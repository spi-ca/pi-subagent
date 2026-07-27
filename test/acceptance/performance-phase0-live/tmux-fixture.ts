import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { classifyParentProcessIdentity, getProcessStartedAt, type ProcessIdentityStatus } from "../../../src/runtime/run-protocol.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, TMUX_SOURCE_SENTINEL_LIFETIME_SECONDS, type BoundedCommandOptions, type BoundedCommandResult, type CellDeadline, type LiveEvidence, type LivePiExecutable, type ProcessIdentity, type Workload, runBoundedCommand as rawRun } from "./evidence.js";
import { ROOT, finalizePhase0CellFailure, type ActionBarrier, runParentCell } from "./cell.js";
import { createCellDeadline, remainingDeadlineMs } from "./evidence.js";
import { revalidateManagedChildPiExecutableGeneration } from "../managed-child-pi-executable.js";

type TmuxSocketIdentity = { dev: bigint; ino: bigint };
type TmuxSocketRootIdentity = { dev: bigint; ino: bigint; uid: number; mode: number };
type TmuxServerBinding = {
  server: ProcessIdentity; socket: TmuxSocketIdentity; socketRoot: TmuxSocketRootIdentity; creationServerPids: readonly [number, number];
  /** Source/sentinel fixture generations which must also be gone before root cleanup. */
  expectedProcesses?: readonly ProcessIdentity[];
};
type TmuxTeardownHooks = {
  runCommand?: (bin: string, args: string[], options: BoundedCommandOptions) => Promise<Pick<BoundedCommandResult, "code" | "stdout">>;
  /** Exact tri-state probe; unknown is never absence or signal authority. */
  classifyIdentity?: (identity: ProcessIdentity) => ProcessIdentityStatus;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test-only synchronization point after the old namespace has been detached. */
  afterRootRenamed?: (tombstoneRoot: string) => Promise<void>;
};
/** Test seam for failures after each independently identity-bound fixture stage. */
export type TmuxFixtureTestHooks = {
  afterBinding?: (stage: "creation" | "source" | "sentinel", state: { socket: string; socketRoot: string; binding: TmuxServerBinding }) => void | Promise<void>;
};

/** Fixture setup never inherits shell startup hooks or the caller's PATH. */
export const TMUX_FIXTURE_SAFE_PATH = "/usr/bin:/bin";
export function tmuxFixtureSetupEnv(): NodeJS.ProcessEnv {
  return { PATH: TMUX_FIXTURE_SAFE_PATH, SHELL: "/bin/sh", HOME: "/tmp", TERM: "xterm-256color" };
}
function exactTmuxSocket(stat: Awaited<ReturnType<typeof fs.lstat>> | null, expected: TmuxSocketIdentity): boolean {
  return Boolean(stat?.isSocket() && !stat.isSymbolicLink() && BigInt(stat.dev) === expected.dev && BigInt(stat.ino) === expected.ino);
}
function privateTmuxSocketRoot(stat: Awaited<ReturnType<typeof fs.lstat>> | null): TmuxSocketRootIdentity | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const mode = Number(stat?.mode) & 0o777, owner = Number(stat?.uid);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || mode !== 0o700 || (uid !== undefined && owner !== uid)) return null;
  return { dev: BigInt(stat.dev), ino: BigInt(stat.ino), uid: owner, mode };
}
function exactPrivateTmuxSocketRoot(stat: Awaited<ReturnType<typeof fs.lstat>> | null, expected: TmuxSocketRootIdentity): boolean {
  const actual = privateTmuxSocketRoot(stat);
  return actual !== null && actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid && actual.mode === expected.mode;
}
async function tmuxReportedServerPid(tmux: string, socket: string, timeoutMs: number, env: NodeJS.ProcessEnv, runCommand: TmuxTeardownHooks["runCommand"] = rawRun): Promise<number | null> {
  const result = await runCommand(tmux, ["-S", socket, "display-message", "-p", "#{pid}"], { timeoutMs, env });
  if (result.code !== 0) return null;
  const pid = Number(result.stdout.trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
/** Captures the minimal authority needed to kill a just-created isolated server. */
async function bindCreatedTmuxServer(tmux: string, socket: string, socketRoot: string, socketRootIdentity: TmuxSocketRootIdentity, timeoutMs: number, env: NodeJS.ProcessEnv, runCommand: TmuxTeardownHooks["runCommand"] = rawRun): Promise<TmuxServerBinding | null> {
  const root = await fs.lstat(socketRoot).catch(() => null), socketStat = await fs.lstat(socket).catch(() => null);
  if (!exactPrivateTmuxSocketRoot(root, socketRootIdentity) || !socketStat?.isSocket() || socketStat.isSymbolicLink()) return null;
  const serverPid = await tmuxReportedServerPid(tmux, socket, timeoutMs, env, runCommand);
  const serverStartedAt = serverPid === null ? null : getProcessStartedAt(serverPid);
  if (serverPid === null || serverStartedAt === null) return null;
  const binding: TmuxServerBinding = {
    server: { pid: serverPid, startedAt: serverStartedAt },
    socket: { dev: BigInt(socketStat.dev), ino: BigInt(socketStat.ino) },
    socketRoot: socketRootIdentity,
    // The PID/start-time and socket/root generations are exact authority; the
    // guarded teardown command rechecks the server PID immediately before kill.
    creationServerPids: [serverPid, serverPid],
  };
  return exactPrivateTmuxSocketRoot(await fs.lstat(socketRoot).catch(() => null), socketRootIdentity)
    && exactTmuxSocket(await fs.lstat(socket).catch(() => null), binding.socket)
    && getProcessStartedAt(serverPid) === serverStartedAt ? binding : null;
}
function expectedTmuxFixtureProcesses(binding: TmuxServerBinding): readonly ProcessIdentity[] {
  return [binding.server, ...(binding.expectedProcesses ?? [])];
}
function fixtureProcessGenerationsDead(binding: TmuxServerBinding, classifyIdentity: (identity: ProcessIdentity) => ProcessIdentityStatus): boolean {
  return expectedTmuxFixtureProcesses(binding).every((process) => classifyIdentity(process) === "dead");
}
function tombstoneSibling(socketRoot: string): string {
  return path.join(path.dirname(socketRoot), `.${path.basename(socketRoot)}.tmux-tombstone-${crypto.randomUUID()}`);
}
async function renamePrivateTmuxSocketRoot(socketRoot: string, expected: TmuxSocketRootIdentity): Promise<string | null> {
  const tombstoneRoot = tombstoneSibling(socketRoot);
  // Require creation identity immediately before the namespace detach. The
  // pathname itself never grants deletion authority.
  if (!exactPrivateTmuxSocketRoot(await fs.lstat(socketRoot).catch(() => null), expected)) return null;
  // rename(2) may replace an existing destination, so reject any observed
  // collision rather than turning a tombstone name into deletion authority.
  if (await fs.lstat(tombstoneRoot).catch(() => null)) return null;
  try { await fs.rename(socketRoot, tombstoneRoot); } catch { return null; }
  return exactPrivateTmuxSocketRoot(await fs.lstat(tombstoneRoot).catch(() => null), expected) ? tombstoneRoot : null;
}
/**
 * This is the only harness kill-server path. A stale socket is never unlinked
 * at its original pathname: its verified private directory is renamed out of
 * that namespace first, so a recreated socket root is never removed.
 */
export async function teardownIdentityBoundTmuxServer(options: {
  tmux: string; socket: string; socketRoot: string; binding: TmuxServerBinding | null; env?: NodeJS.ProcessEnv; timeoutMs?: number; hooks?: TmuxTeardownHooks;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, binding = options.binding, hooks = options.hooks ?? {};
  const runCommand = hooks.runCommand ?? rawRun, classifyIdentity = hooks.classifyIdentity ?? ((identity: ProcessIdentity) => classifyParentProcessIdentity(identity.pid, identity.startedAt));
  const sleep = hooks.sleep ?? (async (milliseconds: number) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const socketRoot = path.resolve(options.socketRoot), socket = path.resolve(options.socket), socketName = path.basename(socket);
  if (!binding || path.dirname(socket) !== socketRoot || socketName === "." || socketName === path.sep) throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
  const socketBefore = await fs.lstat(socket).catch(() => null);
  const rootBefore = await fs.lstat(socketRoot).catch(() => null);
  const serverStatus = classifyIdentity(binding.server);
  // A server which is proven dead is only cleaned when every fixture process is
  // also proven dead and its creation root is still verified. No tmux mutation
  // is attempted for unknown identity status.
  if (serverStatus === "dead" && socketBefore === null) {
    if (!fixtureProcessGenerationsDead(binding, classifyIdentity) || !exactPrivateTmuxSocketRoot(rootBefore, binding.socketRoot)) throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
    const tombstoneRoot = await renamePrivateTmuxSocketRoot(socketRoot, binding.socketRoot);
    if (!tombstoneRoot || !exactPrivateTmuxSocketRoot(await fs.lstat(tombstoneRoot).catch(() => null), binding.socketRoot)) throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
    await fs.rm(tombstoneRoot, { recursive: true, force: true });
    return;
  }
  const pidBefore = await tmuxReportedServerPid(options.tmux, socket, timeoutMs, options.env ?? {}, runCommand);
  if (!exactPrivateTmuxSocketRoot(rootBefore, binding.socketRoot) || !exactTmuxSocket(socketBefore, binding.socket) || serverStatus !== "live" || pidBefore === null
    || pidBefore !== binding.server.pid || binding.creationServerPids[0] !== binding.server.pid
    || binding.creationServerPids[1] !== binding.server.pid || binding.creationServerPids[0] !== binding.creationServerPids[1]) {
    throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
  }
  if (!exactPrivateTmuxSocketRoot(await fs.lstat(socketRoot).catch(() => null), binding.socketRoot)
    || !exactTmuxSocket(await fs.lstat(socket).catch(() => null), binding.socket)) {
    throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
  }
  // if-shell -F evaluates #{pid} inside the server immediately before the
  // mutation. A nonzero result is never treated as a successful kill.
  const guarded = await runCommand(options.tmux, ["-S", socket, "if-shell", "-F", `#{==:#{pid},${binding.server.pid}}`, "kill-server", "display-message -p -l pi-subagent-guard-noop"], { timeoutMs, env: options.env ?? {} });
  if (guarded.code !== 0) throw new Error(`identity-bound tmux teardown failed after guarded kill-server (${guarded.code}); private socket root retained`);
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    if (!fixtureProcessGenerationsDead(binding, classifyIdentity)) {
      await sleep(50);
      continue;
    }
    const rootNow = await fs.lstat(socketRoot).catch(() => null);
    if (!exactPrivateTmuxSocketRoot(rootNow, binding.socketRoot)) throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
    const socketNow = await fs.lstat(socket).catch(() => null);
    if (socketNow === null) {
      // Detach even an empty root before removal. A recreated root stays at
      // socketRoot and is never passed to rm.
      const tombstoneRoot = await renamePrivateTmuxSocketRoot(socketRoot, binding.socketRoot);
      if (!tombstoneRoot || !exactPrivateTmuxSocketRoot(await fs.lstat(tombstoneRoot).catch(() => null), binding.socketRoot)) throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
      await fs.rm(tombstoneRoot, { recursive: true, force: true });
      return;
    }
    if (!exactTmuxSocket(socketNow, binding.socket)) throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
    // rename is the namespace-detach operation. A random, initially absent
    // sibling keeps any later recreation at socketRoot outside cleanup scope.
    const tombstoneRoot = await renamePrivateTmuxSocketRoot(socketRoot, binding.socketRoot);
    if (!tombstoneRoot || !exactTmuxSocket(await fs.lstat(path.join(tombstoneRoot, socketName)).catch(() => null), binding.socket)) {
      throw new Error("identity-bound tmux teardown is ambiguous; private socket tombstone retained");
    }
    await hooks.afterRootRenamed?.(tombstoneRoot);
    // Only the detached tombstone is removed. Do not inspect, unlink, or remove
    // socketRoot after rename: it may now name a replacement server.
    if (!exactPrivateTmuxSocketRoot(await fs.lstat(tombstoneRoot).catch(() => null), binding.socketRoot)
      || !exactTmuxSocket(await fs.lstat(path.join(tombstoneRoot, socketName)).catch(() => null), binding.socket)) {
      throw new Error("identity-bound tmux teardown is ambiguous; private socket tombstone retained");
    }
    await fs.rm(tombstoneRoot, { recursive: true, force: true });
    return;
  }
  throw new Error(`identity-bound tmux teardown failed after guarded kill-server (${guarded.code}); private socket root retained`);
}

/* Transport sources are deliberately isolated. The production extension selects its transport from these exact source environments. */
export async function runTmuxCell(root: string, agentDir: string, extension: string, pi: LivePiExecutable, activeRuns: number, workload: Workload, env: NodeJS.ProcessEnv, testHooks: TmuxFixtureTestHooks = {}): Promise<Omit<LiveEvidence["matrix"][number], "mode" | "sourceAndSentinelPreserved">> {
  const deadline = createCellDeadline(activeRuns), tmux = pi.tmux.executable, session = `phase0-${crypto.randomUUID()}`;
  const setupEnv = tmuxFixtureSetupEnv();
  const run = (bin: string, args: string[], options: BoundedCommandOptions): Promise<BoundedCommandResult> => {
    revalidateManagedChildPiExecutableGeneration(pi.tmux);
    return rawRun(bin, args, { ...options, env: setupEnv });
  };
  let socketRoot = "", socket = "", tmuxBinding: TmuxServerBinding | null = null, primaryFailure: unknown = null;
  let parentCompleted = false, transportCleanupProven = true, result: Omit<LiveEvidence["matrix"][number], "mode" | "sourceAndSentinelPreserved"> | null = null;
  try {
    const socketRootRaw = await fs.mkdtemp("/tmp/pi-s0-tmux-"); socketRoot = await fs.realpath(socketRootRaw); socket = path.join(socketRoot, "s");
    await fs.chmod(socketRoot, 0o700);
    const creationSocketRoot = privateTmuxSocketRoot(await fs.lstat(socketRoot).catch(() => null));
    if (creationSocketRoot === null) throw new Error("isolated tmux socket root identity unavailable");
    const created = await run(tmux, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-x", "500", "-y", "200", "-s", session, "-c", ROOT, `exec /bin/sleep ${TMUX_SOURCE_SENTINEL_LIFETIME_SECONDS}`], { deadline, env });
    if (created.code !== 0) {
      // Creation can partially succeed. Bind only two matching observations so
      // cleanup can use the same identity-bound path as every later failure.
      const firstPid = await tmuxReportedServerPid(tmux, socket, DEFAULT_COMMAND_TIMEOUT_MS, env, run);
      const secondPid = await tmuxReportedServerPid(tmux, socket, DEFAULT_COMMAND_TIMEOUT_MS, env, run);
      const socketStat = await fs.lstat(socket).catch(() => null);
      const startedAt = firstPid !== null && firstPid === secondPid ? getProcessStartedAt(firstPid) : null;
      tmuxBinding = firstPid !== null && secondPid !== null && startedAt !== null && socketStat?.isSocket() && !socketStat.isSymbolicLink()
        ? { server: { pid: firstPid, startedAt }, socket: { dev: BigInt(socketStat.dev), ino: BigInt(socketStat.ino) }, socketRoot: creationSocketRoot, creationServerPids: [firstPid, secondPid] as const }
        : null;
      throw new Error("could not create isolated tmux source");
    }
    tmuxBinding = await bindCreatedTmuxServer(tmux, socket, socketRoot, creationSocketRoot, DEFAULT_COMMAND_TIMEOUT_MS, env, run);
    if (!tmuxBinding) throw new Error("isolated tmux creation binding is unavailable");
    await testHooks.afterBinding?.("creation", { socket, socketRoot, binding: tmuxBinding });
    // tmux 3.7a normalizes literal tab format output in this command path;
    // use a fixed non-ambiguous delimiter for the isolated fixture instead.
    const identity = await run(tmux, ["-S", socket, "display-message", "-p", "-t", `${session}:0.0`, "#{pane_id}|#{pid}"], { deadline, env });
    if (identity.code !== 0) throw new Error("isolated tmux source identity command failed");
    const identityMatch = identity.stdout.trim().match(/^(%\d+)\|(\d+)$/);
    if (!identityMatch) throw new Error("isolated tmux source unavailable");
    const source = identityMatch[1]!, serverPid = Number(identityMatch[2]);
    const server = await run(tmux, ["-S", socket, "display-message", "-p", "-t", source, "#{pid}"], { deadline, env });
    if (server.code !== 0) throw new Error("isolated tmux server identity command failed");
    const actualServerPid = Number(server.stdout.trim());
    if (!Number.isSafeInteger(actualServerPid) || actualServerPid <= 0 || serverPid !== actualServerPid || actualServerPid !== tmuxBinding.server.pid || getProcessStartedAt(actualServerPid) !== tmuxBinding.server.startedAt) throw new Error("isolated tmux server PID observations disagree");
    const sourcePanePidResult = await run(tmux, ["-S", socket, "display-message", "-p", "-t", source, "#{pane_pid}"], { deadline, env });
    if (sourcePanePidResult.code !== 0) throw new Error("isolated tmux source pane identity command failed");
    const sourcePanePid = Number(sourcePanePidResult.stdout.trim()), sourcePaneStartedAt = Number.isSafeInteger(sourcePanePid) && sourcePanePid > 0 ? getProcessStartedAt(sourcePanePid) : null;
    if (sourcePaneStartedAt === null) throw new Error("isolated tmux source fixture identity unavailable");
    tmuxBinding = { ...tmuxBinding, expectedProcesses: [{ pid: sourcePanePid, startedAt: sourcePaneStartedAt }] };
    await testHooks.afterBinding?.("source", { socket, socketRoot, binding: tmuxBinding });
    const sentinelResult = await run(tmux, ["-S", socket, "split-window", "-d", "-P", "-F", "#{pane_id}|#{pane_pid}", "-t", source, `exec /bin/sleep ${TMUX_SOURCE_SENTINEL_LIFETIME_SECONDS}`], { deadline, env });
    if (sentinelResult.code !== 0) throw new Error("isolated tmux sentinel command failed");
    const sentinelMatch = sentinelResult.stdout.trim().match(/^(%\d+)\|([1-9]\d*)$/);
    if (!sentinelMatch || sentinelMatch[1] === source || serverPid <= 0) throw new Error("isolated tmux sentinel unavailable");
    const sentinel = sentinelMatch[1]!, sentinelPid = Number(sentinelMatch[2]!), sentinelStartedAt = getProcessStartedAt(sentinelPid);
    if (sentinelStartedAt === null) throw new Error("isolated tmux sentinel fixture identity unavailable");
    tmuxBinding = { ...tmuxBinding, expectedProcesses: [...(tmuxBinding.expectedProcesses ?? []), { pid: sentinelPid, startedAt: sentinelStartedAt }] };
    await testHooks.afterBinding?.("sentinel", { socket, socketRoot, binding: tmuxBinding });
    const baseline = new Set([source, sentinel]);
    const listPanes = async (withinCell = true): Promise<string[]> => {
      const listed = await run(tmux, ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], withinCell ? { deadline, env } : { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS, env });
      if (listed.code !== 0) throw new Error("tmux topology inspection failed");
      const panes = listed.stdout.trim().split(/\s+/).filter(Boolean);
      if (new Set(panes).size !== panes.length || !panes.every((pane) => /^%\d+$/.test(pane))) throw new Error("tmux topology was malformed");
      return panes;
    };
    const barrier: ActionBarrier = async (_child, expected, barrierDeadline, signal) => {
      let targets: string[] = [];
      while (remainingDeadlineMs(barrierDeadline) > 0) {
        if (signal?.aborted) throw new Error("Phase 0 action barrier aborted");
        targets = (await listPanes()).filter((pane) => !baseline.has(pane)).sort();
        if (targets.length === expected) break;
        if (targets.length > expected) throw new Error("tmux allocation exceeded the expected target count");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (signal?.aborted) throw new Error("Phase 0 action barrier aborted");
      if (targets.length !== expected) throw new Error(`tmux observed ${targets.length}/${expected} target panes`);
      if (!tmuxBinding) throw new Error("tmux source generation binding is unavailable");
      return { observedProcesses: targets.length, backendTargets: targets, tmuxGeneration: { socketPath: socket, socketDev: String(tmuxBinding.socket.dev), socketIno: String(tmuxBinding.socket.ino), serverStartedAt: tmuxBinding.server.startedAt }, closeAll: async () => {
        for (const target of targets) {
          if (!(await listPanes()).includes(target)) throw new Error("tmux target changed before external close");
          const closed = await run(tmux, ["-S", socket, "kill-pane", "-t", target], { deadline, env });
          if (closed.code !== 0 || (await listPanes()).includes(target)) throw new Error("tmux exact target close was not proven");
        }
      } };
    };
    let sampling = true, maxBackendTargets = 0;
    const topologySampler = (async () => { while (sampling) { try { maxBackendTargets = Math.max(maxBackendTargets, (await listPanes()).filter((pane) => !baseline.has(pane)).length); } catch { /* final checks fail closed */ } await new Promise((resolve) => setTimeout(resolve, 25)); } })();
    let cell: Awaited<ReturnType<typeof runParentCell>>;
    try { cell = await runParentCell(root, agentDir, extension, pi, activeRuns, workload, env, { TMUX: `${socket},${actualServerPid},0`, TMUX_PANE: source, TMUX_BIN: tmux }, barrier, false, deadline); parentCompleted = true; }
    finally { sampling = false; await topologySampler; }
    if (maxBackendTargets < activeRuns) throw new Error(`tmux topology observed only ${maxBackendTargets}/${activeRuns} concurrent targets`);
    cell.backend.topologyProbeCount = maxBackendTargets;
    const cleanupDeadline = Date.now() + 20_000; let finalPanes = await listPanes(false);
    while (Date.now() < cleanupDeadline && (finalPanes.length !== 2 || !finalPanes.includes(source) || !finalPanes.includes(sentinel))) { await new Promise((resolve) => setTimeout(resolve, 100)); finalPanes = await listPanes(false); }
    if (finalPanes.length !== 2 || !finalPanes.includes(source) || !finalPanes.includes(sentinel)) throw new Error("tmux source/sentinel preservation or child cleanup failed");
    cell.cleanup.residualBackendTargetCount = finalPanes.filter((pane) => !baseline.has(pane)).length;
    result = cell;
  } catch (error) {
    primaryFailure = error;
  } finally {
    // A created namespace without an exact server binding is deliberately
    // retained rather than guessed at; that is not proven cleanup.
    if (tmuxBinding) {
      try { await teardownIdentityBoundTmuxServer({ tmux, socket, socketRoot, binding: tmuxBinding, env: setupEnv, hooks: { runCommand: run } }); }
      catch { transportCleanupProven = false; }
    } else if (socketRoot) transportCleanupProven = false;
    const finalized = await finalizePhase0CellFailure(root, primaryFailure, transportCleanupProven, { mode: "tmux", workload, activeRuns }, parentCompleted);
    if (finalized) throw finalized;
  }
  if (result === null) throw new Error("unreachable tmux cell completion");
  return result;
}
