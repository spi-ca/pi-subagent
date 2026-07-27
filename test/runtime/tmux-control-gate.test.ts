import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getProcessStartedAt, prepareRunArtifactPaths } from "../../src/runtime/run-protocol";
import {
	TMUX_CONTROL_FIXTURE_CONTRACT_ID,
	TMUX_CONTROL_SOURCE_COMMIT,
	TmuxControlVersionError,
	canonicalTmuxProbeBytes,
	createTmuxControlTransportGate,
	isTmuxControlTransportGateCurrent,
	parseTmuxControlProbe,
	parseTmuxControlTransportGate,
	publishTmuxControlTransportGate,
} from "../../src/runtime/tmux-control-gate";

const roots: string[] = []; const servers: net.Server[] = [];
afterEach(async () => { while (servers.length) await new Promise<void>((resolve) => servers.pop()!.close(() => resolve())); while (roots.length) await fs.promises.rm(roots.pop()!, { recursive: true, force: true }); });

async function socketFixture() {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-gate-")); roots.push(root); await fs.promises.chmod(root, 0o700);
	const socketPath = path.join(root, "tmux.sock"), server = net.createServer(); servers.push(server);
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
	return { root, socketPath };
}

describe("tmux control transport gate", () => {
	test("accepts stable tmux 3.7a and higher while strictly parsing, sorting, and hashing the read-only probe", () => {
		const probe = parseTmuxControlProbe("tmux 3.7a\n", "42|$1|%2|99\n", "$2|%5|100\n$1|%2|99\n");
		assert.ok(probe);
		assert.equal(probe.detectedTmuxVersion, "3.7a");
		assert.ok(parseTmuxControlProbe("tmux 3.7b\n", "42|$1|%2|99\n", "$1|%2|99\n"));
		assert.ok(parseTmuxControlProbe("tmux 3.8\n", "42|$1|%2|99\n", "$1|%2|99\n"));
		assert.ok(parseTmuxControlProbe("tmux 4.0\n", "42|$1|%2|99\n", "$1|%2|99\n"));
		assert.deepEqual(probe.paneRows, [{ sessionId: "$1", paneId: "%2", panePid: 99 }, { sessionId: "$2", paneId: "%5", panePid: 100 }]);
		assert.equal(canonicalTmuxProbeBytes(probe).at(-1), 0x0a);
		for (const malformed of [
			["tmux 3.7\n", "42|$1|%2|99\n", "$1|%2|99\n"],
			["tmux 3.6z\n", "42|$1|%2|99\n", "$1|%2|99\n"],
			["tmux 3.8-rc1\n", "42|$1|%2|99\n", "$1|%2|99\n"],
			["tmux garbage\n", "42|$1|%2|99\n", "$1|%2|99\n"],
			["tmux 3.7b\n", "42|$1|%2|99\r\n", "$1|%2|99\n"],
			["tmux 3.7b\n", "42|$1|%2|99\n", "$1|%2|99\n$1|%2|99\n"],
			["tmux 3.7b\n", "42|$1|%2|99\n", "$1|%3|99\n"],
		]) assert.equal(parseTmuxControlProbe(...malformed as [string, string, string]), null);
	});

	test("classifies below-minimum and malformed version output as a fatal version gate error", async () => {
		const fixture = await socketFixture();
		for (const versionStdout of ["tmux 3.7\n", "tmux 3.6z\n", "tmux 3.8-rc1\n", "garbage\n"]) {
			let calls = 0;
			await assert.rejects(() => createTmuxControlTransportGate({ runId: "version", executable: process.execPath, socketPath: fixture.socketPath, sourcePaneId: "%2", serverStartedAt: getProcessStartedAt(process.pid)!, run: async (args) => { calls += 1; return args[0] === "-V" ? { exitCode: 0, stdout: versionStdout } : args.includes("display-message") ? { exitCode: 0, stdout: `${process.pid}|$1|%2|99\n` } : { exitCode: 0, stdout: "$1|%2|99\n" }; } }), TmuxControlVersionError);
			assert.equal(calls, 3);
		}
	});

	test("constructs and immutably publishes complete generation evidence", async () => {
		const fixture = await socketFixture();
		const paths = await prepareRunArtifactPaths({ rootDir: path.join(fixture.root, "state"), runId: "gate-run" });
		const calls: string[][] = [];
		const serverStartedAt = getProcessStartedAt(process.pid)!;
		const gate = await createTmuxControlTransportGate({ runId: "gate-run", executable: process.execPath, socketPath: fixture.socketPath, sourcePaneId: "%2", serverStartedAt, createdAt: 456, run: async (args) => {
			calls.push(args);
			if (args[0] === "-V") return { exitCode: 0, stdout: "tmux 3.7a\n" };
			if (args.includes("display-message")) return { exitCode: 0, stdout: `${process.pid}|$1|%2|99\n` };
			return { exitCode: 0, stdout: "$1|%2|99\n" };
		} });
		assert.equal(gate.fixtureContractId, TMUX_CONTROL_FIXTURE_CONTRACT_ID);
		assert.equal(gate.probeResult.detectedTmuxVersion, "3.7a");
		assert.equal(gate.pinnedSourceCommit, TMUX_CONTROL_SOURCE_COMMIT);
		assert.equal(gate.probeDigest, crypto.createHash("sha256").update(canonicalTmuxProbeBytes(gate.probeResult)).digest("hex"));
		assert.deepEqual((await publishTmuxControlTransportGate(paths.transportGatePath, gate)).probeResult, gate.probeResult);
		assert.equal(calls.length, 3);
	});

	test("invalidates executable replacement even when inode, size, and mtime are preserved", async () => {
		const fixture = await socketFixture(); const executable = path.join(fixture.root, "tmux");
		await fs.promises.writeFile(executable, "aaaa", { mode: 0o700 }); const before = await fs.promises.stat(executable);
		const gate = await createTmuxControlTransportGate({ runId: "ctime", executable, socketPath: fixture.socketPath, sourcePaneId: "%1", serverStartedAt: getProcessStartedAt(process.pid)!, createdAt: 2, run: async (args) => args[0] === "-V" ? { exitCode: 0, stdout: "tmux 3.7b\n" } : args.includes("display-message") ? { exitCode: 0, stdout: `${process.pid}|$1|%1|8\n` } : { exitCode: 0, stdout: "$1|%1|8\n" } });
		assert.equal(isTmuxControlTransportGateCurrent(gate), true);
		await new Promise((resolve) => setTimeout(resolve, 2)); await fs.promises.writeFile(executable, "bbbb", { mode: 0o700 }); await fs.promises.utimes(executable, before.atime, before.mtime);
		assert.equal(isTmuxControlTransportGateCurrent(gate), false);
	});

	test("rejects extra fields, digest changes, unsorted rows, and cross-run records", async () => {
		const fixture = await socketFixture();
		const gate = await createTmuxControlTransportGate({ runId: "strict", executable: process.execPath, socketPath: fixture.socketPath, sourcePaneId: "%1", serverStartedAt: getProcessStartedAt(process.pid)!, createdAt: 2, run: async (args) => args[0] === "-V" ? { exitCode: 0, stdout: "tmux 3.7b\n" } : args.includes("display-message") ? { exitCode: 0, stdout: `${process.pid}|$1|%1|8\n` } : { exitCode: 0, stdout: "$1|%1|8\n$2|%2|9\n" } });
		assert.ok(parseTmuxControlTransportGate(gate, "strict"));
		const higherProbe = { ...gate.probeResult, detectedTmuxVersion: "3.8" };
		const higherGate = { ...gate, probeResult: higherProbe, probeDigest: crypto.createHash("sha256").update(canonicalTmuxProbeBytes(higherProbe)).digest("hex") };
		assert.equal(parseTmuxControlTransportGate(higherGate, "strict")?.probeResult.detectedTmuxVersion, "3.8");
		for (const detectedTmuxVersion of ["3.7", "3.6z", "3.8-rc1", "garbage"]) {
			const probeResult = { ...gate.probeResult, detectedTmuxVersion };
			assert.equal(parseTmuxControlTransportGate({ ...gate, probeResult, probeDigest: crypto.createHash("sha256").update(canonicalTmuxProbeBytes(probeResult)).digest("hex") }, "strict"), null);
		}
		assert.equal(parseTmuxControlTransportGate({ ...gate, extra: true }, "strict"), null);
		assert.equal(parseTmuxControlTransportGate({ ...gate, probeDigest: "0".repeat(64) }, "strict"), null);
		assert.equal(parseTmuxControlTransportGate({ ...gate, probeResult: { ...gate.probeResult, paneRows: [...gate.probeResult.paneRows].reverse() } }, "strict"), null);
		assert.equal(parseTmuxControlTransportGate(gate, "other"), null);
	});
});
