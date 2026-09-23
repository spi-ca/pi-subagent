import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { ensureInlinePresentation } from "../../src/core/runner-events";
import { renderResult } from "../../src/ui/render";
import { InlinePresentationRegistry } from "../../src/ui/inline-presentation";
import { InlinePresentationWidget } from "../../src/ui/inline-presentation-widget";
import { Box, Container, visibleWidth } from "@earendil-works/pi-tui";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

const nestedMouseTest = typeof (Container.prototype as any).handleMouse === "function" ? test : test.skip;

function result(agent: string, text: string, activities: Array<{ id: string; name: string; status: "running" | "completed" | "failed" }>, terminal: Partial<{ exitCode: number; stopReason: string; errorMessage: string }> = {}) {
  const value = {
    agent,
    agentSource: "user" as const,
    task: `${agent} task`,
    exitCode: terminal.exitCode ?? 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    ...terminal,
  };
  Object.assign(ensureInlinePresentation(value)!, { lastAssistantText: text, activities });
  return value;
}

function details(results: ReturnType<typeof result>[]) {
  return { mode: results.length === 1 ? "single" as const : "parallel" as const, toolLabel: "Subagent", delegationMode: "spawn" as const, terminalMode: "inline" as const, projectAgentsDir: null, results };
}

function component(registry: InlinePresentationRegistry, value: ReturnType<typeof details>, expanded = false) {
  registry.capture("tool-call", value, { retainAuthoritativeResults: true });
  return renderResult({ content: [], details: value }, expanded, theme, { toolCallId: "tool-call" }, registry) as any;
}

function card(registry: InlinePresentationRegistry, value: ReturnType<typeof details>, expanded = false) {
  return component(registry, value, expanded).render(160).join("\n");
}

describe("inline execution presentation", () => {
  test("separates parallel agent cards and hides raw arguments/output", () => {
    const registry = new InlinePresentationRegistry();
    const value = details([
      result("scout", "scout completed", [{ id: "a", name: "read", status: "completed" }]),
      result("reviewer", "review completed", [{ id: "b", name: "bash", status: "failed" }]),
    ]);
    const text = card(registry, value);
    assert.match(text, /▸ scout[\s\S]*scout completed/);
    assert.match(text, /▸ reviewer[\s\S]*review completed/);
    assert.doesNotMatch(text, /task|arguments|tool output/i);
  });

  test("keeps the collapsed card to one preview line, then expands only from the header", () => {
    const registry = new InlinePresentationRegistry();
    const value = details([result("worker", "one\ntwo\nthree\nfour", Array.from({ length: 6 }, (_, index) => ({
      id: `activity-${index}`, name: `tool-${index}`, status: "completed" as const,
    })))]);
    const first = component(registry, value, false);
    const firstCard = first.children[0];
    const collapsed = first.render(160).join("\n");
    assert.match(collapsed, /one/);
    assert.doesNotMatch(collapsed, /two|three|tool-0/);
    assert.equal(firstCard.handleMouse({ type: "click", button: "left", x: 2, y: 1 }), undefined, "body clicks stay available for transcript selection");
    assert.equal(firstCard.handleMouse({ type: "drag", button: "left", y: 0 }), undefined);
    assert.equal(firstCard.handleMouse({ type: "wheel", y: 0 }), undefined);
    assert.equal(firstCard.handleMouse({ type: "click", button: "right", y: 0 }), undefined);
    const mouse = firstCard.handleMouse({ type: "click", button: "left", x: 2, y: 0, screenX: 12, screenY: 13, width: 80, height: 8 });
    assert.equal(mouse?.handled, true);
    assert.equal(mouse?.target.component, firstCard, "Pi 0.87 target-bearing handled response preserves nested dispatch");
    const expanded = first.render(160).join("\n");
    assert.match(expanded, /one\s+\ntwo\s+\nthree\s+\nfour/);
    assert.match(expanded, /tool-0 · done/);
  });

  test("renders a terminal foreground result from full authoritative Markdown rather than its 4 KiB snapshot", () => {
    const registry = new InlinePresentationRegistry();
    const fullOutput = `**Full result**\n\n${"x".repeat(5_000)}\n\n**tail marker**`;
    const value = details([result("worker", fullOutput, [])]);
    value.results[0]!.messages = [{ role: "assistant", content: [{ type: "text", text: fullOutput }] }] as any;
    const rendered = component(registry, value, false) as any;
    assert.match(rendered.render(8_000).join("\n"), /Response preview \(clipped\)/, "the in-memory snapshot remains explicitly bounded");
    rendered.children[0].handleMouse({ type: "click", button: "left", y: 0 });
    const expanded = rendered.render(8_000).join("\n");
    assert.match(expanded, /tail marker/);
    assert.ok(expanded.length > 4_096, "expanded foreground output is not sourced from the capped snapshot");
  });

  test("retains authoritative terminal results only for foreground recovery and selects the last completed assistant response", () => {
    const completed = `**completed response**\n${"x".repeat(5_000)}\n**completed tail**`;
    const terminal = result("worker", completed, [], {
      exitCode: 1, stopReason: "error", errorMessage: "terminal failure",
    });
    terminal.messages = [
      { role: "assistant", content: [{ type: "text", text: completed }] },
      { role: "assistant", content: [{ type: "text", text: "error placeholder" }], stopReason: "error" },
      { role: "assistant", content: [{ type: "text", text: "aborted placeholder" }], stopReason: "aborted" },
      { role: "assistant", content: [{ type: "text", text: "pending placeholder" }], stopReason: "pending" },
      { role: "assistant", content: [{ type: "text", text: "status-pending placeholder" }], status: "pending" },
    ] as any;
    const value = details([terminal]);

    const defaultRegistry = new InlinePresentationRegistry();
    defaultRegistry.capture("default", value);
    const defaultCard = defaultRegistry.get("default", value.results, 0)!;
    assert.equal(defaultRegistry.authoritativeMessages("default", defaultCard.identity), undefined, "default capture retains no full terminal result");

    const backgroundRegistry = new InlinePresentationRegistry();
    backgroundRegistry.capture("background", value, { retainAuthoritativeResults: false });
    const backgroundCard = backgroundRegistry.get("background", value.results, 0)!;
    assert.equal(backgroundRegistry.authoritativeMessages("background", backgroundCard.identity), undefined, "background capture retains no full terminal result");

    const foregroundRegistry = new InlinePresentationRegistry();
    foregroundRegistry.capture("foreground", value, { retainAuthoritativeResults: true });
    const foregroundCard = foregroundRegistry.get("foreground", value.results, 0)!;
    assert.strictEqual(foregroundRegistry.authoritativeMessages("foreground", foregroundCard.identity), terminal.messages, "foreground recovery retains only the existing result reference");

    const detailsComponent = renderResult({ content: [], details: value }, false, theme, { toolCallId: "foreground" }, foregroundRegistry) as any;
    detailsComponent.children[0].handleMouse({ type: "click", button: "left", y: 0 });
    const detailsText = detailsComponent.render(8_000).join("\n");
    assert.match(detailsText, /completed tail/);
    assert.doesNotMatch(detailsText, /error placeholder|aborted placeholder|pending placeholder|status-pending placeholder/);

    const thrownRegistry = new InlinePresentationRegistry();
    thrownRegistry.capture("thrown", value, { retainAuthoritativeResults: true });
    const thrownSnapshot = renderResult({ content: [{ type: "text", text: "host error without details" }] }, false, theme, { toolCallId: "thrown" }, thrownRegistry) as any;
    thrownSnapshot.children[0].handleMouse({ type: "click", button: "left", y: 0 });
    const snapshotText = thrownSnapshot.render(8_000).join("\n");
    assert.match(snapshotText, /completed tail/);
    assert.doesNotMatch(snapshotText, /error placeholder|aborted placeholder|pending placeholder|status-pending placeholder/);
  });

  nestedMouseTest("uses Pi 0.87 transformed container dispatch for a header but not a card body", () => {
    const registry = new InlinePresentationRegistry();
    const value = details([result("worker", "answer", [])]);
    const rendered = component(registry, value, false);
    const firstCard = rendered.children[0];
    const parent = new Container() as any;
    parent.addChild(firstCard);
    const outer = new Box(2, 1, (text: string) => text) as any;
    outer.addChild(parent);
    outer.render(120);
    const header = outer.handleMouse({
      type: "click", button: "left", x: 3, y: 1, screenX: 103, screenY: 51,
      width: 120, height: outer.render(120).length, shift: false, alt: false, ctrl: false,
    });
    assert.equal(header?.handled, true);
    assert.equal(header?.target.component, firstCard);
    assert.equal(header?.target.originX, 102, "target origin uses the card's transformed local x");
    assert.equal(header?.target.originY, 51, "target origin uses the card's transformed local y");
    assert.equal(outer.handleMouse({
      type: "click", button: "left", x: 3, y: 2, screenX: 103, screenY: 52,
      width: 120, height: outer.render(120).length, shift: false, alt: false, ctrl: false,
    }), undefined, "only the card header consumes a primary click after nested dispatch");
  });

  test("keeps an individual choice through redraw, lets global expansion override it, and distinguishes duplicate slots", () => {
    const registry = new InlinePresentationRegistry();
    const partial = details([
      result("worker", "first completed", [{ id: "a", name: "read", status: "running" }]),
      result("worker", "second completed", [{ id: "b", name: "grep", status: "running" }]),
    ]);
    const first = component(registry, partial, false);
    first.children[1].handleMouse({ type: "click", button: "left", y: 0 });
    const final = details([
      result("worker", "final first", [{ id: "a", name: "read", status: "completed" }]),
      result("worker", "final second\nwith all lines\nretained", [{ id: "b", name: "grep", status: "completed" }]),
    ]);
    const retained = card(registry, final, false);
    assert.match(retained, /worker #2/);
    assert.match(retained, /final second\s+\nwith all lines\s+\nretained/, "slot ordinal retains its own expansion through final redraw");
    const globallyExpanded = card(registry, final, true);
    assert.match(globallyExpanded, /final first/, "global tool expansion remains authoritative");
    const globallyCollapsed = card(registry, final, false);
    assert.doesNotMatch(globallyCollapsed, /with all lines\s+\nretained/, "a changed global state resets local expansion");
  });

  test("keeps duplicate agents in separate chain stages stable across redraws", () => {
    const registry = new InlinePresentationRegistry();
    const partial = details([result("worker", "research", []), result("worker", "implementation\nline two\nline three", [])]) as any;
    partial.mode = "chain";
    partial.results[0].stageLabel = "research";
    partial.results[1].stageLabel = "implement";
    const first = component(registry, partial, false);
    first.children[1].handleMouse({ type: "click", button: "left", y: 0 });
    const final = details([result("worker", "research final", []), result("worker", "implementation final\nline two\nline three", [])]) as any;
    final.mode = "chain";
    final.results[0].stageLabel = "research";
    final.results[1].stageLabel = "implement";
    const rendered = card(registry, final, false);
    assert.match(rendered, /research \(worker\)[\s\S]*implement \(worker\)/);
    assert.match(rendered, /implementation final\s+\nline two\s+\nline three/, "the expanded duplicate agent stays bound to its chain stage");
  });

  test("shows only running background cards within the bounded dock", () => {
    const registry = new InlinePresentationRegistry();
    const widget = new InlinePresentationWidget({ requestRender: () => {} } as any, registry, theme);
    assert.deepEqual(widget.render(12), [], "an initially empty widget occupies no dock rows");
    registry.capture("background-call", details([
      result("completed", "completed", []),
      result("running", "running\n".repeat(20), [], { exitCode: -1 }),
      result("failed", "failed", [], { exitCode: 1, stopReason: "error" }),
      result("cancelled", "cancelled", [], { exitCode: 130, stopReason: "aborted" }),
    ]));
    const compact = widget.render(12);
    assert.ok(compact.length <= 12, "the dock budget applies after narrow-width rendering");
    assert.ok(compact.every((line) => visibleWidth(line) <= 12), "the dock never exceeds its narrow terminal width");
    const compactText = compact.join("\n");
    assert.match(compactText, /running/, "a mixed invocation keeps its running card visible");
    assert.doesNotMatch(compactText, /completed|failed|cancelled|Ctrl\+O|to expand/);
    assert.ok(widget.render(12).length <= 12, "a local header expansion cannot consume the dock");
    widget.dispose();
  });

  test("removes terminal background cards without clearing their registry snapshots", () => {
    const registry = new InlinePresentationRegistry();
    const widget = new InlinePresentationWidget({ requestRender: () => {} } as any, registry, theme);
    registry.capture("success", details([result("success", "done", [])]));
    registry.capture("failure", details([result("failure", "failed", [], { exitCode: 1, stopReason: "error" })]));
    assert.deepEqual(widget.render(160), [], "captured successful and failed terminal results leave no dock space");

    registry.capture("cancel", details([result("cancel", "working", [], { exitCode: -1 })]));
    assert.match(widget.render(160).join("\n"), /cancel/);
    registry.markTerminal("cancel", "cancelled");
    assert.deepEqual(widget.render(160), [], "markTerminal cancellation removes the card without erasing its snapshot");

    registry.capture("failure-after-partial", details([result("failure-after-partial", "working", [], { exitCode: -1 })]));
    registry.markTerminal("failure-after-partial", "failed");
    assert.deepEqual(widget.render(160), [], "markTerminal failure removes the card");

    registry.capture("new-run", details([result("new-run", "working", [], { exitCode: -1 })]));
    assert.match(widget.render(160).join("\n"), /new-run/, "a later running job reinstates the widget");
    registry.reset();
    assert.deepEqual(widget.render(160), [], "reset leaves no dock rows");
    widget.dispose();
  });

  test("filters terminal history before the four-card widget cap", () => {
    const registry = new InlinePresentationRegistry();
    const widget = new InlinePresentationWidget({ requestRender: () => {} } as any, registry, theme);
    for (let index = 0; index < 5; index += 1) {
      registry.capture(`terminal-${index}`, details([result(`terminal-${index}`, "done", [])]));
    }
    registry.capture("current", details([result("current", "working", [], { exitCode: -1 })]));
    assert.match(widget.render(160).join("\n"), /current/, "old terminal cards cannot starve a new running job");
    widget.dispose();
  });

  nestedMouseTest("dispatches the visible second widget header after the first card expands", () => {
    const registry = new InlinePresentationRegistry();
    const widget = new InlinePresentationWidget({ requestRender: () => {} } as any, registry, theme);
    registry.capture("background-call", details([
      result("running-1", "one\ntwo\nthree", [], { exitCode: -1 }),
      result("running-2", "two", [], { exitCode: -1 }),
      result("running-3", "three", [], { exitCode: -1 }),
      result("running-4", "four", [], { exitCode: -1 }),
    ]));
    const compact = widget.render(12);
    const firstHeader = compact[0];
    // Slots reserve three real rows per card at this width, so y=3 is the
    // visible second header rather than a coordinate in the first body.
    const secondHeaderRow = 3;
    const dispatched = (widget as any).handleMouse({
      type: "click", button: "left", x: 0, y: secondHeaderRow, screenX: 0, screenY: secondHeaderRow,
      width: 12, height: compact.length, shift: false, alt: false, ctrl: false,
    });
    assert.equal(dispatched?.handled, true, "the rendered second-card header receives widget dispatch");
    assert.equal((widget as any).handleMouse({
      type: "click", button: "left", x: 0, y: 1, screenX: 0, screenY: 1,
      width: 12, height: compact.length, shift: false, alt: false, ctrl: false,
    }), undefined, "a visible narrow card body remains outside the header hit target");
    const expanded = widget.render(12);
    assert.match(expanded[secondHeaderRow]!, /▾/, "clicking the visible second header expands that card, not the hidden first body");
    assert.equal(expanded[0], firstHeader, "the first header remains visible after a later card expands");
    assert.ok(expanded.length <= 12);
    widget.dispose();
  });

  test("keeps foreground cards out of the background widget and isolates their expansion from background redraws", () => {
    const foreground = new InlinePresentationRegistry();
    const background = new InlinePresentationRegistry();
    const foregroundDetails = details([result("worker", "one\ntwo\nthree", [])]);
    const foregroundCard = component(foreground, foregroundDetails, false).children[0];
    foregroundCard.handleMouse({ type: "click", button: "left", y: 0 });
    let renders = 0;
    const widget = new InlinePresentationWidget({ requestRender: () => { renders += 1; } } as any, background, theme);
    const backgroundDetails = details([result("background", "background answer", [], { exitCode: -1 })]);
    background.capture("background-call", backgroundDetails);
    assert.equal(widget.render(160).join("\n").includes("worker"), false, "the background widget never renders foreground tool calls");
    assert.match(component(foreground, foregroundDetails, false).render(160).join("\n"), /one\s+\ntwo\s+\nthree/, "background refresh does not reset foreground expansion");
    assert.ok(renders >= 2, "widget redraws only for its background registry");
    widget.dispose();
  });

  test("isolates throwing display listeners, rendering, and disposal from registry lifecycle", () => {
    const registry = new InlinePresentationRegistry();
    registry.subscribe(() => { throw new Error("listener failure"); });
    const widget = new InlinePresentationWidget({ requestRender: () => { throw new Error("disposed tui"); } } as any, registry, theme);
    const value = details([result("worker", "answer", [])]);
    assert.doesNotThrow(() => registry.capture("call", value));
    assert.doesNotThrow(() => registry.markTerminal("call", "failed"));
    assert.doesNotThrow(() => registry.reset());
    widget.dispose();
    assert.doesNotThrow(() => registry.capture("after-dispose", value), "disposed widgets unsubscribe from later session projection");
  });

  test("keeps snapshot expansion synchronized with global and local choices through terminal state", () => {
    const registry = new InlinePresentationRegistry();
    const partial = details([result("worker", "one\ntwo\nthree", [], { exitCode: -1 })]);
    registry.capture("terminal-call", partial);
    const live = renderResult({ content: [], details: partial }, false, theme, { toolCallId: "terminal-call" }, registry) as any;
    live.children[0].handleMouse({ type: "click", button: "left", y: 0 });
    registry.markTerminal("terminal-call", "failed");

    const localChoice = renderResult({ content: [{ type: "text", text: "host error" }] }, false, theme, { toolCallId: "terminal-call" }, registry).render(160).join("\n");
    assert.match(localChoice, /one\s+\ntwo\s+\nthree/, "the local choice survives the partial-to-terminal snapshot");
    const globalExpansion = renderResult({ content: [{ type: "text", text: "host error" }] }, true, theme, { toolCallId: "terminal-call" }, registry).render(160).join("\n");
    assert.match(globalExpansion, /one\s+\ntwo\s+\nthree/, "global expansion reaches terminal snapshots");
    const globalCollapse = renderResult({ content: [{ type: "text", text: "host error" }] }, false, theme, { toolCallId: "terminal-call" }, registry).render(160).join("\n");
    assert.doesNotMatch(globalCollapse, /three/, "a changed global state resets the local terminal snapshot choice");
  });

  test("uses terminal snapshots for failed/cancelled host errors and bounds/reset caches", () => {
    const registry = new InlinePresentationRegistry();
    const failed = details([result("worker", "completed before failure", [{ id: "x", name: "read", status: "completed" }], {
      exitCode: 1, stopReason: "error", errorMessage: "bounded failure",
    })]);
    registry.capture("failed-call", failed, { retainAuthoritativeResults: true });
    const snapshotComponent = renderResult({ content: [{ type: "text", text: "host error without details" }] }, false, theme, { toolCallId: "failed-call" }, registry) as any;
    snapshotComponent.children[0].handleMouse({ type: "click", button: "left", y: 0 });
    const snapshot = snapshotComponent.render(160).join("\n");
    assert.match(snapshot, /failed[\s\S]*completed before failure[\s\S]*bounded failure/);
    registry.markTerminal("failed-call", "cancelled");
    const cancelled = renderResult({ content: [{ type: "text", text: "host cancellation without details" }] }, true, theme, { toolCallId: "failed-call" }, registry).render(160).join("\n");
    assert.match(cancelled, /cancelled[\s\S]*completed before failure/);

    const fullFailure = `**full failure response**\n${"x".repeat(5_000)}\n**failure tail**`;
    failed.results[0]!.messages = [{ role: "assistant", content: [{ type: "text", text: fullFailure }] }] as any;
    registry.capture("failed-full", failed, { retainAuthoritativeResults: true });
    const failedFull = renderResult({ content: [{ type: "text", text: "host error without details" }] }, false, theme, { toolCallId: "failed-full" }, registry) as any;
    failedFull.children[0].handleMouse({ type: "click", button: "left", y: 0 });
    assert.match(failedFull.render(8_000).join("\n"), /failure tail/, "a thrown failure uses its session-local terminal result reference without serializing a duplicate");
    registry.reset();
    const afterReload = renderResult({ content: [{ type: "text", text: "host error without details" }] }, true, theme, { toolCallId: "failed-full" }, registry).render(160).join("\n");
    assert.doesNotMatch(afterReload, /failure tail|completed before failure/, "after session reset there is no fabricated recovery for missing thrown-error details");

    for (let index = 0; index < 70; index += 1) {
      const activities = Array.from({ length: 20 }, (_, activity) => ({
        id: `${index}-${activity}`,
        name: `tool-${activity}`,
        status: "completed" as const,
      }));
      registry.capture(`tool-${index}`, details([result(`agent-${index}`, "\x1b[31manswer\x1b[0m", activities)]));
    }
    assert.equal(registry.size, 64);
    const safe = details([result("safe", "\u202eevil\u202c", [{ id: "x", name: "\x1b[31mread", status: "completed" }])]);
    const latest = card(registry, safe);
    assert.doesNotMatch(latest, /\x1b|\u202e|\u202c/);
    registry.reset();
    assert.equal(registry.size, 0);
    assert.equal(registry.all().length, 0);
  });

  test("caps cards globally, evicts card state deterministically, and bounds observer capture", () => {
    const registry = new InlinePresentationRegistry();
    let observerCalls = 0;
    registry.subscribe(() => { observerCalls += 1; });
    const oversized = Array.from({ length: 65 }, (_, index) => result(`wide-${index}`, "answer", []));
    Object.defineProperty(oversized[64]!, "agent", { get: () => { throw new Error("capture inspected beyond its card budget"); } });
    assert.doesNotThrow(() => registry.capture("wide", details(oversized)));
    assert.equal(registry.all().length, 64);
    assert.equal(observerCalls, 1, "one bounded capture produces one observer notification");

    const evictions = new InlinePresentationRegistry();
    const old = Array.from({ length: 63 }, (_, index) => result(`old-${index}`, "answer", []));
    evictions.capture("old", details(old));
    const firstOld = evictions.get("old", old, 0)!;
    evictions.state("old", firstOld.identity, false).expanded = true;
    evictions.capture("fresh", details([result("fresh-1", "answer", []), result("fresh-2", "answer", [])]));
    assert.equal(evictions.all().length, 64, "the budget applies across multiple retained invocations");
    assert.notEqual(evictions.get("old", old, 0), undefined, "an equal-priority terminal arrival is discardable instead of evicting a retained card");
    assert.equal(evictions.state("old", firstOld.identity, false).expanded, true, "discarding an incoming card retains existing expansion state");
    assert.deepEqual(evictions.all().filter(({ toolCallId }) => toolCallId === "fresh").map(({ card }) => card.agent), ["fresh-1"], "the cap retains only the first equal-priority arrival after earlier retained terminals");

    const active = new InlinePresentationRegistry();
    active.capture("mixed", details([
      ...Array.from({ length: 63 }, (_, index) => result(`terminal-${index}`, "answer", [])),
      result("still-running", "answer", [], { exitCode: -1 }),
    ]));
    active.capture("fresh", details([result("fresh", "answer", []), result("fresh-2", "answer", [])]));
    assert.ok(active.all().some(({ card }) => card.agent === "still-running"), "terminal snapshots make room before a running card is evicted");

    const allRunning = new InlinePresentationRegistry();
    const running = Array.from({ length: 64 }, (_, index) => result(`running-${index}`, "answer", [], { exitCode: -1 }));
    allRunning.capture("running", details(running));
    const expandedRunning = allRunning.get("running", running, 0)!;
    allRunning.state("running", expandedRunning.identity, false).expanded = true;
    allRunning.capture("terminal-arrival", details([result("completed-arrival", "answer", [])]));
    assert.equal(allRunning.all().filter(({ toolCallId }) => toolCallId === "running").length, 64, "an incoming completed snapshot cannot evict any running card");
    assert.equal(allRunning.get("terminal-arrival", [result("completed-arrival", "answer", [])], 0), undefined);
    assert.equal(allRunning.state("running", expandedRunning.identity, false).expanded, true, "discarding the arrival leaves retained card state intact");
  });
});
