// @ts-expect-error Bun mock runtime export is absent from @types/node.
import { mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import assert from "node:assert/strict";
import { discoverAgents, type AgentConfig } from "../../src/core/agents";

const originalArgv = process.argv;
process.argv = ["bun", "pi", "--tools", "bash,mcp__docs__*", "--exclude-tools", "mcp__docs__delete", "--no-tools"];
const { buildPiArgs, buildInteractivePiArgs, runAgent } = await import("../../src/runtime/runner");
process.argv = originalArgv;
const agent: AgentConfig = { name: "reader", description: "", systemPrompt: "", source: "user", filePath: "/reader.md", tools: ["read"] };
const build = (tools: string[], version = "1.1.0", parentNativeCodemodeActive = true) => [
  ...(["spawn", "fork"] as const).map((mode) => buildPiArgs({ ...agent, tools }, null, "/task", mode, mode === "fork" ? "/session" : null, undefined, "inherit", undefined, version, parentNativeCodemodeActive)),
  buildInteractivePiArgs({ ...agent, tools }, null, "/task", "/session", undefined, "inherit", undefined, version, parentNativeCodemodeActive),
];

test("spawn/fork/interactive retain parent MCP namespace and exclusions beside agent local tools", () => {
  for (const args of build(["read"])) {
    assert.equal(args.includes("--no-mcp"), false);
    assert.equal(args.includes("--no-tools"), false, "explicit selection overrides historical no-tools fallback");
    assert.equal(args[args.indexOf("--tools") + 1], "read,mcp__docs__*,codemode");
    assert.equal(args[args.indexOf("--exclude-tools") + 1], "mcp__docs__delete");
    assert.equal(args.includes("builtin:codemode"), false, "do not force-load over disabled/native replacement owner");
  }
  for (const args of build(["read", "mcp__docs__read"])) assert.equal(args[args.indexOf("--tools") + 1], "read,mcp__docs__read,codemode");
  for (const args of build(["read", "mcp__*"])) assert.equal(args[args.indexOf("--tools") + 1], "read,mcp__docs__*,codemode");
  for (const args of build(["read", "mcp__other__*"])) {
    assert.ok(args.includes("--no-mcp"));
    assert.equal(args[args.indexOf("--tools") + 1], "read");
  }
  for (const args of build([])) assert.ok(args.includes("--no-tools") && args.includes("--no-mcp") && !args.includes("--tools"));
  for (const args of build(["read"], "1.0.4")) assert.equal(args[args.indexOf("--tools") + 1], "read,mcp__docs__*");
});

test("discovered empty frontmatter retains parent tool and MCP fallback compatibility", async () => {
  const tempParent = path.join(process.cwd(), ".bun-tmp");
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, "mcp-empty-frontmatter-"));
  const agentsDir = path.join(root, "agents");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await fs.mkdir(agentsDir, { recursive: true });
    for (const [name, field] of [["omitted", ""], ["array", "tools: []\n"], ["string", 'tools: ""\n']] as const) {
      await fs.writeFile(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: Fixture\n${field}---\nFixture\n`);
    }
    const discovered = discoverAgents(root, "user").agents;
    assert.equal(discovered.length, 3);
    for (const config of discovered) {
      assert.equal(config.tools, undefined, "empty file selections remain omitted, not explicit no-tools");
      const variants = [
        buildPiArgs(config, null, "/task", "spawn", null, undefined, "inherit", undefined, "1.1.0", true),
        buildPiArgs(config, null, "/task", "fork", "/session", undefined, "inherit", undefined, "1.1.0", true),
        buildInteractivePiArgs(config, null, "/task", "/session", undefined, "inherit", undefined, "1.1.0", true),
      ];
      for (const args of variants) {
        assert.equal(args[args.indexOf("--tools") + 1], "bash,mcp__docs__*,codemode");
        assert.equal(args.includes("--no-tools"), false, "parent tools retain precedence over no-tools fallback");
        assert.equal(args.includes("--no-mcp"), false);
      }
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unrepresentable refinement errors before an actual run is started", async () => {
  for (const tools of [["+read"], ["*"]]) assert.throws(() => build(tools), /Cannot preserve parent MCP allowlist/);
  const result = await runAgent({ cwd: process.cwd(), agents: [{ ...agent, tools: ["+read"] }], agentName: agent.name, task: "Never launch", delegationMode: "spawn", terminalMode: "inline", parentDepth: 0, parentAgentStack: [], maxDepth: 5, preventCycles: true, makeDetails: (results) => ({ mode: "single", results, toolLabel: "Subagent", delegationMode: "spawn", terminalMode: "inline", projectAgentsDir: null }) });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stopReason, "error");
  assert.deepEqual(result.messages, []);
  assert.match(result.errorMessage ?? "", /Cannot preserve parent MCP allowlist/);
});


test("all builders default to no supplementation and respect invocation-scoped inactive evidence", () => {
  for (const args of build(["read"], "1.1.0", false)) {
    assert.equal(args[args.indexOf("--tools") + 1], "read,mcp__docs__*");
    assert.equal(args.includes("--no-mcp"), false);
  }
  const defaults = [
    buildPiArgs(agent, null, "/task", "spawn", null, undefined, "inherit", undefined, "1.1.0"),
    buildPiArgs(agent, null, "/task", "fork", "/session", undefined, "inherit", undefined, "1.1.0"),
    buildInteractivePiArgs(agent, null, "/task", "/session", undefined, "inherit", undefined, "1.1.0"),
  ];
  for (const args of defaults) assert.equal(args[args.indexOf("--tools") + 1], "read,mcp__docs__*");
  for (const args of build(["read", "codemode"], "1.1.0", false)) assert.equal(args[args.indexOf("--tools") + 1], "read,codemode,mcp__docs__*");
});


test("entrypoint captures native capability once for single, parallel, chain and queued background invocations", async () => {
  const actualRunner = await import("../../src/runtime/runner");
  const actualPermits = await import("../../src/runtime/tree-permit-authority");
  const captured: Array<{ task: string; parentNativeCodemodeActive?: boolean }> = [];
  let releaseBlocker!: () => void;
  const blocker = new Promise<void>((resolve) => { releaseBlocker = resolve; });
  const entries = new Map<string, () => void>();
  const entered = (task: string) => new Promise<void>((resolve) => { entries.set(task, resolve); });
  const bounded = async (entry: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([entry, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("mock runner entry timed out")), 2_000); })]);
    } finally { clearTimeout(timer); }
  };
  mock.module("../../src/runtime/runner", () => ({
    ...actualRunner,
    runAgent: async (options: Parameters<typeof actualRunner.runAgent>[0]) => {
      captured.push({ task: options.task, parentNativeCodemodeActive: options.parentNativeCodemodeActive });
      entries.get(options.task)?.();
      if (options.task === "blocker") await blocker;
      return { agent: options.agentName, agentSource: "user", task: options.task, exitCode: 0, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
    },
    startStaleInteractiveReaper: async () => ({ startup: Promise.resolve(), completion: Promise.resolve({ diagnostics: [] }), cancelAndDrain: async () => undefined }),
  }));
  mock.module("../../src/runtime/tree-permit-authority", () => ({
    ...actualPermits,
    createSharedForegroundPermitScopeManager: () => ({ acquire: async () => undefined, release: async () => true, cancelSettlementWatchersIfIdle: async () => undefined }),
    createTreePermitAuthorityLifecycle: () => ({ startup: async () => null, get: async () => null }),
  }));
  const { default: register } = await import("../../index");
  const tempParent = path.join(process.cwd(), ".bun-tmp");
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, "mcp-invocation-"));
  const saved = { configDir: process.env.PI_CODING_AGENT_DIR, depth: process.env.PI_SUBAGENT_DEPTH, stack: process.env.PI_SUBAGENT_STACK };
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let execute!: (...args: any[]) => Promise<unknown>;
  let active = ["codemode"];
  let owner: { source?: string; path?: string } | undefined = { source: "builtin", path: "builtin:codemode" };
  let activeReads = 0;
  let shutdown: (() => Promise<unknown>) | undefined;
  try {
    await fs.mkdir(path.join(root, "agents"));
    await fs.writeFile(path.join(root, "agents", "reader.md"), "---\nname: reader\ndescription: Reader\ntools: read\n---\nRead\n");
    process.env.PI_CODING_AGENT_DIR = root;
    delete process.env.PI_SUBAGENT_DEPTH;
    delete process.env.PI_SUBAGENT_STACK;
    register({
      registerToolRenderer: () => undefined, registerMessageRenderer: () => undefined, registerFlag: () => undefined, registerCommand: () => undefined,
      getFlag: (name: string) => name === "subagent-max-active" ? "1" : undefined,
      registerTool: (tool: { name: string; execute: typeof execute }) => { if (tool.name === "subagent") execute = tool.execute; },
      on: (name: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(name, handler),
      events: { emit: () => undefined }, sendMessage: () => undefined, getCommands: () => [],
      getActiveTools: () => { activeReads++; return active; },
      getAllTools: () => [{ name: "codemode", sourceInfo: owner }],
    } as never);
    const context = { cwd: root, hasUI: false, isIdle: () => true, ui: { notify: () => undefined, confirm: async () => false }, sessionManager: { getSessionId: () => "mcp-invocation", getSessionFile: () => undefined } };
    shutdown = async () => await handlers.get("session_shutdown")!({}, context);
    await handlers.get("session_start")!({}, context);
    const invoke = async (params: Record<string, unknown>) => await execute("mcp-test", params, new AbortController().signal, undefined, context);
    for (const metadata of [
      { source: "builtin", path: "builtin:codemode" },
      { source: "extension", path: "builtin:codemode" },
      { source: "builtin", path: "/replacement.ts" }, undefined,
    ]) {
      owner = metadata;
      captured.length = 0;
      await invoke({ agent: "reader", task: "single" });
      assert.equal(captured[0]?.parentNativeCodemodeActive, metadata?.source === "builtin" && metadata.path === "builtin:codemode");
    }
    owner = { source: "builtin", path: "builtin:codemode" };
    active = [];
    captured.length = 0;
    await invoke({ agent: "reader", task: "inactive" });
    assert.equal(captured[0]?.parentNativeCodemodeActive, false);
    active = ["codemode"];
    captured.length = 0;
    const beforeParallel = activeReads;
    await invoke({ tasks: [{ agent: "reader", task: "parallel-a" }, { agent: "reader", task: "parallel-b" }] });
    assert.deepEqual(captured.map((entry) => entry.parentNativeCodemodeActive), [true, true]);
    assert.equal(activeReads - beforeParallel, 1);
    captured.length = 0;
    const beforeChain = activeReads;
    await invoke({ chain: [{ agent: "reader", task: "first" }, { type: "parallel", label: "batch", tasks: [{ agent: "reader", task: "chain-a" }, { agent: "reader", task: "chain-b" }] }] });
    assert.deepEqual(captured.map((entry) => entry.parentNativeCodemodeActive), [true, true, true]);
    assert.equal(activeReads - beforeChain, 1);
    captured.length = 0;
    const blockerEntered = entered("blocker");
    const inactiveEntered = entered("queued-inactive");
    const activeEntered = entered("queued-active");
    await invoke({ agent: "reader", task: "blocker", background: true });
    await bounded(blockerEntered);
    assert.equal(captured.length, 1);
    active = [];
    await invoke({ agent: "reader", task: "queued-inactive", background: true });
    active = ["codemode"];
    await invoke({ agent: "reader", task: "queued-active", background: true });
    active = [];
    owner = { source: "extension", path: "/later.ts" };
    releaseBlocker();
    await bounded(Promise.all([inactiveEntered, activeEntered]).then(() => undefined));
    assert.deepEqual(captured.map((entry) => entry.parentNativeCodemodeActive), [true, false, true], "queued/background runners retain each invocation's capability, not later registry state");
  } finally {
    releaseBlocker();
    await shutdown?.();
    if (saved.configDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.configDir;
    if (saved.depth === undefined) delete process.env.PI_SUBAGENT_DEPTH; else process.env.PI_SUBAGENT_DEPTH = saved.depth;
    if (saved.stack === undefined) delete process.env.PI_SUBAGENT_STACK; else process.env.PI_SUBAGENT_STACK = saved.stack;
    await fs.rm(root, { recursive: true, force: true });
  }
});
