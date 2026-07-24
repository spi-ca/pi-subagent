import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reapStaleInteractiveRuns, startStaleInteractiveReaper } from "../../src/runtime/runner";
import { computeSessionCompletionBoundary, verifySessionCompletionBoundary } from "../../src/runtime/completion-v3";
import { canonicalTmuxProbeBytes, TMUX_CONTROL_FIXTURE_CONTRACT_ID, TMUX_CONTROL_PROBE_RECIPE_ID, TMUX_CONTROL_SOURCE_COMMIT } from "../../src/runtime/tmux-control-gate";
import { exactArtifactDigest } from "../../src/runtime/tmux-control-protocol";
import { FORK_SOURCE_ROOT_NAME, ForkSourceOwnershipManager } from "../../src/runtime/fork-source-ownership";
import {
	RUN_PROTOCOL_VERSION,
	getCurrentProcessStartedAt,
	atomicWriteJson,
	parseCompletionRecord,
	prepareRunArtifactPaths,
	readJsonFile,
	writePrivateFile,
} from "../../src/runtime/run-protocol";

const tempDirs: string[] = [];
const CMUX_WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";
const tmuxGeneration = { socketPath: "/tmp/tmux.sock", socketDev: "1", socketIno: "2", serverStartedAt: 3 };
function cmuxAbsentTree(workspaceId = CMUX_WORKSPACE_ID) {
	const paneId = "123e4567-e89b-12d3-a456-426614174098";
	return { windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: "123e4567-e89b-12d3-a456-426614174099", pane_id: paneId }] }] }] }] };
}
function cmuxTargetTree(surfaceId: string, workspaceId = CMUX_WORKSPACE_ID) {
	return cmuxSurfaceTree([surfaceId], workspaceId);
}
function cmuxSurfaceTree(surfaceIds: string[], workspaceId = CMUX_WORKSPACE_ID) {
	const paneId = "123e4567-e89b-12d3-a456-426614174098";
	return { windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: surfaceIds.map((id) => ({ id, pane_id: paneId })) }] }] }] };
}
function v2CmuxIntent(paths: { childSessionPath: string }, runId: string, parentRunId?: string) {
	return {
		version: 2, runId, ...(parentRunId ? { parentRunId } : {}), parentSessionId: "p", parentPid: 42, parentStartedAt: 1, terminalMode: "cmux-pane" as const,
		source: { workspaceId: CMUX_WORKSPACE_ID, sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" },
		childSessionFile: paths.childSessionPath, createdAt: 1, brokerNonce: "a".repeat(43),
		runtimePath: process.execPath, runtimeInterpreterPath: process.execPath, backendPath: process.execPath, brokerEntrypoint: process.execPath,
	};
}
function v2CmuxLayoutIntent(paths: { childSessionPath: string }, runId: string) {
	return {
		...v2CmuxIntent(paths, runId), layout: "auto", placement: "cmux-new-surface",
		container: { kind: "cmux-pane", workspaceId: CMUX_WORKSPACE_ID, paneId: "123e4567-e89b-12d3-a456-426614174090" },
	};
}
function v2TmuxIntent(paths: { childSessionPath: string }, runId: string) {
	return {
		version: 2, runId, parentSessionId: "p", parentPid: 42, parentStartedAt: 1, terminalMode: "tmux-pane" as const,
		source: { socketPath: "/tmp/tmux.sock", sourcePaneId: "%1", sourcePanePid: 456, serverPid: 123, generation: tmuxGeneration },
		childSessionFile: paths.childSessionPath, createdAt: 1, brokerNonce: "a".repeat(43),
		runtimePath: process.execPath, runtimeInterpreterPath: process.execPath, backendPath: process.execPath, brokerEntrypoint: process.execPath,
	};
}
function v2TmuxLayoutIntent(paths: { childSessionPath: string }, runId: string) {
	return {
		...v2TmuxIntent(paths, runId), layout: "split" as const, placement: "tmux-split" as const,
		container: { kind: "tmux-source-pane" as const, socketPath: "/tmp/tmux.sock", serverPid: 123, sessionId: "$1", windowId: "@2", paneId: "%1", panePid: 456, generation: tmuxGeneration },
	};
}

afterEach(async () => {
	while (tempDirs.length > 0) await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function createRun(rootDir: string, options: {
	runId: string;
	surfaceId: string;
	parentRunId?: string;
	ownership?: "parent-owned" | "detached";
	terminalMode?: "cmux-pane" | "tmux-pane";
	renewedAt: number;
}) {
	const paths = await prepareRunArtifactPaths({ rootDir, runId: options.runId });
	await writePrivateFile(paths.taskPath, "secret task");
	const terminalMode = options.terminalMode ?? "cmux-pane";
	await atomicWriteJson(paths.launchPath, {
		version: RUN_PROTOCOL_VERSION,
		runId: options.runId,
		parentRunId: options.parentRunId,
		parentSessionId: "parent-session",
		ownership: options.ownership ?? "parent-owned",
		terminalMode,
		...(terminalMode === "cmux-pane"
			? { cmuxWorkspaceId: CMUX_WORKSPACE_ID, cmuxSurfaceId: options.surfaceId, cmuxSurfaceUuid: options.surfaceId }
			: {
				tmuxPaneId: options.surfaceId,
				tmuxSocketPath: "/tmp/tmux/default",
				tmuxServerPid: 123,
				tmuxPanePid: 456,
			}),
		childSessionFile: paths.childSessionPath,
		createdAt: 1,
	});
	await atomicWriteJson(paths.parentLeasePath, {
		version: RUN_PROTOCOL_VERSION,
		runId: options.runId,
		parentPid: process.pid,
		parentStartedAt: getCurrentProcessStartedAt()!,
		renewedAt: options.renewedAt,
	});
	return paths;
}

describe("stale interactive run reaper", () => {
	test("refuses to inspect a non-private state root", async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		await fs.promises.chmod(root, 0o755);
		await assert.rejects(
			() => reapStaleInteractiveRuns({ rootDir: root }),
			/Refusing to reap an untrusted subagent state root/,
		);
	});

	test("skips the reserved fork source root instead of classifying it as a run", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const manager = await ForkSourceOwnershipManager.create('{"x":1}\n', { rootDir: root });
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 20_000, staleAfterMs: 1 });
		assert.equal(outcome.scanned, 0);
		assert.equal(outcome.invalid.includes(FORK_SOURCE_ROOT_NAME), false);
		assert.equal(fs.existsSync(manager.paths.invocationDir), true, "the live owner remains authoritative while the reserved root is skipped");
	});

	test("ignores an unmarked UUID-looking directory under a marked root", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		// Initialize only the root marker, then add a child the reaper did not create.
		await prepareRunArtifactPaths({ rootDir: root, runId: "known-run" });
		const unmarked = path.join(root, "123e4567-e89b-12d3-a456-426614174099");
		await fs.promises.mkdir(unmarked, { mode: 0o700 });
		await fs.promises.writeFile(path.join(unmarked, "keep.txt"), "do not delete", { mode: 0o600 });
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 20_000, staleAfterMs: 10 });
		assert.equal(outcome.invalid.includes(path.basename(unmarked)), true);
		assert.equal(fs.existsSync(path.join(unmarked, "keep.txt")), true);
	});

	test("defers all startup-reaper classification when injected 100001-entry enumeration overflows", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		await prepareRunArtifactPaths({ rootDir: root, runId: "overflow-seed" });
		const names = Array.from({ length: 100_001 }, (_, index) => `overflow-${index}`);
		let classifications = 0;
		const handle = await startStaleInteractiveReaper({
			rootDir: root,
			enumerateRunDirectories: () => ({
				startup: Promise.resolve(names.slice(0, 50)), completion: Promise.resolve(names.slice(50, 100_000)), overflow: Promise.resolve(true), cancelAndDrain: async () => undefined,
			}),
			onValidationConcurrency: (active) => { if (active > 0) classifications += 1; },
		});
		await handle.startup;
		const outcome = await handle.completion;
		assert.match(outcome.diagnostic ?? "", /entry cap/);
		assert.equal(outcome.scanned, 0);
		assert.equal(classifications, 0, "overflow must prevent every classification and mutation");
	});

	test("transfers a bounded startup enumeration and completes in the background", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const seed = await prepareRunArtifactPaths({ rootDir: root, runId: "seed" });
		await atomicWriteJson(seed.parentLeasePath, { version: RUN_PROTOCOL_VERSION, runId: "seed", parentPid: process.pid, parentStartedAt: getCurrentProcessStartedAt()!, renewedAt: Date.now() });
		for (let index = 0; index < 20; index += 1) await fs.promises.mkdir(path.join(root, `unmarked-${index}`), { mode: 0o700 });
		const handle = await startStaleInteractiveReaper({ rootDir: root, startupBudgetMs: 0, startupEntryBudget: 0 });
		await handle.startup;
		const outcome = await handle.completion;
		assert.equal(outcome.scanned, 21);
		assert.equal(outcome.skipped.includes("seed"), true);
		for (let index = 0; index < 20; index += 1) assert.equal(fs.existsSync(path.join(root, `unmarked-${index}`)), true);
	});

	test("removes only proven-dead stale incomplete runs and preserves fresh or live pre-launch runs", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const stale = await prepareRunArtifactPaths({ rootDir: root, runId: "stale-incomplete" });
		await fs.promises.writeFile(stale.secretEnvPath, "export KEY=secret\n", { mode: 0o600 });
		const fresh = await prepareRunArtifactPaths({ rootDir: root, runId: "fresh-incomplete" });
		await fs.promises.writeFile(fresh.secretEnvPath, "export KEY=secret\n", { mode: 0o600 });
		const liveStale = await prepareRunArtifactPaths({ rootDir: root, runId: "live-stale-incomplete" });
		await fs.promises.writeFile(liveStale.secretEnvPath, "export KEY=secret\n", { mode: 0o600 });
		const now = Date.now() + 20_000;
		await atomicWriteJson(stale.parentLeasePath, { version: RUN_PROTOCOL_VERSION, runId: "stale-incomplete", parentPid: 999_999, parentStartedAt: 1, renewedAt: now - 20_000 });
		await atomicWriteJson(liveStale.parentLeasePath, { version: RUN_PROTOCOL_VERSION, runId: "live-stale-incomplete", parentPid: process.pid, parentStartedAt: getCurrentProcessStartedAt()!, renewedAt: now - 20_000 });
		await atomicWriteJson(fresh.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION,
			runId: "fresh-incomplete",
			parentPid: process.pid,
			parentStartedAt: getCurrentProcessStartedAt()!,
			renewedAt: now,
		});
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now, staleAfterMs: 12_000, isProcessIdentityAlive: (pid) => pid === process.pid });
		assert.deepEqual(outcome.invalid, ["stale-incomplete"]);
		assert.deepEqual(new Set(outcome.skipped), new Set(["fresh-incomplete", "live-stale-incomplete"]));
		assert.equal(fs.existsSync(stale.runDir), false);
		assert.equal(fs.existsSync(fresh.secretEnvPath), true);
		assert.equal(fs.existsSync(liveStale.secretEnvPath), true);
	});

	test("never reaps a valid durably promoted user-owned target", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const runId = "promoted-user-owned"; const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(paths.allocationPath, allocation);
		await fs.promises.writeFile(paths.taskPath, "sensitive task", { mode: 0o600 });
		await fs.promises.writeFile(paths.childSessionPath, '{"type":"session"}\n', { mode: 0o600 });
		await atomicWriteJson(paths.detachedOwnershipPath, { contract: "pi-subagent.detached-ownership", version: 1, runId, owner: "user", detachedAt: 1, allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") }, completionMode: "handoff" });
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 20_000, staleAfterMs: 1 });
		assert.equal(outcome.skipped.includes(runId), true);
		assert.equal(outcome.reaped.includes(runId), false);
		assert.equal(fs.existsSync(paths.runDir), true);
		assert.equal(fs.existsSync(paths.taskPath), false);
		assert.equal(fs.existsSync(paths.detachedOwnershipPath), true);
		assert.equal(fs.existsSync(paths.childSessionPath), true, "unknown child identity preserves a possibly live promoted session");
		await atomicWriteJson(paths.statePath, { version: 1, runId, sequence: 1, phase: "running", updatedAt: 1, childPid: 999_998, childStartedAt: 1 });
		await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 40_000, staleAfterMs: 1 });
		assert.equal(fs.existsSync(paths.childSessionPath), true, "unknown target inspection scrubs secrets only, even after a stale child marker");
	});

	test("retains an absent promoted candidate when artifact deletion fails, then reaps it on retry", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const runId = "promoted-delete-retry";
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const allocation = { version: 2, runId, terminalMode: "cmux-pane" as const, target: { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		const digest = crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex");
		const request = { contract: "pi-subagent.detached-transfer" as const, version: 1 as const, kind: "request" as const, transferId: "123e4567-e89b-12d3-a456-426614174014", runId, allocation: { algorithm: "sha256" as const, digest }, completionMode: "one-shot" as const, parent: { pid: 1, startedAt: 2 }, child: { pid: 3, startedAt: 4 }, requestedAt: 5 };
		await atomicWriteJson(paths.allocationPath, allocation);
		await atomicWriteJson(paths.promotionRequestPath, request);
		const { requestedAt: _requestedAt, ...ack } = request;
		await atomicWriteJson(paths.promotionAckPath, { ...ack, kind: "ack", acknowledgedAt: 6 });
		await atomicWriteJson(paths.detachedOwnershipPath, { contract: "pi-subagent.detached-ownership", version: 1, runId, owner: "user", detachedAt: 7, allocation: request.allocation, completionMode: request.completionMode });
		const failed = await reapStaleInteractiveRuns({
			rootDir: root,
			inspectPromotedTarget: async () => "absent",
			removePromotedRunArtifacts: async () => { throw new Error("injected promoted deletion failure"); },
		});
		assert.deepEqual(failed.reaped, []);
		assert.deepEqual(failed.invalid, [runId]);
		assert.deepEqual(failed.skipped, [runId]);
		assert.equal(fs.existsSync(paths.runDir), true, "failed deletion retains retry authority");
		const recovered = await reapStaleInteractiveRuns({ rootDir: root, inspectPromotedTarget: async () => "absent" });
		assert.deepEqual(recovered.reaped, [runId]);
		assert.equal(fs.existsSync(paths.runDir), false);
	});

	test("retains a partial transfer chain without target mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const runId = "partial-transfer"; const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(paths.allocationPath, allocation);
		await atomicWriteJson(paths.promotionRequestPath, { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174004", runId,
			allocation: { algorithm: "sha256", digest: crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") }, completionMode: "one-shot", parent: { pid: 1, startedAt: 2 }, child: { pid: 3, startedAt: 4 }, requestedAt: 5 });
		let mutations = 0;
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 20_000, staleAfterMs: 1, cmuxRun: async () => { mutations += 1; return { exitCode: 0, stdout: "", stderr: "", aborted: false }; } });
		assert.equal(outcome.invalid.includes(runId), true);
		assert.equal(outcome.skipped.includes(runId), true);
		assert.equal(mutations, 0);
	});

	test("rejects complete promotion chains when valid or malformed completion authority also exists", async () => {
		for (const [label, completion] of [
			["valid", { version: 2, status: "failed", completedAt: 1, errorCode: "child-error" }],
			["malformed", "{malformed}\n"],
		] as const) {
			const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `pi-subagent-reaper-dual-${label}-`)); tempDirs.push(root);
			const runId = `dual-authority-${label}`; const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
			const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
			const digest = crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex");
			const request = { contract: "pi-subagent.detached-transfer", version: 1, kind: "request", transferId: "123e4567-e89b-12d3-a456-426614174004", runId,
				allocation: { algorithm: "sha256", digest }, completionMode: "one-shot", parent: { pid: 1, startedAt: 2 }, child: { pid: 3, startedAt: 4 }, requestedAt: 5 };
			await atomicWriteJson(paths.allocationPath, allocation);
			await atomicWriteJson(paths.promotionRequestPath, request);
			const { requestedAt: _requestedAt, ...shared } = request;
			await atomicWriteJson(paths.promotionAckPath, { ...shared, kind: "ack", acknowledgedAt: 6 });
			await atomicWriteJson(paths.detachedOwnershipPath, { contract: "pi-subagent.detached-ownership", version: 1, runId, owner: "user", detachedAt: 7, allocation: request.allocation, completionMode: request.completionMode });
			if (typeof completion === "string") await fs.promises.writeFile(paths.completionPath, completion, { mode: 0o600 });
			else await atomicWriteJson(paths.completionPath, { ...completion, runId });
			let mutations = 0;
			const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 20_000, staleAfterMs: 1, cmuxRun: async () => { mutations += 1; return { exitCode: 0, stdout: "", stderr: "", aborted: false }; } });
			assert.equal(outcome.invalid.includes(runId), true, `${label} completion makes dual authority invalid`);
			assert.equal(outcome.skipped.includes(runId), true);
			assert.equal(mutations, 0);
			assert.equal(fs.existsSync(paths.runDir), true);
		}
	});

	test("retains malformed promotion markers without target mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const runId = "malformed-user-ownership";
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		await atomicWriteJson(paths.allocationPath, {
			version: 2, runId, terminalMode: "cmux-pane",
			target: { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1,
		});
		await fs.promises.writeFile(paths.detachedOwnershipPath, "{malformed}\n", { mode: 0o600 });
		let mutations = 0;
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root, now: Date.now() + 20_000, staleAfterMs: 1,
			cmuxRun: async () => { mutations += 1; return { exitCode: 0, stdout: "", stderr: "", aborted: false }; },
		});
		assert.equal(outcome.invalid.includes(runId), true);
		assert.equal(outcome.skipped.includes(runId), true);
		assert.equal(mutations, 0);
		assert.equal(fs.existsSync(paths.runDir), true);
	});

	test("retains a detached marker bound to a different allocation without target mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const runId = "mismatched-detached-ownership";
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		await atomicWriteJson(paths.allocationPath, { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 });
		await atomicWriteJson(paths.detachedOwnershipPath, { contract: "pi-subagent.detached-ownership", version: 1, runId, owner: "user", detachedAt: 1, allocation: { algorithm: "sha256", digest: "a".repeat(64) }, completionMode: "one-shot" });
		let mutations = 0;
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 20_000, staleAfterMs: 1, cmuxRun: async () => { mutations += 1; return { exitCode: 0, stdout: "", stderr: "", aborted: false }; } });
		assert.equal(outcome.invalid.includes(runId), true);
		assert.equal(outcome.skipped.includes(runId), true);
		assert.equal(mutations, 0);
		assert.equal(fs.existsSync(paths.runDir), true);
	});

	test("retains conflicting detached and legacy ownership markers without target mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const runId = "conflicting-ownership";
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const allocation = { version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		await atomicWriteJson(paths.allocationPath, allocation);
		const digest = crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex");
		await atomicWriteJson(paths.detachedOwnershipPath, { contract: "pi-subagent.detached-ownership", version: 1, runId, owner: "user", detachedAt: 1, allocation: { algorithm: "sha256", digest }, completionMode: "one-shot" });
		await atomicWriteJson(paths.userOwnershipPath, { version: 1, runId, promotedAt: 1, allocationDigest: "b".repeat(64) });
		let mutations = 0;
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 20_000, staleAfterMs: 1, cmuxRun: async () => { mutations += 1; return { exitCode: 0, stdout: "", stderr: "", aborted: false }; } });
		assert.equal(outcome.invalid.includes(runId), true);
		assert.equal(outcome.skipped.includes(runId), true);
		assert.equal(mutations, 0);
		assert.equal(fs.existsSync(paths.runDir), true);
	});

	test("quarantines stale V1 cmux descendants while keeping fresh and detached records", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const parent = await createRun(root, { runId: "parent", surfaceId: "123e4567-e89b-12d3-a456-426614174001", renewedAt: 1 });
		const child = await createRun(root, { runId: "child", surfaceId: "123e4567-e89b-12d3-a456-426614174002", parentRunId: "parent", renewedAt: 1 });
		await createRun(root, { runId: "fresh", surfaceId: "123e4567-e89b-12d3-a456-426614174003", renewedAt: 95 });
		await createRun(root, { runId: "detached", surfaceId: "123e4567-e89b-12d3-a456-426614174004", renewedAt: 1, ownership: "detached" });
		const calls: string[][] = [];
		const scheduled: string[] = [];
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root,
			now: 100,
			staleAfterMs: 10,
			cmuxRun: async (args) => {
				calls.push(args);
				return { exitCode: 0, stdout: "", stderr: "", aborted: false };
			},
			scheduleCleanup: (runDir) => scheduled.push(path.basename(runDir)),
		});

		assert.deepEqual(outcome.reaped, []);
		assert.deepEqual(new Set(outcome.invalid), new Set(["child", "parent"]));
		assert.deepEqual(new Set(outcome.skipped), new Set(["child", "parent", "fresh", "detached"]));
		assert.deepEqual(calls, []);
		assert.deepEqual(scheduled, []);
		assert.equal(fs.existsSync(child.taskPath), false);
		assert.equal(fs.existsSync(parent.taskPath), false);
		assert.equal(fs.existsSync(child.launchPath), true);
	});

	test("never interrupts or closes a V1 cmux target even with canonical-looking IDs", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const surfaceId = "123e4567-e89b-12d3-a456-426614174009";
		const paths = await createRun(root, { runId: "workspace-bound", surfaceId, renewedAt: 1 });
		const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root,
			now: 100,
			staleAfterMs: 10,
			cmuxRun: async (args) => {
				calls.push(args);
				return { exitCode: 0, stdout: JSON.stringify(cmuxTargetTree(surfaceId)), stderr: "", aborted: false };
			},
			scheduleCleanup: () => assert.fail("V1 cmux must be retained, not scheduled"),
		});
		assert.deepEqual(outcome.reaped, []);
		assert.deepEqual(outcome.invalid, ["workspace-bound"]);
		assert.deepEqual(outcome.skipped, ["workspace-bound"]);
		assert.deepEqual(calls, []);
		assert.equal(fs.existsSync(paths.launchPath), true);
	});

	test("quarantines malformed V2 authority and reaps classified V2 descendants leaf-first", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const parent = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-parent" });
		const child = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-child" });
		const writeV2 = async (paths: typeof parent, runId: string, surfaceId: string, parentRunId?: string) => {
			await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(v2CmuxIntent(paths, runId, parentRunId))}\n`);
			await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId, terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId, paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 })}\n`);
		};
		await writeV2(parent, "v2-parent", "123e4567-e89b-12d3-a456-426614174010");
		await writeV2(child, "v2-child", "123e4567-e89b-12d3-a456-426614174011", "v2-parent");
		const malformed = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-malformed" });
		await writePrivateFile(malformed.launchIntentPath, "{broken}\n");
		const closed: string[] = [];
		const liveSurfaces = new Set(["123e4567-e89b-12d3-a456-426614174011", "123e4567-e89b-12d3-a456-426614174010"]);
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, cmuxRun: async (args) => {
			if (args[0] === "close-surface") {
				const surface = args.at(-1)!;
				closed.push(surface);
				liveSurfaces.delete(surface);
			}
			return { exitCode: 0, stdout: args.includes("tree") ? JSON.stringify(cmuxSurfaceTree([...liveSurfaces])) : "", stderr: "", aborted: false };
		} });
		assert.deepEqual(outcome.reaped, ["v2-child", "v2-parent"]);
		assert.deepEqual(closed, ["123e4567-e89b-12d3-a456-426614174011", "123e4567-e89b-12d3-a456-426614174010"]);
		assert.deepEqual(outcome.invalid, ["v2-malformed"]);
		assert.equal(fs.existsSync(malformed.runDir), true);
	});

	test("retains cyclic and unknown unified dependencies before any mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const a = await prepareRunArtifactPaths({ rootDir: root, runId: "cycle-a" });
		const b = await prepareRunArtifactPaths({ rootDir: root, runId: "cycle-b" });
		const unknown = await prepareRunArtifactPaths({ rootDir: root, runId: "unknown-child" });
		for (const [paths, intent, surfaceId] of [
			[a, v2CmuxIntent(a, "cycle-a", "cycle-b"), "123e4567-e89b-12d3-a456-426614174031"],
			[b, v2CmuxIntent(b, "cycle-b", "cycle-a"), "123e4567-e89b-12d3-a456-426614174032"],
			[unknown, v2CmuxIntent(unknown, "unknown-child", "missing-parent"), "123e4567-e89b-12d3-a456-426614174033"],
		] as const) {
			await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
			await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId: intent.runId, terminalMode: "cmux-pane", target: { workspaceId: CMUX_WORKSPACE_ID, surfaceId, paneId: "123e4567-e89b-12d3-a456-426614174034" }, allocatedAt: 1 })}\n`);
		}
		const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, cmuxRun: async (args) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "", aborted: false }; } });
		assert.deepEqual(new Set(outcome.skipped), new Set(["cycle-a", "cycle-b", "unknown-child"]));
		assert.deepEqual(calls, []);
	});

	test("reaps a layout-aware cmux allocation by exact surface without closing its container", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-layout-exact-surface" });
		const intent = v2CmuxLayoutIntent(paths, "v2-layout-exact-surface");
		const target = { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174091", paneId: intent.container.paneId };
		const allocation = {
			version: 2, runId: intent.runId, terminalMode: "cmux-pane", layout: "auto", placement: "cmux-new-surface",
			container: { kind: "cmux-pane", workspaceId: target.workspaceId, paneId: target.paneId }, target, allocatedAt: 1,
		};
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		const calls: string[][] = [];
		let targetPresent = true;
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined, cmuxRun: async (args) => {
			calls.push(args);
			if (args[0] === "close-surface") targetPresent = false;
			return { exitCode: 0, stdout: args.includes("tree") ? JSON.stringify(targetPresent ? cmuxTargetTree(target.surfaceId) : cmuxAbsentTree()) : "", stderr: "", aborted: false };
		} });
		assert.deepEqual(outcome.reaped, [intent.runId]);
		const closeCalls = calls.filter((args) => args[0] === "close-surface");
		assert.deepEqual(closeCalls, [["close-surface", "--workspace", target.workspaceId, "--surface", target.surfaceId]]);
		assert.equal(calls.flat().includes(target.paneId), false);
	});

	test("retains a V3 success session boundary when exact stale-target cleanup remains unresolved", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v3-unresolved-target" });
		const intent = v2CmuxLayoutIntent(paths, "v3-unresolved-target");
		const target = { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174092", paneId: intent.container.paneId };
		const allocation = { version: 2, runId: intent.runId, terminalMode: "cmux-pane", layout: "auto", placement: "cmux-new-surface", container: { kind: "cmux-pane", workspaceId: target.workspaceId, paneId: target.paneId }, target, allocatedAt: 1 };
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		await writePrivateFile(paths.childSessionPath, `${JSON.stringify({ type: "message", id: "final", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`);
		const session = await computeSessionCompletionBoundary(paths.childSessionPath); assert.ok(session);
		await writePrivateFile(paths.completionPath, `${JSON.stringify({ version: 3, runId: intent.runId, producer: "child", status: "completed", completedAt: 2, session })}\n`);
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined, cmuxRun: async (args) => ({ exitCode: 0, stdout: args.includes("tree") ? JSON.stringify(cmuxTargetTree(target.surfaceId)) : "", stderr: "", aborted: false }) });
		assert.deepEqual(outcome.skipped, [intent.runId]);
		assert.equal(fs.existsSync(paths.childSessionPath), true);
		assert.equal(fs.existsSync(paths.completionPath), true);
	});

	test("quarantine preserves a valid boundary-less V3 transcript while scrubbing other secrets", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const runId = "boundaryless-v3-quarantine";
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(v2CmuxIntent(paths, runId))}\n`);
		await atomicWriteJson(paths.brokerStatusPath, { version: 2, runId, writer: "broker", pid: 999_999, phase: "failed", updatedAt: 1, errorCode: "allocation-failed" });
		await atomicWriteJson(paths.completionPath, {
			version: 3, runId, producer: "parent", status: "failed", completedAt: 1,
			errorCode: "transport-lost", evidenceRefs: ["state"],
		});
		await writePrivateFile(paths.childSessionPath, "boundary-less transcript\n");
		for (const secret of [paths.taskPath, paths.systemPromptPath, paths.secretEnvPath, paths.wrapperPath]) {
			await writePrivateFile(secret, "secret");
		}
		let corrupted = false;
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 100, staleAfterMs: 10,
			onValidationConcurrency: (active) => {
				if (active !== 0 || corrupted) return;
				corrupted = true;
				// This simulates a malformed surrounding authority published after
				// the read-only classification but before cleanup revalidation.
				fs.writeFileSync(paths.brokerStatusPath, "{}\n", { mode: 0o600 });
				fs.chmodSync(paths.brokerStatusPath, 0o600);
			},
		});
		assert.equal(corrupted, true);
		assert.deepEqual(outcome.invalid, [runId]);
		assert.deepEqual(outcome.skipped, [runId]);
		assert.equal(await fs.promises.readFile(paths.childSessionPath, "utf8"), "boundary-less transcript\n");
		for (const secret of [paths.taskPath, paths.systemPromptPath, paths.secretEnvPath, paths.wrapperPath]) {
			assert.equal(fs.existsSync(secret), false);
		}
		assert.equal(fs.existsSync(paths.completionPath), true);
	});

	test("quarantines a V2 cmux allocation that aliases its immutable source surface", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-source-surface-alias" });
		const intent = v2CmuxIntent(paths, "v2-source-surface-alias");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId: intent.runId, terminalMode: "cmux-pane", target: { workspaceId: intent.source.workspaceId, surfaceId: intent.source.sourceSurfaceId, paneId: "123e4567-e89b-12d3-a456-426614174022" }, allocatedAt: 1 })}\n`);
		const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, cmuxRun: async (args) => {
			calls.push(args); return { exitCode: 0, stdout: "", stderr: "", aborted: false };
		} });
		assert.deepEqual(outcome.invalid, [intent.runId]);
		assert.deepEqual(outcome.skipped, [intent.runId]);
		assert.deepEqual(calls, []);
	});

	test("reaps a layout-aware tmux allocation through its exact pane only", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-layout-tmux-pane" });
		const intent = v2TmuxLayoutIntent(paths, "v2-layout-tmux-pane");
		const allocation = {
			version: 2, runId: intent.runId, terminalMode: "tmux-pane" as const, layout: "split" as const, placement: "tmux-split" as const,
			container: { kind: "tmux-window" as const, socketPath: "/tmp/tmux.sock", serverPid: 123, sessionId: "$1", windowId: "@2", paneId: "%2", panePid: 789, generation: tmuxGeneration },
			target: { socketPath: "/tmp/tmux.sock", serverPid: 123, paneId: "%2", panePid: 789, generation: tmuxGeneration }, allocatedAt: 1,
		};
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		let closed = false; const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined, isTmuxGenerationCurrent: (generation, serverPid) => generation.socketPath === tmuxGeneration.socketPath && generation.socketDev === tmuxGeneration.socketDev && generation.socketIno === tmuxGeneration.socketIno && generation.serverStartedAt === tmuxGeneration.serverStartedAt && serverPid === 123, tmuxRun: async (args) => {
			calls.push(args);
			if (args.includes("display-message")) return { exitCode: 0, stdout: "123\n", stderr: "", aborted: false };
			if (args.includes("list-panes")) return { exitCode: 0, stdout: closed ? "%1\t0\tsource\t456\n" : "%2\t0\tallocated\t789\n", stderr: "", aborted: false };
			if (args.includes("if-shell") && args.some((arg) => arg === "kill-pane -t %2")) closed = true;
			return { exitCode: 0, stdout: "", stderr: "", aborted: false };
		} });
		assert.deepEqual(outcome.reaped, [intent.runId]);
		assert.ok(calls.some((args) => args.includes("if-shell") && args.some((arg) => arg === "kill-pane -t %2")));
		assert.equal(calls.some((args) => args.includes("kill-window") || args.includes("kill-session")), false);
	});

	test("reaps a strict V3 tmux chain through one generation-fenced control runner", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const runId = "v3-control-tmux-pane";
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId });
		const executable = fs.realpathSync(process.execPath), executableStat = fs.statSync(executable, { bigint: true });
		const probeResult = { detectedTmuxVersion: "3.7b" as const, serverPid: 123, attachedSessionId: "$1", sourcePaneId: "%1", sourcePanePid: 456, paneRows: [{ sessionId: "$1", paneId: "%1", panePid: 456 }, { sessionId: "$1", paneId: "%2", panePid: 789 }] };
		const transportGate = {
			version: 1 as const, runId, selectedTransport: "tmux-control-v1" as const,
			fixtureContractId: TMUX_CONTROL_FIXTURE_CONTRACT_ID, pinnedSourceCommit: TMUX_CONTROL_SOURCE_COMMIT,
			executableGeneration: { realpath: executable, dev: String(executableStat.dev), ino: String(executableStat.ino), size: String(executableStat.size), mtimeNs: String(executableStat.mtimeNs), ctimeNs: String(executableStat.ctimeNs) },
			probeRecipeId: TMUX_CONTROL_PROBE_RECIPE_ID, probeResult, probeDigestAlgorithm: "sha256" as const,
			probeDigest: crypto.createHash("sha256").update(canonicalTmuxProbeBytes(probeResult)).digest("hex"),
			canonicalSocketPath: "/tmp/tmux.sock", socketDev: 1, socketIno: 2, serverStartedAt: 3, createdAt: 4,
		};
		await writePrivateFile(paths.transportGatePath, `${JSON.stringify(transportGate)}\n`);
		const transportGateDigest = await exactArtifactDigest(paths.transportGatePath); assert.ok(transportGateDigest);
		const intent = { ...v2TmuxLayoutIntent(paths, runId), version: 3 as const, backendPath: executable, runtimePath: executable, runtimeInterpreterPath: executable, brokerEntrypoint: executable, transport: "tmux-control-v1" as const, transportGatePath: paths.transportGatePath, transportGateDigest };
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		const intentDigest = await exactArtifactDigest(paths.launchIntentPath); assert.ok(intentDigest);
		const allocation = {
			version: 3 as const, runId, terminalMode: "tmux-pane" as const, transport: "tmux-control-v1" as const, intentDigest,
			layout: "split" as const, placement: "tmux-split" as const,
			container: { kind: "tmux-window" as const, socketPath: "/tmp/tmux.sock", serverPid: 123, sessionId: "$1", windowId: "@2", paneId: "%2", panePid: 789, generation: tmuxGeneration },
			target: { socketPath: "/tmp/tmux.sock", serverPid: 123, paneId: "%2", panePid: 789, generation: tmuxGeneration }, allocatedAt: 5,
		};
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		const allocationDigest = await exactArtifactDigest(paths.allocationPath); assert.ok(allocationDigest);
		await writePrivateFile(paths.decisionPath, `${JSON.stringify({ version: 3, runId, kind: "commit", decidedAt: 6, allocationPath: paths.allocationPath, launchPath: paths.launchPath })}\n`);
		await writePrivateFile(paths.launchPath, `${JSON.stringify({ version: 3, runId, terminalMode: "tmux-pane", transport: "tmux-control-v1", allocationPath: paths.allocationPath, allocationDigest, childSessionFile: paths.childSessionPath, committedAt: 7, ownership: "parent-owned" })}\n`);
		await writePrivateFile(paths.launchGatePath, `${JSON.stringify({ version: 3, runId, terminalMode: "tmux-pane", launchPath: paths.launchPath, publishedAt: 8 })}\n`);
		let closed = false, managerClosed = false; const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined,
			isTmuxGenerationCurrent: () => true,
			isTmuxControlGateCurrent: () => true,
			tmuxControlRunFactory: async (gate, backendPath) => {
				assert.equal(gate.runId, runId); assert.equal(backendPath, executable);
				return { close: () => { managerClosed = true; }, run: async (args) => {
					calls.push(args);
					if (args.includes("display-message")) return { exitCode: 0, stdout: "123\n", stderr: "", aborted: false };
					if (args.at(-1)?.includes("|")) return { exitCode: 0, stdout: closed ? "%1|$1|@2|456\n" : "%1|$1|@2|456\n%2|$1|@2|789\n", stderr: "", aborted: false };
					if (args.at(-1) === "#{pane_id}\t#{pane_pid}") return { exitCode: 0, stdout: closed ? "%1\t456\n" : "%1\t456\n%2\t789\n", stderr: "", aborted: false };
					if (args.includes("list-panes")) return { exitCode: 0, stdout: closed ? "%1\t0\tsource\t456\n" : "%2\t0\tallocated\t789\n", stderr: "", aborted: false };
					if (args.includes("if-shell") && args.some((arg) => arg === "kill-pane -t %2")) closed = true;
					return { exitCode: 0, stdout: "", stderr: "", aborted: false };
				} };
			},
		});
		assert.deepEqual(outcome.reaped, [runId]);
		assert.equal(managerClosed, true);
		assert.ok(calls.some((args) => args.includes("if-shell") && args.some((arg) => arg === "kill-pane -t %2")));
	});

	test("retains generation-less V2 tmux diagnostics without lifecycle mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-legacy-tmux" });
		const generatedIntent = v2TmuxIntent(paths, "v2-legacy-tmux");
		const { generation: _generation, ...source } = generatedIntent.source;
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify({ ...generatedIntent, source })}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId: generatedIntent.runId, terminalMode: "tmux-pane", target: { socketPath: source.socketPath, serverPid: source.serverPid, paneId: "%2", panePid: 789 }, allocatedAt: 1 })}\n`);
		const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, tmuxRun: async (args) => {
			calls.push(args); return { exitCode: 0, stdout: "", stderr: "", aborted: false };
		} });
		assert.deepEqual(outcome.invalid, [generatedIntent.runId]);
		assert.deepEqual(outcome.skipped, [generatedIntent.runId]);
		assert.deepEqual(calls, []);
	});

	test("quarantines a V2 tmux allocation that aliases its immutable source pane without lifecycle mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-source-pane-alias" });
		const intent = v2TmuxIntent(paths, "v2-source-pane-alias");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		// A changed PID does not make the source pane a new allocation.
		await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId: intent.runId, terminalMode: "tmux-pane", target: { socketPath: intent.source.socketPath, serverPid: intent.source.serverPid, paneId: intent.source.sourcePaneId, panePid: intent.source.sourcePanePid + 1, generation: tmuxGeneration }, allocatedAt: 1 })}\n`);
		const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, tmuxRun: async (args) => {
			calls.push(args); return { exitCode: 0, stdout: "", stderr: "", aborted: false };
		} });
		assert.deepEqual(outcome.invalid, [intent.runId]);
		assert.deepEqual(outcome.skipped, [intent.runId]);
		assert.deepEqual(calls, []);
	});

	test("reaps a V2 allocation whose workspace UUID is an uppercase source alias", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-uppercase-workspace" });
		const intent = v2CmuxIntent(paths, "v2-uppercase-workspace");
		const target = { workspaceId: intent.source.workspaceId.toUpperCase(), surfaceId: "123e4567-e89b-12d3-a456-426614174021", paneId: "123e4567-e89b-12d3-a456-426614174022" };
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId: intent.runId, terminalMode: "cmux-pane", target, allocatedAt: 1 })}\n`);
		const calls: string[][] = [];
		let targetPresent = true;
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined, cmuxRun: async (args) => {
			calls.push(args);
			if (args[0] === "close-surface") targetPresent = false;
			return { exitCode: 0, stdout: args.includes("tree") ? JSON.stringify(targetPresent ? cmuxTargetTree(target.surfaceId, target.workspaceId) : cmuxAbsentTree(target.workspaceId)) : "", stderr: "", aborted: false };
		} });
		assert.deepEqual(outcome.reaped, [intent.runId]);
		assert.equal(calls.some((args) => args[0] === "close-surface" && args.includes(target.workspaceId)), true);
	});

	test("quarantines a V2 allocation whose source does not match its immutable intent", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-source-mismatch" });
		const intent = v2CmuxIntent(paths, "v2-source-mismatch");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId: intent.runId, terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174099", surfaceId: "123e4567-e89b-12d3-a456-426614174021", paneId: "123e4567-e89b-12d3-a456-426614174022" }, allocatedAt: 1 })}\n`);
		const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, cmuxRun: async (args) => {
			calls.push(args); return { exitCode: 0, stdout: "", stderr: "", aborted: false };
		} });
		assert.deepEqual(outcome.invalid, [intent.runId]);
		assert.deepEqual(outcome.skipped, [intent.runId]);
		assert.deepEqual(calls, []);
	});

	test("retains a V2-exclusive pathname with V1-looking content before V1 fallback", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await createRun(root, { runId: "v2-no-downgrade", surfaceId: "123e4567-e89b-12d3-a456-426614174020", renewedAt: 1 });
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify({ version: 1, runId: "v2-no-downgrade" })}\n`);
		const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, cmuxRun: async (args) => {
			calls.push(args); return { exitCode: 0, stdout: "", stderr: "", aborted: false };
		} });
		assert.deepEqual(outcome.invalid, ["v2-no-downgrade"]);
		assert.equal(calls.length, 0);
		assert.equal(fs.existsSync(paths.launchPath), true);
		assert.equal(fs.existsSync(paths.taskPath), true);
	});

	test("retains a malformed V2 launch instead of deleting it as V1", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-malformed-launch" });
		await writePrivateFile(paths.taskPath, "secret task");
		await atomicWriteJson(paths.launchPath, { version: 2, runId: "v2-malformed-launch" });
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 20_000, staleAfterMs: 10 });
		assert.deepEqual(outcome.invalid, ["v2-malformed-launch"]);
		assert.equal(fs.existsSync(paths.launchPath), true);
		assert.equal(fs.existsSync(paths.taskPath), true);
	});

	test("retires terminal V2 targets and intention-only runs with diagnostic retention", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const target = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-target-gone" });
		const intent = (runId: string, paths: typeof target) => v2CmuxIntent(paths, runId);
		await writePrivateFile(target.launchIntentPath, `${JSON.stringify(intent("v2-target-gone", target))}\n`);
		await writePrivateFile(target.allocationPath, `${JSON.stringify({ version: 2, runId: "v2-target-gone", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId: "123e4567-e89b-12d3-a456-426614174021", paneId: "123e4567-e89b-12d3-a456-426614174022" }, allocatedAt: 1 })}\n`);
		const intention = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-intention-only" });
		await writePrivateFile(intention.launchIntentPath, `${JSON.stringify(intent("v2-intention-only", intention))}\n`);
		const scheduled: string[] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: (runDir) => scheduled.push(path.basename(runDir)), cmuxRun: async (args) => ({
			exitCode: args[0] === "close-surface" ? 1 : 0, stdout: args.includes("tree") ? JSON.stringify(cmuxAbsentTree()) : "", stderr: "", aborted: false,
		}) });
		assert.deepEqual(outcome.reaped, ["v2-intention-only", "v2-target-gone"]);
		assert.deepEqual(scheduled, ["v2-intention-only", "v2-target-gone"]);
	});

	test("does not let a fresh V2 lease outlive its immutable dead parent identity", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-dead-parent" });
		const intent = v2CmuxIntent(paths, "v2-dead-parent");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await atomicWriteJson(paths.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION, runId: intent.runId, parentPid: intent.parentPid,
			parentStartedAt: intent.parentStartedAt, renewedAt: 100,
		});
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined,
			isProcessIdentityAlive: () => false,
		});
		assert.deepEqual(outcome.reaped, [intent.runId]);
	});

	test("does not let a fresh matching zombie-parent lease block exact V2 target cleanup", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-zombie-parent" });
		const intent = v2CmuxIntent(paths, "v2-zombie-parent");
		const allocation = {
			version: 2, runId: intent.runId, terminalMode: "cmux-pane" as const,
			target: { workspaceId: intent.source.workspaceId, surfaceId: "123e4567-e89b-12d3-a456-426614174040", paneId: "123e4567-e89b-12d3-a456-426614174041" }, allocatedAt: 1,
		};
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		await atomicWriteJson(paths.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION, runId: intent.runId, parentPid: intent.parentPid,
			parentStartedAt: intent.parentStartedAt, renewedAt: 100,
		});
		const calls: string[][] = [];
		let targetPresent = true;
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined,
			isProcessIdentityAlive: (pid, startedAt) => {
				assert.equal(pid, intent.parentPid);
				assert.equal(startedAt, intent.parentStartedAt);
				return false;
			},
			cmuxRun: async (args) => {
				calls.push(args);
				if (args[0] === "close-surface") targetPresent = false;
				return { exitCode: 0, stdout: args.includes("tree") ? JSON.stringify(targetPresent ? cmuxTargetTree(allocation.target.surfaceId) : cmuxAbsentTree()) : "", stderr: "", aborted: false };
			},
		});
		assert.deepEqual(outcome.reaped, [intent.runId]);
		assert.equal(calls.some((args) => args[0] === "close-surface" && args.at(-1) === allocation.target.surfaceId), true);
	});

	test("would skip a fresh live-harness lease if a zombie were incorrectly considered alive", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-zombie-considered-live" });
		const intent = v2CmuxIntent(paths, "v2-zombie-considered-live");
		const allocation = {
			version: 2, runId: intent.runId, terminalMode: "cmux-pane" as const,
			target: { workspaceId: intent.source.workspaceId, surfaceId: "123e4567-e89b-12d3-a456-426614174042", paneId: "123e4567-e89b-12d3-a456-426614174043" }, allocatedAt: 1,
		};
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		await atomicWriteJson(paths.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION, runId: intent.runId, parentPid: intent.parentPid,
			parentStartedAt: intent.parentStartedAt, renewedAt: 100,
		});
		const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 100, staleAfterMs: 5_000, scheduleCleanup: () => undefined,
			// Regression seam: treating a matching zombie as alive would suppress
			// the same positive-window cleanup used by the live harness.
			isProcessIdentityAlive: () => true,
			cmuxRun: async (args) => {
				calls.push(args);
				return { exitCode: 0, stdout: args.includes("tree") ? JSON.stringify(cmuxAbsentTree()) : "", stderr: "", aborted: false };
			},
		});
		assert.deepEqual(outcome.skipped, [intent.runId]);
		assert.deepEqual(outcome.reaped, []);
		assert.deepEqual(calls, []);
		assert.equal(fs.existsSync(paths.taskPath), false);
	});

	test("fences a broker delayed before claim and retains when a claim races cancellation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "delayed-before-claim" });
		const intent = v2CmuxIntent(paths, "delayed-before-claim");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.taskPath, "secret");
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => assert.fail("late claim must retain"),
			publishImmutable: async (filePath, value) => {
				await writePrivateFile(filePath, `${JSON.stringify(value)}\n`);
				await writePrivateFile(paths.brokerClaimPath, `${JSON.stringify({ version: 2, runId: intent.runId, brokerNonce: intent.brokerNonce, pid: 999999, brokerStartedAt: 1, claimedAt: 2 })}\n`);
				return "published";
			},
		});
		assert.deepEqual(outcome.skipped, [intent.runId]);
		assert.equal((await readJsonFile(paths.decisionPath) as any).reason, "commit-timeout");
		assert.equal(fs.existsSync(paths.taskPath), true);
	});

	test("stale dead ready broker publishes an immutable cancel before preserving no-allocation recovery", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "reaper-ready-cancel" });
		const intent = v2CmuxIntent(paths, "reaper-ready-cancel");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.brokerClaimPath, `${JSON.stringify({ version: 2, runId: intent.runId, brokerNonce: intent.brokerNonce, pid: 999999, brokerStartedAt: 1, claimedAt: 1 })}\n`);
		await writePrivateFile(paths.taskPath, "secret");
		await atomicWriteJson(paths.brokerStatusPath, { version: 2, runId: intent.runId, writer: "broker", pid: 999999, phase: "ready", updatedAt: 1 });
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => assert.fail("must preserve recovery authority") });
		assert.deepEqual(outcome.skipped, [intent.runId]);
		assert.deepEqual(await readJsonFile(paths.decisionPath), { version: 2, runId: intent.runId, kind: "cancel", decidedAt: 100, reason: "ready-timeout" });
		assert.equal(fs.existsSync(paths.taskPath), false);
	});

	test("reconciles a concurrent commit winner instead of claiming its ready cancel", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "reaper-commit-winner" });
		const intent = v2CmuxIntent(paths, "reaper-commit-winner");
		const allocation = { version: 2, runId: intent.runId, terminalMode: "cmux-pane" as const, target: { workspaceId: intent.source.workspaceId, surfaceId: "123e4567-e89b-12d3-a456-426614174050", paneId: "123e4567-e89b-12d3-a456-426614174051" }, allocatedAt: 2 };
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.brokerClaimPath, `${JSON.stringify({ version: 2, runId: intent.runId, brokerNonce: intent.brokerNonce, pid: 999999, brokerStartedAt: 1, claimedAt: 1 })}\n`);
		await atomicWriteJson(paths.brokerStatusPath, { version: 2, runId: intent.runId, writer: "broker", pid: 999999, phase: "ready", updatedAt: 1 });
		const scheduled: string[] = [];
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: (dir) => scheduled.push(path.basename(dir)),
			publishImmutable: async () => {
				await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
				await writePrivateFile(paths.decisionPath, `${JSON.stringify({ version: 2, runId: intent.runId, kind: "commit", decidedAt: 2, allocationPath: paths.allocationPath, launchPath: paths.launchPath })}\n`);
				return "exists";
			},
			cmuxRun: async (args) => ({ exitCode: 0, stdout: args.includes("tree") ? JSON.stringify(cmuxAbsentTree()) : "", stderr: "", aborted: false }),
		});
		assert.deepEqual(outcome.reaped, [intent.runId]);
		assert.deepEqual(scheduled, [intent.runId]);
		assert.equal((await readJsonFile(paths.decisionPath) as { kind?: string }).kind, "commit");
	});

	test("retains stale ready cancellation without allocation as recovery-pending", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "ready-cancel-pending" });
		const intent = v2CmuxIntent(paths, "ready-cancel-pending");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.brokerClaimPath, `${JSON.stringify({ version: 2, runId: intent.runId, brokerNonce: intent.brokerNonce, pid: 999999, brokerStartedAt: 1, claimedAt: 1 })}\n`);
		await writePrivateFile(paths.taskPath, "secret");
		await fs.promises.writeFile(`${paths.wrapperStatusPath}.tmp.123`, "temporary", { mode: 0o600 });
		await fs.promises.writeFile(`${paths.wrapperStatusPath}.tmp.001`, "not a canonical PID", { mode: 0o600 });
		await fs.promises.mkdir(`${paths.wrapperStatusPath}.tmp.456`, { mode: 0o700 });
		await atomicWriteJson(paths.decisionPath, { version: 2, runId: intent.runId, kind: "cancel", decidedAt: 2, reason: "ready-timeout" });
		await atomicWriteJson(paths.brokerStatusPath, { version: 2, runId: intent.runId, writer: "broker", pid: 999999, phase: "ready", updatedAt: 1 });
		const scheduled: string[] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: (dir) => scheduled.push(dir) });
		assert.deepEqual(outcome.skipped, [intent.runId]);
		assert.deepEqual(scheduled, []);
		assert.equal(fs.existsSync(paths.runDir), true);
		assert.equal(fs.existsSync(paths.taskPath), false);
		assert.equal(fs.existsSync(`${paths.wrapperStatusPath}.tmp.123`), false);
		assert.equal(fs.existsSync(`${paths.wrapperStatusPath}.tmp.001`), true);
		assert.equal(fs.existsSync(`${paths.wrapperStatusPath}.tmp.456`), true);
	});

	test("does not mark a run reaped or schedule retention when selected secret deletion fails", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "secret-delete-failure" });
		const intent = v2CmuxIntent(paths, "secret-delete-failure");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.taskPath, "secret");
		const scheduled: string[] = [];
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: (dir) => scheduled.push(dir),
			removeSensitivePath: async (target) => {
				if (target === paths.taskPath) throw new Error("injected deletion failure");
				await fs.promises.rm(target, { recursive: true, force: true });
			},
		});
		assert.deepEqual(outcome.reaped, []);
		assert.deepEqual(outcome.invalid, [intent.runId]);
		assert.deepEqual(outcome.skipped, [intent.runId]);
		assert.deepEqual(scheduled, []);
		assert.equal(fs.existsSync(paths.taskPath), true);
		assert.equal(fs.existsSync(paths.shellHomePath), false);
	});

	test("does not let terminal broker status with a reused live PID block cleanup and strips recovery secrets", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "terminal-broker-pid" });
		const intent = v2CmuxIntent(paths, "terminal-broker-pid");
		const allocation = { version: 2, runId: "terminal-broker-pid", terminalMode: "cmux-pane", target: { workspaceId: intent.source.workspaceId, surfaceId: "123e4567-e89b-12d3-a456-426614174030", paneId: "123e4567-e89b-12d3-a456-426614174031" }, allocatedAt: 1 };
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		await atomicWriteJson(paths.brokerStatusPath, { version: 2, runId: intent.runId, writer: "broker", pid: process.pid, phase: "committed", updatedAt: 100 });
		for (const artifact of [paths.taskPath, paths.systemPromptPath, paths.childSessionPath, paths.secretEnvPath, paths.wrapperPath, paths.wrapperStatusPath, paths.stderrPath]) {
			await fs.promises.writeFile(artifact, "secret", { mode: 0o600 });
		}
		await fs.promises.writeFile(`${paths.wrapperStatusPath}.tmp.456`, "temporary", { mode: 0o600 });
		await fs.promises.writeFile(`${paths.wrapperStatusPath}.tmp.0`, "not a canonical PID", { mode: 0o600 });
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined, cmuxRun: async (args) => ({
			exitCode: 0, stdout: args.includes("tree") ? JSON.stringify(cmuxAbsentTree()) : "", stderr: "", aborted: false,
		}) });
		assert.deepEqual(outcome.reaped, [intent.runId]);
		for (const artifact of [paths.taskPath, paths.systemPromptPath, paths.secretEnvPath, paths.wrapperPath, paths.wrapperStatusPath, paths.stderrPath]) assert.equal(fs.existsSync(artifact), false);
		assert.equal(fs.existsSync(paths.childSessionPath), true, "immutable terminal authority retains the transcript for bounded usage recovery/audit");
		assert.equal(fs.existsSync(`${paths.wrapperStatusPath}.tmp.456`), false);
		assert.equal(fs.existsSync(`${paths.wrapperStatusPath}.tmp.0`), true);
		assert.equal(fs.existsSync(paths.allocationPath), true);
		assert.equal(fs.existsSync(paths.brokerStatusPath), true);
	});

	test("does not let a failed broker status with a reused live PID block stale intent cleanup", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "failed-broker-pid" });
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(v2CmuxIntent(paths, "failed-broker-pid"))}\n`);
		await writePrivateFile(paths.taskPath, "secret");
		await atomicWriteJson(paths.brokerStatusPath, { version: 2, runId: "failed-broker-pid", writer: "broker", pid: process.pid, phase: "failed", updatedAt: 100, errorCode: "allocation-failed" });
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined });
		assert.deepEqual(outcome.reaped, ["failed-broker-pid"]);
		assert.equal(fs.existsSync(paths.taskPath), false);
	});

	test("uses immutable completion time for restart retention instead of resetting the transcript TTL", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-retention-"));
		tempDirs.push(root);
		const expired = await prepareRunArtifactPaths({ rootDir: root, runId: "expired-completion-retention" });
		const expiredIntent = { ...v2CmuxIntent(expired, "expired-completion-retention"), createdAt: 1 };
		await writePrivateFile(expired.launchIntentPath, `${JSON.stringify(expiredIntent)}\n`);
		await writePrivateFile(expired.childSessionPath, "recoverable transcript\n");
		await writePrivateFile(expired.completionPath, `${JSON.stringify({ version: 3, runId: expiredIntent.runId, producer: "parent", status: "failed", completedAt: 1_000, errorCode: "transport-lost", evidenceRefs: ["state"] })}\n`);
		let expiredCleanup = Promise.resolve();
		const expiredOutcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 20_000, staleAfterMs: 10, diagnosticRetentionSeconds: 10,
			scheduleCleanup: (runDir, delaySeconds) => {
				assert.equal(delaySeconds, 0, "an expired durable completion cleans up immediately after restart");
				expiredCleanup = fs.promises.rm(runDir, { recursive: true, force: true });
			},
		});
		assert.deepEqual(expiredOutcome.reaped, [expiredIntent.runId]);
		await expiredCleanup;
		assert.equal(fs.existsSync(expired.runDir), false, "the injected immediate schedule removes the expired transcript");

		const pending = await prepareRunArtifactPaths({ rootDir: root, runId: "remaining-completion-retention" });
		const pendingIntent = { ...v2CmuxIntent(pending, "remaining-completion-retention"), createdAt: 1 };
		await writePrivateFile(pending.launchIntentPath, `${JSON.stringify(pendingIntent)}\n`);
		await writePrivateFile(pending.childSessionPath, `${JSON.stringify({ type: "message", id: "late-final", message: { role: "assistant", content: [{ type: "text", text: "late boundary" }] } })}\n`);
		await writePrivateFile(pending.completionPath, `${JSON.stringify({ version: 3, runId: pendingIntent.runId, producer: "parent", status: "failed", completedAt: 95_000, errorCode: "transport-lost", evidenceRefs: ["state"] })}\n`);
		const remaining: number[] = [];
		const pendingOutcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 100_000, staleAfterMs: 10, diagnosticRetentionSeconds: 10,
			scheduleCleanup: (_runDir, delaySeconds) => remaining.push(delaySeconds),
		});
		assert.deepEqual(pendingOutcome.reaped, [pendingIntent.runId]);
		assert.deepEqual(remaining, [5], "restart callbacks receive the remaining retention duration");
		assert.equal(fs.existsSync(pending.childSessionPath), true);
		const lateBoundary = await computeSessionCompletionBoundary(pending.childSessionPath);
		assert.ok(lateBoundary, "the retained session permits a late exact boundary capture");
		assert.equal(await verifySessionCompletionBoundary(pending.childSessionPath, lateBoundary), true);
	});

	test("does not reap through a custom root with a lexical symlink ancestor", async () => {
		if (process.platform === "win32") return;
		const container = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(container);
		const actual = path.join(container, "actual"); const alias = path.join(container, "alias");
		await fs.promises.mkdir(actual, { mode: 0o700 }); await fs.promises.symlink(actual, alias);
		const root = path.join(alias, "state");
		await fs.promises.mkdir(path.join(actual, "state"), { mode: 0o700 });
		await assert.rejects(() => reapStaleInteractiveRuns({ rootDir: root }), /Refusing to reap an untrusted/);
	});

	test("does not kill a reused tmux pane and safely retires the stale record", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await createRun(root, {
			runId: "reused-tmux-pane",
			surfaceId: "%12",
			terminalMode: "tmux-pane",
			renewedAt: 1,
		});
		const calls: string[][] = [];
		const scheduled: string[] = [];
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root,
			now: 100,
			staleAfterMs: 10,
			tmuxRun: async (args) => {
				calls.push(args);
				return { exitCode: 0, stdout: "999\n", stderr: "", aborted: false };
			},
			scheduleCleanup: (runDir) => scheduled.push(path.basename(runDir)),
		});
		assert.deepEqual(outcome.reaped, ["reused-tmux-pane"]);
		assert.deepEqual(outcome.skipped, []);
		assert.deepEqual(calls, [["-S", "/tmp/tmux/default", "display-message", "-p", "#{pid}"]]);
		assert.deepEqual(scheduled, ["reused-tmux-pane"]);
		assert.equal(fs.existsSync(paths.taskPath), false);
		assert.equal(parseCompletionRecord(await readJsonFile(paths.completionPath), "reused-tmux-pane")?.status, "orphaned");
	});

	test("quarantines V1 cmux recovery metadata without attempting close", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await createRun(root, {
			runId: "close-failed",
			surfaceId: "123e4567-e89b-12d3-a456-426614174005",
			renewedAt: 1,
		});
		const scheduled: string[] = [];
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root,
			now: 100,
			staleAfterMs: 10,
			cmuxRun: async (args) => ({
				exitCode: args[0] === "close-surface" || args[0] === "tree" ? 1 : 0,
				stdout: "",
				stderr: "unavailable",
				aborted: false,
			}),
			scheduleCleanup: (runDir) => scheduled.push(path.basename(runDir)),
		});
		assert.deepEqual(outcome.reaped, []);
		assert.deepEqual(outcome.invalid, ["close-failed"]);
		assert.deepEqual(outcome.skipped, ["close-failed"]);
		assert.deepEqual(scheduled, []);
		assert.equal(fs.existsSync(paths.taskPath), false);
		assert.equal(fs.existsSync(paths.launchPath), true);
	});

	test("reaps stale tmux panes through their recorded socket", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		await createRun(root, {
			runId: "tmux-child",
			surfaceId: "%12",
			terminalMode: "tmux-pane",
			renewedAt: 1,
		});
		const calls: string[][] = [];
		let closed = false;
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root,
			now: 100,
			staleAfterMs: 10,
			tmuxRun: async (args) => {
				calls.push(args);
				if (args.includes("if-shell") && args.some((arg) => arg === "kill-pane -t %12")) closed = true;
				const stdout = args.includes("display-message")
					? "123\n"
					: args.includes("list-panes")
						? (closed ? "%13\t0\tother\t789\n" : "%12\t0\tsubagent\t456\n")
						: "";
				return { exitCode: 0, stdout, stderr: "", aborted: false };
			},
			scheduleCleanup: () => undefined,
		});
		assert.deepEqual(outcome.reaped, ["tmux-child"]);
		const guarded = calls.filter((args) => args.includes("if-shell"));
		assert.equal(guarded.some((args) => args.some((arg) => arg === "send-keys -t %12 Escape")), true);
		assert.equal(guarded.some((args) => args.some((arg) => arg === "kill-pane -t %12")), true);
		assert.equal(calls.some((args) => args[0] === "kill-pane" || args[2] === "kill-pane"), false);
	});

	test("classifies stale runs concurrently without mutating until ordered graph cleanup", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const runIds = ["validation-ready", "validation-target", ...Array.from({ length: 10 }, (_, index) => `validation-${index}`)];
		const paths = new Map<string, Awaited<ReturnType<typeof prepareRunArtifactPaths>>>();
		for (const [index, runId] of runIds.entries()) {
			const runPaths = await prepareRunArtifactPaths({ rootDir: root, runId });
			paths.set(runId, runPaths);
			await writePrivateFile(runPaths.launchIntentPath, `${JSON.stringify(v2CmuxIntent(runPaths, runId, runIds[index - 1]))}\n`);
		}
		const ready = paths.get("validation-ready")!;
		await writePrivateFile(ready.brokerClaimPath, `${JSON.stringify({ version: 2, runId: "validation-ready", brokerNonce: "a".repeat(43), pid: 999999, brokerStartedAt: 1, claimedAt: 1 })}\n`);
		await atomicWriteJson(ready.brokerStatusPath, { version: 2, runId: "validation-ready", writer: "broker", pid: 999999, phase: "ready", updatedAt: 1 });
		const target = paths.get("validation-target")!;
		await writePrivateFile(target.allocationPath, `${JSON.stringify({ version: 2, runId: "validation-target", terminalMode: "cmux-pane", target: { workspaceId: CMUX_WORKSPACE_ID, surfaceId: "123e4567-e89b-12d3-a456-426614174070", paneId: "123e4567-e89b-12d3-a456-426614174071" }, allocatedAt: 1 })}\n`);

		let validationActive = 0;
		const validationSamples: number[] = [];
		const mutationDuringValidation: string[] = [];
		let backendCalls = 0, removeCalls = 0, publishCalls = 0, targetPresent = true;
		const outcome = await reapStaleInteractiveRuns({
			rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined,
			onValidationConcurrency: (active) => { validationActive = active; validationSamples.push(active); },
			cmuxRun: async (args) => {
				backendCalls += 1;
				if (validationActive > 0) mutationDuringValidation.push("backend");
				if (args[0] === "close-surface") targetPresent = false;
				return { exitCode: 0, stdout: args.includes("tree") ? JSON.stringify(targetPresent ? cmuxTargetTree("123e4567-e89b-12d3-a456-426614174070") : cmuxAbsentTree()) : "", stderr: "", aborted: false };
			},
			removeSensitivePath: async (artifact) => {
				removeCalls += 1;
				if (validationActive > 0) mutationDuringValidation.push("remove");
				await fs.promises.rm(artifact, { recursive: true, force: true });
			},
			publishImmutable: async () => {
				publishCalls += 1;
				if (validationActive > 0) mutationDuringValidation.push("publish");
				return "exists";
			},
		});

		assert.ok(Math.max(...validationSamples) <= 8);
		assert.ok(Math.max(...validationSamples) > 1);
		assert.deepEqual(mutationDuringValidation, []);
		assert.ok(backendCalls > 0);
		assert.ok(removeCalls > 0);
		assert.equal(publishCalls, runIds.length - 1);
		assert.deepEqual(outcome.reaped, runIds.slice(1).reverse());
		assert.deepEqual(outcome.skipped, ["validation-ready"]);
	});
});
