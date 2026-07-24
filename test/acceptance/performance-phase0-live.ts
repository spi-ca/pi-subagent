import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_BENCHMARK_EVIDENCE_FIXTURES, currentWorktreeSourceIdentity } from "./worktree-source-identity";
import {
  CHILD_MODEL, CMUX_CONCURRENCY_TIER_ID, LIVE_ACKNOWLEDGEMENTS, LIVE_GATE, LIVE_TIER_IDS, ROUTINE_TIER_ID,
  claimLiveCheckpoint, createPrivateEvidenceRoot, expectedChildRunCount, expectedLiveCells, livePlan, loadLiveCheckpoint, parseArgs,
  preflightLiveBenchmark, preflightLivePrerequisites, requireCurrentCheckpointSource, requireLiveGate,
  scrubSensitiveRecoveryArtifacts, terminalizeLiveCheckpoint, validateLiveCheckpointCell, validateLiveEvidence, writeLiveCheckpoint,
  writePrivateEvidence, type ActiveRun, type CellEvidence, type LiveCheckpoint, type LiveEvidence, type LiveMode,
  type LiveOptions, type LivePiExecutable, type LiveTierId, type Workload,
} from "./performance-phase0-live/evidence.js";
import { prepareAgentDirectory, runParentCell, writeSyntheticParent } from "./performance-phase0-live/cell.js";
import { runTmuxCell } from "./performance-phase0-live/tmux-fixture.js";
import { runCmuxCell } from "./performance-phase0-live/cmux-fixture.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LIVE_ROUTINE_EVIDENCE_FIXTURE = "test/fixtures/transport-performance-phase0-live-routine.json";
export const LIVE_CONCURRENCY_EVIDENCE_FIXTURE = "test/fixtures/transport-performance-phase0-live-concurrency.json";
export function liveFixturePath(tier: LiveTierId): string { return tier === ROUTINE_TIER_ID ? LIVE_ROUTINE_EVIDENCE_FIXTURE : LIVE_CONCURRENCY_EVIDENCE_FIXTURE; }
export function currentLiveSourceIdentity(root = ROOT): { sourceRevision: "unknown" | string; sourceDirty: boolean; worktreeDigest: string } { return currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES); }
export function verifyCurrentLiveEvidence(value: unknown, tier?: LiveTierId): value is LiveEvidence {
  if (!validateLiveEvidence(value) || (tier !== undefined && value.tier !== tier)) return false;
  const identity = currentLiveSourceIdentity();
  return value.environment.sourceRevision === identity.sourceRevision && value.environment.sourceDirty === identity.sourceDirty && value.environment.worktreeDigest === identity.worktreeDigest;
}
export function verifyCurrentRoutineLiveEvidence(value: unknown): value is LiveEvidence { return verifyCurrentLiveEvidence(value, ROUTINE_TIER_ID); }
export function verifyCurrentCmuxConcurrencyLiveEvidence(value: unknown): value is LiveEvidence { return verifyCurrentLiveEvidence(value, CMUX_CONCURRENCY_TIER_ID); }
export type RecordLiveFixtureTestHooks = { rename?: (from: string, to: string) => Promise<void>; syncDirectory?: (directory: string) => Promise<void> };
function sameFileIdentity(left: { dev: number; ino: number } | null, right: { dev: number; ino: number } | null): boolean { return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino; }
async function syncRecordedFixtureDirectory(directory: string): Promise<void> {
  const before = await fs.lstat(directory).catch(() => null);
  if (!before?.isDirectory() || before.isSymbolicLink()) throw new Error("fixture destination directory is unsafe");
  const handle = await fs.open(directory, "r");
  try {
    const opened = await handle.stat();
    if (!sameFileIdentity(before, opened) || !sameFileIdentity(before, await fs.lstat(directory).catch(() => null))) throw new Error("fixture destination directory identity changed before fsync");
    await handle.sync();
  } finally { await handle.close(); }
}
/** Fixed-path recorder: no caller-controlled destination, complete source-bound evidence only, atomic 0600 replacement. */
export async function recordLiveFixture(evidence: LiveEvidence, env: NodeJS.ProcessEnv = process.env, root = ROOT, hooks: RecordLiveFixtureTestHooks = {}): Promise<string> {
  if (env.PI_SUBAGENT_PHASE0_LIVE_RECORD !== "1") throw new Error("PI_SUBAGENT_PHASE0_LIVE_RECORD=1 is required to record a fixture");
  if (!validateLiveEvidence(evidence)) throw new Error("refusing to record invalid tier evidence");
  const identity = currentLiveSourceIdentity(root);
  if (evidence.environment.sourceRevision !== identity.sourceRevision || evidence.environment.sourceDirty !== identity.sourceDirty || evidence.environment.worktreeDigest !== identity.worktreeDigest) throw new Error("refusing to record evidence not bound to the current source identity");
  const destination = path.resolve(root, liveFixturePath(evidence.tier));
  if (path.relative(root, destination).startsWith("..") || path.isAbsolute(path.relative(root, destination))) throw new Error("fixed fixture destination escaped repository");
  const directory = path.dirname(destination); await fs.mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`);
    await handle.sync();
    await fs.chmod(temporary, 0o600);
    await handle.close(); handle = null;
    await (hooks.rename ?? fs.rename)(temporary, destination);
    await (hooks.syncDirectory ?? syncRecordedFixtureDirectory)(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return destination;
}

export async function executeLiveSmoke(mode: LiveMode, activeRuns: ActiveRun, workload: Workload, env: NodeJS.ProcessEnv = process.env): Promise<Omit<CellEvidence, "mode" | "sourceAndSentinelPreserved">> {
  if (env.PI_SUBAGENT_PHASE0_LIVE_SMOKE !== "1" || !["inline", "tmux", "cmux"].includes(mode) || activeRuns !== 1 || !expectedLiveCells(ROUTINE_TIER_ID).some((cell) => cell.workload === workload)) throw new Error("invalid or unauthorized live smoke");
  const pi = await preflightLivePrerequisites(env), root = await createPrivateEvidenceRoot(); let succeeded = false;
  try { const agent = await prepareAgentDirectory(root), extension = await writeSyntheticParent(root); const result = mode === "inline" ? await runParentCell(root, agent, extension, pi.bin, activeRuns, workload) : mode === "tmux" ? await runTmuxCell(root, agent, extension, pi.bin, activeRuns, workload) : await runCmuxCell(root, agent, extension, pi.bin, activeRuns, workload); succeeded = true; return result; }
  finally { if (succeeded) await fs.rm(root, { recursive: true, force: true }); else if (!await scrubSensitiveRecoveryArtifacts(root)) await fs.rm(root, { recursive: true, force: true }); }
}

type LiveCellResult = Omit<CellEvidence, "mode" | "sourceAndSentinelPreserved">;
export type LiveBenchmarkTestHooks = { preflight?: (env: NodeJS.ProcessEnv) => Promise<LivePiExecutable>; capturedSource?: () => { sourceRevision: "unknown" | string; sourceDirty: boolean; worktreeDigest: string }; claimCheckpoint?: (root: string) => Promise<string>; createRoot?: () => Promise<string>; prepareAgentDirectory?: (root: string) => Promise<string>; writeSyntheticParent?: (root: string) => Promise<string>; runCell?: (root: string, agent: string, extension: string, piBin: string, mode: LiveMode, activeRuns: ActiveRun, workload: Workload) => Promise<LiveCellResult>; };
export type LiveBenchmarkResult = { mode: "completed"; evidence: LiveEvidence; evidenceFile: string; recordedFixture?: string; resumedRoot?: string } | { phase: "M0-live"; tier: LiveTierId; mode: "checkpointed"; checkpoint: string; completedCells: number; totalCells: number; resumedRoot?: string };

export async function executeLiveBenchmark(options: LiveOptions, env: NodeJS.ProcessEnv = process.env, hooks: LiveBenchmarkTestHooks = {}): Promise<LiveBenchmarkResult> {
  requireLiveGate(options, env); if (!options.execute || !options.tier) throw new Error("live execution requires --execute-live and --tier");
  const tier = options.tier, plan = livePlan(tier), pi = await (hooks.preflight ?? preflightLivePrerequisites)(env), source = hooks.capturedSource?.() ?? currentLiveSourceIdentity();
  // Claim first: a supplied root can never remain a reusable checkpoint once
  // this invocation is allowed to reach a provider-backed cell.
  const claimedResumeRoot = options.resumeLiveRoot ? await (hooks.claimCheckpoint ?? claimLiveCheckpoint)(options.resumeLiveRoot) : undefined;
  const resumed = claimedResumeRoot ? await loadLiveCheckpoint(claimedResumeRoot) : null;
  if (resumed) requireCurrentCheckpointSource(resumed, source, tier);
  if (tier === CMUX_CONCURRENCY_TIER_ID && resumed && resumed.cells.length === 0) throw new Error("cmux concurrency tier does not accept a partial resume");
  const createRoot = hooks.createRoot ?? createPrivateEvidenceRoot, runtimeRoot = claimedResumeRoot ?? await createRoot(), evidenceRoot = await createRoot(); let completed = false;
  try {
    const checkpoint: LiveCheckpoint = resumed ?? { version: 3, tier, planId: plan.planId, planDigest: plan.planDigest, sourceRevision: source.sourceRevision, sourceDirty: source.sourceDirty, worktreeDigest: source.worktreeDigest, childRuns: plan.childRuns, cells: [] };
    if (!resumed) await writeLiveCheckpoint(runtimeRoot, checkpoint);
    const agent = await (hooks.prepareAgentDirectory ?? prepareAgentDirectory)(runtimeRoot), extension = await (hooks.writeSyntheticParent ?? writeSyntheticParent)(runtimeRoot), matrix: CellEvidence[] = [...checkpoint.cells]; let newCells = 0;
    for (let index = matrix.length; index < plan.cells.length; index += 1) {
      if (options.maxCells !== undefined && newCells >= options.maxCells) break;
      const cellPlan = plan.cells[index]!; console.error(`live progress tier=${tier} index=${index + 1}/${plan.cells.length} mode=${cellPlan.mode} count=${cellPlan.activeRuns} workload=${cellPlan.workload}`);
      // An attempted provider cell has no replay checkpoint. Only a completed
      // cell (or an intentional max-cells boundary before this loop) is resumable.
      await terminalizeLiveCheckpoint(runtimeRoot);
      const candidate = hooks.runCell ? await hooks.runCell(runtimeRoot, agent, extension, pi.bin, cellPlan.mode, cellPlan.activeRuns, cellPlan.workload) : cellPlan.mode === "inline" ? await runParentCell(runtimeRoot, agent, extension, pi.bin, cellPlan.activeRuns, cellPlan.workload) : cellPlan.mode === "tmux" ? await runTmuxCell(runtimeRoot, agent, extension, pi.bin, cellPlan.activeRuns, cellPlan.workload) : await runCmuxCell(runtimeRoot, agent, extension, pi.bin, cellPlan.activeRuns, cellPlan.workload);
      if (!validateLiveCheckpointCell({ mode: cellPlan.mode, ...candidate, sourceAndSentinelPreserved: true })) throw new Error("live cell evidence failed strict validation");
      matrix.push({ mode: cellPlan.mode, ...candidate, sourceAndSentinelPreserved: true }); newCells += 1; await writeLiveCheckpoint(runtimeRoot, { ...checkpoint, cells: matrix });
    }
    if (matrix.length < plan.cells.length) { if (!await scrubSensitiveRecoveryArtifacts(runtimeRoot)) { await fs.rm(runtimeRoot, { recursive: true, force: true }); throw new Error("runtime root removed because secret scrubbing was unproven"); } await fs.rm(evidenceRoot, { recursive: true, force: true }); return { phase: "M0-live", tier, mode: "checkpointed", checkpoint: runtimeRoot, completedCells: matrix.length, totalCells: plan.cells.length, ...(claimedResumeRoot ? { resumedRoot: claimedResumeRoot } : {}) }; }
    const residualDescendantCount = matrix.reduce((count, cell) => count + cell.cleanup.residualDescendantCount, 0), residualBackendTargetCount = matrix.reduce((count, cell) => count + cell.cleanup.residualBackendTargetCount, 0);
    if (residualDescendantCount !== 0 || residualBackendTargetCount !== 0) throw new Error("live benchmark cleanup retained residual identities or backend targets");
    const evidence: LiveEvidence = { schemaVersion: 4, tier, planId: plan.planId, planDigest: plan.planDigest, phase: "M0-live", evidenceKind: "gated-provider-transport-benchmark", capturedAt: new Date().toISOString(), environment: { os: process.platform, arch: process.arch, bunVersion: process.versions.bun ?? "unavailable", piVersion: pi.version, ...source }, requested: { provider: "openai-codex", model: CHILD_MODEL, childRuns: plan.childRuns }, matrix, cleanup: { result: "clean", evidenceRoot: "private-0700", evidenceFile: "private-0600", residualDescendantCount, residualBackendTargetCount } };
    const evidenceFile = await writePrivateEvidence(evidenceRoot, evidence); const recordedFixture = options.recordFixture ? await recordLiveFixture(evidence, env) : undefined; completed = true; return { mode: "completed", evidence, evidenceFile, ...(recordedFixture ? { recordedFixture } : {}), ...(claimedResumeRoot ? { resumedRoot: claimedResumeRoot } : {}) }; 
  } catch (error) { const scrubbed = await scrubSensitiveRecoveryArtifacts(runtimeRoot); if (!scrubbed) await fs.rm(runtimeRoot, { recursive: true, force: true }); await fs.rm(evidenceRoot, { recursive: true, force: true }).catch(() => undefined); throw error; }
  finally { if (completed) await fs.rm(runtimeRoot, { recursive: true, force: true }); }
}
export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, hooks: LiveBenchmarkTestHooks = {}): Promise<void> { const options = parseArgs(argv); if (!options.execute) { await preflightLiveBenchmark(); console.log(JSON.stringify({ phase: "M0-live", mode: "preflight", mutation: "none", tiers: LIVE_TIER_IDS })); return; } const result = await executeLiveBenchmark(options, env, hooks); console.log(JSON.stringify(result.mode === "checkpointed" ? { phase: result.phase, tier: result.tier, mode: result.mode, checkpoint: result.checkpoint, completedCells: result.completedCells, totalCells: result.totalCells } : { phase: "M0-live", tier: result.evidence.tier, mode: "executed", evidence: result.evidenceFile, cells: result.evidence.matrix.length, ...(result.recordedFixture ? { fixture: result.recordedFixture } : {}) })); }
export * from "./performance-phase0-live/evidence.js";
export { aggregateTransportTelemetry, deriveSettlementFromToolResults, monitorPhase0ReadStartMilestones, phase0CumulativeLaunchCooldownMs, phase0HarnessLimits, phase0LaunchCooldownMs, phase0StageMilestones, phase0TaskChunks, PHASE0_MAX_BACKGROUND_JOBS, PHASE0_MAX_TASKS_PER_BACKGROUND_JOB, PHASE0_PROCESS_LOCAL_SCHEDULER_HEADROOM, PHASE0_SINGLE_CHILD_LAUNCH_COOLDOWN_MS, PHASE0_SYNTHETIC_PARENT_ROOT_LEASES, verifyNaturalResults, verifyPhase0LaunchCooldownBudget, verifyPhase0LaunchProtocol, verifyTmuxV3TransportProofs } from "./performance-phase0-live/cell.js";
export { teardownIdentityBoundTmuxServer } from "./performance-phase0-live/tmux-fixture.js";
if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
