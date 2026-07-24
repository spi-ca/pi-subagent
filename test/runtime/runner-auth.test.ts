import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildChildProcessEnv,
  buildPrivateChildEnvironmentScript,
  buildPiArgs,
  PHASE0_LIVE_GATE_ENV,
  PHASE0_LIVE_PROOF_BARRIER_PATH_ENV,
  PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV,
  PHASE0_LIVE_PROOF_BEHAVIOR_ENV,
  PHASE0_LIVE_PROOF_CAPABILITY_ENV,
  PHASE0_LIVE_PROOF_ID_ENV,
  PHASE0_LIVE_PROOF_MASTER_ENV,
  PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV,
  PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV,
  PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV,
  PHASE0_LIVE_PROOF_SOCKET_ENV,
  applyChildProjectIsolation,
  getInheritedCliArgsForAgent,
  prepareInheritedApiKeyAgentDir,
  resolveInheritedCliApiKeyForChild,
  runAgent,
} from "../../src/runtime/runner";
import { SUBAGENT_LIMIT_DEFINITIONS, type SubagentLimits } from "../../src/core/subagent-limits";
import {
  SUBAGENT_COMPLETION_MODE_ENV,
  SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV,
  V3_FAILURE_BOUNDARY_CAPABILITY,
  SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV,
  V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY,
  SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV,
  SUBAGENT_COMPLETION_FENCE_NONCE_ENV,
  SUBAGENT_COMPLETION_FENCE_PATH_ENV,
  SUBAGENT_LEASE_CHECK_MS_ENV,
  SUBAGENT_PROMOTION_ACK_PATH_ENV,
  SUBAGENT_PROMOTION_REQUEST_PATH_ENV,
} from "../../src/runtime/run-protocol";
import {
  TREE_PERMIT_LEASE_ID_ENV,
  TREE_PERMIT_LEASE_TOKEN_ENV,
  TREE_PERMIT_MAX_ACTIVE_ENV,
  TREE_PERMIT_ROOT_ENV,
  TREE_PERMIT_ROOT_ID_ENV,
  TREE_PERMIT_TOKEN_ENV,
} from "../../src/runtime/tree-permit-authority";

const tempDirs: string[] = [];
const phase0ProofEnvNames = [
  PHASE0_LIVE_GATE_ENV,
  PHASE0_LIVE_PROOF_SOCKET_ENV,
  PHASE0_LIVE_PROOF_MASTER_ENV,
  PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV,
  PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV,
  PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV,
  PHASE0_LIVE_PROOF_ID_ENV,
  PHASE0_LIVE_PROOF_CAPABILITY_ENV,
  PHASE0_LIVE_PROOF_BARRIER_PATH_ENV,
  PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV,
  PHASE0_LIVE_PROOF_BEHAVIOR_ENV,
] as const;

function futurePhase0Deadline(): string { return String(Date.now() + 60_000); }

function importRunnerWithPhase0Env(overrides: Record<string, string>) {
  const env = { ...process.env };
  for (const name of phase0ProofEnvNames) delete env[name];
  Object.assign(env, overrides);
  const runnerUrl = new URL("../../src/runtime/runner.ts", import.meta.url).href;
  return spawnSync(process.execPath, ["-e", `await import(${JSON.stringify(runnerUrl)}); process.stdout.write(JSON.stringify(process.env));`], {
    cwd: process.cwd(), env, encoding: "utf8",
  });
}

function importedRunnerEnv(result: ReturnType<typeof importRunnerWithPhase0Env>): NodeJS.ProcessEnv {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("subagent auth propagation", () => {
  test("propagates the exact resolved pane layout to nested inline and interactive children", () => {
    const common = {
      agentName: "worker",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      baseEnv: {},
    };
    assert.equal(buildChildProcessEnv({ ...common, interactivePaneLayout: "auto" }).PI_SUBAGENT_PANE_LAYOUT, "auto");
    assert.equal(buildChildProcessEnv({ ...common, interactivePaneLayout: "split" }).PI_SUBAGENT_PANE_LAYOUT, "split");
    assert.equal(buildChildProcessEnv({ ...common }).PI_SUBAGENT_MAX_ACTIVE, "16");
    assert.equal(buildChildProcessEnv({ ...common, maxActive: 7 }).PI_SUBAGENT_MAX_ACTIVE, "7");
    const limited = buildChildProcessEnv({ ...common, limits: {
      maxActive: 11, maxParallelTasks: 2, maxChainSteps: 3, maxConcurrency: 4, maxChainParallelTasks: 5,
      maxBackgroundJobs: 6, backgroundHistoryLimit: 7, backgroundHistoryTtlMs: 8,
      backgroundOutputMaxBytes: 0, backgroundShutdownSettleMs: 9, parallelHeartbeatMs: 10,
    } });
    assert.equal(limited.PI_SUBAGENT_MAX_ACTIVE, "11");
    assert.equal(limited.PI_SUBAGENT_MAX_PARALLEL_TASKS, "2");
    assert.equal(limited.PI_SUBAGENT_BACKGROUND_OUTPUT_MAX_BYTES, "0");
    assert.equal(limited.PI_SUBAGENT_PARALLEL_HEARTBEAT_MS, "10");
    const lifecycle = buildChildProcessEnv({ ...common, baseEnv: { [SUBAGENT_LEASE_CHECK_MS_ENV]: "37" }, runProtocolEnv: { [SUBAGENT_LEASE_CHECK_MS_ENV]: "37" } });
    assert.equal(lifecycle[SUBAGENT_LEASE_CHECK_MS_ENV], "37");
  });

  test("replaces stale completion mode with the exact private child value", () => {
    const common = {
      agentName: "worker", parentDepth: 0, parentAgentStack: [], maxDepth: 3,
      preventCycles: true, baseEnv: { [SUBAGENT_COMPLETION_MODE_ENV]: "handoff" },
    };
    const oneShot = buildChildProcessEnv(common);
    assert.equal(oneShot[SUBAGENT_COMPLETION_MODE_ENV], "one-shot");
    assert.match(buildPrivateChildEnvironmentScript(oneShot), /^export PI_SUBAGENT_COMPLETION_MODE='one-shot'$/m);
    const handoff = buildChildProcessEnv({ ...common, completionMode: "handoff" });
    assert.equal(handoff[SUBAGENT_COMPLETION_MODE_ENV], "handoff");
    assert.match(buildPrivateChildEnvironmentScript(handoff), /^export PI_SUBAGENT_COMPLETION_MODE='handoff'$/m);
  });

  test("does not inherit ancestor promotion paths but allows the current run's explicit paths", () => {
    const names = [SUBAGENT_PROMOTION_REQUEST_PATH_ENV, SUBAGENT_PROMOTION_ACK_PATH_ENV];
    const common = {
      agentName: "nested", parentDepth: 1, parentAgentStack: ["parent"], maxDepth: 3, preventCycles: true,
      baseEnv: Object.fromEntries(names.map((name) => [name, `/stale-ancestor/${name}`])),
    };
    const omitted = buildChildProcessEnv(common);
    for (const name of names) assert.equal(omitted[name], undefined);

    const current = Object.fromEntries(names.map((name) => [name, `/current-run/${name}`]));
    const child = buildChildProcessEnv({ ...common, runProtocolEnv: current });
    for (const name of names) assert.equal(child[name], current[name]);
  });

  test("does not inherit an ancestor completion-fence capability into a nested child", () => {
    const names = [SUBAGENT_COMPLETION_FENCE_PATH_ENV, SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV, SUBAGENT_COMPLETION_FENCE_NONCE_ENV];
    const nested = buildChildProcessEnv({
      agentName: "nested", parentDepth: 1, parentAgentStack: ["parent"], maxDepth: 3, preventCycles: true,
      baseEnv: Object.fromEntries(names.map((name, index) => [name, index === 2 ? "a".repeat(64) : `/ancestor/${name}`])),
    });
    for (const name of names) assert.equal(nested[name], undefined);
  });

  test("strips inherited V3 boundary negotiation and passes only exact current capabilities", () => {
    const capabilityNames = [SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV, SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV];
    const common = {
      agentName: "nested", parentDepth: 1, parentAgentStack: ["parent"], maxDepth: 3, preventCycles: true,
      baseEnv: Object.fromEntries(capabilityNames.map((name) => [name, "stale-or-forged"])),
    };
    const unnegotiated = buildChildProcessEnv(common);
    for (const name of capabilityNames) assert.equal(unnegotiated[name], undefined);
    const negotiated = buildChildProcessEnv({
      ...common,
      runProtocolEnv: {
        [SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV]: V3_FAILURE_BOUNDARY_CAPABILITY,
        [SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV]: V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY,
      },
    });
    assert.equal(negotiated[SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV], V3_FAILURE_BOUNDARY_CAPABILITY);
    assert.equal(negotiated[SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV], V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY);
    for (const [name, value] of [[SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV, V3_FAILURE_BOUNDARY_CAPABILITY], [SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV, V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY]] as const) {
      assert.match(buildPrivateChildEnvironmentScript(negotiated), new RegExp(`^export ${name}='${value}'$`, "m"));
    }
  });

  test("replaces inherited tree authority material with only the exact reserved child lease", () => {
    const names = [TREE_PERMIT_ROOT_ENV, TREE_PERMIT_ROOT_ID_ENV, TREE_PERMIT_TOKEN_ENV, TREE_PERMIT_MAX_ACTIVE_ENV, TREE_PERMIT_LEASE_ID_ENV, TREE_PERMIT_LEASE_TOKEN_ENV];
    const stale = Object.fromEntries(names.map((name) => [name, "stale-parent-value"]));
    const common = { agentName: "worker", parentDepth: 0, parentAgentStack: [], maxDepth: 3, preventCycles: true, baseEnv: stale };
    const omitted = buildChildProcessEnv(common);
    for (const name of names) assert.equal(omitted[name], undefined);
    const exact = Object.fromEntries(names.map((name, index) => [name, `exact-${index}`]));
    const child = buildChildProcessEnv({ ...common, treePermitEnv: exact });
    const privateScript = buildPrivateChildEnvironmentScript(child);
    for (const name of names) {
      assert.equal(child[name], exact[name]);
      assert.match(privateScript, new RegExp(`^export ${name}='exact-[0-9]+'$`, "m"));
    }
  });

  test("injects an inherit-only cmux child profile without mutating the parent environment", () => {
    const parentEnv = {
      PI_CMUX_PROFILE: "parent-profile",
      PI_CMUX_NOTIFY_LEVEL: "loud",
      PI_CMUX_UNRELATED: "must-not-cross-private-boundary",
      PI_SUBAGENT_MANAGED_TITLE: "parent-title",
    };
    const before = { ...parentEnv };
    const inherited = buildChildProcessEnv({
      agentName: `worker\x1b-${"x".repeat(128)}`,
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      baseEnv: parentEnv,
      runProtocolEnv: { PI_SUBAGENT_RUN_ID: "run-prefix-123" },
    });
    const profile = {
      PI_CMUX_PROFILE: "subagent-child-v1",
      PI_CMUX_NOTIFY_LEVEL: "disabled",
      PI_CMUX_SIDEBAR_FLASH: "disabled",
      PI_CMUX_SIDEBAR_SOURCE: "pi-subagent-child",
      PI_CMUX_REGISTER_COMMANDS: "0",
      PI_CMUX_REGISTER_TOOLS: "0",
      PI_CMUX_SUBAGENT_DASHBOARD: "0",
    };
    assert.deepEqual(parentEnv, before);
    for (const [key, value] of Object.entries(profile)) assert.equal(inherited[key], value);
    assert.match(inherited.PI_SUBAGENT_MANAGED_TITLE!, /^subagent:[\x20-\x7e]+$/);
    assert.ok(inherited.PI_SUBAGENT_MANAGED_TITLE!.length <= 96);
    assert.equal(inherited.PI_SUBAGENT_MANAGED_TITLE!.includes("\x1b"), false);
    assert.equal(inherited.PI_CMUX_UNRELATED, undefined);

    const privateEnvironment = buildPrivateChildEnvironmentScript(inherited);
    for (const [key, value] of Object.entries(profile)) assert.match(privateEnvironment, new RegExp(`^export ${key}='${value}'$`, "m"));
    assert.match(privateEnvironment, /^export PI_SUBAGENT_MANAGED_TITLE='subagent:/m);
    assert.equal(privateEnvironment.includes("PI_CMUX_UNRELATED="), false);

    const managed = buildChildProcessEnv({
      agentName: "worker",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      baseEnv: { PI_SUBAGENT_CMUX_CHILD_POLICY: "managed", PI_CMUX_UNRELATED: "ignored", PI_CMUX_NOTIFY_LEVEL: "all" },
    });
    for (const key of Object.keys(profile)) assert.equal(managed[key], undefined);
    assert.equal(managed.PI_CMUX_UNRELATED, undefined);
  });

  test("removes runtime loader injection variables only from managed children", () => {
    const common = {
      agentName: "worker", parentDepth: 0, parentAgentStack: [], maxDepth: 3,
      preventCycles: true,
      baseEnv: { NODE_OPTIONS: "--require=/tmp/inject.js", BUN_OPTIONS: "--preload=/tmp/inject.ts", LD_PRELOAD: "/tmp/inject.so", BASH_ENV: "/tmp/inject.sh", SHELLOPTS: "xtrace", PS4: "$(inject)", "BASH_FUNC_kill%%": "() { inject; }" },
    };
    const inherited = buildChildProcessEnv(common);
    assert.equal(inherited.NODE_OPTIONS, "--require=/tmp/inject.js");
    const managed = buildChildProcessEnv({ ...common, baseEnv: { ...common.baseEnv, PI_SUBAGENT_CMUX_CHILD_POLICY: "managed" } });
    for (const name of ["NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD", "BASH_ENV", "SHELLOPTS", "PS4", "BASH_FUNC_kill%%"]) assert.equal(managed[name], undefined);
  });

  test("keeps every custom limit through the private interactive-child environment filter", () => {
    const limits = Object.fromEntries(
      Object.keys(SUBAGENT_LIMIT_DEFINITIONS).map((name, index) => [name, index + 101]),
    ) as unknown as SubagentLimits;
    const env = buildChildProcessEnv({
      agentName: "worker",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      limits,
      preventCycles: true,
      baseEnv: { PI_SUBAGENT_CMUX_CHILD_POLICY: "managed" },
    });
    assert.equal(env.PI_SUBAGENT_CMUX_CHILD_POLICY, "managed");
    const privateEnvironment = buildPrivateChildEnvironmentScript(env);
    assert.match(privateEnvironment, /^export PI_SUBAGENT_CMUX_CHILD_POLICY='managed'$/m);

    for (const [name, definition] of Object.entries(SUBAGENT_LIMIT_DEFINITIONS)) {
      assert.equal(env[definition.env], String(limits[name as keyof SubagentLimits]));
      assert.match(privateEnvironment, new RegExp(`^export ${definition.env}='${limits[name as keyof SubagentLimits]}'$`, "m"));
    }
  });

  test("uses an inherited API-key agent-dir overlay instead of argv/env key injection", async () => {
    const sourceAgentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-source-"));
    tempDirs.push(sourceAgentDir);
    await fs.promises.writeFile(path.join(sourceAgentDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "stored-key" } }));
    await fs.promises.mkdir(path.join(sourceAgentDir, "agents"));

    const overlayDir = await prepareInheritedApiKeyAgentDir({
      name: "OPENROUTER_API_KEY",
      value: "super-secret",
      provider: "openrouter",
    }, { baseEnv: { PI_CODING_AGENT_DIR: sourceAgentDir } });
    assert.ok(overlayDir);
    tempDirs.push(overlayDir);

    const env = buildChildProcessEnv({
      agentName: "worker",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      inheritedApiKeyBinding: {
        name: "OPENROUTER_API_KEY",
        value: "super-secret",
        provider: "openrouter",
      },
      inheritedApiKeyAgentDir: overlayDir,
      baseEnv: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: sourceAgentDir },
    });

    const auth = JSON.parse(await fs.promises.readFile(path.join(overlayDir, "auth.json"), "utf-8"));
    assert.equal(auth.openrouter.key, "$PI_SUBAGENT_INHERITED_API_KEY");
    assert.equal((await fs.promises.readFile(path.join(overlayDir, "auth.json"), "utf-8")).includes("super-secret"), false);
    assert.equal((await fs.promises.lstat(path.join(overlayDir, "auth.json"))).mode & 0o777, 0o600);
    assert.equal((await fs.promises.lstat(overlayDir)).mode & 0o777, 0o700);
    assert.deepEqual(Object.keys(auth), ["openrouter"]);
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.PI_SUBAGENT_INHERITED_API_KEY, "super-secret");
    assert.equal(env.PI_CODING_AGENT_DIR, overlayDir);
    assert.equal(env.PI_SUBAGENT_DEPTH, "1");
    assert.equal(env.PI_SUBAGENT_STACK, JSON.stringify(["worker"]));
    assert.equal(env.PATH, "/usr/bin");
  });

  test("snapshots only data resources for managed API-key overlays", async () => {
    const sourceAgentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-managed-agent-source-"));
    tempDirs.push(sourceAgentDir);
    await fs.promises.mkdir(path.join(sourceAgentDir, "agents"));
    await fs.promises.writeFile(path.join(sourceAgentDir, "agents", "worker.md"), "worker-v1");
    await fs.promises.mkdir(path.join(sourceAgentDir, "extensions"));
    await fs.promises.writeFile(path.join(sourceAgentDir, "extensions", "unsafe.ts"), "unsafe");
    await fs.promises.writeFile(path.join(sourceAgentDir, "settings.json"), "{}\n");

    const overlayDir = await prepareInheritedApiKeyAgentDir({
      name: "OPENROUTER_API_KEY", value: "super-secret", provider: "openrouter",
    }, { baseEnv: { PI_CODING_AGENT_DIR: sourceAgentDir, PI_SUBAGENT_CMUX_CHILD_POLICY: "managed" } });
    assert.ok(overlayDir);
    tempDirs.push(overlayDir);
    const agentSnapshot = path.join(overlayDir, "agents", "worker.md");
    assert.equal((await fs.promises.lstat(agentSnapshot)).isSymbolicLink(), false);
    assert.equal(await fs.promises.readFile(agentSnapshot, "utf8"), "worker-v1");
    await fs.promises.writeFile(path.join(sourceAgentDir, "agents", "worker.md"), "worker-v2");
    assert.equal(await fs.promises.readFile(agentSnapshot, "utf8"), "worker-v1");
    assert.equal(fs.existsSync(path.join(overlayDir, "extensions")), false);
    assert.equal(await fs.promises.readFile(path.join(overlayDir, "settings.json"), "utf8"), "{}\n");
  });

  test("cleans an inherited API-key overlay if async auth writing fails", async () => {
    let overlayDir: string | null = null;

    await assert.rejects(async () => await prepareInheritedApiKeyAgentDir({
      name: "OPENROUTER_API_KEY",
      value: "super-secret",
      provider: "openrouter",
    }, {
      baseEnv: { PI_CODING_AGENT_DIR: "/missing-agent-dir" },
      mkdtemp: async (prefix) => {
        overlayDir = await fs.promises.mkdtemp(prefix);
        return overlayDir;
      },
      writeFile: async () => {
        throw new Error("disk full");
      },
    }), /disk full/);

    assert.ok(overlayDir);
    assert.equal(fs.existsSync(overlayDir), false);
  });

  test("rejects inherited agent entries whose symlink target escapes the source directory", async () => {
    const sourceAgentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-source-"));
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-outside-"));
    tempDirs.push(sourceAgentDir, outside);
    await fs.promises.writeFile(path.join(outside, "foreign.json"), "{}", { mode: 0o600 });
    await fs.promises.symlink(path.join(outside, "foreign.json"), path.join(sourceAgentDir, "foreign.json"));
    await assert.rejects(
      prepareInheritedApiKeyAgentDir({ name: "OPENROUTER_API_KEY", value: "super-secret", provider: "openrouter" }, {
        baseEnv: { PI_CODING_AGENT_DIR: sourceAgentDir },
      }),
      /escapes its source directory/,
    );
  });

  test("restores the original agent dir for nested children without a new CLI key overlay", () => {
    const env = buildChildProcessEnv({
      agentName: "nested",
      parentDepth: 1,
      parentAgentStack: ["worker"],
      maxDepth: 3,
      preventCycles: true,
      inheritedApiKeyBinding: null,
      baseEnv: {
        PI_CODING_AGENT_DIR: "/tmp/pi-subagent-agent-overlay",
        PI_SUBAGENT_ORIGINAL_AGENT_DIR: "/home/user/.pi/agent",
        PI_SUBAGENT_INHERITED_API_KEY: "super-secret",
        PATH: "/usr/bin",
      },
    });

    assert.equal(env.PI_CODING_AGENT_DIR, "/home/user/.pi/agent");
    assert.equal(env.PI_SUBAGENT_ORIGINAL_AGENT_DIR, undefined);
    assert.equal(env.PI_SUBAGENT_INHERITED_API_KEY, undefined);
    assert.equal(env.PI_SUBAGENT_DEPTH, "2");
  });

  test("drops an ambiguous inherited CLI --api-key but keeps delegation available", () => {
    const outcome = resolveInheritedCliApiKeyForChild({
      apiKey: "super-secret",
      fallbackModel: "claude-3-5-sonnet",
    });

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /child will not inherit the CLI key/i);
    assert.match(outcome.warningMessage ?? "", /--provider/);
    assert.match(outcome.warningMessage ?? "", /--model/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("uses a user agent model as a provider hint when parent hints are absent", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        fallbackModel: "claude-3-5-sonnet",
      },
      {
        source: "user",
        model: "anthropic/claude-3-5-sonnet",
      },
    );

    assert.deepEqual(outcome, {
      inheritedApiKeyBinding: {
        name: "ANTHROPIC_API_KEY",
        value: "super-secret",
        provider: "anthropic",
      },
      warningMessage: null,
    });
  });

  test("normalizes explicit parent provider case before conflict checks", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        provider: "OpenRouter",
        fallbackModel: "openrouter/openai/gpt-5",
      },
      { source: "user", model: "openrouter/openai/gpt-5" },
    );

    assert.deepEqual(outcome.inheritedApiKeyBinding, {
      name: "OPENROUTER_API_KEY",
      value: "super-secret",
      provider: "openrouter",
    });
    assert.equal(outcome.warningMessage, null);
  });

  test("does not propagate a CLI key when parent provider conflicts with user agent model", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        provider: "openrouter",
        fallbackModel: "openrouter/openai/gpt-5",
      },
      {
        source: "user",
        model: "anthropic/claude-3-5-sonnet",
      },
    );

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /conflicts with the child model provider/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("does not propagate a CLI key when explicit parent provider conflicts with parent model provider", () => {
    const outcome = resolveInheritedCliApiKeyForChild({
      apiKey: "super-secret",
      provider: "openrouter",
      fallbackModel: "anthropic/claude-3-5-sonnet",
    });

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /conflicts with the parent model provider/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("does not propagate a CLI key when parent model provider conflicts with user agent model", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        fallbackModel: "openrouter/openai/gpt-5",
      },
      {
        source: "user",
        model: "anthropic/claude-3-5-sonnet",
      },
    );

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /conflicts with the child model provider/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("does not propagate a CLI key when parent provider conflicts with trusted project agent model", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        provider: "openrouter",
        fallbackModel: "openrouter/openai/gpt-5",
      },
      {
        source: "project",
        model: "anthropic/claude-3-5-sonnet",
      },
      { projectAgentTrusted: true },
    );

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /conflicts with the child model provider/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("uses a trusted project agent model as a provider hint when parent hints are absent", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        fallbackModel: "claude-3-5-sonnet",
      },
      {
        source: "project",
        model: "anthropic/claude-3-5-sonnet",
      },
      { projectAgentTrusted: true },
    );

    assert.deepEqual(outcome, {
      inheritedApiKeyBinding: {
        name: "ANTHROPIC_API_KEY",
        value: "super-secret",
        provider: "anthropic",
      },
      warningMessage: null,
    });
  });

  test("does not use an untrusted project agent model as a provider hint", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        fallbackModel: "claude-3-5-sonnet",
      },
      {
        source: "project",
        model: "anthropic/claude-3-5-sonnet",
      },
    );

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /child will not inherit the CLI key/i);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("drops inherited --provider when the effective child model is fully-qualified", () => {
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "user", model: "anthropic/claude-3-5-sonnet" },
        ["--provider", "openrouter", "--theme", "night-owl"],
      ),
      ["--theme", "night-owl"],
    );
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "project", model: "anthropic/claude-3-5-sonnet" },
        ["--provider", "openrouter", "--theme", "night-owl"],
      ),
      ["--theme", "night-owl"],
    );
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "user", model: undefined },
        ["--provider", "openrouter", "--theme", "night-owl"],
        "anthropic/claude-3-5-sonnet",
      ),
      ["--theme", "night-owl"],
    );
  });

  test("keeps the parent provider in child args for user agents with unqualified models", () => {
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "user", model: "claude-3-5-sonnet" },
        ["--provider", "openrouter", "--theme", "night-owl"],
      ),
      ["--provider", "openrouter", "--theme", "night-owl"],
    );
  });

  test("uses per-call model override when deciding child model args and inherited provider flags", () => {
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "user", model: "claude-3-5-sonnet" },
        ["--provider", "openrouter", "--theme", "night-owl"],
        undefined,
        "anthropic/claude-sonnet-4",
      ),
      ["--theme", "night-owl"],
    );

    const args = buildPiArgs(
      {
        name: "worker",
        description: "Worker",
        systemPrompt: "",
        source: "user",
        filePath: "/tmp/worker.md",
        model: "openai/gpt-4.1",
      },
      null,
      "/tmp/task-worker.md",
      "spawn",
      null,
      "anthropic/claude-sonnet-4",
    );

    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
      "--model",
      "anthropic/claude-sonnet-4",
    ]);
    assert.equal(args.includes("openai/gpt-4.1"), false);
  });

  test("keeps per-call model override on early unknown-agent results", async () => {
    const result = await runAgent({
      cwd: process.cwd(),
      agents: [],
      agentName: "missing",
      task: "Do work",
      model: "anthropic/claude-sonnet-4",
      delegationMode: "spawn",
      terminalMode: "inline",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      makeDetails: (results) => ({
        mode: "single",
        toolLabel: "Subagent",
        delegationMode: "spawn",
        terminalMode: "inline",
        projectAgentsDir: null,
        results,
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.model, "anthropic/claude-sonnet-4");
    assert.match(result.stderr, /Unknown agent/);
  });

  test("keeps inline children project-unapproved after project-agent approval", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-project-"));
    tempDirs.push(root);
    await fs.promises.mkdir(path.join(root, ".pi", "agents"), { recursive: true });
    const args = buildPiArgs({
      name: "project-worker", description: "Worker", systemPrompt: "", source: "project", filePath: path.join(root, ".pi", "agents", "worker.md"),
    }, null, "/tmp/task.md", "spawn", null);
    args.unshift("--context-file", "/tmp/untrusted-context.md", "-nc", "--approve");
    applyChildProjectIsolation(args, root);
    assert.equal(args.includes("--approve"), false);
    assert.equal(args.includes("--context-file"), false);
    assert.equal(args.includes("-nc"), false);
    assert.equal(args.filter((arg) => arg === "--no-context-files").length, 1);
    assert.equal(args.filter((arg) => arg === "--no-approve").length, 1);
  });

  test("passes delegated task via @file instead of argv text", () => {
    const args = buildPiArgs(
      {
        name: "worker",
        description: "Worker",
        systemPrompt: "",
        source: "user",
        filePath: "/tmp/worker.md",
      },
      null,
      "/tmp/task-worker.md",
      "spawn",
      null,
    );

    assert.equal(args.includes("Task: secret task"), false);
    assert.equal(args.at(-1), "@/tmp/task-worker.md");
  });

  test("accepts an authorized Phase 0 launcher import without controller material", () => {
    const env = importedRunnerEnv(importRunnerWithPhase0Env({ [PHASE0_LIVE_GATE_ENV]: "1" }));
    for (const name of phase0ProofEnvNames.slice(1)) assert.equal(env[name], undefined);
  });

  test("captures complete Phase 0 controller material before tools can inherit it", () => {
    const env = importedRunnerEnv(importRunnerWithPhase0Env({
      [PHASE0_LIVE_GATE_ENV]: "1",
      [PHASE0_LIVE_PROOF_SOCKET_ENV]: "/private/proofs/phase0.sock",
      [PHASE0_LIVE_PROOF_MASTER_ENV]: "a".repeat(64),
      [PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV]: JSON.stringify(["/private/proofs/barrier-0"]),
      [PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV]: JSON.stringify(["c".repeat(64)]),
      [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: futurePhase0Deadline(),
      [PHASE0_LIVE_PROOF_BEHAVIOR_ENV]: "short",
    }));
    for (const name of phase0ProofEnvNames.slice(1)) assert.equal(env[name], undefined);
  });

  test("retains only the exact Phase 0 child assignment at runner import", () => {
    const assignment = {
      [PHASE0_LIVE_GATE_ENV]: "1",
      [PHASE0_LIVE_PROOF_SOCKET_ENV]: "/private/proofs/phase0.sock",
      [PHASE0_LIVE_PROOF_ID_ENV]: "a".repeat(32),
      [PHASE0_LIVE_PROOF_CAPABILITY_ENV]: "b".repeat(64),
      [PHASE0_LIVE_PROOF_BARRIER_PATH_ENV]: "/private/proofs/barrier-0",
      [PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV]: "c".repeat(64),
      [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: futurePhase0Deadline(),
      [PHASE0_LIVE_PROOF_BEHAVIOR_ENV]: "short",
    };
    const env = importedRunnerEnv(importRunnerWithPhase0Env(assignment));
    for (const [name, value] of Object.entries(assignment)) assert.equal(env[name], value);
    assert.equal(env[PHASE0_LIVE_PROOF_MASTER_ENV], undefined);
    assert.equal(env[PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV], undefined);
    assert.equal(env[PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV], undefined);
  });

  test("rejects an assigned Phase 0 child with leaked controller material", () => {
    const result = importRunnerWithPhase0Env({
      [PHASE0_LIVE_GATE_ENV]: "1",
      [PHASE0_LIVE_PROOF_SOCKET_ENV]: "/private/proofs/phase0.sock",
      [PHASE0_LIVE_PROOF_ID_ENV]: "a".repeat(32),
      [PHASE0_LIVE_PROOF_CAPABILITY_ENV]: "b".repeat(64),
      [PHASE0_LIVE_PROOF_BARRIER_PATH_ENV]: "/private/proofs/barrier-0",
      [PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV]: "d".repeat(64),
      [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: futurePhase0Deadline(),
      [PHASE0_LIVE_PROOF_BEHAVIOR_ENV]: "short",
      [PHASE0_LIVE_PROOF_MASTER_ENV]: "c".repeat(64),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Phase 0 live proof child environment is incomplete/);
  });

  test("rejects partial or misaligned Phase 0 controller material at runner import", () => {
    for (const environment of [
      { [PHASE0_LIVE_GATE_ENV]: "1", [PHASE0_LIVE_PROOF_SOCKET_ENV]: "/private/proofs/phase0.sock" },
      { [PHASE0_LIVE_GATE_ENV]: "1", [PHASE0_LIVE_PROOF_SOCKET_ENV]: "/private/proofs/phase0.sock", [PHASE0_LIVE_PROOF_MASTER_ENV]: "a".repeat(64), [PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV]: JSON.stringify(["/private/proofs/barrier-0"]), [PHASE0_LIVE_PROOF_BEHAVIOR_ENV]: "short" },
      { [PHASE0_LIVE_GATE_ENV]: "1", [PHASE0_LIVE_PROOF_SOCKET_ENV]: "/private/proofs/phase0.sock", [PHASE0_LIVE_PROOF_MASTER_ENV]: "a".repeat(64), [PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV]: JSON.stringify(["/private/proofs/barrier-0", "/private/proofs/barrier-1"]), [PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV]: JSON.stringify(["b".repeat(64)]), [PHASE0_LIVE_PROOF_BEHAVIOR_ENV]: "short" },
    ]) {
      const result = importRunnerWithPhase0Env(environment as Record<string, string>);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Phase 0 live proof controller environment is incomplete/);
    }
  });

  test("rejects missing, malformed, expired, distant, and mixed Phase 0 release-deadline environments", () => {
    const controller = () => ({
      [PHASE0_LIVE_GATE_ENV]: "1",
      [PHASE0_LIVE_PROOF_SOCKET_ENV]: "/private/proofs/phase0.sock",
      [PHASE0_LIVE_PROOF_MASTER_ENV]: "a".repeat(64),
      [PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV]: JSON.stringify(["/private/proofs/barrier-0"]),
      [PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV]: JSON.stringify(["b".repeat(64)]),
      [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: futurePhase0Deadline(),
      [PHASE0_LIVE_PROOF_BEHAVIOR_ENV]: "short",
    });
    const { [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: _missingDeadline, ...missing } = controller();
    const environments = [
      missing,
      { ...controller(), [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: "not-a-deadline" },
      { ...controller(), [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: String(Date.now() - 1) },
      { ...controller(), [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: String(Date.now() + 31 * 60 * 1_000) },
      { ...controller(), [PHASE0_LIVE_PROOF_ID_ENV]: "c".repeat(32) },
    ];
    for (const environment of environments) {
      const result = importRunnerWithPhase0Env(environment);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Phase 0 live proof (controller|child) environment is incomplete/);
    }
  });

  test("passes only an assigned Phase 0 proof to inline and interactive child environments", () => {
    const proof = {
      [PHASE0_LIVE_PROOF_SOCKET_ENV]: "/private/proofs/phase0.sock",
      [PHASE0_LIVE_PROOF_BARRIER_PATH_ENV]: "/private/proofs/barrier-0",
      [PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV]: "c".repeat(64),
      [PHASE0_LIVE_PROOF_ID_ENV]: "a".repeat(32),
      [PHASE0_LIVE_PROOF_CAPABILITY_ENV]: "b".repeat(64),
      [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: futurePhase0Deadline(),
      [PHASE0_LIVE_PROOF_BEHAVIOR_ENV]: "short",
    };
    const env = buildChildProcessEnv({
      agentName: "worker", parentDepth: 0, parentAgentStack: [], maxDepth: 3, preventCycles: true,
      baseEnv: { PI_SUBAGENT_PHASE0_LIVE: "1", [PHASE0_LIVE_PROOF_SOCKET_ENV]: "/private/controller.sock", PI_SUBAGENT_PHASE0_LIVE_PROOF_MASTER: "c".repeat(64), PI_SUBAGENT_PHASE0_LIVE_PROOF_BARRIER_PATHS: JSON.stringify(["/private/controller/barrier-0", "/private/controller/barrier-1"]), PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_TOKENS: JSON.stringify(["d".repeat(64), "e".repeat(64)]), [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: futurePhase0Deadline() },
      phase0LiveProofEnv: proof,
    });
    assert.deepEqual(Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("PI_SUBAGENT_PHASE0_LIVE_PROOF"))), proof);
    const privateInteractiveEnv = buildPrivateChildEnvironmentScript(env);
    assert.ok(privateInteractiveEnv.includes(`export ${PHASE0_LIVE_PROOF_BARRIER_PATH_ENV}='${proof[PHASE0_LIVE_PROOF_BARRIER_PATH_ENV]}'`));
    assert.ok(privateInteractiveEnv.includes(`export ${PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV}='${proof[PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV]}'`));
    assert.ok(privateInteractiveEnv.includes(`export ${PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV}='${proof[PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]}'`));
    assert.ok(privateInteractiveEnv.includes(`export ${PHASE0_LIVE_PROOF_ID_ENV}='${proof[PHASE0_LIVE_PROOF_ID_ENV]}'`));
    assert.ok(privateInteractiveEnv.includes(`export ${PHASE0_LIVE_PROOF_CAPABILITY_ENV}='${proof[PHASE0_LIVE_PROOF_CAPABILITY_ENV]}'`));
    assert.ok(privateInteractiveEnv.includes(`export ${PHASE0_LIVE_PROOF_SOCKET_ENV}='${proof[PHASE0_LIVE_PROOF_SOCKET_ENV]}'`));
    assert.equal(privateInteractiveEnv.includes("PROOF_MASTER"), false);
  });

  test("keeps documented provider environment aligned for inline and private interactive children", () => {
    const providerEnv = {
      OPENAI_API_KEY: "existing-env-secret",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
      RADIUS_API_KEY: "radius-secret",
      AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      GOOGLE_CLOUD_PROJECT: "vertex-project",
      GOOGLE_APPLICATION_CREDENTIALS: "/private/vertex.json",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/private/irsa-token",
      HTTPS_PROXY: "http://proxy",
      UNRELATED_SECRET: "must-not-pass-to-interactive-child",
      PATH: "/usr/bin",
    };
    const env = buildChildProcessEnv({
      agentName: "worker",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      inheritedApiKeyBinding: null,
      baseEnv: providerEnv,
    });
    const privateInteractiveEnv = buildPrivateChildEnvironmentScript(env);

    for (const [name, value] of Object.entries(providerEnv)) {
      assert.equal(env[name], value);
      if (name !== "UNRELATED_SECRET") assert.ok(privateInteractiveEnv.includes(`export ${name}='${value}'`));
    }
    assert.equal(privateInteractiveEnv.includes("UNRELATED_SECRET="), false);
    const inheritedCliKeyScript = buildPrivateChildEnvironmentScript({ PI_SUBAGENT_INHERITED_API_KEY: "super-secret" });
    assert.equal(inheritedCliKeyScript.includes("export PI_SUBAGENT_INHERITED_API_KEY='super-secret'"), true);
    assert.equal(env.PI_SUBAGENT_DEPTH, "1");
  });


});
