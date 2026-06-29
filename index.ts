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
 * Plus two execution surfaces:
 *   - inline (non-Zellij fallback): child pi runs directly and streams stdout.
 *   - zellij-pane: child pi runs in a new Zellij pane, JSON is bridged back through a FIFO, and the pane renders human-readable progress.
 */

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
  validateChainStages,
} from "./src/core/chain-helpers.js";
import { type AgentConfig, discoverAgents, findNearestProjectAgentsDir } from "./src/core/agents.js";
import { renderCall, renderResult } from "./src/ui/render.js";
import { getResultSummaryText } from "./src/core/runner-events.js";
import { applySessionProjectTrustOverride, isTrustedProjectAgentsDirWithSessionOverrides } from "./src/core/project-trust.js";
import { mapConcurrent, runAgent } from "./src/runtime/runner.js";
import {
  BACKGROUND_BEHAVIOR_GUIDANCE,
  cancelBackgroundJobs,
  compactBackgroundJobResult,
  createBackgroundJobRecord,
  extractToolText,
  formatUntrustedToolText,
  formatBackgroundJobListEntry,
  formatBackgroundJobStatusText,
  formatInvalidInvocationShapeMessage,
  formatSubagentSystemPrompt,
  formatSubagentToolDescription,
  getBackgroundJobSnapshot,
  truncateAgentDescription,
  listBackgroundJobSnapshots,
  parseBackgroundAction,
  parseBackgroundFlag,
  pruneBackgroundJobs,
  type BackgroundJobRecord,
  type BackgroundJobStatus,
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
  isResultError,
  isResultSuccess,
} from "./src/core/types.js";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_STEPS = 8;
const MAX_CONCURRENCY = 4;
const PARALLEL_HEARTBEAT_MS = 1000;
const DEFAULT_MAX_DELEGATION_DEPTH = 3;
const DEFAULT_PREVENT_CYCLE_DELEGATION = true;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TRUSTED_PROJECTS_ENV = "PI_SUBAGENT_TRUSTED_PROJECTS";
const SUBAGENT_DENIED_PROJECTS_ENV = "PI_SUBAGENT_DENIED_PROJECTS";

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

interface SessionSnapshotSource {
  getHeader: () => unknown;
  getBranch: () => unknown[];
}

const BACKGROUND_RESULT_CUSTOM_TYPE = "subagent_result";
const MAX_RUNNING_BACKGROUND_JOBS = 4;
const backgroundJobs = new Map<string, BackgroundJobRecord>();

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
    ? `\n\n${formatUntrustedToolText(detailText)}`
    : "";
  const errorText = job.error ? `\n\n${formatUntrustedToolText(job.error)}` : "";
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

function finalizeBackgroundJob(
  pi: ExtensionAPI,
  job: BackgroundJobRecord,
  result: BackgroundJobToolResult | undefined,
  fallbackError: string | undefined,
): void {
  const cancellationRequested = job.status === "cancelling";
  const status: BackgroundJobStatus = cancellationRequested && (fallbackError || result?.isError)
    ? "cancelled"
    : result?.isError
      ? "failed"
      : fallbackError
        ? "failed"
        : "completed";
  const error = fallbackError;

  job.status = status;
  job.completedAt = Date.now();
  job.result = status === "cancelled" ? undefined : compactBackgroundJobResult(result);
  job.error = status === "cancelled" ? undefined : error;
  backgroundJobs.set(job.id, job);
  pruneBackgroundJobs(backgroundJobs);
  notifyBackgroundJobResult(pi, job);
}

function startBackgroundJob(
  pi: ExtensionAPI,
  job: BackgroundJobRecord,
  run: (signal: AbortSignal) => Promise<BackgroundJobToolResult>,
): void {
  pruneBackgroundJobs(backgroundJobs);
  backgroundJobs.set(job.id, job);

  void run(job.controller.signal)
    .then((result) => {
      finalizeBackgroundJob(pi, job, result, undefined);
    })
    .catch((error) => {
      finalizeBackgroundJob(
        pi,
        job,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    });
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

function getCurrentZellijPaneIdFromEnv(): string | undefined {
  const raw = process.env["ZELLIJ_PANE_ID"]?.trim();
  if (!raw) return undefined;
  if (/^(terminal|plugin)_\d+$/.test(raw)) return raw;
  if (/^\d+$/.test(raw)) return `terminal_${raw}`;
  return undefined;
}

function buildForkSessionSnapshotJsonl(
  sessionManager: SessionSnapshotSource,
): string | null {
  const header = sessionManager.getHeader();
  if (!header || typeof header !== "object") return null;

  const branchEntries = sessionManager.getBranch();
  const lines = [JSON.stringify(header)];
  for (const entry of branchEntries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
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

function getMaxDepthFlagFromArgv(argv: string[]): string | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-max-depth") {
      return argv[i + 1] ?? "";
    }
    if (arg.startsWith("--subagent-max-depth=")) {
      return arg.slice("--subagent-max-depth=".length);
    }
  }
  return null;
}

function getPreventCyclesFlagFromArgv(
  argv: string[],
): string | boolean | null {
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--subagent-prevent-cycles") {
      const maybeValue = argv[i + 1];
      if (maybeValue !== undefined && !maybeValue.startsWith("--")) {
        return maybeValue;
      }
      return true;
    }
    if (arg === "--no-subagent-prevent-cycles") return false;
    if (arg.startsWith("--subagent-prevent-cycles=")) {
      return arg.slice("--subagent-prevent-cycles=".length);
    }
  }
  return null;
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

  const argvFlagRaw = getMaxDepthFlagFromArgv(process.argv);
  const argvFlagMaxDepth =
    argvFlagRaw !== null ? parseNonNegativeInt(argvFlagRaw) : null;
  if (argvFlagRaw !== null && argvFlagMaxDepth === null) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-max-depth value "${argvFlagRaw}". Expected a non-negative integer.`,
    );
  }

  const runtimeFlagValue = pi.getFlag("subagent-max-depth");
  const runtimeFlagMaxDepth =
    typeof runtimeFlagValue === "string"
      ? parseNonNegativeInt(runtimeFlagValue)
      : null;
  if (
    argvFlagRaw === null &&
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

  const argvPreventCyclesRaw = getPreventCyclesFlagFromArgv(process.argv);
  const argvPreventCycles =
    typeof argvPreventCyclesRaw === "boolean"
      ? argvPreventCyclesRaw
      : parseBoolean(argvPreventCyclesRaw);
  if (
    typeof argvPreventCyclesRaw === "string" &&
    argvPreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${argvPreventCyclesRaw}". Expected true/false.`,
    );
  }

  const runtimePreventCyclesRaw = pi.getFlag("subagent-prevent-cycles");
  const runtimePreventCycles = parseBoolean(runtimePreventCyclesRaw);
  if (
    argvPreventCyclesRaw === null &&
    runtimePreventCyclesRaw !== undefined &&
    runtimePreventCycles === null
  ) {
    console.warn(
      `[pi-subagent] Ignoring invalid --subagent-prevent-cycles value "${String(runtimePreventCyclesRaw)}". Expected true/false.`,
    );
  }

  const flagMaxDepth = argvFlagMaxDepth ?? runtimeFlagMaxDepth;
  const maxDepth = flagMaxDepth ?? envMaxDepth ?? DEFAULT_MAX_DELEGATION_DEPTH;
  const preventCycles =
    argvPreventCycles ??
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

function countCompletedChainStages(stages: ChainStageRecord[]): number {
  return stages.filter((stage) => stage.status === "completed").length;
}

function countDoneChainStages(stages: ChainStageRecord[]): number {
  return stages.filter((stage) => stage.status !== "skipped").length;
}

function countFailedChainStages(stages: ChainStageRecord[]): number {
  return stages.filter((stage) => stage.status === "failed").length;
}

function countCompletedWithErrorChainStages(stages: ChainStageRecord[]): number {
  return stages.filter((stage) => stage.status === "completed_with_errors").length;
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

/**
 * Prompt the user to confirm project-local agents if needed.
 * Returns false if the user declines.
 */
async function requestProjectAgentApprovalIfNeeded(
  projectAgents: AgentConfig[],
  projectAgentsDir: string | null,
  ctx: { ui: { confirm: (title: string, body: string) => Promise<boolean> } },
): Promise<boolean> {
  if (projectAgents.length === 0) return true;

  const names = projectAgents.map((a) => a.name).join(", ");
  const dir = projectAgentsDir ?? "(unknown)";
  return ctx.ui.confirm(
    "Run project-local agents?",
    `Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerFlag("subagent-max-depth", {
    description: "Maximum allowed subagent delegation depth (default: 3).",
    type: "string",
  });
  pi.registerFlag("subagent-prevent-cycles", {
    description:
      "Block delegating to agents already in the current delegation stack (default: true).",
    type: "boolean",
  });
  const depthConfig = resolveDelegationDepthConfig(pi);
  const { currentDepth, maxDepth, canDelegate, ancestorAgentStack, preventCycles } =
    depthConfig;

  let discoveredAgents: AgentConfig[] = [];

  const sessionTrustedProjectDirs = new Set<string>(parseProjectRootEnvValue(process.env[SUBAGENT_TRUSTED_PROJECTS_ENV]));
  const sessionDeniedProjectDirs = new Set<string>(parseProjectRootEnvValue(process.env[SUBAGENT_DENIED_PROJECTS_ENV]));

  const getTrustOverrideFromArgv = (): boolean | null => {
    if (process.argv.includes("--approve") || process.argv.includes("-a")) return true;
    if (process.argv.includes("--no-approve") || process.argv.includes("-na")) return false;
    return null;
  };

  const applyArgvTrustOverride = (projectAgentsDir: string | null): string | null =>
    applySessionProjectTrustOverride(
      projectAgentsDir,
      getTrustOverrideFromArgv(),
      sessionTrustedProjectDirs,
      sessionDeniedProjectDirs,
    );

  const isProjectTrustedForSession = (projectAgentsDir: string | null): boolean =>
    isTrustedProjectAgentsDirWithSessionOverrides(projectAgentsDir, {
      sessionTrustedProjectRoots: sessionTrustedProjectDirs,
      sessionDeniedProjectRoots: sessionDeniedProjectDirs,
    });

  // Auto-discover agents on session start
  pi.on("session_start", async (_event, ctx) => {
    if (!canDelegate) return;

    const projectAgentsDir = findNearestProjectAgentsDir(ctx.cwd);
    applyArgvTrustOverride(projectAgentsDir);
    const trustedProject = isProjectTrustedForSession(projectAgentsDir);
    const discovery = trustedProject
      ? discoverAgents(ctx.cwd, "both")
      : discoverAgents(ctx.cwd, "user");
    discoveredAgents = discovery.agents;
  });

  // Inject available agents into the system prompt
  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    if (discoveredAgents.length === 0) return;

    const agentList = discoveredAgents
      .map((a) => JSON.stringify({ name: a.name, description: truncateAgentDescription(a.description) }))
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

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const projectAgentsDir = findNearestProjectAgentsDir(ctx.cwd);
        applyArgvTrustOverride(projectAgentsDir);
        const earlyToolDetails = makeDetailsFactory(
          projectAgentsDir,
          DEFAULT_DELEGATION_MODE,
          getDefaultTerminalModeFromEnv(),
        )("single")([]);

        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasChain = (params.chain?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        const action = parseBackgroundAction(params.action);
        const background = parseBackgroundFlag(params.background);

        if (params.action !== undefined && !action) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid action \"${String(params.action)}\". Expected \"status\" or \"cancel\".`,
              },
            ],
            details: earlyToolDetails,
            isError: true,
          };
        }

        if (background === null) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid background value \"${String(params.background)}\". Expected true or false.`,
              },
            ],
            details: earlyToolDetails,
            isError: true,
          };
        }

        if (action) {
          const hasExecutionField = params.agent !== undefined || params.task !== undefined || params.model !== undefined || params.tasks !== undefined || params.chain !== undefined || params.cwd !== undefined || params.mode !== undefined;
          if (hasExecutionField) {
            return {
              content: [
                {
                  type: "text",
                  text: "Invalid parameters. action cannot be combined with agent/task, tasks, or chain.",
                },
              ],
              details: earlyToolDetails,
              isError: true,
            };
          }
          if (params.id !== undefined && typeof params.id !== "string") {
            return {
              content: [
                {
                  type: "text",
                  text: "Invalid parameters. id must be a string when provided with action=\"status\" or action=\"cancel\".",
                },
              ],
              details: earlyToolDetails,
              isError: true,
            };
          }
          if (params.background !== undefined) {
            return {
              content: [
                {
                  type: "text",
                  text: "Invalid parameters. background cannot be combined with action.",
                },
              ],
              details: earlyToolDetails,
              isError: true,
            };
          }
          pruneBackgroundJobs(backgroundJobs);
          if (action === "status") {
            if (typeof params.id === "string") {
              const job = getBackgroundJobSnapshot(params.id, backgroundJobs);
              if (!job) {
                return {
                  content: [{ type: "text", text: `Background subagent job ${params.id} was not found.` }],
                  details: earlyToolDetails,
                  isError: true,
                };
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
          if (!cancellation.found) {
            return {
              content: [{ type: "text", text: `Background subagent job ${String(params.id)} was not found.` }],
              details: earlyToolDetails,
              isError: true,
            };
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

        if (params.id !== undefined) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid parameters. id can only be used with action=\"status\" or action=\"cancel\".",
              },
            ],
            details: earlyToolDetails,
            isError: true,
          };
        }

        const trustedProjectAtStart = isProjectTrustedForSession(projectAgentsDir);
        const untrustedProjectAgents = trustedProjectAtStart ? [] : discoverAgents(ctx.cwd, "project", { metadataOnly: true }).agents;
        const discovery = trustedProjectAtStart
          ? discoverAgents(ctx.cwd, "both")
          : {
            agents: discoverAgents(ctx.cwd, "user").agents,
            projectAgentsDir,
          };
        const { agents } = discovery;
        const visibleAgents = trustedProjectAtStart ? agents : discoverAgents(ctx.cwd, "user").agents;

        const delegationMode = parseDelegationMode(params.mode);
        const terminalMode = getDefaultTerminalModeFromEnv();
        const intendedMode = inferInvocationMode(params);
        if (!delegationMode) {
          const fallbackDetails = makeDetailsFactory(
            discovery.projectAgentsDir,
            DEFAULT_DELEGATION_MODE,
            terminalMode,
          );
          return {
            content: [
              {
                type: "text",
                text: `Invalid mode \"${String(params.mode)}\". Expected \"spawn\" or \"fork\".\nAvailable agents: ${formatAgentNames(visibleAgents)}`,
              },
            ],
            details: fallbackDetails(intendedMode)([]),
            isError: true,
          };
        }

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
          forkSessionSnapshotJsonl =
            buildForkSessionSnapshotJsonl(ctx.sessionManager) ?? undefined;
          if (!forkSessionSnapshotJsonl) {
            return {
              content: [
                {
                  type: "text",
                  text: "Cannot use mode=\"fork\": failed to snapshot current session context.",
                },
              ],
              details: makeDetails(intendedMode, detailsExtras)([]),
              isError: true,
            };
          }
        }

        // Validate: exactly one invocation shape must be specified
        if (Number(hasTasks) + Number(hasChain) + Number(hasSingle) !== 1) {
          return {
            content: [
              {
                type: "text",
                text: formatInvalidInvocationShapeMessage(formatAgentNames(visibleAgents)),
              },
            ],
            details: makeDetails(intendedMode)([]),
            isError: true,
          };
        }

        if (params.model !== undefined && !hasSingle) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid parameters. top-level model can only be used with single {agent, task} invocations; put model on each task item for parallel or chain calls.",
              },
            ],
            details: makeDetails(intendedMode)([]),
            isError: true,
          };
        }

        // Security: guard project-local agents before running
        const requested = new Set<string>();
        if (params.tasks) for (const t of params.tasks) requested.add(t.agent);
        if (params.chain) {
          const chainValidationError = validateChainStages(params.chain as ChainStage[]);
          if (chainValidationError) {
            return {
              content: [{ type: "text", text: chainValidationError }],
              details: makeDetails("chain", { chainStageCount: params.chain.length })([]),
              isError: true,
            };
          }
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
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: delegation cycle detected. Requested agent(s) already in the delegation stack: ${cycleViolations.join(", ")}.
Current stack: ${stackText}

This guard prevents self-recursion and cyclic handoffs (for example A -> B -> A).`,
                },
              ],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
              isError: true,
            };
          }
        }

        const hiddenProjectShadowedUserAgents = !trustedProjectAtStart
          ? Array.from(requested).filter((name) =>
            visibleAgents.some((agent) => agent.name === name && agent.source === "user") &&
            untrustedProjectAgents.some((agent) => agent.name === name),
          )
          : [];
        if (hiddenProjectShadowedUserAgents.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Blocked: hidden project agent name collision for ${hiddenProjectShadowedUserAgents.join(", ")}. Trust the project first or rename one of the colliding agents before calling it by name.`,
              },
            ],
            details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
            isError: true,
          };
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
              requestedProjectAgents,
              discovery.projectAgentsDir,
              ctx,
            );
            if (!approved) {
              applySessionProjectTrustOverride(
                discovery.projectAgentsDir,
                false,
                sessionTrustedProjectDirs,
                sessionDeniedProjectDirs,
              );
              return {
                content: [
                  {
                    type: "text",
                    text: "Canceled: project-local agents not approved.",
                  },
                ],
                details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
                isError: true,
              };
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
            const names = requestedProjectAgents.map((a) => a.name).join(", ");
            const dir = discovery.projectAgentsDir ?? "(unknown)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: project-local agent confirmation is required in non-UI mode.\nAgents: ${names}\nSource: ${dir}\n\nRun from an interactive session and approve this exact project root, or pass --approve to trust the current nearest project-agent root for this session.`,
                },
              ],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
              isError: true,
            };
          }

          const fullDiscovery = discoverAgents(ctx.cwd, "both");
          runnableAgents = fullDiscovery.agents;
          discoveredAgents = fullDiscovery.agents;
        }

        const runInvocation = (
          executionSignal: AbortSignal | undefined,
          executionOnUpdate: ((partial: any) => void) | undefined,
        ) => {
          if (params.tasks && params.tasks.length > 0) {
            return executeParallel(
              params.tasks,
              delegationMode,
              terminalMode,
              trustedProjectRoots,
              deniedProjectRoots,
              forkSessionSnapshotJsonl,
              runnableAgents,
              ctx.cwd,
              executionSignal,
              executionOnUpdate,
              makeDetails,
            );
          }

          if (params.chain && params.chain.length > 0) {
            return executeChain(
              params.chain as ChainStage[],
              delegationMode,
              terminalMode,
              trustedProjectRoots,
              deniedProjectRoots,
              forkSessionSnapshotJsonl,
              runnableAgents,
              ctx.cwd,
              executionSignal,
              executionOnUpdate,
              makeDetails,
            );
          }

          if (params.agent && params.task) {
            return executeSingle(
              params.agent,
              params.task,
              params.cwd,
              params.model,
              delegationMode,
              terminalMode,
              trustedProjectRoots,
              deniedProjectRoots,
              forkSessionSnapshotJsonl,
              runnableAgents,
              ctx.cwd,
              executionSignal,
              executionOnUpdate,
              makeDetails,
            );
          }

          return Promise.resolve({
            content: [
              {
                type: "text" as const,
                text: `Invalid parameters. Available agents: ${formatAgentNames(agents)}`,
              },
            ],
            details: makeDetails("single")([]),
          });
        };

        if (background) {
          pruneBackgroundJobs(backgroundJobs);
          if (countRunningBackgroundJobs() >= MAX_RUNNING_BACKGROUND_JOBS) {
            return {
              content: [{
                type: "text",
                text: `Cannot start background subagent job: ${MAX_RUNNING_BACKGROUND_JOBS} background job(s) are already running or cancelling. Wait for a steer result, check status, or cancel an existing job first.`,
              }],
              details: makeDetails(intendedMode, detailsExtras)([]),
              isError: true,
            };
          }

          const job = createBackgroundJobRecord({
            mode: intendedMode,
            agent: params.agent,
            task: params.task,
            taskCount: params.tasks?.length,
            chainStageCount: params.chain?.length,
          });
          startBackgroundJob(pi, job, (jobSignal) => runInvocation(jobSignal, undefined));
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

        return runInvocation(signal, onUpdate);
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
    trustedProjectRoots: string[],
    deniedProjectRoots: string[],
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    const result = await runAgent({
      cwd: defaultCwd,
      agents,
      agentName,
      task,
      taskCwd: cwd,
      model,
      delegationMode,
      terminalMode,
      trustedProjectRoots,
      deniedProjectRoots,
      forkSessionSnapshotJsonl,
      parentDepth: currentDepth,
      parentAgentStack: ancestorAgentStack,
      maxDepth,
      preventCycles,
      signal,
      onUpdate,
      makeDetails: makeDetails("single"),
    });

    if (isResultError(result)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Agent ${result.stopReason || "failed"}: ${getResultSummaryText(result)}`,
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
    trustedProjectRoots: string[],
    deniedProjectRoots: string[],
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    if (chain.length > MAX_CHAIN_STEPS) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Too many chain stages (${chain.length}). Max is ${MAX_CHAIN_STEPS}.`,
          },
        ],
        details: makeDetails("chain", { chainStageCount: chain.length })([]),
        isError: true,
      };
    }

    const validationError = validateChainStages(chain);
    if (validationError) {
      return {
        content: [{ type: "text" as const, text: validationError }],
        details: makeDetails("chain", { chainStageCount: chain.length })([]),
        isError: true,
      };
    }

    const stages: ChainStageRecord[] = [];
    const flattenedResults: SingleResult[] = [];
    const state: ChainExecutionState = { hadError: false, hadCompletedWithErrors: false, hadBlockingError: false };

    const emitProgress = (running?: SingleResult[]) => {
      if (!onUpdate) return;
      const displayedResults = running ? [...flattenedResults, ...running] : [...flattenedResults];
      const runningText = running && running.length > 0
        ? `, running ${running.map((r) => r.agent).join(", ")}...`
        : "";
      onUpdate({
        content: [
          {
            type: "text",
            text: `Chain: ${stages.length}/${chain.length} stages done${runningText}`,
          },
        ],
        details: makeDetails("chain", {
          chainStageCount: chain.length,
          chainCompletedCount: countCompletedChainStages(stages),
          chainSkippedCount: stages.filter((stage) => stage.status === "skipped").length,
          chainFailedCount: countFailedChainStages(stages),
          chainCompletedWithErrorsCount: countCompletedWithErrorChainStages(stages),
        })(displayedResults),
      });
    };

    emitProgress();

    for (let index = 0; index < chain.length; index++) {
      const stage = chain[index];
      const stageType = getChainStageType(stage);
      const label = getStageLabel(stage, index);
      const continueOnError = stage.continueOnError ?? false;

      if (signal?.aborted) {
        stages.push({
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
              text: `Chain aborted before stage ${index + 1}/${chain.length} (${label}).\n\n${formatChainStageSummaries(stages)}`,
            },
          ],
          details: makeDetails("chain", {
            chainStageCount: chain.length,
            chainCompletedCount: countCompletedChainStages(stages),
            chainSkippedCount: stages.filter((stage) => stage.status === "skipped").length,
            chainFailedCount: countFailedChainStages(stages),
            chainCompletedWithErrorsCount: countCompletedWithErrorChainStages(stages),
          })(flattenedResults),
          isError: true,
        };
      }

      if (!shouldRunStage(stage.condition, state)) {
        stages.push({
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
        const runningResults: SingleResult[] = parallel.tasks.map((task) => ({
          agent: task.agent,
          agentSource: "unknown" as const,
          task: buildChainTaskFromStages(task.task, stages),
          stageLabel: label,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: emptyUsage(),
          model: task.model,
        }));
        emitProgress(runningResults);

        const sharedRestoreFocusPaneId = terminalMode === "zellij-pane"
          ? getCurrentZellijPaneIdFromEnv()
          : undefined;

        const maybeStageResults = await mapConcurrent(
          parallel.tasks,
          MAX_CONCURRENCY,
          async (task, taskIndex) => {
            const result = await runAgent({
              cwd: defaultCwd,
              agents,
              agentName: task.agent,
              task: buildChainTaskFromStages(task.task, stages),
              stageLabel: label,
              taskCwd: task.cwd,
              model: task.model,
              delegationMode,
              terminalMode,
              paneTitleSuffix: `#${taskIndex + 1}`,
              restoreFocusPaneId: sharedRestoreFocusPaneId,
              trustedProjectRoots,
              deniedProjectRoots,
              forkSessionSnapshotJsonl,
              parentDepth: currentDepth,
              parentAgentStack: ancestorAgentStack,
              maxDepth,
              preventCycles,
              signal,
              onUpdate: (partial) => {
                if (partial.details?.results[0]) {
                  runningResults[taskIndex] = partial.details.results[0];
                  onUpdate?.({
                    content: partial.content,
                    details: makeDetails("chain", {
                      chainStageCount: chain.length,
                      chainCompletedCount: countCompletedChainStages(stages),
                      chainSkippedCount: stages.filter((stage) => stage.status === "skipped").length,
                      chainFailedCount: countFailedChainStages(stages),
                      chainCompletedWithErrorsCount: countCompletedWithErrorChainStages(stages),
                    })([...flattenedResults, ...runningResults]),
                  });
                }
              },
              makeDetails: makeDetails("chain"),
            });
            runningResults[taskIndex] = result;
            emitProgress(runningResults);
            return result;
          },
          { signal },
        );
        const stageResults = maybeStageResults.map((result, taskIndex) =>
          result ?? makeUnstartedAbortResult(
            parallel.tasks[taskIndex].agent,
            buildChainTaskFromStages(parallel.tasks[taskIndex].task, stages),
            label,
            parallel.tasks[taskIndex].model,
          ),
        );

        flattenedResults.push(...stageResults);
        const stageHasError = stageResults.some((result) => isResultError(result));
        const status: ChainStageStatus = stageHasError
          ? continueOnError
            ? "completed_with_errors"
            : "failed"
          : "completed";
        stages.push({ label, type: "parallel", status, results: stageResults });
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
                text: `Chain stopped at stage ${index + 1}/${chain.length} (${label}).\n\n${formatChainStageSummaries(stages)}`,
              },
            ],
            details: makeDetails("chain", {
              chainStageCount: chain.length,
              chainCompletedCount: countCompletedChainStages(stages),
              chainSkippedCount: stages.filter((stage) => stage.status === "skipped").length,
              chainFailedCount: countFailedChainStages(stages),
              chainCompletedWithErrorsCount: countCompletedWithErrorChainStages(stages),
            })(flattenedResults),
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
        model: taskStage.model,
      };
      emitProgress([runningResult]);

      const result = await runAgent({
        cwd: defaultCwd,
        agents,
        agentName: taskStage.agent,
        task: buildChainTaskFromStages(taskStage.task, stages),
        stageLabel: label,
        taskCwd: taskStage.cwd,
        model: taskStage.model,
        delegationMode,
        terminalMode,
        trustedProjectRoots,
        deniedProjectRoots,
        forkSessionSnapshotJsonl,
        parentDepth: currentDepth,
        parentAgentStack: ancestorAgentStack,
        maxDepth,
        preventCycles,
        signal,
        onUpdate: (partial) => {
          if (partial.details?.results[0]) {
            onUpdate?.({
              content: partial.content,
              details: makeDetails("chain", {
                chainStageCount: chain.length,
                chainCompletedCount: countCompletedChainStages(stages),
                chainSkippedCount: stages.filter((stage) => stage.status === "skipped").length,
                chainFailedCount: countFailedChainStages(stages),
                chainCompletedWithErrorsCount: countCompletedWithErrorChainStages(stages),
              })([...flattenedResults, partial.details.results[0]]),
            });
          }
        },
        makeDetails: makeDetails("chain"),
      });

      flattenedResults.push(result);
      const stageHasError = isResultError(result);
      const status: ChainStageStatus = stageHasError
        ? continueOnError
          ? "completed_with_errors"
          : "failed"
        : "completed";
      stages.push({ label, type: "chain", status, results: [result] });
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
              text: `Chain stopped at stage ${index + 1}/${chain.length} (${label}).\n\n${formatChainStageSummaries(stages)}`,
            },
          ],
          details: makeDetails("chain", {
            chainStageCount: chain.length,
            chainCompletedCount: countCompletedChainStages(stages),
            chainSkippedCount: stages.filter((stage) => stage.status === "skipped").length,
            chainFailedCount: countFailedChainStages(stages),
            chainCompletedWithErrorsCount: countCompletedWithErrorChainStages(stages),
          })(flattenedResults),
          isError: true,
        };
      }
    }

    const completed = countCompletedChainStages(stages);
    const completedWithErrors = countCompletedWithErrorChainStages(stages);
    const skipped = stages.filter((stage) => stage.status === "skipped").length;
    const failed = countFailedChainStages(stages);
    return {
      content: [
        {
          type: "text" as const,
          text: `Chain: ${completed + completedWithErrors}/${chain.length} stages completed${completedWithErrors ? `, ${completedWithErrors} completed with errors` : ""}${skipped ? `, ${skipped} skipped` : ""}${failed ? `, ${failed} failed` : ""}\n\n${formatChainStageSummaries(stages)}`,
        },
      ],
      details: makeDetails("chain", {
        chainStageCount: chain.length,
        chainCompletedCount: completed,
        chainSkippedCount: skipped,
        chainFailedCount: countFailedChainStages(stages),
        chainCompletedWithErrorsCount: countCompletedWithErrorChainStages(stages),
      })(flattenedResults),
      isError: state.hadError || state.hadCompletedWithErrors ? true : undefined,
    };
  }

  async function executeParallel(
    tasks: Array<{ agent: string; task: string; cwd?: string; model?: string }>,
    delegationMode: DelegationMode,
    terminalMode: TerminalMode,
    trustedProjectRoots: string[],
    deniedProjectRoots: string[],
    forkSessionSnapshotJsonl: string | undefined,
    agents: AgentConfig[],
    defaultCwd: string,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: any) => void) | undefined,
    makeDetails: ReturnType<typeof makeDetailsFactory>,
  ) {
    if (tasks.length > MAX_PARALLEL_TASKS) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Too many parallel tasks (${tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
          },
        ],
        details: makeDetails("parallel")([]),
        isError: true,
      };
    }

    // Initialize placeholder results for streaming
    let allResults: SingleResult[] = tasks.map((t) => ({
      agent: t.agent,
      agentSource: "unknown" as const,
      task: t.task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      model: t.model,
    }));

    const emitProgress = () => {
      if (!onUpdate) return;
      const running = allResults.filter((r) => r.exitCode === -1).length;
      const done = allResults.filter((r) => r.exitCode !== -1).length;
      onUpdate({
        content: [
          {
            type: "text",
            text: `Parallel: ${done}/${allResults.length} done, ${running} running...`,
          },
        ],
        details: makeDetails("parallel")([...allResults]),
      });
    };

    let heartbeat: NodeJS.Timeout | undefined;
    if (onUpdate) {
      emitProgress();
      heartbeat = setInterval(() => {
        if (allResults.some((r) => r.exitCode === -1)) emitProgress();
      }, PARALLEL_HEARTBEAT_MS);
    }

    let results: SingleResult[];
    try {
      const sharedRestoreFocusPaneId = terminalMode === "zellij-pane"
        ? getCurrentZellijPaneIdFromEnv()
        : undefined;

      const maybeResults = await mapConcurrent(
        tasks,
        MAX_CONCURRENCY,
        async (t, index) => {
          const result = await runAgent({
            cwd: defaultCwd,
            agents,
            agentName: t.agent,
            task: t.task,
            taskCwd: t.cwd,
            model: t.model,
            delegationMode,
            terminalMode,
            paneTitleSuffix: `#${index + 1}`,
            restoreFocusPaneId: sharedRestoreFocusPaneId,
            trustedProjectRoots,
            deniedProjectRoots,
            forkSessionSnapshotJsonl,
            parentDepth: currentDepth,
            parentAgentStack: ancestorAgentStack,
            maxDepth,
            preventCycles,
            signal,
            onUpdate: (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitProgress();
              }
            },
            makeDetails: makeDetails("parallel"),
          });
          allResults[index] = result;
          emitProgress();
          return result;
        },
        { signal },
      );
      results = maybeResults.map((result, index) =>
        result ?? makeUnstartedAbortResult(tasks[index].agent, tasks[index].task, undefined, tasks[index].model),
      );
      allResults = results;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    const successCount = results.filter((r) => isResultSuccess(r)).length;
    const summaries = results.map((r) =>
      `[${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r)}`,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
        },
      ],
      details: makeDetails("parallel")(results),
      isError: successCount !== results.length ? true : undefined,
    };
  }
}
