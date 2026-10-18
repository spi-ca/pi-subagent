import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isParentReportKind, MAX_PARENT_REPORT_BATCH } from "../runtime/parent-report.js";

const MAX_RENDER_CHARS = 128 * 1024;
/** Presentation only. Neither details nor display text confer sender authority.
 * Text (not Markdown) prevents links/markup from acquiring terminal behavior. */
function safeText(value: string, limit: number, multiline = false): string {
  const bounded = value.slice(0, limit);
  let text = bounded.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => {
    if (multiline && char === "\n") return char;
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  const truncated = value.length > bounded.length || text.length > limit;
  if (text.length > limit) text = text.slice(0, limit);
  if (truncated) text += multiline ? "… [display truncated]" : "…";
  return text;
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function shortTime(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return `${date.toISOString().slice(11, 23)}Z`;
}
function summary(value: unknown): string | undefined {
  const data = record(value);
  if (!data || data.kind !== "subagent.parent-report" || data.version !== 3
    || typeof data.agent !== "string" || typeof data.childId !== "string"
    || typeof data.reportId !== "string" || !isParentReportKind(data.reportKind)
    || !timestamp(data.receivedAtMs) || !timestamp(data.submittedAtMs)) return;
  let name = safeText(data.agent, 48);
  if (typeof data.stageLabel === "string") name = `${safeText(data.stageLabel, 48)}(${name})`;
  return `${name} / ${data.reportKind} #${safeText(data.reportId, 8)} child:${safeText(data.childId, 8)} received:${shortTime(data.receivedAtMs)} submitted:${shortTime(data.submittedAtMs)}`;
}

/** One renderer for single important reports and progress batches. The host owns
 * expansion; exact model content is untouched and never copied into details. */
export const renderParentReport: MessageRenderer = (message, { expanded }, theme) => {
  const details = record(message.details);
  let rows: string[] | undefined;
  if (details?.kind === "subagent.parent-report.batch" && details.version === 2
    && Array.isArray(details.reports) && details.reports.length > 0 && details.reports.length <= MAX_PARENT_REPORT_BATCH) {
    const summaries = details.reports.map(summary);
    if (summaries.every((row): row is string => row !== undefined)) rows = summaries;
  } else {
    const row = summary(details);
    if (row) rows = [row];
  }
  let text = theme.fg("accent", `Subagent reports (${rows?.length ?? "legacy/unknown"}; untrusted)`);
  if (rows) text += `\n${rows.join("\n")}`;
  else text += "\nSender metadata unavailable; expand for stored content.";
  if (expanded) {
    const content = typeof message.content === "string" ? message.content : "[Non-text report content unavailable]";
    text += `\nHandoff/draft times only — not commit, delivery or model read.\n${safeText(content, MAX_RENDER_CHARS, true)}`;
  }
  return new Text(text, 0, 0);
};
