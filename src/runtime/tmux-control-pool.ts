import { createTmuxControlCommandRunner, TmuxControlClient } from "./tmux-control.mjs";
import { recordPhase0LiveTelemetry } from "./phase0-live-telemetry.mjs";

export interface TmuxControlCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  aborted: boolean;
  dispatched?: boolean;
}

export interface TmuxControlAuthority {
  controlContract: string;
  executableGeneration: { realpath: string; dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
  canonicalSocketPath: string;
  socketDev: number;
  socketIno: number;
  serverPid: number;
  serverStartedAt: number;
  attachedSessionId: string;
  sourcePaneId: string;
  sourcePanePid: number;
  sourceWindowId: string;
}

export type TmuxControlRun = (args: string[], options?: { signal?: AbortSignal }) => Promise<TmuxControlCommandResult>;
type ControlClient = Pick<TmuxControlClient, "close" | "notificationSequence" | "lastNotificationAt" | "waitForNotification">;
type StartedClient = ControlClient & { execute: TmuxControlClient["execute"] };

export interface TmuxControlLeaseOptions {
  authority: TmuxControlAuthority;
  /** Creates and starts a parent-only client. Detached brokers and reapers never use this pool. */
  createClient: (onDisconnect: () => void) => Promise<StartedClient>;
  /**
   * Run-specific proof performed on a serialized, newly accepted generation.
   * It must verify the immutable V3 gate digest and the executable, socket,
   * server, source/session/window, and exact target identities.
   */
  revalidate: (run: TmuxControlRun) => Promise<boolean>;
}

type Entry = {
  /** Opaque process-local identity; never expose authority paths or IDs. */
  transportKey: string;
  authority: TmuxControlAuthority;
  client: StartedClient | null;
  run: TmuxControlRun | null;
  epoch: number;
  leases: Set<TmuxControlLease>;
  reconnecting: Promise<boolean> | null;
  physicalConnects: number;
  closing: boolean;
};

const entries = new Map<string, Entry>();
let nextTransportKey = 0;
let shutdownEpoch = 0;
let shuttingDown = false;

/** Full physical tmux authority; do not weaken this to socket/session alone. */
export function tmuxControlAuthorityKey(authority: TmuxControlAuthority): string {
  return JSON.stringify(authority);
}

function unavailable(message: string): TmuxControlCommandResult {
  return { exitCode: 1, stdout: "", stderr: message, aborted: false };
}

function poison(entry: Entry): void {
  if (!entry.client && !entry.run) return;
  entry.client = null;
  entry.run = null;
  entry.epoch += 1;
  for (const lease of entry.leases) lease.notifyDisconnect();
}

async function connect(entry: Entry, options: TmuxControlLeaseOptions): Promise<boolean> {
  if (shuttingDown || entry.closing) return false;
  if (entry.client && entry.run) return true;
  if (entry.reconnecting) return await entry.reconnecting;
  const fence = shutdownEpoch;
  entry.reconnecting = (async () => {
    let client: StartedClient | null = null;
    try {
      client = await options.createClient(() => poison(entry));
      if (shuttingDown || entry.closing || fence !== shutdownEpoch) {
        client.close();
        return false;
      }
      const run = createTmuxControlCommandRunner(client as TmuxControlClient, entry.authority.canonicalSocketPath) as TmuxControlRun;
      if (!await options.revalidate(run) || shuttingDown || entry.closing || fence !== shutdownEpoch) {
        client.close();
        return false;
      }
      entry.client = client;
      entry.run = run;
      if (entry.physicalConnects > 0) {
        recordPhase0LiveTelemetry("tmux", "reconnects");
        recordPhase0LiveTelemetry("tmux", "persistentClientRestarts");
      }
      entry.physicalConnects += 1;
      entry.epoch += 1;
      return true;
    } catch {
      client?.close();
      return false;
    } finally {
      entry.reconnecting = null;
    }
  })();
  return await entry.reconnecting;
}

/**
 * Opaque accepted shared-transport identity for active read batching. It has no
 * socket, process, session, pane, or other authority material.
 */
export interface TmuxControlAcceptedTransport {
  readonly epoch: number;
  readonly key: string;
}

export class TmuxControlLease {
  private released = false;
  private acceptedEpoch = -1;
  private notificationCursor = 0;
  private readonly disconnectListeners = new Set<() => void>();

  constructor(private readonly entry: Entry, private readonly options: TmuxControlLeaseOptions) {}

  /** Serialized per-physical-client command runner. Stale generations fail closed. */
  readonly run: TmuxControlRun = async (args, options) => {
    if (this.released || this.acceptedEpoch !== this.entry.epoch || !this.entry.run) return unavailable("tmux control generation is unavailable");
    return await this.entry.run(args, options);
  };

  /**
   * Returns only an opaque pool key and the exact accepted epoch. A caller may
   * use this for read-only single-flight keys, never as mutation authority.
   */
  acceptedTransport(): TmuxControlAcceptedTransport | null {
    if (this.released || this.acceptedEpoch !== this.entry.epoch || !this.entry.client || !this.entry.run) return null;
    return { epoch: this.acceptedEpoch, key: this.entry.transportKey };
  }

  notificationSequence(): number { return this.entry.client?.notificationSequence() ?? this.notificationCursor; }
  lastNotificationAt(): number | null { return this.entry.client?.lastNotificationAt() ?? null; }
  isConnected(): boolean { return this.acceptedTransport() !== null; }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  notifyDisconnect(): void {
    for (const listener of this.disconnectListeners) {
      try { listener(); } catch { /* observer only */ }
    }
  }

  /** Each lease independently proves its own authority before accepting an epoch. */
  async reconnect(): Promise<boolean> {
    // A prior acceptance must not authorize mutations while this lease proves a
    // healthy shared generation (or while that generation changes underneath it).
    this.acceptedEpoch = -1;
    if (this.released || shuttingDown || this.entry.closing) return false;
    const connected = await connect(this.entry, this.options);
    if (!connected || !this.entry.client || !this.entry.run) return false;
    const client = this.entry.client;
    const run = this.entry.run;
    const epoch = this.entry.epoch;
    let revalidated = false;
    try {
      // A shared healthy client still requires this run's own durable/live proof.
      revalidated = await this.options.revalidate(run);
    } catch {
      // Proof errors are fail-closed just like a negative proof result.
    }
    if (!revalidated || this.released || shuttingDown || this.entry.closing
      || this.entry.client !== client || this.entry.run !== run || this.entry.epoch !== epoch) return false;
    this.acceptedEpoch = epoch;
    this.notificationCursor = client.notificationSequence();
    return true;
  }

  /** Independent cursor prevents one run's wait from consuming another's hint. */
  async waitForNotification(timeoutMs: number): Promise<"notification" | "timeout" | "disconnect"> {
    if (!this.isConnected() || !this.entry.client) return "disconnect";
    const client = this.entry.client;
    if (client.notificationSequence() !== this.notificationCursor) {
      this.notificationCursor = client.notificationSequence();
      return "notification";
    }
    const reason = await client.waitForNotification(timeoutMs);
    if (reason === "notification") this.notificationCursor = client.notificationSequence();
    return reason;
  }

  /** Idempotent lease release; the final release closes only this pool entry. */
  release(): void {
    if (this.released) return;
    this.released = true;
    this.disconnectListeners.clear();
    this.entry.leases.delete(this);
    if (this.entry.leases.size !== 0) return;
    this.entry.closing = true;
    const key = tmuxControlAuthorityKey(this.entry.authority);
    if (entries.get(key) === this.entry) entries.delete(key);
    this.entry.client?.close();
    poison(this.entry);
  }
}

export async function acquireTmuxControlLease(options: TmuxControlLeaseOptions): Promise<TmuxControlLease | null> {
  if (shuttingDown) return null;
  const key = tmuxControlAuthorityKey(options.authority);
  let entry = entries.get(key);
  if (!entry) {
    entry = { transportKey: `tmux-transport-${++nextTransportKey}`, authority: options.authority, client: null, run: null, epoch: 0, leases: new Set(), reconnecting: null, physicalConnects: 0, closing: false };
    entries.set(key, entry);
  }
  const lease = new TmuxControlLease(entry, options);
  entry.leases.add(lease);
  if (await lease.reconnect()) return lease;
  lease.release();
  return null;
}

/** Fences in-flight connects and permanently rejects new leases for this process lifecycle. */
export function shutdownTmuxControlPool(): void {
  shuttingDown = true;
  shutdownEpoch += 1;
  for (const entry of [...entries.values()]) {
    entry.closing = true;
    entries.delete(tmuxControlAuthorityKey(entry.authority));
    entry.client?.close();
    poison(entry);
  }
}

/**
 * Starts a new interactive-session generation after fencing every old client.
 * Old leases keep their orphaned entries so their final release cannot affect a
 * replacement entry with the same authority key.
 */
export function resetTmuxControlPoolForNewSession(): void {
  shutdownTmuxControlPool();
  shuttingDown = false;
  shutdownEpoch += 1;
}

/** Test-only alias for an explicit new-session transition. */
export function resetTmuxControlPoolForTest(): void {
  resetTmuxControlPoolForNewSession();
}

export function snapshotTmuxControlPoolForTest(): { entries: number; leases: number; clients: number } {
  const values = [...entries.values()];
  return { entries: values.length, leases: values.reduce((count, entry) => count + entry.leases.size, 0), clients: values.filter((entry) => entry.client !== null).length };
}
