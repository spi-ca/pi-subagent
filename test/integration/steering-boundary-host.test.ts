import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type BoundaryState, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import inlineBridge, { INLINE_STEERING_STATE_PATH_ENV } from "../../src/runtime/inline-steering-bridge";
import { STEERING_CUSTOM_TYPE } from "../../src/runtime/steering-inbox";
import { LifecycleEventServer, SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV, SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV, writeLifecycleBootstrapToken } from "../../src/runtime/lifecycle-socket";
import { assertSelectedPiHost, SELECTED_PI_VERSION } from "../helpers/selected-pi-host";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// Exact installed host, public SDK and real authenticated socket. The only
// synthetic seam is its public streamFunction; no native prompt/input mocks.
async function fixture(inherited: (pi: ExtensionAPI) => void) {
  assertSelectedPiHost();
  const saved = { ...process.env }, originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  const forbidden = (): never => { forbiddenCalls++; throw Error("Offline host forbids auth/network/provider/discovery"); };
  globalThis.fetch = forbidden as unknown as typeof fetch;
  process.env.PI_OFFLINE = "1";
  const parent = path.join(process.cwd(), ".bun-tmp");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "steering-host-"));
  const server = await LifecycleEventServer.start();
  const id = "real-steering-host", token = server.registerRun(id, true);
  server.activateRun(id);
  await writeLifecycleBootstrapToken(path.join(root, "lifecycle-token"), token);
  Object.assign(process.env, {
    PI_SUBAGENT_RUN_ID: id, [INLINE_STEERING_STATE_PATH_ENV]: path.join(root, "state.json"),
    [SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: server.socketPath,
    [SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: path.join(root, "lifecycle-token"),
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const cleanup = async () => {
    session?.dispose();
    await server.close();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await fs.rm(root, { recursive: true, force: true });
  };
  try {
    const settingsManager = SettingsManager.inMemory({
      extensions: [], packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off",
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root, agentDir: path.join(root, "agent"), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [inherited, inlineBridge],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => false });
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.equal(resourceLoader.getExtensions().extensions.length, 2); // only explicit factories
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden },
    });
    const model = modelRuntime.getModels()[0]; assert.ok(model);
    modelRuntime.stream = forbidden; modelRuntime.streamSimple = forbidden;
    modelRuntime.classify = forbidden; modelRuntime.generateImages = forbidden;
    modelRuntime.getAuth = forbidden; modelRuntime.checkAuth = forbidden;
    // A synthetic stream needs no credential. Avoid even credential discovery.
    modelRuntime.hasConfiguredAuth = () => true;
    const manager = SessionManager.inMemory(root);
    const assistant = (text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
      role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
      timestamp: 0, stopReason,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    manager.appendMessage({ role: "user", content: "existing context", timestamp: 0 });
    manager.appendMessage(assistant("existing answer"));
    const originalEntries = structuredClone(manager.getBranch());
    ({ session } = await createAgentSession({
      cwd: root, agentDir: path.join(root, "agent"), modelRuntime, model, thinkingLevel: "off",
      settingsManager, resourceLoader, sessionManager: manager, tools: [], noTools: "all",
    }));
    const requests: Message[][] = [];
    let streamStop: AssistantMessage["stopReason"] = "stop";
    session.agent.streamFunction = (_model, context) => {
      requests.push(structuredClone(context.messages));
      const stream = createAssistantMessageEventStream();
      const result = assistant(`response ${requests.length}`, streamStop);
      queueMicrotask(() => {
        if (streamStop === "aborted" || streamStop === "error") stream.push({ type: "error", reason: streamStop, error: result });
        else stream.push({ type: "done", reason: "stop", message: result });
      });
      return stream;
    };
    const errors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => { errors.push(error); } });
    return { session, server, id, requests, errors, manager, originalEntries, cleanup,
      forbiddenCalls: () => forbiddenCalls, setStop: (reason: AssistantMessage["stopReason"]) => { streamStop = reason; } };
  } catch (error) { await cleanup(); throw error; }
}

for (const boundary of ["turn_end"] as const) {
  for (const inputAction of ["transform", "handled"] as const) {
    test(`Pi ${SELECTED_PI_VERSION} socket inbox at ${boundary} bypasses inherited ${inputAction} input and continues exactly once`, { timeout: 15_000 }, async () => {
      const reached = latch(), resume = latch();
      let inputCalls = 0, extensionInputCalls = 0, prompts = 0, boundaries = 0;
      const inheritedEntry: SessionBoundaryDraft = { type: "custom_message", customType: "inherited", content: "earlier boundary context", display: false };
      const f = await fixture((pi) => {
        pi.on("input", async (event) => {
          inputCalls++;
          if (event.source !== "extension") return;
          extensionInputCalls++;
          // Old steering would enter this inherited await/transform/handled path.
          await resume.promise;
          return inputAction === "handled" ? { action: "handled" } : { action: "transform", text: "HIJACKED" };
        });
        pi.on("before_agent_start", () => { prompts++; });
        const handler = async (event: BoundaryState) => {
          if (++boundaries !== 1) return;
          reached.release(); await resume.promise;
          return { entries: [...event.entries, inheritedEntry], continue: event.continue };
        };
        pi.on("turn_end", handler);
      });
      try {
        const started = f.server.waitForEvent(f.id, 1000);
        const run = f.session.prompt("initial task", { expandPromptTemplates: false });
        await reached.promise; await started;
        assert.equal(f.requests.length, 1);
        assert.equal(await f.server.requestSteer(f.id, "/skill:literal $ARGUMENTS"), "submitted");
        assert.equal(await f.server.requestSteer(f.id, "bounded second"), "submitted");
        assert.equal(f.manager.getBranch().filter((entry) => entry.type === "custom_message").length, 0); // ACK is admission, not commit
        resume.release(); await run;
        assert.equal(f.requests.length, 2);
        assert.equal(prompts, 1); assert.equal(inputCalls, 1); assert.equal(extensionInputCalls, 0);
        assert.deepEqual(f.requests[1]!.slice(0, f.requests[0]!.length), f.requests[0]);
        const contents = f.requests[1]!.map((message) => JSON.stringify(message.content));
        for (const text of ["existing context", "existing answer", "initial task", "earlier boundary context", "/skill:literal $ARGUMENTS", "bounded second"]) {
          assert.equal(contents.filter((content) => content.includes(text)).length, 1, text);
        }
        assert.equal(f.requests[1]!.at(-1)!.role, "user");
        const steering = f.manager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === STEERING_CUSTOM_TYPE);
        assert.deepEqual(steering.map(entry => (entry as { content: unknown }).content), ["/skill:literal $ARGUMENTS", "bounded second"]);
        assert.deepEqual(f.manager.getBranch().slice(0, f.originalEntries.length), f.originalEntries);
        const settledTranscript = structuredClone(f.manager.getBranch());
        assert.notEqual(await f.server.requestSteer(f.id, "already settled"), "submitted");
        assert.deepEqual(f.manager.getBranch(), settledTranscript);
        assert.equal(f.requests.length, 2); assert.equal(prompts, 1);
        assert.deepEqual(f.errors, []); assert.equal(f.forbiddenCalls(), 0);
      } finally { resume.release(); await f.cleanup(); }
    });
  }
}

for (const mode of ["completed", "abort-before-request"] as const) {
  test(`Pi ${SELECTED_PI_VERSION} pre-settle ${mode} rejects steering despite completed outcome and unaborted preceding signal`, { timeout: 15_000 }, async () => {
    const reached = latch(), resume = latch();
    let context: ExtensionContext | undefined, precedingSignal: AbortSignal | undefined;
    let capturedOutcome: BoundaryState["outcome"] | undefined, prompts = 0;
    const f = await fixture((pi) => {
      pi.on("before_agent_start", () => { prompts++; });
      pi.on("turn_end", (_event, ctx) => { precedingSignal = ctx.signal; });
      pi.on("agent_before_settle", async (event, ctx) => {
        context = ctx;
        capturedOutcome = event.outcome;
        if (mode === "abort-before-request") ctx.abort();
        reached.release(); await resume.promise;
      });
    });
    try {
      const started = f.server.waitForEvent(f.id, 1000);
      const run = f.session.prompt("initial task", { expandPromptTemplates: false });
      await reached.promise; await started;
      assert.equal(capturedOutcome, "completed");
      assert.ok(precedingSignal);
      assert.equal(precedingSignal.aborted, false); // ctx.abort at pre-settle does not abort it
      assert.equal(context!.signal, undefined);
      assert.equal(context!.isIdle(), false); // session run still active is not admission authority
      assert.equal(f.requests.length, 1);
      const before = structuredClone(f.manager.getBranch());
      const admission = await f.server.requestSteer(f.id, "must not enter transcript");
      assert.ok(admission === "rejected" || admission === "unavailable", admission);
      assert.deepEqual(f.manager.getBranch(), before);
      resume.release(); await run;
      assert.equal(f.requests.length, 1); assert.equal(prompts, 1);
      assert.deepEqual(f.manager.getBranch(), before);
      assert.equal(f.manager.getBranch().some((entry) => entry.type === "custom_message" && entry.customType === STEERING_CUSTOM_TYPE), false);
      assert.deepEqual(f.manager.getBranch().slice(0, f.originalEntries.length), f.originalEntries);
      assert.deepEqual(f.errors, []); assert.equal(f.forbiddenCalls(), 0);
    } finally { resume.release(); await f.cleanup(); }
  });
}

for (const mode of ["abort", "error", "settled"] as const) {
  test(`Pi ${SELECTED_PI_VERSION} ${mode} arrival makes zero new prompts/streams or steering transcript mutations`, { timeout: 15_000 }, async () => {
    const reached = latch(), resume = latch();
    let context: ExtensionContext | undefined, prompts = 0;
    const f = await fixture((pi) => {
      pi.on("before_agent_start", () => { prompts++; });
      const handler = async (_event: unknown, ctx: ExtensionContext) => {
        context = ctx; reached.release(); await resume.promise;
      };
      if (mode === "settled") pi.on("agent_settled", handler);
      else pi.on("turn_end", handler);
    });
    try {
      if (mode === "error") f.setStop("error");
      const started = f.server.waitForEvent(f.id, 1000);
      const run = f.session.prompt("initial task", { expandPromptTemplates: false });
      await reached.promise; await started;
      if (mode === "abort") {
        assert.equal(await f.server.requestSteer(f.id, "admitted before abort"), "submitted");
        context!.abort(); // native operation signal aborts while earlier boundary handler awaits
        assert.equal(context!.signal!.aborted, true);
      }
      if (mode === "error") {
        // Arrival can precede bridge's outcome observer, but it must never commit.
        assert.equal(await f.server.requestSteer(f.id, "pending error outcome"), "submitted");
      }
      const before = structuredClone(f.manager.getBranch());
      assert.equal(await f.server.requestSteer(f.id, "late arrival"), mode === "settled" ? "unavailable" : mode === "abort" ? "rejected" : "submitted");
      resume.release(); await run;
      assert.equal(f.requests.length, 1); assert.equal(prompts, 1);
      assert.deepEqual(f.manager.getBranch(), before);
      assert.equal(f.manager.getBranch().some((entry) => entry.type === "custom_message"), false);
      assert.notEqual(await f.server.requestSteer(f.id, "post settlement"), "submitted");
      assert.deepEqual(f.manager.getBranch(), before);
      assert.deepEqual(f.errors, []); assert.equal(f.forbiddenCalls(), 0);
    } finally { resume.release(); await f.cleanup(); }
  });
}
