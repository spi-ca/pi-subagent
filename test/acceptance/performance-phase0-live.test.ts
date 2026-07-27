import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  CHILD_MODEL, CMUX_CONCURRENCY_TIER_ID, LIVE_ACKNOWLEDGEMENTS, LIVE_CMUX16_ACKNOWLEDGEMENT, LIVE_CMUX16_GATE,
  LIVE_GATE, LIVE_RECORD_GATE, ROUTINE_TIER_ID, createPrivateEvidenceRoot, expectedChildRunCount, expectedLiveCells,
  livePlan, loadLiveCheckpoint, parseArgs, requireLiveGate, validateLiveCheckpoint, validateLiveEvidence,
  claimLiveCheckpoint, cleanupPhase0ReleaseWriters, formatPhase0FailureSummary, PHASE0_FAILURE_SUMMARY_FILE, resolveLiveBackendExecutable, resolveLivePiExecutable, revalidateStagedLivePiBundle, scrubSensitiveRecoveryArtifacts, stageLivePiExecutable, validatePhase0FailureSummary, writeLiveCheckpoint, writePhase0FailureSummary, type CellEvidence, type LiveEvidence, type LivePiExecutable, type Phase0ReleaseWriter,
} from "./performance-phase0-live/evidence";
import { getProcessStartedAt } from "../../src/runtime/run-protocol";
import { inspectTmuxPane } from "../../src/runtime/tmux";
import { buildTmuxSourcePaneProbeArgs, parseTmuxSourcePaneProbe } from "../../src/runtime/runner";
import { createTmuxControlTransportGate } from "../../src/runtime/tmux-control-gate";
import { validateSubagentInvocation } from "../../src/core/subagent-config";
import { MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV, captureManagedChildLivePiExecutableGeneration, captureManagedChildPiExecutableGeneration } from "./managed-child-pi-executable";
import { Phase0BlindStageTerminalObserver, Phase0CellFailure, Phase0LiveDiagnosticWatchdog, Phase0LiveMilestoneTracker, attemptPhase0CleanupSteps, awaitExactBootstrapWatchdogDisarm, awaitPhase0PreReadLifecycle, buildSyntheticParentEnv, discoverExactBootstrapWatchdog, finalizePhase0CellFailure, phase0ChildTerminalFailure, phase0FailureCategory, phase0WrapperFallbackSummary, prepareAgentDirectory, processRows, runParentCell, terminateExactBootstrapAuthority, terminateExactPhase0Identities } from "./performance-phase0-live/cell";
import { currentLiveSourceIdentity, executeLiveBenchmark, executeLiveSmoke, recordLiveFixture, type LiveBenchmarkTestHooks } from "./performance-phase0-live";
import { aggregateCmuxCleanupAttempts, CMUX_CLEANUP_DEADLINE_MS, createCmuxCleanupDeadline, withCmuxCleanupDeadline } from "./performance-phase0-live/cmux-fixture";
import { runTmuxCell, teardownIdentityBoundTmuxServer, TMUX_FIXTURE_SAFE_PATH, tmuxFixtureSetupEnv } from "./performance-phase0-live/tmux-fixture";

const fixtureGeneration = { executable: "/fixture/pi", dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1, mode: 0o700, uid: 1, nativeExecutable: true };
const fixturePi: LivePiExecutable = { bin: "/fixture/pi", version: "0.81.1", generation: fixtureGeneration, tmux: fixtureGeneration, cmux: fixtureGeneration };
const bypassPiStaging = async (_root: string, pi: LivePiExecutable): Promise<LivePiExecutable> => pi;
const measured = (mode: "tmux" | "cmux") => ({ source: `authoritative-live-artifact:transport-${mode}` as const, availability: "measured" as const, backendRequests: 1, backendSpawns: 1, requestBacklogHighWater: 1, lineBacklogHighWater: 1, byteBacklogHighWater: 1, controlDisconnects: 0, reconnects: 0, unknownOutcomes: 0, exactSnapshots: 1, exactCleanupMutations: 1, residualRecovery: 0, persistentClientCreates: 1, persistentClientRestarts: 0, healthyPeriodicStatusQueries: 0, notificationToReconcileLatencyMs: 0, lifecycleCompletionLatencyMs: 1 });
const inline = () => { const value = { notApplicable: true as const, reason: "inline-no-interactive-transport" as const }; return { source: "not-applicable:inline" as const, availability: "not-applicable" as const, backendRequests: value, backendSpawns: value, requestBacklogHighWater: value, lineBacklogHighWater: value, byteBacklogHighWater: value, controlDisconnects: value, reconnects: value, unknownOutcomes: value, exactSnapshots: value, exactCleanupMutations: value, residualRecovery: value, persistentClientCreates: value, persistentClientRestarts: value, healthyPeriodicStatusQueries: value, notificationToReconcileLatencyMs: value, lifecycleCompletionLatencyMs: value }; };
function cell(mode: "inline" | "tmux" | "cmux", activeRuns: 1 | 16, workload: "idle-wait" | "short-response" | "long-response" | "cancel" | "external-close"): CellEvidence {
  return { mode, activeRuns, workload, timing: { monotonicElapsedMs: 2, settlementLatencyMs: 1, eventLoopDelayMeanMs: 0, eventLoopDelayMaxMs: 0, eventLoopDelayP99Ms: 0 }, parent: { cpuDeltaMs: 1, peakRssKiB: 1 }, descendants: { peakCount: activeRuns, peakIdentities: Array.from({ length: activeRuns }, (_, i) => ({ pid: i + 1, startedAt: i + 1 })), verifiedProviderIdentities: Array.from({ length: activeRuns }, (_, i) => ({ pid: i + 1, startedAt: i + 1 })), resources: { cumulativeCpuMs: 1, peakAggregateCpuMs: 1, peakAggregateRssKiB: 1, peakIndividualRssKiB: 1 } }, backend: { topologyProbeCount: mode === "inline" ? 0 : activeRuns, transportCounters: mode === "inline" ? inline() : measured(mode) }, verifiedProviderChildren: activeRuns, settlement: workload === "idle-wait" ? "observed-then-cancelled" : workload === "cancel" ? "cancelled" : workload === "external-close" ? "externally-closed" : "settled", requestedProvider: "openai-codex", requestedModel: CHILD_MODEL, observedProvider: "openai-codex", observedModel: "gpt-5.4-mini", cleanup: { result: "clean", residualDescendantCount: 0, residualBackendTargetCount: 0 }, sourceAndSentinelPreserved: true };
}
function evidence(tier: typeof ROUTINE_TIER_ID | typeof CMUX_CONCURRENCY_TIER_ID, source: { sourceRevision: "unknown" | string; sourceDirty: boolean; worktreeDigest: string } = { sourceRevision: "unknown", sourceDirty: true, worktreeDigest: "a".repeat(64) }): LiveEvidence {
  const plan = livePlan(tier); return { schemaVersion: 4, tier, planId: plan.planId, planDigest: plan.planDigest, phase: "M0-live", evidenceKind: "gated-provider-transport-benchmark", capturedAt: new Date().toISOString(), environment: { os: "darwin", arch: "arm64", bunVersion: "1", piVersion: "1", ...source }, requested: { provider: "openai-codex", model: CHILD_MODEL, childRuns: plan.childRuns }, matrix: expectedLiveCells(tier).map((entry) => cell(entry.mode, entry.activeRuns, entry.workload)), cleanup: { result: "clean", evidenceRoot: "private-0700", evidenceFile: "private-0600", residualDescendantCount: 0, residualBackendTargetCount: 0 } };
}
async function writeThemePair(root: string, dark: string | Buffer = '{"name":"dark"}\n', light: string | Buffer = '{"name":"light"}\n'): Promise<void> {
  await fs.mkdir(path.join(root, "theme"), { mode: 0o700, recursive: true }); await fs.chmod(path.join(root, "theme"), 0o700);
  await fs.writeFile(path.join(root, "theme", "dark.json"), dark, { mode: 0o600 });
  await fs.writeFile(path.join(root, "theme", "light.json"), light, { mode: 0o600 });
}
async function runPiStartup(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Pi startup test timed out")); }, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
  });
}

describe("two-tier gated Phase 0 live harness", () => {
  test("defines immutable exact routine and concurrency plans", () => {
    assert.equal(expectedChildRunCount(ROUTINE_TIER_ID), 15);
    assert.equal(expectedChildRunCount(CMUX_CONCURRENCY_TIER_ID), 16);
    assert.deepEqual(expectedLiveCells(ROUTINE_TIER_ID).map(({ mode, activeRuns, workload }) => `${mode}:${activeRuns}:${workload}`), [
      "inline:1:idle-wait", "inline:1:short-response", "inline:1:long-response", "inline:1:cancel", "inline:1:external-close",
      "tmux:1:idle-wait", "tmux:1:short-response", "tmux:1:long-response", "tmux:1:cancel", "tmux:1:external-close",
      "cmux:1:idle-wait", "cmux:1:short-response", "cmux:1:long-response", "cmux:1:cancel", "cmux:1:external-close",
    ]);
    assert.deepEqual(expectedLiveCells(CMUX_CONCURRENCY_TIER_ID), [{ mode: "cmux", activeRuns: 16, workload: "short-response" }]);
    assert.match(livePlan(ROUTINE_TIER_ID).planDigest, /^[0-9a-f]{64}$/);
  });

  test("requires explicit canonical backend executables instead of caller PATH", async () => {
    await assert.rejects(() => resolveLivePiExecutable({ PATH: "/self-reporting/pi/bin" }), /explicit absolute PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE/);
    assert.throws(() => resolveLiveBackendExecutable({}, "TMUX_BIN"), /explicit absolute TMUX_BIN/);
    assert.throws(() => resolveLiveBackendExecutable({ CMUX_BIN: "cmux" }, "CMUX_BIN"), /explicit absolute CMUX_BIN/);
  });

  test("requires exact tier selectors, acknowledgements, and environment gates", () => {
    assert.deepEqual(parseArgs(["--execute-live", "--tier=routine-v1", LIVE_ACKNOWLEDGEMENTS[ROUTINE_TIER_ID]]), { execute: true, tier: ROUTINE_TIER_ID });
    assert.deepEqual(parseArgs(["--execute-live", "--tier=cmux-concurrency-16-v1", LIVE_ACKNOWLEDGEMENTS[CMUX_CONCURRENCY_TIER_ID], LIVE_CMUX16_ACKNOWLEDGEMENT]), { execute: true, tier: CMUX_CONCURRENCY_TIER_ID });
    for (const args of [
      ["--execute-live", LIVE_ACKNOWLEDGEMENTS[ROUTINE_TIER_ID]],
      ["--execute-live", "--tier=routine-v1", "--ack-provider-child-runs=255"],
      ["--execute-live", "--tier=routine-v1", LIVE_ACKNOWLEDGEMENTS[ROUTINE_TIER_ID], LIVE_CMUX16_ACKNOWLEDGEMENT],
      ["--execute-live", "--tier=cmux-concurrency-16-v1", LIVE_ACKNOWLEDGEMENTS[CMUX_CONCURRENCY_TIER_ID]],
      ["--execute-live", "--tier=cmux-concurrency-16-v1", LIVE_ACKNOWLEDGEMENTS[CMUX_CONCURRENCY_TIER_ID], LIVE_CMUX16_ACKNOWLEDGEMENT, "--max-cells=1"],
    ]) assert.throws(() => parseArgs(args), /usage|acknowledgement|max cells/);
    assert.throws(() => requireLiveGate({ execute: true, tier: ROUTINE_TIER_ID }, {}), /PI_SUBAGENT_PHASE0_LIVE=1/);
    assert.throws(() => requireLiveGate({ execute: true, tier: CMUX_CONCURRENCY_TIER_ID }, { [LIVE_GATE]: "1" }), /PI_SUBAGENT_PHASE0_LIVE_CMUX16=1/);
    assert.doesNotThrow(() => requireLiveGate({ execute: true, tier: CMUX_CONCURRENCY_TIER_ID }, { [LIVE_GATE]: "1", [LIVE_CMUX16_GATE]: "1" }));
  });

  test("uses schema v4 tier discriminators, 40/64-hex source revisions, and exact ordered cardinality", () => {
    const routine = evidence(ROUTINE_TIER_ID), concurrency = evidence(CMUX_CONCURRENCY_TIER_ID);
    assert.equal(validateLiveEvidence(routine), true); assert.equal(validateLiveEvidence(concurrency), true);
    for (const sourceRevision of ["a".repeat(40), "b".repeat(64)]) {
      assert.equal(validateLiveEvidence(evidence(ROUTINE_TIER_ID, { sourceRevision, sourceDirty: false, worktreeDigest: "c".repeat(64) })), true);
    }
    const wrongVersion = structuredClone(routine) as any; wrongVersion.schemaVersion = 3; assert.equal(validateLiveEvidence(wrongVersion), false);
    const reordered = structuredClone(routine); [reordered.matrix[0], reordered.matrix[1]] = [reordered.matrix[1]!, reordered.matrix[0]!]; assert.equal(validateLiveEvidence(reordered), false);
    const tierConfusion = structuredClone(routine) as any; tierConfusion.tier = CMUX_CONCURRENCY_TIER_ID; assert.equal(validateLiveEvidence(tierConfusion), false);
    const badPlan = structuredClone(concurrency); badPlan.planDigest = "0".repeat(64); assert.equal(validateLiveEvidence(badPlan), false);
    concurrency.matrix.push(cell("cmux", 16, "short-response")); assert.equal(validateLiveEvidence(concurrency), false);
  });

  test("uses source- and Pi-version-bound v4 checkpoints and rejects old, cross-tier, or concurrency partial checkpoints", async () => {
    const root = await createPrivateEvidenceRoot(), source = { sourceRevision: "unknown" as const, sourceDirty: true, worktreeDigest: "b".repeat(64) }, routine = livePlan(ROUTINE_TIER_ID), concurrency = livePlan(CMUX_CONCURRENCY_TIER_ID);
    try {
      const checkpoint = { version: 4 as const, tier: ROUTINE_TIER_ID, planId: routine.planId, planDigest: routine.planDigest, piVersion: fixturePi.version, ...source, childRuns: 15, cells: [evidence(ROUTINE_TIER_ID, source).matrix[0]!] };
      assert.equal(validateLiveCheckpoint(checkpoint), true); await writeLiveCheckpoint(root, checkpoint); assert.equal(await scrubSensitiveRecoveryArtifacts(root), true); assert.deepEqual(await loadLiveCheckpoint(root), checkpoint);
      assert.equal(validateLiveCheckpoint({ ...checkpoint, version: 3 } as any), false);
      const { piVersion: _piVersion, ...withoutPiVersion } = checkpoint;
      assert.equal(validateLiveCheckpoint(withoutPiVersion), false);
      assert.equal(validateLiveCheckpoint({ ...checkpoint, piVersion: "0.81.2" }), true);
      assert.equal(validateLiveCheckpoint({ ...checkpoint, tier: CMUX_CONCURRENCY_TIER_ID } as any), false);
      assert.equal(validateLiveCheckpoint({ version: 4, tier: CMUX_CONCURRENCY_TIER_ID, planId: concurrency.planId, planDigest: concurrency.planDigest, piVersion: fixturePi.version, ...source, childRuns: 16, cells: [cell("cmux", 16, "short-response"), cell("cmux", 16, "short-response")] }), false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("runs every acknowledged cell once and makes cleanup failures terminal", async () => {
    const roots: string[] = [], source = { sourceRevision: "unknown" as const, sourceDirty: true, worktreeDigest: "c".repeat(64) }, calls: string[] = [];
    const hooks: LiveBenchmarkTestHooks = { preflight: async () => fixturePi, stagePi: bypassPiStaging, capturedSource: () => source, createRoot: async () => { const root = await createPrivateEvidenceRoot(); roots.push(root); return root; }, prepareAgentDirectory: async () => "/fixture/agent", writeSyntheticParent: async () => "/fixture/parent", runCell: async (_root, _agent, _extension, _bin, mode, activeRuns, workload) => { calls.push(`${mode}:${activeRuns}:${workload}`); const { mode: _mode, sourceAndSentinelPreserved: _preserved, ...result } = cell(mode, activeRuns, workload); return result; } };
    try {
      const result = await executeLiveBenchmark({ execute: true, tier: ROUTINE_TIER_ID, maxCells: 2 }, { [LIVE_GATE]: "1" }, hooks);
      assert.equal(result.mode, "checkpointed"); assert.deepEqual(calls, ["inline:1:idle-wait", "inline:1:short-response"]);
      calls.length = 0; hooks.runCell = async () => { calls.push("once"); throw new Error("cmux cleanup was not proven; terminal"); };
      await assert.rejects(() => executeLiveBenchmark({ execute: true, tier: CMUX_CONCURRENCY_TIER_ID }, { [LIVE_GATE]: "1", [LIVE_CMUX16_GATE]: "1" }, hooks), /cleanup was not proven/);
      assert.deepEqual(calls, ["once"]);
    } finally { await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); }
  });

  test("terminalizes attempted cells and atomically consumes the original resume checkpoint", async () => {
    const roots: string[] = [], source = { sourceRevision: "unknown" as const, sourceDirty: true, worktreeDigest: "d".repeat(64) }, plan = livePlan(ROUTINE_TIER_ID);
    let claimedRoot: string | null = null;
    const hooks: LiveBenchmarkTestHooks = { preflight: async () => fixturePi, stagePi: bypassPiStaging, capturedSource: () => source, claimCheckpoint: async (root) => { const claimed = await claimLiveCheckpoint(root); claimedRoot = claimed; roots.push(claimed); return claimed; }, createRoot: async () => { const root = await createPrivateEvidenceRoot(); roots.push(root); return root; }, prepareAgentDirectory: async () => "/fixture/agent", writeSyntheticParent: async () => "/fixture/parent", runCell: async () => { throw new Error("injected cleanup failure"); } };
    const checkpoint = { version: 4 as const, tier: ROUTINE_TIER_ID, planId: plan.planId, planDigest: plan.planDigest, piVersion: fixturePi.version, ...source, childRuns: plan.childRuns, cells: [] };
    const original = await createPrivateEvidenceRoot(); roots.push(original); await writeLiveCheckpoint(original, checkpoint);
    try {
      await assert.rejects(() => executeLiveBenchmark({ execute: true, tier: ROUTINE_TIER_ID, resumeLiveRoot: original }, { [LIVE_GATE]: "1" }, hooks), /injected cleanup failure/);
      // The original inode was atomically consumed before runCell was invoked,
      // so neither failure nor a later invocation can replay it.
      await assert.rejects(() => loadLiveCheckpoint(original), /live checkpoint root|live checkpoint file/);
      assert.ok(claimedRoot);
      await assert.rejects(() => loadLiveCheckpoint(claimedRoot!), /live checkpoint root|live checkpoint file/);
      await assert.rejects(() => executeLiveBenchmark({ execute: true, tier: ROUTINE_TIER_ID, resumeLiveRoot: original }, { [LIVE_GATE]: "1" }, hooks), /live checkpoint root|claim failed/);
    } finally { await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); }
  });

  test("rejects a resume checkpoint with a different preflight Pi version before any provider cell", async () => {
    const root = await createPrivateEvidenceRoot(), source = { sourceRevision: "unknown" as const, sourceDirty: true, worktreeDigest: "9".repeat(64) }, plan = livePlan(ROUTINE_TIER_ID);
    let providerCellAttempted = false;
    try {
      await writeLiveCheckpoint(root, { version: 4, tier: ROUTINE_TIER_ID, planId: plan.planId, planDigest: plan.planDigest, piVersion: fixturePi.version, ...source, childRuns: plan.childRuns, cells: [] });
      await assert.rejects(() => executeLiveBenchmark({ execute: true, tier: ROUTINE_TIER_ID, resumeLiveRoot: root }, { [LIVE_GATE]: "1" }, {
        preflight: async () => ({ ...fixturePi, version: "0.81.2" }), capturedSource: () => source,
        runCell: async () => { providerCellAttempted = true; throw new Error("provider cell must not run"); },
      }), /checkpoint Pi version/);
      assert.equal(providerCellAttempted, false);
      assert.equal(await fs.lstat(root).catch(() => null), null);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("removes claimed resume roots when checkpoint decoding or source binding fails", async () => {
    const currentSource = { sourceRevision: "unknown" as const, sourceDirty: true, worktreeDigest: "f".repeat(64) }, plan = livePlan(ROUTINE_TIER_ID);
    const malformed = await createPrivateEvidenceRoot(), mismatch = await createPrivateEvidenceRoot();
    const claims: string[] = [];
    const hooks: LiveBenchmarkTestHooks = {
      preflight: async () => fixturePi, stagePi: bypassPiStaging, capturedSource: () => currentSource,
      claimCheckpoint: async (root) => { const claimed = await claimLiveCheckpoint(root); claims.push(claimed); return claimed; },
    };
    try {
      await fs.writeFile(path.join(malformed, "phase0-live-checkpoint.json"), "{malformed", { mode: 0o600 });
      await fs.chmod(path.join(malformed, "phase0-live-checkpoint.json"), 0o600);
      const staleSource = { sourceRevision: "unknown" as const, sourceDirty: false, worktreeDigest: "0".repeat(64) };
      await writeLiveCheckpoint(mismatch, { version: 4, tier: ROUTINE_TIER_ID, planId: plan.planId, planDigest: plan.planDigest, piVersion: fixturePi.version, ...staleSource, childRuns: plan.childRuns, cells: [] });
      await assert.rejects(() => executeLiveBenchmark({ execute: true, tier: ROUTINE_TIER_ID, resumeLiveRoot: malformed }, { [LIVE_GATE]: "1" }, hooks), /JSON is malformed/);
      await assert.rejects(() => executeLiveBenchmark({ execute: true, tier: ROUTINE_TIER_ID, resumeLiveRoot: mismatch }, { [LIVE_GATE]: "1" }, hooks), /source identity/);
      assert.equal(claims.length, 2);
      for (const root of [malformed, mismatch, ...claims]) assert.equal(await fs.lstat(root).catch(() => null), null);
    } finally { await Promise.all([malformed, mismatch, ...claims].map((root) => fs.rm(root, { recursive: true, force: true }))); }
  });

  test("uses a fresh cmux cleanup deadline and restores the original cell deadline", async () => {
    assert.deepEqual(createCmuxCleanupDeadline(123), { expiresAt: 123 + CMUX_CLEANUP_DEADLINE_MS });
    const original = { expiresAt: Date.now() - 1 }, deadline = { current: original }, capturedTargets = ["surface-1"], closed: string[] = [];
    await withCmuxCleanupDeadline(deadline, async () => {
      for (const target of capturedTargets) {
        assert.ok(deadline.current.expiresAt > Date.now());
        closed.push(target);
      }
    });
    assert.deepEqual(closed, capturedTargets); assert.strictEqual(deadline.current, original);
    await assert.rejects(() => withCmuxCleanupDeadline(deadline, async () => { assert.notStrictEqual(deadline.current, original); throw new Error("injected cleanup failure"); }), /injected cleanup failure/);
    assert.strictEqual(deadline.current, original);
  });

  test("aggregates cmux cleanup attempts without short-circuiting", async () => {
    const attempts: string[] = [];
    const clean = await aggregateCmuxCleanupAttempts({
      closeSentinel: async () => { attempts.push("sentinel"); return false; },
      closeWorkspace: async () => { attempts.push("workspace"); throw new Error("injected"); },
      verifyCallerPreserved: async () => { attempts.push("caller"); return true; },
    });
    assert.equal(clean, false); assert.deepEqual(attempts, ["sentinel", "workspace", "caller"]);
  });

  test("isolates synthetic parent env and retains only explicit ordinary, proxy, CA, and transport values", () => {
    const env = buildSyntheticParentEnv({ PATH: "/bin", HOME: "/home/test", LANG: "C", HTTPS_PROXY: "https://proxy.invalid", NODE_EXTRA_CA_CERTS: "/tmp/ca.pem", PI_SUBAGENT_SECRET: "leak", SECRET_TOKEN: "leak", NODE_OPTIONS: "--require=bad", BASH_ENV: "/tmp/hook", RANDOM_CANARY: "leak", TMUX: "ambient" }, { TMUX: "explicit", CMUX_SOCKET_PATH: "/tmp/cmux.sock", PI_SUBAGENT_PHASE0_LIVE: "1", PHASE0_ACTIVE_RUNS: "1" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/home/test", LANG: "C", HTTPS_PROXY: "https://proxy.invalid", NODE_EXTRA_CA_CERTS: "/tmp/ca.pem", TMUX: "explicit", CMUX_SOCKET_PATH: "/tmp/cmux.sock", PI_SUBAGENT_PHASE0_LIVE: "1", PHASE0_ACTIVE_RUNS: "1" });
    assert.throws(() => buildSyntheticParentEnv({}, { ARBITRARY_OVERRIDE: "no" }), /not allowlisted/); assert.throws(() => buildSyntheticParentEnv({}, { PI_SUBAGENT_PHASE0_LIVE_EVIL: "no" }), /not allowlisted/);
  });

  test("emits schema-compatible background admission tasks without per-task mode", async () => {
    const root = await createPrivateEvidenceRoot();
    let taskChunks: unknown, barrierPaths: unknown;
    try {
      await assert.rejects(() => runParentCell(root, "/fixture/agent", "/fixture/extension", fixturePi, 1, "short-response", { PATH: process.env.PATH }, {}, undefined, true, { expiresAt: Date.now() + 10_000 }, {
        skipStagedBundleRevalidation: true,
        spawnParent: ((_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
          taskChunks = JSON.parse(options.env?.PHASE0_TASK_CHUNKS ?? "null");
          barrierPaths = JSON.parse(options.env?.PI_SUBAGENT_PHASE0_LIVE_PROOF_BARRIER_PATHS ?? "null");
          throw new Error("captured provider-free admission contract");
        }) as never,
      }));
      assert.ok(Array.isArray(barrierPaths));
      assert.deepEqual(taskChunks, [[{
        agent: "phase0-live-child",
        task: `First call the read tool exactly once with path ${JSON.stringify(barrierPaths[0])}. Follow the continuation instruction returned by that tool.`,
      }]]);
      const tasks = (taskChunks as Array<Array<{ agent: string; task: string }>>)[0]!;
      assert.equal(validateSubagentInvocation({ tasks, background: true }), null);
      assert.equal(Object.hasOwn(tasks[0]!, "mode"), false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("tracks only bounded monotonic milestone state and watchdog ignores volatile gauges", () => {
    const tracker = new Phase0LiveMilestoneTracker(); tracker.parentSpawned();
    tracker.observeJsonl(Buffer.from(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "launch-1", toolName: "subagent", args: { background: true, tasks: [{ task: "SECRET_TASK" }] } })}\n${JSON.stringify({ type: "tool_execution_end", toolCallId: "launch-1", toolName: "subagent", isError: false, result: { details: { jobId: "SECRET_JOB" } } })}\n`));
    // Admission is correlated to one bounded start ID; unmatched, error, oversized,
    // and split-line events cannot advance it.
    tracker.observeJsonl(Buffer.from(`${JSON.stringify({ type: "tool_execution_end", toolCallId: "missing", toolName: "subagent", isError: false, result: { details: { jobId: "job" } } })}\n${JSON.stringify({ type: "tool_execution_start", toolCallId: "x".repeat(129), toolName: "subagent", args: { background: true, tasks: [{}] } })}\n${JSON.stringify({ type: "tool_execution_end", toolCallId: "launch-1", toolName: "subagent", isError: true, result: { details: { jobId: "job" } } })}\n`));
    tracker.observeDescendants(1); tracker.observeReadStarts(1); tracker.observeProofs(1); tracker.observeJsonl(Buffer.alloc(20_000, 0x61));
    const summary = tracker.summary(); assert.equal(summary.proofHighWater, 1); assert.equal(tracker.progress(false, 1, 99, { "provider-error": 0, "settled-before-read": 0, "shutdown-before-read": 0, "aborted-before-read": 0 })[0], "proof-observed"); const boundedTracker = new Phase0LiveMilestoneTracker(); boundedTracker.observeProofs(9_999_999); assert.equal(boundedTracker.summary().proofHighWater, 1_000_000);
    assert.equal(JSON.stringify({ summary, progress: tracker.progress(false, 1, 99, { "provider-error": 0, "settled-before-read": 0, "shutdown-before-read": 0, "aborted-before-read": 0 }) }).includes("SECRET"), false);
    // Repeated generic pause/status events remain display telemetry only: they
    // increment parentEvents but cannot reset the authoritative stall clock.
    const noisy = new Phase0LiveMilestoneTracker(); noisy.parentSpawned();
    const terminals = { "provider-error": 0, "settled-before-read": 0, "shutdown-before-read": 0, "aborted-before-read": 0 };
    const pauseAndStatus = Buffer.from(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "pause-1", toolName: "phase0_pause", args: {} })}\n${JSON.stringify({ type: "tool_execution_end", toolCallId: "pause-1", toolName: "phase0_pause", isError: false, result: {} })}\n${JSON.stringify({ type: "tool_execution_start", toolCallId: "status-1", toolName: "subagent", args: { action: "status", id: "job-1" } })}\n${JSON.stringify({ type: "tool_execution_end", toolCallId: "status-1", toolName: "subagent", isError: false, result: {} })}\n`);
    let now = 0;
    const watchdog = new Phase0LiveDiagnosticWatchdog({ config: { intervalMs: 1, stallMs: 10 }, startedAt: 0, now: () => now, progress: () => noisy.progress(false, 0, 0, terminals) }); watchdog.prime();
    now = 5; noisy.observeJsonl(pauseAndStatus); assert.equal(watchdog.tick(), null);
    now = 10; noisy.observeJsonl(pauseAndStatus); assert.match(watchdog.tick()?.message ?? "", /harness deadline exhausted/);
    assert.equal(noisy.summary().parentEventCount, 8);
  });

  test("fails a blind stage only for a bounded admitted terminal lifecycle event and retains no correlation data", async () => {
    const observer = new Phase0BlindStageTerminalObserver(1);
    const waiting = observer.waitForTerminal().then(() => "resolved", (error: unknown) => error);
    const event = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
    // Malformed, unrelated, unadmitted, error, and nonterminal content cannot
    // release the guard. The untrusted task/job text is never exposed by it.
    observer.observeJsonl(Buffer.concat([
      Buffer.from("{bad}\n"),
      event({ type: "custom_message", customType: "subagent_result", details: { jobId: "SECRET_JOB", status: "failed", startedAt: 1, completedAt: 2 } }),
      event({ type: "custom_message", customType: "unrelated", details: { jobId: "SECRET_JOB", status: "failed", startedAt: 1, completedAt: 2 } }),
      event({ type: "tool_execution_start", toolName: "subagent", toolCallId: "launch", args: { background: true, tasks: [{ task: "SECRET_TASK" }] } }),
      event({ type: "tool_execution_end", toolName: "subagent", toolCallId: "launch", isError: true, result: { details: { jobId: "SECRET_JOB" } } }),
    ]));
    assert.equal(await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve("pending"), 10))]), "pending");
    const launch = event({ type: "tool_execution_start", toolName: "subagent", toolCallId: "launch-accepted", args: { background: true, tasks: [{ task: "SECRET_TASK" }] } });
    const admission = event({ type: "tool_execution_end", toolName: "subagent", toolCallId: "launch-accepted", isError: false, result: { details: { jobId: "SECRET_JOB" } } });
    const terminal = event({ type: "custom_message", customType: "subagent_result", details: { jobId: "SECRET_JOB", status: "failed", startedAt: 1, completedAt: 2 }, content: "SECRET_TASK" });
    // Split chunks exercise the incremental bounded JSONL parser.
    observer.observeJsonl(launch); observer.observeJsonl(admission.subarray(0, 17)); observer.observeJsonl(Buffer.concat([admission.subarray(17), terminal]));
    const error = await waiting;
    assert.ok(error instanceof Error); assert.equal(error.message, "Phase 0 stage wait observed a terminal admitted subagent before authenticated read-start.");
    assert.equal(error.message.includes("SECRET"), false);
  });

  test("keeps terminal lifecycle failure armed after topology until authenticated read-start", async () => {
    let resolveTopology!: (value: "topology-ready") => void;
    let rejectTerminal!: (error: Error) => void;
    let abortObserved = false;
    const topology = new Promise<"topology-ready">((resolve) => { resolveTopology = resolve; });
    const terminal = new Promise<never>((_resolve, reject) => { rejectTerminal = reject; });
    const milestone = new Promise<void>(() => undefined);
    const readStarts = new Promise<readonly []>(() => undefined);
    const waiting = awaitPhase0PreReadLifecycle(
      async (signal) => { signal.addEventListener("abort", () => { abortObserved = true; }); return await topology; },
      milestone,
      readStarts,
      terminal,
      new Promise<never>(() => undefined),
    );
    resolveTopology("topology-ready");
    await Promise.resolve();
    rejectTerminal(new Error("terminal-after-topology"));
    await assert.rejects(() => waiting, /terminal-after-topology/);
    assert.equal(abortObserved, true);
  });

  test("uses a fixed hook-free tmux fixture setup environment", () => {
    const setup = tmuxFixtureSetupEnv();
    assert.deepEqual(setup, { PATH: TMUX_FIXTURE_SAFE_PATH, SHELL: "/bin/sh", HOME: "/tmp", TERM: "xterm-256color" });
    assert.equal("BASH_ENV" in setup, false);
    assert.equal("ENV" in setup, false);
    assert.equal("TMUX" in setup, false);
  });

  const tmux37aFixtureTest = process.env.PI_SUBAGENT_REAL_TMUX_37A_FIXTURE === "1" ? test : test.skip;
  tmux37aFixtureTest("gated provider-free tmux 3.7a fixture exercises production probe, gate, snapshot, and exact cleanup", { timeout: 20_000 }, async () => {
    const requestedTmux = process.env.TMUX_BIN?.trim();
    assert.ok(requestedTmux && path.isAbsolute(requestedTmux), "TMUX_BIN must explicitly select the 3.7a fixture executable");
    const root = await createPrivateEvidenceRoot();
    const tmux = captureManagedChildPiExecutableGeneration(requestedTmux!);
    const pi: LivePiExecutable = { bin: "/fixture/no-provider", version: "0.81.1", generation: fixtureGeneration, tmux, cmux: fixtureGeneration };
    const stages: string[] = []; let socketRoot = "";
    const runTmux = async (args: string[]) => {
      const result = await runPiStartup(tmux.executable, args, tmuxFixtureSetupEnv());
      return { exitCode: result.code ?? 1, stdout: result.stdout, stderr: result.stderr };
    };
    try {
      await assert.rejects(
        () => runTmuxCell(root, "/fixture/no-provider-agent", "/fixture/no-provider-extension", pi, 1, "short-response", {
          PATH: "/unsafe-caller-path", SHELL: "/unsafe-caller-shell", BASH_ENV: "/unsafe-hook", ENV: "/unsafe-hook", TMUX: "unsafe", TMUX_PANE: "%9",
        }, {
          afterBinding: async (stage, state) => {
            stages.push(stage); socketRoot = state.socketRoot;
            if (stage === "sentinel") throw new Error("provider-free fixture setup complete");
            if (stage !== "source") return;
            const version = await runTmux(["-V"]);
            assert.equal(version.exitCode, 0); assert.equal(version.stdout.trim(), "tmux 3.7a");
            const source = state.binding.expectedProcesses?.[0];
            if (!source) throw new Error("fixture source process identity is unavailable");
            const sourceProbe = await runTmux(buildTmuxSourcePaneProbeArgs(state.socket));
            const sourcePaneId = sourceProbe.stdout.trim().split("|")[0];
            assert.equal(sourceProbe.exitCode, 0); assert.ok(sourcePaneId && /^%[0-9]+$/.test(sourcePaneId));
            assert.equal(parseTmuxSourcePaneProbe(sourceProbe.stdout, sourcePaneId), source.pid);
            const gate = await createTmuxControlTransportGate({
              runId: "tmux-37a-fixture", executable: tmux.executable, socketPath: state.socket,
              sourcePaneId, serverStartedAt: state.binding.server.startedAt, run: runTmux,
            });
            assert.equal(gate.probeResult.detectedTmuxVersion, "3.7a");
            const snapshot = await inspectTmuxPane({ paneId: sourcePaneId, panePid: source.pid, serverPid: state.binding.server.pid, socketPath: state.socket }, async (args) => {
              const result = await runTmux(args); return { ...result, aborted: false };
            });
            assert.equal(snapshot?.exists, true); assert.equal(snapshot?.panePid, source.pid);
          },
        }),
        (error: unknown) => error instanceof Phase0CellFailure,
      );
      assert.deepEqual(stages, ["creation", "source", "sentinel"]);
      assert.equal(await fs.lstat(socketRoot).catch(() => null), null);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("retains only strict private sanitized failure summaries during recovery scrub", async () => {
    const root = await createPrivateEvidenceRoot(), originalIdentity = await fs.lstat(root);
    const summary = { version: 1 as const, category: "harness-failure" as const, mode: "inline" as const, workload: "short-response" as const, activeRuns: 1, latestMilestone: "proof-observed" as const, monotonic: { parentSpawned: true, parentEventCount: 1, subagentLaunchRequests: 1, backgroundJobAdmissions: 1, descendantHighWater: 1, readStartHighWater: 1, proofHighWater: 1, stagePublished: true }, terminalCounts: { providerError: 0, settledBeforeRead: 0, shutdownBeforeRead: 0, abortedBeforeRead: 0 }, cleanupProven: true };
    try {
      assert.equal(await scrubSensitiveRecoveryArtifacts(root), false); assert.equal(validatePhase0FailureSummary(summary), true); await writePhase0FailureSummary(root, summary); await fs.writeFile(path.join(root, "failure-diagnostics.log"), "SECRET"); await fs.writeFile(path.join(root, "auth.json"), "SECRET");
      await fs.writeFile(path.join(root, "arbitrary.txt"), "SECRET"); await fs.mkdir(path.join(root, "transcript")); await fs.writeFile(path.join(root, "transcript", "stderr"), "SECRET");
      assert.equal(await scrubSensitiveRecoveryArtifacts(root), true); assert.equal((await fs.stat(path.join(root, PHASE0_FAILURE_SUMMARY_FILE))).mode & 0o777, 0o600); assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, PHASE0_FAILURE_SUMMARY_FILE), "utf8")), summary); assert.equal(await fs.lstat(path.join(root, "auth.json")).catch(() => null), null); assert.equal(await fs.lstat(path.join(root, "arbitrary.txt")).catch(() => null), null); assert.equal(await fs.lstat(path.join(root, "transcript")).catch(() => null), null); assert.deepEqual((await fs.readdir(root)).sort(), [PHASE0_FAILURE_SUMMARY_FILE]); const retainedIdentity = await fs.lstat(root); assert.equal(retainedIdentity.dev, originalIdentity.dev); assert.equal(retainedIdentity.ino, originalIdentity.ino); assert.equal(formatPhase0FailureSummary(summary).includes("SECRET"), false);
      await fs.writeFile(path.join(root, PHASE0_FAILURE_SUMMARY_FILE), "{bad", { mode: 0o600 }); assert.equal(await scrubSensitiveRecoveryArtifacts(root), false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("uses deterministic none and known-progress wrapper fallback summaries", () => {
    const origin = { mode: "cmux" as const, workload: "short-response" as const, activeRuns: 4 };
    const beforeParent = phase0WrapperFallbackSummary(origin, true);
    const afterParent = phase0WrapperFallbackSummary(origin, false, true);
    assert.equal(beforeParent.latestMilestone, "none"); assert.deepEqual(beforeParent.monotonic, { parentSpawned: false, parentEventCount: 0, subagentLaunchRequests: 0, backgroundJobAdmissions: 0, descendantHighWater: 0, readStartHighWater: 0, proofHighWater: 0, stagePublished: false });
    assert.equal(afterParent.latestMilestone, "proof-observed"); assert.deepEqual(afterParent.monotonic, { parentSpawned: true, parentEventCount: 4, subagentLaunchRequests: 4, backgroundJobAdmissions: 4, descendantHighWater: 4, readStartHighWater: 4, proofHighWater: 4, stagePublished: true });
    assert.equal(afterParent.cleanupProven, false);
  });

  test("finalizes typed and wrapper-origin failures without raw transport details", async () => {
    const root = await createPrivateEvidenceRoot();
    const summary = { version: 1 as const, category: "deadline-exhausted" as const, mode: "tmux" as const, workload: "short-response" as const, activeRuns: 1, latestMilestone: "parent-spawned" as const, monotonic: { parentSpawned: true, parentEventCount: 0, subagentLaunchRequests: 0, backgroundJobAdmissions: 0, descendantHighWater: 0, readStartHighWater: 0, proofHighWater: 0, stagePublished: false }, terminalCounts: { providerError: 0, settledBeforeRead: 0, shutdownBeforeRead: 0, abortedBeforeRead: 0 }, cleanupProven: true };
    try {
      const primary = new Phase0CellFailure(summary), typedFailedCleanup = await finalizePhase0CellFailure(root, primary, false, { mode: "tmux", workload: "short-response", activeRuns: 1 }), typedCleanCleanup = await finalizePhase0CellFailure(root, primary, true, { mode: "tmux", workload: "short-response", activeRuns: 1 });
      assert.equal(typedFailedCleanup?.summary.category, "deadline-exhausted"); assert.equal(typedFailedCleanup?.summary.latestMilestone, "parent-spawned"); assert.equal(typedFailedCleanup?.summary.cleanupProven, false); assert.equal(typedFailedCleanup?.summaryRetentionProven, true);
      assert.equal(typedCleanCleanup?.summary.category, "deadline-exhausted"); assert.equal(typedCleanCleanup?.summary.cleanupProven, true); assert.equal(typedCleanCleanup?.summaryRetentionProven, true); assert.equal(typedCleanCleanup?.message.includes("summaryRetentionProven"), false);
      const tmuxOrigin = await finalizePhase0CellFailure(root, new Error("raw tmux topology /private/secret"), true, { mode: "tmux", workload: "cancel", activeRuns: 1 });
      const cmuxOrigin = await finalizePhase0CellFailure(root, new Error("raw cmux preservation /private/secret"), false, { mode: "cmux", workload: "external-close", activeRuns: 1 });
      for (const failure of [tmuxOrigin, cmuxOrigin]) {
        assert.ok(failure instanceof Phase0CellFailure); assert.equal(failure!.summary.category, "harness-failure"); assert.equal(failure!.summary.latestMilestone, "none");
        assert.deepEqual(failure!.summary.monotonic, { parentSpawned: false, parentEventCount: 0, subagentLaunchRequests: 0, backgroundJobAdmissions: 0, descendantHighWater: 0, readStartHighWater: 0, proofHighWater: 0, stagePublished: false });
        assert.deepEqual(failure!.summary.terminalCounts, { providerError: 0, settledBeforeRead: 0, shutdownBeforeRead: 0, abortedBeforeRead: 0 }); assert.equal(failure!.message.includes("secret"), false);
      }
      assert.equal(tmuxOrigin!.summary.cleanupProven, true); assert.equal(tmuxOrigin!.summaryRetentionProven, true); assert.equal(cmuxOrigin!.summary.cleanupProven, false); assert.equal(cmuxOrigin!.summary.mode, "cmux");
      assert.equal(JSON.parse(await fs.readFile(path.join(root, PHASE0_FAILURE_SUMMARY_FILE), "utf8")).cleanupProven, false);
      await writePhase0FailureSummary(root, { ...summary, cleanupProven: true }); await fs.chmod(root, 0o500);
      let failedRewrite: Phase0CellFailure | null = null;
      try { failedRewrite = await finalizePhase0CellFailure(root, new Phase0CellFailure(summary, true), true, { mode: "tmux", workload: "short-response", activeRuns: 1 }); }
      finally { await fs.chmod(root, 0o700); }
      assert.equal(failedRewrite?.summary.cleanupProven, false); assert.equal(failedRewrite?.summaryRetentionProven, false);
      assert.equal(JSON.parse(await fs.readFile(path.join(root, PHASE0_FAILURE_SUMMARY_FILE), "utf8")).cleanupProven, true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("classifies setup deadline exhaustion and output-overflow signal precedence without a provider", async () => {
    const root = await createPrivateEvidenceRoot();
    try {
      let thrown: unknown;
      try { await runParentCell(root, "/fixture/agent", "/fixture/extension", fixturePi, 1, "short-response", {}, {}, undefined, true, { expiresAt: Date.now() - 1 }); }
      catch (error) { thrown = error; }
      assert.ok(thrown instanceof Phase0CellFailure); assert.equal(thrown.summary.category, "deadline-exhausted"); assert.equal(thrown.summary.latestMilestone, "none");
      const signal = phase0ChildTerminalFailure({ exitCode: null, signalCode: "SIGKILL" });
      assert.ok(signal); assert.equal(phase0FailureCategory(signal, { timedOut: false, stdoutOverflow: true, stderrOverflow: false }), "stdout-overflow");
      assert.equal(phase0FailureCategory(signal, { timedOut: false, stdoutOverflow: false, stderrOverflow: true }), "stderr-overflow");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("stages only dark.json and light.json beside the validated native Pi and rejects source replacement without a provider", async () => {
    if (process.platform === "win32") return;
    const root = await createPrivateEvidenceRoot(), sourceRoot = await fs.mkdtemp(path.join(os.homedir(), ".phase0-live-native-")), source = path.join(sourceRoot, "pi"), replacement = path.join(sourceRoot, "replacement");
    try {
      await fs.chmod(sourceRoot, 0o700); await fs.copyFile(process.execPath, source); await fs.chmod(source, 0o700); await writeThemePair(sourceRoot); await fs.writeFile(path.join(sourceRoot, "theme", "unlisted.json"), "{}", { mode: 0o600 });
      const generation = captureManagedChildLivePiExecutableGeneration(source);
      const preflight: LivePiExecutable = { bin: generation.executable, version: "0.81.1", generation, tmux: generation, cmux: generation };
      const staged = await stageLivePiExecutable(root, preflight);
      assert.equal(staged.version, preflight.version); assert.equal(staged.bin, path.join(root, "staged-native-pi", "pi")); assert.notEqual(staged.bin, source);
      assert.equal((await fs.stat(path.dirname(staged.bin))).mode & 0o777, 0o700); assert.equal((await fs.stat(staged.bin)).mode & 0o777, 0o700);
      for (const [name, body] of [["dark.json", '{"name":"dark"}\n'], ["light.json", '{"name":"light"}\n']] as const) {
        const asset = path.join(root, "staged-native-pi", "theme", name);
        assert.equal(await fs.readFile(asset, "utf8"), body); assert.equal((await fs.stat(asset)).mode & 0o777, 0o600);
      }
      assert.deepEqual(staged.themeAssets?.map((asset) => asset.relativePath), ["theme/dark.json", "theme/light.json"]); assert.deepEqual((await fs.readdir(path.join(root, "staged-native-pi", "theme"))).sort(), ["dark.json", "light.json"]);
      await revalidateStagedLivePiBundle(staged);
      await fs.copyFile(process.execPath, replacement); await fs.chmod(replacement, 0o700);
      const replacementRoot = await createPrivateEvidenceRoot(), replacementSource = path.join(sourceRoot, "replacement-source");
      await fs.copyFile(process.execPath, replacementSource); await fs.chmod(replacementSource, 0o700); await writeThemePair(path.dirname(replacementSource));
      const replacementGeneration = captureManagedChildLivePiExecutableGeneration(replacementSource);
      await assert.rejects(() => stageLivePiExecutable(replacementRoot, { bin: replacementGeneration.executable, version: "0.81.1", generation: replacementGeneration, tmux: replacementGeneration, cmux: replacementGeneration }, {
        afterSourcePrevalidated: async () => { await fs.rename(replacement, replacementSource); },
      }), /staging failed before provider spawn/);
      assert.equal(await fs.lstat(path.join(replacementRoot, "staged-native-pi")).catch(() => null), null);
      await fs.rm(replacementRoot, { recursive: true, force: true });
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(sourceRoot, { recursive: true, force: true }); }
  });

  test("rejects malformed, invalid UTF-8, oversized, and FIFO source assets before staging", async () => {
    if (process.platform === "win32") return;
    const sourceRoot = await fs.mkdtemp(path.join(os.homedir(), ".phase0-live-theme-source-")), executable = path.join(sourceRoot, "pi");
    try {
      await fs.chmod(sourceRoot, 0o700); await fs.copyFile(process.execPath, executable); await fs.chmod(executable, 0o700);
      const generation = captureManagedChildLivePiExecutableGeneration(executable), preflight: LivePiExecutable = { bin: generation.executable, version: "0.81.1", generation, tmux: generation, cmux: generation };
      const rejectSource = async (dark: string | Buffer, light: string | Buffer = '{"name":"light"}'): Promise<void> => {
        await fs.rm(path.join(sourceRoot, "theme"), { recursive: true, force: true }); await writeThemePair(sourceRoot, dark, light);
        const root = await createPrivateEvidenceRoot();
        try { await assert.rejects(() => stageLivePiExecutable(root, preflight), /staging failed before provider spawn/); assert.equal(await fs.lstat(path.join(root, "staged-native-pi")).catch(() => null), null); }
        finally { await fs.rm(root, { recursive: true, force: true }); }
      };
      await rejectSource('{not-json'); await rejectSource(Buffer.from([0x7b, 0xff, 0x7d]));
      const boundary = JSON.stringify("x".repeat(1024 * 1024 - 2));
      await fs.rm(path.join(sourceRoot, "theme"), { recursive: true, force: true }); await writeThemePair(sourceRoot, boundary);
      const boundaryRoot = await createPrivateEvidenceRoot();
      try { const staged = await stageLivePiExecutable(boundaryRoot, preflight); assert.equal((await fs.stat(staged.themeAssets![0]!.path)).size, 1024 * 1024); }
      finally { await fs.rm(boundaryRoot, { recursive: true, force: true }); }
      await rejectSource(`${boundary} `);
      await fs.rm(path.join(sourceRoot, "theme"), { recursive: true, force: true }); await writeThemePair(sourceRoot); const fifo = path.join(sourceRoot, "theme", "dark.json"); await fs.unlink(fifo);
      const mkfifo = spawnSync("/usr/bin/mkfifo", [fifo]);
      if (mkfifo.status === 0) {
        const root = await createPrivateEvidenceRoot(), startedAt = performance.now();
        try { await assert.rejects(() => stageLivePiExecutable(root, preflight), /staging failed before provider spawn/); assert.ok(performance.now() - startedAt < 1_000, "FIFO source rejection must not block staging"); }
        finally { await fs.rm(root, { recursive: true, force: true }); }
      }
    } finally { await fs.rm(sourceRoot, { recursive: true, force: true }); }
  });

  test("fails closed for missing, symlinked, unsafe, mutated, or replaced staged theme assets", async () => {
    if (process.platform === "win32") return;
    const sourceRoot = await fs.mkdtemp(path.join(os.homedir(), ".phase0-live-theme-")), executable = path.join(sourceRoot, "pi");
    const makePreflight = async (): Promise<LivePiExecutable> => {
      await fs.copyFile(process.execPath, executable); await fs.chmod(executable, 0o700);
      const generation = captureManagedChildLivePiExecutableGeneration(executable);
      return { bin: generation.executable, version: "0.81.1", generation, tmux: generation, cmux: generation };
    };
    try {
      await fs.chmod(sourceRoot, 0o700); const preflight = await makePreflight();
      await assert.rejects(() => revalidateStagedLivePiBundle(preflight), /requires staged theme assets/);
      for (const setup of [
        async () => undefined,
        async () => { await writeThemePair(sourceRoot); await fs.unlink(path.join(sourceRoot, "theme", "light.json")); await fs.symlink("/tmp/not-light", path.join(sourceRoot, "theme", "light.json")); },
        async () => { await writeThemePair(sourceRoot); await fs.chmod(path.join(sourceRoot, "theme", "dark.json"), 0o666); },
      ]) {
        await fs.rm(path.join(sourceRoot, "theme"), { recursive: true, force: true }); await setup(); const root = await createPrivateEvidenceRoot();
        try { await assert.rejects(() => stageLivePiExecutable(root, preflight), /staging failed before provider spawn/); assert.equal(await fs.lstat(path.join(root, "staged-native-pi")).catch(() => null), null); }
        finally { await fs.rm(root, { recursive: true, force: true }); }
      }
      await fs.rm(path.join(sourceRoot, "theme"), { recursive: true, force: true }); await writeThemePair(sourceRoot); const mutationRoot = await createPrivateEvidenceRoot();
      try { await assert.rejects(() => stageLivePiExecutable(mutationRoot, preflight, { afterThemeSourcePrevalidated: async () => { await fs.writeFile(path.join(sourceRoot, "theme", "light.json"), '{"changed":true}', { mode: 0o600 }); } }), /staging failed before provider spawn/); assert.equal(await fs.lstat(path.join(mutationRoot, "staged-native-pi")).catch(() => null), null); }
      finally { await fs.rm(mutationRoot, { recursive: true, force: true }); }
      await fs.rm(path.join(sourceRoot, "theme"), { recursive: true, force: true }); await writeThemePair(sourceRoot); const destinationRoot = await createPrivateEvidenceRoot();
      try {
        await fs.symlink("/tmp", path.join(destinationRoot, "staged-native-pi"));
        await assert.rejects(() => stageLivePiExecutable(destinationRoot, preflight), /staging failed before provider spawn/);
        assert.ok((await fs.lstat(path.join(destinationRoot, "staged-native-pi"))).isSymbolicLink());
      } finally { await fs.rm(destinationRoot, { recursive: true, force: true }); }
      const stagedRoot = await createPrivateEvidenceRoot();
      try {
        const staged = await stageLivePiExecutable(stagedRoot, preflight); await fs.writeFile(staged.themeAssets!.find((asset) => asset.relativePath === "theme/light.json")!.path, '{"changed":true}', { mode: 0o600 });
        await assert.rejects(() => revalidateStagedLivePiBundle(staged), /theme asset changed/);
      } finally { await fs.rm(stagedRoot, { recursive: true, force: true }); }
    } finally { await fs.rm(sourceRoot, { recursive: true, force: true }); }
  });

  (process.platform === "win32" || !process.env[MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV] ? test.skip : test)("stages an installed explicit Pi and initializes provider-free JSON mode", async () => {
    const configured = process.env[MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV]!;
    const root = await createPrivateEvidenceRoot();
    try {
      const preflight = await resolveLivePiExecutable({ [MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV]: configured });
      const staged = await stageLivePiExecutable(root, { ...preflight, tmux: preflight.generation, cmux: preflight.generation });
      const result = await runPiStartup(staged.bin, ["--mode", "json", "--no-context-files", "--no-extensions"], { PATH: "/usr/bin:/bin", HOME: root, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1" });
      assert.equal(result.code, 0, result.stderr);
      const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line) as { type?: unknown });
      assert.ok(events.some((event) => event.type === "session"), "Pi did not emit a normal JSON session event");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("rejects a replaced preflight Pi generation before the credentialed parent spawn", async () => {
    if (process.platform === "win32") return;
    const root = await createPrivateEvidenceRoot(), executableRoot = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-live-")), executable = path.join(executableRoot, "pi"), replacement = path.join(executableRoot, "replacement-pi");
    let spawned = false;
    try {
      await fs.chmod(executableRoot, 0o700);
      await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await fs.chmod(executable, 0o700);
      const generation = captureManagedChildPiExecutableGeneration(executable);
      await fs.writeFile(replacement, "#!/bin/sh\n# replacement\nexit 0\n", { mode: 0o700 }); await fs.chmod(replacement, 0o700); await fs.rename(replacement, executable);
      let thrown: unknown;
      try { await runParentCell(root, "/fixture/agent", "/fixture/extension", { bin: generation.executable, version: "0.81.1", generation, tmux: generation, cmux: generation }, 1, "short-response", { PATH: process.env.PATH }, {}, undefined, true, { expiresAt: Date.now() + 10_000 }, { spawnParent: () => { spawned = true; throw new Error("parent spawn must not run"); } }); }
      catch (error) { thrown = error; }
      assert.ok(thrown instanceof Phase0CellFailure); assert.equal(thrown.summary.category, "harness-failure"); assert.equal(thrown.summary.latestMilestone, "none"); assert.equal(thrown.summary.cleanupProven, true); assert.equal(thrown.summaryRetentionProven, true); assert.equal(spawned, false); assert.equal(thrown.message.includes(executable), false);
      assert.equal(JSON.parse(await fs.readFile(path.join(root, PHASE0_FAILURE_SUMMARY_FILE), "utf8")).category, "harness-failure");
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(executableRoot, { recursive: true, force: true }); }
  });

  test("fails closed with cleanup unproven when a spawned parent PID cannot be identity-bound", async () => {
    if (process.platform === "win32") return;
    const root = await createPrivateEvidenceRoot(), executableRoot = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-live-")), executable = path.join(executableRoot, "pi");
    try {
      await fs.chmod(executableRoot, 0o700); await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await fs.chmod(executable, 0o700);
      const generation = captureManagedChildPiExecutableGeneration(executable), originalKill = process.kill, killTargets: number[] = [];
      let unboundPid: number | null = null, thrown: unknown;
      process.kill = ((pid: number, signal?: number | NodeJS.Signals) => { killTargets.push(pid); return originalKill(pid, signal); }) as typeof process.kill;
      try { await runParentCell(root, "/fixture/agent", "/fixture/extension", { bin: generation.executable, version: "0.81.1", generation, tmux: generation, cmux: generation }, 1, "short-response", { PATH: process.env.PATH }, {}, undefined, true, { expiresAt: Date.now() + 10_000 }, { captureParentStartedAt: (pid) => { unboundPid = pid; return null; }, skipStagedBundleRevalidation: true }); }
      catch (error) { thrown = error; }
      finally { process.kill = originalKill; }
      assert.ok(unboundPid !== null); assert.equal(killTargets.includes(unboundPid), false);
      assert.ok(thrown instanceof Phase0CellFailure); assert.equal(thrown.summary.category, "harness-failure"); assert.equal(thrown.summary.cleanupProven, false); assert.equal(thrown.summaryRetentionProven, true);
      assert.equal(JSON.parse(await fs.readFile(path.join(root, PHASE0_FAILURE_SUMMARY_FILE), "utf8")).cleanupProven, false);
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(executableRoot, { recursive: true, force: true }); }
  });

  test("fails FIFO writer cleanup closed on an unknown identity probe without signalling", async () => {
    const writer = { child: {} as never, identity: { pid: 71, startedAt: 701 } } as Phase0ReleaseWriter;
    const writers = new Set([writer]), originalKill = process.kill, signals: number[] = [];
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => { signals.push(pid); return originalKill(pid, signal); }) as typeof process.kill;
    try {
      await assert.rejects(() => cleanupPhase0ReleaseWriters(writers, { timeoutMs: 0, classify: () => "unknown" }), /cleanup is unproven/);
      assert.equal(writers.has(writer), true);
      assert.deepEqual(signals, []);
    } finally { process.kill = originalKill; }
  });

  test("fails closed on an unknown watchdog while independently terminating only its exact live helper", async () => {
    const watchdog = { pid: 71, startedAt: 701 }, sleepHelper = { pid: 72, startedAt: 702 }, parent = { pid: 73, startedAt: 703 };
    const classifications: number[] = [], signals: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [], originalKill = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => { signals.push({ pid, signal }); return true; }) as typeof process.kill;
    try {
      await assert.rejects(() => terminateExactBootstrapAuthority({ watchdog, sleepHelper }, parent, (identity) => {
        classifications.push(identity.pid);
        return identity.pid === watchdog.pid ? "unknown" : "live";
      }), /watchdog\/helper cleanup was not proven/);
      assert.deepEqual(signals, [{ pid: sleepHelper.pid, signal: "SIGTERM" }]);
      assert.equal(classifications.includes(parent.pid), false);
    } finally { process.kill = originalKill; }
  });

  test("fails closed on an unknown bootstrap parent only after watchdog and helper are proven dead", async () => {
    const watchdog = { pid: 71, startedAt: 701 }, sleepHelper = { pid: 72, startedAt: 702 }, parent = { pid: 73, startedAt: 703 };
    const classifications: number[] = [], signals: number[] = [], originalKill = process.kill;
    process.kill = ((pid: number) => { signals.push(pid); return true; }) as typeof process.kill;
    try {
      await assert.rejects(() => terminateExactBootstrapAuthority({ watchdog, sleepHelper }, parent, (identity) => {
        classifications.push(identity.pid);
        return identity.pid === watchdog.pid || identity.pid === sleepHelper.pid ? "dead" : "unknown";
      }), /parent cleanup was not proven/);
      assert.deepEqual(classifications, [watchdog.pid, watchdog.pid, sleepHelper.pid, parent.pid]);
      assert.deepEqual(signals, []);
    } finally { process.kill = originalKill; }
  });

  test("uses exact SIGTERM watchdog cleanup and requires its helper dead before signalling parent", async () => {
    const watchdog = { pid: 71, startedAt: 701 }, sleepHelper = { pid: 72, startedAt: 702 }, parent = { pid: 73, startedAt: 703 };
    const classifications: number[] = [], signals: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [], originalKill = process.kill;
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => { signals.push({ pid, signal }); return true; }) as typeof process.kill;
    try {
      await terminateExactBootstrapAuthority({ watchdog, sleepHelper }, parent, (identity) => {
        classifications.push(identity.pid);
        if (identity.pid === sleepHelper.pid && signals.some((entry) => entry.pid === watchdog.pid)) return "dead";
        return signals.some((entry) => entry.pid === identity.pid) ? "dead" : "live";
      });
      assert.deepEqual(signals, [{ pid: watchdog.pid, signal: "SIGTERM" }, { pid: parent.pid, signal: "SIGKILL" }]);
      assert.ok(classifications.indexOf(sleepHelper.pid) < classifications.indexOf(parent.pid));
    } finally { process.kill = originalKill; }
  });

  test("attempts provider-child, FIFO, and barrier cleanup after bootstrap cleanup fails", async () => {
    const watchdog = { pid: 74, startedAt: 704 }, sleepHelper = { pid: 75, startedAt: 705 }, parent = { pid: 76, startedAt: 706 }, providerChild = { pid: 77, startedAt: 707 };
    const writer = { child: {} as never, identity: { pid: 73, startedAt: 703 } } as Phase0ReleaseWriter;
    const writers = new Set([writer]), attempts: string[] = [], signals: number[] = [], originalKill = process.kill;
    process.kill = ((pid: number) => { signals.push(pid); return true; }) as typeof process.kill;
    try {
      const failure = await attemptPhase0CleanupSteps([
        async () => { attempts.push("bootstrap"); await terminateExactBootstrapAuthority({ watchdog, sleepHelper }, parent, (identity) => identity.pid === watchdog.pid ? "unknown" : "live"); },
        async () => { attempts.push("provider-child"); await terminateExactPhase0Identities([providerChild], 0, (identity) => signals.includes(identity.pid) ? "dead" : "live"); },
        async () => { attempts.push("writers"); await cleanupPhase0ReleaseWriters(writers, { timeoutMs: 0, classify: () => "dead" }); },
        async () => { attempts.push("barriers"); },
      ]);
      assert.ok(failure instanceof Error);
      assert.deepEqual(attempts, ["bootstrap", "provider-child", "writers", "barriers"]);
      assert.deepEqual(signals, [sleepHelper.pid, providerChild.pid]);
      assert.equal(writers.size, 0);
    } finally { process.kill = originalKill; }
  });

  test("bounds failed process-table probes and treats them as no observation", async () => {
    let timeoutMs = 0;
    assert.deepEqual(processRows({ expiresAt: Date.now() + 50 }, (timeout) => {
      timeoutMs = timeout;
      return { status: null, stdout: "", error: new Error("timed out") };
    }), []);
    assert.ok(timeoutMs > 0 && timeoutMs <= 100);
    let invoked = false;
    assert.deepEqual(processRows({ expiresAt: Date.now() - 1 }, () => { invoked = true; return { status: 0, stdout: "1 0 /bin/pi" }; }), []);
    assert.equal(invoked, false);
    const parent = { pid: 91, startedAt: 901 };
    assert.equal(await discoverExactBootstrapWatchdog(parent, 0, () => processRows(undefined, () => ({ status: null, stdout: "", error: new Error("timed out") })), (pid) => pid === parent.pid ? parent.startedAt : null), null);
  });

  test("requires every tmux fixture identity to be dead before deleting an absent socket root", async () => {
    const makeBinding = async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "phase0-tmux-teardown-"));
      await fs.chmod(root, 0o700);
      const stat = await fs.lstat(root);
      return {
        root,
        binding: {
          server: { pid: 81, startedAt: 801 }, socket: { dev: 0n, ino: 0n },
          socketRoot: { dev: BigInt(stat.dev), ino: BigInt(stat.ino), uid: stat.uid, mode: Number(stat.mode) & 0o777 },
          creationServerPids: [81, 81] as const,
          expectedProcesses: [{ pid: 82, startedAt: 802 }],
        },
      };
    };
    const clean = await makeBinding();
    try {
      await teardownIdentityBoundTmuxServer({ tmux: "/fixture/tmux", socket: path.join(clean.root, "s"), socketRoot: clean.root, binding: clean.binding, timeoutMs: 1, hooks: { classifyIdentity: () => "dead" } });
      assert.equal(await fs.lstat(clean.root).catch(() => null), null);
    } finally { await fs.rm(clean.root, { recursive: true, force: true }); }
    const unknown = await makeBinding(); let commandCalled = false;
    try {
      await assert.rejects(() => teardownIdentityBoundTmuxServer({ tmux: "/fixture/tmux", socket: path.join(unknown.root, "s"), socketRoot: unknown.root, binding: unknown.binding, timeoutMs: 1, hooks: {
        classifyIdentity: (identity) => identity.pid === 81 ? "dead" : "unknown",
        runCommand: async () => { commandCalled = true; return { code: 1, stdout: "" }; },
      } }), /private socket root retained/);
      assert.equal(commandCalled, false);
      assert.ok(await fs.lstat(unknown.root));
    } finally { await fs.rm(unknown.root, { recursive: true, force: true }); }
  });

  test("binds only the exact watchdog/sleep tree and requires tri-state death proof for both", async () => {
    const parent = { pid: 41, startedAt: 101 }, watchdog = { pid: 42, startedAt: 102 }, sleepHelper = { pid: 43, startedAt: 103 };
    const started = new Map([[parent.pid, parent.startedAt], [watchdog.pid, watchdog.startedAt], [sleepHelper.pid, sleepHelper.startedAt]]);
    const rows = [
      { pid: watchdog.pid, ppid: parent.pid, command: "/bin/sh -p -c watchdog" },
      { pid: sleepHelper.pid, ppid: watchdog.pid, command: "/bin/sleep 30" },
    ];
    const exact = await discoverExactBootstrapWatchdog(parent, 0, () => rows, (pid) => started.get(pid) ?? null);
    assert.deepEqual(exact, { watchdog, sleepHelper });
    const ambiguous = await discoverExactBootstrapWatchdog(parent, 0, () => [
      ...rows, { pid: 44, ppid: watchdog.pid, command: "/bin/sleep 30" },
    ], (pid) => started.get(pid) ?? (pid === 44 ? 104 : null));
    assert.equal(ambiguous, null);
    const malformed = await discoverExactBootstrapWatchdog(parent, 0, () => [
      { pid: watchdog.pid, ppid: parent.pid, command: "/bin/sh -p -c watchdog" }, { pid: sleepHelper.pid, ppid: watchdog.pid, command: "/wrong/sleep 30" },
    ], (pid) => started.get(pid) ?? null);
    assert.equal(malformed, null);
    const binding = { watchdog, sleepHelper };
    // No getStartedAt-style evidence is available here: only the tri-state
    // probe may establish exact-live parent plus exact-dead watchdog and helper.
    assert.equal(await awaitExactBootstrapWatchdogDisarm(parent, binding, 0, (identity) => identity.pid === parent.pid ? "live" : "dead"), true);
    assert.equal(await awaitExactBootstrapWatchdogDisarm(parent, binding, 0, (identity) => identity.pid === sleepHelper.pid ? "live" : "dead"), false);
    assert.equal(await awaitExactBootstrapWatchdogDisarm(parent, binding, 0, () => "unknown"), false);
    await assert.rejects(() => terminateExactBootstrapAuthority(binding, null, () => "unknown"), /cleanup was not proven/);
  });

  test("binds the stopped bootstrap watchdog, disarms it, and preserves the exact parent identity through exec", async () => {
    if (process.platform === "win32") return;
    const root = await createPrivateEvidenceRoot(), executableRoot = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-live-")), executable = path.join(executableRoot, "pi");
    await fs.chmod(executableRoot, 0o700); await fs.writeFile(executable, "#!/bin/sh\n/bin/sleep 0.2\nexit 1\n", { mode: 0o700 }); await fs.chmod(executable, 0o700);
    const generation = captureManagedChildPiExecutableGeneration(executable);
    const pi: LivePiExecutable = { bin: generation.executable, version: "0.81.1", generation, tmux: generation, cmux: generation };
    const originalKill = process.kill, signals: Array<{ pid: number; signal: number | NodeJS.Signals | undefined }> = [];
    let resumed: { pid: number; startedAt: number } | null = null, watchdog: { pid: number; startedAt: number } | null = null, sleepHelper: { pid: number; startedAt: number } | null = null, thrown: unknown;
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => { signals.push({ pid, signal }); return originalKill(pid, signal); }) as typeof process.kill;
    try {
      await runParentCell(root, "/fixture/agent", "/fixture/extension", pi, 1, "short-response", { PATH: process.env.PATH }, {}, undefined, true, { expiresAt: Date.now() + 5_000 }, {
        bootstrapBindTimeoutMs: 1_000,
        afterBootstrapWatchdogBound: (_parent, binding) => { watchdog = binding.watchdog; sleepHelper = binding.sleepHelper; },
        afterBootstrapResumed: (identity) => { resumed = identity; },
        skipStagedBundleRevalidation: true,
      });
    } catch (error) { thrown = error; }
    finally { process.kill = originalKill; }
    try {
      const resumedIdentity = resumed as { pid: number; startedAt: number } | null;
      const watchdogIdentity = watchdog as { pid: number; startedAt: number } | null, sleepHelperIdentity = sleepHelper as { pid: number; startedAt: number } | null;
      assert.ok(resumedIdentity); assert.ok(watchdogIdentity); assert.ok(sleepHelperIdentity); assert.ok(resumedIdentity!.pid > 0 && resumedIdentity!.startedAt > 0);
      assert.notEqual(watchdogIdentity!.pid, resumedIdentity!.pid); assert.notEqual(sleepHelperIdentity!.pid, watchdogIdentity!.pid);
      assert.notEqual(getProcessStartedAt(watchdogIdentity!.pid), watchdogIdentity!.startedAt); assert.notEqual(getProcessStartedAt(sleepHelperIdentity!.pid), sleepHelperIdentity!.startedAt);
      assert.ok(signals.some(({ pid, signal }) => pid === resumedIdentity!.pid && signal === "SIGCONT"));
      assert.ok(thrown instanceof Phase0CellFailure); assert.equal(thrown.summary.category, "parent-exit"); assert.equal(thrown.summary.cleanupProven, true);
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(executableRoot, { recursive: true, force: true }); }
  });

  test("failure cleanup uses watchdog SIGTERM, leaves no orphan sleep, and cannot claim proof", async () => {
    if (process.platform === "win32") return;
    const root = await createPrivateEvidenceRoot(), executableRoot = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-live-")), executable = path.join(executableRoot, "pi");
    let watchdog: { pid: number; startedAt: number } | null = null, sleepHelper: { pid: number; startedAt: number } | null = null, thrown: unknown;
    const originalKill = process.kill, signals: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => { signals.push({ pid, signal }); return originalKill(pid, signal); }) as typeof process.kill;
    try {
      await fs.chmod(executableRoot, 0o700); await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await fs.chmod(executable, 0o700);
      const generation = captureManagedChildPiExecutableGeneration(executable);
      try {
        await runParentCell(root, "/fixture/agent", "/fixture/extension", { bin: generation.executable, version: "0.81.1", generation, tmux: generation, cmux: generation }, 1, "short-response", { PATH: process.env.PATH }, {}, undefined, true, { expiresAt: Date.now() + 5_000 }, {
          bootstrapBindTimeoutMs: 1_000,
          afterBootstrapWatchdogBound: (_parent, binding) => { watchdog = binding.watchdog; sleepHelper = binding.sleepHelper; },
          afterBootstrapContinued: (parent) => { process.kill(parent.pid, "SIGKILL"); },
          skipStagedBundleRevalidation: true,
        });
      } catch (error) { thrown = error; }
      const watchdogIdentity = watchdog as { pid: number; startedAt: number } | null, sleepHelperIdentity = sleepHelper as { pid: number; startedAt: number } | null;
      assert.ok(watchdogIdentity); assert.ok(sleepHelperIdentity);
      assert.notEqual(getProcessStartedAt(watchdogIdentity!.pid), watchdogIdentity!.startedAt);
      assert.notEqual(getProcessStartedAt(sleepHelperIdentity!.pid), sleepHelperIdentity!.startedAt, "watchdog trap must reap its /bin/sleep helper");
      assert.ok(signals.some(({ pid, signal }) => pid === watchdogIdentity!.pid && signal === "SIGTERM"));
      assert.equal(signals.some(({ pid, signal }) => pid === watchdogIdentity!.pid && signal === "SIGKILL"), false);
      assert.ok(thrown instanceof Phase0CellFailure); assert.equal(thrown.summary.category, "harness-failure"); assert.equal(thrown.summary.cleanupProven, false);
    } finally { process.kill = originalKill; await fs.rm(root, { recursive: true, force: true }); await fs.rm(executableRoot, { recursive: true, force: true }); }
  });

  test("detaches a long-lived output-writing unbound bootstrap without signalling or retaining its handles", async () => {
    if (process.platform === "win32") return;
    const root = await createPrivateEvidenceRoot(), executableRoot = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-live-")), executable = path.join(executableRoot, "pi");
    let simulated: ReturnType<typeof spawn> | null = null, unboundPid: number | null = null, unrefed = false, thrown: unknown;
    const originalKill = process.kill, killTargets: number[] = [];
    process.kill = ((pid: number, signal?: number | NodeJS.Signals) => { killTargets.push(pid); return originalKill(pid, signal); }) as typeof process.kill;
    try {
      await fs.chmod(executableRoot, 0o700); await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); await fs.chmod(executable, 0o700);
      const generation = captureManagedChildPiExecutableGeneration(executable);
      const beganAt = performance.now();
      try {
        await runParentCell(root, "/fixture/agent", "/fixture/extension", { bin: generation.executable, version: "0.81.1", generation, tmux: generation, cmux: generation }, 1, "short-response", { PATH: process.env.PATH }, {}, undefined, true, { expiresAt: Date.now() + 5_000 }, {
          // This deterministic no-provider surrogate intentionally ignores the
          // received stopped-bootstrap argv, but verifies the harness requested
          // /bin/sh before simulating a watchdog-owned, noisy unbound process.
          spawnParent: ((command: string, _args: readonly string[], options: any) => {
            assert.equal(command, "/bin/sh");
            simulated = spawn("/bin/sh", ["-c", "( /bin/sleep 1; command kill -KILL $$ ) & while :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; /bin/sleep 0.01; done"], options);
            const originalUnref = simulated.unref.bind(simulated);
            simulated.unref = (() => { unrefed = true; return originalUnref(); }) as typeof simulated.unref;
            return simulated;
          }) as typeof spawn,
          captureParentStartedAt: (pid) => { unboundPid = pid; return null; },
          bootstrapBindTimeoutMs: 20,
          skipStagedBundleRevalidation: true,
        });
      } catch (error) { thrown = error; }
      assert.ok(performance.now() - beganAt < 1_000, "unbound cleanup waited for the production watchdog");
      assert.ok(unboundPid !== null); assert.equal(killTargets.includes(unboundPid!), false);
      const simulatedChild = simulated as ReturnType<typeof spawn> | null;
      assert.ok(simulatedChild); assert.equal(unrefed, true); assert.equal(simulatedChild!.stdout!.destroyed, true); assert.equal(simulatedChild!.stderr!.destroyed, true);
      assert.ok(thrown instanceof Phase0CellFailure); assert.equal(thrown.summary.cleanupProven, false); assert.equal(thrown.summary.category, "harness-failure");
      assert.equal(JSON.parse(await fs.readFile(path.join(root, PHASE0_FAILURE_SUMMARY_FILE), "utf8")).cleanupProven, false);
    } finally { process.kill = originalKill; await fs.rm(root, { recursive: true, force: true }); await fs.rm(executableRoot, { recursive: true, force: true }); }
  });

  test("keeps the captured parent-exit category when cleanup later crosses the deadline", async () => {
    if (process.platform === "win32") return;
    const root = await createPrivateEvidenceRoot(), executableRoot = await fs.mkdtemp(path.join(os.homedir(), ".managed-child-pi-live-")), executable = path.join(executableRoot, "pi"), deadline = { expiresAt: Date.now() + 10_000 };
    try {
      await fs.chmod(executableRoot, 0o700); await fs.writeFile(executable, "#!/bin/sh\nsleep 0.1\nexit 1\n", { mode: 0o700 }); await fs.chmod(executable, 0o700);
      const generation = captureManagedChildPiExecutableGeneration(executable);
      let thrown: unknown;
      try { await runParentCell(root, "/fixture/agent", "/fixture/extension", { bin: generation.executable, version: "0.81.1", generation, tmux: generation, cmux: generation }, 1, "short-response", { PATH: process.env.PATH }, {}, undefined, true, deadline, { afterPrimaryFailureCaptured: () => { deadline.expiresAt = Date.now() - 1; }, skipStagedBundleRevalidation: true }); }
      catch (error) { thrown = error; }
      assert.ok(thrown instanceof Phase0CellFailure); assert.equal(thrown.summary.category, "parent-exit", JSON.stringify(thrown.summary)); assert.equal(thrown.summary.cleanupProven, true);
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(executableRoot, { recursive: true, force: true }); }
  });

  test("restricts smoke to one authorized cell and exposes root cleanup/scrub seams without a provider", async () => {
    await assert.rejects(() => executeLiveSmoke("cmux", 16, "short-response", { PI_SUBAGENT_PHASE0_LIVE_SMOKE: "1" }), /invalid or unauthorized live smoke/);
    let successRoot = "", dispatched = "";
    const fake = async () => { const { mode: _mode, sourceAndSentinelPreserved: _preserved, ...result } = cell("inline", 1, "short-response"); return result; };
    await executeLiveSmoke("inline", 1, "short-response", { PI_SUBAGENT_PHASE0_LIVE_SMOKE: "1" }, { preflight: async () => fixturePi, stagePi: bypassPiStaging, createRoot: async () => successRoot = await createPrivateEvidenceRoot(), prepareAgentDirectory: async () => "/fixture/agent", writeSyntheticParent: async () => "/fixture/parent", runCell: async (_root, _agent, _extension, _bin, mode, activeRuns, workload) => { dispatched = `${mode}:${activeRuns}:${workload}`; return fake(); } });
    assert.equal(dispatched, "inline:1:short-response"); assert.equal(await fs.lstat(successRoot).catch(() => null), null);
    let failedRoot = "";
    try { await assert.rejects(() => executeLiveSmoke("inline", 1, "short-response", { PI_SUBAGENT_PHASE0_LIVE_SMOKE: "1" }, { preflight: async () => fixturePi, stagePi: bypassPiStaging, createRoot: async () => failedRoot = await createPrivateEvidenceRoot(), prepareAgentDirectory: async () => "/fixture/agent", writeSyntheticParent: async () => "/fixture/parent", runCell: async (root) => { await writePhase0FailureSummary(root, { version: 1, category: "harness-failure", mode: "inline", workload: "short-response", activeRuns: 1, latestMilestone: "none", monotonic: { parentSpawned: false, parentEventCount: 0, subagentLaunchRequests: 0, backgroundJobAdmissions: 0, descendantHighWater: 0, readStartHighWater: 0, proofHighWater: 0, stagePublished: false }, terminalCounts: { providerError: 0, settledBeforeRead: 0, shutdownBeforeRead: 0, abortedBeforeRead: 0 }, cleanupProven: false }); await fs.writeFile(path.join(root, "failure-diagnostics.log"), "SECRET"); throw new Error("injected"); } }), /injected/); assert.equal(await fs.lstat(failedRoot).catch(() => null), null); }
    finally { if (failedRoot) await fs.rm(failedRoot, { recursive: true, force: true }); }
  });

  test("removes smoke and benchmark roots after a failed final-summary rewrite", async () => {
    const roots: string[] = [];
    const finalWriteFailure = async (root: string): Promise<Phase0CellFailure> => {
      const stale = phase0WrapperFallbackSummary({ mode: "inline", workload: "idle-wait", activeRuns: 1 }, true, true);
      await writePhase0FailureSummary(root, stale); await fs.chmod(root, 0o500);
      try {
        const failure = await finalizePhase0CellFailure(root, new Phase0CellFailure(stale, true), true, { mode: "inline", workload: "idle-wait", activeRuns: 1 });
        assert.ok(failure); assert.equal(failure.summaryRetentionProven, false);
        return failure;
      } finally { await fs.chmod(root, 0o700); }
    };
    const createRoot = async (): Promise<string> => { const root = await createPrivateEvidenceRoot(); roots.push(root); return root; };
    try {
      await assert.rejects(() => executeLiveSmoke("inline", 1, "short-response", { PI_SUBAGENT_PHASE0_LIVE_SMOKE: "1" }, { preflight: async () => fixturePi, stagePi: bypassPiStaging, createRoot, prepareAgentDirectory: async () => "/fixture/agent", writeSyntheticParent: async () => "/fixture/parent", runCell: async (root) => { throw await finalWriteFailure(root); } }));
      const source = { sourceRevision: "unknown" as const, sourceDirty: true, worktreeDigest: "e".repeat(64) };
      await assert.rejects(() => executeLiveBenchmark({ execute: true, tier: ROUTINE_TIER_ID }, { [LIVE_GATE]: "1" }, { preflight: async () => fixturePi, stagePi: bypassPiStaging, capturedSource: () => source, createRoot, prepareAgentDirectory: async () => "/fixture/agent", writeSyntheticParent: async () => "/fixture/parent", runCell: async (root) => { throw await finalWriteFailure(root); } }));
      await Promise.all(roots.map(async (root) => assert.equal(await fs.lstat(root).catch(() => null), null)));
    } finally { await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); }
  });

  test("rejects a preexisting symlink agent directory", async () => {
    const root = await createPrivateEvidenceRoot(), source = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-phase0-auth-"));
    try {
      await fs.writeFile(path.join(source, "auth.json"), "auth", { mode: 0o600 });
      await fs.symlink(source, path.join(root, "agent"));
      await assert.rejects(() => prepareAgentDirectory(root, { PI_CODING_AGENT_DIR: source }), /must not preexist/);
    } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(source, { recursive: true, force: true }); }
  });

  test("records both fixed destinations with durable atomic overwrite and failure cleanup", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-phase0-record-"));
    try {
      spawnSync("git", ["init", "-q", root]); spawnSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]); spawnSync("git", ["-C", root, "config", "user.name", "test"]); await fs.writeFile(path.join(root, "source.ts"), "source\n"); spawnSync("git", ["-C", root, "add", "."]); spawnSync("git", ["-C", root, "commit", "-qm", "source"]);
      const current = currentLiveSourceIdentity(root), routine = evidence(ROUTINE_TIER_ID, current), concurrency = evidence(CMUX_CONCURRENCY_TIER_ID, current);
      await assert.rejects(() => recordLiveFixture(routine, {}, root), /LIVE_RECORD/);
      const routineDestination = await recordLiveFixture(routine, { [LIVE_RECORD_GATE]: "1" }, root);
      const concurrencyDestination = await recordLiveFixture(concurrency, { [LIVE_RECORD_GATE]: "1" }, root);
      assert.equal(routineDestination, path.join(root, "test/fixtures/transport-performance-phase0-live-routine.json")); assert.equal(concurrencyDestination, path.join(root, "test/fixtures/transport-performance-phase0-live-concurrency.json"));
      assert.equal((await fs.stat(routineDestination)).mode & 0o777, 0o600); assert.equal((await fs.stat(concurrencyDestination)).mode & 0o777, 0o600);
      await recordLiveFixture(routine, { [LIVE_RECORD_GATE]: "1" }, root);
      assert.equal(JSON.parse(await fs.readFile(routineDestination, "utf8")).tier, ROUTINE_TIER_ID);
      await assert.rejects(() => recordLiveFixture(routine, { [LIVE_RECORD_GATE]: "1" }, root, { rename: async () => { throw new Error("rename failed"); } }), /rename failed/);
      await assert.rejects(() => recordLiveFixture(routine, { [LIVE_RECORD_GATE]: "1" }, root, { syncDirectory: async () => { throw new Error("directory fsync failed"); } }), /directory fsync failed/);
      const fixtureDirectory = path.dirname(routineDestination);
      assert.deepEqual((await fs.readdir(fixtureDirectory)).filter((name) => name.includes(".tmp")), []);
      routine.environment.worktreeDigest = "0".repeat(64); await assert.rejects(() => recordLiveFixture(routine, { [LIVE_RECORD_GATE]: "1" }, root), /source identity/);
      await fs.rm(fixtureDirectory, { recursive: true, force: true }); await fs.symlink(path.join(root, "source.ts"), fixtureDirectory);
      await assert.rejects(() => recordLiveFixture(concurrency, { [LIVE_RECORD_GATE]: "1" }, root), /ENOTDIR|component|unsafe/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
