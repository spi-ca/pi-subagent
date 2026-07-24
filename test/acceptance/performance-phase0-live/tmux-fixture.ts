import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getProcessStartedAt } from "../../../src/runtime/run-protocol.js";
import { DEFAULT_COMMAND_TIMEOUT_MS, TMUX_SOURCE_SENTINEL_LIFETIME_SECONDS, type BoundedCommandOptions, type BoundedCommandResult, type CellDeadline, type LiveEvidence, type ProcessIdentity, type Workload, runBoundedCommand as run } from "./evidence.js";
import { ROOT, type ActionBarrier, runParentCell } from "./cell.js";
import { createCellDeadline, remainingDeadlineMs } from "./evidence.js";

type TmuxSocketIdentity = { dev: bigint; ino: bigint };
type TmuxSocketRootIdentity = { dev: bigint; ino: bigint; uid: number; mode: number };
type TmuxServerBinding = {
  server: ProcessIdentity; socket: TmuxSocketIdentity; socketRoot: TmuxSocketRootIdentity; creationServerPids: readonly [number, number];
  /** Source/sentinel fixture generations which must also be gone before root cleanup. */
  expectedProcesses?: readonly ProcessIdentity[];
};
type TmuxTeardownHooks = {
  runCommand?: (bin: string, args: string[], options: BoundedCommandOptions) => Promise<Pick<BoundedCommandResult, "code" | "stdout">>;
  getProcessStartedAt?: (pid: number) => number | null;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test-only synchronization point after the old namespace has been detached. */
  afterRootRenamed?: (tombstoneRoot: string) => Promise<void>;
};
/** Test seam for failures after each independently identity-bound fixture stage. */
export type TmuxFixtureTestHooks = {
  afterBinding?: (stage: "creation" | "source" | "sentinel", state: { socket: string; socketRoot: string; binding: TmuxServerBinding }) => void | Promise<void>;
};
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
async function tmuxReportedServerPid(tmux: string, socket: string, timeoutMs: number, runCommand: TmuxTeardownHooks["runCommand"] = run): Promise<number | null> {
  const result = await runCommand(tmux, ["-S", socket, "display-message", "-p", "#{pid}"], { timeoutMs });
  const pid = Number(result.stdout.trim());
  return result.code === 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
/** Captures the minimal authority needed to kill a just-created isolated server. */
async function bindCreatedTmuxServer(tmux: string, socket: string, socketRoot: string, socketRootIdentity: TmuxSocketRootIdentity, timeoutMs: number): Promise<TmuxServerBinding | null> {
  const root = await fs.lstat(socketRoot).catch(() => null), socketStat = await fs.lstat(socket).catch(() => null);
  if (!exactPrivateTmuxSocketRoot(root, socketRootIdentity) || !socketStat?.isSocket() || socketStat.isSymbolicLink()) return null;
  const serverPid = await tmuxReportedServerPid(tmux, socket, timeoutMs);
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
function fixtureProcessGenerationsAbsent(binding: TmuxServerBinding, processStartedAt: (pid: number) => number | null): boolean {
  return expectedTmuxFixtureProcesses(binding).every((process) => processStartedAt(process.pid) !== process.startedAt);
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
  tmux: string; socket: string; socketRoot: string; binding: TmuxServerBinding | null; timeoutMs?: number; hooks?: TmuxTeardownHooks;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, binding = options.binding, hooks = options.hooks ?? {};
  const runCommand = hooks.runCommand ?? run, processStartedAt = hooks.getProcessStartedAt ?? getProcessStartedAt;
  const sleep = hooks.sleep ?? (async (milliseconds: number) => await new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const socketRoot = path.resolve(options.socketRoot), socket = path.resolve(options.socket), socketName = path.basename(socket);
  if (!binding || path.dirname(socket) !== socketRoot || socketName === "." || socketName === path.sep) throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
  const socketBefore = await fs.lstat(socket).catch(() => null);
  const rootBefore = await fs.lstat(socketRoot).catch(() => null);
  const processIsExact = processStartedAt(binding.server.pid) === binding.server.startedAt;
  // A server which was already absent is only cleaned when its creation root
  // is still verified. No tmux mutation is attempted in this case.
  if (!processIsExact && socketBefore === null) {
    if (!fixtureProcessGenerationsAbsent(binding, processStartedAt) || !exactPrivateTmuxSocketRoot(rootBefore, binding.socketRoot)) throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
    const tombstoneRoot = await renamePrivateTmuxSocketRoot(socketRoot, binding.socketRoot);
    if (!tombstoneRoot || !exactPrivateTmuxSocketRoot(await fs.lstat(tombstoneRoot).catch(() => null), binding.socketRoot)) throw new Error("identity-bound tmux teardown is ambiguous; private socket root retained");
    await fs.rm(tombstoneRoot, { recursive: true, force: true });
    return;
  }
  const pidBefore = await tmuxReportedServerPid(options.tmux, socket, timeoutMs, runCommand);
  if (!exactPrivateTmuxSocketRoot(rootBefore, binding.socketRoot) || !exactTmuxSocket(socketBefore, binding.socket) || !processIsExact || pidBefore === null
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
  const guarded = await runCommand(options.tmux, ["-S", socket, "if-shell", "-F", `#{==:#{pid},${binding.server.pid}}`, "kill-server", "display-message -p -l pi-subagent-guard-noop"], { timeoutMs });
  if (guarded.code !== 0) throw new Error(`identity-bound tmux teardown failed after guarded kill-server (${guarded.code}); private socket root retained`);
  const deadline = Date.now() + Math.min(timeoutMs, 10_000);
  while (Date.now() < deadline) {
    if (!fixtureProcessGenerationsAbsent(binding, processStartedAt)) {
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
export async function runTmuxCell(root: string, agentDir: string, extension: string, piBin: string, activeRuns: number, workload: Workload, testHooks: TmuxFixtureTestHooks = {}): Promise<Omit<LiveEvidence["matrix"][number], "mode" | "sourceAndSentinelPreserved">> {
  const deadline = createCellDeadline(activeRuns);
  const tmux = process.env.TMUX_BIN || "tmux", socketRootRaw = await fs.mkdtemp("/tmp/pi-s0-tmux-"), socketRoot = await fs.realpath(socketRootRaw), socket = path.join(socketRoot, "s"), session = `phase0-${crypto.randomUUID()}`;
  await fs.chmod(socketRoot, 0o700);
  const creationSocketRoot = privateTmuxSocketRoot(await fs.lstat(socketRoot).catch(() => null));
  if (creationSocketRoot === null) throw new Error("isolated tmux socket root identity unavailable");
  const created = await run(tmux, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-x", "500", "-y", "200", "-s", session, "-c", ROOT, `exec sleep ${TMUX_SOURCE_SENTINEL_LIFETIME_SECONDS}`], { deadline });
  if (created.code !== 0) {
    // Creation can partially succeed. Take two independent server observations
    // and delegate even this failure path to the sole identity-bound teardown.
    const firstPid = await tmuxReportedServerPid(tmux, socket, DEFAULT_COMMAND_TIMEOUT_MS);
    const secondPid = await tmuxReportedServerPid(tmux, socket, DEFAULT_COMMAND_TIMEOUT_MS);
    const socketStat = await fs.lstat(socket).catch(() => null);
    const startedAt = firstPid !== null && firstPid === secondPid ? getProcessStartedAt(firstPid) : null;
    const binding = firstPid !== null && secondPid !== null && startedAt !== null && socketStat?.isSocket() && !socketStat.isSymbolicLink()
      ? { server: { pid: firstPid, startedAt }, socket: { dev: BigInt(socketStat.dev), ino: BigInt(socketStat.ino) }, socketRoot: creationSocketRoot, creationServerPids: [firstPid, secondPid] as const }
      : null;
    await teardownIdentityBoundTmuxServer({ tmux, socket, socketRoot, binding }).catch(() => undefined);
    throw new Error("could not create isolated tmux source; identity-bound teardown was attempted and ambiguous roots were retained");
  }
  let tmuxBinding: TmuxServerBinding | null = null;
  try {
    // Bind the server/root/socket immediately after successful creation, before
    // any source inspection can fail. Later fixture process identities extend
    // this authority; they never replace its creation generation.
    tmuxBinding = await bindCreatedTmuxServer(tmux, socket, socketRoot, creationSocketRoot, DEFAULT_COMMAND_TIMEOUT_MS);
    if (!tmuxBinding) throw new Error("isolated tmux creation binding is unavailable; private socket root retained");
    await testHooks.afterBinding?.("creation", { socket, socketRoot, binding: tmuxBinding });
    const identity = await run(tmux, ["-S", socket, "display-message", "-p", "-t", `${session}:0.0`, "#{pane_id}\t#{pid}"], { deadline });
    const identityMatch = identity.stdout.trim().match(/^(%\d+)\t(\d+)$/);
    if (!identityMatch) throw new Error("isolated tmux source unavailable");
    const source = identityMatch[1]!, serverPid = Number(identityMatch[2]);
    const server = await run(tmux, ["-S", socket, "display-message", "-p", "-t", source, "#{pid}"], { deadline });
    const actualServerPid = Number(server.stdout.trim());
    if (!Number.isSafeInteger(actualServerPid) || actualServerPid <= 0) throw new Error("isolated tmux server identity unavailable");
    if (serverPid !== actualServerPid || actualServerPid !== tmuxBinding.server.pid || getProcessStartedAt(actualServerPid) !== tmuxBinding.server.startedAt) throw new Error("isolated tmux server PID observations disagree");
    const sourcePanePidResult = await run(tmux, ["-S", socket, "display-message", "-p", "-t", source, "#{pane_pid}"], { deadline });
    const sourcePanePid = Number(sourcePanePidResult.stdout.trim());
    const sourcePaneStartedAt = Number.isSafeInteger(sourcePanePid) && sourcePanePid > 0 ? getProcessStartedAt(sourcePanePid) : null;
    if (sourcePaneStartedAt === null) throw new Error("isolated tmux source fixture identity unavailable");
    tmuxBinding = { ...tmuxBinding, expectedProcesses: [{ pid: sourcePanePid, startedAt: sourcePaneStartedAt }] };
    await testHooks.afterBinding?.("source", { socket, socketRoot, binding: tmuxBinding });
    const sentinelResult = await run(tmux, ["-S", socket, "split-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-t", source, `exec sleep ${TMUX_SOURCE_SENTINEL_LIFETIME_SECONDS}`], { deadline });
    const sentinelMatch = sentinelResult.stdout.trim().match(/^(%\d+)\t([1-9]\d*)$/);
    if (!sentinelMatch || sentinelMatch[1] === source || serverPid <= 0) throw new Error("isolated tmux sentinel unavailable");
    const sentinel = sentinelMatch[1]!, sentinelPid = Number(sentinelMatch[2]!);
    const sentinelStartedAt = getProcessStartedAt(sentinelPid);
    if (sentinelStartedAt === null) throw new Error("isolated tmux sentinel fixture identity unavailable");
    tmuxBinding = { ...tmuxBinding, expectedProcesses: [...(tmuxBinding.expectedProcesses ?? []), { pid: sentinelPid, startedAt: sentinelStartedAt }] };
    await testHooks.afterBinding?.("sentinel", { socket, socketRoot, binding: tmuxBinding });
    const baseline = new Set([source, sentinel]);
    const listPanes = async (withinCell = true): Promise<string[]> => {
      const result = await run(tmux, ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"], withinCell ? { deadline } : { timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS });
      if (result.code !== 0) throw new Error("tmux topology inspection failed");
      const panes = result.stdout.trim().split(/\s+/).filter(Boolean);
      if (new Set(panes).size !== panes.length || !panes.every((pane) => /^%\d+$/.test(pane))) throw new Error("tmux topology was malformed");
      return panes;
    };
    const barrier: ActionBarrier = async (_child, expected, deadline, signal) => {
      let targets: string[] = [];
      while (remainingDeadlineMs(deadline) > 0) {
        if (signal?.aborted) throw new Error("Phase 0 action barrier aborted");
        const panes = await listPanes(); targets = panes.filter((pane) => !baseline.has(pane)).sort();
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
          const closed = await run(tmux, ["-S", socket, "kill-pane", "-t", target]);
          if (closed.code !== 0 || (await listPanes()).includes(target)) throw new Error("tmux exact target close was not proven");
        }
      } };
    };
    let sampling = true, maxBackendTargets = 0;
    const topologySampler = (async () => { while (sampling) { try { maxBackendTargets = Math.max(maxBackendTargets, (await listPanes()).filter((pane) => !baseline.has(pane)).length); } catch { /* final checks fail closed */ } await new Promise((resolve) => setTimeout(resolve, 25)); } })();
    let cell: Awaited<ReturnType<typeof runParentCell>>;
    try { cell = await runParentCell(root, agentDir, extension, piBin, activeRuns, workload, { TMUX: `${socket},${actualServerPid},0`, TMUX_PANE: source }, barrier, false, deadline); }
    finally { sampling = false; await topologySampler; }
    if (maxBackendTargets < activeRuns) throw new Error(`tmux topology observed only ${maxBackendTargets}/${activeRuns} concurrent targets`);
    cell.backend.topologyProbeCount = maxBackendTargets;
    const cleanupDeadline = Date.now() + 20_000; let finalPanes = await listPanes(false);
    while (Date.now() < cleanupDeadline && (finalPanes.length !== 2 || !finalPanes.includes(source) || !finalPanes.includes(sentinel))) { await new Promise((resolve) => setTimeout(resolve, 100)); finalPanes = await listPanes(false); }
    if (finalPanes.length !== 2 || !finalPanes.includes(source) || !finalPanes.includes(sentinel)) throw new Error("tmux source/sentinel preservation or child cleanup failed");
    cell.cleanup.residualBackendTargetCount = finalPanes.filter((pane) => !baseline.has(pane)).length;
    return cell;
  } finally {
    // If creation could not be bound, the private root is deliberately retained.
    // Once bound, every post-creation failure must take the guarded kill path.
    if (tmuxBinding) await teardownIdentityBoundTmuxServer({ tmux, socket, socketRoot, binding: tmuxBinding });
  }
}

