import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";

export const SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV = "PI_SUBAGENT_LIFECYCLE_SOCKET_PATH";
export const SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV = "PI_SUBAGENT_LIFECYCLE_TOKEN_PATH";
const VERSION = 1 as const;
const MAX_FRAME_BYTES = 4096;
const MAX_CONNECTIONS = 64;
const MAX_CONNECTION_CHUNK_BYTES = 64 * 1024;
const HELLO_TIMEOUT_MS = 1000;
const IDLE_TIMEOUT_MS = 15_000;
const MAX_CLIENT_BUFFERED_BYTES = 16 * 1024;
const NONTERMINAL_BUFFER_LIMIT_BYTES = 8 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVENT_TYPES = new Set(["agent-started", "agent-ended", "agent-settled", "completion-ready", "shutdown", "heartbeat"]);
const CONTROL_TYPES = new Set(["abort"]);

export interface LifecycleEvent {
	version: 1;
	type: string;
	runId: string;
	sequence: number;
	childPid?: number;
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
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function object(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseLine(line: Buffer): Record<string, unknown> | null {
	if (line.length === 0 || line.length > MAX_FRAME_BYTES || line.includes(0x0d) || line.includes(0x00)) return null;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
		const value = JSON.parse(text);
		return object(value) ? value : null;
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

export class LifecycleEventServer {
	readonly socketPath: string;
	readonly directory: string;
	private readonly generation: string;
	private readonly markerPath: string;
	private readonly server: net.Server;
	private readonly runs = new Map<string, RunRegistration>();
	private socketIdentity: { dev: bigint; ino: bigint } | null = null;
	private connections = 0;
	private closed = false;

	private constructor(directory: string, generation: string, server: net.Server) {
		this.directory = directory;
		this.socketPath = path.join(directory, "events.sock");
		this.markerPath = path.join(directory, "generation");
		this.generation = generation;
		this.server = server;
	}

	static async start(): Promise<LifecycleEventServer> {
		if (process.platform === "win32") throw new Error("Lifecycle Unix sockets are unavailable on Windows.");
		const root = await safeTemporaryRoot();
		const directory = await fs.mkdtemp(path.join(root, ".pi-se-"));
		await fs.chmod(directory, 0o700);
		const generation = crypto.randomBytes(32).toString("base64url");
		const server = net.createServer();
		const instance = new LifecycleEventServer(directory, generation, server);
		await fs.writeFile(instance.markerPath, `${generation}\n`, { mode: 0o600, flag: "wx" });
		server.on("connection", (socket) => instance.accept(socket));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(instance.socketPath, () => { server.off("error", reject); resolve(); });
		});
		await fs.chmod(instance.socketPath, 0o600);
		await validateSocketPath(instance.socketPath);
		const stats = await fs.lstat(instance.socketPath, { bigint: true });
		if (!stats.isSocket()) { await instance.close(); throw new Error("Lifecycle socket bind did not create a socket."); }
		instance.socketIdentity = { dev: stats.dev, ino: stats.ino };
		return instance;
	}

	registerRun(runId: string): string {
		if (this.closed || !RUN_ID_PATTERN.test(runId) || this.runs.has(runId)) throw new Error("Invalid or duplicate lifecycle run registration.");
		const token = crypto.randomBytes(32).toString("base64url");
		this.runs.set(runId, { token, active: false, terminal: false, socket: null, lastSequence: 0, lastHeartbeatAt: performance.now(), controlSequence: 0, controlAcknowledged: 0, waiters: new Set() });
		return token;
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
		if (run.controlSequence > 0 && run.controlAcknowledged === run.controlSequence) return true;
		if (run.controlSequence > run.controlAcknowledged) return true;
		const sequence = ++run.controlSequence;
		const frame = `${JSON.stringify({ version: VERSION, type: "control", command: "abort", runId, sequence })}\n`;
		if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || run.socket.writableLength > NONTERMINAL_BUFFER_LIMIT_BYTES) { run.socket.destroy(); return false; }
		run.socket.write(frame);
		return true;
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
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > MAX_FRAME_BYTES + 1 && !buffer.includes(0x0a)) { fail(); return; }
			while (true) {
				const lf = buffer.indexOf(0x0a);
				if (lf < 0) break;
				const line = buffer.subarray(0, lf);
				buffer = buffer.subarray(lf + 1);
				const value = parseLine(line);
				if (!value) { fail(); return; }
				if (!authenticated) {
					if (!exactKeys(value, ["version", "type", "runId", "token", "childPid", "sequence"])
						|| value.version !== VERSION || value.type !== "hello" || typeof value.runId !== "string"
						|| typeof value.token !== "string" || !Number.isSafeInteger(value.childPid) || (value.childPid as number) <= 0 || value.sequence !== 0) { fail(); return; }
					const run = this.runs.get(value.runId);
					if (!run || run.terminal || run.socket || !TOKEN_PATTERN.test(value.token)
						|| !crypto.timingSafeEqual(Buffer.from(run.token), Buffer.from(value.token))) { fail(); return; }
					authenticated = { runId: value.runId, run };
					run.socket = socket;
					const helloAck = `${JSON.stringify({ version: VERSION, type: "hello-ack", runId: value.runId, sequence: 0 })}\n`;
					if (Buffer.byteLength(helloAck) > MAX_FRAME_BYTES || socket.writableLength > NONTERMINAL_BUFFER_LIMIT_BYTES) { fail(); return; }
					socket.write(helloAck);
					clearTimeout(helloTimer);
					if (run.active) this.notify(run);
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
				if (value.type === "heartbeat") authenticated.run.lastHeartbeatAt = performance.now();
				if (authenticated.run.active) this.notify(authenticated.run);
			}
			if (buffer.length > MAX_FRAME_BYTES) fail();
		});
		const ended = () => {
			clearTimeout(helloTimer);
			this.connections = Math.max(0, this.connections - 1);
			if (authenticated?.run.socket === socket) {
				authenticated.run.socket = null;
				authenticated.run.active = false;
				authenticated.run.token = ""; // reconnect requires a fresh explicit registration/handoff.
			}
			if (authenticated) this.notify(authenticated.run);
		};
		socket.once("close", ended);
		socket.once("error", () => undefined);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const runId of [...this.runs.keys()]) this.terminalRun(runId);
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
		const [directory, marker, markerStats, socket] = await Promise.all([
			fs.lstat(this.directory), fs.readFile(this.markerPath, "utf8"), fs.lstat(this.markerPath), fs.lstat(this.socketPath, { bigint: true }).catch(() => null),
		]);
		if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || directory.uid !== process.getuid?.()
			|| marker !== `${this.generation}\n` || !markerStats.isFile() || markerStats.isSymbolicLink() || markerStats.uid !== process.getuid?.() || (markerStats.mode & 0o777) !== 0o600
			|| !socket?.isSocket() || !this.socketIdentity
			|| socket.dev !== this.socketIdentity.dev || socket.ino !== this.socketIdentity.ino) {
			throw new Error("Lifecycle socket cleanup authority changed.");
		}
		await fs.unlink(this.socketPath);
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
	private controlHandler: ((command: "abort") => Promise<void> | void) | null = null;
	private readonly pendingControls: Array<{ command: "abort"; sequence: number }> = [];
	private controlDraining = false;
	private constructor(private readonly socket: net.Socket, private readonly runId: string) {}

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

	static async connectFromEnvironment(env: NodeJS.ProcessEnv, statePath: string): Promise<LifecycleEventClient | null> {
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
			const hello = { version: VERSION, type: "hello", runId, token, childPid: process.pid, sequence: 0 };
			const helloFrame = `${JSON.stringify(hello)}\n`;
			if (Buffer.byteLength(helloFrame) > MAX_FRAME_BYTES || socket.writableLength > MAX_CLIENT_BUFFERED_BYTES) throw new Error("Lifecycle hello buffer is unavailable.");
			const client = new LifecycleEventClient(socket, runId);
			let inbound = Buffer.alloc(0), acknowledged = false;
			let resolveHello!: () => void, rejectHello!: (error: Error) => void;
			const helloAcknowledged = new Promise<void>((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
			const rejectProtocol = () => { client.usable = false; rejectHello(new Error("Lifecycle hello acknowledgement is invalid.")); socket.destroy(); };
			const helloTimer = setTimeout(() => rejectProtocol(), HELLO_TIMEOUT_MS);
			helloTimer.unref?.();
			socket.on("data", (chunk: Buffer) => {
				inbound = Buffer.concat([inbound, chunk]);
				if (inbound.length > MAX_FRAME_BYTES + 1) { rejectProtocol(); return; }
				for (;;) {
					const lf = inbound.indexOf(0x0a); if (lf < 0) break;
					const value = parseLine(inbound.subarray(0, lf)); inbound = inbound.subarray(lf + 1);
					if (!acknowledged) {
						if (!value || !exactKeys(value, ["version", "type", "runId", "sequence"])
							|| value.version !== VERSION || value.type !== "hello-ack" || value.runId !== runId || value.sequence !== 0) { rejectProtocol(); return; }
						acknowledged = true; clearTimeout(helloTimer); resolveHello(); continue;
					}
					if (!value || !exactKeys(value, ["version", "type", "command", "runId", "sequence"])
						|| value.version !== VERSION || value.type !== "control" || !CONTROL_TYPES.has(value.command as string)
						|| value.runId !== runId || !Number.isSafeInteger(value.sequence) || value.sequence !== client.controlSequence + 1) { rejectProtocol(); return; }
					client.controlSequence = value.sequence as number;
					client.pendingControls.push({ command: value.command as "abort", sequence: client.controlSequence });
					void client.drainControls();
				}
			});
			socket.on("error", () => { client.usable = false; if (!acknowledged) rejectHello(new Error("Lifecycle socket failed before hello acknowledgement.")); });
			socket.on("close", () => { client.usable = false; if (!acknowledged) rejectHello(new Error("Lifecycle socket closed before hello acknowledgement.")); if (client.heartbeat) clearInterval(client.heartbeat); });
			socket.write(helloFrame);
			await helloAcknowledged;
			client.heartbeat = setInterval(() => client.send("heartbeat"), 1000);
			client.heartbeat.unref?.();
			return client;
		} catch { socket.destroy(); return null; }
	}

	private sendControlAck(controlSequence: number): boolean {
		if (!this.usable || this.socket.destroyed || !Number.isSafeInteger(controlSequence) || controlSequence < 1) return false;
		this.sequence += 1;
		const frame = `${JSON.stringify({ version: VERSION, type: "control-ack", runId: this.runId, sequence: this.sequence, controlSequence })}\n`;
		if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || this.socket.writableLength > MAX_CLIENT_BUFFERED_BYTES) { this.usable = false; this.socket.destroy(); return false; }
		this.socket.write(frame); return true;
	}

	send(type: "agent-started" | "agent-ended" | "agent-settled" | "completion-ready" | "shutdown" | "heartbeat"): boolean {
		if (!this.usable || this.socket.destroyed) return false;
		this.sequence += 1;
		const frame = `${JSON.stringify({ version: VERSION, type, runId: this.runId, sequence: this.sequence })}\n`;
		const terminal = type === "completion-ready" || type === "shutdown";
		if (Buffer.byteLength(frame) > MAX_FRAME_BYTES || this.socket.writableLength > MAX_CLIENT_BUFFERED_BYTES) {
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
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
		this.socket.end();
	}
}
