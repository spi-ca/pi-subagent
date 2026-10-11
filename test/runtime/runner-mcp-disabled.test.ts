// @ts-expect-error Bun mock runtime export is absent from @types/node.
import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discoverAgents, type AgentConfig } from "../../src/core/agents";

// No parent --no-mcp: the child allowlist must disable native MCP itself.
const originalArgv = process.argv;
process.argv = ["bun", "pi", "--tools", "bash,grep", "--exclude-tools", "mcp__docs__delete", "--no-tools"];
const { buildPiArgs, buildInteractivePiArgs } = await import("../../src/runtime/runner");
process.argv = originalArgv;
const agent: AgentConfig = { name: "reader", description: "", systemPrompt: "", source: "user", filePath: "/reader.md", tools: ["read"] };

function variants(config: AgentConfig, policy: "inherit" | "managed", version = "1.1.0") {
  return [
    buildPiArgs(config, null, "/task", "spawn", null, undefined, policy, undefined, version),
    buildPiArgs(config, null, "/task", "fork", "/session", undefined, policy, undefined, version),
    buildInteractivePiArgs(config, null, "/task", "/session", undefined, policy, undefined, version),
  ];
}

test("ordinary and managed spawn/fork/interactive children disable native MCP without widening role tools", () => {
  for (const policy of ["inherit", "managed"] as const) {
    for (const tools of [["read"], ["read", "grep", "find", "ls", "codemode"]]) {
      for (const args of variants({ ...agent, tools }, policy)) {
        assert.equal(args.filter((arg) => arg === "--no-mcp").length, 1);
        assert.equal(args[args.indexOf("--tools") + 1], tools.join(","));
        assert.equal(args.includes("--no-tools"), false, "agent selection takes precedence over no-tools fallback");
        assert.equal(args[args.indexOf("--exclude-tools") + 1], "mcp__docs__delete");
        assert.equal(args.includes("builtin:codemode"), policy === "managed" && tools.includes("codemode"), "#39 explicit managed codemode remains opt-in");
      }
    }
    for (const args of variants(agent, policy, "1.0.3")) assert.equal(args.includes("--no-mcp"), false, "unsupported hosts do not receive a native MCP flag");
  }
});

test("discovered omitted and empty frontmatter retain local parent fallback compatibility", async () => {
  const tempParent = path.join(process.cwd(), ".bun-tmp");
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, "mcp-empty-disabled-"));
  const agentsDir = path.join(root, "agents");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await fs.mkdir(agentsDir, { recursive: true });
    for (const [name, field] of [["omitted", ""], ["array", "tools: []\n"], ["string", 'tools: ""\n'], ["reader", "tools: read\n"]] as const) {
      await fs.writeFile(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: Fixture\n${field}---\nFixture\n`);
    }
    const discovered = discoverAgents(root, "user").agents;
    assert.equal(discovered.length, 4);
    for (const config of discovered) {
      const explicitReader = config.name === "reader";
      assert.deepEqual(config.tools, explicitReader ? ["read"] : undefined);
      for (const policy of ["inherit", "managed"] as const) {
        for (const args of variants(config, policy)) {
          assert.ok(args.includes("--no-mcp"));
          assert.equal(args.includes("--no-tools"), false, "effective local tools take precedence over no-tools fallback");
          assert.equal(args[args.indexOf("--tools") + 1], explicitReader ? "read" : "bash,grep");
          assert.equal(args.includes("builtin:codemode"), false, "no implicit gateway supplementation");
        }
      }
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Retain #42's explicit, bounded runner-entry signals instead of timing polls.
// The registry-capability feature is gone; assert the disabled child profile.
test("single, parallel, chain and queued background invocations retain native MCP-disabled role selection", async () => {
  const actualRunner = await import("../../src/runtime/runner");
  const actualPermits = await import("../../src/runtime/tree-permit-authority");
  const captured: string[] = [];
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
      const config = options.agents.find((candidate) => candidate.name === options.agentName)!;
      for (const policy of ["inherit", "managed"] as const) {
        for (const args of variants(config, policy)) {
          assert.ok(args.includes("--no-mcp"));
          assert.equal(args[args.indexOf("--tools") + 1], "read");
          assert.equal(args.includes("builtin:codemode"), false);
        }
      }
      captured.push(options.task);
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
  const root = await fs.mkdtemp(path.join(tempParent, "mcp-disabled-invocation-"));
  const saved = { configDir: process.env.PI_CODING_AGENT_DIR, depth: process.env.PI_SUBAGENT_DEPTH, stack: process.env.PI_SUBAGENT_STACK };
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let execute!: (...args: any[]) => Promise<unknown>;
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
      getActiveTools: () => { throw new Error("native gateway inheritance must not inspect active parent tools"); },
      getAllTools: () => [{ name: "codemode", sourceInfo: { source: "builtin", path: "builtin:codemode" } }],
    } as never);
    const context = { cwd: root, hasUI: false, isIdle: () => true, ui: { notify: () => undefined, confirm: async () => false }, sessionManager: { getSessionId: () => "mcp-disabled-invocation", getSessionFile: () => undefined } };
    shutdown = async () => await handlers.get("session_shutdown")!({}, context);
    await handlers.get("session_start")!({}, context);
    const invoke = async (params: Record<string, unknown>) => await execute("mcp-disabled-test", params, new AbortController().signal, undefined, context);
    await invoke({ agent: "reader", task: "single" });
    assert.deepEqual(captured, ["single"]);
    captured.length = 0;
    await invoke({ tasks: [{ agent: "reader", task: "parallel-a" }, { agent: "reader", task: "parallel-b" }] });
    assert.deepEqual(captured, ["parallel-a", "parallel-b"]);
    captured.length = 0;
    await invoke({ chain: [{ agent: "reader", task: "first" }, { type: "parallel", label: "batch", tasks: [{ agent: "reader", task: "chain-a" }, { agent: "reader", task: "chain-b" }] }] });
    assert.equal(captured.length, 3);
    assert.equal(captured[0], "first");
    assert.match(captured[1], /Current task:\nchain-a$/);
    assert.match(captured[2], /Current task:\nchain-b$/);
    captured.length = 0;
    const blockerEntered = entered("blocker");
    const firstEntered = entered("queued-first");
    const secondEntered = entered("queued-second");
    await invoke({ agent: "reader", task: "blocker", background: true });
    await bounded(blockerEntered);
    assert.deepEqual(captured, ["blocker"]);
    await invoke({ agent: "reader", task: "queued-first", background: true });
    await invoke({ agent: "reader", task: "queued-second", background: true });
    assert.deepEqual(captured, ["blocker"], "queued tasks must not enter the runner before the local slot is released");
    releaseBlocker();
    await bounded(Promise.all([firstEntered, secondEntered]).then(() => undefined));
    assert.deepEqual(captured, ["blocker", "queued-first", "queued-second"]);
  } finally {
    releaseBlocker();
    await shutdown?.();
    if (saved.configDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.configDir;
    if (saved.depth === undefined) delete process.env.PI_SUBAGENT_DEPTH; else process.env.PI_SUBAGENT_DEPTH = saved.depth;
    if (saved.stack === undefined) delete process.env.PI_SUBAGENT_STACK; else process.env.PI_SUBAGENT_STACK = saved.stack;
    await fs.rm(root, { recursive: true, force: true });
  }
});
