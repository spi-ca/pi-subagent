import * as path from "node:path";
import { Type } from "typebox";
import { canonicalizePathForTrust } from "./trust-path.js";
import { DEFAULT_DELEGATION_MODE } from "./types.js";

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

export const SubagentParams = Type.Object({
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
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the agent process (single mode only)",
    }),
  ),
});

export function parseProjectRootEnvValue(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
          .map((value) => canonicalizePathForTrust(value)),
      ),
    );
  } catch {
    return [];
  }
}

export function getProjectRootFromAgentsDir(projectAgentsDir: string | null): string | null {
  return projectAgentsDir
    ? canonicalizePathForTrust(path.dirname(path.dirname(projectAgentsDir)))
    : null;
}
