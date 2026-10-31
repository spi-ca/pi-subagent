import { test } from "bun:test";
import assert from "node:assert/strict";
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, theme as activeTheme, Theme, getResolvedThemeColors, setThemeInstance } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { emptyUsage, type SingleResult, type SubagentDetails } from "../../src/core/types";
import { ensureInlinePresentation } from "../../src/core/runner-events";
import { formatParentReport } from "../../src/runtime/parent-report";
import { renderCall, renderResult } from "../../src/ui/render";
import { COMPACT_ITEM_LIMIT, COMPACT_ROW_LIMIT, CompactText, oneLine, expansionState, durationText, stateText } from "../../src/ui/native-ui";
import { InlinePresentationRegistry } from "../../src/ui/inline-presentation";
import { InlinePresentationWidget } from "../../src/ui/inline-presentation-widget";
import { createParentReportRenderer } from "../../src/ui/parent-report-render";
import { createBackgroundResultRenderer } from "../../src/ui/background-result";
import { renderParentReportCall, renderParentReportResult } from "../../src/ui/child-report-render";

initTheme("dark", false);
const theme = activeTheme;
const plain = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const text = (component: { render: (width: number) => string[] }, width = 160) => plain(component.render(width).join("\n")).replace(/ +$/gm, "");
const id = "12345678-1234-4123-8123-123456789abc";
function result(index: number): SingleResult {
  const item: SingleResult = {
    agent: `검토😀-${index}`, stageLabel: `stage-${index}`, agentSource: "user", task: `요청 é 😀 ${index}\n${"full task ".repeat(30)}`,
    exitCode: index === 7 ? 1 : 0, messages: [], stderr: "", usage: { ...emptyUsage(), output: 20 }, model: "expanded-model",
    ...(index === 7 ? { errorMessage: "critical failed child" } : {}),
  };
  Object.assign(ensureInlinePresentation(item)!, { lastAssistantText: `essential response ${index}\n${"한😀".repeat(200)}`, lastAssistantTextClipped: true, activities: [{ id: "activity", name: "read", status: "completed" }] });
  return item;
}
function details(mode: "parallel" | "chain" = "parallel", terminalMode: SubagentDetails["terminalMode"] = "inline"): SubagentDetails {
  return { mode, toolLabel: "Subagent", delegationMode: "spawn", terminalMode, projectAgentsDir: null, results: Array.from({ length: 9 }, (_, i) => result(i)), ...(mode === "chain" ? { chainStageCount: 9, chainCompletedCount: 8, chainFailedCount: 1 } : {}) };
}
function bounded(component: { render: (width: number) => string[] }, max = COMPACT_ROW_LIMIT) {
  for (const width of [1, 2, 4, 12, 40, 80, 160, 12]) {
    const rows = component.render(width);
    assert.ok(rows.length <= max, `${rows.length} rows at width ${width}`);
    for (const row of rows) assert.ok(visibleWidth(row) <= width, `width ${visibleWidth(row)} > ${width}`);
    assert.doesNotMatch(plain(rows.join("\n")), /\p{Surrogate}|\u202e/u);
  }
}

/** Small assertion helper, not a terminal emulator: SGR/OSC8 state at each native-width cell. */
function ansiCells(row: string) {
  let fg = "default", bg = "default", link = "";
  const attributes = new Set<number>();
  const cells: Array<{ text: string; fg: string; bg: string; attributes: number[]; link: string }> = [];
  for (const token of row.matchAll(/\x1b\[[\d;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|[^\x1b]+/g)) {
    const value = token[0];
    if (value.startsWith("\x1b]8;")) { link = value.replace(/^\x1b\]8;[^;]*;/, "").replace(/\x07$|\x1b\\$/, ""); continue; }
    if (value.startsWith("\x1b[")) {
      const codes = value.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i]!;
        if (code === 0) { fg = bg = "default"; attributes.clear(); }
        else if (code === 38 || code === 48) {
          const count = codes[i + 1] === 2 ? 4 : 2;
          const color = codes.slice(i, i + count + 1).join(";");
          if (code === 38) fg = color; else bg = color;
          i += count;
        } else if (code === 39) fg = "default";
        else if (code === 49) bg = "default";
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code);
        else if (code >= 1 && code <= 9) attributes.add(code);
        else if (code === 22) { attributes.delete(1); attributes.delete(2); }
        else if (code >= 23 && code <= 25) attributes.delete(code - 20);
        else if (code >= 27 && code <= 29) attributes.delete(code - 20);
      }
      continue;
    }
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
      for (let column = 0; column < visibleWidth(segment); column++) cells.push({ text: segment, fg, bg, attributes: [...attributes].sort(), link });
    }
  }
  return cells;
}

test("native shell ellipsis keeps per-cell host backgrounds in dark/light pending/success/error", () => {
  for (const appearance of ["dark", "light"] as const) for (const status of ["pending", "success", "error"] as const) {
    initTheme(appearance, false);
    const theme = activeTheme;
    const token = status === "pending" ? "toolPendingBg" : status === "error" ? "toolErrorBg" : "toolSuccessBg";
    const expectedBg = ansiCells(theme.bg(token, "x"))[0]!.bg;
    for (const source of ["x".repeat(130), "한글👩‍💻é".repeat(70)]) for (const kind of ["background", "pane", "inline"] as const) {
      const registry = new InlinePresentationRegistry();
      const item = result(0);
      item.agent = "worker"; delete item.stageLabel;
      item.task = source;
      item.exitCode = status === "pending" ? -1 : status === "error" ? 1 : 0;
      item.messages = [{ role: "assistant", content: [{ type: "text", text: source }], stopReason: "stop" }] as SingleResult["messages"];
      if (status === "error") item.errorMessage = source;
      Object.assign(ensureInlinePresentation(item)!, { lastAssistantText: source, lastAssistantTextClipped: false, activities: [] });
      const value: SubagentDetails = { ...details(), mode: "single", results: [item], terminalMode: kind === "pane" ? "tmux-pane" : "inline" };
      if (kind === "inline") registry.capture("ellipsis", value, { retainAuthoritativeResults: true });
      const host = new ToolExecutionComponent("subagent", "ellipsis", { agent: "worker", task: source }, { outputPad: 1 }, {
        renderCall: (args, theme, context) => renderCall(args as any, theme, context),
        renderResult: (result, { expanded }, theme, context) => renderResult(result, expanded, theme, context, registry),
      }, { requestRender() {} } as never, process.cwd());
      host.updateResult({ content: [], details: kind === "background" ? { kind: "subagent.background-job", version: 1, event: "status", job: { jobId: id, status: status === "error" ? "failed" : "completed", startedAt: 1, completedAt: 2, ...(status === "error" ? { errorReason: source } : { output: source }), omittedBytes: 0 } } : value, isError: status === "error" }, status === "pending");
      for (const width of [1, 2, 24, 80, 160]) {
        const rows = host.render(width);
        let ellipses = 0;
        for (const row of rows) {
          const cells = ansiCells(row);
          for (const [index, cell] of cells.entries()) {
            assert.equal(cell.bg, expectedBg, `${appearance}/${status}/${width} cell ${index} ${JSON.stringify(row)}`);
            if (cell.text === "…") {
              ellipses++;
              // Ellipsis belongs to the same foreground/decorations as retained text.
              if (index > 1 && cells[index - 1]!.text !== " ") {
                assert.equal(cell.fg, cells[index - 1]!.fg);
                assert.deepEqual(cell.attributes, cells[index - 1]!.attributes);
              }
            }
          }
        }
        assert.ok(ellipses > 0, `${appearance}/${status}/${width}: truncation exercised`);
        if (width === 160) {
          const previews = rows.filter(row => plain(row).trimStart().startsWith(source.slice(0, 1)));
          assert.equal(previews.length, 2, `${kind}: both call and result source truncations`);
          for (const [index, preview] of previews.entries()) {
            const previewCells = ansiCells(preview).filter(cell => cell.text !== " ");
            assert.equal(previewCells.at(-1)!.text, "…");
            assert.equal(previewCells.at(-1)!.fg, ansiCells(theme.fg(index === 0 ? "dim" : status === "error" ? "error" : "toolOutput", "x"))[0]!.fg);
            const ellipsis = ansiCells(preview).findIndex(cell => cell.text === "…");
            for (const padding of ansiCells(preview).slice(ellipsis + 1)) {
              assert.equal(padding.fg, "default"); assert.deepEqual(padding.attributes, []);
            }
          }
        }
      }
    }
  }
});

test("report headers/footers, expanded warnings and widget headers preserve inherited theme backgrounds", () => {
  for (const appearance of ["dark", "light"] as const) {
    initTheme(appearance, false);
    const theme = activeTheme;
    const source = "한글👩‍💻é".repeat(100);
    const registry = new InlinePresentationRegistry();
    const value = details();
    value.results.forEach(item => { item.agent = source; item.exitCode = -1; });
    registry.capture("widget-ellipsis", value);
    const widget = new InlinePresentationWidget({ requestRender() {} }, registry, theme);
    const sender = { kind: "subagent.parent-report", version: 3, agent: source, jobId: id, childId: "child", mode: "single" as const, reportId: "report", reportKind: "question" as const, receivedAtMs: 1, submittedAtMs: 2 };
    const message = { content: `Report ID: report; parent receivedAtMs: 1; first submittedAtMs: 2 (handoff/draft only, not commit, delivery or model read).\n${formatParentReport(sender, source, "question")}`, details: sender };
    const expectedBg = ansiCells(theme.bg("customMessageBg", "x"))[0]!.bg;
    for (const expanded of [false, true]) {
      const parent = createParentReportRenderer()(message, { expanded, outputPad: 1 }, theme);
      const background = createBackgroundResultRenderer()({ content: source, details: { legacy: true } }, { expanded, outputPad: 1 }, theme);
      const childCall = renderParentReportCall({ kind: "question", message: source.repeat(20) }, theme, { expanded });
      const childResult = renderParentReportResult({ content: [{ type: "text", text: source.repeat(20) }] }, { expanded }, theme);
      for (const width of [1, 2, 24, 80, 160]) {
        for (const component of [parent, background, childCall, childResult, widget]) {
          for (const row of component.render(width)) {
            // The shell wrapper supplies the background; padding and subsequent rows
            // must not inherit foreground/decorations from a truncated child.
            const ownsShell = component === parent || component === background;
            const cells = ansiCells(ownsShell ? row : theme.bg("customMessageBg", row));
            assert.ok(cells.every(cell => cell.bg === expectedBg), `${appearance}/${expanded}/${width}: ${JSON.stringify(row)}`);
          }
        }
      }
    }
    widget.dispose();
  }
});

test("native shell uses overridden host tokens, never plugin-owned background colors", () => {
  const colors = { ...getResolvedThemeColors("dark"), toolPendingBg: "#123456", toolSuccessBg: "#654321", toolErrorBg: "#245136" };
  const overridden = new Theme(colors as unknown as ConstructorParameters<typeof Theme>[0], colors as unknown as ConstructorParameters<typeof Theme>[1], "truecolor");
  setThemeInstance(overridden);
  try {
    for (const status of ["pending", "success", "error"] as const) {
      const host = new ToolExecutionComponent("subagent", "override", { agent: "worker", task: "x".repeat(130) }, { outputPad: 1 }, {
        renderCall: (args, theme, context) => renderCall(args as any, theme, context),
        renderResult: (result, { expanded }, theme, context) => renderResult(result, expanded, theme, context),
      }, { requestRender() {} } as never, process.cwd());
      host.updateResult({ content: [{ type: "text", text: "한글👩‍💻".repeat(100) }], isError: status === "error" }, status === "pending");
      const token = status === "pending" ? "toolPendingBg" : status === "error" ? "toolErrorBg" : "toolSuccessBg";
      const expectedBg = ansiCells(overridden.bg(token, "x"))[0]!.bg;
      for (const width of [1, 2, 24, 80, 160]) for (const row of host.render(width)) {
        assert.ok(ansiCells(row).every(cell => cell.bg === expectedBg));
      }
    }
  } finally { initTheme("dark", false); }
});

test("source oneLine remains plain after native clipping and sanitization", () => {
  const source = "한글👩‍💻é".repeat(70);
  for (const width of [1, 2, 24, 80, 160]) {
    const sanitized = oneLine(`\x1b[31m\x1b]8;;https://invalid.test\x07${source}\x1b]8;;\x07\x1b[0m\u202e`, width);
    assert.doesNotMatch(sanitized, /\x1b|\u202e/);
    assert.ok(sanitized.endsWith("…")); assert.ok(visibleWidth(sanitized) <= width);
  }
});

test("final CompactText closes only local styles, including OSC8", () => {
  const source = "한글👩‍💻é".repeat(70);
  for (const color of ["38;2;17;38;59", "38;5;123", "31"]) for (const terminator of ["\x07", "\x1b\\"]) for (const width of [1, 2, 24, 80, 160]) {
    const decorated = `\x1b[${color};1;2;3;4;5;7;8;9m\x1b]8;;https://invalid.test${terminator}${source}\x1b]8;;${terminator}\x1b[22;23;24;25;27;28;29;39m`;
    const rows = new CompactText(`${decorated}\nplain`).render(width);
    assert.ok(rows.every(row => visibleWidth(row) <= width));
    const cells = ansiCells(`\x1b[48;2;12;34;56m${rows[0]}  ${rows[1]}  `);
    const ellipsis = cells.findIndex(cell => cell.text === "…");
    assert.ok(ellipsis >= 0);
    assert.equal(cells[ellipsis]!.fg, color);
    assert.deepEqual(cells[ellipsis]!.attributes, [1, 2, 3, 4, 5, 7, 8, 9]);
    assert.equal(cells[ellipsis]!.link, "");
    assert.ok(cells.every(cell => cell.bg === "48;2;12;34;56"));
    for (const cell of cells.slice(ellipsis + 1)) {
      assert.equal(cell.fg, "default"); assert.deepEqual(cell.attributes, []); assert.equal(cell.link, "");
    }
  }
  // A genuine source reset must survive: only resets introduced by truncation are replaceable.
  const row = new CompactText("\x1b[31mred\x1b[0mplain".repeat(10)).render(8)[0]!;
  assert.ok(row.includes("\x1b[0m"));
  assert.equal(ansiCells(row).find(cell => cell.text === "p")!.fg, "default");
  assert.equal(ansiCells(row).find(cell => cell.text === "…")!.fg, "default");
});

test("shared lifecycle vocabulary and human durations distinguish cancellation and acceptance", () => {
  assert.equal(stateText("accepted"), "◷ accepted");
  assert.equal(stateText("cancelling"), "– cancelling");
  assert.equal(stateText("cancelled"), "– cancelled");
  assert.equal(durationText(0), "0ms"); assert.equal(durationText(62_000), "1m 2s"); assert.equal(durationText(3_720_000), "1h 2m");
  assert.deepEqual(expansionState({ subagentUiExpansion: "invalid restored state" }, false), { expanded: false, lastGlobalExpanded: false });
});

test("all request variants mark background explicitly, retain task previews and bounded chain order", () => {
  const variants = [
    { agent: "검토😀", task: "요청 é" },
    { tasks: Array.from({ length: 30 }, (_, i) => ({ agent: `agent-${i}`, task: `request-${i}` })) },
    { chain: Array.from({ length: 20 }, (_, i) => i === 1 ? { label: "parallel", type: "parallel", tasks: [{ agent: "scout", task: "inspect task" }] } : { agent: `agent-${i}`, task: `request-${i}` }) },
    { action: "status" }, { action: "cancel", id }, { action: "steer", id, message: "추가 요청" },
  ];
  for (const args of variants) {
    const before = structuredClone(args);
    const component = renderCall({ ...args, background: true }, theme);
    assert.match(text(component), /background/); bounded(component);
    assert.deepEqual(args, before);
  }
  const chain = text(renderCall({ ...variants[2], background: true }, theme));
  assert.ok(chain.indexOf("step-1 (agent-0)") < chain.indexOf("parallel (parallel)"));
  assert.match(chain, /scout: inspect task/); assert.match(chain, /16 stages omitted/);
});

test("partial/final/restored inline and pane aggregates share compact limits and count hidden failures", () => {
  for (const mode of ["parallel", "chain"] as const) for (const terminal of ["inline", "tmux-pane", "cmux-pane", "herdr-pane"] as const) {
    const value = details(mode, terminal);
    const registry = new InlinePresentationRegistry();
    if (terminal === "inline") registry.capture("call", value, { retainAuthoritativeResults: true });
    const before = JSON.stringify(value);
    for (const isPartial of [true, false]) {
      const component = renderResult({ content: [], details: value }, false, theme, { toolCallId: "call", durationMs: 5, isPartial }, registry);
      bounded(component);
      const compact = text(component);
      assert.match(compact, /1 failed/); assert.match(compact, /5 results omitted/);
      assert.match(compact, /stage-0 \(검토😀-0\)/); assert.match(compact, /Task: 요청/);
      assert.doesNotMatch(compact, /expanded-model|Usage:|untrusted/);
      assert.equal(compact.includes("Execute:"), !isPartial);
    }
    const restored = renderResult({ content: [], details: JSON.parse(before) }, true, theme);
    assert.match(text(restored), /expanded-model/); assert.match(text(restored), /stage-8/);
    assert.equal(JSON.stringify(value), before);
  }
});

test("native single/result/action header expansion preserves global transitions, selection and host theme", () => {
  const value = { ...details("parallel", "tmux-pane"), mode: "single" as const, results: [result(0)] };
  const state = {};
  let redraws = 0;
  const context = { state, invalidate: () => { redraws++; }, durationMs: 1 };
  const component = renderResult({ content: [], details: value }, false, theme, context) as any;
  const expander = component.children[0].children[0];
  for (const event of [{ type: "click", button: "left", y: 1 }, { type: "drag", button: "left", y: 0 }, { type: "wheel", y: 0 }, { type: "click", button: "right", y: 0 }]) assert.equal(expander.handleMouse(event), undefined);
  assert.equal(expander.handleMouse({ type: "click", button: "left", y: 0 }).handled, true);
  assert.equal(redraws, 1); assert.match(text(component), /expanded-model/);
  assert.match(text(renderResult({ content: [], details: value }, false, theme, context)), /expanded-model/);
  renderResult({ content: [], details: value }, true, theme, context);
  assert.doesNotMatch(text(renderResult({ content: [], details: value }, false, theme, context)), /expanded-model/);
  for (const name of ["light", "dark"] as const) {
    initTheme(name, false); const themed = activeTheme;
    const rows = renderResult({ content: [], details: value }, false, themed, context).render(80);
    assert.ok(rows.some(row => row.includes("\x1b["))); bounded({ render: width => renderResult({ content: [], details: value }, false, themed, context).render(width) });
  }
  const action = { content: [], details: { kind: "subagent.background-job", version: 1, event: "accepted", jobId: id, status: "running", job: { jobId: id, status: "running", startedAt: 1, omittedBytes: 0 } } };
  assert.match(text(renderResult(action, false, theme)), /◷ accepted/);
  assert.doesNotMatch(text(renderResult(action, false, theme)), /● running/);
  assert.match(text(renderResult(action, false, theme)), /execution not confirmed/);
});

test("background lists retain critical clipping/retention notices and distinguish requested cancellation", () => {
  const jobs = Array.from({ length: 9 }, (_, i) => ({ jobId: `12345678-1234-4123-8123-${String(i).padStart(12, "0")}`, status: i === 7 ? "failed" : "completed", startedAt: 1, completedAt: 2, output: "retained 한😀".repeat(200), outputClipped: true, omittedBytes: 512 }));
  const component = renderResult({ content: [], details: { kind: "subagent.background-job", version: 1, event: "status-list", jobs } }, false, theme, { durationMs: 1 });
  bounded(component); assert.match(text(component), /1 failed · 5 jobs omitted/); assert.match(text(component), /display clipped.*512 B not retained/);
  const cancelled = renderResult({ content: [], details: { kind: "subagent.background-job", version: 1, event: "cancellation-requested", job: { jobId: id, status: "cancelling", startedAt: 1, omittedBytes: 0 } } }, false, theme);
  assert.match(text(cancelled), /– cancelling \(requested\)/); assert.doesNotMatch(text(cancelled), /– cancelled/);
});

test("report aggregates share item/row limits, keep kind nonterminal and preserve immutable model wrappers", () => {
  const reports = Array.from({ length: 10 }, (_, i) => ({ kind: "subagent.parent-report", version: 3, agent: `worker-${i}`, jobId: id, childId: `child-${i}`, mode: "parallel" as const, reportId: `report-${i}`, reportKind: "progress" as const, receivedAtMs: 1, submittedAtMs: 2 }));
  const content = reports.map(sender => `Report ID: ${sender.reportId}; parent receivedAtMs: 1; first submittedAtMs: 2 (handoff/draft only, not commit, delivery or model read).\n${formatParentReport(sender, `본문 한😀 ${sender.agent}`, "progress")}`).join("\n\n");
  const message = { content, details: { kind: "subagent.parent-report.batch", version: 2, batchToken: "batch", reports } };
  const before = JSON.stringify(message);
  const renderer = createParentReportRenderer({ previewLines: 80 });
  const component = renderer(message, { expanded: false, outputPad: 1 }, theme);
  bounded(component); const compact = text(component);
  assert.match(compact, /6 reports omitted/); assert.match(compact, /Report ≠ approval/);
  assert.doesNotMatch(compact, /✓|✗|completed|failed|· untrusted/);
  assert.equal((compact.match(/progress · worker-/g) ?? []).length, COMPACT_ITEM_LIMIT);
  assert.equal(component.handleMouse({ type: "click", button: "left", y: 1 }), undefined);
  component.handleMouse({ type: "click", button: "left", y: 0 });
  assert.match(text(component), /Report: report-9/);
  assert.equal(JSON.stringify(message), before); assert.match(message.content, /Subagent output \(untrusted/);
});

test("widget omissions and clipped warnings are bounded with no false keyboard hint", () => {
  const registry = new InlinePresentationRegistry();
  const value = details(); value.results.forEach(item => { item.exitCode = -1; }); registry.capture("widget", value);
  const widget = new InlinePresentationWidget({ requestRender: () => {} }, registry, theme);
  bounded(widget, 14); const compact = text(widget);
  assert.match(compact, /5 running cards omitted/); assert.match(compact, /display clipped/); assert.doesNotMatch(compact, /to expand|Ctrl\+O/);
  registry.reset(); assert.equal(text(widget), ""); widget.dispose();
});

test("child report call/result presentation is bounded and submitted never claims delivery or approval", () => {
  const args = { kind: "question", message: "한😀\x1b[31m\u202e".repeat(1000) }; const before = structuredClone(args);
  const call = renderParentReportCall(args, theme); bounded(call); assert.doesNotMatch(text(call), /\x1b|\u202e/);
  const result = { content: [{ type: "text", text: "Parent notification submitted." }], details: { outcome: "submitted", kind: "question" } };
  const rendered = renderParentReportResult(result, { expanded: false }, theme); bounded(rendered);
  assert.match(text(rendered), /question · submitted/); assert.match(text(rendered), /not proof of delivery, reading, reply or approval/);
  assert.match(text(renderParentReportResult(result, { expanded: false, isPartial: true }, theme)), /submission pending/);
  assert.match(text(renderParentReportResult({ content: [{ type: "text", text: "Report delivery is unknown; do not retry automatically." }] }, { expanded: false }, theme)), /submission not confirmed[\s\S]*unknown/);
  assert.deepEqual(args, before);
});

test("legacy background fallback remains bounded, honest and header-only clickable", () => {
  const message = { content: "legacy 한😀\u202e".repeat(10_000), details: { legacy: true } };
  const before = structuredClone(message);
  const renderer = createBackgroundResultRenderer(); const card = renderer(message, { expanded: false, outputPad: 0 }, theme);
  bounded(card, 96); assert.match(text(card), /unrecognized/);
  assert.equal(card.handleMouse({ type: "click", button: "left", y: 2 }), undefined);
  card.handleMouse({ type: "click", button: "left", y: 0 }); bounded(card, 96);
  assert.match(text(card), /display clipped/); assert.deepEqual(message, before);
});


test("chain partial/resumed summaries do not claim whole-chain completion or convert cancellation to failure", () => {
  const value = { ...details("chain", "tmux-pane"), results: [result(0)], chainCompletedCount: 1, chainFailedCount: 0, chainStageCount: 3 };
  const compact = text(renderResult({ content: [], details: value }, false, theme, { isPartial: true }));
  assert.match(compact, /◷ queued/); assert.match(compact, /1\/3 stages completed/);
  const resumed: any = JSON.parse(JSON.stringify(value)); delete resumed.chainCompletedCount;
  assert.match(text(renderResult({ content: [], details: resumed }, false, theme)), /stage state unavailable/);
  const cancelled = { ...details("parallel", "tmux-pane"), results: [{ ...result(0), exitCode: 1, stopReason: "aborted", errorMessage: "cancelled by request" }] };
  assert.match(text(renderResult({ content: [], details: cancelled }, false, theme)), /– cancelled/);
  assert.doesNotMatch(text(renderResult({ content: [], details: cancelled }, false, theme)), /✗ failed/);
  const registry = new InlinePresentationRegistry(); const inline = { ...value, terminalMode: "inline" as const }; registry.capture("chain", inline);
  assert.match(text(renderResult({ content: [], details: inline }, false, theme, { toolCallId: "chain", isPartial: true }, registry)), /1\/3 stages resolved/);
  assert.doesNotThrow(() => renderCall({ chain: [{ label: 123, agent: null, task: "partial" }, null] }, theme).render(40));
});

test("actual native tool shell routes action header clicks without added padding or global expansion", () => {
  initTheme("dark", false);
  for (const outputPad of [0, 1]) {
    const value = { content: [], details: { kind: "subagent.background-job", version: 1, event: "status", job: { jobId: id, status: "completed", startedAt: 1, completedAt: 2, output: "first line\nexpanded tail", omittedBytes: 0 } }, durationMs: 12, isError: false };
    const host = new ToolExecutionComponent("subagent", "native-action", { action: "status", id }, { outputPad }, {
      renderCall: (args, theme, context) => renderCall(args as any, theme, context),
      renderResult: (result, { expanded }, theme, context) => renderResult(result, expanded, theme, context),
    }, { requestRender() {} } as never, process.cwd());
    host.updateResult(value);
    const before = host.render(120).map(plain);
    const header = before.findIndex(row => row.includes("✓ completed"));
    assert.ok(header >= 0); assert.equal(before[header]!.indexOf("job"), outputPad);
    assert.doesNotMatch(before.join("\n"), new RegExp(id));
    const handled = host.handleMouse({ type: "click", button: "left", x: outputPad + 2, y: header, screenX: 100 + outputPad + 2, screenY: 50 + header, width: 120, height: before.length, shift: false, alt: false, ctrl: false });
    assert.equal(handled?.handled, true); assert.equal(handled?.target?.originX, 100 + outputPad);
    const after = host.render(120).map(plain).join("\n");
    assert.match(after, new RegExp(id)); assert.match(after, /expanded tail/);
    assert.equal(host.handleMouse({ type: "drag", button: "left", x: outputPad + 2, y: header + 1, screenX: 102 + outputPad, screenY: 51 + header, width: 120, height: host.render(120).length, shift: false, alt: false, ctrl: false }), undefined);
    host.setExpanded(true); host.setExpanded(false);
    assert.doesNotMatch(host.render(120).map(plain).join("\n"), new RegExp(id));
  }
});

test("expanded child report partial/rejected sources are bounded before sanitization and reserve semantic caveats", () => {
  const source = "한😀é\x1b[31m\u202e".repeat(200_000) + "unavailable-source-tail";
  const args = { message: source, kind: "blocked" };
  const rejected = { content: [{ type: "text", text: source }], details: { outcome: "rejected" } };
  const submitted = { content: [{ type: "text", text: source }], details: { outcome: "submitted", kind: "finding" } };
  const before = JSON.stringify({ args, rejected, submitted });
  const components = [
    renderParentReportCall(args, theme, { expanded: true, isPartial: true }),
    renderParentReportCall(args, theme, { expanded: true }),
    renderParentReportResult(rejected, { expanded: true }, theme),
    renderParentReportResult(submitted, { expanded: true, isPartial: true }, theme),
    renderParentReportResult(submitted, { expanded: true }, theme),
  ];
  for (const component of components) {
    bounded(component, 96);
    for (const width of [40, 80, 160, 20_000]) {
      const rendered = text(component, width);
      assert.match(rendered, /\[display clipped\]/);
      assert.match(rendered.replace(/\s+/g, " "), /not proof of delivery, reading, reply or approval/);
      assert.doesNotMatch(rendered, /unavailable-source-tail|not delivered, read|\u202e/);
      assert.ok(rendered.length < 30_000, "bounded source, not just bounded rows");
    }
  }
  assert.match(text(components[2]!), /submission not confirmed/);
  assert.match(text(components[3]!), /submission pending/);
  assert.equal(JSON.stringify({ args, rejected, submitted }), before);
});
