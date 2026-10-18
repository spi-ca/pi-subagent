import { ParentReportRate } from "./parent-report-rate.js";
import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { isSteeringMessage, type SteeringOutcome } from "../core/subagent-steering.js";
import { isParentReportKind, isParentReportMessage, MAX_PARENT_REPORT_MESSAGE_BYTES, type ParentReportHandler, type ParentReportKind, type ReportOutcome } from "./parent-report.js";

export const SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV = "PI_SUBAGENT_LIFECYCLE_SOCKET_PATH";
export const SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV = "PI_SUBAGENT_LIFECYCLE_TOKEN_PATH";
const VERSION = 1 as const;
/** Per direction: eight UNSENT requests in addition to one awaiting remote ACK. */
export const LOCAL_MESSAGE_WAIT_CAPACITY = 8;
const MAX_FRAME_BYTES = 4096;
// JSON can expand each body byte to six bytes (e.g. NUL -> \\u0000).
// Keep a fixed envelope budget; only authenticated report frames get this cap.
const MAX_REPORT_FRAME_BYTES = 6 * MAX_PARENT_REPORT_MESSAGE_BYTES + MAX_FRAME_BYTES;
const MAX_CONNECTIONS = 64;
const MAX_CONNECTION_CHUNK_BYTES = 64 * 1024;
const HELLO_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 15_000;
const NONTERMINAL_BUFFER_LIMIT_BYTES = 8 * 1024;
const REPORT_BUFFER_LIMIT_BYTES = MAX_REPORT_FRAME_BYTES + NONTERMINAL_BUFFER_LIMIT_BYTES;
// Preserve 8 KiB of headroom beyond the report write budget for control ACKs
// and terminal hints. Coalescible events retain the old low watermark.
const MAX_REPORT_CLIENT_BUFFERED_BYTES = REPORT_BUFFER_LIMIT_BYTES + 8 * 1024;
const MAX_CLIENT_BUFFERED_BYTES = 16 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVENT_TYPES = new Set(["agent-started", "agent-ended", "agent-settled", "completion-ready", "shutdown", "heartbeat"]);
const CONTROL_TYPES = new Set(["abort"]);
const CURRENT_UID = BigInt(process.getuid?.() ?? -1);

export interface LifecycleEvent {
	version: 1;
	type: string;
	runId: string;
	sequence: number;
	childPid?: number;
}

interface WaitingSteer {
	message: string;
	socket: net.Socket;
	activityGeneration: number | undefined;
	eligible: () => boolean;
	resolve: (outcome: SteeringOutcome) => void;
}

interface WaitingReport {
	message: string;
	kind: ParentReportKind;
	generation: number;
	eligible: () => boolean;
	signal?: AbortSignal;
	cleanup: () => void;
	resolve: (outcome: ReportOutcome) => void;
}

interface RunRegistration {
	token: string;
	active: boolean;
	terminal: boolean;
	socket: net.Socket | null;
	lastSequence: number;
	lastHeartbeatAt: number;
	controlSequence: number;
	controlAcknowledged: number;
	waiters: Set<() => void>;
	noHeartbeat?: boolean;
	steerSequence?: number;
	steerAcknowledged?: number;
	steerPending?: { sequence: number; resolve: (outcome: SteeringOutcome) => void };
	steerDispatchScheduled?: boolean;
	steerQueue?: WaitingSteer[];
	steerRunning?: boolean;
	steerClosed?: boolean;
	reportHandler?: ParentReportHandler;
	reportHandlerGeneration?: number;
	activityGeneration?: number;
	reportSequence?: number;
	reportRate?: ParentReportRate;
	reportPending?: boolean;
	reportClosed?: boolean;
	reportAbortCleanup?: () => void;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function object(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseLine(line: Buffer, allowReport = false): Record<string, unknown> | null {
	if (line.length === 0 || line.length > (allowReport ? MAX_REPORT_FRAME_BYTES : MAX_FRAME_BYTES)
		|| line.includes(0x0d) || line.includes(0x00)) return null;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
		const value = JSON.parse(text);
		return object(value) && (line.length <= MAX_FRAME_BYTES || (allowReport && value.type === "report")) ? value : null;
	} catch { return null; }
}

async function validateSocketPath(socketPath: string): Promise<void> {
	if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath, "utf8") > 92) throw new Error("Unsafe lifecycle socket path.");
	const directoryPath = path.dirname(socketPath);
	const [directory, socket, canonicalDirectory] = await Promise.all([
		fs.lstat(directoryPath), fs.lstat(socketPath), fs.realpath(directoryPath),
	]);
	if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700
		|| canonicalDirectory !== directoryPath || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== process.getuid?.() || (socket.mode & 0o777) !== 0o600) {
		throw new Error("Unsafe lifecycle socket filesystem authority.");
	}
}

async function safeTemporaryRoot(): Promise<string> {
	const candidate = await fs.realpath("/tmp");
	const stats = await fs.stat(candidate);
	const mode = stats.mode & 0o7777;
	if (!stats.isDirectory() || stats.uid !== 0 || (mode & 0o1000) === 0 || (mode & 0o002) === 0) {
		throw new Error("Lifecycle socket temporary root is not a trusted directory.");
	}
	let ancestor = path.dirname(candidate);
	while (true) {
		const ancestorStats = await fs.lstat(ancestor);
		if (!ancestorStats.isDirectory() || ancestorStats.isSymbolicLink() || ancestorStats.uid !== 0 || (ancestorStats.mode & 0o022) !== 0) {
			throw new Error("Lifecycle socket temporary root has an unsafe ancestor.");
		}
		const parent = path.dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	return candidate;
}

type LifecycleStartupOperations = {
	lstat?: typeof fs.lstat;
	chmod?: typeof fs.chmod;
	open?: typeof fs.open;
	createServer?: typeof net.createServer;
	afterMkdtemp?: (directory: string) => void | Promise<void>;
	now?: () => number;
};

export class LifecycleEventServer {
	readonly socketPath: string;
	readonly directory: string;
	private generation: string | null = null;
	private readonly markerPath: string;
	private server: net.Server | null = null;
	private readonly runs = new Map<string, RunRegistration>();
	private socketIdentity: { dev: bigint; ino: bigint } | null = null;
	private directoryIdentity: { dev: bigint; ino: bigint } | null = null;
	private markerIdentity: { dev: bigint; ino: bigint } | null = null;
	private connections = 0;
	/** Includes unauthenticated peers so close never waits on a hostile reader. */
	private readonly connectionsSet = new Set<net.Socket>();
	private closed = false;

	private constructor(directory: string, private readonly now: () => number) {
		this.directory = directory;
		this.socketPath = path.join(directory, "events.sock");
		this.markerPath = path.join(directory, "generation");
	}

	static async start(operations: LifecycleStartupOperations = {}): Promise<LifecycleEventServer> {
		if (process.platform === "win32") throw new Error("Lifecycle Unix sockets are unavailable on Windows.");
		const lstat = operations.lstat ?? fs.lstat;
		const chmod = operations.chmod ?? fs.chmod;
		const open = operations.open ?? fs.open;
		const createServer = operations.createServer ?? net.createServer;
		let instance: LifecycleEventServer | null = null;
		try {
			const root = await safeTemporaryRoot();
			const directory = await fs.mkdtemp(path.join(root, ".pi-se-"));
			// Arm failure cleanup as soon as mkdtemp returns. If its first identity
			// probe fails, cleanup intentionally retains the directory: pathname-only
			// I/O cannot prove an unrecorded artifact still belongs to this startup.
			instance = new LifecycleEventServer(directory, operations.now ?? (() => performance.now()));
			await operations.afterMkdtemp?.(directory);
			const initialDirectoryStats = await lstat(directory, { bigint: true });
			instance.directoryIdentity = { dev: initialDirectoryStats.dev, ino: initialDirectoryStats.ino };
			instance.generation = crypto.randomBytes(32).toString("base64url");
			const server = createServer();
			instance.server = server;
			await chmod(directory, 0o700);
			const directoryStats = await lstat(directory, { bigint: true });
			if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || directoryStats.uid !== CURRENT_UID || (directoryStats.mode & 0o777n) !== 0o700n
				|| directoryStats.dev !== instance.directoryIdentity.dev || directoryStats.ino !== instance.directoryIdentity.ino) {
				throw new Error("Lifecycle socket directory setup is unsafe.");
			}
			let markerHandle: fs.FileHandle | null = null;
			try {
				markerHandle = await open(instance.markerPath, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | (fsSync.constants.O_NOFOLLOW ?? 0), 0o600);
				const markerBeforeWrite = await markerHandle.stat({ bigint: true });
				if (!markerBeforeWrite.isFile() || markerBeforeWrite.uid !== CURRENT_UID || (markerBeforeWrite.mode & 0o777n) !== 0o600n) {
					throw new Error("Lifecycle socket generation marker setup is unsafe.");
				}
				// This identity makes a partially written marker eligible for startup
				// cleanup; normal close additionally validates its generation content.
				instance.markerIdentity = { dev: markerBeforeWrite.dev, ino: markerBeforeWrite.ino };
				await markerHandle.writeFile(`${instance.generation}\n`);
				const markerAfterWrite = await markerHandle.stat({ bigint: true });
				if (!markerAfterWrite.isFile() || markerAfterWrite.uid !== CURRENT_UID || (markerAfterWrite.mode & 0o777n) !== 0o600n
					|| markerAfterWrite.dev !== instance.markerIdentity.dev || markerAfterWrite.ino !== instance.markerIdentity.ino) {
					throw new Error("Lifecycle socket generation marker changed during setup.");
				}
				await chmod(instance.markerPath, 0o600);
				const markerPathStats = await lstat(instance.markerPath, { bigint: true });
				if (!markerPathStats.isFile() || markerPathStats.isSymbolicLink() || markerPathStats.uid !== CURRENT_UID || (markerPathStats.mode & 0o777n) !== 0o600n
					|| markerPathStats.dev !== instance.markerIdentity.dev || markerPathStats.ino !== instance.markerIdentity.ino) {
					throw new Error("Lifecycle socket generation marker setup is unsafe.");
				}
			} finally {
				if (markerHandle) await markerHandle.close();
			}
			server.on("connection", (socket) => instance!.accept(socket));
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(instance!.socketPath, () => { server.off("error", reject); resolve(); });
			});
			const stats = await lstat(instance.socketPath, { bigint: true });
			if (!stats.isSocket()) throw new Error("Lifecycle socket bind did not create a socket.");
			// Capture the listener generation before post-listen chmod/authority
			// checks so every startup failure can close its own listener safely.
			instance.socketIdentity = { dev: stats.dev, ino: stats.ino };
			await chmod(instance.socketPath, 0o600);
			await validateSocketPath(instance.socketPath);
			return instance;
		} catch (error) {
			if (instance) {
				if (instance.socketIdentity) await instance.close().catch(() => undefined);
				else await instance.cleanupStartupFailure().catch(() => undefined);
			}
			throw error;
		}
	}

	registerRun(runId: string, noHeartbeat = false): string {
		if (this.closed || !RUN_ID_PATTERN.test(runId) || this.runs.has(runId)) throw new Error("Invalid or duplicate lifecycle run registration.");
		const token = crypto.randomBytes(32).toString("base64url");
		this.runs.set(runId, { token, noHeartbeat, active: false, terminal: false, socket: null, lastSequence: 0, lastHeartbeatAt: performance.now(), controlSequence: 0, controlAcknowledged: 0, waiters: new Set() });
		return token;
	}

	/** Parent-owned binding; never derived from a child-supplied parent/job identifier. */
	setReportHandler(runId: string, handler: ParentReportHandler, signal?: AbortSignal): void {
		const run = this.runs.get(runId);
		if (!run || run.terminal || run.reportClosed) return;
		if (signal?.aborted) { this.closeReporting(runId); return; }
		run.reportAbortCleanup?.();
		run.reportHandler = handler;
		run.reportHandlerGeneration = (run.reportHandlerGeneration ?? 0) + 1;
		if (signal) {
			const abort = () => this.closeReporting(runId);
			signal.addEventListener("abort", abort, { once: true });
			run.reportAbortCleanup = () => signal.removeEventListener("abort", abort);
		}
	}

	/** Revoke only reporting; preserve lifecycle, abort and steering authority. */
	closeReporting(runId: string): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.reportClosed = true;
		run.reportAbortCleanup?.();
		delete run.reportAbortCleanup;
		delete run.reportHandler;
		delete run.reportRate;
		run.reportPending = false;
	}

	activateRun(runId: string): void {
		const run = this.runs.get(runId);
		if (!run || run.terminal) throw new Error("Lifecycle run is unavailable for activation.");
		run.active = true;
		this.notify(run); // a pre-activation hello/event becomes visible only now.
	}

	terminalRun(runId: string): void {
		const run = this.runs.get(runId);
		if (!run) return;
		this.closeSteering(run);
		this.closeReporting(runId);
		run.terminal = true;
		run.token = "";
		run.socket?.destroy();
		for (const resolve of run.waiters) resolve();
		run.waiters.clear();
		this.runs.delete(runId);
	}

	lastHeartbeat(runId: string): number | null { return this.runs.get(runId)?.lastHeartbeatAt ?? null; }
	isConnected(runId: string): boolean { return Boolean(this.runs.get(runId)?.socket); }
	isAbortAcknowledged(runId: string): boolean {
		const run = this.runs.get(runId);
		return Boolean(run && run.controlSequence > 0 && run.controlAcknowledged === run.controlSequence);
	}
	/** One bounded, authenticated, idempotent parent-to-child abort request. */
	requestAbort(runId: string): boolean {
		const run = this.runs.get(runId);
		if (!run?.active || run.terminal || !run.socket || run.socket.destroyed) return false;
		this.closeReporting(runId);
		this.closeSteering(run);
		if (run.controlSequence > 0 && run.controlAcknowledged === run.controlSequence) return true;
		if (run.controlSequence > run.controlAcknowledged) return true;
		const sequence = ++run.controlSequence;
		const frame = `${JSON.stringify({ version: VERSION, type: "control", command: "abort", runId, sequence })}\n`;
		if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || run.socket.writableLength > NONTERMINAL_BUFFER_LIMIT_BYTES) { run.socket.destroy(); return false; }
		run.socket.write(frame);
		return true;
	}

	private discardSteeringQueue(run: RunRegistration): void {
		for (const request of run.steerQueue?.splice(0) ?? []) request.resolve("unavailable");
	}

	private closeSteering(run: RunRegistration): void {
		run.steerClosed = true; // Fence BEFORE settling the active request, which may dispatch the next.
		this.discardSteeringQueue(run);
		run.steerPending?.resolve("unknown");
	}

	/** No retries. Local waiting is not ACK; only remote inbox admission is submitted. */
	async requestSteer(runId: string, message: string, eligible: () => boolean = () => true): Promise<SteeringOutcome> {
		const run = this.runs.get(runId);
		if (!isSteeringMessage(message) || !run?.active || run.terminal || run.steerClosed || !run.steerRunning
			|| !run.socket || run.socket.destroyed || !eligible()) return "unavailable";
		const queue = run.steerQueue ??= [];
		if (queue.length >= LOCAL_MESSAGE_WAIT_CAPACITY) return "queue-full";
		return await new Promise<SteeringOutcome>((resolve) => {
			queue.push({ message, socket: run.socket!, activityGeneration: run.activityGeneration, eligible, resolve });
			this.dispatchSteering(runId, run);
		});
	}

	private dispatchSteering(runId: string, run: RunRegistration): void {
		if (run.steerPending || run.steerDispatchScheduled) return;
		const request = run.steerQueue?.shift();
		if (!request) return;
		const { socket, message, resolve } = request;
		if (this.closed || this.runs.get(runId) !== run || !run.active || run.terminal || run.steerClosed || !run.steerRunning
			|| run.socket !== socket || socket.destroyed || run.activityGeneration !== request.activityGeneration || !request.eligible()) {
			resolve("unavailable"); this.dispatchSteering(runId, run); return;
		}
		const sequence = (run.steerSequence ?? 0) + 1;
		const frame = `${JSON.stringify({ version: VERSION, type: "steer", runId, sequence, message })}\n`;
		if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || socket.writableLength + Buffer.byteLength(frame) > NONTERMINAL_BUFFER_LIMIT_BYTES) {
			resolve("busy"); this.dispatchSteering(runId, run); return;
		}
		let settled = false;
		const done = (outcome: SteeringOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			delete run.steerPending;
			if (outcome === "unknown") { run.steerClosed = true; this.discardSteeringQueue(run); }
			// Parse the rest of this inbound batch before rechecking queued work.
			// The flag also prevents a reentrant request from pumping it early.
			run.steerDispatchScheduled = true;
			resolve(outcome);
			queueMicrotask(() => {
				run.steerDispatchScheduled = false;
				this.dispatchSteering(runId, run);
			});
		};
		// Waiting locally consumes no ACK deadline or sequence number.
		const timer = setTimeout(() => done("unknown"), 1000);
		run.steerSequence = sequence;
		run.steerPending = { sequence, resolve: done };
		try { socket.write(frame); } catch { done("unknown"); }
	}

	async waitForEvent(runId: string, timeoutMs: number): Promise<void> {
		const run = this.runs.get(runId);
		if (!run || run.terminal) return;
		await new Promise<void>((resolve) => {
			let timer: NodeJS.Timeout;
			const done = () => { clearTimeout(timer); run.waiters.delete(done); resolve(); };
			timer = setTimeout(done, timeoutMs);
			run.waiters.add(done);
		});
	}

	private notify(run: RunRegistration): void {
		for (const resolve of run.waiters) resolve();
		run.waiters.clear();
	}

	private accept(socket: net.Socket): void {
		if (this.closed || this.connections >= MAX_CONNECTIONS) { socket.destroy(); return; }
		this.connections += 1;
		this.connectionsSet.add(socket);
		let buffer = Buffer.alloc(0);
		let authenticated: { runId: string; run: RunRegistration } | null = null;
		const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
		socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
		const fail = () => socket.destroy();
		socket.on("data", (chunk: Buffer) => {
			if (chunk.length > MAX_CONNECTION_CHUNK_BYTES) { fail(); return; }
			if (!authenticated) {
				const lf = chunk.indexOf(0x0a);
				const preAuthBytes = buffer.length + (lf >= 0 ? lf : chunk.length);
				if (preAuthBytes > MAX_FRAME_BYTES) { fail(); return; }
			}
			// At most one partial bounded frame plus one bounded chunk is retained.
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > (authenticated ? MAX_REPORT_FRAME_BYTES : MAX_FRAME_BYTES) + 1 && !buffer.includes(0x0a)) { fail(); return; }
			while (true) {
				const lf = buffer.indexOf(0x0a);
				if (lf < 0) break;
				const line = buffer.subarray(0, lf);
				buffer = buffer.subarray(lf + 1);
				const value = parseLine(line, authenticated !== null);
				if (!value) { fail(); return; }
				if (!authenticated) {
					if (!(exactKeys(value, ["version", "type", "runId", "token", "childPid", "sequence"])
						|| (exactKeys(value, ["version", "type", "runId", "token", "childPid", "sequence", "report"]) && value.report === true))
						|| value.version !== VERSION || value.type !== "hello" || typeof value.runId !== "string"
						|| typeof value.token !== "string" || !Number.isSafeInteger(value.childPid) || (value.childPid as number) <= 0 || value.sequence !== 0) { fail(); return; }
					const run = this.runs.get(value.runId);
					if (!run || run.terminal || run.socket || !TOKEN_PATTERN.test(value.token)
						|| !crypto.timingSafeEqual(Buffer.from(run.token), Buffer.from(value.token))) { fail(); return; }
					authenticated = { runId: value.runId, run };
					run.socket = socket;
					if (run.noHeartbeat) socket.setTimeout(0); // inline relies on pipe/process exit, not liveness polling.
					const helloAck = `${JSON.stringify({ version: VERSION, type: "hello-ack", runId: value.runId, sequence: 0, ...(value.report === true ? { report: Boolean(run.reportHandler) } : {}) })}\n`;
					if (Buffer.byteLength(helloAck) > MAX_FRAME_BYTES || socket.writableLength > NONTERMINAL_BUFFER_LIMIT_BYTES) { fail(); return; }
					socket.write(helloAck);
					clearTimeout(helloTimer);
					if (run.active) this.notify(run);
					continue;
				}
				if (value.type === "report") {
					const { run, runId } = authenticated;
					if (!(exactKeys(value, ["version", "type", "runId", "sequence", "reportSequence", "message"])
						|| (exactKeys(value, ["version", "type", "runId", "sequence", "reportSequence", "message", "kind"]) && isParentReportKind(value.kind)))
						|| value.version !== VERSION || value.runId !== runId || !Number.isSafeInteger(value.sequence) || value.sequence !== run.lastSequence + 1
						|| !Number.isSafeInteger(value.reportSequence) || value.reportSequence !== (run.reportSequence ?? 0) + 1 || !isParentReportMessage(value.message)) { fail(); return; }
					run.lastSequence = value.sequence as number;
					run.reportSequence = value.reportSequence as number;
					const reportSequence = run.reportSequence;
					const handler = run.reportHandler;
					const handlerGeneration = run.reportHandlerGeneration, activityGeneration = run.activityGeneration;
					const eligible = () => !this.closed && this.runs.get(runId) === run
						&& run.active && !run.terminal && !run.reportClosed && run.steerRunning === true
						&& run.activityGeneration === activityGeneration && run.reportHandlerGeneration === handlerGeneration
						&& run.socket === socket && !socket.destroyed && Boolean(handler) && run.reportHandler === handler;
					const ack = (accepted: boolean) => {
						if (socket.destroyed) return;
						const frame = `${JSON.stringify({ version: VERSION, type: "report-ack", runId, reportSequence, accepted })}\n`;
						if (socket.writableLength + Buffer.byteLength(frame) > NONTERMINAL_BUFFER_LIMIT_BYTES) return; // unknown, preserving lifecycle authority
						socket.write(frame);
					};
					if (socket.writableLength + 256 > NONTERMINAL_BUFFER_LIMIT_BYTES) continue; // no admission without ACK buffer space
					if (!eligible() || run.reportPending) { ack(false); continue; }
					run.reportRate ??= new ParentReportRate(this.now);
					if (!run.reportRate.take()) { ack(false); continue; }
					run.reportPending = true;
					// Callback errors and denied admission never echo child text. No retry.
					void Promise.resolve().then(() => eligible() ? handler!(value.message as string, eligible, (value.kind ?? "progress") as ParentReportKind) : false)
						.then((accepted) => { run.reportPending = false; ack(accepted === true); },
							() => { run.reportPending = false; ack(false); });
					continue;
				}
				if (exactKeys(value, ["version", "type", "runId", "sequence", "steerSequence", "accepted"])
					&& value.version === VERSION && value.type === "steer-ack" && value.runId === authenticated.runId
					&& value.sequence === authenticated.run.lastSequence + 1 && typeof value.accepted === "boolean"
					&& value.steerSequence === authenticated.run.steerSequence && value.steerSequence !== authenticated.run.steerAcknowledged) {
					authenticated.run.lastSequence = value.sequence as number;
					authenticated.run.steerAcknowledged = value.steerSequence as number;
					authenticated.run.steerPending?.resolve(value.accepted ? "submitted" : "rejected");
					continue;
				}
				if (exactKeys(value, ["version", "type", "runId", "sequence", "controlSequence"])
					&& value.version === VERSION && value.type === "control-ack" && value.runId === authenticated.runId
					&& Number.isSafeInteger(value.sequence) && value.sequence === authenticated.run.lastSequence + 1
					&& Number.isSafeInteger(value.controlSequence) && value.controlSequence === authenticated.run.controlSequence) {
					authenticated.run.lastSequence = value.sequence as number;
					authenticated.run.controlAcknowledged = value.controlSequence as number;
					if (authenticated.run.active) this.notify(authenticated.run);
					continue;
				}
				if (!exactKeys(value, ["version", "type", "runId", "sequence"]) || value.version !== VERSION
					|| typeof value.type !== "string" || !EVENT_TYPES.has(value.type) || value.runId !== authenticated.runId
					|| !Number.isSafeInteger(value.sequence) || value.sequence !== authenticated.run.lastSequence + 1) { fail(); return; }
				authenticated.run.lastSequence = value.sequence as number;
				if (value.type === "agent-started" || value.type === "agent-ended") {
					authenticated.run.activityGeneration = (authenticated.run.activityGeneration ?? 0) + 1;
					authenticated.run.steerRunning = value.type === "agent-started";
					this.discardSteeringQueue(authenticated.run);
				}
				if (["agent-settled", "completion-ready", "shutdown"].includes(value.type as string)) {
					this.closeSteering(authenticated.run);
					this.closeReporting(authenticated.runId);
				}
				if (value.type === "heartbeat") authenticated.run.lastHeartbeatAt = performance.now();
				if (authenticated.run.active) this.notify(authenticated.run);
			}
			if (buffer.length > (authenticated ? MAX_REPORT_FRAME_BYTES : MAX_FRAME_BYTES)) fail();
		});
		const ended = () => {
			clearTimeout(helloTimer);
			this.connections = Math.max(0, this.connections - 1);
			this.connectionsSet.delete(socket);
			if (authenticated?.run.socket === socket) {
				this.closeSteering(authenticated.run);
				this.closeReporting(authenticated.runId);
				authenticated.run.reportPending = false;
				authenticated.run.socket = null;
				authenticated.run.active = false;
				authenticated.run.token = ""; // reconnect requires a fresh explicit registration/handoff.
			}
			if (authenticated) this.notify(authenticated.run);
		};
		socket.once("close", ended);
		socket.once("error", () => undefined);
	}

	private async validateStartupMarkerIdentity(): Promise<void> {
		const markerStats = await fs.lstat(this.markerPath, { bigint: true });
		if (!this.markerIdentity || !markerStats.isFile() || markerStats.isSymbolicLink()
			|| markerStats.uid !== CURRENT_UID || (markerStats.mode & 0o777n) !== 0o600n
			|| markerStats.dev !== this.markerIdentity.dev || markerStats.ino !== this.markerIdentity.ino) {
			throw new Error("Lifecycle socket startup marker authority changed.");
		}
	}

	private async validateCleanupGenerationAuthority(): Promise<void> {
		const [directory, marker, markerStats] = await Promise.all([
			fs.lstat(this.directory, { bigint: true }), fs.readFile(this.markerPath, "utf8"), fs.lstat(this.markerPath, { bigint: true }),
		]);
		if (!this.generation || !this.directoryIdentity || !this.markerIdentity || !directory.isDirectory() || directory.isSymbolicLink()
			|| directory.uid !== CURRENT_UID || (directory.mode & 0o777n) !== 0o700n
			|| directory.dev !== this.directoryIdentity.dev || directory.ino !== this.directoryIdentity.ino
			|| marker !== `${this.generation}\n` || !markerStats.isFile() || markerStats.isSymbolicLink()
			|| markerStats.uid !== CURRENT_UID || (markerStats.mode & 0o777n) !== 0o600n
			|| markerStats.dev !== this.markerIdentity.dev || markerStats.ino !== this.markerIdentity.ino) {
			throw new Error("Lifecycle socket cleanup authority changed.");
		}
	}

	/** Cleanup before a listener identity exists; uncertain artifacts are retained. */
	private async cleanupStartupFailure(): Promise<void> {
		this.closed = true;
		const server = this.server;
		// Do not invoke native close for a listener whose pathname identity was
		// never captured: Bun/Node close may unlink a replacement occupant.
		if (server && !server.listening) {
			try { await new Promise<void>((resolve) => server.close(() => resolve())); }
			catch { /* a pre-listen close has no pathname cleanup authority */ }
		}
		const directory = await fs.lstat(this.directory, { bigint: true });
		if (!this.directoryIdentity || !directory.isDirectory() || directory.isSymbolicLink()
			|| directory.uid !== CURRENT_UID || (directory.mode & 0o777n) !== 0o700n
			|| directory.dev !== this.directoryIdentity.dev || directory.ino !== this.directoryIdentity.ino) {
			throw new Error("Lifecycle socket startup cleanup authority changed.");
		}
		if (this.markerIdentity) {
			// A fstat identity captured before marker write proves the partial file;
			// do not require generation content until successful normal cleanup.
			await this.validateStartupMarkerIdentity();
			await fs.unlink(this.markerPath);
		} else if (await fs.lstat(this.markerPath).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error))) {
			throw new Error("Lifecycle socket startup marker authority is unavailable.");
		}
		await fs.rmdir(this.directory);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		const server = this.server;
		if (!server) throw new Error("Lifecycle socket listener was never created.");
		for (const runId of [...this.runs.keys()]) this.terminalRun(runId);
		for (const socket of this.connectionsSet) socket.destroy();

		let authorityChanged = false;
		let unlinkedOwnedSocket = false;
		let foreignPath: string | null = null;
		try {
			// Directory and marker generations are authority too: prove all three
			// identities before mutating the socket pathname.
			await this.validateCleanupGenerationAuthority();
			await validateSocketPath(this.socketPath);
			const before = await fs.lstat(this.socketPath, { bigint: true });
			if (!before.isSocket() || !this.socketIdentity || before.dev !== this.socketIdentity.dev || before.ino !== this.socketIdentity.ino) {
				authorityChanged = true;
			} else {
				// Best-effort unlink after checking our generation. A same-UID peer
				// can still replace this pathname before unlink or native close; the
				// platform exposes no inode-bound close/unlink operation.
				await fs.unlink(this.socketPath);
				unlinkedOwnedSocket = true;
			}
		} catch {
			authorityChanged = true;
		}

		if (authorityChanged) {
			// The test/runtime probe confirms Bun's close auto-unlink behavior.
			// Move the observed foreign pathname aside before closing the owned
			// listener, then restore it without overwriting any newer occupant.
			foreignPath = path.join(this.directory, `.foreign-events-${crypto.randomBytes(16).toString("hex")}`);
			try { await fs.rename(this.socketPath, foreignPath); }
			catch { foreignPath = null; }
		}

		try {
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		} finally {
			for (const socket of this.connectionsSet) socket.destroy();
		}

		if (foreignPath) {
			try {
				const current = await fs.lstat(this.socketPath).then(() => true, (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
				if (!current) await fs.rename(foreignPath, this.socketPath);
			} catch { /* retain the foreign artifact rather than overwrite it */ }
		}
		if (authorityChanged || !unlinkedOwnedSocket) throw new Error("Lifecycle socket cleanup authority changed.");

		await this.validateCleanupGenerationAuthority();
		await fs.unlink(this.markerPath);
		await fs.rmdir(this.directory);
	}
}

export async function writeLifecycleBootstrapToken(filePath: string, token: string): Promise<void> {
	if (!TOKEN_PATTERN.test(token)) throw new Error("Invalid lifecycle capability token.");
	await fs.writeFile(filePath, `${token}\n`, { mode: 0o600, flag: "wx" });
}

async function consumeBootstrapToken(filePath: string, expectedPath: string): Promise<string> {
	if (path.resolve(filePath) !== path.resolve(expectedPath)) throw new Error("Lifecycle token path is outside the run contract.");
	const directoryPath = path.dirname(filePath);
	const directory = await fs.lstat(directoryPath);
	if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || (directory.mode & 0o777) !== 0o700) {
		throw new Error("Unsafe lifecycle token directory.");
	}
	const handle = await fs.open(filePath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o777n) !== 0o600n || before.size > 128n) throw new Error("Unsafe lifecycle token artifact.");
		const token = (await handle.readFile("utf8")).trim();
		if (!TOKEN_PATTERN.test(token)) throw new Error("Malformed lifecycle capability token.");
		const current = await fs.lstat(filePath, { bigint: true });
		if (current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error("Lifecycle token artifact changed before consumption.");
		await fs.unlink(filePath);
		return token;
	} finally { await handle.close(); }
}

export class LifecycleEventClient {
	private sequence = 0;
	private heartbeat: NodeJS.Timeout | null = null;
	private usable = true;
	private controlSequence = 0;
	private steerSequence = 0;
	private reportSequence = 0;
	private readonly reportRate: ParentReportRate;
	private reportGeneration = 0;
	private readonly reportQueue: WaitingReport[] = [];
	private reportDispatchScheduled = false;
	private reportAcknowledged = 0;
	private reportClosed = false;
	reportSupported = false;
	private reportPending: { sequence: number; resolve: (outcome: ReportOutcome) => void } | null = null;
	private steerHandler: ((message: string) => boolean) | null = null;
	private steerClosed = false;
	/** true ACKs one inbox admission only; the child boundary owns consumption. */
	setSteerHandler(handler: (message: string) => boolean): void { this.steerHandler = handler; }
	private controlHandler: ((command: "abort") => Promise<void> | void) | null = null;
	private readonly pendingControls: Array<{ command: "abort"; sequence: number }> = [];
	private controlDraining = false;
	private constructor(private readonly socket: net.Socket, private readonly runId: string, now: () => number) {
		this.reportRate = new ParentReportRate(now);
	}
	private get bufferedByteLimit(): number {
		return this.reportSupported ? MAX_REPORT_CLIENT_BUFFERED_BYTES : MAX_CLIENT_BUFFERED_BYTES;
	}

	setControlHandler(handler: (command: "abort") => Promise<void> | void): void {
		this.controlHandler = handler;
		void this.drainControls();
	}

	/** Frames are sequenced at receipt, but acknowledgement follows a successful handler only. */
	private async drainControls(): Promise<void> {
		if (this.controlDraining || !this.controlHandler || !this.usable) return;
		this.controlDraining = true;
		try {
			while (this.usable && this.pendingControls.length > 0) {
				const handler = this.controlHandler;
				if (!handler) return;
				const control = this.pendingControls[0]!;
				try { await handler(control.command); }
				catch { return; } // Never ACK an absent or failed handler.
				this.pendingControls.shift();
				if (!this.sendControlAck(control.sequence)) return;
			}
		} finally { this.controlDraining = false; }
	}

	static async connectFromEnvironment(env: NodeJS.ProcessEnv, statePath: string, heartbeat = true, report = false, now: () => number = () => performance.now()): Promise<LifecycleEventClient | null> {
		const socketPath = env[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]?.trim();
		const tokenPath = env[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]?.trim();
		delete env[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV];
		delete env[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV];
		if (!socketPath || !tokenPath) return null;
		const runId = env.PI_SUBAGENT_RUN_ID?.trim();
		if (!runId || !RUN_ID_PATTERN.test(runId)) return null;
		let token: string;
		try { token = await consumeBootstrapToken(tokenPath, path.join(path.dirname(statePath), "lifecycle-token")); }
		catch { return null; }
		try { await validateSocketPath(socketPath); } catch { return null; }
		const socket = net.createConnection({ path: socketPath });
		try {
			await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
			const hello = { version: VERSION, type: "hello", runId, token, childPid: process.pid, sequence: 0, ...(report ? { report: true } : {}) };
			const helloFrame = `${JSON.stringify(hello)}\n`;
			if (Buffer.byteLength(helloFrame) > MAX_FRAME_BYTES || socket.writableLength > MAX_CLIENT_BUFFERED_BYTES) throw new Error("Lifecycle hello buffer is unavailable.");
			const client = new LifecycleEventClient(socket, runId, now);
			let inbound = Buffer.alloc(0), acknowledged = false;
			let resolveHello!: () => void, rejectHello!: (error: Error) => void;
			const helloAcknowledged = new Promise<void>((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
			const rejectProtocol = () => { client.usable = false; client.closeReports(); rejectHello(new Error("Lifecycle hello acknowledgement is invalid.")); socket.destroy(); };
			const helloTimer = setTimeout(() => rejectProtocol(), HELLO_TIMEOUT_MS);
			helloTimer.unref?.();
			socket.on("data", (chunk: Buffer) => {
				if (chunk.length > MAX_CONNECTION_CHUNK_BYTES) { rejectProtocol(); return; }
				inbound = Buffer.concat([inbound, chunk]);
				if (inbound.length > MAX_FRAME_BYTES + 1 && !inbound.includes(0x0a)) { rejectProtocol(); return; }
				for (;;) {
					const lf = inbound.indexOf(0x0a); if (lf < 0) break;
					const value = parseLine(inbound.subarray(0, lf)); inbound = inbound.subarray(lf + 1);
					if (!acknowledged) {
						if (!value || !(exactKeys(value, ["version", "type", "runId", "sequence"])
								|| (report && exactKeys(value, ["version", "type", "runId", "sequence", "report"]) && typeof value.report === "boolean"))
							|| value.version !== VERSION || value.type !== "hello-ack" || value.runId !== runId || value.sequence !== 0) { rejectProtocol(); return; }
						client.reportSupported = report && value.report === true;
						acknowledged = true; clearTimeout(helloTimer); resolveHello(); continue;
					}
					if (value?.type === "report-ack") {
						if (!exactKeys(value, ["version", "type", "runId", "reportSequence", "accepted"])
							|| value.version !== VERSION || value.runId !== runId || typeof value.accepted !== "boolean"
							|| !Number.isSafeInteger(value.reportSequence) || value.reportSequence !== client.reportSequence || value.reportSequence === client.reportAcknowledged) { rejectProtocol(); return; }
						client.reportAcknowledged = value.reportSequence as number;
						client.reportPending?.resolve(value.accepted ? "submitted" : "rejected");
						continue;
					}
					if (value?.type === "steer") {
						if (!exactKeys(value, ["version", "type", "runId", "sequence", "message"])
							|| value.version !== VERSION || value.runId !== runId || value.sequence !== client.steerSequence + 1
							|| !isSteeringMessage(value.message)) { rejectProtocol(); return; }
						client.steerSequence = value.sequence as number;
						let accepted = false;
						try { accepted = !client.steerClosed && Boolean(client.steerHandler?.(value.message)); } catch { /* generic rejection only */ }
						client.sequence += 1;
						const ack = `${JSON.stringify({ version: VERSION, type: "steer-ack", runId, sequence: client.sequence, steerSequence: client.steerSequence, accepted })}\n`;
						if (socket.writableLength + Buffer.byteLength(ack) > client.bufferedByteLimit) { rejectProtocol(); return; }
						socket.write(ack);
						continue;
					}
					if (!value || !exactKeys(value, ["version", "type", "command", "runId", "sequence"])
						|| value.version !== VERSION || value.type !== "control" || !CONTROL_TYPES.has(value.command as string)
						|| value.runId !== runId || !Number.isSafeInteger(value.sequence) || value.sequence !== client.controlSequence + 1) { rejectProtocol(); return; }
					client.closeReports();
					client.steerClosed = true; // abort always retains priority over steering.
					client.controlSequence = value.sequence as number;
					client.pendingControls.push({ command: value.command as "abort", sequence: client.controlSequence });
					void client.drainControls();
				}
				if (inbound.length > MAX_FRAME_BYTES) rejectProtocol();
			});
			socket.on("error", () => { client.usable = false; client.closeReports(); if (!acknowledged) rejectHello(new Error("Lifecycle socket failed before hello acknowledgement.")); });
			socket.on("close", () => { client.usable = false; client.closeReports(); if (!acknowledged) rejectHello(new Error("Lifecycle socket closed before hello acknowledgement.")); if (client.heartbeat) clearInterval(client.heartbeat); });
			socket.write(helloFrame);
			await helloAcknowledged;
			if (heartbeat) {
				client.heartbeat = setInterval(() => client.send("heartbeat"), 1000);
				client.heartbeat.unref?.();
			}
			return client;
		} catch { socket.destroy(); return null; }
	}

	private discardReportQueue(): void {
		for (const request of this.reportQueue.splice(0)) {
			request.cleanup();
			request.resolve("unavailable");
		}
	}

	private closeReports(): void {
		this.reportClosed = true;
		this.discardReportQueue();
		this.reportPending?.resolve("unknown");
	}

	/** Only remote API admission is submitted. Unknown fences all further reports. */
	async requestReport(message: string, signal?: AbortSignal, eligible: () => boolean = () => true, kind: ParentReportKind = "progress"): Promise<ReportOutcome> {
		if (!isParentReportKind(kind) || !isParentReportMessage(message) || !this.reportSupported || !this.usable || this.reportClosed || this.socket.destroyed || signal?.aborted || !eligible()) return "unavailable";
		if (!this.reportRate.available()) return "limit";
		if (this.reportQueue.length >= LOCAL_MESSAGE_WAIT_CAPACITY) return "queue-full";
		return await new Promise<ReportOutcome>((resolve) => {
			const abort = () => {
				const index = this.reportQueue.indexOf(request);
				if (index < 0) return;
				this.reportQueue.splice(index, 1);
				request.cleanup();
				resolve("unavailable"); // UNSENT cancellation cannot be unknown or fence the active request.
			};
			const request: WaitingReport = { message, kind, signal, eligible, generation: this.reportGeneration, resolve,
				cleanup: () => signal?.removeEventListener("abort", abort) };
			signal?.addEventListener("abort", abort, { once: true });
			this.reportQueue.push(request);
			this.dispatchReport();
		});
	}

	private dispatchReport(): void {
		if (this.reportPending || this.reportDispatchScheduled) return;
		const request = this.reportQueue.shift();
		if (!request) return;
		request.cleanup(); // Replace the waiting-only abort listener with the active one below.
		const { signal, message, kind, resolve } = request;
		const refuse = (outcome: ReportOutcome) => { resolve(outcome); this.dispatchReport(); };
		if (!this.reportSupported || !this.usable || this.reportClosed || this.socket.destroyed || signal?.aborted
			|| request.generation !== this.reportGeneration || !request.eligible()) { refuse("unavailable"); return; }
		if (!this.reportRate.available()) { refuse("limit"); return; }
		const reportSequence = this.reportSequence + 1;
		const frame = `${JSON.stringify({ version: VERSION, type: "report", runId: this.runId, sequence: this.sequence + 1, reportSequence, message, kind })}\n`;
		const frameBytes = Buffer.byteLength(frame);
		if (frameBytes > MAX_REPORT_FRAME_BYTES || this.socket.writableLength >= NONTERMINAL_BUFFER_LIMIT_BYTES
			|| this.socket.writableLength + frameBytes > REPORT_BUFFER_LIMIT_BYTES) { refuse("busy"); return; }
		let settled = false;
		const done = (outcome: ReportOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			this.reportPending = null;
			if (outcome === "unknown") { this.reportClosed = true; this.discardReportQueue(); }
			// A buffered abort must be parsed before the next report can send.
			// Reentrant requests share this one deferred FIFO pump.
			this.reportDispatchScheduled = true;
			resolve(outcome);
			queueMicrotask(() => {
				this.reportDispatchScheduled = false;
				this.dispatchReport();
			});
		};
		const abort = () => done("unknown");
		const timer = setTimeout(abort, 1000);
		this.reportPending = { sequence: reportSequence, resolve: done };
		this.reportSequence = reportSequence;
		this.reportRate.take();
		this.sequence++;
		signal?.addEventListener("abort", abort, { once: true });
		try { this.socket.write(frame); } catch { done("unknown"); }
	}

	private sendControlAck(controlSequence: number): boolean {
		if (!this.usable || this.socket.destroyed || !Number.isSafeInteger(controlSequence) || controlSequence < 1) return false;
		this.sequence += 1;
		const frame = `${JSON.stringify({ version: VERSION, type: "control-ack", runId: this.runId, sequence: this.sequence, controlSequence })}\n`;
		if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || this.socket.writableLength > this.bufferedByteLimit) { this.usable = false; this.socket.destroy(); return false; }
		this.socket.write(frame); return true;
	}

	send(type: "agent-started" | "agent-ended" | "agent-settled" | "completion-ready" | "shutdown" | "heartbeat"): boolean {
		if (!this.usable || this.socket.destroyed) return false;
		if (type === "agent-started" || type === "agent-ended") { this.reportGeneration++; this.discardReportQueue(); }
		if (["agent-settled", "completion-ready", "shutdown"].includes(type)) { this.steerClosed = true; this.closeReports(); }
		this.sequence += 1;
		const frame = `${JSON.stringify({ version: VERSION, type, runId: this.runId, sequence: this.sequence })}\n`;
		const terminal = type === "completion-ready" || type === "shutdown";
		if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || this.socket.writableLength > this.bufferedByteLimit) {
			this.usable = false; this.socket.destroy(); return false;
		}
		if (!terminal && this.socket.writableLength > NONTERMINAL_BUFFER_LIMIT_BYTES) {
			this.sequence -= 1; // dropped coalescible hint must not create a sequence gap.
			return false;
		}
		// write(false) means queued backpressure, not failure. Nonterminal frames
		// stop above the low watermark, reserving bounded space for terminal hints;
		// socket.end() later flushes queued completion-ready/shutdown frames.
		this.socket.write(frame);
		return true;
	}

	close(): void {
		this.closeReports();
		this.steerClosed = true;
		this.steerHandler = null;
		this.controlHandler = null;
		this.pendingControls.length = 0;
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
		this.socket.end();
	}
}
