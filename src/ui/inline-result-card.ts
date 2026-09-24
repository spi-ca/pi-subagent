import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, truncateToWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { configuredExpandHint } from "./expand-hint.js";
import type { InlineCardPresentation, InlineCardState } from "./inline-presentation.js";

type CardTheme = {
  fg: (color: "success" | "error" | "warning" | "accent" | "toolTitle" | "muted" | "dim" | "toolOutput", text: string) => string;
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

export interface InlineResultCardOptions {
  /** Full terminal result supplied only by the foreground result renderer. */
  authoritativeAssistantText?: string;
  /** Widgets have no host app.tools.expand state to describe. */
  showExpandHint?: boolean;
  /** Widget headers must reserve one real rendered row per prioritized card. */
  compactHeader?: boolean;
}

function finiteCoordinate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\p{Surrogate}/gu, "�")
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b/g, "")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function preview(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

function statusText(status: InlineCardPresentation["activities"][number]["status"]): string {
  return status === "completed" ? "done" : status === "failed" ? "failed" : "running";
}

function safeMarkdownTheme(): MarkdownTheme {
  // The current host supplies every formatter. Fill old/minimal host themes
  // defensively so a display-only card never turns a completed result into a
  // renderer failure.
  const theme = getMarkdownTheme() as Partial<MarkdownTheme>;
  const formatter = (candidate: unknown) => (text: string) => {
    try { return typeof candidate === "function" ? candidate(text) : text; } catch { return text; }
  };
  return {
    heading: formatter(theme.heading),
    link: formatter(theme.link),
    linkUrl: formatter(theme.linkUrl),
    code: formatter(theme.code),
    codeBlock: formatter(theme.codeBlock),
    codeBlockBorder: formatter(theme.codeBlockBorder),
    quote: formatter(theme.quote),
    quoteBorder: formatter(theme.quoteBorder),
    hr: formatter(theme.hr),
    listBullet: formatter(theme.listBullet),
    bold: formatter(theme.bold),
    italic: formatter(theme.italic),
    strikethrough: formatter(theme.strikethrough),
    underline: formatter(theme.underline),
    ...(typeof theme.highlightCode === "function" ? {
      highlightCode: (code: string, language?: string) => {
        try { return theme.highlightCode!(code, language); } catch { return [code]; }
      },
    } : {}),
    ...(typeof theme.codeBlockIndent === "string" ? { codeBlockIndent: theme.codeBlockIndent } : {}),
  };
}

/** A card-local expander using Pi's existing fullscreen mouse dispatch. */
export class InlineResultCard extends Box {
  private renderedWidth: number | undefined;

  constructor(
    private presentation: InlineCardPresentation,
    private state: InlineCardState,
    private theme: CardTheme,
    private options: InlineResultCardOptions = {},
  ) {
    super(0, 0, (text) => this.theme.bg?.("customMessageBg", text) ?? text);
    this.rebuild();
  }

  /** Presentation accessor for layout wrappers; no result data is copied. */
  get cardPresentation(): InlineCardPresentation {
    return this.presentation;
  }

  update(presentation: InlineCardPresentation, theme: CardTheme, options: InlineResultCardOptions = this.options): void {
    this.presentation = presentation;
    this.theme = theme;
    this.options = options;
    this.rebuild();
  }

  override render(width: number): string[] {
    if (this.options.compactHeader && this.renderedWidth !== width) {
      this.renderedWidth = width;
      this.rebuild();
    }
    return super.render(width);
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
    this.renderedWidth = undefined;
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
    const arrow = this.state.expanded ? "▾" : "▸";
    let header = this.theme.fg("toolTitle", this.theme.bold(`${arrow} ${label}`))
      + this.theme.fg(statusColor, ` · ${this.presentation.status}`);
    const authoritative = this.presentation.status === "running" ? undefined : this.options.authoritativeAssistantText;
    const hasExtraDetail = Boolean(authoritative)
      || this.presentation.lastAssistantTextClipped
      || this.presentation.lastAssistantText.includes("\n")
      || this.presentation.lastAssistantText.length > 240
      || this.presentation.activities.length > 0
      || Boolean(this.presentation.error);
    // The host key toggles global expansion, not this card-local state. Only
    // show its hint while collapsed and when opening can reveal more content.
    if (!this.state.expanded && this.options.showExpandHint !== false && hasExtraDetail) {
      header += this.theme.fg("dim", ` (${configuredExpandHint()})`);
    }
    if (this.options.compactHeader && this.renderedWidth !== undefined) {
      header = truncateToWidth(header, this.renderedWidth);
    }
    this.addChild(new Text(header, 0, 0));

    if (this.state.expanded && authoritative) {
      // The registry deliberately retains only a bounded snapshot. A terminal
      // foreground result has its existing authoritative details here instead.
      this.addChild(new Markdown(sanitizeTerminalText(authoritative), 0, 0, safeMarkdownTheme()));
    } else if (this.presentation.lastAssistantText) {
      const clipped = this.presentation.lastAssistantTextClipped;
      const labelText = this.state.expanded
        ? clipped ? "Response preview (clipped):" : "Completed response:"
        : clipped ? "Response preview (clipped):" : "Response preview:";
      const text = this.state.expanded ? this.presentation.lastAssistantText : preview(this.presentation.lastAssistantText);
      this.addChild(new Text(this.theme.fg("muted", labelText) + `\n${this.theme.fg("toolOutput", text)}`, 0, 0));
    } else if (!this.state.expanded) {
      const current = this.presentation.activities.at(-1);
      const detail = current
        ? `${current.name} · ${statusText(current.status)}`
        : this.presentation.error ?? "(no completed assistant response)";
      this.addChild(new Text(this.theme.fg(current?.status === "failed" ? "error" : "dim", detail), 0, 0));
    } else if (this.presentation.status !== "running") {
      // A thrown error after reload has no authoritative result reference.
      // State that limitation; never invent a recoverable completed response.
      this.addChild(new Text(this.theme.fg("dim", "(no completed assistant response available)"), 0, 0));
    }

    if (this.state.expanded) {
      if (this.presentation.error) this.addChild(new Text(this.theme.fg(statusColor === "success" ? "error" : statusColor, this.presentation.error), 0, 0));
      for (const item of this.presentation.activities) {
        const color = item.status === "completed" ? "success" : item.status === "failed" ? "error" : "warning";
        this.addChild(new Text(this.theme.fg(color, `${item.name} · ${statusText(item.status)}`), 0, 0));
      }
    }
  }
}
