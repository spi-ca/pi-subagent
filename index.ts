/**
 * Pi Subagent Extension
 *
 * Delegates tasks to specialized subagents, each running as an isolated `pi`
 * process.
 *
 * Supports two invocation shapes:
 *   - Single:   { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain:    { chain: [{ agent: "name", task: "..." }, ...] }
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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
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
} from "./chain-helpers.js";
import { type AgentConfig, discoverAgents, discoverAgentsWithStarter } from "./agents.js";
import { renderCall, renderResult } from "./render.js";
import { getResultSummaryText } from "./runner-events.js";
import { mapConcurrent, runAgent } from "./runner.js";
import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  type TerminalMode,
  type ZellijPaneOptions,
  DEFAULT_DELEGATION_MODE,
  DEFAULT_TERMINAL_MODE,
  SUBAGENT_TOOL_LABEL,
  emptyUsage,
  getDefaultTerminalModeFromEnv,
  isInsideZellij,
  isResultError,
  isResultSuccess,
} from "./types.js";

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

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const TaskItem = Type.Object({
  agent: Type.String({
    description: "Name of an available agent (must match exactly)",
  }),
  task: Type.String({
    description:
      "Task description for this delegated run. In spawn mode include all required context; in fork mode the subagent also sees your current session context.",
  }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for this agent's process" }),
  ),
});

const StepCondition = Type.Union([
  Type.Literal("always"),
  Type.Literal("on_success"),
  Type.Literal("on_error"),
  Type.Literal("on_completed_with_errors"),
]);

const ChainTaskStep = Type.Object({
  type: Type.Optional(Type.Literal("chain")),
  label: Type.Optional(Type.String({ description: "Human-readable step label. Must be unique within a chain when provided." })),
  agent: Type.String({ description: "Name of an available agent (must match exactly)." }),
  task: Type.String({ description: "Task for this sequential chain step." }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this agent's process" })),
  condition: Type.Optional(StepCondition),
  continueOnError: Type.Optional(Type.Boolean({ description: "Continue later chain steps when this step fails. Default false." })),
});

const ChainParallelStep = Type.Object({
  type: Type.Literal("parallel"),
  label: Type.Optional(Type.String({ description: "Human-readable step label. Must be unique within a chain when provided." })),
  tasks: Type.Array(TaskItem, { description: "Independent tasks to run concurrently within this chain stage." }),
  condition: Type.Optional(StepCondition),
  continueOnError: Type.Optional(Type.Boolean({ description: "Continue later chain steps if one or more parallel tasks fail. Default false." })),
});

const ChainStep = Type.Union([ChainTaskStep, ChainParallelStep]);

const ZellijPaneOptionsShape = {
  direction: Type.Optional(Type.Union([
    Type.Literal("right"),
    Type.Literal("down"),
  ], { description: "Direction to open the new pane in." })),
  floating: Type.Optional(Type.Boolean({ description: "Open the new pane in floating mode." })),
  closeOnExit: Type.Optional(Type.Boolean({ description: "Close the pane immediately when its command exits." })),
  name: Type.Optional(Type.String({ description: "Override the pane title. When the effective terminal mode is zellij-pane, labeled chain stages default to label(agent), unlabeled chain stages to step-N(agent), non-chain runs to subagent-agent, and concurrent parallel runs may append a #N suffix for disambiguation." })),
};

const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name for single mode. Must match an available agent name exactly.",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "Task description for single mode. In spawn mode it must be self-contained; in fork mode the subagent also receives your current session context.",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, {
      description:
        "For parallel mode: array of {agent, task} objects. Each task runs in an isolated process concurrently. Do NOT set agent/task/chain when using this.",
    }),
  ),
  chain: Type.Optional(
    Type.Array(ChainStep, {
      description:
        "For chain mode: ordered stages. Omit type or set type='chain' for one sequential agent; set type='parallel' with tasks for a parallel stage. Stages run sequentially and receive summaries of previous stages. Supports label, condition, and continueOnError. Do NOT set agent/task/tasks when using this.",
    }),
  ),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("spawn"),
      Type.Literal("fork"),
    ], {
      description:
        "Context mode for delegated runs. 'spawn' (default) sends only the task prompt (best for isolated, reproducible work with lower token/cost and less context leakage). 'fork' adds a snapshot of current session context plus the task prompt (best for follow-up work that depends on prior context; usually higher token/cost and may include sensitive context).",
      default: DEFAULT_DELEGATION_MODE,
    }),
  ),
  terminal: Type.Optional(
    Type.Union([
      Type.Literal("inline"),
      Type.Literal("zellij-pane"),
    ], {
      description:
        "Execution surface override for delegated runs. If omitted, subagent auto-selects 'zellij-pane' inside Zellij and 'inline' otherwise. Set 'inline' or 'zellij-pane' only to override that default. 'zellij-pane' requires running inside Zellij, bridges JSON back through a FIFO, renders human-readable pane output, and applies zellij.pane options whenever the effective terminal mode resolves to zellij-pane.",
    }),
  ),
  zellij: Type.Optional(
    Type.Object({
      pane: Type.Optional(Type.Object(ZellijPaneOptionsShape, {
        description: "Optional Zellij pane settings applied whenever the effective terminal mode resolves to zellij-pane.",
      })),
    }, {
      description: "Optional Zellij execution settings applied whenever the effective terminal mode resolves to zellij-pane.",
    }),
  ),
  confirmProjectAgents: Type.Optional(
    Type.Boolean({
      description:
        "Deprecated compatibility field. Ignored; project-local trust checks still apply regardless of this value.",
      default: true,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent process (single mode only)",
    }),
  ),
});

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

function parseDelegationMode(raw: unknown): DelegationMode | null {
  if (raw === undefined) return DEFAULT_DELEGATION_MODE;
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "spawn" || normalized === "fork") {
    return normalized;
  }
  return null;
}

function parseTerminalMode(raw: unknown): TerminalMode | null {
  if (raw === undefined) {
    return getDefaultTerminalModeFromEnv();
  }
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "inline" || normalized === "zellij-pane") {
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

function getConfigDir(): string {
  return process.env["PI_CODING_AGENT_DIR"]?.trim() || path.join(os.homedir(), ".pi", "agent");
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isTrustedProjectAgentsDir(projectAgentsDir: string | null): boolean {
  if (!projectAgentsDir) return false;

  const trust = readJsonObject(path.join(getConfigDir(), "trust.json"));
  if (!trust) return false;

  const projectRoot = path.dirname(path.dirname(projectAgentsDir));
  let dir = projectRoot;
  while (true) {
    if (trust[dir] === true) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
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
  return (mode: "single" | "parallel" | "chain") =>
    (results: SingleResult[]): SubagentDetails => ({
      mode,
      toolLabel: SUBAGENT_TOOL_LABEL,
      delegationMode,
      terminalMode,
      projectAgentsDir,
      results,
    });
}

function formatAgentNames(agents: AgentConfig[]): string {
  return agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
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
    .map((name) => agents.find((a) => a.name === name))
    .filter((a): a is AgentConfig => a?.source === "project");
}

/**
 * Prompt the user to confirm project-local agents if needed.
 * Returns false if the user declines.
 */
async function confirmProjectAgentsIfNeeded(
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

  // Auto-discover agents on session start
  pi.on("session_start", async (_event, ctx) => {
    if (!canDelegate) return;

    const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
    const discovery = starterDiscovery.discovery;
    discoveredAgents = discovery.agents;

    if (ctx.hasUI) {
      if (starterDiscovery.createdAgentPath) {
        ctx.ui.notify(
          `Created starter subagent "explorer" at:\n${starterDiscovery.createdAgentPath}\n\nEdit this file or add more agents in the same directory to customize delegation.`,
          "info",
        );
      } else if (starterDiscovery.error && discoveredAgents.length === 0) {
        ctx.ui.notify(
          `No subagents found. ${starterDiscovery.error}`,
          "info",
        );
      }
    }
  });

  // Inject available agents into the system prompt
  pi.on("before_agent_start", async (event) => {
    if (!canDelegate) return;
    if (discoveredAgents.length === 0) return;

    const agentList = discoveredAgents
      .map((a) => `- **${a.name}**: ${a.description}`)
      .join("\n");
    return {
      systemPrompt:
        event.systemPrompt +
        `\n\n## Available Subagents

The following subagents are available via the \`subagent\` tool:

${agentList}

### How to call the subagent tool

Each subagent runs in an **isolated process**.

Context behavior is controlled by optional 'mode':
- 'spawn' (default): child receives only the provided task prompt. Best for isolated, reproducible tasks with lower token/cost and less context leakage.
- 'fork': child receives a forked snapshot of current session context plus the task prompt. Best for follow-up tasks that rely on prior context; usually higher token/cost and may include sensitive context.

Execution surface can be overridden with optional 'terminal':
- omitted (default): auto-select 'zellij-pane' inside Zellij and 'inline' otherwise.
- 'inline': launch the child pi process directly and stream stdout.
- 'zellij-pane': launch the child in a new Zellij pane, bridge JSON stdout back through a FIFO, and render human-readable progress in the pane while structured progress stays in the parent TUI. This override requires running inside Zellij.

**Single mode** — delegate one task:
\`\`\`json
{ "agent": "agent-name", "task": "Detailed task...", "mode": "spawn", "terminal": "inline" }
\`\`\`

**Parallel mode** — run multiple tasks concurrently (do NOT also set agent/task/chain):
\`\`\`json
{ "tasks": [{ "agent": "agent-name", "task": "..." }, { "agent": "other-agent", "task": "..." }], "mode": "fork", "terminal": "zellij-pane" }
\`\`\`

**Chain mode** — run ordered stages sequentially (do NOT also set agent/task/tasks). A stage can be a sequential agent step or a parallel group:
\`\`\`json
{ "chain": [{ "label": "discover", "type": "parallel", "tasks": [{ "agent": "scout", "task": "Inspect code" }, { "agent": "researcher", "task": "Check docs" }] }, { "label": "plan", "agent": "planner", "task": "Plan from discovery" }], "mode": "spawn", "terminal": "inline" }
\`\`\`

Use single mode for one task, parallel mode when tasks are independent and can run simultaneously, and chain mode when later stages depend on earlier outputs. In chain stages, omitted type means a sequential chain step. Optional fields: label, condition, continueOnError.

### Runtime delegation guards

- Max depth: current depth ${currentDepth}, max depth ${maxDepth}
- Cycle prevention: ${preventCycles ? "enabled" : "disabled"}
- Current delegation stack: ${ancestorAgentStack.length > 0 ? ancestorAgentStack.join(" -> ") : "(root)"}
`,
    };
  });

  // Register the subagent tool
  if (canDelegate) {
    pi.registerTool({
      name: "subagent",
      label: SUBAGENT_TOOL_LABEL,
      description: [
        "Delegate work to specialized subagents running in isolated pi processes.",
        "",
        "IMPORTANT: Use exactly ONE invocation shape:",
        "  Single mode:   set `agent` and `task` (both required together).",
        "  Parallel mode: set `tasks` array (do NOT also set `agent`/`task`/`chain`).",
        "  Chain mode:    set `chain` array (do NOT also set `agent`/`task`/`tasks`). Chain stages can mix sequential steps and parallel groups.",
        "",
        "Optional context mode switch:",
        "  mode: \"spawn\" (default) -> child gets only your task prompt.",
        "                             Best for isolated/reproducible work; lower token/cost and less context leakage.",
        "  mode: \"fork\"            -> child gets current session context + your task prompt.",
        "                             Best for follow-up work that depends on prior context; higher token/cost and may include sensitive context.",
        "",
        "Optional execution surface override:",
        "  terminal omitted            -> auto-select \"zellij-pane\" inside Zellij and \"inline\" otherwise.",
        "  terminal: \"inline\"      -> launch child pi directly and stream stdout.",
        "  terminal: \"zellij-pane\" -> launch child pi in a new Zellij pane, bridge JSON through a FIFO, and render human-readable pane output while structured progress stays in the parent TUI (requires Zellij).",
        "",
        'Example single:   { agent: "writer", task: "Rewrite README.md", mode: "spawn", terminal: "inline" }',
        'Example parallel: { tasks: [{ agent: "writer", task: "..." }, { agent: "tester", task: "..." }], mode: "fork", terminal: "zellij-pane" }',
        'Example chain:    { chain: [{ label: "discover", type: "parallel", tasks: [{ agent: "scout", task: "Inspect" }, { agent: "researcher", task: "Check docs" }] }, { label: "plan", agent: "planner", task: "Plan from discovery" }], mode: "spawn", terminal: "inline" }',
      ].join("\n"),
      parameters: SubagentParams,

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const starterDiscovery = discoverAgentsWithStarter(ctx.cwd);
        const discovery = starterDiscovery.discovery;
        const { agents } = discovery;

        const delegationMode = parseDelegationMode(params.mode);
        const terminalMode = parseTerminalMode((params as { terminal?: unknown }).terminal);
        if (!delegationMode || !terminalMode) {
          const fallbackDetails = makeDetailsFactory(
            discovery.projectAgentsDir,
            DEFAULT_DELEGATION_MODE,
            DEFAULT_TERMINAL_MODE,
          );
          const validationError = !delegationMode
            ? `Invalid mode \"${String(params.mode)}\". Expected \"spawn\" or \"fork\".`
            : `Invalid terminal \"${String((params as { terminal?: unknown }).terminal)}\". Expected \"inline\" or \"zellij-pane\".`;
          return {
            content: [
              {
                type: "text",
                text: `${validationError}\nAvailable agents: ${formatAgentNames(agents)}`,
              },
            ],
            details: fallbackDetails("single")([]),
            isError: true,
          };
        }

        const zellijPane = ((params as { zellij?: { pane?: ZellijPaneOptions } }).zellij?.pane ?? {}) as ZellijPaneOptions;

        const makeDetails = makeDetailsFactory(
          discovery.projectAgentsDir,
          delegationMode,
          terminalMode,
        );

        if (terminalMode === "zellij-pane" && !isInsideZellij()) {
          return {
            content: [
              {
                type: "text",
                text: "Cannot use terminal=\"zellij-pane\" outside a Zellij session.",
              },
            ],
            details: makeDetails("single")([]),
            isError: true,
          };
        }

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
              details: makeDetails("single")([]),
              isError: true,
            };
          }
        }

        // Validate: exactly one invocation shape must be specified
        const hasTasks = (params.tasks?.length ?? 0) > 0;
        const hasChain = (params.chain?.length ?? 0) > 0;
        const hasSingle = Boolean(params.agent && params.task);
        if (Number(hasTasks) + Number(hasChain) + Number(hasSingle) !== 1) {
          return {
            content: [
              {
                type: "text",
                text: `Invalid parameters. Provide exactly one invocation shape.\nAvailable agents: ${formatAgentNames(agents)}`,
              },
            ],
            details: makeDetails("single")([]),
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
              details: makeDetails("chain")([]),
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

        const requestedProjectAgents = getRequestedProjectAgents(
          agents,
          requested,
        );
        // Project-local agents are repository-controlled prompts. Respect the
        // current session trust state, including temporary trust decisions and
        // CLI trust overrides.
        if (requestedProjectAgents.length > 0) {
          const trustedProject = typeof (ctx as { isProjectTrusted?: unknown }).isProjectTrusted === "function"
            ? Boolean((ctx as unknown as { isProjectTrusted: () => boolean }).isProjectTrusted())
            : isTrustedProjectAgentsDir(discovery.projectAgentsDir);
          const shouldPrompt = !trustedProject;
          if (ctx.hasUI && shouldPrompt) {
            const approved = await confirmProjectAgentsIfNeeded(
              requestedProjectAgents,
              discovery.projectAgentsDir,
              ctx,
            );
            if (!approved) {
              return {
                content: [
                  {
                    type: "text",
                    text: "Canceled: project-local agents not approved.",
                  },
                ],
                details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
              };
            }
          } else if (!ctx.hasUI && shouldPrompt) {
            const names = requestedProjectAgents.map((a) => a.name).join(", ");
            const dir = discovery.projectAgentsDir ?? "(unknown)";
            return {
              content: [
                {
                  type: "text",
                  text: `Blocked: project-local agent confirmation is required in non-UI mode.\nAgents: ${names}\nSource: ${dir}\n\nRun from an interactive trusted session or pass --approve so the current session trust state allows project-local agents.`,
                },
              ],
              details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
              isError: true,
            };
          }
        }

        // ── Parallel mode ──
        if (params.tasks && params.tasks.length > 0) {
          return executeParallel(
            params.tasks,
            delegationMode,
            terminalMode,
            zellijPane,
            forkSessionSnapshotJsonl,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
          );
        }



        // ── Chain mode ──
        if (params.chain && params.chain.length > 0) {
          return executeChain(
            params.chain as ChainStage[],
            delegationMode,
            terminalMode,
            zellijPane,
            forkSessionSnapshotJsonl,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
          );
        }

        // ── Single mode ──
        if (params.agent && params.task) {
          return executeSingle(
            params.agent,
            params.task,
            params.cwd,
            delegationMode,
            terminalMode,
            zellijPane,
            forkSessionSnapshotJsonl,
            agents,
            ctx.cwd,
            signal,
            onUpdate,
            makeDetails,
          );
        }

        return {
          content: [
            {
              type: "text",
              text: `Invalid parameters. Available agents: ${formatAgentNames(agents)}`,
            },
          ],
          details: makeDetails("single")([]),
        };
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
    delegationMode: DelegationMode,
    terminalMode: TerminalMode,
    zellijPane: ZellijPaneOptions,
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
      delegationMode,
      terminalMode,
      zellijPane,
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
    zellijPane: ZellijPaneOptions,
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
        details: makeDetails("chain")([]),
        isError: true,
      };
    }

    const validationError = validateChainStages(chain);
    if (validationError) {
      return {
        content: [{ type: "text" as const, text: validationError }],
        details: makeDetails("chain")([]),
        isError: true,
      };
    }

    const stages: ChainStageRecord[] = [];
    const flattenedResults: SingleResult[] = [];
    const state: ChainExecutionState = { hadError: false, hadCompletedWithErrors: false };

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
        details: makeDetails("chain")(displayedResults),
      });
    };

    emitProgress();

    for (let index = 0; index < chain.length; index++) {
      const stage = chain[index];
      const stageType = getChainStageType(stage);
      const label = getStageLabel(stage, index);
      const continueOnError = stage.continueOnError ?? false;

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
        }));
        emitProgress(runningResults);

        const sharedRestoreFocusPaneId = terminalMode === "zellij-pane"
          ? getCurrentZellijPaneIdFromEnv()
          : undefined;

        const stageResults = await mapConcurrent(
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
              delegationMode,
              terminalMode,
              zellijPane,
              paneTitleSuffix: `#${taskIndex + 1}`,
              restoreFocusPaneId: sharedRestoreFocusPaneId,
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
                    details: makeDetails("chain")([...flattenedResults, ...runningResults]),
                  });
                }
              },
              makeDetails: makeDetails("chain"),
            });
            runningResults[taskIndex] = result;
            emitProgress(runningResults);
            return result;
          },
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
            details: makeDetails("chain")(flattenedResults),
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
      };
      emitProgress([runningResult]);

      const result = await runAgent({
        cwd: defaultCwd,
        agents,
        agentName: taskStage.agent,
        task: buildChainTaskFromStages(taskStage.task, stages),
        stageLabel: label,
        taskCwd: taskStage.cwd,
        delegationMode,
        terminalMode,
        zellijPane,
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
              details: makeDetails("chain")([...flattenedResults, partial.details.results[0]]),
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
          details: makeDetails("chain")(flattenedResults),
          isError: true,
        };
      }
    }

    const completed = stages.filter((stage) => stage.status !== "skipped").length;
    const skipped = stages.length - completed;
    return {
      content: [
        {
          type: "text" as const,
          text: `Chain: ${completed}/${chain.length} stages completed${skipped ? `, ${skipped} skipped` : ""}\n\n${formatChainStageSummaries(stages)}`,
        },
      ],
      details: makeDetails("chain")(flattenedResults),
      isError: state.hadError && !state.hadCompletedWithErrors ? true : undefined,
    };
  }

  async function executeParallel(
    tasks: Array<{ agent: string; task: string; cwd?: string }>,
    delegationMode: DelegationMode,
    terminalMode: TerminalMode,
    zellijPane: ZellijPaneOptions,
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
      };
    }

    // Initialize placeholder results for streaming
    const allResults: SingleResult[] = tasks.map((t) => ({
      agent: t.agent,
      agentSource: "unknown" as const,
      task: t.task,
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
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

      results = await mapConcurrent(
        tasks,
        MAX_CONCURRENCY,
        async (t, index) => {
          const result = await runAgent({
            cwd: defaultCwd,
            agents,
            agentName: t.agent,
            task: t.task,
            taskCwd: t.cwd,
            delegationMode,
            terminalMode,
            zellijPane,
            paneTitleSuffix: `#${index + 1}`,
            restoreFocusPaneId: sharedRestoreFocusPaneId,
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
      );
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
    };
  }
}
