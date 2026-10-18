import { createHash } from "node:crypto";

export const MAX_PARENT_REPORT_MEMO = 256;
export const PARENT_REPORT_MEMO_TTL_MS = 10 * 60_000;
type Entry<T> = { payloadHash: string; promise: Promise<T>; settledAt?: number };
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Process-local, session-generation scoped replay, NOT durable exactly-once.
 * Keep settled results/errors for ten minutes from settlement; never evict active
 * or unexpired entries. At capacity reject new IDs without dispatch. Hash both
 * ID and normalized payload so settled entries retain neither arbitrary IDs nor
 * report bodies. Pending operations alone own their bounded transport payload. */
export class ParentReportMemo<T> {
  private entries = new Map<string, Entry<T>>();
  private generation = 0;
  private closed = false;
  constructor(private readonly now: () => number = () => performance.now()) {}
  reset(): void { this.generation++; this.entries.clear(); this.closed = false; }
  close(): void { this.reset(); this.closed = true; }
  run(id: string, payload: string, operation: (eligible: () => boolean) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Direct-parent reporting is unsupported or unavailable for this run."));
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.settledAt !== undefined && now - entry.settledAt >= PARENT_REPORT_MEMO_TTL_MS) this.entries.delete(key);
    }
    // JSON encoding also distinguishes distinct lone-surrogate IDs, which
    // would otherwise share UTF-8 replacement bytes when hashed directly.
    const key = hash(JSON.stringify(id)), payloadHash = hash(payload), existing = this.entries.get(key);
    if (existing) {
      if (existing.payloadHash !== payloadHash) return Promise.reject(new Error("Parent report tool-call ID conflicts with an earlier payload or kind."));
      return this.replay(existing.promise);
    }
    if (this.entries.size >= MAX_PARENT_REPORT_MEMO) return Promise.reject(new Error("Parent report replay capacity is full; no report was sent."));
    const generation = this.generation;
    // Install the promise before invoking operation, including synchronous throws
    // and reentrant calls. Replays share the first caller's cancellation outcome.
    const entry: Entry<T> = { payloadHash, promise: Promise.resolve().then(() => operation(() => !this.closed && generation === this.generation)) };
    this.entries.set(key, entry);
    entry.promise = entry.promise.then(value => {
      entry.settledAt = this.now();
      return structuredClone(value);
    }, error => {
      entry.settledAt = this.now();
      throw error;
    });
    return this.replay(entry.promise);
  }
  private replay(promise: Promise<T>): Promise<T> {
    return promise.then(value => structuredClone(value), error => { throw structuredClone(error); });
  }
}
