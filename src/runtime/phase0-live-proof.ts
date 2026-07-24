import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { getProcessStartedAt } from "./run-protocol.js";

export const PHASE0_LIVE_GATE_ENV = "PI_SUBAGENT_PHASE0_LIVE";
export const PHASE0_LIVE_PROOF_SOCKET_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_SOCKET";
export const PHASE0_LIVE_PROOF_MASTER_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_MASTER";
export const PHASE0_LIVE_PROOF_ID_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_ID";
export const PHASE0_LIVE_PROOF_CAPABILITY_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_CAPABILITY";
/** Controller-only ordered list; it is consumed before a child is launched. */
export const PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_BARRIER_PATHS";
/** Controller-only 256-bit release tokens, positionally bound to BARRIER_PATHS. */
export const PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_TOKENS";
/** One exact FIFO path assigned to an individual benchmark child. */
export const PHASE0_LIVE_PROOF_BARRIER_PATH_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_BARRIER_PATH";
/** One 256-bit release token assigned only to that child. */
export const PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_TOKEN";
/** Absolute controller-issued release deadline, shared only with assigned children. */
export const PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_DEADLINE";
/** Exact post-proof behavior assigned by the benchmark controller. */
export const PHASE0_LIVE_PROOF_BEHAVIOR_ENV = "PI_SUBAGENT_PHASE0_LIVE_PROOF_BEHAVIOR";
export type Phase0LiveProofBehavior = "short" | "long" | "hold";
/** Fixed, redacted terminal states for authenticated children that never reached read-start. */
export const PHASE0_LIVE_PROOF_TERMINAL_CATEGORIES = ["provider-error", "settled-before-read", "shutdown-before-read", "aborted-before-read"] as const;
export type Phase0LiveProofTerminalCategory = (typeof PHASE0_LIVE_PROOF_TERMINAL_CATEGORIES)[number];
export type Phase0LiveProofTerminalCounts = Readonly<Record<Phase0LiveProofTerminalCategory, number>>;
/** Bounded, identity-free terminal state for fixed-assignment barrier diagnostics. */
export type Phase0LiveProofTerminalReport = Readonly<{ total: number; counts: Phase0LiveProofTerminalCounts }>;
export const MAX_PHASE0_LIVE_PROOF_RELEASE_WINDOW_MS = 30 * 60 * 1_000;
const MAX_FRAME_BYTES = 1024;
const MAX_DIAGNOSTIC_COUNT = 1_000_000;

export type Phase0LiveProofChildEnv = Record<typeof PHASE0_LIVE_PROOF_SOCKET_ENV | typeof PHASE0_LIVE_PROOF_ID_ENV | typeof PHASE0_LIVE_PROOF_CAPABILITY_ENV | typeof PHASE0_LIVE_PROOF_BARRIER_PATH_ENV | typeof PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV | typeof PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV | typeof PHASE0_LIVE_PROOF_BEHAVIOR_ENV, string>;
export type Phase0LiveProofIdentity = { pid: number; startedAt: number };

function isProofId(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{32}$/.test(value); }
function isCapability(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function isReleaseToken(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function isTerminalCategory(value: unknown): value is Phase0LiveProofTerminalCategory {
  return typeof value === "string" && (PHASE0_LIVE_PROOF_TERMINAL_CATEGORIES as readonly string[]).includes(value);
}
/** Reject non-canonical, expired, and implausibly distant wall-clock deadlines. */
export function parsePhase0LiveProofReleaseDeadline(value: unknown, now = Date.now()): number | null {
  if (typeof value !== "string" || !/^[1-9]\d{12,15}$/.test(value)) return null;
  const deadline = Number(value);
  if (!Number.isSafeInteger(deadline) || deadline <= now || deadline - now > MAX_PHASE0_LIVE_PROOF_RELEASE_WINDOW_MS) return null;
  return deadline;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function parseFrame(raw: string): Record<string, unknown> | null {
  if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) return null;
  try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; } catch { return null; }
}
function frame(value: object): string { const output = JSON.stringify(value); if (Buffer.byteLength(output) > MAX_FRAME_BYTES) throw new Error("Phase 0 proof frame exceeds its bound."); return `${output}\n`; }
function capability(master: Buffer, proofId: string): string { return crypto.createHmac("sha256", master).update(proofId, "utf8").digest("hex"); }
function validMaster(value: string | undefined): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }

export function derivePhase0LiveProofCapability(masterHex: string, proofId: string): string {
  if (!validMaster(masterHex) || !isProofId(proofId)) throw new Error("Invalid Phase 0 proof key material.");
  return capability(Buffer.from(masterHex, "hex"), proofId);
}

export function capturePhase0LiveProofClientEnv(env: NodeJS.ProcessEnv): Phase0LiveProofChildEnv | null {
  const socketPath = env[PHASE0_LIVE_PROOF_SOCKET_ENV], proofId = env[PHASE0_LIVE_PROOF_ID_ENV], cap = env[PHASE0_LIVE_PROOF_CAPABILITY_ENV], barrierPath = env[PHASE0_LIVE_PROOF_BARRIER_PATH_ENV], releaseToken = env[PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV], releaseDeadline = env[PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV], behavior = env[PHASE0_LIVE_PROOF_BEHAVIOR_ENV];
  const controllerMaterial = env[PHASE0_LIVE_PROOF_MASTER_ENV] !== undefined || env[PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV] !== undefined || env[PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV] !== undefined;
  const childMaterial = socketPath !== undefined || proofId !== undefined || cap !== undefined || barrierPath !== undefined || releaseToken !== undefined || releaseDeadline !== undefined || behavior !== undefined;
  // This is deliberately the first child-bridge action: neither capability nor
  // the private barrier assignment/release token/deadline may remain visible to a tool environment.
  for (const name of [PHASE0_LIVE_PROOF_SOCKET_ENV, PHASE0_LIVE_PROOF_MASTER_ENV, PHASE0_LIVE_PROOF_BARRIER_PATHS_ENV, PHASE0_LIVE_PROOF_RELEASE_TOKENS_ENV, PHASE0_LIVE_PROOF_ID_ENV, PHASE0_LIVE_PROOF_CAPABILITY_ENV, PHASE0_LIVE_PROOF_BARRIER_PATH_ENV, PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV, PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV, PHASE0_LIVE_PROOF_BEHAVIOR_ENV]) delete env[name];
  if (!childMaterial && !controllerMaterial) return null;
  if (env[PHASE0_LIVE_GATE_ENV] !== "1" || controllerMaterial || !socketPath || !path.isAbsolute(socketPath) || socketPath.length > 1024 || !isProofId(proofId) || !isCapability(cap) || !isReleaseToken(releaseToken) || !releaseDeadline || parsePhase0LiveProofReleaseDeadline(releaseDeadline) === null
    || !barrierPath || !path.isAbsolute(barrierPath) || path.normalize(barrierPath) !== barrierPath || barrierPath.length > 1024
    || (behavior !== "short" && behavior !== "long" && behavior !== "hold")) throw new Error("Phase 0 live proof child environment is incomplete.");
  return { [PHASE0_LIVE_PROOF_SOCKET_ENV]: socketPath, [PHASE0_LIVE_PROOF_ID_ENV]: proofId, [PHASE0_LIVE_PROOF_CAPABILITY_ENV]: cap, [PHASE0_LIVE_PROOF_BARRIER_PATH_ENV]: barrierPath, [PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV]: releaseToken, [PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]: releaseDeadline, [PHASE0_LIVE_PROOF_BEHAVIOR_ENV]: behavior };
}

export class Phase0LiveProofClient {
  #socket: net.Socket | null = null;
  #started = false;
  #authenticated = false;
  #readStarted = false;
  #proved = false;
  #terminal = false;
  constructor(private readonly config: Phase0LiveProofChildEnv) {}
  async start(): Promise<void> {
    if (this.#started) throw new Error("Phase 0 proof channel can connect only once.");
    this.#started = true;
    const startedAt = getProcessStartedAt(process.pid);
    if (startedAt === null) throw new Error("Unable to establish Phase 0 child identity.");
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.config[PHASE0_LIVE_PROOF_SOCKET_ENV]); this.#socket = socket;
      let buffer = "", settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; socket.destroy(); reject(error); } };
      const timer = setTimeout(() => fail(new Error("Phase 0 proof hello timed out.")), 5_000);
      socket.once("error", (error) => fail(error));
      socket.once("close", () => { if (!settled) fail(new Error("Phase 0 proof channel closed during hello.")); });
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES || !buffer.includes("\n")) return;
        const [line] = buffer.split("\n", 1), response = parseFrame(line!);
        if (!response || !exact(response, ["type"]) || response.type !== "ack") return fail(new Error("Phase 0 proof hello was rejected."));
        if (!settled) { settled = true; clearTimeout(timer); this.#authenticated = true; resolve(); }
      });
      socket.once("connect", () => {
        try { socket.write(frame({ type: "hello", proofId: this.config[PHASE0_LIVE_PROOF_ID_ENV], pid: process.pid, startedAt, cap: this.config[PHASE0_LIVE_PROOF_CAPABILITY_ENV] })); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
  }
  /** Announces that this authenticated child has validated its FIFO and is about to block on its descriptor. */
  announceReadStart(): void {
    if (!this.#authenticated || !this.#socket || this.#readStarted || this.#proved || this.#terminal || this.#socket.destroyed) {
      throw new Error("Phase 0 proof channel cannot announce this read start.");
    }
    this.#readStarted = true;
    try { this.#socket.write(frame({ type: "read-start", proofId: this.config[PHASE0_LIVE_PROOF_ID_ENV] })); }
    catch (error) {
      this.#socket.destroy();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  proveProviderRead(): void {
    if (!this.#authenticated || !this.#socket || !this.#readStarted || this.#proved || this.#terminal || this.#socket.destroyed) return;
    this.#proved = true;
    try { this.#socket.write(frame({ type: "proof", proofId: this.config[PHASE0_LIVE_PROOF_ID_ENV], provider: "openai-codex", model: "gpt-5.4-mini" })); }
    catch { this.#socket.destroy(); }
  }
  /** Reports one fixed, content-free terminal state only before descriptor read-start. */
  reportTerminal(category: Phase0LiveProofTerminalCategory): boolean {
    if (!this.#authenticated || !this.#socket || this.#readStarted || this.#proved || this.#terminal || this.#socket.destroyed) return false;
    this.#terminal = true;
    try { this.#socket.write(frame({ type: "terminal", proofId: this.config[PHASE0_LIVE_PROOF_ID_ENV], category })); return true; }
    catch { this.#socket.destroy(); return false; }
  }
  close(): void { const socket = this.#socket; this.#socket = null; socket?.end(); }
}

type Binding = { socket: net.Socket; identity: Phase0LiveProofIdentity; readStarted: boolean; proved: boolean; terminal?: Phase0LiveProofTerminalCategory };
export class Phase0LiveProofServer {
  readonly socketPath: string;
  #server: net.Server;
  #bindings = new Map<string, Binding>();
  #sockets = new Set<net.Socket>();
  #closed = false;
  private constructor(private readonly root: string, private readonly master: Buffer) {
    this.socketPath = path.join(root, "phase0-live-proof.sock");
    this.#server = net.createServer((socket) => this.#accept(socket));
  }
  static async start(root: string, masterHex: string): Promise<Phase0LiveProofServer> {
    if (!validMaster(masterHex)) throw new Error("Phase 0 proof master must be a 256-bit hex value.");
    const server = new Phase0LiveProofServer(root, Buffer.from(masterHex, "hex"));
    const directory = await fs.lstat(root).catch(() => null), canonical = await fs.realpath(root).catch(() => null);
    if (!directory?.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || canonical !== root) throw new Error("Phase 0 proof root is not canonical private 0700.");
    if (await fs.lstat(server.socketPath).catch(() => null)) throw new Error("Phase 0 proof socket path already exists.");
    await new Promise<void>((resolve, reject) => { server.#server.once("error", reject); server.#server.listen(server.socketPath, () => resolve()); });
    await fs.chmod(server.socketPath, 0o600);
    const stat = await fs.lstat(server.socketPath);
    if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) { await server.close(); throw new Error("Phase 0 proof socket is not private 0600."); }
    return server;
  }
  #accept(socket: net.Socket): void {
    if (this.#closed) { socket.destroy(); return; }
    this.#sockets.add(socket); let buffer = "", binding: Binding | null = null;
    const reject = () => socket.destroy();
    socket.on("close", () => { this.#sockets.delete(socket); });
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) return reject();
      while (true) {
        const index = buffer.indexOf("\n"); if (index < 0) return;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        const value = parseFrame(line); if (!value) return reject();
        if (!binding) {
          if (!exact(value, ["type", "proofId", "pid", "startedAt", "cap"]) || value.type !== "hello" || !isProofId(value.proofId) || !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt) || !isCapability(value.cap)) return reject();
          const expected = capability(this.master, value.proofId);
          if (this.#bindings.has(value.proofId) || [...this.#bindings.values()].some((candidate) => candidate.identity.pid === value.pid && candidate.identity.startedAt === value.startedAt)
            || !crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(value.cap, "hex")) || getProcessStartedAt(value.pid as number) !== value.startedAt) return reject();
          binding = { socket, identity: { pid: value.pid as number, startedAt: value.startedAt as number }, readStarted: false, proved: false };
          this.#bindings.set(value.proofId, binding);
          socket.write(frame({ type: "ack" }));
        } else {
          const boundProofId = [...this.#bindings.entries()].find(([, candidate]) => candidate === binding)?.[0];
          if (value.type === "read-start") {
            if (!exact(value, ["type", "proofId"]) || value.proofId !== boundProofId || binding.readStarted || binding.proved || binding.terminal) return reject();
            binding.readStarted = true;
            continue;
          }
          if (value.type === "terminal") {
            if (!exact(value, ["type", "proofId", "category"]) || value.proofId !== boundProofId || !isTerminalCategory(value.category) || binding.readStarted || binding.proved || binding.terminal) return reject();
            binding.terminal = value.category;
            continue;
          }
          if (!exact(value, ["type", "proofId", "provider", "model"]) || value.type !== "proof" || value.proofId !== boundProofId || value.provider !== "openai-codex" || value.model !== "gpt-5.4-mini" || !binding.readStarted || binding.proved || binding.terminal) return reject();
          binding.proved = true;
        }
      }
    });
  }
  identities(): Phase0LiveProofIdentity[] { return this.#identities((binding) => binding.proved); }
  readStartIdentities(): Phase0LiveProofIdentity[] { return this.#identities((binding) => binding.readStarted); }
  /** Bounded live-diagnostic accessor; it reveals no identity material. */
  proofCount(): number { return this.#count((binding) => binding.proved); }
  /** Bounded live-diagnostic accessor; it reveals no identity material. */
  readStartCount(): number { return this.#count((binding) => binding.readStarted); }
  /** Bounded terminal-only diagnostics; categories carry no error text, paths, or identities. */
  terminalReport(): Phase0LiveProofTerminalReport {
    const counts: Record<Phase0LiveProofTerminalCategory, number> = {
      "provider-error": 0, "settled-before-read": 0, "shutdown-before-read": 0, "aborted-before-read": 0,
    };
    let total = 0;
    for (const binding of this.#bindings.values()) if (binding.terminal) {
      counts[binding.terminal] = Math.min(MAX_DIAGNOSTIC_COUNT, counts[binding.terminal] + 1);
      total = Math.min(MAX_DIAGNOSTIC_COUNT, total + 1);
    }
    return { total, counts };
  }
  /** @deprecated Use terminalReport() so consumers retain the fixed total and categories. */
  terminalCounts(): Phase0LiveProofTerminalCounts { return this.terminalReport().counts; }
  /** True only once every expected authenticated child has irreversibly terminated before read-start. */
  hasNoReadStartPossibility(expected: number): boolean {
    if (!Number.isSafeInteger(expected) || expected <= 0 || this.#bindings.size !== expected) return false;
    return this.terminalReport().total === expected && [...this.#bindings.values()].every((binding) => !binding.readStarted);
  }
  #count(include: (binding: Binding) => boolean): number {
    let count = 0;
    for (const binding of this.#bindings.values()) if (include(binding)) count = Math.min(MAX_DIAGNOSTIC_COUNT, count + 1);
    return count;
  }
  #identities(include: (binding: Binding) => boolean): Phase0LiveProofIdentity[] {
    return [...this.#bindings.values()].filter(include).map((binding) => binding.identity).sort((a, b) => a.pid - b.pid || a.startedAt - b.startedAt);
  }
  async #waitForIdentities(expected: number, timeoutMs: number, signal: AbortSignal | undefined, label: "read starts" | "proofs", requireLive: boolean): Promise<Phase0LiveProofIdentity[]> {
    if (!Number.isSafeInteger(expected) || expected < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid Phase 0 ${label} wait bound.`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error(`Phase 0 ${label} wait aborted.`);
      const identities = label === "read starts" ? this.readStartIdentities() : this.identities();
      if (identities.length === expected && new Set(identities.map((value) => `${value.pid}:${value.startedAt}`)).size === expected
        && (!requireLive || identities.every((value) => getProcessStartedAt(value.pid) === value.startedAt))) return identities;
      if (label === "read starts" && this.hasNoReadStartPossibility(expected)) throw new Error("Phase 0 proof server has no remaining authenticated read-start possibility.");
      if (identities.length > expected) throw new Error(`Phase 0 proof server observed too many authenticated ${label}.`);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, Math.min(25, Math.max(1, deadline - Date.now())));
        const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error(`Phase 0 ${label} wait aborted.`)); };
        function done() { signal?.removeEventListener("abort", abort); resolve(); }
        if (signal) signal.addEventListener("abort", abort, { once: true });
      });
    }
    const observed = [...this.#bindings.values()].filter((binding) => label === "read starts" ? binding.readStarted : binding.proved).length;
    throw new Error(`Phase 0 proof server received ${observed}/${expected} authenticated ${label}.`);
  }
  /** Waits for exactly the authenticated children that have entered their descriptor reads simultaneously. */
  async waitForReadStarts(expected: number, timeoutMs = 90_000, signal?: AbortSignal): Promise<Phase0LiveProofIdentity[]> {
    return await this.#waitForIdentities(expected, timeoutMs, signal, "read starts", true);
  }
  /** Waits for exact, unique, connection-bound proofs; proved children may already have exited. */
  async waitForProofs(expected: number, timeoutMs = 90_000, signal?: AbortSignal): Promise<Phase0LiveProofIdentity[]> {
    return await this.#waitForIdentities(expected, timeoutMs, signal, "proofs", false);
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await fs.rm(this.socketPath, { force: true });
    if (await fs.lstat(this.socketPath).catch(() => null)) throw new Error("Phase 0 proof socket cleanup failed.");
  }
}
