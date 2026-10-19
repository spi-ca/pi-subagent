import { test } from "bun:test";
import assert from "node:assert/strict";
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, theme as activeTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { emptyUsage, type SingleResult, type SubagentDetails } from "../../src/core/types";
import { ensureInlinePresentation } from "../../src/core/runner-events";
import { formatParentReport } from "../../src/runtime/parent-report";
import { renderCall, renderResult } from "../../src/ui/render";
import { COMPACT_ITEM_LIMIT, COMPACT_ROW_LIMIT, expansionState, durationText, stateText } from "../../src/ui/native-ui";
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
