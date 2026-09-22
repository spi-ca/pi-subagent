import { Box, Text } from "@earendil-works/pi-tui";
import { configuredExpandHint } from "./expand-hint.js";
import type { InlineCardPresentation, InlineCardState } from "./inline-presentation.js";

type CardTheme = {
  fg: (color: "success" | "error" | "warning" | "accent" | "muted" | "dim" | "toolOutput", text: string) => string;
  bold: (text: string) => string;
  bg?: (color: "customMessageBg", text: string) => string;
};

type MouseEventLike = {
  type?: unknown;
  button?: unknown;
  x?: unknown;
  y?: unknown;
  screenX?: unknown;
  screenY?: unknown;
  width?: unknown;
  height?: unknown;
};

type TargetBearingMouseResult = {
  handled: true;
  target: {
    component: InlineResultCard;
    originX: number;
    originY: number;
    width: number;
    height: number;
  };
};

function finiteCoordinate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function preview(text: string): string {
  const lines = text.split("\n").slice(0, 2).join("\n");
  return lines.length > 512 ? `${lines.slice(0, 511)}…` : lines;
}

function statusText(status: InlineCardPresentation["activities"][number]["status"]): string {
  return status === "completed" ? "done" : status === "failed" ? "failed" : "running";
}

/** A card-local expander using Pi's existing fullscreen mouse dispatch. */
export class InlineResultCard extends Box {
  constructor(
    private presentation: InlineCardPresentation,
    private state: InlineCardState,
    private theme: CardTheme,
  ) {
    super(0, 0, (text) => this.theme.bg?.("customMessageBg", text) ?? text);
    this.rebuild();
  }

  update(presentation: InlineCardPresentation, theme: CardTheme): void {
    this.presentation = presentation;
    this.theme = theme;
    this.rebuild();
  }

  // Pi 0.87 carries this return target through nested component dispatch. Only
  // the first (header) row consumes a primary click; body selection, drags,
  // wheel scrolling, and non-primary buttons deliberately remain unhandled.
  handleMouse(event: MouseEventLike): TargetBearingMouseResult | undefined {
    if (event.type !== "click" || event.button !== "left" || finiteCoordinate(event.y) !== 0) return undefined;
    this.state.expanded = !this.state.expanded;
    this.rebuild();
    const x = finiteCoordinate(event.x);
    const y = finiteCoordinate(event.y);
    return {
      handled: true,
      target: {
        component: this,
        originX: finiteCoordinate(event.screenX) - x,
        originY: finiteCoordinate(event.screenY) - y,
        width: finiteCoordinate(event.width),
        height: finiteCoordinate(event.height),
      },
    };
  }

  override invalidate(): void {
    super.invalidate();
    this.rebuild();
  }

  private rebuild(): void {
    this.clear();
    const duplicate = this.presentation.ordinal > 1 ? ` #${this.presentation.ordinal}` : "";
    const label = this.presentation.stageLabel
      ? `${this.presentation.stageLabel} (${this.presentation.agent}${duplicate})`
      : `${this.presentation.agent}${duplicate}`;
    const statusColor = this.presentation.status === "completed" ? "success"
      : this.presentation.status === "failed" ? "error"
        : this.presentation.status === "cancelled" ? "warning" : "accent";
    let text = this.theme.fg(statusColor, this.theme.bold(`${label} · ${this.presentation.status}`));
    const activity = this.state.expanded ? this.presentation.activities : this.presentation.activities.slice(-4);
    if (this.presentation.lastAssistantText) {
      text += `\n${this.theme.fg("muted", "Completed response:")}`;
      text += `\n${this.theme.fg("toolOutput", this.state.expanded ? this.presentation.lastAssistantText : preview(this.presentation.lastAssistantText))}`;
    } else {
      text += `\n${this.theme.fg("dim", "(no completed assistant response)")}`;
    }
    if (this.presentation.error) text += `\n${this.theme.fg(statusColor === "success" ? "error" : statusColor, this.presentation.error)}`;
    if (activity.length > 0) {
      text += `\n${this.theme.fg("muted", "Recent tool activity:")}`;
      for (const item of activity) {
        const color = item.status === "completed" ? "success" : item.status === "failed" ? "error" : "warning";
        text += `\n${this.theme.fg(color, `${item.name} · ${statusText(item.status)}`)}`;
      }
      if (!this.state.expanded && this.presentation.activities.length > activity.length) {
        text += `\n${this.theme.fg("dim", `… ${this.presentation.activities.length - activity.length} earlier tools`)}`;
      }
    }
    text += `\n${this.theme.fg("dim", `(${configuredExpandHint()})`)}`;
    this.addChild(new Text(text, 0, 0));
  }
}
