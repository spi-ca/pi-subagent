import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildBrokerEnvironment,
	buildTmuxSourcePaneProbeArgs,
	parseTmuxSourcePaneProbe,
	buildChildProcessEnv,
	buildInteractivePaneWrapperScript,
	buildInteractiveChildSessionJsonl,
	validateForkBranchSourceJsonl,
	buildPrivateChildEnvironmentScript,
	buildInteractivePiArgs,
	buildPiArgs,
	buildInteractiveExtensionArgs,
	assertManagedChildToolCompatibility,
	resolveManagedChildPolicy,
	resolveCurrentPackageExtensionEntrypoint,
	applyChildProjectIsolation,
	closeInteractiveTarget,
	acquireCmuxTopologyMutationLockForTest,
	acquireTmuxTopologyMutationLockForTest,
	advanceTopologyMutationGenerationForTest,
	getTopologyMutationGenerationForTest,
	inspectActiveCmuxSnapshotForTest,
	inspectActiveTmuxSnapshotForTest,
	isTopologyMutationInvalidatedUndefinedInspectionForTest,
	focusInteractiveRun,
	inspectInteractiveRunForUx,
	keepInteractiveRun,
	listActiveInteractiveRunIds,
	listInteractiveRunUxSnapshots,
	promoteInteractiveRun,
	registerCommittedInteractiveRun,
	settleInteractiveTreePermitAfterOwnershipForTest,
	applyInteractiveOwnershipUnknownResultForTest,
	releaseRegisteredInteractiveRun,
	unregisterCommittedInteractiveRun,
	allocationMatchesInteractiveBackend,
	applyVerifiedInteractiveCompletion,
	hasCommittedInteractiveLaunchAuthority,
	isInteractivePiVersionProofCurrent,
	isPiVersionAtLeast,
	resetInteractivePiVersionChecksForTest,
	verifyInteractivePiVersionCached,
	shouldRetainBrokerRecoveryMetadata,
	resolveBrokerRuntime,
	resolveBackendExecutable,
	resolveBackendPath,
	resolveRegularFile,
	resolveRuntimeInterpreter,
	resolveSharedCmuxSourcePreflight,
	CmuxSourcePreflightError,
	beginInteractiveShutdownForSession,
	canStartInteractiveRun,
	createHerdrAgentWaitFallback,
	createInteractiveResultMutationQueueForTest,
	cmuxEventsAuthorityKeyForTest,
	isCmuxTopologyMutationEventForTest,
	shouldReplaceCmuxEventsAuthorityForTest,
	getInteractiveShutdownGenerationForTest,
	resetInteractiveShutdownForSession,
	publishInteractiveLaunchGate,
	shutdownActiveInteractiveRuns,
	subscribeInteractiveRunChanges,
	watchCompletedHerdrDirectRunForRetirementForTest,
	watchDetachedInteractiveRunForRetirementForTest,
} from "../../src/runtime/runner";
import { InteractiveLayoutCoordinator, resolveInteractivePaneLayout } from "../../src/runtime/interactive-layout";
import { buildTmuxPaneSnapshotArgs, buildTmuxServerPidArgs, readTmuxPaneTitle } from "../../src/runtime/tmux";
import { herdrInteractivePaneBackend, type InteractivePaneBackend } from "../../src/runtime/interactive-pane";
import { acquireTmuxControlLease, snapshotTmuxControlPoolForTest } from "../../src/runtime/tmux-control-pool";
import {
	SUBAGENT_CHILD_SESSION_PATH_ENV,
	SUBAGENT_EXPECTED_PARENT_PID_ENV,
	SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
	SUBAGENT_PARENT_LEASE_PATH_ENV,
	SUBAGENT_RUN_COMPLETION_PATH_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_RUN_OWNERSHIP_ENV,
	SUBAGENT_RUN_STATE_PATH_ENV,
	prepareRunArtifactPaths,
	removeRunArtifacts,
	getCurrentProcessStartedAt,
} from "../../src/runtime/run-protocol";
import { SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV, SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV } from "../../src/runtime/lifecycle-socket";
import { computeSessionCompletionBoundary, computeSessionFailureBoundary, getSessionFileIdentity, setSessionVerificationBufferLimitForTesting } from "../../src/runtime/completion-v3";
import { LaunchPreflightSingleFlight } from "../../src/runtime/launch-preflight";
import { getFinalOutput } from "../../src/core/types";

const agent = {
	name: "reviewer",
	description: "Review code",
	tools: ["read", "grep"],
	model: "provider/model",
	thinking: "high",
	systemPrompt: "Review carefully",
	source: "user" as const,
	filePath: "/tmp/reviewer.md",
};

describe("interactive pane runner preparation", () => {
	test("notifies interactive registry observers immediately and after successful shutdown removal", async () => {
		await shutdownActiveInteractiveRuns();
		await resetInteractiveShutdownForSession();
		const runId = "interactive-observer-shutdown-removal";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "observer" } };
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true, close: async () => true, inspect: async () => ({ exists: false }),
		};
		const observed: boolean[] = [];
		const unsubscribeThrowing = subscribeInteractiveRunChanges(() => { throw new Error("observer failure"); });
		const observer = () => {
			observed.push(listActiveInteractiveRunIds().includes(runId));
		};
		const unsubscribe = subscribeInteractiveRunChanges(observer);
		const unsubscribeDuplicate = subscribeInteractiveRunChanges(observer);
		try {
			assert.deepEqual(observed, [false], "subscription reports the current registry immediately and duplicate registration is a no-op");
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, generation: getInteractiveShutdownGenerationForTest(), release: async () => true }), true);
			assert.deepEqual(observed, [false, true], "a registration notifies despite another observer throwing");
			unsubscribeDuplicate();
			await shutdownActiveInteractiveRuns();
			assert.deepEqual(observed, [false, true, false], "disposing a duplicate leaves the original observer active");
			unsubscribe();
			await resetInteractiveShutdownForSession();
			const unsubscribedRunId = `${runId}-unsubscribed`;
			assert.equal(registerCommittedInteractiveRun({ runId: unsubscribedRunId, backend, handle, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.deepEqual(observed, [false, true, false], "unsubscribed observers receive no later changes");
			unregisterCommittedInteractiveRun(unsubscribedRunId, true);
		} finally {
			unsubscribe();
			unsubscribeDuplicate();
			unsubscribeThrowing();
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
		}
	});

	test("active cleanup does not interrupt or close an auto Herdr child moved outside its allocated tab", async () => {
		await shutdownActiveInteractiveRuns();
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-active-herdr-"));
		const socketPath = path.join(root, "herdr.sock");
		const moved = { workspace_id: "workspace", tab_id: "user-tab", pane_id: "moved-child", terminal_id: "child-terminal" };
		const calls: string[] = [];
		const server = net.createServer((socket) => socket.once("data", (chunk) => {
			const request = JSON.parse(chunk.toString("utf8")) as { id: string; method: string };
			calls.push(request.method);
			const result = request.method === "ping" ? { type: "pong", protocol: 20 }
				: request.method === "pane.get" ? { type: "pane_info", pane: moved } : { type: "ok" };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		}));
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		fs.chmodSync(socketPath, 0o600);
		const runId = "active-herdr-tab-moved";
		const handle = { mode: "herdr-pane" as const, native: { socketPath, socketDev: BigInt(fs.lstatSync(socketPath).dev).toString(), socketIno: BigInt(fs.lstatSync(socketPath).ino).toString(), workspaceId: moved.workspace_id, tabId: "allocated-tab", paneId: "allocated-child", terminalId: moved.terminal_id, allocatedTabId: "allocated-tab", protocol: 20 as const } };
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend: herdrInteractivePaneBackend, handle, generation: getInteractiveShutdownGenerationForTest() }), true);
			await shutdownActiveInteractiveRuns();
			assert.equal(calls.includes("pane.send_keys"), false);
			assert.equal(calls.includes("pane.close"), false);
		} finally {
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("runner Herdr fallback keeps healthy subscriptions wait-free and drains one degraded observer on recovery", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-fallback-"));
		const socketPath = path.join(root, "herdr.sock");
		const calls: string[] = [];
		let subscriptionSocket: net.Socket | undefined;
		const sockets = new Set<net.Socket>();
		const pane = { workspace_id: "workspace", tab_id: "tab", pane_id: "pane", terminal_id: "terminal" };
		const server = net.createServer((socket) => {
			sockets.add(socket); socket.once("close", () => sockets.delete(socket));
			socket.once("data", (chunk) => {
				const request = JSON.parse(chunk.toString("utf8")) as { id: string; method: string };
				calls.push(request.method);
				if (request.method === "events.subscribe") {
					subscriptionSocket = socket;
					socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
					return;
				}
				if (request.method === "agent.wait") return;
				const result = request.method === "pane.get" ? { type: "pane_info", pane }
					: { type: "agent_info", agent: { ...pane, agent_status: "working", focused: false, revision: 1, state_change_seq: 1 } };
				socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		fs.chmodSync(socketPath, 0o600);
		const stat = fs.lstatSync(socketPath, { bigint: true });
		const handle = { socketPath, socketDev: stat.dev.toString(), socketIno: stat.ino.toString(), workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id, protocol: 20 as const };
		const fallback = createHerdrAgentWaitFallback({ handle, onWake: () => undefined });
		const subscription = (await import("../../src/runtime/herdr")).subscribeHerdrPane({
			handle, onReconcile: () => undefined, onHealthChange: (healthy) => fallback.sync(healthy),
		});
		const waitFor = async (condition: () => boolean) => {
			for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
			assert.ok(condition(), "timed out waiting for Herdr observer state");
		};
		try {
			await waitFor(() => subscription.isHealthy());
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.equal(calls.filter((method) => method === "agent.wait").length, 0, "healthy events.subscribe must not start agent.wait");
			subscriptionSocket!.destroy();
			await waitFor(() => calls.filter((method) => method === "agent.wait").length === 1);
			await waitFor(() => subscription.isHealthy());
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.equal(calls.filter((method) => method === "agent.wait").length, 1, "recovery must drain rather than race-restart the degraded observer");
			assert.equal(calls.some((method) => ["pane.close", "tab.close", "pane.send_keys", "agent.send-keys"].includes(method)), false);
		} finally {
			subscription.stop();
			await fallback.stopAndDrain();
			await subscription.closed;
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("retires an auto Herdr tab only after read-only absence without a pane mutation", async () => {
		await resetInteractiveShutdownForSession();
		const runId = "herdr-direct-absence";
		const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
		let closes = 0, inspections = 0;
		const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => { inspections += 1; return { exists: false }; }, interrupt: async () => { throw new Error("must not send keys"); }, close: async () => { closes += 1; return false; } };
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(await releaseRegisteredInteractiveRun(runId), true);
			assert.equal(inspections, 1);
			assert.equal(closes, 0);
		} finally { unregisterCommittedInteractiveRun(runId, true); await resetInteractiveShutdownForSession(); }
	});

	test("finalizes detached retirement after reset cancels observation at the deletion boundary", async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-detached-reset-retirement-"));
		const runId = "detached-reset-retirement", paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
		const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => ({ exists: false }), interrupt: async () => false, close: async () => false };
		const originalAccess = fs.promises.access;
		let pauseAccess = true, enteredAbsenceBoundary!: () => void, releaseAccess!: () => void;
		const absenceBoundary = new Promise<void>((resolve) => { enteredAbsenceBoundary = resolve; });
		const accessRelease = new Promise<void>((resolve) => { releaseAccess = resolve; });
		(fs.promises as { access: typeof fs.promises.access }).access = async (target, mode) => {
			if (target === paths.runDir && pauseAccess) {
				pauseAccess = false;
				enteredAbsenceBoundary();
				await accessRelease;
			}
			return await originalAccess(target, mode);
		};
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(watchDetachedInteractiveRunForRetirementForTest(runId), true);
			await absenceBoundary;
			assert.equal(fs.existsSync(paths.runDir), false, "artifact removal completed before the final registry fence");
			let resetSettled = false;
			const reset = resetInteractiveShutdownForSession().then(() => { resetSettled = true; });
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(resetSettled, false, "reset waits for the serialized cleanup boundary");
			releaseAccess();
			await reset;
			assert.equal(listActiveInteractiveRunIds().includes(runId), false, "no active detached entry points to the deleted run directory");
		} finally {
			(fs.promises as { access: typeof fs.promises.access }).access = originalAccess;
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("retires a completed direct Herdr run only after two read-only absences and safe artifact removal", async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-late-herdr-retirement-"));
		const runId = "late-herdr-completion";
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const completion = { version: 2 as const, runId, status: "completed" as const, completedAt: 1 };
		const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
		let inspections = 0, closes = 0;
		const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => { inspections += 1; return { exists: false }; }, interrupt: async () => { throw new Error("must not send keys"); }, close: async () => { closes += 1; return false; } };
		try {
			await fs.promises.writeFile(paths.completionPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(runId, completion), true);
			for (let attempt = 0; attempt < 100 && listActiveInteractiveRunIds().includes(runId); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(listActiveInteractiveRunIds().includes(runId), false);
			assert.ok(inspections >= 2, "both absence probes are required");
			assert.equal(closes, 0);
			assert.equal(fs.existsSync(paths.runDir), false);
		} finally { unregisterCommittedInteractiveRun(runId, true); await fs.promises.rm(root, { recursive: true, force: true }); await resetInteractiveShutdownForSession(); }
	});

	test("uses a finite cleanup-only retry after confirmed Herdr absence", async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-cleanup-retry-"));
		const runId = "late-herdr-cleanup-retry", paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const completion = { version: 2 as const, runId, status: "completed" as const, completedAt: 1 };
		const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
		let inspections = 0, removals = 0;
		const originalRm = fs.promises.rm;
		(fs.promises as { rm: typeof fs.promises.rm }).rm = async (target, options) => {
			if (target === paths.runDir) {
				removals += 1;
				if (removals === 1) {
					// Simulate recursive rm deleting its durable authority before its
					// first failure is reported.
					await originalRm(paths.completionPath, { force: true });
					throw Object.assign(new Error("planned partial cleanup failure"), { code: "EACCES" });
				}
			}
			return await originalRm(target, options);
		};
		const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => { inspections += 1; return { exists: false }; }, interrupt: async () => false, close: async () => false };
		const waitFor = async (condition: () => boolean) => {
			for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.ok(condition(), "timed out waiting for bounded cleanup retry");
		};
		try {
			await fs.promises.writeFile(paths.completionPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });
			await fs.promises.writeFile(paths.taskPath, "sensitive\n", { mode: 0o600 });
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(runId, completion), true);
			await waitFor(() => removals === 1);
			assert.equal(fs.existsSync(paths.completionPath), false, "the first recursive cleanup failure removed durable authority");
			assert.equal(listActiveInteractiveRunIds().includes(runId), true, "the committed cleanup is still draining");
			await waitFor(() => !listActiveInteractiveRunIds().includes(runId));
			assert.equal(removals, 2, "the finite in-operation retry completes without reopening authority");
			assert.equal(inspections, 2, "post-commit retry never polls Herdr again");
		} finally {
			(fs.promises as { rm: typeof fs.promises.rm }).rm = originalRm;
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("finalizes completed Herdr retirement after reset cancels observation at the deletion boundary", async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-reset-retirement-"));
		const runId = "late-herdr-reset-retirement", paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const completion = { version: 2 as const, runId, status: "completed" as const, completedAt: 1 };
		const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
		const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => ({ exists: false }), interrupt: async () => false, close: async () => false };
		const originalRm = fs.promises.rm;
		let pauseRemoval = true, enteredCleanupBoundary!: () => void, releaseRemoval!: () => void;
		const cleanupBoundary = new Promise<void>((resolve) => { enteredCleanupBoundary = resolve; });
		const removalRelease = new Promise<void>((resolve) => { releaseRemoval = resolve; });
		(fs.promises as { rm: typeof fs.promises.rm }).rm = async (target, options) => {
			if (target === paths.runDir && pauseRemoval) {
				pauseRemoval = false;
				enteredCleanupBoundary();
				await removalRelease;
			}
			return await originalRm(target, options);
		};
		try {
			await fs.promises.writeFile(paths.completionPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(runId, completion), true);
			await cleanupBoundary;
			const resetGeneration = getInteractiveShutdownGenerationForTest() + 1;
			let resetSettled = false;
			const reset = resetInteractiveShutdownForSession().then(() => { resetSettled = true; });
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(resetSettled, false, "reset waits for committed recursive cleanup");
			assert.equal(getInteractiveShutdownGenerationForTest(), resetGeneration);
			assert.equal(canStartInteractiveRun(resetGeneration), false, "the new generation remains fenced while cleanup drains");
			releaseRemoval();
			await reset;
			assert.equal(canStartInteractiveRun(resetGeneration), true, "the new generation opens only after cleanup drains");
			assert.equal(listActiveInteractiveRunIds().includes(runId), false, "a reset cannot strand an active entry after cleanup commitment");
		} finally {
			(fs.promises as { rm: typeof fs.promises.rm }).rm = originalRm;
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("drains a committed cleanup retry during reset without reopening artifact authority", async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-retry-drain-"));
		const runId = "late-herdr-retry-drain", paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const completion = { version: 2 as const, runId, status: "completed" as const, completedAt: 1 };
		const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
		const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => ({ exists: false }), interrupt: async () => false, close: async () => false };
		const originalRm = fs.promises.rm;
		let attempts = 0, enteredRetry!: () => void, releaseRetry!: () => void;
		const retryEntered = new Promise<void>((resolve) => { enteredRetry = resolve; });
		const retryRelease = new Promise<void>((resolve) => { releaseRetry = resolve; });
		(fs.promises as { rm: typeof fs.promises.rm }).rm = async (target, options) => {
			if (target === paths.runDir) {
				attempts += 1;
				if (attempts === 1) throw Object.assign(new Error("planned cleanup failure"), { code: "EACCES" });
				if (attempts === 2) { enteredRetry(); await retryRelease; }
			}
			return await originalRm(target, options);
		};
		try {
			await fs.promises.writeFile(paths.completionPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(runId, completion), true);
			await retryEntered;
			let resetSettled = false;
			const reset = resetInteractiveShutdownForSession().then(() => { resetSettled = true; });
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(resetSettled, false, "reset drains the committed retry rather than cancelling it");
			releaseRetry();
			await reset;
			assert.equal(attempts, 2, "the second in-operation cleanup retry completed without a backend reconciliation");
			assert.equal(listActiveInteractiveRunIds().includes(runId), false);
		} finally {
			(fs.promises as { rm: typeof fs.promises.rm }).rm = originalRm;
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("releases completed Herdr watcher capacity after finite cleanup retries are exhausted", async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-retry-exhaustion-"));
		const completionFor = (runId: string) => ({ version: 2 as const, runId, status: "completed" as const, completedAt: 1 });
		const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
		const originalRm = fs.promises.rm;
		const attempts = new Map<string, number>();
		const paths = [] as Awaited<ReturnType<typeof prepareRunArtifactPaths>>[];
		(fs.promises as { rm: typeof fs.promises.rm }).rm = async (target, options) => {
			const matched = paths.find((candidate) => candidate.runDir === target);
			if (matched) {
				attempts.set(matched.runDir, (attempts.get(matched.runDir) ?? 0) + 1);
				throw Object.assign(new Error("planned cleanup failure"), { code: "EACCES" });
			}
			return await originalRm(target, options);
		};
		try {
			for (let index = 0; index < 16; index += 1) {
				const runId = `exhausted-herdr-${index}`, runPaths = await prepareRunArtifactPaths({ rootDir: root, runId }), completion = completionFor(runId);
				paths.push(runPaths);
				await fs.promises.writeFile(runPaths.completionPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });
				const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
					inspect: async () => ({ exists: false }), interrupt: async () => false, close: async () => false };
				assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths: runPaths, generation: getInteractiveShutdownGenerationForTest() }), true);
				assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(runId, completion), true);
			}
			for (let wait = 0; wait < 300 && (attempts.size !== 16 || [...attempts.values()].some((count) => count !== 3)); wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(attempts.size, 16);
			assert.ok([...attempts.values()].every((count) => count === 3), "initial cleanup plus the two configured retries is the complete budget");
			const recoveredRunId = "recovered-herdr-watcher", recoveredPaths = await prepareRunArtifactPaths({ rootDir: root, runId: recoveredRunId }), recoveredCompletion = completionFor(recoveredRunId);
			paths.push(recoveredPaths);
			await fs.promises.writeFile(recoveredPaths.completionPath, `${JSON.stringify(recoveredCompletion)}\n`, { mode: 0o600 });
			const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
				inspect: async () => ({ exists: true }), interrupt: async () => false, close: async () => false };
			assert.equal(registerCommittedInteractiveRun({ runId: recoveredRunId, backend, handle, paths: recoveredPaths, generation: getInteractiveShutdownGenerationForTest() }), true);
			for (let wait = 0; wait < 100 && !watchCompletedHerdrDirectRunForRetirementForTest(recoveredRunId, recoveredCompletion); wait += 1) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(recoveredRunId, recoveredCompletion), true, "exhausted watcher drains free a cap slot");
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.ok([...attempts.values()].every((count) => count === 3), "exhausted watchers perform no later cleanup attempts");
			unregisterCommittedInteractiveRun(recoveredRunId, true);
		} finally {
			(fs.promises as { rm: typeof fs.promises.rm }).rm = originalRm;
			for (const runPaths of paths) unregisterCommittedInteractiveRun(path.basename(runPaths.runDir), true);
			await resetInteractiveShutdownForSession();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("retains draining completed Herdr watchers in the 16-watcher cap", async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-watcher-cap-"));
		const blocked: Array<() => void> = [];
		const entered = new Set<string>();
		const completionFor = (runId: string) => ({ version: 2 as const, runId, status: "completed" as const, completedAt: 1 });
		const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
		const paths = [] as Awaited<ReturnType<typeof prepareRunArtifactPaths>>[];
		try {
			for (let index = 0; index < 16; index += 1) {
				const runId = `draining-herdr-${index}`, runPaths = await prepareRunArtifactPaths({ rootDir: root, runId }), completion = completionFor(runId);
				paths.push(runPaths);
				await fs.promises.writeFile(runPaths.completionPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });
				const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
					inspect: async () => await new Promise<{ exists: false }>((resolve) => { entered.add(runId); blocked.push(() => resolve({ exists: false })); }), interrupt: async () => false, close: async () => false };
				assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths: runPaths, generation: getInteractiveShutdownGenerationForTest() }), true);
				assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(runId, completion), true);
			}
			for (let attempt = 0; attempt < 100 && entered.size < 16; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(entered.size, 16);
			for (let index = 0; index < 16; index += 1) unregisterCommittedInteractiveRun(`draining-herdr-${index}`, true);
			const runId = "seventeenth-draining-herdr", runPaths = await prepareRunArtifactPaths({ rootDir: root, runId }), completion = completionFor(runId);
			paths.push(runPaths);
			await fs.promises.writeFile(runPaths.completionPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });
			const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle, inspect: async () => ({ exists: true }), interrupt: async () => false, close: async () => false };
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths: runPaths, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(runId, completion), false, "draining watchers retain their process-wide cap slots");
			unregisterCommittedInteractiveRun(runId, true);
		} finally {
			for (const resolve of blocked) resolve();
			await resetInteractiveShutdownForSession();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("does not retire a direct Herdr completion watcher for changed authority, malformed authority, present, or unknown targets", async () => {
		await resetInteractiveShutdownForSession();
		for (const [label, inspection, artifact] of [
			["changed", { exists: false } as const, { version: 2, runId: "different", status: "completed", completedAt: 1 }],
			["malformed", { exists: false } as const, { invalid: true }],
			["present", { exists: true } as const, null],
			["unknown", undefined, null],
		] as const) {
			const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pi-subagent-late-herdr-${label}-`));
			const runId = `late-herdr-${label}`, paths = await prepareRunArtifactPaths({ rootDir: root, runId });
			const completion = { version: 2 as const, runId, status: "completed" as const, completedAt: 1 };
			const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
			let inspections = 0;
			const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle, inspect: async () => { inspections += 1; return inspection; }, interrupt: async () => false, close: async () => { throw new Error("must not close"); } };
			try {
				await fs.promises.writeFile(paths.completionPath, `${JSON.stringify(artifact ?? completion)}\n`, { mode: 0o600 });
				assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
				assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(runId, completion), true);
				await new Promise((resolve) => setTimeout(resolve, 30));
				assert.equal(listActiveInteractiveRunIds().includes(runId), true, label);
				assert.equal(fs.existsSync(paths.runDir), true, label);
				if (label === "present" || label === "unknown") assert.ok(inspections >= 1, `${label} watcher has an initial authoritative reconciliation`);
			} finally { unregisterCommittedInteractiveRun(runId, true); await fs.promises.rm(root, { recursive: true, force: true }); }
		}
		await resetInteractiveShutdownForSession();
	});

	test("completed Herdr watcher reconciles only on bounded events and reconnects, never by idle polling", { timeout: 8_000 }, async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-events-"));
		const socketPath = path.join(root, "herdr.sock");
		const runId = "late-herdr-event-driven";
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const completion = { version: 2 as const, runId, status: "completed" as const, completedAt: 1 };
		const pane = { workspace_id: "workspace", tab_id: "tab", pane_id: "pane", terminal_id: "terminal" };
		const calls: string[] = [];
		let subscriptions = 0;
		let stream: net.Socket | undefined;
		const sockets = new Set<net.Socket>();
		const server = net.createServer((socket) => {
			sockets.add(socket); socket.once("close", () => sockets.delete(socket));
			socket.once("data", (chunk) => {
				const request = JSON.parse(chunk.toString("utf8")) as { id: string; method: string };
				calls.push(request.method);
				if (request.method === "events.subscribe") {
					subscriptions += 1; stream = socket;
					socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
					return;
				}
				socket.end(`${JSON.stringify({ id: request.id, result: { type: "pane_info", pane } })}\n`);
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		fs.chmodSync(socketPath, 0o600);
		const stat = fs.lstatSync(socketPath, { bigint: true });
		const handle = { mode: "herdr-pane" as const, native: { socketPath, socketDev: stat.dev.toString(), socketIno: stat.ino.toString(), workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id, allocatedTabId: pane.tab_id, protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
		let inspections = 0, holdNextReconciliation = false, enteredHeldReconciliation!: () => void, releaseHeldReconciliation!: () => void;
		const heldReconciliationEntered = new Promise<void>((resolve) => { enteredHeldReconciliation = resolve; });
		const heldReconciliation = new Promise<void>((resolve) => { releaseHeldReconciliation = resolve; });
		const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => {
				inspections += 1;
				if (holdNextReconciliation) { holdNextReconciliation = false; enteredHeldReconciliation(); await heldReconciliation; }
				return { exists: true };
			}, interrupt: async () => { throw new Error("auto Herdr cleanup must not send keys"); }, close: async () => { throw new Error("auto Herdr cleanup must not close"); } };
		const waitFor = async (condition: () => boolean) => {
			for (let attempt = 0; attempt < 120 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
			assert.ok(condition(), "timed out waiting for completed Herdr watcher");
		};
		try {
			await fs.promises.writeFile(paths.completionPath, `${JSON.stringify(completion)}\n`, { mode: 0o600 });
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(watchCompletedHerdrDirectRunForRetirementForTest(runId, completion), true);
			await waitFor(() => subscriptions === 1 && inspections >= 1);
			await new Promise((resolve) => setTimeout(resolve, 80));
			const idleInspections = inspections;
			const idleRequests = calls.length;
			await new Promise((resolve) => setTimeout(resolve, 5_100));
			assert.equal(inspections, idleInspections, "idle completion watching must not retain the former 5s backend polling loop");
			assert.equal(calls.length, idleRequests, "idle event stream must not issue pane.get or pane.list");
			const assertBoundedEvent = async (frame: Record<string, unknown>, label: string) => {
				const before = inspections;
				stream!.write(`${JSON.stringify(frame)}\n`);
				await waitFor(() => inspections > before);
				await new Promise((resolve) => setTimeout(resolve, 80));
				assert.ok(inspections <= before + 2, `${label} has bounded coalesced reconciliation`);
			};
			await assertBoundedEvent({ event: "pane.updated", data: { pane } }, "relevant pane event");
			await assertBoundedEvent({ event: "tab.closed", data: { workspace_id: pane.workspace_id, tab_id: pane.tab_id } }, "relevant tab event");
			await assertBoundedEvent({ event: "workspace.closed", data: { workspace_id: pane.workspace_id } }, "relevant workspace event");
			const beforeReconnect = inspections;
			stream!.destroy();
			await waitFor(() => subscriptions === 2 && inspections > beforeReconnect);
			assert.ok(inspections <= beforeReconnect + 5, "disconnect/reconnect reconciliation remains bounded");
			assert.equal(calls.includes("agent.wait"), false);
			assert.equal(calls.some((method) => ["pane.close", "tab.close", "pane.send_keys", "agent.send-keys"].includes(method)), false);
			holdNextReconciliation = true;
			stream!.write(`${JSON.stringify({ event: "pane.updated", data: { pane } })}\n`);
			await heldReconciliationEntered;
			let resetSettled = false;
			const reset = resetInteractiveShutdownForSession().then(() => { resetSettled = true; });
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(resetSettled, false, "reset waits for an already-started watcher reconciliation outside the fence");
			releaseHeldReconciliation();
			await reset;
			const requestsAtReset = calls.length;
			await new Promise((resolve) => setTimeout(resolve, 120));
			assert.equal(calls.length, requestsAtReset, "session reset drains the subscription without a post-stop reconnect or request");
		} finally {
			await resetInteractiveShutdownForSession();
			unregisterCommittedInteractiveRun(runId, true);
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("retains auto Herdr recovery when bounded read-only retirement finds a present or unknown target", { timeout: 8_000 }, async () => {
		await resetInteractiveShutdownForSession();
		for (const [label, snapshot] of [["present", { exists: true }], ["unknown", undefined]] as const) {
			const runId = `herdr-direct-${label}`;
			const handle = { mode: "herdr-pane" as const, native: { socketPath: "/tmp/herdr.sock", socketDev: "1", socketIno: "2", workspaceId: "workspace", tabId: "tab", paneId: "pane", terminalId: "terminal", allocatedTabId: "tab", protocol: 20 as const }, placement: { layout: "auto" as const, placement: "herdr-new-tab" as const } };
			let closes = 0;
			const backend = { mode: "herdr-pane" as const, availabilityError: () => null, launch: async () => handle,
				inspect: async () => snapshot, interrupt: async () => false, close: async () => { closes += 1; return false; } };
			try {
				assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, generation: getInteractiveShutdownGenerationForTest() }), true);
				assert.equal(await releaseRegisteredInteractiveRun(runId), false, label);
				assert.equal(closes, 0, label);
				assert.equal(listActiveInteractiveRunIds().includes(runId), true, label);
			} finally { unregisterCommittedInteractiveRun(runId, true); }
		}
		await resetInteractiveShutdownForSession();
	});

	test("resolves pane layout with CLI precedence and rejects invalid values", () => {
		assert.equal(resolveInteractivePaneLayout(undefined, {}), "auto");
		assert.equal(resolveInteractivePaneLayout(undefined, { PI_SUBAGENT_PANE_LAYOUT: "split" }), "split");
		assert.equal(resolveInteractivePaneLayout("auto", { PI_SUBAGENT_PANE_LAYOUT: "split" }), "auto");
		assert.throws(() => resolveInteractivePaneLayout("AUTO", {}), /--subagent-pane-layout/);
	});

	test("shares three cmux source preflights and retries one fresh epoch across a topology mutation", async () => {
		const workspaceId = "123e4567-e89b-12d3-a456-426614174000";
		const paneId = "123e4567-e89b-12d3-a456-426614174001";
		const surfaceId = "123e4567-e89b-12d3-a456-426614174002";
		const tree = `${JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: surfaceId, pane_id: paneId }] }] }] }] })}\n`;
		const singleFlight = new LaunchPreflightSingleFlight();
		let topologyGeneration = 0, calls = 0, releaseFirst!: () => void;
		const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const run = async () => {
			calls += 1;
			if (calls === 1) await first;
			return { exitCode: 0, stdout: tree, stderr: "", aborted: false };
		};
		const invoke = () => resolveSharedCmuxSourcePreflight({
			run, singleFlight, shutdownGeneration: 7,
			socketGeneration: { socketPath: "/tmp/cmux.sock", socketDev: "1", socketIno: "2" },
			workspaceId, surfaceId, getTopologyGeneration: () => topologyGeneration,
			isShutdownCurrent: () => true, isSocketGenerationCurrent: () => true,
		});
		const pending = [invoke(), invoke(), invoke()];
		while (calls !== 1) await new Promise((resolve) => setTimeout(resolve, 0));
		topologyGeneration += 1;
		releaseFirst();
		const resolved = await Promise.all(pending);
		assert.equal(calls, 2);
		assert.ok(resolved.every((value) => value.workspaceId === workspaceId && value.paneId === paneId && value.surfaceId === surfaceId));
		assert.deepEqual(singleFlight.metrics(), { fetches: 2, joins: 4, failures: 0 });
	});

	test("accepts a changed but generation-stable cmux source observation", async () => {
		const workspaceId = "123e4567-e89b-12d3-a456-426614174030";
		const paneId = "123e4567-e89b-12d3-a456-426614174031";
		const movedPaneId = "123e4567-e89b-12d3-a456-426614174032";
		const surfaceId = "123e4567-e89b-12d3-a456-426614174033";
		const tree = (currentPaneId: string) => `${JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: currentPaneId, surfaces: [{ id: surfaceId, pane_id: currentPaneId }] }] }] }] })}\n`;
		let calls = 0, topologyGeneration = 0;
		const resolved = await resolveSharedCmuxSourcePreflight({
			run: async () => {
				calls += 1;
				if (calls === 1) topologyGeneration += 1;
				return { exitCode: 0, stdout: tree(calls === 1 ? paneId : movedPaneId), stderr: "", aborted: false };
			},
			singleFlight: new LaunchPreflightSingleFlight(), shutdownGeneration: 1,
			socketGeneration: { socketPath: "/tmp/cmux.sock", socketDev: "1", socketIno: "2" },
			workspaceId, surfaceId, getTopologyGeneration: () => topologyGeneration,
			isShutdownCurrent: () => true, isSocketGenerationCurrent: () => true,
		});
		assert.equal(calls, 2, "the second observation is generation-stable");
		assert.equal(resolved.paneId, movedPaneId, "a stable canonical candidate is accepted even when it changed");
	});

	test("accepts a repeated cmux source identity across continuous unrelated topology churn", async () => {
		const workspaceId = "123e4567-e89b-12d3-a456-426614174034";
		const paneId = "123e4567-e89b-12d3-a456-426614174035";
		const surfaceId = "123e4567-e89b-12d3-a456-426614174036";
		const tree = (identity: { workspaceId: string; paneId: string; surfaceId: string }) => `${JSON.stringify({ windows: [{ workspaces: [{ id: identity.workspaceId, panes: [{ id: identity.paneId, surfaces: [{ id: identity.surfaceId, pane_id: identity.paneId }] }] }] }] })}\n`;
		let calls = 0, topologyGeneration = 0;
		const resolved = await resolveSharedCmuxSourcePreflight({
			run: async () => {
				calls += 1;
				topologyGeneration += 1;
				const identity = calls === 1
					? { workspaceId, paneId, surfaceId }
					: { workspaceId: workspaceId.toUpperCase(), paneId: paneId.toUpperCase(), surfaceId: surfaceId.toUpperCase() };
				return { exitCode: 0, stdout: tree(identity), stderr: "", aborted: false };
			},
			singleFlight: new LaunchPreflightSingleFlight(), shutdownGeneration: 1,
			socketGeneration: { socketPath: "/tmp/cmux.sock", socketDev: "1", socketIno: "2" },
			workspaceId, surfaceId, getTopologyGeneration: () => topologyGeneration,
			isShutdownCurrent: () => true, isSocketGenerationCurrent: () => true,
		});
		assert.equal(calls, 2, "the matching second canonical observation settles despite another unrelated mutation");
		assert.equal(resolved.paneId, paneId.toUpperCase(), "canonical identity comparison is case-insensitive");
	});

	test("fences a repeated invalidated identity when shutdown changes during its final socket check", async () => {
		const workspaceId = "123e4567-e89b-12d3-a456-426614174037";
		const paneId = "123e4567-e89b-12d3-a456-426614174038";
		const surfaceId = "123e4567-e89b-12d3-a456-426614174039";
		const tree = `${JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: surfaceId, pane_id: paneId }] }] }] }] })}\n`;
		let calls = 0, topologyGeneration = 0, socketChecks = 0, shutdownCurrent = true;
		let secondSocketCheckEntered!: () => void, resolveSecondSocketCheck!: (current: boolean) => void;
		const secondSocketCheckStarted = new Promise<void>((resolve) => { secondSocketCheckEntered = resolve; });
		const secondSocketCheck = new Promise<boolean>((resolve) => { resolveSecondSocketCheck = resolve; });
		const preflight = resolveSharedCmuxSourcePreflight({
			run: async () => {
				calls += 1;
				topologyGeneration += 1;
				return { exitCode: 0, stdout: tree, stderr: "", aborted: false };
			},
			singleFlight: new LaunchPreflightSingleFlight(), shutdownGeneration: 1,
			socketGeneration: { socketPath: "/tmp/cmux.sock", socketDev: "1", socketIno: "2" },
			workspaceId, surfaceId, getTopologyGeneration: () => topologyGeneration,
			isShutdownCurrent: () => shutdownCurrent,
			isSocketGenerationCurrent: () => {
				socketChecks += 1;
				if (socketChecks === 2) {
					secondSocketCheckEntered();
					return secondSocketCheck;
				}
				return true;
			},
		});
		await secondSocketCheckStarted;
		shutdownCurrent = false;
		resolveSecondSocketCheck(true);
		await assert.rejects(
			() => preflight,
			(error: unknown) => error instanceof CmuxSourcePreflightError && error.parserFailure === "shutdown-fenced",
			"a current socket must not allow stale repeated-identity success after shutdown",
		);
		assert.equal(calls, 2, "the repeated identity reaches the final success path only after two invalidated observations");
		assert.equal(socketChecks, 2, "the shutdown fence runs after the pending second socket-current result, preserving a socket failure's existing precedence");
	});

	test("fences repeated generation-invalidated identities when shutdown or socket currency changes", async () => {
		const workspaceId = "123e4567-e89b-12d3-a456-426614174037";
		const paneId = "123e4567-e89b-12d3-a456-426614174038";
		const surfaceId = "123e4567-e89b-12d3-a456-426614174039";
		const tree = `${JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: surfaceId, pane_id: paneId }] }] }] }] })}\n`;
		for (const [fence, expected] of [["shutdown", "shutdown-fenced"], ["socket", "socket-generation-changed"]] as const) {
			let calls = 0, topologyGeneration = 0;
			await assert.rejects(
				() => resolveSharedCmuxSourcePreflight({
					run: async () => {
						calls += 1;
						topologyGeneration += 1;
						return { exitCode: 0, stdout: tree, stderr: "", aborted: false };
					},
					singleFlight: new LaunchPreflightSingleFlight(), shutdownGeneration: 1,
					socketGeneration: { socketPath: "/tmp/cmux.sock", socketDev: "1", socketIno: "2" },
					workspaceId, surfaceId, getTopologyGeneration: () => topologyGeneration,
					isShutdownCurrent: () => fence !== "shutdown" || calls < 2,
					isSocketGenerationCurrent: () => fence !== "socket" || calls < 2,
				}),
				(error: unknown) => error instanceof CmuxSourcePreflightError && error.parserFailure === expected,
			);
			assert.equal(calls, 2, `${fence} changes after the first invalidated identity is retained`);
		}
	});

	test("rejects cmux preflight after three generation-invalidated source movements", async () => {
		const workspaceId = "123e4567-e89b-12d3-a456-426614174040";
		const paneId = "123e4567-e89b-12d3-a456-426614174041";
		const movedPaneId = "123e4567-e89b-12d3-a456-426614174042";
		const movedAgainPaneId = "123e4567-e89b-12d3-a456-426614174043";
		const surfaceId = "123e4567-e89b-12d3-a456-426614174044";
		const tree = (currentPaneId: string) => `${JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: currentPaneId, surfaces: [{ id: surfaceId, pane_id: currentPaneId }] }] }] }] })}\n`;
		const paneIds = [paneId, movedPaneId, movedAgainPaneId];
		let calls = 0, topologyGeneration = 0;
		await assert.rejects(
			() => resolveSharedCmuxSourcePreflight({
				run: async () => {
					calls += 1;
					topologyGeneration += 1;
					return { exitCode: 0, stdout: tree(paneIds[calls - 1]!), stderr: "", aborted: false };
				},
				singleFlight: new LaunchPreflightSingleFlight(), shutdownGeneration: 1,
				socketGeneration: { socketPath: "/tmp/cmux.sock", socketDev: "1", socketIno: "2" },
				workspaceId, surfaceId, getTopologyGeneration: () => topologyGeneration,
				isShutdownCurrent: () => true, isSocketGenerationCurrent: () => true,
			}),
			(error: unknown) => error instanceof CmuxSourcePreflightError && error.parserFailure === "topology-mutated",
		);
		assert.equal(calls, 3, "all three changed, generation-invalidated observations consume the retry bound");
	});

	test("invalidates cmux events authority on app or identify generation changes", () => {
		const authority = { connection: { socketPath: "/private/tmp/cmux.sock", socketDev: "1", socketIno: "2" }, appVersion: "0.64.20", identifyDigest: "a".repeat(64) };
		const key = cmuxEventsAuthorityKeyForTest(authority);
		assert.equal(shouldReplaceCmuxEventsAuthorityForTest(key, authority), false);
		assert.equal(shouldReplaceCmuxEventsAuthorityForTest(key, { ...authority, appVersion: "0.65.0" }), true);
		assert.equal(shouldReplaceCmuxEventsAuthorityForTest(key, { ...authority, identifyDigest: "b".repeat(64) }), true);
		assert.equal(shouldReplaceCmuxEventsAuthorityForTest(key, { ...authority, connection: { ...authority.connection, socketIno: "3" } }), true);
	});

	test("fences cmux source preflight only for structural topology events", () => {
		for (const name of ["window.created", "workspace.closed", "workspace.moved", "pane.joined", "surface.created", "surface.reordered"]) {
			assert.equal(isCmuxTopologyMutationEventForTest(name), true, name);
		}
		for (const name of ["surface.input_sent", "surface.key_sent", "surface.selected", "surface.focused", "pane.focused", "pane.resized", "workspace.selected", "agent.hook.Stop"]) {
			assert.equal(isCmuxTopologyMutationEventForTest(name), false, name);
		}
	});

	test("keys cmux source preflight by shutdown, socket generation, workspace, and surface", async () => {
		const ids = ["123e4567-e89b-12d3-a456-426614174010", "123e4567-e89b-12d3-a456-426614174011", "123e4567-e89b-12d3-a456-426614174012", "123e4567-e89b-12d3-a456-426614174013", "123e4567-e89b-12d3-a456-426614174014", "123e4567-e89b-12d3-a456-426614174015", "123e4567-e89b-12d3-a456-426614174016"];
		const [workspaceId, paneId, surfaceId, surfaceTwo, workspaceTwo, paneTwo, surfaceThree] = ids;
		const tree = `${JSON.stringify({ windows: [{ workspaces: [
			{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: surfaceId, pane_id: paneId }, { id: surfaceTwo, pane_id: paneId }] }] },
			{ id: workspaceTwo, panes: [{ id: paneTwo, surfaces: [{ id: surfaceThree, pane_id: paneTwo }] }] },
		] }] })}\n`;
		const singleFlight = new LaunchPreflightSingleFlight(); let calls = 0;
		const base = { run: async () => { calls += 1; return { exitCode: 0, stdout: tree, stderr: "", aborted: false }; }, singleFlight, workspaceId, surfaceId, getTopologyGeneration: () => 0, isShutdownCurrent: () => true, isSocketGenerationCurrent: () => true };
		await Promise.all([
			resolveSharedCmuxSourcePreflight({ ...base, shutdownGeneration: 1, socketGeneration: { socketPath: "/tmp/a", socketDev: "1", socketIno: "1" } }),
			resolveSharedCmuxSourcePreflight({ ...base, shutdownGeneration: 2, socketGeneration: { socketPath: "/tmp/a", socketDev: "1", socketIno: "1" } }),
			resolveSharedCmuxSourcePreflight({ ...base, shutdownGeneration: 1, socketGeneration: { socketPath: "/tmp/b", socketDev: "2", socketIno: "2" } }),
			resolveSharedCmuxSourcePreflight({ ...base, surfaceId: surfaceTwo, shutdownGeneration: 1, socketGeneration: { socketPath: "/tmp/a", socketDev: "1", socketIno: "1" } }),
			resolveSharedCmuxSourcePreflight({ ...base, workspaceId: workspaceTwo, surfaceId: surfaceThree, shutdownGeneration: 1, socketGeneration: { socketPath: "/tmp/a", socketDev: "1", socketIno: "1" } }),
		]);
		assert.equal(calls, 5);
	});

	test("preserves cmux control exit/code/state and parser failure diagnostics", async () => {
		const common = { singleFlight: new LaunchPreflightSingleFlight(), shutdownGeneration: 1, socketGeneration: { socketPath: "/tmp/cmux", socketDev: "1", socketIno: "2" }, workspaceId: "123e4567-e89b-12d3-a456-426614174020", surfaceId: "123e4567-e89b-12d3-a456-426614174021", getTopologyGeneration: () => 0, isShutdownCurrent: () => true, isSocketGenerationCurrent: () => true };
		await assert.rejects(
			() => resolveSharedCmuxSourcePreflight({ ...common, run: async () => ({ exitCode: 124, stdout: "", stderr: "timeout", aborted: false, diagnostic: { kind: "control" as const, code: "CMUX_TIMEOUT", state: "flushed" } }) }),
			(error: unknown) => error instanceof CmuxSourcePreflightError && error.exitCode === 124 && error.controlErrorCode === "CMUX_TIMEOUT" && error.parserFailure === "not-run" && /state=flushed/.test(error.message),
		);
		await assert.rejects(
			() => resolveSharedCmuxSourcePreflight({ ...common, singleFlight: new LaunchPreflightSingleFlight(), run: async () => ({ exitCode: 0, stdout: "not-json\n", stderr: "", aborted: false }) }),
			(error: unknown) => error instanceof CmuxSourcePreflightError && error.exitCode === 0 && error.controlErrorCode === "none" && error.parserFailure === "invalid-json",
		);
	});

	test("requires Pi 0.80.10 or newer for agent_settled", () => {
		assert.equal(isPiVersionAtLeast("0.80.9"), false);
		assert.equal(isPiVersionAtLeast("0.80.10"), true);
		assert.equal(isPiVersionAtLeast("0.80.11"), true);
		assert.equal(isPiVersionAtLeast("0.81.0"), true);
		assert.equal(isPiVersionAtLeast("0.81.0-beta.1"), false);
		assert.equal(isPiVersionAtLeast("garbage"), false);
		assert.equal(isPiVersionAtLeast("unknown"), false);
	});

	test("reuses the Pi version result per executable generation and invalidates on replacement", async () => {
		resetInteractivePiVersionChecksForTest();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-version-cache-"));
		try {
			const executable = path.join(root, "pi"); await fs.promises.writeFile(executable, "v1", { mode: 0o700 });
			let calls = 0;
			const run = async () => { calls += 1; return { exitCode: 0, stdout: "0.81.0\n", stderr: "" }; };
			const proof = await verifyInteractivePiVersionCached({ command: executable, run });
			await verifyInteractivePiVersionCached({ command: executable, run });
			assert.equal(calls, 1); assert.equal(isInteractivePiVersionProofCurrent(proof), true);
			await new Promise((resolve) => setTimeout(resolve, 2)); await fs.promises.writeFile(executable, "v2", { mode: 0o700 });
			assert.equal(isInteractivePiVersionProofCurrent(proof), false);
			await verifyInteractivePiVersionCached({ command: executable, run });
			assert.equal(calls, 2);
			const entrypoint = path.join(root, "pi.js"); await fs.promises.writeFile(entrypoint, "aaaa", { mode: 0o700 });
			const entryProof = await verifyInteractivePiVersionCached({ command: executable, prefixArgs: [entrypoint], run });
			await new Promise((resolve) => setTimeout(resolve, 2)); await fs.promises.writeFile(entrypoint, "bbbb", { mode: 0o700 });
			assert.equal(isInteractivePiVersionProofCurrent(entryProof), false);
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); resetInteractivePiVersionChecksForTest(); }
	});

	test("builds interactive Pi args without JSON, print, or no-session flags", () => {
		const args = buildInteractivePiArgs(
			agent,
			"/tmp/run/system-prompt.md",
			"/tmp/run/task.md",
			"/tmp/run/child-session.jsonl",
		);
		assert.equal(args.includes("--mode"), false);
		assert.equal(args.includes("-p"), false);
		assert.equal(args.includes("--print"), false);
		assert.equal(args.includes("--no-session"), false);
		assert.deepEqual(args.slice(args.indexOf("--session"), args.indexOf("--session") + 2), [
			"--session", "/tmp/run/child-session.jsonl",
		]);
		assert.equal(args.filter((value) => value === resolveCurrentPackageExtensionEntrypoint()).length, 1);
		assert.equal(args.filter((value) => value === buildInteractiveExtensionArgs([]).at(-1)).length, 1);
		assert.equal(args.at(-1), "@/tmp/run/task.md");
	});

	test("builds a minimal managed child profile while preserving bridge and nested delegation", () => {
		assert.equal(resolveManagedChildPolicy({}), "inherit");
		assert.equal(resolveManagedChildPolicy({ PI_SUBAGENT_CMUX_CHILD_POLICY: "managed" }), "managed");
		assert.throws(() => resolveManagedChildPolicy({ PI_SUBAGENT_CMUX_CHILD_POLICY: "other" }));
		assert.doesNotThrow(() => assertManagedChildToolCompatibility({ tools: ["read", "subagent"] }));
		assert.throws(() => assertManagedChildToolCompatibility({ tools: ["cmux_open_terminal"] }), /cannot preserve/);
		assert.throws(() => assertManagedChildToolCompatibility({ tools: ["read"] }, undefined, ["read"]), /extension overrides/);
		assert.throws(() => assertManagedChildToolCompatibility({}, undefined, ["read"]), /extension overrides/);
		assert.doesNotThrow(() => assertManagedChildToolCompatibility({}, undefined, ["read"], true));
		assert.doesNotThrow(() => assertManagedChildToolCompatibility({}, undefined, ["grep"]));
		const args = buildInteractivePiArgs({ name: "worker", description: "", systemPrompt: "", source: "user", filePath: "/tmp/worker.md", tools: ["read", "subagent"] }, null, "/tmp/task", "/tmp/session", undefined, "managed");
		assert.ok(args.includes("--no-extensions"));
		assert.equal(args.filter((value) => value === "--extension").length, 2);
		assert.ok(args.some((value) => value.endsWith("index.ts")));
		assert.ok(args.some((value) => value.endsWith("child-bridge.ts")));
		const inlineArgs = buildPiArgs({ name: "worker", description: "", systemPrompt: "", source: "user", filePath: "/tmp/worker.md", tools: ["subagent"] }, null, "/tmp/task", "spawn", null, undefined, "managed");
		assert.ok(inlineArgs.includes("--no-extensions"));
		assert.equal(inlineArgs.filter((value) => value === "--extension").length, 1);
		assert.ok(inlineArgs.some((value) => value.endsWith("index.ts")));
		assert.ok(!inlineArgs.some((value) => value.endsWith("child-bridge.ts")));
		const forkArgs = buildPiArgs({ name: "worker", description: "", systemPrompt: "", source: "user", filePath: "/tmp/worker.md", tools: ["subagent"] }, null, "/tmp/task", "fork", "/tmp/session", undefined, "managed");
		assert.equal(forkArgs.filter((value) => value === "--extension").length, 2);
		assert.ok(forkArgs.some((value) => value.endsWith("child-bridge.ts")));
	});

	test("adds the self extension when inheritance omits it", () => {
		const self = resolveCurrentPackageExtensionEntrypoint();
		const args = buildInteractiveExtensionArgs(["--extension", "/trusted/inherited.ts"]);
		assert.deepEqual(args.slice(0, 4), [
			"--extension", "/trusted/inherited.ts",
			"--extension", self,
		]);
		assert.equal(args[4], "--extension");
		assert.equal(args.filter((value) => value === self).length, 1);
		assert.equal(args.filter((value) => value.endsWith("child-bridge.ts")).length, 1);
	});

	test("deduplicates inherited self and child bridge extensions", () => {
		const self = resolveCurrentPackageExtensionEntrypoint();
		const bridge = buildInteractiveExtensionArgs([]).at(-1)!;
		const args = buildInteractiveExtensionArgs([
			"-e", pathToFileURL(self).href,
			"--extension", pathToFileURL(bridge).href,
			"--extension", self,
			"-e", bridge,
			"--extension", "/trusted/inherited.ts",
		]);
		assert.deepEqual(args, [
			"--extension", "/trusted/inherited.ts",
			"--extension", self,
			"--extension", bridge,
		]);
	});

	test("derives the package extension entrypoint from an installed-style runtime path", () => {
		const runtimeUrl = pathToFileURL("/opt/node_modules/@mjakl/pi-subagent/src/runtime/runner.ts").href;
		assert.equal(
			resolveCurrentPackageExtensionEntrypoint(runtimeUrl),
			"/opt/node_modules/@mjakl/pi-subagent/index.ts",
		);
	});

	test("strips child project controls even without a .pi directory or with .agents skills", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-no-pi-"));
		try {
			await fs.promises.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
			for (const cwd of [root, path.join(root, ".agents", "skills")]) {
				const args = ["--approve", "--context-file", "/tmp/foreign.md", "-nc"];
				applyChildProjectIsolation(args, cwd);
				assert.deepEqual(args, ["--no-context-files", "--no-approve"]);
			}
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("keeps child Pi project-unapproved even when an approved agent lives beside a malicious extension", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-project-"));
		try {
			await fs.promises.mkdir(path.join(root, ".pi", "agents"), { recursive: true });
			await fs.promises.mkdir(path.join(root, ".pi", "extensions"));
			await fs.promises.writeFile(path.join(root, ".pi", "extensions", "malicious.ts"), "throw new Error('must not load');\n");
			const args = ["--approve", "--context-files", "/tmp/foreign-context.md", "-nc", ...buildInteractivePiArgs(agent, null, "/tmp/task.md", "/tmp/child.jsonl")];
			applyChildProjectIsolation(args, root);
			assert.equal(args.includes("--approve"), false);
			assert.equal(args.includes("--context-files"), false);
			assert.equal(args.includes("-nc"), false);
			assert.equal(args.filter((arg) => arg === "--no-context-files").length, 1);
			assert.equal(args.filter((arg) => arg === "--no-approve").length, 1);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("creates a new child session header and retains fork branch entries", () => {
		const parent = JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "context" } });
		const jsonl = buildInteractiveChildSessionJsonl({
			cwd: "/new",
			parentSessionFile: "/sessions/parent.jsonl",
			forkSessionSnapshotJsonl: parent,
			sessionId: "child",
		});
		const lines = jsonl.trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(lines[0], {
			type: "session",
			version: 3,
			id: "child",
			timestamp: lines[0].timestamp,
			cwd: "/new",
		});
		assert.equal("parentSession" in lines[0], false, "child headers must not disclose the parent session pathname");
		assert.equal(lines[1].id, "m1");
		assert.equal(lines.some((line) => line.id === "parent"), false);
		assert.deepEqual(lines.slice(1).map((line) => JSON.stringify(line)), [parent]);
	});

	test("fails closed for malformed, header, and non-entry fork branch sources", () => {
		for (const source of ["{", JSON.stringify({ type: "session", id: "parent" }), "null", JSON.stringify({ type: 1 })]) {
			assert.throws(() => validateForkBranchSourceJsonl(source), /Fork branch source/);
		}
	});

	test("keeps the gated child TUI attached directly to the terminal and changes to its effective cwd", () => {
		const script = buildInteractivePaneWrapperScript({
			effectiveCwd: "/tmp/project",
			childCommand: ["pi", "--session", "/tmp/run/child-session.jsonl", "@/tmp/run/task.md"],
			exportedEnv: { [SUBAGENT_RUN_ID_ENV]: "run-id" },
			wrapperStatusPath: "/tmp/run/wrapper-status",
			cleanupDirs: ["/tmp/run/auth overlay"],
			surfaceTitle: "worker [depth=1;run=12345678]",
		});
		assert.match(script, /pi.*--session/);
		assert.equal(script.includes("pane-renderer"), false);
		assert.equal(script.includes(" | "), false);
		assert.equal(script.includes("Task: "), false);
		assert.match(script, /cd '\/tmp\/project' \|\| exit 1/);
		assert.match(script, /^#!\/bin\/bash/m);
		assert.match(script, /unset NODE_OPTIONS NODE_PATH BUN_OPTIONS/);
		assert.match(script, /trap finish_subagent_runtime EXIT/);
		assert.match(script, /\/bin\/rm -rf '\/tmp\/run\/auth overlay'/);
		assert.match(script, /printf '\\033\]2;%s\\007' 'worker \[depth=1;run=12345678\] · queued'/);
	});

	test("runs the post-gate wrapper from private state but enters the effective workspace before its child", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-wrapper-cwd-"));
		try {
			const runDir = path.join(root, "state", "run"), workspace = path.join(root, "project", "workspace"), marker = path.join(root, "cwd");
			await fs.promises.mkdir(runDir, { recursive: true }); await fs.promises.mkdir(workspace, { recursive: true });
			const wrapper = path.join(runDir, "wrapper.sh");
			await fs.promises.writeFile(wrapper, buildInteractivePaneWrapperScript({
				effectiveCwd: workspace, childCommand: ["/bin/sh", "-c", `pwd > ${JSON.stringify(marker)}`], exportedEnv: {}, wrapperStatusPath: path.join(runDir, "status"),
			}), { mode: 0o700 });
			const exitCode = await new Promise<number>((resolve, reject) => {
				const child = spawn("/bin/bash", [wrapper], { cwd: runDir, stdio: "ignore" }); child.once("error", reject); child.once("close", (code) => resolve(code ?? 1));
			});
			assert.equal(exitCode, 0);
			assert.equal((await fs.promises.readFile(marker, "utf8")).trim(), workspace);
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("checks the Herdr direct durable gate before secrets, cwd, title, or permits", () => {
		const script = buildInteractivePaneWrapperScript({
			effectiveCwd: "/tmp/project", childCommand: ["/bin/true"], exportedEnv: {}, secretEnvPath: "/tmp/run/secret-env.sh",
			wrapperStatusPath: "/tmp/run/status", surfaceTitle: "worker [depth=1;run=gate]", treePermitBootstrapPath: "/tmp/run/permit",
			herdrDirectGate: { runtime: "/usr/bin/node", entrypoint: "/tmp/run/broker.mjs", runDir: "/tmp/run", nonce: "a".repeat(43), runtimeInterpreter: "/usr/bin/node", backend: "/usr/bin/node" },
		});
		const gate = script.indexOf("--verify-herdr-direct-gate");
		assert.ok(gate >= 0);
		assert.ok(gate < script.indexOf("secret-env.sh"));
		assert.ok(gate < script.indexOf("cd '/tmp/project'"));
		assert.ok(gate < script.indexOf("printf '\\033]2;%s\\007'"));
		assert.ok(gate < script.lastIndexOf("/tmp/run/permit"));
	});

	test("stops the interactive wrapper before Pi startup until tree permit continuation", async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-permit-wrapper-"));
		try {
			const gatePath = path.join(root, "tree-permit-bootstrap.json");
			const markerPath = path.join(root, "child-ran");
			const wrapperPath = path.join(root, "wrapper.sh");
			const script = buildInteractivePaneWrapperScript({
				effectiveCwd: root,
				childCommand: ["/usr/bin/touch", markerPath],
				exportedEnv: {},
				wrapperStatusPath: path.join(root, "status"),
				surfaceTitle: "worker [depth=1;run=permit]",
				treePermitBootstrapPath: gatePath,
			});
			assert.ok(script.indexOf("worker [depth=1;run=permit] · queued") < script.indexOf('command kill -STOP "$$"'));
			await fs.promises.writeFile(wrapperPath, script, { mode: 0o700 });
			const child = spawn("/bin/bash", [wrapperPath], { stdio: "ignore" });
			for (let attempt = 0; attempt < 200 && !fs.existsSync(gatePath); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(fs.existsSync(markerPath), false, "child command cannot run before permit bind");
			assert.equal((JSON.parse(await fs.promises.readFile(gatePath, "utf8")) as { pid: number }).pid, child.pid);
			let stopped = false;
			for (let attempt = 0; attempt < 200 && !stopped; attempt += 1) {
				stopped = /^T/.test(spawnSync("/bin/ps", ["-o", "state=", "-p", String(child.pid)], { encoding: "utf8" }).stdout.trim());
				if (!stopped) await new Promise((resolve) => setTimeout(resolve, 5));
			}
			assert.equal(stopped, true);
			process.kill(child.pid!, "SIGCONT");
			const exitCode = await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
			assert.equal(exitCode, 0);
			assert.equal(fs.existsSync(markerPath), true);
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("records wrapper failure and does not run the child when cwd is invalid", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-wrapper-"));
		try {
			const envPath = path.join(root, "env.sh");
			const statusPath = path.join(root, "status");
			const markerPath = path.join(root, "child-ran");
			const wrapperPath = path.join(root, "wrapper.sh");
			await fs.promises.writeFile(envPath, "export PATH='/usr/bin:/bin'\nexport WRAPPER_TEST='ok'\n", { mode: 0o600 });
			await fs.promises.writeFile(wrapperPath, buildInteractivePaneWrapperScript({
				effectiveCwd: path.join(root, "missing"),
				childCommand: ["sh", "-c", `/usr/bin/touch '${markerPath}'`],
				exportedEnv: {},
				secretEnvPath: envPath,
				wrapperStatusPath: statusPath,
			}), { mode: 0o700 });
			const exitCode = await new Promise<number>((resolve, reject) => {
				const child = spawn("bash", [wrapperPath], { stdio: "ignore" });
				child.once("error", reject);
				child.once("close", (code) => resolve(code ?? 1));
			});
			assert.notEqual(exitCode, 0);
			assert.equal(fs.existsSync(markerPath), false);
			assert.equal(fs.existsSync(envPath), false);
			assert.equal((await fs.promises.readFile(statusPath, "utf-8")).trim(), "1");
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("restores cmux, documented provider, and proxy authorities only from the private child environment script", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-wrapper-"));
		try {
			const envPath = path.join(root, "env.sh"), statusPath = path.join(root, "status"), markerPath = path.join(root, "child-env"), wrapperPath = path.join(root, "wrapper.sh");
			await fs.promises.writeFile(envPath, buildPrivateChildEnvironmentScript({
				CMUX_SOCKET_PATH: "/private/socket", CMUX_SOCKET_CAPABILITY: "private-capability",
				CMUX_BUNDLED_CLI_PATH: "/private/cmux", OPENAI_API_KEY: "openai-secret", ANTHROPIC_API_KEY: "anthropic-secret",
				HTTPS_PROXY: "http://proxy", NO_PROXY: "localhost", ARBITRARY_CMUX_ENV: "blocked", UNRELATED_SECRET: "blocked",
			}), { mode: 0o600 });
			await fs.promises.writeFile(wrapperPath, buildInteractivePaneWrapperScript({
				effectiveCwd: root,
				childCommand: ["/bin/sh", "-c", `printf '%s|%s|%s|%s|%s|%s|%s|%s|%s|%s' "$CMUX_SOCKET_PATH" "$CMUX_SOCKET_CAPABILITY" "$CMUX_BUNDLED_CLI_PATH" "$CMUX_WORKSPACE_ID" "$CMUX_SURFACE_ID" "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$HTTPS_PROXY" "$NO_PROXY" "\${UNRELATED_SECRET-unset}" > '${markerPath}'`],
				exportedEnv: {}, secretEnvPath: envPath, wrapperStatusPath: statusPath,
			}), { mode: 0o700 });
			const exitCode = await new Promise<number>((resolve, reject) => {
				const child = spawn("bash", [wrapperPath], { stdio: "ignore", env: { ...process.env, CMUX_WORKSPACE_ID: "dynamic-workspace", CMUX_SURFACE_ID: "dynamic-surface", ARBITRARY_CMUX_ENV: "inherited", UNRELATED_SECRET: "inherited" } });
				child.once("error", reject); child.once("close", (code) => resolve(code ?? 1));
			});
			assert.equal(exitCode, 0);
			assert.equal(await fs.promises.readFile(markerPath, "utf8"), "/private/socket||/private/cmux|dynamic-workspace|dynamic-surface|openai-secret|anthropic-secret|http://proxy|localhost|unset");
			assert.equal(fs.existsSync(envPath), false);
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("resolves symlinked shebang runtimes from a user-controlled PATH", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-runtime-"));
		try {
			const bin = path.join(root, "bin"); await fs.promises.mkdir(bin, { mode: 0o700 });
			const target = path.join(bin, "runtime-target");
			const runtime = path.join(bin, "node");
			await fs.promises.writeFile(target, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			await fs.promises.symlink(target, runtime);
			assert.equal(resolveRegularFile(bin, true), null);
			assert.equal(resolveBrokerRuntime({ PATH: bin }), fs.realpathSync(target));
			assert.equal(resolveBrokerRuntime({ PATH: bin, PI_SUBAGENT_BROKER_RUNTIME: runtime }), fs.realpathSync(target));
			assert.equal(resolveBrokerRuntime({ PATH: bin, PI_SUBAGENT_BROKER_RUNTIME: "" }), fs.realpathSync(target));
			assert.equal(resolveRuntimeInterpreter(target, { PATH: bin }), fs.realpathSync("/bin/sh"));
			assert.equal(resolveRuntimeInterpreter(process.execPath, { PATH: bin }), fs.realpathSync(process.execPath));
			const envRuntime = path.join(bin, "env-runtime");
			await fs.promises.writeFile(envRuntime, "#!/usr/bin/env bun\n", { mode: 0o700 });
			const bunShim = path.join(bin, "bun");
			await fs.promises.symlink(process.execPath, bunShim);
			assert.equal(resolveRuntimeInterpreter(envRuntime, { PATH: bin }), fs.realpathSync(process.execPath));
			await fs.promises.unlink(bunShim);
			if (process.platform !== "win32") {
				await fs.promises.chmod(bin, 0o777);
				assert.equal(resolveBrokerRuntime({ PATH: bin }), fs.realpathSync(target));
			}
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("uses nonempty configured backend executables before PATH and fails closed when they are invalid", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-backend-"));
		try {
			const bin = path.join(root, "bin"); await fs.promises.mkdir(bin, { mode: 0o700 });
			const script = path.join(bin, "backend-script");
			const cmux = path.join(bin, "cmux"), tmux = path.join(bin, "tmux"), configured = path.join(root, "configured-backend");
			await fs.promises.writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			await fs.promises.symlink(script, cmux); await fs.promises.symlink(script, tmux);
			await fs.promises.writeFile(configured, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
			assert.equal(resolveBackendExecutable("cmux-pane", { PATH: bin }), fs.realpathSync(script));
			assert.equal(resolveBackendExecutable("cmux-pane", { PATH: bin, CMUX_BUNDLED_CLI_PATH: "" }), fs.realpathSync(script));
			assert.equal(resolveBackendExecutable("cmux-pane", { PATH: bin, CMUX_BUNDLED_CLI_PATH: configured }), fs.realpathSync(configured));
			assert.equal(resolveBackendExecutable("tmux-pane", { PATH: bin }), fs.realpathSync(script));
			assert.equal(resolveBackendExecutable("tmux-pane", { PATH: bin, TMUX_BIN: "" }), fs.realpathSync(script));
			assert.equal(resolveBackendExecutable("tmux-pane", { PATH: bin, TMUX_BIN: configured }), fs.realpathSync(configured));
			assert.equal(resolveBackendExecutable("tmux-pane", { PATH: bin, TMUX_BIN: path.join(root, "missing") }), null);
			assert.equal(resolveBackendPath("tmux-pane", configured), fs.realpathSync(configured));
			const childCwd = path.join(root, "child-cwd"); await fs.promises.mkdir(childCwd);
			const shadow = path.join(childCwd, "tmux"); await fs.promises.writeFile(shadow, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
			const canonical = fs.realpathSync(configured);
			const brokerEnv = buildBrokerEnvironment({ PATH: bin, TMUX_BIN: "./tmux" }, "tmux-pane", canonical);
			assert.equal(brokerEnv.TMUX_BIN, canonical, "a child-cwd shadow cannot replace the resolved backend");
			assert.match(buildPrivateChildEnvironmentScript({ PATH: bin, TMUX_BIN: "tmux" }), new RegExp(`export TMUX_BIN='${fs.realpathSync(script)}'`));
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("spawns brokers with resolver PATH and only explicit backend identity environment", () => {
		const base = {
			PATH: "/safe/bin", HOME: "/safe/home", TMPDIR: "/safe/tmp", TMUX_BIN: "/safe/tmux",
			CMUX_SOCKET_PATH: "/safe/cmux.sock", CMUX_SOCKET_CAPABILITY: "capability", CMUX_BUNDLED_CLI_PATH: "/safe/cmux",
			CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "surface",
			OPENAI_API_KEY: "secret", AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret", RADIUS_API_KEY: "radius-secret",
			AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com", CLOUDFLARE_ACCOUNT_ID: "account-id",
			GOOGLE_APPLICATION_CREDENTIALS: "/private/vertex.json", HTTPS_PROXY: "proxy", BASH_ENV: "/hook", ENV: "/hook",
		};
		assert.deepEqual(buildBrokerEnvironment(base, "cmux-pane"), { PATH: "/safe/bin", HOME: "/safe/home", TMPDIR: "/safe/tmp", TERM: "xterm-256color", CMUX_SOCKET_PATH: "/safe/cmux.sock", CMUX_BUNDLED_CLI_PATH: "/safe/cmux", CMUX_WORKSPACE_ID: "workspace", CMUX_SURFACE_ID: "surface" });
		assert.deepEqual(buildBrokerEnvironment({ ...base, TMUX: "/safe/tmux.sock,1,0", TMUX_PANE: "%1" }, "tmux-pane"), { PATH: "/safe/bin", HOME: "/safe/home", TMPDIR: "/safe/tmp", TERM: "xterm-256color", TMUX: "/safe/tmux.sock,1,0", TMUX_PANE: "%1" });
	});

	test("passes live telemetry only to the broker boundary, never child environments", () => {
		const source = { PATH: "/safe/bin", HOME: "/safe/home", TMPDIR: "/safe/tmp", PI_SUBAGENT_PHASE0_LIVE: "1", PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_DIR: "/private/telemetry", PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_CAPABILITY: "a".repeat(64) };
		const broker = buildBrokerEnvironment(source, "tmux-pane");
		assert.equal(broker.PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_DIR, "/private/telemetry");
		assert.equal(broker.PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_CAPABILITY, "a".repeat(64));
		const child = buildChildProcessEnv({ agentName: "worker", parentDepth: 0, parentAgentStack: [], maxDepth: 3, preventCycles: true, baseEnv: source });
		assert.equal(child.PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_DIR, undefined);
		assert.equal(child.PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_CAPABILITY, undefined);
	});

	test("rejects opposite-mode committed launch authority before gate publication", () => {
		const tmuxAllocation = {
			version: 2 as const, runId: "run", terminalMode: "tmux-pane" as const,
			target: { paneId: "%1", serverPid: 1, panePid: 2 }, allocatedAt: 1,
		};
		assert.equal(allocationMatchesInteractiveBackend(tmuxAllocation, "cmux-pane"), false);
		assert.equal(allocationMatchesInteractiveBackend(tmuxAllocation, "tmux-pane"), true);
		const intent = {
			version: 2 as const, runId: "run", parentSessionId: "parent", parentPid: process.pid, parentStartedAt: 1, terminalMode: "cmux-pane" as const,
			source: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" },
			childSessionFile: "/tmp/run/child-session.jsonl", createdAt: 1, brokerNonce: "a".repeat(43),
			runtimePath: "/usr/bin/node", runtimeInterpreterPath: "/usr/bin/node", backendPath: "/usr/bin/cmux", brokerEntrypoint: "/tmp/broker.mjs",
		};
		const allocation = {
			version: 2 as const, runId: "run", terminalMode: "cmux-pane" as const,
			target: { workspaceId: intent.source.workspaceId, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1,
		};
		const decision = { version: 2 as const, runId: "run", kind: "commit" as const, decidedAt: 1, allocationPath: "/tmp/run/allocation.json", launchPath: "/tmp/run/launch.json" };
		const launch = { version: 2 as const, runId: "run", terminalMode: "tmux-pane" as const, allocationPath: decision.allocationPath, childSessionFile: intent.childSessionFile, committedAt: 1, ownership: "parent-owned" as const };
		assert.equal(hasCommittedInteractiveLaunchAuthority({ intent, allocation, decision, launch, gate: null, mode: "cmux-pane" }), false);
		assert.equal(hasCommittedInteractiveLaunchAuthority({ intent, allocation, decision, launch: { ...launch, terminalMode: "cmux-pane" }, gate: null, mode: "cmux-pane" }), true);
	});

	test("uses a strict printable pipe delimiter when probing the parent tmux pane", () => {
		assert.deepEqual(buildTmuxSourcePaneProbeArgs("/tmp/tmux"), ["-S", "/tmp/tmux", "list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}"]);
		assert.equal(buildTmuxSourcePaneProbeArgs().at(-1)?.includes("\t"), false);
		assert.equal(parseTmuxSourcePaneProbe("%2|123\n%3|456\n", "%3"), 456);
		for (const output of ["%3\t456\n", "%2|123\n%2|124\n", "%2|bad\n%3|456\n", "%2|123|extra\n"]) {
			assert.equal(parseTmuxSourcePaneProbe(output, "%3"), null);
		}
	});

	test("retains recovery metadata for tri-state authority uncertainty and unconfirmed allocations", () => {
		const missing = { outcome: "missing" } as const;
		const validAllocation = { outcome: "valid", value: { version: 2, runId: "r", terminalMode: "tmux-pane", target: { paneId: "%1", serverPid: 1, panePid: 2 }, allocatedAt: 1 } } as const;
		assert.equal(shouldRetainBrokerRecoveryMetadata({ runId: "r", runDir: "/tmp/r", targetConfirmedAbsent: false, status: missing, decision: missing, allocation: validAllocation }), true);
		assert.equal(shouldRetainBrokerRecoveryMetadata({ runId: "r", runDir: "/tmp/r", targetConfirmedAbsent: true, status: missing, decision: missing, allocation: validAllocation }), false);
		assert.equal(shouldRetainBrokerRecoveryMetadata({ runId: "r", runDir: "/tmp/r", targetConfirmedAbsent: true, status: { outcome: "valid", value: { version: 2, runId: "r", writer: "broker", pid: 1, phase: "failed", updatedAt: 1, errorCode: "possible-unrecorded-allocation" } }, decision: missing, allocation: missing }), true);
		assert.equal(shouldRetainBrokerRecoveryMetadata({ runId: "r", runDir: "/tmp/r", targetConfirmedAbsent: true, status: { outcome: "invalid" }, decision: missing, allocation: missing }), true);
	});

	test("serializes documented provider auth and configuration privately without overriding pane identity", () => {
		const script = buildPrivateChildEnvironmentScript({
			OPENAI_API_KEY: "secret'key",
			ANTHROPIC_API_KEY: "anthropic-secret",
			AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
			RADIUS_API_KEY: "radius-secret",
			AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com",
			AZURE_OPENAI_RESOURCE_NAME: "resource",
			AZURE_OPENAI_API_VERSION: "2024-02-01",
			AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-4=deployment",
			CLOUDFLARE_ACCOUNT_ID: "account-id",
			CLOUDFLARE_GATEWAY_ID: "gateway-id",
			AWS_PROFILE: "bedrock-profile",
			AWS_ACCESS_KEY_ID: "access-key",
			AWS_SECRET_ACCESS_KEY: "secret-key",
			AWS_SESSION_TOKEN: "session-token",
			AWS_REGION: "us-west-2",
			AWS_DEFAULT_REGION: "us-east-1",
			AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/credentials",
			AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/var/run/token",
			AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/irsa-token",
			AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/irsa",
			AWS_BEDROCK_FORCE_CACHE: "1",
			AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://bedrock-proxy.example",
			AWS_BEDROCK_SKIP_AUTH: "1",
			AWS_BEDROCK_FORCE_HTTP1: "1",
			GOOGLE_CLOUD_PROJECT: "vertex-project",
			GOOGLE_CLOUD_LOCATION: "us-central1",
			GOOGLE_APPLICATION_CREDENTIALS: "/private/vertex.json",
			PI_CACHE_RETENTION: "long",
			HTTPS_PROXY: "http://proxy",
			no_proxy: "localhost,127.0.0.1",
			SSL_CERT_DIR: "/private/certs",
			PI_CODING_AGENT_DIR: "/tmp/agent",
			TMUX: "/tmp/tmux/default,1,0",
			TMUX_PANE: "%1",
			CMUX_SURFACE_ID: "surface",
			CMUX_SOCKET_PATH: "/private/cmux.sock",
			CMUX_SOCKET_CAPABILITY: "private-capability",
			CMUX_BUNDLED_CLI_PATH: "/Applications/cmux.app/Contents/Resources/bin/cmux",
			TMUX_BIN: "/opt/tmux/tmux",
			[SUBAGENT_EXPECTED_PARENT_PID_ENV]: "123",
			[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV]: "456",
			ARBITRARY_CMUX_ENV: "must-not-pass",
			UNRELATED_SECRET: "must-not-pass",
			PWD: "/wrong",
		});
		assert.match(script, /export OPENAI_API_KEY='secret'"'"'key'/);
		assert.match(script, /export ANTHROPIC_API_KEY='anthropic-secret'/);
		assert.match(script, /export AWS_BEARER_TOKEN_BEDROCK='bedrock-secret'/);
		assert.match(script, /export RADIUS_API_KEY='radius-secret'/);
		for (const [name, value] of Object.entries({
			AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com", AZURE_OPENAI_RESOURCE_NAME: "resource",
			AZURE_OPENAI_API_VERSION: "2024-02-01", AZURE_OPENAI_DEPLOYMENT_NAME_MAP: "gpt-4=deployment",
			CLOUDFLARE_ACCOUNT_ID: "account-id", CLOUDFLARE_GATEWAY_ID: "gateway-id",
			AWS_PROFILE: "bedrock-profile", AWS_ACCESS_KEY_ID: "access-key", AWS_SECRET_ACCESS_KEY: "secret-key", AWS_SESSION_TOKEN: "session-token",
			AWS_REGION: "us-west-2", AWS_DEFAULT_REGION: "us-east-1", AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.2/credentials",
			AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE: "/var/run/token", AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/irsa-token",
			AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/irsa", AWS_BEDROCK_FORCE_CACHE: "1",
			AWS_ENDPOINT_URL_BEDROCK_RUNTIME: "https://bedrock-proxy.example", AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEDROCK_FORCE_HTTP1: "1",
			GOOGLE_CLOUD_PROJECT: "vertex-project", GOOGLE_CLOUD_LOCATION: "us-central1", GOOGLE_APPLICATION_CREDENTIALS: "/private/vertex.json", PI_CACHE_RETENTION: "long",
		})) assert.ok(script.includes(`export ${name}='${value}'`));
		assert.match(script, /export HTTPS_PROXY='http:\/\/proxy'/);
		assert.match(script, /export no_proxy='localhost,127\.0\.0\.1'/);
		assert.match(script, /export SSL_CERT_DIR='\/private\/certs'/);
		assert.match(script, /export PI_CODING_AGENT_DIR='\/tmp\/agent'/);
		assert.equal(script.includes("TMUX="), false);
		assert.equal(script.includes("TMUX_PANE="), false);
		assert.equal(script.includes("CMUX_SURFACE_ID="), false);
		assert.match(script, /export CMUX_SOCKET_PATH='\/private\/cmux\.sock'/);
		assert.equal(script.includes("CMUX_SOCKET_CAPABILITY="), false);
		assert.match(script, /export CMUX_BUNDLED_CLI_PATH='\/Applications\/cmux\.app\/Contents\/Resources\/bin\/cmux'/);
		assert.equal(script.includes("TMUX_BIN="), false, "an unresolvable raw TMUX_BIN is never replayed to a child");
		assert.match(script, new RegExp(`export ${SUBAGENT_EXPECTED_PARENT_PID_ENV}='123'`));
		assert.match(script, new RegExp(`export ${SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV}='456'`));
		assert.equal(script.includes("ARBITRARY_CMUX_ENV="), false);
		assert.equal(script.includes("PWD="), false);
		assert.equal(script.includes("UNRELATED_SECRET="), false);
	});

	test("preserves recovery state when a pane cannot be closed or confirmed gone", async () => {
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		const backend = {
			mode: "cmux-pane" as const,
			availabilityError: () => null,
			launch: async () => handle,
			interrupt: async () => true,
			close: async () => true,
			inspect: async () => ({ exists: true }),
		};
		// A successful close acknowledgement cannot replace an exact absence probe.
		assert.equal(await closeInteractiveTarget(backend, handle), false);
		backend.inspect = async () => ({ exists: true, exited: true });
		assert.equal(await closeInteractiveTarget(backend, handle), false);
		backend.inspect = async () => ({ exists: false });
		assert.equal(await closeInteractiveTarget(backend, handle), true);
	});

	test("serializes tmux close-and-inspect behind the launch topology lock", async () => {
		const releaseLaunch = await acquireTmuxTopologyMutationLockForTest();
		const handle = { mode: "tmux-pane" as const, native: { paneId: "%2", socketPath: "/tmp/tmux.sock", serverPid: 1, panePid: 2 } };
		let closeCalls = 0;
		let inspectCalls = 0;
		const backend: InteractivePaneBackend = {
			mode: "tmux-pane", availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true,
			close: async () => { closeCalls += 1; return true; },
			inspect: async () => { inspectCalls += 1; return { exists: false }; },
		};
		try {
			const closing = closeInteractiveTarget(backend, handle);
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(closeCalls, 0);
			assert.equal(inspectCalls, 0);
			releaseLaunch();
			assert.equal(await closing, true);
			assert.equal(closeCalls, 1);
			assert.equal(inspectCalls, 1);
		} finally {
			releaseLaunch();
		}
	});

	test("cancelling a queued tmux launch lock cannot enter allocation", async () => {
		const releaseLaunch = await acquireTmuxTopologyMutationLockForTest();
		const controller = new AbortController();
		let allocations = 0;
		const queued = (async () => {
			const release = await acquireTmuxTopologyMutationLockForTest(controller.signal);
			try { allocations += 1; } finally { release(); }
		})();
		try {
			controller.abort();
			await assert.rejects(queued, /tmux topology lock acquisition aborted/);
			assert.equal(allocations, 0);
		} finally {
			releaseLaunch();
		}
		const releaseNext = await acquireTmuxTopologyMutationLockForTest();
		releaseNext();
	});

	test("serializes concurrent cmux launch and exact close-and-inspect", async () => {
		const releaseLaunch = await acquireCmuxTopologyMutationLockForTest();
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "exact-surface" } };
		let closeCalls = 0;
		let inspectCalls = 0;
		const backend: InteractivePaneBackend = {
			mode: "cmux-pane", availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true,
			close: async () => { closeCalls += 1; return true; },
			inspect: async () => { inspectCalls += 1; return { exists: false }; },
		};
		try {
			const closing = closeInteractiveTarget(backend, handle);
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(closeCalls, 0);
			assert.equal(inspectCalls, 0);
			releaseLaunch();
			assert.equal(await closing, true);
			assert.equal(closeCalls, 1);
			assert.equal(inspectCalls, 1);
		} finally {
			releaseLaunch();
		}
	});

	test("serializes registered cmux exact cleanup behind the launch topology lock", async () => {
		const releaseLaunch = await acquireCmuxTopologyMutationLockForTest();
		const runId = "cmux-registered-close-lock";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "registered-surface" } };
		let closeCalls = 0;
		const backend: InteractivePaneBackend = {
			mode: "cmux-pane", availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true,
			close: async () => { closeCalls += 1; return true; },
			inspect: async () => ({ exists: false }),
		};
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, generation: getInteractiveShutdownGenerationForTest() }), true);
			const release = releaseRegisteredInteractiveRun(runId);
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(closeCalls, 0);
			releaseLaunch();
			assert.equal(await release, true);
			assert.equal(closeCalls, 1);
		} finally {
			releaseLaunch();
			unregisterCommittedInteractiveRun(runId);
		}
	});

	test("keeps cmux abort queue ordering while a later launch waits", async () => {
		const releaseFirst = await acquireCmuxTopologyMutationLockForTest();
		const controller = new AbortController();
		let laterEntered = false;
		const aborted = acquireCmuxTopologyMutationLockForTest(controller.signal);
		const later = (async () => {
			const release = await acquireCmuxTopologyMutationLockForTest();
			try { laterEntered = true; } finally { release(); }
		})();
		try {
			controller.abort();
			await assert.rejects(aborted, /cmux topology lock acquisition aborted/);
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(laterEntered, false, "the aborted FIFO slot must not let a later launch pass its predecessor");
			releaseFirst();
			await later;
			assert.equal(laterEntered, true);
		} finally {
			releaseFirst();
		}
	});

	test("registers committed ownership before a post-commit gate failure and exact cleanup", async () => {
		const runId = "commit-before-launch-failure";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true, close: async () => true, inspect: async () => ({ exists: false }),
		};
		registerCommittedInteractiveRun({ runId, backend, handle, generation: getInteractiveShutdownGenerationForTest() });
		try {
			// This is the precise window between commit adoption and gate publish:
			// gate failure must still leave the exact allocation actively owned.
			await assert.rejects(async () => { throw new Error("injected gate publication failure"); });
			assert.equal(listActiveInteractiveRunIds().includes(runId), true);
			await backend.interrupt();
			assert.equal(await closeInteractiveTarget(backend, handle), true);
		} finally { unregisterCommittedInteractiveRun(runId); }
	});

	test("reports readable pipe titles and fail-soft unavailable UX title reads", async () => {
		await resetInteractiveShutdownForSession();
		const runId = "ux-tmux-title";
		const handle = { mode: "tmux-pane" as const, native: { paneId: "%2", socketPath: "/tmp/tmux.sock", serverPid: 123, panePid: 456 } };
		let titleResult = { stdout: "readable|pipe title\n", exitCode: 0 };
		let lifecycleInspections = 0;
		const backend = {
			mode: "tmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => { lifecycleInspections += 1; return { exists: true }; },
			inspectForUx: async () => ({
				exists: true,
				title: await readTmuxPaneTitle(handle.native.paneId, handle.native.socketPath, async () => ({ ...titleResult, stderr: "", aborted: false })),
			}),
			interrupt: async () => true, close: async () => true,
		};
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, agent: "worker", depth: 0, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal((await inspectInteractiveRunForUx(runId))?.titleState, "changed", "a readable pipe title remains a UX value, not an unavailable lifecycle value");
			titleResult = { stdout: "", exitCode: 1 };
			assert.equal((await inspectInteractiveRunForUx(runId))?.titleState, "unavailable", "an unavailable title read is fail-soft for UX");
			titleResult = { stdout: "malformed\nsecond-line\n", exitCode: 0 };
			assert.equal((await inspectInteractiveRunForUx(runId))?.titleState, "unavailable", "a malformed title is rejected before UX state");
			assert.equal(lifecycleInspections, 0, "UX inspection must use its separate post-fingerprint path");
		} finally {
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
		}
	});

	test("active V3 tmux UX resolves the current pooled lease and stays unavailable while reconnecting", async () => {
		await resetInteractiveShutdownForSession();
		const runId = "ux-tmux-pooled-lease";
		const handle = { mode: "tmux-pane" as const, native: { paneId: "%2", socketPath: "/private/tmux.sock", serverPid: 123, panePid: 456 } };
		const disconnects: Array<() => void> = [];
		const pooledCommands: Array<{ client: number; line: string; mutation: boolean | undefined }> = [];
		let clientCount = 0;
		const lease = await acquireTmuxControlLease({
			authority: {
				controlContract: "tmux-control-v1", executableGeneration: { realpath: "/private/tmux", dev: "1", ino: "1", size: "1", mtimeNs: "1", ctimeNs: "1" },
				canonicalSocketPath: handle.native.socketPath, socketDev: 1, socketIno: 1, serverPid: handle.native.serverPid, serverStartedAt: 1,
				attachedSessionId: "$1", sourcePaneId: "%1", sourcePanePid: 101, sourceWindowId: "@1",
			},
			createClient: async (onDisconnect) => {
				const client = clientCount++;
				disconnects.push(onDisconnect);
				return {
					close() {}, notificationSequence: () => 0, lastNotificationAt: () => null, waitForNotification: async () => "timeout" as const,
					execute: async (line: string, options: { mutation?: boolean }) => {
						pooledCommands.push({ client, line, mutation: options.mutation });
						if (line.includes("#{pid}")) return ["123"];
						if (line.startsWith("list-panes")) return ["%2|0|456"];
						if (line.includes("#{pane_title}")) return [`pooled title ${client}`];
						throw new Error(`unexpected control command: ${line}`);
					},
				} as any;
			},
			revalidate: async () => true,
		});
		assert.ok(lease);
		let shortLivedCliReads = 0;
		const capturedCliBackend: InteractivePaneBackend = {
			mode: "tmux-pane", availabilityError: () => null, launch: async () => handle,
			inspect: async () => ({ exists: true }),
			inspectForUx: async () => { shortLivedCliReads += 1; return { exists: true, title: "captured CLI" }; },
			interrupt: async () => true, close: async () => true,
		};
		const pooledUxBackend = (): InteractivePaneBackend => ({
			...capturedCliBackend,
			inspectForUx: async (target) => {
				if (target.mode !== "tmux-pane") return undefined;
				const server = await lease.run(buildTmuxServerPidArgs(target.native.socketPath));
				const panes = await lease.run(buildTmuxPaneSnapshotArgs(target.native.socketPath));
				if (server.exitCode !== 0 || server.stdout !== "123\n" || panes.exitCode !== 0 || panes.stdout !== "%2|0|456\n") return undefined;
				const title = await readTmuxPaneTitle(target.native.paneId, target.native.socketPath, lease.run);
				return title ? { exists: true, title } : undefined;
			},
		});
		let activeUxBackend: InteractivePaneBackend | null = null;
		try {
			assert.equal(registerCommittedInteractiveRun({
				runId, backend: capturedCliBackend, uxBackend: () => lease.acceptedTransport() ? activeUxBackend : null,
				handle, generation: getInteractiveShutdownGenerationForTest(),
			}), true);
			assert.equal((await inspectInteractiveRunForUx(runId))?.titleState, "unavailable", "pre-bind V3 UX must not use the captured CLI backend");
			assert.equal(shortLivedCliReads, 0);
			assert.equal(pooledCommands.length, 0);

			activeUxBackend = pooledUxBackend();
			assert.equal((await inspectInteractiveRunForUx(runId))?.titleState, "changed");
			assert.equal(shortLivedCliReads, 0, "connected UX inspection uses the pooled runner, never a short-lived CLI");
			assert.deepEqual(pooledCommands.map(({ line }) => line.split(" ")[0]), ["display-message", "list-panes", "display-message"]);
			assert.ok(pooledCommands.every(({ mutation }) => mutation === false), "UX inspection sends no mutation through the pooled client");

			disconnects[0]!();
			const commandsBeforePendingRead = pooledCommands.length;
			const pending = await inspectInteractiveRunForUx(runId);
			assert.equal(pending?.titleState, "unavailable", "a disconnected/reconnecting lease has fail-soft unavailable UX state");
			assert.equal(pending?.exists, undefined);
			assert.equal(pooledCommands.length, commandsBeforePendingRead, "pending UX must not send an unproven control command");
			assert.equal(shortLivedCliReads, 0, "pending UX must not fall back to the captured CLI backend");

			assert.equal(await lease.reconnect(), true);
			activeUxBackend = pooledUxBackend();
			assert.equal((await inspectInteractiveRunForUx(runId))?.titleState, "changed");
			assert.equal(shortLivedCliReads, 0);
			assert.deepEqual([...new Set(pooledCommands.map(({ client }) => client))], [0, 1], "UX follows the rebound pooled runner after reconnect");
		} finally {
			unregisterCommittedInteractiveRun(runId, true);
			lease.release();
			await resetInteractiveShutdownForSession();
		}
	});

	test("provides exact focus, preview, keep, and durable promote ownership actions", async () => {
		await resetInteractiveShutdownForSession();
		const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ux-authority-"));
		const runId = "ux-promote-run";
		const paths = await prepareRunArtifactPaths({ rootDir, runId });
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId: "123e4567-e89b-12d3-a456-426614174002" } };
		const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: handle.native.workspaceId, surfaceId: handle.native.surfaceId, paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await fs.promises.writeFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`, { mode: 0o600 });
		const childStartedAt = getCurrentProcessStartedAt(); assert.ok(childStartedAt);
		await fs.promises.writeFile(paths.statePath, `${JSON.stringify({ version: 1, runId, sequence: 1, phase: "idle", updatedAt: Date.now(), childPid: process.pid, childStartedAt })}\n`, { mode: 0o600 });
		let focused = 0; let released = 0; let pauseInspect = false; let paneTitle = "child"; let inspectEntered!: () => void; let resumeInspect!: () => void;
		const inspectStarted = new Promise<void>((resolve) => { inspectEntered = resolve; });
		const inspectResume = new Promise<void>((resolve) => { resumeInspect = resolve; });
		const backend = { mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle, inspect: async () => { if (pauseInspect) { inspectEntered(); await inspectResume; } return { exists: true, title: paneTitle }; }, interrupt: async () => true, close: async () => true, focus: async () => { focused += 1; return true; } };
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, invocationId: "foreground-invocation", backend, handle, paths, agent: "worker", depth: 2, generation: getInteractiveShutdownGenerationForTest(), release: async () => { released += 1; return true; } }), true);
			assert.equal(await focusInteractiveRun(runId), true); assert.equal(focused, 1);
			const inspected = await inspectInteractiveRunForUx(runId);
			assert.equal(inspected?.title, "worker [depth=2;run=ux-promo]"); assert.equal(inspected?.titleState, "changed");
			for (const state of ["queued", "ready", "running", "waiting", "returning", "failed"]) {
				paneTitle = `${inspected!.title} · ${state}`;
				assert.equal((await inspectInteractiveRunForUx(runId))?.titleState, "matching");
			}
			paneTitle = inspected!.title!;
			assert.equal((await inspectInteractiveRunForUx(runId))?.titleState, "changed", "a bare base is not a managed lifecycle title");
			paneTitle = `${inspected!.title} · completed`;
			assert.equal((await inspectInteractiveRunForUx(runId))?.titleState, "changed", "only exact lifecycle suffixes match");
			assert.equal(listInteractiveRunUxSnapshots()[0]?.depth, 2);
			assert.equal(listInteractiveRunUxSnapshots()[0]?.invocationId, "foreground-invocation");
			assert.equal(await keepInteractiveRun(runId), true);
			assert.equal(await releaseRegisteredInteractiveRun(runId), false); assert.equal(released, 0);
			pauseInspect = true;
			const childAcknowledgement = (async () => {
				for (let attempt = 0; attempt < 500 && !fs.existsSync(paths.promotionRequestPath); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
				const request = JSON.parse(await fs.promises.readFile(paths.promotionRequestPath, "utf8"));
				const { requestedAt: _requestedAt, ...shared } = request;
				await fs.promises.writeFile(paths.promotionAckPath, `${JSON.stringify({ ...shared, kind: "ack", acknowledgedAt: Date.now() })}\n`, { mode: 0o600 });
			})();
			const promotion = promoteInteractiveRun(runId);
			await inspectStarted;
			const shutdown = beginInteractiveShutdownForSession();
			resumeInspect();
			assert.equal(await promotion, "promoted");
			await childAcknowledgement;
			await shutdown;
			assert.equal(released, 0);
			assert.equal(fs.existsSync(paths.detachedOwnershipPath), true);
			assert.equal(fs.existsSync(paths.userOwnershipPath), false);
			assert.equal(listInteractiveRunUxSnapshots().find((run) => run.runId === runId)?.ownership, "detached");
		} finally {
			// The fake backend has no live target; this test-only teardown supplies
			// the explicit absence proof required for a detached registry record.
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await removeRunArtifacts(paths).catch(() => undefined);
			await fs.promises.rm(rootDir, { recursive: true, force: true });
		}
	});

	test("requires an exact child handshake for a legacy marker and revokes shutdown authority once its request wins", async () => {
		await resetInteractiveShutdownForSession();
		const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ux-legacy-"));
		const runId = "matching-legacy";
		const paths = await prepareRunArtifactPaths({ rootDir, runId });
		const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		const digest = crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex");
		const childStartedAt = getCurrentProcessStartedAt(); assert.ok(childStartedAt);
		await fs.promises.writeFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`, { mode: 0o600 });
		await fs.promises.writeFile(paths.statePath, `${JSON.stringify({ version: 1, runId, sequence: 1, phase: "idle", updatedAt: Date.now(), childPid: process.pid, childStartedAt })}\n`, { mode: 0o600 });
		await fs.promises.writeFile(paths.userOwnershipPath, `${JSON.stringify({ version: 1, runId, promotedAt: 1, allocationDigest: digest })}\n`, { mode: 0o600 });
		let interrupts = 0, releases = 0;
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: allocation.target.workspaceId, surfaceId: allocation.target.surfaceId } };
		const backend = { mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle, inspect: async () => ({ exists: true }), interrupt: async () => { interrupts += 1; return true; }, close: async () => true };
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest(), release: async () => { releases += 1; return true; } }), true);
			const promotion = promoteInteractiveRun(runId);
			for (let attempt = 0; attempt < 500 && !fs.existsSync(paths.promotionRequestPath); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
			assert.equal(fs.existsSync(paths.promotionRequestPath), true, "a legacy marker alone must not promote an active child");
			assert.equal(await Promise.race([promotion.then(() => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20))]), "pending");
			assert.equal(listInteractiveRunUxSnapshots().find((entry) => entry.runId === runId)?.ownership, "transferring", "the winning request fences monitor settlement while revoking parent authority");
			let permitDetaches = 0;
			assert.equal(await settleInteractiveTreePermitAfterOwnershipForTest("transferring", { detachBoundChild: async () => { permitDetaches += 1; return true; } }), true);
			assert.equal(permitDetaches, 0, "a delayed ACK must not detach the permit while the monitor waits");
			// Shutdown fences behind the in-flight transfer; once the child acks it
			// must observe detached authority and issue neither interrupt nor release.
			const shutdown = shutdownActiveInteractiveRuns();
			const request = JSON.parse(await fs.promises.readFile(paths.promotionRequestPath, "utf8"));
			const { requestedAt: _requestedAt, ...shared } = request;
			await fs.promises.writeFile(paths.promotionAckPath, `${JSON.stringify({ ...shared, kind: "ack", acknowledgedAt: Date.now() })}\n`, { mode: 0o600 });
			assert.equal(await promotion, "already-promoted");
			assert.equal(await settleInteractiveTreePermitAfterOwnershipForTest("detached", { detachBoundChild: async () => { permitDetaches += 1; return true; } }), true);
			assert.equal(permitDetaches, 1, "eventual durable promotion detaches the permit exactly once");
			await shutdown;
			assert.equal(interrupts, 0, "shutdown must not interrupt after request/ack revokes authority");
			assert.equal(releases, 0, "shutdown must not release after request/ack revokes authority");
			assert.equal(fs.existsSync(paths.detachedOwnershipPath), true);
		} finally {
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await removeRunArtifacts(paths).catch(() => undefined);
			await fs.promises.rm(rootDir, { recursive: true, force: true });
		}
	});

	test("reconciles a late exact acknowledgement on a same-process promotion retry", async () => {
		await resetInteractiveShutdownForSession();
		const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ux-late-ack-"));
		const runId = "late-ack-retry";
		const paths = await prepareRunArtifactPaths({ rootDir, runId });
		const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		const childStartedAt = getCurrentProcessStartedAt(); assert.ok(childStartedAt);
		await fs.promises.writeFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`, { mode: 0o600 });
		await fs.promises.writeFile(paths.statePath, `${JSON.stringify({ version: 1, runId, sequence: 1, phase: "idle", updatedAt: Date.now(), childPid: process.pid, childStartedAt })}\n`, { mode: 0o600 });
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: allocation.target.workspaceId, surfaceId: allocation.target.surfaceId } };
		let targetLive = true;
		const backend = { mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle, inspect: async () => ({ exists: targetLive }), interrupt: async () => true, close: async () => true };
		const observedOwnerships: string[] = [];
		const unsubscribe = subscribeInteractiveRunChanges(() => {
			const snapshot = listInteractiveRunUxSnapshots().find((entry) => entry.runId === runId);
			if (snapshot) observedOwnerships.push(snapshot.ownership);
		});
		try {
			const request = {
				contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174004", runId,
				allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") },
				parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: process.pid, startedAt: childStartedAt! }, requestedAt: Date.now(),
			};
			await fs.promises.writeFile(paths.promotionRequestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
			const { requestedAt: _requestedAt, ...shared } = request;
			// This acknowledgement arrived after an earlier same-process request
			// attempt timed out; retry must reconcile it instead of staying unknown.
			await fs.promises.writeFile(paths.promotionAckPath, `${JSON.stringify({ ...shared, kind: "ack", acknowledgedAt: Date.now() })}\n`, { mode: 0o600 });
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(await promoteInteractiveRun(runId), "promoted");
			targetLive = false;
			assert.equal(await promoteInteractiveRun(runId), "already-promoted", "a detached retry relies on the durable transfer chain, not target liveness");
			let detachAttempts = 0;
			assert.equal(await settleInteractiveTreePermitAfterOwnershipForTest("detached", { detachBoundChild: async () => ++detachAttempts === 2 }), true);
			assert.equal(detachAttempts, 2, "detached permit settlement retries a transient authority failure");
			let failedDetachAttempts = 0;
			assert.equal(await settleInteractiveTreePermitAfterOwnershipForTest("detached", { detachBoundChild: async () => { failedDetachAttempts += 1; return false; } }), false);
			assert.equal(failedDetachAttempts, 3, "a detached monitor must fail closed after its bounded retry budget");
			await fs.promises.unlink(paths.promotionAckPath);
			assert.equal(await promoteInteractiveRun(runId), "ownership-unknown", "a detached retry fails closed when its transfer chain is incomplete");
			assert.deepEqual(observedOwnerships, ["managed", "detached", "ownership-unknown"], "a detached-to-unknown transition notifies presence observers");
		} finally {
			unsubscribe();
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await removeRunArtifacts(paths).catch(() => undefined);
			await fs.promises.rm(rootDir, { recursive: true, force: true });
		}
	});

	test("requires permit detachment before reporting a durable promotion and retries after monitor exit", async () => {
		await resetInteractiveShutdownForSession();
		const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ux-permit-promotion-"));
		const runId = "permit-promotion-retry";
		const paths = await prepareRunArtifactPaths({ rootDir, runId });
		const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		const childStartedAt = getCurrentProcessStartedAt(); assert.ok(childStartedAt);
		await fs.promises.writeFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`, { mode: 0o600 });
		await fs.promises.writeFile(paths.statePath, `${JSON.stringify({ version: 1, runId, sequence: 1, phase: "idle", updatedAt: Date.now(), childPid: process.pid, childStartedAt })}\n`, { mode: 0o600 });
		const request = { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174005", runId,
			allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") },
			parent: { pid: process.pid, startedAt: getCurrentProcessStartedAt()! }, child: { pid: process.pid, startedAt: childStartedAt! }, requestedAt: Date.now() };
		const { requestedAt: _requestedAt, ...shared } = request;
		await fs.promises.writeFile(paths.promotionRequestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
		await fs.promises.writeFile(paths.promotionAckPath, `${JSON.stringify({ ...shared, kind: "ack", acknowledgedAt: Date.now() })}\n`, { mode: 0o600 });
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: allocation.target.workspaceId, surfaceId: allocation.target.surfaceId } };
		const backend = { mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle, inspect: async () => ({ exists: true }), interrupt: async () => true, close: async () => true };
		let detachAttempts = 0;
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest(), treePermitLease: { detachBoundChild: async () => ++detachAttempts >= 4 } }), true);
			assert.equal(await promoteInteractiveRun(runId), "ownership-unknown");
			assert.equal(detachAttempts, 3, "promotion cannot succeed while bounded permit detach fails");
			assert.equal(await promoteInteractiveRun(runId), "promoted");
			assert.equal(detachAttempts, 4, "the retained active run settles its exact permit before publishing its detached marker");
		} finally {
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await removeRunArtifacts(paths).catch(() => undefined);
			await fs.promises.rm(rootDir, { recursive: true, force: true });
		}
	});

	test("rejects promotion when a terminal completion won before the transfer fence", async () => {
		await resetInteractiveShutdownForSession();
		const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ux-terminal-winner-"));
		const runId = "terminal-winner";
		const paths = await prepareRunArtifactPaths({ rootDir, runId });
		const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		const childStartedAt = getCurrentProcessStartedAt(); assert.ok(childStartedAt);
		await fs.promises.writeFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`, { mode: 0o600 });
		await fs.promises.writeFile(paths.statePath, `${JSON.stringify({ version: 1, runId, sequence: 1, phase: "idle", updatedAt: Date.now(), childPid: process.pid, childStartedAt })}\n`, { mode: 0o600 });
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: allocation.target.workspaceId, surfaceId: allocation.target.surfaceId } };
		let inspected!: () => void, continuePromotion!: () => void;
		const inspectStarted = new Promise<void>((resolve) => { inspected = resolve; });
		const inspectContinue = new Promise<void>((resolve) => { continuePromotion = resolve; });
		const backend = { mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle, inspect: async () => { inspected(); await inspectContinue; return { exists: true }; }, interrupt: async () => true, close: async () => true };
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
			const promotion = promoteInteractiveRun(runId);
			await inspectStarted;
			await fs.promises.writeFile(paths.completionPath, `${JSON.stringify({ version: 2, runId, status: "failed", completedAt: Date.now(), errorCode: "child-error" })}\n`, { mode: 0o600 });
			continuePromotion();
			assert.equal(await promotion, "rejected");
			assert.equal(fs.existsSync(paths.promotionRequestPath), false);
			assert.equal(listInteractiveRunUxSnapshots().find((entry) => entry.runId === runId)?.ownership, "managed");
		} finally {
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await removeRunArtifacts(paths).catch(() => undefined);
			await fs.promises.rm(rootDir, { recursive: true, force: true });
		}
	});

	test("retains parent ownership when valid or malformed completion races an exact promotion ACK", async () => {
		for (const [label, completion] of [
			["valid", { version: 2, status: "failed", completedAt: Date.now(), errorCode: "child-error" }],
			["malformed", "{malformed}\n"],
		] as const) {
			await resetInteractiveShutdownForSession();
			const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pi-subagent-ux-completion-${label}-`));
			const runId = `completion-after-ack-${label}`;
			const paths = await prepareRunArtifactPaths({ rootDir, runId });
			const allocation = { version: 2, runId, terminalMode: "cmux-pane" as const, target: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
			const childStartedAt = getCurrentProcessStartedAt(); assert.ok(childStartedAt);
			await fs.promises.writeFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`, { mode: 0o600 });
			await fs.promises.writeFile(paths.statePath, `${JSON.stringify({ version: 1, runId, sequence: 1, phase: "idle", updatedAt: Date.now(), childPid: process.pid, childStartedAt })}\n`, { mode: 0o600 });
			const handle = { mode: "cmux-pane" as const, native: { workspaceId: allocation.target.workspaceId, surfaceId: allocation.target.surfaceId } };
			const backend = { mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle, inspect: async () => ({ exists: true }), interrupt: async () => true, close: async () => true };
			let detachAttempts = 0;
			try {
				assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest(), treePermitLease: { detachBoundChild: async () => { detachAttempts += 1; return true; } } }), true);
				const acknowledgement = (async () => {
					for (let attempt = 0; attempt < 500 && !fs.existsSync(paths.promotionRequestPath); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
					const request = JSON.parse(await fs.promises.readFile(paths.promotionRequestPath, "utf8"));
					const { requestedAt: _requestedAt, ...shared } = request;
					await fs.promises.writeFile(paths.promotionAckPath, `${JSON.stringify({ ...shared, kind: "ack", acknowledgedAt: Date.now() })}\n`, { mode: 0o600 });
					if (typeof completion === "string") await fs.promises.writeFile(paths.completionPath, completion, { mode: 0o600 });
					else await fs.promises.writeFile(paths.completionPath, `${JSON.stringify({ ...completion, runId })}\n`, { mode: 0o600 });
				})();
				assert.equal(await promoteInteractiveRun(runId), "ownership-unknown");
				await acknowledgement;
				assert.equal(detachAttempts, 0, `${label} completion retains the parent tree permit`);
				assert.equal(fs.existsSync(paths.detachedOwnershipPath), false, `${label} completion prevents detached marker publication`);
			} finally {
				unregisterCommittedInteractiveRun(runId, true);
				await resetInteractiveShutdownForSession();
				await removeRunArtifacts(paths).catch(() => undefined);
				await fs.promises.rm(rootDir, { recursive: true, force: true });
			}
		}
	});

	test("reports unknown ownership as an error and retains its tree permit", async () => {
		const result = { exitCode: -1, stderr: "", sawAgentEnd: undefined } as any;
		applyInteractiveOwnershipUnknownResultForTest(result);
		assert.equal(result.exitCode, 1);
		assert.equal(result.stopReason, "error");
		assert.equal(result.sawAgentEnd, undefined);
		assert.match(result.errorMessage, /ownership transfer is uncertain/);
		let detachAttempts = 0;
		assert.equal(await settleInteractiveTreePermitAfterOwnershipForTest("ownership-unknown", { detachBoundChild: async () => { detachAttempts += 1; return true; } }), true);
		assert.equal(detachAttempts, 0);
	});

	test("keeps malformed promotion ownership visible and revokes local cleanup", async () => {
		await resetInteractiveShutdownForSession();
		const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ux-unknown-"));
		const runId = "ux-unknown-ownership";
		const paths = await prepareRunArtifactPaths({ rootDir, runId });
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId: "123e4567-e89b-12d3-a456-426614174002" } };
		const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: handle.native.workspaceId, surfaceId: handle.native.surfaceId, paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await fs.promises.writeFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`, { mode: 0o600 });
		await fs.promises.writeFile(paths.userOwnershipPath, "{malformed}\n", { mode: 0o600 });
		let releases = 0;
		const backend = { mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle, inspect: async () => ({ exists: true }), interrupt: async () => true, close: async () => true };
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest(), release: async () => { releases += 1; return true; } }), true);
			assert.equal(await promoteInteractiveRun(runId), "ownership-unknown");
			assert.equal(listInteractiveRunUxSnapshots().find((run) => run.runId === runId)?.ownership, "ownership-unknown");
			let detachAttempts = 0;
			assert.equal(await settleInteractiveTreePermitAfterOwnershipForTest("ownership-unknown", { detachBoundChild: async () => { detachAttempts += 1; return true; } }), true);
			assert.equal(detachAttempts, 0, "unknown promotion must retain tree permit authority");
			assert.equal(await releaseRegisteredInteractiveRun(runId, true), false);
			await shutdownActiveInteractiveRuns();
			assert.equal(releases, 0, "shutdown must not mutate a target after promotion authority becomes unknown");
			assert.equal(listActiveInteractiveRunIds().includes(runId), true);
		} finally {
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await removeRunArtifacts(paths).catch(() => undefined);
			await fs.promises.rm(rootDir, { recursive: true, force: true });
		}
	});

	test("fences in-flight tmux pool connects at interactive shutdown and reopens only for the new session", async () => {
		await resetInteractiveShutdownForSession();
		let finishCreate!: () => void;
		const connecting = acquireTmuxControlLease({
			authority: {
				controlContract: "tmux-control-v1", executableGeneration: { realpath: "/bin/tmux", dev: "1", ino: "1", size: "1", mtimeNs: "1", ctimeNs: "1" },
				canonicalSocketPath: "/tmp/interactive-shutdown-race.sock", socketDev: 1, socketIno: 1, serverPid: 1, serverStartedAt: 1,
				attachedSessionId: "$1", sourcePaneId: "%1", sourcePanePid: 1, sourceWindowId: "@1",
			},
			createClient: async () => await new Promise<void>((resolve) => { finishCreate = resolve; }).then(() => ({
				close() {}, notificationSequence: () => 0, lastNotificationAt: () => null,
				waitForNotification: async () => "disconnect" as const, execute: async () => [],
			} as any)),
			revalidate: async () => true,
		});
		const shutdown = beginInteractiveShutdownForSession();
		finishCreate();
		await shutdown;
		assert.equal(await connecting, null);
		assert.deepEqual(snapshotTmuxControlPoolForTest(), { entries: 0, leases: 0, clients: 0 });
		await resetInteractiveShutdownForSession();
		const fresh = await acquireTmuxControlLease({
			authority: {
				controlContract: "tmux-control-v1", executableGeneration: { realpath: "/bin/tmux", dev: "1", ino: "1", size: "1", mtimeNs: "1", ctimeNs: "1" },
				canonicalSocketPath: "/tmp/interactive-shutdown-race.sock", socketDev: 1, socketIno: 1, serverPid: 1, serverStartedAt: 1,
				attachedSessionId: "$1", sourcePaneId: "%1", sourcePanePid: 1, sourceWindowId: "@1",
			},
			createClient: async () => ({ close() {}, notificationSequence: () => 0, lastNotificationAt: () => null, waitForNotification: async () => "disconnect" as const, execute: async () => [] } as any),
			revalidate: async () => true,
		});
		assert.ok(fresh);
		fresh.release();
	});

	test("increments generations across resets and fences old captures", async () => {
		await resetInteractiveShutdownForSession();
		const captured = getInteractiveShutdownGenerationForTest();
		assert.equal(canStartInteractiveRun(captured), true);
		await beginInteractiveShutdownForSession();
		const fenced = getInteractiveShutdownGenerationForTest();
		await beginInteractiveShutdownForSession();
		assert.equal(getInteractiveShutdownGenerationForTest(), fenced);
		assert.equal(canStartInteractiveRun(captured), false);
		await resetInteractiveShutdownForSession();
		assert.equal(canStartInteractiveRun(captured), false);
		assert.equal(canStartInteractiveRun(getInteractiveShutdownGenerationForTest()), true);
	});

	test("does not reopen a reset generation when a newer shutdown arrives during watcher drain", async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reset-fence-drain-"));
		const runId = "reset-fence-drain", paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "workspace", surfaceId: "surface" } };
		let enteredInspect!: () => void, releaseInspect!: () => void;
		const inspectEntered = new Promise<void>((resolve) => { enteredInspect = resolve; });
		const inspectRelease = new Promise<void>((resolve) => { releaseInspect = resolve; });
		const backend = { mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => { enteredInspect(); await inspectRelease; return { exists: false }; }, interrupt: async () => false, close: async () => false };
		try {
			assert.equal(registerCommittedInteractiveRun({ runId, backend, handle, paths, generation: getInteractiveShutdownGenerationForTest() }), true);
			assert.equal(watchDetachedInteractiveRunForRetirementForTest(runId), true);
			await inspectEntered;
			const resetGeneration = getInteractiveShutdownGenerationForTest() + 1;
			const reset = resetInteractiveShutdownForSession();
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(getInteractiveShutdownGenerationForTest(), resetGeneration);
			assert.equal(canStartInteractiveRun(resetGeneration), false, "reset keeps its new generation fenced during drain");
			const shutdown = beginInteractiveShutdownForSession();
			await new Promise((resolve) => setTimeout(resolve, 20));
			const shutdownGeneration = getInteractiveShutdownGenerationForTest();
			assert.equal(shutdownGeneration, resetGeneration + 1, "newer shutdown supersedes the draining reset");
			assert.equal(canStartInteractiveRun(shutdownGeneration), false);
			releaseInspect();
			await Promise.all([reset, shutdown]);
			assert.equal(canStartInteractiveRun(shutdownGeneration), false, "the superseded reset must not reopen a newer shutdown");
		} finally {
			releaseInspect?.();
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("serializes a paused live drain with completion replay and skips later drains", async () => {
		const queue = createInteractiveResultMutationQueueForTest();
		let entered!: () => void;
		let resume!: () => void;
		const drainEntered = new Promise<void>((resolve) => { entered = resolve; });
		const drainResume = new Promise<void>((resolve) => { resume = resolve; });
		let result = "initial";
		let completionApplied = false;
		let callbacks = 0;
		const pausedDrain = queue.run(async () => {
			entered();
			await drainResume;
			if (completionApplied) return;
			result = "live";
			callbacks += 1;
		});
		await drainEntered;
		const replay = queue.run(async () => {
			completionApplied = true;
			result = "verified replay";
		});
		resume();
		await Promise.all([pausedDrain, replay]);
		assert.equal(result, "verified replay", "a paused drain cannot overwrite a later verified replay");
		assert.equal(callbacks, 1, "the already-running drain retains its callback before the queued winner");
		await queue.run(async () => {
			if (completionApplied) return;
			callbacks += 1;
		});
		assert.equal(callbacks, 1, "a drain that follows the applied winner must not callback");
	});

	test("replays and releases an existing child completion winner during shutdown", async () => {
		await resetInteractiveShutdownForSession();
		const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-child-winner-shutdown-"));
		const runId = "child-winner-shutdown";
		const paths = await prepareRunArtifactPaths({ rootDir, runId });
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		const order: string[] = [];
		let interrupts = 0;
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			inspect: async () => ({ exists: true }), interrupt: async () => { interrupts += 1; return true; }, close: async () => true,
		};
		try {
			const line = `${JSON.stringify({ type: "message", id: "child-final", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`;
			await fs.promises.writeFile(paths.childSessionPath, line, { mode: 0o600 });
			const session = await computeSessionCompletionBoundary(paths.childSessionPath); assert.ok(session);
			const identity = await getSessionFileIdentity(paths.childSessionPath); assert.ok(identity);
			await fs.promises.writeFile(paths.statePath, `${JSON.stringify({ version: 1, runId, sequence: 0, phase: "starting", updatedAt: Date.now() })}\n`, { mode: 0o600 });
			const childWinner = { version: 3, runId, producer: "child", status: "completed", completedAt: Date.now(), session } as const;
			await fs.promises.writeFile(paths.completionPath, `${JSON.stringify(childWinner)}\n`, { mode: 0o600 });
			assert.equal(registerCommittedInteractiveRun({
				runId, backend, handle, paths, sessionIdentity: identity, generation: getInteractiveShutdownGenerationForTest(),
				stopLeaseWriterAndDrain: async () => { order.push("stop"); },
				applyCompletionWinner: async (winner) => { assert.deepEqual(winner, childWinner); order.push("apply"); return true; },
				release: async () => { order.push("release"); return true; },
			}), true);
			await shutdownActiveInteractiveRuns();
			assert.equal(interrupts, 0, "an existing completion winner revokes shutdown interrupt authority");
			assert.ok(order.indexOf("stop") < order.indexOf("apply"), "shutdown stops the lease before replaying the winner");
			assert.ok(order.indexOf("apply") < order.indexOf("release"), "shutdown verifies the exact winner before release");
			assert.equal(listActiveInteractiveRunIds().includes(runId), false);
		} finally {
			unregisterCommittedInteractiveRun(runId, true);
			await resetInteractiveShutdownForSession();
			await removeRunArtifacts(paths).catch(() => undefined);
			await fs.promises.rm(rootDir, { recursive: true, force: true });
		}
	});

	test("retains a fenced late commit for shutdown retry when its first exact release fails", async () => {
		await resetInteractiveShutdownForSession();
		await shutdownActiveInteractiveRuns();
		const runId = "late-commit-during-shutdown";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "exact-surface", paneId: "p" } };
		const calls: string[] = [];
		let releases = 0;
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async (target: typeof handle) => { calls.push(`interrupt:${target.native.surfaceId}`); return true; },
			close: async (target: typeof handle) => { calls.push(`close:${target.native.surfaceId}`); return true; },
			inspect: async () => ({ exists: false }),
		};
		assert.equal(registerCommittedInteractiveRun({
			runId, backend, handle, generation: getInteractiveShutdownGenerationForTest(),
			release: async () => ++releases >= 2,
		}), false);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(releases, 1);
		assert.equal(listActiveInteractiveRunIds().includes(runId), true);
		await shutdownActiveInteractiveRuns();
		assert.equal(releases, 2);
		assert.equal(listActiveInteractiveRunIds().includes(runId), false);
		assert.deepEqual(calls, ["interrupt:exact-surface", "interrupt:exact-surface"]);
		await resetInteractiveShutdownForSession();
	});

	test("does not let a hung shutdown interrupt retain the global fence or mutate a later registered target", async () => {
		await resetInteractiveShutdownForSession();
		const originalHandle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "reused", paneId: "original" } };
		let interruptEntered!: () => void;
		const interruptStarted = new Promise<void>((resolve) => { interruptEntered = resolve; });
		let resolveInterrupt!: (value: boolean) => void;
		const interrupted = new Promise<boolean>((resolve) => { resolveInterrupt = resolve; });
		const originalBackend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => originalHandle,
			inspect: async () => ({ exists: true }),
			interrupt: async (target: typeof originalHandle) => { assert.equal(target, originalHandle); interruptEntered(); return await interrupted; },
			close: async () => true,
		};
		const originalRunId = "hung-interrupt-original";
		const laterHandle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "reused", paneId: "replacement" } };
		let laterInterrupted = 0;
		let laterReleased = 0;
		const laterBackend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => laterHandle,
			inspect: async () => ({ exists: true }),
			interrupt: async (target: typeof laterHandle) => { assert.equal(target, laterHandle); laterInterrupted += 1; return true; },
			close: async () => true,
		};
		try {
			assert.equal(registerCommittedInteractiveRun({ runId: originalRunId, backend: originalBackend, handle: originalHandle, generation: getInteractiveShutdownGenerationForTest(), release: async () => true }), true);
			const shutdown = shutdownActiveInteractiveRuns();
			await interruptStarted;
			// This commit is rejected by the shutdown generation, but its bounded
			// cleanup must still acquire the global fence and /usr/bin/touch only its exact handle.
			assert.equal(registerCommittedInteractiveRun({ runId: "hung-interrupt-later", backend: laterBackend, handle: laterHandle, generation: getInteractiveShutdownGenerationForTest(), release: async () => { laterReleased += 1; return true; } }), false);
			for (let attempt = 0; attempt < 100 && laterReleased === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(laterInterrupted, 1, "the later run interrupt must not wait on unrelated backend I/O under the global fence");
			assert.equal(laterReleased, 1, "late fenced cleanup must progress while the original interrupt is unresolved");
			resolveInterrupt(true);
			await shutdown;
			assert.equal(laterInterrupted, 1, "a delayed original operation must not be replayed against the reused target");
		} finally {
			resolveInterrupt?.(false);
			unregisterCommittedInteractiveRun(originalRunId, true);
			unregisterCommittedInteractiveRun("hung-interrupt-later", true);
			await resetInteractiveShutdownForSession();
		}
	});

	test("does not let a hung registered close retain the global fence", async () => {
		await resetInteractiveShutdownForSession();
		const hungHandle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "hung-close", paneId: "original" } };
		let closeEntered!: () => void;
		const closeStarted = new Promise<void>((resolve) => { closeEntered = resolve; });
		let resolveClose!: (value: boolean) => void;
		const closeResult = new Promise<boolean>((resolve) => { resolveClose = resolve; });
		const hungBackend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => hungHandle,
			interrupt: async () => true,
			close: async (target: typeof hungHandle) => { assert.equal(target, hungHandle); closeEntered(); return await closeResult; },
			inspect: async () => ({ exists: false }),
		};
		const otherHandle = { mode: "tmux-pane" as const, native: { paneId: "%99", serverPid: 1, panePid: 2 } };
		let otherReleased = 0;
		const otherBackend = { mode: "tmux-pane" as const, availabilityError: () => null, launch: async () => otherHandle, interrupt: async () => true, close: async () => true, inspect: async () => ({ exists: false }) };
		try {
			assert.equal(registerCommittedInteractiveRun({ runId: "hung-close", backend: hungBackend, handle: hungHandle, generation: getInteractiveShutdownGenerationForTest() }), true);
			const closing = releaseRegisteredInteractiveRun("hung-close");
			await closeStarted;
			assert.equal(registerCommittedInteractiveRun({ runId: "other-close", backend: otherBackend, handle: otherHandle, generation: getInteractiveShutdownGenerationForTest(), release: async () => { otherReleased += 1; return true; } }), true);
			assert.equal(await releaseRegisteredInteractiveRun("other-close"), true);
			assert.equal(otherReleased, 1, "an unrelated registered release must not wait on the hung close's global fence");
			resolveClose(true);
			assert.equal(await closing, true);
		} finally {
			resolveClose?.(false);
			unregisterCommittedInteractiveRun("hung-close", true);
			unregisterCommittedInteractiveRun("other-close", true);
			await resetInteractiveShutdownForSession();
		}
	});

	test("serializes a paused gate publication with the shutdown fence", async () => {
		await resetInteractiveShutdownForSession();
		const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-gate-fence-"));
		const paths = await prepareRunArtifactPaths({ rootDir, runId: "gate-fence-race" });
		const runId = "gate-fence-race";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		let releases = 0;
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true, close: async () => true, inspect: async () => ({ exists: false }),
		};
		try {
			registerCommittedInteractiveRun({
				runId, backend, handle, generation: getInteractiveShutdownGenerationForTest(),
				release: async () => { releases += 1; return true; },
			});
			let publicationLocked!: () => void;
			const publicationEntered = new Promise<void>((resolve) => { publicationLocked = resolve; });
			let releasePublication!: () => void;
			const publicationPaused = new Promise<void>((resolve) => { releasePublication = resolve; });
			const publishing = publishInteractiveLaunchGate({
				paths, runId, terminalMode: "cmux-pane", generation: getInteractiveShutdownGenerationForTest(),
				beforePublishForTest: async () => { publicationLocked(); await publicationPaused; },
			});
			await publicationEntered;
			const fence = beginInteractiveShutdownForSession();
			releasePublication();
			await publishing;
			await fence;
			assert.equal(fs.existsSync(paths.launchGatePath), true);
			assert.equal(listActiveInteractiveRunIds().includes(runId), true);
			await shutdownActiveInteractiveRuns();
			assert.equal(releases, 1);
			assert.equal(listActiveInteractiveRunIds().includes(runId), false);

			const fencedPaths = await prepareRunArtifactPaths({ rootDir, runId: "gate-fence-wins" });
			await resetInteractiveShutdownForSession();
			const fencedGeneration = getInteractiveShutdownGenerationForTest();
			await beginInteractiveShutdownForSession();
			await assert.rejects(
				publishInteractiveLaunchGate({ paths: fencedPaths, runId: "gate-fence-wins", terminalMode: "cmux-pane", generation: fencedGeneration }),
				/fenced this committed run before gate publication/,
			);
			assert.equal(fs.existsSync(fencedPaths.launchGatePath), false);
			await removeRunArtifacts(fencedPaths);
		} finally {
			unregisterCommittedInteractiveRun(runId);
			await resetInteractiveShutdownForSession();
			await removeRunArtifacts(paths).catch(() => undefined);
			await fs.promises.rm(rootDir, { recursive: true, force: true });
		}
	});

	test("retries failed active releases and retains unresolved ownership", async () => {
		await resetInteractiveShutdownForSession();
		const retryRunId = "retry-release";
		const failedRunId = "failed-release";
		const keptRunId = "kept-completion-release";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		const backend = {
			mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async () => true, close: async () => true, inspect: async () => ({ exists: true }),
		};
		let retries = 0;
		registerCommittedInteractiveRun({
			runId: retryRunId, backend, handle,
			generation: getInteractiveShutdownGenerationForTest(),
			release: async () => ++retries >= 2,
		});
		registerCommittedInteractiveRun({
			runId: failedRunId, backend, handle,
			generation: getInteractiveShutdownGenerationForTest(), release: async () => false,
		});
		let keptReleases = 0;
		registerCommittedInteractiveRun({
			runId: keptRunId, backend, handle,
			generation: getInteractiveShutdownGenerationForTest(), release: async () => ++keptReleases >= 2,
		});
		assert.equal(await keepInteractiveRun(keptRunId), true);
		assert.equal(await releaseRegisteredInteractiveRun(keptRunId), false, "completion must retain a kept run after its active lease is released");
		await shutdownActiveInteractiveRuns();
		assert.equal(retries, 2);
		assert.equal(keptReleases, 2, "session shutdown retries the durable kept-run release without leaking it");
		assert.equal(listActiveInteractiveRunIds().includes(retryRunId), false);
		assert.equal(listActiveInteractiveRunIds().includes(keptRunId), false);
		assert.equal(listActiveInteractiveRunIds().includes(failedRunId), true);
		unregisterCommittedInteractiveRun(failedRunId);
		await resetInteractiveShutdownForSession();
	});

	test("bounds stalled terminal preparation without releasing its target or delaying unrelated shutdown", async () => {
		await resetInteractiveShutdownForSession();
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-terminal-stall-"));
		const leasePaths = await prepareRunArtifactPaths({ rootDir: root, runId: "stalled-lease" });
		const callbackPaths = await prepareRunArtifactPaths({ rootDir: root, runId: "stalled-callback" });
		const handle = { mode: "cmux-pane" as const, native: { workspaceId: "w", surfaceId: "s" } };
		const backend = { mode: "cmux-pane" as const, availabilityError: () => null, launch: async () => handle, interrupt: async () => true, close: async () => true, inspect: async () => ({ exists: true }) };
		let leasePublished = 0, leaseReleased = 0, callbackReleased = 0, unrelatedReleased = 0;
		try {
			assert.equal(registerCommittedInteractiveRun({
				runId: "stalled-lease", backend, handle, paths: leasePaths, generation: getInteractiveShutdownGenerationForTest(),
				stopLeaseWriterAndDrain: async () => await new Promise<never>(() => undefined),
				publishParentCompletion: async () => { leasePublished += 1; return null; }, release: async () => { leaseReleased += 1; return true; },
			}), true);
			assert.equal(registerCommittedInteractiveRun({
				runId: "stalled-callback", backend, handle, paths: callbackPaths, generation: getInteractiveShutdownGenerationForTest(),
				publishParentCompletion: async () => await new Promise<never>(() => undefined), release: async () => { callbackReleased += 1; return true; },
			}), true);
			assert.equal(registerCommittedInteractiveRun({ runId: "unrelated-terminal", backend, handle, generation: getInteractiveShutdownGenerationForTest(), release: async () => { unrelatedReleased += 1; return true; } }), true);
			const started = Date.now();
			await shutdownActiveInteractiveRuns();
			assert.ok(Date.now() - started < 2_000, "stalled terminal preparation must be bounded");
			assert.equal(leasePublished, 0, "an unresolved lease drain must not publish parent completion");
			assert.equal(leaseReleased, 0, "an unresolved lease drain must not release its target");
			assert.equal(callbackReleased, 0, "an unresolved callback must not release its target");
			assert.equal(unrelatedReleased, 1, "unrelated runs continue through shutdown");
			assert.equal(listActiveInteractiveRunIds().includes("stalled-lease"), true);
			assert.equal(listActiveInteractiveRunIds().includes("stalled-callback"), true);
		} finally {
			unregisterCommittedInteractiveRun("stalled-lease", true); unregisterCommittedInteractiveRun("stalled-callback", true); unregisterCommittedInteractiveRun("unrelated-terminal", true);
			await resetInteractiveShutdownForSession();
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("interrupts and confirms exact absence during inspect-exhaustion recovery", async () => {
		const handle = { mode: "tmux-pane" as const, native: { paneId: "%4", serverPid: 11, panePid: 12 } };
		const calls: string[] = [];
		const backend = {
			mode: "tmux-pane" as const, availabilityError: () => null, launch: async () => handle,
			interrupt: async () => { calls.push("interrupt"); return true; },
			close: async () => { calls.push("close"); return true; },
			inspect: async () => { calls.push("inspect"); return { exists: false }; },
		};
		await backend.interrupt();
		assert.equal(await closeInteractiveTarget(backend, handle), true);
		assert.deepEqual(calls, ["interrupt", "close", "inspect"]);
	});

	test("component-level fake backend exercises cancel, external close, shutdown, and reload without touching source/sentinel", async () => {
		await shutdownActiveInteractiveRuns();
		await resetInteractiveShutdownForSession();
		const workspace = "123e4567-e89b-12d3-a456-426614174000";
		const source = { workspaceId: workspace, sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" };
		const sentinel = "123e4567-e89b-12d3-a456-426614174002";
		const live = new Set([source.sourceSurfaceId, sentinel]);
		const interrupted: string[] = [];
		const closed: string[] = [];
		const backend: InteractivePaneBackend = {
			mode: "cmux-pane",
			availabilityError: () => null,
			launch: async () => ({ mode: "cmux-pane", native: { workspaceId: workspace, surfaceId: "123e4567-e89b-12d3-a456-426614174099", paneId: "123e4567-e89b-12d3-a456-426614174090" } }),
			interrupt: async (handle) => {
				if (handle.mode !== "cmux-pane") return false;
				interrupted.push(handle.native.surfaceId);
				return true;
			},
			close: async (handle) => {
				if (handle.mode !== "cmux-pane") return false;
				closed.push(handle.native.surfaceId);
				live.delete(handle.native.surfaceId);
				return true;
			},
			inspect: async (handle) => handle.mode === "cmux-pane" ? { exists: live.has(handle.native.surfaceId) } : undefined,
		};
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: async () => true });
		const runNames = ["foreground", "background", "parallel-chain-0", "parallel-chain-1"];
		const runs = await Promise.all(runNames.map(async (runId, index) => {
			const lease = await coordinator.allocateCmux({
				source, depth: 0, layout: "auto", runId,
				allocate: async (request) => {
					const surfaceId = `123e4567-e89b-12d3-a456-426614174${String(100 + index)}`;
					live.add(surfaceId);
					return {
						committed: true as const, layout: request.layout, placement: request.placement,
						container: { kind: "cmux-pane" as const, workspaceId: workspace, paneId: request.placement === "cmux-split" ? "123e4567-e89b-12d3-a456-426614174090" : request.container.paneId! },
						target: { workspaceId: workspace, paneId: "123e4567-e89b-12d3-a456-426614174090", surfaceId },
					};
				},
			});
			const handle = { mode: "cmux-pane" as const, native: lease.allocation.target };
			const release = async () => {
				await coordinator.releaseCmux({ lease, close: async (allocation) => await closeInteractiveTarget(backend, {
					mode: "cmux-pane", native: allocation.target,
				}) });
				return true;
			};
			registerCommittedInteractiveRun({ runId, backend, handle, generation: getInteractiveShutdownGenerationForTest(), release });
			return { runId, lease, handle, release };
		}));
		assert.equal(coordinator.activeCmuxSurfaceCount(source), runNames.length);

		// Model cancellation and an externally closed child without allowing either to name source/sentinel.
		await backend.interrupt(runs[1]!.handle);
		await runs[1]!.release();
		unregisterCommittedInteractiveRun(runs[1]!.runId);
		live.delete(runs[2]!.lease.allocation.target.surfaceId);
		await runs[2]!.release();
		unregisterCommittedInteractiveRun(runs[2]!.runId);
		await shutdownActiveInteractiveRuns();
		for (const { runId } of runs) assert.equal(listActiveInteractiveRunIds().includes(runId), false);
		assert.equal(coordinator.activeCmuxSurfaceCount(source), 0);
		assert.equal(live.has(source.sourceSurfaceId), true);
		assert.equal(live.has(sentinel), true);
		assert.equal(closed.includes(source.sourceSurfaceId) || closed.includes(sentinel), false);
		assert.equal(interrupted.includes(source.sourceSurfaceId) || interrupted.includes(sentinel), false);

		// A reload starts a fresh generation and cannot reuse a retired shared pane.
		await resetInteractiveShutdownForSession();
		const replacement = await coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: "after-reload",
			allocate: async (request) => ({
				committed: true as const, layout: request.layout, placement: request.placement,
				container: { kind: "cmux-pane" as const, workspaceId: workspace, paneId: "123e4567-e89b-12d3-a456-426614174091" },
				target: { workspaceId: workspace, paneId: "123e4567-e89b-12d3-a456-426614174091", surfaceId: "123e4567-e89b-12d3-a456-426614174150" },
			}),
		});
		assert.equal(replacement.request.placement, "cmux-split");
		await coordinator.releaseCmux({ lease: replacement, close: async () => true });
	});

	test("inspects tmux through an accepted pool epoch without local generation probes", async () => {
		await resetInteractiveShutdownForSession();
		const lease = await acquireTmuxControlLease({
			authority: {
				controlContract: "tmux-control-v1", executableGeneration: { realpath: "/private/tmux", dev: "1", ino: "1", size: "1", mtimeNs: "1", ctimeNs: "1" },
				canonicalSocketPath: "/private/socket", socketDev: 1, socketIno: 1, serverPid: 100, serverStartedAt: 1,
				attachedSessionId: "$1", sourcePaneId: "%1", sourcePanePid: 101, sourceWindowId: "@1",
			},
			createClient: async () => ({
				close() {}, notificationSequence: () => 0, lastNotificationAt: () => null, waitForNotification: async () => "timeout" as const,
				execute: async (line: string) => line.startsWith("display-message") ? ["100"] : ["%2|0|102"],
			} as any),
			revalidate: async () => true,
		});
		assert.ok(lease);
		try {
			const snapshot = await inspectActiveTmuxSnapshotForTest({
				handle: { mode: "tmux-pane", native: {
					paneId: "%2", panePid: 102, serverPid: 100, socketPath: "/private/socket",
					generation: { socketPath: "/intentionally-unavailable/socket", socketDev: "1", socketIno: "1", serverStartedAt: 1 },
				} },
				run: lease.run, backendKey: "ignored-by-pooled-tmux", generation: getInteractiveShutdownGenerationForTest(),
				tmuxAcceptedTransport: () => lease.acceptedTransport(),
			});
			assert.deepEqual(snapshot, { exists: true, exited: false });
		} finally {
			lease.release();
		}
	});

	test("does not spend inspection failures on 16 mutation-invalidated snapshots and applies a stable completion", async () => {
		const workspaceId = "123e4567-e89b-12d3-a456-426614174100";
		const paneId = "123e4567-e89b-12d3-a456-426614174101";
		const surfaceId = "123e4567-e89b-12d3-a456-426614174102";
		const handle = { mode: "cmux-pane" as const, native: { workspaceId, surfaceId } };
		const tree = JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: surfaceId, pane_id: paneId }] }] }] }] });
		const generation = getInteractiveShutdownGenerationForTest();
		let queryFailures = 0;
		for (let epoch = 0; epoch < 16; epoch += 1) {
			let entered!: () => void;
			let release!: () => void;
			const inspectionEntered = new Promise<void>((resolve) => { entered = resolve; });
			const inspectionRelease = new Promise<void>((resolve) => { release = resolve; });
			const observationGeneration = getTopologyMutationGenerationForTest();
			const inspection = inspectActiveCmuxSnapshotForTest({
				handle, backendKey: "test-cmux", generation,
				run: async () => { entered(); await inspectionRelease; return { exitCode: 0, stdout: tree, stderr: "", aborted: false }; },
			});
			await inspectionEntered;
			advanceTopologyMutationGenerationForTest();
			release();
			const snapshot = await inspection;
			assert.equal(snapshot, undefined);
			if (!isTopologyMutationInvalidatedUndefinedInspectionForTest(snapshot, observationGeneration)) queryFailures += 1;
		}
		assert.equal(queryFailures, 0, "stale observations must not consume the transport-failure budget");

		const stableSnapshotGeneration = getTopologyMutationGenerationForTest();
		const stableSnapshot = await inspectActiveCmuxSnapshotForTest({
			handle, backendKey: "test-cmux", generation,
			run: async () => ({ exitCode: 0, stdout: tree, stderr: "", aborted: false }),
		});
		assert.equal(stableSnapshot?.exists, true);
		assert.equal(isTopologyMutationInvalidatedUndefinedInspectionForTest(stableSnapshot, stableSnapshotGeneration), false);
		for (let attempt = 0; attempt < 20; attempt += 1) {
			const snapshot = await inspectActiveCmuxSnapshotForTest({
				handle, backendKey: "test-cmux", generation,
				run: async () => ({ exitCode: 1, stdout: "", stderr: "unavailable", aborted: false }),
			});
			assert.equal(snapshot, undefined);
			if (!isTopologyMutationInvalidatedUndefinedInspectionForTest(snapshot, stableSnapshotGeneration)) queryFailures += 1;
		}
		assert.equal(queryFailures, 20, "20 stable undefined inspections still fail closed");

		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-v3-winner-"));
		try {
			const sessionPath = path.join(root, "session.jsonl");
			await fs.promises.writeFile(sessionPath, `${JSON.stringify({ type: "message", id: "final", message: { role: "assistant", content: [{ type: "text", text: "verified" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "stop" } })}\n`);
			const session = await computeSessionCompletionBoundary(sessionPath); assert.ok(session);
			const completion = { version: 3 as const, runId: "winner", producer: "child" as const, status: "completed" as const, completedAt: 1, session };
			const result = { agent: "reviewer", agentSource: "user" as const, task: "t", exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
			assert.equal(await applyVerifiedInteractiveCompletion({ result, completion, childSessionPath: sessionPath, sessionResultStartOffset: 0, onUpdate: () => undefined }), true);
			assert.equal(result.exitCode, 0);
			assert.equal(result.messages.length, 1);
			await fs.promises.writeFile(sessionPath, `${JSON.stringify({ type: "message", id: "forged", message: { role: "assistant", content: [{ type: "text", text: "forged" }] } })}\n`);
			const forgedResult = { ...result, exitCode: -1, messages: [], usage: { ...result.usage } };
			assert.equal(await applyVerifiedInteractiveCompletion({ result: forgedResult, completion, childSessionPath: sessionPath, sessionResultStartOffset: 0, onUpdate: () => undefined }), false);
			assert.equal(forgedResult.exitCode, -1, "failed boundary proof must retain the recoverable result");
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("replays a verified final assistant entry above the live-tail bound", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-large-final-"));
		const sessionPath = path.join(root, "session.jsonl");
		try {
			const text = "x".repeat(64 * 1024 + 1);
			await fs.promises.writeFile(sessionPath, `${JSON.stringify({ type: "message", id: "large-final", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } })}\n`, { mode: 0o600 });
			const session = await computeSessionCompletionBoundary(sessionPath); assert.ok(session);
			const completion = { version: 3 as const, runId: "large-final", producer: "child" as const, status: "completed" as const, completedAt: 1, session };
			const result = { agent: "reviewer", agentSource: "user" as const, task: "t", exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
			assert.equal(await applyVerifiedInteractiveCompletion({ result, completion, childSessionPath: sessionPath, sessionResultStartOffset: 0, onUpdate: () => undefined }), true);
			assert.equal(getFinalOutput(result.messages as any), text);
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("releases the verified completion lease and retains recovery when final parsing fails", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-completion-lease-"));
		const sessionPath = path.join(root, "session.jsonl");
		try {
			const line = `${JSON.stringify({ type: "message", id: "final", message: { role: "assistant", content: "done" } })}\n`;
			await fs.promises.writeFile(sessionPath, line, { mode: 0o600 });
			const session = await computeSessionCompletionBoundary(sessionPath); assert.ok(session);
			const restore = setSessionVerificationBufferLimitForTesting(session.byteOffset);
			try {
				// Both primary and fallback index paths are files, forcing the final
				// descriptor-bound drain to reject after it acquires the suffix lease.
				await fs.promises.writeFile(`${sessionPath}.entry-index`, "blocked", { mode: 0o600 });
				await fs.promises.writeFile(`${sessionPath}.entry-index.fallback`, "blocked", { mode: 0o600 });
				const result = { agent: "reviewer", agentSource: "user" as const, task: "t", exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
				const completion = { version: 3 as const, runId: "parse-throw", producer: "child" as const, status: "completed" as const, completedAt: 1, session };
				assert.equal(await applyVerifiedInteractiveCompletion({ result, completion, childSessionPath: sessionPath, sessionResultStartOffset: 0, onUpdate: () => undefined }), false);
				assert.equal(result.exitCode, -1, "failed replay must retain recoverable state");
				const recovered = await computeSessionCompletionBoundary(sessionPath);
				assert.ok(recovered, "the parse failure must release the full reservation for the next verifier");
			} finally { restore(); }
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("replays generic failure boundaries, rejects replacement, and leaves boundary-less tails unpolled", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-v3-failure-"));
		try {
			const sessionPath = path.join(root, "session.jsonl");
			const line = JSON.stringify({ type: "message", id: "failure-tail", message: { role: "assistant", content: [{ type: "text", text: "recovered failure usage" }], usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { total: 0 } } } });
			await fs.promises.writeFile(sessionPath, `${line}\n`);
			const identity = await getSessionFileIdentity(sessionPath); assert.ok(identity);
			const session = await computeSessionFailureBoundary(sessionPath, { expectedSessionIdentity: identity }); assert.ok(session);
			const failed = { version: 3 as const, runId: "failure", producer: "parent" as const, status: "failed" as const, completedAt: 1, errorCode: "transport-lost" as const, evidenceRefs: ["state"] as "state"[], session };
			const recovered = { agent: "reviewer", agentSource: "user" as const, task: "t", exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 } };
			assert.equal(await applyVerifiedInteractiveCompletion({ result: recovered, completion: failed, childSessionPath: sessionPath, sessionResultStartOffset: 0, expectedSessionIdentity: identity, onUpdate: () => undefined }), true);
			assert.equal(recovered.messages.length, 1);
			assert.equal(recovered.exitCode, 1);
			await fs.promises.writeFile(sessionPath, `${line.replace("failure-tail", "replacement")}\n`);
			const retained = { ...recovered, exitCode: -1, messages: [], usage: { ...recovered.usage } };
			assert.equal(await applyVerifiedInteractiveCompletion({ result: retained, completion: failed, childSessionPath: sessionPath, sessionResultStartOffset: 0, expectedSessionIdentity: identity, onUpdate: () => undefined }), false);
			assert.equal(retained.exitCode, -1);
			const boundarylessV3 = { version: 3 as const, runId: "boundaryless", producer: "parent" as const, status: "failed" as const, completedAt: 1, errorCode: "transport-lost" as const, evidenceRefs: ["state"] as "state"[] };
			assert.equal(await applyVerifiedInteractiveCompletion({ result: retained, completion: boundarylessV3, childSessionPath: sessionPath, sessionResultStartOffset: 0, onUpdate: () => undefined }), false);
			assert.equal(retained.messages.length, 0, "boundary-less V3 must retain recovery without final-draining live bytes");
			const legacy = { version: 2 as const, runId: "legacy", status: "failed" as const, completedAt: 1 };
			assert.equal(await applyVerifiedInteractiveCompletion({ result: retained, completion: legacy, childSessionPath: sessionPath, sessionResultStartOffset: 0, onUpdate: () => undefined }), true);
			assert.equal(retained.messages.length, 0, "legacy V2 completion must not final-drain live session bytes");
		} finally { await fs.promises.rm(root, { recursive: true, force: true }); }
	});

	test("clears inherited run protocol unless a new run explicitly replaces it", () => {
		const inherited = {
			[SUBAGENT_RUN_ID_ENV]: "parent-run",
			[SUBAGENT_RUN_STATE_PATH_ENV]: "/parent/state.json",
			[SUBAGENT_RUN_COMPLETION_PATH_ENV]: "/parent/complete.json",
			[SUBAGENT_PARENT_LEASE_PATH_ENV]: "/parent/lease.json",
			[SUBAGENT_CHILD_SESSION_PATH_ENV]: "/parent/session.jsonl",
			[SUBAGENT_RUN_OWNERSHIP_ENV]: "parent-owned",
			[SUBAGENT_EXPECTED_PARENT_PID_ENV]: "1",
			[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV]: "2",
			[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: "/tmp/parent.sock",
			[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: "/parent/lifecycle-token",
		};
		const cleared = buildChildProcessEnv({
			agentName: "reviewer",
			parentDepth: 0,
			parentAgentStack: [],
			maxDepth: 3,
			preventCycles: true,
			baseEnv: inherited,
		});
		assert.equal(cleared[SUBAGENT_RUN_ID_ENV], undefined);
		assert.equal(cleared[SUBAGENT_EXPECTED_PARENT_PID_ENV], undefined);
		assert.equal(cleared[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV], undefined);
		assert.equal(cleared[SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV], undefined);
		assert.equal(cleared[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV], undefined);

		const replaced = buildChildProcessEnv({
			agentName: "reviewer",
			parentDepth: 0,
			parentAgentStack: [],
			maxDepth: 3,
			preventCycles: true,
			baseEnv: inherited,
			runProtocolEnv: { [SUBAGENT_RUN_ID_ENV]: "child-run" },
		});
		assert.equal(replaced[SUBAGENT_RUN_ID_ENV], "child-run");
	});
});
