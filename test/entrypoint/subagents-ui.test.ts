// Each inventory file runs in a fresh process; capture only this test's UI registry.
// @ts-expect-error Bun runtime mock export is intentionally absent from Node types.
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
const ux = await import("../../src/core/subagent-ux");
let registry: InstanceType<typeof ux.SubagentUxRegistry>;
class CapturingRegistry extends ux.SubagentUxRegistry {
  constructor() { super(); registry = this; }
}
mock.module("../../src/core/subagent-ux", () => ({ ...ux, SubagentUxRegistry: CapturingRegistry }));
mock.module("../../src/runtime/tree-permit-authority", () => ({
  TREE_PERMIT_LEASE_ID_ENV: "TEST_LEASE_ID", TREE_PERMIT_LEASE_TOKEN_ENV: "TEST_LEASE_TOKEN",
  TREE_PERMIT_MAX_ACTIVE_ENV: "TEST_MAX_ACTIVE", TREE_PERMIT_ROOT_ENV: "TEST_ROOT",
  TREE_PERMIT_ROOT_ID_ENV: "TEST_ROOT_ID", TREE_PERMIT_TOKEN_ENV: "TEST_TOKEN",
  createSharedForegroundPermitScopeManager: () => ({ acquire: async () => undefined, release: async () => true, cancelSettlementWatchersIfIdle: async () => undefined }),
  createTreePermitAuthorityLifecycle: () => ({ startup: async () => null, get: async () => null }),
}));
const runner = await import("../../src/runtime/runner");
type Options = Parameters<typeof runner.runAgent>[0];
let onLeaf: (leaf: { options: Options; finish: () => void }) => void = () => {};
const routed: Options[] = [];
const surfaces = Array.from({ length: 40 }, (_, i) => ({ runId: `exact-run-${i}`, agent: `pane-agent-${i}`, ownership: "managed" as const, backend: "tmux-pane" as const, depth: 1, startedAt: i, updatedAt: i }));
const focused: string[] = [];
mock.module("../../src/runtime/runner", () => ({ ...runner,
  runAgent: async (options: Options) => {
    options.onSteeringReady?.(Object.assign(async () => { routed.push(options); return "submitted" as const; }, { isAvailable: () => true }));
    await new Promise<void>(finish => onLeaf({ options, finish }));
    return { agent: options.agentName, agentSource: "user", task: options.task, exitCode: 0, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
  },
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

test("native steering uses exact live leaves, skips single leaf selection, and revalidates after dialogs", { timeout: 15_000 }, async () => {
  const saved = { ...process.env };
  surfaces.length = 0;
  const cache = path.join(process.cwd(), "node_modules/.cache/leaf-steering");
  await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, "ui-fixture-"));
  const leaves: Array<{ options: Options; finish: () => void }> = [];
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  let tool: any;
  const notices: string[] = [];
  const dialogs: string[] = [];
  let select: (title: string, labels: string[]) => Promise<string | undefined> = async (_title, labels) => labels[0];
  let input: () => Promise<string | undefined> = async () => "literal instruction";
  const ctx = { cwd: root, hasUI: true, mode: "tui", isIdle: () => true,
    sessionManager: SessionManager.inMemory(root), ui: {
      notify: (text: string) => notices.push(text), confirm: async () => false, setStatus() {}, setWidget() {},
      select: async (title: string, labels: string[]) => { dialogs.push(title); return select(title, labels); },
      input: async () => { dialogs.push("input"); return input(); },
    } };
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_SUBAGENT_DEPTH; delete process.env.PI_SUBAGENT_STACK;
    process.env.PI_SUBAGENT_TERMINAL_MODE = "inline";
    await fs.mkdir(path.join(root, "agents"));
    await fs.writeFile(path.join(root, "agents/a.md"), "---\nname: a\ndescription: Test\ntools: read\n---\nTest\n");
    register({ registerToolRenderer() {}, registerMessageRenderer() {}, registerFlag() {},
      registerTool: (value: any) => { if (value.name === "subagent") tool = value; },
      registerCommand: (name: string, value: any) => commands.set(name, value),
      getFlag: (name: string) => name === "subagent-max-active" ? "2" : undefined,
      on: (name: string, handler: any) => {
        const previous = handlers.get(name);
        handlers.set(name, previous ? async (...args: any[]) => { await previous(...args); return handler(...args); } : handler);
      }, getAllTools: () => [], getCommands: () => [], sendMessage() {}, events: { emit() {} },
    } as never);
    await handlers.get("session_start")({}, ctx);
    const invoke = (params: any) => tool.execute("call", params, new AbortController().signal, undefined, ctx);
    const command = commands.get("subagents").handler;
    const start = async (params: any, count: number) => {
      let ready!: () => void;
      const started = new Promise<void>(resolve => { ready = resolve; });
      const before = leaves.length;
      onLeaf = leaf => { leaves.push(leaf); if (leaves.length === before + count) ready(); };
      const accepted = await invoke({ ...params, background: true });
      await started; return accepted.details.jobId as string;
    };
    const single = await start({ agent: "a", task: "single" }, 1);
    select = async (title, labels) => title === "Subagent action" ? "Steer running child" : labels.find(label => label.includes("a ·"));
    await command("", ctx);
    assert.equal(routed.length, 1); assert.equal(routed[0], leaves[0]!.options);
    assert.equal(dialogs.some(title => title.startsWith("Currently running leaves")), false);
    assert.match(notices.at(-1)!, /bounded inbox.*not native queue/);

    // Dismissed input and invalid UTF-8 budgets do not touch transport.
    input = async () => undefined; await command("", ctx); assert.equal(routed.length, 1);
    input = async () => "한".repeat(171); await command("", ctx);
    assert.match(notices.at(-1)!, /512 UTF-8/); assert.equal(routed.length, 1);
    await invoke({ action: "cancel", id: single }); leaves[0]!.finish();

    const parallel = await start({ tasks: [{ agent: "a", task: "left" }, { agent: "a", task: "right" }] }, 2);
    const status = await invoke({ action: "status", id: parallel });
    const ids = status.structuredContent.jobs[0].liveLeaves.map((leaf: any) => leaf.childId);
    select = async (title, labels) => title === "Subagent action" ? "Steer running child"
      : title.startsWith("Currently running leaves") ? labels.find(label => label.endsWith(ids[1]))
      : labels.find(label => label.includes("parallel"));
    const chooseParallel = select;
    select = async (title, labels) => title.startsWith("Currently running leaves") ? undefined : chooseParallel(title, labels);
    const beforeInput = dialogs.filter(title => title === "input").length;
    await command("", ctx);
    assert.equal(dialogs.filter(title => title === "input").length, beforeInput, "dismissing leaf selection has no effect");
    assert.equal(routed.length, 1);
    select = chooseParallel;
    input = async () => "only right";
    await command("", ctx);
    assert.equal(routed.at(-1), leaves[2]!.options); assert.equal(routed.length, 2);
    assert.ok(dialogs.some(title => title.startsWith("Currently running leaves")));
    // Dialog selection labels are not authority: cancel after selection, before send.
    input = async () => { await invoke({ action: "cancel", id: parallel }); return "must not send"; };
    await command("", ctx); assert.equal(routed.length, 2);
    assert.match(notices.at(-1)!, /unavailable/);
    leaves[1]!.finish(); leaves[2]!.finish();

    const stale = await start({ agent: "a", task: "stale" }, 1);
    select = async (title, labels) => title === "Subagent action" ? "Steer running child" : labels.find(label => label.includes("a ·"));
    input = async () => { await handlers.get("session_start")({}, ctx); return "old dialog"; };
    await command("", ctx); assert.equal(routed.length, 2);
    assert.match(notices.at(-1)!, /unavailable/);
    assert.ok(stale);
    // RPC/non-TUI modes retain list behavior; never open native input/select.
    const beforeDialogs = dialogs.length;
    await command("", { ...ctx, mode: "rpc" });
    assert.equal(dialogs.length, beforeDialogs);
  } finally {
    for (const leaf of leaves) leaf.finish();
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await fs.rm(root, { recursive: true, force: true });
  }
});
