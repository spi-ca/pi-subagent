import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import childBridge, { registerChildBridge } from "../../src/runtime/child-bridge";
import {
	RUN_PROTOCOL_VERSION,
	getCurrentProcessStartedAt,
	SUBAGENT_CHILD_SESSION_PATH_ENV,
	SUBAGENT_LEASE_CHECK_MS_ENV,
	SUBAGENT_LEASE_STALE_MS_ENV,
	SUBAGENT_EXPECTED_PARENT_PID_ENV,
	SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
	SUBAGENT_PARENT_LEASE_PATH_ENV,
	SUBAGENT_RUN_COMPLETION_PATH_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_RUN_OWNERSHIP_ENV,
	SUBAGENT_RUN_STATE_PATH_ENV,
	atomicWriteJson,
	parseCompletionRecordV2,
	parseRunState,
	prepareRunArtifactPaths,
	readJsonFile,
} from "../../src/runtime/run-protocol";

const tempDirs: string[] = [];
const savedEnv = { ...process.env };

afterEach(async () => {
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) delete process.env[key];
	}
	for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
	while (tempDirs.length > 0) await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function setupBridge(runId: string, options: { isProcessIdentityAlive?: (pid: number, startedAt: number) => boolean } = {}) {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-bridge-"));
	tempDirs.push(root);
	const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
	process.env[SUBAGENT_RUN_ID_ENV] = runId;
	process.env[SUBAGENT_RUN_STATE_PATH_ENV] = paths.statePath;
	process.env[SUBAGENT_RUN_COMPLETION_PATH_ENV] = paths.completionPath;
	process.env[SUBAGENT_PARENT_LEASE_PATH_ENV] = paths.parentLeasePath;
	process.env[SUBAGENT_CHILD_SESSION_PATH_ENV] = paths.childSessionPath;
	process.env[SUBAGENT_RUN_OWNERSHIP_ENV] = "parent-owned";
	process.env[SUBAGENT_EXPECTED_PARENT_PID_ENV] = String(process.pid);
	process.env[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV] = String(getCurrentProcessStartedAt()!);
	process.env[SUBAGENT_LEASE_STALE_MS_ENV] = "100";
	process.env[SUBAGENT_LEASE_CHECK_MS_ENV] = "20";
	await atomicWriteJson(paths.parentLeasePath, {
		version: RUN_PROTOCOL_VERSION,
		runId,
		parentPid: process.pid,
		parentStartedAt: getCurrentProcessStartedAt()!,
		renewedAt: Date.now(),
	});

	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => any) {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
	};
	registerChildBridge(pi as any, options);
	const lifecycle = { aborted: false, shutdown: false };
	const ctx = {
		abort: () => { lifecycle.aborted = true; },
		shutdown: () => { lifecycle.shutdown = true; },
	};
	const emit = async (event: string, payload: any = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return { paths, handlers, lifecycle, emit };
}

function assistant(stopReason: string, text = "DONE") {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		stopReason,
	};
}

describe("child lifecycle bridge", () => {
	test("is a no-op when it is inherited without run protocol environment", () => {
		delete process.env[SUBAGENT_RUN_ID_ENV];
		let registrations = 0;
		childBridge({ on: () => { registrations += 1; } } as any);
		assert.equal(registrations, 0);
	});

	test("writes completed state on agent_settled and requests graceful shutdown", async () => {
		const bridge = await setupBridge("run-complete");
		await bridge.emit("session_start", { reason: "startup" });
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("stop")] });
		await bridge.emit("agent_settled");

		const completion = parseCompletionRecordV2(await readJsonFile(bridge.paths.completionPath), "run-complete");
		assert.equal(completion?.status, "completed");
		assert.equal(bridge.lifecycle.shutdown, true);
		assert.equal(bridge.lifecycle.aborted, false);
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
		assert.equal(JSON.stringify(raw).includes("untrusted provider output"), false);
	});

	test("publishes immutable completion when the terminal state write faults", async () => {
		const bridge = await setupBridge("run-state-fault");
		await bridge.emit("session_start");
		await bridge.emit("agent_start");
		await bridge.emit("agent_end", { messages: [assistant("stop")] });
		await fs.promises.rm(bridge.paths.statePath, { force: true });
		await fs.promises.mkdir(bridge.paths.statePath);
		await bridge.emit("agent_settled");

		assert.equal(parseCompletionRecordV2(await readJsonFile(bridge.paths.completionPath), "run-state-fault")?.status, "completed");
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
		assert.equal(parseCompletionRecordV2(await readJsonFile(bridge.paths.completionPath), "run-forged-lease")?.errorCode, "lease-expired");
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
		assert.equal(parseCompletionRecordV2(await readJsonFile(bridge.paths.completionPath), "run-forged-live-parent")?.errorCode, "lease-expired");
		assert.equal(bridge.lifecycle.aborted, true);
		assert.equal(identityChecks, 0);
	});

	test("aborts a parent-owned child when its lease is stale", async () => {
		const bridge = await setupBridge("run-orphan");
		await atomicWriteJson(bridge.paths.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION,
			runId: "run-orphan",
			parentPid: 999,
			parentStartedAt: 1,
			renewedAt: Date.now() - 1000,
		});
		await bridge.emit("session_start");

		const completion = parseCompletionRecordV2(await readJsonFile(bridge.paths.completionPath), "run-orphan");
		assert.equal(completion?.status, "orphaned");
		assert.equal(completion?.errorCode, "lease-expired");
		assert.equal(bridge.lifecycle.aborted, true);
		assert.equal(bridge.lifecycle.shutdown, true);
	});
});
