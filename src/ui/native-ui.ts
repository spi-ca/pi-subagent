import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** Display policy only: never lifecycle, delivery or approval evidence. */
export { COMPACT_ITEM_LIMIT, COMPACT_ROW_LIMIT, STATE_STYLE, stateText, durationText, type UiState } from "../core/ui-presentation.js";
export function safeUiText(text: string): string {
  return text.replace(/\p{Surrogate}/gu, "�").replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
export function oneLine(text: string, columns = 100): string {
  return truncateToWidth(safeUiText(text.slice(0, 8192)).replace(/\s+/g, " ").trim(), columns, "…");
}

/** A compact logical row is also one visual row, including at narrow widths. */
export class CompactText extends Text {
  constructor(private rows: string) { super(rows, 0, 0); }
  override setText(text: string): void { this.rows = text; super.setText(text); }
  override render(width: number): string[] {
    if (width < 1) return [];
    return this.rows.split("\n").map(row => truncateToWidth(row, width, "…"));
  }
}

/** Restored/unknown data has a visual cap as well as a source-byte cap. */
export class LimitedText extends Text {
  constructor(text: string, private maxRows = 96) { super(text, 0, 0); }
  override render(width: number): string[] {
    if (width < 1) return [];
    const rows = super.render(width);
    return rows.length <= this.maxRows ? rows : [...rows.slice(0, this.maxRows - 1), truncateToWidth("[display clipped]", width, "…")];
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
