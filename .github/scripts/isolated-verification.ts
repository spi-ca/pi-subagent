import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readValidatedDiagnostic, runOwnedStage, validateTestOutcomePolicy, type CiStage, type OwnedStageOptions, type OwnedStageResult, type TestOutcome } from "./ci-stage";
import { captureSelection, cleanupOwned, cloneSource, copyCache, git, literalPath, ownDirectory, readTree, requireOwned, resolveCommit, selectionManifest, sourceState, trackedPaths, verifySelection, workingManifest, type OwnedDirectory, type SelectedFile } from "./isolated-source";

export type VerificationOptions = { commit?: string; base?: string; paths: string[]; output: string; cacheFrom?: string; cc?: string; allowNetwork: boolean };
const STAGES: CiStage[] = ["core", "phase0", "reaper", "sessionTail"];
// Same locked baseline as the mandatory CI matrix, not a claim about every Pi API.
export const EXPECTED_PI_GRAPH = Object.fromEntries(["agent-core", "ai", "codemode", "coding-agent", "mcp", "telemetry", "tui"].map((name) => [`@earendil-works/pi-${name}`, "1.4.0"]));

export function parseOptions(args: string[]): VerificationOptions {
	const options: VerificationOptions = { paths: [], output: "", allowNetwork: false };
	const seen = new Set<string>();
	for (let index = 0; index < args.length; index += 1) {
		const flag = args[index]!;
		if (flag !== "--path" && seen.has(flag)) throw new Error(`duplicate option ${flag}`);
		seen.add(flag);
		if (flag === "--allow-network") { options.allowNetwork = true; continue; }
		if (!["--commit", "--base", "--path", "--output", "--cache-from", "--cc"].includes(flag)) throw new Error(`unknown option ${flag}`);
		const value = args[index += 1];
		if (!value || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
		if (flag === "--path") options.paths.push(literalPath(value));
		if (flag === "--commit") options.commit = value;
		if (flag === "--base") options.base = value;
		if (flag === "--output") options.output = path.resolve(value);
		if (flag === "--cache-from") options.cacheFrom = path.resolve(value);
		if (flag === "--cc") {
			if (!path.isAbsolute(value)) throw new Error("--cc requires an absolute executable path");
			options.cc = value;
		}
	}
	if (!options.output || Boolean(options.commit) === Boolean(options.base) || (options.commit && options.paths.length) || (options.base && !options.paths.length)) {
		throw new Error("usage: verify:isolated (--commit <local-ref> | --base <local-ref> --path <tracked-file>...) --output <new-directory> [--cache-from <explicit-cache>] [--cc <absolute-executable>] [--allow-network]");
	}
	if (new Set(options.paths).size !== options.paths.length) throw new Error("duplicate literal paths");
	return options;
}

export type CompilerSelection = { executable: string; target: string; directory: string };

/** Walk compiler paths without normalizing away directories traversed before a symlink or `..`. */
function compilerPath(selected: string, uid: number): string {
	const root = path.parse(selected).root;
	let current = root, pending = selected.slice(root.length).split(path.sep), hops = 0;
	const safeDirectory = (directory: string) => {
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || (stat.uid !== 0 && stat.uid !== uid)) throw new Error("--cc requires safe ownership, modes and canonical ancestry");
	};
	safeDirectory(root);
	while (pending.length) {
		const component = pending.shift()!;
		if (component === "" || component === ".") continue;
		if (component === "..") { current = path.dirname(current); continue; }
		const candidate = path.join(current, component), stat = fs.lstatSync(candidate);
		if (stat.isSymbolicLink()) {
			if (++hops > 40 || (stat.uid !== 0 && stat.uid !== uid)) throw new Error("--cc requires a bounded, safely owned alias chain");
			const link = fs.readlinkSync(candidate);
			if (path.isAbsolute(link)) current = root;
			pending = [...link.slice(path.isAbsolute(link) ? root.length : 0).split(path.sep), ...pending];
			continue;
		}
		if (stat.isDirectory()) safeDirectory(candidate);
		else if (!stat.isFile() || pending.length) throw new Error("--cc requires directories along the path and a regular executable");
		current = candidate;
	}
	return current;
}

/** Validate the full alias chain, but preserve explicit basename for multicall compiler wrappers.
 * Pathname validation is not protection against concurrent same-UID toolchain replacement.
 */
export function compilerSelection(selected: string): CompilerSelection {
	if (!path.isAbsolute(selected) || selected.includes("\0")) throw new Error("--cc requires an absolute executable path");
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("cannot validate --cc ownership on this platform");
	const target = compilerPath(selected, uid), directory = compilerPath(path.dirname(selected), uid), executable = path.join(directory, path.basename(selected));
	if (directory.includes(path.delimiter)) throw new Error("--cc invocation directory must not contain the PATH delimiter");
	const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || !(stat.mode & 0o111) || (stat.mode & 0o6022) !== 0 || (stat.uid !== 0 && stat.uid !== uid)) throw new Error("--cc requires a safe regular executable");
		fs.accessSync(executable, fs.constants.X_OK);
	} finally { fs.closeSync(fd); }
	return { executable, target, directory };
}

/** No caller HOME/auth/proxy/loader/provider variables, PATH, or implicit CC inheritance. */
export function cleanEnvironment(root: string, bun = process.execPath, cc?: string): NodeJS.ProcessEnv {
	const compiler = cc === undefined ? undefined : compilerSelection(cc);
	return {
		...(compiler === undefined ? {} : { CC: compiler.executable }),
		PATH: [...new Set([path.dirname(bun), ...(compiler === undefined ? [] : [compiler.directory]), "/usr/local/bin", "/usr/bin", "/bin"])].join(path.delimiter),
		HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
		TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
		BUN_INSTALL_CACHE_DIR: path.join(root, "cache"), BUN_INSTALL: path.join(root, "bun"),
		BUN_CONFIG_NO_CLEAR_TERMINAL: "1", BUN_CONFIG_NO_INSTALL: "1",
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
		GIT_CONFIG_COUNT: "4", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/dev/null",
		GIT_CONFIG_KEY_1: "protocol.allow", GIT_CONFIG_VALUE_1: "never", GIT_CONFIG_KEY_2: "core.fsmonitor", GIT_CONFIG_VALUE_2: "false",
		GIT_CONFIG_KEY_3: "protocol.file.allow", GIT_CONFIG_VALUE_3: "always",
		CI: "1", PI_OFFLINE: "1", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC",
	};
}

export function installCommand(cache: string, allowNetwork: boolean, bun = process.execPath): string[] {
	const command = [bun, "install", "--no-env-file", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile", `--cache-dir=${cache}`, "--registry=https://registry.npmjs.org"];
	if (!allowNetwork) command.push("--offline");
	return command;
}

export async function collectStageReports(root: string): Promise<Record<string, unknown>> {
	const reports: Record<string, unknown> = Object.fromEntries(STAGES.map((stage) => [stage, { state: "missing" }]));
	const entries = fs.readdirSync(root, { withFileTypes: true });
	if (entries.length > STAGES.length) throw new Error("unexpected extra CI diagnostic directories");
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || !/^ci-stage-[A-Za-z0-9_-]+$/.test(entry.name)) throw new Error("unexpected CI diagnostics entry");
		const directory = path.join(root, entry.name), files = fs.readdirSync(directory, { withFileTypes: true });
		if (files.length !== 1 || !files[0]!.isFile() || files[0]!.isSymbolicLink()) throw new Error("stage report must have exactly one regular file");
		const file = path.join(directory, files[0]!.name), report = await readValidatedDiagnostic(file);
		const stage = report.stage as CiStage;
		if (!STAGES.includes(stage) || (reports[stage] as { state: string }).state !== "missing") throw new Error("unexpected/duplicate stage report");
		let state = "failure";
		if (report.status === "success" && report.testOutcome) {
			const outcome = report.testOutcome as TestOutcome;
			try {
				if (!Object.values(outcome).every((value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) throw new Error("missing/noninteger outcome counts");
				validateTestOutcomePolicy(stage, outcome);
				if (outcome.tests !== outcome.passed + outcome.skipped + outcome.failures + outcome.errors || outcome.failures || outcome.errors) throw new Error("inconsistent or failing test outcomes");
				state = "pass";
			} catch { /* valid telemetry is not necessarily passing test evidence */ }
		}
		reports[stage] = { state, path: file, diagnostic: report };
	}
	return reports;
}

function privateOutput(output: string, source: string): OwnedDirectory {
	const parent = path.dirname(output);
	if (fs.realpathSync(parent) !== parent) throw new Error("output parent must be canonical and non-symlink");
	const relative = path.relative(source, output);
	if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
		&& !relative.startsWith(`node_modules${path.sep}.cache${path.sep}isolated-verification${path.sep}`)) throw new Error("output must be outside test inventory (or under node_modules/.cache/isolated-verification)");
	fs.mkdirSync(output, { mode: 0o700 }); // Exclusive: never reuse caller files.
	return ownDirectory(output);
}

function writeReceipt(owner: OwnedDirectory, receipt: Record<string, unknown>): void {
	requireOwned(owner);
	const encoded = `${JSON.stringify(receipt, null, 2)}\n`;
	if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) throw new Error("receipt exceeds 16 MiB bound");
	const temporary = path.join(owner.directory, "receipt.tmp");
	fs.writeFileSync(temporary, encoded, { flag: "wx", mode: 0o600 });
	fs.renameSync(temporary, path.join(owner.directory, "receipt.json"));
	requireOwned(owner);
}

/** A fresh HOME must have safe ancestry too: a private child below world-writable /tmp is insufficient. */
export function defaultWorkspacePrefix(source: string, home = os.homedir()): string {
	const parent = fs.realpathSync(home), uid = process.getuid?.();
	if (uid === undefined) throw new Error("cannot validate workspace home ownership on this platform");
	const relative = path.relative(fs.realpathSync(source), parent);
	if (parent.split(path.sep).includes("node_modules") || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) throw new Error("workspace home must be outside source inventory and node_modules");
	for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
		const stat = fs.lstatSync(ancestor);
		if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(ancestor) !== ancestor || (stat.mode & 0o022) !== 0
			|| (ancestor === parent ? stat.uid !== uid : stat.uid !== 0 && stat.uid !== uid)) throw new Error("workspace home requires safe ownership, modes and canonical ancestry");
		if (ancestor === path.dirname(ancestor)) break;
	}
	return path.join(parent, ".pi-iv-");
}

type TestHooks = { temporaryParent?: string; runCommand?: (options: OwnedStageOptions) => Promise<OwnedStageResult> };

/** Test hooks control project-local fixtures, never CLI flags or the production CI contract. */
export async function verifyIsolated(options: VerificationOptions, source = process.cwd(), hooks: TestHooks = {}): Promise<Record<string, unknown>> {
	source = fs.realpathSync(source);
	const output = privateOutput(path.resolve(options.output), source);
	const receipt: Record<string, unknown> = { schemaVersion: 1, status: "running", source, selection: options, toolchain: { bun: process.versions.bun, executable: process.execPath }, dependencyGraph: { state: "not-run", expected: EXPECTED_PI_GRAPH }, stages: Object.fromEntries(STAGES.map((stage) => [stage, { state: "missing" }])), cleanup: { state: "not-started" }, commands: [] };
	writeReceipt(output, receipt);
	let temporary: OwnedDirectory | undefined, env: NodeJS.ProcessEnv | undefined, before: unknown, sourcePaths: string[] = [];
	let clone: string | undefined, cloneBefore: unknown, clonePaths: string[] = [], selection: SelectedFile[] = [];
	const abort = new AbortController();
	let requestedSignal: string | undefined;
	const onInt = () => { requestedSignal ??= "SIGINT"; abort.abort(); };
	const onTerm = () => { requestedSignal ??= "SIGTERM"; abort.abort(); };
	process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
	const checkCancelled = () => { if (abort.signal.aborted) throw new Error("verification cancelled"); };
	const runCommand = async (name: string, command: string[], cwd: string, timeoutMs: number, diagnostics?: string): Promise<OwnedStageResult> => {
		checkCancelled();
		const log = path.join(output.directory, `${name}.log`), fd = fs.openSync(log, "wx", 0o600);
		const entry: Record<string, unknown> = { name, command, log, output: "combined stdout/stderr", state: "running" };
		(receipt.commands as unknown[]).push(entry);
		writeReceipt(output, receipt);
		try {
			const result = await (hooks.runCommand ?? runOwnedStage)({ stage: name, command, cwd, timeoutMs, env: name === "graph" ? { ...env, PI_GRAPH_EXPECTED: JSON.stringify(EXPECTED_PI_GRAPH) } : env, outputFd: fd, abortSignal: abort.signal, workloadDiagnosticsDirectory: diagnostics });
			entry.result = result;
			entry.state = result.status;
			if (result.status === "cleanup_incomplete") receipt.processCleanupIncomplete = true;
			return result;
		} catch (error) {
			// A thrown boundary cannot prove that a partially spawned child is gone.
			entry.state = "ownership_uncertain";
			receipt.processCleanupIncomplete = true;
			throw error;
		} finally { fs.closeSync(fd); }
	};
	try {
		const compiler = options.cc === undefined ? undefined : compilerSelection(options.cc);
		if (compiler !== undefined) (receipt.toolchain as Record<string, unknown>).compiler = { requested: options.cc, ...compiler };
		const prefix = hooks.temporaryParent === undefined ? defaultWorkspacePrefix(source) : path.join(fs.realpathSync(hooks.temporaryParent), "pi-iv-");
		temporary = ownDirectory(fs.mkdtempSync(prefix));
		receipt.temporaryRoot = temporary.directory;
		env = cleanEnvironment(temporary.directory, process.execPath, compiler?.executable);
		for (const directory of ["home", "config", "xdg-cache", "tmp", "bun", "template"]) fs.mkdirSync(path.join(temporary.directory, directory), { mode: 0o700 });
		if (git(source, env, ["rev-parse", "--show-toplevel"]).toString().trim() !== source) throw new Error("invoke from an explicit local repository root");
		const commit = resolveCommit(source, env, options.commit ?? options.base ?? "");
		const baseTree = readTree(source, env, commit);
		sourcePaths = [...new Set([...trackedPaths(source, env), ...(options.base ? options.paths : [])])];
		before = sourceState(source, env, sourcePaths);
		receipt.sourceBefore = before;
		selection = options.base ? captureSelection(source, env, options.paths, baseTree) : [];
		receipt.selectedManifest = selectionManifest(selection);
		receipt.sourceCommit = commit;
		receipt.baseTree = git(source, env, ["rev-parse", `${commit}^{tree}`]).toString().trim();
		receipt.selectedPaths = options.paths;
		checkCancelled();
		clone = path.join(temporary.directory, "source");
		const materialized = cloneSource(source, clone, env, commit, selection, path.join(temporary.directory, "template"));
		receipt.selectedDiffSha256 = materialized.patchSha256;
		receipt.selectionProof = { beforeInstall: verifySelection(clone, selection) };
		clonePaths = materialized.entries.map((entry) => entry.path);
		cloneBefore = workingManifest(clone, clonePaths);
		receipt.clone = { head: git(clone, env, ["rev-parse", "HEAD"]).toString().trim(), shallow: git(clone, env, ["rev-parse", "--is-shallow-repository"]).toString().trim(), tree: materialized.tree, entries: materialized.entries, contentBefore: cloneBefore };
		if (JSON.stringify(before) !== JSON.stringify(sourceState(source, env, sourcePaths))) throw new Error("original source changed during selection");
		const cache = path.join(temporary.directory, "cache");
		if (options.cacheFrom) copyCache(options.cacheFrom, cache);
		else fs.mkdirSync(cache, { mode: 0o700 });
		receipt.installPolicy = { offline: !options.allowNetwork, cacheFrom: options.cacheFrom ?? null, privateCache: cache, lifecycleScripts: false, networkPermission: "dependency provisioning only; not an OS sandbox", envKeys: Object.keys(env).sort() };
		receipt.processBoundary = process.platform === "linux" ? "Linux owned subreaper/PID-start identity" : "portable direct-child only; no detached descendant guarantee";
		const install = await runCommand("install", installCommand(cache, options.allowNetwork), clone, 10 * 60_000);
		if (install.status !== "success" || install.exitCode !== 0) throw new Error("dependency provisioning failed; see install.log (no automatic network fallback)");
		(receipt.selectionProof as Record<string, unknown>).afterInstall = verifySelection(clone, selection);
		const graph = await runCommand("graph", [process.execPath, "--no-env-file", ".github/scripts/verify-pi-graph.ts"], clone, 60_000);
		// Only this graph probe receives the explicit expected mapping; the common environment is still credential-free.
		receipt.dependencyGraph = { state: graph.status === "success" && graph.exitCode === 0 ? "verified" : "failure", expected: EXPECTED_PI_GRAPH, result: graph };
		if (graph.status !== "success" || graph.exitCode !== 0) throw new Error("installed Pi graph verification failed");
		const diagnostics = path.join(output.directory, "stages");
		fs.mkdirSync(diagnostics, { mode: 0o700 });
		const ci = await runCommand("ci", [process.execPath, "--no-env-file", "run", "ci"], clone, 80 * 60_000, diagnostics);
		receipt.productionCi = ci;
		receipt.stages = await collectStageReports(diagnostics);
		if (ci.status !== "success" || ci.exitCode !== 0 || Object.values(receipt.stages as Record<string, { state: string }>).some((report) => report.state !== "pass")) throw new Error("mandatory CI or required stage evidence failed");
		checkCancelled();
		receipt.status = "candidate_pass";
	} catch (error) {
		receipt.status = "failure";
		receipt.error = error instanceof Error ? error.message.slice(0, 2048) : "verification failed";
	} finally {
		try {
			if (clone && cloneBefore) {
				(receipt.selectionProof as Record<string, unknown>).afterVerification = verifySelection(clone, selection);
				const after = workingManifest(clone, clonePaths);
				(receipt.clone as Record<string, unknown>).contentAfter = after;
				if (env) (receipt.clone as Record<string, unknown>).treeAfter = git(clone, env, ["write-tree"]).toString().trim();
				if ((receipt.clone as Record<string, unknown>).treeAfter !== (receipt.clone as Record<string, unknown>).tree || JSON.stringify(after) !== JSON.stringify(cloneBefore)) throw new Error("clone tracked tree/content/modes changed during verification");
			}
		} catch (error) { receipt.status = "failure"; receipt.preservationError = error instanceof Error ? error.message : "clone preservation verification failed"; }
		try {
			if (before && env) {
				const after = sourceState(source, env, sourcePaths);
				receipt.sourceAfter = after;
				receipt.sourcePreserved = JSON.stringify(before) === JSON.stringify(after);
				if (!receipt.sourcePreserved) throw new Error("original source changed during verification");
			}
		} catch (error) { receipt.status = "failure"; receipt.sourcePreservationError = error instanceof Error ? error.message : "source preservation verification failed"; }
		try {
			if (temporary && !receipt.processCleanupIncomplete) { cleanupOwned(temporary); receipt.cleanup = { state: "complete" }; }
			else if (temporary) throw new Error("process cleanup incomplete; private workspace retained");
			else receipt.cleanup = { state: "not-created" };
		} catch (error) { receipt.status = "failure"; receipt.cleanup = { state: "incomplete", error: error instanceof Error ? error.message : "cleanup failed" }; }
		// Let signals queued during synchronous filesystem verification/cleanup reach the
		// still-installed handlers before publishing any terminal pass.
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (requestedSignal) { receipt.status = "signaled"; receipt.signal = requestedSignal; }
		if (receipt.status === "candidate_pass") receipt.status = "pass";
		writeReceipt(output, receipt);
		process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
	}
	return receipt;
}

if (import.meta.main) {
	try {
		const receipt = await verifyIsolated(parseOptions(process.argv.slice(2)));
		console.log(JSON.stringify({ status: receipt.status, receipt: path.join((receipt.selection as VerificationOptions).output, "receipt.json"), cleanup: receipt.cleanup }));
		process.exitCode = receipt.status === "pass" ? 0 : receipt.signal === "SIGINT" ? 130 : receipt.signal === "SIGTERM" ? 143 : 1;
	} catch (error) { console.error(error instanceof Error ? error.message : "isolated verification failed"); process.exitCode = 1; }
}
