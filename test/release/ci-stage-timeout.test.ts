import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCiInventory, HEAVY_STAGE_FILES, runCiStage, runOwnedStage, validateDiagnosticDirectory } from "../../.github/scripts/ci-stage";

const tempDirs: string[] = [];
afterEach(async () => {
	while (tempDirs.length) await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
});

test("CI timeout boundary does not run later Bun tests after an actual per-test timeout", async () => {
	if (process.platform !== "linux") return;
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ci-stage-"));
	tempDirs.push(directory);
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
		stage: "bun-timeout", command: [process.execPath, "test", "--isolate", "--bail=1", fixture], timeoutMs: 5_000, diagnosticsDirectory: directory, strictLinux: true,
	});
	assert.equal(result.status, "failure");
	assert.equal(await fs.promises.stat(marker).then(() => true).catch(() => false), false);
});

test("production per-file coordinator stops a timeout-first inventory and reaps its descendants", { timeout: 15_000 }, async () => {
	if (process.platform !== "linux") return;
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ci-timeout-inventory-"));
	const diagnostics = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-ci-timeout-diagnostics-"));
	tempDirs.push(root, diagnostics);
	const marker = path.join(root, "later-ran"), childPid = path.join(root, "child-pid");
	await fs.promises.writeFile(path.join(root, "01-timeout.test.ts"), `
		import { test } from "bun:test";
		import { spawn } from "node:child_process";
		import { writeFileSync } from "node:fs";
		test("times out", () => {
			const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
			writeFileSync(${JSON.stringify(childPid)}, String(child.pid));
			return new Promise(() => {});
		}, { timeout: 40 });
	`);
	await fs.promises.writeFile(path.join(root, "02-marker.test.ts"), `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "loaded"); test("must not run", () => {});`);
	// Real inventory discovery/validation, not a replacement test launcher.
	for (const file of Object.values(HEAVY_STAGE_FILES).flat()) {
		await fs.promises.mkdir(path.dirname(path.join(root, file)), { recursive: true });
		await fs.promises.writeFile(path.join(root, file), 'import { test } from "bun:test"; test("unused heavy stage", () => {});');
	}
	assert.deepEqual((await createCiInventory(root)).core, ["01-timeout.test.ts", "02-marker.test.ts"]);
	const previous = process.env.CI_STAGE_DIAGNOSTICS_DIR;
	process.env.CI_STAGE_DIAGNOSTICS_DIR = diagnostics;
	try {
		const result = await runCiStage("core", root, true);
		assert.equal(result.status, "failure", "timeout remains failure, never cleanup_incomplete/success");
		assert.notEqual(result.exitCode, 0);
		assert.equal(fs.existsSync(marker), false, "second inventory file was not even imported");
		const pid = Number(await fs.promises.readFile(childPid, "utf8"));
		assert.ok(Number.isSafeInteger(pid) && pid > 0);
		assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH", "supervisor reaped the exact fixture descendant");
		const diagnostic = JSON.parse(await fs.promises.readFile(await validateDiagnosticDirectory(diagnostics), "utf8"));
		if (diagnostic.testOutcome) assert.ok(diagnostic.testOutcome.failures > 0);
		else assert.ok(diagnostic.partialErrors.some((error: string) => error.startsWith("junit-outcome:")), "incomplete JUnit is explicitly diagnostic, not fabricated green");
	} finally {
		if (previous === undefined) delete process.env.CI_STAGE_DIAGNOSTICS_DIR; else process.env.CI_STAGE_DIAGNOSTICS_DIR = previous;
	}
});
