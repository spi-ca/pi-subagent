import { getResultSummaryText } from "./runner-events.js";
import { isResultError, type SingleResult } from "./types.js";

export type StepConditionName = "always" | "on_success" | "on_error" | "on_completed_with_errors";

export type ChainTask = { agent: string; task: string; cwd?: string };
export type ChainTaskStage = ChainTask & {
  type?: "chain";
  label?: string;
  condition?: StepConditionName;
  continueOnError?: boolean;
};
export type ChainParallelStage = {
  type: "parallel";
  label?: string;
  tasks: ChainTask[];
  condition?: StepConditionName;
  continueOnError?: boolean;
};
export type ChainStage = ChainTaskStage | ChainParallelStage;

export type ChainStageStatus = "completed" | "completed_with_errors" | "failed" | "skipped";
export interface ChainStageRecord {
  label: string;
  type: "chain" | "parallel";
  status: ChainStageStatus;
  results: SingleResult[];
  reason?: string;
}

export interface ChainExecutionState {
  hadError: boolean;
  hadCompletedWithErrors: boolean;
}

export function getChainStageType(stage: ChainStage): "chain" | "parallel" {
  return stage.type === "parallel" ? "parallel" : "chain";
}

export function getStageLabel(stage: ChainStage, index: number): string {
  return stage.label?.trim() || `step-${index + 1}`;
}

export function collectRequestedAgentNamesFromChain(chain: ChainStage[]): Set<string> {
  const requested = new Set<string>();
  for (const stage of chain) {
    if (getChainStageType(stage) === "parallel") {
      for (const task of (stage as ChainParallelStage).tasks ?? []) requested.add(task.agent);
    } else {
      requested.add((stage as ChainTaskStage).agent);
    }
  }
  return requested;
}

export function validateChainStages(chain: ChainStage[], maxParallelTasks = 8): string | null {
  const labels = new Set<string>();
  for (let i = 0; i < chain.length; i++) {
    const stage = chain[i];
    const label = stage.label?.trim();
    if (label) {
      if (labels.has(label)) return `Duplicate chain label "${label}". Labels must be unique.`;
      labels.add(label);
    }

    if (getChainStageType(stage) === "parallel") {
      const parallel = stage as ChainParallelStage;
      if (!Array.isArray(parallel.tasks) || parallel.tasks.length === 0) {
        return `Invalid chain stage ${i + 1}: type="parallel" requires a non-empty tasks array.`;
      }
      if (parallel.tasks.length > maxParallelTasks) {
        return `Too many parallel tasks in chain stage ${i + 1} (${parallel.tasks.length}). Max is ${maxParallelTasks}.`;
      }
    } else {
      const task = stage as ChainTaskStage;
      if (!task.agent || !task.task) {
        return `Invalid chain stage ${i + 1}: sequential chain stages require agent and task.`;
      }
    }
  }
  return null;
}

export function shouldRunStage(condition: StepConditionName | undefined, state: ChainExecutionState): boolean {
  switch (condition ?? "on_success") {
    case "always":
      return true;
    case "on_success":
      return !state.hadError;
    case "on_error":
      return state.hadError;
    case "on_completed_with_errors":
      return state.hadCompletedWithErrors;
  }
}

export function buildChainTaskFromStages(task: string, previousStages: ChainStageRecord[]): string {
  const previous = previousStages
    .filter((stage) => stage.status !== "skipped")
    .map((stage) => {
      const body = stage.results.length > 0
        ? stage.results
            .map((result) => `### ${result.agent} (${isResultError(result) ? "failed" : "completed"})\n${getResultSummaryText(result)}`)
            .join("\n\n")
        : stage.reason ?? "(no output)";
      return `## ${stage.label} (${stage.type}, ${stage.status})\n${body}`;
    })
    .join("\n\n");

  if (!previous.trim()) return task;
  return `Previous chain stage outputs are provided for context. Use them as evidence, but follow the current task instructions.\n\n${previous}\n\n---\n\nCurrent task:\n${task}`;
}

export function formatChainStageSummaries(stages: ChainStageRecord[]): string {
  return stages
    .map((stage, index) => {
      if (stage.status === "skipped") {
        return `[${index + 1}. ${stage.label}] skipped: ${stage.reason ?? "condition not met"}`;
      }
      const summaries = stage.results.map((r) =>
        `  [${r.agent}] ${isResultError(r) ? "failed" : "completed"}: ${getResultSummaryText(r)}`,
      );
      return `[${index + 1}. ${stage.label}] ${stage.status}:\n${summaries.join("\n\n")}`;
    })
    .join("\n\n");
}
