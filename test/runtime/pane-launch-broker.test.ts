import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getProcessStartedAt, prepareRunArtifactPaths, readBrokerJson, writePrivateExecutableFile, writePrivateFile } from "../../src/runtime/run-protocol";
import { getCmuxControlRequestManager } from "../../src/runtime/cmux-control-adapter.mjs";
import { fakeCmuxControlServer } from "../helpers/fake-cmux-control-server";
import { acceptanceAllocationCheckpointPath } from "../acceptance/acceptance-allocation-checkpoint";
import { buildTmuxWindowLabel } from "../../src/runtime/tmux-window-label.mjs";
import { cleanupAcceptanceCmuxTarget, terminateStoppedPostallocationBroker } from "../acceptance/live-harness";

const tempDirs: string[] = [];
afterEach(async () => { while (tempDirs.length) await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true }); });

const workspaceId = "123e4567-e89b-12d3-a456-426614174000";
const surfaceId = "123e4567-e89b-12d3-a456-426614174010";
const paneId = "123e4567-e89b-12d3-a456-426614174011";

async function nativeMock(root: string, splitResponse = JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId }), splitExitCode = 0, targetWorkspaceId = workspaceId): Promise<string> {
	const source = path.join(root, "mock.c"), binary = path.join(root, "cmux");
	const preTree = JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: sourcePaneId, surfaces: [{ id: sourceSurfaceId, pane_id: sourcePaneId }] }] }] }] });
	const presentTree = JSON.stringify({ windows: [{ workspaces: [{ id: targetWorkspaceId, panes: [{ id: paneId, surfaces: [{ id: surfaceId, pane_id: paneId }] }] }] }] });
	const absentTree = JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: sourcePaneId, surfaces: [{ id: sourceSurfaceId, pane_id: sourcePaneId }] }] }] }] });
	await fs.promises.writeFile(source, `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
int main(int n,char**v){int split=0,tree=0,close=0,allocated=0;for(int i=1;i<n;i++){if(!strcmp(v[i],"new-split"))split=1;if(!strcmp(v[i],"tree"))tree=1;if(!strcmp(v[i],"close-surface"))close=1;}const char*l=getenv("CMUX_SOCKET_PATH");if(l){FILE*f=fopen(l,"a");if(f){extern char**environ;fprintf(f,"node=%s bun=%s\\n",getenv("NODE_OPTIONS")?:"",getenv("BUN_OPTIONS")?:"");for(char**e=environ;*e;e++)fprintf(f,"env=%s\\n",*e);for(int i=1;i<n;i++)fprintf(f,"%s ",v[i]);fprintf(f,"\\n");fclose(f);}if(tree){FILE*r=fopen(l,"r");char b[256];while(r&&fgets(b,sizeof b,r)){if(strstr(b,"close-surface"))close=1;if(strstr(b,"new-split"))allocated=1;}if(r)fclose(r);}}if(split){sleep(1);puts(${JSON.stringify(splitResponse)});return ${splitExitCode};}else if(tree)puts(close?${JSON.stringify(absentTree)}:(allocated?${JSON.stringify(presentTree)}:${JSON.stringify(preTree)}));return 0;}`);
	assert.equal(spawnSync("/usr/bin/cc", [source, "-o", binary]).status, 0);
	await fs.promises.chmod(binary, 0o700);
	return binary;
}

const sourceSurfaceId = "123e4567-e89b-12d3-a456-426614174001";
const sourcePaneId = "123e4567-e89b-12d3-a456-426614174002";
const allocatedPaneId = "123e4567-e89b-12d3-a456-426614174012";

async function nativeCmuxLayoutMock(root: string, log: string, options: { split?: string; surface?: string; tree?: string; splitCode?: number; surfaceCode?: number } = {}): Promise<string> {
	const source = path.join(root, "mock-layout.c"), binary = path.join(root, "cmux-layout");
	const tree = options.tree ?? JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [
		{ id: sourcePaneId, surfaces: [{ id: sourceSurfaceId, pane_id: sourcePaneId }] }, { id: paneId, surfaces: [] },
	] }] }] });
	const split = options.split ?? JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: allocatedPaneId });
	const surface = options.surface ?? JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId });
	await fs.promises.writeFile(source, `#include <stdio.h>\n#include <string.h>\nint main(int n,char**v){int split=0,surface=0,tree=0;for(int i=1;i<n;i++){split|=!strcmp(v[i],"new-split");surface|=!strcmp(v[i],"new-surface");tree|=!strcmp(v[i],"tree");}FILE*f=fopen(${JSON.stringify(log)},"a");if(f){for(int i=1;i<n;i++)fprintf(f,"%s ",v[i]);fputc('\\n',f);fclose(f);}if(tree){puts(${JSON.stringify(tree)});return 0;}if(split){puts(${JSON.stringify(split)});return ${options.splitCode ?? 0};}if(surface){puts(${JSON.stringify(surface)});return ${options.surfaceCode ?? 0};}return 0;}`);
	assert.equal(spawnSync("/usr/bin/cc", [source, "-o", binary]).status, 0);
	await fs.promises.chmod(binary, 0o700);
	return binary;
}

async function writeIntent(paths: Awaited<ReturnType<typeof prepareRunArtifactPaths>>, runId: string, backend: string): Promise<string[]> {
	const nonce = "a".repeat(43), broker = path.resolve("src/runtime/pane-launch-broker.mjs");
	await writePrivateFile(paths.launchIntentPath, `${JSON.stringify({
		version: 2, runId, parentSessionId: "p", parentPid: process.pid, parentStartedAt: 1, terminalMode: "cmux-pane",
		source: { workspaceId, sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" }, childSessionFile: paths.childSessionPath,
		createdAt: 1, brokerNonce: nonce, runtimePath: fs.realpathSync(process.execPath), runtimeInterpreterPath: fs.realpathSync(process.execPath), backendPath: fs.realpathSync(backend), brokerEntrypoint: fs.realpathSync(broker),
	})}\n`);
	return [broker, "--run-dir", paths.runDir, "--nonce", nonce, "--runtime", fs.realpathSync(process.execPath), "--runtime-interpreter", fs.realpathSync(process.execPath), "--backend", fs.realpathSync(backend)];
}

async function writeTmuxIntent(paths: Awaited<ReturnType<typeof prepareRunArtifactPaths>>, runId: string, backend: string): Promise<string[]> {
	const nonce = "b".repeat(43), broker = path.resolve("src/runtime/pane-launch-broker.mjs");
	const socketPath = path.join(paths.runDir, "tmux.sock");
	await fs.promises.writeFile(socketPath, "fixture", { mode: 0o600 });
	const socket = fs.realpathSync.native(socketPath), stat = fs.statSync(socket, { bigint: true });
	const generation = { socketPath: socket, socketDev: stat.dev.toString(), socketIno: stat.ino.toString(), serverStartedAt: getProcessStartedAt(process.pid)! };
	await writePrivateFile(paths.launchIntentPath, `${JSON.stringify({
		version: 2, runId, parentSessionId: "p", parentPid: process.pid, parentStartedAt: 1, terminalMode: "tmux-pane",
		source: { socketPath: socket, sourcePaneId: "%1", sourcePanePid: 456, serverPid: process.pid, generation }, childSessionFile: paths.childSessionPath,
		createdAt: 1, brokerNonce: nonce, runtimePath: fs.realpathSync(process.execPath), runtimeInterpreterPath: fs.realpathSync(process.execPath), backendPath: fs.realpathSync(backend), brokerEntrypoint: fs.realpathSync(broker),
	})}\n`);
	return [broker, "--run-dir", paths.runDir, "--nonce", nonce, "--runtime", fs.realpathSync(process.execPath), "--runtime-interpreter", fs.realpathSync(process.execPath), "--backend", fs.realpathSync(backend)];
}

async function nativeTmuxMock(root: string, defaultShell: string, log: string, splitResponse = "%2\|789", splitExitCode = 0, topologyResponse = "%1|$1|@2|456", topologyExitCode = 0, paneListResponse = "%1\|456"): Promise<string> {
	const source = path.join(root, "mock-tmux.c"), binary = path.join(root, `tmux-${path.basename(defaultShell).replace(/[^a-z]/gi, "") || "unsafe"}`);
	await fs.promises.writeFile(source, `#include <stdio.h>
#include <string.h>
#include <stdlib.h>
int main(int n,char**v){int show=0,display=0,list=0,split=0,topology=0;for(int i=1;i<n;i++){show|=!strcmp(v[i],"show-options");display|=!strcmp(v[i],"display-message");list|=!strcmp(v[i],"list-panes");split|=!strcmp(v[i],"split-window")||!strcmp(v[i],"new-window");topology|=strstr(v[i],"session_id")!=0;}FILE*f=fopen(${JSON.stringify(log)},"a");if(f){for(int i=1;i<n;i++)fprintf(f,"%s ",v[i]);fputc('\\n',f);fclose(f);}if(split){puts(${JSON.stringify(splitResponse)});return ${splitExitCode};}else if(show)puts(${JSON.stringify(defaultShell)});else if(display){const char*pid=getenv("PI_SUBAGENT_TEST_TMUX_SERVER_PID");puts(pid?pid:"123");}else if(list){puts(topology?${JSON.stringify(topologyResponse)}:${JSON.stringify(paneListResponse)});return topology?${topologyExitCode}:0;}return 0;}`);
	assert.equal(spawnSync("/usr/bin/cc", [source, "-o", binary]).status, 0);
	await fs.promises.chmod(binary, 0o700);
	return binary;
}

async function nativeTmuxGateMock(root: string): Promise<string> {
	const source = path.join(root, "mock-tmux-gate.c"), binary = path.join(root, "tmux-gate");
	await fs.promises.writeFile(source, `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
int main(int n,char**v){int display=0,list=0;for(int i=1;i<n;i++){display|=!strcmp(v[i],"display-message");list|=!strcmp(v[i],"list-panes");}if(display){const char*pid=getenv("PI_SUBAGENT_TEST_TMUX_SERVER_PID");puts(pid?pid:"123");return 0;}if(list){const char*pid=getenv("PI_SUBAGENT_TEST_TMUX_PANE_PID");if(pid)printf("%%2|%s\\n",pid);else printf("%%2|%ld\\n",(long)getppid());return 0;}return 1;}`);
	assert.equal(spawnSync("/usr/bin/cc", [source, "-o", binary]).status, 0);
	await fs.promises.chmod(binary, 0o700);
	return binary;
}

async function publishCommittedTmuxGate(paths: Awaited<ReturnType<typeof prepareRunArtifactPaths>>, runId: string, panePid: number, paneId = "%2") {
	const intent = await readBrokerJson(paths.launchIntentPath) as { source: { socketPath: string; serverPid: number; generation: unknown } };
	await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId, terminalMode: "tmux-pane", target: { socketPath: intent.source.socketPath, serverPid: intent.source.serverPid, paneId, panePid, generation: intent.source.generation }, allocatedAt: 1 })}\n`);
	await writePrivateFile(paths.decisionPath, `${JSON.stringify({ version: 2, runId, kind: "commit", decidedAt: 1, allocationPath: paths.allocationPath, launchPath: paths.launchPath })}\n`);
	await writePrivateFile(paths.launchPath, `${JSON.stringify({ version: 2, runId, terminalMode: "tmux-pane", allocationPath: paths.allocationPath, childSessionFile: paths.childSessionPath, committedAt: 1, ownership: "parent-owned" })}\n`);
	await writePrivateFile(paths.launchGatePath, `${JSON.stringify({ version: 2, runId, terminalMode: "tmux-pane", launchPath: paths.launchPath, publishedAt: 1 })}\n`);
}

function tmuxSourceAuthority(record: Record<string, unknown>) {
	return record.source as { socketPath: string; serverPid: number; generation: unknown };
}
function tmuxSourceContainer(record: Record<string, unknown>) {
	const source = tmuxSourceAuthority(record);
	return { kind: "tmux-source-pane", socketPath: source.socketPath, serverPid: source.serverPid, sessionId: "$1", windowId: "@2", paneId: "%1", panePid: 456, generation: source.generation };
}
function tmuxSessionContainer(record: Record<string, unknown>) {
	const source = tmuxSourceAuthority(record);
	return { kind: "tmux-session", socketPath: source.socketPath, serverPid: source.serverPid, sessionId: "$1", sourceWindowId: "@2", generation: source.generation };
}
function tmuxTarget(record: Record<string, unknown>, paneId = "%2", panePid = 789) {
	const source = tmuxSourceAuthority(record);
	return { socketPath: source.socketPath, serverPid: source.serverPid, paneId, panePid, generation: source.generation };
}
function tmuxWindow(record: Record<string, unknown>, windowId: string) {
	return { kind: "tmux-window", sessionId: "$1", windowId, ...tmuxTarget(record) };
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
	return new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd?: string, command = process.execPath): Promise<number> {
	const fixtureEnv = { ...env, PI_SUBAGENT_TEST_HARNESS: "1", PI_SUBAGENT_TEST_TMUX_GENERATION: "1", PI_SUBAGENT_TEST_TMUX_SERVER_PID: String(process.pid) };
	return new Promise((resolve, reject) => { const child = spawn(command, args, { cwd, env: fixtureEnv, stdio: "ignore" }); child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); });
}

const herdrSource = { workspace_id: "herdr-workspace", tab_id: "herdr-tab", pane_id: "herdr-source", terminal_id: "herdr-source-terminal" };
const herdrChild = { workspace_id: "herdr-workspace", tab_id: "herdr-tab", pane_id: "herdr-child", terminal_id: "herdr-child-terminal" };
type HerdrBrokerMode = "success" | "split-unknown" | "send-unknown" | "split-terminal-reuse" | "source-moved" | `split-${"malformed" | "oversized" | "wrong-id"}` | `send-${"malformed" | "oversized" | "wrong-id"}`;
async function fakeHerdrBrokerServer(root: string, mode: HerdrBrokerMode, protocol = 20) {
	const socketPath = path.join(root, `herdr-${mode}.sock`), calls: string[] = [], requests: Array<{ method: string; params: Record<string, unknown> }> = [];
	let sourceGets = 0;
	const server = net.createServer((socket) => {
		let input = "";
		socket.on("data", (chunk: Buffer) => {
			input += chunk.toString("utf8");
			const newline = input.indexOf("\n");
			if (newline < 0) return;
			const request = JSON.parse(input.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> };
			calls.push(request.method); requests.push({ method: request.method, params: request.params });
			if (request.method === "pane.split" && mode === "split-unknown" || request.method === "pane.send_text" && mode === "send-unknown") { socket.destroy(); return; }
			const failure = request.method === "pane.split" ? mode.slice("split-".length) : request.method === "pane.send_text" ? mode.slice("send-".length) : null;
			if (failure === "malformed") { socket.end("{not-json}\n"); return; }
			if (failure === "oversized") { socket.end("x".repeat(256 * 1024 + 1)); return; }
			if (failure === "wrong-id") { socket.end(`${JSON.stringify({ id: "wrong", result: { type: "ok" } })}\n`); return; }
			const pane = request.method === "pane.get"
				? request.params.pane_id === herdrChild.pane_id ? herdrChild : (++sourceGets === 2 && mode === "source-moved" ? { ...herdrSource, pane_id: "herdr-source-moved" } : herdrSource)
				: request.method === "pane.split" && mode === "split-terminal-reuse" ? { ...herdrChild, terminal_id: herdrSource.terminal_id }
					: herdrChild;
			const result = request.method === "ping" ? { type: "pong", protocol }
				: request.method === "pane.get" || request.method === "pane.split" ? { type: "pane_info", pane }
					: { type: "ok" };
			socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	fs.chmodSync(socketPath, 0o600);
	return { socketPath, calls, requests, close: async () => await new Promise<void>((resolve) => server.close(() => resolve())) };
}
async function writeHerdrIntent(paths: Awaited<ReturnType<typeof prepareRunArtifactPaths>>, runId: string, socketPath: string, protocol = 20): Promise<string[]> {
	const nonce = "h".repeat(43), broker = path.resolve("src/runtime/pane-launch-broker.mjs"), runtime = fs.realpathSync(process.execPath);
	await writePrivateFile(paths.launchIntentPath, `${JSON.stringify({
		version: 2, runId, parentSessionId: "p", parentPid: process.pid, parentStartedAt: 1, terminalMode: "herdr-pane",
		source: { socketPath, workspaceId: herdrSource.workspace_id, tabId: herdrSource.tab_id, sourcePaneId: herdrSource.pane_id, sourceTerminalId: herdrSource.terminal_id, protocol },
		childSessionFile: paths.childSessionPath, createdAt: 1, brokerNonce: nonce, runtimePath: runtime, runtimeInterpreterPath: runtime, backendPath: runtime, brokerEntrypoint: fs.realpathSync(broker),
	})}\n`);
	return [broker, "--run-dir", paths.runDir, "--nonce", nonce, "--runtime", runtime, "--runtime-interpreter", runtime, "--backend", runtime];
}
async function waitForBrokerArtifact(filePath: string): Promise<unknown> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const value = await readBrokerJson(filePath);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path.basename(filePath)}`);
}

async function writeCommittedGate(paths: Awaited<ReturnType<typeof prepareRunArtifactPaths>>, runId: string, backend: string, options: { allocationRunId?: string; allocationMode?: "cmux-pane" | "tmux-pane"; gateMode?: "cmux-pane" | "tmux-pane" } = {}): Promise<string[]> {
	const args = await writeIntent(paths, runId, backend);
	const allocationRunId = options.allocationRunId ?? runId;
	const allocation = options.allocationMode === "tmux-pane"
		? { version: 2, runId: allocationRunId, terminalMode: "tmux-pane", target: { socketPath: "/tmp/tmux.sock", serverPid: 123, paneId: "%2", panePid: 789 }, allocatedAt: 1 }
		: { version: 2, runId: allocationRunId, terminalMode: "cmux-pane", target: { workspaceId, surfaceId, paneId }, allocatedAt: 1 };
	await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
	await writePrivateFile(paths.decisionPath, `${JSON.stringify({ version: 2, runId, kind: "commit", decidedAt: 1, allocationPath: paths.allocationPath, launchPath: paths.launchPath })}\n`);
	await writePrivateFile(paths.launchPath, `${JSON.stringify({ version: 2, runId, terminalMode: "cmux-pane", allocationPath: paths.allocationPath, childSessionFile: paths.childSessionPath, committedAt: 1, ownership: "parent-owned" })}\n`);
	await writePrivateFile(paths.launchGatePath, `${JSON.stringify({ version: 2, runId, terminalMode: options.gateMode ?? "cmux-pane", launchPath: paths.launchPath, publishedAt: 1 })}\n`);
	return args;
}

describe("pane launch broker", () => {
	test("records production Herdr success, split uncertainty, and post-commit send uncertainty separately", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-broker-")); tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const runtime = fs.realpathSync(process.execPath);
		for (const mode of ["success", "split-unknown", "send-unknown"] as const) {
			const server = await fakeHerdrBrokerServer(root, mode);
			try {
				const stateRoot = path.join(root, `state-${mode}`); await fs.promises.mkdir(stateRoot, { mode: 0o700 });
				const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: `herdr-${mode}` });
				const args = await writeHerdrIntent(paths, `herdr-${mode}`, server.socketPath);
				if (mode === "split-unknown") {
					assert.equal(await run(args, process.env, paths.runDir, runtime), 0);
					assert.equal((await readBrokerJson(paths.residualRiskPath) as { reason?: string })?.reason, "possible-unrecorded-allocation");
					assert.equal(await readBrokerJson(paths.allocationPath), null);
					continue;
				}
				const broker = spawn(runtime, args, { cwd: paths.runDir, env: process.env, stdio: "ignore" });
				await waitForBrokerArtifact(paths.launchPath);
				await writePrivateFile(paths.launchGatePath, `${JSON.stringify({ version: 2, runId: `herdr-${mode}`, terminalMode: "herdr-pane", protocol: 20, launchPath: paths.launchPath, publishedAt: 1 })}\n`);
				assert.equal(await waitForExit(broker), 0);
				assert.equal((await readBrokerJson(paths.allocationPath) as { target?: { terminalId?: string } })?.target?.terminalId, herdrChild.terminal_id);
				if (mode === "success") {
					assert.equal(await readBrokerJson(paths.launchDeliveryUnknownPath), null);
					assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string })?.phase, "committed");
				} else {
					assert.equal((await readBrokerJson(paths.launchDeliveryUnknownPath) as { allocationPath?: string })?.allocationPath, paths.allocationPath);
					assert.equal((await readBrokerJson(paths.residualRiskPath)), null, "known allocation delivery uncertainty is not split residual risk");
				}
			} finally { await server.close(); }
		}
	});

	test("records the negotiated protocol 19 and 20 in Herdr allocation and gate authority", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-broker-")); tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const runtime = fs.realpathSync(process.execPath);
		for (const protocol of [19, 20] as const) {
			const server = await fakeHerdrBrokerServer(root, "success", protocol);
			try {
				const stateRoot = path.join(root, `state-protocol-${protocol}`); await fs.promises.mkdir(stateRoot, { mode: 0o700 });
				const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: `herdr-protocol-${protocol}` });
				const broker = spawn(runtime, await writeHerdrIntent(paths, `herdr-protocol-${protocol}`, server.socketPath, protocol), { cwd: paths.runDir, env: process.env, stdio: "ignore" });
				await waitForBrokerArtifact(paths.launchPath);
				await writePrivateFile(paths.launchGatePath, `${JSON.stringify({ version: 2, runId: `herdr-protocol-${protocol}`, terminalMode: "herdr-pane", protocol, launchPath: paths.launchPath, publishedAt: 1 })}\n`);
				assert.equal(await waitForExit(broker), 0);
				assert.equal((await readBrokerJson(paths.allocationPath) as { target?: { protocol?: number } })?.target?.protocol, protocol);
			} finally { await server.close(); }
		}
	});

	test("rejects a broker intent when the live Herdr protocol no longer matches", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-broker-")); tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const server = await fakeHerdrBrokerServer(root, "success", 20);
		try {
			const stateRoot = path.join(root, "state-mismatch"); await fs.promises.mkdir(stateRoot, { mode: 0o700 });
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "herdr-protocol-mismatch" });
			assert.equal(await run(await writeHerdrIntent(paths, "herdr-protocol-mismatch", server.socketPath, 19), process.env, paths.runDir), 0);
			assert.equal(server.calls.includes("pane.split"), false);
			assert.equal(await readBrokerJson(paths.allocationPath), null);
		} finally { await server.close(); }
	});

	test("quarantines malformed, oversized, and wrong-ID Herdr mutation responses without rollback", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-broker-")); tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const runtime = fs.realpathSync(process.execPath);
		for (const operation of ["split", "send"] as const) {
			for (const failure of ["malformed", "oversized", "wrong-id"] as const) {
				const mode: HerdrBrokerMode = `${operation}-${failure}`;
				const server = await fakeHerdrBrokerServer(root, mode);
				try {
					const stateRoot = path.join(root, `state-${mode}`); await fs.promises.mkdir(stateRoot, { mode: 0o700 });
					const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: `herdr-${mode}` });
					const args = await writeHerdrIntent(paths, `herdr-${mode}`, server.socketPath);
					if (operation === "split") {
						assert.equal(await run(args, process.env, paths.runDir, runtime), 0);
						assert.equal((await readBrokerJson(paths.residualRiskPath) as { reason?: string })?.reason, "possible-unrecorded-allocation");
						assert.equal(await readBrokerJson(paths.allocationPath), null);
					} else {
						const broker = spawn(runtime, args, { cwd: paths.runDir, env: process.env, stdio: "ignore" });
						await waitForBrokerArtifact(paths.launchPath);
						await writePrivateFile(paths.launchGatePath, `${JSON.stringify({ version: 2, runId: `herdr-${mode}`, terminalMode: "herdr-pane", protocol: 20, launchPath: paths.launchPath, publishedAt: 1 })}\n`);
						assert.equal(await waitForExit(broker), 0);
						assert.ok(await readBrokerJson(paths.launchDeliveryUnknownPath));
						assert.equal(await readBrokerJson(paths.residualRiskPath), null);
					}
					assert.equal(server.calls.includes("pane.close"), false, `${mode} must not roll back a possibly launched target`);
				} finally { await server.close(); }
			}
		}
	});

	test("binds broker source and allocation authority to terminal identity across pane moves", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-herdr-broker-")); tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const runtime = fs.realpathSync(process.execPath);
		for (const mode of ["split-terminal-reuse", "source-moved"] as const) {
			const server = await fakeHerdrBrokerServer(root, mode);
			try {
				const stateRoot = path.join(root, `state-${mode}`); await fs.promises.mkdir(stateRoot, { mode: 0o700 });
				const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: `herdr-${mode}` });
				const args = await writeHerdrIntent(paths, `herdr-${mode}`, server.socketPath);
				if (mode === "split-terminal-reuse") {
					assert.equal(await run(args, process.env, paths.runDir, runtime), 0);
					assert.ok(await readBrokerJson(paths.residualRiskPath));
					assert.equal(server.calls.includes("pane.close"), false, "a source-terminal alias is never rollback authority");
					continue;
				}
				const broker = spawn(runtime, args, { cwd: paths.runDir, env: process.env, stdio: "ignore" });
				await waitForBrokerArtifact(paths.launchPath);
				await writePrivateFile(paths.launchGatePath, `${JSON.stringify({ version: 2, runId: `herdr-${mode}`, terminalMode: "herdr-pane", protocol: 20, launchPath: paths.launchPath, publishedAt: 1 })}\n`);
				assert.equal(await waitForExit(broker), 0);
				assert.equal(server.requests.find((request) => request.method === "pane.split")?.params.target_pane_id, "herdr-source-moved");
				assert.equal((await readBrokerJson(paths.allocationPath) as { target?: { terminalId?: string } })?.target?.terminalId, herdrChild.terminal_id);
			} finally { await server.close(); }
		}
	});

	test("uses production control-v2 in a detached broker without invoking a cmux CLI", async () => {
		if (process.platform !== "darwin") return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-control-")); tempDirs.push(root); await fs.promises.chmod(root, 0o700);
		const socket = path.join(root, "cmux.sock");
		const appBundle = path.join(root, "cmux.app");
		await fs.promises.mkdir(path.join(appBundle, "Contents"), { recursive: true, mode: 0o755 });
		await fs.promises.writeFile(path.join(appBundle, "Contents", "Info.plist"), "<plist><dict><key>CFBundleShortVersionString</key><string>0.64.20</string></dict></plist>\n", { mode: 0o600 });
		const identify = { app_bundle_path: await fs.promises.realpath(appBundle), app_version: "0.64.20", boot_id: "broker-fixture" };
		const methods = ["system.tree", "surface.split", "surface.create", "surface.respawn", "surface.send_key", "surface.close", "tab.action"];
		const fake = await fakeCmuxControlServer(socket, (request, server) => {
			const result = request.method === "system.capabilities"
				? { version: 2, protocol: "cmux-socket", access_mode: "automation", methods }
				: request.method === "system.identify" ? identify
					: request.method === "system.tree"
						? { windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: sourcePaneId, surfaces: [{ id: sourceSurfaceId, pane_id: sourcePaneId }] }] }] }] }
						: request.method === "surface.split" ? { workspace_id: workspaceId, pane_id: allocatedPaneId, surface_id: surfaceId } : {};
			server.send(request.socket, { id: request.id, ok: true, result });
		});
		try {
			const stateRoot = path.join(root, "state"); await fs.promises.mkdir(stateRoot, { mode: 0o700 });
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "control-v2-broker" });
			const canonicalSocket = path.join(await fs.promises.realpath(path.dirname(socket)), path.basename(socket)), socketStat = await fs.promises.lstat(canonicalSocket, { bigint: true });
			const control = { transport: "cmux-control-v2", socketPath: canonicalSocket, socketDev: socketStat.dev.toString(), socketIno: socketStat.ino.toString(), accessMode: "automation", apiVersion: 2, appVersion: "0.64.20", identifyDigest: crypto.createHash("sha256").update(JSON.stringify(identify, Object.keys(identify).sort())).digest("hex"), bootIdentity: identify.boot_id };
			const probe = getCmuxControlRequestManager({ broker: true, env: { CMUX_SOCKET_PATH: socket } });
			const probeHandshake = await probe.ensureReady();
			assert.deepEqual({ transport: "cmux-control-v2", socketPath: probe.identity()?.socketPath, socketDev: probe.identity()?.socketDev, socketIno: probe.identity()?.socketIno, accessMode: probeHandshake.access_mode, apiVersion: probeHandshake.version, appVersion: probeHandshake.detectedAppVersion, identifyDigest: crypto.createHash("sha256").update(JSON.stringify(probeHandshake.identify, Object.keys(probeHandshake.identify).sort())).digest("hex"), bootIdentity: probeHandshake.identify.boot_id }, control);
			probe.close();
			const nonce = "c".repeat(43), broker = path.resolve("src/runtime/pane-launch-broker.mjs"), runtime = fs.realpathSync(process.execPath);
			await writePrivateFile(paths.launchIntentPath, `${JSON.stringify({ version: 2, runId: "control-v2-broker", parentSessionId: "p", parentPid: process.pid, parentStartedAt: 1, terminalMode: "cmux-pane", source: { workspaceId, sourceSurfaceId }, layout: "split", placement: "cmux-split", container: { kind: "cmux-source", workspaceId, sourceSurfaceId }, control, childSessionFile: paths.childSessionPath, createdAt: 1, brokerNonce: nonce, runtimePath: runtime, runtimeInterpreterPath: runtime, backendPath: runtime, brokerEntrypoint: fs.realpathSync(broker) })}\n`);
			const args = [broker, "--run-dir", paths.runDir, "--nonce", nonce, "--runtime", runtime, "--runtime-interpreter", runtime, "--backend", runtime];
			assert.equal(await new Promise<number>((resolve, reject) => { const child = spawn(runtime, args, { cwd: paths.runDir, env: { ...process.env, CMUX_SOCKET_PATH: socket }, stdio: "ignore" }); child.once("error", reject); child.once("close", (code) => resolve(code ?? 1)); }), 0);
			assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string })?.phase, "committed");
			assert.deepEqual(fake.requests.map((request) => request.method), ["system.capabilities", "system.identify", "system.capabilities", "system.identify", "system.tree", "surface.split"]);
			assert.equal((await readBrokerJson(paths.allocationPath) as { control?: unknown })?.control && JSON.stringify((await readBrokerJson(paths.allocationPath) as { control?: unknown }).control), JSON.stringify(control));
		} finally { await fake.close(); }
	});

	test("rejects an unsafe run directory before reading or mutating authority", async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "unsafe-run-dir" });
		await fs.promises.chmod(paths.runDir, 0o755);
		assert.equal(await run([path.resolve("src/runtime/pane-launch-broker.mjs"), "--run-dir", paths.runDir], process.env), 2);
		assert.equal(fs.existsSync(paths.brokerStatusPath), false);
	});

	test("rejects an intent whose run id is not the run directory before claim", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "directory-run" });
		const args = await writeIntent(paths, "different-intent-run", backend);
		assert.equal(await run(args, process.env), 0);
		assert.equal(fs.existsSync(paths.brokerClaimPath), false);
		assert.equal(fs.existsSync(paths.allocationPath), false);
	});

	test("accepts ignored legacy project-root while duplicate required or malformed arguments fail closed", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root);
		const accepted = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "argv-accepted" });
		assert.equal(await run([...await writeIntent(accepted, "argv-accepted", backend), "--project-root", root], process.env), 0);
		assert.equal((await readBrokerJson(accepted.brokerStatusPath) as { phase?: string })?.phase, "committed");
		for (const [runId, suffix] of [["argv-duplicate", ["--runtime", fs.realpathSync(process.execPath)]], ["argv-malformed", ["--project-root", "--nonce"]]] as const) {
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			assert.equal(await run([...await writeIntent(paths, runId, backend), ...suffix], process.env), 2);
			assert.equal(fs.existsSync(paths.brokerClaimPath), false);
			assert.equal(fs.existsSync(paths.brokerStatusPath), false);
		}
	});

	test("stops only at the explicit harness pre-allocation checkpoint", async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "preallocation-checkpoint" });
		const nonce = "a".repeat(43);
		const child = spawn(process.execPath, [...await writeIntent(paths, "preallocation-checkpoint", backend), "--acceptance-preallocation-checkpoint"], { cwd: paths.runDir, env: { ...process.env, PI_SUBAGENT_TEST_HARNESS: "1", PI_SUBAGENT_ACCEPTANCE_HARNESS: "1" }, stdio: "ignore" });
		await writePrivateFile(path.join(paths.runDir, "acceptance-handoff.json"), `${JSON.stringify({ version: 1, runId: "preallocation-checkpoint", brokerNonce: nonce, broker: { pid: child.pid, startedAt: 1, expectedCommand: "pane-launch-broker.mjs", runId: "preallocation-checkpoint" } })}\n`);
		try {
			for (let attempt = 0; attempt < 100; attempt += 1) {
				if ((await readBrokerJson(paths.brokerStatusPath) as { phase?: string } | null)?.phase === "ready") break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string } | null)?.phase, "ready");
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.equal(await readBrokerJson(paths.decisionPath), null);
			assert.match(spawnSync("/bin/ps", ["-o", "state=", "-p", String(child.pid)], { encoding: "utf8" }).stdout, /T/);
			child.kill("SIGCONT");
			assert.equal(await new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? 1))), 0);
			assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string } | null)?.phase, "committed");
		} finally {
			// SIGKILL is reserved for the dedicated acceptance fixture parent.
			if (child.exitCode === null) { child.kill("SIGCONT"); child.kill("SIGTERM"); }
		}
	});

	test("kills the exact response-to-record checkpoint and cleans only its bound candidate", { timeout: 15_000 }, async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "commands.log"), backend = await nativeMock(root), paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "postallocation-checkpoint" });
		const checkpointPath = acceptanceAllocationCheckpointPath(paths);
		const child = spawn(process.execPath, [...await writeIntent(paths, "postallocation-checkpoint", backend), "--acceptance-postallocation-checkpoint"], {
			cwd: paths.runDir, env: { ...process.env, CMUX_SOCKET_PATH: log, PI_SUBAGENT_TEST_HARNESS: "1", PI_SUBAGENT_ACCEPTANCE_HARNESS: "1" }, stdio: "ignore",
		});
		try {
			let checkpoint: Record<string, unknown> | null = null;
			for (let attempt = 0; attempt < 200; attempt += 1) {
				checkpoint = await readBrokerJson(checkpointPath) as Record<string, unknown> | null;
				if (checkpoint) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.ok(checkpoint);
			assert.deepEqual(checkpoint!.allocation, { version: 2, runId: "postallocation-checkpoint", terminalMode: "cmux-pane", target: { workspaceId, surfaceId, paneId }, allocatedAt: (checkpoint!.allocation as { allocatedAt: unknown }).allocatedAt });
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.equal(await readBrokerJson(paths.decisionPath), null);
			assert.equal(await readBrokerJson(paths.launchPath), null);
			const broker = { pid: child.pid!, startedAt: getProcessStartedAt(child.pid!)!, expectedCommand: "pane-launch-broker.mjs", runId: "postallocation-checkpoint" };
			const killed = await terminateStoppedPostallocationBroker(broker, paths);
			assert.equal(killed.result, "exact-candidate-killed");
			const target = (killed.allocation as { target: { workspaceId: string; surfaceId: string; paneId: string } }).target;
			const cmuxRun = async (args: string[]) => await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
				const command = spawn(backend, args, { env: { ...process.env, CMUX_SOCKET_PATH: log }, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "";
				command.stdout.on("data", (data) => { stdout += String(data); }); command.stderr.on("data", (data) => { stderr += String(data); });
				command.once("error", reject); command.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
			});
			const acceptance = { workspaceId, surfaceId: sourceSurfaceId, paneId: sourcePaneId, name: "fixture" };
			const caller = { workspaceId: "123e4567-e89b-12d3-a456-426614174090", surfaceId: "123e4567-e89b-12d3-a456-426614174091", paneId: "123e4567-e89b-12d3-a456-426614174092" };
			assert.equal(await cleanupAcceptanceCmuxTarget(backend, target, acceptance, caller, cmuxRun), true);
			const commands = await fs.promises.readFile(log, "utf8");
			assert.match(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${surfaceId}`));
			assert.doesNotMatch(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${sourceSurfaceId}`));
			assert.equal(await readBrokerJson(paths.launchPath), null);
		} finally {
			if (child.exitCode === null) { child.kill("SIGCONT"); child.kill("SIGKILL"); }
		}
	});

	test("retains residual risk for a killed response checkpoint without exact candidate authority", { timeout: 15_000 }, async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "commands.log"), backend = await nativeMock(root), paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "postallocation-residual" });
		const checkpointPath = acceptanceAllocationCheckpointPath(paths);
		const child = spawn(process.execPath, [...await writeIntent(paths, "postallocation-residual", backend), "--acceptance-postallocation-checkpoint"], {
			cwd: paths.runDir, env: { ...process.env, CMUX_SOCKET_PATH: log, PI_SUBAGENT_TEST_HARNESS: "1", PI_SUBAGENT_ACCEPTANCE_HARNESS: "1" }, stdio: "ignore",
		});
		try {
			let checkpoint: Record<string, unknown> | null = null;
			for (let attempt = 0; attempt < 200; attempt += 1) {
				checkpoint = await readBrokerJson(checkpointPath) as Record<string, unknown> | null;
				if (checkpoint) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.ok(checkpoint);
			await fs.promises.unlink(checkpointPath);
			await fs.promises.writeFile(checkpointPath, `${JSON.stringify({ ...checkpoint, allocation: { ...(checkpoint!.allocation as Record<string, unknown>), target: { workspaceId, surfaceId: sourceSurfaceId, paneId: sourcePaneId } } })}\n`, { mode: 0o600 });
			const broker = { pid: child.pid!, startedAt: getProcessStartedAt(child.pid!)!, expectedCommand: "pane-launch-broker.mjs", runId: "postallocation-residual" };
			assert.deepEqual(await terminateStoppedPostallocationBroker(broker, paths), { result: "residual-risk-retained", allocation: null });
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.equal(await readBrokerJson(paths.launchPath), null);
			const risk = await readBrokerJson(paths.residualRiskPath) as { recordedAt: unknown } | null;
			assert.deepEqual(risk, { version: 2, runId: "postallocation-residual", reason: "possible-unrecorded-allocation", recordedAt: risk?.recordedAt });
			const commands = await fs.promises.readFile(log, "utf8");
			assert.doesNotMatch(commands, /close-surface/);
			assert.doesNotMatch(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${sourceSurfaceId}`));
		} finally {
			if (child.exitCode === null) { child.kill("SIGCONT"); child.kill("SIGKILL"); }
		}
	});

	test("accepts a project-local native backend and records its exact resolved path", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "project-backend" });
		assert.equal(await run(await writeIntent(paths, "project-backend", backend), process.env), 0);
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string })?.phase, "committed");
		assert.equal((await readBrokerJson(paths.allocationPath) as { target?: { surfaceId?: string } })?.target?.surfaceId, surfaceId);
	});

	test("preserves resolver PATH for a symlinked env-shebang backend shim", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const nativeDir = path.join(root, "native"); await fs.promises.mkdir(nativeDir);
		const native = await nativeMock(nativeDir);
		const bin = path.join(root, "bin"); await fs.promises.mkdir(bin);
		const interpreter = path.join(bin, "backend-interpreter");
		await fs.promises.writeFile(interpreter, `#!/bin/sh\nexec ${JSON.stringify(native)} "$@"\n`, { mode: 0o700 });
		const script = path.join(root, "cmux-script");
		const backend = path.join(root, "cmux");
		await fs.promises.writeFile(script, "#!/usr/bin/env backend-interpreter\n", { mode: 0o700 });
		await fs.promises.symlink(script, backend);
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "script-backend" });
		assert.equal(await run(await writeIntent(paths, "script-backend", backend), { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }), 0);
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string })?.phase, "committed");
		assert.equal((await readBrokerJson(paths.allocationPath) as { target?: { surfaceId?: string } })?.target?.surfaceId, surfaceId);
	});

	test("invokes the broker through an env-bun shim while binding its concrete interpreter", async () => {
		if (!process.versions.bun) return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), bin = path.join(root, "bin"); await fs.promises.mkdir(bin);
		await fs.promises.symlink(process.execPath, path.join(bin, "bun"));
		const shim = path.join(bin, "broker-runtime");
		await fs.promises.writeFile(shim, "#!/usr/bin/env bun\nconst entry = process.argv[2];\nprocess.argv = [process.argv[0], entry, ...process.argv.slice(3)];\nawait import(entry);\n", { mode: 0o700 });
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "env-bun-runtime" });
		const args = await writeIntent(paths, "env-bun-runtime", backend);
		const intent = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
		intent.runtimePath = fs.realpathSync(shim);
		intent.runtimeInterpreterPath = fs.realpathSync(process.execPath);
		await fs.promises.unlink(paths.launchIntentPath);
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		args[6] = shim;
		assert.equal(await run(args, { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` }, paths.runDir, shim), 0);
		const status = await readBrokerJson(paths.brokerStatusPath) as { phase?: string; errorCode?: string };
		assert.equal(status?.phase, "committed", status?.errorCode);
	});

	test("accepts a shell runtime wrapper that execs the selected Bun or Node interpreter", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), wrapper = path.join(root, "runtime-wrapper");
		await fs.promises.writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o700 });
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "shell-runtime-wrapper" });
		const args = await writeIntent(paths, "shell-runtime-wrapper", backend);
		const intent = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
		intent.runtimePath = fs.realpathSync(wrapper); intent.runtimeInterpreterPath = fs.realpathSync("/bin/sh");
		await fs.promises.unlink(paths.launchIntentPath);
		await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(intent)}\n`);
		args[6] = wrapper; args[8] = "/bin/sh";
		assert.equal(await run(args, process.env, paths.runDir, wrapper), 0);
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string })?.phase, "committed");
	});

	test("durably records then closes an exact nonzero cmux allocation without committing", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId }), 1);
		const log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "exact-nonzero-allocation" });
		assert.equal(await run(await writeIntent(paths, "exact-nonzero-allocation", backend), { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		assert.deepEqual((await readBrokerJson(paths.allocationPath) as { target?: unknown })?.target, { workspaceId, surfaceId, paneId });
		assert.equal(await readBrokerJson(paths.decisionPath), null);
		assert.equal(await readBrokerJson(paths.launchPath), null);
		assert.equal(await readBrokerJson(paths.residualRiskPath), null);
		const status = await readBrokerJson(paths.brokerStatusPath) as { phase?: string; errorCode?: string };
		assert.equal(status?.phase, "failed");
		assert.equal(status?.errorCode, "allocation-failed");
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /new-split/);
		assert.match(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${surfaceId}`));
		assert.match(commands, /tree --all/);
		assert.doesNotMatch(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface 123e4567-e89b-12d3-a456-426614174001`));
	});

	test("rolls back a moved cmux target through its current global workspace", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const movedWorkspaceId = "123e4567-e89b-12d3-a456-426614174099";
		const log = path.join(root, "commands.log");
		const backend = await nativeMock(root, undefined, 1, movedWorkspaceId);
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "moved-global-target" });
		assert.equal(await run(await writeIntent(paths, "moved-global-target", backend), { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /tree --all/);
		assert.match(commands, new RegExp(`close-surface --workspace ${movedWorkspaceId} --surface ${surfaceId}`));
		assert.doesNotMatch(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${surfaceId}`));
	});

	test("uses an owned exact cmux result object for successful and nonzero allocation responses", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		for (const [runId, exitCode] of [["result-success-allocation", 0], ["result-nonzero-allocation", 1]] as const) {
			const log = path.join(root, `${runId}.log`);
			const topLevelSurfaceId = "123e4567-e89b-12d3-a456-426614174099";
			const backend = await nativeMock(root, JSON.stringify({ workspace_id: workspaceId, surface_id: topLevelSurfaceId, pane_id: paneId, result: { workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId } }), exitCode);
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			assert.equal(await run(await writeIntent(paths, runId, backend), { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
			assert.deepEqual((await readBrokerJson(paths.allocationPath) as { target?: unknown })?.target, { workspaceId, surfaceId, paneId });
			const commands = await fs.promises.readFile(log, "utf8");
			if (exitCode === 0) {
				assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string })?.phase, "committed");
				assert.match(commands, /tree --all/);
				assert.doesNotMatch(commands, /close-surface/);
			} else {
				assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "allocation-failed");
				assert.match(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${surfaceId}`));
				assert.doesNotMatch(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${topLevelSurfaceId}`));
			}
		}
	});

	test("rejects malformed owned cmux results without adopting top-level allocation IDs", { timeout: 15_000 }, async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		for (const [kind, malformedResult] of [["null", null], ["array", []], ["scalar", "not-an-object"]] as const) {
			for (const exitCode of [0, 1] as const) {
				const runId = `malformed-result-${kind}-${exitCode}`;
				const log = path.join(root, `${runId}.log`);
				const backend = await nativeMock(root, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId, result: malformedResult }), exitCode);
				const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
				assert.equal(await run(await writeIntent(paths, runId, backend), { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
				assert.equal(await readBrokerJson(paths.allocationPath), null);
				assert.equal(await readBrokerJson(paths.decisionPath), null);
				assert.equal(await readBrokerJson(paths.launchPath), null);
				const commands = await fs.promises.readFile(log, "utf8");
				assert.match(commands, /new-split/);
				assert.match(commands, /tree --all/);
				assert.doesNotMatch(commands, /close-surface/);
				assert.ok(await readBrokerJson(paths.residualRiskPath));
				assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "possible-unrecorded-allocation");
			}
		}
	});

	test("records malformed nonzero cmux output as residual risk without mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId }), 1);
		const log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "malformed-nonzero-allocation" });
		assert.equal(await run(await writeIntent(paths, "malformed-nonzero-allocation", backend), { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		assert.equal(await readBrokerJson(paths.allocationPath), null);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		const status = await readBrokerJson(paths.brokerStatusPath) as { phase?: string; errorCode?: string };
		assert.equal(status?.phase, "failed");
		assert.equal(status?.errorCode, "possible-unrecorded-allocation");
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /new-split/);
		assert.match(commands, /tree --all/);
		assert.doesNotMatch(commands, /close-surface/);
	});

	test("keeps a distinguishable unspawned cmux allocation as allocation-failed", async () => {
		if (process.platform === "win32") return;
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = path.join(root, "unspawnable-cmux");
		await fs.promises.writeFile(backend, "#!/definitely/not/an/interpreter\n", { mode: 0o700 });
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "unspawned-cmux-allocation" });
		assert.equal(await run(await writeIntent(paths, "unspawned-cmux-allocation", backend), process.env, paths.runDir), 0);
		assert.equal(await readBrokerJson(paths.allocationPath), null);
		assert.equal(await readBrokerJson(paths.residualRiskPath), null);
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "allocation-failed");
	});

	test("fails closed without closing the immutable source when cmux aliases it as an allocation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root, JSON.stringify({ workspace_id: workspaceId, surface_id: sourceSurfaceId, pane_id: paneId })), log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "source-surface-alias" });
		const args = await writeIntent(paths, "source-surface-alias", backend);
		assert.equal(await run(args, { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		assert.equal(await readBrokerJson(paths.allocationPath), null);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /new-split/);
		assert.match(commands, /tree --all/);
		assert.doesNotMatch(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${surfaceId}`));
	});

	test("requires runtimeInterpreterPath in every V2 intent before any backend command or publication", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), log = path.join(root, "commands.log");
		for (const runId of ["missing-runtime-interpreter-cmux", "missing-runtime-interpreter-tmux"]) {
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			const args = runId.endsWith("tmux") ? await writeTmuxIntent(paths, runId, backend) : await writeIntent(paths, runId, backend);
			const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
			delete record.runtimeInterpreterPath;
			await fs.promises.unlink(paths.launchIntentPath);
			await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
			assert.equal(await run(args, { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
			assert.equal(fs.existsSync(paths.brokerClaimPath), false);
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "intent-invalid");
		}
		assert.equal(fs.existsSync(log), false);
	});

	test("rejects coercible array and object intent UUIDs before any backend command or publication", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), log = path.join(root, "commands.log");
		for (const [runId, source] of [
			["array-source-uuid", { workspaceId: [workspaceId], sourceSurfaceId: "123e4567-e89b-12d3-a456-426614174001" }],
			["object-source-uuid", { workspaceId, sourceSurfaceId: { id: "123e4567-e89b-12d3-a456-426614174001" } }],
		] as const) {
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			const args = await writeIntent(paths, runId, backend);
			const record = await readBrokerJson(paths.launchIntentPath) as { source: unknown };
			record.source = source;
			await fs.promises.unlink(paths.launchIntentPath);
			await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
			assert.equal(await run(args, { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.equal(await readBrokerJson(paths.launchPath), null);
		}
		assert.equal(fs.existsSync(log), false);
	});

	test("quarantines coercible array and object backend UUID fields without close, tree, respawn, or publication", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const logs: string[] = [];
		for (const [runId, response] of [
			["array-response-uuid", { workspace_id: [workspaceId], surface_id: surfaceId, pane_id: paneId }],
			["object-response-uuid", { workspace_id: workspaceId, surface_id: { id: surfaceId }, pane_id: paneId }],
		] as const) {
			const log = path.join(root, `${runId}.log`); logs.push(log);
			const backend = await nativeMock(root, JSON.stringify(response));
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			assert.equal(await run(await writeIntent(paths, runId, backend), { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
			assert.ok(await readBrokerJson(paths.residualRiskPath));
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.equal(await readBrokerJson(paths.launchPath), null);
		}
		const commands = (await Promise.all(logs.map((log) => fs.promises.readFile(log, "utf8")))).join("\n");
		assert.match(commands, /new-split/);
		assert.match(commands, /tree --all/);
		assert.doesNotMatch(commands, /close-surface|respawn-pane/);
	});

	test("records uppercase UUID allocation aliases without treating them as a foreign workspace", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root, JSON.stringify({ workspace_id: workspaceId.toUpperCase(), surface_id: surfaceId.toUpperCase(), pane_id: paneId.toUpperCase() }));
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "uppercase-allocation" });
		assert.equal(await run(await writeIntent(paths, "uppercase-allocation", backend), process.env), 0);
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string })?.phase, "committed");
		assert.deepEqual((await readBrokerJson(paths.allocationPath) as { target?: unknown })?.target, { workspaceId: workspaceId.toUpperCase(), surfaceId: surfaceId.toUpperCase(), paneId: paneId.toUpperCase() });
	});

	test("records malformed canonical-looking responses as residual risk without any rollback mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId }));
		const log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "incomplete-canonical-response" });
		assert.equal(await run(await writeIntent(paths, "incomplete-canonical-response", backend), { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /new-split/);
		assert.match(commands, /tree --all/);
		assert.doesNotMatch(commands, /close-surface/);
	});

	test("quarantines a malformed response ref without mutating the ref", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root, JSON.stringify({ workspace_id: workspaceId, surface_ref: "surface:7" }));
		const log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "malformed-response-ref" });
		assert.equal(await run(await writeIntent(paths, "malformed-response-ref", backend), { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /new-split/);
		assert.doesNotMatch(commands, /close-surface/);
	});

	test("quarantines a cross-workspace allocation response without rollback authority", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const foreignWorkspaceId = "123e4567-e89b-12d3-a456-426614174099";
		const backend = await nativeMock(root, JSON.stringify({ workspace_id: foreignWorkspaceId, surface_id: surfaceId, pane_id: paneId }));
		const log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "cross-workspace-response" });
		assert.equal(await run(await writeIntent(paths, "cross-workspace-response", backend), { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		assert.equal(await readBrokerJson(paths.allocationPath), null);
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /new-split/);
		assert.doesNotMatch(commands, /close-surface/);
	});

	test("keeps durable allocation authority before cancel rollback and strips command hooks", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "allocation-first" });
		const args = await writeIntent(paths, "allocation-first", backend);
		const broker = run(args, { ...process.env, CMUX_SOCKET_PATH: log, NODE_OPTIONS: "--no-warnings", PATH: `${root}/bin` });
		await new Promise((resolve) => setTimeout(resolve, 200));
		await writePrivateFile(paths.decisionPath, `${JSON.stringify({ version: 2, runId: "allocation-first", kind: "cancel", decidedAt: 2, reason: "parent-abort" })}\n`);
		assert.equal(await broker, 0);
		assert.equal((await readBrokerJson(paths.allocationPath) as { target?: { surfaceId?: string } }).target?.surfaceId, surfaceId);
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${surfaceId}`));
		assert.match(commands, /node= bun=/);
		// cmux necessarily opens its initial new-split shell. Before the durable
		// decision it receives only backend authority, never parent run/child data.
		for (const authority of [paths.runDir, paths.wrapperPath, paths.secretEnvPath, paths.taskPath, paths.childSessionPath, "Task: secret task", "child-command"]) assert.doesNotMatch(commands, new RegExp(authority.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(commands.indexOf("new-split") < commands.indexOf("close-surface"), true);
	});

	test("preserves malformed allocation winner while rolling back its exact candidate and retaining residual risk", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "malformed-allocation-winner" });
		const args = await writeIntent(paths, "malformed-allocation-winner", backend);
		await writePrivateFile(paths.allocationPath, "{malformed}\\n");
		assert.equal(await run(args, { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		assert.equal(await fs.promises.readFile(paths.allocationPath, "utf8"), "{malformed}\\n");
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "possible-unrecorded-allocation");
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /new-split/);
		assert.match(commands, new RegExp(`close-surface --workspace ${workspaceId} --surface ${surfaceId}`));
		assert.match(commands, /tree --all/);
	});

	test("preserves opposite-mode allocation winner while rolling back only its candidate", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "opposite-allocation-winner" });
		const args = await writeIntent(paths, "opposite-allocation-winner", backend);
		const winner = { version: 2, runId: "opposite-allocation-winner", terminalMode: "tmux-pane", target: { socketPath: "/tmp/tmux.sock", serverPid: 1, paneId: "%2", panePid: 2 }, allocatedAt: 1 };
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(winner)}\n`);
		assert.equal(await run(args, { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		assert.deepEqual(await readBrokerJson(paths.allocationPath), winner);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		assert.match(await fs.promises.readFile(log, "utf8"), new RegExp(`close-surface --workspace ${workspaceId} --surface ${surfaceId}`));
	});

	test("does not adopt an EEXIST allocation from a different cmux workspace", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-broker-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), log = path.join(root, "commands.log");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "wrong-workspace-winner" });
		const args = await writeIntent(paths, "wrong-workspace-winner", backend);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId: "wrong-workspace-winner", terminalMode: "cmux-pane", target: { workspaceId: "123e4567-e89b-12d3-a456-426614174099", surfaceId, paneId }, allocatedAt: 1 })}\n`);
		assert.equal(await run(args, { ...process.env, CMUX_SOCKET_PATH: log }, paths.runDir), 0);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		assert.match(await fs.promises.readFile(log, "utf8"), new RegExp(`close-surface --workspace ${workspaceId} --surface ${surfaceId}`));
	});

	test("verifier launches only a complete, matching committed gate", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-gate-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), marker = path.join(root, "launched");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "valid-gate" });
		const args = await writeCommittedGate(paths, "valid-gate", backend);
		await writePrivateExecutableFile(paths.wrapperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
		assert.equal(await run([...args, "--verify-gate", "--wrapper", paths.wrapperPath], {
			...process.env, CMUX_WORKSPACE_ID: workspaceId, CMUX_SURFACE_ID: surfaceId,
		}, paths.runDir), 0);
		assert.equal(fs.existsSync(marker), true);
	});

	test("tmux verifier accepts the allocated pane process directly", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-gate-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeTmuxGateMock(root), paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-gate-direct" });
		const args = await writeTmuxIntent(paths, "tmux-gate-direct", backend), marker = path.join(root, "launched");
		await writePrivateExecutableFile(paths.wrapperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
		const child = spawn(process.execPath, [...args, "--verify-gate", "--wrapper", paths.wrapperPath], { cwd: paths.runDir, env: { ...process.env, PI_SUBAGENT_TEST_HARNESS: "1", PI_SUBAGENT_TEST_TMUX_GENERATION: "1", PI_SUBAGENT_TEST_TMUX_SERVER_PID: String(process.pid) }, stdio: "ignore" });
		assert.ok(child.pid);
		await publishCommittedTmuxGate(paths, "tmux-gate-direct", child.pid!);
		assert.equal(await waitForExit(child), 0);
		assert.equal(fs.existsSync(marker), true);
	});

	test("tmux verifier accepts exactly one non-exec wrapper layer", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-gate-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeTmuxGateMock(root), paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-gate-child" });
		const args = await writeTmuxIntent(paths, "tmux-gate-child", backend), marker = path.join(root, "launched");
		await writePrivateExecutableFile(paths.wrapperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
		const launcher = path.join(root, "non-exec-launcher.mjs");
		await fs.promises.writeFile(launcher, `import { spawn } from "node:child_process";\nconst [runtime, ...args] = process.argv.slice(2);\nconst child = spawn(runtime, args, { stdio: "inherit", env: { ...process.env, PI_SUBAGENT_TEST_TMUX_PANE_PID: String(process.pid) } });\nchild.once("exit", (code) => process.exit(code ?? 1));\n`);
		const child = spawn(process.execPath, [launcher, process.execPath, ...args, "--verify-gate", "--wrapper", paths.wrapperPath], { cwd: paths.runDir, env: { ...process.env, PI_SUBAGENT_TEST_HARNESS: "1", PI_SUBAGENT_TEST_TMUX_GENERATION: "1", PI_SUBAGENT_TEST_TMUX_SERVER_PID: String(process.pid) }, stdio: "ignore" });
		assert.ok(child.pid);
		await publishCommittedTmuxGate(paths, "tmux-gate-child", child.pid!);
		assert.equal(await waitForExit(child), 0);
		assert.equal(fs.existsSync(marker), true);
	});

	test("tmux verifier rejects unrelated process authority and source aliases", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-gate-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeTmuxGateMock(root);
		for (const [runId, paneId, panePid] of [["tmux-gate-unrelated", "%2", null], ["tmux-gate-source-alias", "%1", 456]] as const) {
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			const args = await writeTmuxIntent(paths, runId, backend), marker = path.join(root, `${runId}-launched`);
			await writePrivateExecutableFile(paths.wrapperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
			const child = spawn(process.execPath, [...args, "--verify-gate", "--wrapper", paths.wrapperPath], { cwd: paths.runDir, stdio: "ignore" });
			assert.ok(child.pid);
			await publishCommittedTmuxGate(paths, runId, panePid ?? child.pid! + 1, paneId);
			assert.equal(await waitForExit(child), 0);
			assert.equal(fs.existsSync(marker), false, runId);
		}
	});

	test("tmux verifier rejects malformed allocation authority", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-gate-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeTmuxGateMock(root), paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-gate-malformed" });
		const args = await writeTmuxIntent(paths, "tmux-gate-malformed", backend), marker = path.join(root, "launched");
		await writePrivateExecutableFile(paths.wrapperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
		await writePrivateFile(paths.allocationPath, "{}\n");
		assert.equal(await run([...args, "--verify-gate", "--wrapper", paths.wrapperPath], process.env, paths.runDir), 0);
		assert.equal(fs.existsSync(marker), false);
	});

	test("verifier rejects invalid gates and mismatched allocations without launching", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-gate-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root);
		const cases: Array<[string, { allocationRunId?: string; allocationMode?: "cmux-pane" | "tmux-pane"; gateMode?: "cmux-pane" | "tmux-pane" }]> = [["bad-gate", { gateMode: "tmux-pane" }], ["bad-allocation", { allocationRunId: "other-run" }], ["opposite-mode-allocation", { allocationMode: "tmux-pane" }]];
		for (const [runId, options] of cases) {
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			const marker = path.join(root, `${runId}-launched`);
			const args = await writeCommittedGate(paths, runId, backend, options);
			await writePrivateExecutableFile(paths.wrapperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
			assert.equal(await run([...args, "--verify-gate", "--wrapper", paths.wrapperPath], process.env, paths.runDir), 0);
			assert.equal(fs.existsSync(marker), false);
		}
	});

	test("verifier rejects a committed cmux allocation that aliases the source surface", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-gate-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const backend = await nativeMock(root), marker = path.join(root, "source-alias-launched");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "source-alias-gate" });
		const args = await writeCommittedGate(paths, "source-alias-gate", backend);
		const allocation = await readBrokerJson(paths.allocationPath) as { target: { surfaceId: string } };
		allocation.target.surfaceId = "123e4567-e89b-12d3-a456-426614174001";
		await fs.promises.unlink(paths.allocationPath);
		await writePrivateFile(paths.allocationPath, `${JSON.stringify(allocation)}\n`);
		await writePrivateExecutableFile(paths.wrapperPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
		assert.equal(await run([...args, "--verify-gate", "--wrapper", paths.wrapperPath], {
			...process.env, CMUX_WORKSPACE_ID: workspaceId, CMUX_SURFACE_ID: "123e4567-e89b-12d3-a456-426614174001",
		}, paths.runDir), 0);
		assert.equal(fs.existsSync(marker), false);
	});

	test("private broker cwd prevents a project bunfig preload from running", async () => {
		if (!process.versions.bun) return;
		const project = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-project-")); tempDirs.push(project);
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(root);
		const marker = path.join(project, "bunfig-preload-ran");
		await fs.promises.writeFile(path.join(project, "bunfig.toml"), "preload = ['./preload.ts']\n");
		await fs.promises.writeFile(path.join(project, "preload.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
		// The broker is started from its private runDir, not this project, so
		// Bun cannot discover this project bunfig preload.
		const backend = await nativeMock(project), paths = await prepareRunArtifactPaths({ rootDir: root, runId: "malicious-cwd" });
		const args = await writeCommittedGate(paths, "malicious-cwd", backend, { gateMode: "tmux-pane" });
		await writePrivateExecutableFile(paths.wrapperPath, "#!/bin/sh\nexit 1\n");
		assert.equal(await run([...args, "--verify-gate", "--wrapper", paths.wrapperPath], process.env, paths.runDir), 0);
		assert.equal(fs.existsSync(marker), false);
	});

	test("binds layout tmux split allocation to the requested source container", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "tmux.log"), backend = await nativeTmuxMock(root, "/bin/sh", log, "$1|@2|%2|789");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-layout-split" });
		const args = await writeTmuxIntent(paths, "tmux-layout-split", backend);
		const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
		record.layout = "split"; record.placement = "tmux-split";
		record.container = tmuxSourceContainer(record);
		await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
		assert.equal(await run(args, process.env, paths.runDir), 0);
		const allocation = await readBrokerJson(paths.allocationPath) as { container?: unknown; target?: unknown };
		assert.deepEqual(allocation.container, tmuxWindow(record, "@2"));
		assert.deepEqual(allocation.target, tmuxTarget(record));
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { phase?: string })?.phase, "committed");
		assert.match(await fs.promises.readFile(log, "utf8"), /#{pane_id}\|#{session_id}\|#{window_id}\|#{pane_pid}/);
	});

	test("binds layout tmux new-window allocation to its requested session and pane fingerprint", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "tmux.log"), backend = await nativeTmuxMock(root, "/bin/sh", log, "$1|@3|%2|789", 0, "$1|@2|%1|456");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-layout-window" });
		const args = await writeTmuxIntent(paths, "tmux-layout-window", backend);
		const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
		record.layout = "auto"; record.placement = "tmux-new-window"; record.windowLabel = buildTmuxWindowLabel("agent", "tmux-layout-window");
		record.container = tmuxSessionContainer(record);
		await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
		assert.equal(await run(args, process.env, paths.runDir), 0);
		const allocation = await readBrokerJson(paths.allocationPath) as { container?: unknown };
		assert.deepEqual(allocation.container, tmuxWindow(record, "@3"));
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /#{session_id}\|#{window_id}\|#{pane_id}\|#{pane_pid}/);
		assert.match(commands, /new-window/);
		const newWindow = commands.split("\n").find((line) => line.includes("new-window"))!;
		assert.equal(newWindow.split(" ").filter((arg) => arg === "-n").length, 1);
		assert.match(newWindow, /-n subagent:agent:tmux-lay/);
		assert.match(commands, /-t \$1:/);
		assert.equal(commands.indexOf("list-panes") < commands.indexOf("new-window"), true);
		assert.doesNotMatch(commands, /kill-window|kill-session/);
	});

	test("rejects missing, invalid, or run-mismatched tmux window labels before allocation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		for (const [runId, label] of [
			["tmux-label-missing", undefined],
			["tmux-label-invalid", "subagent:agent:#{pane_id}"],
			["tmux-label-mismatch", buildTmuxWindowLabel("agent", "other-run")],
		] as const) {
			const log = path.join(root, `${runId}.log`), backend = await nativeTmuxMock(root, "/bin/sh", log, "$1|@3|%2|789", 0, "$1|@2|%1|456");
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			const args = await writeTmuxIntent(paths, runId, backend);
			const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
			record.layout = "auto"; record.placement = "tmux-new-window"; record.container = tmuxSessionContainer(record);
			if (label === undefined) delete record.windowLabel; else record.windowLabel = label;
			await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
			assert.equal(await run(args, process.env, paths.runDir), 0);
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "intent-invalid");
			assert.equal(fs.existsSync(log), false, "invalid labels must not issue a tmux allocation command");
		}
	});

	test("rejects a same-window tmux response without commit and rolls back only its exact pane", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "tmux.log"), backend = await nativeTmuxMock(root, "/bin/sh", log, "$1|@2|%2|789", 0, "$1|@2|%1|456");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-same-window" });
		const args = await writeTmuxIntent(paths, "tmux-same-window", backend);
		const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
		record.layout = "auto"; record.placement = "tmux-new-window"; record.windowLabel = buildTmuxWindowLabel("agent", "tmux-same-window");
		record.container = tmuxSessionContainer(record);
		await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
		assert.equal(await run(args, process.env, paths.runDir), 0);
		assert.equal(await readBrokerJson(paths.allocationPath), null);
		assert.equal(await readBrokerJson(paths.decisionPath), null);
		assert.equal(await readBrokerJson(paths.launchPath), null);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /new-window/);
		assert.doesNotMatch(commands, /if-shell|kill-pane|kill-window|kill-session/);
	});

	test("fails before layout tmux new-window when source-session topology is not canonical", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		for (const [runId, topologyResponse, topologyExitCode] of [
			["tmux-window-session-mismatch", "$2|@2|%1|456", 0],
			["tmux-window-pane-mismatch", "$1|@2|%2|456", 0],
			["tmux-window-pid-mismatch", "$1|@2|%1|457", 0],
			["tmux-window-malformed-topology", "$1|@2|%1|not-a-pid", 0],
			["tmux-window-duplicate-source", "$1|@2|%1|456\\n$1|@2|%1|456", 0],
			["tmux-window-topology-probe-failure", "$1|@2|%1|456", 1],
		] as const) {
			const log = path.join(root, `${runId}.log`);
			const backend = await nativeTmuxMock(root, "/bin/sh", log, "$1|@3|%2|789", 0, topologyResponse, topologyExitCode);
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			const args = await writeTmuxIntent(paths, runId, backend);
			const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
			record.layout = "auto"; record.placement = "tmux-new-window"; record.windowLabel = buildTmuxWindowLabel("agent", runId);
			record.container = tmuxSessionContainer(record);
			await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
			assert.equal(await run(args, process.env, paths.runDir), 0);
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "allocation-failed");
			const commands = await fs.promises.readFile(log, "utf8");
			assert.match(commands, /#{session_id}\|#{window_id}\|#{pane_id}\|#{pane_pid}/);
			assert.doesNotMatch(commands, /new-window|if-shell|kill-pane|kill-window|kill-session/);
		}
	});

	test("durably records then closes exact nonzero tmux allocation without committing", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "tmux.log"), backend = await nativeTmuxMock(root, "/bin/sh", log, "%2|789", 1);
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-exact-nonzero" });
		assert.equal(await run(await writeTmuxIntent(paths, "tmux-exact-nonzero", backend), process.env, paths.runDir), 0);
		const allocation = await readBrokerJson(paths.allocationPath) as { target?: unknown } | null;
		assert.deepEqual(allocation?.target, tmuxTarget(await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>), JSON.stringify(await readBrokerJson(paths.brokerStatusPath)));
		assert.equal(await readBrokerJson(paths.decisionPath), null);
		assert.equal(await readBrokerJson(paths.launchPath), null);
		assert.equal(await readBrokerJson(paths.residualRiskPath), null);
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "allocation-failed");
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /split-window/);
		assert.match(commands, /list-panes -a -F #\{pane_id\}\|#\{pane_pid\}/);
		assert.doesNotMatch(commands, /if-shell|kill-pane|kill-window|kill-session/);
	});

	test("treats malformed dispatched nonzero tmux output as residual risk without mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "tmux.log"), backend = await nativeTmuxMock(root, "/bin/sh", log, "malformed", 1);
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-malformed-nonzero" });
		assert.equal(await run(await writeTmuxIntent(paths, "tmux-malformed-nonzero", backend), process.env, paths.runDir), 0);
		assert.equal(await readBrokerJson(paths.allocationPath), null);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "possible-unrecorded-allocation");
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /split-window/);
		assert.doesNotMatch(commands, /if-shell|kill-pane|kill-window|kill-session/);
	});

	test("treats malformed dispatched zero-exit tmux output as residual risk", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "tmux.log"), backend = await nativeTmuxMock(root, "/bin/sh", log, "malformed", 0);
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-malformed-zero" });
		assert.equal(await run(await writeTmuxIntent(paths, "tmux-malformed-zero", backend), process.env, paths.runDir), 0);
		assert.equal(await readBrokerJson(paths.allocationPath), null);
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		assert.equal((await readBrokerJson(paths.brokerStatusPath) as { errorCode?: string })?.errorCode, "possible-unrecorded-allocation");
	});

	test("tmux source-pane aliases fail closed without if-shell or kill-pane mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		for (const [runId, response] of [["tmux-source-alias", "%1\|456"], ["tmux-changed-pid-source-alias", "%1\|789"], ["tmux-malformed-source-alias", "%1\|not-a-pid"]] as const) {
			const log = path.join(root, `${runId}.log`);
			const backend = await nativeTmuxMock(root, "/bin/sh", log, response);
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			assert.equal(await run(await writeTmuxIntent(paths, runId, backend), process.env, paths.runDir), 0);
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.ok(await readBrokerJson(paths.residualRiskPath));
			const commands = await fs.promises.readFile(log, "utf8");
			assert.match(commands, /split-window/);
			assert.doesNotMatch(commands, /if-shell|kill-pane/);
		}
	});

	test("quarantines a pre-existing tmux response pane without rollback mutation", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "tmux.log");
		const backend = await nativeTmuxMock(root, "/bin/sh", log, "%2|789", 0, "%1|$1|@2|456\n%2|$1|@2|789");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-preexisting-pane" });
		assert.equal(await run(await writeTmuxIntent(paths, "tmux-preexisting-pane", backend), process.env, paths.runDir), 0);
		assert.equal(await readBrokerJson(paths.allocationPath), null);
		const commands = await fs.promises.readFile(log, "utf8");
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		assert.match(commands, /split-window/);
		assert.doesNotMatch(commands, /if-shell|kill-pane/);
	});

	test("suppresses tmux rollback on a malformed unrelated pre-mutation row", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "tmux.log");
		const backend = await nativeTmuxMock(root, "/bin/sh", log, "%2|789", 1, "%1|$1|@2|456", 0, "%1|456\nnot-a-row");
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "tmux-malformed-rollback-row" });
		assert.equal(await run(await writeTmuxIntent(paths, "tmux-malformed-rollback-row", backend), process.env, paths.runDir), 0);
		assert.deepEqual((await readBrokerJson(paths.allocationPath) as { target?: unknown })?.target, tmuxTarget(await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>));
		assert.ok(await readBrokerJson(paths.residualRiskPath));
		const commands = await fs.promises.readFile(log, "utf8");
		assert.match(commands, /list-panes/);
		assert.doesNotMatch(commands, /if-shell|kill-pane/);
	});

	test("quarantines pre-existing cmux response IDs without closing named targets", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-cmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const staleSurfaceTree = JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [
			{ id: sourcePaneId, surfaces: [{ id: sourceSurfaceId, pane_id: sourcePaneId }] },
			{ id: paneId, surfaces: [{ id: surfaceId, pane_id: paneId }] },
		] }] }] });
		for (const [runId, tree, response] of [
			["cmux-preexisting-surface", staleSurfaceTree, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: allocatedPaneId })],
			["cmux-preexisting-split-pane", undefined, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId })],
		] as const) {
			const log = path.join(root, `${runId}.log`), backend = await nativeCmuxLayoutMock(root, log, { ...(tree ? { tree } : {}), split: response });
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId }); const args = await writeIntent(paths, runId, backend);
			const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
			record.layout = "split"; record.placement = "cmux-split"; record.container = { kind: "cmux-source", workspaceId, sourceSurfaceId };
			await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
			assert.equal(await run(args, process.env, paths.runDir), 0);
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			assert.ok(await readBrokerJson(paths.residualRiskPath));
			const commands = await fs.promises.readFile(log, "utf8");
			assert.match(commands, /new-split/);
			assert.doesNotMatch(commands, /close-surface/);
		}
	});

	test("allocates layout-aware cmux auto split and records its exact pane container", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-cmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "cmux.log"), backend = await nativeCmuxLayoutMock(root, log);
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "cmux-layout-auto-split" });
		const args = await writeIntent(paths, "cmux-layout-auto-split", backend);
		const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
		record.layout = "auto"; record.placement = "cmux-split"; record.container = { kind: "cmux-source", workspaceId, sourceSurfaceId };
		await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
		assert.equal(await run(args, process.env, paths.runDir), 0);
		const allocation = await readBrokerJson(paths.allocationPath) as { container?: unknown };
		assert.deepEqual(allocation.container, { kind: "cmux-pane", workspaceId, paneId: allocatedPaneId });
		const commands = await fs.promises.readFile(log, "utf8");
		assert.equal((commands.match(/tree --all/g) ?? []).length, 1);
		assert.match(commands, /new-split right --workspace/);
		assert.equal(commands.indexOf("tree --all") < commands.indexOf("new-split"), true);
	});

	test("allocates stacked and nested source-pane cmux surfaces only after strict topology binding", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-cmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		for (const [runId, container] of [
			["cmux-layout-stacked", { kind: "cmux-pane", workspaceId, paneId }],
			["cmux-layout-source-pane", { kind: "cmux-source-pane", workspaceId, sourceSurfaceId, paneId: sourcePaneId }],
		] as const) {
			const log = path.join(root, `${runId}.log`), targetPane = container.kind === "cmux-source-pane" ? sourcePaneId : paneId;
			const backend = await nativeCmuxLayoutMock(root, log, { surface: JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: targetPane }) });
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId }); const args = await writeIntent(paths, runId, backend);
			const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
			record.layout = "auto"; record.placement = "cmux-new-surface"; record.container = container;
			await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
			assert.equal(await run(args, process.env, paths.runDir), 0);
			const commands = await fs.promises.readFile(log, "utf8");
			assert.equal((commands.match(/tree --all/g) ?? []).length, 1);
			assert.match(commands, /tree --all/);
			assert.match(commands, new RegExp(`new-surface --type terminal --workspace ${workspaceId} --pane ${targetPane} --working-directory ${path.dirname(paths.childSessionPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --focus false`));
			assert.equal(commands.indexOf("tree --all") < commands.indexOf("new-surface"), true);
		}
	});

	test("rejects stale, malformed, and wrong-pane layout cmux new-surface authority without close", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-cmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const malformedTree = JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: sourceSurfaceId, pane_id: "not-a-uuid" }] }] }] }] });
		const unrelatedMalformedTree = JSON.stringify({ windows: [{ workspaces: [
			{ id: workspaceId, panes: [{ id: sourcePaneId, surfaces: [{ id: sourceSurfaceId, pane_id: sourcePaneId }] }, { id: paneId, surfaces: [] }] },
			{ id: "123e4567-e89b-12d3-a456-426614174099", panes: [{ id: "123e4567-e89b-12d3-a456-426614174098", surfaces: [{ id: "not-a-uuid", pane_id: "123e4567-e89b-12d3-a456-426614174098" }] }] },
		] }] });
		for (const [runId, tree, surface] of [
			["cmux-layout-stale", malformedTree, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId })],
			["cmux-layout-unrelated-malformed", unrelatedMalformedTree, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId })],
			["cmux-layout-wrong-pane", undefined, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: sourcePaneId })],
			["cmux-layout-partial", undefined, JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId })],
		] as const) {
			const log = path.join(root, `${runId}.log`), backend = await nativeCmuxLayoutMock(root, log, { ...(tree ? { tree } : {}), surface });
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId }); const args = await writeIntent(paths, runId, backend);
			const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
			record.layout = "auto"; record.placement = "cmux-new-surface"; record.container = { kind: "cmux-pane", workspaceId, paneId };
			await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
			assert.equal(await run(args, process.env, paths.runDir), 0);
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			const commands = await fs.promises.readFile(log, "utf8");
			assert.doesNotMatch(commands, /close-surface/);
			if (runId === "cmux-layout-stale" || runId === "cmux-layout-unrelated-malformed") assert.doesNotMatch(commands, /new-surface/);
			else assert.ok(await readBrokerJson(paths.residualRiskPath));
		}
	});

	test("does not mutate when layout cmux topology omits, moves, or mismatches immutable authority", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-cmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const sourceOnly = JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: sourcePaneId, surfaces: [{ id: sourceSurfaceId, pane_id: sourcePaneId }] }] }] }] });
		const sourceMissing = JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [] }] }] }] });
		const sourceMoved = JSON.stringify({ windows: [{ workspaces: [
			{ id: workspaceId, panes: [{ id: paneId, surfaces: [] }] },
			{ id: "123e4567-e89b-12d3-a456-426614174099", panes: [{ id: sourcePaneId, surfaces: [{ id: sourceSurfaceId, pane_id: sourcePaneId }] }] },
		] }] });
		const sourceDuplicate = JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [
			{ id: sourcePaneId, surfaces: [{ id: sourceSurfaceId, pane_id: sourcePaneId }] },
			{ id: paneId, surfaces: [{ id: sourceSurfaceId, pane_id: paneId }] },
		] }] }] });
		for (const [runId, tree, placement, container] of [
			["cmux-split-source-missing", sourceMissing, "cmux-split", { kind: "cmux-source", workspaceId, sourceSurfaceId }],
			["cmux-split-source-duplicate", sourceDuplicate, "cmux-split", { kind: "cmux-source", workspaceId, sourceSurfaceId }],
			["cmux-split-source-moved", sourceMoved, "cmux-split", { kind: "cmux-source", workspaceId, sourceSurfaceId }],
			["cmux-surface-destination-missing", sourceOnly, "cmux-new-surface", { kind: "cmux-pane", workspaceId, paneId }],
			["cmux-surface-source-pane-mismatch", undefined, "cmux-new-surface", { kind: "cmux-source-pane", workspaceId, sourceSurfaceId, paneId }],
		] as const) {
			const log = path.join(root, `${runId}.log`), backend = await nativeCmuxLayoutMock(root, log, { ...(tree ? { tree } : {}) });
			const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId });
			const args = await writeIntent(paths, runId, backend);
			const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
			record.layout = placement === "cmux-split" ? "split" : "auto";
			record.placement = placement; record.container = container;
			await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
			const brokerExit = await run(args, process.env, paths.runDir);
			assert.equal(brokerExit, 0, JSON.stringify(await readBrokerJson(paths.brokerStatusPath)));
			assert.equal(await readBrokerJson(paths.allocationPath), null);
			const commands = await fs.promises.readFile(log, "utf8");
			assert.equal((commands.match(/tree --all/g) ?? []).length, 1);
			assert.doesNotMatch(commands, /new-split|new-surface|close-surface/);
		}
	});

	test("durably records and rolls back only an exact nonzero layout cmux surface", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-cmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const log = path.join(root, "cmux.log"), backend = await nativeCmuxLayoutMock(root, log, { surfaceCode: 1 });
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "cmux-layout-nonzero" }); const args = await writeIntent(paths, "cmux-layout-nonzero", backend);
		const record = await readBrokerJson(paths.launchIntentPath) as Record<string, unknown>;
		record.layout = "auto"; record.placement = "cmux-new-surface"; record.container = { kind: "cmux-pane", workspaceId, paneId };
		await fs.promises.unlink(paths.launchIntentPath); await writePrivateFile(paths.launchIntentPath, `${JSON.stringify(record)}\n`);
		assert.equal(await run(args, process.env, paths.runDir), 0);
		assert.deepEqual((await readBrokerJson(paths.allocationPath) as { container?: unknown }).container, { kind: "cmux-pane", workspaceId, paneId });
		const commands = await fs.promises.readFile(log, "utf8");
		// The global probe proves this target absent, so rollback succeeds without
		// guessing a workspace-local mutation.
		assert.doesNotMatch(commands, /close-surface/);
	});

	test("tmux bypasses its configured shell with direct env-i argv", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tmux-")); tempDirs.push(root);
		const stateRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-state-")); tempDirs.push(stateRoot);
		const configuredShell = "/tmp/project-hook-shell";
		const log = path.join(root, "tmux.log"), backend = await nativeTmuxMock(root, configuredShell, log);
		const paths = await prepareRunArtifactPaths({ rootDir: stateRoot, runId: "direct-argv" });
		assert.equal(await run(await writeTmuxIntent(paths, "direct-argv", backend), { ...process.env, BASH_ENV: "/tmp/bash-hook", ENV: "/tmp/sh-hook", XDG_CONFIG_HOME: "/tmp/fish-hook", RUBYOPT: "/tmp/ruby-hook", NODE_OPTIONS: "--require=/tmp/node-hook" }, paths.runDir), 0);
		const split = await fs.promises.readFile(log, "utf8");
		for (const expected of ["/usr/bin/env -i", `HOME=${paths.shellHomePath}`, `XDG_CONFIG_HOME=${paths.shellHomePath}`, `PATH=${process.env.PATH || "/usr/bin:/bin"}`, "--verify-gate", "NODE_OPTIONS=", "BUN_OPTIONS=", "DYLD_INSERT_LIBRARIES="]) assert.match(split, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.doesNotMatch(split, /project-hook-shell|bash-hook|sh-hook|fish-hook|ruby-hook|node-hook|show-options/);
	});
});
