/** Presentation vocabulary only; never runtime or transport authority. */
export const COMPACT_ITEM_LIMIT = 4;
export const COMPACT_ROW_LIMIT = 16;
export type UiState = "running" | "queued" | "completed" | "failed" | "cancelling" | "cancelled" | "accepted" | "pending";
export const STATE_STYLE = {
  running: { icon: "●", color: "accent" }, queued: { icon: "◷", color: "muted" },
  completed: { icon: "✓", color: "success" }, failed: { icon: "✗", color: "error" },
  cancelling: { icon: "–", color: "warning" }, cancelled: { icon: "–", color: "warning" },
  accepted: { icon: "◷", color: "accent" }, pending: { icon: "◷", color: "muted" },
} as const;
export function stateText(state: UiState): string { return `${STATE_STYLE[state].icon} ${state}`; }
export function durationText(ms: number): string {
  ms = Math.max(0, ms);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}
