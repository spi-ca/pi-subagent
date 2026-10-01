import { Type } from "typebox";
import { type SingleResult, type SubagentDetails } from "./types.js";
import type { BackgroundJobActionDetails, BackgroundJobDetailSummary } from "./background-job-details.js";

export const STRUCTURED_RESULT_MAX_ROWS = 32;
export const STRUCTURED_RESULT_MAX_BYTES = 64 * 1024;
const MAX_STRING = 2048;
const text = () => Type.String({ maxLength: MAX_STRING });
const count = () => Type.Integer({ minimum: 0 });
const JobSchema = Type.Object({
  jobId: text(), status: text(), startedAt: Type.Number(), completedAt: Type.Optional(Type.Number()),
  output: Type.Optional(text()), errorReason: Type.Optional(text()), omittedBytes: count(), clipped: Type.Boolean(),
}, { additionalProperties: false });
const ResultSchema = Type.Object({
  agent: text(), agentSource: text(), exitCode: Type.Integer(), output: text(),
  stageLabel: Type.Optional(text()), model: Type.Optional(text()), stopReason: Type.Optional(text()), errorMessage: Type.Optional(text()),
  clipped: Type.Boolean(),
}, { additionalProperties: false });
/** A bounded data projection, independent of human formatting and TUI details. */
export const SubagentOutputSchema = Type.Object({
  kind: Type.Literal("subagent.result"), version: Type.Literal(1),
  operation: Type.Union(["single", "parallel", "chain", "background", "status", "cancel"].map((value) => Type.Literal(value))),
  event: Type.Optional(text()), mode: Type.Optional(text()), delegationMode: Type.Optional(text()), terminalMode: Type.Optional(text()),
  results: Type.Array(ResultSchema, { maxItems: STRUCTURED_RESULT_MAX_ROWS }),
  jobs: Type.Array(JobSchema, { maxItems: STRUCTURED_RESULT_MAX_ROWS }),
  omittedResults: count(), omittedJobs: count(), clipped: Type.Boolean(),
  chainStageCount: Type.Optional(count()), chainCompletedCount: Type.Optional(count()), chainSkippedCount: Type.Optional(count()),
  chainFailedCount: Type.Optional(count()), chainCompletedWithErrorsCount: Type.Optional(count()),
}, { additionalProperties: false });

function bounded(value: string): string {
  let end = Math.min(value.length, MAX_STRING);
  if (end < value.length && /[\ud800-\udbff]/.test(value[end - 1] ?? "")) end -= 1;
  return value.slice(0, end);
}
/** Same last non-empty assistant selection as human output, without a full join. */
function finalOutput(result: SingleResult): { output: string; clipped: boolean } {
  for (let index = result.messages.length - 1; index >= 0; index--) {
    const message = result.messages[index];
    if (message.role !== "assistant") continue;
    let prefix = "", length = 0, hasText = false;
    for (const part of message.content) {
      if (part.type !== "text" || !part.text) continue;
      const separator = hasText ? "\n" : "";
      length += separator.length + part.text.length;
      if (prefix.length < MAX_STRING + 1) prefix += separator + part.text.slice(0, MAX_STRING + 1 - prefix.length - separator.length);
      hasText = true;
    }
    if (hasText) return { output: bounded(prefix), clipped: length > MAX_STRING };
  }
  return { output: "", clipped: false };
}
function projectResult(result: SingleResult) {
  const { output, clipped } = finalOutput(result);
  const raw = {
    agent: result.agent, agentSource: result.agentSource, exitCode: result.exitCode, output,
    ...(result.stageLabel === undefined ? {} : { stageLabel: result.stageLabel }),
    ...(result.model === undefined ? {} : { model: result.model }),
    ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
    ...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
  };
  return { ...raw, ...Object.fromEntries(Object.entries(raw).filter(([, value]) => typeof value === "string").map(([key, value]) => [key, bounded(value as string)])),
    clipped: clipped || Object.values(raw).some((value) => typeof value === "string" && bounded(value) !== value) };
}
function projectJob(job: BackgroundJobDetailSummary) {
  return {
    jobId: bounded(job.jobId), status: job.status, startedAt: job.startedAt,
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    ...(job.output === undefined ? {} : { output: bounded(job.output) }),
    ...(job.errorReason === undefined ? {} : { errorReason: bounded(job.errorReason) }),
    omittedBytes: job.omittedBytes,
    clipped: Boolean(job.outputClipped || job.omittedBytes > 0 || (job.output?.length ?? 0) > MAX_STRING || (job.errorReason?.length ?? 0) > MAX_STRING),
  };
}

/** Only producer data is read. Human content is never parsed or used as authority. */
export function withSubagentStructuredContent<T extends { details: unknown }>(result: T) {
  const details = result.details as SubagentDetails & BackgroundJobActionDetails;
  const background = details?.kind === "subagent.background-job";
  let operation: string = details.mode;
  if (background) {
    if (details.event === "accepted") operation = "background";
    else if (["cancel-list", "cancellation-requested", "already-terminal"].includes(details.event)) operation = "cancel";
    else operation = "status";
  }
  const data = {
    kind: "subagent.result" as const, version: 1 as const,
    operation,
    ...(background ? { event: details.event } : { mode: details.mode, delegationMode: details.delegationMode, terminalMode: details.terminalMode }),
    results: [] as ReturnType<typeof projectResult>[], jobs: [] as ReturnType<typeof projectJob>[],
    omittedResults: 0, omittedJobs: 0, clipped: false,
    ...Object.fromEntries(["chainStageCount", "chainCompletedCount", "chainSkippedCount", "chainFailedCount", "chainCompletedWithErrorsCount"].flatMap((key) => {
      const value = (details as unknown as Record<string, unknown>)[key];
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
    })),
  };
  const results = background ? [] : details.results ?? [];
  const jobs = background ? details.jobs ?? (details.job ? [details.job] : []) : [];
  // JSON escaping can expand text sixfold. Charge actual encoded rows before
  // retaining them and reserve a fixed envelope allowance, not a char estimate.
  let remaining = STRUCTURED_RESULT_MAX_BYTES - 4096;
  for (const source of results.slice(0, STRUCTURED_RESULT_MAX_ROWS)) {
    const row = projectResult(source), bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > remaining) break;
    remaining -= bytes; data.results.push(row);
  }
  for (const source of jobs.slice(0, STRUCTURED_RESULT_MAX_ROWS)) {
    const row = projectJob(source), bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > remaining) break;
    remaining -= bytes; data.jobs.push(row);
  }
  data.omittedResults = results.length - data.results.length;
  data.omittedJobs = jobs.length - data.jobs.length + (details.omittedJobCount ?? 0);
  data.clipped = data.omittedResults > 0 || data.omittedJobs > 0 || [...data.results, ...data.jobs].some((row) => row.clipped);
  return { ...result, structuredContent: data };
}
