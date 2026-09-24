import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { InlineResultCard } from "./inline-result-card.js";
import { type InlinePresentationRegistry } from "./inline-presentation.js";

type WidgetTheme = {
  fg: (color: "success" | "error" | "warning" | "accent" | "toolTitle" | "muted" | "dim" | "toolOutput", text: string) => string;
  bold: (text: string) => string;
  bg?: (color: "customMessageBg", text: string) => string;
};

const MAX_WIDGET_CARDS = 4;
const MAX_WIDGET_LINES = 12;

/**
 * Keeps the Container's rendered layout and mouse layout identical. Limiting
 * parent render output directly would leave hidden card bodies clickable.
 */
class WidgetCardSlot implements Component {
  constructor(private readonly card: InlineResultCard, private readonly maxRows: number) {}

  // Kept for existing display observers that inspect widget children only.
  get presentation() {
    return this.card.cardPresentation;
  }

  render(width: number): string[] {
    return this.card.render(width).slice(0, this.maxRows);
  }

  handleMouse(event: any): ReturnType<InlineResultCard["handleMouse"]> {
    if (typeof event?.y !== "number" || event.y < 0 || event.y >= this.maxRows) return undefined;
    return this.card.handleMouse(event);
  }

  invalidate(): void {
    this.card.invalidate();
  }
}

/**
 * Session-fenced background widget. It reads only bounded display snapshots;
 * the final result message remains the detail surface. The dock itself has a
 * real rendered-row budget so narrow Markdown wrapping cannot consume it.
 */
export class InlinePresentationWidget extends Container implements Component {
  private unsubscribe: (() => void) | undefined;
  private slots: WidgetCardSlot[] = [];

  constructor(
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly registry: InlinePresentationRegistry,
    private theme: WidgetTheme,
  ) {
    super();
    this.unsubscribe = registry.subscribe(() => this.publish());
    this.publish();
  }

  dispose(): void {
    try { this.unsubscribe?.(); } catch { /* host disposal is display-only */ }
    this.unsubscribe = undefined;
  }

  override invalidate(): void {
    super.invalidate();
    this.publish();
  }

  override render(width: number): string[] {
    // Pi 0.87's Container records WidgetCardSlot's capped child heights for
    // mouse dispatch. Older compatible hosts have no Container.render().
    const containerRender = (Container.prototype as unknown as { render?: (width: number) => string[] }).render;
    return typeof containerRender === "function"
      ? containerRender.call(this, width)
      : this.slots.flatMap((slot) => slot.render(width));
  }

  private publish(): void {
    // A registry update can be driven by tool completion. Keep all widget
    // projection failures out of that execution path and still attempt a
    // render if rebuilding succeeds.
    try {
      this.rebuild();
      try { this.tui.requestRender(); } catch { /* disposed TUI */ }
    } catch { /* malformed/disposed widget surface */ }
  }

  private rebuild(): void {
    this.clear();
    const visible = this.registry.all()
      .filter(({ card }) => card.status === "running")
      .slice(0, MAX_WIDGET_CARDS);
    // Reserve one (single-line) header for every prioritized card before
    // allocating body rows. An expanded first card can never hide later work.
    const detailRows = Math.max(0, MAX_WIDGET_LINES - visible.length);
    const extraRows = visible.length === 0 ? 0 : Math.floor(detailRows / visible.length);
    this.slots = visible.map(({ toolCallId, card }) => {
      // The widget has no authoritative app.tools.expand state. Header clicks
      // expand only its bounded snapshot and never advertise a host shortcut.
      const widgetCard = new InlineResultCard(
        card,
        this.registry.state(toolCallId, card.identity, false),
        this.theme,
        { showExpandHint: false, compactHeader: true },
      );
      const slot = new WidgetCardSlot(widgetCard, 1 + extraRows);
      this.addChild(slot);
      return slot;
    });
  }
}
