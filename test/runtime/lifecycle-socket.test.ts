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

	test("rejects wrong tokens, replayed sequences, unknown frames, and oversized pre-auth input", async () => {
		const fixture = await setup("raw-run");
		const connect = () => new Promise<net.Socket>((resolve, reject) => {
			const socket = net.createConnection({ path: fixture.server.socketPath }, () => resolve(socket));
			socket.once("error", reject);
		});
		const waitClosed = (socket: net.Socket) => new Promise<void>((resolve) => socket.destroyed ? resolve() : socket.once("close", () => resolve()));

		const wrong = await connect();
		wrong.write(`${JSON.stringify({ version: 1, type: "hello", runId: fixture.runId, token: "x".repeat(43), childPid: process.pid, sequence: 0 })}\n`);
		await waitClosed(wrong);
		assert.equal(fixture.server.isConnected(fixture.runId), false);

		const replay = await connect();
		replay.write(`${JSON.stringify({ version: 1, type: "hello", runId: fixture.runId, token: fixture.token, childPid: process.pid, sequence: 0 })}\n`);
		for (let attempt = 0; attempt < 20 && !fixture.server.isConnected(fixture.runId); attempt += 1) await delay(5);
		replay.write(`${JSON.stringify({ version: 1, type: "heartbeat", runId: fixture.runId, sequence: 1 })}\n`);
		replay.write(`${JSON.stringify({ version: 1, type: "heartbeat", runId: fixture.runId, sequence: 1 })}\n`);
		await waitClosed(replay);

		const unknown = await connect();
		unknown.write("{\"version\":1,\"type\":\"unknown\"}\n");
		await waitClosed(unknown);
		const oversized = await connect();
		oversized.write("x".repeat(4098));
		await waitClosed(oversized);
	});

	test("fails closed for unsafe token artifacts and preserves no capability environment", async () => {
		const fixture = await setup("unsafe-run");
		await fs.promises.chmod(fixture.tokenPath, 0o644);
		assert.equal(await LifecycleEventClient.connectFromEnvironment(process.env, fixture.statePath), null);
		assert.equal(process.env[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV], undefined);
		assert.equal(process.env[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV], undefined);
		assert.equal(fixture.server.isConnected(fixture.runId), false);
	});
});
