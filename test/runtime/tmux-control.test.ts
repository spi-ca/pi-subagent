import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	TmuxControlClient,
	createTmuxControlCommandRunner,
	TmuxControlError,
	TmuxControlParser,
	TmuxControlUnknownOutcomeError,
	encodeTmuxToken,
	resetTmuxControlMetrics,
	snapshotTmuxControlMetrics,
	tmuxCommand,
} from "../../src/runtime/tmux-control";
import { MINIMUM_TMUX_VERSION } from "../../src/runtime/version-policy.mjs";
import {
	closePhase0LiveTelemetryForTest,
	PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV,
	PHASE0_LIVE_TELEMETRY_DIR_ENV,
} from "../../src/runtime/phase0-live-telemetry.mjs";

const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/tmux-control-v1.json"), "utf8"));

class FakeChild extends EventEmitter {
	stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 123;
	killed = false;
	kill() { this.killed = true; this.emit("exit", 0, "SIGTERM"); return true; }
}

async function startControlledClient(options: { commandTimeoutMs?: number; onDisconnect?: (detail: { code: string; category: string }) => void } = {}) {
	const child = new FakeChild();
	const writes: string[] = [];
	queueMicrotask(() => child.stdout.write("%begin 1 0 0\n%end 1 0 0\n"));
	child.stdin.on("data", (chunk) => {
		const line = String(chunk);
		writes.push(line);
		if (line.startsWith("refresh-client")) queueMicrotask(() => child.stdout.write("%begin 2 1 0\n%end 2 1 0\n"));
	});
	const client = new TmuxControlClient({
		executable: "/usr/bin/tmux", socketPath: "/tmp/tmux.sock", sessionId: "$1", spawnProcess: (() => child) as any,
		...options,
	});
	await client.start();
	return { child, client, writes };
}

describe("tmux 3.7b control mode", () => {
	test("parses pinned response blocks and outside-block notifications", () => {
		assert.equal(fixture.contract, "tmux-control-v1");
		assert.equal(fixture.minimumVersion, MINIMUM_TMUX_VERSION);
		assert.equal(fixture.capturedVersion, "3.7b");
		assert.equal(fixture.sourceCommit, "e802909de06012a4df6209d55e86487c56223163");
		const parser = new TmuxControlParser();
		let response: unknown;
		for (const line of fixture.response) response = parser.consume(line) ?? response;
		assert.deepEqual(response, { kind: "response", ok: true, lines: ["%1|$1|@1|0|1234"] });
		for (const line of fixture.notifications) {
			const parsed = parser.consume(line);
			if (line.startsWith("%output") || line.startsWith("%extended-output")) assert.deepEqual(parsed, { kind: "output" });
			else assert.equal(parsed?.kind, "notification");
		}
		assert.deepEqual(parser.consume("%subscription-changed pi-subagent-pane-dead %2 1"), {
			kind: "notification",
			notification: { name: "%subscription-changed", line: "%subscription-changed pi-subagent-pane-dead %2 1", resync: true },
		});
	});

	test("parses every response shape used by uncorrelated-response telemetry", () => {
		const cases = [
			[true, [], "uncorrelated-ok-empty"],
			[true, ["safe-nonempty-line"], "uncorrelated-ok-nonempty"],
			[false, [], "uncorrelated-error-empty"],
			[false, ["safe-nonempty-line"], "uncorrelated-error-nonempty"],
		] as const;
		for (const [ok, lines, category] of cases) {
			const parser = new TmuxControlParser();
			const marker = ok ? "%end" : "%error";
			let parsed: unknown;
			for (const line of ["%begin 9 9 0", ...lines, `${marker} 9 9 0`]) parsed = parser.consume(line) ?? parsed;
			assert.deepEqual(parsed, { kind: "response", ok, lines }, category);
		}
	});

	test("rejects malformed nesting, mismatched tuples, notifications in blocks, and EOF mid-response", () => {
		for (const lines of [
			["%end 1 1 0"],
			["%begin 1 1 0", "%begin 1 2 0"],
			["%begin 1 1 0", "%layout-change @1 x y z"],
			["%begin 1 1 0", "%end 1 2 0"],
		] as const) {
			const parser = new TmuxControlParser();
			assert.throws(() => { for (const line of lines) parser.consume(line); }, TmuxControlError);
		}
		const partial = new TmuxControlParser(); partial.consume("%begin 1 1 0");
		assert.throws(() => partial.finish(), TmuxControlError);
		assert.throws(() => new TmuxControlParser().consume("plain output"), TmuxControlError);
	});

	test("encodes adversarial values as exactly one expansion-free tmux token", () => {
		assert.equal(encodeTmuxToken(""), "''");
		assert.equal(encodeTmuxToken("simple"), "'simple'");
		assert.equal(encodeTmuxToken("a'b $HOME; run-shell x \\ y"), "'a'\\''b $HOME; run-shell x \\ y'");
		assert.equal(tmuxCommand("display-message", ["-p", "#{pid}"]), "display-message '-p' '#{pid}'");
		for (const value of ["a\nb", "a\rb", "a\0b"]) assert.throws(() => encodeTmuxToken(value), TmuxControlError);
	});

	test("maps direct argv to one encoded control command without shell interpretation", async () => {
		const lines: string[] = [];
		const client = { execute: async (line: string) => { lines.push(line); return ["%2|99"]; } } as unknown as TmuxControlClient;
		const run = createTmuxControlCommandRunner(client, "/tmp/tmux.sock");
		const canary = "x; run-shell 'touch /tmp/forbidden' $HOME";
		const result = await run(["-S", "/tmp/tmux.sock", "split-window", "-d", "--", "/usr/bin/env", "ARG=" + canary]);
		assert.equal(result.exitCode, 0);
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /^split-window /);
		assert.ok(lines[0]!.includes(encodeTmuxToken("ARG=" + canary)));
		assert.equal((await run(["-S", "/other.sock", "list-panes"])).exitCode, 1);
	});

	test("requests two responses only for complete repository guarded if-shell commands", async () => {
		const calls: Array<{ line: string; options: Record<string, unknown> }> = [];
		const client = { execute: async (line: string, options: Record<string, unknown>) => { calls.push({ line, options }); return []; } } as unknown as TmuxControlClient;
		const run = createTmuxControlCommandRunner(client, "/tmp/tmux.sock");
		const condition = "#{&&:#{==:#{pid},123},#{==:#{pane_pid},456}}";
		await run(["-S", "/tmp/tmux.sock", "if-shell", "-F", "-t", "%2", condition, "kill-pane -t %2", "display-message -p -l pi-subagent-guard-noop"]);
		await run(["-S", "/tmp/tmux.sock", "if-shell", "-F", "-t", "%2", condition, "kill-pane -t %2", ""]);
		assert.equal(calls[0]!.options.expectedResponses, 2);
		assert.equal(calls[1]!.options.expectedResponses, 1, "an incomplete guarded shape must not assume a nested response");
	});

	test("defers guarded if-shell resolution and queue dispatch until both successful responses arrive", async () => {
		const disconnects: Array<{ code: string; category: string }> = [];
		const { child, client, writes } = await startControlledClient({ onDisconnect: (detail) => disconnects.push(detail) });
		const guarded = client.execute("if-shell '-F' '-t' '%2' 'guard' 'kill-pane -t %2' 'display-message -p -l pi-subagent-guard-noop'", { name: "if-shell", mutation: true, expectedResponses: 2 });
		const next = client.execute("list-panes '-a'", { name: "list-panes" });
		child.stdout.write("%begin 3 2 0\nouter\n%end 3 2 0\n");
		await Promise.resolve();
		assert.equal(writes.filter((line) => line.startsWith("list-panes")).length, 0);
		let settled = false;
		void guarded.then(() => { settled = true; });
		await Promise.resolve();
		assert.equal(settled, false);
		child.stdout.write("%begin 3 3 0\nnested\n%end 3 3 0\n");
		assert.deepEqual(await guarded, ["outer", "nested"]);
		await Promise.resolve();
		assert.equal(writes.filter((line) => line.startsWith("list-panes")).length, 1);
		child.stdout.write("%begin 3 4 0\nnext\n%end 3 4 0\n");
		assert.deepEqual(await next, ["next"]);
		assert.deepEqual(disconnects, [], "the nested response remains correlated with its original command");
		client.close();
	});

	test("settles guarded outer errors immediately and nested errors as unknown mutation outcomes", async () => {
		const outer = await startControlledClient();
		const outerCommand = outer.client.execute("if-shell 'outer'", { name: "if-shell", mutation: true, expectedResponses: 2 });
		const queued = outer.client.execute("list-panes '-a'", { name: "list-panes" });
		outer.child.stdout.write("%begin 3 2 0\n%error 3 2 0\n");
		await assert.rejects(() => outerCommand, TmuxControlUnknownOutcomeError);
		await Promise.resolve();
		assert.equal(outer.writes.filter((line) => line.startsWith("list-panes")).length, 1, "a top-level error has no nested response to await");
		outer.child.stdout.write("%begin 3 3 0\nqueued\n%end 3 3 0\n");
		assert.deepEqual(await queued, ["queued"]);
		outer.client.close();

		const nested = await startControlledClient();
		const nestedCommand = nested.client.execute("if-shell 'nested'", { name: "if-shell", mutation: true, expectedResponses: 2 });
		nested.child.stdout.write("%begin 3 2 0\n%end 3 2 0\n%begin 3 3 0\n%error 3 3 0\n");
		await assert.rejects(() => nestedCommand, TmuxControlUnknownOutcomeError);
		assert.equal(nested.writes.filter((line) => line.startsWith("if-shell")).length, 1, "unknown mutations are never replayed");
		nested.client.close();
	});

	test("uses one deadline across both guarded responses and validates expected response counts", { timeout: 1_000 }, async () => {
		const { child, client } = await startControlledClient({ commandTimeoutMs: 20 });
		for (const expectedResponses of [0, 3, 1.5]) {
			await assert.rejects(() => client.execute("display-message '-p' '#{pid}'", { expectedResponses }), (error: unknown) => error instanceof TmuxControlError && error.code === "TMUX_RESPONSES");
		}
		const pending = client.execute("if-shell 'timeout'", { name: "if-shell", mutation: true, expectedResponses: 2 });
		child.stdout.write("%begin 3 2 0\nfirst\n%end 3 2 0\n");
		await assert.rejects(() => pending, TmuxControlUnknownOutcomeError);
		assert.equal(child.killed, true, "the original command deadline is not restarted for its nested response");
	});

	test("rejects aggregate multi-response line and byte bounds", async () => {
		const lineBounded = await startControlledClient();
		const lineOverflow = lineBounded.client.execute("if-shell 'lines'", { name: "if-shell", expectedResponses: 2 });
		const manyLines = (tuple: number) => `%begin 3 ${tuple} 0\n${Array.from({ length: 2_049 }, () => "x").join("\n")}\n%end 3 ${tuple} 0\n`;
		lineBounded.child.stdout.write(manyLines(2));
		lineBounded.child.stdout.write(manyLines(3));
		await assert.rejects(() => lineOverflow, (error: unknown) => error instanceof TmuxControlError && error.code === "TMUX_PROTOCOL");
		assert.equal(lineBounded.child.killed, true);

		const byteBounded = await startControlledClient();
		const byteOverflow = byteBounded.client.execute("if-shell 'bytes'", { name: "if-shell", expectedResponses: 2 });
		const manyBytes = (tuple: number) => `%begin 3 ${tuple} 0\n${Array.from({ length: 10 }, () => "x".repeat(60 * 1024)).join("\n")}\n%end 3 ${tuple} 0\n`;
		byteBounded.child.stdout.write(manyBytes(2));
		byteBounded.child.stdout.write(manyBytes(3));
		await assert.rejects(() => byteOverflow, (error: unknown) => error instanceof TmuxControlError && error.code === "TMUX_PROTOCOL");
		assert.equal(byteBounded.child.killed, true);
	});

	test("spawns one serialized control client with atomic output suppression and correlates responses", async () => {
		resetTmuxControlMetrics();
		const child = new FakeChild();
		const writes: string[] = [];
		let command = 1;
		child.stdin.on("data", (chunk) => {
			writes.push(String(chunk));
			const current = command++;
			queueMicrotask(() => child.stdout.write(`%begin 2 ${current} 0\nreply-${current}\n%end 2 ${current} 0\n`));
		});
		queueMicrotask(() => child.stdout.write("%begin 1 0 0\n%end 1 0 0\n"));
		let spawnArgs: string[] = [];
		const client = new TmuxControlClient({ executable: "/usr/bin/tmux", socketPath: "/tmp/tmux.sock", sessionId: "$1", spawnProcess: ((_file: string, args: readonly string[]) => { spawnArgs = [...args]; return child; }) as any });
		await client.start();
		const [first, second] = await Promise.all([
			client.execute(tmuxCommand("display-message", ["-p", "#{pid}"]), { name: "pid" }),
			client.execute(tmuxCommand("list-panes", ["-a", "-F", "#{pane_id}"]), { name: "panes" }),
		]);
		assert.deepEqual(spawnArgs, ["-S", "/tmp/tmux.sock", "-C", "attach-session", "-f", "no-output", "-t", "$1"]);
		assert.deepEqual(first, ["reply-2"]);
		assert.deepEqual(second, ["reply-3"]);
		assert.match(writes[0]!, /^refresh-client .*pi-subagent-pane-dead/);
		assert.match(writes[1]!, /^display-message /);
		assert.match(writes[2]!, /^list-panes /);
		client.close();
		assert.deepEqual(snapshotTmuxControlMetrics(), { clientsSpawned: 1, clientsClosed: 1, commandsDispatched: 3, notifications: 0, commandNames: { panes: 1, pid: 1, "refresh-client": 1 } });
	});

	test("keeps sixteen clients connected through fake high-volume startup output and independent pane-dead subscriptions", async () => {
		const subscriptions = new Map<string, FakeChild>();
		const clients = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
			const child = new FakeChild();
			const writes: string[] = [];
			let response = 1;
			child.stdin.on("data", (chunk) => {
				const line = String(chunk);
				writes.push(line);
				const subscription = line.match(/^refresh-client '-B' '([^:']+):%\*:#{pane_dead}'\n$/);
				if (subscription) subscriptions.set(subscription[1]!, child);
				const current = response++;
				queueMicrotask(() => child.stdout.write(`%begin 2 ${current} 0\nclient-${index}\n%end 2 ${current} 0\n`));
			});
			// tmux 3.7b applies no-output in attach-session argv. This hostile fake
			// still emits 256 parser-discarded output lines before attach completes,
			// proving startup does not depend on an output-free queue or disconnect.
			const startupOutput = Array.from({ length: 256 }, () => `%output %${index + 1} ${"x".repeat(1024)}\n`).join("");
			queueMicrotask(() => child.stdout.write(`${startupOutput}%begin 1 0 0\n%end 1 0 0\n`));
			const client = new TmuxControlClient({
				executable: "/usr/bin/tmux", socketPath: `/tmp/tmux-${index}.sock`, sessionId: "$1", spawnProcess: (() => child) as any,
			});
			await client.start();
			return { child, client, index, writes };
		}));
		const names = clients.map(({ writes }) => writes[0]!.match(/^refresh-client '-B' '([^:']+):%\*:#{pane_dead}'\n$/)?.[1]);
		assert.equal(new Set(names).size, 16);
		assert.equal(subscriptions.size, 16);

		const survivor = clients[0]!;
		const closing = clients[15]!;
		const closingName = names[15]!;
		closing.client.close();
		// Model tmux removing the closed control client's server-global subscription.
		subscriptions.delete(closingName);
		const notification = survivor.client.waitForNotification(100);
		assert.equal(subscriptions.get(names[0]!), survivor.child);
		survivor.child.stdout.write(`%subscription-changed ${names[0]} %2 1\n`);
		assert.equal(await notification, "notification");
		assert.deepEqual(await survivor.client.execute(tmuxCommand("display-message", ["-p", "#{pane_id}"]), { name: "display-message" }), ["client-0"]);

		for (const { client } of clients.slice(0, -1)) client.close();
	});

	test("uses the parent bounded 30s command timeout for delayed read-only backlog while defaults still fail at 5s", { timeout: 7_000 }, async () => {
		const delayedResponseMs = 5_100;
		const createBackloggedClient = (commandTimeoutMs?: number) => {
			const child = new FakeChild();
			const writes: string[] = [];
			child.stdin.on("data", (chunk) => {
				const line = String(chunk);
				writes.push(line);
				if (line.startsWith("refresh-client")) {
					queueMicrotask(() => child.stdout.write("%begin 2 1 0\n%end 2 1 0\n"));
					return;
				}
				// A bounded ignored-output burst models an active shared client's
				// notification/output backlog without preserving payload content.
				child.stdout.write(Array.from({ length: 128 }, () => `%output %1 ${"x".repeat(512)}\n`).join(""));
				setTimeout(() => child.stdout.write("%begin 2 2 0\nlate-read\n%end 2 2 0\n"), delayedResponseMs);
			});
			queueMicrotask(() => child.stdout.write("%begin 1 0 0\n%end 1 0 0\n"));
			const client = new TmuxControlClient({
				executable: "/usr/bin/tmux", socketPath: "/tmp/tmux.sock", sessionId: "$1", spawnProcess: (() => child) as any,
				...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
			});
			return { child, client, writes };
		};
		const defaultRead = createBackloggedClient();
		const parentRead = createBackloggedClient(30_000);
		const mutation = createBackloggedClient();
		await Promise.all([defaultRead.client.start(), parentRead.client.start(), mutation.client.start()]);
		const defaultResult = defaultRead.client.execute(tmuxCommand("display-message", ["-p", "#{pane_id}"]), { name: "display-message" });
		const parentResult = parentRead.client.execute(tmuxCommand("display-message", ["-p", "#{pane_id}"]), { name: "display-message" });
		const mutationResult = mutation.client.execute(tmuxCommand("kill-pane", ["-t", "%2"]), { name: "kill-pane", mutation: true, reserved: true });
		const [defaultOutcome, parentOutcome, mutationOutcome] = await Promise.allSettled([defaultResult, parentResult, mutationResult]);
		assert.equal(defaultOutcome.status, "rejected");
		assert.ok(defaultOutcome.reason instanceof TmuxControlError && defaultOutcome.reason.code === "TMUX_TIMEOUT");
		assert.deepEqual(parentOutcome, { status: "fulfilled", value: ["late-read"] });
		assert.equal(mutationOutcome.status, "rejected");
		assert.ok(mutationOutcome.reason instanceof TmuxControlUnknownOutcomeError);
		assert.equal(defaultRead.child.killed, true, "timed-out read poisons its generation for reconnect");
		assert.equal(mutation.child.killed, true);
		assert.equal(mutation.writes.filter((line) => line.startsWith("kill-pane")).length, 1, "unknown mutation is never replayed");
		parentRead.client.close();
	});

	test("wakes bounded waiters on notifications, timeout, and disconnect without polling commands", async () => {
		const child = new FakeChild();
		queueMicrotask(() => child.stdout.write("%begin 1 0 0\n%end 1 0 0\n"));
		child.stdin.on("data", (chunk) => {
			if (String(chunk).startsWith("refresh-client")) queueMicrotask(() => child.stdout.write("%begin 2 1 0\n%end 2 1 0\n"));
		});
		const client = new TmuxControlClient({ executable: "/usr/bin/tmux", socketPath: "/tmp/tmux.sock", sessionId: "$1", spawnProcess: (() => child) as any });
		await client.start();
		const initialSequence = client.notificationSequence();
		const notified = client.waitForNotification(100);
		child.stdout.write("%layout-change @1 x y z\n");
		assert.equal(await notified, "notification");
		assert.equal(client.notificationSequence(), initialSequence + 1);
		assert.equal(await client.waitForNotification(5), "timeout");
		const disconnected = client.waitForNotification(100);
		client.close();
		assert.equal(await disconnected, "disconnect");
	});

	test("treats EOF after mutation dispatch as unknown and never replays it", async () => {
		const child = new FakeChild();
		queueMicrotask(() => child.stdout.write("%begin 1 0 0\n%end 1 0 0\n"));
		child.stdin.on("data", (chunk) => {
			if (String(chunk).startsWith("refresh-client")) queueMicrotask(() => child.stdout.write("%begin 2 1 0\n%end 2 1 0\n"));
			else queueMicrotask(() => child.emit("exit", 1, null));
		});
		const client = new TmuxControlClient({ executable: "/usr/bin/tmux", socketPath: "/tmp/tmux.sock", sessionId: "$1", spawnProcess: (() => child) as any });
		await client.start();
		await assert.rejects(() => client.execute(tmuxCommand("kill-pane", ["-t", "%2"]), { name: "kill-pane", mutation: true, reserved: true }), TmuxControlUnknownOutcomeError);
	});

	test("reports fixed sanitized protocol disconnect categories to callbacks and telemetry", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tmux-control-telemetry-")));
		fs.chmodSync(root, 0o700);
		const environment = ["PI_SUBAGENT_PHASE0_LIVE", PHASE0_LIVE_TELEMETRY_DIR_ENV, PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV] as const;
		const previous = new Map(environment.map((name) => [name, process.env[name]]));
		closePhase0LiveTelemetryForTest();
		process.env.PI_SUBAGENT_PHASE0_LIVE = "1";
		process.env[PHASE0_LIVE_TELEMETRY_DIR_ENV] = root;
		process.env[PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV] = "c".repeat(64);
		try {
			const startClient = async () => {
				const child = new FakeChild();
				const details: Array<{ code: string; category: string }> = [];
				queueMicrotask(() => child.stdout.write("%begin 1 0 0\n%end 1 0 0\n"));
				child.stdin.on("data", (chunk) => {
					if (String(chunk).startsWith("refresh-client")) queueMicrotask(() => child.stdout.write("%begin 2 1 0\n%end 2 1 0\n"));
				});
				const client = new TmuxControlClient({
					executable: "/usr/bin/tmux", socketPath: "/tmp/tmux.sock", sessionId: "$1", spawnProcess: (() => child) as any,
					onDisconnect: (detail) => details.push(detail),
				});
				await client.start();
				return { child, client, details };
			};
			const cases: Array<[string, (child: FakeChild) => void]> = [
				["uncorrelated-ok-empty", (child) => child.stdout.write("%begin 3 2 0\n%end 3 2 0\n")],
				["uncorrelated-ok-nonempty", (child) => child.stdout.write("%begin 3 2 0\nraw-output-must-not-escape\n%end 3 2 0\n")],
				["uncorrelated-error-empty", (child) => child.stdout.write("%begin 3 2 0\n%error 3 2 0\n")],
				["uncorrelated-error-nonempty", (child) => child.stdout.write("%begin 3 2 0\nraw-output-must-not-escape\n%error 3 2 0\n")],
				["parser-framing", (child) => child.stdout.write("%end 3 2 0\n")],
				["chunk", (child) => child.stdout.write(Buffer.alloc(1024 * 1024 + 1))],
				["line", (child) => { child.stdout.write(Buffer.alloc(512 * 1024)); child.stdout.write(Buffer.alloc(512 * 1024 + 1)); }],
				["utf8", (child) => child.stdout.write(Buffer.from([0xff, 0x0a]))],
			];
			for (const [category, emit] of cases) {
				const { child, details } = await startClient();
				emit(child);
				assert.deepEqual(details, [{ code: "TMUX_PROTOCOL", category }], `${category} exposes code and fixed category only`);
			}
			closePhase0LiveTelemetryForTest();
			const telemetry = fs.readdirSync(root).flatMap((name) => fs.readFileSync(path.join(root, name), "utf8").trim().split("\n")).filter(Boolean).map((line) => JSON.parse(line));
			assert.deepEqual(telemetry.filter((event) => event.type === "counter" && event.metric === "controlDisconnects" && event.reason !== "presence").map((event) => event.reason).sort(), ["chunk", "line", "parser-framing", "uncorrelated-error-empty", "uncorrelated-error-nonempty", "uncorrelated-ok-empty", "uncorrelated-ok-nonempty", "utf8"]);
			assert.equal(JSON.stringify(telemetry).includes("raw-output-must-not-escape"), false, "telemetry must not include parsed response lines");
		} finally {
			closePhase0LiveTelemetryForTest();
			for (const name of environment) {
				const value = previous.get(name);
				if (value === undefined) delete process.env[name]; else process.env[name] = value;
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
