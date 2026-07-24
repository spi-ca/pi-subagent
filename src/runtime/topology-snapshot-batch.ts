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

type InFlight<T> = Promise<TopologySnapshot<T>>;

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
    fetch: () => Promise<T | undefined>;
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
      const snapshot = await existing;
      if (snapshot.state === "unknown") this.unknown += 1;
      return snapshot;
    }

    this.fetches += 1;
    const fetch = this.fetchSnapshot(options.fetch, options.validate);
    this.inFlight.set(mapKey, fetch as InFlight<unknown>);
    try {
      const snapshot = await fetch;
      if (snapshot.state === "unknown") this.unknown += 1;
      return snapshot;
    } finally {
      // Do not cache settled evidence. A following poll must be fresh.
      if (this.inFlight.get(mapKey) === fetch) this.inFlight.delete(mapKey);
    }
  }

  /** Drops only in-flight lookup references; it never promotes old evidence. */
  reset(): void {
    this.inFlight.clear();
  }

  metrics(): TopologySnapshotBatchMetrics {
    return { fetches: this.fetches, joins: this.joins, unknown: this.unknown };
  }

  private async fetchSnapshot<T>(
    fetch: () => Promise<T | undefined>,
    validate?: (value: T) => boolean,
  ): Promise<TopologySnapshot<T>> {
    try {
      const value = this.timeoutMs === undefined
        ? await fetch()
        : await Promise.race<T | undefined>([
          fetch(),
          new Promise<undefined>((resolve) => setTimeout(resolve, this.timeoutMs)),
        ]);
      if (value === undefined) return { state: "unknown" };
      try {
        return validate && !validate(value) ? { state: "unknown" } : { state: "known", value };
      } catch {
        return { state: "unknown" };
      }
    } catch {
      return { state: "unknown" };
    }
  }
}
