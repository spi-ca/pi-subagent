import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  CHILD_MODEL, CMUX_CONCURRENCY_TIER_ID, LIVE_ACKNOWLEDGEMENTS, LIVE_CMUX16_ACKNOWLEDGEMENT, LIVE_CMUX16_GATE,
  LIVE_GATE, LIVE_RECORD_GATE, ROUTINE_TIER_ID, createPrivateEvidenceRoot, expectedChildRunCount, expectedLiveCells,
  livePlan, loadLiveCheckpoint, parseArgs, requireLiveGate, validateLiveCheckpoint, validateLiveEvidence,
  claimLiveCheckpoint, writeLiveCheckpoint, type CellEvidence, type LiveEvidence,
} from "./performance-phase0-live/evidence";
import { currentLiveSourceIdentity, executeLiveBenchmark, executeLiveSmoke, recordLiveFixture, type LiveBenchmarkTestHooks } from "./performance-phase0-live";

const measured = (mode: "tmux" | "cmux") => ({ source: `authoritative-live-artifact:transport-${mode}` as const, availability: "measured" as const, backendRequests: 1, backendSpawns: 1, requestBacklogHighWater: 1, lineBacklogHighWater: 1, byteBacklogHighWater: 1, controlDisconnects: 0, reconnects: 0, unknownOutcomes: 0, exactSnapshots: 1, exactCleanupMutations: 1, residualRecovery: 0, persistentClientCreates: 1, persistentClientRestarts: 0, healthyPeriodicStatusQueries: 0, notificationToReconcileLatencyMs: 0, lifecycleCompletionLatencyMs: 1 });
const inline = () => { const value = { notApplicable: true as const, reason: "inline-no-interactive-transport" as const }; return { source: "not-applicable:inline" as const, availability: "not-applicable" as const, backendRequests: value, backendSpawns: value, requestBacklogHighWater: value, lineBacklogHighWater: value, byteBacklogHighWater: value, controlDisconnects: value, reconnects: value, unknownOutcomes: value, exactSnapshots: value, exactCleanupMutations: value, residualRecovery: value, persistentClientCreates: value, persistentClientRestarts: value, healthyPeriodicStatusQueries: value, notificationToReconcileLatencyMs: value, lifecycleCompletionLatencyMs: value }; };
function cell(mode: "inline" | "tmux" | "cmux", activeRuns: 1 | 16, workload: "idle-wait" | "short-response" | "long-response" | "cancel" | "external-close"): CellEvidence {
  return { mode, activeRuns, workload, timing: { monotonicElapsedMs: 2, settlementLatencyMs: 1, eventLoopDelayMeanMs: 0, eventLoopDelayMaxMs: 0, eventLoopDelayP99Ms: 0 }, parent: { cpuDeltaMs: 1, peakRssKiB: 1 }, descendants: { peakCount: activeRuns, peakIdentities: Array.from({ length: activeRuns }, (_, i) => ({ pid: i + 1, startedAt: i + 1 })), verifiedProviderIdentities: Array.from({ length: activeRuns }, (_, i) => ({ pid: i + 1, startedAt: i + 1 })), resources: { cumulativeCpuMs: 1, peakAggregateCpuMs: 1, peakAggregateRssKiB: 1, peakIndividualRssKiB: 1 } }, backend: { topologyProbeCount: mode === "inline" ? 0 : activeRuns, transportCounters: mode === "inline" ? inline() : measured(mode) }, verifiedProviderChildren: activeRuns, settlement: workload === "idle-wait" ? "observed-then-cancelled" : workload === "cancel" ? "cancelled" : workload === "external-close" ? "externally-closed" : "settled", requestedProvider: "openai-codex", requestedModel: CHILD_MODEL, observedProvider: "openai-codex", observedModel: "gpt-5.4-mini", cleanup: { result: "clean", residualDescendantCount: 0, residualBackendTargetCount: 0 }, sourceAndSentinelPreserved: true };
}
function evidence(tier: typeof ROUTINE_TIER_ID | typeof CMUX_CONCURRENCY_TIER_ID, source: { sourceRevision: "unknown" | string; sourceDirty: boolean; worktreeDigest: string } = { sourceRevision: "unknown", sourceDirty: true, worktreeDigest: "a".repeat(64) }): LiveEvidence {
  const plan = livePlan(tier); return { schemaVersion: 4, tier, planId: plan.planId, planDigest: plan.planDigest, phase: "M0-live", evidenceKind: "gated-provider-transport-benchmark", capturedAt: new Date().toISOString(), environment: { os: "darwin", arch: "arm64", bunVersion: "1", piVersion: "1", ...source }, requested: { provider: "openai-codex", model: CHILD_MODEL, childRuns: plan.childRuns }, matrix: expectedLiveCells(tier).map((entry) => cell(entry.mode, entry.activeRuns, entry.workload)), cleanup: { result: "clean", evidenceRoot: "private-0700", evidenceFile: "private-0600", residualDescendantCount: 0, residualBackendTargetCount: 0 } };
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

  test("uses source-bound v3 checkpoints and rejects old, cross-tier, or concurrency partial checkpoints", async () => {
    const root = await createPrivateEvidenceRoot(), source = { sourceRevision: "unknown" as const, sourceDirty: true, worktreeDigest: "b".repeat(64) }, routine = livePlan(ROUTINE_TIER_ID), concurrency = livePlan(CMUX_CONCURRENCY_TIER_ID);
    try {
      const checkpoint = { version: 3 as const, tier: ROUTINE_TIER_ID, planId: routine.planId, planDigest: routine.planDigest, ...source, childRuns: 15, cells: [evidence(ROUTINE_TIER_ID, source).matrix[0]!] };
      assert.equal(validateLiveCheckpoint(checkpoint), true); await writeLiveCheckpoint(root, checkpoint); assert.deepEqual(await loadLiveCheckpoint(root), checkpoint);
      assert.equal(validateLiveCheckpoint({ ...checkpoint, version: 2 } as any), false);
      assert.equal(validateLiveCheckpoint({ ...checkpoint, tier: CMUX_CONCURRENCY_TIER_ID } as any), false);
      assert.equal(validateLiveCheckpoint({ version: 3, tier: CMUX_CONCURRENCY_TIER_ID, planId: concurrency.planId, planDigest: concurrency.planDigest, ...source, childRuns: 16, cells: [cell("cmux", 16, "short-response"), cell("cmux", 16, "short-response")] }), false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("runs every acknowledged cell once and makes cleanup failures terminal", async () => {
    const roots: string[] = [], source = { sourceRevision: "unknown" as const, sourceDirty: true, worktreeDigest: "c".repeat(64) }, calls: string[] = [];
    const hooks: LiveBenchmarkTestHooks = { preflight: async () => ({ bin: "/fixture/pi", version: "1" }), capturedSource: () => source, createRoot: async () => { const root = await createPrivateEvidenceRoot(); roots.push(root); return root; }, prepareAgentDirectory: async () => "/fixture/agent", writeSyntheticParent: async () => "/fixture/parent", runCell: async (_root, _agent, _extension, _bin, mode, activeRuns, workload) => { calls.push(`${mode}:${activeRuns}:${workload}`); const { mode: _mode, sourceAndSentinelPreserved: _preserved, ...result } = cell(mode, activeRuns, workload); return result; } };
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
    const hooks: LiveBenchmarkTestHooks = { preflight: async () => ({ bin: "/fixture/pi", version: "1" }), capturedSource: () => source, claimCheckpoint: async (root) => { const claimed = await claimLiveCheckpoint(root); claimedRoot = claimed; roots.push(claimed); return claimed; }, createRoot: async () => { const root = await createPrivateEvidenceRoot(); roots.push(root); return root; }, prepareAgentDirectory: async () => "/fixture/agent", writeSyntheticParent: async () => "/fixture/parent", runCell: async () => { throw new Error("injected cleanup failure"); } };
    const checkpoint = { version: 3 as const, tier: ROUTINE_TIER_ID, planId: plan.planId, planDigest: plan.planDigest, ...source, childRuns: plan.childRuns, cells: [] };
    const original = await createPrivateEvidenceRoot(); roots.push(original); await writeLiveCheckpoint(original, checkpoint);
    try {
      await assert.rejects(() => executeLiveBenchmark({ execute: true, tier: ROUTINE_TIER_ID, resumeLiveRoot: original }, { [LIVE_GATE]: "1" }, hooks), /injected cleanup failure/);
      // The original inode was atomically consumed before runCell was invoked,
      // so neither failure nor a later invocation can replay it.
      await assert.rejects(() => loadLiveCheckpoint(original), /live checkpoint root|live checkpoint file/);
      assert.ok(claimedRoot);
      await assert.rejects(() => loadLiveCheckpoint(claimedRoot!), /live checkpoint file/);
      await assert.rejects(() => executeLiveBenchmark({ execute: true, tier: ROUTINE_TIER_ID, resumeLiveRoot: original }, { [LIVE_GATE]: "1" }, hooks), /live checkpoint root|claim failed/);
    } finally { await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true }))); }
  });

  test("restricts exported smoke to active-runs=1", async () => {
    await assert.rejects(() => executeLiveSmoke("cmux", 16, "short-response", { PI_SUBAGENT_PHASE0_LIVE_SMOKE: "1" }), /invalid or unauthorized live smoke/);
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
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
