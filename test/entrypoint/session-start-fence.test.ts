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
const createdSchedulers: InstanceType<typeof RealProcessLocalScheduler>[] = [];
class CapturingProcessLocalScheduler extends RealProcessLocalScheduler {
  constructor(...args: ConstructorParameters<typeof RealProcessLocalScheduler>) {
    super(...args);
    createdSchedulers.push(this);
  }
}
mock.module("../../src/runtime/process-local-scheduler", () => ({
  ProcessLocalScheduler: CapturingProcessLocalScheduler,
}));

mock.module("@earendil-works/pi-tui", () => ({
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

const actualRunner = await import("../../src/runtime/runner");
let releaseOldRun: () => void = () => undefined;
let oldRunFinished: Promise<void> = Promise.resolve();
let markOldRunStarted: () => void = () => undefined;
mock.module("../../src/runtime/runner", () => ({
  ...actualRunner,
  runAgent: async (options: Parameters<typeof actualRunner.runAgent>[0]) => {
    markOldRunStarted();
    await oldRunFinished;
    return {
      agent: options.agentName, agentSource: "user" as const, task: options.task, exitCode: 0, messages: [], stderr: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    };
  },
}));
const { default: registerPiSubagent } = await import("../../index");

type Tool = { name?: string; execute?: (...args: any[]) => Promise<unknown> };
type SessionContext = {
  cwd: string;
  hasUI: boolean;
  isIdle: () => boolean;
  ui: { notify: () => void; confirm: () => Promise<false>; setStatus: (key: string, value: string | undefined) => void };
  sessionManager: { getSessionId: () => string; getSessionFile: () => undefined };
};

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
});
