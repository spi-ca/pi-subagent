import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  VERSION, createAgentSession, createCodemodeExtension, createMcpExtension,
  DefaultResourceLoader, ModelRuntime, parseArgs, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { JsonRpcMessage, McpTransport, McpTransportMessageListener } from "@earendil-works/pi-mcp";
type McpExtensionOptions = NonNullable<Parameters<typeof createMcpExtension>[0]>;
import { captureParentNativeCodemodeActive, resolveInheritedChildToolSelection } from "../../src/runtime/child-tool-selection";

test("native Pi parser uses the final exclusion alias and rejects wildcard modifiers in either order", () => {
  assert.equal(VERSION, "1.1.0");
  for (const first of ["--exclude-tools", "-xt"]) {
    for (const last of ["--exclude-tools", "-xt"]) {
      for (const final of ["bash", "code*", ""]) {
        const parsed = parseArgs([first, "codemode", last, final]);
        assert.deepEqual(parsed.diagnostics, []);
        assert.deepEqual(parsed.excludeTools, final ? [final] : []);
        const tools: string[] | undefined = resolveInheritedChildToolSelection({ agentTools: ["read"], alwaysProxy: [first, "codemode", last, final], hostVersion: VERSION, parentNativeCodemodeActive: true }).tools;
        assert.equal(tools?.includes("codemode"), !final.startsWith("code"));
      }
    }
  }
  for (const value of ["-codemode,+codemode", "+codemode,-codemode"]) {
    const parsed = parseArgs(["-t", value]);
    assert.deepEqual(parsed.diagnostics, []);
    assert.deepEqual(parsed.tools, value.split(","));
  }
  for (const value of ["-*,+codemode", "+codemode,-*", "-code*,+codemode", "+code*,-codemode"]) {
    const parsed = parseArgs(["--tools", value]);
    assert.equal(parsed.tools, undefined);
    assert.equal(parsed.diagnostics.length, 1);
    assert.equal(parsed.diagnostics[0]?.type, "error");
    assert.match(parsed.diagnostics[0]?.message ?? "", /exact tool names, not patterns/);
  }
});

const originalArgv = process.argv;
process.argv = ["bun", "pi", "--tools", "bash,mcp__docs__*", "--exclude-tools", "mcp__docs__delete"];
const { buildPiArgs } = await import("../../src/runtime/runner");
process.argv = originalArgv;

/** Owned in-memory JSON-RPC peer, not a mocked Pi client/registry/pipeline. */
class FixtureTransport implements McpTransport {
  listeners = new Set<McpTransportMessageListener>();
  closed = false;
  calls: string[] = [];
  async start() {}
  async close() { this.closed = true; this.listeners.clear(); }
  onMessage(listener: McpTransportMessageListener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onError() { return () => {}; }
  onClose() { return () => {}; }
  async send(message: JsonRpcMessage) {
    if (!("method" in message) || !("id" in message)) return;
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "owned-fixture", version: "1" }, instructions: "Owned offline fixture" };
    else if (message.method === "tools/list") result = { tools: ["echo", "fail", "direct", "delete", "hidden"].map((name) => ({ name, description: `Fixture ${name}`, inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: { value: { type: "string" } } } })) };
    else if (message.method === "tools/call") {
      const name = (message.params as { name: string }).name;
      this.calls.push(name);
      result = { content: [{ type: "text", text: name }], structuredContent: { value: name }, ...(name === "fail" ? { isError: true } : {}) };
    } else throw new Error(`Unexpected fixture method: ${message.method}`);
    queueMicrotask(() => { for (const listener of this.listeners) listener({ jsonrpc: "2.0", id: message.id, result } as JsonRpcMessage); });
  }
}

test("exact native Pi MCP/codemode pipeline preserves reach, result errors, declarations and forbidden tools offline", { timeout: 20_000 }, async () => {
  assert.equal(VERSION, "1.1.0");
  const tempParent = path.join(process.cwd(), ".bun-tmp");
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, "native-mcp-"));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "workspace");
  const previousOffline = process.env.PI_OFFLINE, originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  const forbidden = (): never => { forbiddenCalls++; throw new Error("Fixture forbids network/provider/auth/config mutations"); };
  globalThis.fetch = forbidden as unknown as typeof fetch;
  process.env.PI_OFFLINE = "1";
  const transports: FixtureTransport[] = [];
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
  try {
    await fs.mkdir(agentDir); await fs.mkdir(cwd);
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden } });
    const model = runtime.getModels()[0]; assert.ok(model);
    runtime.stream = forbidden; runtime.streamSimple = forbidden; runtime.getAuth = forbidden;
    runtime.classify = forbidden; runtime.generateImages = forbidden;
    const argv = buildPiArgs({ name: "reader", description: "", source: "user", filePath: "/reader.md", systemPrompt: "", tools: ["read"] }, null, "/task", "spawn", null, undefined, "inherit", undefined, VERSION, true);
    const inheritedTools = argv[argv.indexOf("--tools") + 1]!.split(",");
    assert.deepEqual(inheritedTools, ["read", "mcp__docs__*", "codemode"]);
    for (const lane of ["restricted", "ordinary", "excluded", "disabled", "replacement"] as const) {
      const restricted = lane === "restricted";
      const tools = restricted ? inheritedTools : resolveInheritedChildToolSelection({ agentTools: ["read"], hostVersion: VERSION, parentNativeCodemodeActive: true }).tools!;
      const settingsManager = SettingsManager.inMemory(lane === "disabled" ? { extensions: ["-builtin:codemode"] } : {});
      const loadConfig: McpExtensionOptions["loadConfig"] = () => ({ errors: [], servers: ["docs", "other"].map((name) => ({ name, source: "owned-in-memory", config: { command: "never-executed", toolExposure: { direct: "direct", hidden: "hidden" } } })) });
      const mcpOptions: McpExtensionOptions = {
        loadConfig, createTransport: () => { const transport = new FixtureTransport(); transports.push(transport); return transport; },
        credentials: { forServer: forbidden, tokens: forbidden, remove: forbidden } as unknown as McpExtensionOptions["credentials"],
        logPath: path.join(root, "unused-mcp.log"), openUrl: forbidden, updateConfig: forbidden,
      };
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          ...(lane === "replacement" ? [{ name: "replacement", factory: createCodemodeExtension({ models: false }) }] : []),
          { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
          { name: "mcp", factory: createMcpExtension(mcpOptions), builtin: true, replaceable: true },
        ],
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => false });
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools, excludeTools: lane === "excluded" ? ["codemode", "mcp__*__delete"] : restricted ? ["mcp__docs__delete"] : ["mcp__*__delete"] });
      sessions.push(session);
      // Baseline is the same native local loadout before MCP connects, not a
      // token estimate or a snapshot of the real caller's session.
      const baselineGateway = session.agent.state.tools.find((tool) => tool.name === "codemode");
      const baselineDescriptionChars = baselineGateway?.description.length;
      const baselineParametersChars = baselineGateway ? JSON.stringify(baselineGateway.parameters).length : undefined;
      await session.bindExtensions({});
      // No provider turn invokes the top-level tool_call readiness hook here.
      // Wait boundedly for the real background client to publish its registry.
      const deadline = performance.now() + 3000;
      while (!session.getAllTools().some((tool) => tool.name === "mcp__docs__echo") && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
      assert.ok(session.getAllTools().some((tool) => tool.name === "mcp__docs__echo"), "native fixture connection must register before direct offline invocation");
      const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode")!;
      if (lane === "excluded" || lane === "disabled") {
        assert.equal(codemode, undefined, "do not reopen excluded or disabled native gateway");
        assert.equal(session.getAllTools().some((tool) => tool.name === "codemode"), false);
        continue;
      }
      assert.ok(codemode);
      if (lane === "replacement") {
        const replacement = session.getAllTools().find((tool) => tool.name === "codemode")!;
        assert.notEqual(replacement.sourceInfo.path, "builtin:codemode", "native loader preserves inherited replacement owner");
        assert.equal(resourceLoader.getExtensions().extensions.some((extension) => extension.path === "builtin:codemode"), false);
        continue;
      }
      const owner = session.getAllTools().find((tool) => tool.name === "codemode")!.sourceInfo;
      assert.equal(owner.source, "builtin"); assert.equal(owner.path, "builtin:codemode");
      session.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: "fixture", name: "codemode", arguments: {} }], api: model.api, provider: model.provider, model: model.id, timestamp: 0, stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
      const result = await codemode.execute("fixture", { code: `// @options: {"timeout_ms": 5000}
text({names: ALL_TOOLS.map(t => t.name).sort(), echo: await tools.mcp__docs__echo({}), fail: await tools.mcp__docs__fail({})});` }, AbortSignal.timeout(10_000));
      assert.notEqual(result.isError, true, JSON.stringify(result));
      const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const data = JSON.parse(text.slice(text.indexOf('{"names"')));
      assert.deepEqual(data.echo.structuredContent, { value: "echo" });
      assert.equal(data.fail.isError, true, "MCP error results resolve inside native scripts");
      assert.equal(data.fail.content[0].text, "fail");
      const declarations = session.agent.state.tools.map((tool) => tool.name);
      for (const name of ["mcp__docs__echo", "mcp__docs__fail", "mcp__docs__hidden", "mcp__docs__delete"]) assert.equal(declarations.includes(name), false);
      assert.equal(declarations.includes("mcp__docs__direct"), restricted, "unmatched direct stays inactive, not coerced to callable");
      assert.equal(data.names.includes("mcp__docs__direct"), restricted);
      assert.equal(data.names.some((name: string) => name.startsWith("mcp__other__")), !restricted);
      const forbiddenNames = ["bash", "edit", "write", "codemode", "subagent", "mcp__docs__hidden", "mcp__docs__delete", ...(restricted ? ["mcp__other__echo"] : ["mcp__docs__direct"])];
      for (const name of forbiddenNames) {
        const denied = await codemode.execute(`denied-${name}`, { code: `await tools.${name}({});` }, AbortSignal.timeout(5_000));
        assert.equal(denied.isError, true, name);
        assert.match(denied.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), /does not exist/);
      }
      assert.equal(codemode.description.includes("Fixture echo"), false, "default MCP exposure has no per-tool inline schema");
      assert.equal(codemode.description.length, baselineDescriptionChars, "fixture MCP default exposure does not grow gateway description after connection");
      assert.equal(JSON.stringify(codemode.parameters).length, baselineParametersChars);
      if (restricted) console.log(JSON.stringify({ contextSurface: "native-codemode-gateway", baseline: { descriptionChars: baselineDescriptionChars, parametersChars: baselineParametersChars }, inherited: { descriptionChars: codemode.description.length, parametersChars: JSON.stringify(codemode.parameters).length }, note: "Characters, not tokens. Adding a gateway is not zero context; direct MCP declarations/server prompt sections are separate." }));
    }
    assert.deepEqual(transports.filter((transport) => transport.calls.length > 0).map((transport) => transport.calls), [["echo", "fail"], ["echo", "fail"]]);
    assert.equal(transports.length, 10);
    assert.equal(forbiddenCalls, 0);
  } finally {
    // These peers own no external process/socket. Close every owned transport
    // explicitly: session.dispose does not emit native session_shutdown.
    for (const transport of transports) await transport.close();
    for (const session of sessions) session.dispose();
    globalThis.fetch = originalFetch;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline;
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("public parent capability drives supplementation even with MCP autoEnableCodemode false", { timeout: 20_000 }, async () => {
  const tempParent = path.join(process.cwd(), ".bun-tmp");
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, "native-mcp-active-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const previousOffline = process.env.PI_OFFLINE;
  const originalFetch = globalThis.fetch;
  let forbiddenCalls = 0;
  const forbidden = (): never => { forbiddenCalls++; throw new Error("Fixture forbids network/provider/auth/config mutations"); };
  globalThis.fetch = forbidden as unknown as typeof fetch;
  process.env.PI_OFFLINE = "1";
  const transports: FixtureTransport[] = [];
  const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
  try {
    await fs.mkdir(agentDir);
    await fs.mkdir(cwd);
    const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden } });
    const model = runtime.getModels()[0];
    assert.ok(model);
    runtime.stream = forbidden; runtime.streamSimple = forbidden; runtime.getAuth = forbidden;
    runtime.classify = forbidden; runtime.generateImages = forbidden;

    // Both parent and child use the real native host, with config supplied only
    // by the owned fixture. Production captures just the two public APIs.
    const openSession = async (tools: string[] | undefined, autoEnableCodemode: boolean) => {
      const settingsManager = SettingsManager.inMemory({});
      const mcpOptions: McpExtensionOptions = {
        loadConfig: () => ({ autoEnableCodemode, errors: [], servers: [{ name: "docs", source: "owned-in-memory", config: { command: "never-executed" } }] }),
        createTransport: () => { const transport = new FixtureTransport(); transports.push(transport); return transport; },
        credentials: { forServer: forbidden, tokens: forbidden, remove: forbidden } as unknown as McpExtensionOptions["credentials"],
        logPath: path.join(root, "unused-mcp.log"), openUrl: forbidden, updateConfig: forbidden,
      };
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
          { name: "mcp", factory: createMcpExtension(mcpOptions), builtin: true, replaceable: true },
        ],
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => false });
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, thinkingLevel: "off", settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools });
      sessions.push(session);
      await session.bindExtensions({});
      const deadline = performance.now() + 3000;
      while (!session.getAllTools().some((tool) => tool.name === "mcp__docs__echo") && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2));
      assert.ok(session.getAllTools().some((tool) => tool.name === "mcp__docs__echo"));
      return session;
    };

    for (const scenario of [
      { name: "native MCP autoactivation", auto: true, parentTools: undefined, activateManually: false, expected: true },
      { name: "false auto flag, explicit parent native selection", auto: false, parentTools: ["read", "codemode"], activateManually: false, expected: true },
      { name: "false auto flag, inactive native gateway", auto: false, parentTools: undefined, activateManually: false, expected: false },
      { name: "false auto flag, public runtime selection", auto: false, parentTools: undefined, activateManually: true, expected: true },
      { name: "ordered exact modifiers re-enable native gateway", auto: false, parentTools: ["-codemode", "+codemode"], activateManually: false, expected: true },
      { name: "ordered exact modifiers finally remove native gateway", auto: false, parentTools: ["+codemode", "-codemode"], activateManually: false, expected: false },
    ]) {
      const parent = await openSession(scenario.parentTools, scenario.auto);
      if (scenario.activateManually) parent.setActiveToolsByName(["read", "codemode"]);
      const parentNativeCodemodeActive = captureParentNativeCodemodeActive({ getActiveTools: () => parent.getActiveToolNames(), getAllTools: () => parent.getAllTools() });
      assert.equal(parentNativeCodemodeActive, scenario.expected, scenario.name);
      const tools = resolveInheritedChildToolSelection({ agentTools: ["read"], hostVersion: VERSION, parentNativeCodemodeActive }).tools!;
      assert.deepEqual(tools, scenario.expected ? ["read", "codemode"] : ["read"], scenario.name);
      const child = await openSession(tools, scenario.auto);
      assert.equal(child.getActiveToolNames().includes("codemode"), scenario.expected, scenario.name);
      assert.equal(captureParentNativeCodemodeActive({ getActiveTools: () => child.getActiveToolNames(), getAllTools: () => child.getAllTools() }), scenario.expected, "nested capture observes the child's own active native gateway");
    }
    assert.equal(forbiddenCalls, 0);
    assert.equal(transports.length, 12);
    assert.ok(transports.every((transport) => transport.calls.length === 0), "no provider or MCP tool call is needed to capture capability");
  } finally {
    for (const transport of transports) await transport.close();
    for (const session of sessions) session.dispose();
    globalThis.fetch = originalFetch;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await fs.rm(root, { recursive: true, force: true });
  }
});
