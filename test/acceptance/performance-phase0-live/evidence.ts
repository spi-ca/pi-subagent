import * as crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MINIMUM_CMUX_VERSION, MINIMUM_TMUX_VERSION, isStableSemverAtLeast, isStableTmuxVersionAtLeast, parseCmuxVersionOutput, parsePiVersionOutput, parseTmuxVersionOutput } from "../../../src/runtime/version-policy.mjs";
import { classifyParentProcessIdentity, getProcessStartedAt, type ProcessIdentityStatus } from "../../../src/runtime/run-protocol.js";
import { findCanonicalCmuxIdentity } from "../live-harness.js";
import { MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV, MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION, captureManagedChildLivePiExecutableGeneration, captureManagedChildPiExecutableGeneration, resolveManagedChildLiveAcceptancePiExecutable, revalidateManagedChildPiExecutableGeneration, type ManagedChildPiExecutableGeneration } from "../managed-child-pi-executable.js";

export const LIVE_GATE = "PI_SUBAGENT_PHASE0_LIVE";
export const LIVE_RECORD_GATE = "PI_SUBAGENT_PHASE0_LIVE_RECORD";
export const LIVE_CMUX16_GATE = "PI_SUBAGENT_PHASE0_LIVE_CMUX16";
export const CHILD_MODEL = "openai-codex/gpt-5.4-mini";
export const LIVE_MODES = ["inline", "tmux", "cmux"] as const;
export const WORKLOADS = ["idle-wait", "short-response", "long-response", "cancel", "external-close"] as const;
/** Routine tier cardinality; active-16 exists only in the explicit concurrency tier. */
export const ACTIVE_RUN_MATRIX = [1] as const;
export const SUPPORTED_ACTIVE_RUNS = [1, 4, 8, 16] as const;
export const ROUTINE_TIER_ID = "routine-v1" as const;
export const CMUX_CONCURRENCY_TIER_ID = "cmux-concurrency-16-v1" as const;
export const LIVE_TIER_IDS = [ROUTINE_TIER_ID, CMUX_CONCURRENCY_TIER_ID] as const;
export type LiveTierId = typeof LIVE_TIER_IDS[number];
export type LiveMode = typeof LIVE_MODES[number];
export type Workload = typeof WORKLOADS[number];
export type ActiveRun = 1 | 16;
export type SupportedActiveRun = typeof SUPPORTED_ACTIVE_RUNS[number];
export type CellDeadline = { readonly expiresAt: number };
export const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_LIVE_STDOUT_BYTES = 64 * 1024 * 1024;
export const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const CELL_TIMEOUT_MS = 300_000;
const CELL_TIMEOUT_PER_ACTIVE_RUN_MS = 75_000;
export const PHASE0_LIVE_SETTLEMENT_MARGIN_MS = CELL_TIMEOUT_MS;
export const TMUX_SOURCE_SENTINEL_LIFETIME_SECONDS = 1_800;
export const LIVE_ACKNOWLEDGEMENTS = {
  [ROUTINE_TIER_ID]: "--ack-provider-child-runs=15",
  [CMUX_CONCURRENCY_TIER_ID]: "--ack-provider-child-runs=16",
} as const;
export const LIVE_CMUX16_ACKNOWLEDGEMENT = "--ack-cmux-active-runs=16";
/** Compatibility export; live execution now requires the tier-specific acknowledgement. */
export const LIVE_ACKNOWLEDGEMENT = LIVE_ACKNOWLEDGEMENTS[ROUTINE_TIER_ID];

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordJson = Record<string, Json>;
export type Metric = number | "unavailable";
export type NotApplicable = { notApplicable: true; reason: "inline-no-interactive-transport" };
export type TransportMetric = number | NotApplicable;
export const TRANSPORT_METRICS = ["backendRequests", "backendSpawns", "requestBacklogHighWater", "lineBacklogHighWater", "byteBacklogHighWater", "controlDisconnects", "reconnects", "unknownOutcomes", "exactSnapshots", "exactCleanupMutations", "residualRecovery", "persistentClientCreates", "persistentClientRestarts", "healthyPeriodicStatusQueries", "notificationToReconcileLatencyMs", "lifecycleCompletionLatencyMs"] as const;
export type ProcessIdentity = { pid: number; startedAt: number };
export type TransportCounters = { source: "not-applicable:inline" | `authoritative-live-artifact:${string}`; availability: "not-applicable" | "measured"; [key: string]: TransportMetric | string };
export type ChildResources = { cumulativeCpuMs: Metric; peakAggregateCpuMs: Metric; peakAggregateRssKiB: Metric; peakIndividualRssKiB: Metric };
export type CellEvidence = {
  mode: LiveMode; activeRuns: number; workload: Workload;
  timing: { monotonicElapsedMs: number; settlementLatencyMs: number; eventLoopDelayMeanMs: Metric; eventLoopDelayMaxMs: Metric; eventLoopDelayP99Ms: Metric };
  parent: { cpuDeltaMs: Metric; peakRssKiB: Metric };
  descendants: { peakCount: number; peakIdentities: ProcessIdentity[]; verifiedProviderIdentities: ProcessIdentity[]; resources: ChildResources };
  backend: { topologyProbeCount: number; transportCounters: TransportCounters };
  verifiedProviderChildren: number;
  settlement: "settled" | "cancelled" | "observed-then-cancelled" | "externally-closed";
  requestedProvider: "openai-codex"; requestedModel: typeof CHILD_MODEL;
  observedProvider: string | "unavailable"; observedModel: string | "unavailable";
  cleanup: { result: "clean"; residualDescendantCount: number; residualBackendTargetCount: number };
  sourceAndSentinelPreserved: boolean;
};
type PlanCell = { mode: LiveMode; activeRuns: ActiveRun; workload: Workload };
const routineCells: readonly PlanCell[] = LIVE_MODES.flatMap((mode) => WORKLOADS.map((workload) => ({ mode, activeRuns: 1 as const, workload })));
const concurrencyCells: readonly PlanCell[] = [{ mode: "cmux", activeRuns: 16, workload: "short-response" }];
export type LivePlan = { tier: LiveTierId; planId: string; planDigest: string; childRuns: number; cells: readonly PlanCell[] };
function makePlan(tier: LiveTierId, cells: readonly PlanCell[]): LivePlan {
  const immutableCells = cells.map((cell) => Object.freeze({ ...cell }));
  const planId = `phase0-live-${tier}`;
  const childRuns = immutableCells.reduce((sum, cell) => sum + cell.activeRuns, 0);
  const planDigest = crypto.createHash("sha256").update(JSON.stringify({ schema: 4, tier, planId, childRuns, cells: immutableCells })).digest("hex");
  return Object.freeze({ tier, planId, planDigest, childRuns, cells: Object.freeze(immutableCells) });
}
const PLANS: Record<LiveTierId, LivePlan> = {
  [ROUTINE_TIER_ID]: makePlan(ROUTINE_TIER_ID, routineCells),
  [CMUX_CONCURRENCY_TIER_ID]: makePlan(CMUX_CONCURRENCY_TIER_ID, concurrencyCells),
};
export function livePlan(tier: LiveTierId): LivePlan { return PLANS[tier]; }
export function expectedLiveCells(tier: LiveTierId = ROUTINE_TIER_ID): PlanCell[] { return livePlan(tier).cells.map((cell) => ({ ...cell })); }
export function expectedChildRunCount(tier: LiveTierId = ROUTINE_TIER_ID): number { return livePlan(tier).childRuns; }
export const EXPECTED_PROVIDER_CHILD_RUNS = expectedChildRunCount(ROUTINE_TIER_ID);

export type LiveEvidenceBase<T extends LiveTierId> = {
  schemaVersion: 4; tier: T; planId: string; planDigest: string; phase: "M0-live"; evidenceKind: "gated-provider-transport-benchmark"; capturedAt: string;
  environment: { os: string; arch: string; bunVersion: string; piVersion: string; sourceRevision: "unknown" | string; sourceDirty: boolean; worktreeDigest: string };
  requested: { provider: "openai-codex"; model: typeof CHILD_MODEL; childRuns: number };
  matrix: CellEvidence[];
  cleanup: { result: "clean"; evidenceRoot: "private-0700"; evidenceFile: "private-0600"; residualDescendantCount: number; residualBackendTargetCount: number };
};
export type RoutineLiveEvidence = LiveEvidenceBase<typeof ROUTINE_TIER_ID>;
export type ConcurrencyLiveEvidence = LiveEvidenceBase<typeof CMUX_CONCURRENCY_TIER_ID>;
export type LiveEvidence = RoutineLiveEvidence | ConcurrencyLiveEvidence;
export type LiveOptions = { execute: boolean; tier?: LiveTierId; resumeLiveRoot?: string; maxCells?: number; recordFixture?: boolean };
/** Preflight captures each explicitly selected backend executable generation. */
export type LiveBackendExecutables = { tmux: ManagedChildPiExecutableGeneration; cmux: ManagedChildPiExecutableGeneration };
export type LivePiGeneration = { bin: string; version: string; generation: ManagedChildPiExecutableGeneration };
/** Preflight's exact Pi generation must be staged before every credentialed cell spawn. */
export type LivePiExecutable = LivePiGeneration & LiveBackendExecutables;

export function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
export function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(), expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
export function safeNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function safeText(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && /^[a-z0-9._/-]+$/i.test(value); }
export function isSourceRevision(value: unknown): value is "unknown" | string { return value === "unknown" || typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value); }
export function expectedLiveSettlement(workload: Workload): CellEvidence["settlement"] { return workload === "short-response" || workload === "long-response" ? "settled" : workload === "cancel" ? "cancelled" : workload === "idle-wait" ? "observed-then-cancelled" : "externally-closed"; }
function metric(value: unknown): value is Metric { return value === "unavailable" || safeNumber(value); }
function identities(value: unknown, count: number): value is ProcessIdentity[] { return Array.isArray(value) && value.length === count && value.every((entry) => record(entry) && exact(entry, ["pid", "startedAt"]) && Number.isSafeInteger(entry.pid) && (entry.pid as number) > 0 && safeNumber(entry.startedAt)) && new Set(value.map((entry) => `${(entry as ProcessIdentity).pid}:${(entry as ProcessIdentity).startedAt}`)).size === count; }
function validTransport(mode: LiveMode, entry: unknown): entry is TransportCounters {
  if (!record(entry) || !exact(entry, ["source", "availability", ...TRANSPORT_METRICS])) return false;
  if (entry.availability === "not-applicable") return mode === "inline" && entry.source === "not-applicable:inline" && TRANSPORT_METRICS.every((field) => record(entry[field]) && exact(entry[field] as Record<string, unknown>, ["notApplicable", "reason"]) && (entry[field] as NotApplicable).notApplicable === true && (entry[field] as NotApplicable).reason === "inline-no-interactive-transport");
  return entry.availability === "measured" && mode !== "inline" && entry.source === `authoritative-live-artifact:transport-${mode}` && TRANSPORT_METRICS.every((field) => safeNumber(entry[field]));
}
/** Validates a complete clean cell independently; plan membership/order is checked by tier validators. */
export function validateLiveCheckpointCell(value: unknown): value is CellEvidence {
  if (!record(value) || !exact(value, ["mode", "activeRuns", "workload", "timing", "parent", "descendants", "backend", "verifiedProviderChildren", "settlement", "requestedProvider", "requestedModel", "observedProvider", "observedModel", "cleanup", "sourceAndSentinelPreserved"])
    || !LIVE_MODES.includes(value.mode as LiveMode) || !Number.isSafeInteger(value.activeRuns) || !safeNumber(value.activeRuns) || !WORKLOADS.includes(value.workload as Workload)
    || !record(value.timing) || !exact(value.timing, ["monotonicElapsedMs", "settlementLatencyMs", "eventLoopDelayMeanMs", "eventLoopDelayMaxMs", "eventLoopDelayP99Ms"]) || !safeNumber(value.timing.monotonicElapsedMs) || !safeNumber(value.timing.settlementLatencyMs) || !metric(value.timing.eventLoopDelayMeanMs) || !metric(value.timing.eventLoopDelayMaxMs) || !metric(value.timing.eventLoopDelayP99Ms)
    || !record(value.parent) || !exact(value.parent, ["cpuDeltaMs", "peakRssKiB"]) || !metric(value.parent.cpuDeltaMs) || !metric(value.parent.peakRssKiB)
    || !record(value.descendants) || !exact(value.descendants, ["peakCount", "peakIdentities", "verifiedProviderIdentities", "resources"]) || !Number.isInteger(value.descendants.peakCount) || !safeNumber(value.descendants.peakCount) || !identities(value.descendants.peakIdentities, value.descendants.peakCount) || !identities(value.descendants.verifiedProviderIdentities, value.activeRuns as number)
    || !record(value.descendants.resources) || !exact(value.descendants.resources, ["cumulativeCpuMs", "peakAggregateCpuMs", "peakAggregateRssKiB", "peakIndividualRssKiB"]) || !metric(value.descendants.resources.cumulativeCpuMs) || !metric(value.descendants.resources.peakAggregateCpuMs) || !metric(value.descendants.resources.peakAggregateRssKiB) || !metric(value.descendants.resources.peakIndividualRssKiB)
    || !record(value.backend) || !exact(value.backend, ["topologyProbeCount", "transportCounters"]) || !Number.isInteger(value.backend.topologyProbeCount) || !safeNumber(value.backend.topologyProbeCount) || !validTransport(value.mode as LiveMode, value.backend.transportCounters)
    || value.verifiedProviderChildren !== value.activeRuns || !Number.isInteger(value.verifiedProviderChildren) || value.settlement !== expectedLiveSettlement(value.workload as Workload) || value.requestedProvider !== "openai-codex" || value.requestedModel !== CHILD_MODEL || !(value.observedProvider === "unavailable" || safeText(value.observedProvider)) || !(value.observedModel === "unavailable" || safeText(value.observedModel))
    || !record(value.cleanup) || !exact(value.cleanup, ["result", "residualDescendantCount", "residualBackendTargetCount"]) || value.cleanup.result !== "clean" || value.cleanup.residualDescendantCount !== 0 || value.cleanup.residualBackendTargetCount !== 0 || value.sourceAndSentinelPreserved !== true) return false;
  if ((value.workload === "short-response" || value.workload === "long-response") && (value.observedProvider !== "openai-codex" || value.observedModel !== "gpt-5.4-mini")) return false;
  const counters = value.backend.transportCounters;
  if (value.mode === "inline") return value.descendants.peakCount >= value.activeRuns && value.backend.topologyProbeCount === 0;
  return value.backend.topologyProbeCount >= value.activeRuns && [counters.backendRequests, counters.exactSnapshots, counters.persistentClientCreates].every((entry) => typeof entry === "number" && entry > 0) && counters.unknownOutcomes === 0 && counters.residualRecovery === 0 && counters.healthyPeriodicStatusQueries === 0 && typeof counters.persistentClientRestarts === "number" && typeof counters.reconnects === "number" && (value.mode === "tmux" ? counters.persistentClientRestarts === 0 : counters.persistentClientRestarts <= value.activeRuns && counters.reconnects === counters.persistentClientRestarts);
}
function hasOrderedCells(cells: unknown, plan: LivePlan, complete: boolean): cells is CellEvidence[] {
  return Array.isArray(cells) && (complete ? cells.length === plan.cells.length : cells.length <= plan.cells.length) && cells.every((cell, index) => validateLiveCheckpointCell(cell) && cell.mode === plan.cells[index]!.mode && cell.activeRuns === plan.cells[index]!.activeRuns && cell.workload === plan.cells[index]!.workload);
}
export function validateLiveEvidence(value: unknown): value is LiveEvidence {
  if (!record(value) || !exact(value, ["schemaVersion", "tier", "planId", "planDigest", "phase", "evidenceKind", "capturedAt", "environment", "requested", "matrix", "cleanup"]) || value.schemaVersion !== 4 || !LIVE_TIER_IDS.includes(value.tier as LiveTierId) || value.phase !== "M0-live" || value.evidenceKind !== "gated-provider-transport-benchmark" || typeof value.capturedAt !== "string") return false;
  const plan = livePlan(value.tier as LiveTierId);
  return value.planId === plan.planId && value.planDigest === plan.planDigest && record(value.environment) && exact(value.environment, ["os", "arch", "bunVersion", "piVersion", "sourceRevision", "sourceDirty", "worktreeDigest"]) && [value.environment.os, value.environment.arch, value.environment.bunVersion, value.environment.piVersion].every((part) => typeof part === "string" && !/(?:secret|token|key|password)/i.test(part)) && isSourceRevision(value.environment.sourceRevision) && typeof value.environment.sourceDirty === "boolean" && typeof value.environment.worktreeDigest === "string" && /^[0-9a-f]{64}$/.test(value.environment.worktreeDigest) && record(value.requested) && exact(value.requested, ["provider", "model", "childRuns"]) && value.requested.provider === "openai-codex" && value.requested.model === CHILD_MODEL && value.requested.childRuns === plan.childRuns && hasOrderedCells(value.matrix, plan, true) && record(value.cleanup) && exact(value.cleanup, ["result", "evidenceRoot", "evidenceFile", "residualDescendantCount", "residualBackendTargetCount"]) && value.cleanup.result === "clean" && value.cleanup.evidenceRoot === "private-0700" && value.cleanup.evidenceFile === "private-0600" && value.cleanup.residualDescendantCount === 0 && value.cleanup.residualBackendTargetCount === 0;
}
export function validateRoutineLiveEvidence(value: unknown): value is RoutineLiveEvidence { return validateLiveEvidence(value) && value.tier === ROUTINE_TIER_ID; }
export function validateCmuxConcurrencyLiveEvidence(value: unknown): value is ConcurrencyLiveEvidence { return validateLiveEvidence(value) && value.tier === CMUX_CONCURRENCY_TIER_ID; }
export type LiveCheckpoint = { version: 4; tier: LiveTierId; planId: string; planDigest: string; piVersion: string; sourceRevision: "unknown" | string; sourceDirty: boolean; worktreeDigest: string; childRuns: number; cells: CellEvidence[] };
const LIVE_CHECKPOINT_FILE = "phase0-live-checkpoint.json";
const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
export function validateLiveCheckpoint(value: unknown): value is LiveCheckpoint {
  if (!record(value) || !exact(value, ["version", "tier", "planId", "planDigest", "piVersion", "sourceRevision", "sourceDirty", "worktreeDigest", "childRuns", "cells"]) || value.version !== 4 || !LIVE_TIER_IDS.includes(value.tier as LiveTierId) || !isStableSemverAtLeast(value.piVersion, MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION) || !isSourceRevision(value.sourceRevision) || typeof value.sourceDirty !== "boolean" || typeof value.worktreeDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.worktreeDigest)) return false;
  const plan = livePlan(value.tier as LiveTierId);
  if (value.planId !== plan.planId || value.planDigest !== plan.planDigest || value.childRuns !== plan.childRuns || !hasOrderedCells(value.cells, plan, false)) return false;
  return plan.tier !== CMUX_CONCURRENCY_TIER_ID || value.cells.length === 0 || value.cells.length === 1;
}
export function requireCurrentCheckpointSource(checkpoint: LiveCheckpoint, source: { sourceRevision: string; sourceDirty: boolean; worktreeDigest: string }, tier?: LiveTierId): void {
  if (tier !== undefined && checkpoint.tier !== tier) throw new Error("live checkpoint tier does not match the selected tier");
  if (checkpoint.sourceRevision !== source.sourceRevision || checkpoint.sourceDirty !== source.sourceDirty || checkpoint.worktreeDigest !== source.worktreeDigest) throw new Error("live checkpoint source identity does not match the current checkout");
}
/** Completed cells are resumable only under the exact preflight Pi version that ran them. */
export function requireCurrentCheckpointPiVersion(checkpoint: LiveCheckpoint, piVersion: string): void {
  if (checkpoint.piVersion !== piVersion) throw new Error("live checkpoint Pi version does not match the current preflight");
}
export function parseArgs(argv: string[]): LiveOptions {
  if (argv.length === 0) return { execute: false };
  const tierArgs = argv.filter((arg) => arg.startsWith("--tier=")); const resume = argv.filter((arg) => arg.startsWith("--resume-live-root=")); const maxCells = argv.filter((arg) => arg.startsWith("--max-cells="));
  const allowed = new Set(["--execute-live", "--record-fixture", ...tierArgs, ...resume, ...maxCells, ...Object.values(LIVE_ACKNOWLEDGEMENTS), LIVE_CMUX16_ACKNOWLEDGEMENT]);
  const usage = "usage: performance-phase0-live.ts --execute-live --tier=<routine-v1|cmux-concurrency-16-v1> --ack-provider-child-runs=<15|16> [--ack-cmux-active-runs=16] [--resume-live-root=<absolute>] [--max-cells=<1..15>] [--record-fixture]";
  if (argv.some((arg) => !allowed.has(arg)) || argv.filter((arg) => arg === "--execute-live").length !== 1 || argv.filter((arg) => arg === "--record-fixture").length > 1 || tierArgs.length !== 1 || resume.length > 1 || maxCells.length > 1) throw new Error(usage);
  const tier = tierArgs[0]!.slice(7); if (!LIVE_TIER_IDS.includes(tier as LiveTierId)) throw new Error(usage);
  const plan = livePlan(tier as LiveTierId), acknowledgement = LIVE_ACKNOWLEDGEMENTS[plan.tier];
  if (argv.filter((arg) => arg === acknowledgement).length !== 1 || Object.values(LIVE_ACKNOWLEDGEMENTS).some((ack) => ack !== acknowledgement && argv.includes(ack)) || (plan.tier === CMUX_CONCURRENCY_TIER_ID ? argv.filter((arg) => arg === LIVE_CMUX16_ACKNOWLEDGEMENT).length !== 1 : argv.includes(LIVE_CMUX16_ACKNOWLEDGEMENT))) throw new Error("live tier acknowledgement flags must exactly match the selected tier");
  const resumeLiveRoot = resume[0]?.slice("--resume-live-root=".length); if (resumeLiveRoot !== undefined && (!path.isAbsolute(resumeLiveRoot) || path.normalize(resumeLiveRoot) !== resumeLiveRoot)) throw new Error("resume live root must be an absolute canonical path");
  const rawMax = maxCells[0]?.slice("--max-cells=".length); let maxCellsValue: number | undefined;
  if (rawMax !== undefined) { const parsed = Number(rawMax); if (!/^[1-9]\d*$/.test(rawMax) || !Number.isSafeInteger(parsed) || parsed > plan.cells.length || plan.tier === CMUX_CONCURRENCY_TIER_ID) throw new Error("max cells is permitted only for routine tier in 1..15"); maxCellsValue = parsed; }
  return { execute: true, tier: plan.tier, ...(resumeLiveRoot === undefined ? {} : { resumeLiveRoot }), ...(maxCellsValue === undefined ? {} : { maxCells: maxCellsValue }), ...(argv.includes("--record-fixture") ? { recordFixture: true } : {}) };
}
export function requireLiveGate(options: LiveOptions, env: NodeJS.ProcessEnv = process.env): void {
  if (!options.execute) { if (options.tier || options.maxCells || options.recordFixture || options.resumeLiveRoot) throw new Error("live tier options require execution"); return; }
  if (!options.tier) throw new Error("live execution requires an exact tier selector");
  if (env[LIVE_GATE] !== "1") throw new Error(`${LIVE_GATE}=1 is required for provider-backed child runs`);
  if (options.tier === CMUX_CONCURRENCY_TIER_ID && env[LIVE_CMUX16_GATE] !== "1") throw new Error(`${LIVE_CMUX16_GATE}=1 is required for cmux active-runs=16`);
  if (options.recordFixture && env[LIVE_RECORD_GATE] !== "1") throw new Error(`${LIVE_RECORD_GATE}=1 is required to record a fixture`);
  if (options.tier === CMUX_CONCURRENCY_TIER_ID && options.maxCells !== undefined) throw new Error("cmux concurrency tier does not allow partial resume");
}
export function phase0CellDeadlineMs(activeRuns: number): number { return CELL_TIMEOUT_MS + activeRuns * CELL_TIMEOUT_PER_ACTIVE_RUN_MS; }
export function createCellDeadline(activeRuns: number): CellDeadline { return { expiresAt: Date.now() + phase0CellDeadlineMs(activeRuns) }; }
export function remainingDeadlineMs(deadline: CellDeadline): number { return deadline.expiresAt - Date.now(); }
/** Fixed discriminator for every harness deadline, never a raw operation error. */
export class Phase0DeadlineExhaustedError extends Error { constructor() { super("Phase 0 harness deadline exhausted."); } }
export function requireRemainingDeadline(deadline: CellDeadline, _operation: string): number { const remaining = remainingDeadlineMs(deadline); if (remaining <= 0) throw new Phase0DeadlineExhaustedError(); return remaining; }
export async function preflightLiveBenchmark(): Promise<void> { const runtime = await fs.stat(process.execPath); if (!runtime.isFile()) throw new Error("benchmark runtime is not a regular file"); for (const tier of LIVE_TIER_IDS) if (expectedChildRunCount(tier) !== (tier === ROUTINE_TIER_ID ? 15 : 16)) throw new Error("unexpected tier plan cardinality"); }
export function resolveLiveBackendExecutable(env: NodeJS.ProcessEnv, name: "TMUX_BIN" | "CMUX_BIN"): ManagedChildPiExecutableGeneration {
  const requested = env[name]?.trim();
  if (!requested || !path.isAbsolute(requested)) throw new Error(`live benchmark requires explicit absolute ${name}`);
  try { return captureManagedChildPiExecutableGeneration(requested); }
  catch { throw new Error(`live benchmark ${name} is not a canonical safe executable`); }
}

export async function preflightLivePrerequisites(env: NodeJS.ProcessEnv): Promise<LivePiExecutable> {
  await preflightLiveBenchmark();
  if (process.platform !== "darwin") throw new Error("the endpoint cmux live matrix requires macOS");
  const pi = await resolveLivePiExecutable(env), tmuxGeneration = resolveLiveBackendExecutable(env, "TMUX_BIN"), cmuxGeneration = resolveLiveBackendExecutable(env, "CMUX_BIN");
  const tmux = await run(tmuxGeneration.executable, ["-V"], { env });
  const tmuxVersion = tmux.code === 0 ? parseTmuxVersionOutput(tmux.stdout) : null;
  if (!tmuxVersion || !isStableTmuxVersionAtLeast(tmuxVersion, MINIMUM_TMUX_VERSION)) throw new Error(`live benchmark requires stable tmux >=${MINIMUM_TMUX_VERSION}`);
  revalidateManagedChildPiExecutableGeneration(tmuxGeneration);
  const cmux = await run(cmuxGeneration.executable, ["--version"], { env });
  const cmuxVersion = cmux.code === 0 ? parseCmuxVersionOutput(cmux.stdout) : null;
  if (!cmuxVersion || !isStableSemverAtLeast(cmuxVersion, MINIMUM_CMUX_VERSION)) throw new Error(`live benchmark requires stable cmux >=${MINIMUM_CMUX_VERSION}`);
  revalidateManagedChildPiExecutableGeneration(cmuxGeneration);
  const workspaceId = env.CMUX_WORKSPACE_ID?.trim(), surfaceId = env.CMUX_SURFACE_ID?.trim();
  if (!workspaceId || !surfaceId || !env.CMUX_SOCKET_PATH) throw new Error("live benchmark requires a canonical cmux caller environment");
  const tree = await run(cmuxGeneration.executable, ["--json", "--id-format", "both", "tree", "--workspace", workspaceId], { env });
  revalidateManagedChildPiExecutableGeneration(cmuxGeneration);
  if (tree.code !== 0 || !findCanonicalCmuxIdentity(tree.stdout, workspaceId, surfaceId)) throw new Error("live benchmark cmux caller preflight failed");
  const authPath = path.join(env.PI_CODING_AGENT_DIR?.trim() || path.join(env.HOME?.trim() || "/nonexistent", ".pi", "agent"), "auth.json"), auth = await fs.lstat(authPath).catch(() => null);
  if (!auth?.isFile() || auth.isSymbolicLink() || auth.size <= 0 || auth.size > 1024 * 1024) throw new Error("live benchmark provider auth source is unavailable or unsafe");
  return { ...pi, tmux: tmuxGeneration, cmux: cmuxGeneration };
}
export function redactEvidenceValue(value: unknown): Json { if (typeof value === "string") return /(?:api[_-]?key|token|secret|password|authorization|bearer)/i.test(value) ? "[redacted]" : value.slice(0, 128); if (typeof value === "number" || typeof value === "boolean" || value === null) return value; if (Array.isArray(value)) return value.slice(0, 32).map(redactEvidenceValue); if (!record(value)) return "[redacted]"; const output: RecordJson = {}; for (const [key, child] of Object.entries(value)) if (!/(?:api[_-]?key|token|secret|password|credential|authorization|cookie|auth)/i.test(key)) output[key] = redactEvidenceValue(child); return output; }
export async function createPrivateEvidenceRoot(): Promise<string> { const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-phase0-live-")); await fs.chmod(root, 0o700); return await fs.realpath(root); }
export async function privateLiveRoot(root: string): Promise<{ dev: number; ino: number }> { if (!path.isAbsolute(root) || path.normalize(root) !== root || !/^pi-subagent-phase0-live-[a-z0-9_-]{6,128}$/i.test(path.basename(root))) throw new Error("live checkpoint root path is invalid"); const temp = await fs.realpath(os.tmpdir()), parent = await fs.realpath(path.dirname(root)).catch(() => null), stat = await fs.lstat(root).catch(() => null), uid = typeof process.getuid === "function" ? process.getuid() : null; if (!stat?.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (uid !== null && stat.uid !== uid) || parent !== temp || await fs.realpath(root).catch(() => null) !== root) throw new Error("live checkpoint root is not canonical private 0700"); return { dev: stat.dev, ino: stat.ino }; }
export function sameIdentity(stat: { dev: number; ino: number } | null, expected: { dev: number; ino: number }): boolean { return stat !== null && stat.dev === expected.dev && stat.ino === expected.ino; }
async function syncDirectory(root: string): Promise<void> { const handle = await fs.open(root, fsConstants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }

const STAGED_NATIVE_PI_DIRECTORY = "staged-native-pi";
const STAGED_NATIVE_PI_FILE = "pi";
export type StageLivePiExecutableHooks = { afterSourcePrevalidated?: () => void | Promise<void> };
/**
 * Converts the validated Pi pathname into one private per-runtime generation.
 * The source fence detects replacement before and after the exclusive copy;
 * same-UID replacement during those individual filesystem operations remains
 * outside this harness's threat model.
 */
export async function stageLivePiExecutable(root: string, pi: LivePiExecutable, hooks: StageLivePiExecutableHooks = {}): Promise<LivePiExecutable> {
  const rootIdentity = await privateLiveRoot(root), directory = path.join(root, STAGED_NATIVE_PI_DIRECTORY), destination = path.join(directory, STAGED_NATIVE_PI_FILE);
  let created = false;
  try {
    revalidateManagedChildPiExecutableGeneration(pi.generation);
    await hooks.afterSourcePrevalidated?.();
    await fs.mkdir(directory, { mode: 0o700 }); created = true;
    await fs.chmod(directory, 0o700);
    const directoryStat = await fs.lstat(directory);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777) !== 0o700 || (uid !== null && directoryStat.uid !== uid) || await fs.realpath(directory) !== directory || !sameIdentity(await fs.lstat(root).catch(() => null), rootIdentity)) throw new Error("private staged Pi directory is unsafe");
    revalidateManagedChildPiExecutableGeneration(pi.generation);
    await fs.copyFile(pi.generation.executable, destination, fsConstants.COPYFILE_EXCL);
    await fs.chmod(destination, 0o700);
    revalidateManagedChildPiExecutableGeneration(pi.generation);
    const staged = captureManagedChildLivePiExecutableGeneration(destination, directory);
    revalidateManagedChildPiExecutableGeneration(staged);
    const file = await fs.open(destination, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try { await file.sync(); } finally { await file.close(); }
    await syncDirectory(directory);
    await syncDirectory(root);
    if (!sameIdentity(await fs.lstat(root).catch(() => null), rootIdentity)) throw new Error("private staged Pi root identity changed");
    revalidateManagedChildPiExecutableGeneration(staged);
    return { ...pi, bin: staged.executable, generation: staged };
  } catch (error) {
    if (created) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw new Error("live Pi staging failed before provider spawn", { cause: error });
  }
}
export async function writeLiveCheckpoint(root: string, checkpoint: LiveCheckpoint): Promise<string> { if (!validateLiveCheckpoint(checkpoint)) throw new Error("refusing to persist an invalid live checkpoint"); const identity = await privateLiveRoot(root), destination = path.join(root, LIVE_CHECKPOINT_FILE), temporary = path.join(root, `.${LIVE_CHECKPOINT_FILE}.${crypto.randomUUID()}.tmp`); const handle = await fs.open(temporary, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(checkpoint)}\n`); await handle.sync(); } finally { await handle.close(); } if (!sameIdentity(await fs.lstat(root).catch(() => null), identity)) { await fs.rm(temporary, { force: true }); throw new Error("live checkpoint root identity changed before publish"); } try { await fs.rename(temporary, destination); await fs.chmod(destination, 0o600); await syncDirectory(root); } catch (error) { await fs.rm(temporary, { force: true }); throw error; } return destination; }
export async function loadLiveCheckpoint(root: string): Promise<LiveCheckpoint> { const identity = await privateLiveRoot(root), file = path.join(root, LIVE_CHECKPOINT_FILE), before = await fs.lstat(file).catch(() => null), uid = typeof process.getuid === "function" ? process.getuid() : null; if (!before?.isFile() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o600 || (uid !== null && before.uid !== uid) || before.size <= 0 || before.size > MAX_CHECKPOINT_BYTES) throw new Error("live checkpoint file is unsafe"); const raw = await fs.readFile(file); const after = await fs.lstat(file).catch(() => null); if (!sameIdentity(await fs.lstat(root).catch(() => null), identity) || !sameIdentity(after, before)) throw new Error("live checkpoint path identity changed while reading"); let parsed: unknown; try { parsed = JSON.parse(raw.toString("utf8")); } catch { throw new Error("live checkpoint JSON is malformed"); } if (!validateLiveCheckpoint(parsed)) throw new Error("live checkpoint schema is invalid"); return parsed; }
/** Atomically moves a resumable root out of its caller-visible name before it can be used again. */
export async function claimLiveCheckpoint(root: string): Promise<string> {
  const identity = await privateLiveRoot(root), parent = await fs.realpath(path.dirname(root));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimed = path.join(parent, `pi-subagent-phase0-live-claimed-${crypto.randomUUID()}`);
    if (await fs.lstat(claimed).catch(() => null)) continue;
    try { await fs.rename(root, claimed); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new Error("live checkpoint claim failed before provider start", { cause: error });
    }
    try {
      if (!sameIdentity(await fs.lstat(claimed).catch(() => null), identity) || await fs.lstat(root).catch(() => null)) throw new Error("live checkpoint claim identity was not proven");
      await syncDirectory(parent);
      return claimed;
    } catch (error) {
      // A post-rename proof failure must not leave an unreferenced hidden claim.
      await fs.rm(claimed, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  throw new Error("live checkpoint claim destination could not be reserved");
}
/** Removes the checkpoint file and fsyncs its verified private root before an attempted provider cell. */
export async function terminalizeLiveCheckpoint(root: string): Promise<void> {
  const identity = await privateLiveRoot(root), file = path.join(root, LIVE_CHECKPOINT_FILE);
  const entry = await fs.lstat(file).catch(() => null);
  if (entry !== null) {
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o600) throw new Error("live checkpoint file is unsafe to terminalize");
    await fs.unlink(file);
  }
  if (!sameIdentity(await fs.lstat(root).catch(() => null), identity)) throw new Error("live checkpoint root identity changed before terminalization");
  await syncDirectory(root);
  if (await fs.lstat(file).catch(() => null)) throw new Error("live checkpoint terminalization was not durable");
}
export const PHASE0_FAILURE_SUMMARY_FILE = "failure-summary.json";
export const PHASE0_FAILURE_CATEGORIES = ["spawn-failed", "parent-exit", "parent-signal", "deadline-exhausted", "stdout-overflow", "stderr-overflow", "harness-failure"] as const;
export const PHASE0_LIVE_MILESTONES = ["none", "parent-spawned", "parent-event-observed", "subagent-launch-requested", "background-job-admitted", "descendant-observed", "read-start-observed", "proof-observed"] as const;
export type Phase0FailureCategory = typeof PHASE0_FAILURE_CATEGORIES[number];
export type Phase0LiveMilestone = typeof PHASE0_LIVE_MILESTONES[number];
export type Phase0FailureSummary = {
  version: 1; category: Phase0FailureCategory; mode: LiveMode; workload: Workload; activeRuns: number; latestMilestone: Phase0LiveMilestone;
  monotonic: { parentSpawned: boolean; parentEventCount: number; subagentLaunchRequests: number; backgroundJobAdmissions: number; descendantHighWater: number; readStartHighWater: number; proofHighWater: number; stagePublished: boolean };
  terminalCounts: { providerError: number; settledBeforeRead: number; shutdownBeforeRead: number; abortedBeforeRead: number };
  cleanupProven: boolean;
};
const MAX_PHASE0_FAILURE_SUMMARY_BYTES = 2048;
function failureSummaryCount(value: unknown): value is number { return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= 1_000_000; }
export function validatePhase0FailureSummary(value: unknown): value is Phase0FailureSummary {
  return record(value) && exact(value, ["version", "category", "mode", "workload", "activeRuns", "latestMilestone", "monotonic", "terminalCounts", "cleanupProven"])
    && value.version === 1 && PHASE0_FAILURE_CATEGORIES.includes(value.category as Phase0FailureCategory) && LIVE_MODES.includes(value.mode as LiveMode) && WORKLOADS.includes(value.workload as Workload) && SUPPORTED_ACTIVE_RUNS.includes(value.activeRuns as SupportedActiveRun)
    && PHASE0_LIVE_MILESTONES.includes(value.latestMilestone as Phase0LiveMilestone) && record(value.monotonic) && exact(value.monotonic, ["parentSpawned", "parentEventCount", "subagentLaunchRequests", "backgroundJobAdmissions", "descendantHighWater", "readStartHighWater", "proofHighWater", "stagePublished"])
    && typeof value.monotonic.parentSpawned === "boolean" && [value.monotonic.parentEventCount, value.monotonic.subagentLaunchRequests, value.monotonic.backgroundJobAdmissions, value.monotonic.descendantHighWater, value.monotonic.readStartHighWater, value.monotonic.proofHighWater].every(failureSummaryCount) && typeof value.monotonic.stagePublished === "boolean"
    && record(value.terminalCounts) && exact(value.terminalCounts, ["providerError", "settledBeforeRead", "shutdownBeforeRead", "abortedBeforeRead"]) && Object.values(value.terminalCounts).every(failureSummaryCount) && typeof value.cleanupProven === "boolean";
}
export function formatPhase0FailureSummary(summary: Phase0FailureSummary): string {
  if (!validatePhase0FailureSummary(summary)) throw new Error("Phase 0 failure summary schema is invalid");
  const serialized = JSON.stringify(summary);
  if (Buffer.byteLength(serialized, "utf8") > MAX_PHASE0_FAILURE_SUMMARY_BYTES) throw new Error("Phase 0 failure summary exceeded its byte budget");
  return serialized;
}
async function privateSummaryDirectory(root: string): Promise<{ dev: number; ino: number }> {
  return privateLiveRoot(root);
}
async function syncFailureSummaryDirectory(root: string): Promise<void> { const handle = await fs.open(root, fsConstants.O_RDONLY); try { await handle.sync(); } finally { await handle.close(); } }
async function syncVerifiedRecoveryRoot(root: string, expected: { dev: number; ino: number }): Promise<boolean> {
  const before = await fs.lstat(root).catch(() => null);
  if (!sameIdentity(before, expected)) return false;
  const handle = await fs.open(root, fsConstants.O_RDONLY).catch(() => null);
  if (!handle) return false;
  try {
    const opened = await handle.stat();
    if (!sameIdentity(opened, expected) || !sameIdentity(await fs.lstat(root).catch(() => null), expected)) return false;
    await handle.sync();
    return sameIdentity(await fs.lstat(root).catch(() => null), expected);
  } catch { return false; }
  finally { await handle.close().catch(() => undefined); }
}
/** Writes the fixed, sanitized recovery summary atomically; no caller path is accepted. */
export async function writePhase0FailureSummary(root: string, summary: Phase0FailureSummary): Promise<string> {
  const serialized = formatPhase0FailureSummary(summary); await privateSummaryDirectory(root);
  const destination = path.join(root, PHASE0_FAILURE_SUMMARY_FILE), temporary = path.join(root, `.${PHASE0_FAILURE_SUMMARY_FILE}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${serialized}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, destination); await fs.chmod(destination, 0o600); await syncFailureSummaryDirectory(root); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
  return destination;
}
async function validRetainedFailureSummary(file: string): Promise<boolean> {
  const stat = await fs.lstat(file).catch(() => null), uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (uid !== null && stat.uid !== uid) || stat.size <= 0 || stat.size > MAX_PHASE0_FAILURE_SUMMARY_BYTES + 1) return false;
  let value: unknown; try { value = JSON.parse(await fs.readFile(file, "utf8")); } catch { return false; }
  return validatePhase0FailureSummary(value) && Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_PHASE0_FAILURE_SUMMARY_BYTES;
}
async function validRetainedLiveCheckpoint(file: string): Promise<boolean> {
  const stat = await fs.lstat(file).catch(() => null), uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat?.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (uid !== null && stat.uid !== uid) || stat.size <= 0 || stat.size > MAX_CHECKPOINT_BYTES) return false;
  try { return validateLiveCheckpoint(JSON.parse(await fs.readFile(file, "utf8"))); } catch { return false; }
}
/** Default-deny recovery: retain only a valid top-level checkpoint and/or summary. */
export async function scrubSensitiveRecoveryArtifacts(root: string): Promise<boolean> { try {
  const identity = await privateSummaryDirectory(root);
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.name === PHASE0_FAILURE_SUMMARY_FILE && await validRetainedFailureSummary(candidate)) continue;
    if (entry.name === LIVE_CHECKPOINT_FILE && await validRetainedLiveCheckpoint(candidate)) continue;
    await fs.rm(candidate, { recursive: true, force: true });
  }
  // Persist every removal before trusting the retained recovery contract.
  if (!await syncVerifiedRecoveryRoot(root, identity)) return false;
  const entries = await fs.readdir(root, { withFileTypes: true });
  if (!sameIdentity(await fs.lstat(root).catch(() => null), identity) || entries.length === 0) return false;
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.name === PHASE0_FAILURE_SUMMARY_FILE ? !await validRetainedFailureSummary(candidate) : entry.name === LIVE_CHECKPOINT_FILE ? !await validRetainedLiveCheckpoint(candidate) : true) return false;
  }
  return sameIdentity(await fs.lstat(root).catch(() => null), identity);
} catch { return false; } }
export async function writePrivateEvidence(root: string, evidence: LiveEvidence): Promise<string> { if (!validateLiveEvidence(evidence)) throw new Error("refusing to persist non-redacted or incomplete live evidence"); const identity = await privateLiveRoot(root), file = path.join(root, "evidence.json"), handle = await fs.open(file, "wx", 0o600); try { await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); } if (!sameIdentity(await fs.lstat(root).catch(() => null), identity)) { await fs.rm(file, { force: true }); throw new Error("evidence root identity changed before publish"); } await fs.chmod(file, 0o600); await syncDirectory(root); return file; }
export type BoundedCommandResult = { code: number; stdout: string; stderr: string; timedOut: boolean; outputOverflow: boolean };
export type BoundedCommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; deadline?: CellDeadline; timeoutMs?: number; detached?: boolean; onStart?: (child: ChildProcess) => void };
/** Every harness command is byte-exact and bounded; partial/truncated output is never accepted. */
export function run(bin: string, args: string[], options: BoundedCommandOptions = {}): Promise<BoundedCommandResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.deadline ? requireRemainingDeadline(options.deadline, `${bin} command`) : options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    let child: ChildProcess;
    try { child = spawn(bin, args, { cwd: options.cwd, env: options.env, detached: options.detached === true && process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { resolve({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false, outputOverflow: false }); return; }
    options.onStart?.(child);
    const stdout = new BoundedOutputCapture(MAX_COMMAND_OUTPUT_BYTES), stderr = new BoundedOutputCapture(MAX_DIAGNOSTIC_BYTES);
    let timedOut = false, outputOverflow = false, finished = false;
    const terminate = (): void => { try { if (child.pid) process.kill(options.detached && process.platform !== "win32" ? -child.pid : child.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    child.stdout?.on("data", (data: Buffer) => { if (!stdout.append(data)) { outputOverflow = true; terminate(); } });
    child.stderr?.on("data", (data: Buffer) => { if (!stderr.append(data)) { outputOverflow = true; terminate(); } });
    child.once("error", (error) => { if (!finished) { finished = true; clearTimeout(timer); resolve({ code: 1, stdout: stdout.text(), stderr: `${stderr.text()}${error.message}`, timedOut, outputOverflow }); } });
    child.once("close", (code) => { if (finished) return; finished = true; clearTimeout(timer); resolve({ code: timedOut || outputOverflow ? 1 : code ?? 1, stdout: stdout.text(), stderr: stderr.text(), timedOut, outputOverflow }); });
  });
}
export { run as runBoundedCommand };

/** A writer is tracked by immutable PID/start identity, never by a reusable PID alone. */
export type Phase0ReleaseWriter = { child: ChildProcess; identity: ProcessIdentity };
export type Phase0ReleaseWriterIdentityClassifier = (identity: ProcessIdentity) => ProcessIdentityStatus;
const classifyReleaseWriterIdentity: Phase0ReleaseWriterIdentityClassifier = (identity) => classifyParentProcessIdentity(identity.pid, identity.startedAt);
async function awaitWriterGone(writer: Phase0ReleaseWriter, timeoutMs: number, classify: Phase0ReleaseWriterIdentityClassifier): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    if (classify(writer.identity) === "dead") return;
    if (Date.now() >= deadline) throw new Error("Phase 0 private FIFO writer cleanup is unproven");
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
  }
}
/** Signals only an exact-live writer generation; unknown identity probes are never signal authority. */
export async function terminatePhase0ReleaseWriter(writer: Phase0ReleaseWriter, timeoutMs = 5_000, classify: Phase0ReleaseWriterIdentityClassifier = classifyReleaseWriterIdentity): Promise<void> {
  if (classify(writer.identity) === "live") {
    try { process.kill(process.platform === "win32" ? writer.identity.pid : -writer.identity.pid, "SIGKILL"); } catch {}
  }
  await awaitWriterGone(writer, timeoutMs, classify);
}
/** Outer cleanup is identity-bound and drains every tracked writer. */
export async function cleanupPhase0ReleaseWriters(writers: Set<Phase0ReleaseWriter>, options: { timeoutMs?: number; classify?: Phase0ReleaseWriterIdentityClassifier } = {}): Promise<void> {
  const tracked = [...writers];
  const results = await Promise.allSettled(tracked.map(async (writer) => {
    await terminatePhase0ReleaseWriter(writer, options.timeoutMs, options.classify);
    writers.delete(writer);
  }));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}
/** Sends one opaque release frame over stdin; the token is never an argv/env/artifact value. */
export async function writePhase0ReleaseToken(barrierPath: string, token: string, deadline: CellDeadline, writers: Set<Phase0ReleaseWriter>): Promise<void> {
  if (!path.isAbsolute(barrierPath) || path.normalize(barrierPath) !== barrierPath || !/^[0-9a-f]{64}$/.test(token)) throw new Error("invalid private Phase 0 FIFO release");
  const program = String.raw`const fs=require("node:fs");let chunks=[],size=0;process.stdin.on("data",c=>{size+=c.length;if(size>65)process.exit(2);else chunks.push(c)});process.stdin.on("end",()=>{const body=Buffer.concat(chunks,size);if(!/^[0-9a-f]{64}\n$/.test(body.toString("ascii")))process.exit(2);fs.open(process.argv[1],fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,(e,fd)=>{if(e)process.exit(1);fs.write(fd,body,0,body.length,null,e2=>fs.close(fd,()=>process.exit(e2?1:0)))})});`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", program, barrierPath], { detached: process.platform !== "win32", env: {}, stdio: ["pipe", "ignore", "ignore"] });
    const startedAt = child.pid ? getProcessStartedAt(child.pid) : null;
    if (!child.stdin || !child.pid || startedAt === null) { child.kill("SIGKILL"); reject(new Error("Phase 0 private FIFO writer identity is unavailable")); return; }
    const writer: Phase0ReleaseWriter = { child, identity: { pid: child.pid, startedAt } };
    writers.add(writer);
    let settled = false, timingOut = false;
    const finish = (error?: Error, cleanupProven = true) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (cleanupProven) writers.delete(writer);
      error ? reject(error) : resolve();
    };
    const failAfterTermination = async (error: Error) => {
      if (settled) return;
      timingOut = true;
      try { await terminatePhase0ReleaseWriter(writer); }
      catch (terminationError) { finish(terminationError instanceof Error ? terminationError : new Error(String(terminationError)), false); return; }
      finish(error);
    };
    const timer = setTimeout(() => { void failAfterTermination(new Error("Phase 0 private FIFO writer deadline expired")); }, requireRemainingDeadline(deadline, "private FIFO release"));
    child.once("error", () => { void failAfterTermination(new Error("Phase 0 private FIFO writer failed")); });
    child.once("close", (code) => finish(timingOut || code !== 0 ? new Error(timingOut ? "Phase 0 private FIFO writer deadline expired" : "Phase 0 private FIFO writer failed") : undefined));
    child.stdin.end(`${token}\n`);
  });
}
/** Resolves only the operator-selected, descriptor-validated native Pi generation. */
export async function resolveLivePiExecutable(env: NodeJS.ProcessEnv = process.env): Promise<LivePiGeneration> {
  const generation = resolveManagedChildLiveAcceptancePiExecutable({
    executable: env[MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV],
    minimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
  });
  // Validate the returned canonical generation independently for evidence while
  // preserving the resolver's descriptor/native/ancestry generation fence.
  const result = await run(generation.executable, ["--version"], { env: { PATH: process.platform === "win32" ? env.SystemRoot : "/usr/bin:/bin" } });
  const version = result.code === 0 && !result.timedOut && !result.outputOverflow ? parsePiVersionOutput(result.stdout) : null;
  if (!version || !isStableSemverAtLeast(version, MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION)) {
    throw new Error(`live benchmark requires stable Pi >=${MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION}`);
  }
  revalidateManagedChildPiExecutableGeneration(generation);
  return { bin: generation.executable, version, generation };
}

export class BoundedOutputCapture {
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #overflowed = false;

  constructor(readonly maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error("output capture limit must be a non-negative safe integer");
  }

  get byteLength(): number { return this.#bytes; }
  get overflowed(): boolean { return this.#overflowed; }

  append(chunk: Uint8Array): boolean {
    if (this.#overflowed) return false;
    const bytes = Buffer.from(chunk);
    if (bytes.length > this.maximumBytes - this.#bytes) { this.#overflowed = true; return false; }
    this.#chunks.push(bytes);
    this.#bytes += bytes.length;
    return true;
  }

  text(): string { return Buffer.concat(this.#chunks, this.#bytes).toString("utf8"); }
}
