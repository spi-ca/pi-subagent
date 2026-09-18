import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJUnitXml, type JUnitTestOutcome } from "./junit-report";

export type TestOutcome = JUnitTestOutcome;

const RAW_REPORT_MAX_BYTES = 1024 * 1024;

type FileIdentity = { dev: number; ino: number };
type ReportDirectory = FileIdentity & { path: string };
type PinnedReport = { path: string; identity: FileIdentity };
type OwnedScratch = { path: string; handle: fs.promises.FileHandle; identity: FileIdentity };

export type SequentialTestResult = {
	exitCode: number;
	signal: NodeJS.Signals | null;
	outcome: TestOutcome;
	/** True only when every inventory entry produced a valid report. */
	complete: boolean;
};

type CoordinatorTestHooks = {
	/** Test-only seam for the cancellation/replacement check before spawn. */
	afterReportRemoval?: (file: string) => NodeJS.Signals | undefined | Promise<NodeJS.Signals | undefined>;
	/** Test-only seam to verify malformed per-file evidence cannot be aggregated. */
	afterTestClose?: (file: string, scratchPath: string) => void | Promise<void>;
};

function emptyOutcome(): TestOutcome {
	return { tests: 0, passed: 0, skipped: 0, failures: 0, errors: 0 };
}

function addOutcomes(total: TestOutcome, next: TestOutcome): TestOutcome {
	const outcome = {
		tests: total.tests + next.tests,
		passed: total.passed + next.passed,
		skipped: total.skipped + next.skipped,
		failures: total.failures + next.failures,
		errors: total.errors + next.errors,
	};
	if (!Object.values(outcome).every(Number.isSafeInteger)) throw new Error("JUnit aggregate exceeds safe integer range");
	return outcome;
}

function aggregateXml(outcome: TestOutcome): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${outcome.tests}" skipped="${outcome.skipped}" failures="${outcome.failures}" errors="${outcome.errors}"></testsuites>\n`;
}

function sameIdentity(first: FileIdentity, second: FileIdentity): boolean {
	return first.dev === second.dev && first.ino === second.ino;
}

async function observeReportDirectory(reportPath: string): Promise<ReportDirectory> {
	const directory = path.dirname(reportPath);
	const stat = await fs.promises.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("raw JUnit parent is not a regular directory");
	return { path: directory, dev: stat.dev, ino: stat.ino };
}

async function requireReportDirectory(directory: ReportDirectory): Promise<void> {
	const stat = await fs.promises.lstat(directory.path);
	if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(stat, directory)) throw new Error("raw JUnit parent directory identity changed");
}

async function requireReportIdentity(report: PinnedReport, directory: ReportDirectory): Promise<void> {
	await requireReportDirectory(directory);
	const stat = await fs.promises.lstat(report.path);
	if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, report.identity)) throw new Error("raw JUnit report identity changed");
}

async function createPinnedReport(reportPath: string, directory: ReportDirectory): Promise<PinnedReport> {
	await requireReportDirectory(directory);
	const handle = await fs.promises.open(reportPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("raw JUnit report is not a regular file");
		return { path: reportPath, identity: { dev: stat.dev, ino: stat.ino } };
	} finally {
		await handle.close();
	}
}

/** Clear or publish through an open descriptor for the exact parent-pinned inode. */
async function writePinnedReport(report: PinnedReport, directory: ReportDirectory, content: string): Promise<void> {
	await requireReportIdentity(report, directory);
	const handle = await fs.promises.open(report.path, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || !sameIdentity(stat, report.identity)) throw new Error("raw JUnit report identity changed");
		await handle.truncate(0);
		await handle.writeFile(content);
		await handle.sync();
	} finally {
		await handle.close();
	}
	// If an attacker unlinked/replaced the path while the original descriptor
	// was open, this fails closed and preserves the replacement.
	await requireReportIdentity(report, directory);
}

let scratchSequence = 0;

/** Each Bun process receives a separately pinned scratch file, never the final handoff path. */
async function createScratchReport(directory: ReportDirectory): Promise<OwnedScratch> {
	await requireReportDirectory(directory);
	const scratchPath = path.join(directory.path, `.ci-test-coordinator-${process.pid}-${scratchSequence += 1}.xml`);
	const handle = await fs.promises.open(scratchPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("JUnit scratch report is not a regular file");
		return { path: scratchPath, handle, identity: { dev: stat.dev, ino: stat.ino } };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function requireScratchIdentity(scratch: OwnedScratch, directory: ReportDirectory): Promise<void> {
	await requireReportDirectory(directory);
	const pinned = await scratch.handle.stat();
	if (!pinned.isFile() || !sameIdentity(pinned, scratch.identity)) throw new Error("JUnit scratch report identity changed");
	const current = await fs.promises.lstat(scratch.path);
	if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, scratch.identity)) throw new Error("JUnit scratch report identity changed");
}

async function parseScratchReport(scratch: OwnedScratch, directory: ReportDirectory): Promise<TestOutcome> {
	await requireScratchIdentity(scratch, directory);
	const stat = await scratch.handle.stat();
	if (stat.size > RAW_REPORT_MAX_BYTES) throw new Error("raw report exceeded its cap");
	const outcome = parseJUnitXml(await scratch.handle.readFile({ encoding: "utf8" }));
	await requireScratchIdentity(scratch, directory);
	return outcome;
}

/** Delete only a scratch inode this coordinator created and retained. */
async function cleanupScratchReport(scratch: OwnedScratch | undefined, directory: ReportDirectory): Promise<void> {
	if (!scratch) return;
	try {
		await requireScratchIdentity(scratch, directory);
		await fs.promises.unlink(scratch.path);
		await requireReportDirectory(directory);
	} finally {
		await scratch.handle.close();
	}
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; spawnError: boolean }> {
	let spawnError = false;
	child.once("error", () => { spawnError = true; });
	return new Promise((resolve) => child.once("close", (exitCode, signal) => resolve({ exitCode, signal, spawnError })));
}

/** Run each inventory file in a fresh Bun process; only a parent-pinned final aggregate is handed off. */
export async function runSequentialTestFiles(reportPath: string, files: readonly string[], cwd = process.cwd(), testHooks?: CoordinatorTestHooks, expectedFinal?: FileIdentity): Promise<SequentialTestResult> {
	if (!path.isAbsolute(reportPath)) throw new Error("JUnit report path must be absolute");
	if (files.length === 0) throw new Error("test inventory must not be empty");
	const directory = await observeReportDirectory(reportPath);
	const finalReport = expectedFinal ? { path: reportPath, identity: expectedFinal } : await createPinnedReport(reportPath, directory);
	await requireReportIdentity(finalReport, directory);
	let outcome = emptyOutcome();
	let activeChild: ReturnType<typeof spawn> | undefined;
	let requestedSignal: NodeJS.Signals | undefined;
	const stopForSignal = (signal: NodeJS.Signals) => {
		requestedSignal ??= signal;
		try { activeChild?.kill(signal); } catch { /* the close latch owns completion */ }
	};
	const onSigint = () => stopForSignal("SIGINT");
	const onSigterm = () => stopForSignal("SIGTERM");
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	try {
		for (const file of files) {
			if (requestedSignal) break;
			// An incomplete next file must not inherit a valid prior aggregate.
			await writePinnedReport(finalReport, directory, "");
			const testSignal = await testHooks?.afterReportRemoval?.(file);
			if (testSignal) stopForSignal(testSignal);
			if (requestedSignal) break;
			await requireReportIdentity(finalReport, directory);
			let scratch: OwnedScratch | undefined;
			try {
				scratch = await createScratchReport(directory);
				activeChild = spawn(process.execPath, ["test", "--max-concurrency", "1", "--bail=1", "--reporter=junit", `--reporter-outfile=${scratch.path}`, file], {
					cwd, stdio: "inherit", env: { ...process.env, CI_STAGE_DIAGNOSTICS_DIR: undefined },
				});
				const result = await waitForClose(activeChild);
				activeChild = undefined;
				await testHooks?.afterTestClose?.(file, scratch.path);
				let next: TestOutcome;
				try {
					next = await parseScratchReport(scratch, directory);
					if (next.tests === 0) throw new Error(`JUnit report for ${file} contains no tests`);
					outcome = addOutcomes(outcome, next);
				} catch (error) {
					if (result.spawnError) throw new Error("Bun test process could not be spawned");
					return { exitCode: result.exitCode || 1, signal: requestedSignal ?? result.signal, outcome, complete: false };
				}
				if (result.spawnError) throw new Error("Bun test process could not be spawned");
				if (result.signal || result.exitCode !== 0 || requestedSignal) {
					await writePinnedReport(finalReport, directory, aggregateXml(outcome));
					return { exitCode: result.exitCode ?? 1, signal: requestedSignal ?? result.signal, outcome, complete: false };
				}
			} finally {
				await cleanupScratchReport(scratch, directory);
			}
		}
		if (!requestedSignal) {
			await writePinnedReport(finalReport, directory, aggregateXml(outcome));
			return { exitCode: 0, signal: null, outcome, complete: true };
		}
		if (outcome.tests > 0) await writePinnedReport(finalReport, directory, aggregateXml(outcome));
		return { exitCode: 1, signal: requestedSignal, outcome, complete: false };
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}

function parseExpectedIdentity(dev: string | undefined, ino: string | undefined): FileIdentity {
	const parsed = { dev: Number(dev), ino: Number(ino) };
	if (!Object.values(parsed).every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("invalid expected JUnit report identity");
	return parsed;
}

async function main(): Promise<void> {
	const [flag, dev, ino, reportPath, ...files] = process.argv.slice(2);
	if (flag !== "--expected-report-identity" || !reportPath || files.length === 0) throw new Error("usage: ci-test-coordinator.ts --expected-report-identity <dev> <ino> <absolute-report-path> <test-file> [...test-file]");
	const result = await runSequentialTestFiles(reportPath, files, process.cwd(), undefined, parseExpectedIdentity(dev, ino));
	if (result.signal) {
		// Handlers were removed before this point. Preserve the supervisor-visible
		// signal rather than converting it to a conventional 130/143 exit code.
		process.kill(process.pid, result.signal);
		return;
	}
	process.exitCode = result.exitCode;
}

if (import.meta.main) await main();
