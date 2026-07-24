import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareRunArtifactPaths, writePrivateFile } from "../../src/runtime/run-protocol";
import {
	exactArtifactDigest,
	hasValidTmuxControlChain,
	parseAllocationRecordV3,
	parseCommittedLaunchRecordV3,
	parseLaunchIntentV3,
} from "../../src/runtime/tmux-control-protocol";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await fs.promises.rm(roots.pop()!, { recursive: true, force: true }); });

describe("tmux control V3 artifact chain", () => {
	test("strictly binds gate, intent, allocation, and committed launch exact bytes", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-v3-")); roots.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "v3-run" });
		await writePrivateFile(paths.transportGatePath, '{"gate":true}\n');
		const gateDigest = await exactArtifactDigest(paths.transportGatePath); assert.ok(gateDigest);
		const generation = { socketPath: "/tmp/tmux.sock", socketDev: "1", socketIno: "2", serverStartedAt: 3 };
		const intent = {
			version: 3 as const, runId: "v3-run", parentSessionId: "parent", parentPid: 10, parentStartedAt: 11,
			terminalMode: "tmux-pane" as const, transport: "tmux-control-v1" as const, transportGatePath: paths.transportGatePath, transportGateDigest: gateDigest,
			source: { socketPath: "/tmp/tmux.sock", sourcePaneId: "%1", sourcePanePid: 12, serverPid: 13, generation },
			layout: "split" as const, placement: "tmux-split" as const, container: { kind: "tmux-source-pane" as const, socketPath: "/tmp/tmux.sock", serverPid: 13, sessionId: "$1", windowId: "@1", paneId: "%1", panePid: 12, generation },
			childSessionFile: paths.childSessionPath, createdAt: 14, brokerNonce: "a".repeat(43), runtimePath: process.execPath, runtimeInterpreterPath: process.execPath, backendPath: process.execPath, brokerEntrypoint: process.execPath,
		};
		assert.ok(parseLaunchIntentV3(intent, "v3-run", paths.runDir));
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		const intentDigest = await exactArtifactDigest(paths.launchIntentPath); assert.ok(intentDigest);
		const allocation = { version: 3 as const, runId: "v3-run", terminalMode: "tmux-pane" as const, transport: "tmux-control-v1" as const, intentDigest, layout: "split" as const, placement: "tmux-split" as const, container: { kind: "tmux-window" as const, socketPath: "/tmp/tmux.sock", serverPid: 13, sessionId: "$1", windowId: "@2", paneId: "%2", panePid: 15, generation }, target: { socketPath: "/tmp/tmux.sock", serverPid: 13, paneId: "%2", panePid: 15, generation }, allocatedAt: 16 };
		assert.ok(parseAllocationRecordV3(allocation, "v3-run"));
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		const allocationDigest = await exactArtifactDigest(paths.allocationPath); assert.ok(allocationDigest);
		const launch = { version: 3 as const, runId: "v3-run", terminalMode: "tmux-pane" as const, transport: "tmux-control-v1" as const, allocationPath: paths.allocationPath, allocationDigest, childSessionFile: paths.childSessionPath, committedAt: 17, ownership: "parent-owned" as const };
		assert.ok(parseCommittedLaunchRecordV3(launch, "v3-run", paths.runDir));
		await writePrivateFile(paths.launchPath, `${JSON.stringify(launch)}\n`);
		assert.equal(await hasValidTmuxControlChain({ runDir: paths.runDir, intent, allocation, launch }), true);
		await fs.promises.appendFile(paths.transportGatePath, " ");
		assert.equal(await hasValidTmuxControlChain({ runDir: paths.runDir, intent, allocation, launch }), false);
	});

	test("rejects cross-version, extra-field, and malformed transport branches", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-v3-")); roots.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "strict" });
		const base = { version: 3, runId: "strict", terminalMode: "tmux-pane", transport: "tmux-control-v1", allocationPath: paths.allocationPath, allocationDigest: "a".repeat(64), childSessionFile: paths.childSessionPath, committedAt: 1, ownership: "parent-owned" };
		assert.ok(parseCommittedLaunchRecordV3(base, "strict", paths.runDir));
		assert.equal(parseCommittedLaunchRecordV3({ ...base, version: 2 }, "strict", paths.runDir), null);
		assert.equal(parseCommittedLaunchRecordV3({ ...base, extra: true }, "strict", paths.runDir), null);
		assert.equal(parseCommittedLaunchRecordV3({ ...base, allocationPath: "/tmp/other" }, "strict", paths.runDir), null);
	});
});
