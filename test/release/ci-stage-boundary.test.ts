import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { cleanupOwnedReportDirectory, createCiInventory, discoverBunTestFiles, HEAVY_STAGE_FILES, parseJUnitReport, runCiStage, runOwnedStage, validateCiInventory, validateDiagnosticDirectory } from "../../.github/scripts/ci-stage";

const tempDirs: string[] = [];
afterEach(async () => {
	while (tempDirs.length) await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ci-stage-"));
	tempDirs.push(directory);
	return directory;
}

async function eventuallyDead(pid: number): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try { process.kill(pid, 0); } catch { return true; }
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${description}`);
}

async function waitForFile(file: string): Promise<void> {
	if (await fs.promises.stat(file).then(() => true).catch(() => false)) return;
	await new Promise<void>((resolve, reject) => {
		const watcher = fs.watch(path.dirname(file), (_event, filename) => {
			if (filename?.toString() === path.basename(file)) { watcher.close(); resolve(); }
		});
		watcher.once("error", reject);
		void fs.promises.stat(file).then(() => { watcher.close(); resolve(); }).catch(() => undefined);
	});
}

async function writeTemporaryInventory(root: string, coreSource: string, sources: Partial<Record<keyof typeof HEAVY_STAGE_FILES, string>> = {}): Promise<void> {
	await fs.promises.writeFile(path.join(root, "core.test.ts"), coreSource);
	for (const [stage, files] of Object.entries(HEAVY_STAGE_FILES) as [keyof typeof HEAVY_STAGE_FILES, readonly string[]][]) {
		const source = sources[stage] ?? 'import { test } from "bun:test"; test("fixture", () => {});\n';
		for (const file of files) {
			const target = path.join(root, file);
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			await fs.promises.writeFile(target, source);
		}
	}
}

describe("CI stage partition and external timeout boundary", () => {
	test("assigns every Bun test exactly once and requires each explicit heavy workload", async () => {
		const inventory = await createCiInventory(process.cwd());
		const assigned = Object.values(inventory).flat();
		assert.equal(new Set(assigned).size, assigned.length);
		assert.ok(inventory.core.length > 0);
		for (const [stage, required] of Object.entries(HEAVY_STAGE_FILES)) {
			assert.deepEqual(inventory[stage as keyof typeof HEAVY_STAGE_FILES], required);
			assert.ok(required.every((file) => assigned.includes(file)));
		}
		assert.ok(inventory.core.includes("test/release/ci-stage-boundary.test.ts"), "boundary regression coverage stays in core");
		const missing = structuredClone(inventory);
		missing.phase0 = [];
		assert.throws(() => validateCiInventory(assigned, missing), /missing=.*performance-phase0|empty=phase0/);
		const duplicate = structuredClone(inventory);
		duplicate.core.push(HEAVY_STAGE_FILES.phase0[0]);
		assert.throws(() => validateCiInventory(assigned, duplicate), /duplicate=.*performance-phase0/);
	});

	test("discovers all documented Bun suffix variants from new root directories and excludes unsupported names", async () => {
		const root = await temporaryDirectory();
		const names = ["alpha.test.ts", "beta_test.tsx", "gamma.spec.js", "delta_spec.jsx"];
		for (const name of names) {
			const target = path.join(root, "new-test-location", name);
			await fs.promises.mkdir(path.dirname(target), { recursive: true });
			await fs.promises.writeFile(target, "export {};\n");
		}
		await fs.promises.writeFile(path.join(root, "test-legacy.ts"), "export {};\n");
		await fs.promises.writeFile(path.join(root, "ignored.test.mts"), "export {};\n");
		await fs.promises.mkdir(path.join(root, "node_modules", "dep"), { recursive: true });
		await fs.promises.writeFile(path.join(root, "node_modules", "dep", "ignored.test.ts"), "export {};\n");
		assert.deepEqual(await discoverBunTestFiles(root), names.map((name) => `new-test-location/${name}`).sort());
	});

	test("reports nonzero stages as failures without manufacturing test counts", async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory();
		const result = await runOwnedStage({
			stage: "failing-stage", command: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5_000, diagnosticsDirectory: directory,
		});
		assert.equal(result.status, "failure");
		assert.equal(result.exitCode, 7);
		const diagnostic = JSON.parse(await fs.promises.readFile(result.diagnosticPath!, "utf8"));
		assert.equal(diagnostic.status, "failure");
		assert.equal(Object.hasOwn(diagnostic, "testOutcome"), false);
	});

	test("fails closed for a symlinked diagnostics root and retains only schema-valid output", async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory();
		const target = path.join(directory, "target");
		const link = path.join(directory, "link"), reports = path.join(directory, "reports");
		await fs.promises.mkdir(target); await fs.promises.mkdir(reports);
		await fs.promises.symlink(target, link);
		await assert.rejects(() => runOwnedStage({ stage: "symlink", command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 1_000, diagnosticsDirectory: link }), /non-symlink/);
		const result = await runOwnedStage({ stage: "schema", command: [process.execPath, "-e", "process.exit(0)"], timeoutMs: 1_000, diagnosticsDirectory: reports });
		assert.equal(result.status, "success");
		await validateDiagnosticDirectory(reports);
	});

	test("reports unavailable workload executables as spawn errors", async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory();
		const result = await runOwnedStage({ stage: "enoent", command: ["/definitely/not/a-command"], timeoutMs: 1_000, diagnosticsDirectory: directory });
		assert.equal(result.status, "spawn_error");
		assert.equal(JSON.parse(await fs.promises.readFile(result.diagnosticPath!, "utf8")).status, "spawn_error");
	});

	test("kills TERM-resistant descendants and returns only after the supervisor group is empty", async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory();
		const pidFile = path.join(directory, "pids.json");
		const canary = "diagnostic-canary-must-not-persist";
		const program = `
			const fs = require("node:fs");
			const { spawn } = require("node:child_process");
			process.on("SIGTERM", () => {});
			const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
			fs.writeFileSync(process.argv[1], JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
			process.stdout.write(${JSON.stringify(canary)});
			setInterval(() => {}, 1000);
		`;
		const result = await runOwnedStage({
			stage: "timeout-canary", command: [process.execPath, "-e", program, pidFile], timeoutMs: 150, diagnosticsDirectory: directory,
		});
		assert.equal(result.status, "timed_out");
		const pids = JSON.parse(await fs.promises.readFile(pidFile, "utf8")) as { child: number; grandchild: number };
		assert.equal(await eventuallyDead(pids.child), true, "the owned workload exited before the boundary returned");
		assert.equal(await eventuallyDead(pids.grandchild), true, "the owned descendant exited before the boundary returned");
		const raw = await fs.promises.readFile(result.diagnosticPath!, "utf8");
		assert.ok(Buffer.byteLength(raw) <= 8 * 1024);
		assert.equal(raw.includes(canary), false);
		const diagnostic = JSON.parse(raw);
		assert.equal(diagnostic.schemaVersion, 1);
		assert.equal(diagnostic.final, true);
		assert.ok(Array.isArray(diagnostic.partialErrors));
		assert.ok(Object.hasOwn(diagnostic, "ownedProcess"));
		assert.equal(Object.hasOwn(diagnostic, "environment"), false);
		assert.equal(Object.hasOwn(diagnostic, "command"), false);
	});

	test("does not run later Bun tests after an actual per-test timeout, including afterEach continuation", async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory();
		const fixture = path.join(directory, "timeout.test.ts");
		const marker = path.join(directory, "later-ran");
		await fs.promises.writeFile(fixture, `
			import { afterEach, test } from "bun:test";
			import { spawn } from "node:child_process";
			afterEach(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
			test("times out", () => { spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); return new Promise(() => {}); }, { timeout: 40 });
			test("must not run", async () => { await Bun.write(${JSON.stringify(marker)}, "ran"); });
		`);
		const result = await runOwnedStage({
			stage: "bun-timeout", command: [process.execPath, "test", "--bail=1", fixture], timeoutMs: 5_000, diagnosticsDirectory: directory,
		});
		assert.equal(result.status, "failure");
		assert.equal(await fs.promises.stat(marker).then(() => true).catch(() => false), false);
	});

	test("parses bounded JUnit totals and rejects empty or skipped success reports", async () => {
		const directory = await temporaryDirectory();
		const report = path.join(directory, "report.xml");
		await fs.promises.writeFile(report, '<testsuites tests="3" skipped="0" failures="0" errors="0"><testsuite/></testsuites>');
		assert.deepEqual(await parseJUnitReport(report), { tests: 3, passed: 3, skipped: 0, failures: 0, errors: 0 });
		await fs.promises.writeFile(report, '<testsuites tests="0" skipped="0" failures="0" errors="0"><testsuite/></testsuites>');
		assert.deepEqual(await parseJUnitReport(report), { tests: 0, passed: 0, skipped: 0, failures: 0, errors: 0 });
		await fs.promises.writeFile(report, '<testsuites tests="1" skipped="1" failures="0" errors="0"><testsuite/></testsuites>');
		assert.deepEqual(await parseJUnitReport(report), { tests: 1, passed: 0, skipped: 1, failures: 0, errors: 0 });
	});

	test("CLI coalesces a second SIGTERM, finalizes once, and never signals after close", async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory();
		const child = spawn(process.execPath, [".github/scripts/ci-stage.ts", "core"], {
			cwd: process.cwd(), env: { ...process.env, CI_STAGE_DIAGNOSTICS_DIR: directory }, stdio: "ignore",
		});
		await waitFor(async () => (await fs.promises.readdir(directory)).some((entry) => entry.startsWith("ci-stage-")), "stage ownership association");
		assert.equal(child.kill("SIGTERM"), true);
		assert.equal(child.kill("SIGTERM"), true);
		const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
		assert.equal(result.code, 143);
		assert.equal(result.signal, null);
		assert.equal(child.kill("SIGTERM"), false, "closed PID is never reused as a signal target");
		await validateDiagnosticDirectory(directory);
	});

	test("cleans a detached setsid escape through the subreaper instead of claiming its original group contains it", async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory(), pidFile = path.join(directory, "detached.json");
		const program = `
			const fs = require("node:fs"), { spawn } = require("node:child_process");
			const escaped = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
			fs.writeFileSync(process.argv[1], JSON.stringify({ escaped: escaped.pid }));
			process.exit(0);
		`;
		const result = await runOwnedStage({ stage: "setsid-escape", command: [process.execPath, "-e", program, pidFile], timeoutMs: 5_000, diagnosticsDirectory: directory });
		const { escaped } = JSON.parse(await fs.promises.readFile(pidFile, "utf8")) as { escaped: number };
		assert.equal(result.status, "success");
		assert.equal(await eventuallyDead(escaped), true, "detached descendant was reaped before successful finalization");
	});

	test("fails closed after forced supervisor death while terminating observed detached descendants", { timeout: 12_000 }, async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory(), pidFile = path.join(directory, "forced-death.json"), trigger = path.join(directory, "trigger");
		const observedPids = new Set<number>();
		let escapedPid: number | undefined;
		let resolveEscapedObserved: (() => void) | undefined;
		const escapedObserved = new Promise<void>((resolve) => { resolveEscapedObserved = resolve; });
		const program = `
			const fs = require("node:fs"), { spawn } = require("node:child_process");
			const escaped = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
			fs.writeFileSync(process.argv[1], JSON.stringify({ escaped: escaped.pid, supervisor: process.ppid }));
			const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); setTimeout(() => process.kill(process.ppid, "SIGKILL"), 50); } }, 5);
			setInterval(() => {}, 1000);
		`;
		const resultPromise = runOwnedStage({
			stage: "forced-supervisor-death", command: [process.execPath, "-e", program, pidFile, trigger], timeoutMs: 5_000, diagnosticsDirectory: directory,
			testSupervisorHooks: { onOwnedDescendantObserved: ({ pid }) => { observedPids.add(pid); if (pid === escapedPid) resolveEscapedObserved?.(); } },
		});
		await waitFor(() => fs.existsSync(pidFile), "detached child readiness");
		const { escaped } = JSON.parse(await fs.promises.readFile(pidFile, "utf8")) as { escaped: number };
		escapedPid = escaped;
		if (observedPids.has(escaped)) resolveEscapedObserved?.();
		await escapedObserved;
		await fs.promises.writeFile(trigger, "go");
		const result = await resultPromise;
		assert.equal(result.status, "cleanup_incomplete", "missing subreaper record is never green");
		assert.equal(await eventuallyDead(escaped), true, "outer tracked-identity fallback cleaned the observed escape");
	});

	test("retains a replacement raw-report directory rather than removing a foreign occupant", async () => {
		const directory = await temporaryDirectory();
		const stat = await fs.promises.lstat(directory), report = path.join(directory, "report.xml");
		await fs.promises.writeFile(report, "first");
		const original = await fs.promises.lstat(report);
		await fs.promises.unlink(report); await fs.promises.writeFile(report, "replacement");
		await assert.rejects(() => cleanupOwnedReportDirectory({ directory, dev: stat.dev, ino: stat.ino }, report, { dev: original.dev, ino: original.ino }), /identity changed/);
		assert.equal(await fs.promises.readFile(report, "utf8"), "replacement");
	});

	test("applies the production JUnit policy to a real zero-pass core report", async () => {
		if (process.platform !== "linux") return;
		const root = await temporaryDirectory();
		await writeTemporaryInventory(root, "export {};\n");
		const result = await runCiStage("core", root, true);
		assert.equal(result.exitCode, 0, "Bun accepted the generated empty suite");
		assert.equal(result.status, "failure", "removing the production policy call makes this test fail");
	});

	test("applies the production JUnit policy to mixed passing and skipped required-heavy reports", async () => {
		if (process.platform !== "linux") return;
		const root = await temporaryDirectory();
		const skipped = 'import { test } from "bun:test"; test("passing", () => {}); test.skip("intentional", () => {});\n';
		await writeTemporaryInventory(root, 'import { test } from "bun:test"; test("core", () => {});\n', { reaper: skipped });
		const result = await runCiStage("reaper", root, true);
		assert.equal(result.exitCode, 0, "Bun accepted the generated mixed passing and skipped suites");
		assert.equal(result.status, "failure", "removing the heavy-stage skip guard makes this test fail despite passing tests");
	});

	test("preserves direct Popen status when it exits after poll and before selective adopted reaping", { timeout: 8_000 }, async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory(), state = path.join(directory, "state.json");
		const intermediary = `
			const fs = require("node:fs"), { spawn } = require("node:child_process");
			const detached = spawn(process.execPath, ["-e", ${JSON.stringify('process.once("SIGUSR1", () => process.exit(0)); setInterval(() => {}, 1000);')}], { detached: true, stdio: "ignore" });
			fs.writeFileSync(process.argv[1], String(detached.pid));
			process.exit(0);
		`;
		const workload = `
			const fs = require("node:fs"), { spawn } = require("node:child_process");
			const intermediary = spawn(process.execPath, ["-e", ${JSON.stringify(intermediary)}, process.argv[1]], { stdio: "ignore" });
			intermediary.once("exit", () => {
				fs.writeFileSync(process.argv[2], JSON.stringify({ direct: process.pid, detached: Number(fs.readFileSync(process.argv[1], "utf8")) }));
				process.once("SIGUSR1", () => process.exit(42));
				setInterval(() => {}, 1000);
			});
		`;
		const result = await runOwnedStage({
			stage: "direct-status-after-poll", command: [process.execPath, "-e", workload, path.join(directory, "detached-pid"), state], timeoutMs: 5_000, diagnosticsDirectory: directory, strictLinux: true,
			testSupervisorHooks: {
				afterDirectPollBeforeReap: async () => {
					await waitForFile(state);
					const pids = JSON.parse(await fs.promises.readFile(state, "utf8")) as { direct: number; detached: number };
					process.kill(pids.detached, "SIGUSR1");
					process.kill(pids.direct, "SIGUSR1");
				},
			},
		});
		assert.equal(result.status, "failure");
		assert.equal(result.exitCode, 42, "selective waitpid never consumes the direct Popen return status");
	});

	test("refuses to spawn a workload when cancellation is observed after parent check and before Popen", async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory();
		const barrier = path.join(directory, "bootstrap-barrier"), result = path.join(directory, "bootstrap-result"), workloadMarker = path.join(directory, "orphan-workload");
		const helper = path.join(directory, "bootstrap-parent.ts");
		const moduleUrl = pathToFileURL(path.join(process.cwd(), ".github/scripts/ci-stage.ts")).href;
		await fs.promises.writeFile(helper, `
			import { runOwnedStage } from ${JSON.stringify(moduleUrl)};
			await runOwnedStage({
				stage: "bootstrap-parent-death", command: [process.execPath, "-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(workloadMarker)}, "spawned")`)}], timeoutMs: 5_000,
				testBootstrapBarrierPath: process.argv[2], testBootstrapResultPath: process.argv[3], strictLinux: true,
			});
		`);
		const outer = spawn(process.execPath, [helper, barrier, result], { cwd: process.cwd(), stdio: "ignore" });
		await waitFor(() => fs.existsSync(barrier), "post-parent-check pre-Popen bootstrap barrier");
		assert.equal(outer.kill("SIGKILL"), true);
		await new Promise<void>((resolve) => outer.once("close", () => resolve()));
		await fs.promises.unlink(barrier);
		await waitFor(() => fs.existsSync(result), "post-prctl original-parent verification");
		assert.equal(await fs.promises.readFile(result, "utf8"), "cancelled-before-workload-spawn");
		assert.equal(await fs.promises.stat(workloadMarker).then(() => true).catch(() => false), false, "orphaned supervisor never spawned a workload");
	});

	test("keeps the close latch when a child exits near the timeout boundary", async () => {
		if (process.platform !== "linux") return;
		const directory = await temporaryDirectory();
		const result = await runOwnedStage({
			stage: "close-race", command: [process.execPath, "-e", "setTimeout(() => process.exit(0), 20)"], timeoutMs: 1_000, diagnosticsDirectory: directory,
		});
		assert.equal(result.status, "success");
		assert.equal(result.exitCode, 0);
		assert.ok(await fs.promises.stat(result.diagnosticPath!));
	});
});
