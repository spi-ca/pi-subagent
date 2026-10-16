import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  VERSION, createAgentSession, createCodemodeExtension, createMcpExtension,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
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
    // Pi 1.3 caps workers still running/shutting down at two. Probe every
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
