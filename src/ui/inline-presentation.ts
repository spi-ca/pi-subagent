import { getInlinePresentation } from "../core/runner-events.js";

export const INLINE_PRESENTATION_MAX_CARDS = 64;
const MAX_CARDS = INLINE_PRESENTATION_MAX_CARDS;
const MAX_ACTIVITIES = 16;
const MAX_ASSISTANT_BYTES = 4 * 1024;
const MAX_LABEL_BYTES = 256;

export interface InlineActivityPresentation {
  name: string;
  status: "running" | "completed" | "failed";
}

export interface InlineCardPresentation {
  identity: string;
  agent: string;
  ordinal: number;
  stageLabel?: string;
  lastAssistantText: string;
  lastAssistantTextClipped: boolean;
  activities: InlineActivityPresentation[];
  status: "running" | "completed" | "cancelled" | "failed";
  error?: string;
}

export interface InlineCardState {
  expanded: boolean;
  lastGlobalExpanded: boolean;
}

type InlineResultLike = {
  agent?: unknown;
  stageLabel?: unknown;
  exitCode?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  messages?: unknown;
};

type InlineDetailsLike = { terminalMode?: unknown; results?: unknown };

export interface InlinePresentationCaptureOptions {
  /** Retains existing foreground terminal result references only for thrown-error recovery. */
  retainAuthoritativeResults?: boolean;
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

function truncateUtf8(text: string, maxBytes: number): string {
  return truncateUtf8WithStatus(text, maxBytes).text;
}

function truncateUtf8WithStatus(text: string, maxBytes: number): { text: string; clipped: boolean } {
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) return { text: `${result}…`, clipped: true };
    result += character;
    bytes += size;
  }
  return { text: result, clipped: false };
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" ? truncateUtf8(sanitizeTerminalText(value), MAX_LABEL_BYTES) || fallback : fallback;
}

function resultIdentity(results: unknown[], index: number): { identity: string; agent: string; ordinal: number; stageLabel?: string } | undefined {
  const candidate = results[index] as InlineResultLike | undefined;
  if (!candidate || typeof candidate !== "object" || typeof candidate.agent !== "string") return undefined;
  const agent = safeLabel(candidate.agent, "agent");
  const stageLabel = typeof candidate.stageLabel === "string" ? safeLabel(candidate.stageLabel, "stage") : undefined;
  let ordinal = 0;
  for (let current = 0; current <= index; current += 1) {
    const prior = results[current] as InlineResultLike | undefined;
    if (!prior || typeof prior !== "object" || typeof prior.agent !== "string") continue;
    if (safeLabel(prior.agent, "agent") === agent
      && (typeof prior.stageLabel === "string" ? safeLabel(prior.stageLabel, "stage") : undefined) === stageLabel) ordinal += 1;
  }
  // This slot key contains only bounded presentation labels and an ordinal;
  // task arguments, tool IDs, and child output never become identity data.
  return { identity: `${stageLabel ?? ""}\u0000${agent}\u0000${ordinal}`, agent, ordinal, ...(stageLabel ? { stageLabel } : {}) };
}

function terminalStatus(candidate: InlineResultLike): InlineCardPresentation["status"] {
  if (candidate.stopReason === "aborted") return "cancelled";
  if (candidate.exitCode === -1) return "running";
  return candidate.exitCode === 0 && candidate.stopReason !== "error" ? "completed" : "failed";
}

/**
 * Bounded, session-local presentation metadata. It is keyed by Pi's existing
 * tool-call identity and never mutates tool details, content, usage, or prompt
 * state. A session reset drops every retained preview and expansion choice.
 */
export class InlinePresentationRegistry {
  private cards = new Map<string, Map<string, InlineCardPresentation>>();
  // Terminal result references are UI-only and bounded by the same card cap.
  // They avoid a second full-output copy while a thrown host error has no
  // details to render. Session reset releases every reference.
  private terminalResults = new Map<string, Map<string, InlineResultLike>>();
  private cardCount = 0;
  private states = new Map<string, InlineCardState>();
  private listeners = new Set<() => void>();

  capture(toolCallId: string, details: unknown, options: InlinePresentationCaptureOptions = {}): boolean {
    if (!toolCallId || details === null || typeof details !== "object") return false;
    const typedDetails = details as InlineDetailsLike;
    if (typedDetails.terminalMode !== "inline" || !Array.isArray(typedDetails.results)) return false;

    const cards = new Map<string, InlineCardPresentation>();
    const terminalResults = new Map<string, InlineResultLike>();
    // Presentation observers must not allocate or inspect unbounded result
    // arrays. Result order is stable, so retaining the first slots gives a
    // deterministic clipped preview while the tool details remain complete.
    const capturedResults = typedDetails.results.slice(0, MAX_CARDS);
    for (const [index, candidate] of capturedResults.entries()) {
      if (candidate === null || typeof candidate !== "object") continue;
      const identity = resultIdentity(capturedResults, index);
      if (!identity) continue;
      const result = candidate as InlineResultLike;
      const presentation = getInlinePresentation(candidate) as {
        lastAssistantText?: unknown;
        lastAssistantTextClipped?: unknown;
        activities?: Array<{ name?: unknown; status?: unknown }>;
      } | undefined;
      const activities = Array.isArray(presentation?.activities)
        ? presentation.activities.slice(-MAX_ACTIVITIES).flatMap((activity) => {
          if (!activity || typeof activity.name !== "string") return [];
          const status = activity.status === "running" || activity.status === "failed" || activity.status === "completed"
            ? activity.status
            : "running";
          return [{ name: truncateUtf8(sanitizeTerminalText(activity.name), 128) || "tool", status: status as InlineActivityPresentation["status"] }];
        })
        : [];
      const error = terminalStatus(result) === "failed" || terminalStatus(result) === "cancelled"
        ? safeLabel(result.errorMessage, terminalStatus(result) === "cancelled" ? "cancelled" : "failed")
        : undefined;
      const assistantSnapshot = typeof presentation?.lastAssistantText === "string"
        ? truncateUtf8WithStatus(sanitizeTerminalText(presentation.lastAssistantText), MAX_ASSISTANT_BYTES)
        : { text: "", clipped: false };
      const status = terminalStatus(result);
      cards.set(identity.identity, {
        ...identity,
        lastAssistantText: assistantSnapshot.text,
        // The upstream observer clips by code units before this UTF-8 cap.
        // Its explicit metadata is required for exact-limit ASCII previews.
        lastAssistantTextClipped: assistantSnapshot.clipped || presentation?.lastAssistantTextClipped === true,
        activities,
        status,
        ...(error ? { error } : {}),
      });
      if (options.retainAuthoritativeResults === true && status !== "running") terminalResults.set(identity.identity, result);
    }
    if (cards.size === 0) return false;
    this.replaceInvocation(toolCallId, cards, terminalResults);
    this.emit();
    return true;
  }

  get(toolCallId: string, results: unknown[], index: number): InlineCardPresentation | undefined {
    const identity = resultIdentity(results, index);
    if (!identity) return undefined;
    const cards = this.cards.get(toolCallId);
    if (!cards) return undefined;
    this.cards.delete(toolCallId);
    this.cards.set(toolCallId, cards);
    return cards.get(identity.identity);
  }

  all(): Array<{ toolCallId: string; card: InlineCardPresentation }> {
    return [...this.cards.entries()].flatMap(([toolCallId, cards]) => [...cards.values()].map((card) => ({ toolCallId, card })));
  }

  /** Returns the existing terminal message array without copying it. */
  authoritativeMessages(toolCallId: string, identity: string): unknown[] | undefined {
    const messages = this.terminalResults.get(toolCallId)?.get(identity)?.messages;
    return Array.isArray(messages) ? messages : undefined;
  }

  state(toolCallId: string, identity: string, globalExpanded: boolean): InlineCardState {
    const key = `${toolCallId}\u0000${identity}`;
    let state = this.states.get(key);
    if (!state) {
      state = { expanded: globalExpanded, lastGlobalExpanded: globalExpanded };
      this.states.set(key, state);
    } else if (state.lastGlobalExpanded !== globalExpanded) {
      state.expanded = globalExpanded;
      state.lastGlobalExpanded = globalExpanded;
    }
    return state;
  }

  markTerminal(toolCallId: string, status: "failed" | "cancelled"): void {
    const cards = this.cards.get(toolCallId);
    if (!cards) return;
    for (const [identity, card] of cards) {
      cards.set(identity, { ...card, status, error: card.error ?? (status === "cancelled" ? "cancelled" : "failed") });
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.cards.clear();
    this.terminalResults.clear();
    this.cardCount = 0;
    this.states.clear();
    this.emit();
  }

  private replaceInvocation(
    toolCallId: string,
    incomingCards: ReadonlyMap<string, InlineCardPresentation>,
    incomingTerminalResults: ReadonlyMap<string, InlineResultLike>,
  ): void {
    // Choose from the combined retained and incoming candidates. A completed
    // arrival must never evict one of 64 running cards merely because it was
    // captured later. Ordering within a priority is stable and deterministic.
    const candidates: Array<{ toolCallId: string; identity: string; card: InlineCardPresentation; terminalResult?: InlineResultLike; order: number }> = [];
    let order = 0;
    for (const [existingToolCallId, cards] of this.cards) {
      if (existingToolCallId === toolCallId) continue;
      for (const [identity, card] of cards) {
        candidates.push({ toolCallId: existingToolCallId, identity, card, terminalResult: this.terminalResults.get(existingToolCallId)?.get(identity), order: order++ });
      }
    }
    for (const [identity, card] of incomingCards) {
      candidates.push({ toolCallId, identity, card, terminalResult: incomingTerminalResults.get(identity), order: order++ });
    }
    const priority = (card: InlineCardPresentation): number => card.status === "running" ? 0 : card.status === "failed" || card.status === "cancelled" ? 1 : 2;
    const retained = candidates
      .sort((left, right) => priority(left.card) - priority(right.card) || left.order - right.order)
      .slice(0, MAX_CARDS);
    const retainedKeys = new Set(retained.map((candidate) => `${candidate.toolCallId}\u0000${candidate.identity}`));
    for (const key of this.states.keys()) {
      if (!retainedKeys.has(key)) this.states.delete(key);
    }
    this.cards.clear();
    this.terminalResults.clear();
    this.cardCount = 0;
    for (const candidate of retained) {
      let cards = this.cards.get(candidate.toolCallId);
      if (!cards) this.cards.set(candidate.toolCallId, cards = new Map());
      cards.set(candidate.identity, candidate.card);
      if (candidate.terminalResult) {
        let terminalResults = this.terminalResults.get(candidate.toolCallId);
        if (!terminalResults) this.terminalResults.set(candidate.toolCallId, terminalResults = new Map());
        terminalResults.set(candidate.identity, candidate.terminalResult);
      }
      this.cardCount += 1;
    }
  }

  private emit(): void {
    // Presentation observers run inside tool/session lifecycle callbacks. A
    // disposed host widget must not turn a completed invocation into an error.
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* display-only observer */ }
    }
  }

  /** Test-only cache bounds visibility. */
  get size(): number { return this.cards.size; }
}
