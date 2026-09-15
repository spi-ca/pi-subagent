// @ts-expect-error Bun runtime export is intentionally absent from @types/node.
import { describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const actualLimits = await import("../../src/core/subagent-limits");
const { createPiSubagentDashboardPublisher: createRealDashboardPublisher } = await import("../../src/integration/pi-cmux-contract");
const { createPiSubagentPresenceProducer: createRealPresenceProducer } = await import("../../src/integration/pi-presence-producer");
const createdDashboardPublishers: ReturnType<typeof createRealDashboardPublisher>[] = [];
const createdPresenceProducers: ReturnType<typeof createRealPresenceProducer>[] = [];
const dashboardLifecycleCalls: string[] = [];
const presenceLifecycleCalls: string[] = [];
mock.module("../../src/integration/pi-cmux-contract", () => ({
  createPiSubagentDashboardPublisher: (options: Parameters<typeof createRealDashboardPublisher>[0]) => {
    const publisher = createRealDashboardPublisher(options);
    createdDashboardPublishers.push(publisher);
    return {
      startSession: (sessionId: string, generation: number) => {
        dashboardLifecycleCalls.push(`start:${sessionId}:${generation}`);
        publisher.startSession(sessionId, generation);
      },
      stop: () => {
        dashboardLifecycleCalls.push("stop");
        publisher.stop();
      },
      publish: (snapshot: Parameters<typeof publisher.publish>[0]) => publisher.publish(snapshot),
      publishDetached: (value: Parameters<typeof publisher.publishDetached>[0]) => publisher.publishDetached(value),
    };
  },
}));
mock.module("../../src/integration/pi-presence-producer", () => ({
  createPiSubagentPresenceProducer: (options: Parameters<typeof createRealPresenceProducer>[0]) => {
    const producer = createRealPresenceProducer(options);
    createdPresenceProducers.push(producer);
    return {
      startSession: (sessionId: string, generation: number) => {
        presenceLifecycleCalls.push(`start:${sessionId}:${generation}`);
        return producer.startSession(sessionId, generation);
      },
      stop: () => {
        presenceLifecycleCalls.push("stop");
        producer.stop();
      },
      publish: (snapshot: Parameters<typeof producer.publish>[0]) => producer.publish(snapshot),
      beginAgentRun: () => producer.beginAgentRun(),
      settle: () => producer.settle(),
    };
  },
}));
let holdLimitResolution: Promise<void> | null = null;
let markSlowResolutionEntered: (() => void) | undefined;
const resolvedMaxActiveValues: number[] = [];
mock.module("../../src/core/subagent-limits", () => ({
  ...actualLimits,
  resolveSubagentLimitsForSession: async () => {
    const maxActive = resolvedMaxActiveValues.shift() ?? 16;
    if (holdLimitResolution) {
      markSlowResolutionEntered?.();
      await holdLimitResolution;
    }
    return { ...actualLimits.resolveSubagentLimits(), maxActive };
  },
}));

const { ProcessLocalScheduler: RealProcessLocalScheduler } = await import("../../src/runtime/process-local-scheduler");
const createdSchedulers: CapturingProcessLocalScheduler[] = [];
class CapturingProcessLocalScheduler extends RealProcessLocalScheduler {
  metricsResetCalls = 0;

  constructor(...args: ConstructorParameters<typeof RealProcessLocalScheduler>) {
    super(...args);
    createdSchedulers.push(this);
  }

  override resetMetrics(): void {
    this.metricsResetCalls += 1;
    super.resetMetrics();
  }
}
mock.module("../../src/runtime/process-local-scheduler", () => ({
  ProcessLocalScheduler: CapturingProcessLocalScheduler,
}));

mock.module("@earendil-works/pi-tui", () => ({
  Box: class {},
  Container: class {}, Markdown: class {}, Spacer: class {}, Text: class {},
  visibleWidth: (text: string) => text.length,
  wrapTextWithAnsi: (text: string, width: number) => [text.slice(0, width)],
  truncateToWidth: (text: string, width: number) => text.slice(0, width),
}));
mock.module("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => ".pi",
  getMarkdownTheme: () => ({}),
  keyHint: (_keybinding: string, description: string) => description,
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

const actualRunner = await import("../../src/runtime/runner");
let releaseOldRun: () => void = () => undefined;
let oldRunFinished: Promise<void> = Promise.resolve();
let markOldRunStarted: () => void = () => undefined;
const successfulResult = (options: { agentName: string; task: string }, text = "") => ({
  agent: options.agentName, agentSource: "user" as const, task: options.task, exitCode: 0,
  messages: text ? [{ role: "assistant", content: [{ type: "text", text }] }] : [], stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
}) as Awaited<ReturnType<typeof actualRunner.runAgent>>;
const defaultRunAgentForTest = async (options: Parameters<typeof actualRunner.runAgent>[0]): Promise<Awaited<ReturnType<typeof actualRunner.runAgent>>> => {
  markOldRunStarted();
  await oldRunFinished;
  return successfulResult(options);
};
let runAgentForTest = defaultRunAgentForTest;
mock.module("../../src/runtime/runner", () => ({
  ...actualRunner,
  runAgent: async (options: Parameters<typeof actualRunner.runAgent>[0]) => await runAgentForTest(options),
}));
const { default: registerPiSubagent } = await import("../../index");

type Tool = { name?: string; execute?: (...args: any[]) => Promise<any> };
type SessionContext = {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
  ui: { notify: () => void; confirm: () => Promise<false>; setStatus: (key: string, value: string | undefined) => void };
  sessionManager: { getSessionId: () => string; getSessionFile: () => undefined };
};

function withinDeadline<T>(promise: Promise<T>, description: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), 1_000);
    timer.unref?.();
    void promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

describe("session-start background completion fence", () => {
  test("fences an old completion before slow limit resolution and rejects a superseded overlapping start", async () => {
    const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
    const previousDepth = process.env.PI_SUBAGENT_DEPTH;
    const previousStack = process.env.PI_SUBAGENT_STACK;
    let configDir: string | undefined;
    let sessionShutdown: ((...args: any[]) => Promise<unknown>) | undefined;
    try {
      configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-session-fence-"));
      await fs.mkdir(path.join(configDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(configDir, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\nWork\n");
      process.env.PI_CODING_AGENT_DIR = configDir;
      process.env.PI_SUBAGENT_DEPTH = "0";
      process.env.PI_SUBAGENT_STACK = "[]";

      const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
      let subagentTool: Tool | undefined;
      const messages: unknown[] = [];
      const observerEvents: Array<{ channel: string; payload: unknown }> = [];
      registerPiSubagent({
        registerMessageRenderer: () => undefined,
        registerFlag: () => undefined,
        getFlag: (name: string) => name === "subagent-max-active" ? "1" : undefined,
        registerCommand: () => undefined,
        registerTool: (tool: Tool) => { if (tool.name === "subagent") subagentTool = tool; },
        on: (event: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(event, handler),
        events: { emit: (channel: string, payload: unknown) => { observerEvents.push({ channel, payload }); } },
        sendMessage: (message: unknown) => { messages.push(message); },
        getAllTools: () => [],
        getCommands: () => [],
      } as never);
      const sessionStart = handlers.get("session_start");
      sessionShutdown = handlers.get("session_shutdown");
      assert.ok(sessionStart);
      assert.ok(sessionShutdown);
      assert.ok(subagentTool?.execute);
      const session = (id: string, options: { hasUI?: boolean; throwOnStatusClear?: boolean } = {}): SessionContext => ({
        cwd: configDir!, hasUI: options.hasUI ?? false, isIdle: () => true,
        ui: {
          notify: () => undefined,
          confirm: async () => false,
          setStatus: (_key, value) => {
            if (options.throwOnStatusClear && value === undefined) throw new Error("disposed TUI");
          },
        },
        sessionManager: { getSessionId: () => id, getSessionFile: () => undefined },
      });

      resolvedMaxActiveValues.push(1);
      await sessionStart({}, session("old"));
      assert.equal(createdSchedulers.at(-1)?.metricsResetCalls, 1, "the host startup establishes one metrics epoch despite provisional/resolved scheduler generations");
      let finishOldRun!: () => void;
      oldRunFinished = new Promise<void>((resolve) => { finishOldRun = resolve; });
      releaseOldRun = finishOldRun;
      const oldRunStarted = new Promise<void>((resolve) => { markOldRunStarted = resolve; });
      await subagentTool.execute!("old-background", { agent: "worker", task: "old", background: true }, new AbortController().signal, undefined, session("old"));
      await oldRunStarted;

      let releaseSlowLimits!: () => void;
      resolvedMaxActiveValues.push(2);
      holdLimitResolution = new Promise<void>((resolve) => { releaseSlowLimits = resolve; });
      const slowResolutionEntered = new Promise<void>((resolve) => { markSlowResolutionEntered = resolve; });
      const replaced = sessionStart({}, session("replacement", { hasUI: true, throwOnStatusClear: true }));
      await slowResolutionEntered;
      assert.equal(createdSchedulers.at(-1)?.metricsResetCalls, 2, "the reset occurs synchronously before slow configuration resolution");

      // session_start has reached its first await, so its synchronous preamble
      // must already have withdrawn/fenced all old observer state. The direct
      // calls model deferred interactive and presence callbacks while limit
      // resolution is still blocked.
      const dashboard = createdDashboardPublishers.at(-1);
      const presence = createdPresenceProducers.at(-1);
      assert.ok(dashboard);
      assert.ok(presence);
      const observerEventCount = observerEvents.length;
      assert.equal(dashboard.publishDetached({ runId: "old-run", agent: "worker", backend: "tmux-pane", detachedAt: 1 }), false);
      assert.equal(presence.publish({ generation: 1, active: [], recent: [] }), false);
      assert.equal(observerEvents.length, observerEventCount, "stopped observers must not emit under the previous session");
      assert.ok(dashboardLifecycleCalls.includes("stop"), "replacement start stops the previous dashboard synchronously");
      assert.ok(presenceLifecycleCalls.includes("stop"), "replacement start stops the previous presence source synchronously");

      // The background finalizer is separately fenced before startup yields.
      releaseOldRun();
      await oldRunFinished;
      await Promise.resolve();
      await Promise.resolve();
      assert.deepEqual(messages, [], "an old background finalizer must not steer the replacement session");

      // A later start wins while the previous config resolution remains slow.
      holdLimitResolution = null;
      resolvedMaxActiveValues.push(3);
      const latest = sessionStart({}, session("latest"));
      releaseSlowLimits();
      await Promise.all([replaced, latest]);
      assert.equal(createdSchedulers.at(-1)?.metricsResetCalls, 3, "each host session_start resets metrics exactly once, including racing starts");
      assert.equal(createdSchedulers.at(-1)?.maxActive, 3, "the slower superseded startup must not replace the latest session limits");
      assert.deepEqual(dashboardLifecycleCalls.filter((call) => call.startsWith("start:")), ["start:old:1", "start:latest:3"], "only the winning startup initializes a dashboard generation");
      assert.deepEqual(presenceLifecycleCalls.filter((call) => call.startsWith("start:")), ["start:old:1", "start:latest:3"], "only the winning startup initializes a presence generation");
      assert.deepEqual(messages, [], "a superseded startup must not revive the fenced completion");
    } finally {
      holdLimitResolution = null;
      markSlowResolutionEntered = undefined;
      resolvedMaxActiveValues.length = 0;
      releaseOldRun();
      if (sessionShutdown && configDir) await sessionShutdown({}, {
        cwd: configDir, hasUI: false, isIdle: () => true,
        ui: { notify: () => undefined, confirm: async () => false, setStatus: () => undefined },
        sessionManager: { getSessionId: () => "cleanup", getSessionFile: () => undefined },
      });
      dashboardLifecycleCalls.length = 0;
      presenceLifecycleCalls.length = 0;
      while (createdDashboardPublishers.length > 0) createdDashboardPublishers.pop()!.stop();
      while (createdPresenceProducers.length > 0) createdPresenceProducers.pop()!.stop();
      if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
      if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = previousDepth;
      if (previousStack === undefined) delete process.env.PI_SUBAGENT_STACK;
      else process.env.PI_SUBAGENT_STACK = previousStack;
      if (configDir) await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  test("keeps a finalized result and status when its one steer delivery throws without logging the thrown secret", async () => {
    const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
    const previousDepth = process.env.PI_SUBAGENT_DEPTH;
    const previousStack = process.env.PI_SUBAGENT_STACK;
    let configDir: string | undefined;
    let sessionShutdown: ((...args: any[]) => Promise<unknown>) | undefined;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    let resolveDelivery!: () => void;
    const deliveryAttempted = new Promise<void>((resolve) => { resolveDelivery = resolve; });
    const secret = "send-message-secret";
    let runnerAttempts = 0;
    let deliveryAttempts = 0;

    try {
      configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-background-delivery-"));
      await fs.mkdir(path.join(configDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(configDir, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\nWork\n");
      process.env.PI_CODING_AGENT_DIR = configDir;
      process.env.PI_SUBAGENT_DEPTH = "0";
      process.env.PI_SUBAGENT_STACK = "[]";
      runAgentForTest = async (options) => {
        runnerAttempts += 1;
        return successfulResult(options, "verified background result");
      };
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

      const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
      let subagentTool: Tool | undefined;
      const context: SessionContext = {
        cwd: configDir,
        hasUI: false,
        isIdle: () => true,
        ui: { notify: () => undefined, confirm: async () => false, setStatus: () => undefined },
        sessionManager: { getSessionId: () => "delivery", getSessionFile: () => undefined },
      };
      registerPiSubagent({
        registerMessageRenderer: () => undefined,
        registerFlag: () => undefined,
        getFlag: () => undefined,
        registerCommand: () => undefined,
        registerTool: (tool: Tool) => { if (tool.name === "subagent") subagentTool = tool; },
        on: (event: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(event, handler),
        events: { emit: () => undefined },
        sendMessage: () => {
          deliveryAttempts += 1;
          resolveDelivery();
          throw new Error(`${secret}:${"x".repeat(64 * 1024)}`);
        },
        getAllTools: () => [],
        getCommands: () => [],
      } as never);
      const sessionStart = handlers.get("session_start");
      sessionShutdown = handlers.get("session_shutdown");
      assert.ok(sessionStart);
      assert.ok(sessionShutdown);
      await sessionStart({}, context);
      assert.ok(subagentTool?.execute);

      const started = await subagentTool.execute!("delivery-job", { agent: "worker", task: "deliver", background: true }, new AbortController().signal, undefined, context);
      const jobId = started.details?.jobId;
      assert.equal(typeof jobId, "string");
      await withinDeadline(deliveryAttempted, "the single background steer attempt");
      assert.equal(runnerAttempts, 1);

      const status = await subagentTool.execute!("delivery-status", { action: "status", id: jobId }, new AbortController().signal, undefined, context);
      assert.match(status.content[0]?.text ?? "", /status: completed/);
      assert.match(status.content[0]?.text ?? "", /verified background result/);
      assert.equal(deliveryAttempts, 1, "a failed notification must not be retried");
      assert.deepEqual(warnings, [`[pi-subagent] Failed to deliver background result for job ${jobId}.`]);
      assert.ok(warnings[0]!.length < 256, "delivery warning must remain bounded");
      assert.equal(warnings[0]!.includes(secret), false, "delivery warning must not expose the thrown secret");
    } finally {
      console.warn = originalWarn;
      runAgentForTest = defaultRunAgentForTest;
      if (sessionShutdown && configDir) await sessionShutdown({}, {
        cwd: configDir, hasUI: false, isIdle: () => true,
        ui: { notify: () => undefined, confirm: async () => false, setStatus: () => undefined },
        sessionManager: { getSessionId: () => "cleanup", getSessionFile: () => undefined },
      });
      if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
      if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = previousDepth;
      if (previousStack === undefined) delete process.env.PI_SUBAGENT_STACK;
      else process.env.PI_SUBAGENT_STACK = previousStack;
      if (configDir) await fs.rm(configDir, { recursive: true, force: true });
    }
  });

  test("requires exact-ID cancellation to settle before the released slot starts a fresh job", async () => {
    const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
    const previousDepth = process.env.PI_SUBAGENT_DEPTH;
    const previousStack = process.env.PI_SUBAGENT_STACK;
    const previousMaxBackgroundJobs = process.env.PI_SUBAGENT_MAX_BACKGROUND_JOBS;
    let configDir: string | undefined;
    let sessionShutdown: ((...args: any[]) => Promise<unknown>) | undefined;
    let resolveCancelledRunStarted!: () => void;
    let resolveCancelledDelivery!: () => void;
    let resolveFreshRunStarted!: () => void;
    const cancelledRunStarted = new Promise<void>((resolve) => { resolveCancelledRunStarted = resolve; });
    const cancelledDelivery = new Promise<void>((resolve) => { resolveCancelledDelivery = resolve; });
    const freshRunStarted = new Promise<void>((resolve) => { resolveFreshRunStarted = resolve; });
    const runnerTasks: string[] = [];

    try {
      configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-background-cancel-"));
      await fs.mkdir(path.join(configDir, "agents"), { recursive: true });
      await fs.writeFile(path.join(configDir, "agents", "worker.md"), "---\nname: worker\ndescription: Worker\n---\nWork\n");
      process.env.PI_CODING_AGENT_DIR = configDir;
      process.env.PI_SUBAGENT_DEPTH = "0";
      process.env.PI_SUBAGENT_STACK = "[]";
      process.env.PI_SUBAGENT_MAX_BACKGROUND_JOBS = "1";
      runAgentForTest = async (options) => {
        runnerTasks.push(options.task);
        if (options.task === "cancel-me") {
          resolveCancelledRunStarted();
          await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
          return { ...successfulResult(options), exitCode: 1, stderr: "cancelled" };
        }
        assert.equal(options.task, "fresh");
        resolveFreshRunStarted();
        return successfulResult(options, "fresh result");
      };

      const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
      let subagentTool: Tool | undefined;
      const context: SessionContext = {
        cwd: configDir,
        hasUI: false,
        isIdle: () => true,
        ui: { notify: () => undefined, confirm: async () => false, setStatus: () => undefined },
        sessionManager: { getSessionId: () => "cancel", getSessionFile: () => undefined },
      };
      registerPiSubagent({
        registerMessageRenderer: () => undefined,
        registerFlag: () => undefined,
        getFlag: () => undefined,
        registerCommand: () => undefined,
        registerTool: (tool: Tool) => { if (tool.name === "subagent") subagentTool = tool; },
        on: (event: string, handler: (...args: any[]) => Promise<unknown>) => handlers.set(event, handler),
        events: { emit: () => undefined },
        sendMessage: (message: { details?: { status?: string } }) => {
          if (message.details?.status === "cancelled") resolveCancelledDelivery();
        },
        getAllTools: () => [],
        getCommands: () => [],
      } as never);
      const sessionStart = handlers.get("session_start");
      sessionShutdown = handlers.get("session_shutdown");
      assert.ok(sessionStart);
      assert.ok(sessionShutdown);
      await sessionStart({}, context);
      assert.ok(subagentTool?.execute);

      const started = await subagentTool.execute!("cancel-job", { agent: "worker", task: "cancel-me", background: true }, new AbortController().signal, undefined, context);
      const jobId = started.details?.jobId;
      assert.equal(typeof jobId, "string");
      await withinDeadline(cancelledRunStarted, "the cancellable runner to start");
      const cancellation = await subagentTool.execute!("cancel-exact", { action: "cancel", id: jobId }, new AbortController().signal, undefined, context);
      assert.match(cancellation.content[0]?.text ?? "", new RegExp(`Requested cancellation for background subagent job ${jobId}\\.`));

      await assert.rejects(
        () => subagentTool!.execute!("fresh-too-early", { agent: "worker", task: "fresh", background: true }, new AbortController().signal, undefined, context),
        /1 background job\(s\) are already running or cancelling/,
      );
      await withinDeadline(cancelledDelivery, "the cancelled job to settle");
      const terminal = await subagentTool.execute!("cancel-status", { action: "status", id: jobId }, new AbortController().signal, undefined, context);
      assert.match(terminal.content[0]?.text ?? "", /status: cancelled/);

      const fresh = await subagentTool.execute!("fresh-after-settlement", { agent: "worker", task: "fresh", background: true }, new AbortController().signal, undefined, context);
      assert.equal(fresh.isError, undefined);
      await withinDeadline(freshRunStarted, "the fresh runner to start");
      assert.deepEqual(runnerTasks, ["cancel-me", "fresh"]);
    } finally {
      runAgentForTest = defaultRunAgentForTest;
      if (sessionShutdown && configDir) await sessionShutdown({}, {
        cwd: configDir, hasUI: false, isIdle: () => true,
        ui: { notify: () => undefined, confirm: async () => false, setStatus: () => undefined },
        sessionManager: { getSessionId: () => "cleanup", getSessionFile: () => undefined },
      });
      if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
      if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = previousDepth;
      if (previousStack === undefined) delete process.env.PI_SUBAGENT_STACK;
      else process.env.PI_SUBAGENT_STACK = previousStack;
      if (previousMaxBackgroundJobs === undefined) delete process.env.PI_SUBAGENT_MAX_BACKGROUND_JOBS;
      else process.env.PI_SUBAGENT_MAX_BACKGROUND_JOBS = previousMaxBackgroundJobs;
      if (configDir) await fs.rm(configDir, { recursive: true, force: true });
    }
  });
});
