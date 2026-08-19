/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHASE0_LIVE_GATE_ENV, PHASE0_LIVE_PROOF_BARRIER_PATH_ENV, PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV, PHASE0_LIVE_PROOF_BEHAVIOR_ENV, PHASE0_LIVE_PROOF_CAPABILITY_ENV, PHASE0_LIVE_PROOF_ID_ENV, PHASE0_LIVE_PROOF_MASTER_ENV, PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV, PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV, PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV, PHASE0_LIVE_PROOF_SOCKET_ENV,
  derivePhase0LiveProofCapability, parsePhase0LiveProofReleaseDeadline, type Phase0LiveProofChildEnv, type Phase0LiveProofBehavior,
} from "./phase0-live-proof.js";
export { PHASE0_LIVE_GATE_ENV, PHASE0_LIVE_PROOF_BARRIER_PATH_ENV, PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV, PHASE0_LIVE_PROOF_BEHAVIOR_ENV, PHASE0_LIVE_PROOF_CAPABILITY_ENV, PHASE0_LIVE_PROOF_ID_ENV, PHASE0_LIVE_PROOF_MASTER_ENV, PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV, PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV, PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV, PHASE0_LIVE_PROOF_SOCKET_ENV } from "./phase0-live-proof.js";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  getAmbiguousInheritedCliApiKeyMessage,
  getProviderFromModelSpecifier,
  INHERITED_CLI_API_KEY_ENV_VAR,
  PROVIDER_API_KEY_ENV_VAR_MAP,
  resolveInheritedCliApiKeyEnvBinding,
  type InheritedCliApiKeyEnvBinding,
  type InheritedCliAuthContext,
} from "../core/provider-auth.js";
import type { AgentConfig } from "../core/agents.js";
import { DEFAULT_SUBAGENT_LIMITS, MAX_SUBAGENT_ACTIVE, SUBAGENT_LIMIT_DEFINITIONS, subagentLimitsToEnv, type SubagentLimits } from "../core/subagent-limits.js";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { createJsonLineChunkProcessor } from "./runner-core.js";
import {
  createCmuxControlCommandRunner,
  diagnoseCmuxControlError,
  getCmuxControlRequestManager,
  readCmuxAppBundleVersion,
} from "./cmux-control-adapter.mjs";
import { CmuxEventsClient } from "./cmux-events.js";
import {
  assertCmuxLayoutSupport,
  buildCmuxFullTreeArgs,
  buildCmuxRespawnPaneArgs,
  canonicalCmuxPaneExists,
  closeCmuxSurface,
  focusCmuxSurface,
  diagnoseCanonicalCmuxSurfacePane,
  inspectCanonicalCmuxSurfaceTree,
  inspectCmuxSurface,
  interruptCmuxSurface,
  resolveCanonicalCmuxSurfacePane,
  type CmuxCommandRunner,
  type CmuxSourceTopologyFailure,
  type CmuxSurfaceIdentity,
} from "./cmux.js";
import {
  classifyHerdrTerminal,
  closeHerdrPane,
  inspectHerdrPane,
  interruptHerdrPane,
  HERDR_MAX_SUBSCRIPTION_PANES,
  parseHerdrEnvironment,
  observeHerdrAgentWait,
  resolveHerdrCallerPane,
  subscribeHerdrPane,
  type HerdrPaneHandle,
  type HerdrTerminalClassification,
  type HerdrPaneSubscription,
  type HerdrAgentWaitObserver,
} from "./herdr.js";
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
  buildTmuxPaneSnapshotArgs,
  buildTmuxServerPidArgs,
  closeTmuxPane,
  inspectTmuxPaneFingerprint,
  inspectTmuxPaneFingerprintForUx,
  interruptTmuxPane,
  parseTmuxPanePidList,
  parseTmuxEnvironment,
  parseTmuxPaneSnapshots,
  parseTmuxServerPidOutput,
  readTmuxSourceTopology,
  TMUX_FORMAT_DELIMITER,
  type TmuxCommandRunner,
} from "./tmux.js";
import { buildTmuxWindowLabel } from "./tmux-window-label.mjs";
import {
  DEFAULT_PARENT_LEASE_STALE_MS,
  RUN_PROTOCOL_VERSION,
  SUBAGENT_CHILD_SESSION_PATH_ENV,
  SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV,
  V3_FAILURE_BOUNDARY_CAPABILITY,
  SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV,
  V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY,
  SUBAGENT_LEASE_CHECK_MS_ENV,
  SUBAGENT_LEASE_STALE_MS_ENV,
  SUBAGENT_EXPECTED_PARENT_PID_ENV,
  SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
  SUBAGENT_FORK_BOOTSTRAP_PATH_ENV,
  SUBAGENT_PARENT_LEASE_PATH_ENV,
  SUBAGENT_RUN_COMPLETION_PATH_ENV,
  SUBAGENT_COMPLETION_FENCE_PATH_ENV,
  SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV,
  SUBAGENT_COMPLETION_FENCE_NONCE_ENV,
  SUBAGENT_RUN_ID_ENV,
  SUBAGENT_RUN_OWNERSHIP_ENV,
  RUN_STATE_DIR_ENV,
  SUBAGENT_PROMOTION_REQUEST_PATH_ENV,
  SUBAGENT_PROMOTION_ACK_PATH_ENV,
  SUBAGENT_RUN_STATE_PATH_ENV,
  assertSafeRunArtifactPaths,
  assertSafeStateRoot,
  atomicWriteJson,
  BROKER_PROTOCOL_VERSION,
  createRunId,
  ensureRunStateRoot,
  getRunStateRoot,
  classifyParentProcessIdentity,
  getCurrentProcessStartedAt,
  getProcessStartedAt,
  isParentProcessIdentityAlive,
  isUsableParentLease,
  type ParentProcessIdentityChecker,
  type ProcessIdentityStatus,
  parseAllocationRecordV2,
  parseBrokerStatusV2,
  parseBrokerClaimV2,
  parseCommittedLaunchRecordV2,
  parseCompletionRecord,
  parseCompletionAuthority,
  parseDecisionV2,
  parseLaunchGateV2,
  parseLaunchDeliveryUnknownV2,
  parseLaunchIntentV2,
  parseLaunchRecord,
  hasAllocationIntentSourceBinding,
  hasHerdrSocketGeneration,
  buildHerdrTabLabel,
  hasTmuxGeneration,
  hasValidV2StateDependencies,
  parseParentLease,
  parseResidualRiskV2,
  parseRunState,
  parseDetachedOwnershipRecord,
  parseOwnershipTransferAck,
  parseOwnershipTransferRequest,
  sameOwnershipTransfer,
  parseUserOwnershipRecord,
  prepareRunArtifactPaths,
  publishImmutableJson,
  publishCompletionRecordV3,
  readBrokerArtifact,
  readBrokerJson,
  readBoundedPrivateJson,
  readJsonFile,
  removeRunArtifacts,
  resolveRunArtifactPaths,
  scheduleRunArtifactCleanup,
  startParentLeaseWriter,
  writePrivateExecutableFile,
  writePrivateFile,
  type AllocationRecordV2,
  type CompletionEvidenceRefV3,
  type CompletionRecord,
  type CompletionRecordV1,
  type HerdrProtocolVersion,
  type ObserverCompletionErrorCodeV3,
  type RunArtifactPaths,
  type TmuxGenerationV2,
} from "./run-protocol.js";
import { FORK_SOURCE_ROOT_NAME, ForkSourceOwnershipManager, reconcileForkSourceOwnershipRoot } from "./fork-source-ownership.js";
import {
  TREE_PERMIT_LEASE_ID_ENV,
  TREE_PERMIT_LEASE_TOKEN_ENV,
  TREE_PERMIT_MAX_ACTIVE_ENV,
  TREE_PERMIT_ROOT_ENV,
  TREE_PERMIT_ROOT_ID_ENV,
  TREE_PERMIT_TOKEN_ENV,
  type TreePermitLease,
} from "./tree-permit-authority.js";
import {
  computeSessionFailureBoundary,
  getSessionFileIdentity,
  type SessionFileIdentity,
} from "./completion-v3.js";
import { MAX_REAPER_GRAPH_ENTRIES, acquireReaperRootLock, acquireRunCleanupClaim, enumerateRunDirectories, planUnifiedReaperGraph, type ReaperCleanupClaim, type ReaperRootLock } from "./reaper-coordinator.js";
import {
  LifecycleEventServer,
  SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV,
  SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV,
  writeLifecycleBootstrapToken,
} from "./lifecycle-socket.js";
import { createSessionTailState, drainSessionJsonl } from "./session-tail.js";
import {
  applyVerifiedInteractiveCompletion,
  publishParentObserverCompletion,
  sameCompletionWinner,
} from "./interactive-completion.js";
import {
  CancellationFenceAuthorityError,
  CompletionFenceAuthorityError,
  claimCancellationFence,
  publishAndVerifyCompletionFence,
  publishAndVerifyCompletionFenceAck,
  readVerifiedCompletionFence,
} from "./completion-fence.js";

export { applyVerifiedInteractiveCompletion } from "./interactive-completion.js";
import { TmuxControlClient, createTmuxControlCommandRunner } from "./tmux-control.mjs";
import { acquireTmuxControlLease, resetTmuxControlPoolForNewSession, shutdownTmuxControlPool, type TmuxControlAcceptedTransport, type TmuxControlLease } from "./tmux-control-pool.js";
import { createTmuxControlTransportGate, isTmuxControlTransportGateCurrent, parseTmuxControlTransportGate, publishTmuxControlTransportGate, TmuxControlVersionError, type TmuxControlTransportGate } from "./tmux-control-gate.js";
import {
  exactArtifactDigest,
  hasValidTmuxControlChain,
  parseAllocationRecordV3,
  parseBrokerClaimV3,
  parseBrokerStatusV3,
  parseCommittedLaunchRecordV3,
  parseDecisionV3,
  parseLaunchGateV3,
  parseLaunchIntentV3,
  parseResidualRiskV3,
  type AllocationRecordV3,
  type BrokerClaimV3,
  type CommittedLaunchRecordV3,
  type DecisionV3,
  type LaunchGateV3,
  type LaunchIntentV3,
} from "./tmux-control-protocol.js";
import { processPiJsonLineWithAssistantSignatureIndex } from "../core/runner-events.js";
import { emptyAccountingUsage } from "../core/accounting-usage.js";
import { AssistantSignatureIndex } from "./assistant-signature-index.js";
import { MINIMUM_PI_VERSION, isStableSemverAtLeast, parsePiVersionOutput } from "./version-policy.mjs";
import { PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV, PHASE0_LIVE_TELEMETRY_DIR_ENV, recordPhase0LiveTelemetry } from "./phase0-live-telemetry.mjs";
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
import { DEFAULT_MAX_ACTIVE, SUBAGENT_MAX_ACTIVE_ENV } from "./process-local-scheduler.js";
import { TopologySnapshotBatch } from "./topology-snapshot-batch.js";
import {
  executableGenerationKey,
  LaunchPreflightSingleFlight,
  readExecutableGeneration,
  readFileGeneration,
  sameExecutableGeneration,
  sameFileGeneration,
  type FileGeneration,
} from "./launch-preflight.js";

/** Controller material is captured during module initialization and is never inherited by children. */
type Phase0LiveProofEnv = Phase0LiveProofChildEnv;
const phase0LiveProofController = (() => {
  const env = process.env;
  const socketPath = env[PHASE0_LIVE_PROOF_SOCKET_ENV];
  const master = env[PHASE0_LIVE_PROOF_MASTER_ENV];
  const barrierPathsRaw = env[PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV];
  const releaseTokensRaw = env[PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV];
  const proofId = env[PHASE0_LIVE_PROOF_ID_ENV];
  const capability = env[PHASE0_LIVE_PROOF_CAPABILITY_ENV];
  const barrierPath = env[PHASE0_LIVE_PROOF_BARRIER_PATH_ENV];
  const releaseToken = env[PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV];
  const releaseDeadline = env[PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV];
  const behavior = env[PHASE0_LIVE_PROOF_BEHAVIOR_ENV];
  const clearControllerMaterial = () => {
    delete env[PHASE0_LIVE_PROOF_MASTER_ENV];
    delete env[PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV];
    delete env[PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV];
  };
  const clearAllProofMaterial = () => {
    for (const name of [
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
    ]) delete env[name];
  };

  // The gate is explicit authorization, not controller proof material. A
  // launcher imports this module with only that authorization present.
  if (env[PHASE0_LIVE_GATE_ENV] !== "1") {
    clearAllProofMaterial();
    return null;
  }

  // Never leave controller-only authority visible while the remaining module
  // graph (including extensions and tools) initializes.
  clearControllerMaterial();
  const hasChildSpecificMaterial = proofId !== undefined || capability !== undefined || barrierPath !== undefined || releaseToken !== undefined;
  if (hasChildSpecificMaterial) {
    // A child has one exact assignment. Controller master/list leakage is a
    // mixed authority state, even when the leaked values themselves are valid.
    if (master !== undefined || barrierPathsRaw !== undefined || releaseTokensRaw !== undefined
      || !socketPath || !path.isAbsolute(socketPath) || socketPath.length > 1024
      || !/^[0-9a-f]{32}$/.test(proofId ?? "")
      || !/^[0-9a-f]{64}$/.test(capability ?? "") || !/^[0-9a-f]{64}$/.test(releaseToken ?? "") || parsePhase0LiveProofReleaseDeadline(releaseDeadline) === null
      || !barrierPath || !path.isAbsolute(barrierPath) || path.normalize(barrierPath) !== barrierPath || barrierPath.length > 1024
      || (behavior !== "short" && behavior !== "long" && behavior !== "hold")) {
      throw new Error("Phase 0 live proof child environment is incomplete.");
    }
    // child-bridge consumes and deletes this exact per-child assignment before
    // it registers the replacement read tool.
    return null;
  }

  // No proof variables is the authorized benchmark launcher state. Any other
  // controller-shaped state must be complete; partial material fails closed.
  if (socketPath === undefined && master === undefined && barrierPathsRaw === undefined && releaseTokensRaw === undefined && releaseDeadline === undefined && behavior === undefined) return null;
  delete env[PHASE0_LIVE_PROOF_SOCKET_ENV];
  delete env[PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV];
  delete env[PHASE0_LIVE_PROOF_BEHAVIOR_ENV];
  let barrierPaths: string[] | null = null, releaseTokens: string[] | null = null;
  try {
    const parsedPaths = JSON.parse(barrierPathsRaw ?? ""), parsedTokens = JSON.parse(releaseTokensRaw ?? "");
    if (Array.isArray(parsedPaths) && parsedPaths.length > 0 && parsedPaths.every((value) => typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value && value.length <= 1024)
      && new Set(parsedPaths).size === parsedPaths.length) barrierPaths = [...parsedPaths];
    if (Array.isArray(parsedTokens) && parsedTokens.length > 0 && parsedTokens.every((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))
      && new Set(parsedTokens).size === parsedTokens.length) releaseTokens = [...parsedTokens];
  } catch { /* rejected below */ }
  if (!socketPath || !path.isAbsolute(socketPath) || socketPath.length > 1024 || !master || !/^[0-9a-f]{64}$/.test(master) || !barrierPaths || !releaseTokens || barrierPaths.length !== releaseTokens.length || parsePhase0LiveProofReleaseDeadline(releaseDeadline) === null
    || (behavior !== "short" && behavior !== "long" && behavior !== "hold")) throw new Error("Phase 0 live proof controller environment is incomplete.");
  return { socketPath, master, releaseDeadline: releaseDeadline!, assignments: barrierPaths.map((barrierPath, index) => ({ barrierPath, releaseToken: releaseTokens![index]! })), behavior: behavior as Phase0LiveProofBehavior, proofIds: new Set<string>() };
})();
function phase0LiveProofEnabled(): boolean { return phase0LiveProofController !== null; }

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
/** Fixed retry windows for the stopped-bootstrap identity gate. */
const STOPPED_BOOTSTRAP_IDENTITY_ACQUISITION_TIMEOUT_MS = 100;
const STOPPED_BOOTSTRAP_STOPPED_STATE_TIMEOUT_MS = 500;
const STOPPED_BOOTSTRAP_RESUME_TIMEOUT_MS = 500;
/**
 * The complete identity-gate retry budget is 1.1 seconds: acquire exact
 * PID/start identity, observe its stopped state, then revalidate and resume.
 */
export const STOPPED_BOOTSTRAP_IDENTITY_GATE_RETRY_BUDGET_MS = STOPPED_BOOTSTRAP_IDENTITY_ACQUISITION_TIMEOUT_MS
  + STOPPED_BOOTSTRAP_STOPPED_STATE_TIMEOUT_MS + STOPPED_BOOTSTRAP_RESUME_TIMEOUT_MS;
/**
 * Fixed production self-kill bound for a stopped bootstrap shell. This is not
 * configurable through the environment: it must exceed the whole identity
 * retry budget while remaining bounded if its parent cannot safely resume it.
 */
export const STOPPED_BOOTSTRAP_WATCHDOG_SECONDS = 15;
const POLL_INTERVAL_MS = 100;
const INTERACTIVE_PANE_POLL_INTERVAL_MS = 250;
/** Herdr only inspects on authority wakeups while subscribed; degraded probes back off. */
const HERDR_DEGRADED_WATCHDOG_MIN_MS = 5_000;
const HERDR_DEGRADED_WATCHDOG_MAX_MS = 30_000;
const INTERACTIVE_REAPER_VALIDATION_CONCURRENCY = 8;
const INTERACTIVE_CHILD_START_GRACE_MS = 5_000;
const ABORT_WAIT_MS = 3000;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TRUSTED_PROJECTS_ENV = "PI_SUBAGENT_TRUSTED_PROJECTS";
const SUBAGENT_DENIED_PROJECTS_ENV = "PI_SUBAGENT_DENIED_PROJECTS";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SUBAGENT_ORIGINAL_AGENT_DIR_ENV = "PI_SUBAGENT_ORIGINAL_AGENT_DIR";
const SUBAGENT_INHERITED_API_KEY_ENV = INHERITED_CLI_API_KEY_ENV_VAR;
export const SUBAGENT_MANAGED_CHILD_POLICY_ENV = "PI_SUBAGENT_CMUX_CHILD_POLICY";
export const SUBAGENT_MANAGED_TITLE_ENV = "PI_SUBAGENT_MANAGED_TITLE";
export type ManagedChildPolicy = "inherit" | "managed";

const INTERACTIVE_TITLE_MAX_LENGTH = 96;
const INTERACTIVE_TITLE_LIFECYCLE_STATES = ["queued", "ready", "running", "waiting", "returning", "failed"] as const;
type InteractiveTitleLifecycleState = typeof INTERACTIVE_TITLE_LIFECYCLE_STATES[number];
const INTERACTIVE_TITLE_MAX_SUFFIX_LENGTH = Math.max(...INTERACTIVE_TITLE_LIFECYCLE_STATES.map((state) => ` · ${state}`.length));
const INTERACTIVE_TITLE_MAX_BASE_LENGTH = INTERACTIVE_TITLE_MAX_LENGTH - INTERACTIVE_TITLE_MAX_SUFFIX_LENGTH;

function normalizeInteractiveTitleBase(value: unknown): string {
  const safe = String(value ?? "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim() || "unknown";
  return safe.slice(0, INTERACTIVE_TITLE_MAX_BASE_LENGTH).trimEnd() || "unknown";
}

function formatInteractiveTitle(base: string, state: InteractiveTitleLifecycleState): string {
  return `${normalizeInteractiveTitleBase(base)} · ${state}`;
}

function isInteractiveTitleMatchingBase(title: string, base: string): boolean {
  const normalizedBase = normalizeInteractiveTitleBase(base);
  return INTERACTIVE_TITLE_LIFECYCLE_STATES.some((state) => title === formatInteractiveTitle(normalizedBase, state));
}

const CHILD_CMUX_PROFILE_ENV = Object.freeze({
  PI_CMUX_PROFILE: "subagent-child-v1",
  PI_CMUX_NOTIFY_LEVEL: "disabled",
  PI_CMUX_SIDEBAR_FLASH: "disabled",
  PI_CMUX_SIDEBAR_SOURCE: "pi-subagent-child",
  PI_CMUX_REGISTER_COMMANDS: "0",
  PI_CMUX_REGISTER_TOOLS: "0",
  PI_CMUX_SUBAGENT_DASHBOARD: "0",
});
const PI_OFFLINE_ENV = "PI_OFFLINE";
const CHILD_BRIDGE_PATH = fileURLToPath(new URL("./child-bridge.ts", import.meta.url));
const BROKER_READY_TIMEOUT_MS = 5_000;
const BROKER_COMMIT_TIMEOUT_MS = 30_000;
const BROKER_RUNTIME_ENV = "PI_SUBAGENT_BROKER_RUNTIME";
const BROKER_ENTRYPOINT = fileURLToPath(new URL("./pane-launch-broker.mjs", import.meta.url));
const CMUX_BUNDLED_CLI_PATH_ENV = "CMUX_BUNDLED_CLI_PATH";
const TMUX_BIN_ENV = "TMUX_BIN";
const interactivePiVersionChecks = new Map<string, Promise<void>>();

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export type InteractiveRunOwnership = "managed" | "kept" | "transferring" | "detached" | "ownership-unknown";
const PROMOTION_ACK_TIMEOUT_MS = 5_000;
const TREE_PERMIT_DETACH_ATTEMPTS = 3;
const TREE_PERMIT_DETACH_RETRY_MS = 100;
/** Durable promotion has a distinct outcome from a rejected request: an
 * unreadable or malformed immutable marker revokes parent cleanup authority. */
export type InteractivePromotionOutcome = "promoted" | "already-promoted" | "ownership-unknown" | "rejected";
export interface HerdrRunPresentationDiagnostics {
  /** Event transport only; never feeds lifecycle or cleanup decisions. */
  transport: "unknown" | "healthy" | "reconnecting";
  /** Compared with the immutable initial terminal binding, never display IDs. */
  target: "current" | "moved" | "absent" | "unknown";
  orphanRisk: "none" | "possible";
}
export interface InteractiveRunUxSnapshot {
  runId: string;
  /** Process-local parent invocation correlation; never persisted or emitted. */
  invocationId?: string;
  agent: string;
  depth: number;
  backend: "cmux-pane" | "tmux-pane" | "herdr-pane";
  placement?: string;
  ownership: InteractiveRunOwnership;
  startedAt: number;
  updatedAt: number;
  preview?: string;
  /** Presentation-only Herdr stream/reconcile diagnosis. */
  herdr?: HerdrRunPresentationDiagnostics;
}

interface ActiveInteractiveRun {
  runId: string;
  /** Process-local parent invocation correlation; never persisted or emitted. */
  invocationId?: string;
  backend: InteractivePaneBackend;
  /** Optional active-only UX transport; never grants lifecycle/cleanup authority. */
  uxBackend?: () => InteractivePaneBackend | null;
  handle: InteractivePaneHandle;
  paths?: RunArtifactPaths;
  agent: string;
  depth: number;
  ownership: InteractiveRunOwnership;
  startedAt: number;
  updatedAt: number;
  preview?: string;
  /** Retains initial identity only for moved/current presentation comparison. */
  herdr?: HerdrRunPresentationDiagnostics & { initialTerminalId: string; initialWorkspaceId: string; initialTabId: string; initialPaneId: string };
  surfaceTitle: string;
  focusSupported: boolean;
  generation: number;
  operation: Promise<void>;
  /** One idempotent exact-target release path, shared with shutdown. */
  release: (force?: boolean) => Promise<boolean>;
  /** Exact original parent capability retained for post-monitor promotion retry. */
  treePermitLease?: Pick<TreePermitLease, "detachBoundChild">;
  /** Parent-only binding for immutable completion transcript verification. */
  sessionIdentity?: SessionFileIdentity;
  sessionResultStartOffset?: number;
  /** Idempotent result replay; it is never exposed in public run snapshots. */
  applyCompletionWinner?: (completion: CompletionRecord) => Promise<boolean>;
  /** Idempotently stops the parent liveness writer before terminal authority. */
  stopLeaseWriterAndDrain?: () => Promise<boolean | void>;
  /** One in-flight terminal preparation; prevents unbounded per-run FIFO growth. */
  pendingTerminalPublication?: Promise<{ completion: CompletionRecord; won: boolean } | null>;
  /** Private callback-fencing parent completion path; never exposed in UX snapshots. */
  publishParentCompletion?: (status: "failed" | "aborted", errorCode: "parent-aborted" | "wrapper-exited" | "pane-missing" | "inspect-exhausted" | "launch-failed") => Promise<{ completion: CompletionRecord; won: boolean } | null>;
}

const activeInteractiveRuns = new Map<string, ActiveInteractiveRun>();

/** Process-local notification only; observers receive no registry mutation authority. */
export type InteractiveRunChangeObserver = () => void;
const interactiveRunChangeObservers = new Set<InteractiveRunChangeObserver>();

function notifyInteractiveRunChanges(): void {
  for (const observer of [...interactiveRunChangeObservers]) {
    try { observer(); } catch { /* Observers are never lifecycle authority. */ }
  }
}

/**
 * Observe process-local interactive registry changes. The observer is invoked
 * immediately with the current state and after later relevant transitions.
 * Re-subscribing the same callback is a no-op.
 */
export function subscribeInteractiveRunChanges(observer: InteractiveRunChangeObserver): () => void {
  if (interactiveRunChangeObservers.has(observer)) return () => {};
  interactiveRunChangeObservers.add(observer);
  try { observer(); } catch { /* Observers are never lifecycle authority. */ }
  return () => { interactiveRunChangeObservers.delete(observer); };
}

const DETACHED_RETIREMENT_DEGRADED_CADENCE_MS = 5_000;
interface DetachedRetirementWatcher {
  run: ActiveInteractiveRun;
  timer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
  tick: Promise<void> | null;
  cleanup: Promise<void> | null;
  draining: Promise<void> | null;
}
const detachedRetirementWatchers = new Map<string, DetachedRetirementWatcher>();
const detachedRetirementWatcherDrains = new Set<Promise<void>>();

/**
 * Keep the long agent.wait observer strictly behind an unhealthy event stream.
 * A draining observer cannot overlap a replacement, even if health changes
 * faster than its aborted socket settles.
 */
export function createHerdrAgentWaitFallback(options: { handle: HerdrPaneHandle; onWake: () => void }): {
  sync(healthy: boolean): void;
  stopAndDrain(): Promise<void>;
} {
  let stopped = false;
  let healthy = false;
  let observer: HerdrAgentWaitObserver | null = null;
  let drain: Promise<void> | null = null;
  const stopObserver = () => {
    if (!observer) return;
    const current = observer;
    observer = null;
    current.stop();
    drain = current.closed.catch(() => undefined).finally(() => {
      drain = null;
      if (!stopped && !healthy) sync(false);
    });
  };
  const sync = (nextHealthy: boolean) => {
    healthy = nextHealthy;
    if (stopped || healthy) {
      stopObserver();
      return;
    }
    if (!observer && !drain) observer = observeHerdrAgentWait({ handle: options.handle, onWake: options.onWake });
  };
  return {
    sync,
    stopAndDrain: async () => {
      stopped = true;
      healthy = true;
      stopObserver();
      await drain;
    },
  };
}
/** One owner-only Herdr event stream per socket generation. Individual runs
 * retain independent reconciliation authority; this registry shares only the
 * selector/reconnect transport and fans relevant events out in memory. */
type SharedHerdrListener = {
  handle: HerdrPaneHandle;
  stopped: boolean;
  onReconcile: (pane: HerdrPaneHandle | undefined) => Promise<void> | void;
  /** Read-only reconciliation result for presentation only; never lifecycle authority. */
  onReconcileTarget?: (terminal: HerdrTerminalClassification) => void;
  onWake?: () => void;
  onHealthChange?: (healthy: boolean) => void;
  reconciliation: Promise<void> | null;
  reconciliationPending: boolean;
  /** Invalidates a result begun before a newer event or health transition. */
  classificationEpoch: number;
};
type SharedHerdrTransport = {
  listeners: Set<SharedHerdrListener>;
  subscription: HerdrPaneSubscription | null;
  healthy: boolean | null;
  selectorSignature: string;
  epoch: number;
  stopped: boolean;
  reconfigureScheduled: boolean;
  reconfigure: Promise<void>;
};
const sharedHerdrTransports = new Map<string, SharedHerdrTransport>();
function sharedHerdrTransportKey(handle: HerdrPaneHandle): string {
  return `${handle.socketPath}\u0000${handle.socketDev}\u0000${handle.socketIno}\u0000${handle.protocol}`;
}
function sharedHerdrEventMatches(handle: HerdrPaneHandle, event: string, data: Record<string, unknown> | null): boolean {
  if (!data) return false;
  const pane = data.pane && typeof data.pane === "object" && !Array.isArray(data.pane) ? data.pane as Record<string, unknown> : null;
  const terminalMatches = pane?.terminal_id === handle.terminalId;
  return (event === "pane_moved" && data.previous_pane_id === handle.paneId && terminalMatches)
    || data.pane_id === handle.paneId || terminalMatches
    || (event === "tab_closed" && data.workspace_id === handle.workspaceId && data.tab_id === handle.tabId)
    || (event === "workspace_closed" && data.workspace_id === handle.workspaceId);
}
function sharedHerdrSelectorPaneIds(transport: SharedHerdrTransport): string[] {
  return [...new Set([...transport.listeners].filter((listener) => !listener.stopped).map((listener) => listener.handle.paneId))].sort();
}
function deliverSharedHerdr(transport: SharedHerdrTransport, callback: (listener: SharedHerdrListener) => void): void {
  for (const listener of transport.listeners) if (!listener.stopped) { try { callback(listener); } catch { /* Event hints never own lifecycle. */ } }
}
/**
 * Event and transport health only wake this read-only diagnostic reconciliation.
 * Clone the mutable live binding so diagnostics cannot rebind a lifecycle target.
 */
function reconcileSharedHerdrListener(listener: SharedHerdrListener): void {
  if (listener.stopped) return;
  listener.reconciliationPending = true;
  const classificationEpoch = ++listener.classificationEpoch;
  if (listener.reconciliation) return;
  listener.reconciliation = (async () => {
    listener.reconciliationPending = false;
    if (listener.stopped) return;
    const terminal: HerdrTerminalClassification = await classifyHerdrTerminal({ ...listener.handle });
    // A later event or transport transition requires its own fresh read. Do
    // not restore presentation from an in-flight pre-transition result.
    if (listener.stopped || classificationEpoch !== listener.classificationEpoch) return;
    try { listener.onReconcileTarget?.(terminal); } catch { /* Diagnostics never own lifecycle. */ }
    // Preserve the existing wake callback contract while keeping its result
    // isolated from lifecycle authority and the live binding.
    try { await listener.onReconcile(terminal.state === "present" ? terminal.handle : undefined); } catch { /* Wake observers are non-authoritative. */ }
  })().finally(() => {
    listener.reconciliation = null;
    if (listener.reconciliationPending && !listener.stopped) reconcileSharedHerdrListener(listener);
  });
}
/** Reconfiguration is microtask-coalesced, then strictly serial: the old stream
 * is fully drained before a union-selector replacement may connect. */
function scheduleSharedHerdrTransport(key: string, transport: SharedHerdrTransport): void {
  if (transport.stopped || transport.reconfigureScheduled) return;
  transport.reconfigureScheduled = true;
  queueMicrotask(() => {
    transport.reconfigure = transport.reconfigure.catch(() => undefined).then(async () => {
      transport.reconfigureScheduled = false;
      if (transport.stopped || sharedHerdrTransports.get(key) !== transport) return;
      const paneIds = sharedHerdrSelectorPaneIds(transport);
      const signature = paneIds.join("\u0000");
      if (signature === transport.selectorSignature && transport.subscription) return;
      const previous = transport.subscription;
      transport.subscription = null;
      transport.healthy = null;
      const epoch = ++transport.epoch;
      deliverSharedHerdr(transport, (listener) => {
        // Reconfiguration has no replacement classification yet; reject any
        // result still in flight from the stream being drained.
        listener.classificationEpoch += 1;
        listener.onHealthChange?.(false);
      });
      if (previous) {
        previous.stop();
        await previous.closed.catch(() => undefined);
      }
      if (transport.stopped || sharedHerdrTransports.get(key) !== transport || paneIds.length === 0) return;
      // A shared endpoint never fans out into extra physical streams. When the
      // selector union exceeds the same 16-run bound as degraded observation,
      // listeners remain fail-closed/unhealthy and use their bounded fallback.
      if (paneIds.length > HERDR_MAX_SUBSCRIPTION_PANES) return;
      const seed = [...transport.listeners].find((listener) => !listener.stopped);
      if (!seed) return;
      transport.selectorSignature = signature;
      transport.subscription = subscribeHerdrPane({
        handle: seed.handle,
        selectorPaneIds: paneIds,
        onReconcile: () => undefined,
        reconcileOnEvent: false,
        wakeOnEvent: false,
        onWake: () => {
          if (transport.stopped || sharedHerdrTransports.get(key) !== transport || transport.epoch !== epoch) return;
          deliverSharedHerdr(transport, (listener) => {
            listener.onWake?.();
            // Failed reconnect attempts are also wake evidence, not target
            // evidence. Reconciliation turns an unavailable/ambiguous read
            // into unknown without trusting transport state.
            reconcileSharedHerdrListener(listener);
          });
        },
        onHealthChange: (healthy) => {
          if (transport.stopped || sharedHerdrTransports.get(key) !== transport || transport.epoch !== epoch) return;
          transport.healthy = healthy;
          deliverSharedHerdr(transport, (listener) => {
            listener.onHealthChange?.(healthy);
            // Initial health and every successful reconnect merely wake the
            // coalesced authoritative read; health itself carries no target.
            if (healthy) reconcileSharedHerdrListener(listener);
          });
        },
        onEvent: (event, data) => {
          if (transport.stopped || sharedHerdrTransports.get(key) !== transport || transport.epoch !== epoch) return;
          deliverSharedHerdr(transport, (listener) => {
            if (!sharedHerdrEventMatches(listener.handle, event, data)) return;
            listener.onWake?.();
            // The payload establishes relevance only. Target state comes from
            // classifyHerdrTerminal's fresh pane.get/pane.list read.
            reconcileSharedHerdrListener(listener);
          });
        },
      });
      // A listener change while the old stream was draining is coalesced into
      // exactly one later serial replacement, never a concurrent connection.
      if (sharedHerdrSelectorPaneIds(transport).join("\u0000") !== signature) scheduleSharedHerdrTransport(key, transport);
    });
  });
}
function subscribeSharedHerdrPane(options: { handle: HerdrPaneHandle; onReconcile: (pane: HerdrPaneHandle | undefined) => Promise<void> | void; onReconcileTarget?: (terminal: HerdrTerminalClassification) => void; onWake?: () => void; onHealthChange?: (healthy: boolean) => void; }): HerdrPaneSubscription {
  const key = sharedHerdrTransportKey(options.handle);
  let transport = sharedHerdrTransports.get(key);
  if (!transport) {
    transport = { listeners: new Set(), subscription: null, healthy: null, selectorSignature: "", epoch: 0, stopped: false, reconfigureScheduled: false, reconfigure: Promise.resolve() };
    sharedHerdrTransports.set(key, transport);
  }
  const listener: SharedHerdrListener = { ...options, stopped: false, reconciliation: null, reconciliationPending: false, classificationEpoch: 0 };
  transport.listeners.add(listener);
  scheduleSharedHerdrTransport(key, transport);
  // Joining an already healthy shared selector does not necessarily trigger a
  // reconnect, but this listener still needs its mandatory initial read.
  if (transport.healthy === true) reconcileSharedHerdrListener(listener);
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  return {
    stop: () => {
      if (closed) return;
      closed = true;
      listener.stopped = true;
      transport!.listeners.delete(listener);
      if (transport!.listeners.size !== 0) {
        scheduleSharedHerdrTransport(key, transport!);
        resolveClosed();
        return;
      }
      transport!.stopped = true;
      transport!.healthy = false;
      transport!.epoch += 1;
      sharedHerdrTransports.delete(key);
      transport!.subscription?.stop();
      void transport!.reconfigure.catch(() => undefined).then(async () => {
        await transport!.subscription?.closed.catch(() => undefined);
      }).finally(resolveClosed);
    },
    closed: closedPromise,
    isHealthy: () => !closed && transport!.healthy === true,
  };
}

/** Test-only seam for endpoint-sharing transport verification. */
export function subscribeSharedHerdrPaneForTest(options: { handle: HerdrPaneHandle; onReconcile: (pane: HerdrPaneHandle | undefined) => Promise<void> | void; onReconcileTarget?: (terminal: HerdrTerminalClassification) => void; onWake?: () => void; onHealthChange?: (healthy: boolean) => void; }): HerdrPaneSubscription {
  return subscribeSharedHerdrPane(options);
}

const HERDR_COMPLETED_RETIREMENT_MAX_WATCHERS = 16;
const HERDR_COMPLETED_CLEANUP_RETRY_DELAYS_MS = [100, 250] as const;
interface CompletedHerdrRetirementWatcher {
  run: ActiveInteractiveRun;
  completion: CompletionRecord;
  cancelled: boolean;
  subscription: HerdrPaneSubscription | null;
  reconciliation: Promise<void> | null;
  reconciliationPending: boolean;
  /** Set only after winner, ownership/generation, two absence proofs, and sensitive scrub. */
  cleanupCommitted: boolean;
  /** The finite post-commit recursive cleanup; it never reads run artifacts. */
  cleanup: Promise<void> | null;
  startup: Promise<void> | null;
  draining: Promise<void> | null;
}
const completedHerdrRetirementWatchers = new Map<string, CompletedHerdrRetirementWatcher>();
const completedHerdrRetirementWatcherDrains = new Set<Promise<void>>();

function scheduleCompletedHerdrRetirementWatcherDrain(watcher: CompletedHerdrRetirementWatcher): void {
  if (watcher.draining) return;
  const drain = Promise.resolve().then(async () => {
    await watcher.startup?.catch(() => undefined);
    watcher.subscription?.stop();
    await watcher.subscription?.closed.catch(() => undefined);
    await watcher.reconciliation?.catch(() => undefined);
    if (completedHerdrRetirementWatchers.get(watcher.run.runId) === watcher) {
      completedHerdrRetirementWatchers.delete(watcher.run.runId);
    }
  }).finally(() => { completedHerdrRetirementWatcherDrains.delete(drain); });
  watcher.draining = drain;
  completedHerdrRetirementWatcherDrains.add(drain);
}

function cancelCompletedHerdrRetirementWatcher(runId: string): void {
  const watcher = completedHerdrRetirementWatchers.get(runId);
  if (!watcher) return;
  watcher.cancelled = true;
  watcher.reconciliationPending = false;
  // A committed recursive cleanup is deliberately not cancelled: it may have
  // already removed completion.json, so it must finish from in-memory state.
  watcher.subscription?.stop();
  // Retain this entry, including its cap slot, until all watcher I/O settles.
  scheduleCompletedHerdrRetirementWatcherDrain(watcher);
}

function cancelCompletedHerdrRetirementWatchers(): void {
  for (const runId of [...completedHerdrRetirementWatchers.keys()]) cancelCompletedHerdrRetirementWatcher(runId);
}

async function drainCompletedHerdrRetirementWatchers(): Promise<void> {
  await Promise.all([...completedHerdrRetirementWatcherDrains]);
}

function scheduleDetachedRetirementWatcherDrain(watcher: DetachedRetirementWatcher): void {
  if (watcher.draining) return;
  const drain = Promise.resolve().then(async () => {
    await watcher.tick?.catch(() => undefined);
    await watcher.cleanup?.catch(() => undefined);
    if (detachedRetirementWatchers.get(watcher.run.runId) === watcher) {
      detachedRetirementWatchers.delete(watcher.run.runId);
    }
  }).finally(() => { detachedRetirementWatcherDrains.delete(drain); });
  watcher.draining = drain;
  detachedRetirementWatcherDrains.add(drain);
}

function cancelDetachedRetirementWatcher(runId: string): void {
  const watcher = detachedRetirementWatchers.get(runId);
  if (!watcher) return;
  watcher.cancelled = true;
  if (watcher.timer) clearTimeout(watcher.timer);
  watcher.timer = null;
  // Retain the entry until its inspection and serialized cleanup drain.
  scheduleDetachedRetirementWatcherDrain(watcher);
}

function cancelDetachedRetirementWatchers(): void {
  for (const runId of [...detachedRetirementWatchers.keys()]) cancelDetachedRetirementWatcher(runId);
}

async function drainDetachedRetirementWatchers(): Promise<void> {
  await Promise.all([...detachedRetirementWatcherDrains]);
}

/** A bounded, unref'd, side-effect-free target observer for detached runs. */
function watchDetachedInteractiveRunForRetirement(run: ActiveInteractiveRun, initialDelayMs = DETACHED_RETIREMENT_DEGRADED_CADENCE_MS): void {
  if (!run.paths || detachedRetirementWatchers.has(run.runId)) return;
  const watcher: DetachedRetirementWatcher = { run, timer: null, cancelled: false, tick: null, cleanup: null, draining: null };
  detachedRetirementWatchers.set(run.runId, watcher);
  const isAuthorized = async () => await withInteractiveFenceMutex(() => !watcher.cancelled
    && activeInteractiveRuns.get(run.runId) === run && run.ownership === "detached");
  const schedule = (delayMs = DETACHED_RETIREMENT_DEGRADED_CADENCE_MS) => {
    if (watcher.cancelled) return;
    watcher.timer = setTimeout(() => { void startTick(); }, delayMs);
    watcher.timer.unref?.();
  };
  const startTick = async () => {
    if (watcher.tick || watcher.cancelled) return;
    const tick = (async () => {
      if (!await isAuthorized()) { cancelDetachedRetirementWatcher(run.runId); return; }
      const observed = await run.backend.inspect(run.handle).catch(() => undefined);
      if (!await isAuthorized() || observed?.exists !== false) return;
      let queued: Promise<void> | undefined;
      await withInteractiveFenceMutex(() => {
        // Reserve this exact detached registry entry before any second probe.
        // The fence is released while the queued operation performs I/O.
        if (watcher.cancelled || activeInteractiveRuns.get(run.runId) !== run || run.ownership !== "detached") return;
        queued = serializeInteractiveRun(run, async () => {
          if (!await isAuthorized()) return;
          // A poll result is not retirement authority; re-read the exact handle
          // after the per-run FIFO predecessor, never while holding the global fence.
          const confirmed = await run.backend.inspect(run.handle).catch(() => undefined);
          if (!await isAuthorized() || confirmed?.exists !== false) return;
          // Detached ownership and completion authority must never be silently
          // collapsed by this observer; retain the candidate for reaper review.
          const completion = await readBrokerArtifact(run.paths!.completionPath);
          if (!await isAuthorized() || completion.outcome !== "missing") return;
          // Keep the registry candidate until every artifact is gone. A failed
          // delete must remain retryable rather than reporting false retirement.
          if (!await isAuthorized()) return;
          const scrubbed = await removeSelectedSensitiveArtifacts(run.paths!, undefined, false).catch(() => false);
          if (!await isAuthorized() || !scrubbed) return;
          let removed = false;
          try {
            if (!await isAuthorized()) return;
            await removeRunArtifacts(run.paths!);
            removed = !await fileExists(run.paths!.runDir);
          } catch { /* retry from the retained registry candidate */ }
          // Artifact removal and exact absence are irreversible. A reset that
          // cancels observation after this point must not leave this exact
          // detached registry entry pointing at the deleted run directory.
          if (!removed) return;
          let retired = false;
          await withInteractiveFenceMutex(() => {
            if (activeInteractiveRuns.get(run.runId) === run && run.ownership === "detached") {
              activeInteractiveRuns.delete(run.runId);
              retired = true;
            }
          });
          if (retired) notifyInteractiveRunChanges();
          cancelDetachedRetirementWatcher(run.runId);
        });
        watcher.cleanup = queued;
      });
      await queued;
    })().finally(() => {
      watcher.tick = null;
      if (watcher.cancelled) scheduleDetachedRetirementWatcherDrain(watcher);
      else if (detachedRetirementWatchers.get(run.runId) === watcher) schedule();
    });
    watcher.tick = tick;
    await tick;
  };
  schedule(initialDelayMs);
}

/** Test seam for detached retirement; production uses the degraded cadence. */
export function watchDetachedInteractiveRunForRetirementForTest(runId: string): boolean {
  const run = activeInteractiveRuns.get(runId);
  if (!run?.paths) return false;
  run.ownership = "detached";
  run.updatedAt = Date.now();
  watchDetachedInteractiveRunForRetirement(run, 0);
  return detachedRetirementWatchers.has(runId);
}

/**
 * Late direct-Herdr retirement stays strictly observational. A verified child
 * winner is retained until two serialized exact-handle absence probes and the
 * same immutable winner still agree; it never sends terminal control.
 */
function watchCompletedHerdrDirectRunForRetirement(run: ActiveInteractiveRun, completion: CompletionRecord): void {
  if (!run.paths || run.handle.mode !== "herdr-pane" || run.handle.placement?.placement !== "herdr-new-tab"
    || completedHerdrRetirementWatchers.has(run.runId) || completedHerdrRetirementWatchers.size >= HERDR_COMPLETED_RETIREMENT_MAX_WATCHERS) return;
  const herdrHandle = run.handle.native;
  const watcher: CompletedHerdrRetirementWatcher = {
    run, completion, cancelled: false, subscription: null, reconciliation: null, reconciliationPending: false,
    cleanupCommitted: false, cleanup: null, startup: null, draining: null,
  };
  completedHerdrRetirementWatchers.set(run.runId, watcher);
  const isAuthorized = async () => !watcher.cancelled
    && canStartInteractiveRun(run.generation)
    && completedHerdrRetirementWatchers.get(run.runId) === watcher
    && activeInteractiveRuns.get(run.runId) === run
    && (run.ownership === "managed" || run.ownership === "kept");
  const hasCurrentWinner = async () => {
    if (!await isAuthorized()) return false;
    const artifact = await readBrokerArtifact(run.paths!.completionPath);
    const winner = artifact.outcome === "valid" ? parseCompletionAuthority(artifact.value, run.runId) : null;
    return !watcher.cancelled && winner !== null && sameCompletionWinner(winner, completion) && await isAuthorized();
  };
  const finalizeCommittedRetirement = async () => {
    let retired = false;
    await withInteractiveFenceMutex(() => {
      // After the cleanup boundary, this exact entry must not outlive its
      // authority file, even if reset changed the generation or recursive rm
      // left a scrubbed partial directory behind.
      if (activeInteractiveRuns.get(run.runId) === run) {
        activeInteractiveRuns.delete(run.runId);
        retired = true;
      }
    });
    if (retired) notifyInteractiveRunChanges();
    cancelCompletedHerdrRetirementWatcher(run.runId);
  };
  const commitCleanup = async (): Promise<boolean> => {
    // This fence is the irreversible boundary. The durable winner was just
    // re-read after both absence proofs and after sensitive scrub; this final
    // synchronous registry/generation check prevents committing stale work.
    return await withInteractiveFenceMutex(() => {
      if (!watcher.cancelled && canStartInteractiveRun(run.generation)
        && completedHerdrRetirementWatchers.get(run.runId) === watcher
        && activeInteractiveRuns.get(run.runId) === run
        && (run.ownership === "managed" || run.ownership === "kept")) {
        watcher.cleanupCommitted = true;
        return true;
      }
      return false;
    });
  };
  const completeCommittedCleanup = async () => {
    // Never inspect the backend or read any run artifact here. rm may have
    // removed completion.json before reporting an error, so only the retained
    // in-memory commitment may authorize these finite recursive retries.
    for (let attempt = 0; attempt <= HERDR_COMPLETED_CLEANUP_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await fs.promises.rm(run.paths!.runDir, { recursive: true, force: true });
        break;
      } catch { /* Preserve a scrubbed partial directory for the next attempt/reaper. */ }
      const retryDelay = HERDR_COMPLETED_CLEANUP_RETRY_DELAYS_MS[attempt];
      if (retryDelay !== undefined) await delay(retryDelay);
    }
    await finalizeCommittedRetirement();
  };
  const reconcile = async () => {
    if (watcher.cleanupCommitted || !await hasCurrentWinner()) {
      if (!watcher.cleanupCommitted) cancelCompletedHerdrRetirementWatcher(run.runId);
      return;
    }
    // This is the first authoritative proof. It runs initially and thereafter
    // only after a subscription health/reconnect/relevant-event wakeup.
    const observed = await run.backend.inspect(run.handle).catch(() => undefined);
    if (watcher.cancelled || observed?.exists !== false) return;
    let queued: Promise<void> | undefined;
    await withInteractiveFenceMutex(() => {
      if (watcher.cancelled || activeInteractiveRuns.get(run.runId) !== run
        || (run.ownership !== "managed" && run.ownership !== "kept")) return;
      queued = serializeInteractiveRun(run, async () => {
        if (!await hasCurrentWinner()) return;
        // The second serialized exact-handle read is the required independent
        // absence proof before any artifact removal.
        const confirmed = await run.backend.inspect(run.handle).catch(() => undefined);
        if (watcher.cancelled || confirmed?.exists !== false || !await hasCurrentWinner()) return;
        const scrubbed = await removeSelectedSensitiveArtifacts(run.paths!, undefined, false).catch(() => false);
        if (!scrubbed || !await hasCurrentWinner()) return;
        // Complete all path safety validation before the irreversible boundary;
        // retries below must not inspect anything inside this run directory.
        try { await assertSafeRunArtifactPaths(run.paths!); } catch { return; }
        if (!await hasCurrentWinner() || !await commitCleanup()) return;
        watcher.cleanup = completeCommittedCleanup();
        await watcher.cleanup;
      });
    });
    await queued;
  };
  const requestReconcile = () => {
    if (watcher.cancelled || watcher.cleanupCommitted) return;
    watcher.reconciliationPending = true;
    if (watcher.reconciliation) return;
    watcher.reconciliation = (async () => {
      watcher.reconciliationPending = false;
      await reconcile();
    })().catch(() => undefined).finally(() => {
      watcher.reconciliation = null;
      // Do not lose a wake that arrives at the settle boundary.
      if (watcher.reconciliationPending && !watcher.cancelled && !watcher.cleanupCommitted) requestReconcile();
    });
  };
  // Establish the first proof before opening the idle event stream. Subsequent
  // inspection is therefore exclusively subscription-woken.
  watcher.startup = (async () => {
    requestReconcile();
    await watcher.reconciliation;
    if (watcher.cancelled || watcher.cleanupCommitted || completedHerdrRetirementWatchers.get(run.runId) !== watcher) return;
    watcher.subscription = subscribeSharedHerdrPane({
      handle: herdrHandle,
      onReconcile: requestReconcile,
      onWake: requestReconcile,
      onHealthChange: () => requestReconcile(),
    });
  })().catch(() => undefined);
}

/** Test seam for late direct-Herdr completion retirement; production schedules it after a bounded absence timeout. */
export function watchCompletedHerdrDirectRunForRetirementForTest(runId: string, completion: CompletionRecord): boolean {
  const run = activeInteractiveRuns.get(runId);
  if (!run) return false;
  watchCompletedHerdrDirectRunForRetirement(run, completion);
  return completedHerdrRetirementWatchers.has(runId);
}

/** Exact cleanup begun by a post-fence durable commit. */
const lateFencedInteractiveReleases = new Set<Promise<void>>();
let interactiveShutdownActive = false;
let interactiveShutdownGeneration = 0;
/** Non-null only while reset drains the prior generation outside the fence. */
let interactiveResetDrainGeneration: number | null = null;
let lifecycleEventServer: LifecycleEventServer | null = null;
let lifecycleEventServerStarting: Promise<LifecycleEventServer | null> | null = null;
async function getLifecycleEventServer(): Promise<LifecycleEventServer | null> {
  if (lifecycleEventServer) return lifecycleEventServer;
  if (!lifecycleEventServerStarting) lifecycleEventServerStarting = LifecycleEventServer.start()
    .then((server) => { lifecycleEventServer = server; return server; })
    .catch(() => null)
    .finally(() => { lifecycleEventServerStarting = null; });
  return await lifecycleEventServerStarting;
}
async function closeLifecycleEventServer(): Promise<void> {
  const starting = lifecycleEventServerStarting;
  if (starting) await starting;
  const server = lifecycleEventServer;
  lifecycleEventServer = null;
  await server?.close().catch(() => undefined);
}
// These are process-local, read-only sharing helpers. They intentionally have
// no settled cache and are reset with the interactive shutdown generation.
const topologySnapshotBatch = new TopologySnapshotBatch({ timeoutMs: 5_000 });
let topologyMutationGeneration = 0;
const advanceTopologyMutationGeneration = () => {
  topologyMutationGeneration += 1;
  topologySnapshotBatch.reset();
};

/** Test seam for fencing observations that overlap a topology mutation. */
export function advanceTopologyMutationGenerationForTest(): void {
  advanceTopologyMutationGeneration();
}

/** Test seam for the current topology mutation epoch. */
export function getTopologyMutationGenerationForTest(): number {
  return topologyMutationGeneration;
}

function isTopologyMutationInvalidatedUndefinedInspection(
  snapshot: { exists: boolean; exited?: boolean; title?: string } | undefined,
  observationGeneration: number,
): boolean {
  return snapshot === undefined && observationGeneration !== topologyMutationGeneration;
}

/** Test seam for the active-loop failure-budget classification. */
export function isTopologyMutationInvalidatedUndefinedInspectionForTest(
  snapshot: { exists: boolean; exited?: boolean; title?: string } | undefined,
  observationGeneration: number,
): boolean {
  return isTopologyMutationInvalidatedUndefinedInspection(snapshot, observationGeneration);
}
const launchPreflightSingleFlight = new LaunchPreflightSingleFlight();
let cmuxEventsClient: CmuxEventsClient | null = null;
let cmuxEventsStartingClient: CmuxEventsClient | null = null;
let cmuxEventsGeneration = 0;
let cmuxEventsAuthorityKey: string | null = null;
let cmuxEventsStartingKey: string | null = null;
let cmuxEventCursor: { boot_id: string; seq: number } | undefined;
let cmuxEventsStarting: Promise<boolean> | null = null;
const cmuxEventWaiters = new Set<() => void>();
const CMUX_TOPOLOGY_MUTATION_EVENTS = new Set([
  "window.created", "window.closed",
  "workspace.created", "workspace.closed", "workspace.moved", "workspace.reordered",
  "pane.created", "pane.closed", "pane.swapped", "pane.broken", "pane.joined",
  "surface.created", "surface.closed", "surface.moved", "surface.reordered",
]);
function isCmuxTopologyMutationEvent(name: string): boolean {
  return CMUX_TOPOLOGY_MUTATION_EVENTS.has(name);
}
/** Test seam for keeping high-volume output/focus events out of topology fencing. */
export function isCmuxTopologyMutationEventForTest(name: string): boolean {
  return isCmuxTopologyMutationEvent(name);
}
const signalCmuxTopologyHint = () => {
  advanceTopologyMutationGeneration();
  for (const resolve of [...cmuxEventWaiters]) resolve();
  cmuxEventWaiters.clear();
};
const closeCmuxEvents = () => {
  cmuxEventsGeneration += 1;
  cmuxEventsClient?.close();
  cmuxEventsStartingClient?.close();
  cmuxEventsClient = null;
  cmuxEventsStartingClient = null;
  cmuxEventsAuthorityKey = null;
  cmuxEventsStartingKey = null;
  cmuxEventCursor = undefined;
  cmuxEventsStarting = null;
  for (const resolve of [...cmuxEventWaiters]) resolve();
  cmuxEventWaiters.clear();
};
export interface CmuxEventsAuthorityForTest { connection: { socketPath: string; socketDev: string; socketIno: string }; appVersion: string; identifyDigest: string }
export function cmuxEventsAuthorityKeyForTest(expected: CmuxEventsAuthorityForTest): string {
  return JSON.stringify([expected.connection.socketPath, expected.connection.socketDev, expected.connection.socketIno, expected.appVersion, expected.identifyDigest]);
}
export function shouldReplaceCmuxEventsAuthorityForTest(currentKey: string | null, expected: CmuxEventsAuthorityForTest): boolean {
  return currentKey !== cmuxEventsAuthorityKeyForTest(expected);
}
async function ensureCmuxEvents(expected: CmuxEventsAuthorityForTest): Promise<boolean> {
  const authorityKey = cmuxEventsAuthorityKeyForTest(expected);
  if (cmuxEventsClient && cmuxEventsAuthorityKey === authorityKey) return true;
  if ((cmuxEventsClient && shouldReplaceCmuxEventsAuthorityForTest(cmuxEventsAuthorityKey, expected)) || (cmuxEventsStarting && shouldReplaceCmuxEventsAuthorityForTest(cmuxEventsStartingKey, expected))) closeCmuxEvents();
  if (cmuxEventsStarting && cmuxEventsStartingKey === authorityKey) return await cmuxEventsStarting;
  const generation = cmuxEventsGeneration;
  let client!: CmuxEventsClient;
  const starting = (async () => {
    client = new CmuxEventsClient({
      env: process.env,
      includeHeartbeats: true,
      cursor: cmuxEventCursor,
      expectedConnection: expected.connection,
      appVersionValidator: async (identify) => {
        const digest = crypto.createHash("sha256").update(JSON.stringify(identify, Object.keys(identify).sort())).digest("hex");
        return digest === expected.identifyDigest && await readCmuxAppBundleVersion(identify) === expected.appVersion;
      },
      onEvent: (event) => { if (generation === cmuxEventsGeneration && isCmuxTopologyMutationEvent(event.name)) signalCmuxTopologyHint(); },
      onReconcile: () => { if (generation === cmuxEventsGeneration) signalCmuxTopologyHint(); },
      onDisconnect: () => {
        if (generation !== cmuxEventsGeneration) return;
        cmuxEventCursor = client.cursor;
        if (cmuxEventsClient === client) { cmuxEventsClient = null; cmuxEventsAuthorityKey = null; }
        signalCmuxTopologyHint();
      },
    });
    cmuxEventsStartingClient = client;
    try {
      await client.start();
      if (generation !== cmuxEventsGeneration || !client.healthy) {
        if (generation === cmuxEventsGeneration) cmuxEventCursor = client.cursor;
        client.close();
        return false;
      }
      cmuxEventsClient = client;
      cmuxEventsAuthorityKey = authorityKey;
      return true;
    } catch {
      client.close();
      return false;
    } finally {
      if (cmuxEventsStartingClient === client) cmuxEventsStartingClient = null;
      if (cmuxEventsStartingKey === authorityKey) cmuxEventsStartingKey = null;
    }
  })();
  cmuxEventsStartingKey = authorityKey;
  cmuxEventsStarting = starting;
  try { return await starting; }
  finally { if (cmuxEventsStarting === starting) cmuxEventsStarting = null; }
}
async function runLifecycleServerWait(server: LifecycleEventServer | null, runId: string, timeoutMs: number): Promise<void> {
  if (!server) return await delay(timeoutMs);
  await server.waitForEvent(runId, timeoutMs);
}
async function waitForCmuxTopologyHint(timeoutMs: number): Promise<void> {
  if (!cmuxEventsClient) return await delay(timeoutMs);
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cmuxEventWaiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    cmuxEventWaiters.add(finish);
  });
}
let interactiveFenceMutex: Promise<void> = Promise.resolve();
let tmuxLaunchMutex: Promise<void> = Promise.resolve();
let cmuxLaunchMutex: Promise<void> = Promise.resolve();

/**
 * Serialize one terminal backend's topology snapshots, staged gate consumption,
 * and exact close-and-inspect mutations. A cancelled queued waiter relinquishes
 * its FIFO slot only after its predecessor, so it cannot let a later mutation pass it.
 */
async function acquireTopologyMutationMutex(
  backend: "cmux" | "tmux",
  signal?: AbortSignal,
): Promise<() => void> {
  const abortedMessage = `${backend} topology lock acquisition aborted.`;
  if (signal?.aborted) throw new Error(abortedMessage);
  const previous = backend === "cmux" ? cmuxLaunchMutex : tmuxLaunchMutex;
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  if (backend === "cmux") cmuxLaunchMutex = previous.then(() => current);
  else tmuxLaunchMutex = previous.then(() => current);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(abortedMessage));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } catch (error) {
    // Preserve FIFO ordering for later waiters even though this caller leaves
    // immediately: its queue slot opens only after its predecessor does.
    void previous.then(unlock, unlock);
    throw error;
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
  if (signal?.aborted) {
    unlock();
    throw new Error(abortedMessage);
  }
  let released = false;
  return () => { if (!released) { released = true; unlock(); } };
}

async function acquireTmuxLaunchMutex(signal?: AbortSignal): Promise<() => void> {
  return await acquireTopologyMutationMutex("tmux", signal);
}

async function acquireCmuxLaunchMutex(signal?: AbortSignal): Promise<() => void> {
  return await acquireTopologyMutationMutex("cmux", signal);
}

/** Test seam for the process-local tmux topology lock. */
export async function acquireTmuxTopologyMutationLockForTest(signal?: AbortSignal): Promise<() => void> {
  return await acquireTmuxLaunchMutex(signal);
}

/** Test seam for the process-local cmux topology lock. */
export async function acquireCmuxTopologyMutationLockForTest(signal?: AbortSignal): Promise<() => void> {
  return await acquireCmuxLaunchMutex(signal);
}
const INTERACTIVE_SHUTDOWN_DRAIN_ATTEMPTS = 8;
const INTERACTIVE_SHUTDOWN_RELEASE_WAIT_MS = 1_000;
/** One per-run upper bound for terminal lease, callback, and filesystem preparation. */
const INTERACTIVE_TERMINAL_PUBLICATION_WAIT_MS = 1_000;

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
  await withInteractiveFenceMutex(async () => {
    if (interactiveShutdownActive) {
      // A reset deliberately holds the fence closed while it drains. A newer
      // shutdown supersedes that reset so its final reopen cannot win.
      if (interactiveResetDrainGeneration === interactiveShutdownGeneration) {
        interactiveShutdownGeneration += 1;
        interactiveResetDrainGeneration = null;
      }
      return;
    }
    interactiveShutdownActive = true;
    interactiveShutdownGeneration += 1;
    cancelDetachedRetirementWatchers();
    // Cancellation happens while fenced; watcher I/O drains below, outside the
    // global fence, so a reconciliation cannot deadlock on its final check.
    cancelCompletedHerdrRetirementWatchers();
    advanceTopologyMutationGeneration();
    shutdownTmuxControlPool();
    closeCmuxEvents();
    launchPreflightSingleFlight.reset();
    await closeLifecycleEventServer();
  });
  await Promise.all([drainDetachedRetirementWatchers(), drainCompletedHerdrRetirementWatchers()]);
}

/** Reset for a new session; every reset is a distinct generation. */
export async function resetInteractiveShutdownForSession(): Promise<void> {
  let resetGeneration = 0;
  await withInteractiveFenceMutex(async () => {
    // Keep starts fenced until the old generation's watcher I/O and committed
    // cleanup have drained. Opening this generation happens in the final fence.
    interactiveShutdownActive = true;
    interactiveShutdownGeneration += 1;
    resetGeneration = interactiveShutdownGeneration;
    interactiveResetDrainGeneration = resetGeneration;
    cancelDetachedRetirementWatchers();
    cancelCompletedHerdrRetirementWatchers();
    advanceTopologyMutationGeneration();
    resetTmuxControlPoolForNewSession();
    closeCmuxEvents();
    launchPreflightSingleFlight.reset();
    await closeLifecycleEventServer();
  });
  await Promise.all([drainDetachedRetirementWatchers(), drainCompletedHerdrRetirementWatchers()]);
  await withInteractiveFenceMutex(() => {
    // A newer reset or shutdown owns the fence now; never reopen over it.
    if (interactiveShutdownGeneration === resetGeneration && interactiveResetDrainGeneration === resetGeneration) {
      interactiveShutdownActive = false;
      interactiveResetDrainGeneration = null;
    }
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

function sanitizeInteractivePreview(value: unknown, maxLength = 256): string | undefined {
  const normalized = String(value ?? "").replace(/\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\x1b]*\x1b\\|[@-_])/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function interactiveSnapshot(run: ActiveInteractiveRun): InteractiveRunUxSnapshot {
  return Object.freeze({
    runId: run.runId,
    ...(run.invocationId === undefined ? {} : { invocationId: run.invocationId }),
    agent: run.agent,
    depth: run.depth,
    backend: run.backend.mode,
    ...(run.handle.placement ? { placement: run.handle.placement.placement } : {}),
    ownership: run.ownership,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.preview ? { preview: run.preview } : {}),
    ...(run.herdr ? { herdr: Object.freeze({ transport: run.herdr.transport, target: run.herdr.target, orphanRisk: run.herdr.orphanRisk }) } : {}),
  });
}

export function listInteractiveRunUxSnapshots(): readonly InteractiveRunUxSnapshot[] {
  return Object.freeze(Array.from(activeInteractiveRuns.values()).sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId)).map(interactiveSnapshot));
}
/** Presentation updates are called only from shared transport callbacks or monitor teardown. */
function updateHerdrRunPresentation(runId: string, update: Partial<HerdrRunPresentationDiagnostics>, terminal?: HerdrTerminalClassification): void {
  const run = activeInteractiveRuns.get(runId);
  if (!run?.herdr) return;
  const target = terminal === undefined ? update.target
    : terminal.state === "absent" ? "absent"
      : terminal.state === "unknown" ? "unknown"
      : terminal.handle.workspaceId === run.herdr.initialWorkspaceId && terminal.handle.tabId === run.herdr.initialTabId
        && terminal.handle.paneId === run.herdr.initialPaneId && terminal.handle.terminalId === run.herdr.initialTerminalId ? "current" : "moved";
  const next = { ...run.herdr, ...update, ...(target ? { target } : {}) };
  next.orphanRisk = next.transport === "healthy" && next.target === "current" ? "none" : "possible";
  if (next.transport === run.herdr.transport && next.target === run.herdr.target && next.orphanRisk === run.herdr.orphanRisk) return;
  run.herdr = next;
  run.updatedAt = Date.now();
  notifyInteractiveRunChanges();
}

/** A transport transition invalidates any prior target classification. */
function updateHerdrRunTransportPresentation(runId: string, healthy: boolean): void {
  // A newly acknowledged stream, including a successful reconnect, proves
  // only transport health. Do not retain a prior current/moved target until
  // this stream's fresh read-only classification completes.
  updateHerdrRunPresentation(runId, { transport: healthy ? "healthy" : "reconnecting", target: "unknown", orphanRisk: "possible" });
}

/** A stopped monitor has no transport or target proof for a retained run. */
function markRetainedHerdrRunPresentationUnavailable(runId: string, targetConfirmedAbsent: boolean): void {
  if (targetConfirmedAbsent) return;
  updateHerdrRunTransportPresentation(runId, false);
}

/** Test seam for the transport-to-classification presentation boundary. */
export function updateHerdrRunTransportPresentationForTest(runId: string, healthy: boolean): void {
  updateHerdrRunTransportPresentation(runId, healthy);
}
/** Test seam for the read-only presentation classification result. */
export function updateHerdrRunPresentationClassificationForTest(runId: string, terminal: HerdrTerminalClassification): void {
  updateHerdrRunPresentation(runId, {}, terminal);
}
/** Test seam for the monitor-finally presentation downgrade. */
export function markRetainedHerdrRunPresentationUnavailableForTest(runId: string, targetConfirmedAbsent = false): void {
  markRetainedHerdrRunPresentationUnavailable(runId, targetConfirmedAbsent);
}

export function updateInteractiveRunPreview(runId: string, value: unknown): void {
  const run = activeInteractiveRuns.get(runId);
  if (!run) return;
  const preview = sanitizeInteractivePreview(value);
  if (preview) { run.preview = preview; run.updatedAt = Date.now(); }
}

async function serializeInteractiveRun<T>(run: ActiveInteractiveRun, action: () => Promise<T>): Promise<T> {
  const previous = run.operation;
  let release!: () => void;
  run.operation = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await action(); } finally { release(); }
}

function createInteractiveResultMutationQueue(): { run<T>(operation: () => Promise<T>): Promise<T> } {
  let tail: Promise<void> = Promise.resolve();
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await operation(); } finally { release(); }
    },
  };
}

/** Test seam for the per-run live-drain/completion mutation serializer. */
export function createInteractiveResultMutationQueueForTest(): { run<T>(operation: () => Promise<T>): Promise<T> } {
  return createInteractiveResultMutationQueue();
}

export async function inspectInteractiveRunForUx(runId: string): Promise<(InteractiveRunUxSnapshot & { exists?: boolean; exited?: boolean; title?: string; titleState?: "matching" | "changed" | "unavailable"; focusSupported: boolean; promoteSupported: boolean }) | null> {
  const run = activeInteractiveRuns.get(runId);
  if (!run) return null;
  // Active V3 tmux UX reads resolve the currently accepted lease backend at
  // call time. A pending/disconnected lease deliberately has no fallback to
  // the backend captured at commit, which could be a short-lived CLI runner.
  const uxBackend = run.uxBackend ? run.uxBackend() : run.backend;
  // UX title reads are optional and occur only through the backend's
  // post-fingerprint diagnostic path; lifecycle callers use inspect() alone.
  const pane = uxBackend
    ? await (uxBackend.inspectForUx?.(run.handle) ?? uxBackend.inspect(run.handle)).catch(() => undefined)
    : undefined;
  const titleState = !pane?.title ? "unavailable" : isInteractiveTitleMatchingBase(pane.title, run.surfaceTitle) ? "matching" : "changed";
  return Object.freeze({ ...interactiveSnapshot(run), ...(pane ? { exists: pane.exists, ...(pane.exited === undefined ? {} : { exited: pane.exited }) } : {}), title: run.surfaceTitle, titleState, focusSupported: run.focusSupported, promoteSupported: Boolean(run.paths) });
}

export async function focusInteractiveRun(runId: string): Promise<boolean> {
  const run = activeInteractiveRuns.get(runId);
  if (!run?.backend.focus || !run.focusSupported) return false;
  let queued: Promise<boolean> | undefined;
  await withInteractiveFenceMutex(() => {
    if (activeInteractiveRuns.get(runId) !== run) return;
    queued = serializeInteractiveRun(run, async () => {
      const authorized = await withInteractiveFenceMutex(() => canStartInteractiveRun(run.generation) && activeInteractiveRuns.get(runId) === run);
      return authorized && await run.backend.focus!(run.handle).catch(() => false);
    });
  });
  return await queued ?? false;
}

export async function keepInteractiveRun(runId: string): Promise<boolean> {
  const run = activeInteractiveRuns.get(runId);
  if (!run) return false;
  let queued: Promise<boolean> | undefined;
  await withInteractiveFenceMutex(() => {
    if (activeInteractiveRuns.get(runId) !== run) return;
    queued = serializeInteractiveRun(run, async () => {
      const authorized = await withInteractiveFenceMutex(() => canStartInteractiveRun(run.generation) && activeInteractiveRuns.get(runId) === run);
      if (!authorized) return false;
      const snapshot = await run.backend.inspect(run.handle).catch(() => undefined);
      if (!snapshot?.exists || snapshot.exited) return false;
      await withInteractiveFenceMutex(() => {
        if (activeInteractiveRuns.get(runId) === run && run.ownership === "managed") {
          cancelCompletedHerdrRetirementWatcher(runId);
          run.ownership = "kept";
          run.updatedAt = Date.now();
        }
      });
      return run.ownership === "kept";
    });
  });
  return await queued ?? false;
}

type OwnershipMarkerState = "missing" | "matching" | "unknown";

/**
 * Markers are recovery records, not evidence that this active child withdrew
 * its lease checker.  They may predate an interrupted transfer, so promotion
 * still requires the child-bound request/ack exchange below.
 */
async function classifyExistingOwnershipMarkers(paths: RunArtifactPaths, runId: string, allocationDigest: string): Promise<OwnershipMarkerState> {
  const [detachedArtifact, legacyArtifact] = await Promise.all([
    readBrokerArtifact(paths.detachedOwnershipPath),
    readBrokerArtifact(paths.userOwnershipPath),
  ]);
  const detachedExists = detachedArtifact.outcome !== "missing";
  const legacyExists = legacyArtifact.outcome !== "missing";
  if (!detachedExists && !legacyExists) return "missing";
  const detached = detachedArtifact.outcome === "valid" ? parseDetachedOwnershipRecord(detachedArtifact.value, runId) : null;
  const legacy = legacyArtifact.outcome === "valid" ? parseUserOwnershipRecord(legacyArtifact.value, runId) : null;
  if (detachedExists && (!detached || detached.allocation.digest !== allocationDigest)) return "unknown";
  if (legacyExists && (!legacy || legacy.allocationDigest !== allocationDigest)) return "unknown";
  // Mixed-era records must still name the same immutable allocation.
  if (detached && legacy && detached.allocation.digest !== legacy.allocationDigest) return "unknown";
  return "matching";
}

async function waitForOwnershipTransferAck(paths: RunArtifactPaths, request: ReturnType<typeof parseOwnershipTransferRequest>, timeoutMs = PROMOTION_ACK_TIMEOUT_MS): Promise<boolean> {
  if (!request) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ack = parseOwnershipTransferAck(await readBoundedPrivateJson(paths.promotionAckPath, { requireSingleLineTerminated: true }), request.runId);
    if (ack && sameOwnershipTransfer(request, ack)) return true;
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  return false;
}

/** Revalidate a settled transfer before accepting an in-memory detached state. */
async function hasCompleteDetachedOwnershipTransfer(paths: RunArtifactPaths, runId: string): Promise<boolean> {
  const allocation = await readBoundedPrivateJson(paths.allocationPath, { requireSingleLineTerminated: true });
  const parsedAllocation = allocation && typeof allocation === "object" && !Array.isArray(allocation) && (allocation as { version?: unknown }).version === 3
    ? parseAllocationRecordV3(allocation, runId) : parseAllocationRecordV2(allocation, runId);
  if (!parsedAllocation) return false;
  const allocationDigest = crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex");
  if (await classifyExistingOwnershipMarkers(paths, runId, allocationDigest) !== "matching") return false;
  const [requestArtifact, ackArtifact, detachedArtifact, completionArtifact] = await Promise.all([
    readBrokerArtifact(paths.promotionRequestPath),
    readBrokerArtifact(paths.promotionAckPath),
    readBrokerArtifact(paths.detachedOwnershipPath),
    readBrokerArtifact(paths.completionPath),
  ]);
  // A completion pathname is terminal authority even when unreadable or
  // malformed. A detached transfer chain alongside it is dual authority.
  if (completionArtifact.outcome !== "missing") return false;
  const request = requestArtifact.outcome === "valid" ? parseOwnershipTransferRequest(requestArtifact.value, runId) : null;
  const ack = ackArtifact.outcome === "valid" ? parseOwnershipTransferAck(ackArtifact.value, runId) : null;
  const detached = detachedArtifact.outcome === "valid" ? parseDetachedOwnershipRecord(detachedArtifact.value, runId) : null;
  return request !== null && ack !== null && detached !== null
    && request.allocation.digest === allocationDigest
    && sameOwnershipTransfer(request, ack);
}

/** Bounded retry keeps a transient authority-store failure from becoming success. */
async function detachInteractiveTreePermitWithRetry(treePermitLease?: Pick<TreePermitLease, "detachBoundChild">): Promise<boolean> {
  if (!treePermitLease) return true;
  for (let attempt = 0; attempt < TREE_PERMIT_DETACH_ATTEMPTS; attempt += 1) {
    if (await treePermitLease.detachBoundChild().catch(() => false)) return true;
    if (attempt + 1 < TREE_PERMIT_DETACH_ATTEMPTS) await delay(TREE_PERMIT_DETACH_RETRY_MS);
  }
  return false;
}

async function settleInteractiveTreePermitAfterOwnership(ownership: InteractiveRunOwnership | undefined, treePermitLease?: Pick<TreePermitLease, "detachBoundChild">): Promise<boolean> {
  // Only a durable detached transfer may return parent-held capacity. An
  // in-progress or indeterminate handoff retains the permit for recovery.
  return ownership !== "detached" || await detachInteractiveTreePermitWithRetry(treePermitLease);
}

/** Test seam for the monitor's ownership/permit settlement decision. */
export async function settleInteractiveTreePermitAfterOwnershipForTest(ownership: InteractiveRunOwnership | undefined, treePermitLease?: Pick<TreePermitLease, "detachBoundChild">): Promise<boolean> {
  return await settleInteractiveTreePermitAfterOwnership(ownership, treePermitLease);
}

function applyInteractiveOwnershipUnknownResult(result: SingleResult): void {
  result.exitCode = 1;
  result.stopReason = "error";
  result.errorMessage = "Interactive subagent ownership transfer is uncertain.";
  result.stderr = result.stderr ? `${result.stderr}\n${result.errorMessage}` : result.errorMessage;
  // Deliberately do not set sawAgentEnd: uncertainty is not completion.
}

/** Test seam for the monitor's explicit uncertain-ownership outcome. */
export function applyInteractiveOwnershipUnknownResultForTest(result: SingleResult): void {
  applyInteractiveOwnershipUnknownResult(result);
}

export async function promoteInteractiveRun(runId: string, detachedAt = Date.now()): Promise<InteractivePromotionOutcome> {
  const run = activeInteractiveRuns.get(runId);
  if (!run?.paths || !Number.isSafeInteger(detachedAt) || detachedAt <= 0) return "rejected";
  let notifyOwnershipUnknown = false;
  const markOwnershipUnknown = (): InteractivePromotionOutcome => {
    notifyOwnershipUnknown ||= run.ownership === "detached";
    cancelCompletedHerdrRetirementWatcher(runId);
    run.ownership = "ownership-unknown";
    run.updatedAt = Date.now();
    return "ownership-unknown";
  };
  let queued: Promise<InteractivePromotionOutcome> | undefined;
  await withInteractiveFenceMutex(() => {
    if (activeInteractiveRuns.get(runId) !== run) return;
    // Reserve promotion behind any already-authorized target operation without
    // retaining the global fence while that backend operation is in flight.
    queued = serializeInteractiveRun(run, async () => {
    const authorized = await withInteractiveFenceMutex(() => activeInteractiveRuns.get(runId) === run);
    if (!authorized) return "rejected";
    // A caller may retry after the monitor has already observed detachment and
    // the pane has exited. Durable protocol evidence, not target liveness, is
    // the sole authority for this idempotent outcome.
    if (run.ownership === "detached") {
      if (!await hasCompleteDetachedOwnershipTransfer(run.paths!, runId)) {
        return markOwnershipUnknown();
      }
      if (!await detachInteractiveTreePermitWithRetry(run.treePermitLease)) {
        return markOwnershipUnknown();
      }
      return "already-promoted";
    }
    if (!canStartInteractiveRun(run.generation)) return "rejected";
    const snapshot = await run.backend.inspect(run.handle).catch(() => undefined);
    if (!snapshot?.exists || snapshot.exited) return "rejected";
    const allocation = await readBoundedPrivateJson(run.paths!.allocationPath, { requireSingleLineTerminated: true });
    const parsedAllocation = allocation && typeof allocation === "object" && !Array.isArray(allocation) && (allocation as { version?: unknown }).version === 3
      ? parseAllocationRecordV3(allocation, runId) : parseAllocationRecordV2(allocation, runId);
    if (!parsedAllocation) return "rejected";
    const allocationDigest = crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex");
    const existingMarker = await classifyExistingOwnershipMarkers(run.paths!, runId, allocationDigest);
    if (existingMarker === "unknown") return markOwnershipUnknown();
    const child = parseRunState(await readBoundedPrivateJson(run.paths!.statePath), runId);
    const parentStartedAt = getCurrentProcessStartedAt();
    if (!child?.childPid || !child.childStartedAt || parentStartedAt === null) return "rejected";
    const expected = {
      allocationDigest,
      parentPid: process.pid, parentStartedAt, childPid: child.childPid, childStartedAt: child.childStartedAt,
    };
    const isCurrentRequest = (request: ReturnType<typeof parseOwnershipTransferRequest>): request is NonNullable<typeof request> => request !== null
      && request.allocation.digest === expected.allocationDigest
      && request.parent.pid === expected.parentPid && request.parent.startedAt === expected.parentStartedAt
      && request.child.pid === expected.childPid && request.child.startedAt === expected.childStartedAt;
    const requestArtifact = await readBrokerArtifact(run.paths!.promotionRequestPath);
    // The per-run FIFO serializes observer terminal publication. Any existing
    // completion artifact—including malformed/unreadable authority—wins before
    // promotion; never reinterpret it as an absent terminal record.
    const completionArtifact = await readBrokerArtifact(run.paths!.completionPath);
    if (completionArtifact.outcome !== "missing") return "rejected";
    // Completion and cancellation now share this immutable pathname. Either
    // winner revokes ownership transfer before a request can be published.
    if ((await readBrokerArtifact(run.paths!.completionFencePath)).outcome !== "missing") return "rejected";
    let request: NonNullable<ReturnType<typeof parseOwnershipTransferRequest>>;
    if (requestArtifact.outcome === "missing") {
      request = {
        contract: "pi-subagent.detached-transfer" as const, version: 1 as const, kind: "request" as const,
        transferId: crypto.randomUUID(), runId, allocation: { algorithm: "sha256" as const, digest: allocationDigest },
        parent: { pid: process.pid, startedAt: parentStartedAt }, child: { pid: child.childPid, startedAt: child.childStartedAt }, requestedAt: detachedAt,
      };
      // Revocation precedes publication: a request that wins concurrently must
      // never leave shutdown/cancel with parent cleanup authority. This is a
      // distinct non-terminal state so the monitor cannot publish target loss
      // while the child is fencing and acknowledging the handoff.
      cancelCompletedHerdrRetirementWatcher(runId);
      run.ownership = "transferring";
      run.updatedAt = Date.now();
      try {
        if (await publishImmutableJson(run.paths!.promotionRequestPath, request) === "exists") {
          const winner = parseOwnershipTransferRequest(await readBoundedPrivateJson(run.paths!.promotionRequestPath, { requireSingleLineTerminated: true }), runId);
          if (!isCurrentRequest(winner)) return markOwnershipUnknown();
          request = winner;
        }
      } catch {
        return markOwnershipUnknown();
      }
    } else {
      const winner = requestArtifact.outcome === "valid" ? parseOwnershipTransferRequest(requestArtifact.value, runId) : null;
      if (!isCurrentRequest(winner)) return markOwnershipUnknown();
      // A same-process retry may observe an exact request after a late child
      // acknowledgement. It is the only ownership-unknown state we reconcile;
      // this queued operation retains the run's terminal ordering while ACK
      // I/O proceeds outside the process-global fence.
      request = winner;
      cancelCompletedHerdrRetirementWatcher(runId);
      run.ownership = "transferring";
      run.updatedAt = Date.now();
    }
    try {
      if (!await waitForOwnershipTransferAck(run.paths!, request)) return markOwnershipUnknown();
      // ACK durability first fences the child; settle the exact parent-held
      // tree lease before publishing detached ownership. The child may release
      // the same token concurrently, and exact absence is an idempotent win.
      if ((await readBrokerArtifact(run.paths!.completionPath)).outcome !== "missing") return markOwnershipUnknown();
      if (!await detachInteractiveTreePermitWithRetry(run.treePermitLease)) return markOwnershipUnknown();
      // Completion racing lease settlement is still terminal authority and
      // must never be hidden behind a final detached marker.
      if ((await readBrokerArtifact(run.paths!.completionPath)).outcome !== "missing") return markOwnershipUnknown();
      const finalRecord = { contract: "pi-subagent.detached-ownership" as const, version: 1 as const, runId, owner: "user" as const,
        detachedAt, allocation: request.allocation };
      await publishImmutableJson(run.paths!.detachedOwnershipPath, finalRecord);
      if (await classifyExistingOwnershipMarkers(run.paths!, runId, allocationDigest) !== "matching") throw new Error("detached marker verification failed");
      if ((await readBrokerArtifact(run.paths!.completionPath)).outcome !== "missing") return markOwnershipUnknown();
      const committed = await withInteractiveFenceMutex(() => {
        if (activeInteractiveRuns.get(runId) !== run || run.ownership !== "transferring") return false;
        run.ownership = "detached";
        run.updatedAt = Date.now();
        return true;
      });
      if (committed) notifyInteractiveRunChanges();
      return committed ? existingMarker === "matching" ? "already-promoted" : "promoted" : "ownership-unknown";
    } catch {
      // Request/ack publication can have succeeded when I/O reports an error.
      // Never resume local cleanup authority after such an uncertain handoff.
      return markOwnershipUnknown();
    }
    });
  });
  const outcome = await queued ?? "rejected";
  // Presence filtering excludes detached runs but conservatively includes
  // unknown ownership. Notify after releasing the interactive fence.
  if (notifyOwnershipUnknown) notifyInteractiveRunChanges();
  return outcome;
}


/**
 * The only active-registry close path. Observation is never close authority:
 * reserve the per-run FIFO slot under the promotion fence, then verify the
 * immutable winner when that operation starts. Backend mutation occurs only
 * after the global fence is released. Missing/malformed/replaced completion
 * authority retains recovery.
 */
type ExactUnixChildTerminationOutcome = "terminated" | "completion-won" | "revoked";

interface ExactUnixChildTerminationOptions {
  processId: number;
  expectedStartedAt: number;
  /** The immutable cancellation claim and durable ownership/state must remain exact. */
  isStillAuthorized: () => Promise<boolean>;
  classifyIdentity?: (processId: number, expectedStartedAt: number) => ProcessIdentityStatus;
  signal?: (processId: number, signal: "SIGTERM" | "SIGKILL") => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Relevant lifecycle/Herdr wake only; never a periodic inspection timer. */
  waitForWake?: (timeoutMs: number) => Promise<void>;
  termGraceMs?: number;
}

/**
 * Escalate only an exact child PID/start tuple after cancellation has already
 * won the shared immutable fence. It intentionally never signals a process
 * group or descendants.
 */
async function terminateExactUnixChild(options: ExactUnixChildTerminationOptions): Promise<ExactUnixChildTerminationOutcome> {
  if (isWindows) return "revoked";
  const classify = options.classifyIdentity ?? classifyParentProcessIdentity;
  const signal = options.signal ?? ((processId, terminationSignal) => {
    try { process.kill(processId, terminationSignal); return true; } catch { return false; }
  });
  const sleep = options.sleep ?? (async (milliseconds) => await delay(milliseconds));
  if (!await options.isStillAuthorized()
    || classify(options.processId, options.expectedStartedAt) !== "live"
    || !signal(options.processId, "SIGTERM")) return "revoked";
  // The cancellation winner remains immutable through one bounded grace
  // deadline. Relevant lifecycle/Herdr events can prove an early exact-child
  // exit; no artifact/process polling is performed. Bound pathological
  // immediate wake delivery before yielding once to the same final deadline.
  const deadline = Date.now() + Math.max(0, options.termGraceMs ?? SIGKILL_TIMEOUT_MS);
  let wakeRevalidations = 0;
  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now());
    if (!options.waitForWake || wakeRevalidations >= 16) {
      await sleep(remainingMs);
      break;
    }
    await options.waitForWake(remainingMs);
    if (Date.now() >= deadline) break;
    if (!await options.isStillAuthorized()) return "revoked";
    if (classify(options.processId, options.expectedStartedAt) !== "live") return "terminated";
    wakeRevalidations += 1;
  }
  if (!await options.isStillAuthorized()) return "revoked";
  if (classify(options.processId, options.expectedStartedAt) !== "live") return "terminated";
  return signal(options.processId, "SIGKILL") ? "terminated" : "revoked";
}

/** Test seam for the exact-PID-only Herdr cancellation escalation. */
export async function terminateExactUnixChildForTest(options: ExactUnixChildTerminationOptions): Promise<boolean> {
  return await terminateExactUnixChild(options) === "terminated";
}

/**
 * Active direct-Herdr cancellation is the sole force-termination authority.
 * It first elects a cancellation claim against the child's completion fence;
 * therefore no read of that pathname can race the eventual SIGTERM/SIGKILL.
 */
type ExactUnixChildTerminationHooks = Pick<ExactUnixChildTerminationOptions, "classifyIdentity" | "signal" | "sleep" | "waitForWake" | "termGraceMs">;

async function terminateAuthorizedHerdrChild(
  runId: string,
  expectedRun: ActiveInteractiveRun,
  hooks: ExactUnixChildTerminationHooks = {},
): Promise<ExactUnixChildTerminationOutcome> {
  const expectedOwnership = expectedRun.ownership;
  if (!expectedRun.paths || (expectedOwnership !== "managed" && expectedOwnership !== "kept")) return "revoked";
  let queued: Promise<ExactUnixChildTerminationOutcome> | undefined;
  await withInteractiveFenceMutex(() => {
    if (activeInteractiveRuns.get(runId) !== expectedRun || expectedRun.ownership !== expectedOwnership) return;
    queued = serializeInteractiveRun(expectedRun, async () => {
      const paths = expectedRun.paths!;
      const initialState = parseRunState(await readBoundedPrivateJson(paths.statePath), runId);
      if (!initialState?.childPid || !initialState.childStartedAt) return "revoked";
      const expectedChild = { pid: initialState.childPid, startedAt: initialState.childStartedAt };
      const ownsExactState = async () => {
        const owns = await withInteractiveFenceMutex(() => activeInteractiveRuns.get(runId) === expectedRun
          && expectedRun.ownership === expectedOwnership);
        if (!owns) return false;
        const state = parseRunState(await readBoundedPrivateJson(paths.statePath), runId);
        return state?.childPid === expectedChild.pid && state.childStartedAt === expectedChild.startedAt;
      };
      // Validate completion, ownership, and the exact durable child tuple
      // before linking the immutable claim. Any existing completion artifact
      // is terminal authority; a malformed path or an existing cancellation
      // claim remains revoked/fail-closed inside claimCancellationFence.
      if ((await readBrokerArtifact(paths.completionPath)).outcome !== "missing" || !await ownsExactState()) return "revoked";
      const winner = await claimCancellationFence(paths, runId, expectedChild.pid, expectedChild.startedAt);
      if (winner === "completion-won") return "completion-won";
      if (winner !== "claimed") return "revoked";
      // The claim is now the only completion/cancellation winner. Revalidate
      // only mutable ownership and exact PID/start state during grace; never
      // reread the shared fence at a signal boundary.
      return await terminateExactUnixChild({
        processId: expectedChild.pid,
        expectedStartedAt: expectedChild.startedAt,
        isStillAuthorized: ownsExactState,
        ...hooks,
      });
    });
  });
  return await queued ?? "revoked";
}

/** Test seam for the registered-run cancellation path, including its FIFO and artifact checks. */
export async function terminateAuthorizedHerdrChildForTest(
  runId: string,
  hooks: ExactUnixChildTerminationHooks = {},
): Promise<ExactUnixChildTerminationOutcome> {
  const run = activeInteractiveRuns.get(runId);
  return run ? await terminateAuthorizedHerdrChild(runId, run, hooks) : "revoked";
}

async function interruptActiveInteractiveRunWithoutWinner(options: {
  runId: string;
  expectedRun: ActiveInteractiveRun;
}): Promise<boolean> {
  let queued: Promise<boolean> | undefined;
  await withInteractiveFenceMutex(() => {
    const current = activeInteractiveRuns.get(options.runId);
    if (current !== options.expectedRun
      || (current.ownership !== "managed" && current.ownership !== "kept")) return;
    // Reserve this run's FIFO slot while the promotion fence is held. The
    // operation re-enters the fence after its predecessor settles, so no
    // backend I/O can retain the global fence.
    queued = serializeInteractiveRun(current, async () => {
      const authorized = await withInteractiveFenceMutex(() => activeInteractiveRuns.get(options.runId) === current
        && (current.ownership === "managed" || current.ownership === "kept"));
      if (!authorized) return false;
      // Completion authority is durable I/O and must not retain the process
      // global fence. This operation's FIFO slot still prevents a later exact
      // target mutation from overtaking it.
      if (current.paths && (await readBrokerArtifact(current.paths.completionPath)).outcome !== "missing") return false;
      // Direct Herdr tabs have no parent-side pane mutation authority. Ask the
      // authenticated bridge to abort/write completion/shutdown; unavailable
      // control deliberately retains recovery state for its lease fallback.
      if (current.handle.mode === "herdr-pane" && current.handle.placement?.placement === "herdr-new-tab") {
        return lifecycleEventServer?.requestAbort(options.runId) ?? false;
      }
      const interrupt = current.backend.interrupt(current.handle).catch(() => false);
      void interrupt;
      return true;
    });
  });
  return await queued ?? false;
}

/** Direct Herdr tabs are child-owned. One initial and one deadline/event-woken
 * authoritative read replace the former periodic inspection loop. */
async function pollHerdrDirectTabAbsence(run: ActiveInteractiveRun, waitForWake: (timeoutMs: number) => Promise<void>): Promise<boolean> {
  const deadline = Date.now() + ABORT_WAIT_MS;
  const initial = await run.backend.inspect(run.handle).catch(() => undefined);
  if (initial?.exists === false) return true;
  await waitForWake(Math.max(1, deadline - Date.now()));
  const final = await run.backend.inspect(run.handle).catch(() => undefined);
  return final?.exists === false;
}

async function releaseActiveInteractiveRunAfterWinner(options: {
  runId: string;
  expectedRun: ActiveInteractiveRun;
  completion?: CompletionRecord;
  force?: boolean;
  waitForHerdrWake?: (timeoutMs: number) => Promise<void>;
}): Promise<boolean> {
  let queued: Promise<boolean> | undefined;
  await withInteractiveFenceMutex(() => {
    const current = activeInteractiveRuns.get(options.runId);
    if (current !== options.expectedRun
      || (current.ownership !== "managed" && current.ownership !== "kept")) return;
    // Queue the exact release before dropping the fence. A promotion that
    // arrives later waits behind this operation rather than racing its target.
    queued = serializeInteractiveRun(current, async () => {
      const authorized = await withInteractiveFenceMutex(() => activeInteractiveRuns.get(options.runId) === current
        && (current.ownership === "managed" || current.ownership === "kept"));
      if (!authorized) return false;
      const artifact = current.paths
        ? await readBrokerArtifact(current.paths.completionPath)
        : { outcome: "missing" as const };
      const winner = options.completion && artifact.outcome === "valid"
        ? parseCompletionAuthority(artifact.value, options.runId) : null;
      if (options.completion ? !winner || !sameCompletionWinner(winner, options.completion) : artifact.outcome !== "missing") return false;
      // Replay a session-bound winner before any target release. A failed proof
      // retains both the exact target and its recovery transcript for retry.
      if (options.completion && current.applyCompletionWinner
        && !await current.applyCompletionWinner(options.completion).catch(() => false)) return false;
      const stillOwned = await withInteractiveFenceMutex(() => activeInteractiveRuns.get(options.runId) === current
        && (current.ownership === "managed" || current.ownership === "kept"));
      if (!stillOwned) return false;
      // Herdr direct tabs are retired only by their child/terminal lifecycle
      // and read-only absence reconciliation; never send close/keys here. A
      // completion winner already represents terminal cooperation, so it must
      // not trigger a redundant abort request.
      if (current.handle.mode === "herdr-pane" && current.handle.placement?.placement === "herdr-new-tab") {
        // Re-read immediately before cooperative control: a completion that
        // won while this FIFO slot waited revokes even the harmless abort.
        const completionWon = current.paths && (await readBrokerArtifact(current.paths.completionPath)).outcome !== "missing";
        if (!options.completion && !completionWon) void lifecycleEventServer?.requestAbort(options.runId);
        const absent = await pollHerdrDirectTabAbsence(current, options.waitForHerdrWake ?? delay);
        if (!absent && options.completion) watchCompletedHerdrDirectRunForRetirement(current, options.completion);
        return absent;
      }
      return await current.release(options.force).catch(() => false);
    });
  });
  return await queued ?? false;
}

export async function releaseRegisteredInteractiveRun(runId: string, force = false): Promise<boolean> {
  const run = activeInteractiveRuns.get(runId);
  if (!run) return false;
  // Public/manual close is intentionally not terminal cleanup authority. It
  // may operate only before any completion pathname exists.
  return await releaseActiveInteractiveRunAfterWinner({ runId, expectedRun: run, force });
}

/** Register immediately on durable commit, before any one-way launch action. */
export function registerCommittedInteractiveRun(
  run: { runId: string; invocationId?: string; backend: InteractivePaneBackend; /** Active-only UX transport resolver; lifecycle and cleanup retain `backend`. */ uxBackend?: () => InteractivePaneBackend | null; handle: InteractivePaneHandle; paths?: RunArtifactPaths; agent?: string; depth?: number; focusSupported?: boolean; release?: () => Promise<boolean>; treePermitLease?: Pick<TreePermitLease, "detachBoundChild">; sessionIdentity?: SessionFileIdentity; sessionResultStartOffset?: number; applyCompletionWinner?: (completion: CompletionRecord) => Promise<boolean>; stopLeaseWriterAndDrain?: () => Promise<boolean | void>; publishParentCompletion?: ActiveInteractiveRun["publishParentCompletion"]; generation: number },
): boolean {
  const underlyingRelease = run.release ?? (() => closeInteractiveTarget(run.backend, run.handle));
  const now = Date.now();
  const active = {} as ActiveInteractiveRun;
  Object.assign(active, {
    runId: run.runId, ...(run.invocationId === undefined ? {} : { invocationId: run.invocationId }), backend: run.backend, ...(run.uxBackend ? { uxBackend: run.uxBackend } : {}), handle: run.handle, ...(run.paths ? { paths: run.paths } : {}),
    agent: sanitizeInteractivePreview(run.agent, 96) ?? "unknown", depth: Number.isSafeInteger(run.depth) && (run.depth ?? -1) >= 0 ? run.depth! : 0,
    surfaceTitle: buildChildRuntimeTitle(run.agent ?? "unknown", run.runId, run.depth),
    focusSupported: run.focusSupported ?? typeof run.backend.focus === "function", generation: run.generation,
    ownership: "managed", startedAt: now, updatedAt: now, operation: Promise.resolve(),
    ...(run.handle.mode === "herdr-pane" ? { herdr: {
      // A healthy event subscription is not target proof. The first target
      // diagnosis remains unknown until its read-only reconciliation succeeds.
      transport: "unknown" as const, target: "unknown" as const, orphanRisk: "possible" as const,
      initialTerminalId: run.handle.native.terminalId, initialWorkspaceId: run.handle.native.workspaceId,
      initialTabId: run.handle.native.tabId, initialPaneId: run.handle.native.paneId,
    } } : {}),
    ...(run.treePermitLease ? { treePermitLease: run.treePermitLease } : {}),
    ...(run.sessionIdentity ? { sessionIdentity: run.sessionIdentity } : {}),
    ...(run.sessionResultStartOffset !== undefined ? { sessionResultStartOffset: run.sessionResultStartOffset } : {}),
    ...(run.applyCompletionWinner ? { applyCompletionWinner: run.applyCompletionWinner } : {}),
    ...(run.stopLeaseWriterAndDrain ? { stopLeaseWriterAndDrain: run.stopLeaseWriterAndDrain } : {}),
    ...(run.publishParentCompletion ? { publishParentCompletion: run.publishParentCompletion } : {}),
    release: async (force = false) => {
      // Callers must reserve `active.operation` before this exact target
      // mutation. Keeping this check non-serializing lets the global fence be
      // released while a backend close is in flight.
      if (activeInteractiveRuns.get(active.runId) !== active
        || active.ownership === "transferring" || active.ownership === "ownership-unknown" || active.ownership === "detached" || active.ownership === "kept" && !force) return false;
      return await underlyingRelease();
    },
  });
  // A durable commit may race shutdown or a replacement session. Retain the
  // exact target in the retryable registry before its first cleanup attempt:
  // failed/unknown release remains shutdown-owned for later retries.
  if (!canStartInteractiveRun(run.generation)) {
    activeInteractiveRuns.set(active.runId, active);
    notifyInteractiveRunChanges();
    const cleanup = (async () => {
      const drained = await active.stopLeaseWriterAndDrain?.().catch(() => false);
      if (drained === false) return;
      await interruptActiveInteractiveRunWithoutWinner({ runId: active.runId, expectedRun: active });
      // A shutdown-fenced commit has no polling authority. Establish and
      // re-read an exact parent winner before attempting its close; otherwise
      // leave the registered target for independent recovery.
      const publication = active.publishParentCompletion
        ? await active.publishParentCompletion("aborted", "parent-aborted").catch(() => null)
        // Pathless/legacy test registrations have no live callback stream and
        // therefore cannot participate in the V4 fence.
        : active.paths ? await publishParentCompletion(active.paths, active.runId, "aborted", "parent-aborted", active.sessionIdentity).catch(() => null) : null;
      // `publishParentCompletion` returns the exact immutable winner even
      // when an already-published child/reaper record won the race. Replay and
      // release that verified winner; only unreadable/malformed authority
      // reaches the null recovery path above.
      if (active.paths && !publication) return;
      const release = releaseActiveInteractiveRunAfterWinner({ runId: active.runId, expectedRun: active, ...(publication ? { completion: publication.completion } : {}), force: true });
      const released = await awaitInteractiveBooleanBounded(release);
      if (!released) finalizeBoundedInteractiveRelease(active.runId, active, release);
      if (released && activeInteractiveRuns.get(active.runId) === active) {
        activeInteractiveRuns.delete(active.runId);
        notifyInteractiveRunChanges();
      }
    })();
    lateFencedInteractiveReleases.add(cleanup);
    void cleanup.finally(() => lateFencedInteractiveReleases.delete(cleanup));
    return false;
  }
  activeInteractiveRuns.set(active.runId, active);
  notifyInteractiveRunChanges();
  return true;
}

export function unregisterCommittedInteractiveRun(runId: string, targetConfirmedAbsent = false): void {
  const run = activeInteractiveRuns.get(runId);
  // A kept run is session-owned and an indeterminate promotion has explicitly
  // revoked local cleanup authority. Both stay visible until exact absence is
  // separately proven by the caller.
  if (run?.ownership === "managed" || targetConfirmedAbsent) {
    const removed = activeInteractiveRuns.delete(runId);
    cancelDetachedRetirementWatcher(runId);
    cancelCompletedHerdrRetirementWatcher(runId);
    if (removed) notifyInteractiveRunChanges();
  }
}

export async function closeInteractiveTarget(
  backend: InteractivePaneBackend,
  handle: InteractivePaneHandle,
): Promise<boolean> {
  const closeAndInspect = async (): Promise<boolean> => {
    // A close acknowledgement is transport success, not ownership proof. Always
    // inspect the exact recorded fingerprint/UUID after attempting the close.
    // Fence active-loop read batches on both sides of the mutation so an
    // observation started before close can never become terminal authority.
    advanceTopologyMutationGeneration();
    await backend.close(handle).catch(() => false);
    const snapshot = await backend.inspect(handle).catch(() => undefined);
    advanceTopologyMutationGeneration();
    return snapshot !== undefined && snapshot.exists === false;
  };
  // The per-backend FIFO lock is held from source preflight through committed
  // gate handoff. Do not let an exact target close race that window; detached
  // broker/reaper authority remains process-independent.
  const release = handle.mode === "cmux-pane"
    ? await acquireCmuxLaunchMutex()
    : await acquireTmuxLaunchMutex();
  try {
    return await closeAndInspect();
  } finally {
    release();
  }
}

/** Best-effort interruption always remains fenced by the recorded handle. */
/**
 * Create a cleanup client that is deliberately independent of the active-run
 * pool lease. A kept run can outlive the pooled lease released by its normal
 * completion path, so cleanup reconnects from immutable V3 evidence instead
 * of closing over the mutable active backend.
 */
function makeDurableTmuxCleanupRelease(options: {
  backend: InteractivePaneBackend;
  backendPath: string;
  backendGeneration: NonNullable<ReturnType<typeof readExecutableGeneration>>;
  paths: RunArtifactPaths;
  runId: string;
  transportGateDigest: string;
  handle: Extract<InteractivePaneHandle, { mode: "tmux-pane" }>;
  expectedSourceWindowId: string;
}): () => Promise<boolean> {
  let released = false;
  let inFlight: Promise<boolean> | null = null;
  // Once a mutation is dispatched, a later retry only probes for exact
  // absence. Replaying an uncertain close through a new connection is unsafe;
  // a reaper may retry only after its independent durable claim.
  let mutationAttempted = false;
  return async () => {
    if (released) return true;
    if (inFlight) return await inFlight;
    inFlight = (async () => {
      let client: TmuxControlClient | null = null;
      try {
        const currentGate = parseTmuxControlTransportGate(await readBrokerJson(options.paths.transportGatePath), options.runId);
        if (!currentGate || !isTmuxControlTransportGateCurrent(currentGate)
          || await exactArtifactDigest(options.paths.transportGatePath) !== options.transportGateDigest
          || !sameExecutableGeneration(options.backendGeneration, readExecutableGeneration(options.backendPath))
          || !hasTmuxGeneration(options.handle.native)
          || !isTmuxGenerationCurrent(options.handle.native.generation, options.handle.native.serverPid)) return false;
        client = new TmuxControlClient({
          executable: options.backendPath,
          socketPath: currentGate.canonicalSocketPath,
          sessionId: currentGate.probeResult.attachedSessionId,
          commandTimeoutMs: 30_000,
        });
        await client.start();
        const run = createTmuxControlCommandRunner(client, currentGate.canonicalSocketPath) as TmuxCommandRunner;
        const [server, sourceProbe, topology, target] = await Promise.all([
          run(buildTmuxServerPidArgs(currentGate.canonicalSocketPath)),
          run(buildTmuxSourcePaneProbeArgs(currentGate.canonicalSocketPath)),
          readTmuxSourceTopology({ sourcePaneId: currentGate.probeResult.sourcePaneId, socketPath: currentGate.canonicalSocketPath, run }),
          inspectTmuxPaneFingerprint(options.handle.native, run),
        ]);
        const exactTarget = target?.exists === false || target?.exists === true && target.panePid === options.handle.native.panePid;
        if (server.exitCode !== 0 || parseTmuxServerPidOutput(server.stdout) !== currentGate.probeResult.serverPid
          || sourceProbe.exitCode !== 0 || parseTmuxSourcePaneProbe(sourceProbe.stdout, currentGate.probeResult.sourcePaneId) !== currentGate.probeResult.sourcePanePid
          || topology === null || topology.sessionId !== currentGate.probeResult.attachedSessionId || topology.windowId !== options.expectedSourceWindowId
          || !exactTarget || !isTmuxControlTransportGateCurrent(currentGate)
          || await exactArtifactDigest(options.paths.transportGatePath) !== options.transportGateDigest
          || !sameExecutableGeneration(options.backendGeneration, readExecutableGeneration(options.backendPath))
          || !isTmuxGenerationCurrent(options.handle.native.generation, options.handle.native.serverPid)) return false;
        if (target!.exists === false) { released = true; return true; }
        if (mutationAttempted) return false;
        const cleanupBackend = bindInteractiveBackend(options.backend, options.backendPath, options.backendGeneration, run);
        mutationAttempted = true;
        const closed = await closeInteractiveTarget(cleanupBackend, options.handle);
        released ||= closed;
        return closed;
      } catch {
        return false;
      } finally {
        client?.close();
        inFlight = null;
      }
    })();
    return await inFlight;
  };
}

/** Creates the sole release path for completion, cancellation, and shutdown. */
function makeInteractiveRelease(
  getBackend: () => InteractivePaneBackend,
  handle: InteractivePaneHandle,
  cmuxLease: CmuxLayoutLease | null,
  durableCleanup?: () => Promise<boolean>,
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
            close: async (allocation) => await closeInteractiveTarget(getBackend(), {
              mode: "cmux-pane",
              native: {
                workspaceId: allocation.target.workspaceId,
                surfaceId: allocation.target.surfaceId,
                paneId: allocation.target.paneId,
              },
              placement: { layout: allocation.layout, placement: allocation.placement },
            }),
          });
        } else if (!await (durableCleanup?.() ?? closeInteractiveTarget(getBackend(), handle))) {
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

async function awaitInteractiveBooleanBounded(operation: Promise<boolean>): Promise<boolean> {
  return await Promise.race([
    operation.catch(() => false),
    delay(INTERACTIVE_SHUTDOWN_RELEASE_WAIT_MS).then(() => false),
  ]);
}

type BoundedTerminalPublication<T> = { timedOut: false; value: T | null } | { timedOut: true; value: null };

/** Do not let one run's lease/FIFO/filesystem stall hold the session shutdown fence. */
async function awaitTerminalPublicationBounded<T>(publication: Promise<T>): Promise<BoundedTerminalPublication<T>> {
  const timedOut = Symbol("terminal-publication-timeout");
  const outcome = await Promise.race([
    publication.then((value) => value as T | typeof timedOut, () => null),
    delay(INTERACTIVE_TERMINAL_PUBLICATION_WAIT_MS).then(() => timedOut),
  ]);
  return outcome === timedOut ? { timedOut: true, value: null } : { timedOut: false, value: outcome as T | null };
}

/** A timed-out exact release remains registered until that exact queued work succeeds. */
function finalizeBoundedInteractiveRelease(runId: string, expectedRun: ActiveInteractiveRun, release: Promise<boolean>): void {
  void release.then(async (released) => {
    if (!released) return;
    let removed = false;
    await withInteractiveFenceMutex(() => {
      if (activeInteractiveRuns.get(runId) === expectedRun) {
        activeInteractiveRuns.delete(runId);
        cancelDetachedRetirementWatcher(runId);
        cancelCompletedHerdrRetirementWatcher(runId);
        removed = true;
      }
    });
    if (removed) notifyInteractiveRunChanges();
  }, () => undefined);
}

export async function shutdownActiveInteractiveRuns(): Promise<void> {
  // Fence before observing either registry. Any later durable commit is
  // rejected synchronously and its exact cleanup joins lateFenced... above.
  await beginInteractiveShutdownForSession();
  // A stalled terminal preparation remains owned by its active-run record and
  // continues in the background. Do not spend another full timeout on it in
  // this shutdown invocation; a later shutdown/recovery retry reuses its drain.
  const publicationAttempted = new Set<string>();
  for (let attempt = 0; attempt < INTERACTIVE_SHUTDOWN_DRAIN_ATTEMPTS; attempt += 1) {
    const runs = Array.from(activeInteractiveRuns.values()).filter((run) => (run.ownership === "managed" || run.ownership === "kept") && !publicationAttempted.has(run.runId));
    const lateReleases = Array.from(lateFencedInteractiveReleases);
    if (runs.length === 0 && lateReleases.length === 0) {
      await Promise.all([drainDetachedRetirementWatchers(), drainCompletedHerdrRetirementWatchers()]);
      return;
    }

    // Start every drain before waiting for any one of them. A stalled lease on
    // one run must not defer another run's FIFO/fence preparation by a second
    // full terminal-publication window.
    const leaseDrains = new Map<string, Promise<BoundedTerminalPublication<boolean>>>();
    for (const run of runs) {
      leaseDrains.set(run.runId, awaitTerminalPublicationBounded(Promise.resolve().then(async () => (await run.stopLeaseWriterAndDrain?.()) !== false)));
    }
    await Promise.all(runs.map(async (run) => {
      await awaitInteractiveCleanupBounded(interruptActiveInteractiveRunWithoutWinner({ runId: run.runId, expectedRun: run }));
    }));
    if (attempt === 0 && runs.length > 0) await delay(250);
    await Promise.all(runs.map(async (run) => {
      const drain = await leaseDrains.get(run.runId)!;
      // A still-in-flight lease write is terminal-preparation failure, never
      // permission to publish a parent winner or release its exact target.
      if (drain.timedOut || drain.value !== true) {
        if (run.paths || run.publishParentCompletion) publicationAttempted.add(run.runId);
        return;
      }
      // Legacy/pathless registrations have no terminal callback preparation;
      // retain their historical bounded exact-release retries.
      if (run.paths || run.publishParentCompletion) publicationAttempted.add(run.runId);
      const operation = run.publishParentCompletion
        ? run.publishParentCompletion("aborted", "parent-aborted")
        // Compatibility only: production registration supplies the private
        // callback above, while old test-only records have no live drain.
        : run.paths ? publishParentCompletion(run.paths, run.runId, "aborted", "parent-aborted", run.sessionIdentity) : Promise.resolve(null);
      const outcome = await awaitTerminalPublicationBounded(operation);
      // A timeout is deliberately fail-closed: the active registry retains the
      // exact target and the one shared preparation continues in background.
      if (outcome.timedOut) return;
      const publication = outcome.value;
      const release = (!run.paths || publication)
        ? releaseActiveInteractiveRunAfterWinner({ runId: run.runId, expectedRun: run, ...(publication ? { completion: publication.completion } : {}), force: true })
        : null;
      const released = release ? await awaitInteractiveBooleanBounded(release) : false;
      if (release && !released) finalizeBoundedInteractiveRelease(run.runId, run, release);
      // Retain malformed completion and unknown releases for later
      // drain/startup recovery. A valid pre-existing child/reaper winner is
      // replayed and released above, just like a parent winner.
      if (released && activeInteractiveRuns.get(run.runId) === run) {
        activeInteractiveRuns.delete(run.runId);
        notifyInteractiveRunChanges();
      }
    }));
    await Promise.all(lateReleases.map(awaitInteractiveCleanupBounded));
  }
  await Promise.all([drainDetachedRetirementWatchers(), drainCompletedHerdrRetirementWatchers()]);
}

const INTERNAL_REAPER_CONTEXT: unique symbol = Symbol("internal-reaper-context");

export interface ReaperDiagnostic {
  severity: "debug" | "warning" | "error";
  code: string;
  message: string;
  details?: unknown;
}

export function forkSourceReconciliationFailureDiagnostic(error: unknown, shutdown = false): ReaperDiagnostic {
  return {
    severity: "error",
    code: shutdown ? "fork-source-shutdown-reconciliation-failed" : "fork-source-reconciliation-failed",
    message: shutdown
      ? "Fork source ownership shutdown reconciliation failed. Durable records were retained."
      : "Fork source ownership reconciliation failed. Durable records were retained; run /subagents doctor.",
    details: { error: error instanceof Error ? error.message : String(error) },
  };
}

const GRAPH_ENTRY_CAP_DIAGNOSTIC = `reaper graph entry cap (${MAX_REAPER_GRAPH_ENTRIES}) exceeded; deferred all mutation`;

function graphEntryCapDiagnostic(): ReaperDiagnostic {
  return {
    severity: "debug",
    code: "graph-entry-cap",
    message: "Reaper graph entry cap exceeded; all mutation was deferred.",
    details: { limit: MAX_REAPER_GRAPH_ENTRIES },
  };
}

export interface ReapStaleInteractiveRunsResult {
  scanned: number;
  reaped: string[];
  skipped: string[];
  invalid: string[];
  diagnostics: ReaperDiagnostic[];
  /** @deprecated Use structured `diagnostics`; retained for direct consumers. */
  diagnostic?: string;
}

function recordGraphEntryCap(outcome: ReapStaleInteractiveRunsResult): void {
  outcome.diagnostic = GRAPH_ENTRY_CAP_DIAGNOSTIC;
  outcome.diagnostics.push(graphEntryCapDiagnostic());
}

export async function reapStaleInteractiveRuns(options: {
  rootDir?: string;
  now?: number;
  staleAfterMs?: number;
  diagnosticRetentionSeconds?: number;
  cmuxRun?: CmuxCommandRunner;
  tmuxRun?: TmuxCommandRunner;
  /** Test seam for a generation-fenced V3 control connection. */
  tmuxControlRunFactory?: (gate: NonNullable<ReturnType<typeof parseTmuxControlTransportGate>>, backendPath: string) => Promise<{ run: TmuxCommandRunner; close: () => void }>;
  scheduleCleanup?: (runDir: string, delaySeconds: number) => void;
  /** Test seam for sensitive artifact deletion fault handling. */
  removeSensitivePath?: (path: string) => Promise<void>;
  /** Test seam for whole promoted-run artifact removal fault handling. */
  removePromotedRunArtifacts?: (paths: RunArtifactPaths) => Promise<void>;
  /** Test seam for startup enumeration overflow handling. */
  enumerateRunDirectories?: typeof enumerateRunDirectories;
  /** Test seam for the immutable first-writer-wins decision publication. */
  publishImmutable?: typeof publishImmutableJson;
  /** Test seam; production uses OS-backed PID/start identity validation. */
  isProcessIdentityAlive?: ParentProcessIdentityChecker;
  /** Test seam; production proves the tuple against the live socket and server. */
  isTmuxGenerationCurrent?: (generation: TmuxGenerationV2, serverPid: number) => boolean;
  /** Test seam; production validates executable/socket/server gate identity. */
  isTmuxControlGateCurrent?: typeof isTmuxControlTransportGateCurrent;
  /** Test seam observing active side-effect-free artifact validation workers. */
  onValidationConcurrency?: (active: number) => void;
  /** Test seam for fork-source ownership reconciliation outcomes. */
  reconcileForkSources?: typeof reconcileForkSourceOwnershipRoot;
  /** Exact, non-mutating promoted-target inspection seam. */
  inspectPromotedTarget?: (runId: string, allocation: AllocationRecordV2 | AllocationRecordV3) => Promise<"absent" | "live" | "unknown">;
  signal?: AbortSignal;
  /** Test/benchmark seams; production defaults are 200ms and 50 entries. */
  startupBudgetMs?: number;
  startupEntryBudget?: number;
  [INTERNAL_REAPER_CONTEXT]?: { entries: string[]; rootLock: ReaperRootLock };
} = {}): Promise<ReapStaleInteractiveRunsResult> {
  const rootDir = path.resolve(options.rootDir ?? getRunStateRoot());
  const outcome: ReapStaleInteractiveRunsResult = { scanned: 0, reaped: [], skipped: [], invalid: [], diagnostics: [] };
  if (!await fileExists(rootDir)) return outcome;
  try {
    await assertSafeStateRoot(rootDir);
  } catch {
    throw new Error(`Refusing to reap an untrusted subagent state root: ${rootDir}`);
  }
  const internalContext = options[INTERNAL_REAPER_CONTEXT];
  const ownerStartedAt = getCurrentProcessStartedAt();
  if (ownerStartedAt === null) return outcome;
  const rootLock = internalContext?.rootLock ?? await acquireReaperRootLock(rootDir, `${process.pid}:${ownerStartedAt}`);
  if (!rootLock) return outcome;
  try {
  let entryNames = internalContext?.entries;
  if (entryNames && entryNames.length > MAX_REAPER_GRAPH_ENTRIES) {
    recordGraphEntryCap(outcome);
    return outcome;
  }
  if (!entryNames) {
    const enumeration = (options.enumerateRunDirectories ?? enumerateRunDirectories)(rootDir, { startupBudgetMs: options.startupBudgetMs ?? 200, startupEntryBudget: options.startupEntryBudget ?? 50 });
    const startupEntries = await enumeration.startup;
    const [remainingEntries, overflow] = await Promise.all([enumeration.completion, enumeration.overflow]);
    if (overflow) {
      recordGraphEntryCap(outcome);
      return outcome;
    }
    entryNames = [...startupEntries, ...remainingEntries];
  }
  // The reserved fork-source root has its own descriptor-bound recovery
  // protocol. It is not a run directory and must never be quarantined as one.
  const entries = entryNames.filter((name) => name !== FORK_SOURCE_ROOT_NAME).map((name) => ({ name, isDirectory: () => true }));
  if (options.signal?.aborted) return outcome;
  const now = options.now ?? Date.now();
  const reaperNow = (): number => options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_PARENT_LEASE_STALE_MS;

  const cleanupInvalidRun = async (entryName: string, paths: RunArtifactPaths): Promise<void> => {
    let lease = null;
    try {
      lease = parseParentLease(await readBoundedPrivateJson(paths.parentLeasePath), entryName, reaperNow());
    } catch {
      lease = null;
    }
    if (isUsableParentLease({ lease, now: reaperNow(), staleAfterMs, isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive })) {
      outcome.skipped.push(entryName);
      return;
    }
    if (!lease || cleanupOwnerStatus(lease.parentPid, lease.parentStartedAt) !== "dead") {
      outcome.skipped.push(entryName);
      return;
    }
    const cleanupOwners = [{ pid: lease.parentPid, startedAt: lease.parentStartedAt }];
    const stateArtifactExists = await fileExists(paths.statePath);
    const state = parseRunState(await readBoundedPrivateJson(paths.statePath), entryName);
    if (stateArtifactExists && !state) { outcome.skipped.push(entryName); return; }
    if (state?.childPid !== undefined && state.childStartedAt !== undefined) cleanupOwners.push({ pid: state.childPid, startedAt: state.childStartedAt });
    const cleanupClaim = await acquireCleanupClaimFor(paths, entryName, cleanupOwners);
    if (!cleanupClaim) { outcome.skipped.push(entryName); return; }
    try {
      const freshLease = parseParentLease(await readBoundedPrivateJson(paths.parentLeasePath), entryName, reaperNow());
      const stat = await fs.promises.lstat(paths.runDir).catch(() => null);
      if (options.signal?.aborted || !await cleanupClaim.assertCurrent() || !freshLease
        || freshLease.parentPid !== lease.parentPid || freshLease.parentStartedAt !== lease.parentStartedAt
        || cleanupOwnerStatus(freshLease.parentPid, freshLease.parentStartedAt) !== "dead"
        || isUsableParentLease({ lease: freshLease, now: reaperNow(), staleAfterMs, isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive })
        || !stat || reaperNow() - stat.mtimeMs < staleAfterMs) {
        outcome.skipped.push(entryName);
        return;
      }
      await assertSafeRunArtifactPaths(paths);
      outcome.invalid.push(entryName);
      await fs.promises.rm(paths.runDir, { recursive: true, force: true });
    } catch {
      outcome.invalid.push(entryName);
    } finally {
      await cleanupClaim.release();
    }
  };

  const isBrokerAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const cleanupOwnerStatus = (pid: number, startedAt: number): ProcessIdentityStatus => {
    if (options.isProcessIdentityAlive) return options.isProcessIdentityAlive(pid, startedAt) ? "live" : "dead";
    if (options.now !== undefined) return "dead";
    return classifyParentProcessIdentity(pid, startedAt);
  };
  const acquireCleanupClaimFor = async (paths: RunArtifactPaths, runId: string, owners: Array<{ pid: number; startedAt: number }>): Promise<ReaperCleanupClaim | null> => {
    if (options.signal?.aborted) return null;
    return await acquireRunCleanupClaim({ runDir: paths.runDir, runId, rootLock, expectedOwners: owners, now: reaperNow(), classifyOwner: cleanupOwnerStatus });
  };
  const cleanupV2Allocation = async (allocation: NonNullable<ReturnType<typeof parseAllocationRecordV2>>, run: BackendCommandRunner, authorizeMutation: () => Promise<boolean>): Promise<boolean> => {
    if (allocation.terminalMode === "cmux-pane") {
      const handle = { workspaceId: allocation.target.workspaceId, surfaceId: allocation.target.surfaceId };
      if (options.signal?.aborted || !await authorizeMutation()) return false;
      await interruptCmuxSurface(handle, run).catch(() => false);
      if (options.signal?.aborted || !await authorizeMutation()) return false;
      await closeCmuxSurface(handle, run).catch(() => false);
      const snapshot = await inspectCmuxSurface(handle, run).catch(() => undefined);
      return snapshot !== undefined && !snapshot.exists;
    }
    if (allocation.terminalMode === "herdr-pane") {
      if (!hasHerdrSocketGeneration(allocation.target)) return false;
      const handle: HerdrPaneHandle = { ...allocation.target, socketDev: allocation.target.generation.socketDev, socketIno: allocation.target.generation.socketIno,
        ...("layout" in allocation && allocation.placement === "herdr-new-tab" && allocation.container.kind === "herdr-tab"
          ? { allocatedTabId: allocation.container.tabId } : {}),
      };
      // New-tab reaping is intentionally read-only: only confirmed absence
      // retires artifacts. Present and unknown targets remain manual recovery.
      if ("layout" in allocation && allocation.placement === "herdr-new-tab") return (await inspectHerdrPane(handle).catch(() => undefined))?.exists === false;
      if (options.signal?.aborted || !await authorizeMutation()) return false;
      await interruptHerdrPane(handle).catch(() => false);
      if (options.signal?.aborted || !await authorizeMutation()) return false;
      await closeHerdrPane(handle).catch(() => false);
      return (await inspectHerdrPane(handle).catch(() => undefined))?.exists === false;
    }
    const generationIsCurrent = options.isTmuxGenerationCurrent ?? isTmuxGenerationCurrent;
    if (!hasTmuxGeneration(allocation.target)
      || !generationIsCurrent(allocation.target.generation, allocation.target.serverPid)) return false;
    // The reaper's injected checker is the test equivalent of the live tuple
    // proof. Keep it immediately around every lifecycle operation; do not let
    // a legacy low-level handle bypass the durable authority check.
    const handle = { paneId: allocation.target.paneId, socketPath: allocation.target.socketPath, serverPid: allocation.target.serverPid, panePid: allocation.target.panePid };
    const initial = await inspectTmuxPaneFingerprint(handle, run).catch(() => undefined);
    if (!initial?.exists) return initial !== undefined;
    if (!generationIsCurrent(allocation.target.generation, allocation.target.serverPid)) return false;
    if (options.signal?.aborted || !await authorizeMutation()) return false;
    await interruptTmuxPane(handle, run).catch(() => false);
    if (options.signal?.aborted || !await authorizeMutation() || !generationIsCurrent(allocation.target.generation, allocation.target.serverPid)) return false;
    await closeTmuxPane(handle, run).catch(() => false);
    if (!generationIsCurrent(allocation.target.generation, allocation.target.serverPid)) return false;
    const snapshot = await inspectTmuxPaneFingerprint(handle, run).catch(() => undefined);
    return snapshot !== undefined && !snapshot.exists;
  };
  type V1Candidate = { paths: RunArtifactPaths; launch: NonNullable<ReturnType<typeof parseLaunchRecord>> };
  type V2Candidate = { paths: RunArtifactPaths; intent: NonNullable<ReturnType<typeof parseLaunchIntentV2>> | LaunchIntentV3; completion: CompletionRecord | null; brokerClaim: NonNullable<ReturnType<typeof parseBrokerClaimV2>> | BrokerClaimV3 | null };
  type DeferredInvalid = { runId: string; paths: RunArtifactPaths; kind: "v1-incomplete" | "malformed"; parentRunId?: string };
  type ReaperClassification = {
    outcome: { scanned: number; invalid: string[]; skipped?: string[] };
    candidate?: V1Candidate;
    v2Candidate?: V2Candidate;
    promoted?: { runId: string; paths: RunArtifactPaths; allocation: AllocationRecordV2 | AllocationRecordV3 };
    deferredInvalid?: DeferredInvalid;
  };
  const candidates: V1Candidate[] = [];
  const v2Candidates: V2Candidate[] = [];
  const promotedCandidates: Array<{ runId: string; paths: RunArtifactPaths; allocation: AllocationRecordV2 | AllocationRecordV3 }> = [];
  const retentionSeconds = options.diagnosticRetentionSeconds ?? 60 * 60;
  const scheduleRetentionCleanup = (runDir: string, retainedAt: number): void => {
    const deadline = retainedAt + Math.max(0, retentionSeconds) * 1000;
    // Test callbacks retain their existing delay-based contract, but receive
    // the remaining (not freshly reset) duration after startup/restart.
    const remainingSeconds = Math.max(0, (deadline - reaperNow()) / 1000);
    if (options.scheduleCleanup) options.scheduleCleanup(runDir, remainingSeconds);
    else scheduleRunArtifactCleanup(runDir, remainingSeconds, deadline);
  };
  // V1 tmux fingerprints can still fence a pane mutation. V1 cmux has no
  // equivalent immutable source authority and is quarantined below.
  const legacyTmuxRun = options.tmuxRun ?? (() => {
    const executable = resolveBackendExecutable("tmux-pane");
    return executable ? createBackendCommandRunner("tmux-pane", executable) : null;
  })();
  const v2ArtifactPaths = (paths: RunArtifactPaths) => [
    paths.launchIntentPath, paths.allocationPath, paths.decisionPath, paths.launchPath,
    paths.launchGatePath, paths.brokerClaimPath, paths.residualRiskPath, paths.completionPath, paths.brokerStatusPath,
    paths.launchDeliveryUnknownPath,
  ];
  const removeSensitiveArtifacts = async (paths: RunArtifactPaths, preserveChildSession = false): Promise<boolean> =>
    await removeSelectedSensitiveArtifacts(paths, options.removeSensitivePath, preserveChildSession);
  const deferredInvalid: DeferredInvalid[] = [];
  const quarantineV2 = async (runId: string, paths: RunArtifactPaths): Promise<void> => {
    if (options.signal?.aborted) return;
    // Retain a V3 success transcript whenever malformed surrounding recovery
    // authority prevents exact cleanup; its boundary must remain re-verifiable.
    const rawCompletion = await readBrokerArtifact(paths.completionPath);
    const completion = parseCompletionAuthority(rawCompletion.outcome === "valid" ? rawCompletion.value : null, runId);
    // A parsed V2/V3 completion is immutable terminal authority in its own
    // right. Its transcript is recovery evidence even when the V3 record has
    // no digest boundary, so only scrub the other selected secrets.
    const preserveCompletionSession = completion !== null;
    // Retain recovery authority if any selected secret cannot be removed.
    // Either way this run is never scheduled as ordinary retention.
    await removeSensitiveArtifacts(paths, preserveCompletionSession);
    outcome.invalid.push(runId);
    outcome.skipped.push(runId);
  };
  // Classification is deliberately limited to artifact reads, parsing, and
  // validation. It must finish for every entry before cleanup can mutate a
  // target, remove sensitive data, or publish recovery authority.
  let validationActive = 0;
  const classifyEntry = async (entry: { name: string; isDirectory: () => boolean }): Promise<ReaperClassification> => {
    validationActive += 1;
    options.onValidationConcurrency?.(validationActive);
    try {
      if (!entry.isDirectory()) return { outcome: { scanned: 0, invalid: [] } };
      const classification: ReaperClassification = { outcome: { scanned: 1, invalid: [] } };
      let paths: RunArtifactPaths;
      try {
        paths = resolveRunArtifactPaths(entry.name, rootDir);
        await assertSafeRunArtifactPaths(paths);
      } catch {
        classification.outcome.invalid.push(entry.name);
        return classification;
      }

      // Read every V2 pathname first. The V2-exclusive names fix the namespace
      // by presence, not by their JSON version or semantic validity.
      const v2Artifacts = await Promise.all(v2ArtifactPaths(paths).map(readBrokerArtifact));
      // Either ownership namespace is a cleanup boundary. Never proceed to
      // target mutation when either marker is malformed, conflicting, or
      // otherwise not provably detached.
      const [detachedArtifact, legacyOwnershipArtifact, transferRequestArtifact, transferAckArtifact] = await Promise.all([
        readBrokerArtifact(paths.detachedOwnershipPath),
        readBrokerArtifact(paths.userOwnershipPath),
        readBrokerArtifact(paths.promotionRequestPath),
        readBrokerArtifact(paths.promotionAckPath),
      ]);
      if (detachedArtifact.outcome !== "missing" || legacyOwnershipArtifact.outcome !== "missing"
        || transferRequestArtifact.outcome !== "missing" || transferAckArtifact.outcome !== "missing") {
        const detached = detachedArtifact.outcome === "valid" ? parseDetachedOwnershipRecord(detachedArtifact.value, entry.name) : null;
        const legacy = legacyOwnershipArtifact.outcome === "valid" ? parseUserOwnershipRecord(legacyOwnershipArtifact.value, entry.name) : null;
        const request = transferRequestArtifact.outcome === "valid" ? parseOwnershipTransferRequest(transferRequestArtifact.value, entry.name) : null;
        const ack = transferAckArtifact.outcome === "valid" ? parseOwnershipTransferAck(transferAckArtifact.value, entry.name) : null;
        const allocationArtifact = v2Artifacts[1];
        const promotedRawAllocation = allocationArtifact?.outcome === "valid" ? allocationArtifact.value : null;
        const promotedAllocation = promotedRawAllocation
          ? (promotedRawAllocation.version === 3 ? parseAllocationRecordV3(promotedRawAllocation, entry.name) : parseAllocationRecordV2(promotedRawAllocation, entry.name)) : null;
        const allocationDigest = promotedAllocation
          ? crypto.createHash("sha256").update(JSON.stringify(promotedRawAllocation)).digest("hex") : null;
        const transferPresent = transferRequestArtifact.outcome !== "missing" || transferAckArtifact.outcome !== "missing";
        // Completion and promotion are mutually exclusive terminal authority.
        // Do not mistake a complete request/ack/marker transcript for a user
        // promotion if any completion pathname also exists.
        if (transferPresent && v2Artifacts[7]!.outcome !== "missing") {
          classification.outcome.invalid.push(entry.name);
          classification.outcome.skipped = [entry.name];
          return classification;
        }
        const validDetached = detached !== null && detached.allocation.digest === allocationDigest;
        const validLegacy = legacy !== null && legacy.allocationDigest === allocationDigest;
        // New transfer artifacts are an all-or-nothing chain. A partial,
        // malformed, conflicting, or final-marker-less handoff retains the
        // target; only marker-only historical promotions remain compatible.
        const promoted = transferPresent
          ? request !== null && ack !== null && sameOwnershipTransfer(request, ack) && validDetached
            && request.allocation.digest === allocationDigest
            && (legacyOwnershipArtifact.outcome === "missing" || validLegacy && legacy!.allocationDigest === request.allocation.digest)
          : (detachedArtifact.outcome !== "missing" && legacyOwnershipArtifact.outcome !== "missing"
            ? validDetached && validLegacy && detached!.allocation.digest === legacy!.allocationDigest
            : validDetached || validLegacy);
        if (promoted && promotedAllocation) classification.promoted = { runId: entry.name, paths, allocation: promotedAllocation };
        else if (promoted) classification.outcome.invalid.push(entry.name);
        else classification.outcome.invalid.push(entry.name);
        classification.outcome.skipped = [entry.name];
        return classification;
      }
      const hasV2Path = [v2Artifacts[0], v2Artifacts[1], v2Artifacts[2], v2Artifacts[4], v2Artifacts[5], v2Artifacts[6], v2Artifacts[8], v2Artifacts[9]]
        .some((artifact) => artifact?.outcome !== "missing")
        || v2Artifacts.some((artifact) => artifact.outcome === "valid" && artifact.value.version === BROKER_PROTOCOL_VERSION);
      if (hasV2Path) {
        const [intentArtifact, allocationArtifact, decisionArtifact, launchArtifact, gateArtifact, claimArtifact, riskArtifact, completionArtifact, statusArtifact, deliveryUnknownArtifact] = v2Artifacts;
        const rawIntent = intentArtifact?.outcome === "valid" ? intentArtifact.value : null;
        const controlV3 = rawIntent?.version === 3;
        const intent = controlV3 ? parseLaunchIntentV3(rawIntent, entry.name, paths.runDir, { allowLegacyTmuxWindowLabel: true }) : parseLaunchIntentV2(rawIntent, entry.name, paths.runDir, { allowLegacyTmuxWindowLabel: true });
        if (v2Artifacts.some((artifact) => artifact.outcome === "invalid")) {
          classification.deferredInvalid = { runId: entry.name, paths, kind: "malformed", ...(intent?.parentRunId ? { parentRunId: intent.parentRunId } : {}) };
          return classification;
        }
        const allocation = controlV3
          ? parseAllocationRecordV3(allocationArtifact?.outcome === "valid" ? allocationArtifact.value : null, entry.name)
          : parseAllocationRecordV2(allocationArtifact?.outcome === "valid" ? allocationArtifact.value : null, entry.name);
        const decision = controlV3
          ? parseDecisionV3(decisionArtifact?.outcome === "valid" ? decisionArtifact.value : null, entry.name, paths.runDir)
          : parseDecisionV2(decisionArtifact?.outcome === "valid" ? decisionArtifact.value : null, entry.name, paths.runDir);
        const launch = controlV3
          ? parseCommittedLaunchRecordV3(launchArtifact?.outcome === "valid" ? launchArtifact.value : null, entry.name, paths.runDir)
          : parseCommittedLaunchRecordV2(launchArtifact?.outcome === "valid" ? launchArtifact.value : null, entry.name, paths.runDir);
        const gate = controlV3
          ? parseLaunchGateV3(gateArtifact?.outcome === "valid" ? gateArtifact.value : null, entry.name, paths.runDir)
          : parseLaunchGateV2(gateArtifact?.outcome === "valid" ? gateArtifact.value : null, entry.name, paths.runDir);
        const claim = controlV3
          ? parseBrokerClaimV3(claimArtifact?.outcome === "valid" ? claimArtifact.value : null, entry.name)
          : parseBrokerClaimV2(claimArtifact?.outcome === "valid" ? claimArtifact.value : null, entry.name);
        const risk = controlV3
          ? parseResidualRiskV3(riskArtifact?.outcome === "valid" ? riskArtifact.value : null, entry.name)
          : parseResidualRiskV2(riskArtifact?.outcome === "valid" ? riskArtifact.value : null, entry.name);
        const completion = parseCompletionAuthority(completionArtifact?.outcome === "valid" ? completionArtifact.value : null, entry.name);
        const status = controlV3
          ? parseBrokerStatusV3(statusArtifact?.outcome === "valid" ? statusArtifact.value : null, entry.name)
          : parseBrokerStatusV2(statusArtifact?.outcome === "valid" ? statusArtifact.value : null, entry.name);
        const deliveryUnknown = controlV3 ? null : parseLaunchDeliveryUnknownV2(deliveryUnknownArtifact?.outcome === "valid" ? deliveryUnknownArtifact.value : null, entry.name, paths.runDir);
        const artifactValues: Array<{ artifact: Awaited<ReturnType<typeof readBrokerArtifact>> | undefined; value: unknown }> = [
          { artifact: intentArtifact, value: intent }, { artifact: allocationArtifact, value: allocation },
          { artifact: decisionArtifact, value: decision }, { artifact: launchArtifact, value: launch },
          { artifact: gateArtifact, value: gate }, { artifact: claimArtifact, value: claim }, { artifact: riskArtifact, value: risk }, { artifact: completionArtifact, value: completion },
          { artifact: statusArtifact, value: status }, { artifact: deliveryUnknownArtifact, value: deliveryUnknown },
        ];
        const presentButInvalid = artifactValues.some(({ artifact, value }) => artifact?.outcome === "valid" && !value);
        const validChain = !controlV3 || intent?.version === 3
          && await hasValidTmuxControlChain({ runDir: paths.runDir, intent, allocation: allocation?.version === 3 ? allocation : null, launch: launch?.version === 3 ? launch : null, allowLegacyTmuxWindowLabel: true });
        const inconsistent = !intent
          || (allocation !== null && !hasAllocationIntentSourceBinding(intent as any, allocation as any))
          || (allocation !== null && allocation.terminalMode !== intent.terminalMode)
          || (launch !== null && (launch.terminalMode !== intent.terminalMode || launch.childSessionFile !== intent.childSessionFile))
          || (gate !== null && gate.terminalMode !== intent.terminalMode)
          || !hasValidV2StateDependencies({ allocation: allocation as any, decision: decision as any, launch: launch as any, gate: gate as any })
          || !validChain
          || (claim !== null && claim.brokerNonce !== intent.brokerNonce)
          || (deliveryUnknown !== null && (!allocation || allocation.terminalMode !== "herdr-pane" || deliveryUnknown.allocationPath !== paths.allocationPath));
        if (presentButInvalid || inconsistent || resolveBackendPath(intent.terminalMode, intent.backendPath) !== intent.backendPath) {
          classification.deferredInvalid = { runId: entry.name, paths, kind: "malformed", ...(intent?.parentRunId ? { parentRunId: intent.parentRunId } : {}) };
          return classification;
        }
        classification.v2Candidate = { paths, intent, completion, brokerClaim: claim };
        return classification;
      }

      // Only a V2-free namespace may be treated as a V1 launch record.
      const launchPathExists = await fileExists(paths.launchPath);
      const launchValue = await readBoundedPrivateJson(paths.launchPath);
      const launch = parseLaunchRecord(launchValue, entry.name);
      if (!launch || path.dirname(launch.childSessionFile) !== paths.runDir) {
        classification.deferredInvalid = { runId: entry.name, paths, kind: launchPathExists ? "malformed" : "v1-incomplete" };
        return classification;
      }
      classification.candidate = { paths, launch };
      return classification;
    } finally {
      validationActive -= 1;
      options.onValidationConcurrency?.(validationActive);
    }
  };
  const classifications = await mapConcurrent(entries, INTERACTIVE_REAPER_VALIDATION_CONCURRENCY, classifyEntry, { signal: options.signal });
  // mapConcurrent retains input order. Merge all classification products in
  // that order so graph construction and public outcomes remain deterministic.
  for (const classification of classifications) {
    if (!classification) continue;
    outcome.scanned += classification.outcome.scanned;
    outcome.invalid.push(...classification.outcome.invalid);
    outcome.skipped.push(...(classification.outcome.skipped ?? []));
    if (classification.candidate) candidates.push(classification.candidate);
    if (classification.v2Candidate) v2Candidates.push(classification.v2Candidate);
    if (classification.promoted) promotedCandidates.push(classification.promoted);
    if (classification.deferredInvalid) deferredInvalid.push(classification.deferredInvalid);
  }
  // An abort may leave a stable prefix of classifications, but never permits
  // graph planning or any cleanup mutation. The root lock releases in finally.
  if (options.signal?.aborted) return outcome;

  // No cleanup or target mutation occurs until every directory has been
  // classified and one unified dependency graph has been validated.
  const graphNodes = [
    ...v2Candidates.map(({ intent }) => ({ runId: intent.runId, ...(intent.parentRunId ? { parentRunId: intent.parentRunId } : {}) })),
    ...candidates.map(({ launch }) => ({ runId: launch.runId, ...(launch.parentRunId ? { parentRunId: launch.parentRunId } : {}) })),
    ...deferredInvalid.map(({ runId, parentRunId }) => ({ runId, parentRunId })),
  ];
  const graphPlan = planUnifiedReaperGraph(graphNodes);
  if (graphPlan.overflow) {
    recordGraphEntryCap(outcome);
    return outcome;
  }
  for (const invalid of deferredInvalid) if (invalid.kind === "malformed") graphPlan.unresolved.add(invalid.runId);
  // The legacy cleanup implementations remain protocol-specific. Retain a
  // mixed-version dependency component rather than violate the unified order.
  const protocolKind = new Map<string, "v1" | "v2">([
    ...v2Candidates.map(({ intent }) => [intent.runId, "v2"] as const),
    ...candidates.map(({ launch }) => [launch.runId, "v1"] as const),
  ]);
  const graphChildren = new Map<string, string[]>();
  const graphParent = new Map<string, string>();
  const graphIds = new Set(graphNodes.map((node) => node.runId));
  for (const node of graphNodes) {
    if (node.parentRunId) {
      if (graphIds.has(node.parentRunId)) graphParent.set(node.runId, node.parentRunId);
      const children = graphChildren.get(node.parentRunId) ?? [];
      children.push(node.runId); graphChildren.set(node.parentRunId, children);
      if (protocolKind.has(node.parentRunId) && protocolKind.get(node.runId) !== protocolKind.get(node.parentRunId)) {
        graphPlan.unresolved.add(node.runId); graphPlan.unresolved.add(node.parentRunId);
      }
    }
  }
  const unresolvedQueue = [...graphPlan.unresolved];
  for (let index = 0; index < unresolvedQueue.length; index += 1) {
    const runId = unresolvedQueue[index]!;
    const parent = graphParent.get(runId);
    if (parent && !graphPlan.unresolved.has(parent)) { graphPlan.unresolved.add(parent); unresolvedQueue.push(parent); }
    for (const child of graphChildren.get(runId) ?? []) {
      if (!graphPlan.unresolved.has(child)) { graphPlan.unresolved.add(child); unresolvedQueue.push(child); }
    }
  }
  const graphRank = new Map(graphPlan.descendantsFirst.filter((runId) => !graphPlan.unresolved.has(runId)).map((runId, index) => [runId, index]));
  const skippedIds = new Set(outcome.skipped);
  for (const runId of graphPlan.unresolved) {
    if (!skippedIds.has(runId)) { skippedIds.add(runId); outcome.skipped.push(runId); }
  }
  // Promoted targets are never mutated. A restart may retire their directory
  // only after an exact, side-effect-free target absence proof; live/unknown
  // observations retain recovery/session state and scrub secrets only.
  const inspectPromotedTarget = async (promoted: { runId: string; paths: RunArtifactPaths; allocation: AllocationRecordV2 | AllocationRecordV3 }): Promise<"absent" | "live" | "unknown"> => {
    if (options.inspectPromotedTarget) return await options.inspectPromotedTarget(promoted.runId, promoted.allocation).catch(() => "unknown");
    try {
      if (promoted.allocation.terminalMode === "cmux-pane") {
        const control = (promoted.allocation as { control?: import("./run-protocol.js").CmuxControlTransportV2 }).control;
        if (!control) return "unknown";
        const snapshot = await inspectCmuxSurface({ workspaceId: promoted.allocation.target.workspaceId, surfaceId: promoted.allocation.target.surfaceId },
          options.cmuxRun ?? createCmuxControlCommandRunner({ env: process.env, expectedControl: control }));
        return snapshot === undefined ? "unknown" : snapshot.exists ? "live" : "absent";
      }
      if (promoted.allocation.terminalMode === "herdr-pane") {
        if (!hasHerdrSocketGeneration(promoted.allocation.target)) return "unknown";
        const snapshot = await inspectHerdrPane({ ...promoted.allocation.target, socketDev: promoted.allocation.target.generation.socketDev, socketIno: promoted.allocation.target.generation.socketIno }).catch(() => undefined);
        return snapshot === undefined ? "unknown" : snapshot.exists ? "live" : "absent";
      }
      const target = promoted.allocation.target;
      if (!hasTmuxGeneration(target) || !(options.isTmuxGenerationCurrent ?? isTmuxGenerationCurrent)(target.generation, target.serverPid)) return "unknown";
      const executable = resolveBackendExecutable("tmux-pane");
      if (!executable) return "unknown";
      const snapshot = await inspectTmuxPaneFingerprint({ paneId: target.paneId, panePid: target.panePid, socketPath: target.socketPath, serverPid: target.serverPid }, options.tmuxRun ?? createBackendCommandRunner("tmux-pane", executable));
      return snapshot === undefined ? "unknown" : snapshot.exists ? "live" : "absent";
    } catch { return "unknown"; }
  };
  for (const promoted of promotedCandidates) {
    const targetState = await inspectPromotedTarget(promoted);
    if (targetState === "absent") {
      let removed = false;
      try {
        await (options.removePromotedRunArtifacts ?? removeRunArtifacts)(promoted.paths);
        removed = !await fileExists(promoted.paths.runDir);
      } catch { /* retain the candidate for a future reaper pass */ }
      if (removed) outcome.reaped.push(promoted.runId);
      else {
        if (!outcome.invalid.includes(promoted.runId)) outcome.invalid.push(promoted.runId);
        if (!outcome.skipped.includes(promoted.runId)) outcome.skipped.push(promoted.runId);
      }
      continue;
    }
    // A live/unknown target is user-owned recovery state regardless of a
    // stale child PID marker: scrub secrets only, never its session directory.
    if (!await removeSensitiveArtifacts(promoted.paths, true)) outcome.invalid.push(promoted.runId);
    outcome.skipped.push(promoted.runId);
  }

  // Malformed authority remains intact. Only an authority-free incomplete run
  // may enter stale directory cleanup after the full graph is known.
  for (const invalid of deferredInvalid) {
    if (options.signal?.aborted) return outcome;
    if (invalid.kind === "malformed") { outcome.invalid.push(invalid.runId); continue; }
    await cleanupInvalidRun(invalid.runId, invalid.paths);
  }
  v2Candidates.splice(0, v2Candidates.length, ...v2Candidates.filter(({ intent }) => graphRank.has(intent.runId)).sort((left, right) => graphRank.get(left.intent.runId)! - graphRank.get(right.intent.runId)!));
  for (const candidate of v2Candidates) {
    if (options.signal?.aborted) return outcome;
    const { paths, intent, completion, brokerClaim } = candidate;
    let lease = null;
    try { lease = parseParentLease(await readBoundedPrivateJson(paths.parentLeasePath), intent.runId, reaperNow()); } catch { /* stale/unreadable */ }
    if (isUsableParentLease({
      lease, now: reaperNow(), staleAfterMs, parentPid: intent.parentPid, parentStartedAt: intent.parentStartedAt,
      isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive,
    })) { outcome.skipped.push(intent.runId); continue; }
    const cleanupOwners = [{ pid: intent.parentPid, startedAt: intent.parentStartedAt }];
    const observedChildState = parseRunState(await readBoundedPrivateJson(paths.statePath), intent.runId);
    if (observedChildState?.childPid !== undefined && observedChildState.childStartedAt !== undefined && !cleanupOwners.some((owner) => owner.pid === observedChildState.childPid && owner.startedAt === observedChildState.childStartedAt)) cleanupOwners.push({ pid: observedChildState.childPid, startedAt: observedChildState.childStartedAt });
    if (brokerClaim?.brokerStartedAt !== undefined && !cleanupOwners.some((owner) => owner.pid === brokerClaim.pid && owner.startedAt === brokerClaim.brokerStartedAt)) cleanupOwners.push({ pid: brokerClaim.pid, startedAt: brokerClaim.brokerStartedAt });
    const cleanupClaim = await acquireCleanupClaimFor(paths, intent.runId, cleanupOwners);
    if (!cleanupClaim) { outcome.skipped.push(intent.runId); continue; }
    try {
    try { await assertSafeRunArtifactPaths(paths); } catch { outcome.invalid.push(intent.runId); continue; }
    const controlV3 = intent.version === 3;
    let [allocationArtifact, decisionArtifact, riskArtifact, statusArtifact, deliveryUnknownArtifact] = await Promise.all([
      readBrokerArtifact(paths.allocationPath), readBrokerArtifact(paths.decisionPath), readBrokerArtifact(paths.residualRiskPath), readBrokerArtifact(paths.brokerStatusPath), readBrokerArtifact(paths.launchDeliveryUnknownPath),
    ]);
    let allocation: AllocationRecordV2 | AllocationRecordV3 | null = controlV3
      ? parseAllocationRecordV3(allocationArtifact.outcome === "valid" ? allocationArtifact.value : null, intent.runId)
      : parseAllocationRecordV2(allocationArtifact.outcome === "valid" ? allocationArtifact.value : null, intent.runId);
    let decision: ReturnType<typeof parseDecisionV2> | DecisionV3 = controlV3
      ? parseDecisionV3(decisionArtifact.outcome === "valid" ? decisionArtifact.value : null, intent.runId, paths.runDir)
      : parseDecisionV2(decisionArtifact.outcome === "valid" ? decisionArtifact.value : null, intent.runId, paths.runDir);
    let risk = controlV3
      ? parseResidualRiskV3(riskArtifact.outcome === "valid" ? riskArtifact.value : null, intent.runId)
      : parseResidualRiskV2(riskArtifact.outcome === "valid" ? riskArtifact.value : null, intent.runId);
    let status = controlV3
      ? parseBrokerStatusV3(statusArtifact.outcome === "valid" ? statusArtifact.value : null, intent.runId)
      : parseBrokerStatusV2(statusArtifact.outcome === "valid" ? statusArtifact.value : null, intent.runId);
    let deliveryUnknown = controlV3 ? null : parseLaunchDeliveryUnknownV2(deliveryUnknownArtifact.outcome === "valid" ? deliveryUnknownArtifact.value : null, intent.runId, paths.runDir);
    const authorityIsInvalid = () => (allocationArtifact.outcome === "valid" && !allocation)
      || (decisionArtifact.outcome === "valid" && !decision)
      || (riskArtifact.outcome === "valid" && !risk)
      || (statusArtifact.outcome === "valid" && !status)
      || (deliveryUnknownArtifact.outcome === "valid" && !deliveryUnknown)
      || (deliveryUnknown !== null && (!allocation || allocation.terminalMode !== "herdr-pane" || deliveryUnknown.allocationPath !== paths.allocationPath));
    if (authorityIsInvalid()) {
      await quarantineV2(intent.runId, paths);
      continue;
    }
    if (status?.writer === "broker" && status.phase === "ready" && brokerClaim?.brokerStartedAt === undefined) {
      outcome.skipped.push(intent.runId);
      continue;
    }
    let launch: ReturnType<typeof parseCommittedLaunchRecordV2> | CommittedLaunchRecordV3 = controlV3
      ? parseCommittedLaunchRecordV3(await readBrokerJson(paths.launchPath), intent.runId, paths.runDir)
      : parseCommittedLaunchRecordV2(await readBrokerJson(paths.launchPath), intent.runId, paths.runDir);
    let gate: ReturnType<typeof parseLaunchGateV2> | LaunchGateV3 = controlV3
      ? parseLaunchGateV3(await readBrokerJson(paths.launchGatePath), intent.runId, paths.runDir)
      : parseLaunchGateV2(await readBrokerJson(paths.launchGatePath), intent.runId, paths.runDir);
    if ((allocation !== null && !hasAllocationIntentSourceBinding(intent as any, allocation as any))
      || !hasValidV2StateDependencies({ allocation: allocation as any, decision: decision as any, launch: launch as any, gate: gate as any })
      || controlV3 && !(intent.version === 3 && await hasValidTmuxControlChain({ runDir: paths.runDir, intent, allocation: allocation?.version === 3 ? allocation : null, launch: launch?.version === 3 ? launch : null, allowLegacyTmuxWindowLabel: true }))) {
      await quarantineV2(intent.runId, paths);
      continue;
    }
    // A residual unrecorded-allocation claim is stronger than any recorded
    // target absence. Never act on the recorded target in this state.
    if (risk && allocation) {
      await quarantineV2(intent.runId, paths);
      continue;
    }
    const authorityIsStillQuiescent = async (): Promise<boolean> => {
      if (options.signal?.aborted || !await cleanupClaim.assertCurrent() || cleanupOwnerStatus(intent.parentPid, intent.parentStartedAt) !== "dead"
        || (brokerClaim?.brokerStartedAt !== undefined && cleanupOwnerStatus(brokerClaim.pid, brokerClaim.brokerStartedAt) !== "dead")) return false;
      try { await assertSafeRunArtifactPaths(paths); } catch { return false; }
      const checkedAt = reaperNow();
      const freshLease = parseParentLease(await readBoundedPrivateJson(paths.parentLeasePath), intent.runId, checkedAt);
      if (isUsableParentLease({
        lease: freshLease, now: checkedAt, staleAfterMs, parentPid: intent.parentPid, parentStartedAt: intent.parentStartedAt,
        isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive,
      })) return false;
      const [freshAllocationArtifact, freshStatusArtifact, freshClaimArtifact, freshDeliveryUnknownArtifact, freshStateValue] = await Promise.all([
        readBrokerArtifact(paths.allocationPath), readBrokerArtifact(paths.brokerStatusPath), readBrokerArtifact(paths.brokerClaimPath),
        readBrokerArtifact(paths.launchDeliveryUnknownPath), readBoundedPrivateJson(paths.statePath),
      ]);
      const freshAllocation = controlV3
        ? parseAllocationRecordV3(freshAllocationArtifact.outcome === "valid" ? freshAllocationArtifact.value : null, intent.runId)
        : parseAllocationRecordV2(freshAllocationArtifact.outcome === "valid" ? freshAllocationArtifact.value : null, intent.runId);
      const freshStatus = controlV3
        ? parseBrokerStatusV3(freshStatusArtifact.outcome === "valid" ? freshStatusArtifact.value : null, intent.runId)
        : parseBrokerStatusV2(freshStatusArtifact.outcome === "valid" ? freshStatusArtifact.value : null, intent.runId);
      const freshBrokerClaim = controlV3
        ? parseBrokerClaimV3(freshClaimArtifact.outcome === "valid" ? freshClaimArtifact.value : null, intent.runId)
        : parseBrokerClaimV2(freshClaimArtifact.outcome === "valid" ? freshClaimArtifact.value : null, intent.runId);
      const freshDeliveryUnknown = controlV3 ? null : parseLaunchDeliveryUnknownV2(
        freshDeliveryUnknownArtifact.outcome === "valid" ? freshDeliveryUnknownArtifact.value : null,
        intent.runId,
        paths.runDir,
      );
      if (freshDeliveryUnknownArtifact.outcome === "invalid"
        || (freshDeliveryUnknownArtifact.outcome === "valid" && !freshDeliveryUnknown)
        || JSON.stringify(freshAllocation) !== JSON.stringify(allocation) || JSON.stringify(freshStatus) !== JSON.stringify(status)
        || JSON.stringify(freshBrokerClaim) !== JSON.stringify(brokerClaim)
        || JSON.stringify(freshDeliveryUnknown) !== JSON.stringify(deliveryUnknown)) return false;
      if (freshStatus?.writer === "broker" && freshStatus.phase === "ready" && "pid" in freshStatus && isBrokerAlive(freshStatus.pid)) return false;
      const freshState = parseRunState(freshStateValue, intent.runId);
      if (observedChildState?.childPid !== freshState?.childPid || observedChildState?.childStartedAt !== freshState?.childStartedAt) return false;
      if (freshState?.childPid !== undefined && freshState.childStartedAt !== undefined && cleanupOwnerStatus(freshState.childPid, freshState.childStartedAt) !== "dead") return false;
      if (freshState && checkedAt >= freshState.updatedAt && checkedAt - freshState.updatedAt <= staleAfterMs
        && ["starting", "idle", "running", "settled", "shutting-down"].includes(freshState.phase)) return false;
      return true;
    };
    // Broker PIDs are reusable. Only a fresh, preterminal ready status may
    // defer cleanup; committed/failed records are one-shot terminal evidence.
    let brokerActive = status?.writer === "broker" && status.phase === "ready"
      && reaperNow() >= status.updatedAt && reaperNow() - status.updatedAt <= staleAfterMs
      && "pid" in status && isBrokerAlive(status.pid);
    if (brokerActive) { outcome.skipped.push(intent.runId); continue; }
    if (!allocation && decision?.kind !== "cancel") {
      if (!await authorityIsStillQuiescent()) { outcome.skipped.push(intent.runId); continue; }
      // Fence every allocation-free run, including a broker delayed before its
      // immutable claim. The broker checks this winner before and after claim.
      const reason = status?.writer === "broker" && status.phase === "ready" ? "ready-timeout" : "commit-timeout";
      await (options.publishImmutable ?? publishImmutableJson)(paths.decisionPath, {
        version: controlV3 ? 3 : BROKER_PROTOCOL_VERSION, runId: intent.runId, kind: "cancel", decidedAt: now, reason,
      }).catch(() => undefined);
      [allocationArtifact, decisionArtifact, riskArtifact, statusArtifact, deliveryUnknownArtifact] = await Promise.all([
        readBrokerArtifact(paths.allocationPath), readBrokerArtifact(paths.decisionPath), readBrokerArtifact(paths.residualRiskPath), readBrokerArtifact(paths.brokerStatusPath), readBrokerArtifact(paths.launchDeliveryUnknownPath),
      ]);
      allocation = controlV3
        ? parseAllocationRecordV3(allocationArtifact.outcome === "valid" ? allocationArtifact.value : null, intent.runId)
        : parseAllocationRecordV2(allocationArtifact.outcome === "valid" ? allocationArtifact.value : null, intent.runId);
      decision = controlV3
        ? parseDecisionV3(decisionArtifact.outcome === "valid" ? decisionArtifact.value : null, intent.runId, paths.runDir)
        : parseDecisionV2(decisionArtifact.outcome === "valid" ? decisionArtifact.value : null, intent.runId, paths.runDir);
      risk = controlV3
        ? parseResidualRiskV3(riskArtifact.outcome === "valid" ? riskArtifact.value : null, intent.runId)
        : parseResidualRiskV2(riskArtifact.outcome === "valid" ? riskArtifact.value : null, intent.runId);
      status = controlV3
        ? parseBrokerStatusV3(statusArtifact.outcome === "valid" ? statusArtifact.value : null, intent.runId)
        : parseBrokerStatusV2(statusArtifact.outcome === "valid" ? statusArtifact.value : null, intent.runId);
      deliveryUnknown = controlV3 ? null : parseLaunchDeliveryUnknownV2(deliveryUnknownArtifact.outcome === "valid" ? deliveryUnknownArtifact.value : null, intent.runId, paths.runDir);
      launch = controlV3
        ? parseCommittedLaunchRecordV3(await readBrokerJson(paths.launchPath), intent.runId, paths.runDir)
        : parseCommittedLaunchRecordV2(await readBrokerJson(paths.launchPath), intent.runId, paths.runDir);
      gate = controlV3
        ? parseLaunchGateV3(await readBrokerJson(paths.launchGatePath), intent.runId, paths.runDir)
        : parseLaunchGateV2(await readBrokerJson(paths.launchGatePath), intent.runId, paths.runDir);
      if (authorityIsInvalid() || (allocation !== null && !hasAllocationIntentSourceBinding(intent as any, allocation as any))
        || !hasValidV2StateDependencies({ allocation: allocation as any, decision: decision as any, launch: launch as any, gate: gate as any })
        || controlV3 && !(intent.version === 3 && await hasValidTmuxControlChain({ runDir: paths.runDir, intent, allocation: allocation?.version === 3 ? allocation : null, launch: launch?.version === 3 ? launch : null, allowLegacyTmuxWindowLabel: true }))
        || (risk && allocation)) {
        await quarantineV2(intent.runId, paths);
        continue;
      }
      // A concurrent broker commit is the first-writer winner. Reconcile its
      // exact allocation below instead of reporting a cancellation we lost.
      brokerActive = false;
    }
    if (!allocation) {
      if (!await authorityIsStillQuiescent()) { outcome.skipped.push(intent.runId); continue; }
      // A cancel winner remains recovery authority while the broker may still
      // roll back or expose an allocation. A later reaper may retire it only
      // after terminal broker evidence or exact allocation absence.
      const recoveryPending = Boolean(risk) || (status?.phase === "failed" && "errorCode" in status && status.errorCode === "possible-unrecorded-allocation") || decision?.kind === "commit" || (status?.writer === "broker" && status.phase === "ready");
      // Keep the session pathname until whole-run retention cleanup. Even
      // though a child cannot validly launch without allocation, this avoids a
      // deletion race with any late immutable completion publication.
      if (!await removeSensitiveArtifacts(paths, true)) { outcome.invalid.push(intent.runId); outcome.skipped.push(intent.runId); continue; }
      if (recoveryPending) {
        outcome.skipped.push(intent.runId);
      } else {
        scheduleRetentionCleanup(paths.runDir, completion?.completedAt ?? intent.createdAt);
        outcome.reaped.push(intent.runId);
      }
      continue;
    }
    // Revalidate owner lease/progress and exact authority immediately before
    // issuing target-mutating terminal commands.
    if (!await authorityIsStillQuiescent()) { outcome.skipped.push(intent.runId); continue; }
    // Legacy cmux V2 records are retained diagnostics only. They lack the
    // control socket generation and therefore are never reaper mutation
    // authority, even if their UUIDs look canonical.
    const cmuxIntentControl = (intent as { control?: import("./run-protocol.js").CmuxControlTransportV2 }).control;
    const cmuxAllocationControl = (allocation as { control?: import("./run-protocol.js").CmuxControlTransportV2 }).control;
    const allowLegacyCmuxTestRunner = allocation.terminalMode === "cmux-pane" && options.cmuxRun !== undefined;
    if (allocation.terminalMode === "cmux-pane" && !allowLegacyCmuxTestRunner && (!cmuxIntentControl || !cmuxAllocationControl
      || JSON.stringify(cmuxIntentControl) !== JSON.stringify(cmuxAllocationControl))) {
      await quarantineV2(intent.runId, paths);
      continue;
    }
    const backendPath = resolveBackendPath(intent.terminalMode, intent.backendPath);
    if (!backendPath) {
      await quarantineV2(intent.runId, paths);
      continue;
    }
    let closeReaperControl: (() => void) | null = null;
    let v3TransportGate: NonNullable<ReturnType<typeof parseTmuxControlTransportGate>> | null = null;
    let reaperRun: BackendCommandRunner;
    if (controlV3 && intent.version === 3 && allocation.version === 3) {
      const transportGate = parseTmuxControlTransportGate(await readBrokerJson(paths.transportGatePath), intent.runId);
      const currentExecutable = readExecutableGeneration(backendPath);
      if (!transportGate || !(options.isTmuxControlGateCurrent ?? isTmuxControlTransportGateCurrent)(transportGate) || !currentExecutable
        || transportGate.executableGeneration.realpath !== currentExecutable.realpath
        || transportGate.executableGeneration.dev !== currentExecutable.dev
        || transportGate.executableGeneration.ino !== currentExecutable.ino
        || transportGate.executableGeneration.size !== currentExecutable.size
        || transportGate.executableGeneration.mtimeNs !== currentExecutable.mtimeNs
        || await exactArtifactDigest(paths.transportGatePath) !== intent.transportGateDigest
        || transportGate.canonicalSocketPath !== allocation.target.socketPath
        || transportGate.probeResult.serverPid !== allocation.target.serverPid
        || transportGate.probeResult.sourcePaneId !== intent.source.sourcePaneId
        || transportGate.probeResult.sourcePanePid !== intent.source.sourcePanePid) {
        await quarantineV2(intent.runId, paths);
        continue;
      }
      v3TransportGate = transportGate;
      if (options.tmuxControlRunFactory) {
        try {
          const managed = await options.tmuxControlRunFactory(transportGate, backendPath);
          reaperRun = managed.run;
          closeReaperControl = managed.close;
        } catch {
          await quarantineV2(intent.runId, paths);
          continue;
        }
      } else {
        const reaperControlClient = new TmuxControlClient({
          executable: backendPath,
          socketPath: transportGate.canonicalSocketPath,
          sessionId: transportGate.probeResult.attachedSessionId,
        });
        try {
          await reaperControlClient.start();
        } catch {
          reaperControlClient.close();
          await quarantineV2(intent.runId, paths);
          continue;
        }
        reaperRun = createTmuxControlCommandRunner(reaperControlClient, transportGate.canonicalSocketPath) as BackendCommandRunner;
        closeReaperControl = () => reaperControlClient.close();
      }
    } else {
      reaperRun = allocation.terminalMode === "cmux-pane"
        ? (options.cmuxRun ?? createCmuxControlCommandRunner({ env: process.env, expectedControl: cmuxIntentControl! }))
        : (options.tmuxRun ?? createBackendCommandRunner("tmux-pane", backendPath));
    }
    let gone = false;
    if (controlV3 && v3TransportGate && allocation.terminalMode === "tmux-pane") {
      const openControl = async (): Promise<{ run: TmuxCommandRunner; close: () => void }> => {
        if (options.tmuxControlRunFactory) return await options.tmuxControlRunFactory(v3TransportGate!, backendPath);
        const client = new TmuxControlClient({ executable: backendPath, socketPath: v3TransportGate!.canonicalSocketPath, sessionId: v3TransportGate!.probeResult.attachedSessionId });
        await client.start();
        return { run: createTmuxControlCommandRunner(client, v3TransportGate!.canonicalSocketPath), close: () => client.close() };
      };
      const generationIsCurrent = options.isTmuxGenerationCurrent ?? isTmuxGenerationCurrent;
      const sourceGeneration = intent.source.generation;
      if (!sourceGeneration) {
        await quarantineV2(intent.runId, paths);
        continue;
      }
      const expectedSourceWindowId = intent.container.kind === "tmux-source-pane" ? intent.container.windowId : intent.container.sourceWindowId;
      const validateSource = async (run: TmuxCommandRunner): Promise<boolean> => {
        const gateIsCurrent = options.isTmuxControlGateCurrent ?? isTmuxControlTransportGateCurrent;
        if (!gateIsCurrent(v3TransportGate!)) return false;
        const [server, sourceProbe, topology] = await Promise.all([
          run(buildTmuxServerPidArgs(v3TransportGate!.canonicalSocketPath)),
          run(buildTmuxSourcePaneProbeArgs(v3TransportGate!.canonicalSocketPath)),
          readTmuxSourceTopology({ sourcePaneId: intent.source.sourcePaneId, socketPath: v3TransportGate!.canonicalSocketPath, run }),
        ]);
        return server.exitCode === 0 && parseTmuxServerPidOutput(server.stdout) === intent.source.serverPid
          && sourceProbe.exitCode === 0 && parseTmuxSourcePaneProbe(sourceProbe.stdout, intent.source.sourcePaneId) === intent.source.sourcePanePid
          && topology !== null && topology.sessionId === v3TransportGate!.probeResult.attachedSessionId && topology.windowId === expectedSourceWindowId
          && generationIsCurrent(sourceGeneration, intent.source.serverPid) && gateIsCurrent(v3TransportGate!);
      };
      const targetGeneration = allocation.target.generation;
      if (!targetGeneration) {
        await quarantineV2(intent.runId, paths);
        continue;
      }
      const v3Handle = { paneId: allocation.target.paneId, panePid: allocation.target.panePid, socketPath: allocation.target.socketPath, serverPid: allocation.target.serverPid };
      let current = { run: reaperRun as TmuxCommandRunner, close: closeReaperControl ?? (() => undefined) };
      try {
        if (!generationIsCurrent(targetGeneration, allocation.target.serverPid) || !await validateSource(current.run)) throw new Error("tmux generation or source changed before reaper inspection");
        const initial = await inspectTmuxPaneFingerprint(v3Handle, current.run).catch(() => undefined);
        if (initial && !initial.exists) {
          gone = true;
        } else if (initial?.exists) {
          // Keep snapshot and close on the same healthy connection. A close
          // outcome is never replayed; disconnect only triggers read-only proof.
          if (!generationIsCurrent(targetGeneration, allocation.target.serverPid) || !await validateSource(current.run)) throw new Error("tmux generation or source changed before reaper close");
          if (options.signal?.aborted || !await authorityIsStillQuiescent()) throw new Error("reaper authority changed before tmux close");
          await closeTmuxPane(v3Handle, current.run).catch(() => false);
          const sameConnectionSnapshot = await inspectTmuxPaneFingerprint(v3Handle, current.run).catch(() => undefined);
          gone = sameConnectionSnapshot !== undefined && !sameConnectionSnapshot.exists;
        }
      } catch { /* retain recovery authority */ }
      finally { current.close(); }
      if (!gone) {
        let verifier: { run: TmuxCommandRunner; close: () => void } | null = null;
        try {
          if (!generationIsCurrent(targetGeneration, allocation.target.serverPid)) throw new Error("tmux generation changed before final verification");
          verifier = await openControl();
          if (!await validateSource(verifier.run)) throw new Error("tmux source changed before final verification");
          const finalSnapshot = await inspectTmuxPaneFingerprint(v3Handle, verifier.run).catch(() => undefined);
          gone = finalSnapshot !== undefined && !finalSnapshot.exists;
        } catch { /* retain recovery authority */ }
        finally { verifier?.close(); }
      }
    } else {
      gone = await cleanupV2Allocation(allocation as AllocationRecordV2, reaperRun, authorityIsStillQuiescent);
      closeReaperControl?.();
    }
    if (!await authorityIsStillQuiescent()) { outcome.skipped.push(intent.runId); continue; }
    const observerEvidence: CompletionEvidenceRefV3[] = ["allocation"];
    if (lease) observerEvidence.push("lease");
    if (gone) observerEvidence.push("target-snapshot");
    observerEvidence.sort();
    // A reaper is also an observer publisher. Bind a generic complete prefix
    // before immutable publication when one is presently provable; otherwise
    // retain the boundary-less compatibility record without draining live data.
    const session = await computeSessionFailureBoundary(paths.childSessionPath).catch(() => null);
    const observerRecord = {
      version: 3 as const, runId: intent.runId, producer: "reaper" as const, status: "orphaned" as const,
      completedAt: now, errorCode: gone ? "lease-expired" as const : "transport-lost" as const, evidenceRefs: observerEvidence,
      ...(session ? { session } : {}),
    };
    let winner: CompletionRecord;
    try {
      // Publish/re-read the immutable winner before deleting a transcript: a
      // concurrent child V3 success may need that exact boundary indefinitely.
      winner = await publishCompletionRecordV3(paths.completionPath, observerRecord);
    } catch {
      await removeSensitiveArtifacts(paths, true);
      outcome.invalid.push(intent.runId); outcome.skipped.push(intent.runId); continue;
    }
    // Reapers cannot replay into the original foreground result. Preserve the
    // transcript for every immutable winner, including legacy boundary-less
    // failures, until the run-retention policy expires.
    const preserveCompletionSession = true;
    if (!await removeSensitiveArtifacts(paths, preserveCompletionSession)) { outcome.invalid.push(intent.runId); outcome.skipped.push(intent.runId); continue; }
    if (!gone) {
      outcome.skipped.push(intent.runId); continue;
    }
    scheduleRetentionCleanup(paths.runDir, winner.completedAt);
    outcome.reaped.push(intent.runId);
    } finally { await cleanupClaim.release(); }
  }

  candidates.splice(0, candidates.length, ...candidates.filter(({ launch }) => graphRank.has(launch.runId)).sort((left, right) => graphRank.get(left.launch.runId)! - graphRank.get(right.launch.runId)!));

  for (const candidate of candidates) {
    if (options.signal?.aborted) return outcome;
    const { paths, launch } = candidate;
    let lease = null;
    try {
      lease = parseParentLease(await readBoundedPrivateJson(paths.parentLeasePath), launch.runId, reaperNow());
    } catch {
      lease = null;
    }
    if (launch.ownership === "detached" || isUsableParentLease({
      lease,
      now: reaperNow(),
      staleAfterMs: options.staleAfterMs ?? DEFAULT_PARENT_LEASE_STALE_MS,
      isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive,
    })) {
      outcome.skipped.push(launch.runId);
      continue;
    }
    if (!lease) { outcome.skipped.push(launch.runId); continue; }
    const cleanupOwners = [{ pid: lease.parentPid, startedAt: lease.parentStartedAt }];
    const observedChildState = parseRunState(await readBoundedPrivateJson(paths.statePath), launch.runId);
    if (observedChildState?.childPid !== undefined && observedChildState.childStartedAt !== undefined && !cleanupOwners.some((owner) => owner.pid === observedChildState.childPid && owner.startedAt === observedChildState.childStartedAt)) cleanupOwners.push({ pid: observedChildState.childPid, startedAt: observedChildState.childStartedAt });
    const cleanupClaim = await acquireCleanupClaimFor(paths, launch.runId, cleanupOwners);
    if (!cleanupClaim) { outcome.skipped.push(launch.runId); continue; }
    try {
    try { await assertSafeRunArtifactPaths(paths); } catch { outcome.invalid.push(launch.runId); continue; }
    const v1AuthorityIsStillQuiescent = async (): Promise<boolean> => {
      if (options.signal?.aborted || !await cleanupClaim.assertCurrent() || cleanupOwnerStatus(lease.parentPid, lease.parentStartedAt) !== "dead") return false;
      const checkedAt = reaperNow();
      try { await assertSafeRunArtifactPaths(paths); } catch { return false; }
      const freshLease = parseParentLease(await readBoundedPrivateJson(paths.parentLeasePath), launch.runId, checkedAt);
      if (isUsableParentLease({ lease: freshLease, now: checkedAt, staleAfterMs, isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive })) return false;
      const freshState = parseRunState(await readBoundedPrivateJson(paths.statePath), launch.runId);
      if (observedChildState?.childPid !== freshState?.childPid || observedChildState?.childStartedAt !== freshState?.childStartedAt) return false;
      if (freshState?.childPid !== undefined && freshState.childStartedAt !== undefined && cleanupOwnerStatus(freshState.childPid, freshState.childStartedAt) !== "dead") return false;
      return !(freshState && checkedAt >= freshState.updatedAt && checkedAt - freshState.updatedAt <= staleAfterMs
        && ["starting", "idle", "running", "settled", "shutting-down"].includes(freshState.phase));
    };
    if (!await v1AuthorityIsStillQuiescent()) { outcome.skipped.push(launch.runId); continue; }
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
        if (options.signal?.aborted || !await v1AuthorityIsStillQuiescent()) { outcome.skipped.push(launch.runId); continue; }
        await interruptTmuxPane(handle, legacyTmuxRun).catch(() => false);
        if (options.signal?.aborted || !await v1AuthorityIsStillQuiescent()) { outcome.skipped.push(launch.runId); continue; }
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
    if (!await v1AuthorityIsStillQuiescent()) { outcome.skipped.push(launch.runId); continue; }
    let existingCompletion = null;
    try {
      existingCompletion = parseCompletionRecord(await readBoundedPrivateJson(paths.completionPath), launch.runId);
    } catch {
      existingCompletion = null;
    }
    const completionAt = existingCompletion?.completedAt ?? options.now ?? Date.now();
    if (!existingCompletion) {
      await atomicWriteJson(paths.completionPath, {
        version: RUN_PROTOCOL_VERSION,
        runId: launch.runId,
        status: "orphaned",
        completedAt: completionAt,
        stopReason: "aborted",
        errorCode: "lease-expired",
        childSessionFile: launch.childSessionFile,
      } satisfies CompletionRecordV1).catch(() => undefined);
    }
    if (!await removeSensitiveArtifacts(paths)) { outcome.invalid.push(launch.runId); outcome.skipped.push(launch.runId); continue; }
    scheduleRetentionCleanup(paths.runDir, completionAt);
    outcome.reaped.push(launch.runId);
    } finally { await cleanupClaim.release(); }
  }
  return outcome;
  } finally {
    // Keep the root lock through both graphs: fork records may refer to a
    // just-reaped interactive run directory. Fork reconciliation is best
    // effort and never turns completed run cleanup into a false success.
    if (!options.signal?.aborted) {
      try {
        const forkOutcome = await (options.reconcileForkSources ?? reconcileForkSourceOwnershipRoot)({
          stateRoot: rootDir,
          ownerStatus: ({ pid, startedAt }) => options.isProcessIdentityAlive
            ? options.isProcessIdentityAlive(pid, startedAt) ? "live" : "dead"
            : classifyParentProcessIdentity(pid, startedAt),
          signal: options.signal,
          now: () => options.now ?? Date.now(),
        });
        if (forkOutcome.invalid.length > 0) {
          outcome.diagnostics.push({
            severity: "warning",
            code: "fork-source-invalid",
            message: "Fork source ownership records require inspection. Run /subagents doctor for status.",
            details: forkOutcome,
          });
        }
      } catch (error) {
        outcome.diagnostics.push(forkSourceReconciliationFailureDiagnostic(error));
      }
    }
    await rootLock.release();
  }
}

export interface StaleInteractiveReaperHandle {
  /** Resolves after the bounded foreground enumeration slice transfers ownership. */
  startup: Promise<void>;
  /** Resolves after full classification, graph planning, and bounded-safe cleanup. */
  completion: Promise<ReapStaleInteractiveRunsResult>;
  cancelAndDrain(): Promise<void>;
}

export async function startStaleInteractiveReaper(
  options: Omit<NonNullable<Parameters<typeof reapStaleInteractiveRuns>[0]>, typeof INTERNAL_REAPER_CONTEXT> = {},
): Promise<StaleInteractiveReaperHandle> {
  const startedAt = performance.now();
  const rootDir = path.resolve(options.rootDir ?? getRunStateRoot());
  const empty: ReapStaleInteractiveRunsResult = { scanned: 0, reaped: [], skipped: [], invalid: [], diagnostics: [] };
  if (!await fileExists(rootDir)) return { startup: Promise.resolve(), completion: Promise.resolve(empty), cancelAndDrain: async () => undefined };
  await assertSafeStateRoot(rootDir);
  const ownerStartedAt = getCurrentProcessStartedAt();
  if (ownerStartedAt === null) return { startup: Promise.resolve(), completion: Promise.resolve(empty), cancelAndDrain: async () => undefined };
  const rootLock = await acquireReaperRootLock(rootDir, `${process.pid}:${ownerStartedAt}`);
  if (!rootLock) return { startup: Promise.resolve(), completion: Promise.resolve(empty), cancelAndDrain: async () => undefined };
  const elapsed = performance.now() - startedAt;
  const enumeration = (options.enumerateRunDirectories ?? enumerateRunDirectories)(rootDir, { startupBudgetMs: Math.max(0, (options.startupBudgetMs ?? 200) - elapsed), startupEntryBudget: options.startupEntryBudget ?? 50 });
  const controller = new AbortController();
  const startupNames = enumeration.startup;
  const startup = startupNames.then(() => undefined);
  let delegatedLock = false;
  const completion = Promise.all([startupNames, enumeration.completion, enumeration.overflow]).then(async ([initial, remaining, overflow]) => {
    // Overflow is a whole-root result, not a partial-list warning. Do not
    // classify or mutate even the startup prefix when the graph is too large.
    if (overflow) {
      const overflowOutcome = { ...empty, diagnostics: [] };
      recordGraphEntryCap(overflowOutcome);
      return overflowOutcome;
    }
    delegatedLock = true;
    return await reapStaleInteractiveRuns({ ...options, signal: controller.signal, [INTERNAL_REAPER_CONTEXT]: { entries: [...initial, ...remaining], rootLock } });
  }).finally(async () => {
    if (!delegatedLock) await rootLock.release();
  });
  return {
    startup,
    completion,
    async cancelAndDrain(): Promise<void> {
      controller.abort();
      await enumeration.cancelAndDrain();
      await completion.catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Derive the spawn command from the current process context so child invocations
 * work on Unix and Windows without going through a shell wrapper.
 */
export interface PiSpawnResolution {
  command: string;
  prefixArgs: string[];
}

/** Resolve only the supported interpreter-hosted Pi entrypoints, never arbitrary runtimes. */
export function resolvePiSpawnForTest(context: { execPath: string; argv: readonly string[] }): PiSpawnResolution {
  const runtimeName = path.basename(context.execPath.replace(/\\/g, "/")).toLowerCase();
  const isSupportedInterpreter = runtimeName === "node" || runtimeName === "node.exe"
    || runtimeName === "bun" || runtimeName === "bun.exe";
  const entrypoint = context.argv[1];
  if (isSupportedInterpreter && entrypoint) {
    return { command: context.execPath, prefixArgs: [path.resolve(entrypoint)] };
  }
  return { command: context.execPath, prefixArgs: [] };
}

function resolvePiSpawn(): PiSpawnResolution {
  return resolvePiSpawnForTest({ execPath: process.execPath, argv: process.argv });
}

export function isPiVersionAtLeast(rawVersion: string, minimum: string | readonly [number, number, number] = MINIMUM_PI_VERSION): boolean {
  const minimumVersion = typeof minimum === "string" ? minimum : minimum.join(".");
  const detected = parsePiVersionOutput(rawVersion);
  return detected !== null && isStableSemverAtLeast(detected, minimumVersion);
}

export interface InteractivePiVersionProof {
  command: string;
  prefixArgs: string[];
  executableGeneration: NonNullable<ReturnType<typeof readExecutableGeneration>>;
  entrypointGeneration: ReturnType<typeof readExecutableGeneration>;
}

export async function verifyInteractivePiVersionCached(options: {
  command: string;
  prefixArgs?: string[];
  run?: (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}): Promise<InteractivePiVersionProof> {
  const command = options.command;
  const prefixArgs = options.prefixArgs ?? [];
  const executableGeneration = readExecutableGeneration(command);
  const entrypointGeneration = prefixArgs[0] ? readExecutableGeneration(prefixArgs[0]) : null;
  if (!executableGeneration || (prefixArgs[0] && !entrypointGeneration)) throw new Error("Pi version executable identity is unavailable.");
  const key = JSON.stringify([executableGeneration, entrypointGeneration]);
  let check = interactivePiVersionChecks.get(key);
  if (!check) {
    check = (async () => {
      const version = options.run
        ? await options.run(command, [...prefixArgs, "--version"])
        : await runCommandCapture(command, [...prefixArgs, "--version"], { env: buildBrokerEnvironment(process.env, "cmux-pane") });
      if (version.exitCode !== 0 || !isPiVersionAtLeast(version.stdout || version.stderr)) {
        throw new Error(`cmux Pi TUI mode requires stable Pi >= ${MINIMUM_PI_VERSION}; detected ${(version.stdout || version.stderr).trim() || "unknown"}.`);
      }
    })();
    interactivePiVersionChecks.set(key, check);
  }
  try { await check; } catch (error) { if (interactivePiVersionChecks.get(key) === check) interactivePiVersionChecks.delete(key); throw error; }
  return { command, prefixArgs: [...prefixArgs], executableGeneration, entrypointGeneration };
}

export function isInteractivePiVersionProofCurrent(proof: InteractivePiVersionProof): boolean {
  if (!sameExecutableGeneration(proof.executableGeneration, readExecutableGeneration(proof.command))) return false;
  const currentEntrypoint = proof.prefixArgs[0] ? readExecutableGeneration(proof.prefixArgs[0]) : null;
  return proof.entrypointGeneration === null ? currentEntrypoint === null
    : currentEntrypoint !== null && sameExecutableGeneration(proof.entrypointGeneration, currentEntrypoint);
}

async function ensureInteractivePiVersion(): Promise<InteractivePiVersionProof> {
  const { command, prefixArgs } = resolvePiSpawn();
  return await verifyInteractivePiVersionCached({ command, prefixArgs });
}

export function resetInteractivePiVersionChecksForTest(): void { interactivePiVersionChecks.clear(); }

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
  preserveChildSession = false,
  preserveDiagnosticArtifacts = false,
): Promise<boolean> {
  try { await assertSafeRunArtifactPaths(paths); } catch { return false; }
  const selected = [
    paths.taskPath, paths.systemPromptPath, paths.secretEnvPath, paths.lifecycleTokenPath,
    paths.completionFencePath, paths.completionFenceAckPath,
    ...(!preserveChildSession ? [paths.childSessionPath] : []),
    `${paths.childSessionPath}.entry-index`, `${paths.childSessionPath}.entry-index.fallback`,
    ...(!preserveDiagnosticArtifacts ? [paths.wrapperPath, paths.wrapperStatusPath, paths.stderrPath] : []),
    paths.shellHomePath,
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
export function resolveBackendExecutable(mode: "cmux-pane" | "tmux-pane" | "herdr-pane", env: NodeJS.ProcessEnv = process.env): string | null {
  // Herdr is socket-native: the broker runtime is its executable provenance,
  // not a nonexistent Herdr CLI binary.
  if (mode === "herdr-pane") return resolveBrokerRuntime(env);
  if (mode === "cmux-pane") {
    const configured = env[CMUX_BUNDLED_CLI_PATH_ENV]?.trim();
    if (configured) return resolveConfiguredExecutable(env, configured);
    return resolvePathExecutable(env, "cmux");
  }
  const configured = env[TMUX_BIN_ENV]?.trim();
  if (configured) return resolveConfiguredExecutable(env, configured);
  return resolvePathExecutable(env, "tmux");
}

/** Revalidate the exact executable selected before a lifecycle operation. */
export function resolveBackendPath(_mode: "cmux-pane" | "tmux-pane" | "herdr-pane", candidate: string): string | null {
  return resolveRegularFile(candidate, true);
}

type BackendCommandRunner = CmuxCommandRunner & TmuxCommandRunner;

/** A disconnected control client is never reused while reconnection is pending. */
const unavailableTmuxControlRunner: BackendCommandRunner = async () => ({
  exitCode: 1,
  stdout: "",
  stderr: "tmux control transport reconnect is pending.",
  aborted: false,
});

/** Each lifecycle operation revalidates the preflight-selected executable. */
function createBackendCommandRunner(
  mode: "cmux-pane" | "tmux-pane" | "herdr-pane",
  backendPath: string,
  initialGeneration: ReturnType<typeof readExecutableGeneration> = readExecutableGeneration(backendPath),
): BackendCommandRunner {
  return async (args, options = {}) => {
    if (!initialGeneration || !sameExecutableGeneration(initialGeneration, readExecutableGeneration(backendPath))
      || resolveBackendPath(mode, backendPath) !== backendPath) {
      return { exitCode: 1, stdout: "", stderr: "Backend executable is no longer available after preflight.", aborted: false };
    }
    const result = await runCommandCapture(backendPath, args, { signal: options.signal, env: buildBrokerEnvironment(process.env, mode, backendPath) });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, aborted: result.aborted };
  };
}

/**
 * Shared active-loop observation only. It never reaches any mutation, final
 * close confirmation, cancellation, rollback, or reaper path.
 */
interface TmuxLaunchIdentity {
  socket: FileGeneration;
  serverStartedAt: number;
}

function readTmuxLaunchIdentity(socketPath: string | undefined, serverPid: number): TmuxLaunchIdentity | null {
  // TMUX normally supplies its explicit socket. A default-socket invocation
  // cannot prove replacement resistance, so it is not launch authority.
  if (!socketPath) return null;
  const socket = readFileGeneration(socketPath, true);
  const serverStartedAt = getProcessStartedAt(serverPid);
  return socket && serverStartedAt !== null ? { socket, serverStartedAt } : null;
}

function sameTmuxLaunchIdentity(
  expected: TmuxLaunchIdentity,
  socketPath: string | undefined,
  serverPid: number,
): boolean {
  const current = readTmuxLaunchIdentity(socketPath, serverPid);
  return current !== null && current.serverStartedAt === expected.serverStartedAt
    && sameFileGeneration(expected.socket, current.socket);
}

/** Prove that a durable tmux tuple still names the same socket and server. */
export function isTmuxGenerationCurrent(generation: TmuxGenerationV2, serverPid: number): boolean {
  if (!Number.isSafeInteger(serverPid) || serverPid <= 0) return false;
  const socket = readFileGeneration(generation.socketPath, true);
  return socket !== null && socket.realpath === generation.socketPath
    && socket.dev === generation.socketDev && socket.ino === generation.socketIno
    && getProcessStartedAt(serverPid) === generation.serverStartedAt;
}

async function inspectActiveInteractiveSnapshot(options: {
  handle: InteractivePaneHandle;
  run: BackendCommandRunner;
  backendKey: string;
  generation: number;
  /** Active tmux reads are valid only through an accepted pooled epoch. */
  tmuxAcceptedTransport?: () => TmuxControlAcceptedTransport | null;
}): Promise<{ exists: boolean; exited?: boolean; title?: string } | undefined> {
  const { handle, run, backendKey, generation } = options;
  const observationGeneration = topologyMutationGeneration;
  const batchGeneration = generation * 1_000_000 + observationGeneration;
  if (handle.mode === "herdr-pane") return undefined;
  if (handle.mode === "cmux-pane") {
    const native = handle.native;
    const key = `cmux:${backendKey}:${native.workspaceId.toLowerCase()}`;
    const shared = await topologySnapshotBatch.read({
      generation: batchGeneration,
      key,
      fetch: async (signal) => {
        const response = await run(buildCmuxFullTreeArgs(native.workspaceId), { signal });
        return response.exitCode === 0 ? response.stdout : undefined;
      },
      validate: (raw) => inspectCanonicalCmuxSurfaceTree(raw, native.workspaceId, native.surfaceId) !== undefined,
    });
    if (observationGeneration !== topologyMutationGeneration) return undefined;
    return shared.state === "known"
      ? inspectCanonicalCmuxSurfaceTree(shared.value, native.workspaceId, native.surfaceId)
      : undefined;
  }

  const native = handle.native;
  // The pool accepted this exact persistent connection only after the full
  // gate/digest/executable/socket/server/source/session/window/target proof.
  // Do not re-run local process/socket probes on every active observation:
  // those probes can be transiently unavailable despite a live accepted epoch.
  const acceptedTransport = options.tmuxAcceptedTransport?.();
  if (!acceptedTransport) return undefined;
  const key = `tmux:${acceptedTransport.key}:${observationGeneration}`;
  const shared = await topologySnapshotBatch.read({
    generation: acceptedTransport.epoch,
    key,
    fetch: async (signal) => {
      const server = await run(buildTmuxServerPidArgs(native.socketPath), { signal });
      if (server.exitCode !== 0 || signal.aborted) return undefined;
      const panes = await run(buildTmuxPaneSnapshotArgs(native.socketPath), { signal });
      return panes.exitCode === 0 ? { server: server.stdout, panes: panes.stdout } : undefined;
    },
    validate: (snapshot) => parseTmuxServerPidOutput(snapshot.server) !== null && parseTmuxPaneSnapshots(snapshot.panes) !== null,
  });
  const currentTransport = options.tmuxAcceptedTransport?.();
  if (observationGeneration !== topologyMutationGeneration || shared.state === "unknown"
    || !currentTransport || currentTransport.epoch !== acceptedTransport.epoch || currentTransport.key !== acceptedTransport.key) return undefined;
  // Parsing remains per-handle. A malformed shared response is unknown for
  // every waiter; a PID mismatch is exact evidence that this handle is gone.
  if (parseTmuxServerPidOutput(shared.value.server) !== native.serverPid) return { exists: false };
  const panes = parseTmuxPaneSnapshots(shared.value.panes);
  if (!panes) return undefined;
  const pane = panes.get(native.paneId);
  if (!pane) return { exists: false };
  return pane.panePid === native.panePid
    ? { exists: true, exited: pane.dead }
    : { exists: false };
}

/** Test seam for active tmux snapshots through an already accepted pool epoch. */
export async function inspectActiveTmuxSnapshotForTest(options: {
  handle: Extract<InteractivePaneHandle, { mode: "tmux-pane" }>;
  run: TmuxCommandRunner;
  backendKey: string;
  generation: number;
  tmuxAcceptedTransport: () => TmuxControlAcceptedTransport | null;
}): Promise<{ exists: boolean; exited?: boolean; title?: string } | undefined> {
  return await inspectActiveInteractiveSnapshot({
    ...options,
    run: options.run as BackendCommandRunner,
  });
}

/** Test seam for an active cmux read that shares the production batch fence. */
export async function inspectActiveCmuxSnapshotForTest(options: {
  handle: Extract<InteractivePaneHandle, { mode: "cmux-pane" }>;
  run: CmuxCommandRunner;
  backendKey: string;
  generation: number;
}): Promise<{ exists: boolean; exited?: boolean; title?: string } | undefined> {
  return await inspectActiveInteractiveSnapshot({
    ...options,
    run: options.run as BackendCommandRunner,
  });
}

/** Bind active lifecycle calls to the exact resolved executable in V2 intent. */
function bindInteractiveBackend(
  backend: InteractivePaneBackend,
  backendPath: string,
  backendGeneration: ReturnType<typeof readExecutableGeneration>,
  transportRun?: BackendCommandRunner,
): InteractivePaneBackend {
  if (backend.mode === "herdr-pane") return backend;
  const run = transportRun ?? createBackendCommandRunner(backend.mode, backendPath, backendGeneration);
  if (backend.mode === "cmux-pane") {
    return {
      ...backend,
      inspect: async (handle) => handle.mode === "cmux-pane" ? await inspectCmuxSurface(handle.native, run) : undefined,
      interrupt: async (handle) => handle.mode === "cmux-pane" && await interruptCmuxSurface(handle.native, run),
      close: async (handle) => handle.mode === "cmux-pane" && await closeCmuxSurface(handle.native, run),
      focus: async (handle) => handle.mode === "cmux-pane" && await focusCmuxSurface(handle.native, run),
    };
  }
  return {
    ...backend,
    inspect: async (handle) => {
      if (handle.mode !== "tmux-pane" || !hasTmuxGeneration(handle.native)
        || !isTmuxGenerationCurrent(handle.native.generation, handle.native.serverPid)) return undefined;
      const snapshot = await inspectTmuxPaneFingerprint(handle.native, run);
      return snapshot && { exists: snapshot.exists, exited: snapshot.dead };
    },
    inspectForUx: async (handle) => {
      if (handle.mode !== "tmux-pane" || !hasTmuxGeneration(handle.native)
        || !isTmuxGenerationCurrent(handle.native.generation, handle.native.serverPid)) return undefined;
      const snapshot = await inspectTmuxPaneFingerprintForUx(handle.native, run);
      return snapshot && { exists: snapshot.exists, exited: snapshot.dead, title: snapshot.title };
    },
    interrupt: async (handle) => handle.mode === "tmux-pane" && hasTmuxGeneration(handle.native)
      && isTmuxGenerationCurrent(handle.native.generation, handle.native.serverPid) && await interruptTmuxPane(handle.native, run),
    close: async (handle) => handle.mode === "tmux-pane" && hasTmuxGeneration(handle.native)
      && isTmuxGenerationCurrent(handle.native.generation, handle.native.serverPid) && await closeTmuxPane(handle.native, run),
  };
}

type InteractiveCompletionAuthority =
  | { outcome: "none" }
  | { outcome: "completion"; completion: CompletionRecord }
  | { outcome: "invalid" };

/**
 * Completion is immutable terminal authority: a pathname that cannot be
 * decoded as this run's completion is recovery-blocking, never equivalent to
 * an absent completion.
 */
async function readInteractiveCompletionAuthority(
  completionPath: string,
  runId: string,
): Promise<InteractiveCompletionAuthority> {
  const artifact = await readBrokerArtifact(completionPath);
  if (artifact.outcome === "missing") return { outcome: "none" };
  if (artifact.outcome !== "valid") return { outcome: "invalid" };
  const completion = parseCompletionAuthority(artifact.value, runId);
  return completion ? { outcome: "completion", completion } : { outcome: "invalid" };
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
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (exitCode: number, signalCode: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      if (sigkillTimer) {
        clearTimeout(sigkillTimer);
        sigkillTimer = undefined;
      }
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
        sigkillTimer = setTimeout(() => {
          sigkillTimer = undefined;
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
// Private temporary artifact helpers
// ---------------------------------------------------------------------------

function safeTempName(agentName: string): string {
  return agentName.replace(/[^\w.-]+/g, "_");
}

async function writePrivateTempFile(
  agentName: string,
  name: string,
  contents: string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  try {
    await fs.promises.chmod(dir, 0o700);
    const filePath = path.join(dir, `${name}-${safeTempName(agentName)}`);
    const handle = await fs.promises.open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf-8");
      await handle.chmod(0o600);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`Refusing non-file private artifact: ${filePath}`);
    } finally {
      await handle.close();
    }
    return { dir, filePath };
  } catch (error) {
    await cleanupTempDir(dir).catch(() => undefined);
    throw error;
  }
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  return await writePrivateTempFile(agentName, "prompt", prompt);
}

async function writeForkSessionToTempFile(agentName: string, sessionJsonl: string): Promise<{ dir: string; filePath: string }> {
  return await writePrivateTempFile(agentName, "fork", sessionJsonl);
}

async function writeTaskToTempFile(agentName: string, task: string): Promise<{ dir: string; filePath: string }> {
  return await writePrivateTempFile(agentName, "task", `Task: ${task}`);
}

async function cleanupTempDir(dir: string | null | undefined): Promise<void> {
  if (!dir) return;
  try {
    await fs.promises.rm(dir, { recursive: true, force: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/** Attempt every reverse-order cleanup; only ENOENT is an idempotent success. */
async function cleanupTempDirs(...dirs: Array<string | null | undefined>): Promise<void> {
  let firstError: unknown;
  for (const dir of dirs) {
    try {
      await cleanupTempDir(dir);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
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
  maxActive?: number;
  limits?: SubagentLimits;
  preventCycles: boolean;
  interactivePaneLayout?: InteractivePaneLayout;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
  childPolicy?: ManagedChildPolicy;
}): Record<string, string> {
  const trustedProjectsEnv = JSON.stringify(opts.trustedProjectRoots ?? []);
  const deniedProjectsEnv = JSON.stringify(opts.deniedProjectRoots ?? []);
  const nextDepth = Math.max(0, Math.floor(opts.parentDepth)) + 1;
  const propagatedMaxDepth = Math.max(0, Math.floor(opts.maxDepth));
  const configuredMaxActive = opts.maxActive ?? opts.limits?.maxActive;
  const propagatedMaxActive = Number.isSafeInteger(configuredMaxActive) && configuredMaxActive! > 0 && configuredMaxActive! <= MAX_SUBAGENT_ACTIVE
    ? configuredMaxActive!
    : DEFAULT_MAX_ACTIVE;
  const propagatedStack = [...opts.parentAgentStack, opts.agentName];

  return {
    ...subagentLimitsToEnv(opts.limits ?? DEFAULT_SUBAGENT_LIMITS),
    [SUBAGENT_DEPTH_ENV]: String(nextDepth),
    [SUBAGENT_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
    [SUBAGENT_MAX_ACTIVE_ENV]: String(propagatedMaxActive),
    [SUBAGENT_STACK_ENV]: JSON.stringify(propagatedStack),
    [SUBAGENT_PREVENT_CYCLES_ENV]: opts.preventCycles ? "1" : "0",
    [SUBAGENT_MANAGED_CHILD_POLICY_ENV]: opts.childPolicy ?? resolveManagedChildPolicy(),
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

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const MANAGED_AGENT_SNAPSHOT_ENTRIES = new Set([
  "agents", "skills", "prompts", "themes", "models.json", "settings.json", "keybindings.json",
]);

function sameSnapshotIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function snapshotManagedAgentEntry(
  sourcePath: string,
  destination: string,
  canonicalSource: string,
  budget: { entries: number; bytes: number },
): Promise<void> {
  if (++budget.entries > 20_000) throw new Error("Managed agent configuration snapshot has too many entries.");
  const resolved = await fs.promises.realpath(sourcePath);
  if (!isContainedPath(canonicalSource, resolved)) throw new Error(`Inherited agent entry escapes its source directory: ${path.basename(sourcePath)}`);
  const before = await fs.promises.stat(resolved);
  if (before.isDirectory()) {
    await fs.promises.mkdir(destination, { mode: 0o700 });
    const directory = await fs.promises.opendir(resolved);
    try {
      while (true) {
        const entry = await directory.read();
        if (!entry) break;
        await snapshotManagedAgentEntry(path.join(resolved, entry.name), path.join(destination, entry.name), canonicalSource, budget);
        // Directory rename/restore changes ctime even when dev/ino return to the
        // original path, so every streamed child is fenced against ABA swaps.
        const currentResolved = await fs.promises.realpath(sourcePath);
        const current = await fs.promises.stat(currentResolved);
        if (currentResolved !== resolved || !sameSnapshotIdentity(before, current)) {
          throw new Error(`Inherited agent directory changed while creating the managed snapshot: ${path.basename(sourcePath)}`);
        }
      }
    } finally {
      try {
        await directory.close();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ERR_DIR_CLOSED") throw error;
      }
    }
  } else if (before.isFile()) {
    const source = await fs.promises.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const target = await fs.promises.open(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      const opened = await source.stat();
      if (!sameSnapshotIdentity(before, opened)) throw new Error(`Inherited agent entry changed before snapshot: ${path.basename(sourcePath)}`);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        budget.bytes += bytesRead;
        if (budget.bytes > 256 * 1024 * 1024) throw new Error("Managed agent configuration snapshot is too large.");
        let written = 0;
        while (written < bytesRead) {
          const result = await target.write(buffer, written, bytesRead - written, position + written);
          if (result.bytesWritten <= 0) throw new Error("Managed agent configuration snapshot write made no progress.");
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      if (position !== opened.size || !sameSnapshotIdentity(opened, await source.stat())) {
        throw new Error(`Inherited agent entry changed while creating the managed snapshot: ${path.basename(sourcePath)}`);
      }
      await target.sync();
    } finally {
      await Promise.allSettled([source.close(), target.close()]);
    }
  } else {
    throw new Error(`Inherited agent entry is not a regular file or directory: ${path.basename(sourcePath)}`);
  }
  const currentResolved = await fs.promises.realpath(sourcePath);
  const [after, current] = await Promise.all([fs.promises.stat(resolved), fs.promises.stat(currentResolved)]);
  if (currentResolved !== resolved || !sameSnapshotIdentity(before, after) || !sameSnapshotIdentity(before, current)) {
    throw new Error(`Inherited agent entry changed while creating the managed snapshot: ${path.basename(sourcePath)}`);
  }
}

/**
 * Create a private agent-dir overlay without ever serializing the credential.
 * Managed children receive a bounded private snapshot of data-only resources;
 * inherit mode keeps linked entries for extension/package compatibility.
 */
export async function prepareInheritedApiKeyAgentDir(
  binding: InheritedCliApiKeyEnvBinding | null | undefined,
  options: {
    baseEnv?: NodeJS.ProcessEnv;
    mkdtemp?: (prefix: string) => Promise<string>;
    writeFile?: typeof fs.promises.writeFile;
  } = {},
): Promise<string | null> {
  if (!binding) return null;
  const baseEnv = options.baseEnv ?? process.env;
  const sourceAgentDir = baseEnv[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] || getDefaultPiAgentDir(baseEnv);
  const mkdtemp = options.mkdtemp ?? (async (prefix: string) => await fs.promises.mkdtemp(prefix, "utf8") as string);
  const writeFile = options.writeFile ?? fs.promises.writeFile;
  const overlayDir = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-"));

  try {
    await fs.promises.chmod(overlayDir, 0o700);
    let entries: fs.Dirent[] = [];
    let canonicalSource: string | null = null;
    let sourceIdentity: fs.Stats | null = null;
    try {
      canonicalSource = await fs.promises.realpath(sourceAgentDir);
      const sourceStat = await fs.promises.stat(canonicalSource);
      sourceIdentity = sourceStat;
      if (!sourceStat.isDirectory()) throw new Error(`Inherited agent directory is not a directory: ${sourceAgentDir}`);
      entries = await fs.promises.readdir(canonicalSource, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (canonicalSource) {
      const managed = resolveManagedChildPolicy(baseEnv) === "managed";
      const snapshotBudget = { entries: 0, bytes: 0 };
      for (const entry of entries) {
        if (entry.name === "auth.json" || managed && !MANAGED_AGENT_SNAPSHOT_ENTRIES.has(entry.name)) continue;
        const sourceEntry = path.join(canonicalSource, entry.name);
        const destination = path.join(overlayDir, entry.name);
        if (managed) {
          const currentRoot = await fs.promises.realpath(sourceAgentDir);
          const currentRootIdentity = await fs.promises.stat(currentRoot);
          if (!sourceIdentity || currentRoot !== canonicalSource || !sameSnapshotIdentity(sourceIdentity, currentRootIdentity)) {
            throw new Error("Inherited agent directory changed while creating the managed snapshot.");
          }
          await snapshotManagedAgentEntry(sourceEntry, destination, canonicalSource, snapshotBudget);
          continue;
        }
        const before = await fs.promises.lstat(sourceEntry);
        const resolvedTarget = await fs.promises.realpath(sourceEntry);
        const targetStat = await fs.promises.stat(resolvedTarget);
        if (!isContainedPath(canonicalSource, resolvedTarget) || !targetStat.isFile() && !targetStat.isDirectory()) {
          throw new Error(`Inherited agent entry escapes its source directory: ${entry.name}`);
        }
        await fs.promises.symlink(sourceEntry, destination, before.isDirectory() ? "dir" : "file");
        const linkedTarget = await fs.promises.realpath(destination);
        if (!isContainedPath(canonicalSource, linkedTarget)) {
          throw new Error(`Inherited agent overlay link escapes its source directory: ${entry.name}`);
        }
      }
      if (managed) {
        const currentRoot = await fs.promises.realpath(sourceAgentDir);
        const currentRootIdentity = await fs.promises.stat(currentRoot);
        if (!sourceIdentity || currentRoot !== canonicalSource || !sameSnapshotIdentity(sourceIdentity, currentRootIdentity)) {
          throw new Error("Inherited agent directory changed while finalizing the managed snapshot.");
        }
      }
    }

    const auth: Record<string, unknown> = {
      [binding.provider]: { type: "api_key", key: `$${SUBAGENT_INHERITED_API_KEY_ENV}` },
    };
    const authPath = path.join(overlayDir, "auth.json");
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    await fs.promises.chmod(authPath, 0o600);
    const authStat = await fs.promises.lstat(authPath);
    if (!authStat.isFile() || authStat.isSymbolicLink()) throw new Error("Inherited API-key overlay auth file is not private regular file.");
    return overlayDir;
  } catch (error) {
    try {
      await cleanupTempDir(overlayDir);
    } catch {
      // Preserve the auth/validation failure; the caller never launches with a
      // partially prepared overlay.
    }
    throw error;
  }
}

function buildChildRuntimeTitle(agentName: string, runId: string | undefined, childDepth = 0): string {
  const runPrefix = (runId ?? "inline").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "run";
  const depth = Number.isSafeInteger(childDepth) && childDepth >= 0 ? childDepth : 0;
  const suffix = ` [depth=${depth};run=${runPrefix}]`;
  const agent = normalizeInteractiveTitleBase(agentName);
  const maxAgentLength = Math.max(1, INTERACTIVE_TITLE_MAX_BASE_LENGTH - suffix.length);
  return `${agent.slice(0, maxAgentLength).trimEnd() || "unknown"}${suffix}`;
}

export function buildChildProcessEnv(opts: {
  agentName: string;
  parentDepth: number;
  parentAgentStack: string[];
  maxDepth: number;
  maxActive?: number;
  limits?: SubagentLimits;
  preventCycles: boolean;
  interactivePaneLayout?: InteractivePaneLayout;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
  inheritedApiKeyBinding?: InheritedCliApiKeyEnvBinding | null;
  inheritedApiKeyAgentDir?: string | null;
  /** Gated Phase 0 child-only proof fields; controller paths are never propagated. */
  phase0LiveProofEnv?: Phase0LiveProofEnv;
  baseEnv?: NodeJS.ProcessEnv;
  runProtocolEnv?: Record<string, string>;
  /** Exact tree authority and lease capability minted for this child launch. */
  treePermitEnv?: Record<string, string>;
}): NodeJS.ProcessEnv {
  const baseEnv = opts.baseEnv ?? process.env;
  const childPolicy = resolveManagedChildPolicy(baseEnv);
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...buildPropagatedSubagentEnv({ ...opts, childPolicy }),
  };

  if (childPolicy === "managed") {
    // --no-extensions is not an isolation boundary if runtime loader hooks can
    // inject code before Pi processes its extension flags.
    for (const name of [
      "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "DENO_DIR",
      "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
      "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH",
      "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND",
      "CDPATH", "GLOBIGNORE", "KSH_ENV", "ZDOTDIR", "FPATH", "INPUTRC",
    ]) delete env[name];
    for (const name of Object.keys(env)) if (name.startsWith("BASH_FUNC_")) delete env[name];
  }

  for (const name of [
    RUN_STATE_DIR_ENV,
    SUBAGENT_RUN_ID_ENV,
    SUBAGENT_RUN_STATE_PATH_ENV,
    SUBAGENT_RUN_COMPLETION_PATH_ENV,
    SUBAGENT_COMPLETION_FENCE_PATH_ENV,
    SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV,
    SUBAGENT_COMPLETION_FENCE_NONCE_ENV,
    SUBAGENT_PARENT_LEASE_PATH_ENV,
    SUBAGENT_CHILD_SESSION_PATH_ENV,
    SUBAGENT_RUN_OWNERSHIP_ENV,
    // Promotion paths bind a child to its direct parent and are never inherited.
    SUBAGENT_PROMOTION_REQUEST_PATH_ENV,
    SUBAGENT_PROMOTION_ACK_PATH_ENV,
    SUBAGENT_FORK_BOOTSTRAP_PATH_ENV,
    SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV,
    SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV,
    SUBAGENT_LEASE_CHECK_MS_ENV,
    SUBAGENT_LEASE_STALE_MS_ENV,
    SUBAGENT_EXPECTED_PARENT_PID_ENV,
    SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
    SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV,
    SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV,
    PHASE0_LIVE_PROOF_ID_ENV,
    PHASE0_LIVE_PROOF_CAPABILITY_ENV,
    PHASE0_LIVE_PROOF_SOCKET_ENV,
    PHASE0_LIVE_PROOF_MASTER_ENV,
    PHASE0_LIVE_PROOF_BARRIER_PATH_ENV,
    PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV,
    PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV,
    PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV,
    PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV,
    PHASE0_LIVE_PROOF_BEHAVIOR_ENV,
    PHASE0_LIVE_TELEMETRY_DIR_ENV,
    PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV,
    TREE_PERMIT_ROOT_ENV,
    TREE_PERMIT_ROOT_ID_ENV,
    TREE_PERMIT_TOKEN_ENV,
    TREE_PERMIT_MAX_ACTIVE_ENV,
    TREE_PERMIT_LEASE_ID_ENV,
    TREE_PERMIT_LEASE_TOKEN_ENV,
  ]) {
    delete env[name];
  }
  Object.assign(env, opts.runProtocolEnv ?? {}, opts.phase0LiveProofEnv ?? {}, opts.treePermitEnv ?? {});
  env[SUBAGENT_MANAGED_TITLE_ENV] = buildChildRuntimeTitle(opts.agentName, opts.runProtocolEnv?.[SUBAGENT_RUN_ID_ENV], opts.parentDepth + 1);
  // Parent pi-cmux policy is not a child bootstrap authority. Remove every
  // inherited PI_CMUX_* value, then add only the reviewed child profile when
  // pi-cmux itself is inherited. Managed children do not load pi-cmux.
  for (const name of Object.keys(env)) if (name.startsWith("PI_CMUX_")) delete env[name];
  if (childPolicy === "inherit") Object.assign(env, CHILD_CMUX_PROFILE_ENV);

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

export function resolveManagedChildPolicy(env: NodeJS.ProcessEnv = process.env): ManagedChildPolicy {
  const raw = env[SUBAGENT_MANAGED_CHILD_POLICY_ENV]?.trim();
  if (raw === undefined || raw === "" || raw === "inherit") return "inherit";
  if (raw === "managed") return "managed";
  throw new Error(`${SUBAGENT_MANAGED_CHILD_POLICY_ENV} must be exactly inherit or managed.`);
}

const MANAGED_BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "subagent"]);
const MANAGED_DEFAULT_ACTIVE_TOOLS = ["read", "bash", "edit", "write", "subagent"] as const;
export function assertManagedChildToolCompatibility(
  agent: Pick<AgentConfig, "tools">,
  fallbackTools?: string,
  overriddenBuiltinTools: readonly string[] = [],
  fallbackNoTools = false,
): void {
  const configured = agent.tools ?? (fallbackTools === undefined ? undefined : fallbackTools.split(",").map((value) => value.trim()).filter(Boolean));
  const unsupported = configured?.filter((name) => !MANAGED_BUILTIN_TOOLS.has(name)) ?? [];
  if (unsupported.length > 0) throw new Error(`managed child policy cannot preserve extension-owned tools: ${unsupported.join(", ")}`);
  // With no explicit allowlist Pi still activates its default built-ins. Managed
  // mode must not silently replace an inherited override of one of those tools.
  const effective = configured ?? (fallbackNoTools ? [] : [...MANAGED_DEFAULT_ACTIVE_TOOLS]);
  const overridden = effective.filter((name) => overriddenBuiltinTools.includes(name));
  if (overridden.length > 0) throw new Error(`managed child policy cannot preserve extension overrides for built-in tools: ${overridden.join(", ")}`);
}

export function buildManagedExtensionArgs(includeBridge: boolean, selfExtensionPath = resolveCurrentPackageExtensionEntrypoint(), childBridgePath = CHILD_BRIDGE_PATH): string[] {
  return ["--no-extensions", "--extension", canonicalizeExtensionPath(selfExtensionPath), ...(includeBridge ? ["--extension", canonicalizeExtensionPath(childBridgePath)] : [])];
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

/** Allocates one FIFO and one HMAC-derived proof capability for a benchmark child. */
export async function claimPhase0LiveProofForChild(_env: NodeJS.ProcessEnv, modelSpecifier: string | undefined): Promise<Phase0LiveProofEnv | undefined> {
  const controller = phase0LiveProofController;
  if (!controller) return undefined;
  const provider = getProviderFromModelSpecifier(modelSpecifier);
  const model = modelSpecifier?.split("/", 2)[1];
  if (provider !== "openai-codex" || model !== "gpt-5.4-mini") throw new Error("Phase 0 live proof child model does not match the gated provider contract.");
  const assigned = controller.assignments.shift();
  if (!assigned) throw new Error("Phase 0 live proof has no unclaimed barrier FIFO.");
  const parent = await fs.promises.realpath(path.dirname(assigned.barrierPath));
  const barrierPath = path.join(parent, path.basename(assigned.barrierPath));
  if (barrierPath !== assigned.barrierPath) throw new Error("Phase 0 live proof barrier path is not canonical.");
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  const stat = await fs.promises.lstat(barrierPath);
  if (!stat.isFIFO() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (owner !== undefined && stat.uid !== owner)) {
    throw new Error("Phase 0 live proof barrier is not an owned private FIFO.");
  }
  let proofId: string;
  do { proofId = crypto.randomBytes(16).toString("hex"); } while (controller.proofIds.has(proofId));
  controller.proofIds.add(proofId);
  return {
    [PHASE0_LIVE_PROOF_SOCKET_ENV]: controller.socketPath,
    [PHASE0_LIVE_PROOF_ID_ENV]: proofId,
    [PHASE0_LIVE_PROOF_CAPABILITY_ENV]: derivePhase0LiveProofCapability(controller.master, proofId),
    [PHASE0_LIVE_PROOF_BARRIER_PATH_ENV]: barrierPath,
    [PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV]: assigned.releaseToken,
    [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: controller.releaseDeadline,
    [PHASE0_LIVE_PROOF_BEHAVIOR_ENV]: controller.behavior,
  };
}

export function buildPiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  taskFilePath: string,
  delegationMode: DelegationMode,
  forkSessionPath: string | null,
  modelOverride?: string,
  childPolicy: ManagedChildPolicy = resolveManagedChildPolicy(),
): string[] {
  if (childPolicy === "managed") assertManagedChildToolCompatibility(agent, inheritedCliArgs.fallbackTools);
  const args: string[] = [
    "--mode",
    "json",
    ...(childPolicy === "managed" ? buildManagedExtensionArgs(delegationMode === "fork" || phase0LiveProofEnabled()) : delegationMode === "fork" ? buildInteractiveExtensionArgs(inheritedCliArgs.extensionArgs) : inheritedCliArgs.extensionArgs),
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
  childPolicy: ManagedChildPolicy = resolveManagedChildPolicy(),
): string[] {
  if (childPolicy === "managed") assertManagedChildToolCompatibility(agent, inheritedCliArgs.fallbackTools);
  const args: string[] = [
    ...(childPolicy === "managed" ? buildManagedExtensionArgs(true) : buildInteractiveExtensionArgs(inheritedCliArgs.extensionArgs)),
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

/** Validate the headerless, immutable branch source before a child can use it. */
export function validateForkBranchSourceJsonl(source: string): string[] {
  const lines = source.split(/\r?\n/).filter((line) => line.length > 0);
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error("Fork branch source contains malformed JSONL.");
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Fork branch source contains a non-entry record.");
    }
    const type = (entry as Record<string, unknown>).type;
    if (typeof type !== "string" || !type || type === "session") {
      throw new Error("Fork branch source contains a header or invalid entry.");
    }
  }
  return lines;
}

export function buildInteractiveChildSessionJsonl(options: {
  cwd: string;
  parentSessionFile?: string;
  /** Headerless validated parent branch-entry JSONL. */
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
  // Never expose the parent session pathname to a child. The validated branch
  // bytes and run-level parentSessionId carry lineage without granting a direct
  // pointer to unselected or subsequently appended parent history.
  const lines = [JSON.stringify(header)];
  if (options.forkSessionSnapshotJsonl !== undefined) {
    lines.push(...validateForkBranchSourceJsonl(options.forkSessionSnapshotJsonl));
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

/**
 * Select one state root before child launch. Existing roots are only accepted
 * with their immutable marker; a missing root is initialized through the
 * existing protocol path, never by repairing a markerless directory.
 */
async function resolveChildRunStateRoot(
  treePermitLease?: Pick<TreePermitLease, "authority">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const requestedRoot = treePermitLease?.authority.rootDir ?? getRunStateRoot(baseEnv);
  const canonicalRoot = await ensureRunStateRoot(requestedRoot);
  if (treePermitLease && canonicalRoot !== await fs.promises.realpath(treePermitLease.authority.rootDir)) {
    throw new Error("Tree permit root does not match the validated child state root.");
  }
  return canonicalRoot;
}

/** Test seam for root selection and canonicalization without spawning Pi. */
export async function resolveChildRunStateRootForTest(
  treePermitLease?: Pick<TreePermitLease, "authority">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return await resolveChildRunStateRoot(treePermitLease, baseEnv);
}

function buildTreePermitChildEnv(treePermitLease: TreePermitLease | undefined, runStateRoot: string): Record<string, string> | undefined {
  if (!treePermitLease) return undefined;
  return { ...treePermitLease.exportChildEnv(), [TREE_PERMIT_ROOT_ENV]: runStateRoot };
}

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
  /** Process-local parent invocation correlation; never persisted or emitted. */
  invocationId?: string;
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
  /** Process-local active child cap propagated to nested child Pi processes. */
  maxActive?: number;
  /** Invocation and background limits propagated to nested child Pi processes. */
  limits?: SubagentLimits;
  /** Whether cycle prevention should be enforced in child processes. */
  preventCycles: boolean;
  /** Built-in names currently supplied by inherited extensions; managed mode must not silently replace them. */
  managedOverriddenBuiltinTools?: string[];
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Invocation-scoped immutable fork source authority. */
  forkSourceOwnership?: ForkSourceOwnershipManager;
  /** Stable child identity pre-registered by the scheduler. */
  forkChildId?: string;
  /** Durable tree-wide permit reserved for this exact child launch. */
  treePermitLease?: TreePermitLease;
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
    invocationId,
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
    maxActive = DEFAULT_MAX_ACTIVE,
    limits,
    preventCycles,
    managedOverriddenBuiltinTools,
    signal,
    onUpdate,
    forkSourceOwnership,
    forkChildId: suppliedForkChildId,
    treePermitLease,
    makeDetails,
  } = opts;

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    await opts.forkSourceOwnership?.markTerminal(opts.forkChildId!, "no-launch").catch(() => undefined);
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
      accountingUsage: emptyAccountingUsage(),
      model: modelOverride,
    };
  }

  if (delegationMode === "fork" && forkSessionSnapshotJsonl === undefined) {
    await opts.forkSourceOwnership?.markTerminal(opts.forkChildId!, "no-launch").catch(() => undefined);
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
      accountingUsage: emptyAccountingUsage(),
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
    accountingUsage: emptyAccountingUsage(),
    model: modelOverride ?? agent.model,
  };

  try {
    if (resolveManagedChildPolicy() === "managed") assertManagedChildToolCompatibility(agent, inheritedCliArgs.fallbackTools, managedOverriddenBuiltinTools, inheritedCliArgs.fallbackNoTools);
  } catch (error) {
    result.exitCode = 1; result.stopReason = "error"; result.errorMessage = error instanceof Error ? error.message : String(error); result.stderr = result.errorMessage;
    await opts.forkSourceOwnership?.markTerminal(opts.forkChildId!, "no-launch").catch(() => undefined);
    return result;
  }

  // A delayed background queue item must not become valid after a new session
  // starts. The extension threads its invocation-time capture here.
  if (!canStartInteractiveRun(interactiveShutdownGeneration)) {
    result.exitCode = 130;
    result.stopReason = "aborted";
    result.errorMessage = "Parent session shutdown fenced this subagent invocation before it started.";
    result.stderr = result.errorMessage;
    await opts.forkSourceOwnership?.markTerminal(opts.forkChildId!, "no-launch").catch(() => undefined);
    return result;
  }

  let forkChildId = suppliedForkChildId;
  if (delegationMode === "fork" && forkSourceOwnership) {
    try {
      forkChildId ??= crypto.randomUUID();
      // Scheduler-owned calls arrive pre-registered; direct callers are bound
      // here before any temp/session artifact or process can be created.
      if (!suppliedForkChildId) await forkSourceOwnership.registerChild({
        childId: forkChildId,
        surface: getInteractivePaneBackend(terminalMode) ? "interactive" : "inline",
        runId: getInteractivePaneBackend(terminalMode) ? forkChildId : null,
      });
    } catch (error) {
      result.exitCode = 1; result.stopReason = "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
      result.stderr = result.errorMessage;
      return result;
    }
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

  let phase0LiveProofEnv: Phase0LiveProofEnv | undefined;
  try {
    phase0LiveProofEnv = await claimPhase0LiveProofForChild(
      process.env,
      modelOverride ?? agent.model ?? inheritedCliArgs.fallbackModel,
    );
  } catch (error) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    result.stderr = result.errorMessage;
    await forkSourceOwnership?.markTerminal(forkChildId!, "launch-failed").catch(() => undefined);
    return result;
  }

  let runStateRoot: string;
  try {
    runStateRoot = await resolveChildRunStateRoot(treePermitLease);
  } catch (error) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    result.stderr = result.errorMessage;
    await forkSourceOwnership?.markTerminal(forkChildId!, "launch-failed").catch(() => undefined);
    return result;
  }

  const interactiveBackend = getInteractivePaneBackend(terminalMode);
  if (interactiveBackend) {
    return await runAgentInInteractivePane({
      backend: interactiveBackend,
      result,
      agent,
      invocationId,
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
      maxActive,
      limits,
      preventCycles,
      trustedProjectRoots,
      deniedProjectRoots,
      inheritedApiKeyBinding,
      phase0LiveProofEnv,
      forkSourceOwnership,
      forkChildId,
      treePermitLease,
      runStateRoot,
    });
  }

  let promptTmpDir: string | null = null;
  let forkSessionTmpDir: string | null = null;
  let taskTmpDir: string | null = null;
  let inheritedApiKeyAgentDir: string | null = null;

  try {
    const promptTmp = agent.systemPrompt.trim()
      ? await writePromptToTempFile(agent.name, agent.systemPrompt)
      : null;
    promptTmpDir = promptTmp?.dir ?? null;

    // Fork source is immutable, headerless branch data. Every inline child
    // receives a fresh header plus its own writable private session file.
    const inlineForkSession = delegationMode === "fork" ? buildInteractiveChildSessionJsonl({
      cwd: taskCwd ?? cwd, parentSessionFile, forkSessionSnapshotJsonl,
    }) : undefined;
    const forkTmp = inlineForkSession !== undefined
      ? await writeForkSessionToTempFile(agent.name, inlineForkSession)
      : null;
    forkSessionTmpDir = forkTmp?.dir ?? null;
    let forkBootstrapPath: string | undefined;
    if (forkSourceOwnership && forkChildId && forkTmp && forkSessionSnapshotJsonl !== undefined) {
      const inheritedOffset = Buffer.byteLength(inlineForkSession!, "utf8") - Buffer.byteLength(forkSessionSnapshotJsonl, "utf8");
      await forkSourceOwnership.writeBootstrap(forkChildId, {
        sessionPath: forkTmp.filePath, inheritedOffset, inheritedLength: Buffer.byteLength(forkSessionSnapshotJsonl, "utf8"),
      });
      forkBootstrapPath = path.join(forkSourceOwnership.paths.childrenDir, forkChildId, "bootstrap.json");
    }

    const taskTmp = await writeTaskToTempFile(agent.name, task);
    taskTmpDir = taskTmp.dir;
    inheritedApiKeyAgentDir = await prepareInheritedApiKeyAgentDir(inheritedApiKeyBinding);
    const piArgs = buildPiArgs(
      agent,
      promptTmp?.filePath ?? null,
      taskTmp.filePath,
      delegationMode,
      forkTmp?.filePath ?? null,
      modelOverride,
    );
    const effectiveCwd = taskCwd ?? cwd;
    applyChildProjectIsolation(piArgs, effectiveCwd);
    return await runAgentInline({
      result, cwd, taskCwd, piArgs, signal, onUpdate: emitUpdate,
      parentDepth, parentAgentStack, maxDepth, maxActive, limits, preventCycles,
      interactivePaneLayout, trustedProjectRoots, deniedProjectRoots, makeDetails,
      inheritedApiKeyBinding, inheritedApiKeyAgentDir, phase0LiveProofEnv, assistantSignatureIndexDir: taskTmpDir,
      forkSourceOwnership, forkChildId, forkBootstrapPath, treePermitLease, runStateRoot,
    });
  } finally {
    // Attempt every cleanup without replacing an already produced child result.
    // Cleanup failure is diagnostic and must not suppress later sensitive cleanup.
    await cleanupTempDirs(inheritedApiKeyAgentDir, taskTmpDir, forkSessionTmpDir, promptTmpDir)
      .catch((error) => console.error(`[pi-subagent] Temporary artifact cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
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
  maxActive: number;
  limits?: SubagentLimits;
  preventCycles: boolean;
  interactivePaneLayout: InteractivePaneLayout;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
  inheritedApiKeyBinding?: InheritedCliApiKeyEnvBinding | null;
  inheritedApiKeyAgentDir?: string | null;
  phase0LiveProofEnv?: Phase0LiveProofEnv;
  /** Existing private task-artifact directory; cleanup removes the index too. */
  assistantSignatureIndexDir?: string | null;
  forkSourceOwnership?: ForkSourceOwnershipManager;
  forkChildId?: string;
  forkBootstrapPath?: string;
  treePermitLease?: TreePermitLease;
  /** One parent-validated, canonical root passed explicitly to this child. */
  runStateRoot: string;
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

async function getProcessStartedAtWithRetry(processId: number | undefined, timeoutMs = STOPPED_BOOTSTRAP_IDENTITY_ACQUISITION_TIMEOUT_MS): Promise<number | null> {
  if (processId === undefined) return null;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const startedAt = getProcessStartedAt(processId);
    if (startedAt !== null) return startedAt;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type StoppedProcessState = "stopped" | "running" | "dead" | "unknown";
export type StoppedProcessResumeResult = "resumed" | "identity-changed" | "not-stopped" | "dead" | "timeout" | "signal-failed";

export interface StoppedProcessResumeProbe {
  getStartedAt(processId: number): number | null;
  getStoppedState(processId: number): StoppedProcessState;
  classifyIdentity(processId: number, expectedStartedAt: number): ProcessIdentityStatus;
  signal(processId: number, signal: "SIGCONT"): boolean;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

function getStoppedProcessState(processId: number): StoppedProcessState {
  try {
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${processId}/stat`, "utf8");
      const close = raw.lastIndexOf(")");
      const state = close >= 0 ? raw.slice(close + 1).trim().split(/\s+/)[0] : undefined;
      if (/^[Tt]$/.test(state ?? "")) return "stopped";
      if (/^[ZXx]$/.test(state ?? "")) return "dead";
      return state ? "running" : "unknown";
    }
    if (process.platform === "darwin") {
      const probe = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(processId)], { encoding: "utf8" });
      if (probe.status !== 0 || probe.error) return "unknown";
      const state = String(probe.stdout).trim()[0];
      if (state === "T" || state === "t") return "stopped";
      if (state === "Z" || state === "X" || state === "x") return "dead";
      return state ? "running" : "unknown";
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

const defaultStoppedProcessResumeProbe: StoppedProcessResumeProbe = {
  getStartedAt: getProcessStartedAt,
  getStoppedState: getStoppedProcessState,
  classifyIdentity: classifyParentProcessIdentity,
  signal: (processId, signal) => {
    try {
      process.kill(processId, signal);
      return true;
    } catch {
      return false;
    }
  },
  now: Date.now,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function isStoppedProcessNow(processId: number, expectedStartedAt: number): boolean {
  return getProcessStartedAt(processId) === expectedStartedAt && getStoppedProcessState(processId) === "stopped";
}

/**
 * Resume only an exactly identified, currently stopped bootstrap process.
 * Transient probe failures are retried within the deadline; a PID/start
 * mismatch, dead process, or externally resumed process is never signalled.
 */
async function resumeStoppedProcess(
  processId: number,
  expectedStartedAt: number,
  timeoutMs = STOPPED_BOOTSTRAP_RESUME_TIMEOUT_MS,
  probe: StoppedProcessResumeProbe = defaultStoppedProcessResumeProbe,
): Promise<StoppedProcessResumeResult> {
  const deadline = probe.now() + Math.max(0, timeoutMs);
  while (true) {
    const initialStartedAt = probe.getStartedAt(processId);
    if (initialStartedAt !== expectedStartedAt) {
      if (initialStartedAt !== null) return "identity-changed";
      if (probe.classifyIdentity(processId, expectedStartedAt) === "dead") return "dead";
    } else {
      const state = probe.getStoppedState(processId);
      if (state === "dead") return "dead";
      if (state === "running") return "not-stopped";
      if (state === "stopped") {
        // Re-read the exact OS-issued start identity after the stopped-state
        // probe, immediately adjacent to SIGCONT, so neither proof is reused.
        const finalStartedAt = probe.getStartedAt(processId);
        if (finalStartedAt === expectedStartedAt) {
          return probe.signal(processId, "SIGCONT") ? "resumed" : "signal-failed";
        }
        if (finalStartedAt !== null) return "identity-changed";
        if (probe.classifyIdentity(processId, expectedStartedAt) === "dead") return "dead";
      }
    }
    const remainingMs = deadline - probe.now();
    if (remainingMs <= 0) return "timeout";
    await probe.sleep(Math.min(10, remainingMs));
  }
}

/** Test seam for exact stopped-bootstrap resumes; defaults to the real OS probe. */
export async function resumeStoppedBootstrapForTest(options: {
  processId: number;
  expectedStartedAt: number;
  timeoutMs?: number;
  probe?: StoppedProcessResumeProbe;
}): Promise<StoppedProcessResumeResult> {
  return resumeStoppedProcess(options.processId, options.expectedStartedAt, options.timeoutMs, options.probe);
}

/** @deprecated Use resumeStoppedBootstrapForTest. */
export const resumeStoppedProcessForTest = resumeStoppedBootstrapForTest;

async function waitForStoppedProcess(processId: number, expectedStartedAt: number, timeoutMs = STOPPED_BOOTSTRAP_STOPPED_STATE_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isStoppedProcessNow(processId, expectedStartedAt)) return true;
    if (getProcessStartedAt(processId) !== expectedStartedAt) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function signalStoppedProcess(processId: number, expectedStartedAt: number, signal: "SIGCONT" | "SIGKILL"): boolean {
  if (!isStoppedProcessNow(processId, expectedStartedAt)) return false;
  try {
    process.kill(processId, signal);
    return true;
  } catch {
    return false;
  }
}

async function terminateStoppedBootstrap(
  proc: ChildProcessWithoutNullStreams,
  processId: number | undefined,
  expectedStartedAt: number | null,
  timeoutMs = 500,
): Promise<void> {
  if (processId !== undefined && expectedStartedAt !== null) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signalStoppedProcess(processId, expectedStartedAt, "SIGKILL")) {
        // Close the external-SIGCONT race: terminate the owned process group as
        // well as the stopped leader before leaving the bootstrap fence.
        signalUnixProcessTree(proc, "SIGKILL");
        break;
      }
      if (getProcessStartedAt(processId) !== expectedStartedAt) break;
      // An external SIGCONT may race the stopped check. The same start identity
      // still authorizes exact group termination, but never a PID-only signal.
      if (classifyParentProcessIdentity(processId, expectedStartedAt) === "live") {
        signalUnixProcessTree(proc, "SIGKILL");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (proc.exitCode === null) {
    await Promise.race([
      new Promise<void>((resolve) => proc.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }
}

export async function monitorInlineProcess(
  proc: ChildProcessWithoutNullStreams,
  result: SingleResult,
  signal: AbortSignal | undefined,
  onUpdate: () => void,
  assistantSignatureIndex?: AssistantSignatureIndex,
  outputLimitBytes?: number,
  expectedChildStartedAt?: number | null,
  identityUnavailableAbortTimeoutMs = SIGKILL_TIMEOUT_MS,
): Promise<{ exitCode: number; wasAborted: boolean }> {
  let wasAborted = false;
  const childPid = proc.pid;
  const childStartedAt = expectedChildStartedAt === undefined
    ? await getProcessStartedAtWithRetry(childPid)
    : expectedChildStartedAt;
  const exitCode = await new Promise<number>((resolve) => {
    let didClose = false;
    let settled = false;
    let abortHandler: (() => void) | undefined;
    let semanticCompletionTimer: NodeJS.Timeout | undefined;
    let identityUnavailableAbortTimer: NodeJS.Timeout | undefined;

    const clearSemanticCompletionTimer = () => {
      if (semanticCompletionTimer) {
        clearTimeout(semanticCompletionTimer);
        semanticCompletionTimer = undefined;
      }
    };

    const signalOwnedUnixProcessTree = (terminationSignal: NodeJS.Signals): boolean => {
      if (childPid === undefined || childStartedAt === null) return false;
      const identityStatus = classifyParentProcessIdentity(childPid, childStartedAt);
      if (identityStatus === "unknown") return false;
      if (identityStatus === "dead" && getProcessStartedAt(childPid) !== null) return false;
      signalUnixProcessTree(proc, terminationSignal);
      return true;
    };

    const terminateChild = (): boolean => {
      if (isWindows) {
        if (proc.pid !== undefined) {
          const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
            stdio: "ignore",
          });
          killer.unref();
        }
        return true;
      }

      if (!signalOwnedUnixProcessTree("SIGTERM")) return false;
      const sigkillTimer = setTimeout(() => {
        // A detached group can outlive its leader. Tri-state identity proof
        // blocks both initial and delayed signals after PID/PGID reuse.
        signalOwnedUnixProcessTree("SIGKILL");
      }, SIGKILL_TIMEOUT_MS);
      sigkillTimer.unref();
      return true;
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearSemanticCompletionTimer();
      if (identityUnavailableAbortTimer) {
        clearTimeout(identityUnavailableAbortTimer);
        identityUnavailableAbortTimer = undefined;
      }
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      resolve(code);
    };

    let lineProcessing = Promise.resolve();
    let maybeFinishFromAgentEnd = () => undefined;
    let pendingStdoutBytes = 0;
    let totalStdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    const failBoundedOutput = () => {
      if (outputExceeded) return;
      outputExceeded = true;
      result.stderr += "\nManaged child output exceeded its bounded safety limit.";
      terminateChild();
      finish(1);
    };
    const flushLine = (line: string) => {
      // stdout chunks may arrive before durable index publication completes.
      // Chaining keeps event/result/callback order identical to JSONL order.
      lineProcessing = lineProcessing.then(async () => {
        if (await processPiJsonLineWithAssistantSignatureIndex(line, result, assistantSignatureIndex)) onUpdate();
        maybeFinishFromAgentEnd();
      }).catch(() => {
        // The index and parser both fail closed to exact public-message
        // handling. Do not let an internal optimization failure strand a run.
      });
    };

    const chunkProcessor = createJsonLineChunkProcessor(flushLine);

    maybeFinishFromAgentEnd = () => {
      if (!result.sawAgentEnd || didClose || settled) return;
      clearSemanticCompletionTimer();
      semanticCompletionTimer = setTimeout(() => {
        if (didClose || settled || !result.sawAgentEnd) return;
        chunkProcessor.flushRemainder();
        void lineProcessing.then(() => {
          proc.stdout.removeListener("data", onStdoutData);
          proc.stderr.removeListener("data", onStderrData);
          finish(0);
          terminateChild();
        });
      }, AGENT_END_GRACE_MS);
      semanticCompletionTimer.unref();
    };

    const onStdoutData = (chunk: Buffer) => {
      if (outputLimitBytes !== undefined) {
        totalStdoutBytes += chunk.length;
        const lastLf = chunk.lastIndexOf(0x0a);
        pendingStdoutBytes = lastLf >= 0 ? chunk.length - lastLf - 1 : pendingStdoutBytes + chunk.length;
        if (totalStdoutBytes > outputLimitBytes || pendingStdoutBytes > outputLimitBytes) {
          failBoundedOutput();
          return;
        }
      }
      chunkProcessor.pushChunk(chunk.toString());
    };

    const onStderrData = (chunk: Buffer) => {
      if (outputLimitBytes !== undefined) {
        stderrBytes += chunk.length;
        if (stderrBytes > outputLimitBytes) {
          failBoundedOutput();
          return;
        }
      }
      result.stderr += chunk.toString();
    };

    proc.stdout.on("data", onStdoutData);
    proc.stderr.on("data", onStderrData);

    const onClose = (code: number | null, terminationSignal?: NodeJS.Signals | null) => {
      if (didClose) return;
      didClose = true;
      chunkProcessor.flushRemainder();
      void lineProcessing.then(() => finish(code ?? (terminationSignal && !result.sawAgentEnd ? 1 : 0)));
    };
    proc.on("close", onClose);
    // Identity retry can outlive a very short child. Node retains pipe bytes,
    // but the close event itself is not replayed to a late listener.
    if (proc.exitCode !== null || proc.signalCode !== null) queueMicrotask(() => onClose(proc.exitCode, proc.signalCode));

    proc.on("error", (err) => {
      if (!result.stderr.trim()) result.stderr = err.message;
      chunkProcessor.flushRemainder();
      void lineProcessing.then(() => finish(1));
    });

    if (signal) {
      abortHandler = () => {
        if (didClose || settled) return;
        wasAborted = true;
        if (!terminateChild()) {
          // Identity-unavailable fail-closed signaling must not retain the
          // scheduler permit forever. Bound settlement without guessing a PID.
          identityUnavailableAbortTimer = setTimeout(() => {
            result.stderr += "\nChild identity unavailable during cancellation; detached process signaling was skipped.";
            proc.stdin.destroy();
            proc.stdout.destroy();
            proc.stderr.destroy();
            proc.unref();
            finish(130);
          }, identityUnavailableAbortTimeoutMs);
          identityUnavailableAbortTimer.unref();
        }
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });

  return { exitCode, wasAborted };
}

/**
 * Build the one production argv used for every Unix stopped bootstrap. The
 * privileged shell, absolute sleep executable, exact identity gate, and
 * self-kill watchdog deliberately have no environment-controlled variants.
 */
export function buildStoppedBootstrapArgv(command: string, args: readonly string[]): string[] {
  const bootstrap = `_pi_bootstrap_pid=$$; ( _pi_watchdog_sleep=; trap 'command kill "$_pi_watchdog_sleep" 2>/dev/null; wait "$_pi_watchdog_sleep" 2>/dev/null; exit 0' TERM; /bin/sleep ${STOPPED_BOOTSTRAP_WATCHDOG_SECONDS} & _pi_watchdog_sleep=$!; wait "$_pi_watchdog_sleep"; command kill -KILL "$_pi_bootstrap_pid" ) & _pi_watchdog=$!; command kill -STOP "$$"; command kill "$_pi_watchdog" 2>/dev/null; wait "$_pi_watchdog" 2>/dev/null; exec "$@"`;
  return ["-p", "-c", bootstrap, "pi-subagent-managed-child", command, ...args];
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
    maxActive,
    limits,
    preventCycles,
    interactivePaneLayout,
    trustedProjectRoots,
    deniedProjectRoots,
    inheritedApiKeyBinding,
    inheritedApiKeyAgentDir,
    phase0LiveProofEnv,
    assistantSignatureIndexDir,
    forkSourceOwnership,
    forkChildId,
    forkBootstrapPath,
    treePermitLease,
    runStateRoot,
  } = opts;

  const managedChild = resolveManagedChildPolicy() === "managed";
  if (managedChild && !isWindows && process.platform !== "linux" && process.platform !== "darwin") {
    result.stderr += `Managed child identity gate is unsupported on ${process.platform}.`;
    result.exitCode = 1;
    return normalizeCompletedResult(result, false);
  }
  const { command, prefixArgs } = resolvePiSpawn();
  // Fork bootstrap acknowledgement is a launch gate independent of the
  // configured child policy. The stopped shell self-terminates if recording or
  // resume cannot be proven.
  const gatedChild = managedChild || Boolean(forkBootstrapPath) || Boolean(treePermitLease);
  const childCommand = gatedChild && !isWindows ? "/bin/sh" : command;
  const childArgs = gatedChild && !isWindows
    ? buildStoppedBootstrapArgv(command, [...prefixArgs, ...piArgs])
    : [...prefixArgs, ...piArgs];
  const proc = spawn(childCommand, childArgs, {
    cwd: taskCwd ?? cwd,
    shell: false,
    detached: !isWindows,
    stdio: ["pipe", "pipe", "pipe"],
    env: buildChildProcessEnv({
      agentName: result.agent,
      parentDepth,
      parentAgentStack,
      maxDepth,
      maxActive,
      limits,
      preventCycles,
      interactivePaneLayout,
      trustedProjectRoots,
      deniedProjectRoots,
      inheritedApiKeyBinding,
      inheritedApiKeyAgentDir,
      phase0LiveProofEnv,
      runProtocolEnv: {
        [RUN_STATE_DIR_ENV]: runStateRoot,
        ...(forkBootstrapPath ? { [SUBAGENT_FORK_BOOTSTRAP_PATH_ENV]: forkBootstrapPath } : {}),
      },
      treePermitEnv: buildTreePermitChildEnv(treePermitLease, runStateRoot),
    }),
  });

  const spawnState: { error: Error | null } = { error: null };
  proc.on("error", (error) => {
    spawnState.error = error;
  });
  proc.stdin.on("error", () => {
    /* ignore broken pipe on fast exits */
  });
  proc.stdin.end();

  const assistantSignatureIndex = assistantSignatureIndexDir
    ? new AssistantSignatureIndex(assistantSignatureIndexDir)
    : undefined;
  const outputLimitBytes = managedChild ? 64 * 1024 * 1024 : undefined;
  const childStartedAt = await getProcessStartedAtWithRetry(proc.pid);
  const observedSpawnError = spawnState.error;
  let identityFailure = observedSpawnError !== null;
  if (observedSpawnError && !result.stderr.trim()) result.stderr = observedSpawnError.message;
  if (treePermitLease && isWindows && observedSpawnError === null) {
    if (childStartedAt === null || proc.pid === undefined || !await treePermitLease.bindChildIdentity({ pid: proc.pid, startedAt: childStartedAt })) {
      result.stderr += "Tree permit child process binding failed.";
      identityFailure = true;
    }
  }
  if (gatedChild && !isWindows && observedSpawnError === null) {
    const stopped = childStartedAt !== null && proc.pid !== undefined
      && await waitForStoppedProcess(proc.pid, childStartedAt);
    if (!stopped || childStartedAt === null || proc.pid === undefined) {
      // The bootstrap's private watchdog self-terminates when no verified
      // SIGCONT is issued; no PID-only mutation is needed here.
      result.stderr += "Unable to bind managed child process identity.";
      identityFailure = true;
    } else {
      if (forkSourceOwnership && forkChildId) {
        try {
          await forkSourceOwnership.recordProcess(forkChildId, { pid: proc.pid, startedAt: childStartedAt });
        } catch (error) {
          result.stderr += `Fork child process record failed: ${error instanceof Error ? error.message : String(error)}`;
          identityFailure = true;
        }
      }
      if (treePermitLease && !identityFailure && !await treePermitLease.bindChildIdentity({ pid: proc.pid, startedAt: childStartedAt })) {
        result.stderr += "Tree permit child process binding failed.";
        identityFailure = true;
      }
      if (!identityFailure) {
        const resume = await resumeStoppedProcess(proc.pid, childStartedAt);
        if (resume !== "resumed") {
          result.stderr += resume === "identity-changed"
            ? "Child process identity changed before resume."
            : resume === "timeout"
              ? "Timed out confirming managed child process state before resume."
              : "Managed child process was not safely stopped before resume.";
          identityFailure = true;
        }
      }
    }
  }
  if (identityFailure) {
    await terminateStoppedBootstrap(proc, proc.pid, childStartedAt);
    proc.stdin.destroy();
    proc.stdout.destroy();
    proc.stderr.destroy();
    proc.unref();
    result.exitCode = 1;
    await forkSourceOwnership?.markTerminal(forkChildId!, "launch-failed").catch(() => undefined);
    return normalizeCompletedResult(result, false);
  }
  const { exitCode, wasAborted } = await monitorInlineProcess(proc, result, signal, onUpdate, assistantSignatureIndex, outputLimitBytes, childStartedAt);
  result.exitCode = exitCode;
  if (treePermitLease && proc.exitCode === null && proc.signalCode === null) {
    const exited = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(false); }, SIGKILL_TIMEOUT_MS * 2);
      timer.unref();
      const onClose = () => { cleanup(); resolve(true); };
      const cleanup = () => { clearTimeout(timer); proc.removeListener("close", onClose); };
      proc.once("close", onClose);
      if (proc.exitCode !== null || proc.signalCode !== null) onClose();
    });
    if (!exited) {
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = "tree-permit-child-exit-unconfirmed";
      result.stderr = result.stderr ? `${result.stderr}\ntree-permit-child-exit-unconfirmed` : "tree-permit-child-exit-unconfirmed";
    }
  }
  if (forkSourceOwnership && forkChildId) {
    const acknowledged = await forkSourceOwnership.validateChildAcknowledgement(forkChildId).catch(() => false);
    if (!acknowledged) {
      result.exitCode = 1; result.stopReason = "error"; result.errorMessage = "fork-bootstrap-unacknowledged";
      result.stderr = result.stderr ? `${result.stderr}\nfork-bootstrap-unacknowledged` : "fork-bootstrap-unacknowledged";
      await forkSourceOwnership.markTerminal(forkChildId, "process-exited-before-ack").catch(() => undefined);
    }
  }
  return normalizeCompletedResult(result, wasAborted);
}

interface RunAgentInInteractivePaneOptions {
  backend: InteractivePaneBackend;
  result: SingleResult;
  agent: AgentConfig;
  /** Process-local parent invocation correlation; never persisted or emitted. */
  invocationId?: string;
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
  maxActive: number;
  limits?: SubagentLimits;
  preventCycles: boolean;
  interactivePaneLayout: InteractivePaneLayout;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
  inheritedApiKeyBinding?: InheritedCliApiKeyEnvBinding | null;
  phase0LiveProofEnv?: Phase0LiveProofEnv;
  forkSourceOwnership?: ForkSourceOwnershipManager;
  forkChildId?: string;
  treePermitLease?: TreePermitLease;
  /** One parent-validated, canonical root used for this run and its child. */
  runStateRoot: string;
}

const MULTIPLEXER_IDENTITY_ENV = new Set(["TMUX", "TMUX_PANE", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"]);

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
  "CMUX_SOCKET_PATH", CMUX_BUNDLED_CLI_PATH_ENV, TMUX_BIN_ENV,
  ...Object.keys(CHILD_CMUX_PROFILE_ENV),
  PI_AGENT_DIR_ENV, SUBAGENT_ORIGINAL_AGENT_DIR_ENV, SUBAGENT_INHERITED_API_KEY_ENV, SUBAGENT_MANAGED_TITLE_ENV,
  SUBAGENT_DEPTH_ENV, SUBAGENT_MAX_DEPTH_ENV, SUBAGENT_MAX_ACTIVE_ENV, SUBAGENT_STACK_ENV, SUBAGENT_PREVENT_CYCLES_ENV, SUBAGENT_MANAGED_CHILD_POLICY_ENV,
  INTERACTIVE_PANE_LAYOUT_ENV, SUBAGENT_TRUSTED_PROJECTS_ENV, SUBAGENT_DENIED_PROJECTS_ENV, PI_OFFLINE_ENV,
  RUN_STATE_DIR_ENV, SUBAGENT_RUN_ID_ENV, SUBAGENT_RUN_STATE_PATH_ENV, SUBAGENT_RUN_COMPLETION_PATH_ENV,
  SUBAGENT_COMPLETION_FENCE_PATH_ENV, SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV, SUBAGENT_COMPLETION_FENCE_NONCE_ENV,
  TREE_PERMIT_ROOT_ENV, TREE_PERMIT_ROOT_ID_ENV, TREE_PERMIT_TOKEN_ENV, TREE_PERMIT_MAX_ACTIVE_ENV, TREE_PERMIT_LEASE_ID_ENV, TREE_PERMIT_LEASE_TOKEN_ENV,
  SUBAGENT_PARENT_LEASE_PATH_ENV, SUBAGENT_CHILD_SESSION_PATH_ENV, SUBAGENT_RUN_OWNERSHIP_ENV, SUBAGENT_PROMOTION_REQUEST_PATH_ENV, SUBAGENT_PROMOTION_ACK_PATH_ENV, SUBAGENT_FORK_BOOTSTRAP_PATH_ENV, SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV, SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV,
  SUBAGENT_LEASE_CHECK_MS_ENV, SUBAGENT_LEASE_STALE_MS_ENV, SUBAGENT_EXPECTED_PARENT_PID_ENV, SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
  SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV, SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV,
  PHASE0_LIVE_GATE_ENV, PHASE0_LIVE_PROOF_SOCKET_ENV, PHASE0_LIVE_PROOF_ID_ENV, PHASE0_LIVE_PROOF_CAPABILITY_ENV, PHASE0_LIVE_PROOF_BARRIER_PATH_ENV, PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV, PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV, PHASE0_LIVE_PROOF_BEHAVIOR_ENV,
  ...Object.values(SUBAGENT_LIMIT_DEFINITIONS).map(({ env }) => env),
]);

/** Explicit child allowlist; provider auth, proxy, and CA settings stay private. */
/** Environment authority for the detached broker and every command it runs. */
export function buildTmuxSourcePaneProbeArgs(socketPath?: string): string[] {
  return [...(socketPath ? ["-S", socketPath] : []), "list-panes", "-a", "-F", `#{pane_id}${TMUX_FORMAT_DELIMITER}#{pane_pid}`];
}

export function parseTmuxSourcePaneProbe(stdout: string, paneId: string): number | null {
  const parsed = parseTmuxPanePidList(stdout, paneId);
  return typeof parsed === "number" ? parsed : null;
}

export class CmuxSourcePreflightError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly controlErrorCode: string,
    readonly parserFailure: CmuxSourceTopologyFailure | "not-run" | "topology-mutated" | "shutdown-fenced" | "socket-generation-changed",
  ) { super(message); this.name = "CmuxSourcePreflightError"; }
}

type CmuxPreflightCommandResult = Awaited<ReturnType<BackendCommandRunner>> & {
  diagnostic?: { kind: "control" | "adapter"; code: string; state?: string; method?: string; remote?: true };
};

function sameCmuxSurfaceIdentity(left: CmuxSurfaceIdentity, right: CmuxSurfaceIdentity): boolean {
  return left.workspaceId.toLowerCase() === right.workspaceId.toLowerCase()
    && left.surfaceId.toLowerCase() === right.surfaceId.toLowerCase()
    && left.paneId.toLowerCase() === right.paneId.toLowerCase();
}

export async function resolveSharedCmuxSourcePreflight(options: {
  run: BackendCommandRunner;
  singleFlight: LaunchPreflightSingleFlight;
  shutdownGeneration: number;
  socketGeneration: { socketPath: string; socketDev: string; socketIno: string };
  workspaceId: string;
  surfaceId: string;
  getTopologyGeneration: () => number;
  isShutdownCurrent: () => boolean;
  isSocketGenerationCurrent: () => boolean | Promise<boolean>;
  maxAttempts?: number;
}): Promise<CmuxSurfaceIdentity> {
  const attempts = options.maxAttempts ?? 3;
  let generationInvalidatedIdentity: CmuxSurfaceIdentity | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!options.isShutdownCurrent()) {
      throw new CmuxSourcePreflightError("cmux source topology preflight failed: exit=130 control=CMUX_ABORTED parser=shutdown-fenced", 130, "CMUX_ABORTED", "shutdown-fenced");
    }
    const topologyGeneration = options.getTopologyGeneration();
    const key = JSON.stringify(["cmux-source-v1", options.shutdownGeneration, options.socketGeneration.socketPath, options.socketGeneration.socketDev, options.socketGeneration.socketIno, options.workspaceId, options.surfaceId, topologyGeneration]);
    const candidate = await options.singleFlight.read(key, async () => {
      const tree = await options.run(buildCmuxFullTreeArgs(options.workspaceId)) as CmuxPreflightCommandResult;
      if (tree.exitCode !== 0) {
        const controlCode = tree.diagnostic?.code ?? "CMUX_CONTROL_FAILURE";
        const state = tree.diagnostic?.state ? ` state=${tree.diagnostic.state}` : "";
        throw new CmuxSourcePreflightError(`cmux source topology preflight failed: exit=${tree.exitCode} control=${controlCode}${state} parser=not-run`, tree.exitCode, controlCode, "not-run");
      }
      const parsed = diagnoseCanonicalCmuxSurfacePane(tree.stdout, options.workspaceId, options.surfaceId);
      if (!parsed.ok) {
        throw new CmuxSourcePreflightError(`cmux source topology preflight failed: exit=0 control=none parser=${parsed.reason}`, 0, "none", parsed.reason);
      }
      return { identity: parsed.identity, topologyGeneration };
    });
    if (!options.isShutdownCurrent()) {
      throw new CmuxSourcePreflightError("cmux source topology preflight failed: exit=130 control=CMUX_ABORTED parser=shutdown-fenced", 130, "CMUX_ABORTED", "shutdown-fenced");
    }
    if (!await options.isSocketGenerationCurrent()) {
      throw new CmuxSourcePreflightError("cmux source topology preflight failed: exit=1 control=CMUX_SOCKET_ROTATED parser=socket-generation-changed", 1, "CMUX_SOCKET_ROTATED", "socket-generation-changed");
    }
    if (!options.isShutdownCurrent()) {
      throw new CmuxSourcePreflightError("cmux source topology preflight failed: exit=130 control=CMUX_ABORTED parser=shutdown-fenced", 130, "CMUX_ABORTED", "shutdown-fenced");
    }
    if (options.getTopologyGeneration() === candidate.topologyGeneration) return candidate.identity;
    if (generationInvalidatedIdentity && sameCmuxSurfaceIdentity(generationInvalidatedIdentity, candidate.identity)) return candidate.identity;
    generationInvalidatedIdentity = candidate.identity;
  }
  throw new CmuxSourcePreflightError("cmux source topology preflight failed: exit=1 control=none parser=topology-mutated", 1, "none", "topology-mutated");
}

export function buildBrokerEnvironment(env: NodeJS.ProcessEnv, mode: "cmux-pane" | "tmux-pane" | "herdr-pane", resolvedBackendExecutable?: string): NodeJS.ProcessEnv {
  const minimal: NodeJS.ProcessEnv = {
    // Keep the resolver PATH for env-shebang runtime/backend shims. This is
    // still an explicit allowlisted value, not inherited shell state.
    PATH: env.PATH || "/usr/bin:/bin",
    HOME: env.HOME || os.homedir(),
    TMPDIR: env.TMPDIR || os.tmpdir(),
    TERM: env.TERM || "xterm-256color",
  };
  for (const key of [PHASE0_LIVE_GATE_ENV, PHASE0_LIVE_TELEMETRY_DIR_ENV, PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV]) {
    if (env[key] !== undefined) minimal[key] = env[key];
  }
  for (const key of mode === "cmux-pane"
    ? ["CMUX_SOCKET_PATH", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", CMUX_BUNDLED_CLI_PATH_ENV]
    : mode === "herdr-pane"
      ? ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"]
      : ["TMUX", "TMUX_PANE"]) {
    if (env[key] !== undefined) minimal[key] = env[key];
  }
  if (mode === "tmux-pane") {
    // Do not replay a caller's raw/relative selection into the detached
    // broker. Every tmux descendant receives the already-resolved identity.
    const canonical = resolvedBackendExecutable
      ? resolveBackendPath("tmux-pane", resolvedBackendExecutable)
      : resolveBackendExecutable("tmux-pane", env);
    if (canonical && path.isAbsolute(canonical)) minimal[TMUX_BIN_ENV] = canonical;
  }
  return minimal;
}

export function buildPrivateChildEnvironmentScript(env: NodeJS.ProcessEnv): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
    if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (!CHILD_BOOTSTRAP_ENV.has(key) && !key.startsWith("LC_")) continue;
    // Child/nested launch must never inherit an unresolved relative TMUX_BIN.
    // Resolve it against the explicit PATH once, then serialize only its
    // canonical absolute path through the private bootstrap artifact.
    if (key === TMUX_BIN_ENV) {
      const canonical = resolveBackendExecutable("tmux-pane", env);
      if (!canonical || !path.isAbsolute(canonical)) continue;
      lines.push(`export ${key}=${shellQuote(canonical)}`);
      continue;
    }
    // Multiplexer pane identities remain dynamic and must never be restored.
    // The inherited CLI key uses this same short-lived private 0600 boundary
    // as provider keys; the wrapper unlinks the script immediately after source.
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
  surfaceTitle?: string;
  /** Private fixed path used to stop before Pi starts until the parent binds the tree permit. */
  treePermitBootstrapPath?: string;
  /** Direct Herdr tabs enter only through this quiet durable-gate verifier. */
  herdrDirectGate?: { runtime: string; entrypoint: string; runDir: string; nonce: string; runtimeInterpreter: string; backend: string };
}): string {
  return [
    "#!/bin/bash",
    // A direct Herdr layout starts this file before the parent can publish its
    // final gate. Do not touch secrets, cwd, title, status, or permits first.
    ...(options.herdrDirectGate ? [
      'if [[ "${1:-}" != "--pi-subagent-herdr-gate-ok" ]]; then',
      `  exec ${shellQuote(options.herdrDirectGate.runtime)} ${shellQuote(options.herdrDirectGate.entrypoint)} --verify-herdr-direct-gate --run-dir ${shellQuote(options.herdrDirectGate.runDir)} --nonce ${shellQuote(options.herdrDirectGate.nonce)} --runtime ${shellQuote(options.herdrDirectGate.runtime)} --runtime-interpreter ${shellQuote(options.herdrDirectGate.runtimeInterpreter)} --backend ${shellQuote(options.herdrDirectGate.backend)} --wrapper "$0"`,
      "fi",
      "shift",
    ] : []),
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
    `  case "$_pi_env_name" in TMUX|TMUX_PANE|CMUX_WORKSPACE_ID|CMUX_SURFACE_ID|HERDR_ENV|HERDR_SOCKET_PATH|HERDR_WORKSPACE_ID|HERDR_TAB_ID|HERDR_PANE_ID|${SUBAGENT_INHERITED_API_KEY_ENV}) ;; *) unset "$_pi_env_name" ;; esac`,
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
    // The wrapper owns only the pre-Pi queued state. Emit it after the
    // effective private environment and cwd are installed, but before a tree
    // permit can stop this process; child-bridge owns later lifecycle states.
    ...(options.surfaceTitle ? [`printf '\\033]2;%s\\007' ${shellQuote(formatInteractiveTitle(options.surfaceTitle, "queued"))}`] : []),
    ...(options.treePermitBootstrapPath ? [
      "umask 077",
      `_pi_permit_tmp=${shellQuote(`${options.treePermitBootstrapPath}.tmp`)}.$$`,
      "printf '{\"pid\":%s}\\n' \"$$\" > \"$_pi_permit_tmp\"",
      `/bin/mv "$_pi_permit_tmp" ${shellQuote(options.treePermitBootstrapPath)}`,
      "( /bin/sleep 10; command kill -KILL \"$$\" ) & _pi_permit_watchdog=$!",
      "command kill -STOP \"$$\"",
      "command kill \"$_pi_permit_watchdog\" 2>/dev/null || true",
      "wait \"$_pi_permit_watchdog\" 2>/dev/null || true",
      `/bin/rm -f ${shellQuote(options.treePermitBootstrapPath)}`,
      "unset _pi_permit_tmp _pi_permit_watchdog",
    ] : []),
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
  launchDeliveryUnknown?: Awaited<ReturnType<typeof readBrokerArtifact>>;
}): boolean {
  // Invalid immutable authority is quarantined rather than deleted. A valid
  // allocation is retained until the exact target's absence was observed.
  if ([options.status, options.decision, options.allocation, options.launch, options.gate, options.residualRisk, options.launchDeliveryUnknown].some((artifact) => artifact?.outcome === "invalid")) return true;
  const status = parseBrokerStatusV2(options.status.outcome === "valid" ? options.status.value : null, options.runId);
  const decision = parseDecisionV2(options.decision.outcome === "valid" ? options.decision.value : null, options.runId, options.runDir);
  const allocation = parseAllocationRecordV2(options.allocation.outcome === "valid" ? options.allocation.value : null, options.runId);
  const launch = parseCommittedLaunchRecordV2(options.launch?.outcome === "valid" ? options.launch.value : null, options.runId, options.runDir);
  const gate = parseLaunchGateV2(options.gate?.outcome === "valid" ? options.gate.value : null, options.runId, options.runDir);
  const residualRisk = parseResidualRiskV2(options.residualRisk?.outcome === "valid" ? options.residualRisk.value : null, options.runId);
  const deliveryUnknown = parseLaunchDeliveryUnknownV2(options.launchDeliveryUnknown?.outcome === "valid" ? options.launchDeliveryUnknown.value : null, options.runId, options.runDir);
  if ((options.status.outcome === "valid" && !status) || (options.decision.outcome === "valid" && !decision) || (options.allocation.outcome === "valid" && !allocation) || (options.launch?.outcome === "valid" && !launch) || (options.gate?.outcome === "valid" && !gate) || (options.residualRisk?.outcome === "valid" && !residualRisk) || (options.launchDeliveryUnknown?.outcome === "valid" && !deliveryUnknown)) return true;
  if (!hasValidV2StateDependencies({ allocation, decision, launch, gate })) return true;
  if (deliveryUnknown && (!allocation || allocation.terminalMode !== "herdr-pane" || deliveryUnknown.allocationPath !== path.join(options.runDir, "allocation.json"))) return true;
  if (residualRisk || deliveryUnknown || (status?.phase === "failed" && status.errorCode === "possible-unrecorded-allocation")) return true;
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
  mode: "cmux-pane" | "tmux-pane" | "herdr-pane",
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
  mode: "cmux-pane" | "tmux-pane" | "herdr-pane";
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
  terminalMode: "cmux-pane" | "tmux-pane" | "herdr-pane";
  generation: number;
  protocolVersion?: 2 | 3;
  /** Required only for the exact negotiated Herdr V2 gate. */
  herdrProtocol?: HerdrProtocolVersion;
  /** Test seam for deterministic publication/fence ordering. */
  beforePublishForTest?: () => Promise<void>;
}): Promise<NonNullable<ReturnType<typeof parseLaunchGateV2>> | LaunchGateV3> {
  return await withInteractiveFenceMutex(async () => {
    await options.beforePublishForTest?.();
    if (!canStartInteractiveRun(options.generation)) {
      throw new Error("Interactive session shutdown fenced this committed run before gate publication.");
    }
    const protocolVersion = options.protocolVersion ?? 2;
    if (options.terminalMode === "herdr-pane" && options.herdrProtocol === undefined) {
      throw new Error("Herdr launch gate requires its negotiated protocol.");
    }
    const gate = {
      version: protocolVersion,
      runId: options.runId,
      terminalMode: options.terminalMode,
      ...(options.terminalMode === "herdr-pane" ? { protocol: options.herdrProtocol as HerdrProtocolVersion } : {}),
      launchPath: options.paths.launchPath,
      publishedAt: Date.now(),
    };
    await publishImmutableJson(options.paths.launchGatePath, gate);
    const rawPublishedGate = await readBrokerJson(options.paths.launchGatePath);
    const publishedGate = protocolVersion === 3
      ? parseLaunchGateV3(rawPublishedGate, options.runId, options.paths.runDir)
      : parseLaunchGateV2(rawPublishedGate, options.runId, options.paths.runDir);
    if (!publishedGate) {
      throw new Error("Interactive launch gate authority is malformed or belongs to another backend.");
    }
    return publishedGate;
  });
}

function allocationToHandle(allocation: NonNullable<ReturnType<typeof parseAllocationRecordV2>>): InteractivePaneHandle {
  if (allocation.terminalMode === "herdr-pane") {
    if (!hasHerdrSocketGeneration(allocation.target)) throw new Error("Herdr allocation lacks socket generation authority.");
    return { mode: "herdr-pane", native: {
    ...allocation.target,
    socketDev: allocation.target.generation.socketDev, socketIno: allocation.target.generation.socketIno,
    ...("layout" in allocation && allocation.placement === "herdr-new-tab" && allocation.container.kind === "herdr-tab"
      ? { allocatedTabId: allocation.container.tabId } : {}),
  }, placement: "layout" in allocation ? { layout: allocation.layout, placement: allocation.placement } : undefined };
  }
  const placement = "layout" in allocation
    ? { layout: allocation.layout, placement: allocation.placement }
    : undefined;
  if (allocation.terminalMode === "cmux-pane") {
    return { mode: "cmux-pane", native: { workspaceId: allocation.target.workspaceId, surfaceId: allocation.target.surfaceId, paneId: allocation.target.paneId }, placement };
  }
  if (!hasTmuxGeneration(allocation.target)) throw new Error("Tmux allocation lacks generation authority.");
  return { mode: "tmux-pane", native: {
    paneId: allocation.target.paneId, socketPath: allocation.target.socketPath,
    serverPid: allocation.target.serverPid, panePid: allocation.target.panePid, generation: allocation.target.generation,
  }, placement };
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

async function waitForBrokerDecision(paths: RunArtifactPaths, runId: string, signal?: AbortSignal, broker?: ReturnType<typeof spawn>, protocolVersion: 2 | 3 = 2): Promise<ReturnType<typeof parseDecisionV2> | DecisionV3> {
  const started = Date.now();
  let sawReady = false;
  let brokerExited = false;
  let brokerSpawnError: Error | null = null;
  broker?.once("exit", () => { brokerExited = true; });
  broker?.once("error", (error) => { brokerExited = true; brokerSpawnError = error; });
  while (Date.now() - started < BROKER_COMMIT_TIMEOUT_MS) {
    const rawDecision = await readBrokerJson(paths.decisionPath);
    const decision = protocolVersion === 3 ? parseDecisionV3(rawDecision, runId, paths.runDir) : parseDecisionV2(rawDecision, runId, paths.runDir);
    if (decision) return decision;
    const rawStatus = await readBrokerJson(paths.brokerStatusPath);
    const status = protocolVersion === 3 ? parseBrokerStatusV3(rawStatus, runId) : parseBrokerStatusV2(rawStatus, runId);
    if (status?.phase === "failed") throw new Error(`Launch broker failed: ${"errorCode" in status ? status.errorCode : "unknown"}.`);
    sawReady ||= status?.writer === "broker" && status.phase === "ready";
    if (brokerExited) {
      const rawAllocation = await readBrokerJson(paths.allocationPath);
      const allocation = protocolVersion === 3 ? parseAllocationRecordV3(rawAllocation, runId) : parseAllocationRecordV2(rawAllocation, runId);
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
  await publishImmutableJson(paths.decisionPath, { version: protocolVersion, runId, kind: "cancel", decidedAt: Date.now(), reason });
  const rawWinner = await readBrokerJson(paths.decisionPath);
  const winner = protocolVersion === 3 ? parseDecisionV3(rawWinner, runId, paths.runDir) : parseDecisionV2(rawWinner, runId, paths.runDir);
  if (winner?.kind === "commit") return winner;
  if (!winner) throw new Error(`Launch broker ${reason}; decision publication could not be verified.`);
  throw new Error(`Launch broker ${reason}.`);
}

async function publishParentCompletion(
  paths: RunArtifactPaths,
  runId: string,
  status: "failed" | "aborted",
  errorCode: "parent-aborted" | "wrapper-exited" | "pane-missing" | "inspect-exhausted" | "launch-failed",
  expectedSessionIdentity?: SessionFileIdentity,
): Promise<{ completion: CompletionRecord; won: boolean }> {
  return await publishParentObserverCompletion(paths, runId, status, errorCode, expectedSessionIdentity, fileExists);
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

  let piVersionProof: InteractivePiVersionProof;
  try {
    piVersionProof = await ensureInteractivePiVersion();
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
  const effectiveCwd = path.resolve(options.taskCwd ?? options.cwd);
  const brokerRuntime = resolveBrokerRuntime(process.env);
  // A selected runtime can be an env-shebang shim. Record the interpreter
  // that will actually execute it; for a native Bun/Node runtime this is the
  // selected runtime itself, not the parent Pi executable.
  const runtimeInterpreter = brokerRuntime ? resolveRuntimeInterpreter(brokerRuntime, process.env) : null;
  // Phase 1 cmux never resolves or spawns the bundled CLI. The runtime path is
  // retained only as a regular-file protocol placeholder for legacy V2 fields;
  // all cmux operations use the persistent control-v2 UDS manager below.
  const backendExecutable = backend.mode === "cmux-pane" ? brokerRuntime : resolveBackendExecutable(backend.mode, process.env);
  const backendGeneration = backendExecutable ? readExecutableGeneration(backendExecutable) : null;
  const brokerRuntimeGeneration = brokerRuntime ? readExecutableGeneration(brokerRuntime) : null;
  const runtimeInterpreterGeneration = runtimeInterpreter ? readExecutableGeneration(runtimeInterpreter) : null;
  const brokerEntrypoint = resolveRegularFile(BROKER_ENTRYPOINT, false);
  const brokerEntrypointGeneration = brokerEntrypoint ? readExecutableGeneration(brokerEntrypoint, false) : null;
  if (!brokerRuntime || !runtimeInterpreter || !backendExecutable || !backendGeneration || !brokerRuntimeGeneration || !runtimeInterpreterGeneration || !brokerEntrypoint || !brokerEntrypointGeneration) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = "Interactive pane mode requires an available broker runtime, broker entrypoint, and backend executable.";
    result.stderr = result.errorMessage;
    return result;
  }

  const cmuxControlManager = backend.mode === "cmux-pane" ? getCmuxControlRequestManager({ env: process.env }) : null;
  let backendRun = backend.mode === "cmux-pane"
    ? createCmuxControlCommandRunner({ manager: cmuxControlManager! }) as BackendCommandRunner
    : createBackendCommandRunner(backend.mode, backendExecutable, backendGeneration);
  backend = bindInteractiveBackend(backend, backendExecutable, backendGeneration, cmuxControlManager ? backendRun : undefined);
  // Never let durable cleanup inherit a later active-pool backend rebinding.
  const durableCleanupBackend = backend;
  let paths: RunArtifactPaths | null = null;
  let handle: InteractivePaneHandle | null = null;
  let inheritedApiKeyAgentDir: string | null = null;
  let leaseWriter: ReturnType<typeof startParentLeaseWriter> | null = null;
  // Parent runs sharing the same full physical authority lease one process-local
  // control client. Detached broker/reaper clients remain intentionally separate.
  let tmuxParentLease: TmuxControlLease | null = null;
  let tmuxReconnectPending = false;
  let removeTmuxDisconnectListener: (() => void) | null = null;
  let cmuxFocusSupported = false;
  let herdrSubscription: HerdrPaneSubscription | null = null;
  let herdrAgentWaitFallback: ReturnType<typeof createHerdrAgentWaitFallback> | null = null;
  const herdrWakeWaiters = new Set<() => void>();
  const signalHerdrWake = () => { for (const wake of [...herdrWakeWaiters]) wake(); herdrWakeWaiters.clear(); };
  const waitForHerdrWake = async (timeoutMs: number): Promise<void> => await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); herdrWakeWaiters.delete(finish); resolve(); };
    const timer = setTimeout(finish, timeoutMs); herdrWakeWaiters.add(finish);
  });
  let releaseTmuxLaunchMutex: (() => void) | null = backend.mode === "tmux-pane" ? await acquireTmuxLaunchMutex(options.signal) : null;
  let releaseCmuxLaunchMutex: (() => void) | null = backend.mode === "cmux-pane" ? await acquireCmuxLaunchMutex(options.signal) : null;
  const releaseTmuxLaunch = () => { releaseTmuxLaunchMutex?.(); releaseTmuxLaunchMutex = null; };
  const releaseCmuxLaunch = () => { releaseCmuxLaunchMutex?.(); releaseCmuxLaunchMutex = null; };
  // Terminal authority and terminal target cleanup must not race a late lease
  // rename. Stop scheduling synchronously, then retain one drain promise: a
  // timed-out caller never starts a second lease writer drain behind the first.
  let leaseWriterDrain: Promise<void> | null = null;
  let terminalPreparationTimedOut = false;
  const stopLeaseWriterAndDrain = async (): Promise<boolean> => {
    const writer = leaseWriter;
    if (writer) {
      leaseWriter = null;
      writer.stop();
      leaseWriterDrain ??= writer.stopAndDrain();
    }
    if (!leaseWriterDrain) return true;
    return await Promise.race([
      leaseWriterDrain.then(() => true, () => false),
      delay(INTERACTIVE_TERMINAL_PUBLICATION_WAIT_MS).then(() => false),
    ]);
  };
  const publishTerminalParentCompletion = async (
    terminalPaths: RunArtifactPaths,
    runId: string,
    status: "failed" | "aborted",
    errorCode: "parent-aborted" | "wrapper-exited" | "pane-missing" | "inspect-exhausted" | "launch-failed",
  ) => {
    let queued: Promise<{ completion: CompletionRecord; won: boolean } | null> | undefined;
    await withInteractiveFenceMutex(() => {
      const active = activeInteractiveRuns.get(runId);
      // Reserve the terminal operation while identity/ownership are known
      // synchronously. Reuse one in-flight operation so repeated abnormal
      // observations cannot accumulate behind a stalled result FIFO.
      if (!active || (active.ownership !== "managed" && active.ownership !== "kept")) return;
      if (active.pendingTerminalPublication) { queued = active.pendingTerminalPublication; return; }
      queued = serializeInteractiveRun(active, async () => {
        const authorized = await withInteractiveFenceMutex(() => activeInteractiveRuns.get(runId) === active
          && (active.ownership === "managed" || active.ownership === "kept"));
        if (!authorized) return null;
        if (!await stopLeaseWriterAndDrain()) { terminalPreparationTimedOut = true; return null; }
        // Fence, ACK, and boundary capture occupy one result-mutation FIFO
        // slot. A stalled preceding result operation cannot retain the global
        // fence or block unrelated runs.
        return await serializeResultMutation(async () => {
          if (completionFenceInvalid) throw new Error("completion fence authority is malformed");
          try {
            const fence = await publishAndVerifyCompletionFence(terminalPaths, runId, completionFenceNonce);
            await publishAndVerifyCompletionFenceAck(terminalPaths, fence);
            completionFenced = true;
          } catch (error) {
            if (error instanceof CompletionFenceAuthorityError) {
              completionFenced = true;
              completionFenceInvalid = true;
            }
            throw error;
          }
          return await publishParentCompletion(terminalPaths, runId, status, errorCode, sessionIdentity ?? undefined);
        });
      });
      active.pendingTerminalPublication = queued;
      void queued.finally(() => {
        if (active.pendingTerminalPublication === queued) active.pendingTerminalPublication = undefined;
      }).catch(() => undefined);
    });
    return await queued ?? null;
  };
  let completedNormally = false;
  let preserveDiagnostics = false;
  let retainRecoveryMetadata = false;
  let targetConfirmedAbsent = false;
  let committedRunId: string | null = null;
  let skipFinalRelease = false;
  let lifecycleRunId: string | null = null;
  let sessionResultStartOffset = 0;
  let sessionIdentity: SessionFileIdentity | null = null;
  let tailState: ReturnType<typeof createSessionTailState> | null = null;
  let appliedCompletion: CompletionRecord | null = null;
  let completionFenced = false;
  let completionFenceInvalid = false;
  // Parent-generated, child-private capability. It is never persisted in logs
  // or public active-run snapshots.
  const completionFenceNonce = crypto.randomBytes(32).toString("hex");
  // A final verified replay resets the result and tail accounting. Keep every
  // ordinary drain and every caller (including shutdown) behind one FIFO so a
  // drain that began before a terminal winner cannot later overwrite it.
  const resultMutationQueue = createInteractiveResultMutationQueue();
  const serializeResultMutation = resultMutationQueue.run;
  const applyCompletionWinner = async (completion: CompletionRecord): Promise<boolean> => await serializeResultMutation(async () => {
    if (!paths || !sessionIdentity) return false;
    if (appliedCompletion) return sameCompletionWinner(appliedCompletion, completion);
    const verified = await applyVerifiedInteractiveCompletion({
      result, completion, childSessionPath: paths.childSessionPath, sessionResultStartOffset,
      configuredModel: options.modelOverride ?? options.agent.model, onUpdate: options.onUpdate,
      expectedSessionIdentity: sessionIdentity,
    });
    if (verified) appliedCompletion = completion;
    return verified;
  });
  /** Fence callbacks under the same FIFO as incremental drains and final replay. */
  const fenceCallbacksForCompletion = async (publishIfMissing: boolean): Promise<"none" | "fenced" | "cancelled" | "invalid" | "timed-out"> => await serializeResultMutation(async () => {
    if (completionFenceInvalid) return "invalid";
    if (completionFenced) return "fenced";
    if (!paths) return "invalid";
    let fence;
    try {
      fence = publishIfMissing
        ? await publishAndVerifyCompletionFence(paths, path.basename(paths.runDir), completionFenceNonce)
        : await readVerifiedCompletionFence(paths, path.basename(paths.runDir), completionFenceNonce);
    } catch (error) {
      if (error instanceof CancellationFenceAuthorityError) return "cancelled";
      if (!(error instanceof CompletionFenceAuthorityError)) throw error;
      completionFenced = true;
      completionFenceInvalid = true;
      return "invalid";
    }
    if (!fence) return "none";
    // A child-origin fence may arrive while a scheduled lease renewal is still
    // waiting to rename. It must be fully drained before this ACK closes the
    // child's callback boundary, just like parent-origin terminal publication.
    if (!await stopLeaseWriterAndDrain()) {
      terminalPreparationTimedOut = true;
      return "timed-out";
    }
    try {
      await publishAndVerifyCompletionFenceAck(paths, fence);
      completionFenced = true;
      return "fenced";
    } catch (error) {
      if (!(error instanceof CompletionFenceAuthorityError)) throw error;
      completionFenced = true;
      completionFenceInvalid = true;
      return "invalid";
    }
  });
  try {
    const parentStartedAt = getCurrentProcessStartedAt();
    if (parentStartedAt === null) throw new Error("Unable to establish parent process start identity.");
    paths = await prepareRunArtifactPaths({ rootDir: options.runStateRoot, runId: options.forkChildId, initialParentLease: { parentPid: process.pid, parentStartedAt } });
    if (paths.rootDir !== options.runStateRoot || await fs.promises.realpath(paths.rootDir) !== options.runStateRoot) {
      throw new Error("Interactive run state root does not match the validated child root.");
    }
    await assertSafeRunArtifactPaths(paths);
    const runPaths = paths;
    const runId = path.basename(paths.runDir);
    // Publish liveness immediately after the private run directory marker, before
    // prompt/session writes or backend preflight can stall.
    leaseWriter = startParentLeaseWriter({ filePath: runPaths.parentLeasePath, runId, parentStartedAt });
    await leaseWriter.renew();
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
    // Bind this parent to the just-created child transcript before any child
    // can append. This private inode/device tuple is never protocol data.
    sessionIdentity = await getSessionFileIdentity(paths.childSessionPath);
    if (!sessionIdentity) throw new Error("Unable to establish child session file identity.");
    sessionResultStartOffset = options.delegationMode === "fork" ? Buffer.byteLength(initialChildSessionJsonl, "utf8") : 0;
    let forkBootstrapPath: string | undefined;
    if (options.forkSourceOwnership && options.forkChildId && options.forkSessionSnapshotJsonl !== undefined) {
      const inheritedLength = Buffer.byteLength(options.forkSessionSnapshotJsonl, "utf8");
      await options.forkSourceOwnership.writeBootstrap(options.forkChildId, {
        sessionPath: paths.childSessionPath,
        inheritedOffset: Buffer.byteLength(initialChildSessionJsonl, "utf8") - inheritedLength,
        inheritedLength,
      });
      forkBootstrapPath = path.join(options.forkSourceOwnership.paths.childrenDir, options.forkChildId, "bootstrap.json");
    }
    await atomicWriteJson(paths.statePath, {
      version: RUN_PROTOCOL_VERSION,
      runId: path.basename(paths.runDir),
      sequence: 0,
      phase: "starting",
      updatedAt: Date.now(),
      lastEvent: "parent_prepare",
    });

    inheritedApiKeyAgentDir = await prepareInheritedApiKeyAgentDir(options.inheritedApiKeyBinding);

    const piArgs = buildInteractivePiArgs(
      options.agent,
      options.agent.systemPrompt.trim() ? paths.systemPromptPath : null,
      paths.taskPath,
      paths.childSessionPath,
      options.modelOverride,
    );
    applyChildProjectIsolation(piArgs, effectiveCwd);

    // Allocation stays broker-owned until immutable commit. New runs always
    // publish a layout intent; legacy split intents are not used here.
    let source: any;
    let cmuxControlTransport: any;
    let tmuxSourceTopology: any;
    let tmuxTransportGate: ReturnType<typeof parseTmuxControlTransportGate> = null;
    let revalidateTmuxSource: (() => Promise<boolean>) | null = null;
    if (backend.mode === "cmux-pane") {
      if (options.interactivePaneLayout === "auto") {
        await launchPreflightSingleFlight.read(
          `cmux-support:${options.interactiveShutdownGeneration}:${executableGenerationKey(backendGeneration)}`,
          async () => await assertCmuxLayoutSupport(backendRun),
        );
      }
      let handshake: Awaited<ReturnType<NonNullable<typeof cmuxControlManager>["ensureReady"]>>;
      try { handshake = await cmuxControlManager!.ensureReady(); cmuxFocusSupported = handshake.methods.includes("surface.focus"); }
      catch (error) {
        const diagnostic = diagnoseCmuxControlError(error);
        const state = diagnostic.state ? ` state=${diagnostic.state}` : "";
        throw new CmuxSourcePreflightError(`cmux control-v2 handshake failed: exit=1 control=${diagnostic.code}${state} parser=not-run`, 1, diagnostic.code, "not-run");
      }
      // Phase 4 uses a separately authenticated stream connection. Unsupported
      // servers keep the request path fully functional without pretending
      // that events are completion or cleanup authority.
      const connection = cmuxControlManager!.identity();
      if (!connection) throw new Error("cmux control-v2 connection identity is unavailable.");
      const identifyDigest = crypto.createHash("sha256").update(JSON.stringify(handshake.identify, Object.keys(handshake.identify).sort())).digest("hex");
      await ensureCmuxEvents({ connection, appVersion: handshake.detectedAppVersion, identifyDigest });
      cmuxControlTransport = { transport: "cmux-control-v2", socketPath: connection.socketPath, socketDev: connection.socketDev, socketIno: connection.socketIno, accessMode: handshake.access_mode, apiVersion: 2, appVersion: handshake.detectedAppVersion, identifyDigest,
        ...(typeof handshake.identify.boot_id === "string" ? { bootIdentity: handshake.identify.boot_id } : {}) };
      const configured = { workspaceId: process.env.CMUX_WORKSPACE_ID!.trim(), sourceSurfaceId: process.env.CMUX_SURFACE_ID!.trim() };
      const resolved = await resolveSharedCmuxSourcePreflight({
        run: backendRun,
        singleFlight: launchPreflightSingleFlight,
        shutdownGeneration: options.interactiveShutdownGeneration,
        socketGeneration: connection,
        workspaceId: configured.workspaceId,
        surfaceId: configured.sourceSurfaceId,
        getTopologyGeneration: () => topologyMutationGeneration,
        isShutdownCurrent: () => canStartInteractiveRun(options.interactiveShutdownGeneration),
        isSocketGenerationCurrent: async () => {
          try {
            const current = await cmuxControlManager!.assertCurrentIdentity();
            return current?.socketPath === connection.socketPath && current.socketDev === connection.socketDev && current.socketIno === connection.socketIno;
          } catch { return false; }
        },
      });
      source = { workspaceId: resolved.workspaceId, sourceSurfaceId: resolved.surfaceId };
      cmuxLayoutRunners.set(cmuxLayoutRunnerKey(source.workspaceId), backendRun);
    } else if (backend.mode === "tmux-pane") {
      const identity = parseTmuxEnvironment();
      if (!identity) throw new Error("tmux pane mode requires valid inherited tmux identity.");
      const launchIdentity = readTmuxLaunchIdentity(identity.socketPath, identity.serverPid);
      if (!launchIdentity) throw new Error("tmux source socket or server process identity cannot be established for preflight.");
      const socketKey = `${launchIdentity.socket.realpath}:${launchIdentity.socket.dev}:${launchIdentity.socket.ino}`;
      const sourcePreflight = await launchPreflightSingleFlight.read(
        `tmux-source:${options.interactiveShutdownGeneration}:${executableGenerationKey(backendGeneration)}:${socketKey}:${identity.serverPid}:${launchIdentity.serverStartedAt}:${identity.paneId}`,
        async () => {
          const server = await backendRun(buildTmuxServerPidArgs(identity.socketPath));
          const probe = await backendRun(buildTmuxSourcePaneProbeArgs(identity.socketPath));
          const sourcePid = parseTmuxSourcePaneProbe(probe.stdout, identity.paneId);
          const topology = await readTmuxSourceTopology({ sourcePaneId: identity.paneId, socketPath: identity.socketPath, run: backendRun });
          if (server.exitCode !== 0 || parseTmuxServerPidOutput(server.stdout) !== identity.serverPid
            || probe.exitCode !== 0 || sourcePid === null || !topology) {
            throw new Error("tmux source pane topology is unavailable.");
          }
          return { sourcePid, topology };
        },
      );
      const generation = { socketPath: launchIdentity.socket.realpath, socketDev: launchIdentity.socket.dev, socketIno: launchIdentity.socket.ino, serverStartedAt: launchIdentity.serverStartedAt };
      source = { socketPath: launchIdentity.socket.realpath, sourcePaneId: identity.paneId, sourcePanePid: sourcePreflight.sourcePid, serverPid: identity.serverPid, generation };
      tmuxSourceTopology = { kind: "tmux-source-pane", socketPath: launchIdentity.socket.realpath, serverPid: identity.serverPid, paneId: sourcePreflight.topology.paneId, panePid: sourcePreflight.sourcePid, sessionId: sourcePreflight.topology.sessionId, windowId: sourcePreflight.topology.windowId, generation };
      revalidateTmuxSource = async () => {
        if (!sameTmuxLaunchIdentity(launchIdentity, identity.socketPath, identity.serverPid)) return false;
        const [server, probe, topology] = await Promise.all([
          backendRun(buildTmuxServerPidArgs(identity.socketPath)),
          backendRun(buildTmuxSourcePaneProbeArgs(identity.socketPath)),
          readTmuxSourceTopology({ sourcePaneId: identity.paneId, socketPath: identity.socketPath, run: backendRun }),
        ]);
        return server.exitCode === 0 && parseTmuxServerPidOutput(server.stdout) === identity.serverPid
          && probe.exitCode === 0 && parseTmuxSourcePaneProbe(probe.stdout, identity.paneId) === sourcePreflight.sourcePid
          && topology !== null && topology.paneId === sourcePreflight.topology.paneId
          && topology.sessionId === sourcePreflight.topology.sessionId && topology.windowId === sourcePreflight.topology.windowId;
      };
      if (!await revalidateTmuxSource()) throw new Error("tmux source changed after shared preflight.");
      const candidateGate = await createTmuxControlTransportGate({
        runId,
        executable: backendExecutable,
        socketPath: launchIdentity.socket.realpath,
        sourcePaneId: identity.paneId,
        serverStartedAt: launchIdentity.serverStartedAt,
        run: backendRun,
      }).catch((error) => { if (error instanceof TmuxControlVersionError) throw error; return null; });
      if (candidateGate
        && candidateGate.probeResult.serverPid === identity.serverPid
        && candidateGate.probeResult.sourcePanePid === sourcePreflight.sourcePid
        && candidateGate.probeResult.attachedSessionId === sourcePreflight.topology.sessionId
        && candidateGate.canonicalSocketPath === launchIdentity.socket.realpath) {
        // Once immutable V3 evidence publication begins, errors fail closed;
        // fallback is allowed only before any transport authority exists.
        tmuxTransportGate = await publishTmuxControlTransportGate(runPaths.transportGatePath, candidateGate);
      }
    } else {
      const configured = parseHerdrEnvironment(process.env);
      if (!configured) throw new Error("Herdr pane mode requires a complete Herdr environment.");
      // `resolveHerdrCallerPane` negotiates protocol 19/20 and records the live
      // binding, rather than trusting an environment address that may move.
      const live = await resolveHerdrCallerPane(process.env);
      if (!live) throw new Error("Herdr source pane is unavailable or no longer matches its configured workspace/tab binding.");
      source = { socketPath: live.socketPath, workspaceId: live.workspaceId, tabId: live.tabId, sourcePaneId: live.paneId, sourceTerminalId: live.terminalId, protocol: live.protocol, generation: { socketDev: live.socketDev, socketIno: live.socketIno } };
    }

    const tmuxControlEnabled = backend.mode === "tmux-pane" && tmuxTransportGate !== null;
    let committedIntent: ReturnType<typeof parseLaunchIntentV2> | LaunchIntentV3 = null;
    let committedAfterFence = false;
    // Keep the full durable V2 record as authority. The layout coordinator
    // receives only its narrow cmux adoption DTO and must not replace this.
    let committedAllocation: AllocationRecordV2 | AllocationRecordV3 | null = null;
    let committedDecision: ReturnType<typeof parseDecisionV2> | DecisionV3 = null;
    const createAndCommit = async (request: any) => {
      // This is immediately before the broker crosses its allocation boundary.
      if (!canStartInteractiveRun(options.interactiveShutdownGeneration)) {
        throw new Error("Interactive session shutdown fenced this run before broker allocation.");
      }
      if (!sameExecutableGeneration(backendGeneration, readExecutableGeneration(backendExecutable))
        || !sameExecutableGeneration(brokerRuntimeGeneration, readExecutableGeneration(brokerRuntime))
        || !sameExecutableGeneration(runtimeInterpreterGeneration, readExecutableGeneration(runtimeInterpreter))
        || !sameExecutableGeneration(brokerEntrypointGeneration, readExecutableGeneration(brokerEntrypoint, false))) {
        throw new Error("Interactive executable changed after read-only preflight.");
      }
      if (revalidateTmuxSource && !await revalidateTmuxSource()) {
        throw new Error("tmux source changed before launch intent publication.");
      }
      const tmuxControlV3 = tmuxControlEnabled;
      if (tmuxControlV3 && !tmuxTransportGate) throw new Error("tmux control transport gate is unavailable.");
      const transportGateDigest = tmuxControlV3 ? await exactArtifactDigest(runPaths.transportGatePath) : null;
      if (tmuxControlV3 && !transportGateDigest) throw new Error("tmux control transport gate digest is unavailable.");
      const intent = {
        version: tmuxControlV3 ? 3 : 2, runId, parentRunId: process.env[SUBAGENT_RUN_ID_ENV]?.trim() || undefined,
        parentSessionId: options.parentSessionId ?? "unknown", parentPid: process.pid, parentStartedAt, terminalMode: backend.mode, source,
        layout: request.layout, placement: request.placement, container: request.container,
        ...(backend.mode === "tmux-pane" && request.placement === "tmux-new-window" ? { windowLabel: buildTmuxWindowLabel(result.agent, runId) } : {}),
        ...(backend.mode === "herdr-pane" && request.placement === "herdr-new-tab" ? { tabLabel: buildHerdrTabLabel(result.agent, runId) } : {}),
        ...(backend.mode === "cmux-pane" ? { control: cmuxControlTransport } : tmuxControlV3 ? {
          transport: "tmux-control-v1", transportGatePath: runPaths.transportGatePath, transportGateDigest,
        } : {}),
        childSessionFile: runPaths.childSessionPath,
        ...(backend.mode === "herdr-pane" && (request.placement === "herdr-new-tab" || request.placement === "herdr-split") ? { workingDirectory: effectiveCwd } : {}),
        createdAt: Date.now(),
        brokerNonce: crypto.randomBytes(32).toString("base64url"), runtimePath: brokerRuntime,
        runtimeInterpreterPath: runtimeInterpreter, backendPath: backendExecutable, brokerEntrypoint,
      };
      const validatedIntent = tmuxControlV3
        ? parseLaunchIntentV3(intent, runId, runPaths.runDir)
        : parseLaunchIntentV2(intent, runId, runPaths.runDir);
      if (!validatedIntent) throw new Error("Interactive layout launch intent failed validation.");
      if (await publishImmutableJson(runPaths.launchIntentPath, intent) !== "published") throw new Error("Interactive launch intent already exists.");
      const runLifecycleServer = await getLifecycleEventServer();
      let lifecycleProtocolEnv: Record<string, string> = {};
      if (runLifecycleServer) {
        const lifecycleToken = runLifecycleServer.registerRun(runId);
        lifecycleRunId = runId;
        await writeLifecycleBootstrapToken(runPaths.lifecycleTokenPath, lifecycleToken);
        lifecycleProtocolEnv = {
          [SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: runLifecycleServer.socketPath,
          [SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: runPaths.lifecycleTokenPath,
        };
      }
      const protocolEnv = {
        [RUN_STATE_DIR_ENV]: options.runStateRoot,
        [SUBAGENT_RUN_ID_ENV]: runId, ...(forkBootstrapPath ? { [SUBAGENT_FORK_BOOTSTRAP_PATH_ENV]: forkBootstrapPath } : {}), [SUBAGENT_RUN_STATE_PATH_ENV]: runPaths.statePath,
        [SUBAGENT_RUN_COMPLETION_PATH_ENV]: runPaths.completionPath,
        [SUBAGENT_COMPLETION_FENCE_PATH_ENV]: runPaths.completionFencePath, [SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV]: runPaths.completionFenceAckPath,
        [SUBAGENT_COMPLETION_FENCE_NONCE_ENV]: completionFenceNonce, [SUBAGENT_PARENT_LEASE_PATH_ENV]: runPaths.parentLeasePath,
        [SUBAGENT_CHILD_SESSION_PATH_ENV]: runPaths.childSessionPath, [SUBAGENT_RUN_OWNERSHIP_ENV]: "parent-owned",
        [SUBAGENT_PROMOTION_REQUEST_PATH_ENV]: runPaths.promotionRequestPath, [SUBAGENT_PROMOTION_ACK_PATH_ENV]: runPaths.promotionAckPath,
        // Explicitly negotiate these extensions: rolling older parents reject
        // failure session keys and success boundaries ending in metadata tails.
        [SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV]: V3_FAILURE_BOUNDARY_CAPABILITY,
        [SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV]: V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY,
        [SUBAGENT_LEASE_STALE_MS_ENV]: String(DEFAULT_PARENT_LEASE_STALE_MS),
        ...(process.env[SUBAGENT_LEASE_CHECK_MS_ENV] !== undefined ? { [SUBAGENT_LEASE_CHECK_MS_ENV]: process.env[SUBAGENT_LEASE_CHECK_MS_ENV]! } : {}),
        [SUBAGENT_EXPECTED_PARENT_PID_ENV]: String(intent.parentPid), [SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV]: String(intent.parentStartedAt),
        ...lifecycleProtocolEnv,
      };
      const childEnv = buildChildProcessEnv({
        agentName: result.agent, parentDepth: options.parentDepth, parentAgentStack: options.parentAgentStack,
        maxDepth: options.maxDepth, maxActive: options.maxActive, limits: options.limits, preventCycles: options.preventCycles, interactivePaneLayout: options.interactivePaneLayout,
        trustedProjectRoots: options.trustedProjectRoots, deniedProjectRoots: options.deniedProjectRoots,
        inheritedApiKeyBinding: options.inheritedApiKeyBinding, inheritedApiKeyAgentDir, phase0LiveProofEnv: options.phase0LiveProofEnv,
        baseEnv: backend.mode === "tmux-pane" ? { ...process.env, [TMUX_BIN_ENV]: backendExecutable } : process.env, runProtocolEnv: protocolEnv,
        treePermitEnv: buildTreePermitChildEnv(options.treePermitLease, options.runStateRoot),
      });
      await writePrivateFile(runPaths.secretEnvPath, buildPrivateChildEnvironmentScript(childEnv));
      if (!isInteractivePiVersionProofCurrent(piVersionProof)) throw new Error("Pi executable changed after version preflight.");
      const { command, prefixArgs } = piVersionProof;
      await writePrivateExecutableFile(runPaths.wrapperPath, buildInteractivePaneWrapperScript({
        effectiveCwd, childCommand: [command, ...prefixArgs, ...piArgs], exportedEnv: {}, secretEnvPath: runPaths.secretEnvPath,
        wrapperStatusPath: runPaths.wrapperStatusPath,
        cleanupDirs: inheritedApiKeyAgentDir ? [inheritedApiKeyAgentDir] : undefined,
        surfaceTitle: childEnv[SUBAGENT_MANAGED_TITLE_ENV],
        treePermitBootstrapPath: options.treePermitLease ? path.join(runPaths.runDir, "tree-permit-bootstrap.json") : undefined,
        ...(backend.mode === "herdr-pane" && request.placement === "herdr-new-tab" ? { herdrDirectGate: {
          runtime: brokerRuntime, entrypoint: brokerEntrypoint, runDir: runPaths.runDir, nonce: intent.brokerNonce,
          runtimeInterpreter, backend: backendExecutable,
        } } : {}),
      }));
      if (!canStartInteractiveRun(options.interactiveShutdownGeneration)) {
        throw new Error("Interactive session shutdown fenced this run before broker allocation.");
      }
      if (options.signal?.aborted) throw new Error("Interactive launch was aborted before broker allocation.");
      const brokerEnvironment = buildBrokerEnvironment(process.env, backend.mode, backendExecutable);
      // The detached broker follows these exact paths. Revalidate every
      // executable/script generation immediately before the irreversible spawn.
      if (!sameExecutableGeneration(backendGeneration, readExecutableGeneration(backendExecutable))
        || !sameExecutableGeneration(brokerRuntimeGeneration, readExecutableGeneration(brokerRuntime))
        || !sameExecutableGeneration(runtimeInterpreterGeneration, readExecutableGeneration(runtimeInterpreter))
        || !sameExecutableGeneration(brokerEntrypointGeneration, readExecutableGeneration(brokerEntrypoint, false))
        || !isInteractivePiVersionProofCurrent(piVersionProof)
        || (revalidateTmuxSource !== null && !await revalidateTmuxSource())) {
        throw new Error("Interactive launch authority changed before broker spawn.");
      }
      advanceTopologyMutationGeneration();
      // Run state is configurable and may be nested under the task project.
      // The broker is Bun/Node code, so never let that ancestry select bunfig.
      const brokerBootstrapCwd = path.parse(runPaths.runDir).root;
      if (!path.isAbsolute(brokerBootstrapCwd) || path.normalize(brokerBootstrapCwd) !== brokerBootstrapCwd) throw new Error("Interactive broker bootstrap cwd is unsafe.");
      const broker = spawn(brokerRuntime, [brokerEntrypoint, "--run-dir", runPaths.runDir, "--nonce", intent.brokerNonce, "--runtime", brokerRuntime, "--runtime-interpreter", runtimeInterpreter, "--backend", backendExecutable], {
        cwd: brokerBootstrapCwd, detached: true, stdio: "ignore", windowsHide: true, env: brokerEnvironment,
      });
      broker.unref();
      const decision = await waitForBrokerDecision(runPaths, runId, options.signal, broker, tmuxControlV3 ? 3 : 2);
      advanceTopologyMutationGeneration();
      if (decision?.kind !== "commit") throw new Error("Interactive launch was cancelled before commit.");
      // Commit may have raced the fence. Continue only far enough to bind its
      // exact recorded target; registration below rejects and tracks cleanup.
      committedAfterFence ||= !canStartInteractiveRun(options.interactiveShutdownGeneration);
      const rawCommittedIntent = await readBrokerJson(runPaths.launchIntentPath);
      const rawCommittedAllocation = await readBrokerJson(runPaths.allocationPath);
      const rawCommittedDecision = await readBrokerJson(runPaths.decisionPath);
      committedIntent = tmuxControlV3
        ? parseLaunchIntentV3(rawCommittedIntent, runId, runPaths.runDir)
        : parseLaunchIntentV2(rawCommittedIntent, runId, runPaths.runDir);
      committedAllocation = tmuxControlV3
        ? parseAllocationRecordV3(rawCommittedAllocation, runId)
        : parseAllocationRecordV2(rawCommittedAllocation, runId);
      committedDecision = tmuxControlV3
        ? parseDecisionV3(rawCommittedDecision, runId, runPaths.runDir)
        : parseDecisionV2(rawCommittedDecision, runId, runPaths.runDir);
      const validCommittedAuthority = tmuxControlV3
        ? committedIntent !== null && committedIntent.version === 3 && committedAllocation !== null && committedAllocation.version === 3
          && committedDecision?.version === 3 && committedDecision.kind === "commit"
          && hasAllocationIntentSourceBinding(committedIntent as any, committedAllocation as any)
          && await hasValidTmuxControlChain({ runDir: runPaths.runDir, intent: committedIntent, allocation: committedAllocation })
        : committedIntent !== null && committedIntent.version === 2 && allocationMatchesInteractiveBackend(committedAllocation as AllocationRecordV2 | null, backend.mode)
          && hasAllocationIntentSourceBinding(committedIntent, committedAllocation as AllocationRecordV2)
          && committedDecision?.version === 2 && committedDecision.kind === "commit"
          && hasValidV2StateDependencies({ allocation: committedAllocation as AllocationRecordV2, decision: committedDecision, launch: null, gate: null });
      if (!validCommittedAuthority) {
        retainRecoveryMetadata = true;
        throw new Error("Committed allocation authority does not match the selected terminal backend source.");
      }
      // Keep this explicit recheck adjacent to durable commit; outer adoption
      // still reaches registerCommitted... so its cleanup is tracked.
      committedAfterFence ||= !canStartInteractiveRun(options.interactiveShutdownGeneration);
      return committedAllocation!.terminalMode === "cmux-pane"
        ? cmuxRecordToCommittedLayoutAllocation(committedAllocation as AllocationRecordV2)
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
    } else if (backend.mode === "tmux-pane") {
      const request = selectTmuxInteractivePlacement({ layout: options.interactivePaneLayout, source, sourceTopology: tmuxSourceTopology });
      await createAndCommit(request);
    } else {
      await createAndCommit(options.interactivePaneLayout === "auto"
        ? { layout: "auto", placement: "herdr-new-tab", container: { kind: "herdr-workspace", workspaceId: source.workspaceId } }
        : { layout: "split", placement: "herdr-split", container: { kind: "herdr-source", workspaceId: source.workspaceId, tabId: source.tabId, paneId: source.sourcePaneId, terminalId: source.sourceTerminalId } });
    }
    if (!committedAllocation) throw new Error("Committed allocation authority is missing.");
    handle = allocationToHandle(committedAllocation as AllocationRecordV2);
    const committedHandle = handle;
    committedRunId = runId;
    let durableTmuxCleanupRelease: (() => Promise<boolean>) | null = null;
    const committedRelease = makeInteractiveRelease(
      () => backend,
      committedHandle,
      cmuxLease,
      // Never fall back to the mutable active backend for tmux. Until the
      // independent authority is installed, retain the committed record for
      // shutdown/reaper recovery rather than issuing an unproven mutation.
      committedHandle.mode === "tmux-pane" ? async () => await (durableTmuxCleanupRelease?.() ?? false) : undefined,
    );
    // cmux is registered only after coordinator adoption; tmux has no shared
    // container state and is registered after the same committed binding.
    // Registration is the final exact generation/fence check before any gate.
    if (!registerCommittedInteractiveRun({
      runId, invocationId: options.invocationId, backend,
      // V3 UX must never use the pre-lease CLI binding captured at commit.
      // The resolver follows each accepted pooled lease rebind/reconnect and
      // returns unavailable while the lease is still proving a new epoch.
      ...(tmuxControlEnabled ? { uxBackend: () => tmuxParentLease?.acceptedTransport() ? backend : null } : {}),
      handle, paths: runPaths, agent: result.agent, depth: options.parentDepth + 1, focusSupported: backend.mode === "herdr-pane" || backend.mode === "cmux-pane" && cmuxFocusSupported, release: committedRelease, treePermitLease: options.treePermitLease,
      sessionIdentity, sessionResultStartOffset, applyCompletionWinner, stopLeaseWriterAndDrain,
      publishParentCompletion: async (status, errorCode) => await publishTerminalParentCompletion(runPaths, runId, status, errorCode),
      // Preserve the post-commit observation even if a reset races adoption.
      generation: committedAfterFence ? -1 : options.interactiveShutdownGeneration,
    })) {
      throw new Error("Interactive session shutdown fenced this committed run before launch.");
    }
    if (handle.mode === "herdr-pane") {
      const herdrHandle = handle.native;
      herdrAgentWaitFallback = createHerdrAgentWaitFallback({ handle: herdrHandle, onWake: signalHerdrWake });
      herdrSubscription = subscribeSharedHerdrPane({
        handle: herdrHandle,
        // All of these are presentation/wake hooks. They never determine
        // completion, cleanup, target authority, or fallback ownership.
        onReconcile: () => signalHerdrWake(),
        onReconcileTarget: (terminal) => updateHerdrRunPresentation(runId, {}, terminal),
        onWake: signalHerdrWake,
        onHealthChange: (healthy) => {
          herdrAgentWaitFallback?.sync(healthy);
          updateHerdrRunTransportPresentation(runId, healthy);
        },
      });
    }
    const releaseAfterCompletionWinner = async (completion: CompletionRecord): Promise<boolean> => {
      const active = activeInteractiveRuns.get(runId);
      if (!active) return false;
      const release = releaseActiveInteractiveRunAfterWinner({ runId, expectedRun: active, completion,
        waitForHerdrWake: async (timeoutMs) => await Promise.race([
          waitForHerdrWake(timeoutMs), runLifecycleServerWait(lifecycleEventServer, runId, timeoutMs),
        ]),
      });
      const settled = await awaitInteractiveBooleanBounded(release);
      if (!settled) finalizeBoundedInteractiveRelease(runId, active, release);
      return settled;
    };

    // Ownership is now active; only after registration may launch.json and the
    // one-way gate be reconciled and opened.
    const authorityIntent = committedIntent as ReturnType<typeof parseLaunchIntentV2> | LaunchIntentV3;
    const authorityAllocation = committedAllocation as AllocationRecordV2 | AllocationRecordV3 | null;
    const authorityDecision = committedDecision as ReturnType<typeof parseDecisionV2> | DecisionV3;
    let rawLaunch = await readBrokerJson(paths.launchPath);
    let launch: ReturnType<typeof parseCommittedLaunchRecordV2> | CommittedLaunchRecordV3 = tmuxControlEnabled
      ? parseCommittedLaunchRecordV3(rawLaunch, runId, paths.runDir)
      : parseCommittedLaunchRecordV2(rawLaunch, runId, paths.runDir);
    const launchDeadline = Date.now() + BROKER_READY_TIMEOUT_MS;
    while (!launch && Date.now() < launchDeadline) {
      await delay(POLL_INTERVAL_MS);
      rawLaunch = await readBrokerJson(paths.launchPath);
      launch = tmuxControlEnabled
        ? parseCommittedLaunchRecordV3(rawLaunch, runId, paths.runDir)
        : parseCommittedLaunchRecordV2(rawLaunch, runId, paths.runDir);
    }
    const validLaunchAuthority = tmuxControlEnabled
      ? authorityIntent?.version === 3 && authorityAllocation?.version === 3 && authorityDecision?.version === 3
        && authorityDecision.kind === "commit" && launch?.version === 3
        && await hasValidTmuxControlChain({ runDir: paths.runDir, intent: authorityIntent, allocation: authorityAllocation, launch })
      : hasCommittedInteractiveLaunchAuthority({
        intent: authorityIntent?.version === 2 ? authorityIntent : null,
        allocation: authorityAllocation?.version === 2 ? authorityAllocation : null,
        decision: authorityDecision?.version === 2 ? authorityDecision : null,
        launch: launch?.version === 2 ? launch : null,
        gate: null,
        mode: backend.mode,
      });
    if (!validLaunchAuthority) {
      retainRecoveryMetadata = true;
      throw new Error("Committed launch authority does not match the selected terminal backend.");
    }
    const publishedGate = await publishInteractiveLaunchGate({
      paths,
      runId,
      terminalMode: backend.mode,
      generation: options.interactiveShutdownGeneration,
      protocolVersion: tmuxControlEnabled ? 3 : 2,
      herdrProtocol: backend.mode === "herdr-pane" && authorityAllocation?.version === 2 && authorityAllocation.terminalMode === "herdr-pane"
        ? authorityAllocation.target.protocol : undefined,
    });
    if (lifecycleRunId) lifecycleEventServer?.activateRun(lifecycleRunId);
    const validGateAuthority = tmuxControlEnabled
      ? authorityIntent?.version === 3 && authorityAllocation?.version === 3 && authorityDecision?.version === 3
        && authorityDecision.kind === "commit" && launch?.version === 3 && publishedGate.version === 3
        && publishedGate.terminalMode === "tmux-pane"
        && await hasValidTmuxControlChain({ runDir: paths.runDir, intent: authorityIntent, allocation: authorityAllocation, launch })
      : hasCommittedInteractiveLaunchAuthority({
        intent: authorityIntent?.version === 2 ? authorityIntent : null,
        allocation: authorityAllocation?.version === 2 ? authorityAllocation : null,
        decision: authorityDecision?.version === 2 ? authorityDecision : null,
        launch: launch?.version === 2 ? launch : null,
        gate: publishedGate.version === 2 ? publishedGate : null,
        mode: backend.mode,
      });
    if (!validGateAuthority) {
      retainRecoveryMetadata = true;
      throw new Error("Interactive launch gate authority is malformed or belongs to another backend.");
    }
    if (backend.mode === "tmux-pane" && !options.treePermitLease) {
      const startupDeadline = Date.now() + 10_000;
      let startedState = parseRunState(await readBoundedPrivateJson(paths.statePath), runId);
      while ((!startedState || startedState.sequence < 1 || startedState.childPid === undefined) && Date.now() < startupDeadline) {
        await delay(25);
        startedState = parseRunState(await readBoundedPrivateJson(paths.statePath), runId);
      }
      if (!startedState || startedState.sequence < 1 || startedState.childPid === undefined) throw new Error("tmux child did not consume its launch gate before the startup deadline.");
      releaseTmuxLaunch();
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
      if (!options.treePermitLease) releaseCmuxLaunch();
    }
    let interactivePermitWrapperIdentity: { pid: number; startedAt: number } | null = null;
    if (options.treePermitLease) {
      const permitBootstrapPath = path.join(paths.runDir, "tree-permit-bootstrap.json");
      const startupDeadline = Date.now() + 10_000;
      let permitPid: number | null = null;
      while (permitPid === null && Date.now() < startupDeadline) {
        const value = await readBoundedPrivateJson(permitBootstrapPath);
        if (value && typeof value === "object" && !Array.isArray(value)
          && Object.keys(value).length === 1 && Number.isSafeInteger((value as { pid?: unknown }).pid)
          && ((value as { pid: number }).pid > 0)) permitPid = (value as { pid: number }).pid;
        if (permitPid === null) await delay(25);
      }
      const permitStartedAt = permitPid === null ? null : await getProcessStartedAtWithRetry(permitPid);
      if (permitPid === null || permitStartedAt === null || !await waitForStoppedProcess(permitPid, permitStartedAt)) {
        throw new Error("Interactive tree permit bootstrap did not stop with an exact process identity.");
      }
      interactivePermitWrapperIdentity = { pid: permitPid, startedAt: permitStartedAt };
      if (!await options.treePermitLease.bindChildIdentity(interactivePermitWrapperIdentity)) {
        throw new Error("Tree permit child process binding failed.");
      }
      if (!signalStoppedProcess(permitPid, permitStartedAt, "SIGCONT")) {
        throw new Error("Interactive child identity changed before tree permit continuation.");
      }
      await fs.promises.unlink(permitBootstrapPath).catch(() => undefined);
      if (backend.mode === "tmux-pane") releaseTmuxLaunch(); else releaseCmuxLaunch();
    }
    if ((options.forkSourceOwnership && options.forkChildId) || options.treePermitLease) {
      const startupDeadline = Date.now() + 10_000;
      let startedState = parseRunState(await readBoundedPrivateJson(paths.statePath), runId);
      while ((!startedState || startedState.childPid === undefined || startedState.childStartedAt === undefined) && Date.now() < startupDeadline) {
        await delay(25);
        startedState = parseRunState(await readBoundedPrivateJson(paths.statePath), runId);
      }
      if (!startedState || startedState.childPid === undefined || startedState.childStartedAt === undefined) {
        throw new Error("Child process identity was not durably published before the startup deadline.");
      }
      const piChildIdentity = { pid: startedState.childPid, startedAt: startedState.childStartedAt };
      if (options.treePermitLease && interactivePermitWrapperIdentity
        && (piChildIdentity.pid !== interactivePermitWrapperIdentity.pid || piChildIdentity.startedAt !== interactivePermitWrapperIdentity.startedAt)
        && !await options.treePermitLease.rebindChildIdentity(interactivePermitWrapperIdentity, piChildIdentity)) {
        throw new Error("Tree permit could not transfer from the wrapper to the Pi child identity.");
      }
      if (options.forkSourceOwnership && options.forkChildId) {
        await options.forkSourceOwnership.recordProcess(options.forkChildId, piChildIdentity);
      }
    }

    const activePaths = paths;
    const activeTmuxHandle = handle.mode === "tmux-pane" ? handle.native : null;
    if (tmuxControlEnabled && activeTmuxHandle) {
      if (!tmuxTransportGate || authorityIntent?.version !== 3) throw new Error("tmux control authority is unavailable after launch gate.");
      const expectedSourceWindowId = authorityIntent.container.kind === "tmux-source-pane"
        ? authorityIntent.container.windowId : authorityIntent.container.sourceWindowId;
      durableTmuxCleanupRelease = makeDurableTmuxCleanupRelease({
        backend: durableCleanupBackend,
        backendPath: backendExecutable,
        backendGeneration: backendGeneration!,
        paths: activePaths,
        runId,
        transportGateDigest: authorityIntent.transportGateDigest,
        handle: handle as Extract<InteractivePaneHandle, { mode: "tmux-pane" }>,
        expectedSourceWindowId,
      });
      const revalidateLeaseAuthority = async (run: TmuxCommandRunner): Promise<boolean> => {
        const currentGate = parseTmuxControlTransportGate(await readBrokerJson(activePaths.transportGatePath), runId);
        if (!currentGate || !isTmuxControlTransportGateCurrent(currentGate)
          || await exactArtifactDigest(activePaths.transportGatePath) !== authorityIntent.transportGateDigest
          || !sameExecutableGeneration(backendGeneration, readExecutableGeneration(backendExecutable))
          || !hasTmuxGeneration(activeTmuxHandle) || !isTmuxGenerationCurrent(activeTmuxHandle.generation, activeTmuxHandle.serverPid)) return false;
        const [server, sourceProbe, topology, target] = await Promise.all([
          run(buildTmuxServerPidArgs(currentGate.canonicalSocketPath)),
          run(buildTmuxSourcePaneProbeArgs(currentGate.canonicalSocketPath)),
          readTmuxSourceTopology({ sourcePaneId: currentGate.probeResult.sourcePaneId, socketPath: currentGate.canonicalSocketPath, run }),
          inspectTmuxPaneFingerprint(activeTmuxHandle, run),
        ]);
        return server.exitCode === 0 && parseTmuxServerPidOutput(server.stdout) === currentGate.probeResult.serverPid
          && sourceProbe.exitCode === 0 && parseTmuxSourcePaneProbe(sourceProbe.stdout, currentGate.probeResult.sourcePaneId) === currentGate.probeResult.sourcePanePid
          && topology !== null && topology.sessionId === currentGate.probeResult.attachedSessionId && topology.windowId === expectedSourceWindowId
          && target?.exists === true && target.panePid === activeTmuxHandle.panePid
          && isTmuxControlTransportGateCurrent(currentGate)
          && await exactArtifactDigest(activePaths.transportGatePath) === authorityIntent.transportGateDigest
          && sameExecutableGeneration(backendGeneration, readExecutableGeneration(backendExecutable))
          && isTmuxGenerationCurrent(activeTmuxHandle.generation, activeTmuxHandle.serverPid)
          && canStartInteractiveRun(options.interactiveShutdownGeneration);
      };
      tmuxParentLease = await acquireTmuxControlLease({
        authority: {
          controlContract: `${tmuxTransportGate.selectedTransport}:${tmuxTransportGate.fixtureContractId}:${tmuxTransportGate.pinnedSourceCommit}`, executableGeneration: tmuxTransportGate.executableGeneration,
          canonicalSocketPath: tmuxTransportGate.canonicalSocketPath, socketDev: tmuxTransportGate.socketDev, socketIno: tmuxTransportGate.socketIno,
          serverPid: tmuxTransportGate.probeResult.serverPid, serverStartedAt: tmuxTransportGate.serverStartedAt,
          attachedSessionId: tmuxTransportGate.probeResult.attachedSessionId, sourcePaneId: tmuxTransportGate.probeResult.sourcePaneId,
          sourcePanePid: tmuxTransportGate.probeResult.sourcePanePid, sourceWindowId: expectedSourceWindowId,
        },
        createClient: async (onDisconnect) => {
          // A shared parent client can serialize active-run reconciliation behind
          // output/notification backlog. Keep attach bounded at the default 5s,
          // but permit one bounded 30s command response before poisoning and
          // generation-fenced reconnect; brokers and reapers keep their 5s defaults.
          const client = new TmuxControlClient({
            executable: backendExecutable,
            socketPath: tmuxTransportGate!.canonicalSocketPath,
            sessionId: tmuxTransportGate!.probeResult.attachedSessionId,
            commandTimeoutMs: 30_000,
            onDisconnect,
          });
          await client.start();
          return client as any;
        },
        revalidate: revalidateLeaseAuthority,
      });
      if (!tmuxParentLease) throw new Error("tmux control lease could not prove this run's authority.");
      backendRun = tmuxParentLease.run as BackendCommandRunner;
      backend = bindInteractiveBackend(backend, backendExecutable, backendGeneration, backendRun);
    }
    const markTmuxControlReconnectPending = () => {
      // The pool has already poisoned the shared physical generation. Do not
      // close it here: other same-authority parent leases must independently
      // revalidate and join the authority-wide reconnect singleflight.
      tmuxReconnectPending = true;
      backendRun = unavailableTmuxControlRunner;
      backend = bindInteractiveBackend(backend, backendExecutable, backendGeneration, backendRun);
    };
    removeTmuxDisconnectListener = tmuxParentLease?.onDisconnect(markTmuxControlReconnectPending) ?? null;
    const reconnectTmuxControl = async (_forceFresh = false): Promise<boolean> => {
      if (!canStartInteractiveRun(options.interactiveShutdownGeneration) || backend.mode !== "tmux-pane" || !tmuxParentLease) return false;
      tmuxReconnectPending = true;
      if (!await tmuxParentLease.reconnect()) return false;
      // `persistentClientRestarts` is recorded by the pool only when its
      // physical authority client actually reconnects; lease joins do not
      // inflate transport telemetry.
      backendRun = tmuxParentLease.run as BackendCommandRunner;
      backend = bindInteractiveBackend(backend, backendExecutable, backendGeneration, backendRun);
      tmuxReconnectPending = false;
      return true;
    };

    // Fork snapshots are session context, not child output. Start tailing at
    // the exact initial bytes so inherited assistant text and usage cannot
    // enter this child result, including when it emits no new response.
    sessionResultStartOffset = options.delegationMode === "fork" ? Buffer.byteLength(initialChildSessionJsonl, "utf8") : 0;
    tailState = createSessionTailState();
    tailState.offset = sessionResultStartOffset;
    const drainLiveSession = async (): Promise<"none" | "completion" | "invalid"> => await serializeResultMutation(async () => {
      // The fence check is deliberately inside this FIFO: a drain already in
      // flight completes (and emits its callback) before ACK; none can start after.
      if (completionFenced || !tailState) return "completion";
      const fenceArtifact = await readBrokerArtifact(activePaths.completionFencePath);
      if (fenceArtifact.outcome !== "missing") {
        // The monitor's fence path owns ACK publication because it first stops
        // and drains the lease writer. This incremental path must only yield;
        // it cannot acknowledge a boundary while a late lease rename remains.
        return "completion";
      }
      // A verified terminal replay owns the result permanently. In particular,
      // never reopen the live pathname after it has reset/replayed accounting.
      if (appliedCompletion) return "completion";
      const drained = await drainSessionJsonl({
        filePath: activePaths.childSessionPath,
        state: tailState,
        result,
        expectedIdentity: sessionIdentity ?? undefined,
      });
      tailState = drained.state;
      if (!drained.resultChanged) return "none";
      // Do not expose incremental state after terminal authority appeared while
      // the drain was in flight. A malformed completion is authority too: it
      // blocks callbacks and is retained for recovery rather than collapsing
      // into a normal live-session update.
      const completion = await readInteractiveCompletionAuthority(activePaths.completionPath, runId);
      if (completion.outcome !== "none" || appliedCompletion) return completion.outcome === "invalid" ? "invalid" : "completion";
      updateInteractiveRunPreview(runId, getFinalOutput(result.messages));
      options.onUpdate();
      return "none";
    });
    let abortStartedAt: number | null = null;
    // Start exactly one exact-target interrupt but never let a hung transport
    // postpone the abort deadline or terminal parent authority.
    let interruptPromise: Promise<boolean> | null = null;
    let queryFailures = 0;
    let tmuxReconnectBackoffMs = INTERACTIVE_PANE_POLL_INTERVAL_MS;
    let tmuxReconnectBackoffUntil = 0;
    // Notification bursts are hints, not permission to spend the unknown
    // observation budget in a tight loop.
    let tmuxInspectionBackoffMs = INTERACTIVE_PANE_POLL_INTERVAL_MS;
    let tmuxInspectionBackoffUntil = 0;
    let wrapperExitedAt: number | null = null;
    const childLaunchStartedAt = performance.now();
    let observedTopologyMutationGeneration = topologyMutationGeneration;
    let nextDegradedCmuxInspectDue = 0;
    let nextDegradedHerdrInspectDue = 0;
    let herdrDegradedWatchdogMs = HERDR_DEGRADED_WATCHDOG_MIN_MS;
    let tmuxInspectionDue = backend.mode === "tmux-pane";
    let observedTmuxNotificationSequence = tmuxParentLease?.notificationSequence() ?? 0;
    let pendingTmuxNotification: Promise<"notification" | "timeout" | "disconnect"> | null = null;
    let tmuxNotificationReceivedAt: number | null = null;
    // A parent observer must yield to a durable child winner. If a control
    // disconnect caused the prospective observer failure, take one final
    // fresh, generation-fenced look before publishing anything terminal.
    const recheckBeforeObserverPublication = async (
      observationGeneration = topologyMutationGeneration,
    ): Promise<"completion" | "invalid" | "resume" | "publish"> => {
      const ownership = activeInteractiveRuns.get(runId)?.ownership;
      if (ownership === "transferring" || ownership === "detached" || ownership === "ownership-unknown") return "resume";
      const initialCompletion = await readInteractiveCompletionAuthority(activePaths.completionPath, runId);
      if (initialCompletion.outcome === "completion") return "completion";
      if (initialCompletion.outcome === "invalid") return "invalid";
      // A terminal decision must not consume batched evidence that a concurrent
      // allocation/close invalidated while this observer was awaiting it.
      if (observationGeneration !== topologyMutationGeneration) return "resume";
      if (backend.mode !== "tmux-pane") return "publish";
      // Every tmux observer publication (including inspect exhaustion) must
      // freshly prove this run against the current persistent connection.
      // A formerly accepted epoch is not terminal-publication authority.
      const live = await reconnectTmuxControl(true);
      const recheckedCompletion = await readInteractiveCompletionAuthority(activePaths.completionPath, runId);
      if (recheckedCompletion.outcome === "completion") return "completion";
      if (recheckedCompletion.outcome === "invalid") return "invalid";
      return observationGeneration !== topologyMutationGeneration || live ? "resume" : "publish";
    };
    // Parent-side interrupts are terminal topology mutations. Serialize them
    // with promotion/publication, then make the completion artifact's tri-state
    // and the current exact registry authority decide whether mutation remains
    // permitted. Present, malformed, or unreadable completion all fail closed.
    const interruptIfParentStillOwns = async (): Promise<boolean> => {
      const active = activeInteractiveRuns.get(runId);
      return active && active.handle === handle
        ? await interruptActiveInteractiveRunWithoutWinner({ runId, expectedRun: active })
        : false;
    };
    const waitForFreshTopologyOrLifecycleHint = async () => {
      await (handle!.mode === "cmux-pane"
        ? Promise.race([
          runLifecycleServerWait(lifecycleEventServer, runId, INTERACTIVE_PANE_POLL_INTERVAL_MS),
          waitForCmuxTopologyHint(INTERACTIVE_PANE_POLL_INTERVAL_MS),
        ])
        : handle!.mode === "herdr-pane" ? Promise.race([
          runLifecycleServerWait(lifecycleEventServer, runId, HERDR_DEGRADED_WATCHDOG_MIN_MS),
          waitForHerdrWake(HERDR_DEGRADED_WATCHDOG_MIN_MS),
        ])
        : delay(INTERACTIVE_PANE_POLL_INTERVAL_MS));
    };
    const failClosedTerminalPublication = () => {
      preserveDiagnostics = true;
      retainRecoveryMetadata = true;
      skipFinalRelease = true;
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = "Interactive terminal publication timed out.";
      result.stderr = result.stderr ? `${result.stderr}\n${result.errorMessage}` : result.errorMessage;
      return normalizeCompletedResult(result, false);
    };
    const failClosedInvalidCompletion = () => {
      // Keep the exact target, active registry entry, transcript, and tree
      // permit for recovery. In particular, do not attempt an observer
      // completion, interrupt, or close after malformed terminal authority.
      preserveDiagnostics = true;
      retainRecoveryMetadata = true;
      skipFinalRelease = true;
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = "completion-authority-invalid";
      result.stderr = result.stderr ? `${result.stderr}\n${result.errorMessage}` : result.errorMessage;
      return normalizeCompletedResult(result, false);
    };
    /**
     * A post-dispatch send_text failure has a durable, exact allocation but no
     * delivery acknowledgement. Probe only that handle a few times to settle
     * transport noise; never replay the command, publish a parent winner, or
     * close a pane that may already be running the wrapper.
     */
    const reconcileHerdrLaunchDeliveryUnknown = async (): Promise<"none" | "retained" | "invalid"> => {
      if (handle?.mode !== "herdr-pane") return "none";
      const artifact = await readBrokerArtifact(activePaths.launchDeliveryUnknownPath);
      if (artifact.outcome === "missing") return "none";
      const marker = artifact.outcome === "valid"
        ? parseLaunchDeliveryUnknownV2(artifact.value, runId, activePaths.runDir)
        : null;
      if (!marker || marker.allocationPath !== activePaths.allocationPath
        || committedAllocation?.terminalMode !== "herdr-pane"
        || committedAllocation.target.terminalId !== handle.native.terminalId) return "invalid";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const snapshot = await backend.inspect(handle).catch(() => undefined);
        if (snapshot !== undefined) return "retained";
        if (attempt < 2) await delay(INTERACTIVE_PANE_POLL_INTERVAL_MS);
      }
      return "retained";
    };
    const retainHerdrLaunchDeliveryUnknown = async (state: "retained" | "invalid") => {
      preserveDiagnostics = true;
      retainRecoveryMetadata = true;
      skipFinalRelease = true;
      await stopLeaseWriterAndDrain();
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = state === "invalid"
        ? "Herdr launch-delivery authority is invalid; exact allocation retained for recovery."
        : "Herdr launch delivery is unknown; exact allocation retained without replay.";
      result.stderr = result.stderr ? `${result.stderr}\n${result.errorMessage}` : result.errorMessage;
      return normalizeCompletedResult(result, false);
    };
    while (true) {
      // This must be the first terminal-authority observation in every loop:
      // invalid authority fails closed before any fence callback, live drain,
      // abort interrupt, observer publication, or ownership/tree mutation.
      const loopCompletion = await readInteractiveCompletionAuthority(paths.completionPath, runId);
      if (loopCompletion.outcome === "invalid") return failClosedInvalidCompletion();
      // An acknowledged transfer revokes this monitor's lease, completion, and
      // target authority. The detached child continues independently; parent
      // settlement deliberately publishes neither completion nor close.
      const activeInteractiveRun = activeInteractiveRuns.get(runId);
      const interactiveOwnership = activeInteractiveRun?.ownership;
      if (interactiveOwnership === "transferring") {
        // Request publication revokes cleanup authority, but it is not a
        // terminal ownership result. Yield until the promoter records either
        // detached ownership or an explicit uncertain outcome.
        await waitForFreshTopologyOrLifecycleHint();
        continue;
      }
      if (interactiveOwnership === "detached") {
        skipFinalRelease = true;
        watchDetachedInteractiveRunForRetirement(activeInteractiveRun!);
        await stopLeaseWriterAndDrain();
        // Promotion releases its tree capacity only after durable child
        // detachment has been observed. Retain the permit on uncertainty so a
        // failed authority mutation cannot be reported as normal success.
        if (!await settleInteractiveTreePermitAfterOwnership(interactiveOwnership, activeInteractiveRun?.treePermitLease)) {
          preserveDiagnostics = true;
          retainRecoveryMetadata = true;
          result.exitCode = 1;
          result.stopReason = "error";
          result.errorMessage = "Tree permit detachment failed after promotion.";
          result.stderr = result.stderr ? `${result.stderr}\n${result.errorMessage}` : result.errorMessage;
          return normalizeCompletedResult(result, false);
        }
        result.exitCode = 0;
        result.sawAgentEnd = true;
        return normalizeCompletedResult(result, false);
      }
      if (interactiveOwnership === "ownership-unknown") {
        // An uncertain transfer is terminal for this monitor, but never a
        // normal child completion. Retain the tree permit and recovery state.
        skipFinalRelease = true;
        preserveDiagnostics = true;
        retainRecoveryMetadata = true;
        await stopLeaseWriterAndDrain();
        applyInteractiveOwnershipUnknownResult(result);
        return normalizeCompletedResult(result, false);
      }
      const deliveryReconciliation = await reconcileHerdrLaunchDeliveryUnknown();
      if (deliveryReconciliation !== "none") return await retainHerdrLaunchDeliveryUnknown(deliveryReconciliation);
      // Check after every wake as well as before every drain. An invalid fence
      // fails closed: callbacks remain suppressed and recovery artifacts stay.
      const fenceOutcome = await awaitTerminalPublicationBounded(fenceCallbacksForCompletion(false));
      if (fenceOutcome.timedOut) return failClosedTerminalPublication();
      const fenceState = fenceOutcome.value ?? "invalid";
      if (fenceState === "timed-out") return failClosedTerminalPublication();
      if (fenceState === "invalid") {
        preserveDiagnostics = true; retainRecoveryMetadata = true; skipFinalRelease = true;
        result.exitCode = 1; result.stopReason = "error"; result.errorMessage = "completion-fence-unverified";
        result.stderr = result.stderr ? `${result.stderr}\n${result.errorMessage}` : result.errorMessage;
        return normalizeCompletedResult(result, false);
      }
      // Once acknowledged, no ordinary drain may reopen the live session, but
      // the child can still publish its immutable V3 boundary afterwards.
      // Check that authority before waiting again or this monitor would remain
      // fenced forever after a valid child completion.
      const completionRead = await readInteractiveCompletionAuthority(paths.completionPath, runId);
      if (completionRead.outcome === "invalid") return failClosedInvalidCompletion();
      const completion = completionRead.outcome === "completion" ? completionRead.completion : null;
      if (fenceState === "cancelled" && !completion) {
        // A cancellation claim is a terminal shared-fence winner, not a child
        // completion awaiting ACK. Do not leave this monitor fenced forever.
        preserveDiagnostics = true;
        retainRecoveryMetadata = true;
        skipFinalRelease = true;
        result.exitCode = 130;
        result.stopReason = "aborted";
        result.errorMessage = "Herdr cancellation claim retained for bounded recovery.";
        if (!result.stderr.trim()) result.stderr = result.errorMessage;
        return normalizeCompletedResult(result, true);
      }
      if (fenceState === "fenced" && !completion) {
        await waitForFreshTopologyOrLifecycleHint();
        continue;
      }
      // Read immutable completion before an unbounded incremental drain. Once a
      // V3 boundary exists, bytes appended after it must never enter the result.
      if (completion) {
        if (options.forkSourceOwnership && options.forkChildId && completion.status === "completed"
          && !await options.forkSourceOwnership.validateChildAcknowledgement(options.forkChildId).catch(() => false)) {
          result.exitCode = 1; result.stopReason = "error"; result.errorMessage = "fork-bootstrap-unacknowledged";
          result.stderr = result.stderr ? `${result.stderr}\nfork-bootstrap-unacknowledged` : "fork-bootstrap-unacknowledged";
          await options.forkSourceOwnership.markTerminal(options.forkChildId, "process-exited-before-ack").catch(() => undefined);
          preserveDiagnostics = true; retainRecoveryMetadata = true; skipFinalRelease = true;
          return normalizeCompletedResult(result, false);
        }
        recordPhase0LiveTelemetry(backend.mode === "tmux-pane" ? "tmux" : backend.mode === "herdr-pane" ? "herdr" : "cmux", "lifecycleCompletionLatencyMs", Math.max(0, Date.now() - completion.completedAt), "durable-completion");
        if (!await stopLeaseWriterAndDrain()) return failClosedTerminalPublication();
        const verified = await applyCompletionWinner(completion);
        completedNormally = verified && completion.status === "completed";
        preserveDiagnostics = !verified || completion.status !== "completed";
        retainRecoveryMetadata ||= !verified;
        if (!verified) {
          skipFinalRelease = true;
          return normalizeCompletedResult(result, false);
        }
        await Promise.race([waitForFile(paths.wrapperStatusPath, 500), delay(500)]);
        const targetClosed = await releaseAfterCompletionWinner(completion);
        targetConfirmedAbsent ||= targetClosed;
        if (!targetClosed) {
          preserveDiagnostics = true;
          retainRecoveryMetadata = true;
        }
        return normalizeCompletedResult(result, completion.status === "aborted");
      }

      // Never issue an inspection through the runner bound to a dead control
      // client. Reconnection is retried with bounded backoff and starts from
      // the full durable gate/executable/socket/server/source/session/window/
      // target validation in reconnectTmuxControl.
      if (backend.mode === "tmux-pane" && tmuxReconnectPending && !options.signal?.aborted) {
        if (!canStartInteractiveRun(options.interactiveShutdownGeneration)) {
          // A fenced reconnect cannot return on a stale observation: elect and
          // replay a parent boundary before the shutdown path may release it.
          const publicationOutcome = await awaitTerminalPublicationBounded(publishTerminalParentCompletion(paths, runId, "aborted", "parent-aborted"));
          if (publicationOutcome.timedOut) return failClosedTerminalPublication();
          const publication = publicationOutcome.value;
          if (!publication) {
            if (terminalPreparationTimedOut) return failClosedTerminalPublication();
            continue;
          }
          const verified = await applyCompletionWinner(publication.completion);
          retainRecoveryMetadata ||= !verified;
          completedNormally ||= verified && publication.completion.status === "completed";
          preserveDiagnostics = true;
          if (!verified) { skipFinalRelease = true; return normalizeCompletedResult(result, false); }
          const targetClosed = await releaseAfterCompletionWinner(publication.completion);
          targetConfirmedAbsent ||= targetClosed;
          if (!targetClosed) retainRecoveryMetadata = true;
          return normalizeCompletedResult(result, publication.completion.status === "aborted");
        }
        if (await reconnectTmuxControl()) {
          tmuxReconnectBackoffMs = INTERACTIVE_PANE_POLL_INTERVAL_MS;
          tmuxReconnectBackoffUntil = 0;
          tmuxInspectionDue = true;
          continue;
        }
        const waitMs = tmuxReconnectBackoffMs;
        tmuxReconnectBackoffMs = Math.min(5_000, tmuxReconnectBackoffMs * 2);
        tmuxReconnectBackoffUntil = performance.now() + waitMs;
        await delay(waitMs);
        continue;
      }
      if (backend.mode === "tmux-pane" && performance.now() < tmuxReconnectBackoffUntil) {
        await delay(Math.max(1, tmuxReconnectBackoffUntil - performance.now()));
        continue;
      }
      if (backend.mode === "tmux-pane" && performance.now() < tmuxInspectionBackoffUntil) {
        await delay(Math.max(1, tmuxInspectionBackoffUntil - performance.now()));
        continue;
      }

      const drainOutcome = await drainLiveSession();
      if (drainOutcome === "invalid") return failClosedInvalidCompletion();
      if (drainOutcome === "completion") continue;

      if (await fileExists(paths.wrapperStatusPath)) {
        wrapperExitedAt ??= Date.now();
        if (Date.now() - wrapperExitedAt >= 500) {
          const recovery = await recheckBeforeObserverPublication();
          if (recovery === "completion") continue;
          if (recovery === "invalid") return failClosedInvalidCompletion();
          if (recovery === "resume") {
            queryFailures = 0;
            wrapperExitedAt = null;
            tmuxReconnectBackoffUntil = performance.now() + tmuxReconnectBackoffMs;
            tmuxReconnectBackoffMs = Math.min(5_000, tmuxReconnectBackoffMs * 2);
            continue;
          }
          const publicationOutcome = await awaitTerminalPublicationBounded(publishTerminalParentCompletion(paths, runId, "failed", "wrapper-exited"));
          if (publicationOutcome.timedOut) return failClosedTerminalPublication();
          const publication = publicationOutcome.value;
          if (!publication) {
            if (terminalPreparationTimedOut) return failClosedTerminalPublication();
            continue;
          }
          const winnerVerified = await applyCompletionWinner(publication.completion);
          retainRecoveryMetadata ||= !winnerVerified;
          completedNormally ||= winnerVerified && publication.completion.status === "completed";
          preserveDiagnostics = true;
          if (!winnerVerified) {
            skipFinalRelease = true;
            return normalizeCompletedResult(result, false);
          }
          const targetClosed = await releaseAfterCompletionWinner(publication.completion);
          targetConfirmedAbsent ||= targetClosed;
          if (!targetClosed) retainRecoveryMetadata = true;
          return result;
        }
      }

      if (options.signal?.aborted) {
        abortStartedAt ??= Date.now();
        const cooperativeHerdrAbort = handle.mode === "herdr-pane" && handle.placement?.placement === "herdr-new-tab";
        const abortAcknowledged = cooperativeHerdrAbort && lifecycleEventServer?.isAbortAcknowledged(runId) === true;
        if (!interruptPromise && !abortAcknowledged) {
          // A parent abort must not send a mutation through a dead control
          // client. If recovery cannot prove the exact target, publish the
          // parent-aborted authority below without replaying that mutation.
          if (backend.mode !== "tmux-pane" || !tmuxReconnectPending || await reconnectTmuxControl()) {
            // Do not await this exact queued operation: its transport may hang
            // forever, while ABORT_WAIT continues from the first abort wake.
            const pending = interruptIfParentStillOwns();
            interruptPromise = pending;
            // Direct Herdr control may be requested before the bridge connects.
            // A false return (or an unacknowledged queued request) is retryable;
            // only the authenticated ACK freezes cooperative abort delivery.
            if (cooperativeHerdrAbort) void pending.finally(() => {
              if (interruptPromise === pending && lifecycleEventServer?.isAbortAcknowledged(runId) !== true) interruptPromise = null;
            });
          }
        }
        if (Date.now() - abortStartedAt >= ABORT_WAIT_MS) {
          if (handle.mode === "herdr-pane" && handle.placement?.placement === "herdr-new-tab") {
            // Preserve authenticated cooperative abort first. Only after its
            // bounded grace may active cancellation signal the exact durable
            // child tuple; any changed completion/ownership/identity retains
            // recovery and never mutates the Herdr pane or tab.
            const active = activeInteractiveRuns.get(runId);
            const escalation = active && active === activeInteractiveRun
              ? await terminateAuthorizedHerdrChild(runId, active, {
                waitForWake: async (timeoutMs) => await Promise.race([
                  runLifecycleServerWait(lifecycleEventServer, runId, timeoutMs),
                  waitForHerdrWake(timeoutMs),
                ]),
              })
              : "revoked";
            // A completion or completion fence can appear during SIGTERM
            // grace. Return to the normal monitor rather than reporting an
            // abort: it owns fence acknowledgement and winner replay.
            if (escalation === "completion-won") continue;
            preserveDiagnostics = true;
            retainRecoveryMetadata = true;
            skipFinalRelease = true;
            result.exitCode = 130;
            result.stopReason = "aborted";
            result.errorMessage = "Herdr cooperative shutdown did not complete; recovery state retained.";
            if (!result.stderr.trim()) result.stderr = result.errorMessage;
            return normalizeCompletedResult(result, true);
          }
          const publicationOutcome = await awaitTerminalPublicationBounded(publishTerminalParentCompletion(paths, runId, "aborted", "parent-aborted"));
          if (publicationOutcome.timedOut) return failClosedTerminalPublication();
          const publication = publicationOutcome.value;
          if (!publication) {
            if (terminalPreparationTimedOut) return failClosedTerminalPublication();
            continue;
          }
          const verified = await applyCompletionWinner(publication.completion);
          retainRecoveryMetadata ||= !verified;
          completedNormally ||= verified && publication.completion.status === "completed";
          preserveDiagnostics = true;
          if (!verified) {
            skipFinalRelease = true;
            return normalizeCompletedResult(result, false);
          }
          const targetClosed = await releaseAfterCompletionWinner(publication.completion);
          targetConfirmedAbsent ||= targetClosed;
          if (!targetClosed) retainRecoveryMetadata = true;
          return normalizeCompletedResult(result, publication.completion.status === "aborted");
        }
      }

      if (options.signal?.aborted && handle.mode === "herdr-pane" && handle.placement?.placement === "herdr-new-tab") {
        // Retry unavailable cooperative delivery promptly, but never replay it
        // after the server has durably observed the child's acknowledgement.
        await Promise.race([runLifecycleServerWait(lifecycleEventServer, runId, INTERACTIVE_PANE_POLL_INTERVAL_MS), waitForHerdrWake(INTERACTIVE_PANE_POLL_INTERVAL_MS)]);
        continue;
      }

      if (backend.mode === "tmux-pane" && tmuxParentLease && !tmuxInspectionDue) {
        pendingTmuxNotification ??= tmuxParentLease.waitForNotification(5_000);
        const tmuxWake = pendingTmuxNotification.then((reason) => ({ source: "tmux" as const, reason }));
        const wake = lifecycleEventServer
          ? await Promise.race([
            tmuxWake,
            lifecycleEventServer.waitForEvent(runId, 5_000).then(() => ({ source: "lifecycle" as const })),
          ])
          : await tmuxWake;
        if (wake.source === "tmux") {
          pendingTmuxNotification = null;
          if (wake.reason === "disconnect") {
            markTmuxControlReconnectPending();
            const reconnected = await reconnectTmuxControl();
            if (reconnected) observedTmuxNotificationSequence = tmuxParentLease!.notificationSequence();
            tmuxInspectionDue = true;
          } else {
            const sequence = tmuxParentLease.notificationSequence();
            if (wake.reason !== "timeout" || sequence !== observedTmuxNotificationSequence) {
              tmuxNotificationReceivedAt = tmuxParentLease.lastNotificationAt();
              tmuxInspectionDue = true;
            }
          }
        }
        continue;
      }

      const lifecycleHeartbeat = lifecycleEventServer?.lastHeartbeat(runId);
      const lifecycleConnected = Boolean(lifecycleEventServer?.isConnected(runId));
      const lifecycleSocketHealthy = lifecycleConnected
        && lifecycleHeartbeat !== null && lifecycleHeartbeat !== undefined
        && performance.now() - lifecycleHeartbeat < DEFAULT_PARENT_LEASE_STALE_MS;
      const healthyHerdrEvents = backend.mode === "herdr-pane" && Boolean(herdrSubscription?.isHealthy());
      const lifecycleHealthy = (backend.mode === "cmux-pane" || backend.mode === "herdr-pane")
        && lifecycleSocketHealthy
        && observedTopologyMutationGeneration === topologyMutationGeneration
        && (backend.mode !== "herdr-pane" || healthyHerdrEvents);
      if (lifecycleHealthy) {
        // Authenticated lifecycle frames and a live Herdr subscription are
        // wake authority. Durable completion remains authoritative at loop top;
        // healthy runs issue no periodic backend inspection.
        await (backend.mode === "herdr-pane"
          ? Promise.race([lifecycleEventServer!.waitForEvent(runId, 5_000), waitForHerdrWake(5_000)])
          : Promise.race([lifecycleEventServer!.waitForEvent(runId, 5_000), waitForCmuxTopologyHint(5_000)]));
        continue;
      }
      const degradedCmux = backend.mode === "cmux-pane" && lifecycleRunId !== null;
      const degradedHerdr = backend.mode === "herdr-pane" && !healthyHerdrEvents;
      if ((degradedCmux && observedTopologyMutationGeneration === topologyMutationGeneration || degradedHerdr)
        && performance.now() < (degradedCmux ? nextDegradedCmuxInspectDue : nextDegradedHerdrInspectDue)) {
        const waitMs = Math.max(1, (degradedCmux ? nextDegradedCmuxInspectDue : nextDegradedHerdrInspectDue) - performance.now());
        await (degradedHerdr
          ? Promise.race([runLifecycleServerWait(lifecycleEventServer, runId, waitMs), waitForHerdrWake(waitMs)])
          : Promise.race([runLifecycleServerWait(lifecycleEventServer, runId, Math.min(5_000, waitMs)), waitForCmuxTopologyHint(Math.min(5_000, waitMs))]));
        continue;
      }

      // An unavailable or stale accepted epoch is retryable transport state,
      // not a topology failure. Reconnect with bounded backoff without spending
      // the inspect-exhausted budget.
      if (backend.mode === "tmux-pane" && !tmuxParentLease?.acceptedTransport()) {
        queryFailures = 0;
        tmuxInspectionDue = false;
        tmuxReconnectPending = true;
        recordPhase0LiveTelemetry("tmux", "unknownOutcomes", 1, "accepted-epoch-unavailable");
        continue;
      }

      const tmuxSequenceBeforeInspect = tmuxParentLease?.notificationSequence() ?? observedTmuxNotificationSequence;
      // Capture immediately before the await. An undefined shared snapshot is
      // not a transport failure when an allocation/close advanced the topology
      // epoch while the request was in flight.
      const inspectionTopologyMutationGeneration = topologyMutationGeneration;
      const pane = handle.mode === "herdr-pane"
        ? await backend.inspect(handle).catch(() => undefined)
        : await inspectActiveInteractiveSnapshot({
          handle,
          run: backendRun,
          backendKey: executableGenerationKey(backendGeneration),
          generation: options.interactiveShutdownGeneration,
          tmuxAcceptedTransport: backend.mode === "tmux-pane"
            ? () => tmuxParentLease?.acceptedTransport() ?? null
            : undefined,
        });
      if (tmuxNotificationReceivedAt !== null) { recordPhase0LiveTelemetry("tmux", "notificationToReconcileLatencyMs", Math.max(0, Date.now() - tmuxNotificationReceivedAt), "notification"); tmuxNotificationReceivedAt = null; }
      if (backend.mode === "tmux-pane" && tmuxParentLease) {
        const tmuxSequenceAfterInspect = tmuxParentLease.notificationSequence();
        observedTmuxNotificationSequence = tmuxSequenceAfterInspect;
        tmuxInspectionDue = tmuxSequenceAfterInspect !== tmuxSequenceBeforeInspect;
      }
      if (isTopologyMutationInvalidatedUndefinedInspection(pane, inspectionTopologyMutationGeneration)) {
        // Yield once so the caller observes the post-mutation topology rather
        // than immediately reusing an invalidated batch epoch.
        await waitForFreshTopologyOrLifecycleHint();
        continue;
      }
      if (pane === undefined) {
        if (backend.mode === "tmux-pane") {
          // The epoch can disappear between the pre-check and the shared read.
          // Treat that as reconnectable transport state, never as twenty rapid
          // topology failures.
          if (!tmuxParentLease?.acceptedTransport()) {
            queryFailures = 0;
            tmuxInspectionDue = false;
            tmuxReconnectPending = true;
            recordPhase0LiveTelemetry("tmux", "unknownOutcomes", 1, "accepted-epoch-unavailable");
            continue;
          }
          tmuxInspectionDue = false;
          tmuxInspectionBackoffUntil = performance.now() + tmuxInspectionBackoffMs;
          tmuxInspectionBackoffMs = Math.min(5_000, tmuxInspectionBackoffMs * 2);
        }
        queryFailures += 1;
        if (degradedCmux) nextDegradedCmuxInspectDue = performance.now() + 5_000;
        if (degradedHerdr) {
          nextDegradedHerdrInspectDue = performance.now() + herdrDegradedWatchdogMs;
          herdrDegradedWatchdogMs = Math.min(HERDR_DEGRADED_WATCHDOG_MAX_MS, herdrDegradedWatchdogMs * 2);
        }
        const handleId = handle.mode === "cmux-pane" ? handle.native.surfaceId : handle.native.paneId;
        if (queryFailures >= 20 && !degradedCmux) {
          const recovery = await recheckBeforeObserverPublication(inspectionTopologyMutationGeneration);
          if (recovery === "completion") continue;
          if (recovery === "invalid") return failClosedInvalidCompletion();
          if (recovery === "resume") {
            queryFailures = 0;
            tmuxReconnectBackoffUntil = performance.now() + tmuxReconnectBackoffMs;
            tmuxReconnectBackoffMs = Math.min(5_000, tmuxReconnectBackoffMs * 2);
            continue;
          }
          const publicationOutcome = await awaitTerminalPublicationBounded(publishTerminalParentCompletion(paths, runId, "failed", "inspect-exhausted"));
          if (publicationOutcome.timedOut) return failClosedTerminalPublication();
          const publication = publicationOutcome.value;
          if (!publication) {
            if (terminalPreparationTimedOut) return failClosedTerminalPublication();
            continue;
          }
          const verified = await applyCompletionWinner(publication.completion);
          retainRecoveryMetadata ||= !verified;
          completedNormally ||= verified && publication.completion.status === "completed";
          preserveDiagnostics = true;
          if (!verified) {
            skipFinalRelease = true;
            return normalizeCompletedResult(result, false);
          }
          await interruptIfParentStillOwns();
          const targetClosed = await releaseAfterCompletionWinner(publication.completion);
          targetConfirmedAbsent ||= targetClosed;
          if (!targetClosed) retainRecoveryMetadata = true;
          return normalizeCompletedResult(result, publication.completion.status === "aborted");
        }
      } else {
        queryFailures = 0;
        if (backend.mode === "tmux-pane") {
          tmuxInspectionBackoffMs = INTERACTIVE_PANE_POLL_INTERVAL_MS;
          tmuxInspectionBackoffUntil = 0;
        }
        observedTopologyMutationGeneration = topologyMutationGeneration;
        if (degradedCmux) nextDegradedCmuxInspectDue = performance.now() + 5_000;
        if (degradedHerdr) {
          nextDegradedHerdrInspectDue = performance.now() + HERDR_DEGRADED_WATCHDOG_MIN_MS;
          herdrDegradedWatchdogMs = HERDR_DEGRADED_WATCHDOG_MIN_MS;
        }
        // Batched topology is read-sharing evidence only. Before absence can
        // publish terminal state (or prove cleanup) obtain an independent
        // exact-handle inspection; a stale batch must never be authority.
        const terminalInspectionTopologyMutationGeneration = topologyMutationGeneration;
        const terminalPane = !pane.exists || pane.exited
          // A pooled tmux parent has already fenced this connection at lease
          // acceptance. Its mandatory publication revalidation below performs
          // the fresh exact target proof; do not add local ps/socket probes to
          // every active terminal observation.
          ? (handle.mode === "tmux-pane" ? pane : await backend.inspect(handle).catch(() => undefined))
          : pane;
        if (!terminalPane) {
          if (isTopologyMutationInvalidatedUndefinedInspection(terminalPane, terminalInspectionTopologyMutationGeneration)) {
            await waitForFreshTopologyOrLifecycleHint();
            continue;
          }
          queryFailures += 1;
          await waitForFreshTopologyOrLifecycleHint();
          continue;
        }
        if (!terminalPane.exists || terminalPane.exited) {
          // cmux surface.respawn can expose the allocated surface as transiently
          // exited/absent before the replacement shell and child bridge start.
          // Do not convert that transition into immutable parent failure; wait
          // for bounded child startup, then require a fresh exact observation.
          if (performance.now() - childLaunchStartedAt < INTERACTIVE_CHILD_START_GRACE_MS
            && !await fileExists(paths.wrapperStatusPath)) {
            await (handle.mode === "cmux-pane"
              ? Promise.race([runLifecycleServerWait(lifecycleEventServer, runId, INTERACTIVE_PANE_POLL_INTERVAL_MS), waitForCmuxTopologyHint(INTERACTIVE_PANE_POLL_INTERVAL_MS)])
              : handle.mode === "herdr-pane"
                ? Promise.race([runLifecycleServerWait(lifecycleEventServer, runId, HERDR_DEGRADED_WATCHDOG_MIN_MS), waitForHerdrWake(HERDR_DEGRADED_WATCHDOG_MIN_MS)])
                : delay(INTERACTIVE_PANE_POLL_INTERVAL_MS));
            continue;
          }
          const recovery = await recheckBeforeObserverPublication(terminalInspectionTopologyMutationGeneration);
          if (recovery === "completion") continue;
          if (recovery === "invalid") return failClosedInvalidCompletion();
          if (recovery === "resume") {
            queryFailures = 0;
            tmuxReconnectBackoffUntil = performance.now() + tmuxReconnectBackoffMs;
            tmuxReconnectBackoffMs = Math.min(5_000, tmuxReconnectBackoffMs * 2);
            continue;
          }
          if (!terminalPane.exists) targetConfirmedAbsent = true;
          const publicationOutcome = await awaitTerminalPublicationBounded(publishTerminalParentCompletion(paths, runId, "failed", "pane-missing"));
          if (publicationOutcome.timedOut) return failClosedTerminalPublication();
          const publication = publicationOutcome.value;
          if (!publication) {
            if (terminalPreparationTimedOut) return failClosedTerminalPublication();
            continue;
          }
          const winnerVerified = await applyCompletionWinner(publication.completion);
          retainRecoveryMetadata ||= !winnerVerified;
          completedNormally ||= winnerVerified && publication.completion.status === "completed";
          preserveDiagnostics = true;
          if (!winnerVerified) {
            skipFinalRelease = true;
            return normalizeCompletedResult(result, false);
          }
          const targetClosed = await releaseAfterCompletionWinner(publication.completion);
          targetConfirmedAbsent ||= targetClosed;
          if (!targetClosed) retainRecoveryMetadata = true;
          return result;
        }
      }
      await (handle.mode === "cmux-pane" ? waitForCmuxTopologyHint(INTERACTIVE_PANE_POLL_INTERVAL_MS)
        : handle.mode === "herdr-pane" ? waitForHerdrWake(HERDR_DEGRADED_WATCHDOG_MIN_MS)
        : delay(INTERACTIVE_PANE_POLL_INTERVAL_MS));
    }
  } catch (error) {
    // An error before staged gate consumption may need exact cleanup. Release
    // first so that cleanup reacquires the same FIFO topology lock instead of
    // waiting on this launch's own slot.
    releaseTmuxLaunch();
    releaseCmuxLaunch();
    preserveDiagnostics = true;
    let publication: Awaited<ReturnType<typeof publishParentCompletion>> | null = null;
    if (paths && handle && committedRunId && !(handle.mode === "herdr-pane" && handle.placement?.placement === "herdr-new-tab")) {
      try {
        const outcome = await awaitTerminalPublicationBounded(publishTerminalParentCompletion(paths, committedRunId, options.signal?.aborted ? "aborted" : "failed", options.signal?.aborted ? "parent-aborted" : "launch-failed"));
        if (outcome.timedOut) { retainRecoveryMetadata = true; skipFinalRelease = true; }
        else publication = outcome.value;
        // A lease drain failure revokes terminal authority just like a timed
        // out publication. Retain the exact target and its recovery transcript.
        if (terminalPreparationTimedOut) { retainRecoveryMetadata = true; skipFinalRelease = true; }
      } catch {
        retainRecoveryMetadata = true;
      }
    }
    const wasAborted = Boolean(options.signal?.aborted);
    if (publication) {
      const verified = await applyCompletionWinner(publication.completion);
      retainRecoveryMetadata ||= !verified;
      completedNormally ||= verified && publication.completion.status === "completed";
      if (!verified) {
        skipFinalRelease = true;
        return normalizeCompletedResult(result, false);
      }
      const active = committedRunId ? activeInteractiveRuns.get(committedRunId) : undefined;
      const release = active && committedRunId
        ? releaseActiveInteractiveRunAfterWinner({ runId: committedRunId, expectedRun: active, completion: publication.completion,
          waitForHerdrWake: async (timeoutMs) => await Promise.race([
            waitForHerdrWake(timeoutMs), runLifecycleServerWait(lifecycleEventServer, active.runId, timeoutMs),
          ]),
        })
        : null;
      const targetClosed = release ? await awaitInteractiveBooleanBounded(release) : false;
      if (release && !targetClosed && active && committedRunId) finalizeBoundedInteractiveRelease(committedRunId, active, release);
      targetConfirmedAbsent ||= targetClosed;
      if (!targetClosed) retainRecoveryMetadata = true;
      if (publication.won && !result.stderr.trim()) result.stderr = error instanceof Error ? error.message : String(error);
      return normalizeCompletedResult(result, publication.completion.status === "aborted");
    }
    // No parent or verified-child completion winner means this monitor has no
    // close authority. Retain the registered exact target for shutdown/reaper
    // recovery rather than replaying a stale poll as a mutation.
    result.exitCode = wasAborted ? 130 : 1;
    result.stopReason = wasAborted ? "aborted" : "error";
    result.errorMessage = error instanceof Error ? error.message : String(error);
    if (!result.stderr.trim()) result.stderr = result.errorMessage;
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    releaseTmuxLaunch();
    releaseCmuxLaunch();
    const stoppedHerdrAgentWaitFallback = herdrAgentWaitFallback;
    herdrAgentWaitFallback = null;
    await stoppedHerdrAgentWaitFallback?.stopAndDrain();
    const stoppedHerdrSubscription = herdrSubscription;
    stoppedHerdrSubscription?.stop();
    herdrSubscription = null;
    await stoppedHerdrSubscription?.closed.catch(() => undefined);
    // If the target was not proven absent and unregistered at a winner site,
    // the retained registry entry must not present its stopped monitor as live.
    if (stoppedHerdrSubscription && committedRunId) {
      markRetainedHerdrRunPresentationUnavailable(committedRunId, targetConfirmedAbsent);
    }
    signalHerdrWake();
    await stopLeaseWriterAndDrain();
    if (lifecycleRunId) lifecycleEventServer?.terminalRun(lifecycleRunId);
    // All terminal closes occur at their winner site under the interactive
    // fence. Finally is deliberately non-mutating: it cannot turn a late
    // promotion, malformed completion, or replaced registry entry into close
    // authority.
    // Failed/unknown exact releases retain registry ownership for shutdown
    // retries and future startup recovery. Only proven absence may unregister.
    if (paths && (!committedRunId || targetConfirmedAbsent)) {
      unregisterCommittedInteractiveRun(path.basename(paths.runDir), targetConfirmedAbsent);
    }
    removeTmuxDisconnectListener?.();
    removeTmuxDisconnectListener = null;
    tmuxParentLease?.release();
    tmuxParentLease = null;
    await cleanupTempDir(inheritedApiKeyAgentDir).catch((error) => {
      preserveDiagnostics = true;
      console.error(`[pi-subagent] Interactive auth overlay cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (paths) {
      // Decide retention from tri-state authority reads before any delayed
      // cleanup. Invalid artifacts and uncertain allocations are recovery
      // state, not ordinary diagnostic output.
      const [status, decision, allocation, launch, gate, residualRisk, launchDeliveryUnknown, completionArtifact, intentArtifact] = await Promise.all([
        readBrokerArtifact(paths.brokerStatusPath),
        readBrokerArtifact(paths.decisionPath),
        readBrokerArtifact(paths.allocationPath),
        readBrokerArtifact(paths.launchPath),
        readBrokerArtifact(paths.launchGatePath),
        readBrokerArtifact(paths.residualRiskPath),
        readBrokerArtifact(paths.launchDeliveryUnknownPath),
        readBrokerArtifact(paths.completionPath),
        readBrokerArtifact(paths.launchIntentPath),
      ]);
      retainRecoveryMetadata ||= shouldRetainBrokerRecoveryMetadata({
        runId: path.basename(paths.runDir), runDir: paths.runDir, targetConfirmedAbsent,
        status, decision, allocation, launch, gate, residualRisk, launchDeliveryUnknown,
      });
      const runId = path.basename(paths.runDir);
      const retainedCompletion = parseCompletionAuthority(
        completionArtifact.outcome === "valid" ? completionArtifact.value : null,
        runId,
      );
      const rawIntent = intentArtifact.outcome === "valid" ? intentArtifact.value : null;
      const retainedIntent = rawIntent?.version === 3
        ? parseLaunchIntentV3(rawIntent, runId, paths.runDir)
        : parseLaunchIntentV2(rawIntent, runId, paths.runDir);
      const active = committedRunId ? activeInteractiveRuns.get(committedRunId) : undefined;
      // A timed-out terminal FIFO can publish a boundary after this monitor
      // returns. Keep its exact transcript even before complete.json exists.
      let preserveCompletionSession = Boolean(retainedCompletion)
        || retainRecoveryMetadata
        || Boolean(active?.pendingTerminalPublication);
      // Remove non-transcript secrets first. If any removal fails, the run
      // becomes recovery metadata before its session can be touched.
      let secretsRemoved = await removeSelectedSensitiveArtifacts(paths, undefined, true, preserveDiagnostics);
      if (!secretsRemoved) {
        retainRecoveryMetadata = true;
        preserveCompletionSession = true;
      }
      if (!preserveCompletionSession && secretsRemoved) {
        // The first pass proved every other selected artifact absent, so this
        // second pass may retire the transcript only for ordinary retention.
        secretsRemoved = await removeSelectedSensitiveArtifacts(paths, undefined, false, preserveDiagnostics);
        if (!secretsRemoved) {
          retainRecoveryMetadata = true;
          preserveCompletionSession = true;
        }
      }
      if (retainRecoveryMetadata) {
        // Keep non-secret launch identity for a future startup reaper retry.
      } else if (completedNormally && !preserveDiagnostics) {
        await removeRunArtifacts(paths).catch(() => undefined);
      } else {
        const retainedAt = retainedCompletion?.completedAt ?? retainedIntent?.createdAt;
        if (retainedAt !== undefined) {
          const deadline = retainedAt + 60 * 60 * 1000;
          scheduleRunArtifactCleanup(paths.runDir, Math.max(0, (deadline - Date.now()) / 1000), deadline);
        } else {
          // Without immutable terminal or launch time, no safe restart-stable
          // retention deadline exists. Leave recovery to the stale-run reaper
          // rather than silently granting a fresh TTL from mutable wall time.
        }
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
