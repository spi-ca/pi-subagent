import type { SubagentUxRegistrySnapshot, SubagentUxSnapshot } from "../core/subagent-ux.js";

/** Duplicated wire contract: this package intentionally has no pi-cmux-presence dependency. */
export const PI_PRESENCE_UPDATE_EVENT = "pi-presence:update:v1" as const;
export const PI_PRESENCE_REMOVE_EVENT = "pi-presence:remove:v1" as const;
export const PI_PRESENCE_READY_EVENT = "pi-presence:ready:v1" as const;
/** Optional companion DTO; generic v1 update/remove behavior is unchanged. */
export const PI_PRESENCE_SUMMARY_EVENT = "pi-presence:summary:v1" as const;
export const PI_SUBAGENT_PRESENCE_SOURCE = { id: "pi-subagent", label: "Subagents", kind: "agent-group" } as const;

const MAX_TEXT = 96;
const MAX_ARRAY = 16;
const MAX_SUMMARY_ACTIVE = 8;
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
const SUMMARY_ROOT_KEYS = ["version", "sessionId", "generation", "sequence", "source", "active", "waiting", "terminal", "omitted"];
const SUMMARY_SOURCE_KEYS = ["id"];
const SUMMARY_ACTIVE_KEYS = ["id", "agent", "status", "category", "startedAt"];
const SUMMARY_WAITING_KEYS = ["category", "count"];
const SUMMARY_TERMINAL_KEYS = ["id", "agent", "status", "completedAt"];

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
export interface PiPresenceSummaryActive {
  readonly id: string;
  readonly agent: string;
  readonly status: "running" | "cancelling";
  readonly category: "active" | "cancelling";
  readonly startedAt: number;
}
export interface PiPresenceSummaryTerminal {
  readonly id: string;
  readonly agent: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly completedAt: number;
}
export interface PiPresenceSummaryWaiting {
  readonly category: "queued" | "cancelling";
  readonly count: number;
}
/** Capability-gated, intentionally sparse per-run observer summary. */
export interface PiPresenceSummary {
  readonly version: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly source: { readonly id: string };
  readonly active: readonly PiPresenceSummaryActive[];
  readonly waiting?: PiPresenceSummaryWaiting;
  readonly terminal?: PiPresenceSummaryTerminal;
  readonly omitted: number;
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
function snapshotDenseArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) return null;
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1 || !keys.every((key) => key === "length" || (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length))) return null;
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    values.push(descriptor.value);
  }
  return values;
}

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
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }

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

/** Total parser for the optional capability-gated summary DTO. */
export function parsePiPresenceSummary(value: unknown): PiPresenceSummary | null {
  try {
    const root = snapshotOwnDataFields(value, SUMMARY_ROOT_KEYS, ["version", "sessionId", "generation", "sequence", "source", "active", "omitted"]);
    if (!root || root.version !== 1 || !safeText(root.sessionId) || !generation(root.generation) || !sequence(root.sequence) || !count(root.omitted)) return null;
    const source = snapshotOwnDataFields(root.source, SUMMARY_SOURCE_KEYS, SUMMARY_SOURCE_KEYS);
    const active = snapshotDenseArray(root.active, MAX_SUMMARY_ACTIVE);
    if (!source || !safeText(source.id) || !active) return null;
    const parsedActive: PiPresenceSummaryActive[] = [];
    for (const rawItem of active) {
      const item = snapshotOwnDataFields(rawItem, SUMMARY_ACTIVE_KEYS, SUMMARY_ACTIVE_KEYS);
      if (!item || !safeText(item.id) || !safeText(item.agent) || (item.status !== "running" && item.status !== "cancelling")
        || (item.category !== "active" && item.category !== "cancelling") || !timestamp(item.startedAt)
        || (item.category === "cancelling") !== (item.status === "cancelling")) return null;
      parsedActive.push({ id: item.id, agent: item.agent, status: item.status, category: item.category, startedAt: item.startedAt });
    }
    let waiting: PiPresenceSummaryWaiting | undefined;
    if (hasOwn(root, "waiting")) {
      const rawWaiting = snapshotOwnDataFields(root.waiting, SUMMARY_WAITING_KEYS, SUMMARY_WAITING_KEYS);
      if (!rawWaiting || (rawWaiting.category !== "queued" && rawWaiting.category !== "cancelling") || !count(rawWaiting.count)) return null;
      waiting = { category: rawWaiting.category, count: rawWaiting.count };
    }
    let terminal: PiPresenceSummaryTerminal | undefined;
    if (hasOwn(root, "terminal")) {
      const rawTerminal = snapshotOwnDataFields(root.terminal, SUMMARY_TERMINAL_KEYS, SUMMARY_TERMINAL_KEYS);
      if (!rawTerminal || !safeText(rawTerminal.id) || !safeText(rawTerminal.agent)
        || (rawTerminal.status !== "completed" && rawTerminal.status !== "failed" && rawTerminal.status !== "cancelled") || !timestamp(rawTerminal.completedAt)) return null;
      terminal = { id: rawTerminal.id, agent: rawTerminal.agent, status: rawTerminal.status, completedAt: rawTerminal.completedAt };
    }
    return { version: 1, sessionId: root.sessionId, generation: root.generation, sequence: root.sequence, source: { id: source.id }, active: parsedActive, ...(waiting ? { waiting } : {}), ...(terminal ? { terminal } : {}), omitted: root.omitted };
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
  /** Cached only in-process; never emitted until a consumer advertises support. */
  private summary: PiPresenceSummary | null = null;
  /** Prevent nested ready advertisements from duplicating one update companion. */
  private summaryEmittedSequence: number | null = null;
  private readonly terminalIds = new Set<string>();
  /** Finalized invocation IDs fence accounting against duplicate completion callbacks. */
  private readonly usageInvocationIds = new Set<string>();
  private terminalCounts = { completed: 0, failed: 0, cancelled: 0 };
  private presenceUsage = { tokens: 0, cost: 0 };
  private lastTerminal: TerminalStatus | null = null;
  private unsubscribeReady: (() => void) | null = null;
  private cmuxStatusConsumerSeen = false;
  private presenceRemoveCapabilityDetected = false;
  private presenceSummaryCapabilityDetected = false;
  /** Keeps an update and its companion summary as one synchronous publication. */
  private publishing = false;
  /** Coalesces a consumer-less ready received while that publication is on-stack. */
  private replayPending = false;
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
    this.summary = null;
    this.summaryEmittedSequence = null;
    this.terminalIds.clear();
    this.usageInvocationIds.clear();
    this.terminalCounts = { completed: 0, failed: 0, cancelled: 0 };
    this.presenceUsage = { tokens: 0, cost: 0 };
    this.lastTerminal = null;
    this.cmuxStatusConsumerSeen = false;
    this.presenceRemoveCapabilityDetected = false;
    this.presenceSummaryCapabilityDetected = false;
    this.publishing = false;
    this.replayPending = false;
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
    this.summary = null;
    this.summaryEmittedSequence = null;
    this.cmuxStatusConsumerSeen = false;
    this.presenceRemoveCapabilityDetected = false;
    this.presenceSummaryCapabilityDetected = false;
    this.publishing = false;
    this.replayPending = false;
    this.replaying = false;
    this.locallyEmittedReadyRequest = null;
    this.requestingReady = false;
    this.settlementDeferred = false;
    this.terminalIds.clear();
    this.usageInvocationIds.clear();
    this.presenceUsage = { tokens: 0, cost: 0 };
  }

  /**
   * Project one finalized invocation's internal accounting to the already
   * declared generic v1 usage fields. This is observer-only and deliberately
   * does not accept partial updates or infer context usage.
   */
  recordFinalUsage(invocationId: unknown, generation: unknown, usage: unknown): boolean {
    if (this.sessionId === null || generation !== this.generation || typeof invocationId !== "string" || !safeText(invocationId)) return false;
    if (this.usageInvocationIds.has(invocationId) || this.usageInvocationIds.size >= MAX_REMEMBERED_TERMINALS) return false;
    if (!usage || typeof usage !== "object") return false;
    const value = usage as { totalTokens?: unknown; cost?: { total?: unknown } };
    const tokens = value.totalTokens;
    const cost = value.cost?.total;
    if (!metric(tokens) || !metric(cost)) return false;
    const nextTokens = this.presenceUsage.tokens + tokens;
    const nextCost = this.presenceUsage.cost + cost;
    // Never emit a malformed over-bound aggregate; retain the current safe
    // value rather than partially accepting a finalized invocation.
    if (!metric(nextTokens) || !metric(nextCost)) return false;
    this.usageInvocationIds.add(invocationId);
    this.presenceUsage = { tokens: nextTokens, cost: nextCost };
    return true;
  }

  publish(snapshot: SubagentUxRegistrySnapshot): boolean {
    if (this.sessionId === null || this.generation === null || snapshot.generation !== this.generation) return false;
    const newTerminal = this.rememberTerminals(snapshot.recent);
    const computed = this.makeUpdate(snapshot, newTerminal, false);
    if (!computed) return false;
    // Build and cache both companion snapshots before the synchronous generic
    // emit. A ready advertisement re-entering from that emit must see the
    // matching summary rather than the previous update's summary.
    this.current = freezePresenceUpdate(computed.event);
    this.summary = this.makeSummary(snapshot, computed.active, computed.queued, this.current.sequence);
    this.publishing = true;
    try {
      this.emitSafely(PI_PRESENCE_UPDATE_EVENT, this.current);
      // The synchronous update dispatch is now complete. A capability
      // advertisement received from any update listener can safely receive
      // this cached companion without overtaking later update listeners.
      this.emitSummary();
    } finally {
      this.publishing = false;
    }
    // A consumer-less ready can synchronously re-enter update emission. Drain
    // it only after this update's companion has been published.
    this.flushDeferredReplay();
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
    const summaryAdvertised = ready.consumer?.capabilities.includes("presence-summary-v1") === true;
    if (summaryAdvertised) this.presenceSummaryCapabilityDetected = true;
    if (!this.cmuxStatusConsumerSeen && ready.consumer?.id === "pi-cmux-presence" && ready.consumer.capabilities.includes("cmux-status")) {
      this.cmuxStatusConsumerSeen = true;
      try { this.onCmuxStatusConsumer?.(); } catch { /* UI routing is non-authoritative. */ }
    }
    if (ready.consumer) {
      // During an update dispatch, advertise capability only. The outer
      // publication emits the companion after every update listener returns.
      if (summaryAdvertised && !this.publishing) this.emitSummary();
      return;
    }
    if (!this.current || this.replaying) return;
    if (this.publishing) {
      this.replayPending = true;
      return;
    }
    this.emitReplay();
  }

  /** Publish a deferred discovery replay only after the active update's summary. */
  private flushDeferredReplay(): void {
    if (!this.replayPending || this.publishing || this.replaying) return;
    this.replayPending = false;
    this.emitReplay();
  }

  private emitReplay(): void {
    if (!this.current || this.replaying) return;
    const parsed = parsePiPresenceUpdate({ ...this.current, sequence: this.nextSequence(), attention: "none" });
    if (!parsed) return;
    this.current = freezePresenceUpdate(parsed);
    // Replay is one logical update: its companion uses precisely the replay
    // update sequence and does not consume a generic sequence of its own.
    this.summary = this.summary ? freezePresenceSummary(parsePiPresenceSummary({ ...this.summary, sequence: this.current.sequence }) ?? this.summary) : null;
    this.replaying = true;
    this.publishing = true;
    try {
      this.emitSafely(PI_PRESENCE_UPDATE_EVENT, this.current);
      this.emitSummary();
    } finally {
      this.publishing = false;
      this.replaying = false;
    }
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
      ...(this.presenceUsage.tokens > 0 || this.presenceUsage.cost > 0 ? { usage: { ...this.presenceUsage } } : {}),
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
    this.summary = null;
    this.summaryEmittedSequence = null;
    this.settlementDeferred = false;
    this.emitSafely(PI_PRESENCE_REMOVE_EVENT, freezePresenceRemove(remove));
  }
  private makeSummary(snapshot: SubagentUxRegistrySnapshot, activeCount: number, queuedCount: number, updateSequence: number): PiPresenceSummary | null {
    if (this.sessionId === null || this.generation === null) return null;
    const candidates = snapshot.active.filter((item): item is SubagentUxSnapshot & { status: "running" | "cancelling" } =>
      (item.status === "running" || item.status === "cancelling") && safeText(item.id) && safeText(item.agent) && timestamp(item.startedAt),
    ).sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
    const active = candidates.slice(0, MAX_SUMMARY_ACTIVE).map((item) => ({
      id: item.id, agent: item.agent, status: item.status,
      category: item.status === "cancelling" ? "cancelling" as const : "active" as const,
      startedAt: item.startedAt,
    }));
    const terminals = snapshot.recent.filter(isTerminalSnapshot).filter((item) => safeText(item.id) && safeText(item.agent) && timestamp(item.completedAt));
    const latest = terminals.reduce<TerminalSnapshot | null>((newest, item) => !newest || isNewerTerminal(item, newest) ? item : newest, null);
    const waiting = queuedCount > 0
      ? { category: "queued" as const, count: queuedCount }
      : candidates.length > 0 && candidates.every((item) => item.status === "cancelling")
        ? { category: "cancelling" as const, count: activeCount }
        : undefined;
    const parsed = parsePiPresenceSummary({
      // This companion belongs to its associated generic update. It never
      // allocates a sequence independently of update/remove.
      version: 1, sessionId: this.sessionId, generation: this.generation, sequence: updateSequence, source: { id: PI_SUBAGENT_PRESENCE_SOURCE.id },
      active, ...(waiting ? { waiting } : {}), omitted: clamp(Math.max(0, activeCount - active.length)),
      ...(latest?.completedAt !== undefined ? { terminal: { id: latest.id, agent: latest.agent, status: latest.status, completedAt: latest.completedAt } } : {}),
    });
    return parsed ? freezePresenceSummary(parsed) : null;
  }
  private emitSummary(): void {
    if (!this.presenceSummaryCapabilityDetected || !this.current || !this.summary || this.summary.sequence !== this.current.sequence || this.summaryEmittedSequence === this.summary.sequence) return;
    // Mark before synchronous emit so a re-entrant advertisement cannot emit
    // the same companion twice.
    this.summaryEmittedSequence = this.summary.sequence;
    this.emitSafely(PI_PRESENCE_SUMMARY_EVENT, this.summary);
  }
  private emitSafely(channel: string, event: PiPresenceUpdate | PiPresenceRemove | PiPresenceReady | PiPresenceSummary): void { try { this.emit(channel, event); } catch { /* Event observers are never lifecycle authority. */ } }
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
function freezePresenceSummary(event: PiPresenceSummary): PiPresenceSummary {
  return Object.freeze({
    ...event,
    source: Object.freeze({ ...event.source }),
    active: Object.freeze(event.active.map((item) => Object.freeze({ ...item }))),
    ...(event.waiting ? { waiting: Object.freeze({ ...event.waiting }) } : {}),
    ...(event.terminal ? { terminal: Object.freeze({ ...event.terminal }) } : {}),
  });
}
function generationNumber(value: unknown): value is number { return generation(value); }
function safeCount(value: unknown): number { return count(value) ? value : 0; }
function clamp(value: number): number { return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_PRESENCE_COUNT) : 0; }

export function createPiSubagentPresenceProducer(options: PiSubagentPresenceProducerOptions): PiSubagentPresenceProducer {
  return new PiSubagentPresenceProducer(options);
}
