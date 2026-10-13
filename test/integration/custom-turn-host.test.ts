import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getSystemMessageText, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { RUN_STATE_DIR_ENV } from "../../src/runtime/run-protocol";
import { assertSelectedPiHost, SELECTED_PI_VERSION } from "../helpers/selected-pi-host";

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

for (const trigger of ["user", "custom"] as const) for (const cancel of [false, true]) {
  test(`Pi ${SELECTED_PI_VERSION} production subagent prompt survives ${trigger} startup; queued message${cancel ? " and cancellation" : ""}`, { timeout: 20_000 }, async () => {
    assertSelectedPiHost();
    const saved = { ...process.env }, originalFetch = globalThis.fetch;
    let forbiddenCalls = 0;
    const forbidden = (): never => { forbiddenCalls++; throw Error("Offline host forbids credentials/network/live providers"); };
    globalThis.fetch = forbidden as unknown as typeof fetch;
    await fs.mkdir(path.join(process.cwd(), ".bun-tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/custom-turn-host-"));
    const agentDir = path.join(root, "agent");
    const reached = latch(), resume = latch();
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await fs.mkdir(path.join(agentDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(agentDir, "agents/fixture-reader.md"), "---\nname: fixture-reader\ndescription: OFFLINE_AGENT_DESCRIPTION\ntools: read\n---\nRead only fixture files.\n");
      // Isolate production config/discovery and durable tree state; no reaper or child spawn.
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("PI_SUBAGENT_TREE_PERMIT_")) delete process.env[key];
      }
      Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir,
        PI_SUBAGENT_DEPTH: "1", PI_SUBAGENT_MAX_DEPTH: "3", [RUN_STATE_DIR_ENV]: path.join(root, "runs") });
      const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
      let pi!: ExtensionAPI, startupContext!: ExtensionContext;
      const kinds: string[] = [];
      const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
        noExtensions: true, additionalExtensionPaths: [path.join(process.cwd(), "index.ts")],
        noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        appendSystemPrompt: ["ROLE_INSTRUCTIONS_MUST_SURVIVE_CUSTOM_RUN"],
        extensionFactories: [api => {
          pi = api;
          api.on("before_agent_start", async (event, ctx) => {
            kinds.push(event.messageType); startupContext = ctx;
            reached.release(); await resume.promise;
          });
        }],
      });
      await loader.reload({ resolveProjectTrust: async () => false });
      assert.deepEqual(loader.getExtensions().errors, []);
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
        credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden } });
      const model = modelRuntime.getModels()[0]; assert.ok(model);
      modelRuntime.stream = forbidden; modelRuntime.streamSimple = forbidden; modelRuntime.getAuth = forbidden;
      modelRuntime.checkAuth = forbidden; modelRuntime.classify = forbidden; modelRuntime.generateImages = forbidden;
      modelRuntime.hasConfiguredAuth = () => true;
      const manager = SessionManager.inMemory(root);
      ({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime, model, thinkingLevel: "off",
        settingsManager, resourceLoader: loader, sessionManager: manager, tools: [] }));
      const requests: { systemPrompt: string; messages: Message[]; aborted: boolean }[] = [];
      session.agent.streamFunction = (_model, context, options) => {
        const leading = context.messages[0];
        assert.equal(leading?.role, "system");
        const systemPrompt = leading?.role === "system" ? getSystemMessageText(leading) : "";
        const aborted = options?.signal?.aborted === true;
        requests.push({ systemPrompt, messages: structuredClone(context.messages), aborted });
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "offline response" }],
          api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (aborted) stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", content: [] } });
        else stream.push({ type: "done", reason: "stop", message });
        return stream;
      };
      const errors: unknown[] = [];
      await session.bindExtensions({ onError: error => { errors.push(error); } });
      let run: Promise<void> | undefined;
      if (trigger === "user") run = session.prompt("initial user task");
      else pi.sendMessage({ customType: "subagent_result", content: "final background result", display: true }, { triggerTurn: true });
      await reached.promise;
      assert.equal(session.isStreaming, true, "starting runs count as busy before any provider request");
      assert.equal(startupContext.isIdle(), false);
      assert.equal(requests.length, 0);
      pi.sendMessage({ customType: "startup-queued", content: "queued during startup", display: false }, { deliverAs: "steer", triggerTurn: true });
      pi.sendMessage({ customType: "startup-context", content: "non-triggering startup context", display: false }, { triggerTurn: false });
      assert.deepEqual(kinds, [trigger], "queued messages cannot start a concurrent run");
      if (cancel) startupContext.abort();
      resume.release(); await run; await session.waitForIdle();
      assert.deepEqual(kinds, [trigger]);
      // Pi can enter streamFunction with an already-aborted signal. The provider
      // must honor it; no un-aborted request or follow-up may escape startup abort.
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.aborted, cancel);
      if (!cancel) {
        assert.match(requests[0]!.systemPrompt, /ROLE_INSTRUCTIONS_MUST_SURVIVE_CUSTOM_RUN/);
        assert.match(requests[0]!.systemPrompt, /fixture-reader/);
        assert.match(requests[0]!.systemPrompt, /OFFLINE_AGENT_DESCRIPTION/);
        for (const text of [trigger === "user" ? "initial user task" : "final background result", "queued during startup", "non-triggering startup context"]) {
          assert.equal(requests[0]!.messages.filter(message => JSON.stringify(message.content).includes(text)).length, 1, text);
        }
      }
      assert.deepEqual(errors, []); assert.equal(forbiddenCalls, 0);
    } finally {
      resume.release(); session?.dispose(); globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved); await fs.rm(root, { recursive: true, force: true });
    }
  });
}
