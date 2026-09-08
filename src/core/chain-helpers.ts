import { formatBoundedForegroundRecordEnvelope, formatBoundedForegroundRecords } from "./foreground-output.js";
import { getResultSummaryText } from "./runner-events.js";
import { isResultError, type SingleResult } from "./types.js";

export type StepConditionName = "always" | "on_success" | "on_error" | "on_completed_with_errors";

export type ChainTask = { agent: string; task: string; cwd?: string; model?: string };
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
  hadBlockingError: boolean;
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

export function validateChainLabels(chain: ChainStage[]): string | null {
  const labels = new Set<string>();
  for (const [index, stage] of chain.entries()) {
    const label = stage.label?.trim();
    if (!label) continue;
    if (labels.has(label)) return `Duplicate chain label at chain[${index}]. Labels must be unique.`;
    labels.add(label);
  }
  return null;
}

export function validateChainParallelLimit(chain: ChainStage[], maxParallelTasks = 8): string | null {
  for (let i = 0; i < chain.length; i++) {
    const stage = chain[i];
    if (getChainStageType(stage) !== "parallel") continue;
    const parallel = stage as ChainParallelStage;
    if (parallel.tasks.length > maxParallelTasks) {
      return `Too many parallel tasks in chain stage ${i + 1} (${parallel.tasks.length}). Max is ${maxParallelTasks}.`;
    }
  }
  return null;
}

/** Counts every sequential and nested-parallel leaf before chain execution. */
export function validateChainLeafTaskLimit(chain: ChainStage[], maxTasks: number): string | null {
  let taskCount = 0;
  for (const stage of chain) {
    taskCount += getChainStageType(stage) === "parallel"
      ? (stage as ChainParallelStage).tasks.length
      : 1;
    if (taskCount > maxTasks) {
      return `Too many aggregate leaf tasks in chain (${taskCount}). Max is ${maxTasks}.`;
    }
  }
  return null;
}

export function shouldRunStage(condition: StepConditionName | undefined, state: ChainExecutionState): boolean {
  switch (condition ?? "on_success") {
    case "always":
      return true;
    case "on_success":
      return !state.hadBlockingError;
    case "on_error":
      return state.hadError;
    case "on_completed_with_errors":
      return state.hadCompletedWithErrors;
  }
}

function chainStageRecords(stages: ChainStageRecord[]): Array<{ identifier: string; body: string }> {
  return stages.map((stage, index) => ({
    identifier: `${index + 1}. ${stage.label}`,
    body: stage.status === "skipped"
      ? `skipped: ${stage.reason ?? "condition not met"}`
      : `${stage.type}, ${stage.status}:\n${stage.results.length > 0
        ? stage.results.map((result) =>
          `#### [${result.agent}] ${isResultError(result) ? "failed" : "completed"}\n${getResultSummaryText(result)}`,
        ).join("\n\n")
        : stage.reason ?? "(no output)"}`,
  }));
}

function formatChainStageRecords(stages: ChainStageRecord[], destination: "tool-result" | "chain-handoff" = "tool-result"): string {
  return formatBoundedForegroundRecords(chainStageRecords(stages), undefined, "chain stage record", destination);
}

export function buildChainTaskFromStages(task: string, previousStages: ChainStageRecord[]): string {
  const previous = formatChainStageRecords(previousStages.filter((stage) => stage.status !== "skipped"), "chain-handoff");

  if (!previous.trim()) return task;
  // The fixed budget applies only to prior output records. The current task is
  // always appended intact so omitted history cannot rewrite or displace it.
  return `Previous chain stage outputs are provided for context. Use them as evidence, but follow the current task instructions.\n\n${previous}\n\n---\n\nCurrent task:\n${task}`;
}

export function formatChainStageSummaries(stages: ChainStageRecord[]): string {
  return formatChainStageRecords(stages, "tool-result");
}

/** Reserve the final chain header before formatting stage records. */
export function formatChainStageEnvelope(header: string, stages: ChainStageRecord[]): string {
  return formatBoundedForegroundRecordEnvelope(header, chainStageRecords(stages), "chain stage record");
}
