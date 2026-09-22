import { Container, type Component, type TUI } from "@earendil-works/pi-tui";
import { InlineResultCard } from "./inline-result-card.js";
import { type InlinePresentationRegistry } from "./inline-presentation.js";

type WidgetTheme = {
  fg: (color: "success" | "error" | "warning" | "accent" | "muted" | "dim" | "toolOutput", text: string) => string;
  bold: (text: string) => string;
  bg?: (color: "customMessageBg", text: string) => string;
};

/**
 * Session-fenced background widget. It reads only the registry's bounded,
 * display-only snapshots and asks the host to redraw; it never emits messages
 * or invokes a tool update callback after that tool has returned.
 */
export class InlinePresentationWidget extends Container implements Component {
  private unsubscribe: (() => void) | undefined;

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
    for (const { toolCallId, card } of this.registry.all()) {
      // Widgets do not receive the tool-result expanded flag. Individual
      // header expansion remains available; normal result cards still obey
      // the host's authoritative app.tools.expand state.
      this.addChild(new InlineResultCard(card, this.registry.state(toolCallId, card.identity, false), this.theme));
    }
  }
}
