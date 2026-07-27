import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPiSubagentPresenceProducer } from "../../src/integration/pi-presence-producer.js";
import {
  closeAcceptanceCmuxWorkspaceAfterSingletonProof,
  createAcceptanceCmuxWorkspace,
  findCanonicalCmuxIdentity,
  reconcileAcceptanceCmuxWorkspace,
  parseRequiredCmuxVersion,
  requireDisjointAcceptanceCmuxWorkspace,
  verifyCmuxCallerPreserved,
  type CmuxIdentity,
  type CmuxWorkspaceIdentity,
} from "./live-harness.js";
import { resolveBackendExecutable } from "../../src/runtime/runner.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LIVE_CMUX_PRESENCE_GATE = "PI_SUBAGENT_LIVE_CMUX_PRESENCE";
export const LIVE_CMUX_PRESENCE_TRUST = "PI_SUBAGENT_CMUX_PRESENCE_TRUST";
const POLL_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 75;
const CMUX_COMMAND_TIMEOUT_MS = 2_000;
const CMUX_COMMAND_STDOUT_MAX_BYTES = 256 * 1024;
const CMUX_COMMAND_STDERR_MAX_BYTES = 64 * 1024;

export type PresenceCmuxLiveOptions = { dryRun: boolean };
export type CommandResult = { code: number; stdout: string; stderr: string; unknown?: boolean };
type CmuxRun = (args: string[]) => Promise<CommandResult>;
type SpawnCommand = typeof spawn;
export type BoundedCmuxCommandOptions = {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  spawnCommand?: SpawnCommand;
};
type StatusEntry = { label: string; icon: string; color: string; priority: number };
type EventHandler = (payload: unknown) => void;
type LifecycleHandler = (event: unknown, context: unknown) => unknown;
type RealPresenceModules = {
  extension: (pi: unknown) => void;
  presenceStatusKey: (sourceId: string, surfaceId?: string) => string;
  resolveCmuxSocketPath: () => Promise<string | null>;
  safeSocketFingerprint: (socketPath: string) => Promise<{ dev: number; ino: number; uid: number }>;
};

export const PRESENCE_ENV = [
  "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_SOCKET_PATH",
  "PI_CMUX_PROFILE", "PI_CMUX_NOTIFY_LEVEL", "PI_CMUX_SIDEBAR_FLASH",
  "PI_CMUX_PRESENCE_ENABLED", "PI_CMUX_PRESENCE_TIMEOUT_MS", "PI_CMUX_PRESENCE_MAX_QUEUE",
  "PI_CMUX_PRESENCE_PROGRESS", "PI_CMUX_PRESENCE_NOTIFICATIONS", "PI_CMUX_PRESENCE_FLASH",
  "PI_CMUX_PRESENCE_NOTIFY_POLICY", "PI_CMUX_PRESENCE_FLASH_POLICY", "PI_CMUX_PRESENCE_LOG",
  "PI_CMUX_PRESENCE_SIDEBAR", "PI_CMUX_PRESENCE_NATIVE_LIFECYCLE", "PI_CMUX_PRESENCE_FEED",
  "PI_CMUX_PRESENCE_META_BLOCK", "PI_CMUX_PRESENCE_AUTO_TITLE", "PI_CMUX_PRESENCE_RESUME_FALLBACK",
  "PI_CMUX_PRESENCE_FINAL_CLEAR_MS", "PI_CMUX_PRESENCE_MAX_LABEL_CHARS",
] as const;

export function parsePresenceCmuxLiveArgs(argv: string[]): PresenceCmuxLiveOptions {
  if (argv.length === 0) return { dryRun: false };
  if (argv.length === 1 && argv[0] === "--dry-run") return { dryRun: true };
  throw new Error("usage: presence-cmux-live.ts [--dry-run]");
}

export function requirePresenceCmuxLiveGate(env = process.env): void {
  if (env[LIVE_CMUX_PRESENCE_GATE] !== "1") {
    throw new Error(`${LIVE_CMUX_PRESENCE_GATE}=1 is required; use --dry-run to inspect without mutation.`);
  }
}

export function requirePresenceCmuxPresenceTrust(env = process.env): void {
  if (env[LIVE_CMUX_PRESENCE_TRUST] !== "1") {
    throw new Error(`${LIVE_CMUX_PRESENCE_TRUST}=1 is required before dynamically importing trusted sibling code.`);
  }
}

/** Parse only the complete stable `cmux list-status` text table; malformed output is unknown, never absence. */
export function parseCmuxListStatus(stdout: string): Map<string, StatusEntry> | null {
  if (!stdout.endsWith("\n") || stdout.includes("\r") || Buffer.byteLength(stdout, "utf8") > 256 * 1024) return null;
  const result = new Map<string, StatusEntry>();
  const lines = stdout.slice(0, -1).split("\n");
  if (lines.length === 1 && lines[0] === "") return result;
  for (const line of lines) {
    const match = /^([a-z][a-z0-9:-]{0,255})=(.{1,512}) icon=([a-z][a-z0-9-]{0,63}) color=(#[0-9a-fA-F]{6}) priority=(-?[0-9]{1,4})$/.exec(line);
    if (!match || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(match[2]!)) return null;
    const priority = Number(match[5]);
    if (!Number.isSafeInteger(priority) || priority < -9_999 || priority > 9_999 || result.has(match[1]!)) return null;
    result.set(match[1]!, { label: match[2]!, icon: match[3]!, color: match[4]!, priority });
  }
  return result;
}

export function parseCmuxListStatusPresence(stdout: string, key: string): "present" | "absent" | "unknown" {
  const entries = parseCmuxListStatus(stdout);
  return entries === null ? "unknown" : entries.has(key) ? "present" : "absent";
}

/** Bounded command output is never parsed after timeout or truncation. */
export function runBoundedCmuxCommand(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: BoundedCmuxCommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const timeoutMs = options.timeoutMs ?? CMUX_COMMAND_TIMEOUT_MS;
    const maxStdoutBytes = options.maxStdoutBytes ?? CMUX_COMMAND_STDOUT_MAX_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? CMUX_COMMAND_STDERR_MAX_BYTES;
    const spawnCommand = options.spawnCommand ?? spawn;
    let child: ReturnType<SpawnCommand>;
    try {
      child = spawnCommand(bin, args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error), unknown: true });
      return;
    }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, timedOut = false, overflow = false, settled = false;
    let terminationTimer: ReturnType<typeof setTimeout> | null = null;
    const terminate = () => {
      try { child.kill("SIGKILL"); } catch { /* exit status remains unknown */ }
      // A broken child/stream must not hold the polling deadline after an attempted kill.
      if (!terminationTimer) terminationTimer = setTimeout(() => finish(1, new Error("cmux command did not close after termination")), 250);
    };
    const finish = (code: number | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminationTimer) clearTimeout(terminationTimer);
      const unknown = timedOut || overflow || error !== undefined;
      resolve({
        code: unknown ? 1 : code ?? 1,
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: `${Buffer.concat(stderr, stderrBytes).toString("utf8")}${error?.message ?? ""}`,
        unknown,
      });
    };
    const append = (chunks: Buffer[], bytes: number, chunk: Buffer | string, limit: number): number | null => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + value.length > limit) return null;
      chunks.push(value);
      return bytes + value.length;
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const next = append(stdout, stdoutBytes, chunk, maxStdoutBytes);
      if (next === null) { overflow = true; terminate(); } else stdoutBytes = next;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const next = append(stderr, stderrBytes, chunk, maxStderrBytes);
      if (next === null) { overflow = true; terminate(); } else stderrBytes = next;
    });
    child.once("error", (error) => finish(1, error));
    child.once("close", (code) => finish(code));
  });
}

function cmuxRunOrThrow(bin: string, args: string[]): Promise<CommandResult> {
  return runBoundedCmuxCommand(bin, args).then((result) => {
    if (result.unknown) throw new Error(`cmux command outcome is unknown (timeout or output cap): ${args[0] ?? "<empty>"}`);
    return result;
  });
}

async function privateRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-cmux-presence-live-"));
  await fs.promises.chmod(root, 0o700);
  return root;
}

async function removePrivateRoot(root: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(root);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (uid !== undefined && stat.uid !== uid)) return false;
    await fs.promises.rm(root, { recursive: true, force: false });
    await fs.promises.lstat(root);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

async function writeEvidence(root: string, evidence: Record<string, unknown>): Promise<void> {
  await fs.promises.writeFile(path.join(root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

export function replacePresenceEnv(
  values: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): { restore: () => void; verifyRestored: () => string[] } {
  const previous = new Map<string, string | undefined>(PRESENCE_ENV.map((key) => [key, env[key]]));
  for (const key of PRESENCE_ENV) {
    const value = values[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return {
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    },
    verifyRestored: () => PRESENCE_ENV.filter((key) => env[key] !== previous.get(key)),
  };
}

function requireCanonicalCaller(env = process.env): Pick<CmuxIdentity, "workspaceId" | "surfaceId"> {
  const workspaceId = env.CMUX_WORKSPACE_ID?.trim();
  const surfaceId = env.CMUX_SURFACE_ID?.trim();
  if (!workspaceId || !surfaceId) throw new Error("run from a cmux terminal with canonical CMUX_WORKSPACE_ID and CMUX_SURFACE_ID");
  return { workspaceId, surfaceId };
}

export const PRESENCE_SNAPSHOT_FILES = [
  "index.ts",
  "package.json",
  "src/client.ts",
  "src/config.ts",
  "src/events.ts",
  "src/hooks.ts",
  "src/identity.ts",
  "src/notification-policy.ts",
  "src/official-hook.ts",
  "src/presence.ts",
  "src/presentation.ts",
  "src/protocol.ts",
  "src/runtime.ts",
  "src/text.ts",
  "src/todo.ts",
  "src/transport.ts",
  "src/usage.ts",
  "src/validation.ts",
] as const;
const PRESENCE_SNAPSHOT_SOURCE_FILES = PRESENCE_SNAPSHOT_FILES.filter((relative) => relative.startsWith("src/"));
const MAX_PRESENCE_SNAPSHOT_FILE_BYTES = 1024 * 1024;

export type PresenceSnapshotManifest = {
  sha256: string;
  fileCount: number;
  totalBytes: number;
  files: Array<{ path: string; bytes: number; sha256: string }>;
};
export type StagedPresenceSnapshot = { root: string; manifest: PresenceSnapshotManifest };

function ownerUid(): number {
  if (typeof process.getuid !== "function") throw new Error("trusted sibling staging requires a current uid");
  return process.getuid();
}

function isOwnerSafeDirectory(stat: fs.Stats, uid: number, allowRootOwner: boolean): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o022) === 0 && (stat.uid === uid || (allowRootOwner && stat.uid === 0));
}

function isOwnerSafeFile(stat: fs.Stats, uid: number): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === uid && (stat.mode & 0o022) === 0
    && Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= MAX_PRESENCE_SNAPSHOT_FILE_BYTES;
}

async function requireTrustedAncestorChain(checkout: string, uid: number): Promise<void> {
  const parsed = path.parse(checkout);
  if (!parsed.root || !path.isAbsolute(checkout)) throw new Error("pi-cmux-presence checkout must be canonical and absolute");
  let current = parsed.root;
  const components = ["", ...checkout.slice(parsed.root.length).split(path.sep).filter(Boolean)];
  for (const component of components) {
    if (component) current = path.join(current, component);
    const stat = await fs.promises.lstat(current).catch(() => null);
    if (!stat || !isOwnerSafeDirectory(stat, uid, true)) {
      throw new Error(`pi-cmux-presence ancestor is not a trusted real directory: ${current}`);
    }
  }
}

async function readTrustedPresenceFile(root: string, relative: string, uid: number): Promise<Buffer> {
  const source = path.join(root, relative);
  const beforePath = await fs.promises.lstat(source).catch(() => null);
  if (!beforePath || !isOwnerSafeFile(beforePath, uid)) throw new Error(`pi-cmux-presence canonical file is unsafe or absent: ${relative}`);
  const handle = await fs.promises.open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!isOwnerSafeFile(before, uid)) throw new Error(`pi-cmux-presence opened file is unsafe: ${relative}`);
    const bytes = Buffer.alloc(before.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const afterPath = await fs.promises.lstat(source).catch(() => null);
    if (read.bytesRead !== bytes.length || !isOwnerSafeFile(after, uid)
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || !afterPath || afterPath.isSymbolicLink() || after.dev !== afterPath.dev || after.ino !== afterPath.ino) {
      throw new Error(`pi-cmux-presence file changed while staging: ${relative}`);
    }
    return bytes;
  } finally { await handle.close(); }
}

async function requireExactPresenceSourceDirectory(root: string, uid: number): Promise<void> {
  const sourceRoot = path.join(root, "src");
  const sourceStat = await fs.promises.lstat(sourceRoot).catch(() => null);
  if (!sourceStat || !isOwnerSafeDirectory(sourceStat, uid, false)) throw new Error("pi-cmux-presence src directory is unsafe or absent");
  const actual = await fs.promises.readdir(sourceRoot, { withFileTypes: true });
  const expected = new Set(PRESENCE_SNAPSHOT_SOURCE_FILES.map((relative) => path.basename(relative)));
  if (actual.length !== expected.size || actual.some((entry) => entry.isSymbolicLink() || !entry.isFile() || !expected.has(entry.name))) {
    throw new Error("pi-cmux-presence src directory does not match the exact staged allowlist");
  }
}

async function createPrivatePresenceSnapshotRoot(evidenceRoot: string, uid: number): Promise<string> {
  const evidenceStat = await fs.promises.lstat(evidenceRoot).catch(() => null);
  if (!evidenceStat || !isOwnerSafeDirectory(evidenceStat, uid, false) || (evidenceStat.mode & 0o777) !== 0o700) {
    throw new Error("cmux presence evidence root is not private before sibling staging");
  }
  const snapshotRoot = await fs.promises.mkdtemp(path.join(evidenceRoot, "trusted-presence-"));
  await fs.promises.chmod(snapshotRoot, 0o700);
  const snapshotStat = await fs.promises.lstat(snapshotRoot);
  if (!isOwnerSafeDirectory(snapshotStat, uid, false) || (snapshotStat.mode & 0o777) !== 0o700) throw new Error("private staged sibling root creation was not proven");
  return snapshotRoot;
}

async function writeStagedPresenceFile(snapshotRoot: string, relative: string, bytes: Buffer, uid: number): Promise<void> {
  const destination = path.join(snapshotRoot, relative);
  if (relative.startsWith("src/")) {
    const sourceRoot = path.join(snapshotRoot, "src");
    if (!await fs.promises.lstat(sourceRoot).catch(() => null)) {
      await fs.promises.mkdir(sourceRoot, { mode: 0o700 });
      await fs.promises.chmod(sourceRoot, 0o700);
    }
    const sourceStat = await fs.promises.lstat(sourceRoot);
    if (!isOwnerSafeDirectory(sourceStat, uid, false) || (sourceStat.mode & 0o777) !== 0o700) throw new Error("private staged sibling src directory creation was not proven");
  }
  await fs.promises.writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
  await fs.promises.chmod(destination, 0o600);
  const stat = await fs.promises.lstat(destination);
  if (!isOwnerSafeFile(stat, uid) || (stat.mode & 0o777) !== 0o600) throw new Error(`private staged sibling file creation was not proven: ${relative}`);
}

export async function stageTrustedPresenceSnapshot(
  evidenceRoot: string,
  rootOverride = process.env.PI_SUBAGENT_CMUX_PRESENCE_ROOT,
  env = process.env,
): Promise<StagedPresenceSnapshot> {
  requirePresenceCmuxPresenceTrust(env);
  const explicitRoot = rootOverride?.trim();
  if (explicitRoot && !path.isAbsolute(explicitRoot)) throw new Error("PI_SUBAGENT_CMUX_PRESENCE_ROOT must be an absolute canonical sibling checkout path");
  const candidate = explicitRoot || path.resolve(ROOT, "../pi-cmux-presence");
  const root = await fs.promises.realpath(candidate).catch(() => null);
  if (!root || (explicitRoot && explicitRoot !== root)) throw new Error("pi-cmux-presence root must be an available canonical checkout");
  const uid = ownerUid();
  await requireTrustedAncestorChain(root, uid);
  await requireExactPresenceSourceDirectory(root, uid);

  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (const relative of PRESENCE_SNAPSHOT_FILES) files.push({ path: relative, bytes: await readTrustedPresenceFile(root, relative, uid) });
  let packageJson: unknown;
  try { packageJson = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(files.find((file) => file.path === "package.json")!.bytes)); }
  catch { throw new Error("trusted sibling package.json is not valid UTF-8 JSON"); }
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson) || (packageJson as { name?: unknown }).name !== "pi-cmux-presence") {
    throw new Error("trusted sibling package.json must have exact name pi-cmux-presence");
  }

  const snapshotRoot = await createPrivatePresenceSnapshotRoot(evidenceRoot, uid);
  const manifestFiles = files.map((file) => ({ path: file.path, bytes: file.bytes.length, sha256: crypto.createHash("sha256").update(file.bytes).digest("hex") }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  for (const file of files) await writeStagedPresenceFile(snapshotRoot, file.path, file.bytes, uid);
  const manifest = {
    sha256: crypto.createHash("sha256").update(manifestFiles.map((file) => `${file.path}\t${file.bytes}\t${file.sha256}\n`).join("")).digest("hex"),
    fileCount: manifestFiles.length,
    totalBytes: manifestFiles.reduce((total, file) => total + file.bytes, 0),
    files: manifestFiles,
  };
  return { root: snapshotRoot, manifest };
}

async function loadRealPresence(snapshot: StagedPresenceSnapshot): Promise<RealPresenceModules> {
  let entry: Record<string, unknown>, presence: Record<string, unknown>, identity: Record<string, unknown>, presentation: Record<string, unknown>;
  try {
    [entry, presence, identity, presentation] = await Promise.all([
      import(pathToFileURL(path.join(snapshot.root, "index.ts")).href),
      import(pathToFileURL(path.join(snapshot.root, "src/presence.ts")).href),
      import(pathToFileURL(path.join(snapshot.root, "src/identity.ts")).href),
      import(pathToFileURL(path.join(snapshot.root, "src/presentation.ts")).href),
    ]);
  } catch (error) {
    throw new Error(`staged pi-cmux-presence import failed to resolve: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof entry.default !== "function" || typeof presence.registerPresence !== "function"
    || typeof identity.resolveCmuxSocketPath !== "function" || typeof identity.safeSocketFingerprint !== "function"
    || typeof presentation.presenceStatusKey !== "function") {
    throw new Error("pi-cmux-presence staged exports do not provide its real entrypoint, consumer checks, and status key");
  }
  return {
    extension: entry.default as RealPresenceModules["extension"],
    presenceStatusKey: presentation.presenceStatusKey as RealPresenceModules["presenceStatusKey"],
    resolveCmuxSocketPath: identity.resolveCmuxSocketPath as RealPresenceModules["resolveCmuxSocketPath"],
    safeSocketFingerprint: identity.safeSocketFingerprint as RealPresenceModules["safeSocketFingerprint"],
  };
}

function createFakePi() {
  const events = new Map<string, Set<EventHandler>>();
  const lifecycle = new Map<string, LifecycleHandler[]>();
  const api = {
    events: {
      on(channel: string, handler: EventHandler) {
        const handlers = events.get(channel) ?? new Set<EventHandler>();
        handlers.add(handler);
        events.set(channel, handlers);
        return () => handlers.delete(handler);
      },
      emit(channel: string, payload: unknown) {
        for (const handler of [...(events.get(channel) ?? [])]) handler(payload);
      },
    },
    on(name: string, handler: LifecycleHandler) {
      const handlers = lifecycle.get(name) ?? [];
      handlers.push(handler);
      lifecycle.set(name, handlers);
    },
    getAllTools: () => [],
  };
  return {
    api,
    emit: api.events.emit,
    async lifecycle(name: string, event: unknown = {}, context: unknown = {}) {
      for (const handler of lifecycle.get(name) ?? []) await handler(event, context);
    },
  };
}

function runningSnapshot() {
  return {
    generation: 7,
    active: [{ id: "presence-live-run", agent: "safe", kind: "foreground", status: "running", generation: 7, startedAt: 1, updatedAt: 1 }],
    recent: [],
  } as const;
}

function completedSnapshot() {
  return {
    generation: 7,
    active: [],
    recent: [{ id: "presence-live-run", agent: "safe", kind: "foreground", status: "completed", generation: 7, startedAt: 1, updatedAt: 2, completedAt: 2 }],
  } as const;
}

async function waitForStatus(cmuxRun: CmuxRun, workspaceId: string, key: string, expected: "running" | "absent"): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await cmuxRun(["list-status", "--workspace", workspaceId]);
    // A command failure or malformed listing is unknown, not evidence of absence.
    const entries = result.code === 0 ? parseCmuxListStatus(result.stdout) : null;
    if (entries) {
      const entry = entries.get(key);
      if (expected === "running" && entry?.label === "Subagents: running · 1 active") return;
      if (expected === "absent" && !entry) return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for exact pi-subagent ${expected} status`);
}

async function live(): Promise<void> {
  requirePresenceCmuxLiveGate();
  requirePresenceCmuxPresenceTrust();
  const callerInput = requireCanonicalCaller();
  const root = await privateRoot();
  const workspaceName = `pi-subagent-presence-${crypto.randomUUID()}`;
  const evidence: Record<string, unknown> = {
    mode: "cmux-presence-live", outcome: "failed", workspaceName,
    liveGate: LIVE_CMUX_PRESENCE_GATE, trustGate: LIVE_CMUX_PRESENCE_TRUST,
  };
  const cleanup: Record<string, string> = {};
  const cleanupFailures: string[] = [];
  let primaryError: unknown = null;
  let restoreEnv: ReturnType<typeof replacePresenceEnv> | null = null;
  let workspace: CmuxWorkspaceIdentity | null = null;
  let workspaceCreationAttempted = false;
  let caller: CmuxIdentity | null = null;
  let presence: RealPresenceModules | null = null;
  let producer: ReturnType<typeof createPiSubagentPresenceProducer> | null = null;
  let primaryProducerStarted = false, primaryProducerStopped = false;
  let secondaryProducer: ReturnType<typeof createPiSubagentPresenceProducer> | null = null;
  let secondaryProducerStarted = false, secondaryProducerStopped = false;
  let consumer: ReturnType<typeof createFakePi> | null = null;
  let consumerStarted = false, consumerShutdown = false;
  let cmux: string | null = null;
  let cmuxRun: CmuxRun | null = null;
  let socket: string | null = null;
  let socketBefore: { dev: number; ino: number; uid: number } | null = null;
  const stopPrimary = () => { if (producer) { producer.stop(); producer = null; } primaryProducerStopped = true; };
  const stopSecondary = () => { if (secondaryProducer) { secondaryProducer.stop(); secondaryProducer = null; } secondaryProducerStopped = true; };
  try {
    const stagedPresence = await stageTrustedPresenceSnapshot(root);
    evidence.stagedSnapshot = stagedPresence.manifest;
    presence = await loadRealPresence(stagedPresence);
    cmux = resolveBackendExecutable("cmux-pane");
    if (!cmux) throw new Error("no real cmux executable resolved through the package backend resolver");
    cmuxRun = (args) => cmuxRunOrThrow(cmux!, args);
    const version = await cmuxRun(["--version"]);
    const supported = version.code === 0 ? parseRequiredCmuxVersion(version.stdout) : null;
    if (!supported) throw new Error("live cmux presence requires the harness-supported stable cmux version");
    evidence.cmuxVersion = supported;

    socket = await presence.resolveCmuxSocketPath();
    if (!socket) throw new Error("pi-cmux-presence rejected the configured/default cmux socket identity");
    socketBefore = await presence.safeSocketFingerprint(socket);
    evidence.socketIdentity = "consumer-verified";

    const callerTree = await cmuxRun(["--json", "--id-format", "both", "tree", "--all"]);
    caller = callerTree.code === 0 ? findCanonicalCmuxIdentity(callerTree.stdout, callerInput.workspaceId, callerInput.surfaceId) : null;
    if (!caller) throw new Error("caller does not resolve to one canonical cmux workspace/pane/surface identity");
    evidence.callerBefore = "canonical-present";

    workspaceCreationAttempted = true;
    const created = await createAcceptanceCmuxWorkspace(cmuxRun, workspaceName, root);
    if (created.state !== "created") throw new Error(`private workspace creation is unresolved: ${created.recovery}`);
    workspace = created.workspace;
    requireDisjointAcceptanceCmuxWorkspace(workspace, caller);
    evidence.workspace = "created-caller-disjoint";

    restoreEnv = replacePresenceEnv({
      CMUX_WORKSPACE_ID: workspace.workspaceId, CMUX_SURFACE_ID: workspace.surfaceId, CMUX_SOCKET_PATH: socket,
      PI_CMUX_PROFILE: "subagent-child-v1", PI_CMUX_NOTIFY_LEVEL: "disabled", PI_CMUX_SIDEBAR_FLASH: "disabled",
      PI_CMUX_PRESENCE_ENABLED: "1", PI_CMUX_PRESENCE_TIMEOUT_MS: "750", PI_CMUX_PRESENCE_MAX_QUEUE: "16",
      PI_CMUX_PRESENCE_PROGRESS: "0", PI_CMUX_PRESENCE_NOTIFICATIONS: "0", PI_CMUX_PRESENCE_FLASH: "0",
      PI_CMUX_PRESENCE_NOTIFY_POLICY: "disabled", PI_CMUX_PRESENCE_FLASH_POLICY: "disabled", PI_CMUX_PRESENCE_LOG: "0",
      PI_CMUX_PRESENCE_SIDEBAR: "1", PI_CMUX_PRESENCE_NATIVE_LIFECYCLE: "0", PI_CMUX_PRESENCE_FEED: "0",
      PI_CMUX_PRESENCE_META_BLOCK: "0", PI_CMUX_PRESENCE_AUTO_TITLE: "0", PI_CMUX_PRESENCE_RESUME_FALLBACK: "0",
      PI_CMUX_PRESENCE_FINAL_CLEAR_MS: "0", PI_CMUX_PRESENCE_MAX_LABEL_CHARS: "96",
    });

    const liveConsumer = createFakePi();
    consumer = liveConsumer;
    consumerStarted = true;
    presence.extension(liveConsumer.api);
    producer = createPiSubagentPresenceProducer({
      emit: liveConsumer.emit,
      on: (channel, handler) => liveConsumer.api.events.on(channel, handler),
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    primaryProducerStarted = true;
    if (!producer.startSession("presence-live-smoke", 7) || !producer.publish(runningSnapshot())) throw new Error("fixed provider-free producer snapshot was rejected");
    await liveConsumer.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "presence-live-smoke" } });
    if (!producer.isPresenceRemoveCapabilityDetected()) throw new Error("real consumer did not advertise presence-remove-v1 after producer-first replay request");

    const key = presence.presenceStatusKey("pi-subagent", workspace.surfaceId);
    await waitForStatus(cmuxRun, workspace.workspaceId, key, "running");
    evidence.runningStatus = "exact-key-and-label-observed";
    if (!producer.publish(completedSnapshot())) throw new Error("fixed terminal producer snapshot was rejected");
    producer.settle();
    await waitForStatus(cmuxRun, workspace.workspaceId, key, "absent");
    evidence.removeStatus = "exact-key-absent-after-strict-listing";
    stopPrimary();

    secondaryProducer = createPiSubagentPresenceProducer({
      emit: liveConsumer.emit,
      on: (channel, handler) => liveConsumer.api.events.on(channel, handler),
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    secondaryProducerStarted = true;
    secondaryProducer.startSession("presence-live-smoke", 8);
    if (!secondaryProducer.isPresenceRemoveCapabilityDetected()) throw new Error("real consumer did not advertise presence-remove-v1 for consumer-first startup");
    stopSecondary();
    evidence.startupOrders = "producer-first-and-consumer-first";
  } catch (error) {
    primaryError = error;
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
    const prove = async (name: string, action: () => Promise<boolean> | boolean, required: boolean): Promise<void> => {
      if (!required) { cleanup[name] = "not-started"; return; }
      try {
        if (await action()) cleanup[name] = "proven";
        else { cleanup[name] = "unknown"; cleanupFailures.push(`${name} is unknown`); }
      } catch (error) {
        cleanup[name] = "unknown";
        cleanupFailures.push(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await prove("primaryProducerStop", () => { if (!primaryProducerStopped) stopPrimary(); return primaryProducerStopped; }, primaryProducerStarted);
    await prove("secondaryProducerStop", () => { if (!secondaryProducerStopped) stopSecondary(); return secondaryProducerStopped; }, secondaryProducerStarted);
    await prove("consumerSessionShutdown", async () => {
      if (!consumerShutdown && consumer) { await consumer.lifecycle("session_shutdown"); consumerShutdown = true; consumer = null; }
      return consumerShutdown;
    }, consumerStarted);
    await prove("environmentRestore", () => {
      if (!restoreEnv) return false;
      restoreEnv.restore();
      const mismatches = restoreEnv.verifyRestored();
      if (mismatches.length) { cleanup.environmentRestoreKeys = mismatches.join(","); return false; }
      cleanup.environmentRestoreKeys = PRESENCE_ENV.join(",");
      return true;
    }, restoreEnv !== null);
    await prove("socketIdentity", async () => {
      if (!presence || !socket || !socketBefore) return false;
      const after = await presence.safeSocketFingerprint(socket);
      return after.dev === socketBefore.dev && after.ino === socketBefore.ino && after.uid === socketBefore.uid;
    }, socketBefore !== null);

    if (workspaceCreationAttempted && cmuxRun) {
      try {
        // A named workspace may appear late or be ambiguous; only this fresh canonical reconciliation is close authority.
        workspace = null;
        const reconciled = await reconcileAcceptanceCmuxWorkspace(cmuxRun, workspaceName);
        cleanup.workspaceReconciliation = reconciled.state === "created" ? `created:${reconciled.recovery}` : `unknown:${reconciled.recovery}`;
        if (reconciled.state === "created") workspace = reconciled.workspace;
        else cleanupFailures.push(`workspace reconciliation is ${reconciled.recovery}`);
      } catch (error) {
        cleanup.workspaceReconciliation = "unknown";
        cleanupFailures.push(`workspace reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else cleanup.workspaceReconciliation = workspaceCreationAttempted ? "unknown:no-command-runner" : "not-started";

    let callerPreservedBeforeClose = false;
    await prove("callerPreservedBeforeClose", async () => {
      callerPreservedBeforeClose = Boolean(caller && cmux && cmuxRun && await verifyCmuxCallerPreserved(cmux, caller, cmuxRun));
      return callerPreservedBeforeClose;
    }, workspaceCreationAttempted);
    await prove("workspaceClose", async () => Boolean(callerPreservedBeforeClose && workspace && caller && cmux && cmuxRun
      && await closeAcceptanceCmuxWorkspaceAfterSingletonProof(cmux, workspace, caller, cmuxRun)), workspaceCreationAttempted);
    await prove("callerPreservedAfterClose", async () => Boolean(caller && cmux && cmuxRun && await verifyCmuxCallerPreserved(cmux, caller, cmuxRun)), workspaceCreationAttempted);

    evidence.cleanup = cleanup;
    const cleanupProven = cleanupFailures.length === 0;
    evidence.cleanupProven = cleanupProven;
    evidence.outcome = primaryError || !cleanupProven ? "failed" : "passed";
    let evidenceWritten = false;
    try { await writeEvidence(root, evidence); evidenceWritten = true; }
    catch (error) { cleanupFailures.push(`evidence write failed: ${error instanceof Error ? error.message : String(error)}`); }

    if (!primaryError && cleanupFailures.length === 0 && evidenceWritten && await removePrivateRoot(root)) {
      console.log(JSON.stringify({ mode: "cmux-presence-live", outcome: "passed", cleanup: "proven" }));
      return;
    }
    if (!primaryError && cleanupFailures.length === 0) {
      cleanupFailures.push("private evidence root cleanup is unproven");
      cleanup.privateEvidenceRoot = "unknown";
      evidence.outcome = "failed";
      evidence.cleanupProven = false;
      try { await writeEvidence(root, evidence); } catch { /* root is retained and reported below */ }
    }
    console.error(`cmux presence live evidence retained: ${path.join(root, "evidence.json")}`);
    const primary = primaryError ? (primaryError instanceof Error ? primaryError.message : String(primaryError)) : "none";
    const cleanupLeg = cleanupFailures.length ? cleanupFailures.join("; ") : "none";
    throw new Error(`cmux presence live primary failure: ${primary}; cleanup failure: ${cleanupLeg}`);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parsePresenceCmuxLiveArgs(argv);
  if (options.dryRun) {
    console.log(JSON.stringify({ mode: "cmux-presence-live", dryRun: true, mutation: "none", requiredGates: [LIVE_CMUX_PRESENCE_GATE, LIVE_CMUX_PRESENCE_TRUST] }));
    return;
  }
  await live();
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
