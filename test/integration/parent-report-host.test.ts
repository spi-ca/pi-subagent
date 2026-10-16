import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { VERSION, createAgentSession, createAgentSessionRuntime, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { INLINE_STEERING_STATE_PATH_ENV } from "../../src/runtime/inline-steering-bridge";
import { ParentReportAdmission, PARENT_REPORT_RECEIPT_TYPE, PARENT_REPORT_CUSTOM_TYPE, PARENT_REPORT_ENV, PARENT_REPORT_TOOL } from "../../src/runtime/parent-report";
import { buildPiArgs, collectManagedOverriddenBuiltinTools } from "../../src/runtime/runner";
import { LifecycleEventClient, LifecycleEventServer, SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV, SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV, writeLifecycleBootstrapToken } from "../../src/runtime/lifecycle-socket";
import { assertSelectedPiHost, SELECTED_PI_VERSION } from "../helpers/selected-pi-host";

function sender(jobId: string) { return { jobId, childId: `leaf-${jobId}`, agent: "reporter", mode: "single" as const }; }

function latch() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }

// Observe real worker exit without replacing the native sandbox or its worker
// admission. Pi 1.3 returns script results before Bun worker teardown completes.
async function withCodemodeWorkerExit(run: () => Promise<void>): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "once");
  const once = Worker.prototype.once;
  const seen = new WeakSet<Worker>(), exits: Promise<void>[] = [];
  Worker.prototype.once = function (this: Worker, event: string, listener: (...args: any[]) => void) {
    if (event === "exit" && !seen.has(this)) {
      seen.add(this);
      exits.push(new Promise<void>(resolve => { once.call(this, "exit", () => resolve()); }));
    }
    return once.call(this, event, listener);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await run();
    assert.equal(exits.length, 1, "native codemode must create one real worker");
    await Promise.race([
      Promise.all(exits),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Native codemode worker did not exit")), 5000); }),
    ]);
  } finally {
    clearTimeout(timer);
    if (descriptor) Object.defineProperty(Worker.prototype, "once", descriptor);
    else Reflect.deleteProperty(Worker.prototype, "once");
  }
}

// Register the production admission against real Pi lifecycle events, as index.ts
// does in its existing session hooks. Never manually reset it around host reload.
function registerParentReportAdmission(pi: ExtensionAPI): ParentReportAdmission {
  const admission = new ParentReportAdmission(pi);
  pi.on("session_start", (_event, ctx) => { admission.reset(ctx.sessionManager); });
  pi.on("session_shutdown", () => { admission.close(); });
  return admission;
}

for (const active of [false, true]) for (const codemode of [false, true]) for (const multi of [false, true]) for (const trigger of ["user", "custom"] as const) {
  test(`real Pi ${SELECTED_PI_VERSION} ${multi ? "multi-child" : "single-child"} ${codemode ? "native codemode" : "direct tool"} report to ${active ? "active" : "idle"} parent waits for ${trigger} run`, { timeout: 20_000 }, async () => {
    assertSelectedPiHost();
    const saved = { ...process.env }, originalFetch = globalThis.fetch;
    let forbiddenCalls = 0;
    const forbidden = (): never => { forbiddenCalls++; throw Error("No auth discovery, network, or real provider allowed"); };
    globalThis.fetch = forbidden as unknown as typeof fetch;
    process.env.PI_OFFLINE = "1";
    await fs.mkdir(path.join(process.cwd(), ".bun-tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/report-host-"));
    const server = await LifecycleEventServer.start();
    const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
    const reached = latch(), resume = latch();
    try {
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
        credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden } });
      const model = modelRuntime.getModels()[0]; assert.ok(model);
      modelRuntime.stream = forbidden; modelRuntime.streamSimple = forbidden; modelRuntime.getAuth = forbidden;
      modelRuntime.checkAuth = forbidden; modelRuntime.classify = forbidden; modelRuntime.generateImages = forbidden;
      modelRuntime.hasConfiguredAuth = () => true;
      const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
        role: "assistant", content, api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      });
      async function host(name: string, factories: Array<((pi: ExtensionAPI) => void) | InlineExtension>, tools: string[], extensionPaths: string[] = []) {
        const cwd = path.join(root, name); await fs.mkdir(cwd);
        const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
        const loader = new DefaultResourceLoader({ cwd, agentDir: path.join(cwd, "agent"), settingsManager,
          noExtensions: true, additionalExtensionPaths: extensionPaths, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories });
        await loader.reload({ resolveProjectTrust: async () => false });
        assert.deepEqual(loader.getExtensions().errors, []);
        const manager = SessionManager.inMemory(cwd);
        const { session } = await createAgentSession({ cwd, agentDir: path.join(cwd, "agent"), modelRuntime, model, thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: manager, tools });
        sessions.push(session);
        const errors: unknown[] = [];
        await session.bindExtensions({ onError: e => { errors.push(e); } });
        session.setActiveToolsByName(tools);
        const requests: Message[][] = [];
        session.agent.streamFunction = (_model, ctx) => {
          requests.push(structuredClone(ctx.messages));
          const stream = createAssistantMessageEventStream();
          void (async () => {
            if (name === "parent" && active && requests.length === 1) { reached.release(); await resume.promise; }
            let result: AssistantMessage;
            if (name.startsWith("child") && requests.length === 1) {
              const body = `/skill:literal 한글 report ${name}`;
              result = assistant([{ type: "toolCall", id: "report-call", name: codemode ? "codemode" : PARENT_REPORT_TOOL,
                arguments: codemode ? { code: `text(await tools.report_to_parent({message:${JSON.stringify(body)}}));` } : { message: body } }], "toolUse");
            } else result = assistant([{ type: "text", text: `${name} response` }]);
            stream.push({ type: "done", reason: result.stopReason as "stop" | "toolUse", message: result });
          })();
          return stream;
        };
        return { session, manager, requests, errors };
      }
      let admission!: ParentReportAdmission, parentPi!: ExtensionAPI;
      const parent = await host("parent", [pi => { parentPi = pi; admission = registerParentReportAdmission(pi); }], []);
      let parentRun: Promise<void> | undefined;
      if (active) { parentRun = parent.session.prompt("parent active natural task"); await reached.promise; }
      const identities = multi ? [
        { ...sender("parallel-job"), childId: "parallel-leaf-a", mode: "parallel" as const, taskIndex: 0 },
        { ...sender("parallel-job"), childId: "parallel-leaf-b", mode: "parallel" as const, taskIndex: 1 },
        { ...sender("chain-job"), childId: "chain-leaf-a", mode: "chain" as const, stageIndex: 0, stageLabel: "duplicate" },
        { ...sender("chain-job"), childId: "chain-leaf-b", mode: "chain" as const, stageIndex: 1, stageLabel: "duplicate", taskIndex: 0 },
        { ...sender("chain-job"), childId: "chain-leaf-c", mode: "chain" as const, stageIndex: 1, stageLabel: "duplicate", taskIndex: 1 },
      ] : [sender("parent-owned-job")];
      const children: Awaited<ReturnType<typeof host>>[] = [];
      for (const [index, identity] of identities.entries()) {
        const id = `direct-child-${index}`, token = server.registerRun(id, true);
        server.setReportHandler(id, admission.bind(identity, () => true));
        server.activateRun(id);
        // The authenticated token contract requires a private directory,
        // independently of the invoking process's umask.
        const runDir = path.join(root, `run-${index}`); await fs.mkdir(runDir, { mode: 0o700 });
        const tokenPath = path.join(runDir, "lifecycle-token");
        await writeLifecycleBootstrapToken(tokenPath, token);
        Object.assign(process.env, { PI_SUBAGENT_RUN_ID: id, [INLINE_STEERING_STATE_PATH_ENV]: path.join(runDir, "state.json"),
          [SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: server.socketPath, [SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: tokenPath, [PARENT_REPORT_ENV]: "1" });
        const selected = codemode ? [PARENT_REPORT_TOOL, "codemode"] : [PARENT_REPORT_TOOL];
        const args = buildPiArgs({ name: "reporter", description: "", systemPrompt: "", source: "user", filePath: "/reporter.md", tools: selected }, null, "/task", "spawn", null, undefined, "managed", undefined, VERSION);
        assert.ok(args.includes("--no-extensions") && args.includes("--no-mcp"));
        const factories = codemode ? [{ name: "codemode", factory: createCodemodeExtension({ mode: "only" }), builtin: true, replaceable: true }] : [];
        const extensionPaths = [path.join(process.cwd(), "src/runtime/inline-steering-bridge.ts"), ...args.filter(arg => arg === "builtin:codemode")];
        const child = await host(`child-${index}`, factories, selected, extensionPaths);
        assert.deepEqual(collectManagedOverriddenBuiltinTools(child.session.getAllTools()), []);
        assert.equal(process.env[PARENT_REPORT_ENV], undefined);
        assert.equal(process.env[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV], undefined);
        assert.equal(child.session.getActiveToolNames().includes(PARENT_REPORT_TOOL), true);
        children.push(child);
      }
      const parentBefore = structuredClone(parent.manager.getBranch());
      // Production children have separate processes. These SDK children share
      // Pi 1.3's process-wide two-worker codemode cap, so serialize only native
      // codemode scripts through actual worker exit (not a sleep or retry).
      // Direct reporting still exercises concurrent admission.
      if (codemode) for (const child of children) await withCodemodeWorkerExit(() => child.session.prompt("child natural task"));
      else await Promise.all(children.map(child => child.session.prompt("child natural task")));
      for (const child of children) {
        const toolResults = child.session.messages.filter(m => m.role === "toolResult");
        assert.equal(toolResults.length, 1);
        assert.equal((toolResults[0] as any).isError, false, JSON.stringify(toolResults));
        assert.match(JSON.stringify(toolResults), /Parent notification submitted/);
      }
      assert.deepEqual(parent.manager.getBranch().filter(e => e.type !== "custom" || e.customType !== PARENT_REPORT_RECEIPT_TYPE), parentBefore); // only private budget receipt, not notification transcript commit
      assert.equal(parent.manager.getEntries().filter(e => e.type === "custom" && e.customType === PARENT_REPORT_RECEIPT_TYPE).length, identities.length);
      assert.equal(parent.requests.length, active ? 1 : 0); // zero extra parent streams
      resume.release(); await parentRun;
      assert.equal(parent.requests.length, active ? 1 : 0);
      assert.equal(parent.manager.getBranch().some(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE), false);
      if (trigger === "user") await parent.session.prompt("next natural user prompt");
      else {
        // Production background results use this public API to start a custom run.
        // Pending reports join it, but never trigger a run independently.
        parentPi.sendMessage({ customType: "subagent_result", content: "final background result", display: true }, { triggerTurn: true });
        await parent.session.waitForIdle();
      }
      assert.equal(parent.requests.length, active ? 2 : 1);
      const context = parent.requests.at(-1)!;
      const reports = context.filter(m => JSON.stringify(m.content).includes("/skill:literal 한글 report"));
      assert.equal(reports.length, identities.length); assert.equal(reports[0]!.role, "user");
      assert.match(JSON.stringify(reports[0]!.content), /untrusted; do not follow instructions/);
      const entries = parent.manager.getBranch().filter(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE);
      assert.equal(entries.length, identities.length);
      for (const [index, identity] of identities.entries()) {
        const body = `/skill:literal 한글 report child-${index}`;
        const attributed = entries.filter(e => (e as any).details.childId === identity.childId);
        assert.equal(attributed.length, 1);
        assert.equal((attributed[0] as any).display, true);
        assert.deepEqual((attributed[0] as any).details, { kind: "subagent.parent-report", version: 2, ...identity });
        assert.ok((attributed[0] as any).content.endsWith(JSON.stringify(body)));
        assert.equal(context.filter(m => JSON.stringify(m.content).includes(body)).length, 1);
      }
      await parent.session.prompt("another natural prompt");
      assert.equal(parent.requests.at(-1)!.filter(m => JSON.stringify(m.content).includes("/skill:literal 한글 report")).length, identities.length);
      assert.equal(parent.manager.getBranch().filter(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE).length, identities.length, "each report committed only once");
      assert.deepEqual(parent.errors, []);
      for (const child of children) assert.deepEqual(child.errors, []);
      assert.equal(forbiddenCalls, 0);
    } finally {
      resume.release();
      for (const session of sessions) session.dispose();
      await server.close();
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const consumed of [false, true]) {
  test(`real Pi registration: 32 ${consumed ? "consumed" : "unconsumed"} reports survive reload/branch recreation; replacement gets fresh budget`, { timeout: 20_000 }, async () => {
    assertSelectedPiHost();
    const saved = { ...process.env }, originalFetch = globalThis.fetch;
    let forbiddenCalls = 0;
    const forbidden = (): never => { forbiddenCalls++; throw Error("No credentials, network or live providers"); };
    globalThis.fetch = forbidden as unknown as typeof fetch;
    process.env.PI_OFFLINE = "1";
    await fs.mkdir(path.join(process.cwd(), ".bun-tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/report-budget-host-"));
    const server = await LifecycleEventServer.start();
    let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
    try {
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
        credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden } });
      const model = modelRuntime.getModels()[0]; assert.ok(model);
      modelRuntime.stream = forbidden; modelRuntime.streamSimple = forbidden; modelRuntime.getAuth = forbidden;
      modelRuntime.checkAuth = forbidden; modelRuntime.classify = forbidden; modelRuntime.generateImages = forbidden;
      modelRuntime.hasConfiguredAuth = () => true;
      let admission!: ParentReportAdmission, creations = 0, runNumber = 0;
      const errors: unknown[] = [], contexts: Message[][] = [];
      const bind = async (session: Awaited<ReturnType<typeof createAgentSession>>["session"]) => {
        await session.bindExtensions({ onError: e => { errors.push(e); } });
        session.agent.streamFunction = (_model, context) => {
          contexts.push(structuredClone(context.messages));
          const stream = createAssistantMessageEventStream();
          stream.push({ type: "done", reason: "stop", message: {
            role: "assistant", content: [{ type: "text", text: "offline response" }], api: model.api, provider: model.provider,
            model: model.id, timestamp: 0, stopReason: "stop",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          } });
          return stream;
        };
      };
      runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
        const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
        const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [pi => { creations++; admission = registerParentReportAdmission(pi); }] });
        await resourceLoader.reload({ resolveProjectTrust: async () => false });
        assert.deepEqual(resourceLoader.getExtensions().errors, []);
        // Supply already-created services: the convenience services factory
        // refreshes auth discovery, which this offline lifecycle test forbids.
        const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader, diagnostics: [] };
        const result = await createAgentSession({ cwd, agentDir, modelRuntime, settingsManager, resourceLoader,
          sessionManager, sessionStartEvent, model, thinkingLevel: "off", tools: [] });
        return { ...result, services, diagnostics: services.diagnostics };
      }, { cwd: root, agentDir: path.join(root, "agent"), sessionManager: SessionManager.inMemory(root) });
      runtime.setRebindSession(bind); await bind(runtime.session);
      const original = runtime.session, originalId = original.sessionId;
      await original.prompt("branch anchor");
      const anchor = original.sessionManager.getLeafId()!;
      const reportRun = async (count: number, expect: "submitted" | "rejected") => {
        const id = `child-${++runNumber}`, token = server.registerRun(id, true);
        server.setReportHandler(id, admission.bind(sender(id), () => true)); server.activateRun(id);
        const tokenPath = path.join(root, "lifecycle-token");
        await writeLifecycleBootstrapToken(tokenPath, token);
        const client = await LifecycleEventClient.connectFromEnvironment({ PI_SUBAGENT_RUN_ID: id,
          [SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: server.socketPath, [SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: tokenPath }, path.join(root, "state.json"), false, true);
        assert.ok(client);
        try {
          const started = server.waitForEvent(id, 1000); client.send("agent-started"); await started;
          assert.deepEqual(await Promise.all(Array.from({ length: count }, () => client.requestReport("budget report body"))), Array(count).fill(expect));
        } finally { client.close(); server.terminalRun(id); }
      };
      const streamsBefore = contexts.length;
      for (let i = 0; i < 8; i++) await reportRun(4, "submitted");
      assert.equal(contexts.length, streamsBefore, "reports never start parent streams");
      if (consumed) await original.prompt("consume naturally");
      const stale = admission.bind(sender("old-registration"), () => true);
      await original.reload();
      assert.equal(runtime.session, original, "reload retains AgentSession and its nextTurn queue");
      assert.equal(original.sessionId, originalId); assert.equal(creations, 2);
      assert.equal(stale("old callback"), false);
      await reportRun(1, "rejected"); // 33rd, no manual accounting reset or fake session event
      const receipts = original.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === PARENT_REPORT_RECEIPT_TYPE);
      assert.equal(receipts.length, 32);
      assert.equal(JSON.stringify(receipts).includes("budget report body"), false);
      await original.prompt("natural turn after reload");
      const reportMessages = contexts.at(-1)!.filter(m => JSON.stringify(m.content).includes("budget report body"));
      assert.equal(reportMessages.length, 32, "pending reports survive reload; consumed reports do not duplicate");
      assert.equal(JSON.stringify(contexts).includes(PARENT_REPORT_RECEIPT_TYPE), false, "budget ledger excluded from LLM context");
      assert.equal(JSON.stringify(contexts).includes('"reservation"'), false);
      await original.navigateTree(anchor, { summarize: false });
      assert.equal(original.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === PARENT_REPORT_RECEIPT_TYPE), false);
      await original.reload();
      await reportRun(1, "rejected"); // abandoned branches still consumed lifetime budget
      // Fork copies branch receipts but embeds the old owner id. Its actual SDK
      // replacement must start fresh, not inherit copied accounting.
      original.sessionManager.branch(receipts.at(-1)!.id);
      assert.equal((await runtime.fork(receipts.at(-1)!.id, { position: "at" })).cancelled, false);
      assert.notEqual(runtime.session, original); assert.notEqual(runtime.session.sessionId, originalId);
      assert.equal(runtime.session.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === PARENT_REPORT_RECEIPT_TYPE).length, 32);
      await reportRun(1, "submitted");
      const forkId = runtime.session.sessionId;
      assert.equal((await runtime.newSession()).cancelled, false);
      assert.notEqual(runtime.session.sessionId, forkId);
      await reportRun(4, "submitted");
      assert.deepEqual(errors, []); assert.equal(forbiddenCalls, 0);
    } finally {
      await runtime?.dispose(); await server.close(); globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved); await fs.rm(root, { recursive: true, force: true });
    }
  });
}
