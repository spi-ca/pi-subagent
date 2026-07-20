import { spawn } from "node:child_process";

export const TMUX_PANE_ID_RE = /^%(?:0|[1-9][0-9]*)$/;
/** Layout topology requires non-zero stable container IDs. */
export const TMUX_SESSION_ID_RE = /^\$(?:0|[1-9][0-9]*)$/;
export const TMUX_WINDOW_ID_RE = /^@(?:0|[1-9][0-9]*)$/;
const POSITIVE_PID_RE = /^[1-9][0-9]*$/;

/** Strict tmux PID decoder: no whitespace, suffixes, signs, or leading zeroes. */
export function parsePositivePid(value: string): number | null {
	if (!POSITIVE_PID_RE.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function withoutFinalLineEnding(value: string): string {
	return value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
}

function parseTmuxPidOutput(value: string): number | null {
	return parsePositivePid(withoutFinalLineEnding(value));
}

export interface TmuxCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	aborted: boolean;
}

export type TmuxCommandRunner = (
	args: string[],
	options?: { signal?: AbortSignal },
) => Promise<TmuxCommandResult>;

export interface TmuxPaneHandle {
	paneId: string;
	socketPath?: string;
	serverPid: number;
	panePid: number;
	/** Optional allocation diagnostics; legacy split handles do not require them. */
	sessionId?: string;
	windowId?: string;
}

export interface TmuxSourceTopology {
	paneId: string;
	sessionId: string;
	windowId: string;
}

export interface TmuxWindowFingerprint extends TmuxSourceTopology {
	panePid: number;
}

/** tmux receives these as direct argv values, never a task/prompt shell string. */
export type TmuxDirectCommand = readonly string[];

export interface TmuxPaneSnapshot {
	exists: boolean;
	dead?: boolean;
	title?: string;
	panePid?: number;
}

export interface TmuxEnvironmentIdentity {
	paneId: string;
	socketPath?: string;
	serverPid: number;
}

export function parseTmuxEnvironment(env: NodeJS.ProcessEnv = process.env): TmuxEnvironmentIdentity | null {
	const paneId = env.TMUX_PANE?.trim();
	const tmux = env.TMUX;
	if (!paneId || !TMUX_PANE_ID_RE.test(paneId) || !tmux) return null;
	// TMUX's socket prefix is opaque (and may itself contain whitespace). Only
	// the numeric right-side contract fields permit surrounding whitespace.
	const match = /^(.*),\s*(\d+)\s*,\s*(\d+)\s*$/.exec(tmux);
	if (!match) return null;
	const socketPath = match[1] || undefined;
	const serverPid = parsePositivePid(match[2]!);
	if (serverPid === null) return null;
	return { paneId, socketPath, serverPid };
}

export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseTmuxEnvironment(env) !== null;
}

function withSocket(socketPath: string | undefined, args: string[]): string[] {
	return socketPath ? ["-S", socketPath, ...args] : args;
}

/** Uses a printable separator because locale/client handling can sanitize tabs. */
export function buildTmuxSourceTopologyArgs(socketPath?: string): string[] {
	return withSocket(socketPath, ["list-panes", "-a", "-F", "#{pane_id}|#{session_id}|#{window_id}|#{pane_pid}"]);
}

/** Alias that makes the command's read-only purpose explicit to callers. */
export const buildTmuxSourceTopologyQueryArgs = buildTmuxSourceTopologyArgs;

/**
 * Parses the complete topology response, not just a matching substring. A
 * repeated source row or any malformed row is ambiguous authority and fails.
 */
export function parseTmuxPanePidList(stdout: string, targetPaneId: string): number | false | null {
	if (!TMUX_PANE_ID_RE.test(targetPaneId)) return null;
	const output = withoutFinalLineEnding(stdout);
	if (output.endsWith("\r")) return null;
	let target: number | false = false;
	const seenPaneIds = new Set<string>();
	for (const line of output ? output.split("\n") : []) {
		const fields = line.split("\t");
		if (fields.length !== 2) return null;
		const [paneId, panePidText] = fields;
		const panePid = parsePositivePid(panePidText!);
		if (!TMUX_PANE_ID_RE.test(paneId!) || panePid === null || seenPaneIds.has(paneId!)) return null;
		seenPaneIds.add(paneId!);
		if (paneId === targetPaneId) target = panePid;
	}
	return target;
}

export function parseTmuxSourceTopology(stdout: string, sourcePaneId: string): TmuxSourceTopology | null {
	if (!TMUX_PANE_ID_RE.test(sourcePaneId)) return null;
	const output = withoutFinalLineEnding(stdout);
	if (!output || output.endsWith("\r")) return null;
	let source: TmuxSourceTopology | undefined;
	const seenPaneIds = new Set<string>();
	for (const line of output.split("\n")) {
		const fields = line.split("|");
		if (fields.length !== 4) return null;
		const [paneId, sessionId, windowId, panePidText] = fields;
		if (!TMUX_PANE_ID_RE.test(paneId!) || !TMUX_SESSION_ID_RE.test(sessionId!) || !TMUX_WINDOW_ID_RE.test(windowId!)
			|| parsePositivePid(panePidText!) === null || seenPaneIds.has(paneId!)) return null;
		seenPaneIds.add(paneId!);
		if (paneId === sourcePaneId) source = { paneId, sessionId: sessionId!, windowId: windowId! };
	}
	return source ?? null;
}

export async function readTmuxSourceTopology(options: {
	sourcePaneId: string;
	socketPath?: string;
	signal?: AbortSignal;
	run?: TmuxCommandRunner;
}): Promise<TmuxSourceTopology | null> {
	const run = options.run ?? runTmuxCommand;
	const result = await run(buildTmuxSourceTopologyArgs(options.socketPath), { signal: options.signal });
	return result.exitCode === 0 ? parseTmuxSourceTopology(result.stdout, options.sourcePaneId) : null;
}

export const runTmuxCommand: TmuxCommandRunner = async (args, options = {}) => await new Promise((resolve) => {
	const proc = spawn("tmux", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let settled = false;
	let aborted = false;
	let abortHandler: (() => void) | undefined;
	const finish = (exitCode: number) => {
		if (settled) return;
		settled = true;
		if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
		resolve({ exitCode, stdout, stderr, aborted });
	};
	proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	proc.on("error", (error) => {
		if (!stderr.trim()) stderr = error.message;
		finish(1);
	});
	proc.on("close", (code) => finish(code ?? 0));
	if (options.signal) {
		abortHandler = () => {
			aborted = true;
			proc.kill("SIGTERM");
		};
		if (options.signal.aborted) abortHandler();
		else options.signal.addEventListener("abort", abortHandler, { once: true });
	}
});

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildTmuxSplitArgs(options: {
	sourcePaneId: string;
	socketPath?: string;
	cwd: string;
	wrapperPath: string;
	launchGatePath?: string;
}): string[] {
	const command = options.launchGatePath
		? `while [ ! -f ${shellQuote(options.launchGatePath)} ]; do sleep 0.05; done; exec ${shellQuote(options.wrapperPath)}`
		: `exec ${shellQuote(options.wrapperPath)}`;
	return withSocket(options.socketPath, [
		"split-window",
		"-h",
		"-d",
		"-P",
		"-F",
		"#{pane_id}\t#{pane_pid}",
		"-t",
		options.sourcePaneId,
		"-c",
		options.cwd,
		command,
	]);
}

export function buildTmuxDiagnosticTitle(agentName: string, runId: string): string {
	const sanitize = (value: string, fallback: string, limit: number) => {
		const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, limit);
		return normalized || fallback;
	};
	return `subagent:${sanitize(agentName, "agent", 24)}:${sanitize(runId, "run", 12)}`;
}

function isDirectCommand(command: TmuxDirectCommand): boolean {
	return command.length > 0 && command.every((arg) => typeof arg === "string" && arg.length > 0 && !arg.includes("\0"));
}

export function buildTmuxNewWindowArgs(options: {
	sessionId: string;
	socketPath?: string;
	cwd: string;
	agentName: string;
	runId: string;
	command: TmuxDirectCommand;
}): string[] {
	if (!TMUX_SESSION_ID_RE.test(options.sessionId) || !isDirectCommand(options.command)) {
		throw new Error("tmux new window requires a canonical session ID and non-empty direct command argv.");
	}
	return withSocket(options.socketPath, [
		"new-window", "-d", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}",
		"-t", `${options.sessionId}:`, "-n", buildTmuxDiagnosticTitle(options.agentName, options.runId), "-c", options.cwd,
		...options.command,
	]);
}

export function parseCreatedTmuxPane(stdout: string): string | null {
	const [paneId, panePid, ...extra] = withoutFinalLineEnding(stdout).split("\t");
	if (extra.length > 0 || !paneId || !panePid || !TMUX_PANE_ID_RE.test(paneId)) return null;
	return parsePositivePid(panePid) === null ? null : paneId;
}

export function parseCreatedTmuxPaneFingerprint(stdout: string): { paneId: string; panePid: number } | null {
	const [paneId, panePid, ...extra] = withoutFinalLineEnding(stdout).split("\t");
	if (extra.length > 0 || !paneId || !panePid || !TMUX_PANE_ID_RE.test(paneId)) return null;
	const pid = parsePositivePid(panePid);
	return pid === null ? null : { paneId, panePid: pid };
}

/** The response must prove the requested session and exact pane fingerprint. */
export function parseCreatedTmuxWindow(stdout: string, requestedSessionId: string): TmuxWindowFingerprint | null {
	if (!TMUX_SESSION_ID_RE.test(requestedSessionId)) return null;
	const [sessionId, windowId, paneId, panePidText, ...extra] = withoutFinalLineEnding(stdout).split("|");
	if (extra.length > 0 || !sessionId || !windowId || !paneId || !panePidText
		|| !TMUX_SESSION_ID_RE.test(sessionId) || !TMUX_WINDOW_ID_RE.test(windowId) || !TMUX_PANE_ID_RE.test(paneId)
		|| sessionId !== requestedSessionId) return null;
	const panePid = parsePositivePid(panePidText);
	return panePid === null ? null : { sessionId, windowId, paneId, panePid };
}

export const parseCreatedTmuxWindowFingerprint = parseCreatedTmuxWindow;

async function readTmuxServerPid(
	socketPath: string | undefined,
	run: TmuxCommandRunner,
	signal?: AbortSignal,
): Promise<number | null> {
	const result = await run(withSocket(socketPath, ["display-message", "-p", "#{pid}"]), { signal });
	const serverPid = parseTmuxPidOutput(result.stdout);
	return result.exitCode === 0 ? serverPid : null;
}

/**
 * Allocates a detached window in the exact requested session. The direct
 * command is intentionally opaque here: broker integration supplies argv later.
 */
export async function createTmuxWindow(options: {
	sessionId: string;
	socketPath?: string;
	serverPid: number;
	cwd: string;
	agentName: string;
	runId: string;
	command: TmuxDirectCommand;
	signal?: AbortSignal;
	onAllocated?: (handle: TmuxPaneHandle) => Promise<void>;
	run?: TmuxCommandRunner;
}): Promise<TmuxPaneHandle> {
	if (!TMUX_SESSION_ID_RE.test(options.sessionId) || !isDirectCommand(options.command)) {
		throw new Error("tmux new window requires a canonical session ID and non-empty direct command argv.");
	}
	if (options.signal?.aborted) throw new Error("tmux window creation was aborted.");
	const run = options.run ?? runTmuxCommand;
	const serverPid = await readTmuxServerPid(options.socketPath, run, options.signal);
	if (serverPid !== options.serverPid) {
		throw new Error("tmux server identity no longer matches the inherited TMUX environment.");
	}
	// Do not abort after sending new-window: its response is the only exact
	// allocation identity that permits a safe pane-only rollback.
	const result = await run(buildTmuxNewWindowArgs(options));
	// Parse an exact target before observing status. tmux can create a pane then
	// report a nonzero/aborted result; its fingerprint is the only safe rollback
	// authority and must reach the durable publisher first.
	const fingerprint = parseCreatedTmuxWindow(result.stdout, options.sessionId);
	if (!fingerprint) {
		if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to create tmux window.");
		throw new Error(`Failed to parse tmux window fingerprint: ${result.stdout.trim() || "(empty)"}`);
	}
	const handle: TmuxPaneHandle = {
		paneId: fingerprint.paneId,
		socketPath: options.socketPath,
		serverPid: options.serverPid,
		panePid: fingerprint.panePid,
		sessionId: fingerprint.sessionId,
		windowId: fingerprint.windowId,
	};
	try {
		await options.onAllocated?.(handle);
	} catch (error) {
		await closeTmuxPane(handle, run).catch(() => undefined);
		throw error;
	}
	if (result.exitCode !== 0 || result.aborted || options.signal?.aborted) {
		await closeTmuxPane(handle, run).catch(() => undefined);
		throw new Error(result.aborted || options.signal?.aborted
			? "tmux window creation was aborted."
			: result.stderr.trim() || result.stdout.trim() || "Failed to create tmux window.");
	}
	return handle;
}

export async function createTmuxPane(options: {
	sourcePaneId: string;
	socketPath?: string;
	serverPid: number;
	cwd: string;
	wrapperPath: string;
	launchGatePath?: string;
	signal?: AbortSignal;
	onAllocated?: (handle: TmuxPaneHandle) => Promise<void>;
	run?: TmuxCommandRunner;
}): Promise<TmuxPaneHandle> {
	const run = options.run ?? runTmuxCommand;
	const serverPid = await readTmuxServerPid(options.socketPath, run, options.signal);
	if (serverPid !== options.serverPid) {
		throw new Error("tmux server identity no longer matches the inherited TMUX environment.");
	}
	// split-window is non-abortable once sent: losing its response loses the only
	// exact allocation identity. A staged wrapper prevents child start pre-gate.
	const result = await run(buildTmuxSplitArgs(options));
	// See createTmuxWindow: a complete fingerprint remains authority even when
	// tmux returns nonzero or the caller's signal is observed after dispatch.
	const fingerprint = parseCreatedTmuxPaneFingerprint(result.stdout);
	if (!fingerprint) {
		if (result.exitCode !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Failed to create tmux pane.");
		throw new Error(`Failed to parse tmux pane fingerprint: ${result.stdout.trim() || "(empty)"}`);
	}
	const handle: TmuxPaneHandle = {
		paneId: fingerprint.paneId,
		socketPath: options.socketPath,
		serverPid: options.serverPid,
		panePid: fingerprint.panePid,
	};
	try {
		await options.onAllocated?.(handle);
	} catch (error) {
		await closeTmuxPane(handle, run).catch(() => undefined);
		throw error;
	}
	if (result.exitCode !== 0 || result.aborted || options.signal?.aborted) {
		await closeTmuxPane(handle, run).catch(() => undefined);
		throw new Error(result.aborted || options.signal?.aborted
			? "tmux pane creation was aborted."
			: result.stderr.trim() || result.stdout.trim() || "Failed to create tmux pane.");
	}
	return handle;
}

function parseTmuxPaneSnapshots(stdout: string): Map<string, TmuxPaneSnapshot> | null {
	const output = withoutFinalLineEnding(stdout);
	if (output.endsWith("\r")) return null;
	const panes = new Map<string, TmuxPaneSnapshot>();
	for (const line of output ? output.split("\n") : []) {
		const fields = line.split("\t");
		if (fields.length !== 4) return null;
		const [paneId, dead, title, panePidText] = fields;
		const panePid = parsePositivePid(panePidText!);
		if (!TMUX_PANE_ID_RE.test(paneId!) || (dead !== "0" && dead !== "1") || panePid === null || panes.has(paneId!)) return null;
		panes.set(paneId!, { exists: true, dead: dead === "1", title: title || undefined, panePid });
	}
	return panes;
}

export async function inspectTmuxPane(
	handle: TmuxPaneHandle,
	run: TmuxCommandRunner = runTmuxCommand,
	signal?: AbortSignal,
): Promise<TmuxPaneSnapshot | undefined> {
	if (!TMUX_PANE_ID_RE.test(handle.paneId)) return undefined;
	const result = await run(withSocket(handle.socketPath, [
		"list-panes",
		"-a",
		"-F",
		"#{pane_id}\t#{pane_dead}\t#{pane_title}\t#{pane_pid}",
	]), { signal });
	if (result.exitCode !== 0) return undefined;
	const panes = parseTmuxPaneSnapshots(result.stdout);
	if (!panes) return undefined;
	return panes.get(handle.paneId) ?? { exists: false };
}

export async function inspectTmuxPaneFingerprint(
	handle: TmuxPaneHandle,
	run: TmuxCommandRunner = runTmuxCommand,
): Promise<TmuxPaneSnapshot | undefined> {
	const serverPid = await readTmuxServerPid(handle.socketPath, run);
	if (serverPid === null) return undefined;
	if (serverPid !== handle.serverPid) return { exists: false };
	const snapshot = await inspectTmuxPane(handle, run);
	if (!snapshot || !snapshot.exists) return snapshot;
	return snapshot.panePid === handle.panePid ? snapshot : { exists: false };
}

export async function matchesTmuxPaneFingerprint(
	handle: TmuxPaneHandle,
	run: TmuxCommandRunner = runTmuxCommand,
): Promise<boolean> {
	return Boolean((await inspectTmuxPaneFingerprint(handle, run))?.exists);
}

export function buildGuardedTmuxPaneCommandArgs(
	handle: TmuxPaneHandle,
	command: "interrupt" | "close",
): string[] {
	const condition = `#{&&:#{==:#{pid},${handle.serverPid}},#{==:#{pane_pid},${handle.panePid}}}`;
	const guardedCommand = command === "interrupt"
		? `send-keys -t ${handle.paneId} Escape`
		: `kill-pane -t ${handle.paneId}`;
	return withSocket(handle.socketPath, [
		"if-shell",
		"-F",
		"-t",
		handle.paneId,
		condition,
		guardedCommand,
		"",
	]);
}

export async function interruptTmuxPane(
	handle: TmuxPaneHandle,
	run: TmuxCommandRunner = runTmuxCommand,
): Promise<boolean> {
	if (!await matchesTmuxPaneFingerprint(handle, run)) return false;
	const result = await run(buildGuardedTmuxPaneCommandArgs(handle, "interrupt"));
	return result.exitCode === 0;
}

export async function closeTmuxPane(
	handle: TmuxPaneHandle,
	run: TmuxCommandRunner = runTmuxCommand,
): Promise<boolean> {
	if (!await matchesTmuxPaneFingerprint(handle, run)) return false;
	const result = await run(buildGuardedTmuxPaneCommandArgs(handle, "close"));
	return result.exitCode === 0;
}
