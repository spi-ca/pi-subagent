import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { cleanEnvironment, collectStageReports, compilerSelection, defaultWorkspacePrefix, EXPECTED_PI_GRAPH, installCommand, parseOptions, verifyIsolated } from "../../.github/scripts/isolated-verification";
import { cleanupOwned, cloneSource, copyCache, git, literalPath, ownDirectory, readTree, resolveCommit, captureSelection, sha256, sourceState, trackedPaths, selectionManifest, verifySelection } from "../../.github/scripts/isolated-source";
import { HEAVY_STAGE_FILES, runOwnedStage, type OwnedStageOptions } from "../../.github/scripts/ci-stage";
import { captureManagedChildPiExecutableGeneration } from "../acceptance/managed-child-pi-executable";

const cacheRoot = path.join(process.cwd(), "node_modules/.cache/isolated-verification");
const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });
function temporary(): string {
	fs.mkdirSync(cacheRoot, { recursive: true });
	const root = fs.mkdtempSync(path.join(cacheRoot, "test-"));
	roots.push(root);
	return root;
}
function put(root: string, file: string, value: string | Buffer): void {
	fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
	fs.writeFileSync(path.join(root, file), value);
}
function fixture(): { root: string; source: string; env: NodeJS.ProcessEnv; commit: string; output: string } {
	const root = temporary(), source = path.join(root, "repo"), env = cleanEnvironment(root);
	fs.mkdirSync(source); fs.mkdirSync(path.join(root, "template"));
	execFileSync("git", ["init", "--template=" + path.join(root, "template"), source], { env, stdio: "ignore" });
	put(source, "a.txt", "original\n"); put(source, "delete.txt", "delete\n"); put(source, "binary.dat", Buffer.from([0, 1, 2, 255]));
	git(source, env, ["add", "--", "a.txt", "delete.txt", "binary.dat"]);
	git(source, env, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "initial"]);
	const commit = resolveCommit(source, env, "HEAD");
	return { root, source, env, commit, output: path.join(root, "output") };
}
function diagnostic(stage: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { schemaVersion: 1, stage, final: true, status: "success", durationMs: 1, toolchain: { bun: "fixture" }, platform: { os: "fixture", arch: "fixture", cpuCount: null, memoryBytes: null, filesystemCapacityBytes: null }, ownedProcess: { observedPeakProcessCount: null, observedPeakRssBytes: null, observedPeakCumulativeCpuUserTicks: null, observedPeakCumulativeCpuSystemTicks: null, observedPeakCumulativeReadBytes: null, observedPeakCumulativeWriteBytes: null }, partialErrors: [], testOutcome: { tests: 1, passed: 1, skipped: 0, failures: 0, errors: 0 }, ...overrides };
}
function stageReport(root: string, stage: string, value: unknown): void { put(root, `ci-stage-${stage}/${stage}.json`, JSON.stringify(value)); }

test("CLI requires an explicit local commit or exact tracked selection and explicit new output", () => {
	assert.equal(parseOptions(["--commit", "HEAD", "--output", "receipt"]).commit, "HEAD");
	assert.deepEqual(parseOptions(["--base", "main", "--path", "a.txt", "--output", "receipt"]).paths, ["a.txt"]);
	for (const args of [[], ["--output", "x"], ["--base", "HEAD", "--output", "x"], ["--commit", "HEAD", "--path", "a.txt", "--output", "x"], ["--commit", "HEAD", "--base", "HEAD", "--output", "x"], ["--commit", "HEAD", "--output", "x", "--whatever"], ["--commit", "HEAD", "--output", "x", "--allow-network", "--allow-network"]]) assert.throws(() => parseOptions(args));
	for (const file of ["", "../a", "/a", ":(glob)*", "a/*", "a//b", "a/./b", "a/../b", "a\\b", ".git/config", "x/.env", ".npmrc", "bunfig.toml"]) assert.throws(() => literalPath(file));
	assert.equal(literalPath("space name.txt"), "space name.txt");
});

test("local commit/ref validation rejects rev expressions, options and ambiguous branch/tag names", () => {
	const { source, env, commit } = fixture();
	assert.equal(resolveCommit(source, env, commit), commit);
	assert.equal(resolveCommit(source, env, "HEAD"), commit);
	git(source, env, ["branch", "same"]); git(source, env, ["tag", "same"]);
	for (const ref of ["same", "HEAD~1", "HEAD:package.json", "--help", "../bad", "missing"]) assert.throws(() => resolveCommit(source, env, ref));
});

test("binary selected tracked diff clones full Git identity, excludes untracked/unselected, and preserves original index/content", () => {
	const { root, source, env, commit } = fixture();
	put(source, "a.txt", "selected staged\n"); git(source, env, ["add", "--", "a.txt"]);
	put(source, "a.txt", "selected working\n"); put(source, "private-untracked.txt", "must not copy");
	put(source, "binary.dat", Buffer.from([0, 2, 255, 3])); fs.unlinkSync(path.join(source, "delete.txt"));
	const paths = trackedPaths(source, env), before = sourceState(source, env, paths), tree = readTree(source, env, commit);
	const patch = captureSelection(source, env, ["a.txt", "binary.dat"], tree);
	const clone = path.join(root, "clone"), result = cloneSource(source, clone, env, commit, patch, path.join(root, "template"));
	assert.match(result.tree, /^[0-9a-f]{40}$/);
	assert.equal(fs.readFileSync(path.join(clone, "a.txt"), "utf8"), "selected working\n");
	assert.deepEqual(fs.readFileSync(path.join(clone, "binary.dat")), Buffer.from([0, 2, 255, 3]));
	assert.equal(fs.existsSync(path.join(clone, "private-untracked.txt")), false);
	assert.equal(fs.readFileSync(path.join(clone, "delete.txt"), "utf8"), "delete\n");
	assert.equal(git(clone, env, ["rev-parse", "HEAD"]).toString().trim(), commit);
	assert.equal(git(clone, env, ["rev-parse", "--is-shallow-repository"]).toString().trim(), "false");
	assert.notEqual(fs.realpathSync(path.join(clone, ".git")), fs.realpathSync(path.join(source, ".git")));
	const object = path.join("objects", commit.slice(0, 2), commit.slice(2));
	assert.notEqual(fs.statSync(path.join(clone, ".git", object)).ino, fs.statSync(path.join(source, ".git", object)).ino, "no shared object hardlinks");
	assert.deepEqual(sourceState(source, env, paths), before);
	assert.equal(fs.readFileSync(path.join(source, "private-untracked.txt"), "utf8"), "must not copy");
	assert.throws(() => captureSelection(source, env, ["private-untracked.txt"], tree), /not tracked/);
});

test("tracked additions, rename-as-delete/add, deletion and executable mode are literal selected changes", () => {
	const { root, source, env, commit } = fixture();
	fs.renameSync(path.join(source, "a.txt"), path.join(source, "renamed.txt"));
	git(source, env, ["add", "--", "a.txt", "renamed.txt"]);
	fs.unlinkSync(path.join(source, "delete.txt")); fs.chmodSync(path.join(source, "binary.dat"), 0o755);
	const patch = captureSelection(source, env, ["a.txt", "renamed.txt", "delete.txt", "binary.dat"], readTree(source, env, commit));
	const clone = path.join(root, "clone");
	cloneSource(source, clone, env, commit, patch, path.join(root, "template"));
	assert.equal(fs.existsSync(path.join(clone, "a.txt")), false);
	assert.equal(fs.existsSync(path.join(clone, "delete.txt")), false);
	assert.equal(fs.readFileSync(path.join(clone, "renamed.txt"), "utf8"), "original\n");
	assert.ok(fs.statSync(path.join(clone, "binary.dat")).mode & 0o111, "Git executable mode survives the private umask");
});

test("symlink index/worktree, submodule tree and shallow/alternate source fail closed", () => {
	const { root, source, env, commit } = fixture(), tree = readTree(source, env, commit);
	fs.unlinkSync(path.join(source, "a.txt")); fs.symlinkSync("delete.txt", path.join(source, "a.txt"));
	assert.throws(() => captureSelection(source, env, ["a.txt"], tree), /symlink/);
	git(source, env, ["add", "--", "a.txt"]); assert.throws(() => trackedPaths(source, env), /symlink/);
	git(source, env, ["update-index", "--add", "--cacheinfo", `160000,${commit},submodule`]);
	const submoduleTree = git(source, env, ["write-tree"]).toString().trim();
	assert.throws(() => readTree(source, env, submoduleTree), /symlink|submodule/);
	put(source, ".git/shallow", `${commit}\n`);
	assert.throws(() => cloneSource(source, path.join(root, "clone"), env, commit, [], path.join(root, "template")), /nonshallow/);
	fs.unlinkSync(path.join(source, ".git/shallow")); put(source, ".git/objects/info/alternates", "do-not-read\n");
	assert.throws(() => cloneSource(source, path.join(root, "clone"), env, commit, [], path.join(root, "template")), /alternates/);
});

test("controlled provisioning is offline/frozen/script-free with private env; network requires explicit flag", () => {
	const root = temporary(), env = cleanEnvironment(root);
	for (const key of ["OPENAI_API_KEY", "KIRO_API_KEY", "NPM_TOKEN", "NODE_OPTIONS", "BUN_OPTIONS", "SSH_AUTH_SOCK", "HTTP_PROXY", "AWS_PROFILE"]) assert.equal(env[key], undefined);
	assert.equal(env.HOME, path.join(root, "home")); assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null"); assert.equal(env.PI_OFFLINE, "1");
	const offline = installCommand(path.join(root, "cache"), false), online = installCommand(path.join(root, "cache"), true);
	for (const flag of ["--offline", "--no-env-file", "--frozen-lockfile", "--ignore-scripts", "--backend=copyfile"]) assert.ok(offline.includes(flag));
	assert.deepEqual(online, offline.filter((flag) => flag !== "--offline"));
	assert.equal(parseOptions(["--commit", "HEAD", "--output", "x"]).allowNetwork, false);
});

// Placement policy tests use synthetic homes inside the project, never the caller's actual home.
function placementFixture(): { root: string; home: string; source: string } {
	const root = fs.mkdtempSync(path.join(process.cwd(), ".pi-iv-test-"));
	roots.push(root);
	const home = path.join(root, "caller-home"), source = path.join(root, "repo");
	fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(source, { mode: 0o700 });
	return { root, home, source };
}

test("default workspace placement selects canonical hidden home sibling with safe ancestry, not temporary storage", () => {
	const { root, home, source } = placementFixture();
	const unsafeTmp = path.join(root, "world-writable-tmp");
	fs.mkdirSync(unsafeTmp, { mode: 0o1777 }); fs.chmodSync(unsafeTmp, 0o1777);
	fs.symlinkSync("caller-home", path.join(root, "home-alias"));
	const before = fs.readdirSync(home);
	const prefix = defaultWorkspacePrefix(source, path.join(root, "home-alias"));
	assert.equal(prefix, path.join(fs.realpathSync(home), ".pi-iv-"));
	assert.notEqual(path.dirname(prefix), unsafeTmp);
	for (let ancestor = path.dirname(prefix); ; ancestor = path.dirname(ancestor)) {
		const stat = fs.lstatSync(ancestor);
		assert.equal(stat.mode & 0o022, 0);
		assert.ok(stat.uid === 0 || stat.uid === process.getuid!());
		assert.equal(fs.realpathSync(ancestor), ancestor);
		if (ancestor === path.dirname(ancestor)) break;
	}
	assert.deepEqual(fs.readdirSync(home), before, "choice/preflight never creates or reuses caller data");
	const owned = fs.mkdtempSync(prefix), freshHome = cleanEnvironment(owned).HOME!;
	fs.mkdirSync(freshHome, { mode: 0o700 });
	const executable = path.join(freshHome, "pi");
	fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	assert.equal(captureManagedChildPiExecutableGeneration(executable).executable, fs.realpathSync(executable), "unchanged production executable validator accepts every actual ancestor");
	console.log("SYNTHETIC_PLACEMENT_PROOF=" + JSON.stringify({ canonicalHome: true, hiddenPrefix: path.basename(prefix), safeAncestry: true, preflightNoCreation: true, existingExecutableValidator: "accepted", syntheticOnly: true }));
});

test("default workspace placement rejects writable home/ancestors before creation without chmod repair", () => {
	const { root, home, source } = placementFixture();
	for (const mode of [0o770, 0o777, 0o1777]) {
		fs.chmodSync(home, mode); // Only this creation-owned synthetic directory.
		const before = fs.lstatSync(home);
		assert.throws(() => defaultWorkspacePrefix(source, home), /safe ownership, modes and canonical ancestry/);
		assert.equal(fs.lstatSync(home).mode, before.mode);
		assert.deepEqual(fs.readdirSync(home), []);
	}
	fs.chmodSync(home, 0o700);
	const unsafe = path.join(root, "unsafe"), nested = path.join(unsafe, "private-home");
	fs.mkdirSync(unsafe, { mode: 0o700 }); fs.mkdirSync(nested, { mode: 0o700 });
	fs.chmodSync(unsafe, 0o1777);
	const unsafeExecutable = path.join(nested, "pi");
	fs.writeFileSync(unsafeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	assert.throws(() => captureManagedChildPiExecutableGeneration(unsafeExecutable), /not a safe canonical regular executable/);
	fs.unlinkSync(unsafeExecutable);
	assert.throws(() => defaultWorkspacePrefix(source, nested), /safe ownership, modes and canonical ancestry/);
	assert.equal(fs.lstatSync(unsafe).mode & 0o7777, 0o1777);
	assert.deepEqual(fs.readdirSync(nested), [], "private child cannot make an unsafe ancestor safe");
});

test("default workspace placement refuses source inventory and node_modules without a CLI picker", () => {
	const { root, home, source } = placementFixture();
	assert.throws(() => defaultWorkspacePrefix(source, source), /outside source inventory and node_modules/);
	const nested = path.join(source, "home"); fs.mkdirSync(nested, { mode: 0o700 });
	assert.throws(() => defaultWorkspacePrefix(source, nested), /outside source inventory and node_modules/);
	const modules = path.join(root, "node_modules"); fs.mkdirSync(modules, { mode: 0o700 });
	assert.throws(() => defaultWorkspacePrefix(source, modules), /outside source inventory and node_modules/);
	for (const flag of ["--temporary-parent", "--home"]) assert.throws(() => parseOptions(["--commit", "HEAD", "--output", home, flag, root]), /unknown option/);
});

test("workspace clean HOME/config/cache/tmp are fresh private children, never inherited caller data", async () => {
	const { root, source, commit, output } = fixture();
	const caller = path.join(root, "caller-data"); put(caller, "canary", "must not copy");
	const keys = ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "BUN_INSTALL_CACHE_DIR"];
	const saved = keys.map((key) => process.env[key]);
	for (const key of keys) process.env[key] = caller;
	try {
		const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async (options) => {
			for (const key of keys) {
				const directory = options.env![key]!;
				assert.notEqual(directory, caller);
				assert.equal(path.dirname(directory), path.dirname(options.cwd!));
				assert.equal(fs.lstatSync(directory).mode & 0o777, 0o700);
				assert.deepEqual(fs.readdirSync(directory), []);
			}
			return { status: "failure", exitCode: 1, signal: null, timedOut: false };
		} });
		assert.equal(receipt.sourcePreserved, true); assert.deepEqual(receipt.cleanup, { state: "complete" });
		assert.equal(fs.readFileSync(path.join(caller, "canary"), "utf8"), "must not copy");
	} finally { keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }); }
});

function cacheSnapshot(root: string): unknown[] {
	return fs.readdirSync(root).sort().flatMap((name): unknown[] => {
		const file = path.join(root, name), stat = fs.lstatSync(file);
		return [{ file, dev: stat.dev, ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
			value: stat.isSymbolicLink() ? fs.readlinkSync(file) : stat.isFile() ? sha256(fs.readFileSync(file)) : null },
			...(stat.isDirectory() ? cacheSnapshot(file) : [])];
	});
}

for (const kind of ["relative", "absolute"]) test(`explicit cache ${kind} internal Bun aliases become private relative links with independent bytes`, () => {
	const root = temporary(), seed = path.join(root, "seed"), copy = path.join(root, "copy");
	const target = "@earendil-works/pi-ai@1.4.0@@@1", alias = "@earendil-works/pi-ai/1.4.0@@@1";
	put(seed, `${target}/package.json`, '{"name":"synthetic-cache-package"}');
	put(seed, `${target}/content`, Buffer.from([0, 255, 42]));
	fs.mkdirSync(path.dirname(path.join(seed, alias)), { recursive: true });
	fs.symlinkSync(kind === "absolute" ? path.join(seed, target) : path.relative(path.dirname(alias), target), path.join(seed, alias));
	fs.symlinkSync(alias, path.join(seed, "chain"));
	fs.symlinkSync(`${alias}/content`, path.join(seed, "file-alias"));
	// The selected root's canonical context also works through an ancestor alias.
	fs.symlinkSync(".", path.join(root, "seed-parent-alias"));
	fs.chmodSync(path.join(seed, target, "content"), 0o444);
	fs.chmodSync(path.join(seed, target), 0o555);
	const before = cacheSnapshot(seed);
	try {
		copyCache(path.join(root, "seed-parent-alias", "seed"), copy);
		for (const name of [alias, "chain", "file-alias"]) {
			const link = fs.readlinkSync(path.join(copy, name));
			assert.equal(path.isAbsolute(link), false);
			assert.equal(fs.realpathSync(path.join(copy, name)), path.join(copy, name === "file-alias" ? `${target}/content` : target));
		}
		assert.deepEqual(fs.readFileSync(path.join(copy, alias, "content")), Buffer.from([0, 255, 42]));
		assert.notEqual(fs.statSync(path.join(copy, alias, "content")).ino, fs.statSync(path.join(seed, target, "content")).ino);
		fs.writeFileSync(path.join(copy, "file-alias"), "private mutation");
		assert.equal(fs.readFileSync(path.join(copy, "chain/content"), "utf8"), "private mutation");
		assert.deepEqual(cacheSnapshot(seed), before, "source bytes, link text, identities, modes and write timestamps unchanged");
		console.log("SYNTHETIC_CACHE_ALIAS_PROOF=" + JSON.stringify({ kind, relativeDestination: fs.readlinkSync(path.join(copy, alias)), privateTarget: path.relative(root, fs.realpathSync(path.join(copy, alias))), independentBytes: true, sourceUnchanged: true, syntheticOnly: true }));
	} finally { fs.chmodSync(path.join(seed, target), 0o700); }
});

for (const kind of ["external-relative", "external-absolute", "external-prefix", "absolute-dotdot", "dangling", "self", "pair", "root", "parent", "directory-cycle", "external-chain", "external-dotdot"]) test(`explicit cache rejects ${kind} aliases without modifying the source`, () => {
	const root = temporary(), seed = path.join(root, "seed"), copy = path.join(root, "copy");
	put(seed, "pkg/content", "cached"); put(root, "outside/content", "not selected");
	const link = (name: string, target: string) => fs.symlinkSync(target, path.join(seed, name));
	if (kind === "external-relative") link("alias", "../outside");
	if (kind === "external-absolute") link("alias", path.join(root, "outside"));
	if (kind === "external-prefix") { put(root, "seed-other/content", "not selected"); link("alias", path.join(root, "seed-other")); }
	if (kind === "absolute-dotdot") link("alias", `${seed}/../outside`);
	if (kind === "dangling") link("alias", "missing");
	if (kind === "self") link("alias", "alias");
	if (kind === "pair") { link("alias", "other"); link("other", "alias"); }
	if (kind === "root") link("alias", ".");
	if (kind === "parent") link("pkg/alias", "..");
	if (kind === "directory-cycle") { fs.mkdirSync(path.join(seed, "other")); link("pkg/alias", "../other"); link("other/alias", "../pkg"); }
	if (kind === "external-chain") { link("alias", "other/content"); link("other", "../outside"); }
	if (kind === "external-dotdot") { link("alias", "other/../pkg"); link("other", "../outside"); }
	const before = cacheSnapshot(seed), outsideBefore = cacheSnapshot(path.join(root, "outside"));
	assert.throws(() => copyCache(seed, copy), kind.startsWith("external") || kind === "absolute-dotdot" ? /escapes/ : kind === "dangling" ? /ENOENT/ : /cycle/);
	assert.deepEqual(cacheSnapshot(seed), before);
	assert.deepEqual(cacheSnapshot(path.join(root, "outside")), outsideBefore);
});

test("explicit cache retains entry/byte bounds, rejects root symlinks, special entries and destination reuse", () => {
	const root = temporary(), seed = path.join(root, "seed"); put(seed, "content", "cached");
	assert.throws(() => copyCache(seed, path.join(root, "entries"), { entries: 200_000, bytes: 0 }), /bound/);
	assert.throws(() => copyCache(seed, path.join(root, "bytes"), { entries: 0, bytes: 4 * 1024 ** 3 }), /bound/);
	fs.symlinkSync("seed", path.join(root, "seed-alias"));
	assert.throws(() => copyCache(path.join(root, "seed-alias"), path.join(root, "root-copy")), /symlink/);
	assert.throws(() => copyCache(seed, path.join(seed, "nested-copy")), /overlap/);
	copyCache(seed, path.join(root, "copy"));
	assert.throws(() => copyCache(seed, path.join(root, "copy")));
	execFileSync("mkfifo", [path.join(seed, "special")]);
	fs.symlinkSync("special", path.join(seed, "alias-special"));
	assert.throws(() => copyCache(seed, path.join(root, "special-copy")), /nonregular/);
});

test("four existing-schema reports require real outcomes, consistent totals, no heavy skips, no missing/duplicate evidence", async () => {
	const root = temporary();
	assert.equal((await collectStageReports(root)).core && ((await collectStageReports(root)).core as { state: string }).state, "missing");
	for (const stage of ["core", "phase0", "reaper", "sessionTail"]) stageReport(root, stage, diagnostic(stage));
	assert.ok(Object.values(await collectStageReports(root)).every((item) => (item as { state: string }).state === "pass"));
	stageReport(root, "phase0", diagnostic("phase0", { testOutcome: { tests: 2, passed: 1, skipped: 1, failures: 0, errors: 0 } }));
	assert.equal(((await collectStageReports(root)).phase0 as { state: string }).state, "failure");
	stageReport(root, "phase0", diagnostic("phase0", { testOutcome: { tests: 1, passed: 1, skipped: 0, failures: 1, errors: 0 } }));
	assert.equal(((await collectStageReports(root)).phase0 as { state: string }).state, "failure");
	stageReport(root, "core", diagnostic("core", { testOutcome: { tests: 1, passed: 1, skipped: null, failures: 0, errors: 0 } }));
	assert.equal(((await collectStageReports(root)).core as { state: string }).state, "failure");
	const value = diagnostic("phase0"); delete value.testOutcome; stageReport(root, "phase0", value);
	assert.equal(((await collectStageReports(root)).phase0 as { state: string }).state, "failure");
	stageReport(root, "phase0", { status: "success" });
	await assert.rejects(() => collectStageReports(root), /schema/);
});

test("cleanup refuses replaced ownership and leaves foreign data", () => {
	const root = temporary(), directory = path.join(root, "owned"); fs.mkdirSync(directory);
	const owner = ownDirectory(directory);
	fs.renameSync(directory, path.join(root, "original")); fs.mkdirSync(directory); put(directory, "foreign", "keep");
	assert.throws(() => cleanupOwned(owner), /identity/);
	assert.equal(fs.readFileSync(path.join(directory, "foreign"), "utf8"), "keep");
});

async function workflowFixture(): Promise<ReturnType<typeof fixture>> {
	const setup = fixture(), { source, env } = setup;
	put(source, ".env", "ISOLATED_UNTRACKED_ENV_CANARY=must-not-load\n");
	const scripts = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts;
	const devDependencies: Record<string, string> = {};
	for (const [name, version] of Object.entries(EXPECTED_PI_GRAPH)) {
		const directory = `fixture-packages/${name.split("/")[1]}`;
		put(source, `${directory}/package.json`, JSON.stringify({ name, version }));
		devDependencies[name] = `file:${directory}`;
	}
	put(source, "package.json", JSON.stringify({ name: "isolated-fixture", version: "1.0.0", devDependencies, scripts: { check: 'bun -e "process.exit(0)"', ci: scripts.ci, "test:core": scripts["test:core"], "test:phase0": scripts["test:phase0"], "test:reaper": scripts["test:reaper"], "test:session-tail": scripts["test:session-tail"] } }));
	execFileSync(process.execPath, ["install", "--no-env-file", "--ignore-scripts", "--offline", `--cache-dir=${path.join(setup.root, "fixture-cache")}`], { cwd: source, env, stdio: "pipe" });
	for (const script of ["ci-stage.ts", "ci-test-coordinator.ts", "junit-report.ts", "verify-pi-graph.ts"]) put(source, `.github/scripts/${script}`, fs.readFileSync(`.github/scripts/${script}`));
	for (const file of ["core.test.ts", ...Object.values(HEAVY_STAGE_FILES).flat()]) put(source, file, 'import { test } from "bun:test"; import assert from "node:assert/strict"; test("small actual fixture", () => { assert.equal(process.env.ISOLATED_UNTRACKED_ENV_CANARY, undefined); assert.equal(process.env.OPENAI_API_KEY, undefined); assert.equal(process.env.NODE_OPTIONS, undefined); });\n');
	git(source, env, ["add", "--", "package.json", "bun.lock", ".github", "fixture-packages", "core.test.ts", "test"]); git(source, env, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "CI fixture"]);
	setup.commit = resolveCommit(source, env, "HEAD");
	return setup;
}

test("actual offline frozen Bun install and unchanged bun run ci delegate all four production stage runners in an owned clone", { timeout: 30_000 }, async () => {
	const { root, source, commit, output } = await workflowFixture();
	const calls: OwnedStageOptions[] = [];
	const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async (options) => {
		calls.push(options);
		// Local synthetic file: packages only: this does NOT claim real Pi cache provisioning.
		// The offline installer, graph verifier and CI runners themselves execute unmodified.
		const result = await runOwnedStage(options);
		if (result.status !== "success") throw new Error(fs.readFileSync(path.join(output, `${options.stage}.log`), "utf8").slice(-4096));
		return result;
	} });
	assert.equal(receipt.status, "pass", String(receipt.error));
	assert.deepEqual(calls.map((call) => call.stage), ["install", "graph", "ci"]);
	assert.deepEqual(calls[2]!.command, [process.execPath, "--no-env-file", "run", "ci"]);
	assert.equal(receipt.sourcePreserved, true);
	assert.deepEqual(receipt.cleanup, { state: "complete" });
	assert.equal(fs.existsSync(receipt.temporaryRoot as string), false);
	for (const report of Object.values(receipt.stages as Record<string, { state: string; diagnostic: { testOutcome: { tests: number } } }>)) {
		assert.equal(report.state, "pass");
		assert.ok(report.diagnostic.testOutcome.tests > 0, "actual fixture JUnit only; never counts parsed from nested stdout");
	}
	assert.equal(fs.statSync(path.join(output, "receipt.json")).mode & 0o777, 0o600);
	assert.ok(fs.readFileSync(path.join(output, "ci.log"), "utf8").includes("small actual fixture"));
});

test("failure, timeout and cleanup-incomplete persist receipts and never promote a green result", async () => {
	for (const status of ["failure", "timed_out", "cleanup_incomplete"] as const) {
		const { root, source, commit, output } = fixture();
		const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async () => ({ status, exitCode: status === "cleanup_incomplete" ? 0 : 1, signal: null, timedOut: status === "timed_out" }) });
		assert.equal(receipt.status, "failure"); assert.equal(receipt.sourcePreserved, true);
		assert.equal((receipt.cleanup as { state: string }).state, status === "cleanup_incomplete" ? "incomplete" : "complete");
		assert.equal(JSON.parse(fs.readFileSync(path.join(output, "receipt.json"), "utf8")).status, "failure");
		assert.equal((receipt.commands as { result: { status: string } }[])[0]!.result.status, status);
	}
});

test("actual owned-command abort waits for cleanup and records signal before terminal receipt", { timeout: 15_000 }, async () => {
	const { root, source, commit, output } = fixture();
	const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async (options) => {
		const timer = setTimeout(() => process.emit("SIGTERM"), 100);
		try { return await runOwnedStage({ ...options, command: [process.execPath, "-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], timeoutMs: 5_000 }); }
		finally { clearTimeout(timer); }
	} });
	assert.equal(receipt.status, "signaled"); assert.equal(receipt.signal, "SIGTERM");
	assert.equal((receipt.cleanup as { state: string }).state, "complete");
	assert.equal(fs.existsSync(receipt.temporaryRoot as string), false);
});

test("cleanup identity mismatch fails closed; output reuse never overwrites files", async () => {
	const { root, source, commit, output } = fixture();
	const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async (options) => {
		const owned = path.dirname(options.cwd!); fs.renameSync(owned, owned + "-retained"); fs.mkdirSync(owned); put(owned, "foreign", "preserve");
		return { status: "failure", exitCode: 1, signal: null, timedOut: false };
	} });
	assert.equal(receipt.status, "failure"); assert.equal((receipt.cleanup as { state: string }).state, "incomplete");
	assert.equal(fs.readFileSync(path.join(receipt.temporaryRoot as string, "foreign"), "utf8"), "preserve");
	const hash = sha256(fs.readFileSync(path.join(output, "receipt.json")));
	await assert.rejects(() => verifyIsolated({ commit, paths: [], output, allowNetwork: false }, source, { temporaryParent: root }));
	assert.equal(sha256(fs.readFileSync(path.join(output, "receipt.json"))), hash);
});

test("source-local diff/smudge/hooks are not executed by selection or checkout", () => {
	const { root, source, env } = fixture(), marker = path.join(root, "executed");
	put(source, ".gitattributes", "*.txt filter=hostile diff=hostile\n");
	git(source, env, ["add", "--", ".gitattributes"]);
	git(source, env, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "attributes"]);
	const commit = resolveCommit(source, env, "HEAD");
	const hostile = `touch ${marker}`;
	git(source, env, ["config", "filter.hostile.smudge", hostile]);
	git(source, env, ["config", "diff.hostile.command", hostile]);
	put(source, ".git/hooks/post-checkout", `#!/bin/sh\n${hostile}\n`); fs.chmodSync(path.join(source, ".git/hooks/post-checkout"), 0o700);
	put(source, "a.txt", "changed\n");
	const patch = captureSelection(source, env, ["a.txt"], readTree(source, env, commit));
	cloneSource(source, path.join(root, "clone"), env, commit, patch, path.join(root, "template"));
	assert.equal(fs.existsSync(marker), false);
});

test("actual CI failure records production exit and validated failing/missing stage reports", { timeout: 30_000 }, async () => {
	const { root, source, env, output } = await workflowFixture();
	put(source, "core.test.ts", 'import { test } from "bun:test"; test("intentional fixture failure", () => { throw new Error("fixture failure"); });\n');
	git(source, env, ["add", "--", "core.test.ts"]);
	git(source, env, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "failing fixture"]);
	const commit = resolveCommit(source, env, "HEAD");
	const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false }, source, { temporaryParent: root });
	assert.equal(receipt.status, "failure", String(receipt.error));
	assert.equal((receipt.productionCi as { exitCode: number }).exitCode, 1);
	const stages = receipt.stages as Record<string, { state: string; diagnostic?: { status: string } }>;
	assert.equal(stages.core!.state, "failure"); assert.equal(stages.core!.diagnostic!.status, "failure");
	for (const stage of ["phase0", "reaper", "sessionTail"]) assert.equal(stages[stage]!.state, "missing");
	assert.equal(receipt.sourcePreserved, true); assert.deepEqual(receipt.cleanup, { state: "complete" });
});

test("uncertain thrown process boundary retains workspace and fails closed", async () => {
	const { root, source, commit, output } = fixture();
	const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async () => { throw new Error("uncertain spawn ownership"); } });
	assert.equal(receipt.status, "failure"); assert.equal((receipt.cleanup as { state: string }).state, "incomplete");
	assert.equal(fs.existsSync(receipt.temporaryRoot as string), true);
	assert.equal((receipt.commands as { state: string }[])[0]!.state, "ownership_uncertain");
});

test("repository-local Git config includes fail before Git can read an external file", () => {
	const { source, env } = fixture();
	fs.appendFileSync(path.join(source, ".git/config"), '\n[includeIf "gitdir:*"]\n path = /not-read/private-config\n');
	assert.throws(() => resolveCommit(source, env, "HEAD"), /configuration includes/);
});

test("diagnostic duplication, symlinks, oversized reports and non-success statuses cannot pass", async () => {
	const root = temporary();
	stageReport(root, "core", diagnostic("core"));
	put(root, "ci-stage-second/core.json", JSON.stringify(diagnostic("core")));
	await assert.rejects(() => collectStageReports(root), /duplicate/);
	fs.rmSync(path.join(root, "ci-stage-second"), { recursive: true });
	const report = path.join(root, "ci-stage-core/core.json");
	fs.writeFileSync(report, " ".repeat(8193));
	await assert.rejects(() => collectStageReports(root), /cap/);
	fs.unlinkSync(report); fs.symlinkSync("unread-target", report);
	await assert.rejects(() => collectStageReports(root), /regular/);
	fs.unlinkSync(report);
	for (const status of ["failure", "timed_out", "signaled", "spawn_error", "cleanup_incomplete"]) {
		stageReport(root, "core", diagnostic("core", { status }));
		assert.equal(((await collectStageReports(root)).core as { state: string }).state, "failure");
	}
	stageReport(root, "core", diagnostic("core", { testOutcome: { tests: 2, passed: 1, skipped: 1, failures: 0, errors: 0 } }));
	assert.equal(((await collectStageReports(root)).core as { state: string }).state, "pass", "the existing core opt-in skip policy stays intact");
});

// Repair regressions: deterministic RED was recorded against the original working-tree diff implementation.
for (const driver of ["clean", "process"]) test(`raw selection never starts source-local filter.${driver}`, () => {
	const { root, source, env } = fixture(), marker = path.join(root, `${driver}-started`);
	put(source, ".gitattributes", "*.txt filter=hostile\n");
	git(source, env, ["add", "--", ".gitattributes"]);
	git(source, env, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "attributes"]);
	const commit = resolveCommit(source, env, "HEAD");
	git(source, env, ["config", `filter.hostile.${driver}`, `touch ${marker}; ${driver === "clean" ? "cat" : "exit 1"}`]);
	put(source, "a.txt", "explicit raw working bytes, different size\n");
	let patch: ReturnType<typeof captureSelection> | undefined;
	try { patch = captureSelection(source, env, ["a.txt"], readTree(source, env, commit)); } catch { /* assert no command start even if Git failed */ }
	assert.equal(fs.existsSync(marker), false, `${driver} command must not even start in original source`);
	assert.ok(patch);
	const clone = path.join(root, "clone");
	cloneSource(source, clone, env, commit, patch, path.join(root, "template"));
	assert.equal(fs.readFileSync(path.join(clone, "a.txt"), "utf8"), "explicit raw working bytes, different size\n");
	assert.equal(fs.existsSync(marker), false);
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) test(`raw selection honors explicit working bytes despite ${flag}`, () => {
	const { root, source, env, commit } = fixture();
	git(source, env, ["update-index", flag, "--", "a.txt", "binary.dat", "delete.txt"]);
	put(source, "a.txt", "explicit hidden working content\n");
	put(source, "binary.dat", Buffer.from([0, 255, 17, 0, 42]));
	fs.unlinkSync(path.join(source, "delete.txt"));
	const paths = trackedPaths(source, env), before = sourceState(source, env, paths);
	const patch = captureSelection(source, env, ["a.txt", "binary.dat", "delete.txt"], readTree(source, env, commit));
	const clone = path.join(root, "clone");
	cloneSource(source, clone, env, commit, patch, path.join(root, "template"));
	assert.equal(fs.readFileSync(path.join(clone, "a.txt"), "utf8"), "explicit hidden working content\n");
	assert.deepEqual(fs.readFileSync(path.join(clone, "binary.dat")), Buffer.from([0, 255, 17, 0, 42]));
	assert.equal(fs.existsSync(path.join(clone, "delete.txt")), false);
	assert.deepEqual(sourceState(source, env, paths), before);
});

test("raw selection honors actual executable state with core.fileMode=false and base-only deleted paths", () => {
	const { root, source, env, commit } = fixture();
	git(source, env, ["config", "core.fileMode", "false"]);
	git(source, env, ["update-index", "--force-remove", "--", "delete.txt"]);
	fs.unlinkSync(path.join(source, "delete.txt"));
	fs.chmodSync(path.join(source, "a.txt"), 0o755);
	put(source, "new.dat", Buffer.from([0, 9, 255])); git(source, env, ["add", "--", "new.dat"]);
	const paths = [...trackedPaths(source, env), "delete.txt"], before = sourceState(source, env, paths);
	const patch = captureSelection(source, env, ["a.txt", "delete.txt", "new.dat"], readTree(source, env, commit));
	const clone = path.join(root, "clone");
	cloneSource(source, clone, env, commit, patch, path.join(root, "template"));
	assert.ok(fs.statSync(path.join(clone, "a.txt")).mode & 0o111, "actual executable selection cannot be hidden by source config");
	assert.equal(fs.existsSync(path.join(clone, "delete.txt")), false);
	assert.deepEqual(fs.readFileSync(path.join(clone, "new.dat")), Buffer.from([0, 9, 255]));
	assert.deepEqual(sourceState(source, env, paths), before);
});


test("raw selection bypasses cloned text/ident attributes; private binary patch and blobs match the source manifest", () => {
	const { root, source, env } = fixture();
	put(source, ".gitattributes", "*.txt text eol=crlf ident filter=hostile\n");
	git(source, env, ["add", "--", ".gitattributes"]);
	git(source, env, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "attributes"]);
	const commit = resolveCommit(source, env, "HEAD"), tree = readTree(source, env, commit);
	const raw = Buffer.from("raw $Id$\r\nkeep CRLF\r\n"), binary = Buffer.from([0, 255, 42, 0]);
	put(source, "a.txt", raw); put(source, "binary.dat", binary);
	fs.unlinkSync(path.join(source, "delete.txt")); fs.chmodSync(path.join(source, "a.txt"), 0o755);
	const selection = captureSelection(source, env, ["a.txt", "binary.dat", "delete.txt"], tree);
	const clone = path.join(root, "clone"), result = cloneSource(source, clone, env, commit, selection, path.join(root, "template"));
	assert.deepEqual(verifySelection(clone, selection), selectionManifest(selection));
	assert.deepEqual(git(clone, env, ["cat-file", "blob", `${result.tree}:a.txt`]), raw);
	assert.deepEqual(git(clone, env, ["cat-file", "blob", `${result.tree}:binary.dat`]), binary);
	const patch = fs.readFileSync(path.join(root, "selected.patch"));
	assert.equal(result.patchSha256, sha256(patch)); assert.ok(patch.includes(Buffer.from("GIT binary patch")));
	// Replay ONLY into another owned clone's index. Compare exact resulting raw tree,
	// not a working-tree Git diff that could run conversions or hide stat-cache flags.
	const replay = path.join(root, "replay"); fs.mkdirSync(replay);
	const replayClone = path.join(replay, "source");
	cloneSource(source, replayClone, env, commit, [], path.join(root, "template"));
	git(replayClone, env, ["apply", "--cached", "--binary", "--", path.join(root, "selected.patch")]);
	assert.equal(git(replayClone, env, ["write-tree"]).toString().trim(), result.tree);
});

test("raw selection handles executable removal regardless of index mode and core.fileMode=false", () => {
	const { root, source, env } = fixture();
	fs.chmodSync(path.join(source, "a.txt"), 0o755); git(source, env, ["add", "--", "a.txt"]);
	git(source, env, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "executable"]);
	const commit = resolveCommit(source, env, "HEAD");
	git(source, env, ["config", "core.fileMode", "false"]); git(source, env, ["update-index", "--skip-worktree", "--", "a.txt"]);
	fs.chmodSync(path.join(source, "a.txt"), 0o644);
	const selection = captureSelection(source, env, ["a.txt"], readTree(source, env, commit)), clone = path.join(root, "clone");
	const result = cloneSource(source, clone, env, commit, selection, path.join(root, "template"));
	assert.equal(fs.statSync(path.join(clone, "a.txt")).mode & 0o111, 0);
	assert.equal(result.entries.find((entry) => entry.path === "a.txt")!.mode, "100644");
	assert.deepEqual(verifySelection(clone, selection), selectionManifest(selection));
});

for (const change of ["bytes", "executable", "deletion"]) test(`selected manifest rejects install-time ${change} drift before graph/CI`, async () => {
	const { root, source, commit, output } = fixture();
	put(source, "a.txt", "selected working\n"); fs.unlinkSync(path.join(source, "delete.txt"));
	const calls: string[] = [];
	const receipt = await verifyIsolated({ base: commit, paths: ["a.txt", "delete.txt"], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async (options) => {
		calls.push(options.stage);
		if (change === "bytes") put(options.cwd!, "a.txt", "wrong\n");
		if (change === "executable") fs.chmodSync(path.join(options.cwd!, "a.txt"), 0o755);
		if (change === "deletion") put(options.cwd!, "delete.txt", "should stay missing\n");
		return { status: "success", exitCode: 0, signal: null, timedOut: false };
	} });
	assert.equal(receipt.status, "failure"); assert.match(String(receipt.error), /manifest mismatch/);
	assert.deepEqual(calls, ["install"]); assert.equal(receipt.sourcePreserved, true);
	assert.deepEqual((receipt.selectionProof as { beforeInstall: unknown }).beforeInstall, receipt.selectedManifest);
	assert.deepEqual(receipt.cleanup, { state: "complete" });
});

test("selected receipt proves source-to-clone equality before/after install and final verification", async () => {
	const { root, source, env, commit, output } = fixture();
	git(source, env, ["update-index", "--assume-unchanged", "--", "a.txt"]);
	put(source, "a.txt", "hidden raw bytes\n"); fs.chmodSync(path.join(source, "a.txt"), 0o755);
	fs.unlinkSync(path.join(source, "delete.txt"));
	const receipt = await verifyIsolated({ base: commit, paths: ["a.txt", "delete.txt"], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async (options) => {
		assert.equal(fs.readFileSync(path.join(options.cwd!, "a.txt"), "utf8"), "hidden raw bytes\n");
		if (options.stage === "ci") for (const stage of ["core", "phase0", "reaper", "sessionTail"]) stageReport(options.workloadDiagnosticsDirectory!, stage, diagnostic(stage));
		return { status: "success", exitCode: 0, signal: null, timedOut: false };
	} });
	// This fixture injects successful command results, NOT a full repository CI claim.
	assert.equal(receipt.status, "pass", String(receipt.error));
	for (const value of Object.values(receipt.selectionProof as Record<string, unknown>)) assert.deepEqual(value, receipt.selectedManifest);
	assert.equal(Object.keys(receipt.selectionProof as object).length, 3);
	assert.equal(receipt.sourcePreserved, true);
	console.log("SYNTHETIC_SELECTION_PROOF=" + JSON.stringify({ selectedManifest: receipt.selectedManifest, selectedDiffSha256: receipt.selectedDiffSha256, selectionProof: receipt.selectionProof, sourcePreserved: receipt.sourcePreserved, syntheticCommands: true }));
});

test("base-only selected deletion participates in captured original stability even after index removal", async () => {
	const { root, source, env, commit, output } = fixture();
	git(source, env, ["update-index", "--force-remove", "--", "delete.txt"]); fs.unlinkSync(path.join(source, "delete.txt"));
	const receipt = await verifyIsolated({ base: commit, paths: ["delete.txt"], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async () => {
		put(source, "delete.txt", "concurrent original mutation\n");
		return { status: "failure", exitCode: 1, signal: null, timedOut: false };
	} });
	assert.equal(receipt.status, "failure"); assert.equal(receipt.sourcePreserved, false);
	assert.match(String(receipt.sourcePreservationError), /original source changed/);
});

test("selected raw captures reject oversized files, ancestor symlinks and directories without Git conversions", () => {
	const { root, source, env, commit } = fixture(), tree = readTree(source, env, commit);
	const file = path.join(source, "a.txt"); fs.truncateSync(file, 64 * 1024 * 1024 + 1);
	assert.throws(() => captureSelection(source, env, ["a.txt"], tree), /read bound/);
	fs.unlinkSync(file); fs.mkdirSync(file);
	assert.throws(() => captureSelection(source, env, ["a.txt"], tree), /regular file/);
	fs.rmdirSync(file); fs.symlinkSync(root, file);
	assert.throws(() => captureSelection(source, env, ["a.txt/escaped"], [...tree, { path: "a.txt/escaped", mode: "100644", object: commit }]), /symlink/);
});


test("selected deletion restored by CI is rejected at final verification, even with green command reports", async () => {
	const { root, source, commit, output } = fixture(); fs.unlinkSync(path.join(source, "delete.txt"));
	const receipt = await verifyIsolated({ base: commit, paths: ["delete.txt"], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async (options) => {
		if (options.stage === "ci") {
			for (const stage of ["core", "phase0", "reaper", "sessionTail"]) stageReport(options.workloadDiagnosticsDirectory!, stage, diagnostic(stage));
			put(options.cwd!, "delete.txt", "unexpected restoration\n");
		}
		return { status: "success", exitCode: 0, signal: null, timedOut: false };
	} });
	assert.equal(receipt.status, "failure"); assert.match(String(receipt.preservationError), /manifest mismatch/);
	assert.equal(receipt.sourcePreserved, true); assert.deepEqual(receipt.cleanup, { state: "complete" });
});

test("clean environment permits an actual shallow file:// fixture clone without wrapper overrides", () => {
	const { root, source, env, commit } = fixture(), clone = path.join(root, "shallow");
	// Raw Git is intentional: the source helper independently allows file transport.
	execFileSync("git", ["clone", "--depth=1", `file://${source}`, clone], { cwd: root, env, stdio: "pipe", timeout: 5_000 });
	assert.equal(execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: clone, env, encoding: "utf8" }).trim(), "true");
	assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, env, encoding: "utf8" }).trim(), commit);
	assert.equal(fs.readFileSync(path.join(clone, "a.txt"), "utf8"), "original\n");
});

test("clean environment still rejects HTTPS and SSH at Git transport selection before any connection", () => {
	const { root, source, env } = fixture();
	// Check the effective policy before attempting URLs; no remote/network helper is allowed.
	assert.equal(execFileSync("git", ["config", "--get-regexp", "^protocol\\."], { cwd: source, env, encoding: "utf8" }), "protocol.allow never\nprotocol.file.allow always\n");
	assert.equal(env.GIT_CONFIG_NOSYSTEM, "1"); assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
	assert.equal(env.GIT_TERMINAL_PROMPT, "0"); assert.equal(env.SSH_AUTH_SOCK, undefined);
	for (const protocol of ["https", "ssh"]) {
		assert.throws(() => execFileSync("git", ["ls-remote", `${protocol}://example.invalid/fixture.git`], { cwd: source, env, stdio: "pipe", timeout: 5_000 }), (error: unknown) => {
			const failure = error as { status: number; signal: string | null; stdout: Buffer; stderr: Buffer };
			assert.equal(failure.status, 128); assert.equal(failure.signal, null);
			assert.equal(failure.stdout.toString(), "");
			assert.equal(failure.stderr.toString(), `fatal: transport '${protocol}' not allowed\n`);
			return true;
		});
	}
});

// Compiler selection regressions: synthetic executables only; never inspect a host toolchain.
function compilerTemporary(): string {
	const parent = path.join(process.cwd(), "node_modules/.cache/isolated-verification-compiler-fix");
	fs.mkdirSync(parent, { recursive: true });
	const root = fs.mkdtempSync(path.join(parent, "test-"));
	roots.push(root);
	return root;
}
function compilerFixture(): ReturnType<typeof fixture> {
	const root = compilerTemporary(), source = path.join(root, "repo"), env = cleanEnvironment(root);
	fs.mkdirSync(source); fs.mkdirSync(path.join(root, "template"));
	execFileSync("git", ["init", "--template=" + path.join(root, "template"), source], { env, stdio: "ignore" });
	put(source, "a.txt", "compiler fixture source\n");
	git(source, env, ["add", "--", "a.txt"]);
	git(source, env, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "compiler fixture"]);
	return { root, source, env, commit: resolveCommit(source, env, "HEAD"), output: path.join(root, "output") };
}
function fakeCompiler(root: string): { selected: string; executable: string; target: string; directory: string } {
	const directory = path.join(root, "toolchain/bin"), target = path.join(root, "toolchain/lib/multicall-wrapper");
	put(root, "toolchain/lib/multicall-wrapper", `#!/bin/sh
[ "\${0##*/}" = fixture-cc ] || { printf 'wrong invocation basename\n' >&2; exit 87; }
if [ "$1" = --version ]; then printf 'synthetic compiler only\n'; exit 0; fi
[ "$#" = 3 ] && [ "$2" = -o ] && [ -f "$1" ] && [ -d "$TMPDIR" ] || exit 88
as --version > "$TMPDIR/as-proof" || exit 89
ld --version > "$TMPDIR/ld-proof" || exit 90
printf '#!/bin/sh\nprintf "synthetic fixture binary\\n"\n' > "$3"
chmod 700 "$3"
`);
	fs.chmodSync(target, 0o700);
	for (const tool of ["as", "ld"]) {
		put(root, `toolchain/bin/${tool}`, `#!/bin/sh\nprintf 'synthetic ${tool} only\\n'\n`);
		fs.chmodSync(path.join(directory, tool), 0o700);
	}
	fs.symlinkSync("../lib/multicall-wrapper", path.join(directory, "fixture-cc"));
	fs.symlinkSync("toolchain/bin", path.join(root, "selected-bin"));
	return { selected: path.join(root, "selected-bin/fixture-cc"), executable: path.join(directory, "fixture-cc"), target, directory };
}
const rejectedCompilerInheritance = ["OPENAI_API_KEY", "KIRO_API_KEY", "NPM_TOKEN", "NODE_OPTIONS", "BUN_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "SSH_AUTH_SOCK", "HTTP_PROXY", "AWS_PROFILE", "GCC_EXEC_PREFIX", "COMPILER_PATH", "LIBRARY_PATH", "CPATH"];
function withHostileCompilerEnvironment(body: () => void | Promise<void>): Promise<void> {
	const keys = ["CC", "PATH", ...rejectedCompilerInheritance], saved = keys.map((key) => process.env[key]);
	for (const key of keys) process.env[key] = key === "PATH" ? "/never-search-host-path" : "untrusted-inherited-value";
	return Promise.resolve().then(body).finally(() => keys.forEach((key, index) => {
		if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index];
	}));
}

test("compiler CLI is optional, absolute-only, and rejects duplicate or missing values", () => {
	const root = compilerTemporary(), selected = path.join(root, "not-probed-by-parser");
	const base = ["--commit", "HEAD", "--output", path.join(root, "output")];
	assert.equal(parseOptions(base).cc, undefined);
	assert.equal(parseOptions([...base, "--cc", selected]).cc, selected);
	for (const tail of [["--cc"], ["--cc", ""], ["--cc", "--allow-network"], ["--cc", "cc"], ["--cc", "./cc"], ["--cc", selected, "--cc", selected]]) assert.throws(() => parseOptions([...base, ...tail]));
	assert.throws(() => parseOptions([]), /\[--cc <absolute-executable>\]/);
});

test("compiler multicall alias keeps argv0 basename, canonicalizes only its parent, and locates sibling as/ld", () => {
	const root = compilerTemporary(), fake = fakeCompiler(root), workspace = path.join(root, "workspace");
	fs.mkdirSync(path.join(workspace, "tmp"), { recursive: true });
	const env = cleanEnvironment(workspace, process.execPath, fake.selected);
	assert.deepEqual(compilerSelection(fake.selected), { executable: fake.executable, target: fake.target, directory: fake.directory });
	assert.equal(env.CC, fake.executable);
	assert.deepEqual(env.PATH!.split(path.delimiter), [...new Set([path.dirname(process.execPath), fake.directory, "/usr/local/bin", "/usr/bin", "/bin"])]);
	assert.ok(!env.PATH!.split(path.delimiter).includes(path.dirname(fake.target)), "target's directory is not implicitly added");
	assert.equal(spawnSync(fake.target, ["--version"], { cwd: root, env }).status, 87, "synthetic target intentionally requires alias argv0");
	const version = spawnSync(env.CC!, ["--version"], { cwd: root, env, encoding: "utf8" });
	assert.equal(version.status, 0, String(version.error)); assert.equal(version.stdout, "synthetic compiler only\n");
	put(root, "tiny.c", "int main(void) { return 0; }\n");
	const binary = path.join(root, "synthetic-binary"), compiled = spawnSync(env.CC!, [path.join(root, "tiny.c"), "-o", binary], { cwd: root, env, encoding: "utf8" });
	assert.equal(compiled.status, 0, compiled.stderr || String(compiled.error));
	assert.equal(fs.readFileSync(path.join(env.TMPDIR!, "as-proof"), "utf8"), "synthetic as only\n");
	assert.equal(fs.readFileSync(path.join(env.TMPDIR!, "ld-proof"), "utf8"), "synthetic ld only\n");
	assert.equal(spawnSync(binary, [], { cwd: root, env, encoding: "utf8" }).stdout, "synthetic fixture binary\n");
	console.log("SYNTHETIC_COMPILER_MULTICALL_PROOF=" + JSON.stringify({ selected: fake.selected, ...compilerSelection(fake.selected), version: version.stdout.trim(), directTargetStatus: 87, compileFixture: true, siblingAsLd: true, syntheticOnly: true }));
});

test("compiler default ignores inherited CC and host PATH with an independent fresh private environment", async () => {
	const root = compilerTemporary(), first = path.join(root, "first"), second = path.join(root, "second");
	await withHostileCompilerEnvironment(() => {
		const env = cleanEnvironment(first), other = cleanEnvironment(second);
		assert.equal(env.CC, undefined); assert.equal(other.CC, undefined);
		assert.deepEqual(env.PATH!.split(path.delimiter), [...new Set([path.dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"])]);
		assert.equal(env.PATH, other.PATH); assert.notEqual(env.HOME, other.HOME); assert.notEqual(env.TMPDIR, other.TMPDIR);
		for (const key of rejectedCompilerInheritance) { assert.equal(env[key], undefined); assert.equal(other[key], undefined); }
		assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(second), false, "environment construction never writes HOME");
	});
});

test("compiler invalid selections fail closed before workspace creation, install, graph or CI", async () => {
	for (const kind of ["empty", "relative", "missing", "nonexec", "directory", "dangling", "writable-file", "unsafe-alias-parent", "unsafe-target-parent", "setuid", "nul"]) {
		const { root, source, env, commit, output } = compilerFixture(), fake = fakeCompiler(root);
		let cc = fake.selected;
		if (kind === "empty") cc = "";
		if (kind === "relative") cc = "toolchain/bin/fixture-cc";
		if (kind === "missing") cc = path.join(root, "missing");
		if (kind === "nonexec") fs.chmodSync(fake.target, 0o600);
		if (kind === "directory") cc = fake.directory;
		if (kind === "dangling") { cc = path.join(root, "dangling"); fs.symlinkSync("missing", cc); }
		if (kind === "writable-file") fs.chmodSync(fake.target, 0o722);
		if (kind === "unsafe-alias-parent") fs.chmodSync(fake.directory, 0o777);
		if (kind === "unsafe-target-parent") fs.chmodSync(path.dirname(fake.target), 0o777);
		if (kind === "setuid") fs.chmodSync(fake.target, 0o4700);
		if (kind === "nul") cc += "\0";
		const before = sourceState(source, env, trackedPaths(source, env));
		const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false, cc }, source, { temporaryParent: root, runCommand: async () => { assert.fail("invalid compiler must not reach any command"); } });
		assert.equal(receipt.status, "failure", kind); assert.deepEqual(receipt.commands, [], kind);
		assert.equal(receipt.temporaryRoot, undefined, kind); assert.deepEqual(receipt.cleanup, { state: "not-created" });
		assert.equal(JSON.parse(fs.readFileSync(path.join(output, "receipt.json"), "utf8")).status, "failure");
		assert.deepEqual(sourceState(source, env, trackedPaths(source, env)), before);
	}
});

test("compiler selection reaches every private command and persisted receipt without credential or loader inheritance", async () => {
	const { root, source, env, commit, output } = compilerFixture(), fake = fakeCompiler(root), calls: string[] = [];
	const before = sourceState(source, env, trackedPaths(source, env));
	await withHostileCompilerEnvironment(async () => {
		const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false, cc: fake.selected }, source, { temporaryParent: root, runCommand: async (options) => {
			calls.push(options.stage);
			assert.equal(options.env!.CC, fake.executable);
			assert.deepEqual(options.env!.PATH!.split(path.delimiter), [...new Set([path.dirname(process.execPath), fake.directory, "/usr/local/bin", "/usr/bin", "/bin"])]);
			for (const key of rejectedCompilerInheritance) assert.equal(options.env![key], undefined);
			assert.equal(fs.lstatSync(options.env!.TMPDIR!).mode & 0o777, 0o700);
			const version = spawnSync(options.env!.CC!, ["--version"], { cwd: options.cwd, env: options.env, encoding: "utf8" });
			assert.equal(version.status, 0, String(version.error)); assert.equal(version.stdout, "synthetic compiler only\n");
			if (options.stage === "ci") for (const stage of ["core", "phase0", "reaper", "sessionTail"]) stageReport(options.workloadDiagnosticsDirectory!, stage, diagnostic(stage));
			return { status: "success", exitCode: 0, signal: null, timedOut: false };
		} });
		assert.equal(receipt.status, "pass", String(receipt.error)); assert.deepEqual(calls, ["install", "graph", "ci"]);
		const persisted = JSON.parse(fs.readFileSync(path.join(output, "receipt.json"), "utf8"));
		assert.deepEqual(persisted.toolchain.compiler, { requested: fake.selected, executable: fake.executable, target: fake.target, directory: fake.directory });
		assert.deepEqual(persisted.toolchain, receipt.toolchain);
		assert.equal(receipt.sourcePreserved, true); assert.deepEqual(receipt.cleanup, { state: "complete" });
		assert.equal(fs.existsSync(receipt.temporaryRoot as string), false);
		console.log("SYNTHETIC_COMPILER_RECEIPT_PROOF=" + JSON.stringify({ toolchain: persisted.toolchain, calls, privateTmp: true, rejectedInheritance: rejectedCompilerInheritance, sourcePreserved: true, cleanup: receipt.cleanup, syntheticCommands: true, realInstallGraphCiNotRun: true }));
	});
	assert.deepEqual(sourceState(source, env, trackedPaths(source, env)), before);
});

test("compiler omitted in workflow keeps default search and records no explicit selection", async () => {
	const { root, source, commit, output } = compilerFixture();
	await withHostileCompilerEnvironment(async () => {
		const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false }, source, { temporaryParent: root, runCommand: async (options) => {
			assert.equal(options.env!.CC, undefined);
			assert.deepEqual(options.env!.PATH, cleanEnvironment(root).PATH);
			return { status: "failure", exitCode: 1, signal: null, timedOut: false };
		} });
		assert.equal(receipt.status, "failure");
		assert.equal((receipt.toolchain as Record<string, unknown>).compiler, undefined);
		assert.equal((receipt.commands as unknown[]).length, 1);
		assert.equal(receipt.sourcePreserved, true); assert.deepEqual(receipt.cleanup, { state: "complete" });
	});
});

// Compiler-safety regressions are appended: the original 58 test bodies remain unchanged.
async function rejectedCompilerProbe(kind: string, configure: (root: string, fake: ReturnType<typeof fakeCompiler>) => string): Promise<Record<string, unknown>> {
	const { root, source, commit, output } = compilerFixture(), fake = fakeCompiler(root), marker = path.join(root, "compiler-executed");
	fs.writeFileSync(fake.target, `#!/bin/sh\nprintf invoked > '${marker}'\n`, { mode: 0o700 });
	const cc = configure(root, fake);
	let accepted: ReturnType<typeof compilerSelection> | undefined, selectedPath: string | undefined;
	try { accepted = compilerSelection(cc); selectedPath = cleanEnvironment(root, process.execPath, cc).PATH; } catch { /* expected rejection */ }
	const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false, cc }, source, { temporaryParent: root, runCommand: async (options) => {
		// Only the synthetic marker script can run here; no install, graph or CI is executed.
		const result = spawnSync(options.env!.CC!, ["--version"], { cwd: options.cwd, env: options.env });
		assert.equal(result.status, 0, String(result.error));
		return { status: "failure", exitCode: 1, signal: null, timedOut: false };
	} });
	const persisted = JSON.parse(fs.readFileSync(path.join(output, "receipt.json"), "utf8"));
	const proof = { kind, accepted: accepted !== undefined, pathEntries: selectedPath?.split(path.delimiter), compilerExecuted: fs.existsSync(marker), status: receipt.status, commands: (receipt.commands as unknown[]).length, workspaceCreated: receipt.temporaryRoot !== undefined, cleanup: receipt.cleanup, persistedMatches: JSON.stringify(persisted) === JSON.stringify(receipt), syntheticOnly: true };
	console.log("SYNTHETIC_COMPILER_REJECTION_PROOF=" + JSON.stringify(proof));
	return proof;
}
function assertCompilerRejected(proof: Record<string, unknown>): void {
	assert.equal(proof.accepted, false, String(proof.kind));
	assert.equal(proof.compilerExecuted, false, String(proof.kind));
	assert.equal(proof.status, "failure"); assert.equal(proof.commands, 0);
	assert.equal(proof.workspaceCreated, false); assert.deepEqual(proof.cleanup, { state: "not-created" });
	assert.equal(proof.persistedMatches, true);
}

test("compiler safety rejects unsafe intermediate aliases and dotdot traversal despite safe endpoints", async () => {
	const proofs = [];
	for (const kind of ["writable-hop", "writable-dotdot-target", "writable-dotdot-request", "writable-directory-reentry"]) {
		proofs.push(await rejectedCompilerProbe(kind, (root, fake) => {
			const unsafe = path.join(root, "unsafe");
			fs.mkdirSync(unsafe, { mode: 0o700 }); fs.chmodSync(unsafe, 0o777);
			if (kind === "writable-hop") {
				fs.symlinkSync("../toolchain/lib/multicall-wrapper", path.join(unsafe, "hop"));
				fs.unlinkSync(fake.executable); fs.symlinkSync("../../unsafe/hop", fake.executable);
			} else if (kind === "writable-dotdot-target") {
				fs.unlinkSync(fake.executable); fs.symlinkSync("../../unsafe/../toolchain/lib/multicall-wrapper", fake.executable);
			} else if (kind === "writable-dotdot-request") {
				return `${unsafe}/../toolchain/bin/fixture-cc`; // Do not path.join away the unsafe traversal.
			} else {
				fs.symlinkSync("../toolchain/bin", path.join(unsafe, "reentry"));
				fs.unlinkSync(path.join(root, "selected-bin")); fs.symlinkSync("unsafe/reentry", path.join(root, "selected-bin"));
			}
			assert.equal(fs.realpathSync(fake.selected), fake.target, "safe final target hides the unsafe hop");
			assert.equal(fs.realpathSync(path.dirname(fake.selected)), fake.directory, "safe invocation parent hides the unsafe hop");
			return fake.selected;
		}));
	}
	proofs.forEach(assertCompilerRejected);
});

test("compiler safety rejects PATH-delimiter canonical invocation directory before workspace creation", async () => {
	const proof = await rejectedCompilerProbe("delimiter-directory", (root, fake) => {
		const directory = path.join(root, `toolchain${path.delimiter}extra`);
		fs.renameSync(fake.directory, directory);
		fs.unlinkSync(path.join(root, "selected-bin"));
		fs.symlinkSync(path.basename(directory), path.join(root, "selected-bin"));
		// Fix the relative final alias after moving it; target and all directories are safe.
		fs.unlinkSync(path.join(directory, "fixture-cc"));
		fs.symlinkSync("../toolchain/lib/multicall-wrapper", path.join(directory, "fixture-cc"));
		return fake.selected;
	});
	assertCompilerRejected(proof);
});

test("compiler safety accepts safe chained aliases with dotdot and preserves multicall sibling lookup and receipt", async () => {
	const { root, source, commit, output } = compilerFixture(), fake = fakeCompiler(root);
	fs.mkdirSync(path.join(root, "toolchain/aliases"), { mode: 0o700 });
	fs.unlinkSync(fake.executable); fs.symlinkSync("../aliases/first", fake.executable);
	fs.symlinkSync("second", path.join(root, "toolchain/aliases/first"));
	fs.symlinkSync("../lib/multicall-wrapper", path.join(root, "toolchain/aliases/second"));
	const calls: string[] = [];
	const receipt = await verifyIsolated({ commit, paths: [], output, allowNetwork: false, cc: fake.selected }, source, { temporaryParent: root, runCommand: async (options) => {
		calls.push(options.stage);
		assert.equal(options.env!.CC, fake.executable);
		assert.deepEqual(options.env!.PATH!.split(path.delimiter), [...new Set([path.dirname(process.execPath), fake.directory, "/usr/local/bin", "/usr/bin", "/bin"])]);
		const version = spawnSync(options.env!.CC!, ["--version"], { cwd: options.cwd, env: options.env, encoding: "utf8" });
		assert.equal(version.status, 0, version.stderr); assert.equal(version.stdout, "synthetic compiler only\n");
		put(options.cwd!, "tiny.c", "int main(void) { return 0; }\n");
		const binary = path.join(options.cwd!, "synthetic-binary");
		const compiled = spawnSync(options.env!.CC!, [path.join(options.cwd!, "tiny.c"), "-o", binary], { cwd: options.cwd, env: options.env, encoding: "utf8" });
		assert.equal(compiled.status, 0, compiled.stderr);
		for (const tool of ["as", "ld"]) assert.equal(fs.readFileSync(path.join(options.env!.TMPDIR!, `${tool}-proof`), "utf8"), `synthetic ${tool} only\n`);
		assert.equal(spawnSync(binary, [], { cwd: options.cwd, env: options.env, encoding: "utf8" }).stdout, "synthetic fixture binary\n");
		if (options.stage === "ci") for (const stage of ["core", "phase0", "reaper", "sessionTail"]) stageReport(options.workloadDiagnosticsDirectory!, stage, diagnostic(stage));
		return { status: "success", exitCode: 0, signal: null, timedOut: false };
	} });
	assert.equal(receipt.status, "pass", String(receipt.error)); assert.deepEqual(calls, ["install", "graph", "ci"]);
	const persisted = JSON.parse(fs.readFileSync(path.join(output, "receipt.json"), "utf8"));
	assert.deepEqual(persisted.toolchain.compiler, { requested: fake.selected, executable: fake.executable, target: fake.target, directory: fake.directory });
	assert.equal(receipt.sourcePreserved, true); assert.deepEqual(receipt.cleanup, { state: "complete" });
	console.log("SYNTHETIC_COMPILER_SAFE_CHAIN_PROOF=" + JSON.stringify({ calls, receiptCompiler: persisted.toolchain.compiler, aliasBasename: true, siblingAsLd: true, compileFixture: true, sourcePreserved: true, syntheticOnly: true, realInstallGraphCiNotRun: true }));
});

test("compiler safety bounds alias loops and fails closed for dangling or nondirectory intermediate entries", async () => {
	const proofs = [];
	for (const kind of ["cycle", "hop-limit", "dangling-hop", "file-intermediate"]) proofs.push(await rejectedCompilerProbe(kind, (root, fake) => {
		fs.unlinkSync(fake.executable);
		if (kind === "cycle") {
			fs.symlinkSync("cycle", fake.executable); fs.symlinkSync("fixture-cc", path.join(fake.directory, "cycle"));
		} else if (kind === "hop-limit") {
			fs.symlinkSync("hop-0", fake.executable);
			for (let index = 0; index < 41; index += 1) fs.symlinkSync(index === 40 ? "../lib/multicall-wrapper" : `hop-${index + 1}`, path.join(fake.directory, `hop-${index}`));
		} else fs.symlinkSync(kind === "dangling-hop" ? "missing/hop" : "../lib/multicall-wrapper/../multicall-wrapper", fake.executable);
		return fake.selected;
	}));
	proofs.forEach(assertCompilerRejected);
});
