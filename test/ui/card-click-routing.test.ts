import { test } from "bun:test";
import assert from "node:assert/strict";
import { Container, MouseRegion, ScrollView, Text, TuiAltScreen, getCapabilities, setCapabilities, type Component, type Terminal } from "@earendil-works/pi-tui";
import { CustomMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-message.js";
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { formatStoredBackgroundToolText } from "../../src/core/subagent-config";
import { ensureInlinePresentation } from "../../src/core/runner-events";
import { emptyUsage } from "../../src/core/types";
import { ParentReportAdmission } from "../../src/runtime/parent-report";
import { createBackgroundResultRenderer } from "../../src/ui/background-result";
import { createParentReportRenderer } from "../../src/ui/parent-report-render";
import { HeaderExpander } from "../../src/ui/native-ui";
import { InlineResultCard } from "../../src/ui/inline-result-card";
import { InlinePresentationRegistry } from "../../src/ui/inline-presentation";
import { InlinePresentationWidget } from "../../src/ui/inline-presentation-widget";
import { renderCall, renderResult } from "../../src/ui/render";
import { renderParentReportCall, renderParentReportResult } from "../../src/ui/child-report-render";

initTheme("dark", false);
const jobId = "12345678-1234-4123-8123-123456789abc";
const plain = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g, "");

/**
 * Installed Pi 1.4's real fullscreen layout, raw SGR decoder, gesture/selection,
 * OSC 8 and component dispatch, with only terminal I/O/render scheduling stubbed.
 * Private entry points avoid starting a real terminal or touching stdin/config.
 */
function viewport(component: Component, rows = 40) {
  const opened: string[] = [];
  const terminal = { columns: 120, rows, write() {}, hideCursor() {}, showCursor() {} } as unknown as Terminal;
  const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false, openUrl: url => opened.push(url) });
  const native = tui as any;
  tui.requestRender = () => {};
  native.stopped = false;
  native.altScreenActive = true;
  const scroll = new ScrollView(component, { primary: true, follow: "none", scrollbar: "hidden" });
  tui.setLayoutRoot(scroll);
  const paint = () => { native.doRender(); return tui.getScreenLines().map(plain); };
  const raw = (button: number, x: number, y: number, release = false) => {
    assert.deepEqual(native.handleViewportInput(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`), { consume: true });
  };
  // Independent ordinary clicks have no preceding multi-click history. Tests
  // of multi-click selection below deliberately use raw(), without this reset.
  const click = (x: number, y: number) => { tui.resetTextSelection(); raw(0, x, y); raw(0, x, y, true); };
  const row = (pattern: RegExp) => {
    const index = paint().findIndex(line => pattern.test(line));
    assert.ok(index >= 0, `missing row ${pattern}: ${paint().join("\n")}`);
    return index;
  };
  paint();
  return { tui, scroll, paint, raw, click, row, opened };
}

function job(output: string) {
  return { role: "custom" as const, customType: "subagent-result", display: true, timestamp: 0,
    content: `Background subagent job ${jobId} completed.\n\n${formatStoredBackgroundToolText(output)}`,
    details: { jobId, status: "completed" as const, startedAt: 1000, completedAt: 2000 } };
}

function report(body: string) {
  const sent: any[] = [];
  const admission = new ParentReportAdmission({ sendMessage: message => { sent.push(message); } }, () => 1000);
  admission.reset({ getSessionId: () => "click-routing", getEntries: () => [] });
  assert.equal(admission.bind({ agent: "worker", jobId, childId: "leaf", mode: "single" }, () => true)(body, "finding"), true);
  return { role: "custom" as const, timestamp: 0, ...sent[0] };
}

test("raw fullscreen clicks toggle result/report title, body and omission/footer rows through native custom wrappers", () => {
  for (const kind of ["result", "report"] as const) for (const outputPad of [0, 1]) {
    const value = kind === "result" ? job("first\nsecond\nthird\nfourth\n" + "extra row\n".repeat(70)) : report("first\nsecond\nthird\nfourth");
    const before = structuredClone(value);
    const renderer = kind === "result" ? createBackgroundResultRenderer({ previewLines: 2 }) : createParentReportRenderer({ previewLines: 2 });
    const host = new CustomMessageComponent(value, renderer, undefined, outputPad);
    const view = viewport(host, 110);
    const expanded = () => kind === "result" ? view.paint().join("\n").includes(jobId) : view.paint().join("\n").includes("Diagnostics");
    for (const target of [/job 123|worker · finding report/, /first/, /display clipped/]) {
      assert.equal(expanded(), false);
      view.click(outputPad + 2, view.row(target));
      assert.equal(expanded(), true, `${kind}: ${target} expands locally`);
      view.click(outputPad + 2, view.row(/fourth/));
      assert.equal(expanded(), false, `${kind}: expanded body collapses locally`);
    }
    view.click(outputPad + 2, view.row(/first/));
    view.click(outputPad + 2, view.row(kind === "result" ? /subagent-result/ : /Reports, not results or approval/));
    assert.equal(expanded(), false, "expanded footer is also part of the card");
    host.setExpanded(true); assert.equal(expanded(), true);
    host.setExpanded(false); assert.equal(expanded(), false, "host global expansion remains authoritative");
    assert.deepEqual(value, before);
  }
});

test("short job body clicks retain full/short ID toggling; raw drag, multi-click selection and wheel do not expand", () => {
  const host = new CustomMessageComponent(job("selectable short response"), createBackgroundResultRenderer(), undefined, 1);
  const view = viewport(host, 12);
  const body = view.row(/selectable/);
  view.click(3, body);
  assert.ok(view.paint().join("\n").includes(jobId));
  view.raw(0, 3, body);
  view.raw(32, 15, body);
  view.raw(0, 15, body, true);
  assert.equal(view.tui.hasActiveSelection(), true, "native press/drag/release selects body text");
  assert.ok(view.paint().join("\n").includes(jobId), "drag release never becomes a toggle");
  view.tui.resetTextSelection();
  // Stable word before the changing ID: the second/third press remains native word/line selection.
  const title = view.row(/job 123/);
  const repeatedClick = () => { view.raw(0, 2, title); view.raw(0, 2, title, true); };
  repeatedClick();
  const afterSingle = host.render(120).map(plain).join("\n");
  repeatedClick();
  assert.equal(view.tui.hasActiveSelection(), true, "native double click retains word selection");
  repeatedClick();
  assert.equal(view.tui.hasActiveSelection(), true, "native triple click retains line selection");
  assert.equal(host.render(120).map(plain).join("\n"), afterSingle, "multi-click selection does not toggle again");

  const document = new Container();
  document.addChild(host); document.addChild(new Text(Array.from({ length: 40 }, (_, i) => `tail ${i}`).join("\n"), 0, 0));
  const scrolling = viewport(document, 12);
  const beforeWheel = host.render(120).join("\n");
  scrolling.raw(65, 3, scrolling.row(/selectable/));
  assert.ok(scrolling.scroll.scrollTop > 0, "native wheel falls through to the ScrollView");
  assert.equal(host.render(120).join("\n"), beforeWheel);
});

test("native tool shells route call body/omission and result body clicks using existing tool-local state", () => {
  for (const outputPad of [0, 1]) {
    const args = { tasks: Array.from({ length: 6 }, (_, i) => ({ agent: `worker-${i}`, task: `task-${i}\ncall tail` })) };
    const host = new ToolExecutionComponent("subagent", "routing-tool", args, { outputPad }, {
      renderCall: (args, theme, context) => renderCall(args as Parameters<typeof renderCall>[0], theme, context),
      renderResult: (value, { expanded }, theme, context) => renderResult(value, expanded, theme, context),
    }, { requestRender() {} } as never, process.cwd());
    const view = viewport(host);
    view.click(outputPad + 2, view.row(/2 tasks omitted/));
    assert.ok(view.paint().some(line => line.includes("worker-5")), "call omission row expands the call before execution");
    view.click(outputPad + 2, view.row(/call tail/));
    assert.equal(view.paint().some(line => line.includes("worker-5")), false);
    host.updateResult({ content: [], details: { kind: "subagent.background-job", version: 1, event: "status",
      job: { jobId, status: "completed", startedAt: 1000, completedAt: 2000, output: "result body\nresult tail", omittedBytes: 0 } }, isError: false });
    view.click(outputPad + 2, view.row(/result body/));
    assert.ok(view.paint().some(line => line.trim() === "result tail"));
    assert.ok(view.paint().some(line => line.includes("worker-5")), "call/result keep their existing shared tool-local renderer state");
    view.click(outputPad + 2, view.row(/^\s*result tail\s*$/));
    assert.equal(view.paint().some(line => line.trim() === "result tail"), false);
    host.setExpanded(true); host.setExpanded(false);
    assert.equal(view.paint().join("\n").includes(jobId), false, "global tool expansion still overrides the local choice");
  }
});

test("child report call/result bodies share the local toggle through the real tool shell", () => {
  const host = new ToolExecutionComponent("report_to_parent", "routing-report", { kind: "finding", message: "report body\nreport tail" }, { outputPad: 1 }, {
    renderCall: (args, theme, context) => renderParentReportCall(args as Parameters<typeof renderParentReportCall>[0], theme, context),
    renderResult: (result, options, theme, context) => renderParentReportResult(result, options, theme, context),
  }, { requestRender() {} } as never, process.cwd());
  const view = viewport(host);
  view.click(3, view.row(/report body/));
  assert.ok(view.paint().some(line => line.trim() === "report tail"));
  view.click(3, view.row(/^\s*report tail\s*$/));
  assert.equal(view.paint().some(line => line.trim() === "report tail"), false);
  host.updateResult({ content: [{ type: "text", text: "submitted body" }], details: { outcome: "submitted", kind: "finding" }, isError: false });
  view.click(3, view.row(/API admission\/submission only/));
  // No extra authority or control action is attached to this caveat row.
  assert.ok(view.paint().some(line => line.includes("submitted body")));
});

test("native OSC 8 activation wins over an expanded inline card body; neighboring controls keep gesture ownership", () => {
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, hyperlinks: true });
  try {
    const presentation = { identity: "worker", agent: "worker", ordinal: 1, status: "completed" as const, lastAssistantText: "", lastAssistantTextClipped: false, activities: [] };
    const state = { expanded: true, lastGlobalExpanded: false };
    const card = new InlineResultCard(presentation, state, theme, { authoritativeAssistantText: "[Clickable link](https://example.test/card)\n\nordinary body" });
    let controlClicks = 0;
    const document = new Container();
    document.addChild(card);
    document.addChild(new MouseRegion(new Text("interactive control", 0, 0), event => {
      if (event.type === "press" && event.button === "left") return { handled: true, capture: true };
      if (event.type === "click" && event.button === "left") { controlClicks++; return { handled: true }; }
      return undefined;
    }));
    const view = viewport(document);
    const linkRow = view.row(/Clickable link/);
    assert.ok(view.tui.getScreenLines()[linkRow]!.includes("\x1b]8;;https://example.test/card"), "real card Markdown emits OSC 8");
    view.click(2, linkRow);
    assert.deepEqual(view.opened, ["https://example.test/card"]);
    assert.equal(state.expanded, true, "link activation does not collapse the enclosing card");
    view.click(2, view.row(/interactive control/));
    assert.equal(controlClicks, 1); assert.equal(state.expanded, true);
    view.click(2, view.row(/ordinary body/));
    assert.equal(state.expanded, false, "non-link body still collapses locally");
  } finally { setCapabilities(capabilities); }
});

test("native inline aggregate omission retains tool-shell fallback while card bodies toggle individually", () => {
  const registry = new InlinePresentationRegistry();
  const results = Array.from({ length: 6 }, (_, i) => {
    const result = { agent: `worker-${i}`, agentSource: "user" as const, task: `task-${i}`, exitCode: 0, messages: [], stderr: "", usage: emptyUsage() };
    ensureInlinePresentation(result)!.lastAssistantText = `answer-${i}\nresponse tail-${i}`;
    return result;
  });
  const details = { mode: "parallel" as const, toolLabel: "Subagent", delegationMode: "spawn" as const, terminalMode: "inline" as const, projectAgentsDir: null, results };
  registry.capture("inline-routing", details);
  const host = new ToolExecutionComponent("subagent", "inline-routing", { tasks: results }, { outputPad: 1 }, {
    renderCall: (args, theme, context) => renderCall(args as Parameters<typeof renderCall>[0], theme, context),
    renderResult: (value, { expanded }, theme, context) => renderResult(value, expanded, theme, context, registry),
  }, { requestRender() {} } as never, process.cwd());
  host.updateResult({ content: [], details, isError: false });
  const view = viewport(host, 110);
  view.click(3, view.row(/answer-1/));
  assert.ok(view.paint().some(row => row.includes("▾ worker-1")));
  assert.ok(view.paint().some(row => row.includes("▸ worker-0")), "inline card body does not toggle sibling cards");
  view.click(3, view.row(/2 results omitted/));
  assert.ok(view.paint().some(row => row.includes("answer-5")), "native tool fallback reveals omitted aggregate results");
  host.setExpanded(false);
  assert.ok(view.paint().some(row => row.includes("2 results omitted")));
});

test("raw fullscreen widget body clicks target the visible slot while the aggregate cap indicator stays passive", () => {
  const registry = new InlinePresentationRegistry();
  registry.capture("widget", { terminalMode: "inline", results: Array.from({ length: 5 }, (_, i) => ({
    agent: `worker-${i}`, task: `task-${i}`, exitCode: -1, messages: [],
  })) });
  const widget = new InlinePresentationWidget({ requestRender() {} }, registry, theme);
  try {
    const view = viewport(widget);
    const before = widget.render(120);
    view.click(2, view.row(/1 active cards omitted/));
    assert.deepEqual(widget.render(120), before, "aggregate widget omission is a passive bound, not hidden per-card body content");
    view.click(2, view.row(/Task: task-1/));
    const expanded = view.paint();
    assert.ok(expanded.some(row => row.includes("▾ worker-1")));
    assert.ok(expanded.some(row => row.includes("▸ worker-0")));
    view.click(2, view.row(/Task: task-1/));
    assert.ok(view.paint().some(row => row.includes("▸ worker-1")));
    assert.ok(widget.render(120).length <= 14);
  } finally { widget.dispose(); }
});

// Observe selection on press AND release: a handled click clears native
// selection even if a renderer deliberately makes no state change.
function bodyMultiClicks(component: Component, pattern: RegExp, word: string) {
  const view = viewport(component);
  const y = view.row(pattern);
  const match = new RegExp(`(?:^|\\s)(${word})(?=[:\\s]|$)`).exec(view.paint()[y]!);
  assert.ok(match, `missing body word start ${word}`);
  const x = match.index + match[0].indexOf(word);
  const native = view.tui as any;
  const observations = [];
  for (let count = 1; count <= 3; count++) {
    view.raw(0, x, y);
    assert.equal(native.lastClick?.count, count, "uninterrupted native click count");
    const pressedText = native.getActiveSelectionText();
    view.raw(0, x, y, true);
    observations.push({ pressedText, releasedText: native.getActiveSelectionText(), rows: view.paint() });
    assert.equal(view.row(pattern), y, "body stays at the same screen row");
  }
  return observations;
}

function assertPassiveMultiClicks(component: Component, pattern: RegExp, word: string) {
  const [single, double, triple] = bodyMultiClicks(component, pattern, word);
  assert.equal(double!.pressedText, word, "native word selection exists before release, including one-cell words");
  for (const later of [double!, triple!]) {
    assert.equal(later.releasedText, later.pressedText, "multi-click release must not clear native selection");
    assert.deepEqual(later.rows, single!.rows, "multi-click release must not toggle the card again");
  }
  assert.ok(triple!.releasedText?.includes(word), "native triple-click line selection survives");
}

for (const outputPad of [0, 1]) for (const word of ["selectable", "a"]) for (const kind of ["result", "report"] as const) {
  test(`custom ${kind} pad${outputPad} body ${word} WORD START double/triple clicks preserve selection`, () => {
    const output = `${word} short response`;
    const value = kind === "result" ? job(output) : report(output);
    const renderer = kind === "result" ? createBackgroundResultRenderer() : createParentReportRenderer();
    const host = new CustomMessageComponent(value, renderer, undefined, outputPad);
    assertPassiveMultiClicks(host, new RegExp(output), word);
    assert.ok(host.render(120).map(plain).join("\n").includes(kind === "result" ? jobId : "Diagnostics"), "first ordinary body click still expands");
  });
}

for (const word of ["Task", "a"]) {
  test(`widget and standalone inline body ${word} WORD START double/triple clicks preserve selection`, () => {
    const registry = new InlinePresentationRegistry();
    registry.capture("widget-multi", { terminalMode: "inline", results: [{ agent: "worker", task: "a short request", exitCode: -1, messages: [] }] });
    const widget = new InlinePresentationWidget({ requestRender() {} }, registry, theme);
    try {
      assertPassiveMultiClicks(widget, /Task: a short request/, word);
      assert.ok(widget.render(120).map(plain).some(row => row.includes("▾ worker")));
      assert.ok(widget.render(120).length <= 14);
    } finally { widget.dispose(); }
    const state = { expanded: false, lastGlobalExpanded: false };
    const card = new InlineResultCard({ identity: "inline-multi", agent: "worker", ordinal: 1, status: "running", task: "a short request", lastAssistantText: "", lastAssistantTextClipped: false, activities: [] }, state, theme);
    assertPassiveMultiClicks(card, /Task: a short request/, word);
    assert.equal(state.expanded, true);
  });
}

for (const word of ["selectable", "a"]) {
  test(`passive native expander without host fallback declines body ${word} multi-clicks`, () => {
    const state = { expanded: false, lastGlobalExpanded: false };
    const card = new HeaderExpander(state, expanded => new Text(`title ${expanded}\n${word} short response`, 0, 0));
    assertPassiveMultiClicks(card, new RegExp(`${word} short response`), word);
    assert.equal(state.expanded, true);
  });
}

test("native tool result body multi-click fallback limitation is inherited from header-only dispatch", () => {
  for (const outputPad of [0, 1]) for (const word of ["selectable", "a"]) {
    const traces = [];
    for (const headerOnly of [true, false]) {
      const state = { expanded: false, lastGlobalExpanded: false };
      const output = `${word} short response`;
      const host = new ToolExecutionComponent("subagent", "fallback-multi", {}, { outputPad }, {
        renderCall: () => new Text("call", 0, 0),
        renderResult: (_value, { expanded }) => {
          // Use host expansion to expose the fallback's state change; ordinary
          // first clicks match in both versions, without changing body geometry.
          if (state.lastGlobalExpanded !== expanded) { state.expanded = expanded; state.lastGlobalExpanded = expanded; }
          const card = new HeaderExpander(state, open => new Text(`title ${open}\n${output}`, 0, 0));
          if (headerOnly) {
            const original = card.handleMouse.bind(card);
            // Old body behavior: decline any non-header row. No host changes.
            card.handleMouse = event => event.y !== 0 ? undefined : original(event);
          }
          return card;
        },
      }, { requestRender() {} } as never, process.cwd());
      host.updateResult({ content: [], details: {}, isError: false });
      const observations = bodyMultiClicks(host, new RegExp(output), word);
      assert.equal(observations[1]!.pressedText, word);
      assert.equal(observations[1]!.releasedText, undefined, "Pi 1.4 tool fallback clears double-click selection in BOTH versions");
      assert.equal(observations[2]!.releasedText, outputPad === 0 ? undefined : observations[2]!.pressedText, "native triple-click fallback depends on whether release matches the line anchor");
      traces.push(observations.map(({ pressedText, releasedText }) => ({ pressedText, releasedText })));
    }
    assert.deepEqual(traces[1], traces[0], "repaired body guard matches inherited header-only selection behavior under native tool fallback");
  }
});


test("actual foreground inline tool body multi-click selection matches inherited header-only fallback behavior", () => {
  for (const outputPad of [0, 1]) for (const word of ["Task", "a"]) {
    const traces = [];
    for (const headerOnly of [true, false]) {
      const original = InlineResultCard.prototype.handleMouse;
      if (headerOnly) InlineResultCard.prototype.handleMouse = function(event) {
        return event.y !== 0 ? undefined : original.call(this, event);
      };
      try {
        const registry = new InlinePresentationRegistry();
        const result = { agent: "worker", agentSource: "user" as const, task: "a short request", exitCode: 0, messages: [], stderr: "", usage: emptyUsage() };
        ensureInlinePresentation(result)!.lastAssistantText = "selectable short response";
        const details = { mode: "single" as const, toolLabel: "Subagent", delegationMode: "spawn" as const, terminalMode: "inline" as const, projectAgentsDir: null, results: [result] };
        registry.capture("inline-multi", details);
        const host = new ToolExecutionComponent("subagent", "inline-multi", {}, { outputPad }, {
          renderCall: () => new Text("call", 0, 0),
          renderResult: (value, { expanded }, theme, context) => renderResult(value, expanded, theme, context, registry),
        }, { requestRender() {} } as never, process.cwd());
        host.updateResult({ content: [], details, isError: false });
        const observations = bodyMultiClicks(host, /Task: a short request/, word);
        assert.equal(observations[1]!.pressedText, word);
        assert.equal(observations[1]!.releasedText, undefined, "actual inline native-tool fallback clears word selection in both versions");
        traces.push(observations.map(({ pressedText, releasedText }) => ({ pressedText, releasedText })));
      } finally { InlineResultCard.prototype.handleMouse = original; }
    }
    assert.deepEqual(traces[1], traces[0]);
  }
});
