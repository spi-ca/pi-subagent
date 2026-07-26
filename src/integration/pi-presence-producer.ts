import type { SubagentUxRegistrySnapshot, SubagentUxSnapshot } from "../core/subagent-ux.js";

/** Duplicated wire contract: this package intentionally has no pi-cmux-presence dependency. */
export const PI_PRESENCE_UPDATE_EVENT = "pi-presence:update:v1" as const;
export const PI_PRESENCE_READY_EVENT = "pi-presence:ready:v1" as const;
export const PI_SUBAGENT_PRESENCE_SOURCE = { id: "pi-subagent", label: "Subagents", kind: "agent-group" } as const;

const MAX_TEXT = 96;
const MAX_ARRAY = 16;
const MAX_REMEMBERED_TERMINALS = 4096;
/** Counts are deliberately bounded to the consumer's v1 wire maximum. */
export const MAX_PRESENCE_COUNT = 1_000_000;
const MAX_METRIC = 1_000_000_000_000;
const STATES = new Set(["idle", "waiting", "running", "success", "error", "cancelled"]);
const ATTENTION = new Set(["none", "info", "success", "error"]);
const ROOT_KEYS = ["version", "sessionId", "generation", "sequence", "source", "state", "counts", "progress", "usage", "attention"];
const READY_KEYS = ["version", "sessionId", "consumer"];
const SOURCE_KEYS = ["id", "label", "kind"];
const COUNT_KEYS = ["active", "completed", "failed", "queued", "cancelled", "total"];
const PROGRESS_KEYS = ["value", "label"];
const USAGE_KEYS = ["tokens", "cost", "contextPercent"];
const CONSUMER_KEYS = ["id", "capabilities"];

type PresenceState = "idle" | "waiting" | "running" | "success" | "error" | "cancelled";
type PresenceAttention = "none" | "info" | "success" | "error";

export interface PiPresenceUsage { readonly tokens?: number; readonly cost?: number; readonly contextPercent?: number; }
export interface PiPresenceUpdate {
  readonly version: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly source: { readonly id: string; readonly label: string; readonly kind: string };
  readonly state: PresenceState;
  readonly counts: { readonly active: number; readonly completed: number; readonly failed: number; readonly queued?: number; readonly cancelled?: number; readonly total?: number };
  readonly progress?: { readonly value: number; readonly label?: string };
  readonly usage?: PiPresenceUsage;
  readonly attention?: PresenceAttention;
}
export interface PiPresenceReady {
  readonly version: 1;
  readonly sessionId: string;
  readonly consumer?: { readonly id: string; readonly capabilities: readonly string[] };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}
function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.hasOwn(value, key); }
function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value);
}
function generation(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function sequence(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PRESENCE_COUNT; }
function metric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_METRIC; }
function percent(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100; }

/** Total parser for untrusted process-local updates; proxies and throwing getters are rejected. */
export function parsePiPresenceUpdate(value: unknown): PiPresenceUpdate | null {
  try {
    if (!plainObject(value) || !hasOnlyKeys(value, ROOT_KEYS)
      || !["version", "sessionId", "generation", "sequence", "source", "state", "counts"].every((key) => hasOwn(value, key))) return null;
    const source = value.source;
    const counts = value.counts;
    if (value.version !== 1 || !safeText(value.sessionId) || !generation(value.generation) || !sequence(value.sequence)
      || !plainObject(source) || !hasOnlyKeys(source, SOURCE_KEYS) || !SOURCE_KEYS.every((key) => hasOwn(source, key))
      || !safeText(source.id) || !safeText(source.label) || !safeText(source.kind)
      || typeof value.state !== "string" || !STATES.has(value.state)
      || !plainObject(counts) || !hasOnlyKeys(counts, COUNT_KEYS) || !["active", "completed", "failed"].every((key) => hasOwn(counts, key))
      || !count(counts.active) || !count(counts.completed) || !count(counts.failed)
      || (counts.queued !== undefined && !count(counts.queued)) || (counts.cancelled !== undefined && !count(counts.cancelled)) || (counts.total !== undefined && !count(counts.total))) return null;

    let progress: PiPresenceUpdate["progress"];
    if (value.progress !== undefined) {
      const raw = value.progress;
      if (!plainObject(raw) || !hasOnlyKeys(raw, PROGRESS_KEYS) || !hasOwn(raw, "value") || !metric(raw.value) || raw.value > 1 || (raw.label !== undefined && !safeText(raw.label))) return null;
      progress = raw.label === undefined ? { value: raw.value } : { value: raw.value, label: raw.label };
    }
    let usage: PiPresenceUsage | undefined;
    if (value.usage !== undefined) {
      const raw = value.usage;
      if (!plainObject(raw) || !hasOnlyKeys(raw, USAGE_KEYS)
        || (raw.tokens !== undefined && !metric(raw.tokens)) || (raw.cost !== undefined && !metric(raw.cost)) || (raw.contextPercent !== undefined && !percent(raw.contextPercent))) return null;
      usage = { ...(raw.tokens === undefined ? {} : { tokens: raw.tokens }), ...(raw.cost === undefined ? {} : { cost: raw.cost }), ...(raw.contextPercent === undefined ? {} : { contextPercent: raw.contextPercent }) };
    }
    if (value.attention !== undefined && (typeof value.attention !== "string" || !ATTENTION.has(value.attention))) return null;
    return {
      version: 1, sessionId: value.sessionId, generation: value.generation, sequence: value.sequence,
      source: { id: source.id, label: source.label, kind: source.kind }, state: value.state as PresenceState,
      counts: { active: counts.active, completed: counts.completed, failed: counts.failed, ...(counts.queued === undefined ? {} : { queued: counts.queued }), ...(counts.cancelled === undefined ? {} : { cancelled: counts.cancelled }), ...(counts.total === undefined ? {} : { total: counts.total }) },
      ...(progress === undefined ? {} : { progress }), ...(usage === undefined ? {} : { usage }),
      ...(value.attention === undefined ? {} : { attention: value.attention as PresenceAttention }),
    };
  } catch { return null; }
}

/** Ready is a replay request and passive consumer advertisement, never authority. */
export function parsePiPresenceReady(value: unknown): PiPresenceReady | null {
  try {
    if (!plainObject(value) || !hasOnlyKeys(value, READY_KEYS) || value.version !== 1 || !safeText(value.sessionId)) return null;
    if (value.consumer === undefined) return { version: 1, sessionId: value.sessionId };
    const consumer = value.consumer;
    if (!plainObject(consumer) || !hasOnlyKeys(consumer, CONSUMER_KEYS) || !hasOwn(consumer, "id") || !hasOwn(consumer, "capabilities")
      || !safeText(consumer.id) || !Array.isArray(consumer.capabilities) || consumer.capabilities.length > MAX_ARRAY || !consumer.capabilities.every(safeText)) return null;
    return { version: 1, sessionId: value.sessionId, consumer: { id: consumer.id, capabilities: [...consumer.capabilities] } };
  } catch { return null; }
}

/** Exact passive UI routing hint; it grants no execution or lifecycle authority. */
export function isPiCmuxPresenceCmuxStatusReady(value: unknown): boolean {
  const ready = parsePiPresenceReady(value);
  return ready?.consumer?.id === "pi-cmux-presence" && ready.consumer.capabilities.includes("cmux-status");
}

export interface PiSubagentPresenceProducerOptions {
  readonly emit: (channel: string, payload: unknown) => void;
  readonly on?: (channel: string, handler: (payload: unknown) => void) => (() => void);
  readonly getSchedulerCounts: () => { readonly active: number; readonly queued: number };
  readonly getInteractiveActiveCount: () => number;
  /** Passive UI-routing hint only; it must never affect run lifecycle. */
  readonly onCmuxStatusConsumer?: () => void;
}

type TerminalStatus = Extract<SubagentUxSnapshot["status"], "completed" | "failed" | "cancelled">;
type TerminalSnapshot = SubagentUxSnapshot & { readonly status: TerminalStatus };
interface NewTerminalObservation {
  readonly state: TerminalStatus | null;
  readonly attention: PresenceAttention;
}

/** Root-session, observer-only producer. It has no execution or cleanup authority. */
export class PiSubagentPresenceProducer {
  private readonly emit: PiSubagentPresenceProducerOptions["emit"];
  private readonly on: PiSubagentPresenceProducerOptions["on"];
  private readonly getSchedulerCounts: PiSubagentPresenceProducerOptions["getSchedulerCounts"];
  private readonly getInteractiveActiveCount: PiSubagentPresenceProducerOptions["getInteractiveActiveCount"];
  private readonly onCmuxStatusConsumer: PiSubagentPresenceProducerOptions["onCmuxStatusConsumer"];
  private sessionId: string | null = null;
  private generation: number | null = null;
  private sequence = 0;
  private current: PiPresenceUpdate | null = null;
  private readonly terminalIds = new Set<string>();
  private terminalCounts = { completed: 0, failed: 0, cancelled: 0 };
  private lastTerminal: TerminalStatus | null = null;
  private unsubscribeReady: (() => void) | null = null;
  private cmuxStatusConsumerSeen = false;
  private replaying = false;

  constructor(options: PiSubagentPresenceProducerOptions) {
    this.emit = options.emit;
    this.on = options.on;
    this.getSchedulerCounts = options.getSchedulerCounts;
    this.getInteractiveActiveCount = options.getInteractiveActiveCount;
    this.onCmuxStatusConsumer = options.onCmuxStatusConsumer;
  }

  startSession(sessionId: string, generation: number): boolean {
    this.stop();
    if (!safeText(sessionId) || !generationNumber(generation)) return false;
    this.sessionId = sessionId;
    this.generation = generation;
    this.sequence = 0;
    this.current = null;
    this.terminalIds.clear();
    this.terminalCounts = { completed: 0, failed: 0, cancelled: 0 };
    this.lastTerminal = null;
    this.cmuxStatusConsumerSeen = false;
    this.replaying = false;
    try { this.unsubscribeReady = this.on?.(PI_PRESENCE_READY_EVENT, (payload) => this.handleReady(payload)) ?? null; } catch { this.unsubscribeReady = null; }
    return true;
  }

  stop(): void {
    try { this.unsubscribeReady?.(); } catch { /* Listener cleanup is observer-only. */ }
    this.unsubscribeReady = null;
    this.sessionId = null;
    this.generation = null;
    this.current = null;
    this.replaying = false;
    this.terminalIds.clear();
  }

  publish(snapshot: SubagentUxRegistrySnapshot): boolean {
    if (this.sessionId === null || this.generation === null || snapshot.generation !== this.generation) return false;
    const newTerminal = this.rememberTerminals(snapshot.recent);
    const event = this.makeUpdate(snapshot, newTerminal, false);
    if (!event) return false;
    this.current = freezePresenceUpdate(event);
    this.emitSafely(this.current);
    return true;
  }

  /** Public for thin entrypoint wiring and deterministic tests. */
  handleReady(payload: unknown): void {
    const ready = parsePiPresenceReady(payload);
    if (!ready || ready.sessionId !== this.sessionId) return;
    if (!this.cmuxStatusConsumerSeen && ready.consumer?.id === "pi-cmux-presence" && ready.consumer.capabilities.includes("cmux-status")) {
      this.cmuxStatusConsumerSeen = true;
      try { this.onCmuxStatusConsumer?.(); } catch { /* UI routing is non-authoritative. */ }
    }
    if (!this.current || this.replaying) return;
    const parsed = parsePiPresenceUpdate({ ...this.current, sequence: this.nextSequence(), attention: "none" });
    if (!parsed) return;
    this.current = freezePresenceUpdate(parsed);
    this.replaying = true;
    try { this.emitSafely(this.current); } finally { this.replaying = false; }
  }

  private makeUpdate(snapshot: SubagentUxRegistrySnapshot, newTerminals: NewTerminalObservation, replay: boolean): PiPresenceUpdate | null {
    if (this.sessionId === null || this.generation === null) return null;
    const scheduler = this.schedulerCounts();
    const interactive = this.interactiveCount();
    const invocationActive = snapshot.active.filter((item) => item.status === "running" || item.status === "cancelling").length;
    // Scheduler work belongs to the invocation; use the larger observation instead of double-counting it.
    const active = clamp(Math.max(invocationActive, scheduler.active) + interactive);
    const queued = clamp(scheduler.queued);
    const completed = clamp(this.terminalCounts.completed);
    const failed = clamp(this.terminalCounts.failed);
    const cancelled = clamp(this.terminalCounts.cancelled);
    const determinate = snapshot.active.filter((item) => item.progress !== undefined);
    const progressTotal = determinate.reduce((total, item) => clamp(total + (item.progress?.total ?? 0)), 0);
    const progressCompleted = determinate.reduce((total, item) => clamp(total + (item.progress?.completed ?? 0)), 0);
    const terminal = newTerminals.state ?? this.lastTerminal;
    const state: PresenceState = active > 0 ? "running" : queued > 0 ? "waiting" : terminal === "failed" ? "error" : terminal === "completed" ? "success" : terminal === "cancelled" ? "cancelled" : "idle";
    const attention: PresenceAttention = replay ? "none" : newTerminals.attention;
    const event: PiPresenceUpdate = {
      version: 1, sessionId: this.sessionId, generation: this.generation, sequence: this.nextSequence(), source: PI_SUBAGENT_PRESENCE_SOURCE, state,
      counts: { active, completed, failed, queued, cancelled, total: clamp(active + queued + completed + failed + cancelled) },
      ...(progressTotal > 0 ? { progress: { value: Math.min(1, progressCompleted / progressTotal), label: `Subagents ${progressCompleted}/${progressTotal}` } } : {}),
      attention,
    };
    return parsePiPresenceUpdate(event);
  }

  private rememberTerminals(recent: readonly SubagentUxSnapshot[]): NewTerminalObservation {
    let newest: TerminalSnapshot | null = null;
    let attention: PresenceAttention = "none";
    for (const item of recent) {
      if (!isTerminalSnapshot(item) || this.terminalIds.has(item.id)) continue;
      // Once identifier memory saturates, freeze counts rather than risking replay overcount.
      if (this.terminalIds.size >= MAX_REMEMBERED_TERMINALS) continue;
      this.terminalIds.add(item.id);
      if (this.terminalCounts[item.status] < MAX_PRESENCE_COUNT) this.terminalCounts[item.status] += 1;
      if (!newest || isNewerTerminal(item, newest)) newest = item;
      if (item.status === "failed") attention = "error";
      else if (item.status === "completed" && attention !== "error") attention = "success";
    }
    const state = newest?.status ?? null;
    if (state) this.lastTerminal = state;
    return { state, attention };
  }

  private schedulerCounts(): { active: number; queued: number } {
    try { const value = this.getSchedulerCounts(); return { active: safeCount(value?.active), queued: safeCount(value?.queued) }; } catch { return { active: 0, queued: 0 }; }
  }
  private interactiveCount(): number { try { return safeCount(this.getInteractiveActiveCount()); } catch { return 0; } }
  private nextSequence(): number { this.sequence += 1; return this.sequence; }
  private emitSafely(event: PiPresenceUpdate): void { try { this.emit(PI_PRESENCE_UPDATE_EVENT, event); } catch { /* Event observers are never lifecycle authority. */ } }
}

function isTerminalSnapshot(item: SubagentUxSnapshot): item is TerminalSnapshot {
  return item.status === "completed" || item.status === "failed" || item.status === "cancelled";
}
function isNewerTerminal(candidate: TerminalSnapshot, current: TerminalSnapshot): boolean {
  const candidateAt = candidate.completedAt ?? candidate.updatedAt;
  const currentAt = current.completedAt ?? current.updatedAt;
  return candidateAt > currentAt || candidateAt === currentAt && candidate.id > current.id;
}
function freezePresenceUpdate(event: PiPresenceUpdate): PiPresenceUpdate {
  return Object.freeze({
    ...event,
    source: Object.freeze({ ...event.source }),
    counts: Object.freeze({ ...event.counts }),
    ...(event.progress ? { progress: Object.freeze({ ...event.progress }) } : {}),
    ...(event.usage ? { usage: Object.freeze({ ...event.usage }) } : {}),
  });
}
function generationNumber(value: unknown): value is number { return generation(value); }
function safeCount(value: unknown): number { return count(value) ? value : 0; }
function clamp(value: number): number { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_PRESENCE_COUNT) : 0; }

export function createPiSubagentPresenceProducer(options: PiSubagentPresenceProducerOptions): PiSubagentPresenceProducer {
  return new PiSubagentPresenceProducer(options);
}
