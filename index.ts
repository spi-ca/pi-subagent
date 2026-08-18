/**
 * Pi Subagent Extension
 *
 * Delegates tasks to specialized subagents, each running as an isolated `pi`
 * process.
 *
 * Supports four invocation shapes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain:    { chain: [{ agent: "name", task: "..." }, ...] }
 *   - Action:   { action: "status" | "cancel", id?: "..." }
 *
 * And two context modes:
 *   - spawn (default): child gets only the task prompt.
 *   - fork: child gets a forked snapshot of current session context + task prompt.
 *
 * Plus three execution surfaces:
 *   - inline: child pi runs headlessly and streams JSON stdout.
 *   - cmux-pane / tmux-pane / herdr-pane: child pi runs as an interactive TUI in a managed pane.
 */

import * as crypto from "node:crypto";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildChainTaskFromStages,
  collectRequestedAgentNamesFromChain,
  formatChainStageSummaries,
  getChainStageType,
  getStageLabel,
  shouldRunStage,
  type ChainExecutionState,
  type ChainParallelStage,
  type ChainStage,
  type ChainStageRecord,
  type ChainStageStatus,
  type ChainTaskStage,
  validateChainLabels,
  validateChainParallelLimit,
} from "./src/core/chain-helpers.js";
import { type AgentConfig, findNearestProjectAgentsDir, type AgentDiscoveryResult, type AgentScope, type DiscoverAgentOptions } from "./src/core/agents.js";
import { AgentDiscoveryCache } from "./src/core/agent-discovery-cache.js";
import { settleWithUnrefTimeout } from "./src/core/async-settle.js";
import { buildForkBranchSourceJsonl } from "./src/core/fork-session.js";
import { parseHerdrEnvironment } from "./src/core/herdr-environment.js";
import { probeHerdrReadiness } from "./src/runtime/herdr.js";
import { IncrementalResultSlots } from "./src/core/incremental-result-slots.js";
import { resolveSubagentLimits, resolveSubagentLimitsForSession, type SubagentLimits } from "./src/core/subagent-limits.js";
import { SubagentUxRegistry, formatSubagentUxDetail, formatSubagentUxFooter, formatSubagentUxList, formatSubagentUxStatus, parseSubagentsCommand, subagentUxTerminalNotification } from "./src/core/subagent-ux.js";
import { ReaperDiagnosticUx } from "./src/core/reaper-diagnostic-ux.js";
import { renderCall, renderResult } from "./src/ui/render.js";
import { getResultSummaryText } from "./src/core/runner-events.js";
import { emptyAccountingUsage, finalizeForegroundUsage, type AccountingUsage } from "./src/core/accounting-usage.js";
import { applySessionProjectTrustOverride, getConfigDir, getSessionProjectTrustOverride, isTrustedProjectAgentsDirWithSessionOverrides, resolveSessionProjectTrust } from "./src/core/project-trust.js";
import { beginInteractiveShutdownForSession, focusInteractiveRun, forkSourceReconciliationFailureDiagnostic, getInteractiveShutdownGenerationForTest, inspectInteractiveRunForUx, keepInteractiveRun, listActiveInteractiveRunIds, listInteractiveRunUxSnapshots, mapConcurrent, promoteInteractiveRun, resetInteractiveShutdownForSession, resolveManagedChildPolicy, runAgent, shutdownActiveInteractiveRuns, startStaleInteractiveReaper, subscribeInteractiveRunChanges, type InteractiveRunUxSnapshot, type ReaperDiagnostic, type RunAgentOptions, type StaleInteractiveReaperHandle } from "./src/runtime/runner.js";
import { ProcessLocalScheduler, type SchedulerHandle } from "./src/runtime/process-local-scheduler.js";
import { ForkSourceOwnershipManager } from "./src/runtime/fork-source-ownership.js";
import {
  createSharedForegroundPermitScopeManager,
  createTreePermitAuthorityLifecycle,
  type ForegroundDelegationScope,
  type TreePermitAuthority,
  type TreePermitLease,
} from "./src/runtime/tree-permit-authority.js";
import { createPiSubagentDashboardPublisher, type PiSubagentUxSnapshotLike } from "./src/integration/pi-cmux-contract.js";
import { createPiSubagentPresenceProducer } from "./src/integration/pi-presence-producer.js";
import { resolveInteractivePaneLayout, type InteractivePaneLayout } from "./src/runtime/interactive-layout.js";
import {
  BACKGROUND_BEHAVIOR_GUIDANCE,
  BackgroundJobSessionFence,
  cancelBackgroundJobs,
  createBackgroundJobRecord,
  extractToolText,
  finalizeBackgroundJobForSession,
  formatStoredBackgroundToolText,
  formatBackgroundJobListEntry,
  formatBackgroundJobStatusText,
  formatSubagentSystemPrompt,
  formatSubagentToolDescription,
  getBackgroundJobSnapshot,
  truncateAgentDescription,
  listBackgroundJobSnapshots,
  parseBackgroundAction,
  parseBackgroundFlag,
  validateSubagentInvocation,
  formatSubagentInvocationValidationError,
  formatSubagentOperationalError,
  pruneBackgroundJobs,
  type BackgroundJobRecord,
  type BackgroundJobToolResult,
  SubagentParams,
  getProjectRootFromAgentsDir,
  parseProjectRootEnvValue,
} from "./src/core/subagent-config.js";
import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  type TerminalMode,
  DEFAULT_DELEGATION_MODE,
  DEFAULT_TERMINAL_MODE,
  SUBAGENT_TOOL_LABEL,
  emptyUsage,
  getDefaultTerminalModeFromEnv,
  isInsideCmux,
  isInsideTmux,
  isResultError,
} from "./src/core/types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DELEGATION_DEPTH = 5;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TRUSTED_PROJECTS_ENV = "PI_SUBAGENT_TRUSTED_PROJECTS";
const SUBAGENT_DENIED_PROJECTS_ENV = "PI_SUBAGENT_DENIED_PROJECTS";
const HERDR_IDENTITY_ENV_NAMES = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"] as const;
/** Keeps the TUI selector responsive even when configured concurrency is high. */
const SUBAGENT_UX_SELECTOR_LIMIT = 32;
const INTERACTIVE_OWNERSHIP_PRESENTATION: Readonly<Record<InteractiveRunUxSnapshot["ownership"], { readonly icon: string; readonly label: string; readonly attention: number }>> = Object.freeze({
  "ownership-unknown": { icon: "⚠", label: "ownership unknown", attention: 0 },
  // This is the only exact waiting-like ownership state available in snapshots;
  // do not infer a pane lifecycle state from it.
  transferring: { icon: "◌", label: "transferring", attention: 1 },
  managed: { icon: "●", label: "managed", attention: 2 },
  kept: { icon: "◌", label: "kept", attention: 3 },
  detached: { icon: "↗", label: "detached", attention: 4 },
});

function compareInteractiveRunsForUx(left: InteractiveRunUxSnapshot, right: InteractiveRunUxSnapshot): number {
  return INTERACTIVE_OWNERSHIP_PRESENTATION[left.ownership].attention - INTERACTIVE_OWNERSHIP_PRESENTATION[right.ownership].attention
    || left.startedAt - right.startedAt
    || left.runId.localeCompare(right.runId);
}

function formatInteractiveOwnershipForUx(ownership: InteractiveRunUxSnapshot["ownership"]): string {
  const presentation = INTERACTIVE_OWNERSHIP_PRESENTATION[ownership];
  return `${presentation.icon} ${presentation.label}`;
}

/** Detached surfaces are user-owned, so presence must not aggregate their work. */
function listPresenceInteractiveRunSnapshots(): readonly InteractiveRunUxSnapshot[] {
  return listInteractiveRunUxSnapshots().filter((run) => run.ownership !== "detached");
}

function formatSubagentElapsedForUx(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

// CONFIG_DIR_NAME is public in current Pi hosts. Retain the documented default
// for older compatible hosts whose package root does not export it yet.
const CONFIG_DIR_NAME = typeof (piCodingAgent as unknown as { CONFIG_DIR_NAME?: unknown }).CONFIG_DIR_NAME === "string"
  ? (piCodingAgent as unknown as { CONFIG_DIR_NAME: string }).CONFIG_DIR_NAME
  : ".pi";
const getActiveAgentDir = (): string => {
  const getAgentDir = (piCodingAgent as unknown as { getAgentDir?: unknown }).getAgentDir;
  return typeof getAgentDir === "function" ? getAgentDir.call(piCodingAgent) : getConfigDir();
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DelegationDepthConfig {
  currentDepth: number;
  maxDepth: number;
  canDelegate: boolean;
  ancestorAgentStack: string[];
  preventCycles: boolean;
}

const BACKGROUND_RESULT_CUSTOM_TYPE = "subagent_result";
const backgroundJobs = new Map<string, BackgroundJobRecord>();
const backgroundJobSettlements = new Map<string, Promise<void>>();

function countRunningBackgroundJobs(): number {
  return Array.from(backgroundJobs.values()).filter(
    (job) => job.status === "running" || job.status === "cancelling",
  ).length;
}

function notifyBackgroundJobResult(pi: ExtensionAPI, job: BackgroundJobRecord): void {
  const details = {
    jobId: job.id,
    status: job.status,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
  const detailText = job.status === "cancelled" ? "" : extractToolText(job.result);
  const untrustedOutput = detailText
    ? `\n\n${formatStoredBackgroundToolText(detailText)}`
    : "";
  const errorText = job.error ? `\n\n${formatStoredBackgroundToolText(job.error)}` : "";
  const content = `Background subagent job ${job.id} ${job.status}.${untrustedOutput || errorText}`;

  try {
    pi.sendMessage(
      {
        customType: BACKGROUND_RESULT_CUSTOM_TYPE,
        content,
        display: true,
        details,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch (error) {
    console.warn(
      `[pi-subagent] Failed to deliver background result for job ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function startBackgroundJob(
  pi: ExtensionAPI,
  job: BackgroundJobRecord,
  run: (signal: AbortSignal) => Promise<BackgroundJobToolResult>,
  limits: SubagentLimits,
  sessionToken: number,
  sessionFence: BackgroundJobSessionFence,
  onSettled?: (job: BackgroundJobRecord, usage: AccountingUsage | undefined) => void,
): void {
  if (!sessionFence.isCurrent(sessionToken)) return;
  pruneBackgroundJobs(backgroundJobs, { maxCompletedJobs: limits.backgroundHistoryLimit, completedTtlMs: limits.backgroundHistoryTtlMs });
  backgroundJobs.set(job.id, job);

  let settlement: Promise<void>;
  settlement = run(job.controller.signal)
    .then((result) => {
      finalizeBackgroundJobForSession({
        job,
        result,
        sessionToken,
        isSessionCurrent: (token) => sessionFence.isCurrent(token),
        registry: backgroundJobs,
        outputMaxBytes: limits.backgroundOutputMaxBytes,
        maxCompletedJobs: limits.backgroundHistoryLimit,
        completedTtlMs: limits.backgroundHistoryTtlMs,
        onFinalized: (finalizedJob, finalizedUsage) => {
          onSettled?.(finalizedJob, finalizedUsage);
          notifyBackgroundJobResult(pi, finalizedJob);
        },
      });
    })
    .catch((error) => {
      finalizeBackgroundJobForSession({
        job,
        fallbackError: error instanceof Error ? error.message : String(error),
        sessionToken,
        isSessionCurrent: (token) => sessionFence.isCurrent(token),
        registry: backgroundJobs,
        outputMaxBytes: limits.backgroundOutputMaxBytes,
        maxCompletedJobs: limits.backgroundHistoryLimit,
        completedTtlMs: limits.backgroundHistoryTtlMs,
        onFinalized: (finalizedJob, finalizedUsage) => {
          onSettled?.(finalizedJob, finalizedUsage);
          notifyBackgroundJobResult(pi, finalizedJob);
        },
      });
    })
    .finally(() => {
      if (backgroundJobSettlements.get(job.id) === settlement) {
        backgroundJobSettlements.delete(job.id);
      }
    });
  backgroundJobSettlements.set(job.id, settlement);
}

function parseDelegationMode(raw: unknown): DelegationMode | null {
  if (raw === undefined) return DEFAULT_DELEGATION_MODE;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "spawn" || normalized === "fork") {
    return normalized;
  }
  return null;
}

function parseNonNegativeInt(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseBoolean(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function parseAgentStack(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (typeof raw !== "string") return null;
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((value) => typeof value === "string")) return null;
  return parsed
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function resolveDelegationDepthConfig(pi: ExtensionAPI): DelegationDepthConfig {
  const depthRaw = process.env[SUBAGENT_DEPTH_ENV];
  const parsedDepth = parseNonNegativeInt(depthRaw);
  if (depthRaw !== undefined && parsedDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_DEPTH_ENV}="${depthRaw}". Expected a non-negative integer.`,
    );
  }
  const currentDepth = parsedDepth ?? 0;

  const stackRaw = process.env[SUBAGENT_STACK_ENV];
  const ancestorAgentStack = parseAgentStack(stackRaw);
  if (stackRaw !== undefined && ancestorAgentStack === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_STACK_ENV} value. Expected a JSON array of agent names.`,
    );
  }

  const envMaxDepthRaw = process.env[SUBAGENT_MAX_DEPTH_ENV];
  const envMaxDepth = parseNonNegativeInt(envMaxDepthRaw);
  if (envMaxDepthRaw !== undefined && envMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_DEPTH_ENV}="${envMaxDepthRaw}". Expected a non-negative integer.`,
    );
  }

  const runtimeFlagValue = pi.getFlag("subagent-max-depth");
  const runtimeFlagMaxDepth =
    typeof runtimeFlagValue === "string"
      ? parseNonNegativeInt(runtimeFlagValue)
      : null;
  if (
    typeof runtimeFlagValue === "string" &&
    runtimeFlagMaxDepth === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${runtimeFlagValue}". Expected a non-negative integer.`,
    );
  }

  const envPreventCyclesRaw = process.env[SUBAGENT_PREVENT_CYCLES_ENV];
  const envPreventCycles = parseBoolean(envPreventCyclesRaw);
  if (envPreventCyclesRaw !== undefined && envPreventCycles === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid ${SUBAGENT_PREVENT_CYCLES_ENV}="${envPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const runtimePreventCyclesRaw = pi.getFlag("subagent-prevent-cycles");
  const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
  if (
    runtimePreventCyclesRaw !== undefined &&
    runtimePreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
    );
  }

  const maxDepth = runtimeFlagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const preventCycles =
    runtimePreventCycles ??
    envPreventCycles ??
    DEFAULT_PREVENT_CYCLE_DELEGATION;

  return {
    currentDepth,
    maxDepth,
    canDelegate: currentDepth < maxDepth,
    ancestorAgentStack: ancestorAgentStack ?? [],
    preventCycles,
  };
}

function makeDetailsFactory(
  projectAgentsDir: string | null,
  delegationMode: DelegationMode,
  terminalMode: TerminalMode,
) {
  return (
    mode: "single" | "parallel" | "chain",
    extras: Partial<Pick<SubagentDetails, "chainStageCount" | "chainCompletedCount" | "chainSkippedCount" | "chainFailedCount" | "chainCompletedWithErrorsCount">> = {},
  ) =>
    (results: SingleResult[]): SubagentDetails => ({
      mode,
      toolLabel: SUBAGENT_TOOL_LABEL,
      delegationMode,
      terminalMode,
      projectAgentsDir,
      results,
      ...extras,
    });
}

function formatAgentNames(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
}

function makeUnstartedAbortResult(
  agent: string,
  task: string,
  stageLabel?: string,
  model?: string,
): SingleResult {
  return {
    agent,
    agentSource: "unknown",
    task,
    stageLabel,
    exitCode: 1,
    messages: [],
    stderr: "Subagent task was not started because the parent invocation was aborted before it reached the concurrency queue.",
    usage: emptyUsage(),
    accountingUsage: emptyAccountingUsage(),
    model,
    stopReason: "aborted",
    errorMessage: "Not started: parent invocation was aborted.",
  };
}

function getCycleViolations(
  requestedNames: Set<string>,
  ancestorAgentStack: string[],
): string[] {
  if (requestedNames.size === 0 || ancestorAgentStack.length === 0) return [];
  const stackSet = new Set(ancestorAgentStack);
  return Array.from(requestedNames).filter((name) => stackSet.has(name));
}

/** Get project-local agents referenced by the current request. */
function getRequestedProjectAgents(
  agents: AgentConfig[],
  requestedNames: Set<string>,
): AgentConfig[] {
  return Array.from(requestedNames)
    .map((name) => {
      const matches = agents.filter((a) => a.name === name);
      return matches.find((a) => a.source === "project") ?? matches[0];
    })
    .filter((a): a is AgentConfig => a?.source === "project");
}

function inferInvocationMode(params: { agent?: unknown; task?: unknown; tasks?: unknown[]; chain?: unknown[] }): "single" | "parallel" | "chain" {
  if ((params.tasks?.length ?? 0) > 0) return "parallel";
  if ((params.chain?.length ?? 0) > 0) return "chain";
  return "single";
}

function validateConfiguredChainLimits(chain: ChainStage[], limits: SubagentLimits): string | null {
  return chain.length > limits.maxChainSteps
    ? `Too many chain stages (${chain.length}). Max is ${limits.maxChainSteps}.`
    : null;
}

function formatApprovalAgentNames(agents: AgentConfig[]): string {
  return Array.from(new Set(agents.map((agent) => agent.name))).sort().map((name) => JSON.stringify(name)).join(", ") || "none";
}

function getProjectUserNameCollisions(projectAgents: AgentConfig[], userAgents: AgentConfig[]): string[] {
  const userNames = new Set(userAgents.filter((agent) => agent.source === "user").map((agent) => agent.name));
  return Array.from(new Set(projectAgents.map((agent) => agent.name).filter((name) => userNames.has(name)))).sort();
}

function formatProjectAgentApprovalScope(
  projectRoot: string | null,
  projectAgents: AgentConfig[],
  requestedProjectAgents: AgentConfig[],
  userAgents: AgentConfig[],
): string {
  const collisions = getProjectUserNameCollisions(projectAgents, userAgents);
  return [
    `Project root: ${projectRoot ?? "(unknown)"}`,
    `Project agents in this root: ${formatApprovalAgentNames(projectAgents)}`,
    `Requested project agents: ${formatApprovalAgentNames(requestedProjectAgents)}`,
    `Project/user name collisions: ${collisions.map((name) => JSON.stringify(name)).join(", ") || "none"}`,
    "",
    "Approving trusts the entire listed project root for this session. Project agents may shadow same-named user agents.",
  ].join("\n");
}

/**
 * Prompt the user to trust the exact root containing a requested project agent.
 * Returns false if the user declines.
 */
async function requestProjectAgentApprovalIfNeeded(
  projectRoot: string | null,
  projectAgents: AgentConfig[],
  requestedProjectAgents: AgentConfig[],
  userAgents: AgentConfig[],
  ctx: { ui: { confirm: (title: string, body: string) => Promise<boolean> } },
): Promise<boolean> {
  if (requestedProjectAgents.length === 0) return true;

  return ctx.ui.confirm(
    "Trust project-local agent root for this session?",
    `${formatProjectAgentApprovalScope(projectRoot, projectAgents, requestedProjectAgents, userAgents)}\n\nChild Pi runs remain project-unapproved and do not load .pi settings, extensions, packages, or themes.`,
  );
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 5).",
    type: "string",
  });
  pi.registerFlag("subagent-max-active", {
    description: "Maximum active/reserved delegation-tree leases including the root on Linux/macOS; process-local child launches on Windows (default: 16).",
    type: "string",
  });
  for (const [name, description] of [
    ["subagent-max-parallel-tasks", "Maximum top-level parallel tasks (default: 50)."],
    ["subagent-max-chain-steps", "Maximum chain stages (default: 12)."],
    ["subagent-max-concurrency", "Maximum concurrent child mappings per invocation (default: 16)."],
    ["subagent-max-chain-parallel-tasks", "Maximum tasks in a chain parallel stage (default: 8)."],
    ["subagent-max-background-jobs", "Maximum running or cancelling background jobs (default: 16)."],
    ["subagent-background-history-limit", "Completed background job history count (default: 20)."],
    ["subagent-background-history-ttl-ms", "Completed background job history TTL in milliseconds (default: 3600000)."],
    ["subagent-background-output-max-bytes", "Background result/error output byte limit (default: 16384)."],
    ["subagent-background-shutdown-settle-ms", "Background shutdown settle time in milliseconds (default: 3000)."],
    ["subagent-parallel-heartbeat-ms", "Parallel progress heartbeat interval in milliseconds (default: 1000)."],
  ] as const) {
    pi.registerFlag(name, { description, type: "string" });
  }
  pi.registerFlag("subagent-prevent-cycles", {
    description:
      "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });
  pi.registerFlag("subagent-pane-layout", {
    description: "Interactive pane layout: auto (backend-native surface/window/tab) or split (per-run split).",
    type: "string",
  });
  // Resolve at extension initialization so an invalid inherited child value
  // cannot wait until a later tool invocation to fail.
  const interactivePaneLayout = resolveInteractivePaneLayout(pi.getFlag("subagent-pane-layout"));
  const depthConfig = resolveDelegationDepthConfig(pi);
  // A safe pre-session snapshot keeps tool calls deterministic if a host invokes
  // one before session_start. Session starts replace it after loading JSON files.
  let limits = resolveSubagentLimits({ getFlag: (name) => pi.getFlag(name) });
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;
  const scheduler = new ProcessLocalScheduler(limits.maxActive);
  // A scheduler handle is invocation authority. Fork managers never cross this
  // generation:id boundary, including concurrent/background invocations.
  const forkManagers = new Map<string, ForkSourceOwnershipManager>();
  const forkHandoffs = new WeakMap<ForkSourceOwnershipManager, ReturnType<ForkSourceOwnershipManager["reconcile"]>>();
  const handoffForkManager = (manager: ForkSourceOwnershipManager) => {
    const existing = forkHandoffs.get(manager);
    if (existing) return existing;
    const handoff = (async () => {
      await manager.quiesce();
      const recovery = await ForkSourceOwnershipManager.open(manager.paths.invocationDir);
      return await recovery.reconcile({ allowDeadOwnerSeal: true });
    })();
    forkHandoffs.set(manager, handoff);
    return handoff;
  };
  const treePermitAuthorityLifecycle = createTreePermitAuthorityLifecycle();
  const foregroundPermitScopes = createSharedForegroundPermitScopeManager();
  const getTreePermitAuthority = async (): Promise<TreePermitAuthority | null> =>
    await treePermitAuthorityLifecycle.get(limits.maxActive);
  const acquireForegroundPermitScope = async (authority: TreePermitAuthority): Promise<ForegroundDelegationScope> =>
    await foregroundPermitScopes.acquire(authority) as ForegroundDelegationScope;
  const releaseForegroundPermitScope = async (scope: ForegroundDelegationScope): Promise<boolean> =>
    await foregroundPermitScopes.release(scope);
  const backgroundSessionFence = new BackgroundJobSessionFence();
  const uxRegistry = new SubagentUxRegistry({ recentLimit: 20 });
  const reaperDiagnosticUx = new ReaperDiagnosticUx();
  let reaperDiagnosticGeneration = 0;
  const reportReaperDiagnostic = (expectedGeneration: number, diagnostic: ReaperDiagnostic, ctx: { hasUI: boolean; ui: { notify: (message: string, type: "warning" | "error") => void } }): void => {
    reaperDiagnosticUx.report(expectedGeneration, diagnostic, {
      hasUI: ctx.hasUI,
      notify: (message, type) => ctx.ui.notify(message, type),
      warn: (message, details) => console.warn(message, details),
    });
  };
  const dashboardPublisher = currentDepth === 0
    ? createPiSubagentDashboardPublisher({
      emit: (channel, payload) => pi.events.emit(channel, payload),
      getSchedulerCounts: () => ({ active: scheduler.activeCount, queued: scheduler.queuedCount }),
      getInteractiveActiveCount: () => listActiveInteractiveRunIds().length,
    })
    : null;
  const presenceProducer = currentDepth === 0
    ? createPiSubagentPresenceProducer({
      emit: (channel, payload) => pi.events.emit(channel, payload),
      getSchedulerCounts: () => ({ active: scheduler.activeCount, queued: scheduler.queuedCount }),
      getInteractiveActiveCount: () => listPresenceInteractiveRunSnapshots().length,
      // Atomic process-local correlation only; IDs never enter V2 DTOs.
      getInteractiveActiveInvocationIds: () => listPresenceInteractiveRunSnapshots().map((run) => run.invocationId),
    })
    : null;
  // This is the single UX update boundary for invocation progress. It reads
  // structured details only; child task/output text cannot reach presence.
  const updateUxFromPartial = (id: string, generation: number, value: { content?: Array<{ type?: string; text?: string }>; details?: any } | undefined) => {
    const text = value?.content?.filter((entry) => entry.type === "text" && typeof entry.text === "string").at(-1)?.text;
    if (text) uxRegistry.updatePreview(id, text, generation);
    const details = value?.details;
    if (details?.mode === "parallel" && Array.isArray(details.results) && details.results.length > 0) {
      const completed = details.results.filter((result: unknown) => typeof result === "object" && result !== null && (result as { exitCode?: unknown }).exitCode !== -1).length;
      uxRegistry.updateProgress(id, Math.min(details.results.length, completed), details.results.length, generation);
    } else if (details?.mode === "chain" && Number.isSafeInteger(details.chainStageCount) && details.chainStageCount > 0) {
      const keys = ["chainCompletedCount", "chainSkippedCount", "chainFailedCount", "chainCompletedWithErrorsCount"] as const;
      const completed = keys.reduce((sum, key) => {
        const count = details[key];
        return sum + (Number.isSafeInteger(count) && count >= 0 ? count : 0);
      }, 0);
      uxRegistry.updateProgress(id, Math.min(details.chainStageCount, completed), details.chainStageCount, generation);
    }
  };
  let unsubscribeUxStatus: (() => void) | null = null;
  let unsubscribeSchedulerStatus: (() => void) | null = null;
  let unsubscribeInteractiveRunChanges: (() => void) | null = null;

  if (currentDepth === 0) {
    pi.registerCommand("subagents", {
      description: "List, inspect, diagnose, or cancel process-local subagent runs",
      getArgumentCompletions: (prefix) => {
        const fixed = ["list", "doctor", "cancel ", "details ", "focus ", "keep ", "promote "];
        const jobs = uxRegistry.snapshot().active;
        const interactive = listInteractiveRunUxSnapshots();
        const ids = [
          ...jobs.flatMap((job) => [`cancel ${job.id}`, `details ${job.id}`]),
          ...interactive.flatMap((run) => [`details ${run.runId}`, `focus ${run.runId}`, `keep ${run.runId}`, `promote ${run.runId}`]),
        ];
        const values = [...fixed, ...ids].filter((value) => value.startsWith(prefix));
        return values.length > 0 ? values.map((value) => ({ value, label: value })) : null;
      },
      handler: async (rawArgs, ctx) => {
        const command = parseSubagentsCommand(rawArgs);
        if (!command) {
          ctx.ui.notify("Usage: /subagents [list|doctor|cancel|details|focus|keep|promote <full-id>]", "error");
          return;
        }
        if (command.kind === "doctor") {
          const terminal = getDefaultTerminalModeFromEnv();
          const hasCmuxFields = process.env.CMUX_WORKSPACE_ID !== undefined || process.env.CMUX_SURFACE_ID !== undefined;
          const hasHerdrFields = HERDR_IDENTITY_ENV_NAMES.some((name) => process.env[name] !== undefined);
          const hasTmuxFields = process.env.TMUX !== undefined || process.env.TMUX_PANE !== undefined;
          const piCmuxTool = pi.getAllTools().some((tool) => tool.name === "cmux_open_terminal" && tool.sourceInfo.source !== "builtin");
          const piCmuxCommand = pi.getCommands().some((entry) => entry.source === "extension" && /^(?:cmv|cmh|cmo|cmt)(?::\d+)?$/.test(entry.name));
          const lines = [
            `terminal: ${terminal}`,
            `cmux identity: ${hasCmuxFields ? isInsideCmux() ? "valid" : "invalid" : "not present"}`,
            `herdr identity: ${hasHerdrFields ? parseHerdrEnvironment() ? "valid" : "invalid" : "not present"}`,
            "herdr readiness: checking",
            `tmux identity: ${hasTmuxFields ? isInsideTmux() ? "valid" : "invalid" : "not present"}`,
            `layout: ${interactivePaneLayout}`,
            `child policy: ${resolveManagedChildPolicy()}`,
            `scheduler: ${scheduler.activeCount} active, ${scheduler.queuedCount} queued, max ${scheduler.maxActive}`,
            `interactive authority: ${listActiveInteractiveRunIds().length} active`,
            ...reaperDiagnosticUx.formatDoctorStatus(),
            `pi-cmux metadata: ${piCmuxTool || piCmuxCommand ? "possibly detected (registry name only)" : "not observable"}`,
            "control readiness: validated per interactive launch (no doctor probe)",
          ];
          // The probe is observation-only and deliberately exposes only its
          // bounded category, never Herdr identities or socket paths.
          const readiness = await probeHerdrReadiness();
          lines[3] = `herdr readiness: ${readiness.ready ? "ready" : `not-ready (${readiness.category})`}`;
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        if (command.kind === "cancel") {
          const snapshot = uxRegistry.get(command.id);
          if (!snapshot) {
            ctx.ui.notify(`Unknown subagent invocation id: ${command.id}`, "error");
            return;
          }
          if (snapshot.status !== "running") {
            ctx.ui.notify(`Subagent ${command.id} is ${snapshot.status}.`, "warning");
            return;
          }
          if (ctx.hasUI && !await ctx.ui.confirm("Cancel subagent?", `${snapshot.agent} (${snapshot.id})`)) return;
          const cancelled = uxRegistry.cancel(command.id, snapshot.generation);
          ctx.ui.notify(cancelled.changed ? `Cancelling subagent ${command.id}.` : `Subagent ${command.id} was not cancelled.`, cancelled.changed ? "info" : "warning");
          return;
        }
        if (command.kind === "details") {
          const invocation = uxRegistry.get(command.id);
          if (invocation) { ctx.ui.notify(formatSubagentUxDetail(invocation), "info"); return; }
          const run = await inspectInteractiveRunForUx(command.id);
          if (!run) { ctx.ui.notify(`Unknown interactive run id: ${command.id}`, "error"); return; }
          const elapsed = Math.max(0, Date.now() - run.startedAt);
          ctx.ui.notify([
            `Interactive subagent ${run.runId}`,
            `- agent: ${run.agent}`,
            `- backend: ${run.backend}${run.placement ? `/${run.placement}` : ""}`,
            `- ownership: ${run.ownership}`,
            `- depth: ${run.depth}`,
            `- elapsedMs: ${elapsed}`,
            `- target: ${run.exists === undefined ? "unknown" : run.exists ? run.exited ? "exited" : "present" : "absent"}`,
            ...(run.herdr ? [`- herdr transport: ${run.herdr.transport}`, `- herdr target: ${run.herdr.target}`, `- herdr orphan-risk: ${run.herdr.orphanRisk}`] : []),
            `- focus: ${run.focusSupported ? "supported" : "unsupported"}`,
            `- promote: ${run.promoteSupported ? "supported" : "unsupported"}`,
            ...(run.title ? [`- managedTitle: ${run.title}`, `- titleState: ${run.titleState ?? "unavailable"}`] : []),
            ...(run.preview ? [`- preview: ${run.preview}`] : []),
          ].join("\n"), "info");
          return;
        }
        if (command.kind === "focus") {
          const focused = await focusInteractiveRun(command.id);
          ctx.ui.notify(focused ? `Focused interactive subagent ${command.id}.` : `Could not safely focus interactive subagent ${command.id}.`, focused ? "info" : "warning");
          return;
        }
        if (command.kind === "keep") {
          const kept = await keepInteractiveRun(command.id);
          ctx.ui.notify(kept ? `Keeping interactive subagent ${command.id} until session shutdown or promotion.` : `Could not keep interactive subagent ${command.id}.`, kept ? "info" : "warning");
          return;
        }
        if (command.kind === "promote") {
          if (ctx.hasUI && !await ctx.ui.confirm("Promote subagent surface?", `Transfer ${command.id} to user ownership and exclude it from automatic cleanup.`)) return;
          // Capture the exact active-run metadata before the promotion removes
          // it from the registry; only a fresh durable promotion may publish.
          const activeSnapshot = await inspectInteractiveRunForUx(command.id);
          const detachedAt = Date.now();
          const promoted = activeSnapshot ? await promoteInteractiveRun(command.id, detachedAt) : "rejected";
          // Promotion may make a deferred settlement quiescent; presence is an
          // observer, so republishing has no lifecycle authority.
          presenceProducer?.publish(uxRegistry.snapshot());
          if (promoted === "promoted" && activeSnapshot) dashboardPublisher?.publishDetached({
            runId: activeSnapshot.runId,
            agent: activeSnapshot.agent,
            backend: activeSnapshot.backend,
            detachedAt,
          });
          const notification = promoted === "promoted"
            ? `Promoted interactive subagent ${command.id} to user ownership.`
            : promoted === "already-promoted"
              ? `Interactive subagent ${command.id} was already promoted to user ownership.`
              : promoted === "ownership-unknown"
                ? `Interactive subagent ${command.id} remains visible: cleanup authority is unknown/revoked, so automatic cleanup is disabled.`
                : `Could not safely promote interactive subagent ${command.id}.`;
          ctx.ui.notify(notification, promoted === "rejected" ? "warning" : "info");
          return;
        }
        const jobs = uxRegistry.list();
        const interactive = [...listInteractiveRunUxSnapshots()].sort(compareInteractiveRunsForUx);
        const commandMode = (ctx as typeof ctx & { mode?: string }).mode;
        if (rawArgs.trim() === "" && commandMode === "tui" && jobs.length + interactive.length > 0) {
          const jobAttention: Record<(typeof jobs)[number]["status"], number> = { failed: 0, cancelling: 1, running: 2, completed: 3, cancelled: 4 };
          const entries = [
            ...jobs.map((job) => ({
              rank: jobAttention[job.status], startedAt: job.startedAt, id: job.id,
              label: `${job.agent} · ${formatSubagentUxStatus(job.status)} · ${formatSubagentElapsedForUx((job.completedAt ?? Date.now()) - job.startedAt)} · ${job.id}${job.preview ? ` · ${job.preview}` : ""}`,
              detail: formatSubagentUxDetail(job), focusRunId: undefined as string | undefined,
            })),
            ...interactive.map((run) => ({
              rank: INTERACTIVE_OWNERSHIP_PRESENTATION[run.ownership].attention, startedAt: run.startedAt, id: run.runId,
              label: `${run.agent} · interactive/${formatInteractiveOwnershipForUx(run.ownership)} · d${run.depth} · ${formatSubagentElapsedForUx(Date.now() - run.startedAt)} · ${run.runId}${run.herdr ? ` · herdr ${run.herdr.transport}/${run.herdr.target}` : ""}${run.preview ? ` · ${run.preview}` : ""}`,
              detail: `Interactive ${run.runId}\n- backend: ${run.backend}${run.placement ? `/${run.placement}` : ""}\n- depth: ${run.depth}${run.herdr ? `\n- herdr transport: ${run.herdr.transport}\n- herdr target: ${run.herdr.target}\n- herdr orphan-risk: ${run.herdr.orphanRisk}` : ""}${run.preview ? `\n- preview: ${run.preview}` : ""}\nUse /subagents details ${run.runId} for an exact live diagnostic.`,
              focusRunId: run.runId,
            })),
          ].sort((left, right) => left.rank - right.rank || left.startedAt - right.startedAt || left.id.localeCompare(right.id)).slice(0, SUBAGENT_UX_SELECTOR_LIMIT);
          const selected = await ctx.ui.select("Subagents", entries.map((entry) => entry.label));
          const entry = entries.find((candidate) => candidate.label === selected);
          if (entry?.focusRunId && await focusInteractiveRun(entry.focusRunId)) return;
          if (entry) ctx.ui.notify(entry.detail, "info");
          return;
        }
        const invocationText = formatSubagentUxList(jobs);
        const interactiveText = interactive.length ? interactive.map((run) => `- ${run.runId} [${formatInteractiveOwnershipForUx(run.ownership)}] interactive ${run.backend}${run.placement ? `/${run.placement}` : ""} ${run.agent}${run.herdr ? ` · herdr ${run.herdr.transport}/${run.herdr.target} orphan-risk:${run.herdr.orphanRisk}` : ""}${run.preview ? ` — ${run.preview}` : ""}`).join("\n") : "No interactive surfaces.";
        ctx.ui.notify(`${invocationText}\n${interactiveText}`, "info");
      },
    });
  }

  let discoveredAgents: AgentConfig[] = [];
  let sessionShuttingDown = false;
  let startupReaper: StaleInteractiveReaperHandle | null = null;
  const cancelStartupReaperBounded = async (): Promise<void> => {
    const reaper = startupReaper;
    if (!reaper) return;
    await settleWithUnrefTimeout([reaper.cancelAndDrain().catch(() => undefined)], limits.backgroundShutdownSettleMs);
    if (startupReaper === reaper) startupReaper = null;
  };
  const discoveryCache = new AgentDiscoveryCache();

  const treePermitSources = new Map<string, { source: TreePermitAuthority | ForegroundDelegationScope; scope?: ForegroundDelegationScope }>();
  const runScheduledAgent = async (
    handle: SchedulerHandle,
    options: RunAgentOptions,
  ): Promise<SingleResult> => {
    let forkChildId: string | undefined;
    const schedulerKey = `${handle.generation}:${handle.id}`;
    const forkManager = options.delegationMode === "fork" ? forkManagers.get(schedulerKey) : undefined;
    const permitContext = treePermitSources.get(schedulerKey);
    try {
      if (options.delegationMode === "fork" && !forkManager) throw new Error("Fork source ownership manager is unavailable for this invocation.");
      if (forkManager) {
        forkChildId = crypto.randomUUID();
        await forkManager.registerChild({
          childId: forkChildId,
          surface: options.terminalMode === "inline" ? "inline" : "interactive",
          runId: options.terminalMode === "inline" ? null : forkChildId,
        });
      }
      const managedOverriddenBuiltinTools = pi.getAllTools()
        .filter((tool) => ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(tool.name) && tool.sourceInfo.source !== "builtin")
        .map((tool) => tool.name);
      const scheduled = await scheduler.schedule(handle, async () => {
        const treePermitLease = permitContext
          ? (await permitContext.source.waitForReservation({ signal: options.signal }) ?? undefined)
          : undefined;
        if (permitContext && !treePermitLease) return makeUnstartedAbortResult(options.agentName, options.task, options.stageLabel, options.model);
        try {
          return await runAgent({ ...options, forkSourceOwnership: forkManager, forkChildId, treePermitLease, maxActive: limits.maxActive, limits, managedOverriddenBuiltinTools });
        } finally {
          if (treePermitLease) {
            const releasedBeforeBind = await treePermitLease.release().catch(() => false);
            if (permitContext?.scope && !releasedBeforeBind) {
              const settled = await permitContext.scope.completeChild(treePermitLease).catch(() => false);
              // A result can arrive just before its exact child is observable
              // as dead. Keep the parked parent recoverable without revoking a
              // live child; the scope owns one unref'd retry loop per lease.
              if (!settled) permitContext.scope.watchChildSettlement(treePermitLease);
            } else if (!permitContext?.scope && !releasedBeforeBind) {
              await treePermitLease.finalizeBoundChildIfDead().catch(() => false);
            }
          }
        }
      }, options.signal);
      if (scheduled.started) return scheduled.value;
      if (forkManager && forkChildId) await forkManager.markTerminal(forkChildId, "no-launch");
      return makeUnstartedAbortResult(options.agentName, options.task, options.stageLabel, options.model);
    } catch (error) {
      if (forkManager && forkChildId) await forkManager.markTerminal(forkChildId, "launch-failed").catch(() => undefined);
      const agent = options.agents.find((candidate) => candidate.name === options.agentName);
      const message = error instanceof Error ? error.message : String(error);
      return {
        agent: options.agentName,
        agentSource: agent?.source ?? "unknown",
        task: options.task,
        stageLabel: options.stageLabel,
        exitCode: 1,
        messages: [],
        stderr: message,
        usage: emptyUsage(),
        accountingUsage: emptyAccountingUsage(),
        model: options.model ?? agent?.model,
        stopReason: "error",
        errorMessage: message,
      };
    }
  };

  const sessionTrustedProjectDirs = new Set<string>(parseProjectRootEnvValue(process.env[SUBAGENT_TRUSTED_PROJECTS_ENV]));
  const sessionDeniedProjectDirs = new Set<string>(parseProjectRootEnvValue(process.env[SUBAGENT_DENIED_PROJECTS_ENV]));

  const isProjectTrustedForSession = (projectAgentsDir: string | null): boolean =>
    isTrustedProjectAgentsDirWithSessionOverrides(projectAgentsDir, {
      sessionTrustedProjectRoots: sessionTrustedProjectDirs,
      sessionDeniedProjectRoots: sessionDeniedProjectDirs,
    });

  const discoverForSession = (
    cwd: string,
    scope: AgentScope,
    options: DiscoverAgentOptions = {},
  ): AgentDiscoveryResult => {
    const projectAgentsDir = findNearestProjectAgentsDir(cwd);
    const trustedProjectRoot = isProjectTrustedForSession(projectAgentsDir)
      ? getProjectRootFromAgentsDir(projectAgentsDir)
      : null;
    return discoveryCache.discover(cwd, scope, {
      metadataOnly: options.metadataOnly,
      trustedProjectRoot,
      sessionTrustedProjectRoots: sessionTrustedProjectDirs,
      sessionDeniedProjectRoots: sessionDeniedProjectDirs,
    });
  };

  // Auto-discover agents on session start
  pi.on("session_start", async (_event, ctx) => {
    const projectAgentsDir = findNearestProjectAgentsDir(ctx.cwd);
    const projectTrustOverride = getSessionProjectTrustOverride(ctx);
    const trustedProject = resolveSessionProjectTrust(
      projectAgentsDir,
      projectTrustOverride,
      sessionTrustedProjectDirs,
      sessionDeniedProjectDirs,
      // Pi-subagent descendants always use --no-approve, regardless of the
      // interactive extension policy. Preserve only their inherited exact-root
      // authorization; explicit inherited denials still take priority.
      { preserveInheritedSessionTrustOnDeny: currentDepth > 0 },
    );
    limits = await resolveSubagentLimitsForSession({
      agentDir: getActiveAgentDir(),
      cwd: ctx.cwd,
      configDirName: CONFIG_DIR_NAME,
      projectTrusted: trustedProject,
      getFlag: (name) => pi.getFlag(name),
    });

    // A new session never inherits old-session background records or reaper
    // diagnostics. Advance the fence before cancellation so a late old-session
    // completion cannot notify the replacement TUI.
    backgroundSessionFence.startSession();
    reaperDiagnosticGeneration = reaperDiagnosticUx.startSession();
    cancelBackgroundJobs(backgroundJobs);
    backgroundJobs.clear();
    unsubscribeUxStatus?.();
    unsubscribeUxStatus = null;
    unsubscribeSchedulerStatus?.();
    unsubscribeSchedulerStatus = null;
    unsubscribeInteractiveRunChanges?.();
    unsubscribeInteractiveRunChanges = null;
    const uxGeneration = uxRegistry.reset();
    if (currentDepth === 0 && dashboardPublisher) {
      dashboardPublisher.startSession(ctx.sessionManager.getSessionId(), uxGeneration);
      presenceProducer?.startSession(ctx.sessionManager.getSessionId(), uxGeneration);
      const notifiedTerminalIds = new Set<string>();
      const updateObservers = (snapshot: PiSubagentUxSnapshotLike, schedulerQueued = scheduler.queuedCount) => {
        dashboardPublisher.publish(snapshot);
        presenceProducer?.publish(snapshot);
        if (ctx.hasUI) {
          ctx.ui.setStatus("pi-subagent-runs", formatSubagentUxFooter(snapshot, schedulerQueued));
          for (const item of snapshot.recent) {
            const notification = subagentUxTerminalNotification(item.status);
            if (!notification || notifiedTerminalIds.has(item.id)) continue;
            notifiedTerminalIds.add(item.id);
            while (notifiedTerminalIds.size > 256) {
              const oldest = notifiedTerminalIds.values().next().value;
              if (oldest === undefined) break;
              notifiedTerminalIds.delete(oldest);
            }
            try {
              ctx.ui.notify(`Subagent ${item.agent} (${item.id}) failed.`, notification);
            } catch { /* Pi TUI notifications are non-authoritative. */ }
          }
        }
      };
      unsubscribeUxStatus = uxRegistry.subscribe(updateObservers);
      unsubscribeSchedulerStatus = scheduler.subscribe((state) => updateObservers(uxRegistry.snapshot(), state.queued));
      unsubscribeInteractiveRunChanges = subscribeInteractiveRunChanges(() => {
        // Presence observes the registry only; lifecycle authority remains in
        // the runner. This republish lets deferred idle settlement see zero.
        presenceProducer?.publish(uxRegistry.snapshot());
      });
      updateObservers(uxRegistry.snapshot());
      if (ctx.isIdle()) presenceProducer?.settle();
    }
    backgroundJobSettlements.clear();
    sessionShuttingDown = false;
    discoveryCache.startSession();
    scheduler.startSession(limits.maxActive);
    await treePermitAuthorityLifecycle.startup(limits.maxActive);
    await resetInteractiveShutdownForSession();
    if (currentDepth === 0) {
      await cancelStartupReaperBounded();
      const diagnosticGeneration = reaperDiagnosticGeneration;
      try {
        const reaper = await startStaleInteractiveReaper();
        startupReaper = reaper;
        // Observe completion before awaiting startup: both promises can reject
        // from the same enumeration failure, and neither may go unhandled.
        const observedCompletion = reaper.completion.then(
          (outcome) => ({ outcome } as const),
          (error: unknown) => ({ error } as const),
        );
        void observedCompletion.finally(() => { if (startupReaper === reaper) startupReaper = null; });
        await reaper.startup;
        void observedCompletion.then((settled) => {
          if (diagnosticGeneration !== reaperDiagnosticGeneration || sessionShuttingDown) return;
          if ("outcome" in settled) {
            for (const diagnostic of settled.outcome.diagnostics) reportReaperDiagnostic(diagnosticGeneration, diagnostic, ctx);
            return;
          }
          reportReaperDiagnostic(diagnosticGeneration, {
            severity: "error",
            code: "reaper-completion-failed",
            message: "Stale interactive run cleanup failed. Run /subagents doctor.",
            details: { error: settled.error instanceof Error ? settled.error.message : String(settled.error) },
          }, ctx);
        });
      } catch (error) {
        reportReaperDiagnostic(diagnosticGeneration, {
          severity: "error",
          code: "reaper-start-failed",
          message: "Stale interactive run cleanup could not start. Run /subagents doctor.",
          details: { error: error instanceof Error ? error.message : String(error) },
        }, ctx);
      }
    }
    if (!canDelegate) return;

    const discovery = trustedProject
      ? discoverForSession(ctx.cwd, "both")
      : discoverForSession(ctx.cwd, "user");
    discoveredAgents = discovery.agents;
  });

  if (currentDepth === 0) {
    pi.on("agent_start", () => { presenceProducer?.beginAgentRun(); });
    pi.on("agent_settled", (_event, ctx) => {
      if (ctx.isIdle()) presenceProducer?.settle();
    });
  }

  pi.on("session_shutdown", async (_event, ctx) => {
    // Invalidate and quarantine before any await/cancellation so a late
    // old-session finalizer cannot repopulate the registry or send a steer.
    sessionShuttingDown = true;
    backgroundSessionFence.invalidate();
    reaperDiagnosticGeneration = reaperDiagnosticUx.invalidateSession();
    const priorSessionSettlements = Array.from(backgroundJobSettlements.values());
    cancelBackgroundJobs(backgroundJobs);
    backgroundJobs.clear();
    backgroundJobSettlements.clear();
    unsubscribeUxStatus?.();
    unsubscribeUxStatus = null;
    unsubscribeSchedulerStatus?.();
    unsubscribeSchedulerStatus = null;
    unsubscribeInteractiveRunChanges?.();
    unsubscribeInteractiveRunChanges = null;
    if (currentDepth === 0) {
      dashboardPublisher?.stop();
      presenceProducer?.stop();
    }
    uxRegistry.reset();
    if (currentDepth === 0 && ctx.hasUI) ctx.ui.setStatus("pi-subagent-runs", undefined);

    discoveryCache.clear();
    scheduler.shutdown();
    // An active exact child must retain its permit across this Pi session
    // boundary. Idle watcher cancellation only drains already-settled local
    // bookkeeping and never releases a live child.
    await settleWithUnrefTimeout([foregroundPermitScopes.cancelSettlementWatchersIfIdle()], limits.backgroundShutdownSettleMs);
    await cancelStartupReaperBounded();
    await beginInteractiveShutdownForSession();
    await settleWithUnrefTimeout(priorSessionSettlements, limits.backgroundShutdownSettleMs);
    await shutdownActiveInteractiveRuns();
    const strandedForkManagers = Array.from(forkManagers.entries());
    const shutdownDiagnosticGeneration = reaperDiagnosticGeneration;
    const handoffs = strandedForkManagers.map(([key, manager]) => handoffForkManager(manager)
      .catch((error) => reportReaperDiagnostic(
        shutdownDiagnosticGeneration,
        forkSourceReconciliationFailureDiagnostic(error, true),
        { hasUI: false, ui: ctx.ui },
      ))
      .finally(() => { if (forkManagers.get(key) === manager) forkManagers.delete(key); }));
    await settleWithUnrefTimeout(handoffs, limits.backgroundShutdownSettleMs);
  });

  // Inject available agents into the system prompt
  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    if (discoveredAgents.length === 0) return;

    const agentList = discoveredAgents
      .map((a) => JSON.stringify([a.name, truncateAgentDescription(a.description)]))
      .join("\n");
    return {
      systemPrompt:
        event.systemPrompt +
        formatSubagentSystemPrompt({
          agentList,
          currentDepth,
          maxDepth,
          preventCycles,
          stack: JSON.stringify(ancestorAgentStack.length > 0 ? ancestorAgentStack : ["root"]),
        }),
    };
  });

  // Register the subagent tool
  if (canDelegate) {
    pi.registerTool({
      name: "subagent",
      label: SUBAGENT_TOOL_LABEL,
      description: formatSubagentToolDescription(),
      parameters: SubagentParams,

      // Reject raw model arguments before the host applies Value.Convert. The
      // host's converter intentionally coerces values, while invocation shape
      // validation must be strict and side-effect free.
      prepareArguments(raw) {
        const validationError = validateSubagentInvocation(raw);
        if (validationError) throw new Error(formatSubagentInvocationValidationError(validationError));
        return raw as never;
      },

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const invocationDiagnosticGeneration = reaperDiagnosticGeneration;
        const terminalMode = getDefaultTerminalModeFromEnv();
        const rawValidationError = validateSubagentInvocation(params);
        if (rawValidationError) throw new Error(formatSubagentInvocationValidationError(rawValidationError));
        const failOperational = (
          category: "runtime-policy" | "child-execution" | "cancellation",
          message: string,
        ): never => {
          throw new Error(formatSubagentOperationalError(category, message));
        };

        const intendedMode = inferInvocationMode(params);
        if (params.tasks && params.tasks.length > limits.maxParallelTasks) {
          throw new Error(formatSubagentOperationalError(
            "runtime-policy",
            `Too many parallel tasks (${params.tasks.length}). Max is ${limits.maxParallelTasks}.`,
          ));
        }
        if (params.chain) {
          const chainLimitError = validateConfiguredChainLimits(params.chain as ChainStage[], limits)
            ?? validateChainParallelLimit(params.chain as ChainStage[], limits.maxChainParallelTasks);
          if (chainLimitError) throw new Error(formatSubagentOperationalError("runtime-policy", chainLimitError));
          const chainLabelError = validateChainLabels(params.chain as ChainStage[]);
          if (chainLabelError) {
            throw new Error(formatSubagentInvocationValidationError({
              category: "invocation-shape",
              message: chainLabelError,
            }));
          }
        }

        const projectAgentsDir = findNearestProjectAgentsDir(ctx.cwd);
        const earlyToolDetails = makeDetailsFactory(
          projectAgentsDir,
          DEFAULT_DELEGATION_MODE,
          getDefaultTerminalModeFromEnv(),
        )("single")([]);

        if (sessionShuttingDown) {
          failOperational("runtime-policy", "Cannot start subagents while the parent session is shutting down.");
        }
        // Capture only after the initial session check. A reset deliberately
        // creates a different generation, so stale approval/background work
        // can never become valid in the new session.
        const interactiveShutdownGeneration = getInteractiveShutdownGenerationForTest();
        const canStartInvocation = () => !sessionShuttingDown
          && getInteractiveShutdownGenerationForTest() === interactiveShutdownGeneration;

        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasChain = (params.chain?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        // Raw validation above makes these parsers total for the accepted input.
        const action = parseBackgroundAction(params.action);
        const background = parseBackgroundFlag(params.background)!;

        if (action) {
          pruneBackgroundJobs(backgroundJobs, { maxCompletedJobs: limits.backgroundHistoryLimit, completedTtlMs: limits.backgroundHistoryTtlMs });
          if (action === "status") {
            if (typeof params.id === "string") {
              const job = getBackgroundJobSnapshot(params.id, backgroundJobs);
              if (!job) {
                return failOperational("runtime-policy", `Background subagent job ${params.id} was not found.`);
              }
              return {
                content: [{ type: "text", text: formatBackgroundJobStatusText(job) }],
                details: earlyToolDetails,
              };
            }

            const jobs = listBackgroundJobSnapshots(backgroundJobs);
            return {
              content: [{
                type: "text",
                text: jobs.length > 0
                  ? `Background subagent jobs (${jobs.length}):\n${jobs.map((job) => formatBackgroundJobListEntry(job)).join("\n")}`
                  : "No background subagent jobs.",
              }],
              details: earlyToolDetails,
            };
          }

          const cancellation = cancelBackgroundJobs(backgroundJobs, typeof params.id === "string" ? params.id : undefined);
          for (const cancelledJob of cancellation.cancelled) uxRegistry.cancel(cancelledJob.id);
          if (!cancellation.found) {
            failOperational("runtime-policy", `Background subagent job ${String(params.id)} was not found.`);
          }
          if (typeof params.id === "string") {
            if (cancellation.cancelled.length > 0) {
              return {
                content: [{ type: "text", text: `Requested cancellation for background subagent job ${params.id}.` }],
                details: earlyToolDetails,
              };
            }
            const terminalJob = cancellation.terminal[0];
            return {
              content: [{
                type: "text",
                text: terminalJob
                  ? `Background subagent job ${terminalJob.id} is already ${terminalJob.status}.`
                  : `Background subagent job ${params.id} is not running.`,
              }],
              details: earlyToolDetails,
            };
          }

          return {
            content: [{
              type: "text",
              text: cancellation.cancelled.length > 0
                ? `Requested cancellation for ${cancellation.cancelled.length} background subagent job(s): ${cancellation.cancelled.map((job) => job.id).join(", ")}.`
                : "No running background subagent jobs.",
            }],
            details: earlyToolDetails,
          };
        }

        const trustedProjectAtStart = isProjectTrustedForSession(projectAgentsDir);
        const untrustedProjectAgents = trustedProjectAtStart ? [] : discoverForSession(ctx.cwd, "project", { metadataOnly: true }).agents;
        const discovery = trustedProjectAtStart
          ? discoverForSession(ctx.cwd, "both")
          : {
            agents: discoverForSession(ctx.cwd, "user").agents,
            projectAgentsDir,
          };
        const { agents } = discovery;
        const visibleAgents = trustedProjectAtStart ? agents : discoverForSession(ctx.cwd, "user").agents;

        const delegationMode = parseDelegationMode(params.mode)!;
        const parentSessionId = ctx.sessionManager.getSessionId();
        const parentSessionFile = ctx.sessionManager.getSessionFile();

        const detailsExtras = intendedMode === "chain" && Array.isArray(params.chain)
          ? { chainStageCount: params.chain.length }
          : {};
        let runnableAgents = agents;
        const trustedProjectRoots = Array.from(sessionTrustedProjectDirs);
        const deniedProjectRoots = Array.from(sessionDeniedProjectDirs);
        const currentProjectRoot = getProjectRootFromAgentsDir(discovery.projectAgentsDir);
        if (trustedProjectAtStart && currentProjectRoot && !trustedProjectRoots.includes(currentProjectRoot)) {
          trustedProjectRoots.push(currentProjectRoot);
        }
        if (currentProjectRoot) {
          const deniedIndex = deniedProjectRoots.indexOf(currentProjectRoot);
          if (trustedProjectRoots.includes(currentProjectRoot) && deniedIndex !== -1) {
            deniedProjectRoots.splice(deniedIndex, 1);
          }
        }

        const makeDetails = makeDetailsFactory(
          discovery.projectAgentsDir,
          delegationMode,
          terminalMode,
        );

        let forkSessionSnapshotJsonl: string | undefined;
        if (delegationMode === "fork") {
          const forkBranchSource = buildForkBranchSourceJsonl(ctx.sessionManager);
          forkSessionSnapshotJsonl = forkBranchSource ?? undefined;
          if (forkBranchSource === null) {
            failOperational("runtime-policy", "Cannot use mode=\"fork\": failed to snapshot current session context.");
          }
        }

        // Security: guard project-local agents before running
        const requested = new Set<string>();
        if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
        if (params.chain) {
          for (const name of collectRequestedAgentNamesFromChain(params.chain as ChainStage[])) requested.add(name);
        }
        if (params.agent) requested.add(params.agent);

        if (preventCycles) {
          const cycleViolations = getCycleViolations(
            requested,
            ancestorAgentStack,
          );
          if (cycleViolations.length > 0) {
            const stackText =
              ancestorAgentStack.length > 0
                ? ancestorAgentStack.join(" -> ")
                : "(root)";
            failOperational(
              "runtime-policy",
              `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
            );
          }
        }

        const hiddenProjectShadowedUserAgents = !trustedProjectAtStart
          ? Array.from(requested).filter((name) =>
            visibleAgents.some((agent) => agent.name === name && agent.source === "user") &&
            untrustedProjectAgents.some((agent) => agent.name === name),
          )
          : [];
        if (hiddenProjectShadowedUserAgents.length > 0) {
          failOperational(
            "runtime-policy",
            `Blocked: hidden project agent name collision for ${hiddenProjectShadowedUserAgents.join(", ")}. Trust the project first or rename one of the colliding agents before calling it by name.`,
          );
        }
        const requestedProjectAgentNames = trustedProjectAtStart
          ? requested
          : new Set(
            Array.from(requested).filter((name) =>
              !visibleAgents.some((agent) => agent.name === name && agent.source === "user"),
            ),
          );
        const requestedProjectAgents = getRequestedProjectAgents(
          trustedProjectAtStart ? agents : [...agents, ...untrustedProjectAgents],
          requestedProjectAgentNames,
        );
        // Project-local agents are repository-controlled prompts. Respect the
        // extension-managed exact-root trust state, including temporary trust
        // decisions and CLI trust overrides.
        if (requestedProjectAgents.length > 0) {
          const trustedProject = isProjectTrustedForSession(discovery.projectAgentsDir);
          const shouldPrompt = !trustedProject;
          if (ctx.hasUI && shouldPrompt) {
            const approved = await requestProjectAgentApprovalIfNeeded(
              currentProjectRoot,
              untrustedProjectAgents,
              requestedProjectAgents,
              visibleAgents,
              ctx,
            );
            if (!approved) {
              applySessionProjectTrustOverride(
                discovery.projectAgentsDir,
                false,
                sessionTrustedProjectDirs,
                sessionDeniedProjectDirs,
              );
              failOperational("cancellation", "Canceled: project-local agents not approved.");
            }
            const projectRoot = applySessionProjectTrustOverride(
              discovery.projectAgentsDir,
              true,
              sessionTrustedProjectDirs,
              sessionDeniedProjectDirs,
            );
            if (projectRoot) {
              if (!trustedProjectRoots.includes(projectRoot)) trustedProjectRoots.push(projectRoot);
              const deniedIndex = deniedProjectRoots.indexOf(projectRoot);
              if (deniedIndex !== -1) deniedProjectRoots.splice(deniedIndex, 1);
            }
          } else if (!ctx.hasUI && shouldPrompt) {
            failOperational(
              "runtime-policy",
              `Blocked: project-local agent prompt confirmation is required in non-UI mode.\n${formatProjectAgentApprovalScope(currentProjectRoot, untrustedProjectAgents, requestedProjectAgents, visibleAgents)}\n\nRun from an interactive session and approve the entire listed project root for this session, or pass --approve to trust the entire listed project root for this session. Child Pi runs still use --no-approve and do not load other .pi project code.`,
            );
          }

          const fullDiscovery = discoverForSession(ctx.cwd, "both");
          runnableAgents = fullDiscovery.agents;
          discoveredAgents = fullDiscovery.agents;
        }

        const runnableAgentNames = new Set(runnableAgents.map((agent) => agent.name));
        const unknownAgentNames = Array.from(requested).filter((name) => !runnableAgentNames.has(name)).sort();
        if (unknownAgentNames.length > 0) {
          failOperational(
            "runtime-policy",
            `Unknown agent(s): ${unknownAgentNames.join(", ")}. Available agents: ${formatAgentNames(runnableAgents)}`,
          );
        }

        // Approval can yield to session shutdown. Do not permit its old
        // invocation capture to start work after the fence/reset.
        if (!canStartInvocation()) {
          failOperational("runtime-policy", "Cannot start subagents while the parent session is shutting down.");
        }

        const schedulerHandle = scheduler.createHandle();

        const runInvocation = async (
          executionSignal: AbortSignal | undefined,
          executionOnUpdate: ((partial: any) => void) | undefined,
          backgroundExecution: boolean,
          invocationId: string,
        ) => {
          const schedulerKey = `${schedulerHandle.generation}:${schedulerHandle.id}`;
          // Recheck immediately before every foreground call and every
          // background callback. This is intentionally exact, not best effort.
          if (!canStartInvocation()) {
            const pendingForkManager = forkManagers.get(schedulerKey);
            if (pendingForkManager) {
              const pendingDiagnosticGeneration = reaperDiagnosticGeneration;
              try {
                await handoffForkManager(pendingForkManager);
                forkManagers.delete(schedulerKey);
              } catch (error) {
                reportReaperDiagnostic(
                  pendingDiagnosticGeneration,
                  forkSourceReconciliationFailureDiagnostic(error, true),
                  { hasUI: false, ui: ctx.ui },
                );
                // Keep failed authority registered for the shutdown pass.
              }
            }
            return {
              content: [{
                type: "text" as const,
                text: formatSubagentOperationalError("runtime-policy", "Cannot start subagents while the parent session is shutting down."),
              }],
              details: makeDetails(intendedMode, detailsExtras)([]),
              isError: true,
            };
          }
          let forkManager: ForkSourceOwnershipManager | undefined;
          if (delegationMode === "fork") {
            try {
              forkManager = forkManagers.get(schedulerKey) ?? await ForkSourceOwnershipManager.create(forkSessionSnapshotJsonl!);
              forkManagers.set(schedulerKey, forkManager);
            } catch (error) {
              const message = `Cannot use mode="fork": failed to create source ownership record (${error instanceof Error ? error.message : String(error)}).`;
              return {
                content: [{ type: "text" as const, text: formatSubagentOperationalError("runtime-policy", message) }],
                details: makeDetails(intendedMode, detailsExtras)([]),
                isError: true,
              };
            }
          }
          let foregroundPermitScope: ForegroundDelegationScope | undefined;
          try {
            try {
              const authority = await getTreePermitAuthority();
              if (authority) {
                foregroundPermitScope = backgroundExecution ? undefined : await acquireForegroundPermitScope(authority);
                treePermitSources.set(schedulerKey, { source: foregroundPermitScope ?? authority, scope: foregroundPermitScope });
              }
            } catch (error) {
              const message = `Cannot acquire tree-wide permit authority: ${error instanceof Error ? error.message : String(error)}`;
              return {
                content: [{ type: "text" as const, text: formatSubagentOperationalError("runtime-policy", message) }],
                details: makeDetails(intendedMode, detailsExtras)([]),
                isError: true,
              };
            }
            if (params.tasks && params.tasks.length > 0) {
            return await executeParallel(
              params.tasks,
              delegationMode,
              terminalMode,
              interactivePaneLayout,
              trustedProjectRoots,
              deniedProjectRoots,
              forkSessionSnapshotJsonl,
              parentSessionId,
              parentSessionFile,
              interactiveShutdownGeneration,
              runnableAgents,
              ctx.cwd,
              executionSignal,
              invocationId,
              executionOnUpdate,
              makeDetails,
              schedulerHandle,
              forkManager,
            );
          }

          if (params.chain && params.chain.length > 0) {
            return await executeChain(
              params.chain as ChainStage[],
              delegationMode,
              terminalMode,
              interactivePaneLayout,
              trustedProjectRoots,
              deniedProjectRoots,
              forkSessionSnapshotJsonl,
              parentSessionId,
              parentSessionFile,
              interactiveShutdownGeneration,
              runnableAgents,
              ctx.cwd,
              executionSignal,
              invocationId,
              executionOnUpdate,
              makeDetails,
              schedulerHandle,
              forkManager,
            );
          }

          if (params.agent && params.task) {
            return await executeSingle(
              params.agent,
              params.task,
              params.cwd,
              params.model,
              delegationMode,
              terminalMode,
              interactivePaneLayout,
              trustedProjectRoots,
              deniedProjectRoots,
              forkSessionSnapshotJsonl,
              parentSessionId,
              parentSessionFile,
              interactiveShutdownGeneration,
              runnableAgents,
              ctx.cwd,
              executionSignal,
              invocationId,
              executionOnUpdate,
              makeDetails,
              schedulerHandle,
              forkManager,
            );
          }

          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid parameters. Available agents: ${formatAgentNames(agents)}`,
              },
            ],
            details: makeDetails("single")([]),
          };
          } finally {
            treePermitSources.delete(schedulerKey);
            if (foregroundPermitScope) {
              const resumed = await releaseForegroundPermitScope(foregroundPermitScope).catch(() => false);
              if (!resumed) console.warn("[pi-subagent] Tree permit parent remained parked because descendant ownership is unresolved.");
            }
            if (forkManager) {
              let handoffFinished = false;
              try {
                // A retained outcome is conservative ownership state, not a
                // user-facing failure. Startup recovery will retry it.
                await handoffForkManager(forkManager);
                handoffFinished = true;
              } catch (error) {
                // Cleanup cannot replace an already successful child result.
                // During shutdown the invocation token is intentionally stale;
                // route through the current shutdown token and stderr because
                // the closing TUI can no longer guarantee notification render.
                const duringShutdown = sessionShuttingDown && invocationDiagnosticGeneration !== reaperDiagnosticGeneration;
                reportReaperDiagnostic(
                  duringShutdown ? reaperDiagnosticGeneration : invocationDiagnosticGeneration,
                  forkSourceReconciliationFailureDiagnostic(error, duringShutdown),
                  duringShutdown ? { hasUI: false, ui: ctx.ui } : ctx,
                );
              } finally {
                // Keep a failed manager registered so session shutdown can
                // preserve and report the unresolved durable handoff.
                if (handoffFinished) forkManagers.delete(schedulerKey);
              }
            }
          }
        };

        if (background) {
          // This check is separate from the callback check above: no job is
          // published as started after shutdown has fenced the invocation.
          if (!canStartInvocation()) {
            failOperational("runtime-policy", "Cannot start subagents while the parent session is shutting down.");
          }
          pruneBackgroundJobs(backgroundJobs, { maxCompletedJobs: limits.backgroundHistoryLimit, completedTtlMs: limits.backgroundHistoryTtlMs });
          if (countRunningBackgroundJobs() >= limits.maxBackgroundJobs) {
            failOperational(
              "runtime-policy",
              `Cannot start background subagent job: ${limits.maxBackgroundJobs} background job(s) are already running or cancelling. Wait for a steer result, check status, or cancel an existing job first.`,
            );
          }

          if (delegationMode === "fork") {
            try {
              forkManagers.set(`${schedulerHandle.generation}:${schedulerHandle.id}`, await ForkSourceOwnershipManager.create(forkSessionSnapshotJsonl!));
            } catch (error) {
              const message = `Cannot use mode="fork": failed to create source ownership record (${error instanceof Error ? error.message : String(error)}).`;
              failOperational("runtime-policy", message);
            }
          }
          const job = createBackgroundJobRecord({
            mode: intendedMode,
            agent: params.agent,
            task: params.task,
            taskCount: params.tasks?.length,
            chainStageCount: params.chain?.length,
          });
          const uxGeneration = uxRegistry.captureGeneration();
          const progressTotal = params.tasks?.length ?? params.chain?.length ?? 1;
          uxRegistry.start({
            id: job.id,
            agent: params.agent ?? (params.tasks ? `${params.tasks.length} parallel agents` : `${params.chain?.length ?? 0} chain stages`),
            kind: "background",
            progressTotal,
            cancel: () => {
              const cancellation = cancelBackgroundJobs(backgroundJobs, job.id);
              if (!cancellation.found) job.controller.abort();
            },
          });
          startBackgroundJob(
            pi,
            job,
            (jobSignal) => runInvocation(jobSignal, (partial) => updateUxFromPartial(job.id, uxGeneration, partial), true, job.id),
            limits,
            backgroundSessionFence.capture(),
            backgroundSessionFence,
            (finalizedJob, finalizedUsage) => {
              updateUxFromPartial(finalizedJob.id, uxGeneration, finalizedJob.result);
              // Public accounting remains finalized here. Presence is a
              // content-free V2 observer projection and receives no usage.
              void finalizedUsage;
              if (finalizedJob.status === "cancelled") uxRegistry.cancelled(finalizedJob.id, uxGeneration);
              else if (finalizedJob.status === "completed") uxRegistry.complete(finalizedJob.id, uxGeneration);
              else uxRegistry.fail(finalizedJob.id, uxGeneration);
            },
          );
          return {
            content: [{
              type: "text",
              text: `Started background subagent job ${job.id}. ${BACKGROUND_BEHAVIOR_GUIDANCE}`,
            }],
            details: {
              ...makeDetails(intendedMode, detailsExtras)([]),
              jobId: job.id,
              status: job.status,
            },
          };
        }

        const foregroundController = new AbortController();
        const forwardAbort = () => foregroundController.abort();
        if (signal?.aborted) forwardAbort();
        else signal?.addEventListener("abort", forwardAbort, { once: true });
        const uxGeneration = uxRegistry.captureGeneration();
        const progressTotal = params.tasks?.length ?? params.chain?.length ?? 1;
        const uxRun = uxRegistry.start({
          agent: params.agent ?? (params.tasks ? `${params.tasks.length} parallel agents` : `${params.chain?.length ?? 0} chain stages`),
          kind: "foreground",
          progressTotal,
          cancel: () => foregroundController.abort(),
        });
        try {
          const result = finalizeForegroundUsage(await runInvocation(foregroundController.signal, (partial) => { updateUxFromPartial(uxRun.id, uxGeneration, partial); onUpdate?.(partial); }, false, uxRun.id));
          updateUxFromPartial(uxRun.id, uxGeneration, result);
          // Public accounting remains part of the result only; V2 presence
          // deliberately has no usage projection.
          if (foregroundController.signal.aborted) {
            failOperational("cancellation", "Foreground subagent invocation was canceled.");
          }
          if ("isError" in result && result.isError) {
            throw new Error(extractToolText(result) || formatSubagentOperationalError("child-execution", "Subagent invocation failed."));
          }
          uxRegistry.complete(uxRun.id, uxGeneration);
          return result;
        } catch (error) {
          if (foregroundController.signal.aborted) uxRegistry.cancelled(uxRun.id, uxGeneration);
          else uxRegistry.fail(uxRun.id, uxGeneration);
          throw error;
        } finally {
          signal?.removeEventListener("abort", forwardAbort);
        }
      },

      renderCall: (args, theme) => renderCall(args, theme),
      renderResult: (result, { expanded }, theme) =>
        renderResult(result, expanded, theme),
    });
  }

  // -----------------------------------------------------------------------
  // Mode implementations
  // -----------------------------------------------------------------------

  async function executeSingle(
    agentName: string,
    task: string,
    cwd: string | undefined,
    model: string | undefined,
    delegationMode: DelegationMode,
    terminalMode: TerminalMode,
    interactivePaneLayout: InteractivePaneLayout,
    trustedProjectRoots: string[],
    deniedProjectRoots: string[],
    forkSessionSnapshotJsonl: string | undefined,
    parentSessionId: string,
    parentSessionFile: string | undefined,
    interactiveShutdownGeneration: number,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    invocationId: string,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
    schedulerHandle: SchedulerHandle,
    forkSourceOwnership?: ForkSourceOwnershipManager,
  ) {
    const result = await runScheduledAgent(schedulerHandle, {
      cwd: defaultCwd,
      agents,
      agentName,
      task,
      taskCwd: cwd,
      model,
      delegationMode,
      terminalMode,
      interactivePaneLayout,
      trustedProjectRoots,
      deniedProjectRoots,
      forkSessionSnapshotJsonl,
      forkSourceOwnership,
      parentSessionId,
      parentSessionFile,
      interactiveShutdownGeneration,
      parentDepth: currentDepth,
      parentAgentStack: ancestorAgentStack,
      maxDepth,
      preventCycles,
      signal,
      invocationId,
      onUpdate,
      makeDetails: makeDetails("single"),
    });

    if (isResultError(result)) {
      return {
        content: [
          {
            type: "text" as const,
            text: formatSubagentOperationalError(
              result.stopReason === "aborted" ? "cancellation" : "child-execution",
              `Agent ${result.stopReason || "failed"}: ${getResultSummaryText(result)}`,
            ),
          },
        ],
        details: makeDetails("single")([result]),
        isError: true,
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: getResultSummaryText(result),
        },
      ],
      details: makeDetails("single")([result]),
    };
  }


  async function executeChain(
    chain: ChainStage[],
    delegationMode: DelegationMode,
    terminalMode: TerminalMode,
    interactivePaneLayout: InteractivePaneLayout,
    trustedProjectRoots: string[],
    deniedProjectRoots: string[],
    forkSessionSnapshotJsonl: string | undefined,
    parentSessionId: string,
    parentSessionFile: string | undefined,
    interactiveShutdownGeneration: number,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    invocationId: string,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
    schedulerHandle: SchedulerHandle,
    forkSourceOwnership?: ForkSourceOwnershipManager,
  ) {
    const stages: ChainStageRecord[] = [];
    const flattenedResults: SingleResult[] = [];
    const state: ChainExecutionState = { hadError: false, hadCompletedWithErrors: false, hadBlockingError: false };
    const stageCounts = { completed: 0, skipped: 0, failed: 0, completedWithErrors: 0 };

    const recordStage = (stage: ChainStageRecord) => {
      stages.push(stage);
      switch (stage.status) {
        case "completed":
          stageCounts.completed++;
          break;
        case "skipped":
          stageCounts.skipped++;
          break;
        case "failed":
          stageCounts.failed++;
          break;
        case "completed_with_errors":
          stageCounts.completedWithErrors++;
          break;
      }
    };

    const chainDetails = () => ({
      chainStageCount: chain.length,
      chainCompletedCount: stageCounts.completed,
      chainSkippedCount: stageCounts.skipped,
      chainFailedCount: stageCounts.failed,
      chainCompletedWithErrorsCount: stageCounts.completedWithErrors,
    });

    const emitProgress = (running?: IncrementalResultSlots) => {
      if (!onUpdate) return;
      const runningSnapshot = running?.snapshot();
      const displayedResults = runningSnapshot ? [...flattenedResults, ...runningSnapshot.results] : [...flattenedResults];
      const runningText = runningSnapshot && runningSnapshot.results.length > 0
        ? `, running ${runningSnapshot.results.map((result) => result.agent).join(", ")}...`
        : "";
      onUpdate({
        content: [
          {
            type: "text",
            text: `Chain: ${stages.length}/${chain.length} stages done${runningText}`,
          },
        ],
        details: makeDetails("chain", chainDetails())(displayedResults),
      });
    };

    const emitChildProgress = (content: unknown, running: IncrementalResultSlots) => {
      if (!onUpdate) return;
      const runningSnapshot = running.snapshot();
      onUpdate({
        content,
        details: makeDetails("chain", chainDetails())([...flattenedResults, ...runningSnapshot.results]),
      });
    };

    emitProgress();

    for (let index = 0; index < chain.length; index++) {
      const stage = chain[index];
      const stageType = getChainStageType(stage);
      const label = getStageLabel(stage, index);
      const continueOnError = stage.continueOnError ?? false;

      if (signal?.aborted) {
        recordStage({
          label,
          type: stageType,
          status: "failed",
          results: [],
          reason: "parent invocation aborted before this stage started",
        });
        return {
          content: [
            {
              type: "text" as const,
              text: formatSubagentOperationalError(
                "cancellation",
                `Chain aborted before stage ${index + 1}/${chain.length} (${label}).\n\n${formatChainStageSummaries(stages)}`,
              ),
            },
          ],
          details: makeDetails("chain", chainDetails())(flattenedResults),
          isError: true,
        };
      }

      if (!shouldRunStage(stage.condition, state)) {
        recordStage({
          label,
          type: stageType,
          status: "skipped",
          results: [],
          reason: `condition ${stage.condition ?? "on_success"} not met`,
        });
        emitProgress();
        continue;
      }

      if (stageType === "parallel") {
        const parallel = stage as ChainParallelStage;
        const runningSlots = new IncrementalResultSlots(parallel.tasks.map((task) => ({
          agent: task.agent,
          agentSource: "unknown" as const,
          task: buildChainTaskFromStages(task.task, stages),
          stageLabel: label,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: emptyUsage(),
          accountingUsage: emptyAccountingUsage(),
          model: task.model,
        })));
        emitProgress(runningSlots);

        const maybeStageResults = await mapConcurrent(
          parallel.tasks,
          limits.maxConcurrency,
          async (task, taskIndex) => {
            const result = await runScheduledAgent(schedulerHandle, {
              cwd: defaultCwd,
              agents,
              agentName: task.agent,
              task: buildChainTaskFromStages(task.task, stages),
              stageLabel: label,
              taskCwd: task.cwd,
              model: task.model,
              delegationMode,
              terminalMode,
              interactivePaneLayout,
              trustedProjectRoots,
              deniedProjectRoots,
              forkSessionSnapshotJsonl,
              forkSourceOwnership,
              parentSessionId,
              parentSessionFile,
              interactiveShutdownGeneration,
              parentDepth: currentDepth,
              parentAgentStack: ancestorAgentStack,
              maxDepth,
              preventCycles,
              signal,
              invocationId,
              onUpdate: (partial) => {
                if (partial.details?.results[0]) {
                  runningSlots.replace(taskIndex, partial.details.results[0]);
                  emitChildProgress(partial.content, runningSlots);
                }
              },
              makeDetails: makeDetails("chain"),
            });
            runningSlots.replace(taskIndex, result);
            emitProgress(runningSlots);
            return result;
          },
          { signal },
        );
        const stageResults = maybeStageResults.map((result, taskIndex) => {
          const stageResult = result ?? makeUnstartedAbortResult(
            parallel.tasks[taskIndex].agent,
            buildChainTaskFromStages(parallel.tasks[taskIndex].task, stages),
            label,
            parallel.tasks[taskIndex].model,
          );
          runningSlots.replace(taskIndex, stageResult);
          return stageResult;
        });

        flattenedResults.push(...stageResults);
        const stageHasError = stageResults.some((result) => isResultError(result));
        const status: ChainStageStatus = stageHasError
          ? continueOnError
            ? "completed_with_errors"
            : "failed"
          : "completed";
        recordStage({ label, type: "parallel", status, results: stageResults });
        if (stageHasError) {
          state.hadError = true;
          if (continueOnError) state.hadCompletedWithErrors = true;
          else state.hadBlockingError = true;
        }
        emitProgress();

        if (stageHasError && !continueOnError) {
          return {
            content: [
              {
                type: "text" as const,
                text: formatSubagentOperationalError(
                  "child-execution",
                  `Chain stopped at stage ${index + 1}/${chain.length} (${label}).\n\n${formatChainStageSummaries(stages)}`,
                ),
              },
            ],
            details: makeDetails("chain", chainDetails())(flattenedResults),
            isError: true,
          };
        }
        continue;
      }

      const taskStage = stage as ChainTaskStage;
      const runningResult: SingleResult = {
        agent: taskStage.agent,
        agentSource: "unknown" as const,
        task: buildChainTaskFromStages(taskStage.task, stages),
        stageLabel: label,
        exitCode: -1,
        messages: [],
        stderr: "",
        usage: emptyUsage(),
        accountingUsage: emptyAccountingUsage(),
        model: taskStage.model,
      };
      const runningSlots = new IncrementalResultSlots([runningResult]);
      emitProgress(runningSlots);

      const result = await runScheduledAgent(schedulerHandle, {
        cwd: defaultCwd,
        agents,
        agentName: taskStage.agent,
        task: buildChainTaskFromStages(taskStage.task, stages),
        stageLabel: label,
        taskCwd: taskStage.cwd,
        model: taskStage.model,
        delegationMode,
        terminalMode,
        interactivePaneLayout,
        trustedProjectRoots,
        deniedProjectRoots,
        forkSessionSnapshotJsonl,
        forkSourceOwnership,
        parentSessionId,
        parentSessionFile,
        interactiveShutdownGeneration,
        parentDepth: currentDepth,
        parentAgentStack: ancestorAgentStack,
        maxDepth,
        preventCycles,
        signal,
        invocationId,
        onUpdate: (partial) => {
          if (partial.details?.results[0]) {
            runningSlots.replace(0, partial.details.results[0]);
            emitChildProgress(partial.content, runningSlots);
          }
        },
        makeDetails: makeDetails("chain"),
      });

      runningSlots.replace(0, result);
      flattenedResults.push(result);
      const stageHasError = isResultError(result);
      const status: ChainStageStatus = stageHasError
        ? continueOnError
          ? "completed_with_errors"
          : "failed"
        : "completed";
      recordStage({ label, type: "chain", status, results: [result] });
      if (stageHasError) {
        state.hadError = true;
        if (continueOnError) state.hadCompletedWithErrors = true;
        else state.hadBlockingError = true;
      }
      emitProgress();

      if (stageHasError && !continueOnError) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatSubagentOperationalError(
                "child-execution",
                `Chain stopped at stage ${index + 1}/${chain.length} (${label}).\n\n${formatChainStageSummaries(stages)}`,
              ),
            },
          ],
          details: makeDetails("chain", chainDetails())(flattenedResults),
          isError: true,
        };
      }
    }

    const completed = stageCounts.completed;
    const completedWithErrors = stageCounts.completedWithErrors;
    const skipped = stageCounts.skipped;
    const failed = stageCounts.failed;
    return {
      content: [
        {
          type: "text" as const,
          text: state.hadError || state.hadCompletedWithErrors
            ? formatSubagentOperationalError(
              "child-execution",
              `Chain: ${completed + completedWithErrors}/${chain.length} stages completed${completedWithErrors ? `, ${completedWithErrors} completed with errors` : ""}${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} failed` : ""}\n\n${formatChainStageSummaries(stages)}`,
            )
            : `Chain: ${completed}/${chain.length} stages completed${skipped ? `, ${skipped} skipped` : ""}\n\n${formatChainStageSummaries(stages)}`,
        },
      ],
      details: makeDetails("chain", chainDetails())(flattenedResults),
      isError: state.hadError || state.hadCompletedWithErrors ? true : undefined,
    };
  }

  async function executeParallel(
    tasks: Array<{ agent: string; task: string; cwd?: string; model?: string }>,
    delegationMode: DelegationMode,
    terminalMode: TerminalMode,
    interactivePaneLayout: InteractivePaneLayout,
    trustedProjectRoots: string[],
    deniedProjectRoots: string[],
    forkSessionSnapshotJsonl: string | undefined,
    parentSessionId: string,
    parentSessionFile: string | undefined,
    interactiveShutdownGeneration: number,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    invocationId: string,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
    schedulerHandle: SchedulerHandle,
    forkSourceOwnership?: ForkSourceOwnershipManager,
  ) {
    // Preserve one placeholder per task while scheduler-queued work has not started.
    const resultSlots = new IncrementalResultSlots(tasks.map((task) => ({
      agent: task.agent,
      agentSource: "unknown" as const,
      task: task.task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      accountingUsage: emptyAccountingUsage(),
      model: task.model,
    })));

    const emitProgress = () => {
      if (!onUpdate) return;
      const snapshot = resultSlots.snapshot();
      onUpdate({
        content: [
          {
            type: "text",
            text: `Parallel: ${snapshot.doneCount}/${snapshot.results.length} done, ${snapshot.runningCount} running...`,
          },
        ],
        details: makeDetails("parallel")(snapshot.results),
      });
    };

    let heartbeat: NodeJS.Timeout | undefined;
    if (onUpdate) {
      emitProgress();
      heartbeat = setInterval(() => {
        if (resultSlots.hasRunning) emitProgress();
      }, limits.parallelHeartbeatMs);
    }

    let results: SingleResult[];
    try {
      const maybeResults = await mapConcurrent(
        tasks,
        limits.maxConcurrency,
        async (t, index) => {
          const result = await runScheduledAgent(schedulerHandle, {
            cwd: defaultCwd,
            agents,
            agentName: t.agent,
            task: t.task,
            taskCwd: t.cwd,
            model: t.model,
            delegationMode,
            terminalMode,
            interactivePaneLayout,
            trustedProjectRoots,
            deniedProjectRoots,
            forkSessionSnapshotJsonl,
            forkSourceOwnership,
            parentSessionId,
            parentSessionFile,
            interactiveShutdownGeneration,
            parentDepth: currentDepth,
            parentAgentStack: ancestorAgentStack,
            maxDepth,
            preventCycles,
            signal,
            invocationId,
            onUpdate: (partial) => {
              if (partial.details?.results[0]) {
                resultSlots.replace(index, partial.details.results[0]);
                emitProgress();
              }
            },
            makeDetails: makeDetails("parallel"),
          });
          resultSlots.replace(index, result);
          emitProgress();
          return result;
        },
        { signal },
      );
      results = maybeResults.map((result, index) => {
        const terminalResult = result ?? makeUnstartedAbortResult(tasks[index].agent, tasks[index].task, undefined, tasks[index].model);
        resultSlots.replace(index, terminalResult);
        return terminalResult;
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const successCount = resultSlots.snapshot().successCount;
    const summaries = results.map((r) =>
      `[${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r)}`,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: successCount === results.length
            ? `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`
            : formatSubagentOperationalError(
              "child-execution",
              `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
            ),
        },
      ],
      details: makeDetails("parallel")(results),
      isError: successCount !== results.length ? true : undefined,
    };
  }
}
