import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runOwnedStage } from "../../.github/scripts/ci-stage";

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
		stage: "bun-timeout", command: [process.execPath, "test", "--isolate", "--bail=1", fixture], timeoutMs: 5_000, diagnosticsDirectory: directory,
	});
	assert.equal(result.status, "failure");
	assert.equal(await fs.promises.stat(marker).then(() => true).catch(() => false), false);
});
