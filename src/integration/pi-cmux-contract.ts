import type { SubagentUxStatus } from "../core/subagent-ux.js";

/** Public, process-local Pi event names for parent dashboard consumers. */
export const PI_SUBAGENT_DASHBOARD_EVENT = "pi-subagent:dashboard:v1" as const;
export const PI_SUBAGENT_AGGREGATE_COMPLETED_EVENT = "pi-subagent:aggregate-completed:v1" as const;
export const PI_SUBAGENT_DETACHED_EVENT = "pi-subagent:detached:v1" as const;

export type PiSubagentDashboardEventName = typeof PI_SUBAGENT_DASHBOARD_EVENT;
export type PiSubagentAggregateCompletedEventName = typeof PI_SUBAGENT_AGGREGATE_COMPLETED_EVENT;
export type PiSubagentDetachedEventName = typeof PI_SUBAGENT_DETACHED_EVENT;

export type PiSubagentInvocationKind = "foreground" | "background";
export type PiSubagentActiveStatus = "running" | "cancelling";
export type PiSubagentTerminalStatus = "completed" | "failed" | "cancelled";
export type PiSubagentDetachedBackend = "cmux-pane" | "tmux-pane" | "herdr-pane";

export interface PiSubagentDashboardActiveItem {
  readonly id: string;
  readonly agent: string;
  readonly kind: PiSubagentInvocationKind;
  readonly status: PiSubagentActiveStatus;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface PiSubagentDashboardCounts {
  readonly running: number;
  readonly cancelling: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly schedulerActive: number;
  readonly schedulerQueued: number;
  readonly interactiveActive: number;
}

export interface PiSubagentDashboardPayload {
  readonly version: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly emittedAt: number;
  readonly counts: PiSubagentDashboardCounts;
  readonly active: readonly PiSubagentDashboardActiveItem[];
}

export interface PiSubagentAggregateInvocation {
  readonly id: string;
  readonly agent: string;
  readonly kind: PiSubagentInvocationKind;
  readonly status: PiSubagentTerminalStatus;
  readonly startedAt: number;
  readonly completedAt: number;
}

export interface PiSubagentAggregateCompletedPayload {
  readonly version: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly emittedAt: number;
  readonly invocation: PiSubagentAggregateInvocation;
}

export interface PiSubagentDetachedPayload {
  readonly version: 1;
  readonly sessionId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly emittedAt: number;
  readonly runId: string;
  readonly agent: string;
  readonly backend: PiSubagentDetachedBackend;
  readonly detachedAt: number;
}

export interface PiSubagentUxSnapshotItem {
  readonly id: string;
  readonly agent: string;
  readonly kind: PiSubagentInvocationKind;
  readonly status: SubagentUxStatus;
  readonly generation: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface PiSubagentUxSnapshotLike {
  readonly generation: number;
  readonly active: readonly PiSubagentUxSnapshotItem[];
  readonly recent: readonly PiSubagentUxSnapshotItem[];
}

export interface PiSubagentDashboardPublisherOptions {
  readonly emit: (channel: string, payload: unknown) => void;
  readonly getSchedulerCounts: () => { readonly active: number; readonly queued: number };
  readonly getInteractiveActiveCount: () => number;
  readonly now?: () => number;
  readonly rememberedTerminalLimit?: number;
}

const MAX_STRING_LENGTH = 256;
const MAX_ACTIVE_ITEMS = 64;
const DEFAULT_REMEMBERED_TERMINAL_LIMIT = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const ACTIVE_STATUSES = new Set<PiSubagentActiveStatus>(["running", "cancelling"]);
const TERMINAL_STATUSES = new Set<PiSubagentTerminalStatus>(["completed", "failed", "cancelled"]);
const KINDS = new Set<PiSubagentInvocationKind>(["foreground", "background"]);
const DETACHED_BACKENDS = new Set<PiSubagentDetachedBackend>(["cmux-pane", "tmux-pane", "herdr-pane"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isSafeText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING_LENGTH && !CONTROL_CHARACTERS.test(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isVersion(value: unknown): value is 1 {
  return value === 1;
}

function isKind(value: unknown): value is PiSubagentInvocationKind {
  return typeof value === "string" && KINDS.has(value as PiSubagentInvocationKind);
}

function isActiveStatus(value: unknown): value is PiSubagentActiveStatus {
  return typeof value === "string" && ACTIVE_STATUSES.has(value as PiSubagentActiveStatus);
}

function isTerminalStatus(value: unknown): value is PiSubagentTerminalStatus {
  return typeof value === "string" && TERMINAL_STATUSES.has(value as PiSubagentTerminalStatus);
}

function hasValidEnvelope(value: Record<string, unknown>): boolean {
  return isVersion(value.version)
    && isSafeText(value.sessionId)
    && isNonNegativeSafeInteger(value.generation)
    && isPositiveSafeInteger(value.sequence)
    && isNonNegativeFinite(value.emittedAt);
}

function isDashboardItem(value: unknown): value is PiSubagentDashboardActiveItem {
  if (!isObject(value) || !hasExactKeys(value, ["id", "agent", "kind", "status", "startedAt", "updatedAt"])) return false;
  return isSafeText(value.id)
    && isSafeText(value.agent)
    && isKind(value.kind)
    && isActiveStatus(value.status)
    && isNonNegativeFinite(value.startedAt)
    && isNonNegativeFinite(value.updatedAt)
    && value.updatedAt >= value.startedAt;
}

function isDashboardCounts(value: unknown): value is PiSubagentDashboardCounts {
  const keys = ["running", "cancelling", "completed", "failed", "cancelled", "schedulerActive", "schedulerQueued", "interactiveActive"];
  return isObject(value) && hasExactKeys(value, keys) && keys.every((key) => isNonNegativeSafeInteger(value[key]));
}

export function isPiSubagentDashboardPayload(value: unknown): value is PiSubagentDashboardPayload {
  if (!isObject(value) || !hasExactKeys(value, ["version", "sessionId", "generation", "sequence", "emittedAt", "counts", "active"])) return false;
  return hasValidEnvelope(value)
    && isDashboardCounts(value.counts)
    && Array.isArray(value.active)
    && value.active.length <= MAX_ACTIVE_ITEMS
    && value.active.every(isDashboardItem);
}

export function parsePiSubagentDashboardPayload(value: unknown): PiSubagentDashboardPayload | null {
  return isPiSubagentDashboardPayload(value) ? value : null;
}

export function isPiSubagentAggregateCompletedPayload(value: unknown): value is PiSubagentAggregateCompletedPayload {
  if (!isObject(value) || !hasExactKeys(value, ["version", "sessionId", "generation", "sequence", "emittedAt", "invocation"]) || !hasValidEnvelope(value)) return false;
  const invocation = value.invocation;
  return isObject(invocation)
    && hasExactKeys(invocation, ["id", "agent", "kind", "status", "startedAt", "completedAt"])
    && isSafeText(invocation.id)
    && isSafeText(invocation.agent)
    && isKind(invocation.kind)
    && isTerminalStatus(invocation.status)
    && isNonNegativeFinite(invocation.startedAt)
    && isNonNegativeFinite(invocation.completedAt)
    && invocation.completedAt >= invocation.startedAt;
}

export function parsePiSubagentAggregateCompletedPayload(value: unknown): PiSubagentAggregateCompletedPayload | null {
  return isPiSubagentAggregateCompletedPayload(value) ? value : null;
}

export function isPiSubagentDetachedPayload(value: unknown): value is PiSubagentDetachedPayload {
  if (!isObject(value) || !hasExactKeys(value, ["version", "sessionId", "generation", "sequence", "emittedAt", "runId", "agent", "backend", "detachedAt"]) || !hasValidEnvelope(value)) return false;
  return isSafeText(value.runId)
    && isSafeText(value.agent)
    && typeof value.backend === "string"
    && DETACHED_BACKENDS.has(value.backend as PiSubagentDetachedBackend)
    && isNonNegativeFinite(value.detachedAt);
}

export function parsePiSubagentDetachedPayload(value: unknown): PiSubagentDetachedPayload | null {
  return isPiSubagentDetachedPayload(value) ? value : null;
}

function safeCounter(value: unknown): number {
  return isNonNegativeSafeInteger(value) ? value : 0;
}

function dashboardItemFromSnapshot(item: PiSubagentUxSnapshotItem): PiSubagentDashboardActiveItem | null {
  const candidate = {
    id: item.id,
    agent: item.agent,
    kind: item.kind,
    status: item.status,
    startedAt: item.startedAt,
    updatedAt: item.updatedAt,
  };
  return isDashboardItem(candidate) ? candidate : null;
}

function aggregateInvocationFromSnapshot(item: PiSubagentUxSnapshotItem): PiSubagentAggregateInvocation | null {
  const { id, agent, kind, status, startedAt, completedAt } = item;
  if (!isSafeText(id)
    || !isSafeText(agent)
    || !isKind(kind)
    || !isTerminalStatus(status)
    || !isNonNegativeFinite(startedAt)
    || !isNonNegativeFinite(completedAt)
    || completedAt < startedAt) return null;
  return { id, agent, kind, status, startedAt, completedAt };
}

/**
 * Converts session-local UX state into the public, intentionally narrow Pi
 * event contract. It never receives child task/output data and swallows
 * observers' emit failures so run tracking remains independent of listeners.
 */
export class PiSubagentDashboardPublisher {
  private readonly emit: PiSubagentDashboardPublisherOptions["emit"];
  private readonly getSchedulerCounts: PiSubagentDashboardPublisherOptions["getSchedulerCounts"];
  private readonly getInteractiveActiveCount: PiSubagentDashboardPublisherOptions["getInteractiveActiveCount"];
  private readonly now: () => number;
  private readonly rememberedTerminalLimit: number;
  private readonly rememberedTerminalIds = new Map<string, true>();
  private readonly detachedRunIds = new Set<string>();
  private sessionId: string | null = null;
  private generation: number | null = null;
  private sequence = 0;

  constructor(options: PiSubagentDashboardPublisherOptions) {
    if (!Number.isSafeInteger(options.rememberedTerminalLimit ?? DEFAULT_REMEMBERED_TERMINAL_LIMIT) || (options.rememberedTerminalLimit ?? DEFAULT_REMEMBERED_TERMINAL_LIMIT) < 1) {
      throw new Error("Pi subagent dashboard remembered terminal limit must be a positive safe integer.");
    }
    this.emit = options.emit;
    this.getSchedulerCounts = options.getSchedulerCounts;
    this.getInteractiveActiveCount = options.getInteractiveActiveCount;
    this.now = options.now ?? (() => Date.now());
    this.rememberedTerminalLimit = options.rememberedTerminalLimit ?? DEFAULT_REMEMBERED_TERMINAL_LIMIT;
  }

  get rememberedTerminalCount(): number {
    return this.rememberedTerminalIds.size;
  }

  startSession(sessionId: string, generation: number): void {
    if (!isSafeText(sessionId) || !isNonNegativeSafeInteger(generation)) throw new Error("Invalid Pi subagent dashboard session fence.");
    this.sessionId = sessionId;
    this.generation = generation;
    this.sequence = 0;
    this.rememberedTerminalIds.clear();
    this.detachedRunIds.clear();
  }

  stop(): void {
    this.sessionId = null;
    this.generation = null;
    this.rememberedTerminalIds.clear();
    this.detachedRunIds.clear();
  }

  publish(snapshot: PiSubagentUxSnapshotLike): boolean {
    if (this.sessionId === null || this.generation === null || !isNonNegativeSafeInteger(snapshot.generation) || snapshot.generation !== this.generation) return false;
    const scheduler = this.safeSchedulerCounts();
    const active = snapshot.active
      .map(dashboardItemFromSnapshot)
      .filter((item): item is PiSubagentDashboardActiveItem => item !== null)
      .slice(0, MAX_ACTIVE_ITEMS);
    const counts: PiSubagentDashboardCounts = {
      running: snapshot.active.filter((item) => item.status === "running").length,
      cancelling: snapshot.active.filter((item) => item.status === "cancelling").length,
      completed: snapshot.recent.filter((item) => item.status === "completed").length,
      failed: snapshot.recent.filter((item) => item.status === "failed").length,
      cancelled: snapshot.recent.filter((item) => item.status === "cancelled").length,
      schedulerActive: scheduler.active,
      schedulerQueued: scheduler.queued,
      interactiveActive: this.safeInteractiveActiveCount(),
    };
    const dashboard: PiSubagentDashboardPayload = {
      version: 1,
      sessionId: this.sessionId,
      generation: this.generation,
      sequence: this.nextSequence(),
      emittedAt: this.safeNow(),
      counts,
      active,
    };
    if (isPiSubagentDashboardPayload(dashboard)) this.emitSafely(PI_SUBAGENT_DASHBOARD_EVENT, dashboard);

    for (const item of snapshot.recent) {
      const invocation = aggregateInvocationFromSnapshot(item);
      if (!invocation || this.rememberedTerminalIds.has(invocation.id)) continue;
      this.remember(invocation.id);
      const aggregate: PiSubagentAggregateCompletedPayload = {
        version: 1,
        sessionId: this.sessionId,
        generation: this.generation,
        sequence: this.nextSequence(),
        emittedAt: this.safeNow(),
        invocation,
      };
      if (isPiSubagentAggregateCompletedPayload(aggregate)) this.emitSafely(PI_SUBAGENT_AGGREGATE_COMPLETED_EVENT, aggregate);
    }
    return true;
  }

  /** Emits one fenced public detachment event per run in the active session. */
  publishDetached(value: { runId: string; agent: string; backend: PiSubagentDetachedBackend; detachedAt: number }): boolean {
    if (this.sessionId === null || this.generation === null || this.detachedRunIds.has(value.runId)
      || !isSafeText(value.runId) || !isSafeText(value.agent) || !DETACHED_BACKENDS.has(value.backend)
      || !isPositiveSafeInteger(value.detachedAt)) return false;
    const payload: PiSubagentDetachedPayload = {
      version: 1,
      sessionId: this.sessionId,
      generation: this.generation,
      sequence: this.nextSequence(),
      emittedAt: this.safeNow(),
      runId: value.runId,
      agent: value.agent,
      backend: value.backend,
      detachedAt: value.detachedAt,
    };
    if (!isPiSubagentDetachedPayload(payload)) return false;
    this.detachedRunIds.add(value.runId);
    this.emitSafely(PI_SUBAGENT_DETACHED_EVENT, payload);
    return true;
  }

  private safeSchedulerCounts(): { active: number; queued: number } {
    try {
      const counts = this.getSchedulerCounts();
      return { active: safeCounter(counts?.active), queued: safeCounter(counts?.queued) };
    } catch {
      return { active: 0, queued: 0 };
    }
  }

  private safeInteractiveActiveCount(): number {
    try {
      return safeCounter(this.getInteractiveActiveCount());
    } catch {
      return 0;
    }
  }

  private safeNow(): number {
    try {
      const value = this.now();
      return isNonNegativeFinite(value) ? value : Date.now();
    } catch {
      return Date.now();
    }
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private remember(id: string): void {
    this.rememberedTerminalIds.set(id, true);
    while (this.rememberedTerminalIds.size > this.rememberedTerminalLimit) {
      const oldest = this.rememberedTerminalIds.keys().next().value;
      if (oldest === undefined) break;
      this.rememberedTerminalIds.delete(oldest);
    }
  }

  private emitSafely(channel: string, payload: unknown): void {
    try { this.emit(channel, payload); } catch { /* Event listeners are not part of registry lifecycle. */ }
  }
}

export function createPiSubagentDashboardPublisher(options: PiSubagentDashboardPublisherOptions): PiSubagentDashboardPublisher {
  return new PiSubagentDashboardPublisher(options);
}
