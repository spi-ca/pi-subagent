import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
import { VERSION, createAgentSession, createAgentSessionRuntime, createCodemodeExtension, createReadTool, createGrepTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type InlineExtension, defineTool } from "@earendil-works/pi-coding-agent";
import { Type, createAssistantMessageEventStream, type AssistantMessage, type Message, type JsonObject } from "@earendil-works/pi-ai";
import { INLINE_STEERING_STATE_PATH_ENV } from "../../src/runtime/inline-steering-bridge";
import { ParentReportAdmission, registerParentReportHooks, PARENT_REPORT_CUSTOM_TYPE, PARENT_REPORT_ENV, PARENT_REPORT_TOOL, prepareParentReportHandler, registerParentReportTool } from "../../src/runtime/parent-report";
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
  registerParentReportHooks(pi, admission);
  pi.on("session_start", (_event, ctx) => { admission.reset(ctx.sessionManager, ctx); });
  pi.on("session_shutdown", () => { admission.close(); });
  return admission;
}

for (const active of [false, true]) for (const codemode of [false, true]) for (const multi of [false, true]) for (const trigger of ["user", "custom"] as const) {
  test(`real Pi ${SELECTED_PI_VERSION} ${multi ? "multi-child" : "single-child"} ${codemode ? "native codemode" : "direct tool"} report to ${active ? "active" : "idle"} parent drains at ${active ? "successful boundary then" : "next"} ${trigger} run`, { timeout: 20_000 }, async () => {
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
      async function host(name: string, factories: Array<((pi: ExtensionAPI) => void) | InlineExtension>, tools: string[] | undefined, extensionPaths: string[] = [], restoredManager?: SessionManager, excludeTools?: string[]) {
        const cwd = path.join(root, name); await fs.mkdir(cwd);
        const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
        const loader = new DefaultResourceLoader({ cwd, agentDir: path.join(cwd, "agent"), settingsManager,
          noExtensions: true, additionalExtensionPaths: extensionPaths, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories });
        await loader.reload({ resolveProjectTrust: async () => false });
        assert.deepEqual(loader.getExtensions().errors, []);
        const manager = restoredManager ?? SessionManager.inMemory(cwd);
        const { session } = await createAgentSession({ cwd, agentDir: path.join(cwd, "agent"), modelRuntime, model, thinkingLevel: "off", settingsManager, resourceLoader: loader, sessionManager: manager, tools, excludeTools });
        sessions.push(session);
        const errors: unknown[] = [], statuses: Array<[string, string | undefined]> = [], notifications: string[] = [];
        await session.bindExtensions({ onError: e => { errors.push(e); }, ...(name === "parent" ? {
          mode: "tui" as const, uiContext: { setStatus: (key: string, text?: string) => { statuses.push([key, text]); },
            notify: (text: string) => { notifications.push(text); } } as never,
        } : {}) });
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
        return { session, manager, requests, errors, statuses, notifications };
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
        const submit = admission.bind(identity, () => true);
        server.setReportHandler(id, (body, _eligible, kind) => submit(body, kind));
        server.activateRun(id);
        // The authenticated token contract requires a private directory,
        // independently of the invoking process's umask.
        const runDir = path.join(root, `run-${index}`); await fs.mkdir(runDir, { mode: 0o700 });
        const tokenPath = path.join(runDir, "lifecycle-token");
        await writeLifecycleBootstrapToken(tokenPath, token);
        Object.assign(process.env, { PI_SUBAGENT_RUN_ID: id, [INLINE_STEERING_STATE_PATH_ENV]: path.join(runDir, "state.json"),
          [SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: server.socketPath, [SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: tokenPath, [PARENT_REPORT_ENV]: "1" });
        let roleTools: string[] | undefined = ["read"];
        if (codemode) roleTools = ["read", "codemode"];
        else if (multi) roleTools = undefined;
        const delegationMode = roleTools === undefined ? "fork" : "spawn";
        const args = buildPiArgs({ name: "reporter", description: "", systemPrompt: "", source: "user", filePath: "/reporter.md", tools: roleTools }, null, "/task", delegationMode, "/session", undefined, "managed", undefined, VERSION, true);
        let restoredManager: SessionManager | undefined;
        if (roleTools === undefined) {
          assert.equal(args.includes("--tools"), false, "automatic report must not replace omitted tool selection");
          restoredManager = SessionManager.inMemory(root);
          const declarations = [createReadTool(root), createGrepTool(root)].map(({ name, description, parameters }) => ({ name, description, parameters }));
          restoredManager.appendMessage({ role: "system", content: "", toolsAdded: declarations, timestamp: 0 });
        }
        const toolsIndex = args.indexOf("--tools");
        const selected = toolsIndex < 0 ? undefined : args[toolsIndex + 1]!.split(",");
        assert.ok(args.includes("--no-extensions") && args.includes("--no-mcp"));
        const factories = codemode ? [{ name: "codemode", factory: createCodemodeExtension({ mode: "only" }), builtin: true, replaceable: true }] : [];
        const extensionPaths = [path.join(process.cwd(), "src/runtime/inline-steering-bridge.ts"), ...args.filter(arg => arg === "builtin:codemode")];
        const child = await host(`child-${index}`, factories, selected, extensionPaths, restoredManager);
        assert.deepEqual(child.session.getActiveToolNames().sort(), [...(roleTools ?? ["read", "grep"]), PARENT_REPORT_TOOL].sort(), "only reporting supplements role or restored tools");
        assert.deepEqual(collectManagedOverriddenBuiltinTools(child.session.getAllTools()), []);
        assert.equal(process.env[PARENT_REPORT_ENV], undefined);
        assert.equal(process.env[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV], undefined);
        assert.equal(child.session.getActiveToolNames().includes(PARENT_REPORT_TOOL), true);
        children.push(child);
      }
      if (!active && !codemode && !multi && trigger === "user") {
        Object.assign(process.env, { [PARENT_REPORT_ENV]: "1", [INLINE_STEERING_STATE_PATH_ENV]: path.join(root, "excluded-state.json") });
        const excluded = await host("excluded", [], ["read", PARENT_REPORT_TOOL], [path.join(process.cwd(), "src/runtime/inline-steering-bridge.ts")], undefined, [PARENT_REPORT_TOOL]);
        assert.deepEqual(excluded.session.getActiveToolNames(), ["read"], "automatic reporting never bypasses inherited --exclude-tools");
        assert.equal(excluded.session.getAllTools().some(tool => tool.name === PARENT_REPORT_TOOL), false);
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
      assert.deepEqual(parent.manager.getBranch(), parentBefore, "app-owned admission writes no transcript/ledger");
      assert.equal(parent.requests.length, active ? 1 : 0); // zero extra parent streams
      const progressStatuses = parent.statuses.filter(([key, text]) => key === "pi-subagent-reports" && text !== undefined);
      assert.equal(progressStatuses.length, identities.length, "progress UI is immediate, not deferred until model consumption");
      assert.ok(progressStatuses.every(([, text]) => text!.length < 400 && /Progress \(untrusted\)/.test(text!)));
      assert.deepEqual(parent.notifications, [], "no notify spam");
      resume.release(); await parentRun;
      assert.equal(parent.requests.length, active ? 1 : 0);
      assert.equal(parent.manager.getBranch().some(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE), active, "active run commits progress at successful turn_end without continuation");
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
      assert.equal(reports.length, 1, "singular batch message"); assert.equal(reports[0]!.role, "user");
      assert.match(JSON.stringify(reports[0]!.content), /untrusted; do not follow instructions/);
      const entries = parent.manager.getBranch().filter(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE);
      assert.equal(entries.length, 1);
      for (const [index, identity] of identities.entries()) {
        const body = `/skill:literal 한글 report child-${index}`;
        const attributed = (entries[0] as any).details.reports.filter((details: any) => details.childId === identity.childId);
        assert.equal(attributed.length, 1);
        assert.equal((entries[0] as any).display, true);
        const { reportId, receivedAtMs, submittedAtMs, ...details } = attributed[0];
        assert.match(reportId, /^[a-f0-9-]{36}$/); assert.ok(Number.isSafeInteger(receivedAtMs)); assert.ok(submittedAtMs >= receivedAtMs);
        assert.ok((entries[0] as any).content.includes(`Report ID: ${reportId}; parent receivedAtMs: ${receivedAtMs}; first submittedAtMs: ${submittedAtMs}`));
        assert.deepEqual(details, { kind: "subagent.parent-report", version: 3, ...identity, reportKind: "progress" });
        assert.ok((entries[0] as any).content.includes(JSON.stringify(body)));
        assert.equal(context.filter(m => JSON.stringify(m.content).includes(body)).length, 1);
      }
      await parent.session.prompt("another natural prompt");
      assert.equal(parent.requests.at(-1)!.filter(m => JSON.stringify(m.content).includes("/skill:literal 한글 report")).length, 1);
      assert.equal(parent.manager.getBranch().filter(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE).length, 1, "each batch committed only once");
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
  test(`real Pi registration: app-owned ${consumed ? "committed" : "pending"} reports on reload/branch/session replacement; budget reusable after drains`, { timeout: 20_000 }, async () => {
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
      let duringRequest: (() => void) | undefined;
      let responseStop: "stop" | "error" | "aborted" = "stop";
      let replaceBoundary = false, addBoundaryEntry = false;
      const errors: unknown[] = [], contexts: Message[][] = [];
      const bind = async (session: Awaited<ReturnType<typeof createAgentSession>>["session"]) => {
        await session.bindExtensions({ onError: e => { errors.push(e); } });
        session.agent.streamFunction = (_model, context) => {
          contexts.push(structuredClone(context.messages));
          const action = duringRequest; duringRequest = undefined; action?.();
          const stream = createAssistantMessageEventStream();
          const response: AssistantMessage = {
            role: "assistant", content: [{ type: "text", text: "offline response" }], api: model.api, provider: model.provider,
            model: model.id, timestamp: 0, stopReason: responseStop,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          if (responseStop === "stop") stream.push({ type: "done", reason: "stop", message: response });
          else stream.push({ type: "error", reason: responseStop, error: response });
          return stream;
        };
      };
      runtime = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
        const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
        const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
          noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [pi => {
            creations++;
            pi.on("turn_end", event => {
              if (addBoundaryEntry) return { entries: [...event.entries, { type: "custom", customType: "other-boundary", data: 1 }], continue: event.continue };
            });
            admission = registerParentReportAdmission(pi);
            pi.on("turn_end", event => {
              if (replaceBoundary) return { entries: event.entries.filter(entry => entry.type !== "custom_message" || entry.customType !== PARENT_REPORT_CUSTOM_TYPE), continue: event.continue };
            });
          }] });
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
      const reportRun = (count: number, expect: boolean) => {
        for (let i = 0; i < count; i++) {
          const id = `child-${++runNumber}`;
          assert.equal(admission.bind(sender(id), () => true)("budget report body"), expect);
        }
      };
      const streamsBefore = contexts.length;
      reportRun(32, true); reportRun(1, false);
      assert.equal(contexts.length, streamsBefore, "progress never starts parent streams");
      if (consumed) await original.prompt("consume naturally");
      const stale = admission.bind(sender("old-registration"), () => true);
      await original.reload();
      assert.equal(runtime.session, original); assert.equal(original.sessionId, originalId); assert.equal(creations, 2);
      assert.equal(stale("old callback"), false);
      assert.equal(original.sessionManager.getEntries().some(e => e.type === "custom"), false, "no private reservation ledger");
      await original.prompt("natural turn after reload");
      const reportMessages = contexts.at(-1)!.filter(m => JSON.stringify(m.content).includes("budget report body"));
      assert.equal(reportMessages.length, consumed ? 2 : 0, "uncommitted app progress is not persistent across reload");
      // More than 32 lifetime sends, but never more than 32 outstanding. Each
      // natural start/turn_end drains two batches without progress continuation.
      for (let round = 0; round < 3; round++) {
        reportRun(32, true); reportRun(1, false);
        const before = contexts.length;
        await original.prompt(`drain round ${round}`);
        assert.equal(contexts.length, before + 1);
      }
      // Real host boundary replacement must not refund/rewrite a handed-off
      // snapshot. New progress stays pending until the original batch commits.
      replaceBoundary = true; addBoundaryEntry = true;
      const boundarySubmit = admission.bind(sender("boundary-child"), () => true);
      duringRequest = () => {
        assert.equal(boundarySubmit("superseded pending body"), true);
        assert.equal(boundarySubmit("boundary original"), true);
      };
      let before = contexts.length; await original.prompt("replace boundary draft");
      assert.equal(contexts.length, before + 1, "progress-only boundary cannot force continuation");
      const heldToken = (admission as any).progress.message.details.batchToken;
      assert.equal((admission as any).progress.reports.length, 1, "real host pending progress coalesces by child");
      assert.equal((admission as any).progress.message.content.includes("superseded pending body"), false);
      assert.equal(original.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === "other-boundary"), true, "preceding boundary drafts preserved");
      assert.equal(boundarySubmit("superseded behind in-flight batch"), true);
      assert.equal(boundarySubmit("new pending body"), true);
      assert.equal((admission as any).pending.length, 1);
      assert.equal((admission as any).progress.message.details.batchToken, heldToken);
      replaceBoundary = false; addBoundaryEntry = false;
      await original.prompt("retry unchanged boundary batch");
      const batchEntries = original.sessionManager.getBranch().filter(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE);
      assert.equal(batchEntries.filter(e => (e as any).details.batchToken === heldToken).length, 1);
      assert.equal(JSON.stringify(contexts.at(-1)).includes("boundary original"), true);
      assert.equal(JSON.stringify(contexts.at(-1)).includes("new pending body"), false, "new pending was not merged into the handed-off start batch");
      assert.equal((admission as any).pending.length, 0); assert.equal((admission as any).progress, undefined);
      for (const outcome of ["error", "aborted"] as const) {
        responseStop = outcome;
        duringRequest = () => { assert.equal(boundarySubmit(`held after ${outcome}`), true); };
        before = contexts.length; await original.prompt(`provider ${outcome}`);
        assert.equal(contexts.length, before + 1);
        assert.equal((admission as any).pending.length, 1, "unsuccessful turn_end does not hand off pending progress");
        responseStop = "stop"; await original.prompt("natural recovery");
        assert.equal(JSON.stringify(contexts.at(-1)).includes(`held after ${outcome}`), true);
        assert.equal((admission as any).pending.length, 0);
      }
      await original.navigateTree(anchor, { summarize: false }); await original.reload();
      reportRun(1, true);
      const forkAnchor = original.sessionManager.getLeafId()!;
      assert.equal((await runtime.fork(forkAnchor, { position: "at" })).cancelled, false);
      assert.notEqual(runtime.session, original); assert.notEqual(runtime.session.sessionId, originalId);
      reportRun(32, true); reportRun(1, false);
      const forkId = runtime.session.sessionId;
      assert.equal((await runtime.newSession()).cancelled, false);
      assert.notEqual(runtime.session.sessionId, forkId); reportRun(32, true);
      assert.deepEqual(errors, []); assert.equal(forbiddenCalls, 0);
    } finally {
      await runtime?.dispose(); await server.close(); globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved); await fs.rm(root, { recursive: true, force: true });
    }
  });
}

for (const kind of ["finding", "question", "blocked"] as const) for (const mode of kind === "finding" ? ["idle", "busy", "idle-error"] : ["idle", "busy"]) {
  const busy = mode === "busy", failStart = mode === "idle-error";
  test(`real Pi ${SELECTED_PI_VERSION} ${kind} ${mode} ${busy ? "steers after busy tool result" : "starts idle custom run"} through authenticated admission`, { timeout: 15_000 }, async () => {
    assertSelectedPiHost();
    const saved = { ...process.env }, originalFetch = globalThis.fetch;
    let forbiddenCalls = 0;
    const forbidden = (): never => { forbiddenCalls++; throw Error("Offline host forbids credentials/network/provider"); };
    globalThis.fetch = forbidden as unknown as typeof fetch;
    process.env.PI_OFFLINE = "1";
    await fs.mkdir(path.join(process.cwd(), ".bun-tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/report-important-host-"));
    const server = await LifecycleEventServer.start(), reached = latch(), resume = latch();
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined, client: LifecycleEventClient | null = null;
    let parentRun: Promise<void> | undefined;
    try {
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
        credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden } });
      const model = modelRuntime.getModels()[0]; assert.ok(model);
      modelRuntime.stream = forbidden; modelRuntime.streamSimple = forbidden; modelRuntime.getAuth = forbidden;
      modelRuntime.checkAuth = forbidden; modelRuntime.classify = forbidden; modelRuntime.generateImages = forbidden;
      modelRuntime.hasConfiguredAuth = () => true;
      const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
      let admission!: ParentReportAdmission, failPrompt = failStart;
      const starts: string[] = [], errors: any[] = [], contexts: Message[][] = [], statuses: unknown[] = [], notifications: unknown[] = [];
      const errorReported = latch();
      const loader = new DefaultResourceLoader({ cwd: root, agentDir: path.join(root, "agent"), settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [pi => {
          admission = registerParentReportAdmission(pi);
          pi.on("before_agent_start", event => {
            starts.push(event.messageType);
            if (failPrompt) {
              // Fault-inject prompt preparation through public event options,
              // not by replacing sendMessage/sendCustomMessage or appending.
              Object.defineProperty(event.systemPromptOptions, "selectedTools", {
                get: () => { throw Error("Synthetic prompt preparation failure"); },
              });
            }
          });
          pi.registerTool(defineTool({ name: "hold", label: "Hold", description: "Offline test boundary", parameters: Type.Object({}),
            async execute() { reached.release(); await resume.promise; return { content: [{ type: "text", text: "tool completed" }], details: undefined }; } }));
        }] });
      await loader.reload({ resolveProjectTrust: async () => false }); assert.deepEqual(loader.getExtensions().errors, []);
      const manager = SessionManager.inMemory(root);
      ({ session } = await createAgentSession({ cwd: root, agentDir: path.join(root, "agent"), modelRuntime, model, thinkingLevel: "off",
        settingsManager, resourceLoader: loader, sessionManager: manager, tools: ["hold"] }));
      await session.bindExtensions({ onError: e => { errors.push(e); errorReported.release(); }, mode: "tui",
        uiContext: { setStatus: (...args: unknown[]) => { statuses.push(args); }, notify: (...args: unknown[]) => { notifications.push(args); } } as never });
      session.agent.streamFunction = (_model, context) => {
        contexts.push(structuredClone(context.messages));
        const toolCall = busy && contexts.length === 1;
        const result: AssistantMessage = { role: "assistant", content: toolCall
          ? [{ type: "toolCall", id: "hold-call", name: "hold", arguments: {} }] : [{ type: "text", text: "offline answer" }],
          api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: toolCall ? "toolUse" : "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: toolCall ? "toolUse" : "stop", message: result }); return stream;
      };
      const identity = { ...sender("owned-important-job"), mode: "parallel" as const, taskIndex: 1 };
      const id = "important-child", token = server.registerRun(id, true);
      server.setReportHandler(id, prepareParentReportHandler(() => true, async () => true, admission.bind(identity, () => true)));
      server.activateRun(id);
      await writeLifecycleBootstrapToken(path.join(root, "lifecycle-token"), token);
      client = await LifecycleEventClient.connectFromEnvironment({ PI_SUBAGENT_RUN_ID: id,
        [SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: server.socketPath, [SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: path.join(root, "lifecycle-token") }, path.join(root, "state.json"), false, true);
      assert.ok(client);
      const started = server.waitForEvent(id, 1000); client.send("agent-started"); await started;
      if (busy) { parentRun = session.prompt("natural parent work"); await reached.promise; }
      const body = `/skill:literal important ${kind}`;
      if (failStart) assert.equal(admission.bind(sender("failed-start-progress"), () => true)("retained start draft"), true);
      assert.equal(await client.requestReport(body, undefined, () => true, kind), "submitted");
      if (failStart) {
        await errorReported.promise;
        assert.equal(errors.length, 1); assert.equal(errors[0].event, "send_message");
        assert.equal(errors[0].error, "Synthetic prompt preparation failure");
        assert.equal(JSON.stringify(errors).includes(body), false, "host async error does not echo report body");
        assert.equal(contexts.length, 0, "API submission is not a delivery/model-read promise");
        assert.equal((admission as any).important.length, 1, "native handoff stays charged after async start failure");
        assert.equal((admission as any).progress.reports.length, 1, "start draft not refunded/lost on failed preparation");
        failPrompt = false;
        await session.prompt("natural recovery after failed custom start");
        assert.equal((admission as any).progress, undefined, "recovered progress commit reconciled");
        assert.equal(JSON.stringify(contexts).includes("retained start draft"), true);
        assert.equal((admission as any).important.length, 1, "lost native content cannot be assumed committed or retried");
        assert.equal(forbiddenCalls, 0); return;
      }
      if (busy) {
        assert.equal(contexts.length, 1, "no model request while tool is outstanding");
        assert.equal(manager.getBranch().some(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE), false,
          "never append between assistant tool call and its result");
        resume.release(); await parentRun;
      }
      await session.waitForIdle();
      assert.equal(contexts.length, busy ? 2 : 1);
      assert.deepEqual(starts, [busy ? "user" : "custom"], "busy steering is not a second prompt; idle report starts a custom run");
      const request = contexts.at(-1)!;
      const reportIndex = request.findIndex(m => JSON.stringify(m.content).includes(body)); assert.ok(reportIndex >= 0);
      assert.equal(request[reportIndex]!.role, "user");
      assert.match(JSON.stringify(request[reportIndex]!.content), /untrusted; do not follow instructions/);
      if (busy) {
        const resultIndex = request.findIndex(m => m.role === "toolResult" && m.toolCallId === "hold-call");
        assert.ok(resultIndex >= 0 && resultIndex < reportIndex, "tool result precedes report in provider context");
        const branch = manager.getBranch();
        const toolIndex = branch.findIndex(e => e.type === "message" && e.message.role === "toolResult");
        const entryIndex = branch.findIndex(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE);
        assert.ok(toolIndex >= 0 && toolIndex < entryIndex, "persisted replay order is safe too");
      }
      const reports = manager.getBranch().filter(e => e.type === "custom_message" && e.customType === PARENT_REPORT_CUSTOM_TYPE);
      assert.equal(reports.length, 1);
      const { reportId, receivedAtMs, submittedAtMs, ...details } = (reports[0] as any).details;
      assert.match(reportId, /^[a-f0-9-]{36}$/); assert.ok(Number.isSafeInteger(receivedAtMs)); assert.ok(submittedAtMs >= receivedAtMs);
      assert.ok((reports[0] as any).content.includes(`Report ID: ${reportId}; parent receivedAtMs: ${receivedAtMs}; first submittedAtMs: ${submittedAtMs}`));
      assert.deepEqual(details, { kind: "subagent.parent-report", version: 3, ...identity, reportKind: kind });
      assert.equal((admission as any).important.length, 0, "safe lifecycle reconciles confirmed native commit");
      assert.equal((reports[0] as any).content.endsWith(JSON.stringify(body)), true);
      assert.deepEqual(notifications, []); assert.equal(statuses.filter((args: any) => args[1] !== undefined).length, 0);
      assert.deepEqual(errors, []); assert.equal(forbiddenCalls, 0);
    } finally {
      resume.release(); await parentRun; client?.close(); session?.dispose(); await server.close(); globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved); await fs.rm(root, { recursive: true, force: true });
    }
  });
}

test(`real Pi ${SELECTED_PI_VERSION} validates arguments before coercion/echo and replays identical native tool-call IDs`, { timeout: 15_000 }, async () => {
  assertSelectedPiHost();
  const saved = { ...process.env }, originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  const forbidden = (): never => { forbiddenCalls++; throw Error("Offline host forbids credentials/network/provider"); };
  globalThis.fetch = forbidden as unknown as typeof fetch; process.env.PI_OFFLINE = "1";
  await fs.mkdir(path.join(process.cwd(), ".bun-tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/report-validation-host-"));
  const server = await LifecycleEventServer.start(), received: unknown[] = [];
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined, client: LifecycleEventClient | null = null;
  try {
    const id = "validation-child", token = server.registerRun(id, true);
    server.setReportHandler(id, (body, _eligible, kind) => { received.push({ body, kind }); return true; }); server.activateRun(id);
    await writeLifecycleBootstrapToken(path.join(root, "lifecycle-token"), token);
    client = await LifecycleEventClient.connectFromEnvironment({ PI_SUBAGENT_RUN_ID: id,
      [SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: server.socketPath, [SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: path.join(root, "lifecycle-token") }, path.join(root, "state.json"), false, true);
    assert.ok(client);
    const started = server.waitForEvent(id, 1000); client.send("agent-started"); await started;
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden } });
    const model = modelRuntime.getModels()[0]; assert.ok(model);
    modelRuntime.stream = forbidden; modelRuntime.streamSimple = forbidden; modelRuntime.getAuth = forbidden;
    modelRuntime.checkAuth = forbidden; modelRuntime.classify = forbidden; modelRuntime.generateImages = forbidden;
    modelRuntime.hasConfiguredAuth = () => true;
    const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
    process.env[PARENT_REPORT_ENV] = "1";
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: path.join(root, "agent"), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => { assert.equal(registerParentReportTool(pi, () => client, () => true), true); }] });
    await loader.reload({ resolveProjectTrust: async () => false }); assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: root, agentDir: path.join(root, "agent"), modelRuntime, model, thinkingLevel: "off",
      settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(root), tools: [PARENT_REPORT_TOOL] }));
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: e => { errors.push(e); } });
    const message = "private-report-body";
    const invalid: JsonObject[] = [{ message, kind: null }, { message, kind: "important" }, { message, kind: 1 }, { message, kind: {} },
      { message, kind: "finding", parentId: "forged-parent" }, { message: 123 }, { message: "한".repeat(1366) }, { message: " \n" }];
    let requests = 0;
    let calls = invalid.map((args, index) => ({
      type: "toolCall" as const, id: `invalid-${index}`, name: PARENT_REPORT_TOOL, arguments: args,
    }));
    session.agent.streamFunction = () => {
      const toolCalls = ++requests === 1;
      const result: AssistantMessage = { role: "assistant", content: toolCalls ? calls : [{ type: "text", text: "offline answer" }], api: model.api, provider: model.provider, model: model.id,
        timestamp: 0, stopReason: toolCalls ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: toolCalls ? "toolUse" : "stop", message: result }); return stream;
    };
    await session.prompt("exercise native argument validation");
    const results = session.messages.filter(m => m.role === "toolResult");
    assert.equal(results.length, invalid.length);
    for (const result of results) {
      assert.equal(result.isError, true);
      const text = JSON.stringify(result.content);
      assert.equal(text.includes(message), false); assert.equal(text.includes("forged-parent"), false);
      assert.equal(text.includes("한"), false); assert.equal(text.includes("Received arguments"), false);
      assert.match(text, /Invalid parent report arguments or kind|Report must be nonblank; actual UTF-8 bytes/);
    }
    assert.deepEqual(received, []); assert.equal((client as any).reportRate.sent.length, 0);
    calls = Array.from({ length: 2 }, () => ({ type: "toolCall" as const, id: "native-repeat", name: PARENT_REPORT_TOOL, arguments: { message } }));
    requests = 0;
    await session.prompt("native duplicate tool ID in the same batch");
    assert.deepEqual(received, [{ body: message, kind: "progress" }]);
    const successes = session.messages.filter(m => m.role === "toolResult").filter(m => m.toolCallId === "native-repeat");
    assert.equal(successes.length, 2); assert.ok(successes.every(m => !m.isError));
    assert.deepEqual(successes[0]!.content, successes[1]!.content);
    requests = 0;
    await session.prompt("native repeat after settlement of the tool call");
    assert.equal(received.length, 1); assert.equal((client as any).reportRate.sent.length, 1);
    calls = [{ type: "toolCall", id: "native-repeat", name: PARENT_REPORT_TOOL, arguments: { message: "private-conflict" } }];
    requests = 0;
    await session.prompt("native conflict must not transmit or echo payload");
    const conflict = session.messages.filter(m => m.role === "toolResult").filter(m => m.toolCallId === "native-repeat").at(-1)!;
    assert.equal(conflict.isError, true); assert.match(JSON.stringify(conflict.content), /conflicts/);
    assert.equal(JSON.stringify(conflict.content).includes("private-conflict"), false);
    assert.equal(received.length, 1);
    assert.deepEqual(errors, []); assert.equal(forbiddenCalls, 0);
  } finally {
    client?.close(); session?.dispose(); await server.close(); globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); await fs.rm(root, { recursive: true, force: true });
  }
});
