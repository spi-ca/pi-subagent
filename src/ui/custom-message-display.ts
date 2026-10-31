import { Box, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { truncateUiRow } from "./native-ui.js";
import { normalizeToolDisplayPreviewLines } from "./tool-display-config.js";

/** Shared display-only layout/state for native custom messages, not tool cards. */
const MAX_DISPLAY_RENDERED_ROWS = 96;

export interface RenderMessage {
  content?: unknown;
  details?: unknown;
}

export interface RenderFooter {
  text: string;
  /** A compact sentinel preserves footer identity when the full notice cannot fit usefully. */
  compactText?: string;
}

export interface RenderLines {
  /** A source-clipping footer already explains truncation; avoid a second layout notice. */
  hasClippingFooter?: boolean;
  clippingHint?: string;
  /** Compact source-line accounting, independent of header/footer display rows. */
  compactBody?: {
    formatNotice: (count: number) => string;
    firstLineIndex: number;
    /** The output-body visual row budget; headings and footers do not consume it. */
    previewLines: number;
    totalLines: number;
    partialLastLine: boolean;
  };
  lines: string[];
  /** Aggregate compact messages share the native result row budget. */
  compactMaxRows?: number;
  /** Report diagnostics: reserve actual visual rows before budgeting the preceding body. */
  reservedSection?: {
    lines: string[];
    /** Includes the section's clipping marker when its visual rows exceed this limit. */
    maxRows: number;
  };
  footers: RenderFooter[];
}

export type MessageDisplayTheme = {
  fg: (color: "toolTitle" | "success" | "error" | "warning" | "accent" | "muted" | "dim" | "toolOutput", text: string) => string;
  bold: (text: string) => string;
  bg: (color: "customMessageBg", text: string) => string;
};

/** Structural mouse-dispatch result, shared by both custom-message renderers. */
interface MessageDisplayMouseDispatchResult {
  handled: true;
  target: {
    component: MessageDisplayComponent;
    originX: number;
    originY: number;
    width: number;
    height: number;
  };
}

export interface MessageDisplayRendererOptions {
  /** Compact output-body visual rows. Later configuration can inject this without changing renderer state semantics. */
  previewLines?: number;
}

export interface MessageDisplayRenderer {
  (message: RenderMessage, options: { expanded: boolean; outputPad: number }, theme: MessageDisplayTheme): MessageDisplayComponent;
  /** Drops session-owned card state before a replacement/reload rebuilds the transcript. */
  reset(): void;
}

function statusMarker(kind: "clipped" | "substituted", width: number): string {
  // A one-cell terminal cannot show the full diagnostic, but the replacement itself remains visible.
  if (width === 1) return kind === "substituted" ? "?" : "…";
  if (width < 8) return kind === "substituted" ? "[wide?]" : "[clip]";
  return "[display clipped]";
}

function wrapDisplayRows(text: string, width: number): { rows: string[]; substituted: boolean } {
  const wrapped = wrapTextWithAnsi(text, width);
  const rows: string[] = [];
  let substituted = false;
  for (let index = 0; index < wrapped.length; index += 1) {
    const row = wrapped[index];
    const rowWidth = visibleWidth(row);
    if (rowWidth <= width) {
      // The library emits an ANSI-only/empty row before an overwide grapheme at narrow widths.
      // The following row has complete style state, so omit the empty predecessor instead.
      if (rowWidth === 0 && visibleWidth(wrapped[index + 1] ?? "") > width) continue;
      rows.push(row);
      continue;
    }
    // Do not silently discard a double-width grapheme when no terminal cell can contain it.
    rows.push("?");
    substituted = true;
  }
  return { rows, substituted };
}

function createBoundedLines(renderLines: RenderLines, outputPad: number): { render: (width: number) => string[]; invalidate: () => void } {
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  return {
    render: (width) => {
      if (cachedWidth === width && cachedLines) return cachedLines;
      const maxRows = renderLines.compactMaxRows ?? MAX_DISPLAY_RENDERED_ROWS;
      const safeWidth = Math.max(1, width);
      const padding = Math.min(outputPad, Math.max(0, Math.floor((safeWidth - 1) / 2)));
      const contentWidth = Math.max(1, safeWidth - padding);
      const prefix = " ".repeat(padding);
      const compactNotice = (count: number) => contentWidth < 8
        ? "…"
        : renderLines.compactBody!.formatNotice(count);
      const clippedMarker = wrapDisplayRows(renderLines.compactBody === undefined
        ? (contentWidth >= 8 ? renderLines.clippingHint : undefined) ?? statusMarker("clipped", contentWidth)
        : compactNotice(renderLines.compactBody.totalLines), contentWidth).rows;
      const substitutedMarker = wrapDisplayRows(statusMarker("substituted", contentWidth), contentWidth).rows;
      const footerLayout = (text: string) => renderLines.compactMaxRows === undefined
        ? wrapDisplayRows(text, contentWidth)
        : { rows: [truncateUiRow(text, contentWidth)], substituted: false };
      const footerRows = renderLines.footers.map((footer) => footerLayout(
        contentWidth < 8 && footer.compactText !== undefined ? footer.compactText : footer.text,
      ));
      const reservedRows = clippedMarker.length + substitutedMarker.length + footerRows.reduce((count, footer) => count + footer.rows.length, 0);
      const normalRowLimit = Math.max(0, maxRows - reservedRows);
      const sectionRows: string[] = [];
      let sectionSubstituted = false;
      if (renderLines.reservedSection) {
        const sectionLimit = Math.min(renderLines.reservedSection.maxRows, normalRowLimit);
        for (const line of renderLines.reservedSection.lines) {
          const wrapped = wrapDisplayRows(line, contentWidth);
          sectionSubstituted ||= wrapped.substituted;
          const remaining = sectionLimit - sectionRows.length;
          sectionRows.push(...wrapped.rows.slice(0, remaining));
          if (wrapped.rows.length > remaining) {
            sectionRows.splice(Math.max(0, sectionLimit - clippedMarker.length));
            sectionRows.push(...clippedMarker.slice(0, sectionLimit));
            break;
          }
        }
      }
      const bodyRowLimit = normalRowLimit - sectionRows.length;
      const rendered: string[] = [];
      const appendRows = (rows: string[]) => {
        const remaining = maxRows - rendered.length;
        if (remaining > 0) rendered.push(...rows.slice(0, remaining));
      };
      let overflowed = false;
      let substituted = sectionSubstituted || footerRows.some((footer) => footer.substituted);

      if (renderLines.compactBody === undefined) {
        for (const line of renderLines.lines) {
          const wrapped = wrapDisplayRows(line, contentWidth);
          substituted ||= wrapped.substituted;
          for (const row of wrapped.rows) {
            if (rendered.length === bodyRowLimit) {
              overflowed = true;
              break;
            }
            rendered.push(row);
          }
          if (overflowed) break;
        }
      } else {
        const { compactBody } = renderLines;
        let visibleBodyLines = 0;
        let bodyRows = 0;
        let bodyPartiallyVisible = false;
        for (let index = 0; index < renderLines.lines.length; index += 1) {
          const wrapped = index === 0 ? { rows: [truncateUiRow(renderLines.lines[index]!, contentWidth)], substituted: false } : wrapDisplayRows(renderLines.lines[index]!, contentWidth);
          substituted ||= wrapped.substituted;
          if (index < compactBody.firstLineIndex) {
            for (const row of wrapped.rows) {
              if (rendered.length === bodyRowLimit) {
                overflowed = true;
                break;
              }
              rendered.push(row);
            }
            if (overflowed) break;
            continue;
          }

          const visualRemaining = Math.min(compactBody.previewLines - bodyRows, bodyRowLimit - rendered.length);
          if (visualRemaining <= 0) {
            bodyPartiallyVisible = wrapped.rows.length > 0;
            break;
          }
          const rowsToShow = Math.min(wrapped.rows.length, visualRemaining);
          rendered.push(...wrapped.rows.slice(0, rowsToShow));
          bodyRows += rowsToShow;
          if (rowsToShow < wrapped.rows.length) {
            bodyPartiallyVisible = true;
            break;
          }
          visibleBodyLines += 1;
        }

        // Count logical source lines, not visual rows. A visually partial line and
        // a byte-partial final source line both remain hidden logical content.
        const bytePartial = compactBody.partialLastLine && visibleBodyLines === renderLines.lines.length - compactBody.firstLineIndex;
        const omitted = Math.max(0, compactBody.totalLines - visibleBodyLines + (bytePartial ? 1 : 0));
        if (omitted > 0 || bodyPartiallyVisible) appendRows(footerLayout(compactNotice(Math.max(1, omitted))).rows);
      }
      if (renderLines.reservedSection) appendRows(sectionRows);
      if (renderLines.compactBody === undefined && overflowed && !renderLines.hasClippingFooter) appendRows(clippedMarker);
      if (substituted) appendRows(substitutedMarker);
      for (const footer of footerRows) appendRows(footer.rows);

      cachedWidth = width;
      cachedLines = rendered.map((line) => `${prefix}${line}`);
      return cachedLines;
    },
    invalidate: () => {
      cachedWidth = undefined;
      cachedLines = undefined;
    },
  };
}

interface MessageDisplayRenderState {
  component?: MessageDisplayComponent;
  expanded: boolean;
  lastGlobalExpanded: boolean;
}

/**
 * A per-message component. Pi redraws fullscreen click results itself, so
 * the handler only changes this card's state and returns handled: true; it does
 * not call the host-wide tool expansion API.
 */
class MessageDisplayComponent extends Box {
  constructor(
    private message: RenderMessage,
    private state: MessageDisplayRenderState,
    private outputPad: number,
    private theme: MessageDisplayTheme,
    private previewLines: number,
    private buildRenderLines: (message: RenderMessage, expanded: boolean, theme: MessageDisplayTheme, previewLines: number) => RenderLines,
  ) {
    super(0, 0, (text) => this.theme.bg("customMessageBg", text));
    this.rebuild();
  }

  update(message: RenderMessage, outputPad: number, theme: MessageDisplayTheme, previewLines: number): void {
    this.message = message;
    this.outputPad = outputPad;
    this.theme = theme;
    this.previewLines = previewLines;
    this.rebuild();
  }

  /** Handle only primary clicks, leaving native selection/scroll dispatch untouched. */
  handleMouse(event: {
    type?: unknown;
    button?: unknown;
    x?: unknown;
    y?: unknown;
    screenX?: unknown;
    screenY?: unknown;
    width?: unknown;
    height?: unknown;
  }): MessageDisplayMouseDispatchResult | undefined {
    // Do not claim presses, drags, releases, wheels, or secondary clicks: the
    // fullscreen transcript must retain its native selection and scroll paths.
    if (event.type !== "click" || event.button !== "left" || (event.y !== undefined && event.y !== 0)) return undefined;
    this.state.expanded = !this.state.expanded;
    this.rebuild();
    const x = finiteMouseCoordinate(event.x);
    const y = finiteMouseCoordinate(event.y);
    return {
      handled: true,
      target: {
        component: this,
        originX: finiteMouseCoordinate(event.screenX) - x,
        originY: finiteMouseCoordinate(event.screenY) - y,
        width: finiteMouseCoordinate(event.width),
        height: finiteMouseCoordinate(event.height),
      },
    };
  }

  override render(width: number): string[] {
    return width < 1 ? [] : super.render(width);
  }

  override invalidate(): void {
    super.invalidate();
    // Theme invalidation and terminal-layout invalidation must not erase a
    // same-global-state local click choice.
    this.rebuild();
  }

  private rebuild(): void {
    // The real Box has clear(); keeping a children-array fallback also lets the
    // renderer remain display-only under lean host/test component shims.
    const box = this as unknown as { children?: unknown[]; clear?: () => void };
    if (typeof box.clear === "function") box.clear();
    else if (Array.isArray(box.children)) box.children.length = 0;
    this.addChild(createBoundedLines(
      this.buildRenderLines(this.message, this.state.expanded, this.theme, this.previewLines),
      this.outputPad,
    ));
  }
}

function finiteMouseCoordinate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Creates renderer state scoped to this extension/session instance. Global
 * expansion changes are authoritative; calls with an unchanged global value
 * intentionally retain this card's local fullscreen-click choice. This is
 * local-card behavior, not a claim of host-wide expansion parity.
 */
export function createMessageDisplayRenderer(
  buildRenderLines: (message: RenderMessage, expanded: boolean, theme: MessageDisplayTheme, previewLines: number) => RenderLines,
  { previewLines }: MessageDisplayRendererOptions = {},
): MessageDisplayRenderer {
  const compactPreviewLines = normalizeToolDisplayPreviewLines(previewLines);
  let states = new WeakMap<RenderMessage, MessageDisplayRenderState>();
  const renderer = (
    message: RenderMessage,
    options: { expanded: boolean; outputPad: number },
    theme: MessageDisplayTheme,
  ): MessageDisplayComponent => {
    let state = states.get(message);
    if (!state) {
      state = { expanded: options.expanded, lastGlobalExpanded: options.expanded };
      states.set(message, state);
    } else if (state.lastGlobalExpanded !== options.expanded) {
      state.expanded = options.expanded;
      state.lastGlobalExpanded = options.expanded;
    }

    if (!state.component) {
      state.component = new MessageDisplayComponent(message, state, options.outputPad, theme, compactPreviewLines, buildRenderLines);
    } else {
      state.component.update(message, options.outputPad, theme, compactPreviewLines);
    }
    return state.component;
  };
  renderer.reset = () => {
    states = new WeakMap<RenderMessage, MessageDisplayRenderState>();
  };
  return renderer;
}
