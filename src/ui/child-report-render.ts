import { Container, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CompactText, HeaderExpander, expansionState, oneLine, safeUiText, truncateUiRow } from "./native-ui.js";

const kinds = new Set(["progress", "finding", "question", "blocked"]);
const MAX_REPORT_SOURCE = 8192;
const REPORT_CAVEAT = "API admission/submission only; not proof of delivery, reading, reply or approval.";

/** Reserve the semantic caveat even when partial/rejected arguments wrap. */
class ExpandedReportText extends Text {
  constructor(private heading: string, private body: string, private caveat: string, private clipped: boolean) {
    super("", 0, 0);
  }
  override render(width: number): string[] {
    if (width < 1) return [];
    const header = new CompactText(this.heading).render(width);
    const footer = new Text(this.caveat, 0, 0).render(width);
    const rows = new Text(this.body, 0, 0).render(width);
    const available = Math.max(0, 96 - header.length - footer.length);
    const clipped = this.clipped || rows.length > available;
    const body = clipped ? rows.slice(0, Math.max(0, available - 1)) : rows;
    return [...header, ...body, ...(clipped ? ["[display clipped]"] : []), ...footer]
      .map(row => truncateUiRow(row, width));
  }
}
type Context = { state?: Record<string, unknown>; expanded?: boolean; invalidate?: () => void; isPartial?: boolean };
function kind(value: unknown): string { return value === undefined ? "progress" : typeof value === "string" && kinds.has(value) ? value : "unknown kind"; }
function expandable(context: Context | undefined, global: boolean, build: (open: boolean) => Text): Container | Text {
  if (!context?.state) return build(global);
  const container = new Container();
  container.addChild(new HeaderExpander(expansionState(context.state, global), build, context.invalidate));
  return container;
}
export function renderParentReportCall(args: { message?: unknown; kind?: unknown }, theme: Theme, context?: Context): Container | Text {
  return expandable(context, context?.expanded === true, open => {
    const heading = theme.fg("toolTitle", theme.bold(`Report to parent · ${kind(args.kind)} · request`));
    const body = typeof args.message === "string" ? args.message : "(message incomplete)";
    // Args reach the renderer before the 4096-byte admission validator. Bound
    // the source before terminal sanitization, including malformed partials.
    return open ? new ExpandedReportText(heading, safeUiText(body.slice(0, MAX_REPORT_SOURCE)), "Report only; not proof of delivery, reading, reply or approval.", body.length > MAX_REPORT_SOURCE)
      : new CompactText(`${heading}\n${theme.fg("toolOutput", oneLine(body))}`);
  });
}
export function renderParentReportResult(result: { content: Array<{ type: string; text?: string }>; details?: unknown }, options: { expanded: boolean; isPartial?: boolean }, theme: Theme, context?: Context): Container | Text {
  const details = result.details as { outcome?: unknown; kind?: unknown } | undefined;
  const submitted = details !== null && typeof details === "object" && Object.keys(details).length === 2
    && Object.hasOwn(details, "outcome") && Object.hasOwn(details, "kind")
    && details.outcome === "submitted" && typeof details.kind === "string" && kinds.has(details.kind);
  return expandable(context, options.expanded, open => {
    const status = options.isPartial || context?.isPartial ? "submission pending" : submitted ? "submitted" : "submission not confirmed";
    const heading = theme.fg(submitted ? "accent" : "warning", theme.bold(`Report to parent · ${submitted ? kind(details.kind) + " · " : ""}${status}`));
    const blocks = result.content.slice(0, 4).filter(item => item.type === "text" && typeof item.text === "string");
    const raw = blocks.map(item => item.text!.slice(0, MAX_REPORT_SOURCE)).join("\n").slice(0, MAX_REPORT_SOURCE);
    const sourceLength = blocks.reduce((size, item) => size + item.text!.length, Math.max(0, blocks.length - 1));
    const clipped = result.content.length > 4 || sourceLength > MAX_REPORT_SOURCE;
    return open ? new ExpandedReportText(heading, safeUiText(raw), REPORT_CAVEAT, clipped)
      : new CompactText(`${heading}\n${theme.fg("muted", submitted ? REPORT_CAVEAT : oneLine(raw) || REPORT_CAVEAT)}`);
  });
}
