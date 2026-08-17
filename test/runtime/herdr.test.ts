import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseHerdrEnvironment as parseSharedHerdrEnvironment } from "../../src/core/herdr-environment";
import {
	HerdrSocketClient,
	HerdrUnknownOutcomeError,
	classifyHerdrTerminal,
	closeHerdrPane,
	createChildHerdrMetadataReporter,
	createHerdrSplit,
	createHerdrTab,
	focusHerdrPane,
	inspectHerdrPane,
	inspectHerdrPaneForUx,
	interruptHerdrPane,
	isHerdrPublicId,
	observeHerdrAgentWait,
	parseHerdrEnvironment,
	shellQuoteHerdrWrapper,
	subscribeHerdrPane,
} from "../../src/runtime/herdr";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function serverFor(handler: (request: Record<string, unknown>, socket: net.Socket) => void): Promise<{ socketPath: string; close(): Promise<void> }> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-herdr-"));
	roots.push(root);
	const socketPath = path.join(root, "herdr.sock");
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket); socket.once("close", () => sockets.delete(socket));
		let input = "";
		socket.on("data", (chunk) => {
			input += chunk.toString("utf8");
			const line = input.indexOf("\n");
			if (line < 0) return;
			handler(JSON.parse(input.slice(0, line)) as Record<string, unknown>, socket);
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	fs.chmodSync(socketPath, 0o600);
	return { socketPath, close: async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	} };
}

const sourcePane = { workspace_id: "space one", tab_id: "tab/one", pane_id: "pane one", terminal_id: "term-one" };
const socketGeneration = (socketPath: string) => { const stat = fs.lstatSync(socketPath, { bigint: true }); return { socketDev: stat.dev.toString(), socketIno: stat.ino.toString() }; };

describe("Herdr socket client", () => {
	test("keeps public ids opaque but bounded and non-control", () => {
		assert.equal(isHerdrPublicId("w1:p1"), true);
		assert.equal(isHerdrPublicId("a\n"), false);
		assert.equal(isHerdrPublicId("x".repeat(257)), false);
		assert.equal(isHerdrPublicId("😀".repeat(65)), false);
		assert.equal(parseHerdrEnvironment, parseSharedHerdrEnvironment);
		assert.deepEqual(parseHerdrEnvironment({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "space one", HERDR_TAB_ID: "tab/one", HERDR_PANE_ID: "pane one" }), {
			socketPath: "/tmp/herdr.sock", workspaceId: "space one", tabId: "tab/one", paneId: "pane one",
		});
		for (const socketPath of ["relative", "/tmp//herdr.sock", `/${"é".repeat(52)}`]) {
			assert.equal(parseHerdrEnvironment({ HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t", HERDR_PANE_ID: "p" }), null);
		}
		for (const env of [
			{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "😀".repeat(65), HERDR_TAB_ID: "t", HERDR_PANE_ID: "p" },
			{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "😀".repeat(65), HERDR_PANE_ID: "p" },
			{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "w", HERDR_TAB_ID: "t", HERDR_PANE_ID: "😀".repeat(65) },
		]) assert.equal(parseHerdrEnvironment(env), null);
	});

	test("requires the exact response id and surfaces server errors", async () => {
		const fixture = await serverFor((request, socket) => socket.end(`${JSON.stringify({ id: request.id, error: { code: "not_found", message: "missing" } })}\n`));
		await assert.rejects(new HerdrSocketClient(fixture.socketPath).request("pane.get", { pane_id: "p" }), /missing/);
		await fixture.close();
	});

	test("publishes before exactly one shell-quoted pane.send_text launch", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const fixture = await serverFor((request, socket) => {
			calls.push({ method: request.method as string, params: request.params as Record<string, unknown> });
			const pane = request.method === "pane.get"
				? (request.params as { pane_id: string }).pane_id === "new pane" ? { ...sourcePane, pane_id: "new pane", terminal_id: "new-term" } : sourcePane
				: request.method === "pane.split" ? { ...sourcePane, pane_id: "new pane", terminal_id: "new-term" } : undefined;
			const result = request.method === "ping" ? { type: "pong", protocol: 20 } : pane ? { type: "pane_info", pane } : { type: "ok" };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		let published = false;
		const handle = await createHerdrSplit({
			cwd: "/tmp", wrapperPath: "/tmp/wrapper's.sh", env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_WORKSPACE_ID: "space one", HERDR_TAB_ID: "tab/one", HERDR_PANE_ID: "pane one" },
			onAllocated: async () => { published = true; },
		});
		assert.equal(handle.paneId, "new pane");
		assert.equal(published, true);
		assert.deepEqual(calls.map((call) => call.method), ["ping", "pane.get", "ping", "pane.get", "pane.split", "ping", "pane.get", "pane.send_text"]);
		assert.equal(calls[7]!.params.text, `exec ${shellQuoteHerdrWrapper("/tmp/wrapper's.sh")}\n`);
		assert.equal("right_click" in calls[4]!.params, false, "the protocol-20-only split field is never sent");
		await fixture.close();
	});

	test("creates one unfocused protocol-19/20 child tab through one direct layout.apply", async () => {
		for (const protocol of [19, 20] as const) {
			const child = { ...sourcePane, tab_id: `child-tab-${protocol}`, pane_id: `child-pane-${protocol}`, terminal_id: `child-terminal-${protocol}` };
			const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
			const fixture = await serverFor((request, socket) => {
				calls.push({ method: request.method as string, params: request.params as Record<string, unknown> });
				const pane = request.method === "pane.get" ? (request.params as { pane_id: string }).pane_id === child.pane_id ? child : sourcePane : undefined;
				const layout = request.params as { root?: { command?: unknown; cwd?: unknown; env?: unknown } };
				const result = request.method === "ping" ? { type: "pong", protocol }
					: request.method === "layout.apply" ? { type: "layout_apply", layout: { workspace_id: child.workspace_id, tab_id: child.tab_id, focused_pane_id: child.pane_id, root: { type: "pane", pane_id: child.pane_id, command: layout.root?.command, cwd: layout.root?.cwd, env: layout.root?.env } } }
					: pane ? { type: "pane_info", pane } : { type: "ok" };
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
			});
			const handle = await createHerdrTab({ cwd: "/workspace/task", wrapperPath: "/tmp/private/wrapper.sh", env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_WORKSPACE_ID: sourcePane.workspace_id, HERDR_TAB_ID: sourcePane.tab_id, HERDR_PANE_ID: sourcePane.pane_id, BASH_ENV: "/hostile/bashrc", NODE_OPTIONS: "--require /hostile.js", LD_PRELOAD: "/hostile.so" } });
			assert.equal(handle.allocatedTabId, child.tab_id);
			assert.deepEqual(calls.find((call) => call.method === "layout.apply")?.params, { workspace_id: sourcePane.workspace_id, focus: false, tab_label: "pi-subagent:direct:wrapper.sh", root: { type: "pane", cwd: path.parse("/tmp/private/wrapper.sh").root, command: ["/tmp/private/wrapper.sh"], env: { BASH_ENV: "", ENV: "", NODE_OPTIONS: "", NODE_PATH: "", BUN_OPTIONS: "", LD_PRELOAD: "", LD_LIBRARY_PATH: "", LD_AUDIT: "", DYLD_INSERT_LIBRARIES: "", DYLD_LIBRARY_PATH: "", DYLD_FRAMEWORK_PATH: "" } } });
			assert.equal(calls.some((call) => call.method === "pane.send_text" || call.method === "pane.close" || call.method === "pane.send_keys"), false);
			await fixture.close();
		}
	});

	test("suppresses automatic interrupt and close after an auto child moves outside its allocated tab, while preserving focus", async () => {
		const moved = { ...sourcePane, tab_id: "user-tab", pane_id: "moved-child", terminal_id: "child-terminal" };
		const calls: string[] = [];
		const fixture = await serverFor((request, socket) => {
			calls.push(request.method as string);
			const result = request.method === "ping" ? { type: "pong", protocol: 20 } : request.method === "pane.get" ? { type: "pane_info", pane: moved }
				: request.method === "agent.get" || request.method === "agent.focus" ? { type: "agent_info", agent: { ...moved, agent_status: "idle", focused: request.method === "agent.focus", revision: 1, state_change_seq: 1 } }
				: { type: "pane_list", panes: [moved] };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: "child-tab", paneId: "child-pane", terminalId: moved.terminal_id, allocatedTabId: "child-tab", protocol: 20 as const };
		assert.equal(await interruptHerdrPane(handle), false);
		assert.equal(await closeHerdrPane(handle), false);
		assert.equal(await focusHerdrPane(handle), true, "manual focus remains available after ownership transfer");
		assert.equal(calls.includes("pane.send_keys"), false);
		assert.equal(calls.includes("pane.close"), false);
		assert.equal(calls.includes("agent.focus"), true);
		assert.equal(calls.includes("pane.focus"), false);
		await fixture.close();
	});

	test("rejects a split response that reuses the immutable source pane id", async () => {
		const calls: string[] = [];
		const fixture = await serverFor((request, socket) => {
			calls.push(request.method as string);
			const pane = request.method === "pane.split" ? { ...sourcePane, terminal_id: "new-terminal" } : sourcePane;
			const result = request.method === "ping" ? { type: "pong", protocol: 20 } : { type: "pane_info", pane };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		await assert.rejects(createHerdrSplit({ cwd: "/tmp", wrapperPath: "/tmp/wrapper.sh", env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_WORKSPACE_ID: sourcePane.workspace_id, HERDR_TAB_ID: sourcePane.tab_id, HERDR_PANE_ID: sourcePane.pane_id } }), HerdrUnknownOutcomeError);
		assert.equal(calls.includes("pane.send_text"), false);
		await fixture.close();
	});

	test("negotiates protocol 19 and pins it through allocation", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const fixture = await serverFor((request, socket) => {
			calls.push({ method: request.method as string, params: request.params as Record<string, unknown> });
			const pane = request.method === "pane.get"
				? (request.params as { pane_id: string }).pane_id === "new pane" ? { ...sourcePane, pane_id: "new pane", terminal_id: "new-term" } : sourcePane
				: request.method === "pane.split" ? { ...sourcePane, pane_id: "new pane", terminal_id: "new-term" } : undefined;
			const result = request.method === "ping" ? { type: "pong", protocol: 19 } : pane ? { type: "pane_info", pane } : { type: "ok" };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		const handle = await createHerdrSplit({ cwd: "/tmp", wrapperPath: "/tmp/wrapper.sh", env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_WORKSPACE_ID: sourcePane.workspace_id, HERDR_TAB_ID: sourcePane.tab_id, HERDR_PANE_ID: sourcePane.pane_id } });
		assert.equal(handle.protocol, 19);
		assert.equal("right_click" in calls.find((call) => call.method === "pane.split")!.params, false);
		await fixture.close();
	});

	test("rejects a negotiated protocol mismatch before split mutation", async () => {
		let pings = 0; const calls: string[] = [];
		const fixture = await serverFor((request, socket) => {
			calls.push(request.method as string);
			const result = request.method === "ping" ? { type: "pong", protocol: ++pings === 1 ? 19 : 20 } : { type: "pane_info", pane: sourcePane };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		await assert.rejects(createHerdrSplit({ cwd: "/tmp", wrapperPath: "/tmp/wrapper.sh", env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_WORKSPACE_ID: sourcePane.workspace_id, HERDR_TAB_ID: sourcePane.tab_id, HERDR_PANE_ID: sourcePane.pane_id } }), /protocol changed/);
		assert.equal(calls.includes("pane.split"), false);
		await fixture.close();
	});

	test("rejects every wrong response discriminator, never treating it as query or mutation success", async () => {
		const cases: Array<[string, boolean]> = [
			["ping", false], ["pane.get", false], ["pane.list", false], ["agent.get", false], ["agent.wait", false], ["pane.split", true], ["pane.focus", true], ["agent.focus", true],
			["pane.send_text", true], ["pane.send_keys", true], ["pane.close", true], ["pane.report_metadata", true], ["layout.apply", true],
		];
		for (const [method, mutation] of cases) {
			const fixture = await serverFor((request, socket) => socket.end(`${JSON.stringify({ id: request.id, result: { type: "wrong" } })}\n`));
			await assert.rejects(new HerdrSocketClient(fixture.socketPath).request(method, {}, { mutation }), (error: unknown) => mutation ? error instanceof HerdrUnknownOutcomeError : error instanceof Error && error.name === "HerdrProtocolError");
			await fixture.close();
		}
	});

	test("reports bounded child metadata with exact protocol-19/20 params and source-scoped clear", async () => {
		for (const protocol of [19, 20] as const) {
			const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
			const fixture = await serverFor((request, socket) => {
				calls.push({ method: request.method as string, params: request.params as Record<string, unknown> });
				const result = request.method === "ping" ? { type: "pong", protocol }
					: request.method === "pane.get" ? { type: "pane_info", pane: sourcePane } : { type: "ok" };
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
			});
			const reporter = createChildHerdrMetadataReporter({ handle: { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol }, runId: "run-123", title: "Worker" });
			assert.ok(reporter);
			reporter!.report("ready");
			await reporter!.close();
			const metadata = calls.filter((call) => call.method === "pane.report_metadata");
			assert.deepEqual(metadata.map((call) => call.params), [
				{ pane_id: sourcePane.pane_id, source: "pi-subagent:run-123", applies_to_source: "herdr:pi", agent: "pi", seq: 1, ttl_ms: 120000, title: "Worker", display_agent: "Pi", state_labels: { idle: "Ready", working: "Running", blocked: "Waiting", unknown: "Finished" }, tokens: { run: "run-123", lifecycle: "ready" } },
				{ pane_id: sourcePane.pane_id, source: "pi-subagent:run-123", applies_to_source: "herdr:pi", agent: "pi", seq: 2, ttl_ms: 120000, clear_title: true, clear_display_agent: true, clear_state_labels: true, tokens: { run: null, lifecycle: null } },
			]);
			await fixture.close();
		}
	});

	test("coalesces child metadata latest-write-wins and omits unsafe titles", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		let releaseFirst!: () => void;
		const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const fixture = await serverFor((request, socket) => {
			calls.push({ method: request.method as string, params: request.params as Record<string, unknown> });
			if (request.method === "pane.report_metadata" && calls.filter((call) => call.method === "pane.report_metadata").length === 1) {
				void firstHeld.then(() => socket.end(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`));
				return;
			}
			const result = request.method === "ping" ? { type: "pong", protocol: 20 } : request.method === "pane.get" ? { type: "pane_info", pane: sourcePane } : { type: "ok" };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const reporter = createChildHerdrMetadataReporter({ handle, runId: "run-123", title: "bad\u202etitle" });
		assert.ok(reporter);
		reporter!.report("ready"); reporter!.report("running"); reporter!.report("waiting");
		while (calls.filter((call) => call.method === "pane.report_metadata").length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
		releaseFirst();
		for (let attempt = 0; attempt < 30 && calls.filter((call) => call.method === "pane.report_metadata").length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
		const metadata = calls.filter((call) => call.method === "pane.report_metadata");
		assert.equal(metadata.length, 2);
		assert.equal(metadata[0]!.params.title, undefined);
		assert.equal((metadata[1]!.params.tokens as { lifecycle: string }).lifecycle, "waiting");
		assert.deepEqual(metadata.map((call) => call.params.seq), [1, 3]);
		await reporter!.close();
		await fixture.close();
	});

	test("isolates failed child metadata writes without retrying their sequence", async () => {
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		let metadataAttempts = 0;
		const fixture = await serverFor((request, socket) => {
			calls.push({ method: request.method as string, params: request.params as Record<string, unknown> });
			if (request.method === "pane.report_metadata" && ++metadataAttempts === 1) return socket.end(`${JSON.stringify({ id: request.id, result: { type: "wrong" } })}\n`);
			const result = request.method === "ping" ? { type: "pong", protocol: 20 } : request.method === "pane.get" ? { type: "pane_info", pane: sourcePane } : { type: "ok" };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		const reporter = createChildHerdrMetadataReporter({ handle: { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 }, runId: "run-123" });
		assert.ok(reporter);
		reporter!.report("ready");
		while (metadataAttempts < 1) await new Promise((resolve) => setTimeout(resolve, 1));
		reporter!.report("running");
		for (let attempt = 0; attempt < 30 && metadataAttempts < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
		assert.equal(metadataAttempts, 2);
		assert.deepEqual(calls.filter((call) => call.method === "pane.report_metadata").map((call) => call.params.seq), [1, 2]);
		await reporter!.close();
		await fixture.close();
	});

	test("bounds metadata close by aborting blackholed work without post-deadline requests", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-herdr-blackhole-"));
		roots.push(root);
		const socketPath = path.join(root, "herdr.sock");
		const calls: string[] = [], sockets = new Set<net.Socket>();
		const server = net.createServer((socket) => {
			sockets.add(socket); socket.once("close", () => sockets.delete(socket));
			socket.once("data", (chunk) => {
				const request = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
				calls.push(request.method as string);
				const result = request.method === "ping" ? { type: "pong", protocol: 20 }
					: request.method === "pane.get" ? { type: "pane_info", pane: sourcePane } : null;
				if (result) socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
				// pane.report_metadata deliberately blackholes after dispatch.
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve)); fs.chmodSync(socketPath, 0o600);
		const reporter = createChildHerdrMetadataReporter({ handle: { socketPath, ...socketGeneration(socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 }, runId: "run-123" });
		assert.ok(reporter); reporter!.report("running");
		for (let attempt = 0; attempt < 100 && !calls.includes("pane.report_metadata"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
		assert.equal(calls.filter((method) => method === "pane.report_metadata").length, 1);
		const started = Date.now(); await reporter!.close();
		assert.ok(Date.now() - started < 400, "close uses an unref'd 250ms absolute deadline");
		reporter!.report("failed"); await new Promise((resolve) => setTimeout(resolve, 40));
		assert.equal(calls.filter((method) => method === "pane.report_metadata").length, 1, "no request starts after close/deadline");
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	test("enforces the absolute metadata close deadline when a prior write settles before its timer runs", async () => {
		const calls: string[] = [];
		let releaseFirst!: () => void;
		const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const fixture = await serverFor((request, socket) => {
			calls.push(request.method as string);
			if (request.method === "pane.report_metadata" && calls.filter((method) => method === "pane.report_metadata").length === 1) {
				void firstHeld.then(() => socket.end(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`));
				return;
			}
			const result = request.method === "ping" ? { type: "pong", protocol: 20 }
				: request.method === "pane.get" ? { type: "pane_info", pane: sourcePane } : { type: "ok" };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const reporter = createChildHerdrMetadataReporter({ handle, runId: "run-123" });
		assert.ok(reporter);
		reporter!.report("running");
		while (calls.filter((method) => method === "pane.report_metadata").length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
		const now = Object.getOwnPropertyDescriptor(performance, "now")!;
		try {
			const closing = reporter!.close();
			Object.defineProperty(performance, "now", { ...now, value: () => (now.value as () => number)() + 251 });
			releaseFirst();
			await closing;
			assert.equal(calls.filter((method) => method === "pane.report_metadata").length, 1, "the queued clear cannot start after the monotonic deadline");
		} finally {
			Object.defineProperty(performance, "now", now);
			await fixture.close();
		}
	});

	test("does not create child metadata reporters for unsafe source identifiers", () => {
		const handle = { socketPath: "/tmp/unused", socketDev: "1", socketIno: "1", workspaceId: "w", tabId: "t", paneId: "p", terminalId: "term", protocol: 20 as const };
		assert.equal(createChildHerdrMetadataReporter({ handle, runId: "bad/run" }), null);
		assert.equal(createChildHerdrMetadataReporter({ handle, runId: "x".repeat(70) }), null);
	});

	test("does not acknowledge an events subscription with a wrong discriminator", async () => {
		let reconciled = 0;
		const fixture = await serverFor((request, socket) => socket.write(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`));
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const subscription = subscribeHerdrPane({ handle, reconnectDelayMs: 100, onReconcile: () => { reconciled += 1; } });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(subscription.isHealthy(), false);
		assert.equal(reconciled, 0);
		subscription.stop(); await subscription.closed; await fixture.close();
	});

	test("marks a post-dispatch timeout as an unknown mutating outcome", async () => {
		const fixture = await serverFor(() => { /* leave the request unanswered */ });
		const client = new HerdrSocketClient(fixture.socketPath, 20);
		await assert.rejects(client.request("pane.send_text", { pane_id: "p", text: "x" }, { mutation: true }), (error: unknown) => error instanceof HerdrUnknownOutcomeError && error.method === "pane.send_text");
		await fixture.close();
	});

	test("treats malformed, oversized, and wrong-ID split/send responses as typed unknown outcomes", async () => {
		const failures = [
			["malformed", (_request: Record<string, unknown>) => "{not-json}\n"],
			["oversized", (_request: Record<string, unknown>) => "x".repeat(256 * 1024 + 1)],
			["wrong-id", (_request: Record<string, unknown>) => `${JSON.stringify({ id: "wrong", result: { type: "ok" } })}\n`],
		] as const;
		for (const method of ["pane.split", "pane.send_text"] as const) {
			for (const [_kind, responseFor] of failures) {
				const calls: string[] = [];
				const fixture = await serverFor((request, socket) => {
					calls.push(request.method as string);
					if (request.method === method) return socket.end(responseFor(request));
					const pane = request.method === "pane.get"
						? (request.params as { pane_id: string }).pane_id === "new pane" ? { ...sourcePane, pane_id: "new pane", terminal_id: "new-term" } : sourcePane
						: request.method === "pane.split" ? { ...sourcePane, pane_id: "new pane", terminal_id: "new-term" } : undefined;
					const result = request.method === "ping" ? { type: "pong", protocol: 20 } : pane ? { type: "pane_info", pane } : { type: "ok" };
					socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
				});
				await assert.rejects(createHerdrSplit({
					cwd: "/tmp", wrapperPath: "/tmp/wrapper.sh",
					env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_WORKSPACE_ID: sourcePane.workspace_id, HERDR_TAB_ID: sourcePane.tab_id, HERDR_PANE_ID: sourcePane.pane_id },
				}), (error: unknown) => error instanceof HerdrUnknownOutcomeError && error.method === method);
				assert.equal(calls.includes("pane.close"), false, `${method} ${_kind} must never trigger rollback`);
				await fixture.close();
			}
		}
	});

	test("reads the exact bounded managed Unicode title only as diagnostic UX comparison data", async () => {
		const title = "worker [depth=1;run=title] · running";
		const fixture = await serverFor((request, socket) => {
			const pane = { ...sourcePane, terminal_title_stripped: title, terminal_title: "ignored" };
			socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane } })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		assert.deepEqual(await inspectHerdrPaneForUx(handle), { exists: true, title });
		await fixture.close();
	});

	test("rejects unsafe, malformed, and oversized Herdr diagnostic titles", async () => {
		for (const title of ["bad\u0000title", "bad\u0085title", "bad\u001btitle", "bad\u202etitle", "bad\ud800title", "x".repeat(513)]) {
			const fixture = await serverFor((request, socket) => {
				const pane = { ...sourcePane, terminal_title_stripped: title, terminal_title: title };
				socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane } })}\n`);
			});
			const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
			assert.deepEqual(await inspectHerdrPaneForUx(handle), { exists: true, title: undefined });
			await fixture.close();
		}
	});

	test("uses strict protocol-19/20 AgentInfo reads and agent.focus without pane.focus fallback", async () => {
		for (const protocol of [19, 20] as const) {
			const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
			const agent = { ...sourcePane, agent_status: "working", focused: false, revision: 4, state_change_seq: 9 };
			const fixture = await serverFor((request, socket) => {
				calls.push({ method: request.method as string, params: request.params as Record<string, unknown> });
				const result = request.method === "ping" ? { type: "pong", protocol }
					: request.method === "pane.get" ? { type: "pane_info", pane: sourcePane }
					: request.method === "agent.get" || request.method === "agent.focus" ? { type: "agent_info", agent: { ...agent, focused: request.method === "agent.focus" } }
					: { type: "pane_list", panes: [sourcePane] };
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
			});
			assert.equal(await focusHerdrPane({ socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol }), true);
			assert.deepEqual(calls.map((call) => call.method), ["ping", "pane.get", "agent.get", "agent.focus", "pane.get"]);
			assert.deepEqual(calls.find((call) => call.method === "agent.get")?.params, { target: sourcePane.pane_id });
			assert.deepEqual(calls.find((call) => call.method === "agent.focus")?.params, { target: sourcePane.pane_id });
			assert.equal(calls.some((call) => call.method === "pane.focus"), false);
			await fixture.close();
		}
	});

	test("requires agent.focus to confirm focused true without retries", async () => {
		const calls: string[] = [];
		const agent = { ...sourcePane, agent_status: "idle", focused: false, revision: 1, state_change_seq: 1 };
		const fixture = await serverFor((request, socket) => {
			calls.push(request.method as string);
			const result = request.method === "ping" ? { type: "pong", protocol: 20 }
				: request.method === "pane.get" ? { type: "pane_info", pane: sourcePane }
				: request.method === "agent.get" ? { type: "agent_info", agent }
				: { type: "agent_info", agent };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		assert.equal(await focusHerdrPane({ socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 }), false);
		assert.deepEqual(calls, ["ping", "pane.get", "agent.get", "agent.focus"]);
		await fixture.close();
	});

	test("accepts omitted protocol-19 state_change_seq as its schema default", async () => {
		const fixture = await serverFor((request, socket) => socket.end(`${JSON.stringify({ id: request.id, result: { type: "agent_info", agent: { ...sourcePane, agent_status: "idle", focused: false, revision: 1 } } })}\n`));
		assert.equal((await new HerdrSocketClient(fixture.socketPath).getAgent(sourcePane.pane_id))?.stateChangeSeq, 0);
		await fixture.close();
	});

	test("rejects malformed AgentInfo authority fields", async () => {
		for (const agent of [
			{ ...sourcePane, agent_status: "other", focused: false, revision: 1, state_change_seq: 1 },
			{ ...sourcePane, agent_status: "idle", focused: "true", revision: 1, state_change_seq: 1 },
			{ ...sourcePane, agent_status: "idle", focused: false, revision: -1, state_change_seq: 1 },
			{ ...sourcePane, agent_status: "idle", focused: false, revision: 1, state_change_seq: Number.MAX_SAFE_INTEGER + 1 },
			{ ...sourcePane, agent_status: "idle", focused: false, revision: 1, state_change_seq: "not-a-number" },
		]) {
			const fixture = await serverFor((request, socket) => socket.end(`${JSON.stringify({ id: request.id, result: { type: "agent_info", agent } })}\n`));
			assert.equal(await new HerdrSocketClient(fixture.socketPath).getAgent(sourcePane.pane_id), undefined);
			await fixture.close();
		}
	});

	test("agent wait is abort-aware, closes promptly, and never wakes after stop", async () => {
		for (const protocol of [19, 20] as const) {
			const calls: string[] = [];
			let waitParams: Record<string, unknown> | undefined;
			const agent = { ...sourcePane, agent_status: "working", focused: false, revision: 1, state_change_seq: 1 };
			const fixture = await serverFor((request, socket) => {
				calls.push(request.method as string);
				if (request.method === "agent.wait") { waitParams = request.params as Record<string, unknown>; return; }
				const result = request.method === "pane.get" ? { type: "pane_info", pane: sourcePane } : { type: "agent_info", agent };
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
			});
			const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol };
			let wakes = 0;
			const observer = observeHerdrAgentWait({ handle, onWake: () => { wakes += 1; }, serverTimeoutMs: 20, clientTimeoutMs: 30, retryDelayMs: 100 });
			for (let attempt = 0; attempt < 40 && !waitParams; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
			const started = Date.now(); observer.stop(); await observer.closed;
			assert.ok(Date.now() - started < 100, "stop aborts the active wait rather than waiting for its timeout");
			const stoppedWakes = wakes; await new Promise((resolve) => setTimeout(resolve, 40));
			assert.equal(wakes, stoppedWakes);
			assert.deepEqual(waitParams, { target: sourcePane.pane_id, until: ["idle", "blocked", "done", "unknown"], timeout_ms: 20 });
			assert.equal(calls.includes("pane.focus"), false);
			assert.equal(calls.includes("agent.focus"), false);
			assert.ok(calls.includes("agent.wait"));
			await fixture.close();
		}
	});

	test("rate-limits immediate agent_not_running wait errors", async () => {
		let waits = 0;
		const fixture = await serverFor((request, socket) => {
			if (request.method === "pane.get") return socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane: sourcePane } })}\n`);
			if (request.method === "agent.get") return socket.end(`${JSON.stringify({ id: request.id, result: { type: "agent_info", agent: { ...sourcePane, agent_status: "working", focused: false, revision: 1, state_change_seq: 1 } } })}\n`);
			waits += 1;
			socket.end(`${JSON.stringify({ id: request.id, error: { code: "agent_not_running", message: "stopped" } })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const observer = observeHerdrAgentWait({ handle, onWake: () => undefined, serverTimeoutMs: 20, clientTimeoutMs: 30, retryDelayMs: 100 });
		await new Promise((resolve) => setTimeout(resolve, 180));
		observer.stop(); await observer.closed;
		assert.ok(waits >= 1 && waits <= 2, `expected no immediate hot loop, got ${waits} waits`);
		await fixture.close();
	});

	test("caps agent wait observers process-wide without queueing a seventeenth", async () => {
		const fixture = await serverFor((request, socket) => {
			if (request.method === "pane.get") socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane: sourcePane } })}\n`);
			else if (request.method === "agent.get") socket.end(`${JSON.stringify({ id: request.id, result: { type: "agent_info", agent: { ...sourcePane, agent_status: "working", focused: false, revision: 1, state_change_seq: 1 } } })}\n`);
			// agent.wait deliberately remains pending until observer stop aborts it.
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const observers = Array.from({ length: 17 }, () => observeHerdrAgentWait({ handle: { ...handle }, onWake: () => undefined, serverTimeoutMs: 20, clientTimeoutMs: 30 }));
		assert.equal(observers.filter((observer) => observer.isActive()).length, 16);
		for (const observer of observers) observer.stop();
		await Promise.all(observers.map((observer) => observer.closed));
		await fixture.close();
	});

	test("does not continue from an aborted pane.get to pane.list", async () => {
		const calls: string[] = [];
		const controller = new AbortController();
		const fixture = await serverFor((request, socket) => {
			calls.push(request.method as string);
			if (request.method === "pane.get") {
				socket.end(`${JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: "moved" } })}\n`);
				controller.abort();
			}
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		assert.deepEqual(await classifyHerdrTerminal(handle, controller.signal), { state: "unknown" });
		assert.deepEqual(calls, ["pane.get"]);
		await fixture.close();
	});

	test("falls back to one bounded all-workspaces list and rebinds protocol 19/20 moved panes", async () => {
		for (const protocol of [19, 20] as const) {
			const moved = { ...sourcePane, workspace_id: `workspace-${protocol}`, tab_id: `tab-${protocol}`, pane_id: `moved-${protocol}` };
			const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
			const fixture = await serverFor((request, socket) => {
				calls.push({ method: request.method as string, params: request.params as Record<string, unknown> });
				const response = request.method === "pane.get"
					? { id: request.id, error: { code: "pane_not_found", message: "moved" } }
					: { id: request.id, result: { type: "pane_list", panes: [moved] } };
				socket.end(`${JSON.stringify(response)}\n`);
			});
			const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol };
			assert.deepEqual(await inspectHerdrPane(handle), { exists: true });
			assert.deepEqual(calls, [{ method: "pane.get", params: { pane_id: sourcePane.pane_id } }, { method: "pane.list", params: {} }]);
			assert.deepEqual({ workspaceId: handle.workspaceId, tabId: handle.tabId, paneId: handle.paneId }, { workspaceId: moved.workspace_id, tabId: moved.tab_id, paneId: moved.pane_id });
			await fixture.close();
		}
	});

	test("treats zero, duplicate, malformed, and oversized fallback lists as unknown", async () => {
		const unrelated = { ...sourcePane, pane_id: "unrelated-pane", terminal_id: "unrelated-terminal" };
		const cases: Array<[string, unknown]> = [
			["zero", []], ["duplicate", [sourcePane, { ...sourcePane, pane_id: "duplicate" }]],
			["duplicate unrelated pane", [unrelated, { ...unrelated, terminal_id: "another-terminal" }]],
			["duplicate unrelated terminal", [unrelated, { ...unrelated, pane_id: "another-pane" }]],
			["malformed", [{ pane_id: "missing-stable-id" }]], ["oversized", Array.from({ length: 129 }, () => sourcePane)],
		];
		for (const protocol of [19, 20] as const) for (const [_name, panes] of cases) {
			const fixture = await serverFor((request, socket) => {
				const response = request.method === "pane.get"
					? { id: request.id, error: { code: "pane_not_found", message: "moved" } }
					: { id: request.id, result: { type: "pane_list", panes } };
				socket.end(`${JSON.stringify(response)}\n`);
			});
			const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol };
			assert.deepEqual(await inspectHerdrPane(handle), _name === "zero" ? { exists: false } : undefined, `protocol ${protocol} ${_name} classification`);
			await fixture.close();
		}
	});

	test("rebinds an allocation after its durable handoff before launch delivery", async () => {
		const moved = { ...sourcePane, workspace_id: "other workspace", tab_id: "other tab", pane_id: "moved allocated pane", terminal_id: "new-term" };
		const allocated = { ...sourcePane, pane_id: "allocated pane", terminal_id: "new-term" };
		const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
		const fixture = await serverFor((request, socket) => {
			calls.push({ method: request.method as string, params: request.params as Record<string, unknown> });
			const paneId = (request.params as { pane_id?: string }).pane_id;
			const result = request.method === "ping" ? { type: "pong", protocol: 20 }
				: request.method === "pane.split" ? { type: "pane_info", pane: allocated }
				: request.method === "pane.get" && paneId === "allocated pane" ? { type: "pane_info", pane: { ...allocated, terminal_id: "wrong-terminal" } }
				: request.method === "pane.get" ? { type: "pane_info", pane: sourcePane }
				: request.method === "pane.list" ? { type: "pane_list", panes: [moved] }
				: { type: "ok" };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		const handle = await createHerdrSplit({
			cwd: "/tmp", wrapperPath: "/tmp/wrapper.sh",
			env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fixture.socketPath, HERDR_WORKSPACE_ID: sourcePane.workspace_id, HERDR_TAB_ID: sourcePane.tab_id, HERDR_PANE_ID: sourcePane.pane_id },
		});
		assert.deepEqual({ workspaceId: handle.workspaceId, tabId: handle.tabId, paneId: handle.paneId }, { workspaceId: moved.workspace_id, tabId: moved.tab_id, paneId: moved.pane_id });
		assert.equal(calls.find((call) => call.method === "pane.send_text")?.params.pane_id, moved.pane_id);
		await fixture.close();
	});

	test("treats a moved event as a wakeup and rebinds only through pane_not_found then pane.list", async () => {
		const moved = { ...sourcePane, workspace_id: "other workspace", tab_id: "other tab", pane_id: "new pane id" };
		const calls: string[] = [];
		const fixture = await serverFor((request, socket) => {
			calls.push(request.method as string);
			if (request.method === "events.subscribe") {
				assert.deepEqual((request.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions.find((subscription) => subscription.type === "pane.agent_status_changed"), {
					type: "pane.agent_status_changed", pane_id: sourcePane.pane_id,
				});
				socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
				setTimeout(() => socket.write(`${JSON.stringify({ event: "pane_moved", data: { previous_pane_id: sourcePane.pane_id, pane: moved } })}\n`), 5);
				return;
			}
			if (request.method === "pane.get" && (request.params as { pane_id: string }).pane_id === sourcePane.pane_id) {
				socket.end(`${JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: "moved" } })}\n`);
				return;
			}
			const result = request.method === "pane.get" ? { type: "pane_info", pane: moved } : { type: "pane_list", panes: [moved] };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		let reconciled = 0;
		const subscription = subscribeHerdrPane({ handle, onReconcile: () => { reconciled += 1; } });
		await new Promise((resolve) => setTimeout(resolve, 40));
		subscription.stop(); await subscription.closed;
		assert.ok(reconciled >= 1);
		assert.deepEqual(calls.slice(0, 3), ["events.subscribe", "pane.get", "pane.list"]);
		assert.deepEqual({ workspaceId: handle.workspaceId, tabId: handle.tabId, paneId: handle.paneId }, { workspaceId: moved.workspace_id, tabId: moved.tab_id, paneId: moved.pane_id });
		await fixture.close();
	});

	test("stops and drains in-flight subscription reconciliation without post-stop callbacks or requests", async () => {
		let resolvePaneGet!: () => void, callbacks = 0;
		const calls: string[] = [];
		const paneGetHeld = new Promise<void>((resolve) => { resolvePaneGet = resolve; });
		const fixture = await serverFor((request, socket) => {
			calls.push(request.method as string);
			if (request.method === "events.subscribe") return socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
			void paneGetHeld.then(() => socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane: sourcePane } })}\n`));
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const subscription = subscribeHerdrPane({ handle, onReconcile: () => { callbacks += 1; } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		subscription.stop();
		const requestsAtStop = calls.length;
		resolvePaneGet();
		await subscription.closed;
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.equal(callbacks, 0);
		assert.equal(calls.length, requestsAtStop, "stop prevents a late reconciliation from issuing pane.list or reconnect requests");
		assert.deepEqual({ workspaceId: handle.workspaceId, tabId: handle.tabId, paneId: handle.paneId }, { workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id });
		await fixture.close();
	});

	test("does not poll pane state while an idle subscription remains healthy", async () => {
		let subscriptions = 0, paneGets = 0;
		const fixture = await serverFor((request, socket) => {
			if (request.method === "events.subscribe") {
				subscriptions += 1;
				socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
				return;
			}
			if (request.method === "pane.get") paneGets += 1;
			socket.end(`${JSON.stringify({ id: request.id, result: { pane: sourcePane } })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const subscription = subscribeHerdrPane({ handle, onReconcile: () => undefined });
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.deepEqual({ subscriptions, paneGets }, { subscriptions: 1, paneGets: 1 });
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.deepEqual({ subscriptions, paneGets }, { subscriptions: 1, paneGets: 1 }, "a healthy idle subscription must not issue steady pane.get polling");
		subscription.stop(); await subscription.closed;
		await fixture.close();
	});

	test("ignores unrelated tab/workspace closure events and wakes only the tracked scope", async () => {
		let subscriptionSocket: net.Socket | undefined, reconciled = 0;
		const fixture = await serverFor((request, socket) => {
			if (request.method === "events.subscribe") {
				subscriptionSocket = socket;
				assert.deepEqual((request.params as { subscriptions: Array<{ type: string }> }).subscriptions.map(({ type }) => type), ["pane.closed", "pane.exited", "pane.updated", "pane.moved", "pane.agent_status_changed", "tab.closed", "workspace.closed"]);
				socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
				return;
			}
			socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane: sourcePane } })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const subscription = subscribeHerdrPane({ handle, onReconcile: () => { reconciled += 1; } });
		for (let attempt = 0; attempt < 40 && reconciled === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		const initial = reconciled;
		subscriptionSocket!.write(`${JSON.stringify({ event: "tab_closed", data: { workspace_id: "other-workspace", tab_id: sourcePane.tab_id } })}\n`);
		subscriptionSocket!.write(`${JSON.stringify({ event: "workspace_closed", data: { workspace_id: "other-workspace" } })}\n`);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(reconciled, initial);
		subscriptionSocket!.write(`${JSON.stringify({ event: "tab_closed", data: { workspace_id: sourcePane.workspace_id, tab_id: sourcePane.tab_id } })}\n`);
		for (let attempt = 0; attempt < 40 && reconciled === initial; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(reconciled > initial);
		subscription.stop(); await subscription.closed; await fixture.close();
	});

	test("wakes completed watchers after every failed reconnect attempt without repeating health transitions", async () => {
		let wakes = 0;
		const fixture = await serverFor((request, socket) => {
			if (request.method === "events.subscribe") socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const subscription = subscribeHerdrPane({ handle, reconnectDelayMs: 100, onReconcile: () => undefined, onWake: () => { wakes += 1; } });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const beforeFailure = wakes;
		await fixture.close();
		for (let attempt = 0; attempt < 100 && wakes < beforeFailure + 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(wakes >= beforeFailure + 2, "each completed failed reconnect attempt wakes reconciliation even while health remains false");
		subscription.stop(); await subscription.closed;
	});

	test("coalesces a wake received while reconciliation is settling", async () => {
		let subscriptionSocket: net.Socket | undefined, calls = 0, release!: () => void;
		const first = new Promise<void>((resolve) => { release = resolve; });
		const fixture = await serverFor((request, socket) => {
			if (request.method === "events.subscribe") {
				subscriptionSocket = socket;
				socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
				return;
			}
			socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane: sourcePane } })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const subscription = subscribeHerdrPane({ handle, onReconcile: async () => { calls += 1; if (calls === 1) await first; } });
		for (let attempt = 0; attempt < 40 && calls === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		subscriptionSocket!.write(`${JSON.stringify({ event: "tab_closed", data: { workspace_id: sourcePane.workspace_id, tab_id: sourcePane.tab_id } })}\n`);
		release();
		for (let attempt = 0; attempt < 40 && calls < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(calls, 2, "a pending wake restarts exactly one reconciliation after the active promise settles");
		subscription.stop(); await subscription.closed; await fixture.close();
	});

	test("reports strict subscription health transitions across reconnect", async () => {
		let subscriptions = 0;
		const health: boolean[] = [];
		const fixture = await serverFor((request, socket) => {
			if (request.method === "events.subscribe") {
				subscriptions += 1;
				socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
				if (subscriptions === 1) setTimeout(() => socket.end(), 5);
				return;
			}
			socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane: sourcePane } })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const subscription = subscribeHerdrPane({ handle, onReconcile: () => undefined, onHealthChange: (healthy) => health.push(healthy) });
		for (let attempt = 0; attempt < 80 && health.length < 3; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.deepEqual(health, [true, false, true]);
		subscription.stop(); await subscription.closed; await fixture.close();
	});

	test("reconnects after a subscription disconnect and reconciles once per recovered stream", async () => {
		let subscriptions = 0, paneGets = 0;
		let recovered!: () => void;
		const recoveredPromise = new Promise<void>((resolve) => { recovered = resolve; });
		const fixture = await serverFor((request, socket) => {
			if (request.method === "events.subscribe") {
				subscriptions += 1;
				socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
				if (subscriptions === 1) setTimeout(() => socket.end(), 10);
				else recovered();
				return;
			}
			if (request.method === "pane.get") paneGets += 1;
			socket.end(`${JSON.stringify({ id: request.id, result: { pane: sourcePane } })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		const subscription = subscribeHerdrPane({ handle, onReconcile: () => undefined });
		await Promise.race([recoveredPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("subscription did not reconnect")), 1_000))]);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(subscriptions, 2);
		assert.equal(paneGets, 2, "initial and recovered streams each reconcile exactly once");
		subscription.stop(); await subscription.closed;
		await fixture.close();
	});
});
