import { extractToolText, formatStoredBackgroundToolText, type BackgroundJobSnapshot, type BackgroundJobStatus } from "./subagent-config.js";

/** Versioned display-only details for background tool actions. */
export const BACKGROUND_JOB_DETAILS_KIND = "subagent.background-job";
export const BACKGROUND_JOB_DETAILS_VERSION = 1;

export type BackgroundJobDetailEvent =
  | "accepted"
  | "status"
  | "status-list"
  | "cancel-list"
  | "cancellation-requested"
  | "already-terminal"
  | "error";

export interface BackgroundJobDetailSummary {
  jobId: string;
  status: BackgroundJobStatus;
  startedAt: number;
  completedAt?: number;
  errorReason?: string;
  /** Sanitized selected result/error body for the display-only exact-status card. */
  output?: string;
  /** UI-only truncation of the selected detail; distinct from producer omission provenance. */
  outputClipped?: boolean;
  omittedBytes: number;
}

export interface BackgroundJobActionDetails {
  kind: typeof BACKGROUND_JOB_DETAILS_KIND;
  version: typeof BACKGROUND_JOB_DETAILS_VERSION;
  event: BackgroundJobDetailEvent;
  operation?: "start" | "status" | "cancel";
  job?: BackgroundJobDetailSummary;
  /** Retained top-level compatibility fields for accepted background starts. */
  jobId?: string;
  status?: BackgroundJobStatus;
  jobs?: BackgroundJobDetailSummary[];
  /** Number of status rows retained only in the model-visible tool result. */
  omittedJobCount?: number;
  reason?: string;
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUSES = new Set<BackgroundJobStatus>(["running", "cancelling", "completed", "failed", "cancelled"]);
const EVENTS = new Set<BackgroundJobDetailEvent>([
  "accepted", "status", "status-list", "cancel-list", "cancellation-requested", "already-terminal", "error",
]);
const OPERATIONS = new Set(["start", "status", "cancel"]);
const MAX_REASON_CODE_UNITS = 4 * 1024;
const MAX_JOBS = 512;

/** Display-only normalization; model-visible content and error semantics remain untouched. */
function sanitizeBackgroundActionDetail(text: string): string {
  return text
    .replace(/\p{Surrogate}/gu, "�")
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function truncateBackgroundActionDetail(text: string, maxCodeUnits = MAX_REASON_CODE_UNITS): string {
  if (text.length <= maxCodeUnits) return text;
  let end = maxCodeUnits;
  const prior = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (prior >= 0xd800 && prior <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

function stripCurrentBackgroundNotice(text: string, omittedBytes: number): string {
  if (!Number.isSafeInteger(omittedBytes) || omittedBytes <= 0) return text;
  const suffix = `\n\n[Background output truncated: ${omittedBytes} bytes omitted.]`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}

/** Selects text and omission provenance together; a blank result never borrows an error count. */
export function selectBackgroundJobResult(job: BackgroundJobSnapshot): { text: string; omittedBytes: number } | undefined {
  const resultText = job.result?.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") ?? "";
  if (extractToolText(job.result)) return { text: resultText, omittedBytes: job.result?.omittedBytes ?? 0 };
  if (job.error !== undefined) return { text: job.error, omittedBytes: job.errorOmittedBytes ?? 0 };
  if (job.result !== undefined) return { text: "", omittedBytes: job.result.omittedBytes ?? 0 };
  return undefined;
}

function backgroundJobDisplayBody(job: BackgroundJobSnapshot): { text: string; omittedBytes: number } | undefined {
  const source = selectBackgroundJobResult(job);
  return source === undefined ? undefined : { ...source, text: stripCurrentBackgroundNotice(source.text, source.omittedBytes) };
}

function backgroundJobActionDisplayDetail(text: string): { text: string; clipped: boolean } {
  const sanitized = sanitizeBackgroundActionDetail(text);
  const truncated = truncateBackgroundActionDetail(sanitized);
  return { text: truncated, clipped: truncated.length !== sanitized.length };
}

/** Builds bounded, display-only structured status without changing model-visible tool output. */
export function buildBackgroundJobDetailSummary(job: BackgroundJobSnapshot): BackgroundJobDetailSummary {
  const body = backgroundJobDisplayBody(job);
  const error = job.error === undefined
    ? undefined
    : backgroundJobActionDisplayDetail(stripCurrentBackgroundNotice(job.error, job.errorOmittedBytes ?? 0));
  const selected = body === undefined ? undefined : backgroundJobActionDisplayDetail(body.text);
  let errorReason = error?.text;
  let output = selected?.text;

  // Fallback failures can retain the same text as both `error` and `result`.
  // Show one copy, but retain whichever source contains more meaningful text.
  if (errorReason !== undefined && output !== undefined) {
    if (errorReason.includes(output)) output = undefined;
    else if (output.includes(errorReason)) errorReason = undefined;
  }

  const outputClipped = error?.clipped || selected?.clipped || false;
  return {
    jobId: job.id,
    status: job.status,
    startedAt: job.startedAt,
    ...(job.completedAt === undefined ? {} : { completedAt: job.completedAt }),
    ...(errorReason === undefined ? {} : { errorReason }),
    ...(output === undefined ? {} : { output }),
    ...(outputClipped ? { outputClipped: true } : {}),
    omittedBytes: body?.omittedBytes ?? 0,
  };
}

/** Builds the exact current producer envelope before the entrypoint delivers it as a steer message. */
export function buildBackgroundJobResultNotification(job: BackgroundJobSnapshot): {
  content: string;
  details: {
    kind: "subagent.background-result";
    version: 1;
    jobId: string;
    status: BackgroundJobStatus;
    startedAt: number;
    completedAt: number | undefined;
    omittedBytes: number;
  };
} {
  const selected = job.status === "cancelled" ? undefined : selectBackgroundJobResult(job);
  // Preserve a canonical suffix-only producer payload verbatim. The parser
  // validates its leading newlines and omission count; only empty output uses
  // the header-only zero-retention representation.
  const notificationText = selected?.text ?? "";
  return {
    content: `Background subagent job ${job.id} ${job.status}.${notificationText ? `\n\n${formatStoredBackgroundToolText(notificationText)}` : ""}`,
    details: {
      kind: "subagent.background-result",
      version: 1,
      jobId: job.id,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      omittedBytes: selected?.omittedBytes ?? 0,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeOmittedBytes(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeDisplayText(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_REASON_CODE_UNITS
    && !/[\p{Surrogate}\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function parseSummary(value: unknown): BackgroundJobDetailSummary | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = [
    "jobId", "status", "startedAt", "omittedBytes",
    ...(value.completedAt === undefined ? [] : ["completedAt"]),
    ...(value.errorReason === undefined ? [] : ["errorReason"]),
    ...(value.output === undefined ? [] : ["output"]),
    ...(value.outputClipped === undefined ? [] : ["outputClipped"]),
  ];
  if (!hasOnlyKeys(value, allowed)) return undefined;
  if (typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)) return undefined;
  if (typeof value.status !== "string" || !STATUSES.has(value.status as BackgroundJobStatus)) return undefined;
  if (!isSafeTimestamp(value.startedAt)) return undefined;
  if (value.completedAt !== undefined && (!isSafeTimestamp(value.completedAt) || value.completedAt < value.startedAt)) return undefined;
  if (value.errorReason !== undefined && !isSafeDisplayText(value.errorReason)) return undefined;
  if (value.output !== undefined && !isSafeDisplayText(value.output)) return undefined;
  if (value.outputClipped !== undefined && typeof value.outputClipped !== "boolean") return undefined;
  if (!isSafeOmittedBytes(value.omittedBytes)) return undefined;
  return {
    jobId: value.jobId,
    status: value.status as BackgroundJobStatus,
    startedAt: value.startedAt,
    ...(value.completedAt === undefined ? {} : { completedAt: value.completedAt }),
    ...(value.errorReason === undefined ? {} : { errorReason: value.errorReason }),
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value.outputClipped === undefined ? {} : { outputClipped: value.outputClipped }),
    omittedBytes: value.omittedBytes,
  };
}

/**
 * Parses only extension-produced display metadata. It is deliberately closed:
 * restored/model-visible details with unknown keys or malformed fields fall
 * back to the existing result renderer instead of being treated as UI state.
 */
export function parseBackgroundJobActionDetails(value: unknown): BackgroundJobActionDetails | undefined {
  if (!isRecord(value)
    || value.kind !== BACKGROUND_JOB_DETAILS_KIND
    || value.version !== BACKGROUND_JOB_DETAILS_VERSION
    || typeof value.event !== "string"
    || !EVENTS.has(value.event as BackgroundJobDetailEvent)) return undefined;

  const event = value.event as BackgroundJobDetailEvent;
  if (event === "error") {
    if (!hasOnlyKeys(value, ["kind", "version", "event", "operation", "reason"])
      || typeof value.operation !== "string"
      || !OPERATIONS.has(value.operation)
      || !isSafeDisplayText(value.reason)) return undefined;
    return {
      kind: BACKGROUND_JOB_DETAILS_KIND,
      version: BACKGROUND_JOB_DETAILS_VERSION,
      event,
      operation: value.operation as "start" | "status" | "cancel",
      reason: value.reason,
    };
  }

  if (event === "status-list" || event === "cancel-list") {
    const allowed = ["kind", "version", "event", "jobs", ...(value.omittedJobCount === undefined ? [] : ["omittedJobCount"])];
    if (!hasOnlyKeys(value, allowed)
      || !Array.isArray(value.jobs)
      || value.jobs.length > MAX_JOBS
      || (value.omittedJobCount !== undefined && (!isSafeOmittedBytes(value.omittedJobCount) || value.omittedJobCount === 0))) return undefined;
    const jobs = value.jobs.map(parseSummary);
    return jobs.every((job): job is BackgroundJobDetailSummary => job !== undefined)
      ? {
        kind: BACKGROUND_JOB_DETAILS_KIND, version: BACKGROUND_JOB_DETAILS_VERSION, event, jobs,
        ...(value.omittedJobCount === undefined ? {} : { omittedJobCount: value.omittedJobCount }),
      }
      : undefined;
  }

  const accepted = event === "accepted";
  if (!hasOnlyKeys(value, accepted
    ? ["kind", "version", "event", "job", "jobId", "status"]
    : ["kind", "version", "event", "job"])) return undefined;
  const job = parseSummary(value.job);
  if (!job) return undefined;
  if (accepted && (job.status !== "running" || value.jobId !== job.jobId || value.status !== job.status)) return undefined;
  if (event === "cancellation-requested" && job.status !== "cancelling") return undefined;
  if (event === "already-terminal" && (job.status === "running" || job.status === "cancelling")) return undefined;
  return {
    kind: BACKGROUND_JOB_DETAILS_KIND,
    version: BACKGROUND_JOB_DETAILS_VERSION,
    event,
    job,
    ...(accepted ? { jobId: job.jobId, status: job.status } : {}),
  };
}
