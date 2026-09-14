// Bun implements module mocks but this project's Node-only test types omit it.
// @ts-expect-error Bun runtime export is intentionally absent from @types/node.
import { describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const { ProcessLocalScheduler: RealProcessLocalScheduler } = await import("../../src/runtime/process-local-scheduler");
const createdSchedulers: InstanceType<typeof RealProcessLocalScheduler>[] = [];
class CapturingProcessLocalScheduler extends RealProcessLocalScheduler {
  constructor(...args: ConstructorParameters<typeof RealProcessLocalScheduler>) {
    super(...args);
    createdSchedulers.push(this);
  }
}

mock.module("@earendil-works/pi-tui", () => ({
  Box: class {},
  Container: class {}, Markdown: class {}, Spacer: class {}, Text: class {},
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
mock.module("../../src/runtime/process-local-scheduler", () => ({
  ProcessLocalScheduler: CapturingProcessLocalScheduler,
}));

// Load production exports, then intercept only the no-process runner boundary.
const actualRunner = await import("../../src/runtime/runner");
const successfulResult = (options: { agentName: string; task: string }) => ({
  agent: options.agentName, agentSource: "user" as const, task: options.task, exitCode: 0, messages: [], stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
});
let releaseActiveRuns: () => void = () => undefined;
let activeRunsReleased: Promise<void> = Promise.resolve();
const runnerTasks: string[] = [];
let markFirstStarted: () => void = () => undefined;
let markSecondStarted: () => void = () => undefined;
mock.module("../../src/runtime/runner", () => ({
  ...actualRunner,
  runAgent: async (options: Parameters<typeof actualRunner.runAgent>[0]) => {
    runnerTasks.push(options.task);
    if (options.task === "first") markFirstStarted();
    else if (options.task === "second") markSecondStarted();
    else throw new Error(`runner must not launch queued task ${options.task}`);
    await activeRunsReleased;
    return successfulResult(options);
  },
}));
const { default: registerPiSubagent } = await import("../../index");

type ToolResult = { isError?: boolean };
type Tool = { name?: string; execute?: (...args: any[]) => Promise<ToolResult> };
type SessionContext = {
  cwd: string;
  hasUI: false;
  isIdle: () => boolean;
  ui: { notify: () => void; confirm: () => Promise<false> };
  sessionManager: { getSessionId: () => string; getSessionFile: () => undefined };
};

function withinDeadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 1_000);
    timer.unref?.();
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function waitForSchedulerState(
  scheduler: InstanceType<typeof RealProcessLocalScheduler>,
  predicate: (state: { active: number; queued: number }) => boolean,
  description: string,
): Promise<void> {
  let unsubscribe: () => void = () => undefined;
  let matchedDuringSubscription = false;
  const reached = new Promise<void>((resolve) => {
    unsubscribe = scheduler.subscribe((state) => {
      if (!predicate(state)) return;
      matchedDuringSubscription = true;
      unsubscribe();
      resolve();
    });
  });
  if (matchedDuringSubscription) unsubscribe();
  return withinDeadline(reached, description).finally(() => unsubscribe());
}

describe("subagent foreground invocation concurrency", () => {
  test("starts independent tool invocations concurrently and aborts queued work before runner launch", async () => {
    const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
    const previousDepth = process.env.PI_SUBAGENT_DEPTH;
    const previousStack = process.env.PI_SUBAGENT_STACK;
    let configDir: string | undefined;
    let sessionShutdown: ((...args: any[]) => Promise<unknown>) | undefined;
    const activeInvocations: Promise<unknown>[] = [];
    let releaseFirstStarted!: () => void;
    let releaseSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { releaseFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { releaseSecondStarted = resolve; });

    try {
      configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-concurrent-"));
      await fs.mkdir(path.join(configDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(configDir, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\nWork\n");
      process.env.PI_CODING_AGENT_DIR = configDir;
      delete process.env.PI_SUBAGENT_DEPTH;
      delete process.env.PI_SUBAGENT_STACK;
      runnerTasks.length = 0;
      activeRunsReleased = new Promise<void>((resolve) => { releaseActiveRuns = resolve; });
      markFirstStarted = releaseFirstStarted;
      markSecondStarted = releaseSecondStarted;

      const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
      let subagentTool: Tool | undefined;
      const context: SessionContext = {
        cwd: configDir,
        hasUI: false,
        isIdle: () => true,
        ui: { notify: () => undefined, confirm: async () => false },
        sessionManager: { getSessionId: () => "concurrent-invocations", getSessionFile: () => undefined },
      };
      registerPiSubagent({
        registerMessageRenderer: () => undefined,
        registerFlag: () => undefined,
        getFlag: (name: string) => name === "subagent-max-active" ? "2" : undefined,
        registerCommand: () => undefined,
        registerTool: (tool: Tool) => { if (tool.name === "subagent") subagentTool = tool; },
        on: (event: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(event, handler),
        events: { emit: () => undefined },
        getAllTools: () => [],
        getCommands: () => [],
      } as never);
      const sessionStart = handlers.get("session_start");
      sessionShutdown = handlers.get("session_shutdown");
      assert.ok(sessionStart);
      assert.ok(sessionShutdown);
      await sessionStart({}, context);
      assert.ok(subagentTool?.execute, "the registered subagent tool must expose execute");
      const scheduler = createdSchedulers.at(-1);
      assert.ok(scheduler, "the entrypoint must use the process-local scheduler");

      const invoke = (id: string, task: string, signal: AbortSignal) => subagentTool!.execute!(
        id,
        { agent: "worker", task },
        signal,
        undefined,
        context,
      );
      const first = invoke("first", "first", new AbortController().signal);
      const second = invoke("second", "second", new AbortController().signal);
      activeInvocations.push(first, second);
      // Observe early failures even while the start/queue gates are pending.
      void Promise.allSettled([first, second]);
      await withinDeadline(Promise.all([firstStarted, secondStarted]), "both active runner callbacks");
      assert.deepEqual([...runnerTasks].sort(), ["first", "second"]);
      assert.equal(scheduler.activeCount, 2);

      const queuedController = new AbortController();
      const queued = invoke("queued", "queued", queuedController.signal);
      activeInvocations.push(queued);
      void Promise.allSettled([queued]);
      await waitForSchedulerState(scheduler, (state) => state.active === 2 && state.queued === 1, "the third invocation to queue");
      queuedController.abort();
      await assert.rejects(
        () => withinDeadline(queued, "the queued invocation to abort"),
        /Subagent error \(cancellation\)\. Foreground subagent invocation was canceled\./,
      );
      assert.deepEqual([...runnerTasks].sort(), ["first", "second"], "the queued invocation never reaches runAgent");

      releaseActiveRuns();
      const activeResults = await withinDeadline(Promise.all([first, second]), "the active invocations to complete");
      for (const result of activeResults) assert.notEqual(result.isError, true);
      await waitForSchedulerState(scheduler, (state) => state.active === 0 && state.queued === 0, "the scheduler to drain");
      assert.deepEqual(
        [...runnerTasks].sort(),
        ["first", "second"],
        "the cancelled invocation must not launch after active capacity is released",
      );
    } finally {
      releaseActiveRuns();
      await Promise.allSettled(activeInvocations);
      try {
        await sessionShutdown?.({}, { hasUI: false, ui: { notify: () => undefined } });
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
