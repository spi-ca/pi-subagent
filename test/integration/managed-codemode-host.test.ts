import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  VERSION, createAgentSession, createCodemodeExtension, createMcpExtension,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildPiArgs } from "../../src/runtime/runner";
import { assertSelectedPiHost, SELECTED_PI_VERSION } from "../helpers/selected-pi-host";

// Real, exact installed Pi host; no Bun module mocks, model prompts, auth/config
// reads, catalog refresh, MCP connection, or provider calls. The CI inventory
// gives this file a fresh OS process, independent of mocked entrypoint tests.
test(`Pi ${SELECTED_PI_VERSION} resource loader and native session execute managed builtin:codemode with only selected readers`, { timeout: 20_000 }, async () => {
  assertSelectedPiHost();
  const tempParent = path.join(process.cwd(), ".bun-tmp");
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, "managed-codemode-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const previousOffline = process.env.PI_OFFLINE;
  const originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  const forbidden = (): never => { forbiddenCalls += 1; throw new Error("Host integration forbids network/auth/provider calls"); };
  globalThis.fetch = forbidden as unknown as typeof fetch;
  process.env.PI_OFFLINE = "1";
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".pi/extensions"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "extensions/ambient.ts"), 'throw new Error("Discovered user extension must not load");');
    await fs.writeFile(path.join(cwd, ".pi/extensions/ambient.ts"), 'throw new Error("Discovered project extension must not load");');
    await fs.writeFile(path.join(cwd, "a.txt"), "alpha\nbeta\n");
    await fs.writeFile(path.join(cwd, "b.txt"), "gamma\n");
    const selected = ["read", "grep", "find", "ls", "codemode"];
    const argv = buildPiArgs({ name: "reader", description: "", source: "user", filePath: "/reader.md", systemPrompt: "", tools: selected }, null, "/task", "spawn", null, undefined, "managed", undefined, VERSION);
    const settingsManager = SettingsManager.inMemory({ extensions: [path.join(agentDir, "extensions/ambient.ts")] });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: argv.includes("--no-extensions"),
      additionalExtensionPaths: argv.filter((arg) => arg === "builtin:codemode"),
      disabledBuiltinExtensions: argv.includes("--no-mcp") ? ["mcp"] : [],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
        { name: "mcp", factory: (pi) => { forbidden(); createMcpExtension()(pi); }, builtin: true, replaceable: true },
      ],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => false });
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.deepEqual(resourceLoader.getExtensions().extensions.map((extension) => extension.path), ["builtin:codemode"]);
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden },
    });
    // Explicit catalog model avoids initial availability/auth selection. Never prompt.
    const model = modelRuntime.getModels()[0];
    assert.ok(model);
    modelRuntime.stream = forbidden;
    modelRuntime.streamSimple = forbidden;
    modelRuntime.classify = forbidden;
    modelRuntime.generateImages = forbidden;
    modelRuntime.getAuth = forbidden;
    ({ session } = await createAgentSession({
      cwd, agentDir, modelRuntime, model, thinkingLevel: "off", settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(cwd), tools: selected,
    }));
    await session.bindExtensions({});
    assert.deepEqual(session.getAllTools().map((tool) => tool.name).sort(), selected.slice().sort());
    assert.deepEqual(session.getCallableToolNames().sort(), ["find", "grep", "ls", "read"]);
    const owner = session.getAllTools().find((tool) => tool.name === "codemode")!.sourceInfo;
    assert.equal(owner.source, "builtin");
    assert.equal(owner.path, "builtin:codemode");
    assert.equal(session.getAllTools().some((tool) => tool.name.startsWith("mcp__")), false);
    const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode")!;
    assert.ok(codemode);
    assert.match(codemode.description, /models.*classifiers/); // native models=true stays intact
    // Native nested-call execution needs an issuing assistant in the transcript.
    // Seed one locally, rather than prompting a provider or mocking the pipeline.
    session.agent.state.messages.push({
      role: "assistant", content: [{ type: "toolCall", id: "batch", name: "codemode", arguments: {} }],
      api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "toolUse",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const signal = AbortSignal.timeout(10_000);
    const result = await codemode.execute("batch", { code: `// @options: {"timeout_ms": 5000, "max_output_tokens": 1000}
const rows = await Promise.allSettled([
  tools.read({path: "a.txt"}), tools.read({path: "b.txt"}), tools.ls({path: "."})
]);
text(JSON.stringify({names: ALL_TOOLS.map(t => t.name).sort(), rows: rows.map(row => row.status === "rejected" ? {status: row.status, reason: String(row.reason)} : row)}));` }, signal);
    assert.notEqual(result.isError, true);
    const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    assert.match(text, /Script completed/);
    const data = JSON.parse(text.slice(text.indexOf('{"names"')));
    assert.deepEqual(data.names, ["find", "grep", "ls", "read"]);
    // grep/find registry selection is checked above. Do not execute them here:
    // native Pi may download rg/fd when absent, which is outside this offline test.
    assert.equal(data.rows.length, 3);
    assert.ok(data.rows.every((row: { status: string }) => row.status === "fulfilled"), JSON.stringify(data.rows));
    assert.equal(data.rows[0].value, "alpha\nbeta\n");
    assert.equal(data.rows[1].value, "gamma\n");
    assert.match(data.rows[2].value, /a.txt/);
    assert.match(data.rows[2].value, /b.txt/);
    // Pi caps workers still running/shutting down at two by default. Probe every
    // denied name in one script, rather than racing teardown with five workers.
    const deniedNames = ["bash", "edit", "write", "codemode", "subagent"];
    const denied = await codemode.execute("denied-tools", { code: `// @options: {"timeout_ms": 1000}
const denied = [];
for (const name of ${JSON.stringify(deniedNames)}) {
  try { await tools[name]({}); denied.push({name, error: null}); }
  catch (error) { denied.push({name, error: String(error)}); }
}
text(JSON.stringify({denied}));` }, signal);
    assert.notEqual(denied.isError, true);
    const deniedText = denied.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const deniedRows = JSON.parse(deniedText.slice(deniedText.indexOf('{"denied"'))).denied;
    assert.deepEqual(deniedRows.map((row: { name: string }) => row.name), deniedNames);
    for (const row of deniedRows) assert.match(row.error, /does not exist/, `${row.name} must be absent, not merely time out`);
    assert.equal(await fs.readFile(path.join(cwd, "a.txt"), "utf8"), "alpha\nbeta\n");
    assert.equal(forbiddenCalls, 0);
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Fill the native default two-worker pool with real QuickJS scripts blocked in
// an offline tool. No worker mocks, replacement admission manager, or cap raise.
test(`Pi ${SELECTED_PI_VERSION} codemode queues at capacity in FIFO order and removes aborted/expired waiters`, { timeout: 20_000 }, async () => {
  assertSelectedPiHost();
  const previousOffline = process.env.PI_OFFLINE, previousLimit = process.env.PI_CODEMODE_MAX_WORKERS;
  const originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  const forbidden = (): never => { forbiddenCalls++; throw new Error("Worker admission test forbids auth/network/provider calls"); };
  process.env.PI_OFFLINE = "1";
  delete process.env.PI_CODEMODE_MAX_WORKERS; // exercise Pi's default, never increase it
  globalThis.fetch = forbidden as unknown as typeof fetch;
  await fs.mkdir(path.join(process.cwd(), ".bun-tmp"), { recursive: true });
  const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/codemode-admission-"));
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
  function latch() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
  const names = ["holder-a", "holder-b", "first", "cancelled", "expired", "second"];
  const gates = new Map(names.map(name => [name, { entered: latch(), finish: latch() }]));
  const entered: string[] = [];
  const operations: Promise<unknown>[] = [];
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(new Error("Offline admission test deadline")), 12_000);
  try {
    const agentDir = path.join(root, "agent"), cwd = path.join(root, "workspace");
    await fs.mkdir(agentDir); await fs.mkdir(cwd);
    const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [], cacheWarming: "off" });
    const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createCodemodeExtension(), pi => {
        pi.registerTool({ name: "hold", label: "Hold", description: "Offline worker barrier",
          parameters: Type.Object({ name: Type.String() }),
          async execute(_id, { name }, signal) {
            const gate = gates.get(name); assert.ok(gate);
            entered.push(name); gate.entered.release();
            await Promise.race([gate.finish.promise, new Promise<never>((_resolve, reject) => {
              if (signal?.aborted) { reject(signal.reason); return; }
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            })]);
            return { content: [{ type: "text", text: name }], details: undefined };
          },
        });
      }],
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => false });
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
      credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden } });
    const model = modelRuntime.getModels()[0]; assert.ok(model);
    modelRuntime.stream = forbidden; modelRuntime.streamSimple = forbidden; modelRuntime.getAuth = forbidden;
    modelRuntime.checkAuth = forbidden; modelRuntime.classify = forbidden; modelRuntime.generateImages = forbidden;
    // Two sessions share the same actual process-wide pool.
    for (let index = 0; index < 2; index++) {
      const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model,
        thinkingLevel: "off", sessionManager: SessionManager.inMemory(cwd), tools: ["hold", "codemode"] });
      sessions.push(session);
      await session.bindExtensions({});
      session.agent.state.messages.push({ role: "assistant", content: names.map(id => ({ type: "toolCall" as const, id, name: "codemode", arguments: {} })),
        api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "toolUse",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    }
    function run(name: string, index: number, signal = lifetime.signal, timeout = 10_000) {
      const codemode = sessions[index]!.agent.state.tools.find(tool => tool.name === "codemode")!;
      const operation = codemode.execute(name, { code: `// @options: {"timeout_ms": ${timeout}}\ntext(await tools.hold({name: ${JSON.stringify(name)}}));` }, signal);
      operations.push(operation);
      return operation;
    }
    async function reached(name: string) {
      await Promise.race([gates.get(name)!.entered.promise, new Promise<never>((_resolve, reject) => {
        if (lifetime.signal.aborted) { reject(lifetime.signal.reason); return; }
        lifetime.signal.addEventListener("abort", () => reject(lifetime.signal.reason), { once: true });
      })]);
    }
    const holderA = run("holder-a", 0), holderB = run("holder-b", 1);
    await Promise.all([reached("holder-a"), reached("holder-b")]);
    const first = run("first", 0);
    const cancel = new AbortController();
    const cancelSignal = AbortSignal.any([cancel.signal, lifetime.signal]);
    const queued = latch();
    let admissionListener: EventListenerOrEventListenerObject | null = null;
    let admissionListenerRemoved = false;
    const addListener = cancelSignal.addEventListener.bind(cancelSignal);
    const removeListener = cancelSignal.removeEventListener.bind(cancelSignal);
    // Pi's tool/context wrappers forward this signal without subscribing. The
    // executor's first abort subscription is reserveCodemodeWorker's onAbort,
    // immediately AFTER pushing its waiter. Observe only this call's signal;
    // delegate unchanged to native EventTarget, without replacing admission.
    cancelSignal.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      addListener(type, listener, options);
      if (type === "abort") {
        assert.equal(admissionListener, null, "only native admission may subscribe before cancellation");
        admissionListener = listener;
        queued.release();
      }
    };
    cancelSignal.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      removeListener(type, listener, options);
      if (type === "abort" && listener === admissionListener) admissionListenerRemoved = true;
    };
    const cancelled = run("cancelled", 1, cancelSignal);
    const expired = run("expired", 0, lifetime.signal, 150);
    const second = run("second", 1);
    await Promise.race([
      queued.promise,
      cancelled.then(() => assert.fail("cancelled script settled before native queue admission")),
    ]);
    assert.ok(admissionListener, "cancelled script must join the native worker queue before abort");
    assert.equal(cancelSignal.aborted, false);
    assert.equal(admissionListenerRemoved, false, "admission must still be waiting when aborted");
    assert.deepEqual(entered.slice().sort(), ["holder-a", "holder-b"], "both native slots remain held at cancellation");
    cancel.abort(new Error("Cancel queued script"));
    const cancelledResult = await cancelled;
    assert.equal(admissionListenerRemoved, true, "native cancellation must settle and remove its admission listener");
    assert.equal(cancelledResult.isError, true);
    assert.match(JSON.stringify(cancelledResult.content), /Script aborted.*Cancel queued script/);
    assert.match(JSON.stringify(cancelledResult.content), /The script did not start/);
    const expiredResult = await expired;
    assert.equal(expiredResult.isError, true);
    assert.match(JSON.stringify(expiredResult.content), /timed out after 150 ms while waiting for a free codemode worker/);
    assert.match(JSON.stringify(expiredResult.content), /The script did not start/);
    assert.deepEqual(entered.slice().sort(), ["holder-a", "holder-b"], "queued scripts cannot run before a slot is free");
    gates.get("holder-a")!.finish.release();
    assert.notEqual((await holderA).isError, true);
    await reached("first");
    assert.deepEqual(entered.slice(2), ["first"], "second must still wait while both slots are occupied");
    gates.get("first")!.finish.release();
    assert.notEqual((await first).isError, true);
    await reached("second");
    assert.deepEqual(entered.slice(2), ["first", "second"], "cancelled/expired waiters must never execute");
    gates.get("second")!.finish.release();
    gates.get("holder-b")!.finish.release();
    for (const result of await Promise.all([second, holderB])) assert.notEqual(result.isError, true);
    assert.equal(forbiddenCalls, 0);
  } finally {
    lifetime.abort();
    for (const gate of gates.values()) gate.finish.release();
    await Promise.allSettled(operations);
    clearTimeout(timer);
    for (const session of sessions) session.dispose();
    globalThis.fetch = originalFetch;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousLimit === undefined) delete process.env.PI_CODEMODE_MAX_WORKERS;
    else process.env.PI_CODEMODE_MAX_WORKERS = previousLimit;
    await fs.rm(root, { recursive: true, force: true });
  }
});
