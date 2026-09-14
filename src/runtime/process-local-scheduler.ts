/** Process-local, invocation-fair permit scheduler for child launches. */

import { MAX_SUBAGENT_ACTIVE } from "../core/subagent-limits.js";

export const DEFAULT_MAX_ACTIVE = 16;
export const SUBAGENT_MAX_ACTIVE_ENV = "PI_SUBAGENT_MAX_ACTIVE";

export function parsePositiveSafeInteger(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_SUBAGENT_ACTIVE ? parsed : null;
}

/** CLI > environment > default. Invalid configured values are ignored with a warning. */
export function resolveMaxActive(options: {
  env?: NodeJS.ProcessEnv;
  runtimeFlag?: unknown;
  warn?: (message: string) => void;
} = {}): number {
  const env = options.env ?? process.env;
  const warn = options.warn ?? console.warn;
  const runtimeValue = options.runtimeFlag;
  const runtimeParsed = parsePositiveSafeInteger(runtimeValue);
  if (runtimeValue !== undefined && runtimeValue !== null && runtimeParsed === null) {
    warn(`[pi-subagent] Ignoring invalid --subagent-max-active value "${String(runtimeValue)}". Expected a positive safe integer at most ${MAX_SUBAGENT_ACTIVE}.`);
  }
  if (runtimeParsed !== null) return runtimeParsed;

  const envValue = env[SUBAGENT_MAX_ACTIVE_ENV];
  const envParsed = parsePositiveSafeInteger(envValue);
  if (envValue !== undefined && envParsed === null) {
    warn(`[pi-subagent] Ignoring invalid ${SUBAGENT_MAX_ACTIVE_ENV}="${envValue}". Expected a positive safe integer at most ${MAX_SUBAGENT_ACTIVE}.`);
  }
  return envParsed ?? DEFAULT_MAX_ACTIVE;
}

export interface SchedulerHandle { readonly generation: number; readonly id: number; }
export type ScheduledResult<T> = { started: true; value: T } | { started: false };

export interface SchedulerTimingMetricsSnapshot {
  readonly count: number;
  readonly sumMs: number;
  readonly maxMs: number;
}

/** Fixed-size, process-local metrics for the current host-session epoch. */
export interface ProcessLocalSchedulerMetricsSnapshot {
  readonly epoch: number;
  readonly accepted: number;
  readonly started: number;
  readonly cancelledBeforeStart: number;
  readonly settled: number;
  readonly enqueueToDispatch: SchedulerTimingMetricsSnapshot;
  readonly dispatchToLocalSlotRelease: SchedulerTimingMetricsSnapshot;
}

export interface ProcessLocalSchedulerOptions {
  /** Optional monotonic clock seam. Invalid values and errors skip that timing sample. */
  readonly clock?: () => number;
}

/** Immutable scheduler state delivered to local observers after each transition. */
export interface ProcessLocalSchedulerState {
  readonly active: number;
  readonly queued: number;
  readonly maxActive: number;
  readonly accepting: boolean;
  readonly generation: number;
}

export type ProcessLocalSchedulerObserver = (state: ProcessLocalSchedulerState) => void;

interface SchedulerTimingMetrics {
  count: number;
  sumMs: number;
  maxMs: number;
}

interface SchedulerMetricsState {
  epoch: number;
  accepted: number;
  started: number;
  cancelledBeforeStart: number;
  settled: number;
  enqueueToDispatch: SchedulerTimingMetrics;
  dispatchToLocalSlotRelease: SchedulerTimingMetrics;
}

interface QueueEntry<T> {
  handle: SchedulerHandle;
  launch: () => Promise<T>;
  resolve: (result: ScheduledResult<T>) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
  queued: boolean;
  metrics: SchedulerMetricsState;
  enqueuedAt: number | null;
}

interface InvocationQueue {
  handle: SchedulerHandle;
  entries: QueueEntry<any>[];
}

/**
 * Keeps one FIFO queue per tool invocation and selects queues round-robin.
 * It intentionally has no cross-process coordination: every child Pi gets
 * its own pool, avoiding nested-delegation permit deadlocks.
 */
const MAX_METRIC_VALUE = Number.MAX_SAFE_INTEGER;

function saturatingIncrement(value: number): number {
  return value < MAX_METRIC_VALUE ? value + 1 : MAX_METRIC_VALUE;
}

function saturatingAdd(left: number, right: number): number {
  return left >= MAX_METRIC_VALUE - right ? MAX_METRIC_VALUE : left + right;
}

function createMetricsState(epoch = 0): SchedulerMetricsState {
  return {
    epoch,
    accepted: 0,
    started: 0,
    cancelledBeforeStart: 0,
    settled: 0,
    enqueueToDispatch: { count: 0, sumMs: 0, maxMs: 0 },
    dispatchToLocalSlotRelease: { count: 0, sumMs: 0, maxMs: 0 },
  };
}

export class ProcessLocalScheduler {
  /** All generations share this capacity counter until each launch releases. */
  private totalActive = 0;
  /** Dashboard/observer projection is limited to the current generation. */
  private readonly activeByGeneration = new Map<number, number>();
  private nextHandleId = 1;
  private generation = 0;
  private accepting = true;
  private queues: InvocationQueue[] = [];
  private lastDispatchedHandleId: number | null = null;
  private readonly observers = new Set<ProcessLocalSchedulerObserver>();
  private metrics = createMetricsState();
  private readonly clock: () => number;
  /** Clock callbacks are observational and must not recursively drive scheduling. */
  private readingClock = false;

  private configuredMaxActive: number;

  constructor(maxActive: number = DEFAULT_MAX_ACTIVE, options: ProcessLocalSchedulerOptions = {}) {
    if (!Number.isSafeInteger(maxActive) || maxActive <= 0 || maxActive > MAX_SUBAGENT_ACTIVE) {
      throw new Error(`maxActive must be a positive safe integer at most ${MAX_SUBAGENT_ACTIVE}.`);
    }
    this.configuredMaxActive = maxActive;
    this.clock = options.clock ?? (() => performance.now());
  }

  get maxActive(): number { return this.configuredMaxActive; }

  /**
   * Starts a new observational epoch without changing scheduler generation or
   * capacity. The host must call this before cancelling the prior session.
   */
  resetMetrics(): void {
    this.metrics = createMetricsState(saturatingIncrement(this.metrics.epoch));
  }

  getMetricsSnapshot(): ProcessLocalSchedulerMetricsSnapshot {
    const snapshotTiming = (timing: SchedulerTimingMetrics): SchedulerTimingMetricsSnapshot => Object.freeze({
      count: timing.count,
      sumMs: timing.sumMs,
      maxMs: timing.maxMs,
    });
    return Object.freeze({
      epoch: this.metrics.epoch,
      accepted: this.metrics.accepted,
      started: this.metrics.started,
      cancelledBeforeStart: this.metrics.cancelledBeforeStart,
      settled: this.metrics.settled,
      enqueueToDispatch: snapshotTiming(this.metrics.enqueueToDispatch),
      dispatchToLocalSlotRelease: snapshotTiming(this.metrics.dispatchToLocalSlotRelease),
    });
  }

  private setMaxActive(maxActive: number): void {
    if (!Number.isSafeInteger(maxActive) || maxActive <= 0 || maxActive > MAX_SUBAGENT_ACTIVE) {
      throw new Error(`maxActive must be a positive safe integer at most ${MAX_SUBAGENT_ACTIVE}.`);
    }
    this.configuredMaxActive = maxActive;
  }

  createHandle(): SchedulerHandle {
    if (!this.accepting) throw new Error("Subagent scheduler is shutting down.");
    return { generation: this.generation, id: this.nextHandleId++ };
  }

  /**
   * Observers are process-local and non-authoritative. They receive a frozen
   * snapshot immediately and after every scheduler state transition.
   */
  subscribe(observer: ProcessLocalSchedulerObserver): () => void {
    this.observers.add(observer);
    this.notify(observer);
    return () => { this.observers.delete(observer); };
  }

  startSession(maxActive = this.configuredMaxActive): void {
    this.setMaxActive(maxActive);
    // A duplicate/reordered lifecycle event must not let an old invocation
    // survive into the new generation. Active launches release normally.
    for (const queue of this.queues) {
      for (const entry of queue.entries.splice(0)) this.cancelQueued(entry);
    }
    this.queues = [];
    this.lastDispatchedHandleId = null;
    this.generation += 1;
    this.accepting = true;
    this.notifyObservers();
  }

  shutdown(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const queue of this.queues) {
      for (const entry of queue.entries.splice(0)) this.cancelQueued(entry);
    }
    this.queues = [];
    this.lastDispatchedHandleId = null;
    this.notifyObservers();
  }

  get activeCount(): number { return this.activeByGeneration.get(this.generation) ?? 0; }
  get queuedCount(): number { return this.queues.reduce((count, queue) => count + queue.entries.length, 0); }

  schedule<T>(handle: SchedulerHandle, launch: () => Promise<T>, signal?: AbortSignal): Promise<ScheduledResult<T>> {
    if (!this.accepting || handle.generation !== this.generation || signal?.aborted) {
      return Promise.resolve({ started: false });
    }
    // Sample before changing queue state: an injected clock may synchronously
    // start a new session, shut down, or schedule other work.
    const enqueuedAt = this.readClock();
    if (!this.accepting || handle.generation !== this.generation || signal?.aborted) {
      return Promise.resolve({ started: false });
    }
    return new Promise<ScheduledResult<T>>((resolve, reject) => {
      const metrics = this.metrics;
      metrics.accepted = saturatingIncrement(metrics.accepted);
      const entry: QueueEntry<T> = { handle, launch, resolve, reject, signal, queued: true, metrics, enqueuedAt };
      entry.abortListener = () => {
        if (!entry.queued) return;
        this.removeQueued(entry as QueueEntry<any>);
        this.cancelQueued(entry as QueueEntry<any>);
      };
      if (signal) signal.addEventListener("abort", entry.abortListener, { once: true });
      let queue = this.queues.find((candidate) => candidate.handle.id === handle.id && candidate.handle.generation === handle.generation);
      if (!queue) {
        queue = { handle, entries: [] };
        this.queues.push(queue);
      }
      queue.entries.push(entry as QueueEntry<any>);
      this.notifyObservers();
      this.dispatch();
    });
  }

  private removeQueued(entry: QueueEntry<any>): void {
    const queueIndex = this.queues.findIndex((queue) => queue.entries.includes(entry));
    if (queueIndex < 0) return;
    const queue = this.queues[queueIndex]!;
    queue.entries.splice(queue.entries.indexOf(entry), 1);
    if (queue.entries.length === 0) {
      this.queues.splice(queueIndex, 1);
    }
    this.notifyObservers();
  }

  private cancelQueued(entry: QueueEntry<any>): void {
    if (!entry.queued) return;
    entry.queued = false;
    this.recordCancelledBeforeStart(entry.metrics);
    if (entry.signal && entry.abortListener) entry.signal.removeEventListener("abort", entry.abortListener);
    entry.resolve({ started: false });
    this.notifyObservers();
  }

  private dispatch(): void {
    while (this.accepting && this.totalActive < this.maxActive && this.queues.length > 0) {
      // Sample before selecting/removing an entry. A clock callback is allowed
      // to re-enter lifecycle/scheduling code, so selection must use the state
      // it leaves behind rather than a stale queue entry.
      const dispatchedAt = this.readClock();
      if (!this.accepting || this.totalActive >= this.maxActive || this.queues.length === 0) continue;

      // Handles are monotonically registered within a generation. Pick the
      // next queued handle after the previous winner, wrapping at the end.
      // Keeping the cursor even while that handle is active prevents a fast
      // invocation from re-enqueueing ahead of already-waiting peers.
      const ordered = this.queues
        .map((queue, index) => ({ queue, index }))
        .sort((left, right) => left.queue.handle.id - right.queue.handle.id);
      const selected = this.lastDispatchedHandleId === null
        ? ordered[0]!
        : ordered.find(({ queue }) => queue.handle.id > this.lastDispatchedHandleId!) ?? ordered[0]!;
      const queue = selected.queue;
      const entry = queue.entries.shift()!;
      this.lastDispatchedHandleId = queue.handle.id;
      if (queue.entries.length === 0) this.queues.splice(selected.index, 1);
      if (!entry.queued || entry.signal?.aborted || entry.handle.generation !== this.generation || !this.accepting || this.totalActive >= this.maxActive) {
        this.cancelQueued(entry);
        continue;
      }
      entry.queued = false;
      if (entry.signal && entry.abortListener) entry.signal.removeEventListener("abort", entry.abortListener);
      this.recordStarted(entry.metrics, entry.enqueuedAt, dispatchedAt);
      this.incrementActive(entry.handle.generation);
      this.notifyObservers();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        // Read before changing capacity for the same re-entrancy guarantee.
        const releasedAt = this.readClock();
        this.releaseActive(entry.handle.generation);
        this.recordSettled(entry.metrics, dispatchedAt, releasedAt);
        this.notifyObservers();
        this.dispatch();
      };
      void Promise.resolve()
        .then(entry.launch)
        .then((value) => entry.resolve({ started: true, value }), (error) => entry.reject(error))
        .finally(release);
    }
  }

  private readClock(): number | null {
    if (this.readingClock) return null;
    this.readingClock = true;
    try {
      const value = this.clock();
      return Number.isFinite(value) && value >= 0 ? Math.min(value, MAX_METRIC_VALUE) : null;
    } catch {
      return null;
    } finally {
      this.readingClock = false;
    }
  }

  private recordTiming(timing: SchedulerTimingMetrics, start: number | null, end: number | null): void {
    if (start === null || end === null) return;
    const elapsed = Math.min(Math.max(0, end - start), MAX_METRIC_VALUE);
    timing.count = saturatingIncrement(timing.count);
    timing.sumMs = saturatingAdd(timing.sumMs, elapsed);
    timing.maxMs = Math.max(timing.maxMs, elapsed);
  }

  private recordStarted(metrics: SchedulerMetricsState, enqueuedAt: number | null, dispatchedAt: number | null): void {
    if (metrics !== this.metrics) return;
    metrics.started = saturatingIncrement(metrics.started);
    this.recordTiming(metrics.enqueueToDispatch, enqueuedAt, dispatchedAt);
  }

  private recordCancelledBeforeStart(metrics: SchedulerMetricsState): void {
    if (metrics === this.metrics) metrics.cancelledBeforeStart = saturatingIncrement(metrics.cancelledBeforeStart);
  }

  private recordSettled(metrics: SchedulerMetricsState, dispatchedAt: number | null, releasedAt: number | null): void {
    if (metrics !== this.metrics) return;
    metrics.settled = saturatingIncrement(metrics.settled);
    this.recordTiming(metrics.dispatchToLocalSlotRelease, dispatchedAt, releasedAt);
  }

  private incrementActive(generation: number): void {
    this.totalActive += 1;
    this.activeByGeneration.set(generation, (this.activeByGeneration.get(generation) ?? 0) + 1);
  }

  private releaseActive(generation: number): void {
    // Releases can arrive after startSession. They must free shared capacity
    // without decrementing the replacement session's projected active count.
    if (this.totalActive > 0) this.totalActive -= 1;
    const count = this.activeByGeneration.get(generation) ?? 0;
    if (count <= 1) this.activeByGeneration.delete(generation);
    else this.activeByGeneration.set(generation, count - 1);
  }

  private snapshot(): ProcessLocalSchedulerState {
    return Object.freeze({
      active: this.activeCount,
      queued: this.queuedCount,
      maxActive: this.maxActive,
      accepting: this.accepting,
      generation: this.generation,
    });
  }

  private notify(observer: ProcessLocalSchedulerObserver): void {
    try { observer(this.snapshot()); } catch { /* Observers cannot affect scheduling. */ }
  }

  private notifyObservers(): void {
    for (const observer of this.observers) this.notify(observer);
  }
}
