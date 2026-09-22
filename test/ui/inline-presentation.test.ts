import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { ensureInlinePresentation } from "../../src/core/runner-events";
import { renderResult } from "../../src/ui/render";
import { InlinePresentationRegistry } from "../../src/ui/inline-presentation";
import { InlinePresentationWidget } from "../../src/ui/inline-presentation-widget";
import { Box, Container } from "@earendil-works/pi-tui";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

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
  registry.capture("tool-call", value);
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
    assert.match(text, /scout[\s\S]*scout completed[\s\S]*read · done/);
    assert.match(text, /reviewer[\s\S]*review completed[\s\S]*bash · failed/);
    assert.doesNotMatch(text, /task|arguments|tool output/i);
  });

  test("collapses >2 response lines and >4 activities, then expands only from the header", () => {
    const registry = new InlinePresentationRegistry();
    const value = details([result("worker", "one\ntwo\nthree\nfour", Array.from({ length: 6 }, (_, index) => ({
      id: `activity-${index}`, name: `tool-${index}`, status: "completed" as const,
    })))]);
    const first = component(registry, value, false);
    const firstCard = first.children[0];
    const collapsed = first.render(160).join("\n");
    assert.match(collapsed, /one\s+\ntwo/);
    assert.doesNotMatch(collapsed, /three/);
    assert.match(collapsed, /2 earlier tools/);
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

  test("uses Pi 0.87 transformed container dispatch for a header but not a card body", () => {
    const registry = new InlinePresentationRegistry();
    const value = details([result("worker", "answer", [])]);
    const rendered = component(registry, value, false);
    const firstCard = rendered.children[0];
    const parent = new Container() as any;
    // Pi 0.84 intentionally has no mouse dispatch API; the isolated 0.87
    // graph executes this exact nested-coordinate branch in verification.
    if (typeof parent.handleMouse !== "function") return;
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

  test("keeps foreground cards out of the background widget and isolates their expansion from background redraws", () => {
    const foreground = new InlinePresentationRegistry();
    const background = new InlinePresentationRegistry();
    const foregroundDetails = details([result("worker", "one\ntwo\nthree", [])]);
    const foregroundCard = component(foreground, foregroundDetails, false).children[0];
    foregroundCard.handleMouse({ type: "click", button: "left", y: 0 });
    let renders = 0;
    const widget = new InlinePresentationWidget({ requestRender: () => { renders += 1; } } as any, background, theme);
    const backgroundDetails = details([result("background", "background answer", [])]);
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
    registry.capture("failed-call", failed);
    const snapshot = renderResult({ content: [{ type: "text", text: "host error without details" }] }, false, theme, { toolCallId: "failed-call" }, registry).render(160).join("\n");
    assert.match(snapshot, /failed[\s\S]*completed before failure[\s\S]*bounded failure/);
    registry.markTerminal("failed-call", "cancelled");
    const cancelled = renderResult({ content: [{ type: "text", text: "host cancellation without details" }] }, false, theme, { toolCallId: "failed-call" }, registry).render(160).join("\n");
    assert.match(cancelled, /cancelled[\s\S]*completed before failure/);

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
    assert.equal(evictions.get("old", old, 0), undefined, "the oldest retained card is evicted first");
    assert.equal(evictions.state("old", firstOld.identity, false).expanded, false, "eviction removes the associated expansion state");
    assert.deepEqual(evictions.all().filter(({ toolCallId }) => toolCallId === "fresh").map(({ card }) => card.agent), ["fresh-1", "fresh-2"]);
  });
});
