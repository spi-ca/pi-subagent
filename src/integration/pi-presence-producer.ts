import type { SubagentUxRegistrySnapshot, SubagentUxSnapshot } from "../core/subagent-ux.js";

/** Duplicated wire contract: this package intentionally has no pi-cmux-presence dependency. */
export const PI_PRESENCE_UPDATE_EVENT = "pi-presence:update:v1" as const;
export const PI_PRESENCE_REMOVE_EVENT = "pi-presence:remove:v1" as const;
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
const REMOVE_KEYS = ["version", "sessionId", "generation", "sequence", "source"];
const READY_KEYS = ["version", "sessionId", "consumer"];
const SOURCE_KEYS = ["id", "label", "kind"];
const REMOVE_SOURCE_KEYS = ["id"];
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
export interface PiPresenceRemove {
  readonly version: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly source: { readonly id: string };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}
function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.hasOwn(value, key); }

/** Snapshot only own data fields so untrusted ready payloads cannot race validation. */
function snapshotOwnDataFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> | null {
  if (!plainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key) => typeof key === "string" && allowed.includes(key))
    || !required.every((key) => keys.includes(key))) return null;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    snapshot[key as string] = descriptor.value;
  }
  return snapshot;
}

/** Copy a dense, bounded capability list without reading indexed accessors. */
function snapshotCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > MAX_ARRAY) return null;
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1
    || !keys.every((key) => key === "length"
      || (typeof key === "string"
        && /^(?:0|[1-9]\d*)$/.test(key)
        && Number(key) < length))) return null;
  const capabilities: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !safeText(descriptor.value)) return null;
    capabilities.push(descriptor.value);
  }
  return capabilities;
}

function safeText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TEXT * 2
    && [...value].length <= MAX_TEXT
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value);
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
    const version = value.version;
    const sessionId = value.sessionId;
    const eventGeneration = value.generation;
    const eventSequence = value.sequence;
    const rawSource = value.source;
    const state = value.state;
    const rawCounts = value.counts;
    const rawProgress = value.progress;
    const rawUsage = value.usage;
    const attention = value.attention;
    if (version !== 1 || !safeText(sessionId) || !generation(eventGeneration) || !sequence(eventSequence)
      || !plainObject(rawSource) || !hasOnlyKeys(rawSource, SOURCE_KEYS) || !SOURCE_KEYS.every((key) => hasOwn(rawSource, key))
      || !plainObject(rawCounts) || !hasOnlyKeys(rawCounts, COUNT_KEYS) || !["active", "completed", "failed"].every((key) => hasOwn(rawCounts, key))) return null;

    const sourceId = rawSource.id;
    const sourceLabel = rawSource.label;
    const sourceKind = rawSource.kind;
    const countActive = rawCounts.active;
    const countCompleted = rawCounts.completed;
    const countFailed = rawCounts.failed;
    const countQueued = rawCounts.queued;
    const countCancelled = rawCounts.cancelled;
    const countTotal = rawCounts.total;
    if (!safeText(sourceId) || !safeText(sourceLabel) || !safeText(sourceKind)
      || typeof state !== "string" || !STATES.has(state)
      || !count(countActive) || !count(countCompleted) || !count(countFailed)
      || (countQueued !== undefined && !count(countQueued)) || (countCancelled !== undefined && !count(countCancelled)) || (countTotal !== undefined && !count(countTotal))) return null;

    let progress: PiPresenceUpdate["progress"];
    if (rawProgress !== undefined) {
      if (!plainObject(rawProgress) || !hasOnlyKeys(rawProgress, PROGRESS_KEYS) || !hasOwn(rawProgress, "value")) return null;
      const progressValue = rawProgress.value;
      const progressLabel = rawProgress.label;
      if (!metric(progressValue) || progressValue > 1 || (progressLabel !== undefined && !safeText(progressLabel))) return null;
      progress = progressLabel === undefined ? { value: progressValue } : { value: progressValue, label: progressLabel };
    }
    let usage: PiPresenceUsage | undefined;
    if (rawUsage !== undefined) {
      if (!plainObject(rawUsage) || !hasOnlyKeys(rawUsage, USAGE_KEYS)) return null;
      const usageTokens = rawUsage.tokens;
      const usageCost = rawUsage.cost;
      const usageContextPercent = rawUsage.contextPercent;
      if ((usageTokens !== undefined && !metric(usageTokens)) || (usageCost !== undefined && !metric(usageCost)) || (usageContextPercent !== undefined && !percent(usageContextPercent))) return null;
      usage = { ...(usageTokens === undefined ? {} : { tokens: usageTokens }), ...(usageCost === undefined ? {} : { cost: usageCost }), ...(usageContextPercent === undefined ? {} : { contextPercent: usageContextPercent }) };
    }
    if (attention !== undefined && (typeof attention !== "string" || !ATTENTION.has(attention))) return null;
    return {
      version: 1, sessionId, generation: eventGeneration, sequence: eventSequence,
      source: { id: sourceId, label: sourceLabel, kind: sourceKind }, state: state as PresenceState,
      counts: { active: countActive, completed: countCompleted, failed: countFailed, ...(countQueued === undefined ? {} : { queued: countQueued }), ...(countCancelled === undefined ? {} : { cancelled: countCancelled }), ...(countTotal === undefined ? {} : { total: countTotal }) },
      ...(progress === undefined ? {} : { progress }), ...(usage === undefined ? {} : { usage }),
      ...(attention === undefined ? {} : { attention: attention as PresenceAttention }),
    };
  } catch { return null; }
}

/** Total parser for untrusted process-local removals; proxies and throwing getters are rejected. */
export function parsePiPresenceRemove(value: unknown): PiPresenceRemove | null {
  try {
    if (!plainObject(value) || !hasOnlyKeys(value, REMOVE_KEYS)
      || !REMOVE_KEYS.every((key) => hasOwn(value, key))) return null;
    const version = value.version;
    const sessionId = value.sessionId;
    const eventGeneration = value.generation;
    const eventSequence = value.sequence;
    const rawSource = value.source;
    if (version !== 1 || !safeText(sessionId) || !generation(eventGeneration) || !sequence(eventSequence)
      || !plainObject(rawSource) || !hasOnlyKeys(rawSource, REMOVE_SOURCE_KEYS) || !hasOwn(rawSource, "id")) return null;
    const sourceId = rawSource.id;
    if (!safeText(sourceId)) return null;
    return { version: 1, sessionId, generation: eventGeneration, sequence: eventSequence, source: { id: sourceId } };
  } catch { return null; }
}

/** Ready is a replay request and passive consumer advertisement, never authority. */
export function parsePiPresenceReady(value: unknown): PiPresenceReady | null {
  try {
    const root = snapshotOwnDataFields(value, READY_KEYS, ["version", "sessionId"]);
    if (!root || root.version !== 1 || !safeText(root.sessionId)) return null;
    // A discovery request omits consumer entirely; an own undefined value is invalid.
    if (!hasOwn(root, "consumer")) return { version: 1, sessionId: root.sessionId };

    const consumer = snapshotOwnDataFields(root.consumer, CONSUMER_KEYS, CONSUMER_KEYS);
    if (!consumer || !safeText(consumer.id)) return null;
    const capabilities = snapshotCapabilities(consumer.capabilities);
    if (!capabilities) return null;
    return { version: 1, sessionId: root.sessionId, consumer: { id: consumer.id, capabilities } };
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
  /** Total active interactive runs; retained as a compatibility fallback. */
  readonly getInteractiveActiveCount: () => number;
  /** One atomic process-local snapshot of active interactive-run invocation IDs. Never emitted. */
  readonly getInteractiveActiveInvocationIds?: () => readonly (string | undefined)[];
  /** Passive UI-routing hint only; it must never affect run lifecycle. */
  readonly onCmuxStatusConsumer?: () => void;
}

type TerminalStatus = Extract<SubagentUxSnapshot["status"], "completed" | "failed" | "cancelled">;
type TerminalSnapshot = SubagentUxSnapshot & { readonly status: TerminalStatus };
interface NewTerminalObservation {
  readonly state: TerminalStatus | null;
  readonly attention: PresenceAttention;
}
interface ComputedPresenceUpdate {
  readonly event: PiPresenceUpdate;
  readonly active: number;
  readonly queued: number;
}

/** Root-session, observer-only producer. It has no execution or cleanup authority. */
export class PiSubagentPresenceProducer {
  private readonly emit: PiSubagentPresenceProducerOptions["emit"];
  private readonly on: PiSubagentPresenceProducerOptions["on"];
  private readonly getSchedulerCounts: PiSubagentPresenceProducerOptions["getSchedulerCounts"];
  private readonly getInteractiveActiveCount: PiSubagentPresenceProducerOptions["getInteractiveActiveCount"];
  private readonly getInteractiveActiveInvocationIds: PiSubagentPresenceProducerOptions["getInteractiveActiveInvocationIds"];
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
  private presenceRemoveCapabilityDetected = false;
  private replaying = false;
  /** Exact request identity prevents synchronous self-replay without hiding a consumer response. */
  private locallyEmittedReadyRequest: PiPresenceReady | null = null;
  private requestingReady = false;
  private settlementDeferred = false;

  constructor(options: PiSubagentPresenceProducerOptions) {
    this.emit = options.emit;
    this.on = options.on;
    this.getSchedulerCounts = options.getSchedulerCounts;
    this.getInteractiveActiveCount = options.getInteractiveActiveCount;
    this.getInteractiveActiveInvocationIds = options.getInteractiveActiveInvocationIds;
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
    this.presenceRemoveCapabilityDetected = false;
    this.replaying = false;
    this.locallyEmittedReadyRequest = null;
    this.requestingReady = false;
    this.settlementDeferred = false;
    try { this.unsubscribeReady = this.on?.(PI_PRESENCE_READY_EVENT, (payload) => this.handleReady(payload)) ?? null; } catch { this.unsubscribeReady = null; }
    this.requestReady();
    return true;
  }

  stop(): void {
    this.removeCurrent();
    try { this.unsubscribeReady?.(); } catch { /* Listener cleanup is observer-only. */ }
    this.unsubscribeReady = null;
    this.sessionId = null;
    this.generation = null;
    this.current = null;
    this.cmuxStatusConsumerSeen = false;
    this.presenceRemoveCapabilityDetected = false;
    this.replaying = false;
    this.locallyEmittedReadyRequest = null;
    this.requestingReady = false;
    this.settlementDeferred = false;
    this.terminalIds.clear();
  }

  publish(snapshot: SubagentUxRegistrySnapshot): boolean {
    if (this.sessionId === null || this.generation === null || snapshot.generation !== this.generation) return false;
    const newTerminal = this.rememberTerminals(snapshot.recent);
    const computed = this.makeUpdate(snapshot, newTerminal, false);
    if (!computed) return false;
    this.current = freezePresenceUpdate(computed.event);
    this.emitSafely(PI_PRESENCE_UPDATE_EVENT, this.current);
    if (this.settlementDeferred && computed.active === 0 && computed.queued === 0) this.removeCurrent();
    return true;
  }

  /** Starts a new parent run without resetting the cumulative session state. */
  beginAgentRun(): void {
    this.settlementDeferred = false;
  }

  /** Public for root-only Pi agent_settled wiring and deterministic tests. */
  settle(): void {
    if (!this.current) return;
    const { active = 0, queued = 0 } = this.current.counts;
    if (active === 0 && queued === 0) {
      this.removeCurrent();
      return;
    }
    this.settlementDeferred = true;
  }

  /** Read-only session diagnostic; it never gates producer behavior. */
  isPresenceRemoveCapabilityDetected(): boolean {
    return this.presenceRemoveCapabilityDetected;
  }

  /** Public for thin entrypoint wiring and deterministic tests. */
  handleReady(payload: unknown): void {
    // pi.events emits synchronously. Ignore only this exact locally emitted
    // consumer-less request. A nested consumer advertisement remains visible
    // for passive diagnostics/routing, but never requests a replay.
    if (this.requestingReady && payload === this.locallyEmittedReadyRequest) return;
    const ready = parsePiPresenceReady(payload);
    if (!ready || ready.sessionId !== this.sessionId) return;
    // Removal is a backend-neutral v1 consumer capability. Consumer identity
    // only selects the cmux UI-routing hint below; pi-herdr-presence and future
    // valid consumers must be reflected by the diagnostic as well.
    if (!this.presenceRemoveCapabilityDetected && ready.consumer?.capabilities.includes("presence-remove-v1")) {
      this.presenceRemoveCapabilityDetected = true;
    }
    if (!this.cmuxStatusConsumerSeen && ready.consumer?.id === "pi-cmux-presence" && ready.consumer.capabilities.includes("cmux-status")) {
      this.cmuxStatusConsumerSeen = true;
      try { this.onCmuxStatusConsumer?.(); } catch { /* UI routing is non-authoritative. */ }
    }
    if (ready.consumer || !this.current || this.replaying) return;
    const parsed = parsePiPresenceUpdate({ ...this.current, sequence: this.nextSequence(), attention: "none" });
    if (!parsed) return;
    this.current = freezePresenceUpdate(parsed);
    this.replaying = true;
    try { this.emitSafely(PI_PRESENCE_UPDATE_EVENT, this.current); } finally { this.replaying = false; }
  }

  private makeUpdate(snapshot: SubagentUxRegistrySnapshot, newTerminals: NewTerminalObservation, replay: boolean): ComputedPresenceUpdate | null {
    if (this.sessionId === null || this.generation === null) return null;
    const scheduler = this.schedulerCounts();
    const activeInvocationIds = new Set(snapshot.active
      .filter((item) => item.status === "running" || item.status === "cancelling")
      .map((item) => item.id));
    const invocationActive = activeInvocationIds.size;
    const interactiveInvocationIds = this.interactiveInvocationIds();
    // The correlated snapshot is process-local only. Without it, retain the
    // legacy count callback and conservatively treat every interactive run as
    // unmatched rather than guessing ownership from its lifecycle state.
    const interactive = interactiveInvocationIds?.length ?? this.interactiveCount();
    const matchedInteractive = interactiveInvocationIds?.reduce(
      (matched, invocationId) => matched + (invocationId !== undefined && activeInvocationIds.has(invocationId) ? 1 : 0),
      0,
    ) ?? 0;
    const unmatchedInteractive = interactive - matchedInteractive;
    const active = clamp(unmatchedInteractive + Math.max(invocationActive, scheduler.active, matchedInteractive));
    const queued = clamp(scheduler.queued);
    const completed = clamp(this.terminalCounts.completed);
    const failed = clamp(this.terminalCounts.failed);
    const cancelled = clamp(this.terminalCounts.cancelled);
    const determinate = snapshot.active.filter((item) => item.progress !== undefined);
    const progressTotal = determinate.reduce((total, item) => clamp(total + (item.progress?.total ?? 0)), 0);
    const progressCompleted = determinate.reduce((total, item) => clamp(total + (item.progress?.completed ?? 0)), 0);
    const terminal = newTerminals.state ?? this.lastTerminal;
    const state: PresenceState = active > 0 ? "running" : queued > 0 ? "waiting" : terminal === "failed" ? "error" : terminal === "completed" ? "success" : terminal === "cancelled" ? "cancelled" : "idle";
    const meaningful = active > 0 || queued > 0 || newTerminals.state !== null;
    if (!this.current && !meaningful) return null;
    const attention: PresenceAttention = replay ? "none" : newTerminals.attention;
    const event: PiPresenceUpdate = {
      version: 1, sessionId: this.sessionId, generation: this.generation, sequence: this.nextSequence(), source: PI_SUBAGENT_PRESENCE_SOURCE, state,
      counts: { active, completed, failed, queued, cancelled, total: clamp(active + queued + completed + failed + cancelled) },
      ...(progressTotal > 0 ? { progress: { value: Math.min(1, progressCompleted / progressTotal), label: `Subagents ${progressCompleted}/${progressTotal}` } } : {}),
      attention,
    };
    const parsed = parsePiPresenceUpdate(event);
    return parsed ? { event: parsed, active, queued } : null;
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
  private interactiveInvocationIds(): readonly (string | undefined)[] | undefined {
    try {
      const value = this.getInteractiveActiveInvocationIds?.();
      return Array.isArray(value) && value.every((id) => id === undefined || typeof id === "string") ? value : undefined;
    } catch { return undefined; }
  }
  private nextSequence(): number { this.sequence += 1; return this.sequence; }
  private requestReady(): void {
    if (this.sessionId === null) return;
    const request: PiPresenceReady = Object.freeze({ version: 1, sessionId: this.sessionId });
    this.locallyEmittedReadyRequest = request;
    this.requestingReady = true;
    try { this.emitSafely(PI_PRESENCE_READY_EVENT, request); } finally {
      this.requestingReady = false;
      this.locallyEmittedReadyRequest = null;
    }
  }
  private removeCurrent(): void {
    if (!this.current || this.sessionId === null || this.generation === null) return;
    const remove = parsePiPresenceRemove({
      version: 1, sessionId: this.sessionId, generation: this.generation, sequence: this.nextSequence(), source: { id: PI_SUBAGENT_PRESENCE_SOURCE.id },
    });
    if (!remove) return;
    // Clear before emission so synchronous ready handlers cannot replay stale state.
    this.current = null;
    this.settlementDeferred = false;
    this.emitSafely(PI_PRESENCE_REMOVE_EVENT, freezePresenceRemove(remove));
  }
  private emitSafely(channel: string, event: PiPresenceUpdate | PiPresenceRemove | PiPresenceReady): void { try { this.emit(channel, event); } catch { /* Event observers are never lifecycle authority. */ } }
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
function freezePresenceRemove(event: PiPresenceRemove): PiPresenceRemove {
  return Object.freeze({ ...event, source: Object.freeze({ ...event.source }) });
}
function generationNumber(value: unknown): value is number { return generation(value); }
function safeCount(value: unknown): number { return count(value) ? value : 0; }
function clamp(value: number): number { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_PRESENCE_COUNT) : 0; }

export function createPiSubagentPresenceProducer(options: PiSubagentPresenceProducerOptions): PiSubagentPresenceProducer {
  return new PiSubagentPresenceProducer(options);
}
