import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
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
		const generation = await fs.promises.readFile(markerPath, "utf8");
		fs.unlinkSync(markerPath);
		fs.writeFileSync(markerPath, generation, { mode: 0o600 });
		await assert.rejects(server.close(), /cleanup authority changed/);
		assert.equal(await fs.promises.readFile(markerPath, "utf8"), generation);
		await fs.promises.rm(server.directory, { recursive: true, force: true });
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
