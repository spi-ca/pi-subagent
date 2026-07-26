import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import childBridge, { readAssignedPhase0Barrier, registerChildBridge, registerPhase0LiveProviderProof } from "../../src/runtime/child-bridge";
import { derivePhase0LiveProofCapability, Phase0LiveProofServer } from "../../src/runtime/phase0-live-proof";
import { TREE_PERMIT_LEASE_ID_ENV, TREE_PERMIT_LEASE_TOKEN_ENV, TREE_PERMIT_MAX_ACTIVE_ENV, TREE_PERMIT_ROOT_ENV, TREE_PERMIT_ROOT_ID_ENV, TREE_PERMIT_TOKEN_ENV } from "../../src/runtime/tree-permit-authority";

const RELEASE_TOKEN = "c".repeat(64);
import {
	LifecycleEventServer,
	SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV,
	SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV,
	writeLifecycleBootstrapToken,
} from "../../src/runtime/lifecycle-socket";
import {
	RUN_PROTOCOL_VERSION,
	getCurrentProcessStartedAt,
	SUBAGENT_CHILD_SESSION_PATH_ENV,
	SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV,
	V3_FAILURE_BOUNDARY_CAPABILITY,
	SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV,
	V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY,
	SUBAGENT_LEASE_CHECK_MS_ENV,
	SUBAGENT_LEASE_STALE_MS_ENV,
	SUBAGENT_EXPECTED_PARENT_PID_ENV,
	SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
	SUBAGENT_FORK_BOOTSTRAP_PATH_ENV,
	SUBAGENT_PARENT_LEASE_PATH_ENV,
	SUBAGENT_RUN_COMPLETION_PATH_ENV,
	SUBAGENT_COMPLETION_FENCE_PATH_ENV,
	SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV,
	SUBAGENT_COMPLETION_FENCE_NONCE_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_RUN_OWNERSHIP_ENV,
	SUBAGENT_PROMOTION_REQUEST_PATH_ENV,
	SUBAGENT_PROMOTION_ACK_PATH_ENV,
	SUBAGENT_RUN_STATE_PATH_ENV,
	atomicWriteJson,
	parseCompletionAuthority,
	parseOwnershipTransferAck,
	parseRunState,
	prepareRunArtifactPaths,
	readJsonFile,
	publishImmutableJson,
} from "../../src/runtime/run-protocol";

const tempDirs: string[] = [];
const activeBridgeShutdowns: Array<() => Promise<void>> = [];
const lifecycleServers: LifecycleEventServer[] = [];
const savedEnv = { ...process.env };

afterEach(async () => {
	while (activeBridgeShutdowns.length > 0) await activeBridgeShutdowns.pop()!();
	while (lifecycleServers.length > 0) await lifecycleServers.pop()!.close().catch(() => undefined);
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
	while (tempDirs.length > 0) await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function setupBridge(runId: string, options: {
	isProcessIdentityAlive?: (pid: number, startedAt: number) => boolean;
	classifyParentProcessIdentity?: (pid: number, startedAt: number, probeOptions?: { timeoutMs?: number }) => "live" | "dead" | "unknown";
	monotonicNow?: () => number;
	readLease?: (filePath: string) => Promise<unknown | null>;
	title?: string;
	hasUI?: boolean;
	publishPromotionAck?: (filePath: string, value: unknown) => Promise<"published" | "exists">;
	readPromotionAck?: (filePath: string) => Promise<unknown | null>;
	readCompletionFence?: (filePath: string) => Promise<unknown | null>;
	readCompletionFenceAck?: (filePath: string) => Promise<{ outcome: "missing" } | { outcome: "valid"; value: Record<string, unknown> } | { outcome: "invalid" }>;
	beforePromotionAckPublication?: () => Promise<void>;
	releaseInheritedTreePermit?: () => Promise<boolean>;
	completionFence?: boolean;
	leaseStaleMs?: number;
	expectedParent?: { pid: number; startedAt: number };
	failureBoundaryCapability?: boolean;
	metadataTailSuccessBoundaryCapability?: boolean;
} = {}) {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-bridge-"));
	tempDirs.push(root);
	const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
	process.env[SUBAGENT_RUN_ID_ENV] = runId;
	process.env[SUBAGENT_RUN_STATE_PATH_ENV] = paths.statePath;
	process.env[SUBAGENT_RUN_COMPLETION_PATH_ENV] = paths.completionPath;
	if (options.completionFence) {
		process.env[SUBAGENT_COMPLETION_FENCE_PATH_ENV] = paths.completionFencePath;
		process.env[SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV] = paths.completionFenceAckPath;
		process.env[SUBAGENT_COMPLETION_FENCE_NONCE_ENV] = "d".repeat(64);
	} else {
		delete process.env[SUBAGENT_COMPLETION_FENCE_PATH_ENV]; delete process.env[SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV]; delete process.env[SUBAGENT_COMPLETION_FENCE_NONCE_ENV];
	}
	process.env[SUBAGENT_PARENT_LEASE_PATH_ENV] = paths.parentLeasePath;
	process.env[SUBAGENT_CHILD_SESSION_PATH_ENV] = paths.childSessionPath;
	process.env[SUBAGENT_RUN_OWNERSHIP_ENV] = "parent-owned";
	process.env[SUBAGENT_PROMOTION_REQUEST_PATH_ENV] = paths.promotionRequestPath;
	process.env[SUBAGENT_PROMOTION_ACK_PATH_ENV] = paths.promotionAckPath;
	if (options.failureBoundaryCapability === false) delete process.env[SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV];
	else process.env[SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV] = V3_FAILURE_BOUNDARY_CAPABILITY;
	if (options.metadataTailSuccessBoundaryCapability) process.env[SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV] = V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY;
	else delete process.env[SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV];
	const expectedParent = options.expectedParent ?? { pid: process.pid, startedAt: getCurrentProcessStartedAt()! };
	process.env[SUBAGENT_EXPECTED_PARENT_PID_ENV] = String(expectedParent.pid);
	process.env[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV] = String(expectedParent.startedAt);
	process.env[SUBAGENT_LEASE_STALE_MS_ENV] = String(options.leaseStaleMs ?? 100);
	process.env[SUBAGENT_LEASE_CHECK_MS_ENV] = "20";
	// Unit tests model a legacy launch unless they explicitly install an exact
	// inherited tree capability for this bridge process.
	for (const name of [TREE_PERMIT_ROOT_ENV, TREE_PERMIT_ROOT_ID_ENV, TREE_PERMIT_TOKEN_ENV, TREE_PERMIT_MAX_ACTIVE_ENV, TREE_PERMIT_LEASE_ID_ENV, TREE_PERMIT_LEASE_TOKEN_ENV]) delete process.env[name];
	if (options.title === undefined) delete process.env.PI_SUBAGENT_MANAGED_TITLE;
	else process.env.PI_SUBAGENT_MANAGED_TITLE = options.title;
	await fs.promises.writeFile(paths.childSessionPath, `${JSON.stringify({ type: "message", id: `entry-${runId}`, timestamp: new Date().toISOString(), message: assistant("stop") })}\n`, { mode: 0o600 });
	await atomicWriteJson(paths.parentLeasePath, {
		version: RUN_PROTOCOL_VERSION,
		runId,
		parentPid: expectedParent.pid,
		parentStartedAt: expectedParent.startedAt,
		renewedAt: Date.now(),
	});

	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => any }>();
	const tools = new Map<string, any>();
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => any) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => any }) { commands.set(name, command); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
	};
	registerChildBridge(pi as any, options);
	const lifecycle = { aborted: false, shutdown: false };
	const titles: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		abort: () => { lifecycle.aborted = true; },
		shutdown: () => { lifecycle.shutdown = true; },
		waitForIdle: async () => undefined,
		hasUI: options.hasUI ?? false,
		ui: { setTitle: (title: string) => { titles.push(title); }, notify: (message: string, level: string) => { notifications.push({ message, level }); } },
	};
	const emit = async (event: string, payload: any = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	activeBridgeShutdowns.push(async () => { if (!lifecycle.shutdown) await emit("session_shutdown"); });
	return { paths, handlers, commands, tools, lifecycle, titles, notifications, ctx, emit };
}

function completionError(value: ReturnType<typeof parseCompletionAuthority>): string | undefined {
	return value && "errorCode" in value ? value.errorCode : undefined;
}

function assistant(stopReason: string, text = "DONE") {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		stopReason,
	};
}

describe("child lifecycle bridge", () => {
	test("replaces read with the assigned FIFO-only tool and proves only after its successful provider-bound execution", async () => {
		const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-phase0-proof-")));
		tempDirs.push(root);
		await fs.promises.chmod(root, 0o700);
		const barrier = path.join(root, "barrier-0"), auth = path.join(root, "auth.json");
		assert.equal(spawnSync("/usr/bin/mkfifo", [barrier]).status, 0); await fs.promises.chmod(barrier, 0o600);
		await fs.promises.writeFile(auth, "copied-auth-must-not-be-readable", { mode: 0o600 });
		const server = await Phase0LiveProofServer.start(root, "b".repeat(64));
		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>(), tools = new Map<string, any>();
		const pi = { on(event: string, handler: (event: any, ctx: any) => any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, registerTool(tool: any) { tools.set(tool.name, tool); } };
		process.env.PI_SUBAGENT_PHASE0_LIVE = "1";
		process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_SOCKET = server.socketPath;
		process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_ID = "a".repeat(32);
		process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_CAPABILITY = "b9c4ca83c13d60d973eee080ff34ab0903be70ba9bc496940c2e256da6d20a63";
		process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_BARRIER_PATH = barrier;
		process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_TOKEN = RELEASE_TOKEN;
		process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_DEADLINE = String(Date.now() + 10_000);
		process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_BEHAVIOR = "short";
		const client = registerPhase0LiveProviderProof(pi as any, process.env);
		assert.equal(process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_SOCKET, undefined);
		assert.equal(process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_ID, undefined);
		assert.equal(process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_CAPABILITY, undefined);
		assert.equal(process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_BARRIER_PATH, undefined);
		assert.equal(process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_TOKEN, undefined);
		assert.equal(process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_DEADLINE, undefined);
		assert.equal(process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_BEHAVIOR, undefined);
		assert.deepEqual([...tools.keys()], ["read"]);
		await client!.start();
		for (const handler of handlers.get("message_end") ?? []) await handler({ message: { role: "assistant", provider: "openai-codex", model: "gpt-5.4-mini", content: [{ type: "toolCall", name: "read" }] } }, {});
		await assert.rejects(() => tools.get("read").execute("bad", { path: auth }, undefined, undefined, {}));
		assert.deepEqual(server.identities(), [], "a rejected copied auth read must not publish proof");
		const success = tools.get("read").execute("ok", { path: barrier }, undefined, undefined, {});
		assert.deepEqual(await server.waitForReadStarts(1, 500), [{ pid: process.pid, startedAt: getCurrentProcessStartedAt() }]);
		assert.deepEqual(server.identities(), [], "a blocked read-start must not be accepted as a successful proof");
		const release = fs.promises.writeFile(barrier, `${RELEASE_TOKEN}\n`);
		await success; await release;
		assert.deepEqual(await server.waitForProofs(1, 500), [{ pid: process.pid, startedAt: getCurrentProcessStartedAt() }]);
		client!.close(); await server.close();
	});

	test("reports one authenticated redacted terminal category before read-start and never while blocked in a read", async () => {
		const master = "b".repeat(64);
		let index = 0;
		const createPhaseBridge = async () => {
			const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-phase0-terminal-")));
			tempDirs.push(root); await fs.promises.chmod(root, 0o700);
			const barrier = path.join(root, "barrier-0");
			assert.equal(spawnSync("/usr/bin/mkfifo", [barrier]).status, 0); await fs.promises.chmod(barrier, 0o600);
			const server = await Phase0LiveProofServer.start(root, master), proofId = (++index).toString(16).padStart(32, "0");
			process.env.PI_SUBAGENT_PHASE0_LIVE = "1";
			process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_SOCKET = server.socketPath;
			process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_ID = proofId;
			process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_CAPABILITY = derivePhase0LiveProofCapability(master, proofId);
			process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_BARRIER_PATH = barrier;
			process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_TOKEN = RELEASE_TOKEN;
			process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_RELEASE_DEADLINE = String(Date.now() + 10_000);
			process.env.PI_SUBAGENT_PHASE0_LIVE_PROOF_BEHAVIOR = "short";
			return { bridge: await setupBridge(`phase0-terminal-${index}`), server, barrier };
		};
		const waitForTerminal = async (server: Phase0LiveProofServer, category: "provider-error" | "settled-before-read" | "shutdown-before-read") => {
			for (let attempt = 0; attempt < 50; attempt += 1) {
				if (server.terminalCounts()[category] === 1) return;
				await new Promise((resolve) => setTimeout(resolve, 2));
			}
			assert.fail(`terminal category ${category} was not received`);
		};

		const providerError = await createPhaseBridge();
		await providerError.bridge.emit("session_start"); await providerError.bridge.emit("agent_start");
		await providerError.bridge.emit("agent_end", { messages: [assistant("error")] });
		await waitForTerminal(providerError.server, "provider-error");
		assert.deepEqual(providerError.server.terminalCounts(), { "provider-error": 1, "settled-before-read": 0, "shutdown-before-read": 0, "aborted-before-read": 0 });
		await assert.rejects(() => providerError.server.waitForReadStarts(1, 500), /no remaining authenticated read-start possibility/);
		await providerError.server.close();

		const settled = await createPhaseBridge();
		await settled.bridge.emit("session_start"); await settled.bridge.emit("agent_start");
		await settled.bridge.emit("agent_end", { messages: [assistant("stop")] });
		await waitForTerminal(settled.server, "settled-before-read");
		assert.deepEqual(settled.server.terminalCounts(), { "provider-error": 0, "settled-before-read": 1, "shutdown-before-read": 0, "aborted-before-read": 0 });
		await settled.server.close();

		const shutdown = await createPhaseBridge();
		await shutdown.bridge.emit("session_start"); await shutdown.bridge.emit("session_shutdown");
		await waitForTerminal(shutdown.server, "shutdown-before-read");
		assert.deepEqual(shutdown.server.terminalCounts(), { "provider-error": 0, "settled-before-read": 0, "shutdown-before-read": 1, "aborted-before-read": 0 });
		await shutdown.server.close();

		const blocked = await createPhaseBridge(), abort = new AbortController();
		await blocked.bridge.emit("session_start"); await blocked.bridge.emit("agent_start");
		const pendingRead = blocked.bridge.tools.get("read").execute("blocked", { path: blocked.barrier }, abort.signal, undefined, {});
		await blocked.server.waitForReadStarts(1, 500);
		await blocked.bridge.emit("agent_end", { messages: [assistant("error")] });
		assert.deepEqual(blocked.server.terminalCounts(), { "provider-error": 0, "settled-before-read": 0, "shutdown-before-read": 0, "aborted-before-read": 0 });
		abort.abort(); await assert.rejects(() => pendingRead, /Operation aborted/);
		await blocked.bridge.emit("session_shutdown");
		assert.deepEqual(blocked.server.terminalCounts(), { "provider-error": 0, "settled-before-read": 0, "shutdown-before-read": 0, "aborted-before-read": 0 });
		await blocked.server.close();
	});

	test("uses the controller deadline for a >1s staggered exact release and closes it on abort", async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-phase0-fifo-race-")));
		tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const barrier = path.join(root, "barrier"), exactBytes = Buffer.from(`${RELEASE_TOKEN}\n`);
		assert.equal(spawnSync("/usr/bin/mkfifo", [barrier]).status, 0); await fs.promises.chmod(barrier, 0o600);
		let readStarted!: () => void;
		const started = new Promise<void>((resolve) => { readStarted = resolve; });
		let settled = false;
		const read = readAssignedPhase0Barrier(barrier, barrier, RELEASE_TOKEN, Date.now() + 10_000, undefined, readStarted).finally(() => { settled = true; });
		await started;
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		assert.equal(settled, false, "the controller deadline, not a fixed 1s read timeout, keeps the validated FIFO pending");
		await fs.promises.writeFile(barrier, exactBytes);
		assert.equal(await read, exactBytes.length);

		const aborted = new AbortController();
		let abortedReadStarted!: () => void;
		const abortedStarted = new Promise<void>((resolve) => { abortedReadStarted = resolve; });
		const blockedRead = readAssignedPhase0Barrier(barrier, barrier, RELEASE_TOKEN, Date.now() + 10_000, aborted.signal, abortedReadStarted);
		await abortedStarted;
		aborted.abort();
		await assert.rejects(() => blockedRead, /Operation aborted/);
		await assert.rejects(
			() => fs.promises.open(barrier, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW),
			(error: NodeJS.ErrnoException) => error.code === "ENXIO",
			"the aborted read must close its FIFO descriptor",
		);
	});

	test("fails a blocked exact FIFO read at its absolute controller deadline", async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-phase0-deadline-")));
		tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const barrier = path.join(root, "barrier");
		assert.equal(spawnSync("/usr/bin/mkfifo", [barrier]).status, 0); await fs.promises.chmod(barrier, 0o600);
		let announce!: () => void; const started = new Promise<void>((resolve) => { announce = resolve; });
		const read = readAssignedPhase0Barrier(barrier, barrier, RELEASE_TOKEN, Date.now() + 40, undefined, announce);
		await started;
		await assert.rejects(() => read, /release deadline/);
		await assert.rejects(
			() => fs.promises.open(barrier, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW),
			(error: NodeJS.ErrnoException) => error.code === "ENXIO",
			"the deadline-expired read must close its FIFO descriptor",
		);
	});

	test("rejects wrong, truncated, extra, and accepts fragmented exact release frames", async () => {
		const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-phase0-release-")));
		tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const fifo = async (name: string) => { const value = path.join(root, name); assert.equal(spawnSync("/usr/bin/mkfifo", [value]).status, 0); await fs.promises.chmod(value, 0o600); return value; };
		const start = async (barrier: string, expected = RELEASE_TOKEN, releaseDeadline = Date.now() + 200) => {
			let notify!: () => void; const started = new Promise<void>((resolve) => { notify = resolve; });
			const read = readAssignedPhase0Barrier(barrier, barrier, expected, releaseDeadline, undefined, notify); await started; return { read };
		};
		const wrong = await fifo("wrong"), { read: wrongRead } = await start(wrong); await fs.promises.writeFile(wrong, `${"d".repeat(64)}\n`); await assert.rejects(() => wrongRead, /does not match/);
		const truncated = await fifo("truncated"), { read: truncatedRead } = await start(truncated); await fs.promises.writeFile(truncated, RELEASE_TOKEN.slice(0, -1)); await assert.rejects(() => truncatedRead, /truncated/);
		const extra = await fifo("extra"), { read: extraRead } = await start(extra); await fs.promises.writeFile(extra, `${RELEASE_TOKEN}\nextra`); await assert.rejects(() => extraRead, /extra bytes/);
		const fragmented = await fifo("fragmented"), { read: fragmentedRead } = await start(fragmented, RELEASE_TOKEN, Date.now() + 10_000); await fs.promises.writeFile(fragmented, RELEASE_TOKEN.slice(0, 17)); await new Promise((resolve) => setTimeout(resolve, 20)); await fs.promises.writeFile(fragmented, `${RELEASE_TOKEN.slice(17)}\n`); assert.equal(await fragmentedRead, 65);
	});

	test("rejects Phase 0 auth, sibling, relative, symlink, and regular-file read paths", async () => {
		const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-phase0-barrier-")));
		tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const barrier = path.join(root, "barrier"), sibling = path.join(root, "sibling"), regular = path.join(root, "regular"), auth = path.join(root, "auth.json"), link = path.join(root, "link");
		for (const fifo of [barrier, sibling]) { assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0); await fs.promises.chmod(fifo, 0o600); }
		await fs.promises.writeFile(regular, "not a fifo", { mode: 0o600 }); await fs.promises.writeFile(auth, "credential", { mode: 0o600 }); await fs.promises.symlink(barrier, link);
		for (const requested of [auth, sibling, "barrier", "../barrier"]) await assert.rejects(() => readAssignedPhase0Barrier(barrier, requested, RELEASE_TOKEN, Date.now() + 10_000));
		await assert.rejects(() => readAssignedPhase0Barrier(link, link, RELEASE_TOKEN, Date.now() + 10_000));
		await assert.rejects(() => readAssignedPhase0Barrier(regular, regular, RELEASE_TOKEN, Date.now() + 10_000));
	});

	test("is a no-op when it is inherited without run protocol environment", () => {
		delete process.env[SUBAGENT_RUN_ID_ENV];
		let registrations = 0;
		childBridge({ on: () => { registrations += 1; } } as any);
		assert.equal(registrations, 0);
	});

	test("consumes failed fork bootstrap input before an agent can start", async () => {
		process.env[SUBAGENT_FORK_BOOTSTRAP_PATH_ENV] = "/private/invalid/bootstrap.json";
		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const pi = { on(event: string, handler: (event: any, ctx: any) => any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } };
		registerChildBridge(pi as any, { verifyForkBootstrap: async () => { throw new Error("invalid"); } });
		const lifecycle = { aborted: false, shutdown: false };
		const ctx = { abort: () => { lifecycle.aborted = true; }, shutdown: () => { lifecycle.shutdown = true; } };
		const input = await handlers.get("input")![0]!({}, ctx);
		assert.deepEqual(input, { action: "handled" });
		assert.equal(lifecycle.aborted, true); assert.equal(lifecycle.shutdown, true);
	});

	test("updates the UI title through child lifecycle transitions without accepting malformed titles", async () => {
		const title = "worker [depth=1;run=runtitle]";
		const completed = await setupBridge("run-title-completed", { title, hasUI: true });
		await completed.emit("session_start");
		await completed.emit("agent_start");
		await completed.emit("agent_end", { messages: [assistant("stop")] });
		await completed.emit("agent_settled");
		assert.deepEqual(completed.titles, [`${title} · ready`, `${title} · running`, `${title} · waiting`, `${title} · returning`]);

		const failed = await setupBridge("run-title-failed", { title, hasUI: true });
		await failed.emit("session_start");
		await failed.emit("agent_start");
		await failed.emit("agent_end", { messages: [assistant("error")] });
		await failed.emit("agent_settled");
		assert.equal(failed.titles.at(-1), `${title} · failed`);

		const aborted = await setupBridge("run-title-aborted", { title, hasUI: true });
		await aborted.emit("session_start");
		await aborted.emit("agent_start");
		await aborted.emit("agent_end", { messages: [assistant("aborted", "")] });
		await aborted.emit("agent_settled");
		assert.equal(aborted.titles.at(-1), `${title} · waiting`);

		const malformed = await setupBridge("run-title-malformed", { title: `${title}\x1b`, hasUI: true });
		await malformed.emit("session_start");
		assert.deepEqual(malformed.titles, []);

		const noSuffixRoom = await setupBridge("run-title-too-long", { title: "x".repeat(85), hasUI: true });
		await noSuffixRoom.emit("session_start");
		assert.deepEqual(noSuffixRoom.titles, []);
	});

	test("waits for an exact completion-fence ACK before capturing completion", async () => {
		const bridge = await setupBridge("run-completion-fence", { completionFence: true });
		await bridge.emit("session_start"); await bridge.emit("agent_start"); await bridge.emit("agent_end", { messages: [assistant("stop")] });
		const settled = bridge.emit("agent_settled");
		while (!fs.existsSync(bridge.paths.completionFencePath)) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.equal(await readJsonFile(bridge.paths.completionPath), null, "boundary waits for ACK");
		await publishImmutableJson(bridge.paths.completionFenceAckPath, { version: 1, kind: "completion-fence-ack", runId: "run-completion-fence", nonce: "d".repeat(64), acknowledgedAt: Date.now() });
		await settled;
		assert.equal(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-completion-fence")?.status, "completed");
	});

	test("falls back boundary-less when a live parent does not ACK before the fence deadline", async () => {
		const bridge = await setupBridge("run-completion-fence-stale-lease", { completionFence: true, leaseStaleMs: 100, isProcessIdentityAlive: () => true });
		await bridge.emit("session_start"); await bridge.emit("agent_start"); await bridge.emit("agent_end", { messages: [assistant("stop")] });
		const settled = bridge.emit("agent_settled");
		while (!fs.existsSync(bridge.paths.completionFencePath)) await new Promise((resolve) => setTimeout(resolve, 1));
		await settled;
		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-completion-fence-stale-lease");
		assert.equal(completion?.status, "failed");
		assert.equal(completionError(completion), "bridge-error");
		assert.equal(completion && "session" in completion, false);
	});

	test("does not let fresh lease renewal authorize a boundary after the unacknowledged fence deadline", async () => {
		const runId = "run-completion-fence-fresh-lease";
		const bridge = await setupBridge(runId, { completionFence: true, leaseStaleMs: 100, isProcessIdentityAlive: () => true });
		await bridge.emit("session_start"); await bridge.emit("agent_start"); await bridge.emit("agent_end", { messages: [assistant("stop")] });
		const settled = bridge.emit("agent_settled");
		while (!fs.existsSync(bridge.paths.completionFencePath)) await new Promise((resolve) => setTimeout(resolve, 1));
		const parentStartedAt = getCurrentProcessStartedAt()!;
		const renew = setInterval(() => {
			void atomicWriteJson(bridge.paths.parentLeasePath, { version: RUN_PROTOCOL_VERSION, runId, parentPid: process.pid, parentStartedAt, renewedAt: Date.now() });
		}, 20);
		try {
			await settled;
		} finally {
			clearInterval(renew);
		}
		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), runId);
		assert.equal(completion?.status, "failed");
		assert.equal(completionError(completion), "bridge-error");
		assert.equal(completion && "session" in completion, false);
	});

	test("bounds an uncertain parent identity probe by the completion-fence ACK deadline", async () => {
		const probeBudgets: number[] = [];
		const bridge = await setupBridge("run-completion-fence-bounded-identity", {
			completionFence: true, leaseStaleMs: 100, isProcessIdentityAlive: () => true,
			classifyParentProcessIdentity: (_pid, _startedAt, probeOptions) => {
				const timeoutMs = probeOptions?.timeoutMs;
				assert.ok(timeoutMs && timeoutMs > 0 && timeoutMs <= 100, "the exact-parent probe receives only the remaining ACK budget");
				probeBudgets.push(timeoutMs);
				const delayUntil = Date.now() + Math.min(timeoutMs, 15);
				while (Date.now() < delayUntil) { /* simulate a bounded Darwin probe that times out uncertain */ }
				return "unknown";
			},
		});
		await bridge.emit("session_start"); await bridge.emit("agent_start"); await bridge.emit("agent_end", { messages: [assistant("stop")] });
		const started = Date.now();
		await bridge.emit("agent_settled");
		assert.ok(probeBudgets.length > 0);
		assert.ok(Date.now() - started < 300, "an uncertain parent probe cannot overrun the ACK deadline");
		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-completion-fence-bounded-identity");
		assert.equal(completion?.status, "failed");
		assert.equal(completionError(completion), "bridge-error");
		assert.equal(completion && "session" in completion, false);
	});

	test("does not let an unresolving lease read hold completion-fence ACK wait", async () => {
		let reads = 0;
		const bridge = await setupBridge("run-completion-fence-blocked-read", {
			completionFence: true, leaseStaleMs: 100, isProcessIdentityAlive: () => true,
			readLease: async (filePath) => ++reads === 1
				? await readJsonFile(filePath)
				: await new Promise<never>(() => undefined),
		});
		await bridge.emit("session_start"); await bridge.emit("agent_start"); await bridge.emit("agent_end", { messages: [assistant("stop")] });
		const started = Date.now();
		await bridge.emit("agent_settled");
		assert.ok(Date.now() - started < 500, "ACK wait must use the fence deadline rather than the stalled lease read");
		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-completion-fence-blocked-read");
		assert.equal(completionError(completion), "bridge-error");
		assert.equal(completion && "session" in completion, false);
	});

	test("settles a never-resolving ACK artifact read through the boundary-less deadline fallback", async () => {
		const bridge = await setupBridge("run-completion-fence-blocked-ack-read", {
			completionFence: true, leaseStaleMs: 100, isProcessIdentityAlive: () => true,
			readCompletionFenceAck: async () => await new Promise<never>(() => undefined),
		});
		await bridge.emit("session_start"); await bridge.emit("agent_start"); await bridge.emit("agent_end", { messages: [assistant("stop")] });
		const started = Date.now();
		await bridge.emit("agent_settled");
		assert.ok(Date.now() - started < 500, "the ACK artifact deadline must bound a stalled read/open/lstat");
		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-completion-fence-blocked-ack-read");
		assert.equal(completion?.status, "failed");
		assert.equal(completionError(completion), "bridge-error");
		assert.equal(completion && "session" in completion, false);
	});

	test("fences a late periodic lease read and finishes orphan recovery once", async () => {
		let resolveLease!: (value: unknown | null) => void;
		const lateLease = new Promise<unknown | null>((resolve) => { resolveLease = resolve; });
		const bridge = await setupBridge("run-periodic-lease-read-timeout", {
			leaseStaleMs: 100, isProcessIdentityAlive: () => true,
			readLease: async () => await lateLease,
		});
		const started = Date.now();
		await bridge.emit("session_start");
		assert.ok(Date.now() - started < 500, "the initial checker must settle at its stale deadline");
		assert.equal(completionError(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-periodic-lease-read-timeout")), "lease-expired");
		resolveLease({ version: RUN_PROTOCOL_VERSION, runId: "run-periodic-lease-read-timeout", parentPid: process.pid, parentStartedAt: getCurrentProcessStartedAt()!, renewedAt: Date.now() });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(completionError(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-periodic-lease-read-timeout")), "lease-expired", "late read results cannot reopen the orphaned bridge");
		assert.equal(bridge.lifecycle.aborted, true);
	});

	test("does not inherit completion-fence or boundary-negotiation capabilities into subprocesses", async () => {
		await setupBridge("run-completion-fence-env", { completionFence: true, metadataTailSuccessBoundaryCapability: true });
		const names = [SUBAGENT_COMPLETION_FENCE_PATH_ENV, SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV, SUBAGENT_COMPLETION_FENCE_NONCE_ENV, SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV, SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV];
		for (const name of names) assert.equal(process.env[name], undefined);
		const inspect = "const keys=JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((key)=>[key,process.env[key]??null]))));";
		const nested = `const {spawnSync}=require("node:child_process"); const keys=process.argv[1]; const outer=Object.fromEntries(JSON.parse(keys).map((key)=>[key,process.env[key]??null])); const child=spawnSync(process.execPath,["-e",${JSON.stringify(inspect)},keys],{encoding:"utf8"}); if(child.status!==0) process.exit(child.status??1); process.stdout.write(JSON.stringify({outer,nested:JSON.parse(child.stdout)}));`;
		const probe = spawnSync(process.execPath, ["-e", nested, JSON.stringify(names)], { encoding: "utf8" });
		assert.equal(probe.status, 0, probe.stderr);
		const observed = JSON.parse(probe.stdout) as { outer: Record<string, string | null>; nested: Record<string, string | null> };
		for (const name of names) {
			assert.equal(observed.outer[name], null, `subprocess inherited ${name}`);
			assert.equal(observed.nested[name], null, `nested subprocess inherited ${name}`);
		}
	});

	test("fails closed with a boundary-less bridge error for a malformed completion ACK", async () => {
		const bridge = await setupBridge("run-completion-fence-malformed", { completionFence: true });
		await fs.promises.writeFile(bridge.paths.completionFenceAckPath, "{bad}\n", { mode: 0o600 });
		await bridge.emit("session_start"); await bridge.emit("agent_start"); await bridge.emit("agent_end", { messages: [assistant("stop")] }); await bridge.emit("agent_settled");
		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-completion-fence-malformed");
		assert.equal(completion?.status, "failed");
		assert.equal(completionError(completion), "bridge-error");
		assert.equal(completion && "session" in completion, false);
	});

	test("negotiates Pi 0.81 success metadata tails for rolling parents", async () => {
		const legacy = await setupBridge("run-legacy-success-tail");
		const modern = await setupBridge("run-modern-success-tail", { metadataTailSuccessBoundaryCapability: true });
		const usage = { input: 4, output: 1, totalTokens: 5 };
		// The fixture's assistant IDs derive from each run ID, so link each
		// metadata tail to its exact final assistant.
		await fs.promises.writeFile(legacy.paths.childSessionPath, `${JSON.stringify({ type: "message", id: "entry-run-legacy-success-tail", timestamp: new Date().toISOString(), message: assistant("stop") })}\n${JSON.stringify({ type: "compaction", id: "compact-legacy", parentId: "entry-run-legacy-success-tail", timestamp: "2026-07-21T00:00:00.000Z", summary: "compact", tokensBefore: 9, retainedTail: [], usage })}\n`, { mode: 0o600 });
		await fs.promises.writeFile(modern.paths.childSessionPath, `${JSON.stringify({ type: "message", id: "entry-run-modern-success-tail", timestamp: new Date().toISOString(), message: assistant("stop") })}\n${JSON.stringify({ type: "compaction", id: "compact-modern", parentId: "entry-run-modern-success-tail", timestamp: "2026-07-21T00:00:00.000Z", summary: "compact", tokensBefore: 9, retainedTail: [], usage })}\n`, { mode: 0o600 });
		for (const bridge of [legacy, modern]) {
			await bridge.emit("session_start"); await bridge.emit("agent_start"); await bridge.emit("agent_end", { messages: [assistant("stop")] }); await bridge.emit("agent_settled");
		}
		const legacyCompletion = parseCompletionAuthority(await readJsonFile(legacy.paths.completionPath), "run-legacy-success-tail");
		const modernCompletion = parseCompletionAuthority(await readJsonFile(modern.paths.completionPath), "run-modern-success-tail");
		assert.equal(legacyCompletion && "session" in legacyCompletion ? legacyCompletion.session.finalEntryId : undefined, "entry-run-legacy-success-tail");
		assert.equal(modernCompletion && "session" in modernCompletion ? modernCompletion.session.finalEntryId : undefined, "compact-modern");
		assert.ok(legacyCompletion && "session" in legacyCompletion && modernCompletion && "session" in modernCompletion);
		const legacyBytes = await fs.promises.readFile(legacy.paths.childSessionPath);
		const modernBytes = await fs.promises.readFile(modern.paths.childSessionPath);
		assert.equal(legacyCompletion.session.byteOffset, legacyBytes.indexOf(0x0a) + 1, "legacy success ends at the assistant line");
		assert.equal(modernCompletion.session.byteOffset, modernBytes.length, "new parent binds the linked metadata and its usage");
		assert.ok(legacyCompletion.session.byteOffset < modernCompletion.session.byteOffset, "legacy success excludes post-assistant usage metadata");
	});

	test("completes settled turns", async () => {
		const bridge = await setupBridge("run-complete");
		await bridge.emit("session_start", { reason: "startup" });
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("stop")] });
		await bridge.emit("agent_settled");

		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-complete");
		assert.equal(completion?.status, "completed");
		assert.equal(completion?.version, 3);
		assert.equal(completion && "producer" in completion ? completion.producer : undefined, "child");
		assert.equal(completion && "session" in completion ? completion.session.finalEntryId : undefined, "entry-run-complete");
		assert.equal(bridge.lifecycle.shutdown, true);
		assert.equal(bridge.lifecycle.aborted, false);
	});

	test("emits completion-ready only after durable abnormal-boundary publication", async () => {
		const bridge = await setupBridge("run-lifecycle");
		const server = await LifecycleEventServer.start();
		lifecycleServers.push(server);
		const token = server.registerRun("run-lifecycle");
		await writeLifecycleBootstrapToken(bridge.paths.lifecycleTokenPath, token);
		server.activateRun("run-lifecycle");
		process.env[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV] = server.socketPath;
		process.env[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV] = bridge.paths.lifecycleTokenPath;
		await bridge.emit("session_start");
		for (let attempt = 0; attempt < 20 && !server.isConnected("run-lifecycle"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(server.isConnected("run-lifecycle"), true);
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("error")] });
		const completionHint = server.waitForEvent("run-lifecycle", 250);
		await bridge.emit("agent_settled");
		await completionHint;
		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-lifecycle");
		assert.equal(completion?.version, 3);
		assert.equal(completion && "session" in completion ? completion.session.finalEntryId : undefined, "entry-run-lifecycle");
		assert.equal(fs.existsSync(bridge.paths.lifecycleTokenPath), false);
		assert.equal(process.env[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV], undefined);
	});

	test("publishes boundary-less failure records without the parent capability", async () => {
		const bridge = await setupBridge("run-legacy-failure", { failureBoundaryCapability: false });
		await bridge.emit("session_start");
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("error")] });
		await bridge.emit("agent_settled");
		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-legacy-failure");
		assert.equal(completion?.status, "failed");
		assert.equal(completion && "session" in completion, false, "an older strict parent can parse the legacy V3 shape");
	});

	test("records provider errors without copying raw error text", async () => {
		const bridge = await setupBridge("run-error");
		await bridge.emit("session_start");
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [{ ...assistant("error"), errorMessage: "untrusted provider output" }] });
		await bridge.emit("agent_settled");

		const raw = await readJsonFile(bridge.paths.completionPath) as Record<string, unknown>;
		assert.equal(raw.status, "failed");
		assert.equal(raw.errorCode, "child-error");
		assert.equal((raw.session as { finalEntryId?: string } | undefined)?.finalEntryId, "entry-run-error");
		assert.equal(JSON.stringify(raw).includes("untrusted provider output"), false);
	});

	test("falls back to a generic session boundary when nominal success evidence is unavailable", async () => {
		const bridge = await setupBridge("run-success-generic-fallback");
		await fs.promises.writeFile(bridge.paths.childSessionPath, `${JSON.stringify({ type: "session", id: "header" })}\n`, { mode: 0o600 });
		await bridge.emit("session_start");
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("stop")] });
		await bridge.emit("agent_settled");

		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-success-generic-fallback");
		assert.equal(completion?.status, "failed");
		assert.equal(completion && "errorCode" in completion ? completion.errorCode : undefined, "bridge-error");
		assert.equal(completion && "stopReason" in completion ? completion.stopReason : undefined, "completion-boundary-unproven");
		assert.equal(completion && "session" in completion ? completion.session.finalEntryId : undefined, "header");
	});

	test("uses the boundary-less V3 failure fallback when the session contains malformed UTF-8", async () => {
		const bridge = await setupBridge("run-malformed-utf8");
		await fs.promises.writeFile(bridge.paths.childSessionPath, Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]), { mode: 0o600 });
		await bridge.emit("session_start");
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("error")] });
		await bridge.emit("agent_settled");

		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-malformed-utf8");
		assert.equal(completion?.status, "failed");
		assert.equal(completion && "errorCode" in completion ? completion.errorCode : undefined, "child-error");
		assert.equal(completion && "session" in completion, false);
	});

	test("publishes the boundary-less V3 failure record when boundary capture faults", async () => {
		const bridge = await setupBridge("run-boundary-capture-fault");
		await bridge.emit("session_start");
		await bridge.emit("agent_start");
		await fs.promises.rm(bridge.paths.childSessionPath);
		await bridge.emit("agent_end", { messages: [assistant("error")] });
		await bridge.emit("agent_settled");

		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-boundary-capture-fault");
		assert.equal(completion?.status, "failed");
		assert.equal(completion && "errorCode" in completion ? completion.errorCode : undefined, "child-error");
		assert.equal(completion && "session" in completion, false);
	});

	test("publishes immutable completion when the terminal state write faults", async () => {
		const bridge = await setupBridge("run-state-fault");
		await bridge.emit("session_start");
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("stop")] });
		await fs.promises.rm(bridge.paths.statePath, { force: true });
		await fs.promises.mkdir(bridge.paths.statePath);
		await bridge.emit("agent_settled");

		assert.equal(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-state-fault")?.status, "completed");
		assert.equal(bridge.lifecycle.shutdown, true);
	});

	test("does not complete an aborted turn", async () => {
		const bridge = await setupBridge("run-aborted-turn");
		await bridge.emit("session_start");
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("aborted", "")] });
		await bridge.emit("agent_settled");

		assert.equal(await readJsonFile(bridge.paths.completionPath), null);
		assert.equal(bridge.lifecycle.shutdown, false);
		const state = parseRunState(await readJsonFile(bridge.paths.statePath), "run-aborted-turn");
		assert.equal(state?.lastEvent, "agent_settled:aborted");
	});

	test("aborts when a future-forged lease has a dead or mismatched parent identity", async () => {
		const bridge = await setupBridge("run-forged-lease", { isProcessIdentityAlive: () => false });
		await atomicWriteJson(bridge.paths.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION, runId: "run-forged-lease", parentPid: process.pid,
			parentStartedAt: getCurrentProcessStartedAt()!, renewedAt: Date.now() + 60_000,
		});
		await bridge.emit("session_start");
		assert.equal(completionError(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-forged-lease")), "lease-expired");
		assert.equal(bridge.lifecycle.aborted, true);
	});

	test("rejects a forged lease for another live parent before OS liveness", async () => {
		let identityChecks = 0;
		const bridge = await setupBridge("run-forged-live-parent", { isProcessIdentityAlive: () => { identityChecks += 1; return true; } });
		await atomicWriteJson(bridge.paths.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION, runId: "run-forged-live-parent", parentPid: process.pid + 1,
			parentStartedAt: getCurrentProcessStartedAt()!, renewedAt: Date.now(),
		});
		await bridge.emit("session_start");
		assert.equal(completionError(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-forged-live-parent")), "lease-expired");
		assert.equal(bridge.lifecycle.aborted, true);
		assert.equal(identityChecks, 0);
	});

	test("suppresses a slow lease read after external completion", async () => {
		let resolveRead!: (value: unknown | null) => void;
		const bridge = await setupBridge("run-slow-read", {
			readLease: async () => await new Promise<unknown | null>((resolve) => { resolveRead = resolve; }),
		});
		const starting = bridge.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 1));
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("stop")] });
		const settled = bridge.emit("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, 1));
		resolveRead(null);
		await Promise.all([starting, settled]);
		assert.equal(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-slow-read")?.status, "completed");
		assert.equal(bridge.lifecycle.aborted, false);
	});

	test("bounds overlapping child checks to one in-flight and one latest pending read", async () => {
		let reads = 0;
		let resolveSecond!: (value: unknown | null) => void;
		const validLease = (runId: string) => ({
			version: RUN_PROTOCOL_VERSION, runId, parentPid: process.pid,
			parentStartedAt: getCurrentProcessStartedAt()!, renewedAt: Date.now(),
		});
		const bridge = await setupBridge("run-one-pending", {
			readLease: async () => {
				reads += 1;
				if (reads === 2) return await new Promise<unknown | null>((resolve) => { resolveSecond = resolve; });
				return validLease("run-one-pending");
			},
		});
		await bridge.emit("session_start");
		while (reads < 2) await new Promise((resolve) => setTimeout(resolve, 1));
		await new Promise((resolve) => setTimeout(resolve, 45));
		assert.equal(reads, 2);
		resolveSecond(validLease("run-one-pending"));
		while (reads < 3) await new Promise((resolve) => setTimeout(resolve, 1));
		await bridge.emit("session_shutdown");
	});

	test("does not schedule another lease check after an initial orphan", async () => {
		let reads = 0;
		const bridge = await setupBridge("run-initial-orphan", {
			readLease: async () => { reads += 1; return { malformed: true }; },
		});
		await bridge.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 45));
		assert.equal(reads, 1);
		assert.equal(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-initial-orphan")?.status, "orphaned");
	});

	test("fails closed on an unreadable lease and a missing lease with a dead parent identity", async () => {
		const unreadable = await setupBridge("run-unreadable-lease", { readLease: async () => { throw new Error("denied"); } });
		await unreadable.emit("session_start");
		assert.equal(completionError(parseCompletionAuthority(await readJsonFile(unreadable.paths.completionPath), "run-unreadable-lease")), "lease-expired");
		assert.equal(unreadable.lifecycle.aborted, true);

		const missing = await setupBridge("run-missing-dead-parent", { isProcessIdentityAlive: () => false });
		await fs.promises.rm(missing.paths.parentLeasePath, { force: true });
		await missing.emit("session_start");
		assert.equal(completionError(parseCompletionAuthority(await readJsonFile(missing.paths.completionPath), "run-missing-dead-parent")), "lease-expired");
		assert.equal(missing.lifecycle.aborted, true);
	});

	test("acknowledges an exact transfer, drains lease checking, and survives parent lease removal", async () => {
		const bridge = await setupBridge("transfer-child", { isProcessIdentityAlive: () => true });
		const allocation = { version: 2, runId: "transfer-child", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174001", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(bridge.paths.allocationPath, allocation);
		await bridge.emit("session_start");
		const child = parseRunState(await readJsonFile(bridge.paths.statePath), "transfer-child")!;
		const request = { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174004", runId: "transfer-child",
			allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") },
			parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: child.childPid!, startedAt: child.childStartedAt! }, requestedAt: Date.now() };
		await atomicWriteJson(bridge.paths.promotionRequestPath, request);
		await new Promise((resolve) => setTimeout(resolve, 60));
		const ack = parseOwnershipTransferAck(await readJsonFile(bridge.paths.promotionAckPath), "transfer-child");
		assert.ok(ack);
		assert.equal(ack!.transferId, request.transferId);
		await fs.promises.rm(bridge.paths.parentLeasePath, { force: true });
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(bridge.lifecycle.aborted, false);
	});

	test("elects completion when finish becomes terminal before ACK publication", async () => {
		let bridge!: Awaited<ReturnType<typeof setupBridge>>;
		bridge = await setupBridge("transfer-finish-first", {
			isProcessIdentityAlive: () => true,
			beforePromotionAckPublication: async () => {
				// Do not await the finish: it deliberately drains this checker.
				await bridge.emit("agent_start");
				await bridge.emit("agent_end", { messages: [assistant("stop")] });
				void bridge.emit("agent_settled");
				await new Promise((resolve) => setTimeout(resolve, 0));
			},
		});
		const allocation = { version: 2, runId: "transfer-finish-first", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174001", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(bridge.paths.allocationPath, allocation);
		await bridge.emit("session_start");
		const child = parseRunState(await readJsonFile(bridge.paths.statePath), "transfer-finish-first")!;
		await atomicWriteJson(bridge.paths.promotionRequestPath, { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174010", runId: "transfer-finish-first", allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") }, parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: child.childPid!, startedAt: child.childStartedAt! }, requestedAt: Date.now() });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(fs.existsSync(bridge.paths.promotionAckPath), false);
		assert.equal(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "transfer-finish-first")?.status, "completed");
	});

	test("elects a durable ACK over concurrent finish and suppresses later agent settlement completion", async () => {
		let bridge!: Awaited<ReturnType<typeof setupBridge>>;
		bridge = await setupBridge("transfer-ack-first", {
			isProcessIdentityAlive: () => true,
			publishPromotionAck: async (filePath, value) => {
				await atomicWriteJson(filePath, value);
				// finish sets terminal and waits for this checker; durable ACK wins.
				void (async () => {
					await bridge.emit("agent_start");
					await bridge.emit("agent_end", { messages: [assistant("stop")] });
					await bridge.emit("agent_settled");
				})();
				await Promise.resolve();
				return "published";
			},
		});
		const allocation = { version: 2, runId: "transfer-ack-first", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174001", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(bridge.paths.allocationPath, allocation);
		await bridge.emit("session_start");
		const child = parseRunState(await readJsonFile(bridge.paths.statePath), "transfer-ack-first")!;
		await atomicWriteJson(bridge.paths.promotionRequestPath, { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174011", runId: "transfer-ack-first", allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") }, parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: child.childPid!, startedAt: child.childStartedAt! }, requestedAt: Date.now() });
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.ok(parseOwnershipTransferAck(await readJsonFile(bridge.paths.promotionAckPath), "transfer-ack-first"));
		assert.equal(await readJsonFile(bridge.paths.completionPath), null, "concurrent finish must not publish after detached ACK");
		// A later ordinary settled event must also remain local-only.
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("stop")] });
		await bridge.emit("agent_settled");
		assert.equal(await readJsonFile(bridge.paths.completionPath), null);
		assert.equal(bridge.lifecycle.shutdown, true);
	});

	test("retries inherited permit release beyond 25 faults after ACK while finish remains completion-free", async () => {
		let releaseAttempts = 0;
		const bridge = await setupBridge("transfer-release-recovery", {
			isProcessIdentityAlive: () => true,
			releaseInheritedTreePermit: async () => ++releaseAttempts > 26,
		});
		const allocation = { version: 2, runId: "transfer-release-recovery", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174001", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(bridge.paths.allocationPath, allocation);
		await bridge.emit("session_start");
		const child = parseRunState(await readJsonFile(bridge.paths.statePath), "transfer-release-recovery")!;
		await atomicWriteJson(bridge.paths.promotionRequestPath, { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174013", runId: "transfer-release-recovery", allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") }, parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: child.childPid!, startedAt: child.childStartedAt! }, requestedAt: Date.now() });
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.ok(parseOwnershipTransferAck(await readJsonFile(bridge.paths.promotionAckPath), "transfer-release-recovery"));
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("stop")] });
		await bridge.emit("agent_settled");
		assert.equal(await readJsonFile(bridge.paths.completionPath), null, "detached finish must not wait for permit release");
		await fs.promises.rm(bridge.paths.parentLeasePath, { force: true });
		await new Promise((resolve) => setTimeout(resolve, 750));
		assert.ok(releaseAttempts > 26, "release retry must survive more than the old 25-attempt limit");
		assert.equal(bridge.lifecycle.aborted, false, "parent crash after ACK cannot restore the lease checker");
		assert.equal(await readJsonFile(bridge.paths.completionPath), null);
	});

	test("keeps post-detach agent_settled local and never creates a completion artifact", async () => {
		const bridge = await setupBridge("transfer-post-detach", { isProcessIdentityAlive: () => true });
		const allocation = { version: 2, runId: "transfer-post-detach", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174001", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(bridge.paths.allocationPath, allocation);
		await bridge.emit("session_start");
		const child = parseRunState(await readJsonFile(bridge.paths.statePath), "transfer-post-detach")!;
		await atomicWriteJson(bridge.paths.promotionRequestPath, { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174012", runId: "transfer-post-detach", allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") }, parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: child.childPid!, startedAt: child.childStartedAt! }, requestedAt: Date.now() });
		await new Promise((resolve) => setTimeout(resolve, 80));
		assert.ok(parseOwnershipTransferAck(await readJsonFile(bridge.paths.promotionAckPath), "transfer-post-detach"));
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("stop")] });
		await bridge.emit("agent_settled");
		assert.equal(await readJsonFile(bridge.paths.completionPath), null);
		assert.equal(bridge.lifecycle.shutdown, true);
	});

	test("does not publish an ACK when valid or malformed completion wins after promotion fencing", async () => {
		for (const [label, completion] of [
			["valid", { version: 2, status: "failed", completedAt: Date.now(), errorCode: "child-error" }],
			["malformed", "{malformed}\n"],
		] as const) {
			const runId = `transfer-completion-${label}`;
			let bridge!: Awaited<ReturnType<typeof setupBridge>>;
			bridge = await setupBridge(runId, {
				isProcessIdentityAlive: () => true,
				beforePromotionAckPublication: async () => {
					if (typeof completion === "string") await fs.promises.writeFile(bridge.paths.completionPath, completion, { mode: 0o600 });
					else await atomicWriteJson(bridge.paths.completionPath, { ...completion, runId });
				},
			});
			const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174001", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
			await atomicWriteJson(bridge.paths.allocationPath, allocation);
			await bridge.emit("session_start");
			const child = parseRunState(await readJsonFile(bridge.paths.statePath), runId)!;
			await atomicWriteJson(bridge.paths.promotionRequestPath, { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: `123e4567-e89b-12d3-a456-4266141740${label === "valid" ? "08" : "09"}`, runId,
				allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") },
				parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: child.childPid!, startedAt: child.childStartedAt! }, requestedAt: Date.now() });
			await new Promise((resolve) => setTimeout(resolve, 80));
			assert.equal(fs.existsSync(bridge.paths.promotionAckPath), false, `${label} completion must prevent ACK publication`);
		}
	});

	test("does not withdraw its checker for a malformed pre-existing acknowledgement", async () => {
		const bridge = await setupBridge("transfer-malformed-ack", { isProcessIdentityAlive: () => true });
		const allocation = { version: 2, runId: "transfer-malformed-ack", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174001", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(bridge.paths.allocationPath, allocation);
		await bridge.emit("session_start");
		const child = parseRunState(await readJsonFile(bridge.paths.statePath), "transfer-malformed-ack")!;
		const request = { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174005", runId: "transfer-malformed-ack",
			allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") },
			parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: child.childPid!, startedAt: child.childStartedAt! }, requestedAt: Date.now() };
		await atomicWriteJson(bridge.paths.promotionRequestPath, request);
		await fs.promises.writeFile(bridge.paths.promotionAckPath, "{malformed}\n", { mode: 0o600 });
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(await fs.promises.readFile(bridge.paths.promotionAckPath, "utf8"), "{malformed}\n");
		await fs.promises.rm(bridge.paths.parentLeasePath, { force: true });
		await new Promise((resolve) => setTimeout(resolve, 160));
		assert.equal(completionError(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "transfer-malformed-ack")), "lease-expired");
		assert.equal(bridge.lifecycle.aborted, true, "the managed checker must remain responsible after malformed ACK");
	});

	test("does not resume the checker when ACK publication writes then throws and delayed readback later confirms it", async () => {
		let reads = 0;
		const bridge = await setupBridge("transfer-ack-ambiguous", {
			isProcessIdentityAlive: () => true,
			publishPromotionAck: async (filePath, value) => { await atomicWriteJson(filePath, value); throw new Error("written acknowledgement reported as failed"); },
			readPromotionAck: async (filePath) => ++reads <= 3 ? null : await readJsonFile(filePath),
		});
		const allocation = { version: 2, runId: "transfer-ack-ambiguous", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174001", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(bridge.paths.allocationPath, allocation);
		await bridge.emit("session_start");
		const child = parseRunState(await readJsonFile(bridge.paths.statePath), "transfer-ack-ambiguous")!;
		await atomicWriteJson(bridge.paths.promotionRequestPath, { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174007", runId: "transfer-ack-ambiguous",
			allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") },
			parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: child.childPid!, startedAt: child.childStartedAt! }, requestedAt: Date.now() });
		await new Promise((resolve) => setTimeout(resolve, 60));
		await fs.promises.rm(bridge.paths.parentLeasePath, { force: true });
		await new Promise((resolve) => setTimeout(resolve, 320));
		assert.ok(parseOwnershipTransferAck(await readJsonFile(bridge.paths.promotionAckPath), "transfer-ack-ambiguous"));
		assert.equal(bridge.lifecycle.aborted, false, "an ambiguous published ACK must never reactivate parent-death aborting");
		assert.equal(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "transfer-ack-ambiguous"), null);
	});

	test("restores checker enforcement after acknowledgement publication fails", async () => {
		let publishAttempts = 0;
		const bridge = await setupBridge("transfer-ack-failure", {
			isProcessIdentityAlive: () => true,
			publishPromotionAck: async () => { publishAttempts += 1; throw new Error("injected ack publication failure"); },
		});
		const allocation = { version: 2, runId: "transfer-ack-failure", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174001", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(bridge.paths.allocationPath, allocation);
		await bridge.emit("session_start");
		const child = parseRunState(await readJsonFile(bridge.paths.statePath), "transfer-ack-failure")!;
		await atomicWriteJson(bridge.paths.promotionRequestPath, { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174006", runId: "transfer-ack-failure",
			allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") },
			parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: child.childPid!, startedAt: child.childStartedAt! }, requestedAt: Date.now() });
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.ok(publishAttempts > 0);
		await fs.promises.rm(bridge.paths.parentLeasePath, { force: true });
		await new Promise((resolve) => setTimeout(resolve, 160));
		assert.equal(completionError(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "transfer-ack-failure")), "lease-expired");
		assert.equal(bridge.lifecycle.aborted, true, "failed ACK publication must not detach the child");
	});

	test("makes a checker-triggered orphan with a live parent wait for the exact completion-fence ACK", async () => {
		const bridge = await setupBridge("run-orphan", { completionFence: true });
		await atomicWriteJson(bridge.paths.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION,
			runId: "run-orphan",
			parentPid: process.pid,
			parentStartedAt: getCurrentProcessStartedAt()!,
			renewedAt: Date.now() - 1000,
		});
		const settling = bridge.emit("session_start");
		while (!fs.existsSync(bridge.paths.completionFencePath)) await new Promise((resolve) => setTimeout(resolve, 1));
		assert.equal(await readJsonFile(bridge.paths.completionPath), null, "a live parent still needs an ACK even when the checker caused the orphan");
		await publishImmutableJson(bridge.paths.completionFenceAckPath, { version: 1, kind: "completion-fence-ack", runId: "run-orphan", nonce: "d".repeat(64), acknowledgedAt: Date.now() });
		await settling;

		const completion = parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-orphan");
		assert.equal(completion?.status, "orphaned");
		assert.equal(completion?.errorCode, "lease-expired");
		assert.equal(completion && "session" in completion ? completion.session.finalEntryId : undefined, "entry-run-orphan");
		assert.equal(bridge.lifecycle.aborted, true);
		assert.equal(bridge.lifecycle.shutdown, true);
	});

	test("lets a checker-triggered orphan bypass the ACK only after exact parent death", async () => {
		const bridge = await setupBridge("run-orphan-dead", {
			completionFence: true,
			expectedParent: { pid: 999_999_999, startedAt: 1 },
		});
		await atomicWriteJson(bridge.paths.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION,
			runId: "run-orphan-dead",
			parentPid: 999_999_999,
			parentStartedAt: 1,
			renewedAt: Date.now() - 1000,
		});
		await bridge.emit("session_start");
		assert.equal(parseCompletionAuthority(await readJsonFile(bridge.paths.completionPath), "run-orphan-dead")?.status, "orphaned");
		assert.equal(fs.existsSync(bridge.paths.completionFencePath), true);
		assert.equal(fs.existsSync(bridge.paths.completionFenceAckPath), false, "only a dead parent identity may bypass ACK");
	});
});
