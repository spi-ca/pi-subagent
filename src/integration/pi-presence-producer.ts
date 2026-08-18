import {
  createPresenceProducer,
  type PresenceEventV2,
  type PresenceProducerHandle,
  type PresenceStateInputV2,
  type TerminalOutcome,
} from "@pi/presence";
import type { SubagentUxRegistrySnapshot, SubagentUxSnapshot } from "../core/subagent-ux.js";

export const PI_SUBAGENT_PRESENCE_SOURCE = "subagent" as const;
export const MAX_PRESENCE_COUNT = 1_000_000;
const MAX_REMEMBERED_TERMINALS = 4_096;

type TerminalStatus = Extract<SubagentUxSnapshot["status"], "completed" | "failed" | "cancelled">;
type TerminalSnapshot = SubagentUxSnapshot & { readonly status: TerminalStatus };
type Aggregate = Readonly<{ running: number; cancelling: number; queued: number; completed: number; failed: number; cancelled: number; omitted: number }>;
type RecentTerminalWindow = Readonly<{ terminals: readonly TerminalSnapshot[]; omitted: number }>;

export interface PiSubagentPresenceProducerOptions {
  /** Same-process event bus only; it is never lifecycle authority. */
  readonly emit: (channel: string, payload: unknown) => void;
  readonly getSchedulerCounts: () => { readonly active: number; readonly queued: number };
  /** Legacy aggregate fallback when an atomic interactive identity snapshot is unavailable. */
  readonly getInteractiveActiveCount: () => number;
  /** Process-local identity correlation only. These IDs are never emitted. */
  readonly getInteractiveActiveInvocationIds?: () => readonly (string | undefined)[];
}

/** Root-only V2 observer projection. Execution, cancellation, and accounting stay outside it. */
export class PiSubagentPresenceProducer {
  private readonly emit: PiSubagentPresenceProducerOptions["emit"];
  private readonly getSchedulerCounts: PiSubagentPresenceProducerOptions["getSchedulerCounts"];
  private readonly getInteractiveActiveCount: PiSubagentPresenceProducerOptions["getInteractiveActiveCount"];
  private readonly getInteractiveActiveInvocationIds: PiSubagentPresenceProducerOptions["getInteractiveActiveInvocationIds"];
  /** Immutable UX-registry generation; it is only a local equality fence. */
  private uxGeneration: number | null = null;
  /** Mutable V2 lifecycle generation. It may reset after a source-handle rotation. */
  private wireGeneration: number | null = null;
  private readonly previousRecentTerminalIds = new Set<string>();
  private producer: PresenceProducerHandle | undefined;
  private sourceActive = false;
  private sequence = -1;
  private terminalOrdinal = -1;
  private opened = false;
  private settlementDeferred = false;
  private terminalCounts = { completed: 0, failed: 0, cancelled: 0 };
  private lastTerminal: TerminalStatus | null = null;
  private lastAggregate: Pick<Aggregate, "running" | "cancelling" | "queued"> | null = null;
  private recentOmitted = 0;

  constructor(options: PiSubagentPresenceProducerOptions) {
    this.emit = options.emit;
    this.getSchedulerCounts = options.getSchedulerCounts;
    this.getInteractiveActiveCount = options.getInteractiveActiveCount;
    this.getInteractiveActiveInvocationIds = options.getInteractiveActiveInvocationIds;
  }

  /** `sessionId` remains caller-private; V2 events never contain it. */
  startSession(_sessionId: string, generation: number): boolean {
    this.stop();
    if (!validUxGeneration(generation)) return false;
    const producer = createPresenceProducer({
      source: PI_SUBAGENT_PRESENCE_SOURCE,
      emit: (channel: string, event: PresenceEventV2) => this.emit(channel, event),
    });
    if (!producer || !safeCall(() => producer.activate())) return false;
    this.producer = producer;
    this.sourceActive = true;
    this.uxGeneration = generation;
    // A fresh producer handle always begins at the bounded wire origin.
    this.wireGeneration = 0;
    this.sequence = -1;
    this.terminalOrdinal = -1;
    this.opened = false;
    this.settlementDeferred = false;
    this.previousRecentTerminalIds.clear();
    this.terminalCounts = { completed: 0, failed: 0, cancelled: 0 };
    this.lastTerminal = null;
    this.lastAggregate = null;
    this.recentOmitted = 0;
    return true;
  }

  stop(): void {
    // Clean stop must remove retained registry state even when withdrawal is
    // unexpectedly rejected; it is the only teardown path allowed to force it.
    this.withdrawCurrent();
    try { this.producer?.deactivate(); } catch { /* observer teardown is best effort */ }
    this.producer = undefined;
    this.sourceActive = false;
    this.uxGeneration = null;
    this.wireGeneration = null;
    this.sequence = -1;
    this.terminalOrdinal = -1;
    this.opened = false;
    this.settlementDeferred = false;
    this.previousRecentTerminalIds.clear();
    this.lastAggregate = null;
    this.recentOmitted = 0;
  }

  publish(snapshot: SubagentUxRegistrySnapshot): boolean {
    // Fence before inspecting recent IDs: stale callbacks must not consume
    // dedupe memory, terminal counts, or aggregate state.
    if (!this.producer || this.uxGeneration === null || this.wireGeneration === null || snapshot.generation !== this.uxGeneration) return false;
    const recentTerminals = newestTerminalWindow(snapshot.recent);
    const fresh = this.freshTerminals(recentTerminals.terminals);
    const aggregate = this.aggregate(snapshot);
    const meaningful = aggregate.running > 0 || aggregate.cancelling > 0 || aggregate.queued > 0 || fresh.length > 0;
    if (!this.opened && !meaningful) return false;
    if (!this.opened && !this.openLifecycle()) return false;
    if (!this.ensurePublicationCapacity(fresh.length)) return false;

    let emitted = false;
    const acceptedIds = new Set<string>();
    let failureEdge = false;
    for (const terminal of fresh) {
      const eventId = this.terminalOrdinal + 1;
      const eventSequence = this.sequence + 1;
      const accepted = safeCall(() => this.producer!.publishTerminal({
        version: 2,
        generation: this.wireGeneration!,
        sequence: eventSequence,
        source: PI_SUBAGENT_PRESENCE_SOURCE,
        eventId,
        outcome: outcomeFor(terminal.status),
      }));
      if (!accepted) continue; // A rejected terminal remains eligible on the next snapshot.
      this.sequence = eventSequence;
      this.terminalOrdinal = eventId;
      this.commitTerminal(terminal);
      acceptedIds.add(terminal.id);
      failureEdge ||= terminal.status === "failed";
      emitted = true;
    }
    this.rememberCurrentRecent(recentTerminals, acceptedIds);
    // Terminal acceptance changes cumulative counts and possibly the bounded
    // omitted accounting; build the state from that completed projection.
    const projected = this.aggregate(snapshot);

    const stateSequence = this.sequence + 1;
    const state = projected.running + projected.cancelling > 0
      ? "running"
      : projected.queued > 0
        ? "waiting"
        : this.lastTerminal === "failed"
          ? "error"
          : this.lastTerminal === "completed"
            ? "success"
            : this.lastTerminal === "cancelled"
              ? "cancelled"
              : "idle";
    const event: PresenceStateInputV2 = {
      version: 2,
      generation: this.wireGeneration,
      sequence: stateSequence,
      source: PI_SUBAGENT_PRESENCE_SOURCE,
      state,
      subagents: projected,
      ...(progressFor(snapshot.active)),
      ...(failureEdge ? { attention: { reason: "failure" as const, occurrence: "new" as const } } : {}),
    };
    const stateAccepted = safeCall(() => this.producer!.publishState(event));
    if (!stateAccepted) return emitted;
    this.sequence = stateSequence;
    this.lastAggregate = { running: projected.running, cancelling: projected.cancelling, queued: projected.queued };
    emitted = true;
    if (this.settlementDeferred && this.isLastAggregateQuiescent()) this.withdrawCurrent();
    return emitted;
  }

  beginAgentRun(): void { this.settlementDeferred = false; }

  settle(): void {
    if (!this.opened || !this.lastAggregate) return;
    if (this.isLastAggregateQuiescent()) this.withdrawCurrent();
    else this.settlementDeferred = true;
  }

  private openLifecycle(): boolean {
    if (!this.producer || this.wireGeneration === null) return false;
    if (this.opened) return true;
    if (!this.sourceActive && !safeCall(() => this.producer!.activate())) return false;
    this.sourceActive = true;
    // A normal withdrawal tombstones its wire generation. Advance it while
    // possible; at the boundary rotate the source handle so shared fences reset.
    if (this.sequence >= 0) {
      if (this.wireGeneration < MAX_PRESENCE_COUNT) {
        this.wireGeneration += 1;
        this.sequence = -1;
        this.terminalOrdinal = -1;
      } else if (!this.rotateSource()) {
        return false;
      }
    }
    this.opened = true;
    return true;
  }

  /** Atomically rotate before normal publication would consume withdrawal room. */
  private ensurePublicationCapacity(terminals: number): boolean {
    if (!this.opened || this.wireGeneration === null || !Number.isSafeInteger(terminals) || terminals < 0) return false;
    // Keep ordinal MAX available for a withdrawal. Event IDs may use MAX, but
    // a batch that would exceed it rotates before any terminal dedupe/count mutation.
    const needsRotation = this.sequence + terminals + 1 > MAX_PRESENCE_COUNT - 1
      || this.terminalOrdinal + terminals > MAX_PRESENCE_COUNT;
    if (!needsRotation) return true;
    if (!this.withdrawCurrent()) return false;
    if (!this.rotateSource()) return false;
    this.opened = true;
    return true;
  }

  /** Deactivation clears registry ingress and consumer fences before reset ordinals are reused. */
  private rotateSource(): boolean {
    if (!this.producer || !this.sourceActive) return false;
    if (!safeCall(() => this.producer!.deactivate())) return false;
    this.sourceActive = false;
    if (!safeCall(() => this.producer!.activate())) return false;
    this.sourceActive = true;
    this.wireGeneration = 0;
    this.sequence = -1;
    this.terminalOrdinal = -1;
    return true;
  }

  /** Returns false without changing lifecycle state when shared ingress rejects withdrawal. */
  private withdrawCurrent(): boolean {
    if (!this.producer || this.wireGeneration === null || !this.opened) return false;
    const nextSequence = this.sequence + 1;
    if (nextSequence > MAX_PRESENCE_COUNT) return false;
    const withdrawn = safeCall(() => this.producer!.withdraw({
      version: 2,
      generation: this.wireGeneration!,
      sequence: nextSequence,
      source: PI_SUBAGENT_PRESENCE_SOURCE,
    }));
    if (!withdrawn) return false;
    this.sequence = nextSequence;
    this.opened = false;
    this.settlementDeferred = false;
    return true;
  }

  private aggregate(snapshot: SubagentUxRegistrySnapshot): Aggregate {
    const scheduler = this.schedulerCounts();
    const active = this.aggregateInvocationCounts(snapshot.active, scheduler.active);
    return Object.freeze({
      running: active.running,
      cancelling: active.cancelling,
      queued: clamp(scheduler.queued),
      completed: this.terminalCounts.completed,
      failed: this.terminalCounts.failed,
      cancelled: this.terminalCounts.cancelled,
      omitted: this.recentOmitted,
    });
  }

  /**
   * `SubagentUxRegistry` records one item per invocation, while the scheduler
   * records one item per child launch. Do not subtract an invocation-level
   * cancelling count from a child-level scheduler count: a cancelling parallel
   * invocation would otherwise appear to have still-running siblings.
   *
   * Exact interactive IDs can add an invocation that has not reached the UX
   * registry yet. Scheduler active count is only a no-identity fallback.
   */
  private aggregateInvocationCounts(active: readonly SubagentUxSnapshot[], schedulerActive: number): Pick<Aggregate, "running" | "cancelling"> {
    const runningIds = new Set(active.filter((item) => item.status === "running").map((item) => item.id));
    const cancellingIds = new Set(active.filter((item) => item.status === "cancelling").map((item) => item.id));
    for (const id of cancellingIds) runningIds.delete(id);
    const knownIds = new Set([...runningIds, ...cancellingIds]);
    const interactiveIds = this.interactiveInvocationIds();
    if (interactiveIds) {
      // Several parallel interactive children can belong to one invocation.
      // Their shared ID must remain one invocation-level running count.
      const unmatchedKnownIds = new Set(interactiveIds.filter((id): id is string => id !== undefined && !knownIds.has(id)));
      const unmatchedUnknownRuns = interactiveIds.filter((id) => id === undefined).length;
      return {
        running: clamp(runningIds.size + unmatchedKnownIds.size + unmatchedUnknownRuns),
        cancelling: clamp(cancellingIds.size),
      };
    }
    if (knownIds.size > 0) return { running: clamp(runningIds.size), cancelling: clamp(cancellingIds.size) };
    // Compatibility fallback for callers that cannot provide exact identities.
    return { running: clamp(Math.max(schedulerActive, this.interactiveCount())), cancelling: 0 };
  }

  /** Freshness is bounded by the newest-first terminal window, not session history. */
  private freshTerminals(terminals: readonly TerminalSnapshot[]): TerminalSnapshot[] {
    return terminals.filter((item) => !this.previousRecentTerminalIds.has(item.id)).sort(compareTerminalOldestFirst);
  }

  private commitTerminal(terminal: TerminalSnapshot): void {
    this.terminalCounts[terminal.status] = clamp(this.terminalCounts[terminal.status] + 1);
    // Events are emitted oldest-to-newest, so the final accepted event owns state.
    this.lastTerminal = terminal.status;
  }

  private rememberCurrentRecent(recent: RecentTerminalWindow, acceptedIds: ReadonlySet<string>): void {
    const next = new Set<string>();
    // Never consume a locally rejected terminal: preserve only previous or
    // successfully emitted records from this exact newest-first window.
    for (const terminal of recent.terminals) {
      if (this.previousRecentTerminalIds.has(terminal.id) || acceptedIds.has(terminal.id)) next.add(terminal.id);
    }
    this.previousRecentTerminalIds.clear();
    for (const id of next) this.previousRecentTerminalIds.add(id);
    this.recentOmitted = recent.omitted;
  }

  private isLastAggregateQuiescent(): boolean {
    return this.lastAggregate !== null && this.lastAggregate.running + this.lastAggregate.cancelling + this.lastAggregate.queued === 0;
  }

  private schedulerCounts(): { active: number; queued: number } {
    try {
      const value = this.getSchedulerCounts();
      return { active: clamp(value?.active ?? 0), queued: clamp(value?.queued ?? 0) };
    } catch { return { active: 0, queued: 0 }; }
  }
  private interactiveCount(): number { try { return clamp(this.getInteractiveActiveCount()); } catch { return 0; } }
  private interactiveInvocationIds(): readonly (string | undefined)[] | undefined {
    try {
      const ids = this.getInteractiveActiveInvocationIds?.();
      return Array.isArray(ids) && ids.every((id) => id === undefined || typeof id === "string") ? ids : undefined;
    } catch { return undefined; }
  }
}

function progressFor(active: readonly SubagentUxSnapshot[]): Pick<PresenceStateInputV2, "progress"> {
  const determinate = active.filter((item) => item.progress && validProgress(item.progress.completed, item.progress.total));
  if (determinate.length === 0) return {};
  const completed = determinate.reduce((sum, item) => sum + item.progress!.completed, 0);
  const total = determinate.reduce((sum, item) => sum + item.progress!.total, 0);
  return validProgress(completed, total) ? { progress: { completed, total } } : {};
}
/** Select the newest unique terminal IDs before any freshness or retention work. */
function newestTerminalWindow(recent: readonly SubagentUxSnapshot[]): RecentTerminalWindow {
  const seen = new Set<string>();
  const terminals: TerminalSnapshot[] = [];
  let omitted = 0;
  for (const item of recent) {
    if (!isTerminal(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    if (terminals.length < MAX_REMEMBERED_TERMINALS) terminals.push(item);
    else omitted = clamp(omitted + 1);
  }
  return { terminals, omitted };
}
function compareTerminalOldestFirst(left: TerminalSnapshot, right: TerminalSnapshot): number {
  return (left.completedAt ?? left.updatedAt) - (right.completedAt ?? right.updatedAt) || left.id.localeCompare(right.id);
}
function validProgress(completed: number, total: number): boolean { return validOrdinal(total) && total >= 1 && validOrdinal(completed) && completed <= total; }
function isTerminal(item: SubagentUxSnapshot): item is TerminalSnapshot { return item.status === "completed" || item.status === "failed" || item.status === "cancelled"; }
function outcomeFor(status: TerminalStatus): TerminalOutcome { return status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled"; }
function validUxGeneration(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validOrdinal(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PRESENCE_COUNT; }
function clamp(value: number): number { return validOrdinal(value) ? value : value > MAX_PRESENCE_COUNT ? MAX_PRESENCE_COUNT : 0; }
function safeCall(callback: () => boolean): boolean { try { return callback() === true; } catch { return false; } }

export function createPiSubagentPresenceProducer(options: PiSubagentPresenceProducerOptions): PiSubagentPresenceProducer {
  return new PiSubagentPresenceProducer(options);
}
