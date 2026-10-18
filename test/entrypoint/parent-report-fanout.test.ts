// @ts-expect-error Bun runtime mock is absent from the project's Node-only types.
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PARENT_REPORT_CUSTOM_TYPE, type ParentReportKind } from "../../src/runtime/parent-report";

// Keep real discovery, invocation validation, scheduler, fanout and admission.
// Only replace process launch and durable permit startup; no provider/backend.
mock.module("../../src/runtime/tree-permit-authority", () => ({
  TREE_PERMIT_LEASE_ID_ENV: "TEST_LEASE_ID", TREE_PERMIT_LEASE_TOKEN_ENV: "TEST_LEASE_TOKEN",
  TREE_PERMIT_MAX_ACTIVE_ENV: "TEST_MAX_ACTIVE", TREE_PERMIT_ROOT_ENV: "TEST_ROOT",
  TREE_PERMIT_ROOT_ID_ENV: "TEST_ROOT_ID", TREE_PERMIT_TOKEN_ENV: "TEST_TOKEN",
  createSharedForegroundPermitScopeManager: () => ({ acquire: async () => undefined, release: async () => true, cancelSettlementWatchersIfIdle: async () => undefined }),
  createTreePermitAuthorityLifecycle: () => ({ startup: async () => null, get: async () => null }),
}));
const runner = await import("../../src/runtime/runner");
type Options = Parameters<typeof runner.runAgent>[0];
const leaves: Array<{ options: Options; finish: () => void }> = [];
mock.module("../../src/runtime/runner", () => ({ ...runner, runAgent: async (options: Options) => {
  await new Promise<void>(finish => { leaves.push({ options, finish }); });
  return { agent: options.agentName, agentSource: "user", task: options.task, exitCode: 0, messages: [], stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
} }));
const { default: register } = await import("../../index");
async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw Error("entrypoint did not reach expected boundary");
}

test("production background leaf binding: single, same-agent parallel, chain positions, terminal/skipped/queued/cancel/session fences and shared cap", { timeout: 20_000 }, async () => {
  const saved = { ...process.env };
  await fs.mkdir(path.join(process.cwd(), ".bun-tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/report-entrypoint-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: any[] = [];
  let tool: any;
  const manager = SessionManager.inMemory(root);
  const ctx = { cwd: root, hasUI: false, isIdle: () => true, ui: { notify: () => {}, confirm: async () => false }, sessionManager: manager };
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_SUBAGENT_DEPTH; delete process.env.PI_SUBAGENT_STACK;
    process.env.PI_SUBAGENT_TERMINAL_MODE = "inline";
    await fs.mkdir(path.join(root, "agents"));
    for (const name of ["reporter", "other"]) await fs.writeFile(path.join(root, "agents", `${name}.md`), `---\nname: ${name}\ndescription: Reporter\ntools: read\n---\nReport\n`);
    register({ registerToolRenderer: () => {}, registerMessageRenderer: () => {}, registerFlag: () => {},
      getFlag: (name: string) => name === "subagent-max-active" ? "2" : undefined,
      registerCommand: () => {}, registerTool: (value: any) => { if (value.name === "subagent") tool = value; },
      on: (event: string, handler: any) => handlers.set(event, handler), events: { emit: () => {} },
      sendMessage: (message: any, options: any) => sent.push({ message, options }),
      appendEntry: (type: string, data: any) => manager.appendCustomEntry(type, data), getAllTools: () => [], getCommands: () => [],
    } as never);
    await handlers.get("session_start")!({}, ctx);
    const invoke = (params: any) => tool.execute("call", params, new AbortController().signal, undefined, ctx);
    const reports = () => sent.filter(s => s.message.customType === PARENT_REPORT_CUSTOM_TYPE);
    const checkReport = (leaf: typeof leaves[number], expected: any, kind?: ParentReportKind) => {
      const role = leaf.options.agents.find(agent => agent.name === leaf.options.agentName)!;
      assert.deepEqual(role.tools, ["read"], "background leaf binding needs no role messaging permission");
      const args = runner.buildPiArgs(role, null, "/task", "spawn", null, undefined, "managed", undefined, "1.3.0", Boolean(leaf.options.onParentReport));
      assert.equal(args[args.indexOf("--tools") + 1], "read,report_to_parent");
      assert.equal(args.includes("builtin:codemode"), false);
      assert.equal(leaf.options.onParentReport?.(`body-${reports().length}`, kind), true);
      const last = reports().at(-1)!;
      assert.deepEqual(last.options, kind && kind !== "progress" ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "nextTurn", triggerTurn: false });
      assert.equal(last.message.details.reportKind, kind ?? "progress");
      assert.equal(last.message.details.agent, leaf.options.agentName);
      assert.equal(last.message.details.version, 2);
      for (const [key, value] of Object.entries(expected)) assert.equal(last.message.details[key], value);
      for (const key of ["task", "cwd", "model", "history"]) assert.equal(key in last.message.details, false);
      return last.message.details;
    };
    await invoke({ agent: "other", task: "single", background: true }); await until(() => leaves.length === 1);
    const single = leaves[0]!;
    assert.equal(typeof single.options.onSteeringReady, "function");
    checkReport(single, { mode: "single" }, "finding"); single.finish();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(single.options.onParentReport!("completed single"), false);

    await invoke({ tasks: [{ agent: "reporter", task: "parallel-a" }, { agent: "reporter", task: "parallel-b" }], background: true });
    await until(() => leaves.length === 3);
    const [a, b] = leaves.slice(1);
    assert.equal(a!.options.task, "parallel-a"); assert.equal(b!.options.task, "parallel-b");
    const ai = checkReport(a!, { mode: "parallel", taskIndex: 0 }, "question");
    const bi = checkReport(b!, { mode: "parallel", taskIndex: 1 });
    assert.equal(ai.jobId, bi.jobId); assert.notEqual(ai.childId, bi.childId);
    assert.equal(a!.options.onSteeringReady, undefined); assert.equal(b!.options.onSteeringReady, undefined);
    a!.finish(); await new Promise(r => setTimeout(r, 0));
    assert.equal(a!.options.onParentReport!("completed sibling"), false);
    checkReport(b!, { childId: bi.childId }); b!.finish();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(b!.options.onParentReport!("completed parallel"), false);

    // Default step-1 and explicit step-1 legally collide in display. Identity
    // is the leaf UUID + stage index, never a label/agent lookup.
    await invoke({ chain: [
      { agent: "reporter", task: "sequential-a" },
      { label: "skip", condition: "on_error", agent: "reporter", task: "SKIPPED" },
      { label: "step-1", type: "parallel", tasks: [{ agent: "reporter", task: "stage-a" }, { agent: "reporter", task: "stage-b" }] },
      { label: "last", agent: "reporter", task: "sequential-b" },
    ], background: true });
    await until(() => leaves.length === 4);
    const first = leaves[3]!;
    const fi = checkReport(first, { mode: "chain", stageIndex: 0, stageLabel: "step-1" });
    first.finish(); await until(() => leaves.length === 6);
    assert.equal(first.options.onParentReport!("previous stage"), false);
    const pi = checkReport(leaves[4]!, { stageIndex: 2, stageLabel: "step-1", taskIndex: 0 }, "blocked");
    const qi = checkReport(leaves[5]!, { stageIndex: 2, stageLabel: "step-1", taskIndex: 1 });
    assert.equal(fi.jobId, pi.jobId); assert.equal(pi.jobId, qi.jobId);
    for (const leaf of leaves.slice(3, 6)) assert.equal(leaf.options.onSteeringReady, undefined);
    assert.match(leaves[4]!.options.task, /Current task:\nstage-a$/);
    assert.match(leaves[5]!.options.task, /Current task:\nstage-b$/);
    leaves[4]!.finish(); leaves[5]!.finish(); await until(() => leaves.length === 7);
    assert.equal(leaves[4]!.options.onParentReport!("old parallel stage"), false);
    assert.match(leaves[6]!.options.task, /Current task:\nsequential-b$/);
    checkReport(leaves[6]!, { agent: "reporter", stageIndex: 3, stageLabel: "last", taskIndex: undefined });
    assert.equal(leaves.some(l => l.options.task === "SKIPPED"), false);
    // Distinct identities for every scheduled leaf, even same names/labels.
    assert.equal(new Set(reports().map(r => r.message.details.childId)).size, 7);
    leaves[6]!.finish(); await new Promise(r => setTimeout(r, 0));
    assert.equal(leaves[6]!.options.onParentReport!("completed chain"), false);

    // Foreground does not acquire report or steer bindings in ANY shape.
    for (const params of [{ agent: "reporter", task: "fg" }, { tasks: [{ agent: "reporter", task: "fg" }] }, { chain: [{ agent: "reporter", task: "fg" }] }]) {
      const count = leaves.length, pending = invoke(params);
      await until(() => leaves.length === count + 1);
      assert.equal(leaves[count]!.options.onParentReport, undefined);
      assert.equal(leaves[count]!.options.onSteeringReady, undefined);
      leaves[count]!.finish(); await pending;
    }
    const count = leaves.length;
    const accepted = await invoke({ tasks: Array.from({ length: 3 }, (_, i) => ({ agent: "reporter", task: `cancel-${i}` })), background: true });
    await until(() => leaves.length === count + 2);
    const jobId = accepted.details.jobId;
    await invoke({ action: "cancel", id: jobId });
    for (const leaf of leaves.slice(count)) { assert.equal(leaf.options.onParentReport!("cancelled"), false); leaf.finish(); }
    await until(() => leaves.slice(count).every(l => l.options.signal?.aborted === true));
    await new Promise(r => setTimeout(r, 25));
    assert.equal(leaves.length, count + 2, "queued third task never started");

    await invoke({ agent: "other", task: "session stale", background: true });
    await until(() => leaves.length === count + 3);
    const stale = leaves.at(-1)!;
    await handlers.get("session_start")!({}, ctx);
    assert.equal(stale.options.onParentReport!("old session"), false); stale.finish();
    const before = leaves.length;
    await invoke({ tasks: [{ agent: "reporter", task: "budget-a" }, { agent: "reporter", task: "budget-b" }], background: true });
    await until(() => leaves.length === before + 2);
    // This runner seam bypasses the unchanged socket's four-attempt budget;
    // prove all leaves share the SAME persisted lifetime 32-reservation ledger.
    while (reports().length < 32) checkReport(leaves[before + reports().length % 2]!, { mode: "parallel" });
    assert.equal(leaves[before]!.options.onParentReport!("33rd"), false);
    assert.equal(leaves[before + 1]!.options.onParentReport!("34th"), false);
  } finally {
    for (const leaf of leaves) leaf.finish();
    await handlers.get("session_shutdown")?.({}, ctx);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); await fs.rm(root, { recursive: true, force: true });
  }
});
