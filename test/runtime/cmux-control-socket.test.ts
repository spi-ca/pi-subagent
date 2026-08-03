import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CmuxControlSocketClient, CmuxUnknownOutcomeError, parseCmuxNdjsonLine, parseCmuxUuidResult } from "../../src/runtime/cmux-control-socket.mjs";
import { fakeCmuxControlServer, type FakeCmuxServer } from "../helpers/fake-cmux-control-server";

const roots: string[] = []; const servers: FakeCmuxServer[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.close(); while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true }); });
async function server(handler: Parameters<typeof fakeCmuxControlServer>[1]): Promise<{ socket: string; server: FakeCmuxServer }> { const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-control-test-")); roots.push(root); await fs.chmod(root, 0o700); const socket = path.join(root, "cmux.sock"); const fake = await fakeCmuxControlServer(socket, handler); servers.push(fake); return { socket, server: fake }; }
const capabilities = { version: 2, protocol: "cmux-socket", access_mode: "read-write", methods: ["system.tree", "surface.split", "surface.create", "surface.respawn", "surface.send_key", "surface.close", "tab.action"] };
const workspace = "2FF1CE1C-5160-461B-9412-A5630EA19054"; const pane = "ACDC865F-C84C-4C55-A88F-052B7E8DBDA3"; const surface = "0F61DF95-D7D5-44D4-B251-B2B44DF0CF8B";
const reply = (request: { id: number; socket: import("node:net").Socket }, fake: FakeCmuxServer, result: unknown) => fake.send(request.socket, { id: request.id, ok: true, result });

describe("cmux control socket", () => {
	test("uses the capability physical line for every request and completes auth/capabilities/identify", async () => {
		const fixture = await server((request, fake) => reply(request, fake, request.method === "system.capabilities" ? capabilities : request.method === "system.identify" ? { app_bundle_path: "/Applications/cmux.app" } : {}));
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket, CMUX_SOCKET_CAPABILITY: "ignored-ambient-token" }, capability: "cap-token", password: "memory-only" });
		await client.connect(); const handshake = await client.handshake({ identify: (identify) => identify.app_bundle_path === "/Applications/cmux.app", appVersionValidator: (identify) => identify.app_bundle_path === "/Applications/cmux.app" });
		assert.equal(handshake.version, 2); assert.deepEqual(fixture.server.requests.map((request) => request.method), ["auth.login", "system.capabilities", "system.identify"]);
		for (const request of fixture.server.requests) { assert.equal(request.capability, "cap-token"); assert.match(request.line, /^_cmux_capability_v1 cap-token \{"id":\d+,"method":/); }
		assert.equal(fixture.server.requests[0]!.params.password, "memory-only"); client.close();
	});
	test("rejects capability tokens with whitespace, newline, or NUL", () => {
		for (const capability of ["cap token", "cap\n", "cap\0token"]) assert.throws(() => new CmuxControlSocketClient({ capability }));
	});
	test("bounds a half-close between capabilities and identify", async () => {
		const fixture = await server((request, fake) => {
			if (request.method === "system.capabilities") reply(request, fake, capabilities);
			else request.socket.end();
		});
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket }, timeoutMs: 50 });
		await assert.rejects(() => Promise.race([
			client.handshake(),
			new Promise((_, reject) => setTimeout(() => reject(new Error("handshake hung")), 500)),
		]), (error: unknown) => { assert.doesNotMatch(String(error), /handshake hung/); return true; });
		client.close();
	});
	test("matches required methods while ignoring additive discovery fields from cmux 0.64.21+", async () => {
		const fixture = await server((request, fake) => reply(request, fake, request.method === "system.capabilities" ? { ...capabilities, capabilities: ["events.v1", "terminal.replay.v1"], future_metadata: { version: 1 } } : { app_bundle_path: "/Applications/cmux.app" }));
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket } });
		const handshake = await client.handshake({ appVersionValidator: () => true });
		assert.equal("capabilities" in handshake, false); assert.equal("future_metadata" in handshake, false); client.close();
	});
	test("requires the supported control methods as a subset", async () => {
		const fixture = await server((request, fake) => reply(request, fake, request.method === "system.capabilities" ? { ...capabilities, methods: capabilities.methods.filter((method) => method !== "surface.create"), future_method: true } : {}));
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket } });
		await assert.rejects(() => client.handshake(), /lacks required control methods/); client.close();
	});
	test("requires the v2 transport contract rather than an app semantic version", async () => {
		const fixture = await server((request, fake) => reply(request, fake, request.method === "system.capabilities" ? { ...capabilities, version: "0.64.20" } : {}));
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket } });
		await assert.rejects(() => client.handshake(), /capabilities handshake/); client.close();
	});
	test("rejects blank, CRLF, duplicate-key, oversized, and non-object NDJSON", () => {
		for (const line of ["", "{}\r", '{"id":1,"id":2}', '{"id":1,"\\u0069d":2}', "[]", "x".repeat(64 * 1024 + 1)]) assert.throws(() => parseCmuxNdjsonLine(line));
	});
	test("serializes requests and requires exact ok:true/ok:false envelopes", async () => {
		const fixture = await server((request, fake) => {
			if (request.method === "first") fake.send(request.socket, { id: request.id, ok: false, error: { code: "not_found", message: "missing", data: { target: "x" } } });
			else reply(request, fake, request.method);
		});
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket } });
		await assert.rejects(() => client.request("first"), (error: unknown) => { assert.equal((error as { code: string }).code, "not_found"); assert.deepEqual((error as { data: unknown }).data, { target: "x" }); return true; });
		assert.equal(await client.request("second"), "second"); client.close();
	});
	test("accepts queued responses only after their physical request is dispatched", async () => {
		const fixture = await server((request, fake) => reply(request, fake, request.method));
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket } });
		const first = client.request("first"); const second = client.request("second");
		assert.equal(await first, "first"); assert.equal(await second, "second");
		assert.deepEqual(fixture.server.requests.map((request) => request.method), ["first", "second"]); client.close();
	});
	test("fails the generation when a chunk includes a response before the next request is dispatched", async () => {
		const fixture = await server((request) => {
			if (request.method === "first") request.socket.write(`${JSON.stringify({ id: request.id, ok: true, result: "first" })}\n${JSON.stringify({ id: request.id + 1, ok: true, result: "forged-second" })}\n`);
		});
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket } });
		const first = client.request("first"); const second = client.request("second");
		assert.equal(await first, "first");
		await assert.rejects(() => second, (error: unknown) => (error as { code?: string }).code === "CMUX_ENVELOPE");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(fixture.server.requests.map((request) => request.method), ["first"]);
		await assert.rejects(() => client.request("third"), /generation is closed/); client.close();
	});
	test("does not dispatch after close races a pending connection", async () => {
		const fixture = await server(() => undefined); const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket } });
		const pending = client.request("never"); client.close();
		await assert.rejects(() => pending, /client closed/); await new Promise((resolve) => setImmediate(resolve));
		assert.equal(fixture.server.requests.length, 0);
	});
	test("bounds the serialized queue", async () => {
		const fixture = await server((request, fake) => setTimeout(() => reply(request, fake, {}), 10));
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket }, maxQueue: 1, timeoutMs: 100 });
		const first = client.tree(); const second = client.tree();
		await assert.rejects(() => client.tree(), /queue is full/); await Promise.all([first, second]); client.close();
	});
	test("detects a socket path rotation before issuing a request", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-rotation-test-")); roots.push(root); await fs.chmod(root, 0o700);
		const socket = path.join(root, "cmux.sock"); const fake = await fakeCmuxControlServer(socket, undefined, () => fsSync.unlinkSync(socket)); servers.push(fake);
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: socket } }); await assert.rejects(() => client.connect()); client.close();
	});
	test("fails the queued generation instead of reconnecting without a fresh handshake", async () => {
		const fixture = await server((request) => request.socket.destroy());
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket }, timeoutMs: 100 });
		const first = client.request("first"); const queued = client.request("second");
		await Promise.all([assert.rejects(() => first), assert.rejects(() => queued)]);
		await assert.rejects(() => client.request("third"), /generation is closed/);
		assert.equal(new Set(fixture.server.requests.map((request) => request.socket)).size, 1);
		client.close();
	});
	test("does not replay a mutation after flush timeout and reports unknown outcome", async () => {
		const fixture = await server(() => undefined); const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket }, timeoutMs: 10 });
		await assert.rejects(() => client.create({ workspace_id: workspace, pane_id: pane, working_directory: "/tmp" }), CmuxUnknownOutcomeError);
		await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal(fixture.server.requests.length, 1); client.close();
	});
	test("sends exact helper parameters and parses only canonical UUID result authority", async () => {
		const fixture = await server((request, fake) => {
			if (request.method === "tab.action") reply(request, fake, { action: "rename", title: "ok" });
			else if (request.method === "system.tree") reply(request, fake, {});
			else if (request.method === "surface.split" || request.method === "surface.create") reply(request, fake, { workspace_id: workspace, pane_id: pane, surface_id: surface });
			else reply(request, fake, { workspace_id: workspace, surface_id: surface });
		});
		const client = new CmuxControlSocketClient({ env: { CMUX_SOCKET_PATH: fixture.socket } });
		await client.tree(); await client.split({ workspace_id: workspace, surface_id: surface }); await client.create({ workspace_id: workspace, pane_id: pane, working_directory: "/tmp" }); await client.respawn({ workspace_id: workspace, surface_id: surface, command: "exec pi", tmux_start_command: "" + "exec pi" }); await client.sendKey({ workspace_id: workspace, surface_id: surface }); await client.closeSurface({ workspace_id: workspace, surface_id: surface }); await client.focusSurface({ surface_id: surface });
		assert.deepEqual(await client.tabAction({ action: "rename", title: "ok" }), { action: "rename", title: "ok" });
		assert.deepEqual(fixture.server.requests.map((request) => [request.method, request.params]), [
			["system.tree", { all_windows: true }], ["surface.split", { workspace_id: workspace, surface_id: surface, direction: "right", type: "terminal", focus: false }], ["surface.create", { workspace_id: workspace, pane_id: pane, type: "terminal", working_directory: "/tmp", focus: false }], ["surface.respawn", { workspace_id: workspace, surface_id: surface, command: "exec pi", tmux_start_command: "exec pi", focus: false }], ["surface.send_key", { workspace_id: workspace, surface_id: surface, key: "escape" }], ["surface.close", { workspace_id: workspace, surface_id: surface }], ["surface.focus", { surface_id: surface }], ["tab.action", { action: "rename", title: "ok" }],
		]);
		assert.throws(() => parseCmuxUuidResult({ workspace_id: "not-a-uuid" }, ["workspace_id"]));
		assert.deepEqual(parseCmuxUuidResult({ workspace_id: workspace, workspace_ref: "workspace:1" }, ["workspace_id"], { workspace_ref: (value: unknown) => typeof value === "string" }), { workspace_id: workspace });
		assert.throws(() => parseCmuxUuidResult({ workspace_id: workspace, unexpected: surface }, ["workspace_id"])); client.close();
	});
});
