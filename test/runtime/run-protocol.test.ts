import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	RUN_PROTOCOL_VERSION,
	atomicWriteJson,
	assertSafeRunArtifactPaths,
	assertSafeStateRoot,
	isParentLeaseStale,
	isMatchingLiveProcessIdentity,
	isUsableParentLease,
	isPrivateOwnedDirectory,
	parseAllocationRecordV2,
	parseCompletionRecord,
	parseCompletionRecordV2,
	parseDecisionV2,
	parseLaunchIntentV2,
	hasAllocationIntentSourceBinding,
	hasValidV2StateDependencies,
	parseLaunchRecord,
	publishImmutableJson,
	publishCompletionRecordV2,
	readBrokerArtifact,
	readBrokerJson,
	parseParentLease,
	parseLinuxProcessIdentity,
	parseDarwinProcessIdentity,
	parseRunState,
	prepareRunArtifactPaths,
	readJsonFile,
	removeRunArtifacts,
	startParentLeaseWriter,
	STATE_ROOT_MARKER_NAME,
	RUN_DIRECTORY_MARKER_NAME,
} from "../../src/runtime/run-protocol";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("run protocol", () => {
	test("creates private state and run directories without allowing path traversal", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-protocol-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "run-1" });

		assert.equal((await fs.promises.stat(paths.rootDir)).mode & 0o777, 0o700);
		assert.equal((await fs.promises.stat(paths.runDir)).mode & 0o777, 0o700);
		assert.equal((await fs.promises.stat(paths.shellHomePath)).mode & 0o777, 0o700);
		assert.equal((await fs.promises.stat(paths.rootMarkerPath)).mode & 0o777, 0o600);
		assert.equal((await fs.promises.stat(paths.runMarkerPath)).mode & 0o777, 0o600);
		assert.deepEqual(await readJsonFile(paths.rootMarkerPath), { version: 1, kind: "pi-subagent-state-root" });
		assert.deepEqual(await readJsonFile(paths.runMarkerPath), { version: 1, kind: "pi-subagent-run-directory", runId: "run-1" });
		assert.equal(await isPrivateOwnedDirectory(paths.rootDir), true);
		assert.equal(await isPrivateOwnedDirectory(paths.runDir), true);
		assert.equal(await isPrivateOwnedDirectory(paths.shellHomePath), true);
		assert.deepEqual(await fs.promises.readdir(paths.shellHomePath), []);
		await assert.rejects(() => prepareRunArtifactPaths({ rootDir: root, runId: "../escape" }), /Invalid subagent run id/);
	});

	test("rejects malformed or non-private ownership markers", async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-protocol-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "marked-run" });
		await fs.promises.chmod(paths.rootMarkerPath, 0o644);
		await assert.rejects(() => assertSafeStateRoot(root), /ownership marker/);
		await fs.promises.chmod(paths.rootMarkerPath, 0o600);
		await fs.promises.writeFile(paths.runMarkerPath, `${JSON.stringify({ version: 1, kind: "pi-subagent-run-directory", runId: "other" })}\n`, { mode: 0o600 });
		await assert.rejects(() => assertSafeRunArtifactPaths(paths), /ownership marker/);
	});

	test("rejects a populated marker-less state root without migrating or modifying it", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-protocol-"));
		tempDirs.push(root);
		await fs.promises.writeFile(path.join(root, "legacy.json"), "legacy", { mode: 0o600 });
		await assert.rejects(() => prepareRunArtifactPaths({ rootDir: root, runId: "new-run" }), /ownership marker is missing from nonempty root/);
		assert.equal(fs.existsSync(path.join(root, STATE_ROOT_MARKER_NAME)), false);
		assert.equal(fs.existsSync(path.join(root, "legacy.json")), true);
	});

	test("rejects unsafe existing ancestors without creating or chmodding a root", async () => {
		if (process.platform === "win32") return;
		const container = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-protocol-"));
		tempDirs.push(container);
		const renameable = path.join(container, "renameable");
		const absentRoot = path.join(renameable, "state");
		await fs.promises.mkdir(renameable, { mode: 0o700 });
		await fs.promises.chmod(renameable, 0o770);
		const before = (await fs.promises.stat(renameable)).mode & 0o777;
		await assert.rejects(() => prepareRunArtifactPaths({ rootDir: absentRoot, runId: "run" }), /group\/other writable/);
		assert.equal(fs.existsSync(absentRoot), false);
		assert.equal((await fs.promises.stat(renameable)).mode & 0o777, before);
		const actual = path.join(container, "actual"); const linked = path.join(container, "linked");
		await fs.promises.mkdir(actual, { mode: 0o700 }); await fs.promises.symlink(actual, linked);
		await assert.rejects(() => prepareRunArtifactPaths({ rootDir: linked, runId: "run" }), /must not be a symlink/);
	});

	test("atomically writes private JSON and validates run-bound records", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-protocol-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "run-json" });
		const state = {
			version: RUN_PROTOCOL_VERSION,
			runId: "run-json",
			sequence: 2,
			phase: "running",
			updatedAt: 123,
		};
		await atomicWriteJson(paths.statePath, state);

		assert.equal((await fs.promises.stat(paths.statePath)).mode & 0o777, 0o600);
		assert.deepEqual(parseRunState(await readJsonFile(paths.statePath), "run-json"), state);
		assert.equal(parseRunState(state, "other-run"), null);
		assert.deepEqual((await fs.promises.readdir(paths.runDir)).sort(), [RUN_DIRECTORY_MARKER_NAME, "shell-home", "state.json"]);
	});

	test("validates cmux and tmux launch records", () => {
		const common = {
			version: RUN_PROTOCOL_VERSION,
			runId: "run",
			parentSessionId: "parent",
			ownership: "parent-owned",
			childSessionFile: "/tmp/run/session.jsonl",
			createdAt: 1,
		};
		assert.equal(parseLaunchRecord({
			...common,
			terminalMode: "cmux-pane",
			cmuxWorkspaceId: "workspace",
			cmuxSurfaceId: "surface",
		}, "run")?.terminalMode, "cmux-pane");
		assert.equal(parseLaunchRecord({
			...common,
			terminalMode: "tmux-pane",
			tmuxPaneId: "%12",
			tmuxSocketPath: "/tmp/tmux/default",
			tmuxServerPid: 123,
			tmuxPanePid: 456,
		}, "run")?.terminalMode, "tmux-pane");
		assert.equal(parseLaunchRecord({ ...common, terminalMode: "tmux-pane", tmuxPaneId: "bad" }, "run"), null);
	});

	test("publishes V2 authority no-replace and rejects refs, unknown fields, and cross-run paths", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-protocol-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v2" });
		const intent = {
			version: 2, runId: "v2", parentSessionId: "parent", parentPid: process.pid, parentStartedAt: 1, terminalMode: "cmux-pane",
			source: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" },
			childSessionFile: paths.childSessionPath, createdAt: 1,
			brokerNonce: "a".repeat(43), runtimePath: process.execPath, runtimeInterpreterPath: process.execPath, backendPath: process.execPath, brokerEntrypoint: process.execPath,
		};
		assert.equal(parseLaunchIntentV2(intent, "v2", paths.runDir)?.terminalMode, "cmux-pane");
		assert.equal(parseLaunchIntentV2({ ...intent, parentPid: undefined }, "v2", paths.runDir), null);
		assert.equal(parseLaunchIntentV2({ ...intent, source: { workspaceId: "workspace:1", sourceSurfaceId: intent.source.sourceSurfaceId } }, "v2", paths.runDir), null);
		assert.equal(parseLaunchIntentV2({ ...intent, unexpected: true }, "v2", paths.runDir), null);
		assert.equal(await publishImmutableJson(paths.launchIntentPath, intent), "published");
		assert.equal(await publishImmutableJson(paths.launchIntentPath, { ...intent, createdAt: 2 }), "exists");
		assert.deepEqual(await readBrokerJson(paths.launchIntentPath), intent);
		assert.deepEqual(await readBrokerArtifact(paths.allocationPath), { outcome: "missing" });
		await fs.promises.writeFile(paths.allocationPath, "{bad}\n", { mode: 0o600 });
		assert.deepEqual(await readBrokerArtifact(paths.allocationPath), { outcome: "invalid" });
		assert.equal(parseDecisionV2({ version: 2, runId: "v2", kind: "commit", decidedAt: 1, allocationPath: paths.allocationPath, launchPath: paths.launchPath }, "v2", paths.runDir)?.kind, "commit");
		assert.equal(parseAllocationRecordV2({ version: 2, runId: "v2", terminalMode: "tmux-pane", target: { paneId: "%01", serverPid: 1, panePid: 2 }, allocatedAt: 1 }, "v2"), null);
	});

	test("binds allocation source authority to its immutable intent", () => {
		const cmuxIntent = {
			version: 2 as const, runId: "r", parentSessionId: "p", parentPid: 1, parentStartedAt: 1, terminalMode: "cmux-pane" as const,
			source: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" },
			childSessionFile: "/tmp/r/child-session.jsonl", createdAt: 1, brokerNonce: "a".repeat(43), runtimePath: "/usr/bin/node", runtimeInterpreterPath: "/usr/bin/node", backendPath: "/usr/bin/cmux", brokerEntrypoint: "/usr/bin/broker",
		};
		const cmuxAllocation = { version: 2 as const, runId: "r", terminalMode: "cmux-pane" as const, target: { workspaceId: cmuxIntent.source.workspaceId, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1 };
		assert.equal(hasAllocationIntentSourceBinding(cmuxIntent, cmuxAllocation), true);
		assert.equal(hasAllocationIntentSourceBinding(cmuxIntent, { ...cmuxAllocation, target: { ...cmuxAllocation.target, workspaceId: cmuxIntent.source.workspaceId.toUpperCase() } }), true);
		assert.equal(hasAllocationIntentSourceBinding(cmuxIntent, { ...cmuxAllocation, target: { ...cmuxAllocation.target, workspaceId: "123e4567-e89b-12d3-a456-426614174099" } }), false);
		assert.equal(hasAllocationIntentSourceBinding(cmuxIntent, { ...cmuxAllocation, target: { ...cmuxAllocation.target, surfaceId: cmuxIntent.source.sourceSurfaceId.toUpperCase() } }), false);
		const tmuxIntent = { ...cmuxIntent, terminalMode: "tmux-pane" as const, source: { socketPath: "/tmp/tmux", sourcePaneId: "%1", sourcePanePid: 2, serverPid: 3 } };
		const tmuxAllocation = { version: 2 as const, runId: "r", terminalMode: "tmux-pane" as const, target: { socketPath: "/tmp/tmux", serverPid: 3, paneId: "%2", panePid: 4 }, allocatedAt: 1 };
		assert.equal(hasAllocationIntentSourceBinding(tmuxIntent, tmuxAllocation), true);
		assert.equal(hasAllocationIntentSourceBinding(tmuxIntent, { ...tmuxAllocation, target: { ...tmuxAllocation.target, paneId: tmuxIntent.source.sourcePaneId, panePid: tmuxIntent.source.sourcePanePid } }), false);
		assert.equal(hasAllocationIntentSourceBinding(tmuxIntent, { ...tmuxAllocation, target: { ...tmuxAllocation.target, paneId: tmuxIntent.source.sourcePaneId, panePid: 99 } }), false);
		assert.equal(hasAllocationIntentSourceBinding(tmuxIntent, { ...tmuxAllocation, target: { ...tmuxAllocation.target, serverPid: 5 } }), false);
	});

	test("strictly parses every layout-aware V2 placement and preserves exact legacy split records", () => {
		const cmuxSource = { workspaceId: "123e4567-e89b-12d3-a456-426614174000", sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" };
		const cmuxBase = {
			version: 2, runId: "layout", parentSessionId: "p", parentPid: 1, parentStartedAt: 1, terminalMode: "cmux-pane",
			source: cmuxSource, childSessionFile: "/tmp/layout/child-session.jsonl", createdAt: 1, brokerNonce: "a".repeat(43),
			runtimePath: "/usr/bin/node", runtimeInterpreterPath: "/usr/bin/node", backendPath: "/usr/bin/cmux", brokerEntrypoint: "/usr/bin/broker",
		};
		const cmuxTarget = { workspaceId: cmuxSource.workspaceId, surfaceId: "123e4567-e89b-12d3-a456-426614174002", paneId: "123e4567-e89b-12d3-a456-426614174003" };
		const cmuxAllocation = (layout: "auto" | "split", placement: "cmux-split" | "cmux-new-surface") => ({
			version: 2, runId: "layout", terminalMode: "cmux-pane", layout, placement,
			container: { kind: "cmux-pane", workspaceId: cmuxTarget.workspaceId, paneId: cmuxTarget.paneId }, target: cmuxTarget, allocatedAt: 1,
		});
		const tmuxSource = { socketPath: "/tmp/tmux.sock", sourcePaneId: "%1", sourcePanePid: 2, serverPid: 3 };
		const tmuxBase = {
			...cmuxBase, terminalMode: "tmux-pane", source: tmuxSource, backendPath: "/usr/bin/tmux",
		};
		const tmuxTarget = { socketPath: tmuxSource.socketPath, serverPid: tmuxSource.serverPid, paneId: "%2", panePid: 4 };
		const tmuxAllocation = (placement: "tmux-split" | "tmux-new-window", sessionId = "$1", windowId = placement === "tmux-split" ? "@1" : "@2") => ({
			version: 2, runId: "layout", terminalMode: "tmux-pane", layout: placement === "tmux-split" ? "split" : "auto", placement,
			container: { kind: "tmux-window", socketPath: tmuxSource.socketPath, serverPid: tmuxSource.serverPid, sessionId, windowId, paneId: tmuxTarget.paneId, panePid: tmuxTarget.panePid }, target: tmuxTarget, allocatedAt: 1,
		});
		const valid = [
			[{ ...cmuxBase, layout: "auto", placement: "cmux-split", container: { kind: "cmux-source", ...cmuxSource } }, cmuxAllocation("auto", "cmux-split")],
			[{ ...cmuxBase, layout: "split", placement: "cmux-split", container: { kind: "cmux-source", ...cmuxSource } }, cmuxAllocation("split", "cmux-split")],
			[{ ...cmuxBase, layout: "auto", placement: "cmux-new-surface", container: { kind: "cmux-pane", workspaceId: cmuxSource.workspaceId, paneId: cmuxTarget.paneId } }, cmuxAllocation("auto", "cmux-new-surface")],
			[{ ...cmuxBase, layout: "auto", placement: "cmux-new-surface", container: { kind: "cmux-source-pane", ...cmuxSource, paneId: cmuxTarget.paneId } }, cmuxAllocation("auto", "cmux-new-surface")],
			[{ ...tmuxBase, layout: "split", placement: "tmux-split", container: { kind: "tmux-source-pane", socketPath: tmuxSource.socketPath, serverPid: tmuxSource.serverPid, sessionId: "$1", windowId: "@1", paneId: tmuxSource.sourcePaneId, panePid: tmuxSource.sourcePanePid } }, tmuxAllocation("tmux-split")],
			[{ ...tmuxBase, layout: "auto", placement: "tmux-new-window", container: { kind: "tmux-session", socketPath: tmuxSource.socketPath, serverPid: tmuxSource.serverPid, sessionId: "$1", sourceWindowId: "@1" } }, tmuxAllocation("tmux-new-window")],
		] as const;
		for (const [intentRecord, allocationRecord] of valid) {
			const intent = parseLaunchIntentV2(intentRecord, "layout");
			const allocation = parseAllocationRecordV2(allocationRecord, "layout");
			assert.ok(intent, JSON.stringify(intentRecord));
			assert.ok(allocation, JSON.stringify(allocationRecord));
			assert.equal(hasAllocationIntentSourceBinding(intent, allocation), true);
		}

		const legacyIntent = { ...cmuxBase };
		const legacyAllocation = { version: 2, runId: "layout", terminalMode: "cmux-pane", target: cmuxTarget, allocatedAt: 1 };
		assert.deepEqual(parseLaunchIntentV2(legacyIntent, "layout"), legacyIntent);
		assert.deepEqual(parseAllocationRecordV2(legacyAllocation, "layout"), legacyAllocation);
		assert.equal(hasAllocationIntentSourceBinding(parseLaunchIntentV2(legacyIntent, "layout"), parseAllocationRecordV2(legacyAllocation, "layout")), true);
	});

	test("rejects partial, mixed, malformed, and invalid layout V2 authority", () => {
		const base = {
			version: 2, runId: "layout-invalid", parentSessionId: "p", parentPid: 1, parentStartedAt: 1, terminalMode: "cmux-pane",
			source: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" },
			childSessionFile: "/tmp/layout-invalid/child-session.jsonl", createdAt: 1, brokerNonce: "a".repeat(43), runtimePath: "/usr/bin/node", runtimeInterpreterPath: "/usr/bin/node", backendPath: "/usr/bin/cmux", brokerEntrypoint: "/usr/bin/broker",
			layout: "auto", placement: "cmux-split", container: { kind: "cmux-source", workspaceId: "123e4567-e89b-12d3-a456-426614174000", sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" },
		};
		for (const key of ["layout", "placement", "container"] as const) {
			const { [key]: _missing, ...partial } = base;
			assert.equal(parseLaunchIntentV2(partial, "layout-invalid"), null);
		}
		assert.equal(parseLaunchIntentV2({ ...base, unexpected: true }, "layout-invalid"), null);
		assert.equal(parseLaunchIntentV2({ ...base, container: { ...base.container, sourceSurfaceId_ref: base.container.sourceSurfaceId } }, "layout-invalid"), null);
		assert.equal(parseLaunchIntentV2({ ...base, container: { kind: "cmux-source", workspaceId: base.source.workspaceId } }, "layout-invalid"), null);
		assert.equal(parseLaunchIntentV2({ ...base, container: { kind: "cmux-pane", workspaceId: base.source.workspaceId, paneId: "123e4567-e89b-12d3-a456-426614174003" } }, "layout-invalid"), null);
		assert.equal(parseLaunchIntentV2({ ...base, layout: "split", placement: "cmux-new-surface", container: { kind: "cmux-pane", workspaceId: base.source.workspaceId, paneId: "123e4567-e89b-12d3-a456-426614174003" } }, "layout-invalid"), null);
		assert.equal(parseLaunchIntentV2({ ...base, placement: "tmux-new-window", container: { kind: "tmux-session", socketPath: "/tmp/tmux", serverPid: 1, sessionId: "$1" } }, "layout-invalid"), null);
		assert.equal(parseLaunchIntentV2({ ...base, container: { ...base.container, workspaceId: "not-a-uuid" } }, "layout-invalid"), null);

		const allocation = {
			version: 2, runId: "layout-invalid", terminalMode: "tmux-pane", layout: "auto", placement: "tmux-new-window",
			container: { kind: "tmux-window", socketPath: "/tmp/tmux", serverPid: 3, sessionId: "$1", windowId: "@2", paneId: "%2", panePid: 4 },
			target: { socketPath: "/tmp/tmux", serverPid: 3, paneId: "%2", panePid: 4 }, allocatedAt: 1,
		};
		for (const key of ["layout", "placement", "container"] as const) {
			const { [key]: _missing, ...partial } = allocation;
			assert.equal(parseAllocationRecordV2(partial, "layout-invalid"), null);
		}
		assert.equal(parseAllocationRecordV2({ ...allocation, extra: true }, "layout-invalid"), null);
		assert.equal(parseAllocationRecordV2({ ...allocation, container: { ...allocation.container, windowId_ref: "@2" } }, "layout-invalid"), null);
		assert.equal(parseAllocationRecordV2({ ...allocation, container: { kind: "tmux-window", socketPath: "/tmp/tmux", serverPid: 3, sessionId: "$1" } }, "layout-invalid"), null);
		assert.equal(parseAllocationRecordV2({ ...allocation, container: { ...allocation.container, panePid: 5 } }, "layout-invalid"), null);
		assert.equal(parseAllocationRecordV2({ ...allocation, layout: "split" }, "layout-invalid"), null);
		assert.equal(parseAllocationRecordV2({ ...allocation, target: { ...allocation.target, paneId: "%01" } }, "layout-invalid"), null);
		assert.equal(parseAllocationRecordV2({ ...allocation, container: { ...allocation.container, sessionId: "$01" } }, "layout-invalid"), null);
		assert.equal(parseAllocationRecordV2({ ...allocation, container: { ...allocation.container, serverPid: 0 } }, "layout-invalid"), null);
	});

	test("binds layout V2 containers to exact source and allocated targets", () => {
		const intent = {
			version: 2, runId: "binding", parentSessionId: "p", parentPid: 1, parentStartedAt: 1, terminalMode: "tmux-pane",
			source: { socketPath: "/tmp/tmux", sourcePaneId: "%1", sourcePanePid: 2, serverPid: 3 }, childSessionFile: "/tmp/binding/child-session.jsonl", createdAt: 1, brokerNonce: "a".repeat(43), runtimePath: "/usr/bin/node", runtimeInterpreterPath: "/usr/bin/node", backendPath: "/usr/bin/tmux", brokerEntrypoint: "/usr/bin/broker",
			layout: "auto", placement: "tmux-new-window", container: { kind: "tmux-session", socketPath: "/tmp/tmux", serverPid: 3, sessionId: "$1", sourceWindowId: "@1" },
		};
		const allocation = {
			version: 2, runId: "binding", terminalMode: "tmux-pane", layout: "auto", placement: "tmux-new-window",
			container: { kind: "tmux-window", socketPath: "/tmp/tmux", serverPid: 3, sessionId: "$1", windowId: "@2", paneId: "%2", panePid: 4 }, target: { socketPath: "/tmp/tmux", serverPid: 3, paneId: "%2", panePid: 4 }, allocatedAt: 1,
		};
		const parsedIntent = parseLaunchIntentV2(intent, "binding");
		const parsedAllocation = parseAllocationRecordV2(allocation, "binding");
		assert.equal(hasAllocationIntentSourceBinding(parsedIntent, parsedAllocation), true);
		assert.equal(hasAllocationIntentSourceBinding(parsedIntent, parseAllocationRecordV2({ ...allocation, container: { ...allocation.container, windowId: "@1" } }, "binding")), false);
		assert.equal(hasAllocationIntentSourceBinding(parsedIntent, parseAllocationRecordV2({ ...allocation, container: { ...allocation.container, sessionId: "$2" } }, "binding")), false);
		assert.equal(hasAllocationIntentSourceBinding(parsedIntent, parseAllocationRecordV2({ ...allocation, container: { ...allocation.container, panePid: 5 } }, "binding")), false);
		assert.equal(hasAllocationIntentSourceBinding(parsedIntent, parseAllocationRecordV2({ ...allocation, target: { ...allocation.target, paneId: "%1", panePid: 2 } }, "binding")), false);
		const legacyAllocation = { version: 2, runId: "binding", terminalMode: "tmux-pane", target: allocation.target, allocatedAt: 1 };
		assert.equal(hasAllocationIntentSourceBinding(parsedIntent, parseAllocationRecordV2(legacyAllocation, "binding")), false);
		const { layout: _layout, placement: _placement, container: _container, ...legacyIntent } = intent;
		assert.equal(hasAllocationIntentSourceBinding(parseLaunchIntentV2(legacyIntent, "binding"), parsedAllocation), false);

		const cmuxIntent = {
			...intent, terminalMode: "cmux-pane", source: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" }, backendPath: "/usr/bin/cmux",
			layout: "auto", placement: "cmux-new-surface", container: { kind: "cmux-pane", workspaceId: "123e4567-e89b-12d3-a456-426614174000", paneId: "123e4567-e89b-12d3-a456-426614174003" },
		};
		const cmuxAllocation = {
			version: 2, runId: "binding", terminalMode: "cmux-pane", layout: "auto", placement: "cmux-new-surface",
			container: { kind: "cmux-pane", workspaceId: "123e4567-e89b-12d3-a456-426614174000", paneId: "123e4567-e89b-12d3-a456-426614174003" },
			target: { workspaceId: "123e4567-e89b-12d3-a456-426614174000", surfaceId: "123e4567-e89b-12d3-a456-426614174001", paneId: "123e4567-e89b-12d3-a456-426614174003" }, allocatedAt: 1,
		};
		assert.equal(hasAllocationIntentSourceBinding(parseLaunchIntentV2(cmuxIntent, "binding"), parseAllocationRecordV2(cmuxAllocation, "binding")), false);
	});

	test("enforces V2 allocation, commit, launch, and gate dependency matrix", () => {
		const allocation = { version: 2 as const, runId: "r", terminalMode: "tmux-pane" as const, target: { paneId: "%1", serverPid: 1, panePid: 2 }, allocatedAt: 1 };
		const commit = { version: 2 as const, runId: "r", kind: "commit" as const, decidedAt: 1, allocationPath: "/tmp/r/allocation.json", launchPath: "/tmp/r/launch.json" };
		const cancel = { version: 2 as const, runId: "r", kind: "cancel" as const, decidedAt: 1, reason: "parent-abort" as const };
		const launch = { version: 2 as const, runId: "r", terminalMode: "tmux-pane" as const, allocationPath: "/tmp/r/allocation.json", childSessionFile: "/tmp/r/child-session.jsonl", committedAt: 1, ownership: "parent-owned" as const };
		const gate = { version: 2 as const, runId: "r", terminalMode: "tmux-pane" as const, launchPath: "/tmp/r/launch.json", publishedAt: 1 };
		for (const [state, valid] of [
			[{ allocation: null, decision: commit, launch: null, gate: null }, false],
			[{ allocation, decision: null, launch, gate: null }, false],
			[{ allocation, decision: commit, launch, gate: null }, true],
			[{ allocation, decision: commit, launch, gate }, true],
			[{ allocation, decision: cancel, launch: null, gate: null }, true],
			[{ allocation, decision: cancel, launch, gate: null }, false],
			[{ allocation, decision: cancel, launch: null, gate }, false],
		] as const) assert.equal(hasValidV2StateDependencies(state), valid);
		const cmuxLaunch = { ...launch, terminalMode: "cmux-pane" as const };
		const cmuxGate = { ...gate, terminalMode: "cmux-pane" as const };
		assert.equal(hasValidV2StateDependencies({ allocation, decision: commit, launch: cmuxLaunch, gate: null }), false);
		assert.equal(hasValidV2StateDependencies({ allocation, decision: commit, launch, gate: cmuxGate }), false);
	});

	test("accepts the first valid V2 completion winner under concurrent publication", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-protocol-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "completion-race" });
		const winners = await Promise.all([
			publishCompletionRecordV2(paths.completionPath, { version: 2, runId: "completion-race", status: "completed", completedAt: 1 }),
			publishCompletionRecordV2(paths.completionPath, { version: 2, runId: "completion-race", status: "orphaned", completedAt: 2, errorCode: "lease-expired" }),
		]);
		assert.equal(winners[0]?.status, winners[1]?.status);
		assert.equal(parseCompletionRecordV2(await readBrokerJson(paths.completionPath), "completion-race")?.status, winners[0]?.status);
		await fs.promises.writeFile(paths.completionPath, "{bad}\n", { mode: 0o600 });
		await assert.rejects(() => publishCompletionRecordV2(paths.completionPath, { version: 2, runId: "completion-race", status: "failed", completedAt: 3, errorCode: "child-error" }));
	});

	test("rejects malformed completion and lease records", () => {
		assert.equal(parseCompletionRecord({ version: 1, runId: "r", status: "completed", completedAt: 1, childSessionFile: "relative" }, "r"), null);
		assert.equal(parseParentLease({ version: 1, runId: "r", parentPid: 0, parentStartedAt: 1, renewedAt: 1 }, "r"), null);
		assert.equal(parseParentLease({ version: 1, runId: "r", parentPid: 1, parentStartedAt: 1, renewedAt: 20_000 }, "r", 10_000), null);
	});

	test("accepts only known runnable, sleeping, or stopped Linux and Darwin identities", () => {
		const linux = (state: string) => `123 (worker name) ${[state, ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "4242"].join(" ")}`;
		for (const state of ["R", "S", "D", "I", "T", "t"]) {
			assert.deepEqual(parseLinuxProcessIdentity(linux(state)), { startedAt: 4242, isZombie: false });
		}
		for (const state of ["Z", "X", "x", "W", "?", "RR"]) assert.equal(parseLinuxProcessIdentity(linux(state)), null);
		assert.equal(parseLinuxProcessIdentity("123 (worker) S 1"), null);
		assert.equal(parseLinuxProcessIdentity(linux("S").replace("4242", "42.42")), null);

		const darwinStartedAt = Date.parse("Mon Jan 02 03:04:05 2006");
		for (const stat of ["R", "Ss+", "D", "I", "T", "U<"]) {
			assert.deepEqual(parseDarwinProcessIdentity(`${stat}   Mon Jan 02 03:04:05 2006`), { startedAt: darwinStartedAt, isZombie: false });
		}
		for (const stat of ["Z+", "X", "x", "W", "?", "S!"]) assert.equal(parseDarwinProcessIdentity(`${stat}   Mon Jan 02 03:04:05 2006`), null);
		assert.equal(parseDarwinProcessIdentity("Ss Mon Jan 02 03:04 2006"), null);
		assert.equal(parseDarwinProcessIdentity("not-a-process"), null);
		assert.equal(isMatchingLiveProcessIdentity({ startedAt: 4242, isZombie: true }, 4242), false);
		assert.equal(isMatchingLiveProcessIdentity({ startedAt: 4242, isZombie: false }, 4242), true);
		assert.equal(isMatchingLiveProcessIdentity({ startedAt: 4242, isZombie: false }, 4243), false);
	});

	test("rejects future-forged or dead parent lease authority", () => {
		const lease = { version: 1 as const, runId: "r", parentPid: 42, parentStartedAt: 7, renewedAt: 20_000 };
		assert.equal(isParentLeaseStale(lease, 10_000, 12_000), true);
		assert.equal(isUsableParentLease({ lease: { ...lease, renewedAt: 10_000 }, now: 10_000, isProcessIdentityAlive: () => false }), false);
		assert.equal(isUsableParentLease({ lease: { ...lease, renewedAt: 10_000 }, now: 10_000, parentPid: 43, parentStartedAt: 7, isProcessIdentityAlive: () => true }), false);
	});

	test("renews a parent lease and detects staleness", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-protocol-"));
		tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "run-lease" });
		let now = 10_000;
		const writer = startParentLeaseWriter({
			filePath: paths.parentLeasePath,
			runId: "run-lease",
			intervalMs: 60_000,
			parentPid: 42,
			parentStartedAt: 500,
			now: () => now,
		});
		await writer.renew();
		writer.stop();

		const lease = parseParentLease(await readJsonFile(paths.parentLeasePath), "run-lease");
		assert.ok(lease);
		assert.equal(lease.parentStartedAt, 500);
		assert.equal(isParentLeaseStale(lease, 21_999, 12_000), false);
		assert.equal(isParentLeaseStale(lease, 22_001, 12_000), true);
	});

	test("removes only the selected run directory", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-protocol-"));
		tempDirs.push(root);
		const first = await prepareRunArtifactPaths({ rootDir: root, runId: "first" });
		const second = await prepareRunArtifactPaths({ rootDir: root, runId: "second" });
		await removeRunArtifacts(first);
		assert.equal(fs.existsSync(first.runDir), false);
		assert.equal(fs.existsSync(second.runDir), true);
		await removeRunArtifacts(second);
		assert.equal(fs.existsSync(root), true);
	});
});
