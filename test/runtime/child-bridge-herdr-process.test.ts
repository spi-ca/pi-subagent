import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	SUBAGENT_CHILD_SESSION_PATH_ENV,
	SUBAGENT_PARENT_LEASE_PATH_ENV,
	SUBAGENT_RUN_COMPLETION_PATH_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_RUN_OWNERSHIP_ENV,
	SUBAGENT_RUN_STATE_PATH_ENV,
	atomicWriteJson,
	prepareRunArtifactPaths,
} from "../../src/runtime/run-protocol";

type HerdrRequest = { id: string; method: string; params: Record<string, unknown> };
type PendingRequest = { request: HerdrRequest; socket: net.Socket };

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
			timer.unref?.();
		}),
	]).finally(() => clearTimeout(timer!));
}

function childProgram(): string {
	const bridgeUrl = pathToFileURL(path.resolve("src/runtime/child-bridge.ts")).href;
	const herdrUrl = pathToFileURL(path.resolve("src/runtime/herdr.ts")).href;
	return `
import { registerChildBridge } from ${JSON.stringify(bridgeUrl)};
import { createChildHerdrMetadataReporter } from ${JSON.stringify(herdrUrl)};
import { createExtensionRuntime, ExtensionRunner } from "@earendil-works/pi-coding-agent";

const handlers = new Map();
const api = {
  on(type, handler) { handlers.set(type, [...(handlers.get(type) ?? []), handler]); },
  registerTool() { throw new Error("unexpected child tool registration"); },
};
registerChildBridge(api, {
  createHerdrMetadataReporter(handle, runId, title) {
    const reporter = createChildHerdrMetadataReporter({ handle, runId, title });
    if (!reporter) throw new Error("expected an exact allocation-bound Herdr reporter");
    return {
      report(lifecycle) { reporter.report(lifecycle); },
      close() {
        let closing;
        // Regression oracle: invoking close is inert. Only production's await
        // assimilates this thenable and starts the real source-scoped clear.
        // Replacing that await with void therefore sends no clear at all, so a
        // later writeState tail cannot accidentally keep this test passing.
        return {
          then(resolve, reject) {
            closing ??= reporter.close();
            return closing.then(resolve, reject);
          },
        };
      },
    };
  },
});
const extension = {
  path: "<child-bridge-process-test>", resolvedPath: "<child-bridge-process-test>", sourceInfo: {}, handlers,
  tools: new Map(), messageRenderers: new Map(), entryRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
};
const runtime = createExtensionRuntime();
const runner = new ExtensionRunner([extension], runtime, process.cwd(), {}, {});
let extensionError;
runner.onError((error) => { extensionError = error; });
await runner.emit({ type: "session_start", reason: "startup" });
if (extensionError) throw new Error(JSON.stringify(extensionError));
const shutdown = runner.emit({ type: "session_shutdown" });
console.log("shutdown-start");
let shutdownSettled = false;
void shutdown.then(
  () => { shutdownSettled = true; },
  () => { shutdownSettled = true; },
);
await new Promise((resolve) => setImmediate(resolve));
console.log(shutdownSettled ? "shutdown-settled" : "shutdown-pending");
await shutdown;
console.log("shutdown-complete");
if (extensionError) throw new Error(JSON.stringify(extensionError));
`;
}

const unixTest = process.platform === "win32" ? test.skip : test;
unixTest("holds process exit until the source-scoped Herdr shutdown clear is acknowledged", { timeout: 10_000 }, async () => {
	const runId = "shutdown-hold";
	const pane = { workspace_id: "workspace-exact", tab_id: "tab-exact", pane_id: "pane-exact", terminal_id: "terminal-exact" };
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-shutdown-"));
	await fs.promises.chmod(root, 0o700);
	const socketPath = path.join(root, "herdr.sock");
	const sockets = new Set<net.Socket>();
	const socketCompletions: Promise<void>[] = [];
	const queued: PendingRequest[] = [];
	const waiters: Array<{ resolve(value: PendingRequest): void; reject(error: Error): void }> = [];
	const queuedLines: string[] = [];
	const lineWaiters: Array<{ resolve(value: string): void; reject(error: Error): void }> = [];
	let channelError: Error | null = null;
	const failChannel = (error: Error) => {
		channelError ??= error;
		for (const waiter of waiters.splice(0)) waiter.reject(channelError);
		for (const waiter of lineWaiters.splice(0)) waiter.reject(channelError);
	};
	const publish = (value: PendingRequest) => {
		const waiter = waiters.shift();
		if (waiter) waiter.resolve(value); else queued.push(value);
	};
	const receive = () => {
		if (channelError) return Promise.reject(channelError);
		const value = queued.shift();
		if (value) return Promise.resolve(value);
		return new Promise<PendingRequest>((resolve, reject) => waiters.push({ resolve, reject }));
	};
	const publishLine = (value: string) => {
		const waiter = lineWaiters.shift();
		if (waiter) waiter.resolve(value); else queuedLines.push(value);
	};
	const receiveLine = () => {
		if (channelError) return Promise.reject(channelError);
		const value = queuedLines.shift();
		if (value !== undefined) return Promise.resolve(value);
		return new Promise<string>((resolve, reject) => lineWaiters.push({ resolve, reject }));
	};
	const server = net.createServer((socket) => {
		sockets.add(socket);
		let resolveSocketCompletion!: () => void;
		socketCompletions.push(new Promise<void>((resolve) => { resolveSocketCompletion = resolve; }));
		socket.once("close", () => { sockets.delete(socket); resolveSocketCompletion(); });
		let bytes = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			if (bytes.length > 0 && bytes.includes(0x0a)) return failChannel(new Error("Herdr fixture received data after its request frame"));
			bytes = Buffer.concat([bytes, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
			if (bytes.length > 256 * 1024) return failChannel(new Error("Herdr fixture request exceeded its wire bound"));
			const newline = bytes.indexOf(0x0a);
			if (newline < 0) return;
			if (newline !== bytes.length - 1) return failChannel(new Error("Herdr fixture received invalid request framing"));
			try {
				const request = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as HerdrRequest;
				publish({ request, socket });
			} catch (error) {
				failChannel(error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.on("error", (error) => failChannel(error));
	});

	let child: ChildProcess | null = null;
	let childFinished = false;
	let childClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
	let stdoutClosed: Promise<void> | null = null;
	let stderr = "";
	try {
		await withTimeout(new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => { server.off("error", reject); resolve(); });
		}), "Herdr fixture listen");
		await fs.promises.chmod(socketPath, 0o600);
		const stat = await fs.promises.lstat(socketPath, { bigint: true });
		const generation = { socketDev: stat.dev.toString(), socketIno: stat.ino.toString() };
		const paths = await prepareRunArtifactPaths({ rootDir: path.join(root, "state"), runId });
		await Promise.all([
			atomicWriteJson(paths.allocationPath, {
				version: 2, runId, terminalMode: "herdr-pane",
				target: { socketPath, workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id, protocol: 20, generation },
				allocatedAt: Date.now(),
			}),
			fs.promises.writeFile(paths.childSessionPath, "", { mode: 0o600, flag: "wx" }),
		]);

		const env: NodeJS.ProcessEnv = {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			TMPDIR: process.env.TMPDIR,
			[SUBAGENT_RUN_ID_ENV]: runId,
			[SUBAGENT_RUN_STATE_PATH_ENV]: paths.statePath,
			[SUBAGENT_RUN_COMPLETION_PATH_ENV]: paths.completionPath,
			[SUBAGENT_PARENT_LEASE_PATH_ENV]: paths.parentLeasePath,
			[SUBAGENT_CHILD_SESSION_PATH_ENV]: paths.childSessionPath,
			[SUBAGENT_RUN_OWNERSHIP_ENV]: "detached",
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: socketPath,
			HERDR_WORKSPACE_ID: pane.workspace_id,
			HERDR_TAB_ID: pane.tab_id,
			HERDR_PANE_ID: pane.pane_id,
			PI_SUBAGENT_MANAGED_TITLE: "Worker",
		};
		child = spawn(process.execPath, ["-e", childProgram()], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
		const stdout = child.stdout!;
		stdout.setEncoding("utf8");
		let stdoutBuffer = "";
		let stdoutBytes = 0;
		let stdoutLines = 0;
		stdout.on("data", (chunk: string) => {
			if (channelError) return;
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes > 4_096) return failChannel(new Error("Child lifecycle stdout exceeded its byte bound"));
			stdoutBuffer += chunk;
			for (let newline = stdoutBuffer.indexOf("\n"); newline >= 0; newline = stdoutBuffer.indexOf("\n")) {
				if (++stdoutLines > 8) return failChannel(new Error("Child lifecycle stdout exceeded its line bound"));
				const line = stdoutBuffer.slice(0, newline);
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				publishLine(line);
			}
		});
		stdout.on("error", (error) => failChannel(error));
		stdoutClosed = new Promise((resolve) => {
			stdout.once("close", () => {
				if (stdoutBuffer.length > 0) failChannel(new Error("Child lifecycle stdout ended with a partial line"));
				resolve();
			});
		});
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => { if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length); });
		childClosed = new Promise((resolve) => {
			child!.once("error", (error) => { stderr += `${error.message}\n`; });
			child!.once("close", (code, signal) => { childFinished = true; resolve({ code, signal }); });
		});

		const next = async (method: string, params: Record<string, unknown>) => {
			const pending = await withTimeout(receive(), `${method} request`);
			assert.deepEqual(Object.keys(pending.request).sort(), ["id", "method", "params"]);
			assert.equal(pending.request.method, method);
			assert.deepEqual(pending.request.params, params);
			assert.match(pending.request.id, /^pi-subagent:/);
			return pending;
		};
		const nextLine = (label: string) => withTimeout(receiveLine(), label);
		const reply = (pending: PendingRequest, result: Record<string, unknown>) => {
			pending.socket.end(`${JSON.stringify({ id: pending.request.id, result })}\n`);
		};

		reply(await next("ping", {}), { type: "pong", protocol: 20 });
		reply(await next("pane.get", { pane_id: pane.pane_id }), { type: "pane_info", pane });
		const ready = await next("pane.report_metadata", {
			pane_id: pane.pane_id, source: `pi-subagent:${runId}`, applies_to_source: "herdr:pi", agent: "pi", seq: 1, ttl_ms: 120_000,
			title: "Worker", display_agent: "Pi", state_labels: { idle: "Ready", working: "Running", blocked: "Waiting", unknown: "Finished" },
			tokens: { run: runId, lifecycle: "ready" },
		});
		reply(ready, { type: "ok" });

		reply(await next("ping", {}), { type: "pong", protocol: 20 });
		reply(await next("pane.get", { pane_id: pane.pane_id }), { type: "pane_info", pane });
		const clear = await next("pane.report_metadata", {
			pane_id: pane.pane_id, source: `pi-subagent:${runId}`, applies_to_source: "herdr:pi", agent: "pi", seq: 2, ttl_ms: 120_000,
			clear_title: true, clear_display_agent: true, clear_state_labels: true, tokens: { run: null, lifecycle: null },
		});
		assert.equal(await nextLine("shutdown start milestone"), "shutdown-start");
		const heldLifecycle = await nextLine("held shutdown lifecycle milestone");
		assert.notEqual(heldLifecycle, "shutdown-settled", "session_shutdown returned before the held Herdr clear ACK");
		assert.equal(heldLifecycle, "shutdown-pending");
		assert.equal(child.exitCode, null, `child exited before the shutdown clear ACK: ${stderr}`);
		assert.equal(child.signalCode, null);
		reply(clear, { type: "ok" });

		assert.equal(await nextLine("shutdown completion milestone"), "shutdown-complete");
		const outcome = await withTimeout(childClosed, "clean child exit");
		assert.deepEqual(outcome, { code: 0, signal: null }, stderr);
		await withTimeout(stdoutClosed, "child stdout completion");
		await withTimeout(Promise.all(socketCompletions).then(() => undefined), "Herdr socket completion");
		assert.equal(queued.length, 0, "child sent an unexpected Herdr request");
		assert.equal(queuedLines.length, 0, "child sent an unexpected lifecycle milestone");
		assert.equal(channelError, null, String(channelError));
	} finally {
		if (child && !childFinished) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			if (childClosed) await withTimeout(childClosed, "failed child cleanup");
		}
		for (const socket of sockets) socket.destroy();
		await withTimeout(new Promise<void>((resolve) => server.close(() => resolve())), "Herdr fixture close");
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});
