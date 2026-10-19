// Each inventory file runs in a fresh process; capture only this test's UI registry.
// @ts-expect-error Bun runtime mock export is intentionally absent from Node types.
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
const ux = await import("../../src/core/subagent-ux");
let registry: InstanceType<typeof ux.SubagentUxRegistry>;
class CapturingRegistry extends ux.SubagentUxRegistry {
  constructor() { super(); registry = this; }
}
mock.module("../../src/core/subagent-ux", () => ({ ...ux, SubagentUxRegistry: CapturingRegistry }));
const runner = await import("../../src/runtime/runner");
const surfaces = Array.from({ length: 40 }, (_, i) => ({ runId: `exact-run-${i}`, agent: `pane-agent-${i}`, ownership: "managed" as const, backend: "tmux-pane" as const, depth: 1, startedAt: i, updatedAt: i }));
const focused: string[] = [];
mock.module("../../src/runtime/runner", () => ({ ...runner,
  listInteractiveRunUxSnapshots: () => surfaces,
  focusInteractiveRun: async (id: string) => { focused.push(id); return true; },
}));
const { default: register } = await import("../../index");

test("native subagents selection/list/details/confirmation/notifications preserve lifecycle honesty", async () => {
  const previous = process.env.PI_SUBAGENT_DEPTH;
  process.env.PI_SUBAGENT_DEPTH = "0";
  try {
    const commands = new Map<string, any>();
    register({
      registerToolRenderer() {}, registerMessageRenderer() {}, registerFlag() {}, registerTool() {}, on() {},
      registerCommand: (name: string, value: unknown) => commands.set(name, value),
      getFlag: (name: string) => name === "subagent-max-depth" ? "0" : undefined,
      getAllTools: () => [], getCommands: () => [], events: { emit() {} },
    } as never);
    let cancellations = 0;
    for (let i = 0; i < 40; i++) registry.start({ id: `exact-id-${i}`, agent: i < 2 ? "same agent" : `agent-${i}`, kind: "background", startedAt: i, cancel: () => { cancellations++; } });
    registry.fail("exact-id-7");
    registry.updatePreview("exact-id-0", "essential preview 한😀");
    const notifications: Array<[string, string]> = [];
    const confirmations: Array<[string, string]> = [];
    let approval = false;
    let selectedLabels: string[] = [];
    const ctx = {
      hasUI: true, mode: "tui", ui: {
        notify: (text: string, kind: string) => notifications.push([text, kind]),
        confirm: async (title: string, body: string) => { confirmations.push([title, body]); return approval; },
        select: async (_title: string, labels: string[]) => { selectedLabels = labels; return labels.find(label => label.includes("essential preview")); },
      },
    };
    const handler = commands.get("subagents").handler;
    await handler("list", ctx);
    assert.match(notifications.at(-1)![0], /^- agent-7 · ✗ failed/);
    for (const [args, mode, hasUI] of [["list", "tui", true], ["", "json", false], ["list", "rpc", false]] as const) {
      await handler(args, { ...ctx, mode, hasUI });
      const listing = notifications.at(-1)![0];
      for (let i = 0; i < 40; i++) {
        assert.ok(listing.includes(`id: exact-id-${i} ·`), `invocation ${i} is actionable`);
        assert.ok(listing.split("\n").some(line => line.endsWith(`id: exact-run-${i}`)), `surface ${i} is actionable`);
      }
      assert.doesNotMatch(listing, /omitted|startedAt/);
    }
    await handler("focus exact-run-39", ctx);
    assert.equal(focused.at(-1), "exact-run-39");
    await handler("", ctx);
    assert.equal(new Set(selectedLabels).size, selectedLabels.length, "same agent labels remain unambiguous");
    assert.equal(selectedLabels.length, 32, "no-args TUI selector stays compact");
    assert.ok(selectedLabels.every(label => !label.includes("exact-id-") && !label.includes("exact-run-")));
    assert.match(notifications.at(-1)![0], /id: exact-id-0/);
    assert.match(notifications.at(-1)![0], /Job elapsed:/);
    await handler("details exact-id-7", ctx);
    assert.match(notifications.at(-1)![0], /^agent-7 · ✗ failed/);
    await handler("cancel exact-id-0", ctx);
    assert.equal(cancellations, 0); assert.equal(registry.get("exact-id-0")?.status, "running");
    assert.match(confirmations.at(-1)![1], /Request cancellation; wait for terminal status/);
    approval = true;
    await handler("cancel exact-id-0", ctx);
    assert.equal(cancellations, 1); assert.equal(registry.get("exact-id-0")?.status, "cancelling");
    assert.match(notifications.at(-1)![0], /cancelling \(requested; not yet cancelled\)/);
    await handler("cancel exact-id-0", ctx); assert.equal(cancellations, 1);
    assert.ok(notifications.every(([text]) => !text.includes("untrusted")));
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH; else process.env.PI_SUBAGENT_DEPTH = previous;
  }
});
