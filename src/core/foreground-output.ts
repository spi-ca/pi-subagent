import { getResultSummaryText } from "./runner-events.js";
import { isResultError, type SingleResult } from "./types.js";

/** Fixed internal caps; they are intentionally not configurable product settings. */
export const MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES = 50 * 1024;
export const MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES = 2_000;

export type ForegroundOutputDestination = "tool-result" | "chain-handoff" | "thrown-error";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function lineCount(value: string): number {
  return value === "" ? 0 : value.split("\n").length;
}

function resultStatus(result: SingleResult): "completed" | "failed" {
  return isResultError(result) ? "failed" : "completed";
}

function retainedLocation(destination: ForegroundOutputDestination): string {
  return destination === "tool-result"
    ? "full structured result remains in tool details"
    : destination === "chain-handoff"
      ? "content is unavailable to this chain handoff"
      : "content is unavailable from this thrown error";
}

function aggregateOmission(remaining: number, kind: string, destination: ForegroundOutputDestination, bytes: number, lines: number): string | null {
  const detailed = `[${remaining} ${kind}${remaining === 1 ? "" : "s"} omitted: the fixed model-visible output budget was exhausted; ${retainedLocation(destination)}.]`;
  if (byteLength(detailed) <= bytes && lineCount(detailed) <= lines) return detailed;
  const compact = `[${remaining} ${kind}${remaining === 1 ? "" : "s"} omitted.]`;
  if (byteLength(compact) <= bytes && lineCount(compact) <= lines) return compact;
  // A zero-sized caller-supplied budget cannot contain an honest notice. Do
  // not slice a record or silently claim it was included in that case.
  return null;
}

/**
 * Frames complete records for model context. A record is either included whole
 * or replaced by an explicit omission notice; bodies and identifiers are never
 * silently truncated. TUI details retain unmodified structured results, but
 * handoffs and thrown errors do not claim access to those private details.
 */
export function formatBoundedForegroundRecords(
  records: ReadonlyArray<{ identifier: string; body: string }>,
  budget = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES,
  kind = "result record",
  destination: ForegroundOutputDestination = "tool-result",
  maxLines = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES,
): string {
  let remainingBytes = Math.max(0, budget);
  let remainingLines = Math.max(0, maxLines);
  const output: string[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const separatorBytes = output.length > 0 ? byteLength("\n\n") : 0;
    const separatorLines = output.length > 0 ? 1 : 0;
    const full = `### [${record.identifier}]\n${record.body}`;
    const recordsAfter = records.length - index - 1;
    // Reserve a single terminal aggregate notice before retaining this record.
    // This prevents a near-full budget from silently dropping the tail.
    const reserve = recordsAfter === 0
      ? ""
      : aggregateOmission(recordsAfter, kind, destination, remainingBytes, remainingLines);
    const reserveSeparatorBytes = reserve ? byteLength("\n\n") + byteLength(reserve) : 0;
    const reserveSeparatorLines = reserve ? 1 + lineCount(reserve) : 0;
    const fullBytes = separatorBytes + byteLength(full);
    const fullLines = separatorLines + lineCount(full);
    if (fullBytes + reserveSeparatorBytes <= remainingBytes && fullLines + reserveSeparatorLines <= remainingLines) {
      output.push(full);
      remainingBytes -= fullBytes;
      remainingLines -= fullLines;
      continue;
    }

    const terminalSeparatorBytes = output.length > 0 ? byteLength("\n\n") : 0;
    const terminalSeparatorLines = output.length > 0 ? 1 : 0;
    const terminal = aggregateOmission(records.length - index, kind, destination, remainingBytes - terminalSeparatorBytes, remainingLines - terminalSeparatorLines);
    if (terminal) output.push(terminal);
    break;
  }

  return output.join("\n\n");
}

/** Keep one complete summary or replace it entirely; never UTF-8-slice output. */
/** Bound every error leaving tool.execute, including validation and unexpected failures. */
export function formatBoundedForegroundThrownError(
  value: unknown,
  budget = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES,
  maxLines = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES,
): string {
  let message: string;
  try { message = value instanceof Error ? value.message : String(value); }
  catch { message = "Subagent operation failed."; }
  if (byteLength(message) <= budget && lineCount(message) <= maxLines) return message;
  return `[Subagent error omitted: fixed ${budget}-byte/${maxLines}-line model-visible output budget exhausted; content is unavailable from this thrown error.]`;
}

export function formatBoundedForegroundResultSummary(
  result: SingleResult,
  budget = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES,
  destination: ForegroundOutputDestination = "tool-result",
  maxLines = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES,
): string {
  const summary = getResultSummaryText(result);
  if (byteLength(summary) <= budget && lineCount(summary) <= maxLines) return summary;
  return `[Agent output omitted: ${byteLength(summary)} UTF-8 bytes or ${lineCount(summary)} lines exceeds the fixed ${budget}-byte/${maxLines}-line model-visible output budget; ${retainedLocation(destination)}.]`;
}

/**
 * Bounds a final tool-facing envelope after its fixed header/error text has
 * been added. It never slices the preformatted body: if it cannot fit as a
 * whole, every body record is omitted together.
 */
export function formatBoundedForegroundEnvelope(
  header: string,
  body: string,
  destination: ForegroundOutputDestination = "tool-result",
  budget = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES,
  maxLines = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES,
): string {
  const combined = body ? `${header}\n\n${body}` : header;
  if (byteLength(combined) <= budget && lineCount(combined) <= maxLines) return combined;
  const omission = `[Output records omitted: fixed ${budget}-byte/${maxLines}-line model-visible output budget exhausted; ${retainedLocation(destination)}.]`;
  const withOmission = `${header}\n\n${omission}`;
  if (byteLength(withOmission) <= budget && lineCount(withOmission) <= maxLines) return withOmission;
  // Headers derive from configured labels/errors. Do not split an unbounded
  // identifier into model context if even the envelope itself is oversized.
  return `[Subagent output omitted: fixed ${budget}-byte/${maxLines}-line model-visible output budget exhausted.]`;
}

/**
 * Formats records only after reserving the concrete final envelope header and
 * separator. This keeps the record-level aggregate omission (and its count)
 * in the final model-visible content instead of replacing it with the generic
 * envelope fallback at an exact byte or line boundary.
 */
export function formatBoundedForegroundRecordEnvelope(
  header: string,
  records: ReadonlyArray<{ identifier: string; body: string }>,
  kind: string,
  destination: ForegroundOutputDestination = "tool-result",
  budget = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES,
  maxLines = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES,
): string {
  const headerBytes = byteLength(header);
  const headerLines = lineCount(header);
  const hasBodyAllowance = headerBytes < budget && headerLines < maxLines;
  const body = hasBodyAllowance
    ? formatBoundedForegroundRecords(
      records,
      budget - headerBytes - byteLength("\n\n"),
      kind,
      destination,
      maxLines - headerLines - 1,
    )
    : "";
  return formatBoundedForegroundEnvelope(header, body, destination, budget, maxLines);
}

function foregroundResultRecords(results: ReadonlyArray<SingleResult>): Array<{ identifier: string; body: string }> {
  return results.map((result) => ({
    identifier: result.agent,
    body: `${resultStatus(result)}: ${getResultSummaryText(result)}`,
  }));
}

export function formatBoundedForegroundResultRecords(
  results: ReadonlyArray<SingleResult>,
  budget = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES,
  destination: ForegroundOutputDestination = "tool-result",
  maxLines = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES,
): string {
  return formatBoundedForegroundRecords(
    foregroundResultRecords(results),
    budget,
    "subagent result record",
    destination,
    maxLines,
  );
}

export function formatBoundedForegroundResultRecordEnvelope(
  header: string,
  results: ReadonlyArray<SingleResult>,
  destination: ForegroundOutputDestination = "tool-result",
  budget = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES,
  maxLines = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES,
): string {
  return formatBoundedForegroundRecordEnvelope(
    header,
    foregroundResultRecords(results),
    "subagent result record",
    destination,
    budget,
    maxLines,
  );
}
