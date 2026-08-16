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
	closeHerdrPane,
	createHerdrSplit,
	createHerdrTab,
	focusHerdrPane,
	inspectHerdrPane,
	inspectHerdrPaneForUx,
	interruptHerdrPane,
	isHerdrPublicId,
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
	const server = net.createServer((socket) => {
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
	return { socketPath, close: async () => await new Promise<void>((resolve) => server.close(() => resolve())) };
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
				: request.method === "pane.focus" ? { type: "pane_info", pane: moved } : { type: "pane_list", panes: [moved] };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: "child-tab", paneId: "child-pane", terminalId: moved.terminal_id, allocatedTabId: "child-tab", protocol: 20 as const };
		assert.equal(await interruptHerdrPane(handle), false);
		assert.equal(await closeHerdrPane(handle), false);
		assert.equal(await focusHerdrPane(handle), true, "manual focus remains available after ownership transfer");
		assert.equal(calls.includes("pane.send_keys"), false);
		assert.equal(calls.includes("pane.close"), false);
		assert.equal(calls.includes("pane.focus"), true);
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
			["ping", false], ["pane.get", false], ["pane.list", false], ["pane.split", true], ["pane.focus", true],
			["pane.send_text", true], ["pane.send_keys", true], ["pane.close", true], ["layout.apply", true],
		];
		for (const [method, mutation] of cases) {
			const fixture = await serverFor((request, socket) => socket.end(`${JSON.stringify({ id: request.id, result: { type: "wrong" } })}\n`));
			await assert.rejects(new HerdrSocketClient(fixture.socketPath).request(method, {}, { mutation }), (error: unknown) => mutation ? error instanceof HerdrUnknownOutcomeError : error instanceof Error && error.name === "HerdrProtocolError");
			await fixture.close();
		}
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

	test("gates and revalidates exact Herdr focus before mutation", async () => {
		const calls: string[] = [];
		const fixture = await serverFor((request, socket) => {
			calls.push(request.method as string);
			const result = request.method === "ping" ? { type: "pong", protocol: 20 } : { type: "pane_info", pane: sourcePane };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
		assert.equal(await focusHerdrPane({ socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 }), true);
		assert.deepEqual(calls, ["ping", "pane.get", "pane.focus"]);
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
		const cases: Array<[string, unknown]> = [
			["zero", []], ["duplicate", [sourcePane, { ...sourcePane, pane_id: "duplicate" }]], ["malformed", [{ pane_id: "missing-stable-id" }]],
			["oversized", Array.from({ length: 129 }, () => sourcePane)],
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

	test("rebinds a moved pane by terminal_id before reporting absence", async () => {
		const moved = { ...sourcePane, workspace_id: "other workspace", tab_id: "other tab", pane_id: "new pane id" };
		const fixture = await serverFor((request, socket) => {
			if (request.method === "events.subscribe") {
				assert.deepEqual((request.params as { subscriptions: Array<Record<string, unknown>> }).subscriptions.find((subscription) => subscription.type === "pane.agent_status_changed"), {
					type: "pane.agent_status_changed", pane_id: sourcePane.pane_id,
				});
				socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
				setTimeout(() => socket.write(`${JSON.stringify({ data: { previous_pane_id: sourcePane.pane_id, pane: moved } })}\n`), 5);
				return;
			}
			socket.end(`${JSON.stringify({ id: request.id, result: { pane: (request.params as { pane_id: string }).pane_id === moved.pane_id ? moved : sourcePane } })}\n`);
		});
		const handle = { socketPath: fixture.socketPath, ...socketGeneration(fixture.socketPath), workspaceId: sourcePane.workspace_id, tabId: sourcePane.tab_id, paneId: sourcePane.pane_id, terminalId: sourcePane.terminal_id, protocol: 20 as const };
		let reconciled = 0;
		const subscription = subscribeHerdrPane({ handle, onReconcile: () => { reconciled += 1; } });
		await new Promise((resolve) => setTimeout(resolve, 40));
		subscription.stop(); await subscription.closed;
		assert.ok(reconciled >= 1);
		assert.deepEqual({ workspaceId: handle.workspaceId, tabId: handle.tabId, paneId: handle.paneId }, { workspaceId: moved.workspace_id, tabId: moved.tab_id, paneId: moved.pane_id });
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
