import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJUnitXml, type JUnitTestOutcome } from "./junit-report";

export const HEAVY_STAGE_FILES = {
	phase0: ["test/acceptance/performance-phase0.test.ts"],
	reaper: ["test/acceptance/reaper-performance.test.ts", "test/runtime/reaper-coordinator-heavy.test.ts"],
	sessionTail: ["test/runtime/session-tail-heavy.test.ts"],
} as const;

export type CiStage = "core" | keyof typeof HEAVY_STAGE_FILES;
export type CiInventory = Record<CiStage, string[]>;
type StageStatus = "success" | "failure" | "timed_out" | "signaled" | "spawn_error" | "cleanup_incomplete";

type ProcessResource = {
	observedPeakProcessCount: number | null;
	observedPeakRssBytes: number | null;
	observedPeakCumulativeCpuUserTicks: number | null;
	observedPeakCumulativeCpuSystemTicks: number | null;
	observedPeakCumulativeReadBytes: number | null;
	observedPeakCumulativeWriteBytes: number | null;
};

export type TestOutcome = JUnitTestOutcome;
type SupervisorRecord = { exitCode: number | null; signal: NodeJS.Signals | null; spawnError: boolean; cleanupComplete: boolean; cleanupErrors: string[] };
export type SecureDiagnosticDirectory = { directory: string; dev: number; ino: number };
type ProcessIdentity = { pid: number; startTicks: number; session: number };

export type OwnedStageResult = {
	status: StageStatus;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	diagnosticPath?: string;
};

export type OwnedStageOptions = {
	stage: string;
	command: readonly string[];
	cwd?: string;
	timeoutMs: number;
	diagnosticsDirectory?: string;
	testOutcome?: TestOutcome;
	testOutcomeLoader?: () => Promise<TestOutcome>;
	/** Hosted CI opts into Linux's subreaper boundary explicitly. */
	strictLinux?: boolean;
	/** Test-only pre-PDEATHSIG barrier; never inherited by the workload. */
	testBootstrapBarrierPath?: string;
	/** Test-only parent-death result marker; never inherited by the workload. */
	testBootstrapResultPath?: string;
	/** Test-only private-pipe hook after direct Popen.poll() and before adopted-child reaping. */
	testSupervisorHooks?: {
		afterDirectPollBeforeReap?: () => Promise<void> | void;
		onOwnedDescendantObserved?: (identity: ProcessIdentity) => void;
	};
};

const TEST_FILE = /(?:\.test|_test|\.spec|_spec)\.(?:js|jsx|ts|tsx)$/;
const RAW_REPORT_MAX_BYTES = 1024 * 1024;
const DIAGNOSTIC_MAX_BYTES = 8 * 1024;
// Must exceed the subreaper's own TERM phase so Bun never SIGKILLs it mid-cleanup.
const TERMINATION_GRACE_MS = 5_000;
const TERMINATION_KILL_MS = 2_000;
const STAGE_TIMEOUT_MS: Record<CiStage, number> = {
	core: 15 * 60_000,
	phase0: 20 * 60_000,
	reaper: 20 * 60_000,
	sessionTail: 20 * 60_000,
};

let activeStageAbort: (() => Promise<void>) | undefined;
let shutdownRequested = false;

function relative(root: string, value: string): string {
	return path.relative(root, value).split(path.sep).join("/");
}

/** Discover Bun's documented .test/_test/.spec/_spec JS/TS filename forms from the repository root. */
export async function discoverBunTestFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	async function visit(directory: string): Promise<void> {
		for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
			// These are Bun/repository implementation directories, not test roots.
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) await visit(target);
			else if (entry.isFile() && TEST_FILE.test(entry.name)) found.push(relative(root, target));
		}
	}
	await visit(root);
	return found.sort();
}

/** Partition every discovered test file exactly once; required heavy files must exist and remain heavy. */
export function validateCiInventory(discovered: readonly string[], inventory: CiInventory): void {
	const assigned = Object.values(inventory).flat();
	const required = Object.values(HEAVY_STAGE_FILES).flat();
	const missingRequired = required.filter((file) => !discovered.includes(file) || !assigned.includes(file));
	const duplicate = assigned.filter((file, index) => assigned.indexOf(file) !== index);
	const unassigned = discovered.filter((file) => !assigned.includes(file));
	const invalidStage = Object.entries(inventory).filter(([, files]) => files.length === 0).map(([stage]) => stage);
	if (missingRequired.length || duplicate.length || unassigned.length || invalidStage.length || assigned.length !== discovered.length) {
		throw new Error(`invalid CI test inventory: missing=${missingRequired.join(",") || "none"}; duplicate=${[...new Set(duplicate)].join(",") || "none"}; unassigned=${unassigned.join(",") || "none"}; empty=${invalidStage.join(",") || "none"}`);
	}
}

export async function createCiInventory(root = process.cwd()): Promise<CiInventory> {
	const discovered = await discoverBunTestFiles(root);
	const heavy = new Set<string>(Object.values(HEAVY_STAGE_FILES).flat());
	const inventory: CiInventory = {
		core: discovered.filter((file) => !heavy.has(file)),
		phase0: [...HEAVY_STAGE_FILES.phase0],
		reaper: [...HEAVY_STAGE_FILES.reaper],
		sessionTail: [...HEAVY_STAGE_FILES.sessionTail],
	};
	validateCiInventory(discovered, inventory);
	return inventory;
}

function parseLinuxStat(value: string): { ppid: number; pgrp: number; session: number; user: number; system: number; startTicks: number } | null {
	const end = value.lastIndexOf(")");
	if (end < 0) return null;
	const fields = value.slice(end + 1).trim().split(/\s+/);
	const ppid = Number(fields[1]), pgrp = Number(fields[2]), session = Number(fields[3]), user = Number(fields[11]), system = Number(fields[12]), startTicks = Number(fields[19]);
	return [ppid, pgrp, session, user, system, startTicks].every(Number.isFinite) ? { ppid, pgrp, session, user, system, startTicks } : null;
}

async function processStartTicks(pid: number): Promise<number | null> {
	if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
	return parseLinuxStat(await fs.promises.readFile(`/proc/${pid}/stat`, "utf8").catch(() => ""))?.startTicks ?? null;
}

async function ownedProcessResource(processGroup: number): Promise<ProcessResource> {
	const unavailable: ProcessResource = {
		observedPeakProcessCount: null, observedPeakRssBytes: null,
		observedPeakCumulativeCpuUserTicks: null, observedPeakCumulativeCpuSystemTicks: null,
		observedPeakCumulativeReadBytes: null, observedPeakCumulativeWriteBytes: null,
	};
	if (process.platform !== "linux") return unavailable;
	let processes = 0, rss = 0, user = 0, system = 0, read = 0, write = 0;
	let rssAvailable = true, ioAvailable = true;
	try {
		for (const entry of await fs.promises.readdir("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			const stat = parseLinuxStat(await fs.promises.readFile(`/proc/${entry}/stat`, "utf8").catch(() => ""));
			if (!stat || stat.pgrp !== processGroup) continue;
			processes += 1;
			user += stat.user; system += stat.system;
			const status = await fs.promises.readFile(`/proc/${entry}/status`, "utf8").catch(() => "");
			const rssMatch = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
			if (!rssMatch) rssAvailable = false; else rss += Number(rssMatch[1]) * 1024;
			const io = await fs.promises.readFile(`/proc/${entry}/io`, "utf8").catch(() => "");
			const readMatch = /^read_bytes:\s+(\d+)$/m.exec(io), writeMatch = /^write_bytes:\s+(\d+)$/m.exec(io);
			if (!readMatch || !writeMatch) ioAvailable = false;
			else { read += Number(readMatch[1]); write += Number(writeMatch[1]); }
		}
		return {
			observedPeakProcessCount: processes,
			observedPeakRssBytes: rssAvailable ? rss : null,
			observedPeakCumulativeCpuUserTicks: user,
			observedPeakCumulativeCpuSystemTicks: system,
			observedPeakCumulativeReadBytes: ioAvailable ? read : null,
			observedPeakCumulativeWriteBytes: ioAvailable ? write : null,
		};
	} catch { return unavailable; }
}

function peakResource(current: ProcessResource, next: ProcessResource): ProcessResource {
	const peak = (left: number | null, right: number | null) => left === null || right === null ? null : Math.max(left, right);
	return {
		observedPeakProcessCount: peak(current.observedPeakProcessCount, next.observedPeakProcessCount),
		observedPeakRssBytes: peak(current.observedPeakRssBytes, next.observedPeakRssBytes),
		observedPeakCumulativeCpuUserTicks: peak(current.observedPeakCumulativeCpuUserTicks, next.observedPeakCumulativeCpuUserTicks),
		observedPeakCumulativeCpuSystemTicks: peak(current.observedPeakCumulativeCpuSystemTicks, next.observedPeakCumulativeCpuSystemTicks),
		observedPeakCumulativeReadBytes: peak(current.observedPeakCumulativeReadBytes, next.observedPeakCumulativeReadBytes),
		observedPeakCumulativeWriteBytes: peak(current.observedPeakCumulativeWriteBytes, next.observedPeakCumulativeWriteBytes),
	};
}

async function filesystemCapacityBytes(cwd: string): Promise<number | null> {
	try {
		const stats = await fs.promises.statfs(cwd);
		const bytes = Number(stats.bsize) * Number(stats.blocks);
		return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
	} catch { return null; }
}

async function isExpectedLeader(pid: number, expectedStart: number): Promise<boolean> {
	return await processStartTicks(pid) === expectedStart;
}

async function groupMemberCount(processGroup: number): Promise<number | null> {
	if (process.platform !== "linux") return null;
	try {
		let count = 0;
		for (const entry of await fs.promises.readdir("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			if (parseLinuxStat(await fs.promises.readFile(`/proc/${entry}/stat`, "utf8").catch(() => ""))?.pgrp === processGroup) count += 1;
		}
		return count;
	} catch { return null; }
}

async function waitForGroupEmpty(processGroup: number, deadlineMs: number): Promise<boolean> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() <= deadline) {
		if (await groupMemberCount(processGroup) === 0) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return await groupMemberCount(processGroup) === 0;
}

async function observeOwnedDescendants(supervisorPid: number, identities: Map<number, ProcessIdentity>): Promise<void> {
	if (process.platform !== "linux") return;
	const table = new Map<number, ReturnType<typeof parseLinuxStat>>();
	try {
		for (const entry of await fs.promises.readdir("/proc")) {
			if (/^\d+$/.test(entry)) table.set(Number(entry), parseLinuxStat(await fs.promises.readFile(`/proc/${entry}/stat`, "utf8").catch(() => "")));
		}
	} catch { return; }
	const parents = new Set<number>([supervisorPid]);
	let advanced = true;
	while (advanced) {
		advanced = false;
		for (const [pid, stat] of table) {
			if (!stat || pid === supervisorPid || !parents.has(stat.ppid)) continue;
			if (!identities.has(pid)) identities.set(pid, { pid, startTicks: stat.startTicks, session: stat.session });
			if (!parents.has(pid)) { parents.add(pid); advanced = true; }
		}
	}
}

async function cleanupTrackedDescendants(identities: ReadonlyMap<number, ProcessIdentity>): Promise<{ complete: boolean; errors: string[] }> {
	if (process.platform !== "linux") return { complete: true, errors: ["portable-direct-child-cleanup-no-descendant-guarantee"] };
	const errors: string[] = [];
	const live = async (): Promise<ProcessIdentity[]> => {
		const remaining: ProcessIdentity[] = [];
		for (const identity of identities.values()) if (await processStartTicks(identity.pid) === identity.startTicks) remaining.push(identity);
		return remaining;
	};
	const signal = async (name: NodeJS.Signals) => {
		for (const identity of await live()) {
			// Start time is the authority; session is retained as diagnostic provenance only.
			if (await processStartTicks(identity.pid) !== identity.startTicks) continue;
			try { process.kill(identity.pid, name); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(`tracked-${name}:${(error as NodeJS.ErrnoException).code ?? "unknown"}`); }
		}
	};
	const settle = async (deadline: number): Promise<boolean> => {
		while (Date.now() < deadline) {
			if ((await live()).length === 0) return errors.length === 0;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return (await live()).length === 0 && errors.length === 0;
	};
	await signal("SIGTERM");
	if (await settle(Date.now() + TERMINATION_GRACE_MS)) return { complete: true, errors };
	await signal("SIGKILL");
	if (await settle(Date.now() + TERMINATION_KILL_MS)) return { complete: true, errors };
	errors.push("tracked-owned-processes-not-settled");
	return { complete: false, errors };
}

const PYTHON_SUPERVISOR = String.raw`
import ctypes, json, os, signal, subprocess, sys, time
PR_SET_PDEATHSIG = 1
PR_SET_CHILD_SUBREAPER = 36
GROUP = os.getpgrp()
SELF = os.getpid()
errors, tracked = [], {}
stopping = False
bootstrapping = True
test_poll_barrier_used = False
child = None

class SafeAbort(Exception): pass

def proc(pid):
    try:
        raw = open("/proc/%d/stat" % pid).read()
        tail = raw[raw.rfind(")") + 1:].split()
        return {"ppid": int(tail[1]), "pgrp": int(tail[2]), "session": int(tail[3]), "start": int(tail[19])}
    except Exception:
        return None

def snapshot():
    try:
        return {int(name): item for name in os.listdir("/proc") if name.isdigit() for item in [proc(int(name))] if item is not None}
    except Exception as exc:
        errors.append("proc-enumeration:%s" % type(exc).__name__)
        return None

def reap_adopted(table):
    # Reap only zombies that the subreaper adopted.  The direct Popen child is
    # deliberately excluded so its return status remains Popen's authority.
    if table is None: return
    direct = child.pid if child is not None else None
    for pid, item in table.items():
        if pid == SELF or pid == direct or item["ppid"] != SELF: continue
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError: pass
        except Exception as exc:
            errors.append("waitpid:%s" % type(exc).__name__)

def reap_after_workload():
    # Popen.poll()/wait() has already consumed the direct child before callers
    # use this generic reap, so it cannot consume Popen's status.
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if pid == 0: return
        except ChildProcessError: return
        except Exception as exc:
            errors.append("waitpid:%s" % type(exc).__name__); return

def observe():
    table = snapshot()
    if table is None: return None
    # PR_SET_CHILD_SUBREAPER makes detached orphans direct children.  We retain
    # PID/start/session observations, never session-only authority.
    frontier, seen = {SELF}, set()
    while frontier:
        parents, frontier = frontier, set()
        for pid, item in table.items():
            if pid != SELF and item["ppid"] in parents and pid not in seen:
                seen.add(pid); frontier.add(pid)
                tracked[pid] = (item["start"], item["session"])
    return table

def live_targets(table):
    if table is None: return None
    targets = {}
    for pid, item in table.items():
        if pid != SELF and item["pgrp"] == GROUP: targets[pid] = item
    for pid, (start, session) in list(tracked.items()):
        item = table.get(pid)
        if item is None: continue
        if item["start"] == start:
            targets[pid] = item
        else:
            # PID reuse is never signal authority.
            errors.append("pid-reused")
    return targets

def signal_targets(sig):
    table = observe()
    targets = live_targets(table)
    if targets is None: return False
    ok = True
    for pid, expected in targets.items():
        current = proc(pid)
        if current is None or current["start"] != expected["start"]: continue
        try: os.kill(pid, sig)
        except ProcessLookupError: pass
        except Exception as exc:
            errors.append("signal-%d:%s" % (sig, type(exc).__name__)); ok = False
    return ok

def settle(deadline):
    while time.monotonic() < deadline:
        reap_after_workload()
        table = observe(); targets = live_targets(table)
        if targets == {}: return len(errors) == 0
        time.sleep(.025)
    reap_after_workload()
    table = observe(); targets = live_targets(table)
    return targets == {} and len(errors) == 0

def cleanup():
    signal_targets(signal.SIGTERM)
    # Do not generic-wait while the direct Popen child is alive: that could
    # consume its status. First give the whole observed set its TERM budget.
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        if child is not None and child.poll() is None:
            time.sleep(.025); continue
        reap_after_workload()
        if live_targets(observe()) == {}: return len(errors) == 0
        time.sleep(.025)
    signal_targets(signal.SIGKILL)
    if child is not None and child.poll() is None:
        try: child.wait(timeout=2.0)
        except Exception: errors.append("workload-not-reaped-after-kill")
    if settle(time.monotonic() + 2.0): return True
    errors.append("residual-owned-processes")
    return False

def stop(signum, frame):
    global stopping
    stopping = True
    # Before Popen, abort synchronously instead of falling through to launch.
    # Once Popen begins, retain its child handle and use bounded cleanup.
    if bootstrapping: raise SafeAbort("cancelled-before-workload-spawn")

def after_direct_poll_test_barrier():
    global test_poll_barrier_used
    if test_poll_barrier_used: return
    # Extra FDs exist only for the narrowly scoped test hook. They are not
    # inherited by Popen (close_fds default) or configured through ambient env.
    try:
        os.write(4, b"R")
        if os.read(4, 1) != b"C": raise RuntimeError("invalid-test-hook-release")
        test_poll_barrier_used = True
    except OSError:
        return

expected_parent_raw = os.environ.pop("CI_STAGE_EXPECTED_PARENT_PID", "")
test_bootstrap_barrier = os.environ.pop("CI_STAGE_TEST_BOOTSTRAP_BARRIER", "")
test_bootstrap_result = os.environ.pop("CI_STAGE_TEST_BOOTSTRAP_RESULT", "")

def write_test_bootstrap_result(value):
    if not test_bootstrap_result: return
    try:
        fd = os.open(test_bootstrap_result, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try: os.write(fd, value.encode())
        finally: os.close(fd)
    except Exception: pass

record = {"exitCode": None, "signal": None, "spawnError": False, "cleanupComplete": False, "cleanupErrors": errors}
try:
    try: expected_parent = int(expected_parent_raw)
    except Exception: raise RuntimeError("invalid-expected-parent")
    if expected_parent <= 1: raise RuntimeError("invalid-expected-parent")
    # Install the bootstrap-aware handler before enabling PDEATHSIG: a signal
    # before Popen raises SafeAbort; a signal during/after Popen is cleaned.
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # Both protections are installed before the workload is spawned. PDEATHSIG
    # asks this stable subreaper to clean up if the outer Bun process disappears.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0: raise OSError(ctypes.get_errno(), "PR_SET_CHILD_SUBREAPER")
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0: raise OSError(ctypes.get_errno(), "PR_SET_PDEATHSIG")
    # The original outer PID is supplied by Bun before spawn. Checking only a
    # post-orphan getppid() would allow a workload to start after parent death.
    if os.getppid() != expected_parent:
        write_test_bootstrap_result("parent-mismatch")
        raise RuntimeError("outer-parent-changed-before-workload")
    # This barrier is after the parent check and before Popen, so a test can
    # deterministically deliver cancellation in the otherwise narrow window.
    if test_bootstrap_barrier:
        fd = os.open(test_bootstrap_barrier, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        while os.path.exists(test_bootstrap_barrier): time.sleep(.005)
    # The check is intentionally adjacent to Popen. A signal after this check
    # may race with OS process creation; it leaves stopping set and cleanup is
    # bounded once Popen returns rather than claiming an atomic no-spawn edge.
    bootstrapping = False
    if stopping: raise SafeAbort("cancelled-before-workload-spawn")
    # Reserve standard stdout for the bounded terminal record. Workload output
    # remains visible on inherited stderr, without an extra Bun stdio pipe.
    child = subprocess.Popen(sys.argv[1:], stdout=sys.stderr, stderr=sys.stderr, env={key: value for key, value in os.environ.items() if key != "CI_STAGE_DIAGNOSTICS_DIR"})
    while child.poll() is None and not stopping:
        after_direct_poll_test_barrier()
        table = observe(); reap_adopted(table); time.sleep(.02)
    record["cleanupComplete"] = cleanup()
    code = child.returncode
    if code is not None:
        record["exitCode"] = code if code >= 0 else None
        if code < 0: record["signal"] = signal.Signals(-code).name
except SafeAbort:
    write_test_bootstrap_result("cancelled-before-workload-spawn")
    record["spawnError"] = True
    record["cleanupComplete"] = cleanup()
except Exception as exc:
    record["spawnError"] = True
    errors.append("supervisor:%s" % type(exc).__name__)
    record["cleanupComplete"] = cleanup()
os.write(1, (json.dumps(record, separators=(",", ":")) + "\n").encode())
sys.exit(0 if record["cleanupComplete"] else 75)
`;

function parseSupervisorRecord(value: string): SupervisorRecord | null {
	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as Record<string, unknown>;
		const exitCode = record.exitCode === null || Number.isSafeInteger(record.exitCode) ? record.exitCode as number | null : undefined;
		const signal = record.signal === null || typeof record.signal === "string" ? record.signal as NodeJS.Signals | null : undefined;
		if (exitCode === undefined || signal === undefined || typeof record.spawnError !== "boolean" || typeof record.cleanupComplete !== "boolean" || !Array.isArray(record.cleanupErrors) || !record.cleanupErrors.every((error) => typeof error === "string")) return null;
		return { exitCode, signal, spawnError: record.spawnError, cleanupComplete: record.cleanupComplete, cleanupErrors: record.cleanupErrors };
	} catch { return null; }
}

function collectBounded(stream: import("node:stream").Readable, limit: number, closed: Promise<void>): Promise<string> {
	return new Promise((resolve, reject) => {
		let value = "", settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			stream.off("data", onData); stream.off("end", onEnd); stream.off("error", onError);
			if (error) reject(error); else resolve(value);
		};
		const onData = (chunk: Buffer) => {
			value += Buffer.from(chunk).toString("utf8");
			if (Buffer.byteLength(value) > limit) finish(new Error("supervisor terminal record exceeded its cap"));
		};
		const onEnd = () => finish();
		const onError = (error: Error) => finish(error);
		stream.on("data", onData); stream.once("end", onEnd); stream.once("error", onError);
		// Child close follows stdio closure. Missing terminal stream events must
		// never leave a dead supervisor's reader pending; absent data fails parsing.
		void closed.then(() => { finish(); if (!stream.destroyed) stream.destroy(); });
	});
}

/** Request bounded supervisor cleanup, then only escalate while its original Linux identity still exists. */
async function terminateOwnedSupervisor(child: ChildProcess, expectedStart: number, closed: Promise<unknown>, tracked: ReadonlyMap<number, ProcessIdentity>): Promise<{ complete: boolean; errors: string[] }> {
	const errors: string[] = [];
	if (!child.pid || !await isExpectedLeader(child.pid, expectedStart)) return { complete: false, errors: ["supervisor-identity-unavailable"] };
	try { process.kill(child.pid, "SIGTERM"); } catch (error) { errors.push(`supervisor-term:${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "unknown"}`); }
	const ended = await Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TERMINATION_GRACE_MS))]);
	if (!ended && await isExpectedLeader(child.pid, expectedStart)) {
		try { process.kill(-child.pid, "SIGKILL"); } catch (error) { errors.push(`group-kill:${error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "unknown"}`); }
	}
	const groupEmpty = await waitForGroupEmpty(child.pid, TERMINATION_KILL_MS);
	if (!groupEmpty) errors.push("group-not-empty-after-bounded-cleanup");
	// The group is not claimed to contain setsid descendants. Those observed by
	// the outer owner are signalled only by exact PID/start-time identity.
	const trackedResult = await cleanupTrackedDescendants(tracked);
	errors.push(...trackedResult.errors);
	return { complete: groupEmpty && trackedResult.complete && errors.length === 0, errors };
}

async function secureDiagnosticDirectory(root: string): Promise<SecureDiagnosticDirectory> {
	const base = await fs.promises.lstat(root);
	if (!base.isDirectory() || base.isSymbolicLink()) throw new Error("diagnostics root must be an existing non-symlink directory");
	const directory = await fs.promises.mkdtemp(path.join(root, "ci-stage-"));
	const identity = await fs.promises.lstat(directory);
	if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("diagnostics directory is not a regular directory");
	return { directory, dev: identity.dev, ino: identity.ino };
}

async function verifyDiagnosticDirectory(directory: SecureDiagnosticDirectory): Promise<void> {
	const current = await fs.promises.lstat(directory.directory);
	if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== directory.dev || current.ino !== directory.ino) throw new Error("diagnostics directory identity changed");
}

function safeStageName(stage: string): string { return stage.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64); }

function validDiagnostic(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	const resource = record.ownedProcess, outcome = record.testOutcome, platform = record.platform, toolchain = record.toolchain;
	const topLevelKeys = ["schemaVersion", "stage", "final", "status", "durationMs", "toolchain", "platform", "ownedProcess", "partialErrors", ...(outcome === undefined ? [] : ["testOutcome"])];
	if (Object.keys(record).length !== topLevelKeys.length || !topLevelKeys.every((key) => Object.hasOwn(record, key))) return false;
	const numbersOrNull = (item: unknown) => item === null || (typeof item === "number" && Number.isSafeInteger(item) && item >= 0);
	const exactNumberRecord = (item: unknown, keys: readonly string[]) => !!item && typeof item === "object" && !Array.isArray(item)
		&& Object.keys(item as Record<string, unknown>).length === keys.length && keys.every((key) => numbersOrNull((item as Record<string, unknown>)[key]));
	const resourceKeys = ["observedPeakProcessCount", "observedPeakRssBytes", "observedPeakCumulativeCpuUserTicks", "observedPeakCumulativeCpuSystemTicks", "observedPeakCumulativeReadBytes", "observedPeakCumulativeWriteBytes"];
	const outcomeKeys = ["tests", "passed", "skipped", "failures", "errors"];
	const exactKeys = (item: unknown, keys: readonly string[]) => !!item && typeof item === "object" && !Array.isArray(item) && Object.keys(item as Record<string, unknown>).length === keys.length && keys.every((key) => Object.hasOwn(item as Record<string, unknown>, key));
	return record.schemaVersion === 1 && record.final === true && typeof record.stage === "string" && record.stage.length > 0 && record.stage.length <= 64 && ["success", "failure", "timed_out", "signaled", "spawn_error", "cleanup_incomplete"].includes(String(record.status))
		&& typeof record.durationMs === "number" && Number.isSafeInteger(record.durationMs) && record.durationMs >= 0
		&& exactKeys(toolchain, ["bun"]) && (typeof (toolchain as Record<string, unknown>).bun === "string" || (toolchain as Record<string, unknown>).bun === null)
		&& exactKeys(platform, ["os", "arch", "cpuCount", "memoryBytes", "filesystemCapacityBytes"]) && typeof (platform as Record<string, unknown>).os === "string" && typeof (platform as Record<string, unknown>).arch === "string" && numbersOrNull((platform as Record<string, unknown>).cpuCount) && numbersOrNull((platform as Record<string, unknown>).memoryBytes) && numbersOrNull((platform as Record<string, unknown>).filesystemCapacityBytes)
		&& Array.isArray(record.partialErrors) && record.partialErrors.every((item) => typeof item === "string" && item.length <= 128)
		&& exactNumberRecord(resource, resourceKeys)
		&& (outcome === undefined || exactNumberRecord(outcome, outcomeKeys));
}

async function publishDiagnostic(directory: SecureDiagnosticDirectory, filename: string, encoded: string): Promise<string> {
	if (Buffer.byteLength(encoded) > DIAGNOSTIC_MAX_BYTES) throw new Error("sanitized stage diagnostic exceeded its 8 KiB cap");
	await verifyDiagnosticDirectory(directory);
	const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const temporary = path.join(directory.directory, `.${filename}.${nonce}.tmp`);
	const target = path.join(directory.directory, filename);
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
	const handle = await fs.promises.open(temporary, flags, 0o600);
	try { await handle.writeFile(encoded); } finally { await handle.close(); }
	try {
		await verifyDiagnosticDirectory(directory);
		await fs.promises.link(temporary, target); // publish without replacing a possible foreign file
		await fs.promises.unlink(temporary);
		await verifyDiagnosticDirectory(directory);
		const published = await readBoundedFile(target, DIAGNOSTIC_MAX_BYTES);
		if (!validDiagnostic(JSON.parse(published))) throw new Error("published diagnostic violates schema");
		return target;
	} catch (error) {
		await fs.promises.unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function writeDiagnostic(directory: SecureDiagnosticDirectory, stage: string, status: StageStatus, durationMs: number, resource: ProcessResource, cwd: string, testOutcome?: TestOutcome, extraErrors: readonly string[] = []): Promise<string> {
	const capacity = await filesystemCapacityBytes(cwd);
	const partialErrors = [...extraErrors];
	if (capacity === null) partialErrors.push("filesystem-capacity-unavailable");
	if (Object.values(resource).some((value) => value === null)) partialErrors.push("owned-process-resource-partial-or-unavailable");
	const body = {
		schemaVersion: 1, stage: safeStageName(stage), final: true, status,
		durationMs: Math.max(0, Math.round(durationMs)), toolchain: { bun: process.versions.bun ?? null },
		platform: { os: process.platform, arch: process.arch, cpuCount: os.cpus().length, memoryBytes: os.totalmem(), filesystemCapacityBytes: capacity },
		ownedProcess: resource, ...(testOutcome ? { testOutcome } : {}), partialErrors,
	};
	if (!validDiagnostic(body)) throw new Error("diagnostic violates schema before publication");
	return publishDiagnostic(directory, `${body.stage}.json`, `${JSON.stringify(body)}\n`);
}

async function readBoundedFile(file: string, limit: number): Promise<string> {
	const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (stat.size > limit) throw new Error("raw report exceeded its cap");
		const buffer = Buffer.alloc(stat.size);
		await handle.read(buffer, 0, buffer.length, 0);
		return buffer.toString("utf8");
	} finally { await handle.close(); }
}

/** Parse a bounded, structurally well-formed JUnit aggregate. */
export async function parseJUnitReport(file: string): Promise<TestOutcome> {
	return parseJUnitXml(await readBoundedFile(file, RAW_REPORT_MAX_BYTES));
}

/** Reject empty executions everywhere and skipped reporter outcomes in required heavy stages. */
export function validateTestOutcomePolicy(stage: CiStage, outcome: TestOutcome): void {
	if (outcome.passed <= 0 || (stage !== "core" && outcome.skipped !== 0)) throw new Error(`passed=${outcome.passed}, skipped=${outcome.skipped}`);
}

/** Portable orchestration retains the same command/JUnit contract, but cannot prove cleanup of setsid descendants. */
async function runPortableStage(options: OwnedStageOptions): Promise<OwnedStageResult> {
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("stage timeout must be a positive safe integer");
	if (options.command.length === 0) throw new Error("stage command must not be empty");
	const cwd = options.cwd ?? process.cwd(), diagnostics = options.diagnosticsDirectory ? await secureDiagnosticDirectory(options.diagnosticsDirectory) : undefined;
	const started = performance.now();
	let timedOut = false, spawnError = false, termination: Promise<void> | undefined;
	const child = spawn(options.command[0]!, options.command.slice(1), { cwd, stdio: "inherit", env: { ...process.env, CI_STAGE_DIAGNOSTICS_DIR: undefined } });
	let closeCode: number | null = null, closeSignal: NodeJS.Signals | null = null;
	const closed = new Promise<void>((resolve) => child.once("close", (code, signal) => { closeCode = code; closeSignal = signal; resolve(); }));
	child.once("error", () => { spawnError = true; });
	const terminate = () => termination ??= (async () => {
		try { child.kill("SIGTERM"); } catch { /* close/error decides the result */ }
		if (!await Promise.race([closed.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), TERMINATION_GRACE_MS))])) {
			try { child.kill("SIGKILL"); } catch { /* close/error decides the result */ }
			await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, TERMINATION_KILL_MS))]);
		}
	})();
	let signalDiagnostic: Promise<string> | undefined;
	activeStageAbort = async () => { await terminate(); if (diagnostics) signalDiagnostic ??= writeDiagnostic(diagnostics, options.stage, "signaled", performance.now() - started, unavailableResource(), cwd, undefined, ["portable-direct-child-cleanup-no-descendant-guarantee"]); await signalDiagnostic; };
	const timer = setTimeout(() => { timedOut = true; void terminate(); }, options.timeoutMs);
	await closed; clearTimeout(timer);
	let testOutcome = options.testOutcome, outcomeError: string | undefined;
	if (options.testOutcomeLoader) try { testOutcome = await options.testOutcomeLoader(); } catch (error) { outcomeError = `junit-outcome:${error instanceof Error ? error.message.slice(0, 96) : "invalid"}`; }
	const status: StageStatus = spawnError ? "spawn_error" : timedOut ? "timed_out" : closeSignal ? "signaled" : closeCode === 0 && !outcomeError ? "success" : "failure";
	const output: OwnedStageResult = { status, exitCode: closeCode, signal: closeSignal, timedOut };
	if (diagnostics) output.diagnosticPath = signalDiagnostic ? await signalDiagnostic : await writeDiagnostic(diagnostics, options.stage, status, performance.now() - started, unavailableResource(), cwd, testOutcome, ["portable-direct-child-cleanup-no-descendant-guarantee", ...(outcomeError ? [outcomeError] : [])]);
	activeStageAbort = undefined;
	return output;
}

function unavailableResource(): ProcessResource { return { observedPeakProcessCount: null, observedPeakRssBytes: null, observedPeakCumulativeCpuUserTicks: null, observedPeakCumulativeCpuSystemTicks: null, observedPeakCumulativeReadBytes: null, observedPeakCumulativeWriteBytes: null }; }

/** Linux uses a subreaper; non-Linux retains direct-child bounded cleanup only. */
export async function runOwnedStage(options: OwnedStageOptions): Promise<OwnedStageResult> {
	if (options.strictLinux && process.platform !== "linux") throw new Error("--strict-linux requires Linux /proc and Python 3");
	if (process.platform !== "linux") return runPortableStage(options);
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("stage timeout must be a positive safe integer");
	if (options.command.length === 0) throw new Error("stage command must not be empty");
	const cwd = options.cwd ?? process.cwd();
	const diagnostics = options.diagnosticsDirectory ? await secureDiagnosticDirectory(options.diagnosticsDirectory) : undefined;
	const started = performance.now();
	if (shutdownRequested) throw new Error("stage spawn cancelled by signal");
	let timedOut = false, spawnError = false, termination: Promise<{ complete: boolean; errors: string[] }> | undefined;
	// The detached Python process remains the session/group leader until it has observed and cleaned its workload group.
	if (options.testBootstrapBarrierPath !== undefined && !path.isAbsolute(options.testBootstrapBarrierPath)) throw new Error("test bootstrap barrier path must be absolute");
	if (options.testBootstrapResultPath !== undefined && !path.isAbsolute(options.testBootstrapResultPath)) throw new Error("test bootstrap result path must be absolute");
	const supervisorStdio: import("node:child_process").StdioOptions = options.testSupervisorHooks?.afterDirectPollBeforeReap
		? ["ignore", "pipe", "inherit", "ignore", "pipe"]
		: ["ignore", "pipe", "inherit"];
	const child = spawn("python3", ["-c", PYTHON_SUPERVISOR, ...options.command], {
		cwd, stdio: supervisorStdio, detached: true,
		env: {
			...process.env, CI_STAGE_DIAGNOSTICS_DIR: undefined,
			CI_STAGE_EXPECTED_PARENT_PID: String(process.pid),
			CI_STAGE_TEST_BOOTSTRAP_BARRIER: options.testBootstrapBarrierPath,
			CI_STAGE_TEST_BOOTSTRAP_RESULT: options.testBootstrapResultPath,
		},
	});
	let closeCode: number | null = null, closeSignal: NodeJS.Signals | null = null;
	const closed = new Promise<void>((resolve) => child.once("close", (code, signal) => { closeCode = code; closeSignal = signal; resolve(); }));
	child.once("error", () => { spawnError = true; });
	const recordText = collectBounded(child.stdout!, 4 * 1024, closed).catch(() => "");
	const testHook = options.testSupervisorHooks?.afterDirectPollBeforeReap;
	const afterDirectPollHook = testHook ? (async () => {
		const pipe = child.stdio[4] as import("node:stream").Duplex | null;
		if (!pipe) throw new Error("test supervisor hook pipe unavailable");
		const marker = await new Promise<string>((resolve, reject) => {
			pipe.once("data", (chunk) => resolve(Buffer.from(chunk).toString("utf8")));
			pipe.once("error", reject);
		});
		if (marker !== "R") throw new Error("invalid test supervisor hook marker");
		await testHook();
		await new Promise<void>((resolve, reject) => pipe.write("C", (error?: Error | null) => error ? reject(error) : resolve()));
	})() : undefined;
	// Associate the real child synchronously after spawn; this closes the gap
	// where a signal previously emitted a bootstrap report but left a workload alive.
	let earlySignalDiagnostic: Promise<string> | undefined;
	activeStageAbort = async () => {
		try { child.kill("SIGTERM"); } catch { /* close/error decides the result */ }
		await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_MS))]);
		if (diagnostics) earlySignalDiagnostic ??= writeDiagnostic(diagnostics, options.stage, "signaled", performance.now() - started, unavailableResource(), cwd, undefined, ["signal-before-supervisor-identity"]);
		await earlySignalDiagnostic;
	};
	const leaderStart = await processStartTicks(child.pid ?? -1);
	if (!child.pid || leaderStart === null) throw new Error("unable to establish Linux supervisor identity before ownership");
	const tracked = new Map<number, ProcessIdentity>();
	const observeDescendants = async () => {
		const known = new Set(tracked.keys());
		await observeOwnedDescendants(child.pid!, tracked);
		for (const [pid, identity] of tracked) if (!known.has(pid)) options.testSupervisorHooks?.onOwnedDescendantObserved?.(identity);
	};
	await observeDescendants();
	let resource = await ownedProcessResource(child.pid);
	const beginTermination = () => termination ??= terminateOwnedSupervisor(child, leaderStart, closed, tracked);
	let signalDiagnostic: Promise<string> | undefined;
	activeStageAbort = async () => {
		const terminated = await beginTermination();
		if (diagnostics) signalDiagnostic ??= writeDiagnostic(diagnostics, options.stage, "signaled", performance.now() - started, resource, cwd, undefined, terminated.errors);
		await signalDiagnostic;
	};
	const sample = async () => { resource = peakResource(resource, await ownedProcessResource(child.pid!)); };
	const sampler = setInterval(() => { void sample(); }, 250);
	const descendantSampler = setInterval(() => { void observeDescendants(); }, 25);
	const timer = setTimeout(() => { timedOut = true; void beginTermination(); }, options.timeoutMs);
	await closed;
	await afterDirectPollHook;
	clearTimeout(timer); clearInterval(sampler); clearInterval(descendantSampler);
	const terminationResult = termination ? await termination : undefined;
	await sample();
	const supervisor = parseSupervisorRecord((await recordText).trim());
	// If the supervisor was forcibly lost, do not report a green result. We can
	// clean exact identities observed by Bun, but cannot prove an unobserved,
	// hostile same-UID setsid escape without the Linux subreaper's final record.
	const fallback = supervisor?.cleanupComplete === true ? undefined : await cleanupTrackedDescendants(tracked);
	const cleanupErrors = [...(supervisor?.cleanupErrors ?? []), ...(fallback?.errors ?? [])];
	const cleanupComplete = supervisor?.cleanupComplete === true && (terminationResult?.complete ?? true);
	const resultExitCode = supervisor?.exitCode ?? closeCode;
	const resultSignal = supervisor?.signal ?? closeSignal;
	let testOutcome = options.testOutcome;
	let outcomeError: string | undefined;
	if (options.testOutcomeLoader) {
		try { testOutcome = await options.testOutcomeLoader(); }
		catch (error) { outcomeError = `junit-outcome:${error instanceof Error ? error.message.slice(0, 96) : "invalid"}`; }
	}
	const status: StageStatus = spawnError || supervisor?.spawnError ? "spawn_error" : !cleanupComplete ? "cleanup_incomplete" : timedOut ? "timed_out" : resultSignal ? "signaled" : resultExitCode === 0 && !outcomeError ? "success" : "failure";
	const output: OwnedStageResult = { status, exitCode: resultExitCode, signal: resultSignal, timedOut };
	if (diagnostics) output.diagnosticPath = signalDiagnostic ? await signalDiagnostic : earlySignalDiagnostic ? await earlySignalDiagnostic : await writeDiagnostic(diagnostics, options.stage, status, performance.now() - started, resource, cwd, testOutcome, [...cleanupErrors, ...(outcomeError ? [outcomeError] : [])]);
	activeStageAbort = undefined;
	return output;
}

type PinnedReport = { path: string; handle: fs.promises.FileHandle; identity: { dev: number; ino: number } };
type OwnedReportDirectory = { directory: SecureDiagnosticDirectory; report: PinnedReport };

/** Create and retain the final aggregate inode before the coordinator launches. */
async function createOwnedReportDirectory(): Promise<OwnedReportDirectory> {
	const rawDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ci-junit-"));
	const stat = await fs.promises.lstat(rawDirectory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("raw JUnit directory is not a regular directory");
	const directory = { directory: rawDirectory, dev: stat.dev, ino: stat.ino };
	const reportPath = path.join(rawDirectory, "report.xml");
	const handle = await fs.promises.open(reportPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
	try {
		const report = await handle.stat();
		if (!report.isFile()) throw new Error("raw JUnit report is not a regular file");
		return { directory, report: { path: reportPath, handle, identity: { dev: report.dev, ino: report.ino } } };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function verifyPinnedReport(report: PinnedReport): Promise<void> {
	const pinned = await report.handle.stat();
	if (!pinned.isFile() || pinned.dev !== report.identity.dev || pinned.ino !== report.identity.ino) throw new Error("raw JUnit pinned report identity changed");
	const current = await fs.promises.lstat(report.path);
	if (!current.isFile() || current.isSymbolicLink() || current.dev !== report.identity.dev || current.ino !== report.identity.ino) throw new Error("raw JUnit report identity changed; retained without deletion");
}

/** Delete only the parent-pinned final report; retain replacement or scratch evidence. */
export async function cleanupOwnedReportDirectory(directory: SecureDiagnosticDirectory, reportPath: string, reportIdentity?: { dev: number; ino: number }, pinnedHandle?: fs.promises.FileHandle): Promise<void> {
	try {
		try { await verifyDiagnosticDirectory(directory); }
		catch { throw new Error("raw JUnit directory identity changed; retained without deletion"); }
		const entries = await fs.promises.readdir(directory.directory, { withFileTypes: true });
		if (entries.length === 0) { await fs.promises.rmdir(directory.directory); return; }
		if (entries.length !== 1 || entries[0]!.name !== path.basename(reportPath) || !entries[0]!.isFile() || entries[0]!.isSymbolicLink() || !reportIdentity) throw new Error("raw JUnit directory contents are unexpected; retained without deletion");
		if (pinnedHandle) {
			const pinned = await pinnedHandle.stat();
			if (!pinned.isFile() || pinned.dev !== reportIdentity.dev || pinned.ino !== reportIdentity.ino) throw new Error("raw JUnit pinned report identity changed; retained without deletion");
		}
		const current = await fs.promises.lstat(reportPath);
		if (current.isSymbolicLink() || current.dev !== reportIdentity.dev || current.ino !== reportIdentity.ino) throw new Error("raw JUnit report identity changed; retained without deletion");
		await fs.promises.unlink(reportPath);
		await verifyDiagnosticDirectory(directory);
		await fs.promises.rmdir(directory.directory);
	} finally {
		if (pinnedHandle) await pinnedHandle.close();
	}
}

export async function runCiStage(stage: CiStage, root = process.cwd(), strictLinux = false): Promise<OwnedStageResult> {
	const inventory = await createCiInventory(root);
	const reports = await createOwnedReportDirectory();
	const { directory: reportDirectory, report } = reports;
	try {
		const coordinator = fileURLToPath(new URL("./ci-test-coordinator.ts", import.meta.url));
		const command = [process.execPath, coordinator, "--expected-report-identity", String(report.identity.dev), String(report.identity.ino), report.path, ...inventory[stage]];
		return await runOwnedStage({
			stage, command, cwd: root, timeoutMs: STAGE_TIMEOUT_MS[stage], diagnosticsDirectory: process.env.CI_STAGE_DIAGNOSTICS_DIR,
			strictLinux,
			testOutcomeLoader: async () => {
				// The coordinator may never hand off a replacement inode. Read through
				// the parent-held descriptor, then re-check the pathname before cleanup.
				await verifyDiagnosticDirectory(reportDirectory);
				await verifyPinnedReport(report);
				const stat = await report.handle.stat();
				if (stat.size > RAW_REPORT_MAX_BYTES) throw new Error("raw report exceeded its cap");
				const outcome = parseJUnitXml(await report.handle.readFile({ encoding: "utf8" }));
				await verifyDiagnosticDirectory(reportDirectory);
				await verifyPinnedReport(report);
				validateTestOutcomePolicy(stage, outcome);
				return outcome;
			},
		});
	} finally {
		// The stage waits for its direct/adopted descendants before this identity check.
		await cleanupOwnedReportDirectory(reportDirectory, report.path, report.identity, report.handle);
	}
}

export async function validateDiagnosticDirectory(root: string): Promise<string> {
	const base = await fs.promises.lstat(root);
	if (!base.isDirectory() || base.isSymbolicLink()) throw new Error("diagnostics root must be a non-symlink directory");
	const entries = await fs.promises.readdir(root, { withFileTypes: true });
	if (entries.length !== 1 || !entries[0]!.isDirectory() || entries[0]!.isSymbolicLink() || !/^ci-stage-[A-Za-z0-9_-]+$/.test(entries[0]!.name)) throw new Error("diagnostics root must contain exactly one non-hidden report directory");
	const directory = path.join(root, entries[0]!.name);
	const files = await fs.promises.readdir(directory, { withFileTypes: true });
	if (files.length !== 1 || !files[0]!.isFile() || files[0]!.isSymbolicLink() || !/^[A-Za-z0-9_-]{1,64}\.json$/.test(files[0]!.name)) throw new Error("report directory must contain exactly one regular JSON manifest entry");
	const report = path.join(directory, files[0]!.name);
	const parsed = JSON.parse(await readBoundedFile(report, DIAGNOSTIC_MAX_BYTES));
	if (!validDiagnostic(parsed) || files[0]!.name !== `${safeStageName((parsed as { stage: string }).stage)}.json`) throw new Error("diagnostic artifact violates schema, manifest, or size bound");
	return path.resolve(report);
}

async function main(): Promise<void> {
	if (process.argv[2] === "--validate-diagnostic-dir" && process.argv.length === 4) { console.log(await validateDiagnosticDirectory(process.argv[3]!)); return; }
	const stage = process.argv[2] as CiStage | undefined;
	const strictLinux = process.argv[3] === "--strict-linux";
	if (!stage || !(stage in STAGE_TIMEOUT_MS) || !(process.argv.length === 3 || (strictLinux && process.argv.length === 4))) throw new Error("usage: ci-stage.ts <core|phase0|reaper|sessionTail> [--strict-linux]");
	let finalizing: Promise<never> | undefined;
	let forcedExitTimer: ReturnType<typeof setTimeout> | undefined;
	const bootstrapAbort = async () => {
		if (!process.env.CI_STAGE_DIAGNOSTICS_DIR) return;
		const directory = await secureDiagnosticDirectory(process.env.CI_STAGE_DIAGNOSTICS_DIR);
		await writeDiagnostic(directory, stage, "signaled", 0, {
			observedPeakProcessCount: null, observedPeakRssBytes: null,
			observedPeakCumulativeCpuUserTicks: null, observedPeakCumulativeCpuSystemTicks: null,
			observedPeakCumulativeReadBytes: null, observedPeakCumulativeWriteBytes: null,
		}, process.cwd(), undefined, ["signal-before-stage-ownership"]);
	};
	activeStageAbort = bootstrapAbort;
	const stopForSignal = (signal: NodeJS.Signals) => {
		shutdownRequested = true;
		if (finalizing) {
			// A second signal is an explicit bounded force path, not an ignored event.
			forcedExitTimer ??= setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), TERMINATION_KILL_MS);
			forcedExitTimer.unref();
			return;
		}
		finalizing = (async (): Promise<never> => {
			await activeStageAbort?.();
			process.exit(signal === "SIGINT" ? 130 : 143);
			throw new Error("unreachable");
		})();
		void finalizing;
	};
	// Installed synchronously before inventory discovery or any spawn ownership transition.
	process.on("SIGINT", () => stopForSignal("SIGINT"));
	process.on("SIGTERM", () => stopForSignal("SIGTERM"));
	const result = await runCiStage(stage, process.cwd(), strictLinux);
	if (result.status !== "success") throw new Error(`CI stage ${stage} ended with ${result.status} (exit=${String(result.exitCode)}, signal=${String(result.signal)})`);
}

if (import.meta.main) await main();
