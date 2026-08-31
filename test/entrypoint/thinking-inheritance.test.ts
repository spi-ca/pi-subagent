// @ts-expect-error Bun runtime export is intentionally absent from @types/node.
import { describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const captured: Array<{ agentName: string; parentThinkingLevel?: string }> = [];

mock.module("@earendil-works/pi-tui", () => ({
  Container: class {}, Markdown: class {}, Spacer: class {}, Text: class {},
}));
mock.module("../../src/runtime/tree-permit-authority", () => ({
  TREE_PERMIT_LEASE_ID_ENV: "PI_SUBAGENT_TEST_LEASE_ID",
  TREE_PERMIT_LEASE_TOKEN_ENV: "PI_SUBAGENT_TEST_LEASE_TOKEN",
  TREE_PERMIT_MAX_ACTIVE_ENV: "PI_SUBAGENT_TEST_MAX_ACTIVE",
  TREE_PERMIT_ROOT_ENV: "PI_SUBAGENT_TEST_ROOT",
  TREE_PERMIT_ROOT_ID_ENV: "PI_SUBAGENT_TEST_ROOT_ID",
  TREE_PERMIT_TOKEN_ENV: "PI_SUBAGENT_TEST_TOKEN",
  createSharedForegroundPermitScopeManager: () => ({
    acquire: async () => undefined,
    release: async () => true,
    cancelSettlementWatchersIfIdle: async () => undefined,
  }),
  createTreePermitAuthorityLifecycle: () => ({ startup: async () => null, get: async () => null }),
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => ".pi",
  getMarkdownTheme: () => ({}),
  parseFrontmatter: <T>(content: string): { frontmatter: T; body: string } => {
    const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) throw new Error("invalid frontmatter");
    return {
      frontmatter: Object.fromEntries(match[1]!.split("\n").filter(Boolean).map((line) => {
        const separator = line.indexOf(":");
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
      })) as T,
      body: match[2] ?? "",
    };
  },
}));

// Load the production module before replacing only the entrypoint's dependency.
const actualRunner = await import("../../src/runtime/runner");
const successfulResult = (options: { agentName: string; task: string }) => ({
  agent: options.agentName, agentSource: "user" as const, task: options.task, exitCode: 0, messages: [], stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
});
const interceptor = async (options: Parameters<typeof actualRunner.runAgent>[0]) => {
  captured.push({ agentName: options.agentName, parentThinkingLevel: options.parentThinkingLevel });
  if (options.task === "blocker") await blockerReleased;
  return successfulResult(options);
};
let releaseBlocker: () => void = () => undefined;
let blockerReleased: Promise<void> = Promise.resolve();
mock.module("../../src/runtime/runner", () => ({ ...actualRunner, runAgent: interceptor }));
const { default: registerPiSubagent } = await import("../../index");

type Tool = { name?: string; execute?: (...args: any[]) => Promise<unknown> };
type SessionContext = {
  cwd: string;
  thinkingLevel?: string;
  hasUI: false;
  isIdle: () => boolean;
  ui: { notify: () => void; confirm: () => Promise<false> };
  sessionManager: { getSessionId: () => string; getSessionFile: () => undefined };
};

describe("subagent thinking inheritance", () => {
  test("forwards invocation-time session thinking to runner for single, parallel, chain, and delayed background work", async () => {
    let configDir: string | undefined;
    let context: SessionContext | undefined;
    let sessionShutdown: ((...args: any[]) => Promise<unknown>) | undefined;
    const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
    const previousDepth = process.env.PI_SUBAGENT_DEPTH;
    const previousStack = process.env.PI_SUBAGENT_STACK;
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    let subagentTool: Tool | undefined;

    try {
      let resolveBlocker!: () => void;
      blockerReleased = new Promise<void>((resolve) => { resolveBlocker = resolve; });
      releaseBlocker = resolveBlocker;
      configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-thinking-"));
      context = {
        cwd: configDir,
        thinkingLevel: "medium",
        hasUI: false,
        isIdle: () => true,
        ui: { notify: () => undefined, confirm: async () => false },
        sessionManager: { getSessionId: () => "thinking-session", getSessionFile: () => undefined },
      };
      await fs.mkdir(path.join(configDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(configDir, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\nWork\n");
      process.env.PI_CODING_AGENT_DIR = configDir;
      delete process.env.PI_SUBAGENT_DEPTH;
      delete process.env.PI_SUBAGENT_STACK;
      registerPiSubagent({
        registerFlag: () => undefined,
        getFlag: (name: string) => name === "subagent-max-active" ? "1" : undefined,
        registerCommand: () => undefined,
        registerTool: (tool: Tool) => { if (tool.name === "subagent") subagentTool = tool; },
        on: (event: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(event, handler),
        events: { emit: () => undefined },
        sendMessage: () => undefined,
        getAllTools: () => [],
        getCommands: () => [],
      } as never);
      const sessionStart = handlers.get("session_start");
      sessionShutdown = handlers.get("session_shutdown");
      assert.ok(sessionStart);
      assert.ok(sessionShutdown);
      await sessionStart({}, context);
      assert.ok(subagentTool?.execute, "the registered subagent tool must expose execute");

      const invoke = async (params: Record<string, unknown>) => await subagentTool!.execute!("thinking-test", params, new AbortController().signal, undefined, context!);
      captured.length = 0;
      await invoke({ agent: "worker", task: "single" });
      assert.deepEqual(captured.map((entry) => entry.parentThinkingLevel), ["medium"]);

      context.thinkingLevel = "low";
      captured.length = 0;
      await invoke({ tasks: [{ agent: "worker", task: "parallel-a" }, { agent: "worker", task: "parallel-b" }] });
      assert.deepEqual(captured.map((entry) => entry.parentThinkingLevel), ["low", "low"]);

      context.thinkingLevel = "high";
      captured.length = 0;
      await invoke({ chain: [
        { agent: "worker", task: "sequential" },
        { type: "parallel", label: "parallel-stage", tasks: [{ agent: "worker", task: "chain-parallel-a" }, { agent: "worker", task: "chain-parallel-b" }] },
      ] });
      assert.deepEqual(captured.map((entry) => entry.parentThinkingLevel), ["high", "high", "high"]);

      context.thinkingLevel = "low";
      captured.length = 0;
      await invoke({ agent: "worker", task: "blocker", background: true });
      for (let attempt = 0; attempt < 20 && captured.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(captured.map((entry) => entry.parentThinkingLevel), ["low"], "the first background run holds the only scheduler slot");

      context.thinkingLevel = "minimal";
      await invoke({ agent: "worker", task: "delayed-background", background: true });
      context.thinkingLevel = "off";
      releaseBlocker();
      for (let attempt = 0; attempt < 20 && captured.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(captured.map((entry) => entry.parentThinkingLevel), ["low", "minimal"], "a queued background launch uses its invocation-time session value");
    } finally {
      const shutdown = sessionShutdown && context ? sessionShutdown({}, context) : undefined;
      releaseBlocker();
      try {
        await shutdown;
      } finally {
        if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
        if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
        else process.env.PI_SUBAGENT_DEPTH = previousDepth;
        if (previousStack === undefined) delete process.env.PI_SUBAGENT_STACK;
        else process.env.PI_SUBAGENT_STACK = previousStack;
        if (configDir) await fs.rm(configDir, { recursive: true, force: true });
      }
    }
  });
});
