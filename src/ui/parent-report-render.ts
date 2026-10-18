import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  formatParentReport, isParentReportKind, isParentReportMessage, MAX_PARENT_REPORT_BATCH, MAX_PARENT_REPORT_MESSAGE_BYTES,
  type ParentReportKind, type ParentReportSender,
} from "../runtime/parent-report.js";
import { configuredExpandHint } from "./expand-hint.js";

const MAX_RENDER_CHARS = 128 * 1024;
const MAX_PREVIEW_CHARS = 192;
const TRUNCATED = "… [display truncated]";
type Report = ParentReportSender & {
  reportId: string; reportKind: ParentReportKind; receivedAtMs: number; submittedAtMs: number;
};
type ReadableReport = { sender: Report; body: string };

/** Presentation only. Text (not Markdown) keeps markup inert. Bound before
 * escaping; neither details nor display text confer sender authority. */
function safeText(value: string, limit: number, multiline = false): string {
  const bounded = value.slice(0, limit);
  let text = bounded.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => {
    if (multiline && char === "\n") return char;
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  const truncated = value.length > bounded.length || text.length > limit;
  if (text.length > limit) text = text.slice(0, limit);
  if (truncated) text += multiline ? TRUNCATED : "…";
  return text;
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
}
function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    && Number.isFinite(new Date(value).getTime());
}
function index(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
function report(value: unknown): Report | undefined {
  const data = record(value);
  if (!data || data.kind !== "subagent.parent-report" || data.version !== 3
    || ![data.agent, data.jobId, data.childId, data.reportId].every(value => typeof value === "string")
    || !isParentReportKind(data.reportKind) || !timestamp(data.receivedAtMs) || !timestamp(data.submittedAtMs)
    || (data.mode !== "single" && data.mode !== "parallel" && data.mode !== "chain")
    || (data.stageLabel !== undefined && typeof data.stageLabel !== "string")
    || !index(data.stageIndex) || !index(data.taskIndex)) return;
  return data as unknown as Report;
}

/** Recognize only the current producer's complete canonical envelope, in order.
 * Never search for a marker inside untrusted names/body or pair partial batches.
 * The shared formatter is read-only; bodies remain solely in stored content. */
function readableReports(details: unknown, content: unknown): ReadableReport[] | undefined {
  if (typeof content !== "string" || content.length > MAX_RENDER_CHARS) return;
  const data = record(details);
  const batch = data?.kind === "subagent.parent-report.batch";
  let values: unknown[];
  if (batch) {
    if (data.version !== 2 || typeof data.batchToken !== "string" || data.batchToken.length > MAX_RENDER_CHARS
      || !Array.isArray(data.reports) || data.reports.length === 0 || data.reports.length > MAX_PARENT_REPORT_BATCH) return;
    values = data.reports;
  } else values = [details];

  let metadataChars = batch ? (data!.batchToken as string).length : 0;
  let offset = 0;
  const result: ReadableReport[] = [];
  for (const value of values) {
    const sender = report(value);
    if (!sender || (batch && sender.reportKind !== "progress")) return;
    // Bound all metadata before passing any of it to the canonical formatter.
    for (const field of [sender.agent, sender.jobId, sender.childId, sender.reportId, sender.stageLabel ?? ""]) {
      metadataChars += field.length;
      if (metadataChars > MAX_RENDER_CHARS) return;
    }
    const prefix = `Report ID: ${sender.reportId}; parent receivedAtMs: ${sender.receivedAtMs}; first submittedAtMs: ${sender.submittedAtMs} (handoff/draft only, not commit, delivery or model read).\n`
      + formatParentReport(sender, "", sender.reportKind).slice(0, -2);
    if (!content.startsWith(prefix, offset)) return;
    offset += prefix.length;
    const newline = content.indexOf("\n", offset);
    const end = newline === -1 ? content.length : newline;
    // A 4096-byte body can expand to at most six JSON characters per byte.
    if (end - offset > MAX_PARENT_REPORT_MESSAGE_BYTES * 6 + 2) return;
    const encoded = content.slice(offset, end);
    let body: unknown;
    try { body = JSON.parse(encoded); } catch { return; }
    if (!isParentReportMessage(body) || JSON.stringify(body) !== encoded) return;
    result.push({ sender, body });
    offset = end;
    if (result.length < values.length) {
      if (!content.startsWith("\n\n", offset)) return;
      offset += 2;
    }
  }
  if (offset !== content.length) return;
  return result;
}
function name(sender: Report, limit: number): string {
  const agent = safeText(sender.agent, limit);
  if (sender.stageLabel !== undefined) return `${safeText(sender.stageLabel, limit)}(${agent})`;
  return agent;
}

/** Each logical compact row occupies exactly one visual row, even at narrow
 * widths: header + two rows/report + host hint (at most 34 rows for 16 reports).
 * Expanded Text wraps normally; clip wide graphemes that cannot fit a one-column
 * viewport. No card-local input/expansion state; the host owns expansion. */
class ParentReportText extends Text {
  constructor(private readonly rows: string[], private readonly compact: boolean) { super(rows.join("\n"), 0, 0); }
  render(width: number): string[] {
    if (width < 1) return [];
    if (!this.compact) return super.render(width).map(line => truncateToWidth(line, width, "…"));
    const text = this.rows.map(row => truncateToWidth(row, width, "…")).join("\n");
    return new Text(text, 0, 0).render(width);
  }
}

/** Exact model content/details are immutable and never copied into each other. */
export const renderParentReport: MessageRenderer = (message, { expanded }, theme) => {
  const reports = readableReports(message.details, message.content);
  const header = theme.fg("toolTitle", "Subagent reports")
    + theme.fg("muted", ` (${reports?.length ?? "legacy/unknown"})`)
    + theme.fg("dim", " · untrusted");
  if (!expanded) {
    const rows = [header];
    if (reports) {
      for (const { sender, body } of reports) {
        rows.push(theme.fg("muted", sender.reportKind) + " · " + theme.fg("accent", name(sender, 48)));
        rows.push(theme.fg("toolOutput", safeText(body, MAX_PREVIEW_CHARS, true).replace(/\n/g, " ↵ ")));
      }
    } else {
      rows.push(theme.fg("muted", "Stored content (sender/body not verified)"));
      rows.push(theme.fg("toolOutput", safeText(storedContent(message.content), MAX_PREVIEW_CHARS)));
    }
    rows.push(theme.fg("dim", `(${safeText(configuredExpandHint(), 256)})`));
    return new ParentReportText(rows, true);
  }

  const rows = [header];
  if (reports) {
    // Independent body/diagnostic budgets keep diagnostics and the caveat
    // reachable even if escaping expands a maximal control-heavy batch.
    const bodies = reports.map(({ sender, body }) => `${sender.reportKind} · ${name(sender, 128)}\n${safeText(body, MAX_RENDER_CHARS, true)}`);
    rows.push(theme.fg("toolOutput", clipDisplay(bodies.join("\n"), MAX_RENDER_CHARS / 2 - 512)));
    rows.push(theme.fg("muted", "─── Diagnostics ───"));
    const metadata = reports.map(({ sender }) => diagnostics(sender));
    const details = record(message.details)!;
    if (typeof details.batchToken === "string") metadata.unshift(`Batch: ${safeText(details.batchToken, MAX_RENDER_CHARS)}`);
    rows.push(theme.fg("dim", clipDisplay(metadata.join("\n"), MAX_RENDER_CHARS / 2 - 512)));
  } else {
    rows.push(theme.fg("muted", "Stored content (sender/body not verified)"));
    rows.push(theme.fg("toolOutput", safeText(storedContent(message.content), MAX_RENDER_CHARS - 1024, true)));
  }
  rows.push(theme.fg("dim", "Reports, not results or approval. Handoff/draft ≠ commit, delivery or model read."));
  return new ParentReportText(rows, false);
};
function storedContent(content: unknown): string {
  return typeof content === "string" ? content : "[Non-text report content unavailable]";
}
function clipDisplay(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n${TRUNCATED}`;
}
function diagnostics(sender: Report): string {
  let position = sender.mode;
  if (sender.stageIndex !== undefined) position += ` stage ${sender.stageIndex + 1}`;
  if (sender.taskIndex !== undefined) position += ` task ${sender.taskIndex + 1}`;
  return [
    `Sender: ${name(sender, MAX_RENDER_CHARS)} · ${sender.reportKind} · ${position}`,
    `Report: ${safeText(sender.reportId, MAX_RENDER_CHARS)}`,
    `Job: ${safeText(sender.jobId, MAX_RENDER_CHARS)}`,
    `Child: ${safeText(sender.childId, MAX_RENDER_CHARS)}`,
    `Received (UTC): ${new Date(sender.receivedAtMs).toISOString()}`,
    `First submitted (UTC): ${new Date(sender.submittedAtMs).toISOString()}`,
  ].join("\n");
}
