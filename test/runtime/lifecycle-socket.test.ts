import { afterEach, describe, jest, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
	LOCAL_MESSAGE_WAIT_CAPACITY,
	LifecycleEventClient,
	LifecycleEventServer,
	SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV,
	SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV,
	writeLifecycleBootstrapToken,
} from "../../src/runtime/lifecycle-socket";

const servers: LifecycleEventServer[] = [];
const roots: string[] = [];
const savedEnv = { ...process.env };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
	while (servers.length) await servers.pop()!.close().catch(() => undefined);
	while (roots.length) await fs.promises.rm(roots.pop()!, { recursive: true, force: true });
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

async function setup(runId = "run-1", activate = true) {
	const server = await LifecycleEventServer.start(); servers.push(server);
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-lifecycle-")); roots.push(root);
	const tokenPath = path.join(root, "lifecycle-token");
	const statePath = path.join(root, "state.json");
	const token = server.registerRun(runId);
	await writeLifecycleBootstrapToken(tokenPath, token);
	if (activate) server.activateRun(runId);
	process.env.PI_SUBAGENT_RUN_ID = runId;
	process.env[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV] = server.socketPath;
	process.env[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV] = tokenPath;
	return { server, root, tokenPath, statePath, token, runId };
}

async function expectStartupFailureWithCleanup(install: (originals: Record<string, any>, directory: () => string) => Record<string, any>): Promise<void> {
	const originals = {
		lstat: fs.promises.lstat,
		open: fs.promises.open,
		chmod: fs.promises.chmod,
		createServer: net.createServer,
	};
	let createdDirectory: string | null = null;
	const operations = install(originals, () => createdDirectory ?? "");
	const afterMkdtemp = operations.afterMkdtemp;
	operations.afterMkdtemp = async (directory: string) => {
		createdDirectory = directory;
		await afterMkdtemp?.(directory);
	};
	// Injection is passed only to this start call; no process-global module
	// method is mocked, so every failure path restores native behavior by scope.
	await assert.rejects(() => LifecycleEventServer.start(operations));
	assert.ok(createdDirectory);
	assert.equal(await originals.lstat(createdDirectory).then(() => true, () => false), false);
}

describe("private lifecycle socket", () => {
	test("steering requires connected activated active run and yields only inbox admission ACK", async () => {
		const fixture = await setup("steer-run", false);
		assert.equal(await fixture.server.requestSteer(fixture.runId, "change direction"), "unavailable");
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath);
		assert.ok(client);
		const received: string[] = [];
		client.setSteerHandler((message) => { received.push(message); return true; });
		client.send("agent-started");
		await delay(10);
		assert.equal(await fixture.server.requestSteer(fixture.runId, "change direction"), "unavailable");
		fixture.server.activateRun(fixture.runId);
		const pending = fixture.server.requestSteer(fixture.runId, "한글\n/new-task");
		const second = fixture.server.requestSteer(fixture.runId, "second");
		assert.deepEqual(await Promise.all([pending, second]), ["submitted", "submitted"]);
		assert.deepEqual(received, ["한글\n/new-task", "second"]);
		client.send("agent-ended"); await delay(10);
		assert.equal(await fixture.server.requestSteer(fixture.runId, "before-settle"), "unavailable");
		assert.deepEqual(received, ["한글\n/new-task", "second"]);
		client.send("agent-started"); await delay(10);
		assert.equal(await fixture.server.requestSteer(fixture.runId, "normal continuation"), "submitted");
		client.setSteerHandler(() => false);
		assert.equal(await fixture.server.requestSteer(fixture.runId, "reject"), "rejected");
		client.send("agent-settled"); await delay(10);
		assert.equal(await fixture.server.requestSteer(fixture.runId, "terminal"), "unavailable");
		client.close();
	});

	test("steering preserves abort sequencing and cancel wins over an in-flight submission", async () => {
		const fixture = await setup("steer-abort");
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath);
		assert.ok(client);
		let submissions = 0, aborts = 0;
		client.setSteerHandler(() => { submissions += 1; return true; });
		client.setControlHandler(() => { aborts += 1; });
		client.send("agent-started"); await delay(10);
		const pending = fixture.server.requestSteer(fixture.runId, "race");
		const queued = fixture.server.requestSteer(fixture.runId, "unsent");
		assert.equal(fixture.server.requestAbort(fixture.runId), true);
		assert.equal(await pending, "unknown");
		assert.equal(await queued, "unavailable");
		await delay(30);
		assert.ok(submissions <= 1, "a socket write can precede cancel; no retry or duplicate");
		assert.equal(aborts, 1);
		assert.equal(fixture.server.isAbortAcknowledged(fixture.runId), true);
		assert.equal(await fixture.server.requestSteer(fixture.runId, "post-cancel"), "unavailable");
		client.close();
	});

	test("terminal cleanup resolves pending steer without retaining a handle or timer", async () => {
		const fixture = await setup("steer-completion");
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath);
		assert.ok(client);
		client.send("agent-started"); await delay(10);
		const pending = fixture.server.requestSteer(fixture.runId, "race");
		const queued = fixture.server.requestSteer(fixture.runId, "unsent");
		fixture.server.terminalRun(fixture.runId);
		assert.equal(await pending, "unknown");
		assert.equal(await queued, "unavailable");
		assert.equal(await fixture.server.requestSteer(fixture.runId, "late"), "unavailable");
		client.close();
	});

	test("bounded steering backpressure/invalid messages do not destroy abort authority", async () => {
		const fixture = await setup("steer-pressure");
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath);
		assert.ok(client);
		client.send("agent-started"); await delay(10);
		const run = (fixture.server as any).runs.get(fixture.runId);
		const socket = run.socket;
		Object.defineProperty(socket, "writableLength", { configurable: true, get: () => 8192 });
		assert.equal(await fixture.server.requestSteer(fixture.runId, "bounded"), "busy");
		assert.equal(socket.destroyed, false);
		delete socket.writableLength;
		assert.equal(await fixture.server.requestSteer(fixture.runId, "한".repeat(200)), "unavailable");
		assert.equal(await fixture.server.requestSteer(fixture.runId, " "), "unavailable");
		client.setControlHandler(() => undefined);
		assert.equal(fixture.server.requestAbort(fixture.runId), true);
		await delay(20);
		assert.equal(fixture.server.isAbortAcknowledged(fixture.runId), true);
		client.close();
	});

	test("missing ACK times out once as unknown, closes steering only, never retries", async () => {
		const fixture = await setup("steer-timeout");
		const raw = net.createConnection({ path: fixture.server.socketPath });
		let frames = "";
		raw.on("data", (chunk) => { frames += chunk.toString(); });
		await new Promise<void>((resolve) => raw.once("connect", resolve));
		raw.write(`${JSON.stringify({ version: 1, type: "hello", runId: fixture.runId, token: fixture.token, childPid: process.pid, sequence: 0 })}\n`);
		raw.write(`${JSON.stringify({ version: 1, type: "agent-started", runId: fixture.runId, sequence: 1 })}\n`);
		await delay(10);
		jest.useFakeTimers();
		try {
			const active = fixture.server.requestSteer(fixture.runId, "one");
			const queued = fixture.server.requestSteer(fixture.runId, "unsent");
			jest.advanceTimersByTime(1000);
			assert.equal(await active, "unknown");
			assert.equal(await queued, "unavailable");
			assert.equal(await fixture.server.requestSteer(fixture.runId, "two"), "unavailable");
			const run = (fixture.server as any).runs.get(fixture.runId);
			assert.equal(run.steerPending, undefined);
			assert.deepEqual(run.steerQueue, []);
		} finally { jest.useRealTimers(); }
		// A lifecycle heartbeat acts as a socket barrier, not a timing sleep.
		const wake = fixture.server.waitForEvent(fixture.runId, 1000);
		raw.write(`${JSON.stringify({ version: 1, type: "heartbeat", runId: fixture.runId, sequence: 2 })}\n`);
		await wake;
		assert.equal(frames.split("\n").filter((line) => line.includes('"type":"steer"')).length, 1);
		assert.equal(fixture.server.requestAbort(fixture.runId), true);
		raw.destroy();
	});
	test("steering waiting FIFO is bounded, ACK deadline starts at dispatch, and eligibility is rechecked", async () => {
		const f = await setup("steer-fifo");
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, f.statePath, false);
		assert.ok(client);
		const wake = f.server.waitForEvent(f.runId, 1000); client.send("agent-started"); await wake;
		const run = (f.server as any).runs.get(f.runId), socket = run.socket;
		const write = socket.write;
		const frames: any[] = [];
		// Hold outgoing steer frames at the real socket seam; deliver ACKs using
		// the real child parser, without OS scheduling consuming the fake deadline.
		socket.write = (frame: string) => { frames.push(JSON.parse(frame)); return true; };
		jest.useFakeTimers();
		try {
			const active = f.server.requestSteer(f.runId, "first");
			let eligible = true, secondDone = false;
			const second = f.server.requestSteer(f.runId, "second").then(result => { secondDone = true; return result; });
			const stale = f.server.requestSteer(f.runId, "revoked", () => eligible);
			const rest = Array.from({ length: LOCAL_MESSAGE_WAIT_CAPACITY - 2 }, (_, i) => f.server.requestSteer(f.runId, `rest ${i}`));
			assert.equal(await f.server.requestSteer(f.runId, "overflow"), "queue-full");
			assert.equal(secondDone, false, "local wait admission is not remote ACK");
			assert.equal(frames.length, 1);
			jest.advanceTimersByTime(900);
			write.call(socket, JSON.stringify(frames[0]) + "\n");
			assert.equal(await active, "rejected"); // no child inbox handler
			assert.equal(frames.length, 2);
			eligible = false;
			jest.advanceTimersByTime(900); // second has its own full deadline
			assert.equal(secondDone, false);
			write.call(socket, JSON.stringify(frames[1]) + "\n");
			assert.equal(await second, "rejected");
			assert.equal(await stale, "unavailable");
			for (let i = 0; i < rest.length; i++) {
				assert.equal(frames[i + 2].message, `rest ${i}`);
				write.call(socket, JSON.stringify(frames[i + 2]) + "\n");
				assert.equal(await rest[i], "rejected");
			}
			jest.advanceTimersByTime(1000);
			assert.equal(run.steerClosed, undefined, "all ACK timers were cleared");
			assert.deepEqual(frames.map(frame => frame.message), ["first", "second", ...rest.map((_, i) => `rest ${i}`)]);
		} finally { socket.write = write; jest.useRealTimers(); client.close(); }
	});

	test("steer ACK defers one FIFO pump even when a new request arrives before the microtask", async () => {
		const f = await setup("steer-deferred-fifo");
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, f.statePath, false);
		assert.ok(client);
		const started = f.server.waitForEvent(f.runId, 1000); client.send("agent-started"); await started;
		const run = (f.server as any).runs.get(f.runId), socket = run.socket;
		const write = socket.write, frames: any[] = [];
		socket.write = (frame: string) => { frames.push(JSON.parse(frame)); return true; };
		const ack = (steerSequence: number) => socket.emit("data", Buffer.from(JSON.stringify({ version: 1, type: "steer-ack",
			runId: f.runId, sequence: run.lastSequence + 1, steerSequence, accepted: true }) + "\n"));
		jest.useFakeTimers();
		try {
			const active = f.server.requestSteer(f.runId, "active");
			const queued = f.server.requestSteer(f.runId, "queued");
			ack(1);
			const reentrant = f.server.requestSteer(f.runId, "reentrant");
			assert.deepEqual(frames.map(frame => frame.message), ["active"], "new request cannot bypass the deferred pump");
			assert.equal(await active, "submitted");
			assert.deepEqual(frames.map(frame => frame.message), ["active", "queued"]);
			ack(2);
			assert.equal(await queued, "submitted");
			assert.deepEqual(frames.map(frame => frame.message), ["active", "queued", "reentrant"]);
			ack(3);
			assert.equal(await reentrant, "submitted");
			assert.equal(run.steerDispatchScheduled, false);
			assert.equal(run.steerPending, undefined);
			assert.deepEqual(run.steerQueue, []);
			jest.advanceTimersByTime(1000);
			assert.equal(run.steerClosed, undefined);
		} finally { socket.write = write; jest.useRealTimers(); client.close(); }
	});

	test("coalesced steer ACK/end/start never sends queued work across the activity boundary", async () => {
		const f = await setup("steer-buffered-boundary");
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, f.statePath, false);
		assert.ok(client);
		const started = f.server.waitForEvent(f.runId, 1000); client.send("agent-started"); await started;
		const run = (f.server as any).runs.get(f.runId), socket = run.socket;
		const write = socket.write, frames: any[] = [];
		socket.write = (frame: string) => { frames.push(JSON.parse(frame)); return true; };
		jest.useFakeTimers();
		try {
			const active = f.server.requestSteer(f.runId, "active");
			const queued = f.server.requestSteer(f.runId, "old unsent");
			const sequence = run.lastSequence;
			// One data event deterministically exercises the authenticated socket's
			// real parser with all three frames in the same inbound batch.
			socket.emit("data", Buffer.from([
				{ version: 1, type: "steer-ack", runId: f.runId, sequence: sequence + 1, steerSequence: 1, accepted: true },
				{ version: 1, type: "agent-ended", runId: f.runId, sequence: sequence + 2 },
				{ version: 1, type: "agent-started", runId: f.runId, sequence: sequence + 3 },
			].map(frame => JSON.stringify(frame) + "\n").join("")));
			assert.deepEqual(frames.map(frame => frame.message), ["active"], "no UNSENT frame may escape before the buffered end/start");
			assert.equal(await active, "submitted");
			assert.equal(await queued, "unavailable");
			assert.equal(run.steerPending, undefined);
			assert.deepEqual(run.steerQueue, []);
			const fresh = f.server.requestSteer(f.runId, "fresh");
			assert.deepEqual(frames.map(frame => frame.message), ["active", "fresh"]);
			socket.emit("data", Buffer.from(JSON.stringify({ version: 1, type: "steer-ack", runId: f.runId,
				sequence: sequence + 4, steerSequence: 2, accepted: true }) + "\n"));
			assert.equal(await fresh, "submitted");
			jest.advanceTimersByTime(1000);
			assert.equal(run.steerClosed, undefined, "no stale ACK deadline survives the transition");
		} finally { socket.write = write; jest.useRealTimers(); client.close(); }
	});

	for (const end of ["agent-ended", "disconnect", "close"] as const) {
		test(`${end} clears queued steering without sending stale work into a normal retry`, async () => {
			const f = await setup(`steer-${end}`);
			const client = await LifecycleEventClient.connectFromEnvironment(process.env, f.statePath, false);
			assert.ok(client);
			const started = f.server.waitForEvent(f.runId, 1000); client.send("agent-started"); await started;
			const run = (f.server as any).runs.get(f.runId), socket = run.socket;
			const write = socket.write, frames: string[] = [];
			socket.write = (frame: string) => { frames.push(frame); return true; };
			jest.useFakeTimers();
			try {
				const active = f.server.requestSteer(f.runId, "active");
				const queued = f.server.requestSteer(f.runId, "unsent");
				if (end === "agent-ended") {
					const ended = f.server.waitForEvent(f.runId, 1000); client.send("agent-ended"); await ended;
					assert.equal(await queued, "unavailable");
					const restarted = f.server.waitForEvent(f.runId, 1000); client.send("agent-started"); await restarted;
					write.call(socket, frames[0]); assert.equal(await active, "rejected");
					const fresh = f.server.requestSteer(f.runId, "fresh");
					write.call(socket, frames[1]); assert.equal(await fresh, "rejected");
				} else {
					if (end === "disconnect") { const closed = f.server.waitForEvent(f.runId, 1000); client.close(); await closed; }
					else await f.server.close();
					assert.equal(await active, "unknown");
					assert.equal(await queued, "unavailable");
				}
				assert.deepEqual(frames.map(frame => JSON.parse(frame).message), end === "agent-ended" ? ["active", "fresh"] : ["active"]);
				assert.equal(run.steerPending, undefined);
				assert.deepEqual(run.steerQueue, []);
				jest.advanceTimersByTime(1000);
			} finally { socket.write = write; jest.useRealTimers(); client.close(); }
		});
	}

	test("consumes the transient token before connect and delivers bounded sequenced hints", async () => {
		const fixture = await setup();
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath);
		assert.ok(client);
		assert.equal(await fs.promises.stat(fixture.tokenPath).then(() => true, () => false), false);
		assert.equal(process.env[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV], undefined);
		assert.equal(process.env[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV], undefined);
		for (let attempt = 0; attempt < 20 && !fixture.server.isConnected(fixture.runId); attempt += 1) await delay(5);
		assert.equal(fixture.server.isConnected(fixture.runId), true);
		const wake = fixture.server.waitForEvent(fixture.runId, 200);
		assert.equal(client.send("agent-started"), true);
		await wake;
		client.close();
		fixture.server.terminalRun(fixture.runId);
	});

	test("holds a valid pre-activation hello until the durable launch gate activates the run", async () => {
		const fixture = await setup("pending-run", false);
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath);
		assert.ok(client);
		for (let attempt = 0; attempt < 20 && !fixture.server.isConnected(fixture.runId); attempt += 1) await delay(5);
		assert.equal(fixture.server.isConnected(fixture.runId), true);
		assert.equal(client.send("agent-started"), true);
		const started = performance.now();
		await fixture.server.waitForEvent(fixture.runId, 20);
		assert.ok(performance.now() - started >= 15);
		fixture.server.activateRun(fixture.runId);
		const afterActivation = fixture.server.waitForEvent(fixture.runId, 100);
		assert.equal(client.send("heartbeat"), true);
		await afterActivation;
		client.close();
	});

	test("retries an abort unavailable before connect and sends only one command after acknowledgement", async () => {
		const fixture = await setup("control-run");
		assert.equal(fixture.server.requestAbort(fixture.runId), false, "an early request remains retryable until the child connects");
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath);
		assert.ok(client);
		let aborts = 0;
		client.setControlHandler(async () => { aborts += 1; });
		for (let attempt = 0; attempt < 20 && !fixture.server.isConnected(fixture.runId); attempt += 1) await delay(5);
		assert.equal(fixture.server.isAbortAcknowledged(fixture.runId), false);
		assert.equal(fixture.server.requestAbort(fixture.runId), true);
		assert.equal(fixture.server.requestAbort(fixture.runId), true, "a pending request is idempotent");
		for (let attempt = 0; attempt < 20 && aborts !== 1; attempt += 1) await delay(5);
		assert.equal(aborts, 1);
		for (let attempt = 0; attempt < 20 && !fixture.server.isAbortAcknowledged(fixture.runId); attempt += 1) await delay(5);
		assert.equal(fixture.server.isAbortAcknowledged(fixture.runId), true);
		assert.equal(fixture.server.requestAbort(fixture.runId), true, "acknowledged abort is never replayed as another control frame");
		await delay(10);
		assert.equal(aborts, 1);
		client.close();
	});

	test("queues an early abort until a handler succeeds and never acknowledges a failed handler", async () => {
		const fixture = await setup("queued-control");
		const client = await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath);
		assert.ok(client);
		for (let attempt = 0; attempt < 20 && !fixture.server.isConnected(fixture.runId); attempt += 1) await delay(5);
		assert.equal(fixture.server.requestAbort(fixture.runId), true);
		await delay(20);
		let attempts = 0;
		client.setControlHandler(async () => { attempts += 1; throw new Error("reject"); });
		await delay(20);
		assert.equal(attempts, 1);
		assert.equal(fixture.server.requestAbort(fixture.runId), true, "failed handler leaves the unacknowledged control pending");
		client.setControlHandler(async () => { attempts += 1; });
		for (let attempt = 0; attempt < 20 && attempts < 2; attempt += 1) await delay(5);
		assert.equal(attempts, 2);
		client.close();
	});

	test("rejects wrong tokens, replayed sequences, unknown frames, and oversized pre-auth input", async () => {
		const fixture = await setup("raw-run");
		const connect = () => new Promise<net.Socket>((resolve, reject) => {
			const socket = net.createConnection({ path: fixture.server.socketPath }, () => resolve(socket));
			socket.once("error", reject);
		});
		const waitClosed = (socket: net.Socket, label: string) => new Promise<void>((resolve, reject) => {
			if (socket.destroyed) return resolve();
			const timeout = setTimeout(() => reject(new Error(`Timed out waiting for rejected ${label} socket to close.`)), 500);
			socket.once("close", () => { clearTimeout(timeout); resolve(); });
		});

		const wrong = await connect();
		const wrongClosed = waitClosed(wrong, "wrong-token");
		wrong.write(`${JSON.stringify({ version: 1, type: "hello", runId: fixture.runId, token: "x".repeat(43), childPid: process.pid, sequence: 0 })}\n`);
		await wrongClosed;
		assert.equal(fixture.server.isConnected(fixture.runId), false);

		const replay = await connect();
		// Consume the strict hello acknowledgement just as the real client does;
		// Bun 1.4.2 leaves a raw paused socket's close notification pending.
		replay.on("data", () => undefined);
		replay.write(`${JSON.stringify({ version: 1, type: "hello", runId: fixture.runId, token: fixture.token, childPid: process.pid, sequence: 0 })}\n`);
		for (let attempt = 0; attempt < 20 && !fixture.server.isConnected(fixture.runId); attempt += 1) await delay(5);
		const replayClosed = waitClosed(replay, "replayed-sequence");
		replay.write(`${JSON.stringify({ version: 1, type: "heartbeat", runId: fixture.runId, sequence: 1 })}\n`);
		replay.write(`${JSON.stringify({ version: 1, type: "heartbeat", runId: fixture.runId, sequence: 1 })}\n`);
		await replayClosed;

		const unknown = await connect();
		const unknownClosed = waitClosed(unknown, "unknown-frame");
		unknown.write("{\"version\":1,\"type\":\"unknown\"}\n");
		await unknownClosed;
		const oversized = await connect();
		const oversizedClosed = waitClosed(oversized, "oversized-pre-auth");
		oversized.write("x".repeat(4098));
		await oversizedClosed;
	});

	test("requires a strict server hello acknowledgement before exposing a client", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-lifecycle-rogue-")); roots.push(root);
		await fs.promises.chmod(root, 0o700);
		const socketPath = path.join(root, "events.sock"), tokenPath = path.join(root, "lifecycle-token"), statePath = path.join(root, "state.json");
		await fs.promises.writeFile(tokenPath, `${"a".repeat(43)}\n`, { mode: 0o600 });
		const rogue = net.createServer((socket) => socket.once("data", () => socket.end(`${JSON.stringify({ version: 1, type: "control", command: "abort", runId: "rogue-run", sequence: 1 })}\n`)));
		await new Promise<void>((resolve) => rogue.listen(socketPath, resolve));
		await fs.promises.chmod(socketPath, 0o600);
		try {
			assert.equal(await LifecycleEventClient.connectFromEnvironment({ PI_SUBAGENT_RUN_ID: "rogue-run", [SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: socketPath, [SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: tokenPath }, statePath), null);
		} finally { await new Promise<void>((resolve) => rogue.close(() => resolve())); }
	});

	test("fails closed for unsafe token artifacts and preserves no capability environment", async () => {
		const fixture = await setup("unsafe-run");
		await fs.promises.chmod(fixture.tokenPath, 0o644);
		assert.equal(await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath), null);
		assert.equal(process.env[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV], undefined);
		assert.equal(process.env[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV], undefined);
		assert.equal(fixture.server.isConnected(fixture.runId), false);
	});

	test("cleans startup artifacts after failures following the initial stat or server creation", async () => {
		await expectStartupFailureWithCleanup((originals, directory) => {
			let directoryStats = 0;
			return { lstat: async (file: string, ...args: any[]) => {
				if (file === directory() && ++directoryStats === 2) throw new Error("injected post-initial-stat failure");
				return originals.lstat(file, ...args);
			} };
		});
		await expectStartupFailureWithCleanup((originals) => ({
			createServer: (...args: any[]) => {
				const server = originals.createServer(...args);
				const on = server.on.bind(server);
				(server as any).on = (event: string, ...listenerArgs: any[]) => {
					if (event === "connection") throw new Error("injected post-createServer failure");
					return on(event, ...listenerArgs);
				};
				return server;
			},
		}));
	});

	test("cleans proven partial marker artifacts across write, stat, chmod, and listen failures", async () => {
		await expectStartupFailureWithCleanup((originals) => ({
			open: async (...args: any[]) => {
				const handle = await originals.open(...args);
				return new Proxy(handle, { get(target, property, receiver) {
					if (property === "writeFile") return async () => { throw new Error("injected marker write failure"); };
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				} });
			},
		}));
		await expectStartupFailureWithCleanup((originals) => ({
			open: async (...args: any[]) => {
				const handle = await originals.open(...args);
				let stats = 0;
				return new Proxy(handle, { get(target, property, receiver) {
					if (property === "stat") return async (...statArgs: any[]) => {
						if (++stats === 2) throw new Error("injected post-write stat failure");
						return target.stat(...statArgs);
					};
					const value = Reflect.get(target, property, receiver);
					return typeof value === "function" ? value.bind(target) : value;
				} });
			},
		}));
		await expectStartupFailureWithCleanup((originals) => ({
			chmod: async (file: string, ...args: any[]) => {
				if (file.endsWith("/generation")) throw new Error("injected marker chmod failure");
				return originals.chmod(file, ...args);
			},
		}));
		await expectStartupFailureWithCleanup((originals) => ({
			createServer: (...args: any[]) => {
				const server = originals.createServer(...args);
				(server as any).listen = () => { throw new Error("injected listen failure"); };
				return server;
			},
		}));
	});

	test("accepts Bun auto-unlink only after proving the pre-close socket generation", async () => {
		const server = await LifecycleEventServer.start();
		servers.push(server);
		const directory = server.directory;
		const socketPath = server.socketPath;
		await server.close();
		assert.equal(await fs.promises.lstat(socketPath).then(() => true, () => false), false);
		assert.equal(await fs.promises.lstat(directory).then(() => true, () => false), false);
	});

	test("rejects a replaced generation marker before it mutates the owned socket pathname", async () => {
		const server = await LifecycleEventServer.start();
		servers.push(server);
		const markerPath = (server as any).markerPath as string;
		const replacementPath = path.join(server.directory, ".generation-replacement");
		const generation = await fs.promises.readFile(markerPath, "utf8");
		try {
			const original = await fs.promises.lstat(markerPath);
			await fs.promises.writeFile(replacementPath, generation, { mode: 0o600, flag: "wx" });
			await fs.promises.chmod(replacementPath, 0o600);
			const replacement = await fs.promises.lstat(replacementPath);
			assert.notDeepEqual([replacement.dev, replacement.ino], [original.dev, original.ino]);
			await fs.promises.rename(replacementPath, markerPath);
			const installed = await fs.promises.lstat(markerPath);
			assert.deepEqual([installed.dev, installed.ino], [replacement.dev, replacement.ino]);
			await assert.rejects(server.close(), /cleanup authority changed/);
			assert.equal(await fs.promises.readFile(markerPath, "utf8"), generation);
		} finally {
			await fs.promises.rm(replacementPath, { force: true });
			await fs.promises.rm(server.directory, { recursive: true, force: true });
		}
	});

	test("documents the Bun close pathname race with a replacement before native close", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-lifecycle-native-")); roots.push(root);
		await fs.promises.chmod(root, 0o700);
		const socketPath = path.join(root, "events.sock");
		const native = net.createServer();
		await new Promise<void>((resolve) => native.listen(socketPath, resolve));
		fs.unlinkSync(socketPath);
		fs.writeFileSync(socketPath, "foreign", { mode: 0o600 });
		await new Promise<void>((resolve) => native.close(() => resolve()));
		assert.equal(await fs.promises.lstat(socketPath).then(() => true, () => false), false, "Bun server.close unlinks a pre-close replacement; LifecycleEventServer must fence replacements before it delegates to native close");
	});

	test("fences a path replacement before invoking the underlying close and retains the foreign occupant", async () => {
		const server = await LifecycleEventServer.start();
		servers.push(server);
		// Bun's native server.close() unlinks whatever currently occupies its
		// bound pathname. Replace it before LifecycleEventServer invokes close;
		// the implementation must quarantine and restore this foreign file.
		fs.unlinkSync(server.socketPath);
		fs.writeFileSync(server.socketPath, "replacement", { mode: 0o600 });
		try {
			await assert.rejects(server.close(), /cleanup authority changed/);
			assert.equal(await fs.promises.readFile(server.socketPath, "utf8"), "replacement");
		} finally {
			await fs.promises.rm(server.directory, { recursive: true, force: true });
		}
	});
});
