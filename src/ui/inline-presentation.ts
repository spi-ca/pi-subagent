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
};

type InlineDetailsLike = { terminalMode?: unknown; results?: unknown };

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
  let bytes = 0;
  let result = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) return `${result}…`;
    result += character;
    bytes += size;
  }
  return result;
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
  private cardCount = 0;
  private states = new Map<string, InlineCardState>();
  private listeners = new Set<() => void>();

  capture(toolCallId: string, details: unknown): boolean {
    if (!toolCallId || details === null || typeof details !== "object") return false;
    const typedDetails = details as InlineDetailsLike;
    if (typedDetails.terminalMode !== "inline" || !Array.isArray(typedDetails.results)) return false;

    const cards = new Map<string, InlineCardPresentation>();
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
      cards.set(identity.identity, {
        ...identity,
        lastAssistantText: typeof presentation?.lastAssistantText === "string"
          ? truncateUtf8(sanitizeTerminalText(presentation.lastAssistantText), MAX_ASSISTANT_BYTES)
          : "",
        activities,
        status: terminalStatus(result),
        ...(error ? { error } : {}),
      });
    }
    if (cards.size === 0) return false;
    this.removeInvocation(toolCallId, cards);
    while (this.cardCount + cards.size > MAX_CARDS) this.evictOldestCard();
    this.cards.set(toolCallId, cards);
    this.cardCount += cards.size;
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
    this.cardCount = 0;
    this.states.clear();
    this.emit();
  }

  private removeInvocation(toolCallId: string, retainedCards?: ReadonlyMap<string, InlineCardPresentation>): void {
    const cards = this.cards.get(toolCallId);
    if (!cards) return;
    this.cards.delete(toolCallId);
    this.cardCount -= cards.size;
    for (const identity of cards.keys()) {
      if (!retainedCards?.has(identity)) this.states.delete(`${toolCallId}\u0000${identity}`);
    }
  }

  private evictOldestCard(): void {
    const oldestToolCallId = this.cards.keys().next().value;
    if (oldestToolCallId === undefined) return;
    const cards = this.cards.get(oldestToolCallId);
    if (!cards) return;
    const oldestIdentity = cards.keys().next().value;
    if (oldestIdentity === undefined) {
      this.cards.delete(oldestToolCallId);
      return;
    }
    cards.delete(oldestIdentity);
    this.cardCount -= 1;
    this.states.delete(`${oldestToolCallId}\u0000${oldestIdentity}`);
    if (cards.size === 0) this.cards.delete(oldestToolCallId);
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
