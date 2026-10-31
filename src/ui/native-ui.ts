import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** Display policy only: never lifecycle, delivery or approval evidence. */
export { COMPACT_ITEM_LIMIT, COMPACT_ROW_LIMIT, STATE_STYLE, stateText, durationText, type UiState } from "../core/ui-presentation.js";
export function safeUiText(text: string): string {
  return text.replace(/\p{Surrogate}/gu, "�").replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
/**
 * Pi owns width/graphemes and OSC8 closure, but its truncator resets all SGR
 * before/after the suffix. Our rows own foreground/decorations, not the host
 * shell background: keep the suffix in the retained text's style, then close
 * those local styles specifically. Never remove resets from the source text.
 */
export function truncateUiRow(text: string, columns: number): string {
  const truncated = truncateToWidth(text, columns, "…");
  const suffix = "\x1b[0m…\x1b[0m";
  if (!truncated.endsWith(suffix) || truncated === text) return truncated;
  const prefix = truncated.slice(0, -suffix.length);
  // A sanitized source stays plain, including after source-preview clipping.
  if (!text.includes("\x1b")) return `${prefix}…`;
  // With no retained grapheme (one column, or an overwide first grapheme),
  // Pi omits pending ANSI too. Inherit the first cell's SGR, but not its link.
  const leading = prefix ? "" : (text.match(/^(?:\x1b\[[\d;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\))*/)?.[0]
    .match(/\x1b\[[\d;]*m/g)?.join("") ?? "");
  return `${prefix}${leading}…\x1b[22;23;24;25;27;28;29;39m`;
}

export function oneLine(text: string, columns = 100): string {
  return truncateUiRow(safeUiText(text.slice(0, 8192)).replace(/\s+/g, " ").trim(), columns);
}

/** A compact logical row is also one visual row, including at narrow widths. */
export class CompactText extends Text {
  constructor(private rows: string) { super(rows, 0, 0); }
  override setText(text: string): void { this.rows = text; super.setText(text); }
  override render(width: number): string[] {
    if (width < 1) return [];
    return this.rows.split("\n").map(row => truncateUiRow(row, width));
  }
}

/** Restored/unknown data has a visual cap as well as a source-byte cap. */
export class LimitedText extends Text {
  constructor(text: string, private maxRows = 96) { super(text, 0, 0); }
  override render(width: number): string[] {
    if (width < 1) return [];
    const rows = super.render(width);
    return rows.length <= this.maxRows ? rows : [...rows.slice(0, this.maxRows - 1), truncateUiRow("[display clipped]", width)];
  }
}

export interface ExpansionState { expanded: boolean; lastGlobalExpanded: boolean; }
export function expansionState(store: Record<string, unknown> | undefined, global: boolean): ExpansionState {
  const candidate = store?.subagentUiExpansion;
  const previous = candidate && typeof candidate === "object"
    && typeof (candidate as ExpansionState).expanded === "boolean"
    && typeof (candidate as ExpansionState).lastGlobalExpanded === "boolean" ? candidate as ExpansionState : undefined;
  const state = previous ?? { expanded: global, lastGlobalExpanded: global };
  if (state.lastGlobalExpanded !== global) { state.expanded = global; state.lastGlobalExpanded = global; }
  if (store) store.subagentUiExpansion = state;
  return state;
}

/** No shell/padding/background; only the header owns local click expansion. */
export class HeaderExpander implements Component {
  constructor(private state: ExpansionState, private build: (expanded: boolean) => Component, private redraw?: () => void) {}
  render(width: number): string[] { return this.build(this.state.expanded).render(width); }
  invalidate(): void { /* build uses the current host theme on each render */ }
  handleMouse(event: { type?: unknown; button?: unknown; y?: unknown }): { handled: true } | undefined {
    if (event.type !== "click" || event.button !== "left" || event.y !== 0) return undefined;
    this.state.expanded = !this.state.expanded;
    try { this.redraw?.(); } catch { /* disposed host; display-only */ }
    return { handled: true };
  }
}
