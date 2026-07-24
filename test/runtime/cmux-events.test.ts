import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CmuxEventsClient, parseCmuxEventLine } from "../../src/runtime/cmux-events";
import { fakeCmuxControlServer, type FakeCmuxServer } from "../helpers/fake-cmux-control-server";

let root = ""; let server: FakeCmuxServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; if (root) await fs.rm(root, { recursive: true, force: true }); root = ""; });
async function setup(handler: Parameters<typeof fakeCmuxControlServer>[1]): Promise<string> { root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-events-test-")); await fs.chmod(root, 0o700); const socket = path.join(root, "cmux.sock"); server = await fakeCmuxControlServer(socket, handler); return socket; }
const subscription = "F3A4253C-ED38-4C21-A79C-73BE1CE1CA8C"; const bootId = "57FC920E-C1C9-414E-BAC7-E4334A8CF4C1";
const ack = (after: number | null = null, gap = false) => ({ type: "ack", protocol: "cmux-events", version: 1, boot_id: bootId, subscription_id: subscription, heartbeat_interval_seconds: 30, replay_count: gap ? 4 : 0, resume: gap ? { after_seq: after, requested_after_seq: after ?? 3, oldest_seq: 5, latest_seq: 8, next_seq: 9, gap: true, gap_reason: "fixture gap" } : { after_seq: after, requested_after_seq: after ?? 0, oldest_seq: 1, latest_seq: after ?? 0, next_seq: (after ?? 0) + 1, gap: false }, filters: { names: [], categories: [] } });
const handshake = (request: any, fake: FakeCmuxServer) => {
	if (request.method === "system.capabilities") { fake.send(request.socket, { id: request.id, ok: true, result: { version: 2, protocol: "cmux-socket", access_mode: "automation", methods: ["events.stream"] } }); return true; }
	if (request.method === "system.identify") { fake.send(request.socket, { id: request.id, ok: true, result: { app_bundle_path: "/Applications/cmux.app" } }); return true; }
	return false;
};
const event = (seq: number) => ({ type: "event", protocol: "cmux-events", version: 1, boot_id: bootId, seq, id: `${bootId}-${seq}`, name: "surface.changed", category: "surface", source: "cmux", occurred_at: "2026-07-20T00:00:00Z", workspace_id: null, surface_id: "0F61DF95-D7D5-44D4-B251-B2B44DF0CF8B", pane_id: null, window_id: null, payload: {} });

describe("cmux events", () => {
	test("parses the checked-in pinned upstream acknowledgement, event, heartbeat, and slow-consumer frames", async () => {
		const fixture = JSON.parse(await fs.readFile(path.join(process.cwd(), "test/fixtures/cmux-events-v1.json"), "utf8"));
		for (const key of ["ack", "event", "heartbeat", "slow_consumer"]) assert.doesNotThrow(() => parseCmuxEventLine(JSON.stringify(fixture[key])));
		assert.equal(fixture.stream_request.include_heartbeats, true);
		assert.equal(fixture.ack.resume.oldest_seq, 40610);
	});

	test("parses the pinned acknowledgement, event, heartbeat, and slow-consumer frames", () => {
		assert.equal(parseCmuxEventLine(JSON.stringify(ack())).kind, "ack");
		assert.deepEqual(parseCmuxEventLine(JSON.stringify(event(1))), { kind: "event", event: event(1) });
		assert.deepEqual(parseCmuxEventLine(JSON.stringify({ type: "heartbeat", protocol: "cmux-events", version: 1, boot_id: bootId, subscription_id: subscription, latest_seq: 1, occurred_at: "2026-07-20T00:00:01Z" })), { kind: "heartbeat", cursor: { boot_id: bootId, seq: 1 }, subscription_id: subscription });
		assert.deepEqual(parseCmuxEventLine('{"type":"error","ok":false,"error":{"code":"slow_consumer","message":"slow","latest_seq":9}}'), { kind: "error", code: "slow_consumer", message: "slow", latest_seq: 9 });
		const gapWithoutReason = ack(3, true); delete (gapWithoutReason.resume as { gap_reason?: string }).gap_reason;
		for (const line of ['{"type":"event","protocol":"cmux-events","version":1,"boot_id":"boot","seq":1,"id":"bad","name":"x","category":"x","source":"x","occurred_at":"x","payload":{}}', JSON.stringify({ ...event(1), seq: 0, id: `${bootId}-0` }), JSON.stringify({ ...ack(), resume: { ...ack().resume, gap_reason: "impossible" } }), JSON.stringify(gapWithoutReason), '{"type":"ack","cursor":{"boot_id":"b","seq":0}}', JSON.stringify({ ...ack(), heartbeat_interval_seconds: 3601 })]) assert.throws(() => parseCmuxEventLine(line));
	});
	test("uses a separate socket, sends no events.stream RPC response, and processes replay/live frames identically", async () => {
		const socket = await setup((request, fake) => {
			if (request.method === "auth.login") fake.send(request.socket, { id: request.id, ok: true, result: {} });
			else if (!handshake(request, fake) && request.method === "events.stream") { fake.send(request.socket, ack()); fake.send(request.socket, event(1)); fake.send(request.socket, event(2)); }
		});
		const events: number[] = []; const hints: string[] = [];
		const client = new CmuxEventsClient({ env: { CMUX_SOCKET_PATH: socket }, password: "memory-only", onEvent: (received) => events.push(received.seq), onReconcile: (hint) => hints.push(hint) });
		await client.start(); await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(server!.requests.map((request) => request.method), ["auth.login", "system.capabilities", "system.identify", "events.stream"]);
		assert.deepEqual(server!.requests[3]!.params, { names: [], categories: [], include_heartbeats: false }); assert.deepEqual(events, [1, 2]); assert.deepEqual(hints, []); assert.deepEqual(client.cursor, { boot_id: bootId, seq: 2 }); client.close();
	});
	test("rejects an event connection from a different socket generation", async () => {
		const socket = await setup(() => {});
		const stat = await fs.lstat(socket, { bigint: true });
		const client = new CmuxEventsClient({ env: { CMUX_SOCKET_PATH: socket }, expectedConnection: { socketPath: socket, socketDev: stat.dev.toString(), socketIno: (stat.ino + 1n).toString() } });
		await assert.rejects(client.start(), /generation differs/); client.close();
	});

	test("reconciles ack gaps, boot changes, reordering, and slow consumers without delivering unsafe events", async () => {
		const socket = await setup((request, fake) => {
			if (!handshake(request, fake) && request.method === "events.stream") { fake.send(request.socket, ack(3, true)); fake.send(request.socket, event(5)); fake.send(request.socket, { type: "error", code: "slow_consumer", message: "slow", latest_seq: 8 }); }
		});
		const events: number[] = []; const hints: string[] = [];
		const client = new CmuxEventsClient({ env: { CMUX_SOCKET_PATH: socket }, cursor: { boot_id: bootId, seq: 3 }, onEvent: (received) => events.push(received.seq), onReconcile: (hint) => hints.push(hint) });
		await client.start(); await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(events, []); assert.deepEqual(hints, ["gap"]); assert.equal(client.healthy, false); client.close();
	});
	test("uses the acknowledged heartbeat interval for one bounded unref timeout", async () => {
		const socket = await setup((request, fake) => {
			if (!handshake(request, fake) && request.method === "events.stream") fake.send(request.socket, ack());
		});
		let callback: (() => void) | undefined; const scheduled: number[] = []; let cleared = 0; let unrefed = 0; let disconnected = 0;
		const fakeTimer = { unref: () => { unrefed += 1; } } as unknown as ReturnType<typeof setTimeout>;
		const hints: string[] = [];
		const client = new CmuxEventsClient({
			env: { CMUX_SOCKET_PATH: socket }, includeHeartbeats: true,
			setHeartbeatTimer: (next, timeoutMs) => { callback = next; scheduled.push(timeoutMs); return fakeTimer; },
			clearHeartbeatTimer: () => { cleared += 1; },
			onReconcile: (hint) => hints.push(hint), onDisconnect: () => { disconnected += 1; },
		});
		await client.start();
		assert.deepEqual(scheduled, [60_000]); assert.equal(unrefed, 1);
		client.consume(JSON.stringify({ type: "heartbeat", protocol: "cmux-events", version: 1, boot_id: bootId, subscription_id: subscription, latest_seq: 0, occurred_at: "2026-07-20T00:00:01Z" }));
		assert.deepEqual(scheduled, [60_000, 60_000]); assert.equal(unrefed, 2); assert.equal(cleared, 1);
		callback?.(); callback?.();
		assert.deepEqual(hints, ["heartbeat_timeout"]); assert.equal(disconnected, 1); assert.equal(cleared, 2);
		client.close(); assert.equal(cleared, 2);
	});

	test("does not advance the delivered cursor from a heartbeat watermark", () => {
		const events: number[] = []; const hints: string[] = [];
		const client = new CmuxEventsClient({ includeHeartbeats: true, onEvent: (received) => events.push(received.seq), onReconcile: (hint) => hints.push(hint) });
		client.consume(JSON.stringify(ack()));
		client.consume(JSON.stringify({ type: "heartbeat", protocol: "cmux-events", version: 1, boot_id: bootId, subscription_id: subscription, latest_seq: 1, occurred_at: "2026-07-20T00:00:01Z" }));
		assert.deepEqual(client.cursor, { boot_id: bootId, seq: 0 });
		client.consume(JSON.stringify(event(1)));
		assert.deepEqual(events, [1]); assert.deepEqual(hints, []); assert.deepEqual(client.cursor, { boot_id: bootId, seq: 1 });
		client.close();
	});

	test("accepts increasing global sequence gaps for filtered subscriptions", () => {
		const events: number[] = [];
		const client = new CmuxEventsClient({ names: ["surface.changed"], onEvent: (received) => events.push(received.seq) });
		client.consume(JSON.stringify({ ...ack(), filters: { names: ["surface.changed"], categories: [] } }));
		client.consume(JSON.stringify(event(1))); client.consume(JSON.stringify(event(3)));
		assert.deepEqual(events, [1, 3]); assert.deepEqual(client.cursor, { boot_id: bootId, seq: 3 });
	});

	test("rejects acknowledgement fields that do not bind the request", () => {
		for (const changed of [
			{ ...ack(), filters: { names: ["other"], categories: [] } },
			{ ...ack(), resume: { ...ack().resume, requested_after_seq: 1 } },
			{ ...ack(), resume: { ...ack().resume, next_seq: 2 } },
			{ ...ack(), resume: { ...ack().resume, oldest_seq: 2, latest_seq: 1, next_seq: 2, requested_after_seq: 1 } },
		]) {
			const hints: string[] = []; const client = new CmuxEventsClient({ onReconcile: (hint) => hints.push(hint) });
			client.consume(JSON.stringify(changed)); assert.deepEqual(hints, ["malformed"]);
		}
	});

	test("rejects duplicate acknowledgements and truncated replay before heartbeat", () => {
		for (const replay_count of [3, 5]) {
			const hints: string[] = []; const gap = new CmuxEventsClient({ cursor: { boot_id: bootId, seq: 3 }, onReconcile: (hint) => hints.push(hint) });
			gap.consume(JSON.stringify({ ...ack(3, true), replay_count }));
			assert.deepEqual(hints, ["malformed"]);
		}
		const duplicateHints: string[] = []; const duplicate = new CmuxEventsClient({ onReconcile: (hint) => duplicateHints.push(hint) });
		duplicate.consume(JSON.stringify(ack())); duplicate.consume(JSON.stringify(ack()));
		assert.deepEqual(duplicateHints, ["malformed"]);

		const underreportedHints: string[] = []; const underreported = new CmuxEventsClient({ cursor: { boot_id: bootId, seq: 3 }, onReconcile: (hint) => underreportedHints.push(hint) });
		underreported.consume(JSON.stringify({ ...ack(3), replay_count: 1, resume: { ...ack(3).resume, latest_seq: 5, next_seq: 6 } }));
		assert.deepEqual(underreportedHints, ["malformed"]);

		const replayHints: string[] = []; const replay = new CmuxEventsClient({ cursor: { boot_id: bootId, seq: 3 }, onReconcile: (hint) => replayHints.push(hint) });
		const replayAck = { ...ack(3), replay_count: 2, resume: { ...ack(3).resume, latest_seq: 5, next_seq: 6 } };
		replay.consume(JSON.stringify(replayAck)); replay.consume(JSON.stringify(event(4)));
		replay.consume(JSON.stringify({ type: "heartbeat", protocol: "cmux-events", version: 1, boot_id: bootId, subscription_id: subscription, latest_seq: 5, occurred_at: "2026-07-20T00:00:01Z" }));
		assert.deepEqual(replayHints, ["malformed"]); assert.deepEqual(replay.cursor, { boot_id: bootId, seq: 4 });
	});

	test("keeps an in-memory monotonic boot/sequence cursor and reports reordering", () => {
		const events: string[] = []; const hints: string[] = []; const client = new CmuxEventsClient({ onEvent: (received) => events.push(received.name), onReconcile: (hint) => hints.push(hint) });
		client.consume(JSON.stringify(ack())); client.consume(JSON.stringify(event(1))); client.consume(JSON.stringify(event(1)));
		assert.deepEqual(events, ["surface.changed"]); assert.deepEqual(hints, ["reorder"]); assert.deepEqual(client.cursor, { boot_id: bootId, seq: 1 });
	});
});
