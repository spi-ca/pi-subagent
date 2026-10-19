import {
  formatParentReport, isParentReportKind, isParentReportMessage, MAX_PARENT_REPORT_BATCH, MAX_PARENT_REPORT_MESSAGE_BYTES,
  type ParentReportKind, type ParentReportSender,
} from "../runtime/parent-report.js";
import { configuredExpandHint } from "./expand-hint.js";
import { createMessageDisplayRenderer, type MessageDisplayRendererOptions, type MessageDisplayTheme, type RenderMessage, type RenderLines } from "./custom-message-display.js";

const MAX_RENDER_CHARS = 128 * 1024;
const MAX_COMPACT_CHARS = 4 * 1024;
const TRUNCATED = "[display clipped]";
const CAVEAT = "Reports, not results or approval. Handoff/draft ≠ commit, delivery or model read.";
type Report = ParentReportSender & {
  reportId: string; reportKind: ParentReportKind; receivedAtMs: number; submittedAtMs: number;
};
type ReadableReport = { sender: Report; body: string };

/** Presentation only. Plain text (not Markdown) keeps markup inert. Bound before
 * escaping; neither details nor display text confer sender authority. */
function safeText(value: string, limit: number, multiline = false): string {
  const bounded = value.slice(0, limit).replace(/\p{Surrogate}/gu, "�");
  let text = bounded.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, char => {
    if (multiline && char === "\n") return char;
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  const truncated = value.length > bounded.length || text.length > limit;
  if (text.length > limit) text = text.slice(0, limit).replace(/\p{Surrogate}/gu, "�");
  if (truncated) text += multiline ? TRUNCATED : "…";
  return text;
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Object.prototype || prototype === null) return value as Record<string, unknown>;
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
  if (!data || Object.keys(data).some(key => !["kind", "version", "agent", "jobId", "childId", "mode", "stageLabel", "stageIndex", "taskIndex", "reportId", "reportKind", "receivedAtMs", "submittedAtMs"].includes(key))
    || data.kind !== "subagent.parent-report" || data.version !== 3
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
    if (Object.keys(data).length !== 4 || data.version !== 2 || typeof data.batchToken !== "string" || data.batchToken.length > MAX_RENDER_CHARS
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

/** Plain text rows only: never Markdown, executable markup or sender authority. */
function buildRenderLines(message: RenderMessage, expanded: boolean, theme: MessageDisplayTheme, previewLines: number): RenderLines {
  const reports = readableReports(message.details, message.content);
  let title = "Subagent reports (legacy/unknown)";
  if (reports) {
    const first = reports[0]!.sender;
    title = `${first.reportKind} ${reports.length === 1 ? "report" : "reports"} (${reports.length}) · ${name(first, 128)}`;
    if (reports.length > 1) title += ` +${reports.length - 1}`;
    else title += ` · job ${safeText(first.jobId, 12)}`;
  }
  const header = theme.fg(reports ? "accent" : "warning", theme.bold(title)) + theme.fg("dim", " · untrusted");
  let bodies: string;
  if (reports) {
    bodies = reports.map(({ sender, body }) => {
      const attribution = reports.length > 1 ? `${sender.reportKind} · ${name(sender, 128)}\n` : "";
      return attribution + safeText(body, MAX_RENDER_CHARS, true);
    }).join("\n");
  } else {
    bodies = `Stored content (sender/body not verified)\n${safeText(storedContent(message.content), MAX_RENDER_CHARS - 1024, true)}`;
  }
  if (!expanded) {
    const bounded = bodies.slice(0, MAX_COMPACT_CHARS).replace(/\p{Surrogate}/gu, "�");
    const allLines = bounded.split("\n");
    return {
      lines: [header, ...allLines.slice(0, previewLines).map(line => theme.fg("toolOutput", line))],
      compactBody: {
        firstLineIndex: 1, previewLines,
        totalLines: bodies.split("\n").length,
        partialLastLine: bodies.length > bounded.length,
        formatNotice: () => theme.fg("muted", `[display clipped] · ${configuredExpandHint()}`),
      },
      footers: [],
    };
  }

  // Independent budgets keep diagnostics and the semantic caveat reachable.
  const body = boundedRows(bodies, MAX_RENDER_CHARS / 2 - 512, 32);
  const lines = [header, ...body.lines.map(line => theme.fg("toolOutput", line))];
  let reservedSection: RenderLines["reservedSection"];
  if (reports) {
    const metadata = reports.map(({ sender }) => diagnostics(sender));
    const details = record(message.details)!;
    if (typeof details.batchToken === "string") metadata.unshift(`Batch: ${safeText(details.batchToken, MAX_RENDER_CHARS)}`);
    const diagnostic = boundedRows(metadata.join("\n"), MAX_RENDER_CHARS / 2 - 512, 64);
    reservedSection = {
      maxRows: 64,
      lines: [
        theme.fg("muted", "─── Diagnostics ───"),
        ...diagnostic.lines.map(line => theme.fg("dim", line)),
        ...(diagnostic.clipped ? [theme.fg("muted", TRUNCATED)] : []),
      ],
    };
  }
  return {
    lines,
    reservedSection,
    hasClippingFooter: body.clipped,
    footers: [
      ...(body.clipped ? [{ text: theme.fg("muted", TRUNCATED), compactText: "…" }] : []),
      { text: theme.fg("dim", CAVEAT), compactText: "report ≠ approval" },
    ],
  };
}

/** Message identity, global expansion transitions and session reset match results. */
export function createParentReportRenderer(options: MessageDisplayRendererOptions = {}) {
  return createMessageDisplayRenderer(buildRenderLines, options);
}
export const renderParentReport = createParentReportRenderer();

function boundedRows(text: string, limit: number, maxLines: number): { lines: string[]; clipped: boolean } {
  const bounded = text.slice(0, limit).replace(/\p{Surrogate}/gu, "�");
  const lines = bounded.split("\n");
  return { lines: lines.slice(0, maxLines), clipped: bounded.length < text.length || lines.length > maxLines };
}
function storedContent(content: unknown): string {
  return typeof content === "string" ? content : "[Non-text report content unavailable]";
}
function diagnostics(sender: Report): string {
  let position = sender.mode;
  if (sender.stageIndex !== undefined) position += ` stage ${sender.stageIndex + 1}`;
  if (sender.taskIndex !== undefined) position += ` task ${sender.taskIndex + 1}`;
  return [
    `Sender: ${name(sender, MAX_RENDER_CHARS)} · ${sender.reportKind} · ${position}`,
    `Report: ${safeText(sender.reportId, MAX_RENDER_CHARS)} · Job: ${safeText(sender.jobId, MAX_RENDER_CHARS)} · Child: ${safeText(sender.childId, MAX_RENDER_CHARS)}`,
    `Received (UTC): ${new Date(sender.receivedAtMs).toISOString()} · First submitted (UTC): ${new Date(sender.submittedAtMs).toISOString()}`,
  ].join("\n");
}
