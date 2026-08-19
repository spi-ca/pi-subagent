/**
 * Generation-scoped, read-only topology single-flight.
 *
 * This deliberately retains no settled values: callers may share only an
 * in-flight observation. Lifecycle mutation, final absence confirmation, and
 * recovery must continue to obtain their own exact fresh observation.
 */
export type TopologySnapshot<T> =
  | { readonly state: "known"; readonly value: T }
  | { readonly state: "unknown" };

export interface TopologySnapshotBatchMetrics {
  readonly fetches: number;
  readonly joins: number;
  readonly unknown: number;
}

export interface TopologySnapshotBatchOptions {
  /** A bounded read failure is unknown, never absence. */
  timeoutMs?: number;
}

type InFlight<T> = {
  /** Completes at the caller's timeout boundary, if one is configured. */
  readonly result: Promise<TopologySnapshot<T>>;
  /** Completes only after the backend stops, so a timed-out fetch remains single-flight. */
  readonly settled: Promise<void>;
};

/**
 * A process-local batcher keyed by an explicit generation and canonical key.
 * Callers own canonicalization and strict per-handle parsing of the returned
 * raw snapshot. Entries are always removed as soon as the fetch settles.
 */
export class TopologySnapshotBatch {
  private readonly inFlight = new Map<string, InFlight<unknown>>();
  private readonly timeoutMs?: number;
  private fetches = 0;
  private joins = 0;
  private unknown = 0;

  constructor(options: TopologySnapshotBatchOptions = {}) {
    this.timeoutMs = options.timeoutMs;
  }

  async read<T>(options: {
    generation: number;
    key: string;
    /** Internal fetches receive cancellation from the bounded observation. */
    fetch: (signal: AbortSignal) => Promise<T | undefined>;
    /** Reject a malformed shared response before any waiter can treat it as evidence. */
    validate?: (value: T) => boolean;
  }): Promise<TopologySnapshot<T>> {
    if (!Number.isSafeInteger(options.generation) || options.generation < 0 || !options.key) {
      this.unknown += 1;
      return { state: "unknown" };
    }
    const mapKey = `${options.generation}\u0000${options.key}`;
    const existing = this.inFlight.get(mapKey) as InFlight<T> | undefined;
    if (existing) {
      this.joins += 1;
      const snapshot = await existing.result;
      if (snapshot.state === "unknown") this.unknown += 1;
      return snapshot;
    }

    this.fetches += 1;
    const inFlight = this.fetchSnapshot(options.fetch, options.validate);
    this.inFlight.set(mapKey, inFlight as InFlight<unknown>);
    // A timeout returns unknown to callers, but this entry stays registered
    // until its backend has stopped. Otherwise a non-cooperative backend could
    // be multiplied by every retry after the timeout.
    void inFlight.settled.finally(() => {
      if (this.inFlight.get(mapKey) === inFlight) this.inFlight.delete(mapKey);
    });
    const snapshot = await inFlight.result;
    if (snapshot.state === "unknown") this.unknown += 1;
    return snapshot;
  }

  /** Drops only in-flight lookup references; it never promotes old evidence. */
  reset(): void {
    this.inFlight.clear();
  }

  metrics(): TopologySnapshotBatchMetrics {
    return { fetches: this.fetches, joins: this.joins, unknown: this.unknown };
  }

  private fetchSnapshot<T>(
    fetch: (signal: AbortSignal) => Promise<T | undefined>,
    validate?: (value: T) => boolean,
  ): InFlight<T> {
    const controller = new AbortController();
    const backend = Promise.resolve()
      .then(async () => await fetch(controller.signal))
      .then((value): TopologySnapshot<T> => {
        if (value === undefined) return { state: "unknown" };
        try {
          return validate && !validate(value) ? { state: "unknown" } : { state: "known", value };
        } catch {
          return { state: "unknown" };
        }
      })
      .catch((): TopologySnapshot<T> => ({ state: "unknown" }));

    if (this.timeoutMs === undefined) {
      return { result: backend, settled: backend.then(() => undefined) };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<TopologySnapshot<T>>((resolve) => {
      timer = setTimeout(() => {
        // Cooperative command runners terminate promptly; non-cooperative
        // runners stay registered through backend settlement below.
        controller.abort();
        resolve({ state: "unknown" });
      }, this.timeoutMs);
      timer.unref?.();
    });
    const result = Promise.race([backend, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    return { result, settled: backend.then(() => undefined) };
  }
}
