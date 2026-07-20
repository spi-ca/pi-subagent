import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reapStaleInteractiveRuns } from "../../src/runtime/runner";
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
		source: { socketPath: "/tmp/tmux.sock", sourcePaneId: "%1", sourcePanePid: 456, serverPid: 123 },
		childSessionFile: paths.childSessionPath, createdAt: 1, brokerNonce: "a".repeat(43),
		runtimePath: process.execPath, runtimeInterpreterPath: process.execPath, backendPath: process.execPath, brokerEntrypoint: process.execPath,
	};
}
function v2TmuxLayoutIntent(paths: { childSessionPath: string }, runId: string) {
	return {
		...v2TmuxIntent(paths, runId), layout: "split" as const, placement: "tmux-split" as const,
		container: { kind: "tmux-source-pane" as const, socketPath: "/tmp/tmux.sock", serverPid: 123, sessionId: "$1", windowId: "@2", paneId: "%1", panePid: 456 },
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

	test("removes stale incomplete run secrets but preserves a fresh pre-launch run", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const stale = await prepareRunArtifactPaths({ rootDir: root, runId: "stale-incomplete" });
		await fs.promises.writeFile(stale.secretEnvPath, "export KEY=secret\n", { mode: 0o600 });
		const fresh = await prepareRunArtifactPaths({ rootDir: root, runId: "fresh-incomplete" });
		await fs.promises.writeFile(fresh.secretEnvPath, "export KEY=secret\n", { mode: 0o600 });
		const now = Date.now() + 20_000;
		await atomicWriteJson(fresh.parentLeasePath, {
			version: RUN_PROTOCOL_VERSION,
			runId: "fresh-incomplete",
			parentPid: process.pid,
			parentStartedAt: getCurrentProcessStartedAt()!,
			renewedAt: now,
		});
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now, staleAfterMs: 12_000 });
		assert.deepEqual(outcome.invalid, ["stale-incomplete"]);
		assert.deepEqual(outcome.skipped, ["fresh-incomplete"]);
		assert.equal(fs.existsSync(stale.runDir), false);
		assert.equal(fs.existsSync(fresh.secretEnvPath), true);
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
			container: { kind: "tmux-window" as const, socketPath: "/tmp/tmux.sock", serverPid: 123, sessionId: "$1", windowId: "@2", paneId: "%2", panePid: 789 },
			target: { socketPath: "/tmp/tmux.sock", serverPid: 123, paneId: "%2", panePid: 789 }, allocatedAt: 1,
		};
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		let closed = false; const calls: string[][] = [];
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: 100, staleAfterMs: 10, scheduleCleanup: () => undefined, tmuxRun: async (args) => {
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

	test("quarantines a V2 tmux allocation that aliases its immutable source pane without lifecycle mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-source-pane-alias" });
		const intent = v2TmuxIntent(paths, "v2-source-pane-alias");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		// A changed PID does not make the source pane a new allocation.
		await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId: intent.runId, terminalMode: "tmux-pane", target: { socketPath: intent.source.socketPath, serverPid: intent.source.serverPid, paneId: intent.source.sourcePaneId, panePid: intent.source.sourcePanePid + 1 }, allocatedAt: 1 })}\n`);
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

	test("quarantines a V2-exclusive pathname with V1-looking content before V1 fallback", async () => {
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
		assert.equal(fs.existsSync(paths.taskPath), false);
	});

	test("quarantines a malformed V2 launch instead of deleting it as V1", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2-malformed-launch" });
		await writePrivateFile(paths.taskPath, "secret task");
		await atomicWriteJson(paths.launchPath, { version: 2, runId: "v2-malformed-launch" });
		const outcome = await reapStaleInteractiveRuns({ rootDir: root, now: Date.now() + 20_000, staleAfterMs: 10 });
		assert.deepEqual(outcome.invalid, ["v2-malformed-launch"]);
		assert.equal(fs.existsSync(paths.launchPath), true);
		assert.equal(fs.existsSync(paths.taskPath), false);
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

	test("stale dead ready broker publishes an immutable cancel before preserving no-allocation recovery", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "reaper-ready-cancel" });
		const intent = v2CmuxIntent(paths, "reaper-ready-cancel");
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
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
		for (const artifact of [paths.taskPath, paths.systemPromptPath, paths.childSessionPath, paths.secretEnvPath, paths.wrapperPath, paths.wrapperStatusPath, paths.stderrPath]) assert.equal(fs.existsSync(artifact), false);
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
});
