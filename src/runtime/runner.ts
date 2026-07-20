/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  getAmbiguousInheritedCliApiKeyMessage,
  getProviderFromModelSpecifier,
  PROVIDER_API_KEY_ENV_VAR_MAP,
  resolveInheritedCliApiKeyEnvBinding,
  type InheritedCliApiKeyEnvBinding,
  type InheritedCliAuthContext,
} from "../core/provider-auth.js";
import type { AgentConfig } from "../core/agents.js";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { createJsonLineChunkProcessor } from "./runner-core.js";
import {
  assertCmuxLayoutSupport,
  buildCmuxFullTreeArgs,
  buildCmuxRespawnPaneArgs,
  canonicalCmuxPaneExists,
  closeCmuxSurface,
  inspectCmuxSurface,
  interruptCmuxSurface,
  resolveCanonicalCmuxSurfacePane,
  type CmuxCommandRunner,
} from "./cmux.js";
import {
  getInteractivePaneBackend,
  type InteractivePaneBackend,
  type InteractivePaneHandle,
} from "./interactive-pane.js";
import {
  INTERACTIVE_PANE_LAYOUT_ENV,
  InteractiveLayoutCoordinator,
  resolveInteractivePaneLayout,
  selectTmuxInteractivePlacement,
  type CmuxCommittedLayoutAllocation,
  type CmuxLayoutLease,
  type InteractivePaneLayout,
} from "./interactive-layout.js";
import {
  closeTmuxPane,
  inspectTmuxPaneFingerprint,
  interruptTmuxPane,
  parseTmuxPanePidList,
  parseTmuxEnvironment,
  readTmuxSourceTopology,
  type TmuxCommandRunner,
} from "./tmux.js";
import {
  DEFAULT_PARENT_LEASE_STALE_MS,
  RUN_PROTOCOL_VERSION,
  SUBAGENT_CHILD_SESSION_PATH_ENV,
  SUBAGENT_LEASE_STALE_MS_ENV,
  SUBAGENT_EXPECTED_PARENT_PID_ENV,
  SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
  SUBAGENT_PARENT_LEASE_PATH_ENV,
  SUBAGENT_RUN_COMPLETION_PATH_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_RUN_OWNERSHIP_ENV,
  SUBAGENT_RUN_STATE_PATH_ENV,
  assertSafeRunArtifactPaths,
  assertSafeStateRoot,
  atomicWriteJson,
  BROKER_PROTOCOL_VERSION,
  createRunId,
  getRunStateRoot,
  getCurrentProcessStartedAt,
  isParentProcessIdentityAlive,
  isUsableParentLease,
  type ParentProcessIdentityChecker,
  parseAllocationRecordV2,
  parseBrokerStatusV2,
  parseBrokerClaimV2,
  parseCommittedLaunchRecordV2,
  parseCompletionRecord,
  parseCompletionRecordV2,
  parseDecisionV2,
  parseLaunchGateV2,
  parseLaunchIntentV2,
  parseLaunchRecord,
  hasAllocationIntentSourceBinding,
  hasValidV2StateDependencies,
  parseParentLease,
  parseResidualRiskV2,
  prepareRunArtifactPaths,
  publishImmutableJson,
  publishCompletionRecordV2,
  readBrokerArtifact,
  readBrokerJson,
  readJsonFile,
  removeRunArtifacts,
  resolveRunArtifactPaths,
  scheduleRunArtifactCleanup,
  startParentLeaseWriter,
  writePrivateExecutableFile,
  writePrivateFile,
  type AllocationRecordV2,
  type CompletionRecordV1,
  type RunArtifactPaths,
} from "./run-protocol.js";
import { createSessionTailState, drainSessionJsonl } from "./session-tail.js";
import { processPiJsonLine } from "../core/runner-events.js";
import { isTrustedProjectAgentsDirWithSessionOverrides } from "../core/project-trust.js";
import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  type TerminalMode,
  emptyUsage,
  getFinalOutput,
  normalizeCompletedResult,
} from "../core/types.js";
import { canonicalizePathForTrust } from "../core/trust-path.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const POLL_INTERVAL_MS = 100;
const INTERACTIVE_PANE_POLL_INTERVAL_MS = 250;
const ABORT_WAIT_MS = 3000;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TRUSTED_PROJECTS_ENV = "PI_SUBAGENT_TRUSTED_PROJECTS";
const SUBAGENT_DENIED_PROJECTS_ENV = "PI_SUBAGENT_DENIED_PROJECTS";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SUBAGENT_ORIGINAL_AGENT_DIR_ENV = "PI_SUBAGENT_ORIGINAL_AGENT_DIR";
const SUBAGENT_INHERITED_API_KEY_ENV = "PI_SUBAGENT_INHERITED_API_KEY";
const PI_OFFLINE_ENV = "PI_OFFLINE";
const CHILD_BRIDGE_PATH = fileURLToPath(new URL("./child-bridge.ts", import.meta.url));
const MIN_INTERACTIVE_PI_VERSION = [0, 80, 10] as const;
const BROKER_READY_TIMEOUT_MS = 5_000;
const BROKER_COMMIT_TIMEOUT_MS = 30_000;
const BROKER_RUNTIME_ENV = "PI_SUBAGENT_BROKER_RUNTIME";
const BROKER_ENTRYPOINT = fileURLToPath(new URL("./pane-launch-broker.mjs", import.meta.url));
const CMUX_BUNDLED_CLI_PATH_ENV = "CMUX_BUNDLED_CLI_PATH";
let interactivePiVersionCheck: Promise<void> | null = null;

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface ActiveInteractiveRun {
  runId: string;
  backend: InteractivePaneBackend;
  handle: InteractivePaneHandle;
  /** One idempotent exact-target release path, shared with shutdown. */
  release: () => Promise<boolean>;
}

const activeInteractiveRuns = new Map<string, ActiveInteractiveRun>();
/** Exact cleanup begun by a post-fence durable commit. */
const lateFencedInteractiveReleases = new Set<Promise<void>>();
let interactiveShutdownActive = false;
let interactiveShutdownGeneration = 0;
let interactiveFenceMutex: Promise<void> = Promise.resolve();
const INTERACTIVE_SHUTDOWN_DRAIN_ATTEMPTS = 8;
const INTERACTIVE_SHUTDOWN_RELEASE_WAIT_MS = 1_000;

/** Serialize fence transitions with the irreversible launch-gate publication. */
async function withInteractiveFenceMutex<T>(operation: () => Promise<T> | T): Promise<T> {
  const previous = interactiveFenceMutex;
  let release!: () => void;
  interactiveFenceMutex = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

/** Start this session's shutdown fence exactly once. */
export async function beginInteractiveShutdownForSession(): Promise<void> {
  await withInteractiveFenceMutex(() => {
    if (interactiveShutdownActive) return;
    interactiveShutdownActive = true;
    interactiveShutdownGeneration += 1;
  });
}

/** Reset for a new session; every reset is a distinct generation. */
export async function resetInteractiveShutdownForSession(): Promise<void> {
  await withInteractiveFenceMutex(() => {
    interactiveShutdownGeneration += 1;
    interactiveShutdownActive = false;
  });
}

/** A captured session may start work only in its original, unfenced generation. */
export function canStartInteractiveRun(generation: number): boolean {
  return !interactiveShutdownActive && interactiveShutdownGeneration === generation;
}

/** Test-only visibility of the monotonic fence generation. */
export function getInteractiveShutdownGenerationForTest(): number {
  return interactiveShutdownGeneration;
}

// The layout coordinator is process-global so foreground and background calls
// serialize allocation for the same root surface. The runner binds the exact
// preflight-selected executable before each allocation; missing bindings fail
// closed instead of falling back to PATH or a backend default.
const cmuxLayoutRunners = new Map<string, CmuxCommandRunner>();
function cmuxLayoutRunnerKey(workspaceId: string): string {
  return workspaceId.toLowerCase();
}
function createInteractiveLayoutCoordinator(): InteractiveLayoutCoordinator {
  return new InteractiveLayoutCoordinator({
    async resolveCmuxSourcePane(source) {
      const run = cmuxLayoutRunners.get(cmuxLayoutRunnerKey(source.workspaceId));
      if (!run) return undefined;
      const tree = await run(buildCmuxFullTreeArgs(source.workspaceId));
      const resolved = tree.exitCode === 0
        ? resolveCanonicalCmuxSurfacePane(tree.stdout, source.workspaceId, source.sourceSurfaceId)
        : undefined;
      return resolved
        ? { kind: "cmux-source-pane", workspaceId: resolved.workspaceId, sourceSurfaceId: resolved.surfaceId, paneId: resolved.paneId }
        : undefined;
    },
    async validateCmuxPane(pane) {
      const run = cmuxLayoutRunners.get(cmuxLayoutRunnerKey(pane.workspaceId));
      if (!run) return false;
      const tree = await run(buildCmuxFullTreeArgs(pane.workspaceId));
      return tree.exitCode === 0 && canonicalCmuxPaneExists(tree.stdout, pane.workspaceId, pane.paneId);
    },
  });
}
let interactiveLayoutCoordinator = createInteractiveLayoutCoordinator();

/** Test seam; production always uses one coordinator for the process lifetime. */
export function resetInteractiveLayoutCoordinatorForTest(): void {
  cmuxLayoutRunners.clear();
  interactiveLayoutCoordinator = createInteractiveLayoutCoordinator();
}

export function listActiveInteractiveRunIds(): string[] {
  return Array.from(activeInteractiveRuns.keys());
}

/** Register immediately on durable commit, before any one-way launch action. */
export function registerCommittedInteractiveRun(
  run: Omit<ActiveInteractiveRun, "release"> & Partial<Pick<ActiveInteractiveRun, "release">> & { generation: number },
): boolean {
  const active: ActiveInteractiveRun = {
    ...run,
    release: run.release ?? (() => closeInteractiveTarget(run.backend, run.handle)),
  };
  // A durable commit may race shutdown or a replacement session. Retain the
  // exact target in the retryable registry before its first cleanup attempt:
  // failed/unknown release remains shutdown-owned for later retries.
  if (!canStartInteractiveRun(run.generation)) {
    activeInteractiveRuns.set(active.runId, active);
    const cleanup = (async () => {
      await active.backend.interrupt(active.handle).catch(() => false);
      const released = await active.release().catch(() => false);
      if (released) activeInteractiveRuns.delete(active.runId);
    })();
    lateFencedInteractiveReleases.add(cleanup);
    void cleanup.finally(() => lateFencedInteractiveReleases.delete(cleanup));
    return false;
  }
  activeInteractiveRuns.set(active.runId, active);
  return true;
}

export function unregisterCommittedInteractiveRun(runId: string): void {
  activeInteractiveRuns.delete(runId);
}

export async function closeInteractiveTarget(
  backend: InteractivePaneBackend,
  handle: InteractivePaneHandle,
): Promise<boolean> {
  // A close acknowledgement is transport success, not ownership proof. Always
  // inspect the exact recorded fingerprint/UUID after attempting the close.
  await backend.close(handle).catch(() => false);
  const snapshot = await backend.inspect(handle).catch(() => undefined);
  return snapshot !== undefined && snapshot.exists === false;
}

/** Best-effort interruption always remains fenced by the recorded handle. */
export async function recoverInteractiveTarget(
  backend: InteractivePaneBackend,
  handle: InteractivePaneHandle,
): Promise<boolean> {
  await backend.interrupt(handle).catch(() => false);
  return closeInteractiveTarget(backend, handle);
}


/** Creates the sole release path for completion, cancellation, and shutdown. */
function makeInteractiveRelease(
  backend: InteractivePaneBackend,
  handle: InteractivePaneHandle,
  cmuxLease: CmuxLayoutLease | null,
): () => Promise<boolean> {
  let released = false;
  let inFlight: Promise<boolean> | null = null;
  return async () => {
    if (released) return true;
    if (inFlight) return await inFlight;
    inFlight = (async () => {
      try {
        if (cmuxLease) {
          await interactiveLayoutCoordinator.releaseCmux({
            lease: cmuxLease,
            // Coordinator DTOs are not protocol records. Convert only their
            // exact cmux lease target; allocationToHandle accepts full V2
            // authority records and must never be used on this DTO.
            close: async (allocation) => await closeInteractiveTarget(backend, {
              mode: "cmux-pane",
              native: {
                workspaceId: allocation.target.workspaceId,
                surfaceId: allocation.target.surfaceId,
                paneId: allocation.target.paneId,
              },
              placement: { layout: allocation.layout, placement: allocation.placement },
            }),
          });
        } else if (!await closeInteractiveTarget(backend, handle)) {
          return false;
        }
        released = true;
        return true;
      } catch {
        // cmux coordinator deliberately retains failures for a later retry.
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return await inFlight;
  };
}

async function awaitInteractiveCleanupBounded(cleanup: Promise<unknown>): Promise<void> {
  await Promise.race([
    cleanup.then(() => undefined, () => undefined),
    delay(INTERACTIVE_SHUTDOWN_RELEASE_WAIT_MS),
  ]);
}

export async function shutdownActiveInteractiveRuns(): Promise<void> {
  // Fence before observing either registry. Any later durable commit is
  // rejected synchronously and its exact cleanup joins lateFenced... above.
  await beginInteractiveShutdownForSession();
  for (let attempt = 0; attempt < INTERACTIVE_SHUTDOWN_DRAIN_ATTEMPTS; attempt += 1) {
    const runs = Array.from(activeInteractiveRuns.values());
    const lateReleases = Array.from(lateFencedInteractiveReleases);
    if (runs.length === 0 && lateReleases.length === 0) return;

    await Promise.all(runs.map(async (run) => {
      await awaitInteractiveCleanupBounded(run.backend.interrupt(run.handle).catch(() => false));
    }));
    if (attempt === 0 && runs.length > 0) await delay(250);
    await Promise.all(runs.map(async (run) => {
      const released = await Promise.race([
        run.release().catch(() => false),
        delay(INTERACTIVE_SHUTDOWN_RELEASE_WAIT_MS).then(() => false),
      ]);
      // Retain failed/unknown releases for a later drain (and startup reaper).
      if (released) activeInteractiveRuns.delete(run.runId);
    }));
    await Promise.all(lateReleases.map(awaitInteractiveCleanupBounded));
  }
}

export interface ReapStaleInteractiveRunsResult {
  scanned: number;
  reaped: string[];
  skipped: string[];
  invalid: string[];
}

export async function reapStaleInteractiveRuns(options: {
  rootDir?: string;
  now?: number;
  staleAfterMs?: number;
  diagnosticRetentionSeconds?: number;
  cmuxRun?: CmuxCommandRunner;
  tmuxRun?: TmuxCommandRunner;
  scheduleCleanup?: (runDir: string, delaySeconds: number) => void;
  /** Test seam for sensitive artifact deletion fault handling. */
  removeSensitivePath?: (path: string) => Promise<void>;
  /** Test seam for the immutable first-writer-wins decision publication. */
  publishImmutable?: typeof publishImmutableJson;
  /** Test seam; production uses OS-backed PID/start identity validation. */
  isProcessIdentityAlive?: ParentProcessIdentityChecker;
} = {}): Promise<ReapStaleInteractiveRunsResult> {
  const rootDir = path.resolve(options.rootDir ?? getRunStateRoot());
  const outcome: ReapStaleInteractiveRunsResult = { scanned: 0, reaped: [], skipped: [], invalid: [] };
  if (!await fileExists(rootDir)) return outcome;
  try {
    await assertSafeStateRoot(rootDir);
  } catch {
    throw new Error(`Refusing to reap an untrusted subagent state root: ${rootDir}`);
  }
  const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_PARENT_LEASE_STALE_MS;

  const cleanupInvalidRun = async (entryName: string, paths: RunArtifactPaths): Promise<void> => {
    let lease = null;
    try {
      lease = parseParentLease(await readJsonFile(paths.parentLeasePath), entryName, now);
    } catch {
      lease = null;
    }
    if (isUsableParentLease({ lease, now, staleAfterMs, isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive })) {
      outcome.skipped.push(entryName);
      return;
    }
    const stat = await fs.promises.lstat(paths.runDir).catch(() => null);
    if (stat && now - stat.mtimeMs < staleAfterMs) {
      outcome.skipped.push(entryName);
      return;
    }
    try {
      await assertSafeRunArtifactPaths(paths);
      outcome.invalid.push(entryName);
      await fs.promises.rm(paths.runDir, { recursive: true, force: true });
    } catch {
      outcome.invalid.push(entryName);
    }
  };

  const isBrokerAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const cleanupV2Allocation = async (allocation: NonNullable<ReturnType<typeof parseAllocationRecordV2>>, run: BackendCommandRunner): Promise<boolean> => {
    if (allocation.terminalMode === "cmux-pane") {
      const handle = { workspaceId: allocation.target.workspaceId, surfaceId: allocation.target.surfaceId };
      await interruptCmuxSurface(handle, run).catch(() => false);
      await closeCmuxSurface(handle, run).catch(() => false);
      const snapshot = await inspectCmuxSurface(handle, run).catch(() => undefined);
      return snapshot !== undefined && !snapshot.exists;
    }
    const handle = { paneId: allocation.target.paneId, socketPath: allocation.target.socketPath, serverPid: allocation.target.serverPid, panePid: allocation.target.panePid };
    const initial = await inspectTmuxPaneFingerprint(handle, run).catch(() => undefined);
    if (!initial?.exists) return initial !== undefined;
    await interruptTmuxPane(handle, run).catch(() => false);
    await closeTmuxPane(handle, run).catch(() => false);
    const snapshot = await inspectTmuxPaneFingerprint(handle, run).catch(() => undefined);
    return snapshot !== undefined && !snapshot.exists;
  };
  const candidates: Array<{ paths: RunArtifactPaths; launch: NonNullable<ReturnType<typeof parseLaunchRecord>> }> = [];
  const v2Candidates: Array<{ paths: RunArtifactPaths; intent: NonNullable<ReturnType<typeof parseLaunchIntentV2>> }> = [];
  const retentionSeconds = options.diagnosticRetentionSeconds ?? 60 * 60;
  // V1 tmux fingerprints can still fence a pane mutation. V1 cmux has no
  // equivalent immutable source authority and is quarantined below.
  const legacyTmuxRun = options.tmuxRun ?? (() => {
    const executable = resolveBackendExecutable("tmux-pane");
    return executable ? createBackendCommandRunner("tmux-pane", executable) : null;
  })();
  const v2ArtifactPaths = (paths: RunArtifactPaths) => [
    paths.launchIntentPath, paths.allocationPath, paths.decisionPath, paths.launchPath,
    paths.launchGatePath, paths.brokerClaimPath, paths.residualRiskPath, paths.completionPath, paths.brokerStatusPath,
  ];
  const removeSensitiveArtifacts = async (paths: RunArtifactPaths): Promise<boolean> =>
    await removeSelectedSensitiveArtifacts(paths, options.removeSensitivePath);
  const quarantineV2 = async (runId: string, paths: RunArtifactPaths): Promise<void> => {
    // Retain recovery authority if any selected secret cannot be removed.
    // Either way this run is never scheduled as ordinary retention.
    await removeSensitiveArtifacts(paths);
    outcome.invalid.push(runId);
    outcome.skipped.push(runId);
  };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    outcome.scanned += 1;
    let paths: RunArtifactPaths;
    try {
      paths = resolveRunArtifactPaths(entry.name, rootDir);
      await assertSafeRunArtifactPaths(paths);
    } catch {
      outcome.invalid.push(entry.name);
      continue;
    }

    // Read every V2 pathname first. The V2-exclusive names fix the namespace
    // by presence, not by their JSON version or semantic validity.
    const v2Artifacts = await Promise.all(v2ArtifactPaths(paths).map(readBrokerArtifact));
    const hasV2Path = [v2Artifacts[0], v2Artifacts[1], v2Artifacts[2], v2Artifacts[4], v2Artifacts[5], v2Artifacts[6], v2Artifacts[8]]
      .some((artifact) => artifact?.outcome !== "missing")
      || v2Artifacts.some((artifact) => artifact.outcome === "valid" && artifact.value.version === BROKER_PROTOCOL_VERSION);
    if (hasV2Path) {
      if (v2Artifacts.some((artifact) => artifact.outcome === "invalid")) {
        await quarantineV2(entry.name, paths);
        continue;
      }
      const [intentArtifact, allocationArtifact, decisionArtifact, launchArtifact, gateArtifact, claimArtifact, riskArtifact, completionArtifact, statusArtifact] = v2Artifacts;
      const intent = parseLaunchIntentV2(intentArtifact?.outcome === "valid" ? intentArtifact.value : null, entry.name, paths.runDir);
      const allocation = parseAllocationRecordV2(allocationArtifact?.outcome === "valid" ? allocationArtifact.value : null, entry.name);
      const decision = parseDecisionV2(decisionArtifact?.outcome === "valid" ? decisionArtifact.value : null, entry.name, paths.runDir);
      const launch = parseCommittedLaunchRecordV2(launchArtifact?.outcome === "valid" ? launchArtifact.value : null, entry.name, paths.runDir);
      const gate = parseLaunchGateV2(gateArtifact?.outcome === "valid" ? gateArtifact.value : null, entry.name, paths.runDir);
      const claim = parseBrokerClaimV2(claimArtifact?.outcome === "valid" ? claimArtifact.value : null, entry.name);
      const risk = parseResidualRiskV2(riskArtifact?.outcome === "valid" ? riskArtifact.value : null, entry.name);
      const completion = parseCompletionRecordV2(completionArtifact?.outcome === "valid" ? completionArtifact.value : null, entry.name);
      const status = parseBrokerStatusV2(statusArtifact?.outcome === "valid" ? statusArtifact.value : null, entry.name);
      const artifactValues: Array<{ artifact: Awaited<ReturnType<typeof readBrokerArtifact>> | undefined; value: unknown }> = [
        { artifact: intentArtifact, value: intent }, { artifact: allocationArtifact, value: allocation },
        { artifact: decisionArtifact, value: decision }, { artifact: launchArtifact, value: launch },
        { artifact: gateArtifact, value: gate }, { artifact: claimArtifact, value: claim }, { artifact: riskArtifact, value: risk }, { artifact: completionArtifact, value: completion },
        { artifact: statusArtifact, value: status },
      ];
      const presentButInvalid = artifactValues.some(({ artifact, value }) => artifact?.outcome === "valid" && !value);
      const inconsistent = !intent
        || (allocation !== null && !hasAllocationIntentSourceBinding(intent, allocation))
        || (allocation !== null && allocation.terminalMode !== intent.terminalMode)
        || (launch !== null && (launch.terminalMode !== intent.terminalMode || launch.childSessionFile !== intent.childSessionFile))
        || (gate !== null && gate.terminalMode !== intent.terminalMode)
        || !hasValidV2StateDependencies({ allocation, decision, launch, gate })
        || (claim !== null && claim.brokerNonce !== intent.brokerNonce);
      if (presentButInvalid || inconsistent || resolveBackendPath(intent.terminalMode, intent.backendPath) !== intent.backendPath) {
        await quarantineV2(entry.name, paths);
        continue;
      }
      v2Candidates.push({ paths, intent });
      continue;
    }

    // Only a V2-free namespace may be treated as a V1 launch record.
    let launchValue: unknown | null = null;
    try {
      launchValue = await readJsonFile(paths.launchPath);
    } catch {
      await cleanupInvalidRun(entry.name, paths);
      continue;
    }
    const launch = parseLaunchRecord(launchValue, entry.name);
    if (!launch || path.dirname(launch.childSessionFile) !== paths.runDir) {
      await cleanupInvalidRun(entry.name, paths);
      continue;
    }
    candidates.push({ paths, launch });
  }

  // Classify every V2 graph before cleanup, then process descendants first so a
  // parent target cannot invalidate a child's recovery path.
  const v2ById = new Map(v2Candidates.map((candidate) => [candidate.intent.runId, candidate]));
  const v2Depth = (runId: string): number => {
    let depth = 0; let current = v2ById.get(runId)?.intent.parentRunId; const seen = new Set([runId]);
    while (current && !seen.has(current) && v2ById.has(current)) { seen.add(current); depth += 1; current = v2ById.get(current)?.intent.parentRunId; }
    return depth;
  };
  v2Candidates.sort((left, right) => v2Depth(right.intent.runId) - v2Depth(left.intent.runId));
  for (const candidate of v2Candidates) {
    const { paths, intent } = candidate;
    let lease = null;
    try { lease = parseParentLease(await readJsonFile(paths.parentLeasePath), intent.runId, now); } catch { /* stale/unreadable */ }
    if (isUsableParentLease({
      lease, now, staleAfterMs, parentPid: intent.parentPid, parentStartedAt: intent.parentStartedAt,
      isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive,
    })) { outcome.skipped.push(intent.runId); continue; }
    try { await assertSafeRunArtifactPaths(paths); } catch { outcome.invalid.push(intent.runId); continue; }
    let [allocationArtifact, decisionArtifact, riskArtifact, statusArtifact] = await Promise.all([
      readBrokerArtifact(paths.allocationPath), readBrokerArtifact(paths.decisionPath), readBrokerArtifact(paths.residualRiskPath), readBrokerArtifact(paths.brokerStatusPath),
    ]);
    let allocation = parseAllocationRecordV2(allocationArtifact.outcome === "valid" ? allocationArtifact.value : null, intent.runId);
    let decision = parseDecisionV2(decisionArtifact.outcome === "valid" ? decisionArtifact.value : null, intent.runId, paths.runDir);
    let risk = parseResidualRiskV2(riskArtifact.outcome === "valid" ? riskArtifact.value : null, intent.runId);
    let status = parseBrokerStatusV2(statusArtifact.outcome === "valid" ? statusArtifact.value : null, intent.runId);
    const authorityIsInvalid = () => (allocationArtifact.outcome === "valid" && !allocation)
      || (decisionArtifact.outcome === "valid" && !decision)
      || (riskArtifact.outcome === "valid" && !risk)
      || (statusArtifact.outcome === "valid" && !status);
    if (authorityIsInvalid()) {
      await quarantineV2(intent.runId, paths);
      continue;
    }
    let launch = parseCommittedLaunchRecordV2(await readBrokerJson(paths.launchPath), intent.runId, paths.runDir);
    let gate = parseLaunchGateV2(await readBrokerJson(paths.launchGatePath), intent.runId, paths.runDir);
    if ((allocation !== null && !hasAllocationIntentSourceBinding(intent, allocation))
      || !hasValidV2StateDependencies({ allocation, decision, launch, gate })) {
      await quarantineV2(intent.runId, paths);
      continue;
    }
    // A residual unrecorded-allocation claim is stronger than any recorded
    // target absence. Never act on the recorded target in this state.
    if (risk && allocation) {
      await quarantineV2(intent.runId, paths);
      continue;
    }
    // Broker PIDs are reusable. Only a fresh, preterminal ready status may
    // defer cleanup; committed/failed records are one-shot terminal evidence.
    let brokerActive = status?.writer === "broker" && status.phase === "ready"
      && now >= status.updatedAt && now - status.updatedAt <= staleAfterMs
      && isBrokerAlive(status.pid);
    if (brokerActive) { outcome.skipped.push(intent.runId); continue; }
    if (!allocation && status?.writer === "broker" && status.phase === "ready") {
      // A dead/stale ready broker has crossed the allocation boundary but has
      // not durably named a target. Fence it first; the immutable winner is
      // then reread before deciding whether cancellation or commit owns it.
      await (options.publishImmutable ?? publishImmutableJson)(paths.decisionPath, {
        version: BROKER_PROTOCOL_VERSION, runId: intent.runId, kind: "cancel", decidedAt: now, reason: "ready-timeout",
      }).catch(() => undefined);
      [allocationArtifact, decisionArtifact, riskArtifact, statusArtifact] = await Promise.all([
        readBrokerArtifact(paths.allocationPath), readBrokerArtifact(paths.decisionPath), readBrokerArtifact(paths.residualRiskPath), readBrokerArtifact(paths.brokerStatusPath),
      ]);
      allocation = parseAllocationRecordV2(allocationArtifact.outcome === "valid" ? allocationArtifact.value : null, intent.runId);
      decision = parseDecisionV2(decisionArtifact.outcome === "valid" ? decisionArtifact.value : null, intent.runId, paths.runDir);
      risk = parseResidualRiskV2(riskArtifact.outcome === "valid" ? riskArtifact.value : null, intent.runId);
      status = parseBrokerStatusV2(statusArtifact.outcome === "valid" ? statusArtifact.value : null, intent.runId);
      launch = parseCommittedLaunchRecordV2(await readBrokerJson(paths.launchPath), intent.runId, paths.runDir);
      gate = parseLaunchGateV2(await readBrokerJson(paths.launchGatePath), intent.runId, paths.runDir);
      if (authorityIsInvalid() || (allocation !== null && !hasAllocationIntentSourceBinding(intent, allocation))
        || !hasValidV2StateDependencies({ allocation, decision, launch, gate }) || (risk && allocation)) {
        await quarantineV2(intent.runId, paths);
        continue;
      }
      // A concurrent broker commit is the first-writer winner. Reconcile its
      // exact allocation below instead of reporting a cancellation we lost.
      brokerActive = false;
    }
    if (!allocation) {
      // A cancel winner remains recovery authority while the broker may still
      // roll back or expose an allocation. A later reaper may retire it only
      // after terminal broker evidence or exact allocation absence.
      const recoveryPending = Boolean(risk) || (status?.phase === "failed" && status.errorCode === "possible-unrecorded-allocation") || decision?.kind === "commit" || (status?.writer === "broker" && status.phase === "ready");
      if (!await removeSensitiveArtifacts(paths)) { outcome.invalid.push(intent.runId); outcome.skipped.push(intent.runId); continue; }
      if (recoveryPending) {
        outcome.skipped.push(intent.runId);
      } else {
        if (options.scheduleCleanup) options.scheduleCleanup(paths.runDir, retentionSeconds);
        else scheduleRunArtifactCleanup(paths.runDir, retentionSeconds);
        outcome.reaped.push(intent.runId);
      }
      continue;
    }
    // Revalidate immediately before issuing target-mutating terminal commands.
    try { await assertSafeRunArtifactPaths(paths); } catch { outcome.invalid.push(intent.runId); continue; }
    const backendPath = resolveBackendPath(intent.terminalMode, intent.backendPath);
    if (!backendPath) {
      await quarantineV2(intent.runId, paths);
      continue;
    }
    const reaperRun = allocation.terminalMode === "cmux-pane"
      ? (options.cmuxRun ?? createBackendCommandRunner("cmux-pane", backendPath))
      : (options.tmuxRun ?? createBackendCommandRunner("tmux-pane", backendPath));
    const gone = await cleanupV2Allocation(allocation, reaperRun);
    if (!await removeSensitiveArtifacts(paths)) { outcome.invalid.push(intent.runId); outcome.skipped.push(intent.runId); continue; }
    if (!gone) {
      await publishCompletionRecordV2(paths.completionPath, { version: 2, runId: intent.runId, status: "orphaned", completedAt: now, errorCode: "reaper-cleanup-failed" }).catch(() => undefined);
      outcome.skipped.push(intent.runId); continue;
    }
    await publishCompletionRecordV2(paths.completionPath, { version: 2, runId: intent.runId, status: "orphaned", completedAt: now, errorCode: "lease-expired" }).catch(() => undefined);
    if (options.scheduleCleanup) options.scheduleCleanup(paths.runDir, retentionSeconds);
    else scheduleRunArtifactCleanup(paths.runDir, retentionSeconds);
    outcome.reaped.push(intent.runId);
  }

  const byId = new Map(candidates.map((candidate) => [candidate.launch.runId, candidate]));
  const depthOf = (runId: string): number => {
    let depth = 0;
    let current = byId.get(runId)?.launch.parentRunId;
    const seen = new Set<string>([runId]);
    while (current && !seen.has(current) && byId.has(current)) {
      seen.add(current);
      depth += 1;
      current = byId.get(current)?.launch.parentRunId;
    }
    return depth;
  };
  candidates.sort((left, right) => depthOf(right.launch.runId) - depthOf(left.launch.runId));

  for (const candidate of candidates) {
    const { paths, launch } = candidate;
    let lease = null;
    try {
      lease = parseParentLease(await readJsonFile(paths.parentLeasePath), launch.runId, options.now ?? Date.now());
    } catch {
      lease = null;
    }
    if (launch.ownership === "detached" || isUsableParentLease({
      lease,
      now: options.now ?? Date.now(),
      staleAfterMs: options.staleAfterMs ?? DEFAULT_PARENT_LEASE_STALE_MS,
      isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive,
    })) {
      outcome.skipped.push(launch.runId);
      continue;
    }

    try { await assertSafeRunArtifactPaths(paths); } catch { outcome.invalid.push(launch.runId); continue; }
    let targetTerminated = false;
    if (launch.terminalMode === "cmux-pane") {
      // V1 records have no immutable source binding. Even canonical-looking
      // workspace/surface fields could name a caller-owned target, so retain
      // the record for quarantine and never emit a cmux lifecycle mutation.
      await removeSensitiveArtifacts(paths);
      outcome.invalid.push(launch.runId);
      outcome.skipped.push(launch.runId);
      continue;
    } else {
      const handle = {
        paneId: launch.tmuxPaneId!,
        socketPath: launch.tmuxSocketPath,
        serverPid: launch.tmuxServerPid!,
        panePid: launch.tmuxPanePid!,
      };
      if (!legacyTmuxRun) { outcome.skipped.push(launch.runId); continue; }
      const initialSnapshot = await inspectTmuxPaneFingerprint(handle, legacyTmuxRun).catch(() => undefined);
      if (initialSnapshot?.exists) {
        await interruptTmuxPane(handle, legacyTmuxRun).catch(() => false);
        await closeTmuxPane(handle, legacyTmuxRun).catch(() => false);
        const snapshot = await inspectTmuxPaneFingerprint(handle, legacyTmuxRun).catch(() => undefined);
        targetTerminated = snapshot !== undefined && !snapshot.exists;
      } else {
        targetTerminated = initialSnapshot !== undefined;
      }
    }
    if (!targetTerminated) {
      if (!await removeSensitiveArtifacts(paths)) { outcome.invalid.push(launch.runId); outcome.skipped.push(launch.runId); continue; }
      outcome.skipped.push(launch.runId);
      continue;
    }
    let existingCompletion = null;
    try {
      existingCompletion = parseCompletionRecord(await readJsonFile(paths.completionPath), launch.runId);
    } catch {
      existingCompletion = null;
    }
    if (!existingCompletion) {
      await atomicWriteJson(paths.completionPath, {
        version: RUN_PROTOCOL_VERSION,
        runId: launch.runId,
        status: "orphaned",
        completedAt: options.now ?? Date.now(),
        stopReason: "aborted",
        errorCode: "lease-expired",
        childSessionFile: launch.childSessionFile,
      } satisfies CompletionRecordV1).catch(() => undefined);
    }
    if (!await removeSensitiveArtifacts(paths)) { outcome.invalid.push(launch.runId); outcome.skipped.push(launch.runId); continue; }
    if (options.scheduleCleanup) options.scheduleCleanup(paths.runDir, retentionSeconds);
    else scheduleRunArtifactCleanup(paths.runDir, retentionSeconds);
    outcome.reaped.push(launch.runId);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Derive the spawn command from the current process context so child invocations
 * work on Unix and Windows without going through a shell wrapper.
 */
function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [path.resolve(process.argv[1])] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

export function isPiVersionAtLeast(rawVersion: string, minimum = MIN_INTERACTIVE_PI_VERSION): boolean {
  const match = rawVersion.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

async function ensureInteractivePiVersion(): Promise<void> {
  interactivePiVersionCheck ??= (async () => {
    const { command, prefixArgs } = resolvePiSpawn();
    const version = await runCommandCapture(command, [...prefixArgs, "--version"], { env: buildBrokerEnvironment(process.env, "cmux-pane") });
    if (version.exitCode !== 0 || !isPiVersionAtLeast(version.stdout || version.stderr)) {
      throw new Error(`cmux Pi TUI mode requires Pi >= ${MIN_INTERACTIVE_PI_VERSION.join(".")}; detected ${
        (version.stdout || version.stderr).trim() || "unknown"
      }.`);
    }
  })();
  return interactivePiVersionCheck;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildShellCommand(argv: string[]): string {
  return argv.map((arg) => shellQuote(arg)).join(" ");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Remove every selected secret only when deletion succeeds or absence is proven. */
async function removeSelectedSensitiveArtifacts(
  paths: RunArtifactPaths,
  removePath: (secretPath: string) => Promise<void> = async (secretPath) => {
    await fs.promises.rm(secretPath, { recursive: true, force: true });
  },
): Promise<boolean> {
  try { await assertSafeRunArtifactPaths(paths); } catch { return false; }
  const selected = [
    paths.taskPath, paths.systemPromptPath, paths.childSessionPath, paths.secretEnvPath,
    paths.wrapperPath, paths.wrapperStatusPath, paths.stderrPath, paths.shellHomePath,
  ];
  const entries = await fs.promises.readdir(paths.runDir, { withFileTypes: true }).catch(() => null);
  if (!entries) return false;
  for (const entry of entries) {
    if (entry.isFile() && /^wrapper-status\.tmp\.([1-9][0-9]*)$/.test(entry.name)) selected.push(path.join(paths.runDir, entry.name));
  }
  let allAbsent = true;
  for (const secretPath of selected) {
    try { await removePath(secretPath); } catch { /* absence check is authoritative */ }
    try { await fs.promises.lstat(secretPath); allAbsent = false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") allAbsent = false;
    }
  }
  return allAbsent;
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

/** Resolve an existing regular file. Symlinks and script files are valid. */
export function resolveRegularFile(candidate: string, executable: boolean): string | null {
  try {
    const resolved = fs.realpathSync(candidate);
    const file = fs.statSync(resolved);
    if (!file.isFile()) return null;
    fs.accessSync(resolved, executable ? fs.constants.X_OK : fs.constants.R_OK);
    return resolved;
  } catch { return null; }
}

function resolvePathExecutable(env: NodeJS.ProcessEnv, command: string, excludedPath?: string): string | null {
  const rawPath = env.PATH;
  if (!rawPath) return null;
  for (const directory of rawPath.split(path.delimiter)) {
    // Empty and relative PATH entries deliberately retain normal shell PATH
    // semantics. PATH is an explicit user-controlled trust boundary.
    const candidate = path.resolve(directory || ".", command);
    const resolved = resolveRegularFile(candidate, true);
    if (resolved && resolved !== excludedPath) return resolved;
  }
  return null;
}

/** Resolve the concrete interpreter that the kernel will use for a runtime. */
export function resolveRuntimeInterpreter(runtimePath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const runtime = resolveRegularFile(runtimePath, true);
  if (!runtime) return null;
  try {
    const firstLine = fs.readFileSync(runtime, "utf8").split(/\r?\n/, 1)[0] ?? "";
    if (!firstLine.startsWith("#!")) return runtime;
    const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    if (words[0] === "/usr/bin/env") {
      const command = words.find((word, index) => index > 0 && !word.startsWith("-"));
      return command ? resolvePathExecutable(env, command, runtime) : null;
    }
    return path.isAbsolute(words[0]) ? resolveRegularFile(words[0], true) : resolvePathExecutable(env, words[0], runtime);
  } catch {
    return null;
  }
}

function resolveConfiguredExecutable(env: NodeJS.ProcessEnv, configured: string): string | null {
  if (path.isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) {
    return resolveRegularFile(path.resolve(configured), true);
  }
  return resolvePathExecutable(env, configured);
}

/** Resolve the runtime deterministically, preserving user PATH/shim choices. */
export function resolveBrokerRuntime(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env[BROKER_RUNTIME_ENV]?.trim();
  if (configured) return resolveConfiguredExecutable(env, configured);
  return resolvePathExecutable(env, "bun") ?? resolvePathExecutable(env, "node");
}

/** Resolve an existing executable backend without classifying its provenance. */
export function resolveBackendExecutable(mode: "cmux-pane" | "tmux-pane", env: NodeJS.ProcessEnv = process.env): string | null {
  if (mode === "cmux-pane") {
    const configured = env[CMUX_BUNDLED_CLI_PATH_ENV]?.trim();
    if (configured) return resolveConfiguredExecutable(env, configured);
    return resolvePathExecutable(env, "cmux");
  }
  return resolvePathExecutable(env, "tmux");
}

/** Revalidate the exact executable selected before a lifecycle operation. */
export function resolveBackendPath(_mode: "cmux-pane" | "tmux-pane", candidate: string): string | null {
  return resolveRegularFile(candidate, true);
}

type BackendCommandRunner = CmuxCommandRunner & TmuxCommandRunner;

/** Each lifecycle operation revalidates the preflight-selected executable. */
function createBackendCommandRunner(mode: "cmux-pane" | "tmux-pane", backendPath: string): BackendCommandRunner {
  return async (args, options = {}) => {
    if (resolveBackendPath(mode, backendPath) !== backendPath) {
      return { exitCode: 1, stdout: "", stderr: "Backend executable is no longer available after preflight.", aborted: false };
    }
    const result = await runCommandCapture(backendPath, args, { signal: options.signal, env: buildBrokerEnvironment(process.env, mode) });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, aborted: result.aborted };
  };
}

/** Bind active lifecycle calls to the exact resolved executable in V2 intent. */
function bindInteractiveBackend(backend: InteractivePaneBackend, backendPath: string): InteractivePaneBackend {
  const run = createBackendCommandRunner(backend.mode, backendPath);
  if (backend.mode === "cmux-pane") {
    return {
      ...backend,
      inspect: async (handle) => handle.mode === "cmux-pane" ? await inspectCmuxSurface(handle.native, run) : undefined,
      interrupt: async (handle) => handle.mode === "cmux-pane" && await interruptCmuxSurface(handle.native, run),
      close: async (handle) => handle.mode === "cmux-pane" && await closeCmuxSurface(handle.native, run),
    };
  }
  return {
    ...backend,
    inspect: async (handle) => {
      if (handle.mode !== "tmux-pane") return undefined;
      const snapshot = await inspectTmuxPaneFingerprint(handle.native, run);
      return snapshot && { exists: snapshot.exists, exited: snapshot.dead, title: snapshot.title };
    },
    interrupt: async (handle) => handle.mode === "tmux-pane" && await interruptTmuxPane(handle.native, run),
    close: async (handle) => handle.mode === "tmux-pane" && await closeTmuxPane(handle.native, run),
  };
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fileExists(filePath)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

export async function runCommandCapture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; signalCode: NodeJS.Signals | null; aborted: boolean }> {
  return await new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let abortHandler: (() => void) | undefined;

    const finish = (exitCode: number, signalCode: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      resolve({ exitCode, stdout, stderr, signalCode, aborted });
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (!stderr.trim()) stderr = err.message;
      finish(1);
    });
    proc.on("close", (code, signalCode) => finish(code ?? 0, signalCode ?? null));

    if (options.signal) {
      abortHandler = () => {
        if (settled) return;
        aborted = true;
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.unref();
          }
          return;
        }
        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!settled) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function writeForkSessionToTempFile(
  agentName: string,
  sessionJsonl: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `fork-${safeName}.jsonl`);
  fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function writeTaskToTempFile(
  agentName: string,
  task: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `task-${safeName}.md`);
  fs.writeFileSync(filePath, `Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

function findNearestProjectAgentsDirForRunner(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // ignore
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function getProjectRootForCwd(cwd: string): string | null {
  const projectAgentsDir = findNearestProjectAgentsDirForRunner(cwd);
  return projectAgentsDir ? canonicalizePathForTrust(path.dirname(path.dirname(projectAgentsDir))) : null;
}

/** Project-agent approval authorizes only the supplied agent prompt, never a
 * child's general Pi project configuration, extensions, packages, or themes. */
export function applyChildProjectIsolation(args: string[], _cwd: string): void {
  // This is unconditional: non-.pi projects can still load inherited agent
  // and skill configuration through foreign paths.
  // A selected trusted project agent's prompt is already supplied directly.
  // Strip inherited approval/context controls and append canonical hard-deny
  // switches so aliases cannot leave an enabled or ambiguous project channel.
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const flag = args[index];
    if (["--approve", "-a", "--no-approve", "-na", "--no-context-files", "-nc"].includes(flag!)) {
      args.splice(index, 1);
      continue;
    }
    // Pi 0.80.10 has no enable counterpart, but discard these defensively if
    // a caller injected a future/foreign context-file option into child argv.
    if (flag === "--context-file" || flag === "--context-files") {
      const next = args[index + 1];
      args.splice(index, next !== undefined && !next.startsWith("-") ? 2 : 1);
    }
  }
  args.push("--no-context-files", "--no-approve");
}

function buildPropagatedSubagentEnv(opts: {
  agentName: string;
  parentDepth: number;
  parentAgentStack: string[];
  maxDepth: number;
  preventCycles: boolean;
  interactivePaneLayout?: InteractivePaneLayout;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
}): Record<string, string> {
  const trustedProjectsEnv = JSON.stringify(opts.trustedProjectRoots ?? []);
  const deniedProjectsEnv = JSON.stringify(opts.deniedProjectRoots ?? []);
  const nextDepth = Math.max(0, Math.floor(opts.parentDepth)) + 1;
  const propagatedMaxDepth = Math.max(0, Math.floor(opts.maxDepth));
  const propagatedStack = [...opts.parentAgentStack, opts.agentName];

  return {
    [SUBAGENT_DEPTH_ENV]: String(nextDepth),
    [SUBAGENT_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
    [SUBAGENT_STACK_ENV]: JSON.stringify(propagatedStack),
    [SUBAGENT_PREVENT_CYCLES_ENV]: opts.preventCycles ? "1" : "0",
    [INTERACTIVE_PANE_LAYOUT_ENV]: opts.interactivePaneLayout ?? "auto",
    [SUBAGENT_TRUSTED_PROJECTS_ENV]: trustedProjectsEnv,
    [SUBAGENT_DENIED_PROJECTS_ENV]: deniedProjectsEnv,
    [PI_OFFLINE_ENV]: "1",
  };
}

export function resolveInheritedCliApiKeyForChild(
  inheritedCliArgs: InheritedCliAuthContext,
  agent?: Pick<AgentConfig, "source" | "model">,
  options: { projectAgentTrusted?: boolean } = {},
): { inheritedApiKeyBinding: InheritedCliApiKeyEnvBinding | null; warningMessage: string | null } {
  const parentExplicitProvider = inheritedCliArgs.provider?.trim().toLowerCase() || null;
  const parentModelProvider = getProviderFromModelSpecifier(inheritedCliArgs.fallbackModel);
  const parentAuthoritativeProvider = parentExplicitProvider ?? parentModelProvider;
  const parentHasAuthoritativeProviderHint = Boolean(parentAuthoritativeProvider);
  const agentModelProvider = getProviderFromModelSpecifier(agent?.model);
  if (inheritedCliArgs.apiKey?.trim() && parentExplicitProvider && parentModelProvider && parentExplicitProvider !== parentModelProvider) {
    return {
      inheritedApiKeyBinding: null,
      warningMessage: `Inherited CLI --api-key was not propagated because the parent provider hint (${parentExplicitProvider}) conflicts with the parent model provider (${parentModelProvider}). Use provider-specific environment variables or align the parent provider and model.`,
    };
  }
  if (inheritedCliArgs.apiKey?.trim() && parentAuthoritativeProvider && agentModelProvider && parentAuthoritativeProvider !== agentModelProvider) {
    return {
      inheritedApiKeyBinding: null,
      warningMessage: `Inherited CLI --api-key was not propagated because the parent provider hint (${parentAuthoritativeProvider}) conflicts with the child model provider (${agentModelProvider}). Use provider-specific environment variables or align the parent provider/model with the subagent model.`,
    };
  }
  const canUseAgentModelProvider =
    !parentHasAuthoritativeProviderHint &&
    agentModelProvider &&
    (
      agent?.source === "user" ||
      (agent?.source === "project" && options.projectAgentTrusted === true)
    )
      ? agentModelProvider
      : null;
  const providerHintModel =
    agent?.source === "user" &&
    !agentModelProvider &&
    !parentHasAuthoritativeProviderHint
      ? agent.model
      : undefined;

  const resolution = resolveInheritedCliApiKeyEnvBinding({
    ...inheritedCliArgs,
    provider: parentExplicitProvider ?? inheritedCliArgs.provider ?? canUseAgentModelProvider ?? undefined,
    providerHintModel,
  });
  if (resolution.state === "ambiguous") {
    return {
      inheritedApiKeyBinding: null,
      warningMessage: getAmbiguousInheritedCliApiKeyMessage(resolution),
    };
  }

  return {
    inheritedApiKeyBinding: resolution.state === "resolved" ? resolution.binding : null,
    warningMessage: null,
  };
}

function getDefaultPiAgentDir(baseEnv: NodeJS.ProcessEnv = process.env): string {
  return baseEnv[PI_AGENT_DIR_ENV] || path.join(os.homedir(), ".pi", "agent");
}

export function prepareInheritedApiKeyAgentDir(
  binding: InheritedCliApiKeyEnvBinding | null | undefined,
  options: {
    baseEnv?: NodeJS.ProcessEnv;
    mkdtempSync?: (prefix: string) => string;
    readdirSync?: typeof fs.readdirSync;
    symlinkSync?: typeof fs.symlinkSync;
    writeFileSync?: typeof fs.writeFileSync;
  } = {},
): string | null {
  if (!binding) return null;
  const baseEnv = options.baseEnv ?? process.env;
  const sourceAgentDir = baseEnv[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] || getDefaultPiAgentDir(baseEnv);
  const mkdtempSync = options.mkdtempSync ?? fs.mkdtempSync;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const symlinkSync = options.symlinkSync ?? fs.symlinkSync;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const overlayDir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agent-"));

  try {
    for (const entry of readdirSync(sourceAgentDir, { withFileTypes: true })) {
      if (entry.name === "auth.json") continue;
      symlinkSync(path.join(sourceAgentDir, entry.name), path.join(overlayDir, entry.name));
    }
  } catch {
    // Missing/unreadable agent dirs are acceptable; the child will see an
    // otherwise empty agent dir with just the inherited auth override.
  }

  try {
    const auth: Record<string, unknown> = {
      [binding.provider]: { type: "api_key", key: `$${SUBAGENT_INHERITED_API_KEY_ENV}` },
    };
    writeFileSync(path.join(overlayDir, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    return overlayDir;
  } catch (error) {
    cleanupTempDir(overlayDir);
    throw error;
  }
}

export function buildChildProcessEnv(opts: {
  agentName: string;
  parentDepth: number;
  parentAgentStack: string[];
  maxDepth: number;
  preventCycles: boolean;
  interactivePaneLayout?: InteractivePaneLayout;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
  inheritedApiKeyBinding?: InheritedCliApiKeyEnvBinding | null;
  inheritedApiKeyAgentDir?: string | null;
  baseEnv?: NodeJS.ProcessEnv;
  runProtocolEnv?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(opts.baseEnv ?? process.env),
    ...buildPropagatedSubagentEnv(opts),
  };

  for (const name of [
    SUBAGENT_RUN_ID_ENV,
    SUBAGENT_RUN_STATE_PATH_ENV,
    SUBAGENT_RUN_COMPLETION_PATH_ENV,
    SUBAGENT_PARENT_LEASE_PATH_ENV,
    SUBAGENT_CHILD_SESSION_PATH_ENV,
    SUBAGENT_RUN_OWNERSHIP_ENV,
    SUBAGENT_LEASE_STALE_MS_ENV,
    SUBAGENT_EXPECTED_PARENT_PID_ENV,
    SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
  ]) {
    delete env[name];
  }
  Object.assign(env, opts.runProtocolEnv ?? {});

  if (opts.inheritedApiKeyAgentDir) {
    env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] = env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] || getDefaultPiAgentDir(opts.baseEnv ?? process.env);
    env[PI_AGENT_DIR_ENV] = opts.inheritedApiKeyAgentDir;
    if (opts.inheritedApiKeyBinding) env[SUBAGENT_INHERITED_API_KEY_ENV] = opts.inheritedApiKeyBinding.value;
  } else {
    delete env[SUBAGENT_INHERITED_API_KEY_ENV];
    if (env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV]) {
      env[PI_AGENT_DIR_ENV] = env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV];
      delete env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV];
    } else if (opts.inheritedApiKeyBinding) {
      env[opts.inheritedApiKeyBinding.name] = opts.inheritedApiKeyBinding.value;
    }
  }

  return env;
}

function stripFlagWithValue(argv: string[], flagName: string): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flagName) {
      i += 1;
      continue;
    }
    filtered.push(argv[i]!);
  }
  return filtered;
}

export function getInheritedCliArgsForAgent(
  agent: Pick<AgentConfig, "source" | "model">,
  alwaysProxy: string[] = inheritedCliArgs.alwaysProxy,
  fallbackModel: string | undefined = inheritedCliArgs.fallbackModel,
  modelOverride?: string,
): string[] {
  if (!getProviderFromModelSpecifier(modelOverride ?? agent.model ?? fallbackModel)) return alwaysProxy;
  return stripFlagWithValue(alwaysProxy, "--provider");
}

/** Resolve this package's own extension entrypoint from the runtime module.
 * This remains valid for both the repository and an installed package layout. */
export function resolveCurrentPackageExtensionEntrypoint(moduleUrl: string = import.meta.url): string {
  return canonicalizePathForTrust(fileURLToPath(new URL("../../index.ts", moduleUrl)));
}

function canonicalizeExtensionPath(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "file:") return canonicalizePathForTrust(fileURLToPath(url));
  } catch {
    // Non-URL extension sources retain their inherited representation.
  }
  return canonicalizePathForTrust(value);
}

/** Preserve inherited extensions while ensuring child bootstrap extensions are unique. */
export function buildInteractiveExtensionArgs(
  inheritedExtensions: string[],
  selfExtensionPath: string = resolveCurrentPackageExtensionEntrypoint(),
  childBridgePath: string = CHILD_BRIDGE_PATH,
): string[] {
  const self = canonicalizeExtensionPath(selfExtensionPath);
  const bridge = canonicalizeExtensionPath(childBridgePath);
  const filtered: string[] = [];
  for (let index = 0; index < inheritedExtensions.length; index += 1) {
    const flag = inheritedExtensions[index]!;
    if (flag === "--extension" || flag === "-e") {
      const value = inheritedExtensions[index + 1];
      if (value !== undefined) {
        const extension = canonicalizeExtensionPath(value);
        if (extension === self || extension === bridge) {
          index += 1;
          continue;
        }
        filtered.push(flag, value);
        index += 1;
        continue;
      }
    }
    filtered.push(flag);
  }
  return [...filtered, "--extension", self, "--extension", bridge];
}

export function buildPiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  taskFilePath: string,
  delegationMode: DelegationMode,
  forkSessionPath: string | null,
  modelOverride?: string,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inheritedCliArgs.extensionArgs,
    ...getInheritedCliArgsForAgent(agent, inheritedCliArgs.alwaysProxy, inheritedCliArgs.fallbackModel, modelOverride),
    "-p",
  ];

  if (delegationMode === "spawn") {
    args.push("--no-session");
  } else if (forkSessionPath) {
    args.push("--session", forkSessionPath);
  }

  const model = modelOverride ?? agent.model ?? inheritedCliArgs.fallbackModel;
  if (model) args.push("--model", model);

  const thinking = agent.thinking ?? inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  } else if (agent.tools === undefined) {
    if (inheritedCliArgs.fallbackTools !== undefined) {
      args.push("--tools", inheritedCliArgs.fallbackTools);
    } else if (inheritedCliArgs.fallbackNoTools) {
      args.push("--no-tools");
    }
  }

  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  args.push(`@${taskFilePath}`);
  return args;
}

export function buildInteractivePiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  taskFilePath: string,
  childSessionPath: string,
  modelOverride?: string,
): string[] {
  const args: string[] = [
    ...buildInteractiveExtensionArgs(inheritedCliArgs.extensionArgs),
    ...getInheritedCliArgsForAgent(agent, inheritedCliArgs.alwaysProxy, inheritedCliArgs.fallbackModel, modelOverride),
    "--session",
    childSessionPath,
  ];

  const model = modelOverride ?? agent.model ?? inheritedCliArgs.fallbackModel;
  if (model) args.push("--model", model);
  const thinking = agent.thinking ?? inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  } else if (agent.tools === undefined) {
    if (inheritedCliArgs.fallbackTools !== undefined) args.push("--tools", inheritedCliArgs.fallbackTools);
    else if (inheritedCliArgs.fallbackNoTools) args.push("--no-tools");
  }
  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  args.push(`@${taskFilePath}`);
  return args;
}

export function buildInteractiveChildSessionJsonl(options: {
  cwd: string;
  parentSessionFile?: string;
  forkSessionSnapshotJsonl?: string;
  sessionId?: string;
}): string {
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: options.sessionId ?? createRunId(),
    timestamp: new Date().toISOString(),
    cwd: options.cwd,
  };
  if (options.parentSessionFile) header.parentSession = options.parentSessionFile;
  const lines = [JSON.stringify(header)];
  if (options.forkSessionSnapshotJsonl?.trim()) {
    const inheritedLines = options.forkSessionSnapshotJsonl.split(/\r?\n/).filter((line) => line.trim());
    for (const line of inheritedLines.slice(1)) {
      JSON.parse(line);
      lines.push(line);
    }
  }
  return `${lines.join("\n")}\n`;
}

function isProjectAgentExplicitlyTrusted(
  agent: Pick<AgentConfig, "source" | "filePath"> | undefined,
  trustedProjectRoots?: string[],
  deniedProjectRoots?: string[],
): boolean {
  if (!agent || agent.source !== "project") return false;
  return isTrustedProjectAgentsDirWithSessionOverrides(path.dirname(agent.filePath), {
    sessionTrustedProjectRoots: trustedProjectRoots,
    sessionDeniedProjectRoots: deniedProjectRoots,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Fallback working directory when the task doesn't specify one. */
  cwd: string;
  /** All available agent configs. */
  agents: AgentConfig[];
  /** Name of the agent to run. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Optional chain stage label used for UI display. */
  stageLabel?: string;
  /** Optional override working directory. */
  taskCwd?: string;
  /** Optional per-call model override. */
  model?: string;
  /** Context mode: spawn (fresh) or fork (session snapshot + task). */
  delegationMode: DelegationMode;
  /** Execution surface for child runs. */
  terminalMode: TerminalMode;
  /** Exact parent-resolved interactive pane placement policy. */
  interactivePaneLayout?: InteractivePaneLayout;
  /** Trusted project roots to propagate to child processes as temporary approvals. */
  trustedProjectRoots?: string[];
  /** Denied project roots to propagate to child processes as temporary denials. */
  deniedProjectRoots?: string[];
  /** Serialized parent session snapshot used when delegationMode is "fork". */
  forkSessionSnapshotJsonl?: string;
  /** Parent session identity used for durable child lineage. */
  parentSessionId?: string;
  /** Parent session file used for durable child lineage. */
  parentSessionFile?: string;
  /** Session generation captured before validation/approval awaits. */
  interactiveShutdownGeneration?: number;
  /** Current delegation depth of the caller process. */
  parentDepth: number;
  /** Delegation stack from the caller process (ancestor agent names). */
  parentAgentStack: string[];
  /** Maximum allowed delegation depth to propagate to child processes. */
  maxDepth: number;
  /** Whether cycle prevention should be enforced in child processes. */
  preventCycles: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Factory to wrap results into SubagentDetails. */
  makeDetails: (results: SingleResult[]) => SubagentDetails;
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agents,
    agentName,
    task,
    stageLabel,
    taskCwd,
    model: modelOverride,
    delegationMode,
    terminalMode,
    interactivePaneLayout = resolveInteractivePaneLayout(undefined),
    trustedProjectRoots,
    deniedProjectRoots,
    forkSessionSnapshotJsonl,
    parentSessionId,
    parentSessionFile,
    interactiveShutdownGeneration = getInteractiveShutdownGenerationForTest(),
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    signal,
    onUpdate,
    makeDetails,
  } = opts;

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      stageLabel,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
      model: modelOverride,
    };
  }

  if (
    delegationMode === "fork" &&
    (!forkSessionSnapshotJsonl || !forkSessionSnapshotJsonl.trim())
  ) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      stageLabel,
      exitCode: 1,
      messages: [],
      stderr:
        "Cannot run in fork mode: missing parent session snapshot context.",
      usage: emptyUsage(),
      model: modelOverride ?? agent.model,
      stopReason: "error",
      errorMessage:
        "Cannot run in fork mode: missing parent session snapshot context.",
    };
  }

  const result: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    stageLabel,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: modelOverride ?? agent.model,
  };

  // A delayed background queue item must not become valid after a new session
  // starts. The extension threads its invocation-time capture here.
  if (!canStartInteractiveRun(interactiveShutdownGeneration)) {
    result.exitCode = 130;
    result.stopReason = "aborted";
    result.errorMessage = "Parent session shutdown fenced this subagent invocation before it started.";
    result.stderr = result.errorMessage;
    return result;
  }

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(result.messages) || "(running...)",
        },
      ],
      details: makeDetails([result]),
    });
  };

  const { inheritedApiKeyBinding, warningMessage: inheritedApiKeyWarningMessage } =
    resolveInheritedCliApiKeyForChild(
      inheritedCliArgs,
      modelOverride ? { ...agent, model: modelOverride } : agent,
      {
        projectAgentTrusted: isProjectAgentExplicitlyTrusted(agent, trustedProjectRoots, deniedProjectRoots),
      },
    );
  if (inheritedApiKeyWarningMessage) {
    console.warn(`[pi-subagent] ${inheritedApiKeyWarningMessage}`);
  }

  const interactiveBackend = getInteractivePaneBackend(terminalMode);
  if (interactiveBackend) {
    return await runAgentInInteractivePane({
      backend: interactiveBackend,
      result,
      agent,
      cwd,
      taskCwd,
      modelOverride,
      delegationMode,
      interactivePaneLayout,
      forkSessionSnapshotJsonl,
      parentSessionId,
      parentSessionFile,
      interactiveShutdownGeneration,
      signal,
      onUpdate: emitUpdate,
      parentDepth,
      parentAgentStack,
      maxDepth,
      preventCycles,
      trustedProjectRoots,
      deniedProjectRoots,
      inheritedApiKeyBinding,
    });
  }

  // Write system prompt to temp file if needed
  let promptTmpDir: string | null = null;
  let promptTmpPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
    promptTmpDir = tmp.dir;
    promptTmpPath = tmp.filePath;
  }

  // Write forked session snapshot if needed
  let forkSessionTmpDir: string | null = null;
  let forkSessionTmpPath: string | null = null;
  if (delegationMode === "fork" && forkSessionSnapshotJsonl) {
    const tmp = writeForkSessionToTempFile(agent.name, forkSessionSnapshotJsonl);
    forkSessionTmpDir = tmp.dir;
    forkSessionTmpPath = tmp.filePath;
  }

  // Keep delegated task text out of child process argv and wrapper scripts.
  const taskTmp = writeTaskToTempFile(agent.name, task);
  let inheritedApiKeyAgentDir: string | null = null;

  try {
    inheritedApiKeyAgentDir = prepareInheritedApiKeyAgentDir(inheritedApiKeyBinding);
    const piArgs = buildPiArgs(
      agent,
      promptTmpPath,
      taskTmp.filePath,
      delegationMode,
      forkSessionTmpPath,
      modelOverride,
    );
    const effectiveCwd = taskCwd ?? cwd;
    applyChildProjectIsolation(piArgs, effectiveCwd);
    return await runAgentInline({
      result,
      cwd,
      taskCwd,
      piArgs,
      signal,
      onUpdate: emitUpdate,
      parentDepth,
      parentAgentStack,
      maxDepth,
      preventCycles,
      interactivePaneLayout,
      trustedProjectRoots,
      deniedProjectRoots,
      makeDetails,
      inheritedApiKeyBinding,
      inheritedApiKeyAgentDir,
    });
  } finally {
    cleanupTempDir(promptTmpDir);
    cleanupTempDir(forkSessionTmpDir);
    cleanupTempDir(taskTmp.dir);
    cleanupTempDir(inheritedApiKeyAgentDir);
  }
}

interface RunAgentExecutionOptions {
  result: SingleResult;
  cwd: string;
  taskCwd?: string;
  piArgs: string[];
  signal?: AbortSignal;
  onUpdate: () => void;
  parentDepth: number;
  parentAgentStack: string[];
  maxDepth: number;
  preventCycles: boolean;
  interactivePaneLayout: InteractivePaneLayout;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
  inheritedApiKeyBinding?: InheritedCliApiKeyEnvBinding | null;
  inheritedApiKeyAgentDir?: string | null;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
}

export function signalUnixProcessTree(
  proc: Pick<ChildProcessWithoutNullStreams, "pid" | "kill">,
  signal: NodeJS.Signals,
  killProcess: (pid: number, signal: NodeJS.Signals) => boolean = process.kill,
): void {
  if (typeof proc.pid === "number") {
    try {
      killProcess(-proc.pid, signal);
      return;
    } catch {
      // The child may not own a process group; fall back to the direct pid.
    }
  }
  proc.kill(signal);
}

export async function monitorInlineProcess(
  proc: ChildProcessWithoutNullStreams,
  result: SingleResult,
  signal: AbortSignal | undefined,
  onUpdate: () => void,
): Promise<{ exitCode: number; wasAborted: boolean }> {
  let wasAborted = false;
  const exitCode = await new Promise<number>((resolve) => {
    let didClose = false;
    let settled = false;
    let abortHandler: (() => void) | undefined;
    let semanticCompletionTimer: NodeJS.Timeout | undefined;

    const clearSemanticCompletionTimer = () => {
      if (semanticCompletionTimer) {
        clearTimeout(semanticCompletionTimer);
        semanticCompletionTimer = undefined;
      }
    };

    const terminateChild = () => {
      if (isWindows) {
        if (proc.pid !== undefined) {
          const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
            stdio: "ignore",
          });
          killer.unref();
        }
        return;
      }

      signalUnixProcessTree(proc, "SIGTERM");
      const sigkillTimer = setTimeout(() => {
        if (!didClose) signalUnixProcessTree(proc, "SIGKILL");
      }, SIGKILL_TIMEOUT_MS);
      sigkillTimer.unref();
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearSemanticCompletionTimer();
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      resolve(code);
    };

    const flushLine = (line: string) => {
      if (processPiJsonLine(line, result)) onUpdate();
      maybeFinishFromAgentEnd();
    };

    const chunkProcessor = createJsonLineChunkProcessor(flushLine);

    const maybeFinishFromAgentEnd = () => {
      if (!result.sawAgentEnd || didClose || settled) return;
      clearSemanticCompletionTimer();
      semanticCompletionTimer = setTimeout(() => {
        if (didClose || settled || !result.sawAgentEnd) return;
        chunkProcessor.flushRemainder();
        proc.stdout.removeListener("data", onStdoutData);
        proc.stderr.removeListener("data", onStderrData);
        finish(0);
        terminateChild();
      }, AGENT_END_GRACE_MS);
      semanticCompletionTimer.unref();
    };

    const onStdoutData = (chunk: Buffer) => {
      chunkProcessor.pushChunk(chunk.toString());
    };

    const onStderrData = (chunk: Buffer) => {
      result.stderr += chunk.toString();
    };

    proc.stdout.on("data", onStdoutData);
    proc.stderr.on("data", onStderrData);

    proc.on("close", (code) => {
      didClose = true;
      chunkProcessor.flushRemainder();
      finish(code ?? 0);
    });

    proc.on("error", (err) => {
      if (!result.stderr.trim()) result.stderr = err.message;
      finish(1);
    });

    if (signal) {
      abortHandler = () => {
        if (didClose || settled) return;
        wasAborted = true;
        terminateChild();
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });

  return { exitCode, wasAborted };
}

async function runAgentInline(opts: RunAgentExecutionOptions): Promise<SingleResult> {
  const {
    result,
    cwd,
    taskCwd,
    piArgs,
    signal,
    onUpdate,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    interactivePaneLayout,
    trustedProjectRoots,
    deniedProjectRoots,
    inheritedApiKeyBinding,
    inheritedApiKeyAgentDir,
  } = opts;

  const { command, prefixArgs } = resolvePiSpawn();
  const proc = spawn(command, [...prefixArgs, ...piArgs], {
    cwd: taskCwd ?? cwd,
    shell: false,
    detached: !isWindows,
    stdio: ["pipe", "pipe", "pipe"],
    env: buildChildProcessEnv({
      agentName: result.agent,
      parentDepth,
      parentAgentStack,
      maxDepth,
      preventCycles,
      interactivePaneLayout,
      trustedProjectRoots,
      deniedProjectRoots,
      inheritedApiKeyBinding,
      inheritedApiKeyAgentDir,
    }),
  });

  proc.stdin.on("error", () => {
    /* ignore broken pipe on fast exits */
  });
  proc.stdin.end();

  const { exitCode, wasAborted } = await monitorInlineProcess(proc, result, signal, onUpdate);
  result.exitCode = exitCode;
  return normalizeCompletedResult(result, wasAborted);
}

interface RunAgentInInteractivePaneOptions {
  backend: InteractivePaneBackend;
  result: SingleResult;
  agent: AgentConfig;
  cwd: string;
  taskCwd?: string;
  modelOverride?: string;
  delegationMode: DelegationMode;
  forkSessionSnapshotJsonl?: string;
  parentSessionId?: string;
  parentSessionFile?: string;
  interactiveShutdownGeneration: number;
  signal?: AbortSignal;
  onUpdate: () => void;
  parentDepth: number;
  parentAgentStack: string[];
  maxDepth: number;
  preventCycles: boolean;
  interactivePaneLayout: InteractivePaneLayout;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
  inheritedApiKeyBinding?: InheritedCliApiKeyEnvBinding | null;
}

const MULTIPLEXER_IDENTITY_ENV = new Set(["TMUX", "TMUX_PANE", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID"]);

// Pi 0.80.10 docs/providers.md environment contract. Interactive children
// receive these through the private 0600 artifact, not broker argv/environment.
const PROVIDER_CONFIGURATION_ENV = [
  "AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME", "AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID",
  "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME",
  "AWS_BEDROCK_FORCE_CACHE", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "AWS_BEDROCK_SKIP_AUTH", "AWS_BEDROCK_FORCE_HTTP1",
  "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS",
  "PI_CACHE_RETENTION",
] as const;
const PROXY_AND_CERTIFICATE_ENV = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
] as const;
const CHILD_BOOTSTRAP_ENV = new Set([
  "HOME", "USER", "LOGNAME", "PATH", "LANG", "TERM", "COLORTERM", "NO_COLOR",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  ...Object.values(PROVIDER_API_KEY_ENV_VAR_MAP),
  ...PROVIDER_CONFIGURATION_ENV,
  ...PROXY_AND_CERTIFICATE_ENV,
  // These are restored only from the private 0600 environment script after
  // the wrapper removes inherited state. Dynamic pane identities are not.
  "CMUX_SOCKET_PATH", "CMUX_SOCKET_CAPABILITY", CMUX_BUNDLED_CLI_PATH_ENV,
  PI_AGENT_DIR_ENV, SUBAGENT_ORIGINAL_AGENT_DIR_ENV, SUBAGENT_INHERITED_API_KEY_ENV,
  SUBAGENT_DEPTH_ENV, SUBAGENT_MAX_DEPTH_ENV, SUBAGENT_STACK_ENV, SUBAGENT_PREVENT_CYCLES_ENV,
  INTERACTIVE_PANE_LAYOUT_ENV, SUBAGENT_TRUSTED_PROJECTS_ENV, SUBAGENT_DENIED_PROJECTS_ENV, PI_OFFLINE_ENV,
  SUBAGENT_RUN_ID_ENV, SUBAGENT_RUN_STATE_PATH_ENV, SUBAGENT_RUN_COMPLETION_PATH_ENV,
  SUBAGENT_PARENT_LEASE_PATH_ENV, SUBAGENT_CHILD_SESSION_PATH_ENV, SUBAGENT_RUN_OWNERSHIP_ENV,
  SUBAGENT_LEASE_STALE_MS_ENV, SUBAGENT_EXPECTED_PARENT_PID_ENV, SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
]);

/** Explicit child allowlist; provider auth, proxy, and CA settings stay private. */
/** Environment authority for the detached broker and every command it runs. */
export function buildTmuxSourcePaneProbeArgs(socketPath?: string): string[] {
  return [...(socketPath ? ["-S", socketPath] : []), "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"];
}

export function parseTmuxSourcePaneProbe(stdout: string, paneId: string): number | null {
  const parsed = parseTmuxPanePidList(stdout, paneId);
  return typeof parsed === "number" ? parsed : null;
}

export function buildBrokerEnvironment(env: NodeJS.ProcessEnv, mode: "cmux-pane" | "tmux-pane"): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = {
    // Keep the resolver PATH for env-shebang runtime/backend shims. This is
    // still an explicit allowlisted value, not inherited shell state.
    PATH: env.PATH || "/usr/bin:/bin",
    HOME: env.HOME || os.homedir(),
    TMPDIR: env.TMPDIR || os.tmpdir(),
    TERM: env.TERM || "xterm-256color",
  };
  for (const key of mode === "cmux-pane"
    ? ["CMUX_SOCKET_PATH", "CMUX_SOCKET_CAPABILITY", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", CMUX_BUNDLED_CLI_PATH_ENV]
    : ["TMUX", "TMUX_PANE"]) {
    if (env[key] !== undefined) minimal[key] = env[key];
  }
  return minimal;
}

export function buildPrivateChildEnvironmentScript(env: NodeJS.ProcessEnv): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
    if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (!CHILD_BOOTSTRAP_ENV.has(key) && !key.startsWith("LC_")) continue;
    if (MULTIPLEXER_IDENTITY_ENV.has(key)) continue;
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function buildInteractivePaneWrapperScript(options: {
  effectiveCwd: string;
  childCommand: string[];
  exportedEnv: Record<string, string>;
  secretEnvPath?: string;
  wrapperStatusPath: string;
  cleanupDirs?: string[];
}): string {
  return [
    "#!/bin/bash",
    "set -uo pipefail",
    "finish_subagent_runtime() {",
    "  status=$?",
    "  trap - EXIT",
    ...(options.cleanupDirs ?? []).map((dir) => `  /bin/rm -rf ${shellQuote(dir)} 2>/dev/null || true`),
    `  status_tmp=${shellQuote(`${options.wrapperStatusPath}.tmp`)}.$$`,
    "  printf '%s\\n' \"$status\" > \"$status_tmp\"",
    `  /bin/mv \"$status_tmp\" ${shellQuote(options.wrapperStatusPath)}`,
    "  exit \"$status\"",
    "}",
    "trap finish_subagent_runtime EXIT",
    // The broker and tmux staged helper use env -i. Clear loader/preload
    // variables again here before the private allowlist is sourced.
    "unset NODE_OPTIONS NODE_PATH BUN_OPTIONS DENO_DIR LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH BASH_ENV ENV",
    "for _pi_env_name in $(compgen -e); do",
    "  case \"$_pi_env_name\" in TMUX|TMUX_PANE|CMUX_WORKSPACE_ID|CMUX_SURFACE_ID) ;; *) unset \"$_pi_env_name\" ;; esac",
    "done",
    "unset _pi_env_name",
    ...(options.secretEnvPath
      ? [
          `. ${shellQuote(options.secretEnvPath)} || { /bin/rm -f ${shellQuote(options.secretEnvPath)}; exit 1; }`,
          `/bin/rm -f ${shellQuote(options.secretEnvPath)}`,
        ]
      : []),
    ...Object.entries(options.exportedEnv)
      .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `cd ${shellQuote(options.effectiveCwd)} || exit 1`,
    buildShellCommand(options.childCommand),
    "",
  ].join("\n");
}

export function shouldRetainBrokerRecoveryMetadata(options: {
  runId: string;
  runDir: string;
  targetConfirmedAbsent: boolean;
  status: Awaited<ReturnType<typeof readBrokerArtifact>>;
  decision: Awaited<ReturnType<typeof readBrokerArtifact>>;
  allocation: Awaited<ReturnType<typeof readBrokerArtifact>>;
  launch?: Awaited<ReturnType<typeof readBrokerArtifact>>;
  gate?: Awaited<ReturnType<typeof readBrokerArtifact>>;
  residualRisk?: Awaited<ReturnType<typeof readBrokerArtifact>>;
}): boolean {
  // Invalid immutable authority is quarantined rather than deleted. A valid
  // allocation is retained until the exact target's absence was observed.
  if ([options.status, options.decision, options.allocation, options.launch, options.gate, options.residualRisk].some((artifact) => artifact?.outcome === "invalid")) return true;
  const status = parseBrokerStatusV2(options.status.outcome === "valid" ? options.status.value : null, options.runId);
  const decision = parseDecisionV2(options.decision.outcome === "valid" ? options.decision.value : null, options.runId, options.runDir);
  const allocation = parseAllocationRecordV2(options.allocation.outcome === "valid" ? options.allocation.value : null, options.runId);
  const launch = parseCommittedLaunchRecordV2(options.launch?.outcome === "valid" ? options.launch.value : null, options.runId, options.runDir);
  const gate = parseLaunchGateV2(options.gate?.outcome === "valid" ? options.gate.value : null, options.runId, options.runDir);
  const residualRisk = parseResidualRiskV2(options.residualRisk?.outcome === "valid" ? options.residualRisk.value : null, options.runId);
  if ((options.status.outcome === "valid" && !status) || (options.decision.outcome === "valid" && !decision) || (options.allocation.outcome === "valid" && !allocation) || (options.launch?.outcome === "valid" && !launch) || (options.gate?.outcome === "valid" && !gate) || (options.residualRisk?.outcome === "valid" && !residualRisk)) return true;
  if (!hasValidV2StateDependencies({ allocation, decision, launch, gate })) return true;
  if (residualRisk || (status?.phase === "failed" && status.errorCode === "possible-unrecorded-allocation")) return true;
  if (status?.writer === "broker" && status.phase === "ready" && !allocation) return true;
  return Boolean(allocation && !options.targetConfirmedAbsent);
}

async function publishParentResidualRisk(paths: RunArtifactPaths, runId: string): Promise<void> {
  // This is post-ready recovery metadata only. Preflight lookup failures return
  // before run artifacts (and therefore secrets) are created.
  await atomicWriteJson(paths.brokerStatusPath, {
    version: BROKER_PROTOCOL_VERSION, runId, writer: "parent", phase: "failed", updatedAt: Date.now(), errorCode: "possible-unrecorded-allocation",
  }).catch(() => undefined);
}

export function allocationMatchesInteractiveBackend(
  allocation: ReturnType<typeof parseAllocationRecordV2>,
  mode: "cmux-pane" | "tmux-pane",
): allocation is NonNullable<ReturnType<typeof parseAllocationRecordV2>> {
  return allocation !== null && allocation.terminalMode === mode;
}

/** The parent must independently bind every committed authority to its backend. */
export function hasCommittedInteractiveLaunchAuthority(options: {
  intent: ReturnType<typeof parseLaunchIntentV2>;
  allocation: ReturnType<typeof parseAllocationRecordV2>;
  decision: ReturnType<typeof parseDecisionV2>;
  launch: ReturnType<typeof parseCommittedLaunchRecordV2>;
  gate: ReturnType<typeof parseLaunchGateV2>;
  mode: "cmux-pane" | "tmux-pane";
}): boolean {
  const { intent, allocation, decision, launch, gate, mode } = options;
  return intent !== null
    && intent.terminalMode === mode
    && allocationMatchesInteractiveBackend(allocation, mode)
    && hasAllocationIntentSourceBinding(intent, allocation)
    && decision?.kind === "commit"
    && launch !== null
    && launch.terminalMode === mode
    && (gate === null || gate.terminalMode === mode)
    && hasValidV2StateDependencies({ allocation, decision, launch, gate });
}

/**
 * Publish an interactive launch gate only while its captured session remains
 * current and unfenced. The lock deliberately spans durable publication and
 * reread validation, so a shutdown either wins before a gate exists or waits
 * to drain the already-registered exact target.
 */
export async function publishInteractiveLaunchGate(options: {
  paths: Pick<RunArtifactPaths, "runDir" | "launchGatePath" | "launchPath">;
  runId: string;
  terminalMode: "cmux-pane" | "tmux-pane";
  generation: number;
  /** Test seam for deterministic publication/fence ordering. */
  beforePublishForTest?: () => Promise<void>;
}): Promise<NonNullable<ReturnType<typeof parseLaunchGateV2>>> {
  return await withInteractiveFenceMutex(async () => {
    await options.beforePublishForTest?.();
    if (!canStartInteractiveRun(options.generation)) {
      throw new Error("Interactive session shutdown fenced this committed run before gate publication.");
    }
    const gate = {
      version: 2 as const,
      runId: options.runId,
      terminalMode: options.terminalMode,
      launchPath: options.paths.launchPath,
      publishedAt: Date.now(),
    };
    await publishImmutableJson(options.paths.launchGatePath, gate);
    const publishedGate = parseLaunchGateV2(
      await readBrokerJson(options.paths.launchGatePath),
      options.runId,
      options.paths.runDir,
    );
    if (!publishedGate) {
      throw new Error("Interactive launch gate authority is malformed or belongs to another backend.");
    }
    return publishedGate;
  });
}

function allocationToHandle(allocation: NonNullable<ReturnType<typeof parseAllocationRecordV2>>): InteractivePaneHandle {
  const placement = "layout" in allocation
    ? { layout: allocation.layout, placement: allocation.placement }
    : undefined;
  return allocation.terminalMode === "cmux-pane"
    ? { mode: "cmux-pane", native: { workspaceId: allocation.target.workspaceId, surfaceId: allocation.target.surfaceId, paneId: allocation.target.paneId }, placement }
    : { mode: "tmux-pane", native: { paneId: allocation.target.paneId, socketPath: allocation.target.socketPath, serverPid: allocation.target.serverPid, panePid: allocation.target.panePid }, placement };
}

/** Narrow coordinator DTO derived from, never substituted for, full V2 authority. */
function cmuxRecordToCommittedLayoutAllocation(allocation: AllocationRecordV2): CmuxCommittedLayoutAllocation {
  if (allocation.terminalMode !== "cmux-pane" || !("layout" in allocation)
    || (allocation.placement !== "cmux-split" && allocation.placement !== "cmux-new-surface")
    || allocation.container.kind !== "cmux-pane") {
    throw new Error("Committed cmux allocation lacks layout authority.");
  }
  return {
    committed: true,
    layout: allocation.layout,
    placement: allocation.placement,
    container: allocation.container,
    target: allocation.target,
  };
}

async function waitForBrokerDecision(paths: RunArtifactPaths, runId: string, signal?: AbortSignal, broker?: ReturnType<typeof spawn>): Promise<ReturnType<typeof parseDecisionV2>> {
  const started = Date.now();
  let sawReady = false;
  let brokerExited = false;
  let brokerSpawnError: Error | null = null;
  broker?.once("exit", () => { brokerExited = true; });
  broker?.once("error", (error) => { brokerExited = true; brokerSpawnError = error; });
  while (Date.now() - started < BROKER_COMMIT_TIMEOUT_MS) {
    const decision = parseDecisionV2(await readBrokerJson(paths.decisionPath), runId, paths.runDir);
    if (decision) return decision;
    const status = parseBrokerStatusV2(await readBrokerJson(paths.brokerStatusPath), runId);
    if (status?.phase === "failed") throw new Error(`Launch broker failed: ${status.errorCode}.`);
    sawReady ||= status?.writer === "broker" && status.phase === "ready";
    if (brokerExited) {
      const allocation = parseAllocationRecordV2(await readBrokerJson(paths.allocationPath), runId);
      if (!decision && !allocation && sawReady) {
        await publishParentResidualRisk(paths, runId);
        throw new Error("Launch broker exited after ready without a durable allocation; residual allocation risk was retained.");
      }
      if (brokerSpawnError) throw new Error(`Launch broker could not start: ${(brokerSpawnError as Error).message}`);
    }
    if (signal?.aborted) break;
    if (!sawReady && Date.now() - started >= BROKER_READY_TIMEOUT_MS) break;
    await delay(POLL_INTERVAL_MS);
  }
  const reason = signal?.aborted ? "parent-abort" : sawReady ? "commit-timeout" : "ready-timeout";
  await publishImmutableJson(paths.decisionPath, { version: 2, runId, kind: "cancel", decidedAt: Date.now(), reason });
  const winner = parseDecisionV2(await readBrokerJson(paths.decisionPath), runId, paths.runDir);
  if (winner?.kind === "commit") return winner;
  if (!winner) throw new Error(`Launch broker ${reason}; decision publication could not be verified.`);
  throw new Error(`Launch broker ${reason}.`);
}

async function publishParentCompletion(paths: RunArtifactPaths, runId: string, status: "failed" | "aborted", errorCode: "parent-aborted" | "wrapper-exited" | "pane-missing" | "inspect-exhausted"): Promise<{ completion: NonNullable<ReturnType<typeof parseCompletionRecordV2>>; won: boolean }> {
  // Completion is terminal authority: a concurrent valid bridge/reaper winner
  // must drive the result, while malformed immutable authority is an error.
  const record = { version: BROKER_PROTOCOL_VERSION, runId, status, completedAt: Date.now(), errorCode };
  const completion = await publishCompletionRecordV2(paths.completionPath, record);
  return { completion, won: completion.status === record.status && completion.completedAt === record.completedAt && completion.errorCode === record.errorCode };
}

function applyInteractiveCompletion(result: SingleResult, completion: { status: "completed" | "failed" | "aborted" | "orphaned" }): void {
  switch (completion.status) {
    case "completed":
      result.exitCode = 0;
      result.sawAgentEnd = true;
      if (!getFinalOutput(result.messages).trim()) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.errorMessage = "Subagent settled without a final assistant response.";
      }
      break;
    case "failed":
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage ||= result.stderr.trim() || "Subagent failed.";
      break;
    case "aborted":
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      break;
    case "orphaned":
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = "Subagent stopped after its parent lease expired.";
      break;
  }
}

async function runAgentInInteractivePane(options: RunAgentInInteractivePaneOptions): Promise<SingleResult> {
  const { result } = options;
  // Recheck at the interactive boundary as inline preparation/approval may
  // have yielded since runAgent performed its first check.
  if (!canStartInteractiveRun(options.interactiveShutdownGeneration)) {
    result.exitCode = 130;
    result.stopReason = "aborted";
    result.errorMessage = "Parent session shutdown fenced this interactive subagent before allocation.";
    result.stderr = result.errorMessage;
    return result;
  }
  let backend = options.backend;
  const availabilityError = backend.availabilityError();
  if (availabilityError) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = availabilityError;
    result.stderr = result.errorMessage;
    return result;
  }

  try {
    await ensureInteractivePiVersion();
  } catch (error) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    result.stderr = result.errorMessage;
    return result;
  }

  // Resolve the deterministic runtime/backend selection before task, prompt,
  // session, or secret artifacts are written. The user's executable PATH is
  // intentionally the trust boundary for this interactive launch.
  const effectiveCwd = options.taskCwd ?? options.cwd;
  const brokerRuntime = resolveBrokerRuntime(process.env);
  // A selected runtime can be an env-shebang shim. Record the interpreter
  // that will actually execute it; for a native Bun/Node runtime this is the
  // selected runtime itself, not the parent Pi executable.
  const runtimeInterpreter = brokerRuntime ? resolveRuntimeInterpreter(brokerRuntime, process.env) : null;
  const backendExecutable = resolveBackendExecutable(backend.mode, process.env);
  const brokerEntrypoint = resolveRegularFile(BROKER_ENTRYPOINT, false);
  if (!brokerRuntime || !runtimeInterpreter || !backendExecutable || !brokerEntrypoint) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = "Interactive pane mode requires an available broker runtime, broker entrypoint, and backend executable.";
    result.stderr = result.errorMessage;
    return result;
  }

  backend = bindInteractiveBackend(backend, backendExecutable);
  const backendRun = createBackendCommandRunner(backend.mode, backendExecutable);
  let paths: RunArtifactPaths | null = null;
  let handle: InteractivePaneHandle | null = null;
  let inheritedApiKeyAgentDir: string | null = null;
  let leaseWriter: ReturnType<typeof startParentLeaseWriter> | null = null;
  let completedNormally = false;
  let preserveDiagnostics = false;
  let retainRecoveryMetadata = false;
  let targetConfirmedAbsent = false;
  let committedRunId: string | null = null;
  let releaseHandle: (() => Promise<boolean>) | null = null;
  try {
    paths = await prepareRunArtifactPaths();
    const runPaths = paths;
    await writePrivateFile(paths.taskPath, `Task: ${result.task}`);
    if (options.agent.systemPrompt.trim()) {
      await writePrivateFile(paths.systemPromptPath, options.agent.systemPrompt);
    }
    const initialChildSessionJsonl = buildInteractiveChildSessionJsonl({
      cwd: effectiveCwd,
      parentSessionFile: options.parentSessionFile,
      forkSessionSnapshotJsonl: options.delegationMode === "fork" ? options.forkSessionSnapshotJsonl : undefined,
    });
    await writePrivateFile(paths.childSessionPath, initialChildSessionJsonl);
    await atomicWriteJson(paths.statePath, {
      version: RUN_PROTOCOL_VERSION,
      runId: path.basename(paths.runDir),
      sequence: 0,
      phase: "starting",
      updatedAt: Date.now(),
      lastEvent: "parent_prepare",
    });

    inheritedApiKeyAgentDir = prepareInheritedApiKeyAgentDir(options.inheritedApiKeyBinding);

    const piArgs = buildInteractivePiArgs(
      options.agent,
      options.agent.systemPrompt.trim() ? paths.systemPromptPath : null,
      paths.taskPath,
      paths.childSessionPath,
      options.modelOverride,
    );
    applyChildProjectIsolation(piArgs, effectiveCwd);

    const runId = path.basename(paths.runDir);
    const parentStartedAt = getCurrentProcessStartedAt();
    if (parentStartedAt === null) throw new Error("Unable to establish parent process start identity.");

    // Allocation stays broker-owned until immutable commit. New runs always
    // publish a layout intent; legacy split intents are not used here.
    let source: any;
    let tmuxSourceTopology: any;
    if (backend.mode === "cmux-pane") {
      if (options.interactivePaneLayout === "auto") await assertCmuxLayoutSupport(backendRun);
      const configured = { workspaceId: process.env.CMUX_WORKSPACE_ID!.trim(), sourceSurfaceId: process.env.CMUX_SURFACE_ID!.trim() };
      const tree = await backendRun(buildCmuxFullTreeArgs(configured.workspaceId));
      const resolved = tree.exitCode === 0
        ? resolveCanonicalCmuxSurfacePane(tree.stdout, configured.workspaceId, configured.sourceSurfaceId)
        : undefined;
      if (!resolved) throw new Error("cmux source surface is absent or its canonical --all topology is invalid; use --subagent-pane-layout=split after fixing cmux.");
      source = { workspaceId: resolved.workspaceId, sourceSurfaceId: resolved.surfaceId };
      cmuxLayoutRunners.set(cmuxLayoutRunnerKey(source.workspaceId), backendRun);
    } else {
      const identity = parseTmuxEnvironment();
      if (!identity) throw new Error("tmux pane mode requires valid inherited tmux identity.");
      const probe = await backendRun(buildTmuxSourcePaneProbeArgs(identity.socketPath));
      const sourcePid = parseTmuxSourcePaneProbe(probe.stdout, identity.paneId);
      const topology = await readTmuxSourceTopology({ sourcePaneId: identity.paneId, socketPath: identity.socketPath, run: backendRun });
      if (probe.exitCode !== 0 || sourcePid === null || !topology) throw new Error("tmux source pane topology is unavailable.");
      source = { socketPath: identity.socketPath, sourcePaneId: identity.paneId, sourcePanePid: sourcePid, serverPid: identity.serverPid };
      tmuxSourceTopology = { kind: "tmux-source-pane", socketPath: identity.socketPath, serverPid: identity.serverPid, paneId: topology.paneId, panePid: sourcePid, sessionId: topology.sessionId, windowId: topology.windowId };
    }

    let committedIntent: ReturnType<typeof parseLaunchIntentV2> = null;
    let committedAfterFence = false;
    // Keep the full durable V2 record as authority. The layout coordinator
    // receives only its narrow cmux adoption DTO and must not replace this.
    let committedAllocation: AllocationRecordV2 | null = null;
    let committedDecision: ReturnType<typeof parseDecisionV2> = null;
    const createAndCommit = async (request: any) => {
      // This is immediately before the broker crosses its allocation boundary.
      if (!canStartInteractiveRun(options.interactiveShutdownGeneration)) {
        throw new Error("Interactive session shutdown fenced this run before broker allocation.");
      }
      const intent = {
        version: 2, runId, parentRunId: process.env[SUBAGENT_RUN_ID_ENV]?.trim() || undefined,
        parentSessionId: options.parentSessionId ?? "unknown", parentPid: process.pid, parentStartedAt, terminalMode: backend.mode, source,
        layout: request.layout, placement: request.placement, container: request.container,
        childSessionFile: runPaths.childSessionPath, createdAt: Date.now(),
        brokerNonce: crypto.randomBytes(32).toString("base64url"), runtimePath: brokerRuntime,
        runtimeInterpreterPath: runtimeInterpreter, backendPath: backendExecutable, brokerEntrypoint,
      };
      if (!parseLaunchIntentV2(intent, runId, runPaths.runDir)) throw new Error("Interactive layout launch intent failed validation.");
      if (await publishImmutableJson(runPaths.launchIntentPath, intent) !== "published") throw new Error("Interactive launch intent already exists.");
      const protocolEnv = {
        [SUBAGENT_RUN_ID_ENV]: runId, [SUBAGENT_RUN_STATE_PATH_ENV]: runPaths.statePath,
        [SUBAGENT_RUN_COMPLETION_PATH_ENV]: runPaths.completionPath, [SUBAGENT_PARENT_LEASE_PATH_ENV]: runPaths.parentLeasePath,
        [SUBAGENT_CHILD_SESSION_PATH_ENV]: runPaths.childSessionPath, [SUBAGENT_RUN_OWNERSHIP_ENV]: "parent-owned",
        [SUBAGENT_LEASE_STALE_MS_ENV]: String(DEFAULT_PARENT_LEASE_STALE_MS),
        [SUBAGENT_EXPECTED_PARENT_PID_ENV]: String(intent.parentPid), [SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV]: String(intent.parentStartedAt),
      };
      const childEnv = buildChildProcessEnv({
        agentName: result.agent, parentDepth: options.parentDepth, parentAgentStack: options.parentAgentStack,
        maxDepth: options.maxDepth, preventCycles: options.preventCycles, interactivePaneLayout: options.interactivePaneLayout,
        trustedProjectRoots: options.trustedProjectRoots, deniedProjectRoots: options.deniedProjectRoots,
        inheritedApiKeyBinding: options.inheritedApiKeyBinding, inheritedApiKeyAgentDir, baseEnv: process.env, runProtocolEnv: protocolEnv,
      });
      await writePrivateFile(runPaths.secretEnvPath, buildPrivateChildEnvironmentScript(childEnv));
      const { command, prefixArgs } = resolvePiSpawn();
      await writePrivateExecutableFile(runPaths.wrapperPath, buildInteractivePaneWrapperScript({
        effectiveCwd, childCommand: [command, ...prefixArgs, ...piArgs], exportedEnv: {}, secretEnvPath: runPaths.secretEnvPath,
        wrapperStatusPath: runPaths.wrapperStatusPath, cleanupDirs: inheritedApiKeyAgentDir ? [inheritedApiKeyAgentDir] : [],
      }));
      leaseWriter = startParentLeaseWriter({ filePath: runPaths.parentLeasePath, runId, parentStartedAt });
      await leaseWriter.renew();
      if (!canStartInteractiveRun(options.interactiveShutdownGeneration)) {
        throw new Error("Interactive session shutdown fenced this run before broker allocation.");
      }
      const broker = spawn(brokerRuntime, [brokerEntrypoint, "--run-dir", runPaths.runDir, "--nonce", intent.brokerNonce, "--runtime", brokerRuntime, "--runtime-interpreter", runtimeInterpreter, "--backend", backendExecutable], {
        cwd: runPaths.runDir, detached: true, stdio: "ignore", windowsHide: true, env: buildBrokerEnvironment(process.env, backend.mode),
      });
      broker.unref();
      const decision = await waitForBrokerDecision(runPaths, runId, options.signal, broker);
      if (decision?.kind !== "commit") throw new Error("Interactive launch was cancelled before commit.");
      // Commit may have raced the fence. Continue only far enough to bind its
      // exact recorded target; registration below rejects and tracks cleanup.
      committedAfterFence ||= !canStartInteractiveRun(options.interactiveShutdownGeneration);
      committedIntent = parseLaunchIntentV2(await readBrokerJson(runPaths.launchIntentPath), runId, runPaths.runDir);
      committedAllocation = parseAllocationRecordV2(await readBrokerJson(runPaths.allocationPath), runId);
      committedDecision = parseDecisionV2(await readBrokerJson(runPaths.decisionPath), runId, runPaths.runDir);
      if (!committedIntent || !allocationMatchesInteractiveBackend(committedAllocation, backend.mode)
        || !hasAllocationIntentSourceBinding(committedIntent, committedAllocation) || committedDecision?.kind !== "commit"
        || !hasValidV2StateDependencies({ allocation: committedAllocation, decision: committedDecision, launch: null, gate: null })) {
        retainRecoveryMetadata = true;
        throw new Error("Committed allocation authority does not match the selected terminal backend source.");
      }
      // Keep this explicit recheck adjacent to durable commit; outer adoption
      // still reaches registerCommitted... so its cleanup is tracked.
      committedAfterFence ||= !canStartInteractiveRun(options.interactiveShutdownGeneration);
      return committedAllocation.terminalMode === "cmux-pane"
        ? cmuxRecordToCommittedLayoutAllocation(committedAllocation)
        : {
          committed: true as const, layout: request.layout, placement: request.placement,
          container: (committedAllocation as any).container, target: (committedAllocation as any).target,
        };
    };

    let cmuxLease: CmuxLayoutLease | null = null;
    if (backend.mode === "cmux-pane") {
      cmuxLease = await interactiveLayoutCoordinator.allocateCmux({
        source, depth: options.parentDepth, layout: options.interactivePaneLayout, runId,
        allocate: createAndCommit as any,
      });
      // Do not replace committedAllocation with cmuxLease.allocation: that
      // DTO intentionally omits full AllocationRecordV2 authority.
    } else {
      const request = selectTmuxInteractivePlacement({ layout: options.interactivePaneLayout, source, sourceTopology: tmuxSourceTopology });
      await createAndCommit(request);
    }
    if (!committedAllocation) throw new Error("Committed allocation authority is missing.");
    handle = allocationToHandle(committedAllocation);
    committedRunId = runId;
    const committedRelease = makeInteractiveRelease(backend, handle, cmuxLease);
    releaseHandle = committedRelease;
    // cmux is registered only after coordinator adoption; tmux has no shared
    // container state and is registered after the same committed binding.
    // Registration is the final exact generation/fence check before any gate.
    if (!registerCommittedInteractiveRun({
      runId, backend, handle, release: committedRelease,
      // Preserve the post-commit observation even if a reset races adoption.
      generation: committedAfterFence ? -1 : options.interactiveShutdownGeneration,
    })) {
      throw new Error("Interactive session shutdown fenced this committed run before launch.");
    }

    // Ownership is now active; only after registration may launch.json and the
    // one-way gate be reconciled and opened.
    let launch = parseCommittedLaunchRecordV2(await readBrokerJson(paths.launchPath), runId, paths.runDir);
    const launchDeadline = Date.now() + BROKER_READY_TIMEOUT_MS;
    while (!launch && Date.now() < launchDeadline) {
      await delay(POLL_INTERVAL_MS);
      launch = parseCommittedLaunchRecordV2(await readBrokerJson(paths.launchPath), runId, paths.runDir);
    }
    if (!hasCommittedInteractiveLaunchAuthority({
      intent: committedIntent, allocation: committedAllocation, decision: committedDecision,
      launch, gate: null, mode: backend.mode,
    })) {
      retainRecoveryMetadata = true;
      throw new Error("Committed launch authority does not match the selected terminal backend.");
    }
    const publishedGate = await publishInteractiveLaunchGate({
      paths,
      runId,
      terminalMode: backend.mode,
      generation: options.interactiveShutdownGeneration,
    });
    if (!hasCommittedInteractiveLaunchAuthority({
      intent: committedIntent, allocation: committedAllocation, decision: committedDecision,
      launch, gate: publishedGate, mode: backend.mode,
    })) {
      retainRecoveryMetadata = true;
      throw new Error("Interactive launch gate authority is malformed or belongs to another backend.");
    }
    if (backend.mode === "cmux-pane") {
      if (!canStartInteractiveRun(options.interactiveShutdownGeneration)) {
        throw new Error("Interactive session shutdown fenced this committed run before pane respawn.");
      }
      const cmuxHandle = handle.native as import("./cmux.js").CmuxSurfaceHandle;
      const respawn = await backendRun(buildCmuxRespawnPaneArgs(
        cmuxHandle.workspaceId,
        cmuxHandle.surfaceId,
        paths.wrapperPath,
      ));
      if (respawn.exitCode !== 0) throw new Error(respawn.stderr.trim() || "Failed to start committed cmux pane.");
    }

    // Fork snapshots are session context, not child output. Start tailing at
    // the exact initial bytes so inherited assistant text and usage cannot
    // enter this child result, including when it emits no new response.
    let tailState = createSessionTailState();
    if (options.delegationMode === "fork") tailState.offset = Buffer.byteLength(initialChildSessionJsonl, "utf8");
    let abortStartedAt: number | null = null;
    let interruptSent = false;
    let queryFailures = 0;
    let wrapperExitedAt: number | null = null;
    while (true) {
      const drained = await drainSessionJsonl({ filePath: paths.childSessionPath, state: tailState, result });
      tailState = drained.state;
      if (drained.resultChanged) options.onUpdate();

      const completion = parseCompletionRecordV2(await readBrokerJson(paths.completionPath), runId);
      if (completion) {
        const finalDrain = await drainSessionJsonl({
          filePath: paths.childSessionPath,
          state: tailState,
          result,
          final: true,
        });
        tailState = finalDrain.state;
        if (finalDrain.resultChanged) options.onUpdate();
        applyInteractiveCompletion(result, completion);
        completedNormally = completion.status === "completed";
        preserveDiagnostics = completion.status !== "completed";
        await Promise.race([waitForFile(paths.wrapperStatusPath, 500), delay(500)]);
        const targetClosed = await releaseHandle!();
        targetConfirmedAbsent ||= targetClosed;
        if (!targetClosed) {
          preserveDiagnostics = true;
          retainRecoveryMetadata = true;
        }
        return normalizeCompletedResult(result, completion.status === "aborted");
      }

      if (await fileExists(paths.wrapperStatusPath)) {
        wrapperExitedAt ??= Date.now();
        if (Date.now() - wrapperExitedAt >= 500) {
          const finalDrain = await drainSessionJsonl({ filePath: paths.childSessionPath, state: tailState, result, final: true });
          if (finalDrain.resultChanged) options.onUpdate();
          const statusText = (await readFileIfExists(paths.wrapperStatusPath)).trim();
          const parsedStatus = Number.parseInt(statusText, 10);
          const publication = await publishParentCompletion(paths, runId, "failed", "wrapper-exited");
          if (publication.won) {
            result.exitCode = Number.isFinite(parsedStatus) ? parsedStatus : 1;
            result.stopReason = "error";
            result.errorMessage = "Subagent process exited before writing completion state.";
          } else {
            applyInteractiveCompletion(result, publication.completion);
          }
          preserveDiagnostics = true;
          const targetClosed = await releaseHandle!();
          targetConfirmedAbsent ||= targetClosed;
          if (!targetClosed) retainRecoveryMetadata = true;
          return result;
        }
      }

      if (options.signal?.aborted) {
        abortStartedAt ??= Date.now();
        if (!interruptSent) {
          interruptSent = true;
          await backend.interrupt(handle);
        }
        if (Date.now() - abortStartedAt >= ABORT_WAIT_MS) {
          const targetClosed = await releaseHandle!();
          targetConfirmedAbsent ||= targetClosed;
          if (!targetClosed) retainRecoveryMetadata = true;
          const publication = await publishParentCompletion(paths, runId, "aborted", "parent-aborted");
          const finalDrain = await drainSessionJsonl({ filePath: paths.childSessionPath, state: tailState, result, final: true });
          if (finalDrain.resultChanged) options.onUpdate();
          applyInteractiveCompletion(result, publication.completion);
          preserveDiagnostics = true;
          return normalizeCompletedResult(result, publication.completion.status === "aborted");
        }
      }

      const pane = await backend.inspect(handle);
      if (pane === undefined) {
        queryFailures += 1;
        const handleId = handle.mode === "cmux-pane" ? handle.native.surfaceId : handle.native.paneId;
        if (queryFailures >= 20) {
          await backend.interrupt(handle).catch(() => false);
          const targetClosed = await releaseHandle!();
          targetConfirmedAbsent ||= targetClosed;
          if (!targetClosed) retainRecoveryMetadata = true;
          const publication = await publishParentCompletion(paths, runId, "failed", "inspect-exhausted");
          applyInteractiveCompletion(result, publication.completion);
          preserveDiagnostics = true;
          return normalizeCompletedResult(result, publication.completion.status === "aborted");
        }
      } else {
        queryFailures = 0;
        if (!pane.exists || pane.exited) {
          const finalDrain = await drainSessionJsonl({ filePath: paths.childSessionPath, state: tailState, result, final: true });
          if (finalDrain.resultChanged) options.onUpdate();
          const statusText = (await readFileIfExists(paths.wrapperStatusPath)).trim();
          if (!pane.exists) targetConfirmedAbsent = true;
          const publication = await publishParentCompletion(paths, runId, "failed", "pane-missing");
          if (publication.won) {
            result.exitCode = Number.isFinite(Number.parseInt(statusText, 10)) ? Number.parseInt(statusText, 10) : 1;
            result.stopReason = "error";
            result.errorMessage = `${handle.mode} target closed before the subagent wrote completion state.`;
          } else {
            applyInteractiveCompletion(result, publication.completion);
          }
          preserveDiagnostics = true;
          const targetClosed = await releaseHandle!();
          targetConfirmedAbsent ||= targetClosed;
          if (!targetClosed) retainRecoveryMetadata = true;
          return result;
        }
      }
      await delay(INTERACTIVE_PANE_POLL_INTERVAL_MS);
    }
  } catch (error) {
    preserveDiagnostics = true;
    let publication: Awaited<ReturnType<typeof publishParentCompletion>> | null = null;
    if (paths && handle && committedRunId) {
      try {
        publication = await publishParentCompletion(paths, committedRunId, options.signal?.aborted ? "aborted" : "failed", options.signal?.aborted ? "parent-aborted" : "wrapper-exited");
      } catch {
        retainRecoveryMetadata = true;
      }
      const targetClosed = await releaseHandle!();
      targetConfirmedAbsent ||= targetClosed;
      if (!targetClosed) retainRecoveryMetadata = true;
    }
    const wasAborted = Boolean(options.signal?.aborted);
    if (publication) {
      applyInteractiveCompletion(result, publication.completion);
      if (publication.won && !result.stderr.trim()) result.stderr = error instanceof Error ? error.message : String(error);
      return normalizeCompletedResult(result, publication.completion.status === "aborted");
    }
    result.exitCode = wasAborted ? 130 : 1;
    result.stopReason = wasAborted ? "aborted" : "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    if (!result.stderr.trim()) result.stderr = result.errorMessage;
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    (leaseWriter as ReturnType<typeof startParentLeaseWriter> | null)?.stop();
    if (handle && releaseHandle) {
      const targetClosed = await releaseHandle();
      targetConfirmedAbsent ||= targetClosed;
      if (!targetClosed) retainRecoveryMetadata = true;
    }
    // Failed/unknown exact releases retain registry ownership for shutdown
    // retries and future startup recovery. Only proven absence may unregister.
    if (paths && (!committedRunId || targetConfirmedAbsent)) {
      unregisterCommittedInteractiveRun(path.basename(paths.runDir));
    }
    cleanupTempDir(inheritedApiKeyAgentDir);
    if (paths) {
      // Decide retention from tri-state authority reads before any delayed
      // cleanup. Invalid artifacts and uncertain allocations are recovery
      // state, not ordinary diagnostic output.
      const [status, decision, allocation, launch, gate, residualRisk] = await Promise.all([
        readBrokerArtifact(paths.brokerStatusPath),
        readBrokerArtifact(paths.decisionPath),
        readBrokerArtifact(paths.allocationPath),
        readBrokerArtifact(paths.launchPath),
        readBrokerArtifact(paths.launchGatePath),
        readBrokerArtifact(paths.residualRiskPath),
      ]);
      retainRecoveryMetadata ||= shouldRetainBrokerRecoveryMetadata({
        runId: path.basename(paths.runDir), runDir: paths.runDir, targetConfirmedAbsent,
        status, decision, allocation, launch, gate, residualRisk,
      });
      const secretsRemoved = await removeSelectedSensitiveArtifacts(paths);
      if (!secretsRemoved) retainRecoveryMetadata = true;
      if (retainRecoveryMetadata) {
        // Keep non-secret launch identity for a future startup reaper retry.
      } else if (completedNormally && !preserveDiagnostics) {
        await removeRunArtifacts(paths).catch(() => undefined);
      } else {
        scheduleRunArtifactCleanup(paths.runDir, 60 * 60);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 */
export async function mapConcurrent<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
  options: { signal?: AbortSignal } = {},
): Promise<Array<TOut | undefined>> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: Array<TOut | undefined> = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      if (options.signal?.aborted) return;
      const i = nextIndex++;
      if (i >= items.length) return;
      if (options.signal?.aborted) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
