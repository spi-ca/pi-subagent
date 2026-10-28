import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type Identity = { dev: number; ino: number };
export type OwnedDirectory = Identity & { directory: string };
export type TreeEntry = { path: string; mode: string; object: string };
export type SelectedFile = { path: string; missing: true } | { path: string; mode: string; sha256: string; bytes: Buffer };
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const MAX_BYTES = 64 * 1024 * 1024;

export function boundedRead(file: string, limit = MAX_BYTES): Buffer {
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > limit) throw new Error("file is not regular or exceeds read bound");
		const buffer = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const count = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (!count) throw new Error("file changed during bounded read");
			offset += count;
		}
		const after = fs.fstatSync(fd);
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.mode !== stat.mode) throw new Error("file changed during bounded read");
		return buffer;
	} finally { fs.closeSync(fd); }
}

export function ownDirectory(directory: string): OwnedDirectory {
	const stat = fs.lstatSync(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("owned root must be a non-symlink directory");
	fs.chmodSync(directory, 0o700);
	return { directory, dev: stat.dev, ino: stat.ino };
}

export function requireOwned(owner: OwnedDirectory): void {
	const stat = fs.lstatSync(owner.directory);
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== owner.dev || stat.ino !== owner.ino) throw new Error("owned root identity changed; retained");
}

export function cleanupOwned(owner: OwnedDirectory): void {
	requireOwned(owner);
	// rm does not follow symlinks inside the creation-owned private root.
	fs.rmSync(owner.directory, { recursive: true });
	if (fs.existsSync(owner.directory)) throw new Error("owned cleanup incomplete");
}

export function literalPath(value: string): string {
	if (!value || path.isAbsolute(value) || value.includes("\\") || /[\x00-\x1f\x7f:*?\[\]]/.test(value)
		|| value.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
		throw new Error(`invalid literal tracked path: ${JSON.stringify(value)}`);
	}
	if (value.split("/").some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.gitmodules|bunfig\.toml)$/i.test(part))) throw new Error("source provisioning/configuration file rejected");
	return value;
}

function noSymlinkAncestors(root: string, relative: string): void {
	let current = root;
	for (const part of relative.split("/")) {
		current = path.join(current, part);
		try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("symlink source path rejected"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
	}
}

function requireLocalConfig(root: string): void {
	let directory = path.join(root, ".git");
	const entry = fs.lstatSync(directory);
	if (entry.isSymbolicLink()) throw new Error("symlink Git metadata rejected");
	if (entry.isFile()) {
		const match = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(boundedRead(directory, 4096).toString());
		if (!match) throw new Error("invalid linked-worktree Git metadata");
		directory = path.resolve(root, match[1]!);
	}
	if (fs.realpathSync(directory) !== directory) throw new Error("symlink Git metadata ancestry rejected");
	let common = directory;
	const commonFile = path.join(directory, "commondir");
	if (fs.existsSync(commonFile)) common = path.resolve(directory, boundedRead(commonFile, 4096).toString().trim());
	for (const config of [path.join(common, "config"), path.join(directory, "config.worktree")]) {
		if (!fs.existsSync(config)) continue;
		// Git otherwise follows repository-local include/includeIf into private/global files.
		if (/^\s*\[\s*include(?:if)?(?:\s|\])/im.test(boundedRead(config, 1024 * 1024).toString())) throw new Error("Git configuration includes are not supported");
	}
}

/** No shell, global/system config, configuration includes, external diff, fsmonitor, hooks, or optional index locks. */
export function git(root: string, env: NodeJS.ProcessEnv, args: readonly string[], input?: Buffer): Buffer {
	requireLocalConfig(root);
	return execFileSync("git", ["--no-pager", "--literal-pathspecs", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", "-c", "core.autocrlf=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args], {
		cwd: root, env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" },
		maxBuffer: MAX_BYTES, timeout: 60_000, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
}

export function resolveCommit(root: string, env: NodeJS.ProcessEnv, ref: string): string {
	if (!/^(?:[0-9a-fA-F]{7,40}|HEAD|(?:refs\/)?(?:heads\/|tags\/)?[A-Za-z0-9][A-Za-z0-9._/-]*)$/.test(ref)
		|| ref.includes("..") || ref.includes("//") || ref.endsWith("/")) throw new Error("invalid local commit/ref selector");
	if (ref !== "HEAD" && !ref.startsWith("refs/")) {
		const matches = git(root, env, ["for-each-ref", "--format=%(refname)", `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/remotes/${ref}`]).toString().trim().split("\n").filter(Boolean);
		if (matches.length > 1 || (matches.length && /^[0-9a-fA-F]{7,40}$/.test(ref))) throw new Error("ambiguous local ref selector");
	}
	const result = git(root, env, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).toString().trim();
	if (!/^[0-9a-f]{40}$/.test(result)) throw new Error("ambiguous or unsupported commit identity");
	return result;
}

export function readTree(root: string, env: NodeJS.ProcessEnv, commit: string): TreeEntry[] {
	return new TextDecoder("utf-8", { fatal: true }).decode(git(root, env, ["ls-tree", "-rz", "--full-tree", commit])).split("\0").filter(Boolean).map((line) => {
		const match = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(line);
		if (!match || match[2] !== "blob" || !["100644", "100755"].includes(match[1]!)) throw new Error("symlink, submodule, or unsupported tree entry rejected");
		const file = literalPath(match[4]!);
		// These files can alter provisioning or disclose configuration even with a private HOME.
		if (file.split("/").some((part) => /^(?:\.env(?:\..*)?|\.npmrc|\.gitmodules|bunfig\.toml)$/i.test(part))) throw new Error("source provisioning/configuration file rejected");
		return { path: file, mode: match[1]!, object: match[3]! };
	});
}

export function trackedPaths(root: string, env: NodeJS.ProcessEnv): string[] {
	return new TextDecoder("utf-8", { fatal: true }).decode(git(root, env, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean).map((entry) => {
		const match = /^(100644|100755) [0-9a-f]{40} 0\t(.+)$/.exec(entry);
		if (!match) throw new Error("unmerged, symlink, or submodule index entry rejected");
		return literalPath(match[2]!);
	});
}

export function workingManifest(root: string, paths: readonly string[]): unknown[] {
	return paths.map((file) => {
		noSymlinkAncestors(root, file);
		const target = path.join(root, file);
		try {
			const stat = fs.lstatSync(target);
			if (!stat.isFile()) throw new Error("tracked path is not a regular file");
			return { path: file, mode: stat.mode & 0o777, sha256: sha256(boundedRead(target)) };
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, missing: true }; throw error; }
	});
}

export function sourceState(root: string, env: NodeJS.ProcessEnv, paths: readonly string[]): unknown {
	const metadata: Record<string, unknown> = {};
	for (const name of ["HEAD", "index", "config"]) {
		const file = path.resolve(root, git(root, env, ["rev-parse", "--git-path", name]).toString().trim());
		try {
			const stat = fs.lstatSync(file);
			metadata[name] = { sha256: sha256(boundedRead(file)), dev: stat.dev, ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs };
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; metadata[name] = null; }
	}
	return { head: git(root, env, ["rev-parse", "HEAD"]).toString().trim(), index: sha256(git(root, env, ["ls-files", "--stage", "-z"])), metadata, content: workingManifest(root, paths) };
}

/** Capture explicit raw working bytes, not Git's filtered/stat-cache view of the worktree. */
export function captureSelection(root: string, env: NodeJS.ProcessEnv, paths: readonly string[], tree: readonly TreeEntry[]): SelectedFile[] {
	if (!paths.length || new Set(paths).size !== paths.length) throw new Error("select distinct literal tracked files with --path");
	const tracked = new Set([...trackedPaths(root, env), ...tree.map((entry) => entry.path)]);
	let bytes = 0;
	return paths.map((file): SelectedFile => {
		literalPath(file);
		if (!tracked.has(file)) throw new Error(`selected path is not tracked: ${file}`);
		noSymlinkAncestors(root, file);
		const target = path.join(root, file);
		try {
			const stat = fs.lstatSync(target);
			if (!stat.isFile()) throw new Error("selected path is not a regular file");
			const content = boundedRead(target, MAX_BYTES - bytes);
			bytes += content.length;
			const after = fs.lstatSync(target);
			if (stat.dev !== after.dev || stat.ino !== after.ino || stat.mode !== after.mode || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("selected file changed during capture");
			return { path: file, mode: stat.mode & 0o111 ? "100755" : "100644", sha256: sha256(content), bytes: content };
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, missing: true }; throw error; }
	});
}

export function selectionManifest(selection: readonly SelectedFile[]): unknown[] {
	return selection.map((entry) => "missing" in entry ? entry : { path: entry.path, mode: entry.mode, sha256: entry.sha256 });
}

/** Compare materialized bytes, actual executable state AND absence to the captured source. */
export function verifySelection(root: string, selection: readonly SelectedFile[]): unknown[] {
	const actual = workingManifest(root, selection.map((entry) => entry.path)).map((value) => {
		const entry = value as { path: string; mode?: number; sha256?: string; missing?: true };
		return entry.missing ? entry : { path: entry.path, mode: entry.mode! & 0o111 ? "100755" : "100644", sha256: entry.sha256 };
	});
	if (JSON.stringify(actual) !== JSON.stringify(selectionManifest(selection))) throw new Error("selected raw bytes/executable/deletion manifest mismatch");
	return actual;
}

export function cloneSource(root: string, destination: string, env: NodeJS.ProcessEnv, commit: string, selection: readonly SelectedFile[], template: string): { tree: string; entries: TreeEntry[]; patchSha256: string } {
	if (git(root, env, ["rev-parse", "--is-shallow-repository"]).toString().trim() !== "false") throw new Error("nonshallow local history required");
	const objects = path.resolve(root, git(root, env, ["rev-parse", "--git-path", "objects/info/alternates"]).toString().trim());
	if (fs.existsSync(objects)) throw new Error("source object alternates are not supported");
	const grafts = path.resolve(root, git(root, env, ["rev-parse", "--git-path", "info/grafts"]).toString().trim());
	if (fs.existsSync(grafts)) throw new Error("source history grafts are not supported");
	git(root, env, ["clone", "--local", "--no-hardlinks", "--no-checkout", `--template=${template}`, "--", root, destination]);
	git(destination, env, ["checkout", "--detach", commit]);
	// No source-local config is copied by clone. Selection bypasses attributes entirely:
	// never add/apply/checkout selected working bytes through Git's conversion machinery.
	for (const entry of selection.filter((entry) => "missing" in entry)) {
		noSymlinkAncestors(destination, entry.path);
		fs.rmSync(path.join(destination, entry.path), { force: true });
		git(destination, env, ["update-index", "--force-remove", "--", entry.path]);
	}
	for (const entry of selection) {
		if ("missing" in entry) continue;
		noSymlinkAncestors(destination, entry.path);
		const target = path.join(destination, entry.path);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, entry.bytes, { mode: 0o600 });
		fs.chmodSync(target, entry.mode === "100755" ? 0o755 : 0o644);
		const object = git(destination, env, ["hash-object", "-w", "--no-filters", "--stdin"], entry.bytes).toString().trim();
		if (!/^[0-9a-f]{40}$/.test(object)) throw new Error("invalid raw blob identity");
		git(destination, env, ["update-index", "--add", "--cacheinfo", `${entry.mode},${object},${entry.path}`]);
	}
	verifySelection(destination, selection);
	// Tree/index-only diff: no original worktree Git diff, filters or stat-cache flags.
	const patch = git(destination, env, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", "--no-renames", commit, "--"]);
	fs.writeFileSync(path.join(path.dirname(destination), "selected.patch"), patch, { flag: "wx", mode: 0o600 });
	const tree = git(destination, env, ["write-tree"]).toString().trim();
	const entries = readTree(destination, env, tree);
	return { tree, entries, patchSha256: sha256(patch) };
}

/** Explicit seed only: copy bytes, then recreate verified internal aliases as private relative links. */
export function copyCache(source: string, destination: string, budget = { entries: 0, bytes: 0 }): void {
	const rootStat = fs.lstatSync(source);
	if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("cache seed root must be a non-symlink directory");
	const root = fs.realpathSync(source), owned = path.resolve(destination);
	const inside = (base: string, target: string) => target === base || target.startsWith(base.endsWith(path.sep) ? base : `${base}${path.sep}`);
	if (inside(root, owned) || inside(owned, root)) throw new Error("cache source/destination overlap rejected");
	if (fs.realpathSync(path.dirname(owned)) !== path.dirname(owned)) throw new Error("private cache parent must be canonical");
	const aliases: { destination: string; target: string }[] = [];

	// Resolve component by component, never asking realpath/stat to follow a seed link.
	// Every hop stays inside the canonical explicit root, including before any '..'.
	const resolveAlias = (file: string): string => {
		let current = root, pending = path.relative(root, file).split(path.sep), hops = 0;
		while (pending.length) {
			const part = pending.shift()!;
			if (!part || part === ".") continue;
			if (part === "..") {
				if (current === root) throw new Error("cache alias escapes selected seed");
				current = path.dirname(current); continue;
			}
			const next = path.join(current, part), stat = fs.lstatSync(next);
			if (stat.isSymbolicLink()) {
				if (++hops > 40) throw new Error("cache alias cycle or chain bound rejected");
				let target = fs.readlinkSync(next);
				if (path.isAbsolute(target)) {
					if (!inside(root, target)) throw new Error("cache alias escapes selected seed");
					target = target.slice(root.length); current = root;
				}
				pending = [...target.split(path.sep), ...pending];
			} else {
				if (!stat.isFile() && !stat.isDirectory()) throw new Error("cache seed contains a nonregular entry");
				if (!stat.isDirectory() && pending.length) throw new Error("cache alias has a nondirectory ancestor");
				current = next;
			}
		}
		return current;
	};
	const copy = (from: string, to: string): void => {
		const stat = fs.lstatSync(from);
		if (++budget.entries > 200_000) throw new Error("cache seed entry bound rejected");
		if (stat.isSymbolicLink()) {
			const target = resolveAlias(from);
			aliases.push({ destination: to, target: path.join(owned, path.relative(root, target)) });
		} else if (stat.isDirectory()) {
			fs.mkdirSync(to, { mode: 0o700 });
			for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
		} else if (stat.isFile()) {
			budget.bytes += stat.size;
			if (budget.bytes > 4 * 1024 ** 3) throw new Error("cache seed exceeds 4 GiB bound");
			fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
			fs.chmodSync(to, stat.mode & 0o111 ? 0o700 : 0o600);
		} else throw new Error("cache seed contains a nonregular entry");
	};
	copy(root, owned);
	for (const alias of aliases) fs.symlinkSync(path.relative(path.dirname(alias.destination), alias.target) || ".", alias.destination);
	// All targets must exist in the completed private copy. A directory alias can
	// form a traversal cycle even without a kernel ELOOP (e.g. a/link -> b -> a).
	const active = new Set<string>(), checked = new Set<string>();
	const validate = (directory: string): void => {
		if (active.has(directory)) throw new Error("cache alias directory cycle rejected");
		if (checked.has(directory)) return;
		active.add(directory);
		for (const name of fs.readdirSync(directory)) {
			let file = path.join(directory, name), stat = fs.lstatSync(file);
			if (stat.isSymbolicLink()) {
				file = fs.realpathSync(file);
				if (!inside(owned, file)) throw new Error("private cache alias escaped owned copy");
				stat = fs.lstatSync(file);
			}
			if (stat.isDirectory()) validate(file);
			else if (!stat.isFile()) throw new Error("private cache contains a nonregular entry");
		}
		active.delete(directory); checked.add(directory);
	};
	validate(owned);
}
