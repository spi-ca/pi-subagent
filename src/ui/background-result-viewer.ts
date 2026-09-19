import { parseBackgroundResultMessage, type ParsedBackgroundResult } from "./background-result.js";

const BACKGROUND_RESULT_CUSTOM_TYPE = "subagent_result";

export interface RetainedBackgroundResult {
  jobId: string;
  output: string;
  /** Exact producer-derived bytes that could not be retained. */
  omittedBytes: number;
}

export type BackgroundResultSelection =
  | { kind: "selected"; result: RetainedBackgroundResult }
  | { kind: "empty" }
  | { kind: "unknown"; requested: string }
  | { kind: "ambiguous"; requested?: string; candidates: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Removes terminal controls while retaining printable text and producer truncation notices. */
export function sanitizeBackgroundResultViewerText(text: string): string {
  return text
    .replace(/\p{Surrogate}/gu, "�")
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** Selects only strict, current-branch result envelopes and keeps the newest entry for a repeated job ID. */
export function selectRetainedBackgroundResult(entries: readonly unknown[], rawId: string): BackgroundResultSelection {
  const results = new Map<string, RetainedBackgroundResult>();
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== BACKGROUND_RESULT_CUSTOM_TYPE) continue;
    const parsed: ParsedBackgroundResult | undefined = parseBackgroundResultMessage({
      content: entry.content,
      details: entry.details,
    });
    if (parsed) results.set(parsed.metadata.jobId, {
      jobId: parsed.metadata.jobId,
      output: parsed.output,
      omittedBytes: "version" in parsed.metadata ? parsed.metadata.omittedBytes : 0,
    });
  }

  const requested = rawId.trim();
  const values = Array.from(results.values());
  if (requested.length === 0) {
    if (values.length === 0) return { kind: "empty" };
    if (values.length === 1) return { kind: "selected", result: values[0]! };
    return { kind: "ambiguous", candidates: values.map((result) => result.jobId) };
  }

  // A job ID/prefix is canonical UUID text; reject other input before it can
  // be reflected in a terminal notice or used as an unbounded search key.
  if (!/^[0-9a-f-]{1,36}$/.test(requested)) return { kind: "unknown", requested: "the supplied ID" };
  const matches = values.filter((result) => result.jobId.startsWith(requested));
  if (matches.length === 0) return { kind: "unknown", requested };
  if (matches.length > 1) return { kind: "ambiguous", requested, candidates: matches.map((result) => result.jobId) };
  return { kind: "selected", result: matches[0]! };
}

export function formatBackgroundResultSelectionNotice(selection: Exclude<BackgroundResultSelection, { kind: "selected" }>): string {
  if (selection.kind === "empty") return "No retained background subagent results are available on the current branch.";
  if (selection.kind === "unknown") return `No retained background subagent result matches ${selection.requested}. Use /subagent-result with a current-branch job ID or unique prefix.`;
  const candidates = selection.candidates.slice(0, 5).map((id) => id.slice(0, 12)).join(", ");
  const suffix = selection.candidates.length > 5 ? ", …" : "";
  return selection.requested
    ? `Result ID prefix ${selection.requested} is ambiguous. Use a longer prefix: ${candidates}${suffix}.`
    : `More than one retained result is available. Use /subagent-result <job-id-prefix>: ${candidates}${suffix}.`;
}

/** Opens a display-only editor. Its returned text is intentionally discarded, including cancel. */
export async function showRetainedBackgroundResult(
  result: RetainedBackgroundResult,
  ui: { editor: (title: string, prefill?: string) => Promise<string | undefined> },
): Promise<void> {
  const title = `Subagent result ${result.jobId} (retained display only; edits discarded)`;
  // Empty output with a producer omission count is a zero-retention record;
  // preserve that factual distinction from historical genuinely empty output.
  const prefill = result.output.length > 0
    ? sanitizeBackgroundResultViewerText(result.output)
    : result.omittedBytes > 0
      ? `No retained text to display. ${result.omittedBytes} source bytes were not retained.`
      : "No text to display.";
  await ui.editor(title, prefill);
}
