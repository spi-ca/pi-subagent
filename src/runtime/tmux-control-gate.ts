import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getProcessStartedAt, publishImmutableJson, readBrokerJson } from "./run-protocol.js";
import { MINIMUM_TMUX_VERSION, isStableTmuxVersionAtLeast, parseTmuxVersionOutput } from "./version-policy.mjs";

export const TMUX_CONTROL_FIXTURE_CONTRACT_ID = "tmux-control-v1";
export const TMUX_CONTROL_SOURCE_COMMIT = "e802909de06012a4df6209d55e86487c56223163";
export const TMUX_CONTROL_PROBE_RECIPE_ID = "tmux-control-readonly-v1";
export { MINIMUM_TMUX_VERSION };
export class TmuxControlVersionError extends Error {
	constructor(message: string) { super(message); this.name = "TmuxControlVersionError"; }
}
const SESSION = /^\$[0-9]+$/, PANE = /^%[0-9]+$/;
/** Printable delimiter; IDs and canonical decimal PIDs cannot contain it. */
const TMUX_FORMAT_DELIMITER = "|";

export interface TmuxControlProbeResult {
	detectedTmuxVersion: string;
	serverPid: number;
	attachedSessionId: string;
	sourcePaneId: string;
	sourcePanePid: number;
	paneRows: Array<{ sessionId: string; paneId: string; panePid: number }>;
}
export interface TmuxControlTransportGate {
	version: 1;
	runId: string;
	selectedTransport: "tmux-control-v1";
	fixtureContractId: typeof TMUX_CONTROL_FIXTURE_CONTRACT_ID;
	pinnedSourceCommit: typeof TMUX_CONTROL_SOURCE_COMMIT;
	executableGeneration: { realpath: string; dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string };
	probeRecipeId: typeof TMUX_CONTROL_PROBE_RECIPE_ID;
	probeResult: TmuxControlProbeResult;
	probeDigestAlgorithm: "sha256";
	probeDigest: string;
	canonicalSocketPath: string;
	socketDev: number;
	socketIno: number;
	serverStartedAt: number;
	createdAt: number;
}
export interface ProbeCommandResult { exitCode: number; stdout: string; stderr?: string }
export type ProbeCommandRunner = (args: string[]) => Promise<ProbeCommandResult>;

function exact(value: Record<string, unknown>, keys: string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function oneLfLine(value: string): string | null {
	if (!value.endsWith("\n") || value.endsWith("\n\n") || value.includes("\r") || value.includes("\0")) return null;
	const line = value.slice(0, -1); return line.includes("\n") ? null : line;
}
function numericSuffix(value: string): number { return Number(value.slice(1)); }

export function canonicalTmuxProbeBytes(probe: TmuxControlProbeResult): Buffer {
	return Buffer.from(`${JSON.stringify({
		detectedTmuxVersion: probe.detectedTmuxVersion,
		serverPid: probe.serverPid,
		attachedSessionId: probe.attachedSessionId,
		sourcePaneId: probe.sourcePaneId,
		sourcePanePid: probe.sourcePanePid,
		paneRows: probe.paneRows.map((row) => ({ sessionId: row.sessionId, paneId: row.paneId, panePid: row.panePid })),
	})}\n`, "utf8");
}

export function parseTmuxControlProbe(versionStdout: string, identityStdout: string, panesStdout: string): TmuxControlProbeResult | null {
	const detectedTmuxVersion = parseTmuxVersionOutput(versionStdout);
	if (!detectedTmuxVersion || !isStableTmuxVersionAtLeast(detectedTmuxVersion, MINIMUM_TMUX_VERSION)) return null;
	const identity = oneLfLine(identityStdout)?.split(TMUX_FORMAT_DELIMITER);
	if (!identity || identity.length !== 4) return null;
	const serverPid = Number(identity[0]), attachedSessionId = identity[1]!, sourcePaneId = identity[2]!, sourcePanePid = Number(identity[3]);
	if (!positive(serverPid) || !SESSION.test(attachedSessionId) || !PANE.test(sourcePaneId) || !positive(sourcePanePid)) return null;
	if (!panesStdout.endsWith("\n") || panesStdout.includes("\r") || panesStdout.includes("\0")) return null;
	const lines = panesStdout.slice(0, -1).split("\n");
	if (lines.length === 0 || lines.some((line) => !line)) return null;
	const paneRows: TmuxControlProbeResult["paneRows"] = [];
	const pairs = new Set<string>();
	for (const line of lines) {
		const fields = line.split(TMUX_FORMAT_DELIMITER); if (fields.length !== 3) return null;
		const [sessionId, paneId, rawPid] = fields; const panePid = Number(rawPid);
		if (!SESSION.test(sessionId!) || !PANE.test(paneId!) || !positive(panePid)) return null;
		const pair = `${sessionId}:${paneId}`; if (pairs.has(pair)) return null; pairs.add(pair);
		paneRows.push({ sessionId: sessionId!, paneId: paneId!, panePid });
	}
	paneRows.sort((left, right) => numericSuffix(left.sessionId) - numericSuffix(right.sessionId) || numericSuffix(left.paneId) - numericSuffix(right.paneId) || left.panePid - right.panePid);
	if (paneRows.filter((row) => row.sessionId === attachedSessionId && row.paneId === sourcePaneId && row.panePid === sourcePanePid).length !== 1) return null;
	return { detectedTmuxVersion, serverPid, attachedSessionId, sourcePaneId, sourcePanePid, paneRows };
}

function parseGeneration(value: unknown): TmuxControlTransportGate["executableGeneration"] | null {
	const decimal = (item: unknown) => typeof item === "string" && /^(?:0|[1-9][0-9]*)$/.test(item);
	if (!object(value) || !exact(value, ["realpath", "dev", "ino", "size", "mtimeNs", "ctimeNs"]) || typeof value.realpath !== "string" || !path.isAbsolute(value.realpath)
		|| !decimal(value.dev) || !decimal(value.ino) || !decimal(value.size) || !decimal(value.mtimeNs) || !decimal(value.ctimeNs)) return null;
	return value as unknown as TmuxControlTransportGate["executableGeneration"];
}
function parseProbe(value: unknown): TmuxControlProbeResult | null {
	if (!object(value) || !exact(value, ["detectedTmuxVersion", "serverPid", "attachedSessionId", "sourcePaneId", "sourcePanePid", "paneRows"])
		|| typeof value.detectedTmuxVersion !== "string" || !isStableTmuxVersionAtLeast(value.detectedTmuxVersion, MINIMUM_TMUX_VERSION)
		|| !positive(value.serverPid) || typeof value.attachedSessionId !== "string" || !SESSION.test(value.attachedSessionId)
		|| typeof value.sourcePaneId !== "string" || !PANE.test(value.sourcePaneId) || !positive(value.sourcePanePid) || !Array.isArray(value.paneRows)) return null;
	const rows = value.paneRows; const parsed = parseTmuxControlProbe(`tmux ${value.detectedTmuxVersion}\n`, `${value.serverPid}${TMUX_FORMAT_DELIMITER}${value.attachedSessionId}${TMUX_FORMAT_DELIMITER}${value.sourcePaneId}${TMUX_FORMAT_DELIMITER}${value.sourcePanePid}\n`, `${rows.map((row) => object(row) && exact(row, ["sessionId", "paneId", "panePid"]) ? `${row.sessionId}${TMUX_FORMAT_DELIMITER}${row.paneId}${TMUX_FORMAT_DELIMITER}${row.panePid}` : "").join("\n")}\n`);
	return parsed && JSON.stringify(parsed.paneRows) === JSON.stringify(rows) ? parsed : null;
}

export function parseTmuxControlTransportGate(value: unknown, expectedRunId?: string): TmuxControlTransportGate | null {
	const keys = ["version", "runId", "selectedTransport", "fixtureContractId", "pinnedSourceCommit", "executableGeneration", "probeRecipeId", "probeResult", "probeDigestAlgorithm", "probeDigest", "canonicalSocketPath", "socketDev", "socketIno", "serverStartedAt", "createdAt"];
	if (!object(value) || !exact(value, keys) || value.version !== 1 || typeof value.runId !== "string" || (expectedRunId !== undefined && value.runId !== expectedRunId)
		|| value.selectedTransport !== "tmux-control-v1" || value.fixtureContractId !== TMUX_CONTROL_FIXTURE_CONTRACT_ID || value.pinnedSourceCommit !== TMUX_CONTROL_SOURCE_COMMIT
		|| value.probeRecipeId !== TMUX_CONTROL_PROBE_RECIPE_ID || value.probeDigestAlgorithm !== "sha256" || typeof value.probeDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.probeDigest)
		|| typeof value.canonicalSocketPath !== "string" || !path.isAbsolute(value.canonicalSocketPath) || !nonnegative(value.socketDev) || !nonnegative(value.socketIno)
		|| !positive(value.serverStartedAt) || !positive(value.createdAt)) return null;
	const executableGeneration = parseGeneration(value.executableGeneration), probeResult = parseProbe(value.probeResult);
	if (!executableGeneration || !probeResult) return null;
	const digest = crypto.createHash("sha256").update(canonicalTmuxProbeBytes(probeResult)).digest("hex");
	return digest === value.probeDigest ? value as unknown as TmuxControlTransportGate : null;
}

function fileGeneration(filePath: string): TmuxControlTransportGate["executableGeneration"] | null {
	try {
		const realpath = fs.realpathSync(filePath); const stat = fs.statSync(realpath, { bigint: true });
		if (!stat.isFile()) return null;
		return { realpath, dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
	} catch { return null; }
}
function socketGeneration(socketPath: string): { canonicalSocketPath: string; socketDev: number; socketIno: number } | null {
	try {
		const canonicalSocketPath = path.join(fs.realpathSync(path.dirname(socketPath)), path.basename(socketPath));
		const stat = fs.lstatSync(canonicalSocketPath, { bigint: true });
		if (!stat.isSocket() || stat.dev > BigInt(Number.MAX_SAFE_INTEGER) || stat.ino > BigInt(Number.MAX_SAFE_INTEGER)) return null;
		return { canonicalSocketPath, socketDev: Number(stat.dev), socketIno: Number(stat.ino) };
	} catch { return null; }
}

export function isTmuxControlTransportGateCurrent(gate: TmuxControlTransportGate): boolean {
	const executable = fileGeneration(gate.executableGeneration.realpath), socket = socketGeneration(gate.canonicalSocketPath);
	return executable !== null && socket !== null
		&& executable.realpath === gate.executableGeneration.realpath && executable.dev === gate.executableGeneration.dev
		&& executable.ino === gate.executableGeneration.ino && executable.size === gate.executableGeneration.size
		&& executable.mtimeNs === gate.executableGeneration.mtimeNs && executable.ctimeNs === gate.executableGeneration.ctimeNs
		&& socket.canonicalSocketPath === gate.canonicalSocketPath && socket.socketDev === gate.socketDev && socket.socketIno === gate.socketIno
		&& getProcessStartedAt(gate.probeResult.serverPid) === gate.serverStartedAt;
}

export async function createTmuxControlTransportGate(options: {
	runId: string; executable: string; socketPath: string; sourcePaneId: string; serverStartedAt: number; run: ProbeCommandRunner; createdAt?: number;
}): Promise<TmuxControlTransportGate> {
	const executableGeneration = fileGeneration(options.executable), socket = socketGeneration(options.socketPath);
	if (!executableGeneration || !socket || !PANE.test(options.sourcePaneId) || !positive(options.serverStartedAt)) throw new Error("tmux control gate identity is unavailable");
	const [version, identity, panes] = await Promise.all([
		options.run(["-V"]),
		options.run(["-S", socket.canonicalSocketPath, "display-message", "-p", "-t", options.sourcePaneId, `#{pid}${TMUX_FORMAT_DELIMITER}#{session_id}${TMUX_FORMAT_DELIMITER}#{pane_id}${TMUX_FORMAT_DELIMITER}#{pane_pid}`]),
		options.run(["-S", socket.canonicalSocketPath, "list-panes", "-a", "-F", `#{session_id}${TMUX_FORMAT_DELIMITER}#{pane_id}${TMUX_FORMAT_DELIMITER}#{pane_pid}`]),
	]);
	const detectedVersion = version.exitCode === 0 ? parseTmuxVersionOutput(version.stdout) : null;
	if (!detectedVersion || !isStableTmuxVersionAtLeast(detectedVersion, MINIMUM_TMUX_VERSION)) throw new TmuxControlVersionError(`tmux >= ${MINIMUM_TMUX_VERSION} stable version is required`);
	if (identity.exitCode !== 0 || panes.exitCode !== 0) throw new Error("tmux control gate read-only probe failed");
	const probeResult = parseTmuxControlProbe(version.stdout, identity.stdout, panes.stdout);
	if (!probeResult) throw new Error("tmux control gate probe output is malformed");
	const probeDigest = crypto.createHash("sha256").update(canonicalTmuxProbeBytes(probeResult)).digest("hex");
	const gate: TmuxControlTransportGate = { version: 1, runId: options.runId, selectedTransport: "tmux-control-v1", fixtureContractId: TMUX_CONTROL_FIXTURE_CONTRACT_ID, pinnedSourceCommit: TMUX_CONTROL_SOURCE_COMMIT, executableGeneration, probeRecipeId: TMUX_CONTROL_PROBE_RECIPE_ID, probeResult, probeDigestAlgorithm: "sha256", probeDigest, ...socket, serverStartedAt: options.serverStartedAt, createdAt: options.createdAt ?? Date.now() };
	if (!parseTmuxControlTransportGate(gate, options.runId) || !isTmuxControlTransportGateCurrent(gate)) throw new Error("tmux control gate construction failed");
	return gate;
}

export async function publishTmuxControlTransportGate(filePath: string, gate: TmuxControlTransportGate): Promise<TmuxControlTransportGate> {
	if (!parseTmuxControlTransportGate(gate, gate.runId) || !isTmuxControlTransportGateCurrent(gate)) throw new Error("tmux control gate is malformed or stale");
	await publishImmutableJson(filePath, gate);
	const winner = parseTmuxControlTransportGate(await readBrokerJson(filePath), gate.runId);
	if (!winner) throw new Error("tmux control gate publication could not be verified");
	return winner;
}
