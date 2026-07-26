import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import * as path from "node:path";

export const MAX_WORKTREE_EVIDENCE_BYTES = 64 * 1024 * 1024;

/** The complete generated benchmark-evidence exclusion set; source, test, and docs files remain bound. */
export const GENERATED_BENCHMARK_EVIDENCE_FIXTURES = [
  "test/fixtures/transport-performance-phase0-baseline.json",
  "test/fixtures/reaper-performance-baseline.json",
  "test/fixtures/transport-performance-phase0-live-routine.json",
  "test/fixtures/transport-performance-phase0-live-concurrency.json",
] as const;

export type WorktreeSourceIdentity = {
  sourceRevision: "unknown" | string;
  sourceDirty: boolean;
  worktreeDigest: string;
};

function sourceRevision(root: string, pathspec: readonly string[]): "unknown" | string {
  const options = { cwd: root, encoding: "utf8" as const, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
  const shallow = spawnSync("git", ["rev-parse", "--is-shallow-repository"], options);
  if (shallow.error || shallow.status !== 0 || shallow.stdout.trim() !== "false") throw new Error("could not bind evidence to the source revision");
  const result = spawnSync("git", ["log", "-1", "--format=%H", "HEAD", ...pathspec], options);
  if (result.error || result.status !== 0) throw new Error("could not bind evidence to the source revision");
  const revision = result.stdout.trim();
  if (revision === "") return "unknown";
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(revision)) throw new Error("could not bind evidence to the source revision");
  return revision.toLowerCase();
}

function relativeFixturePath(root: string, fixture: string): string {
  const relative = path.relative(root, path.resolve(root, fixture));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("evidence fixture must be a file inside the repository");
  return relative.split(path.sep).join("/");
}

/**
 * Content-addresses the current Git worktree without timestamps or symlink traversal.
 * The explicit generated-evidence set is the complete exclusion set; all other tracked
 * and untracked content, including modes, remains bound to the identity.
 */
export function currentWorktreeSourceIdentity(root: string, excludedFixtures: readonly string[]): WorktreeSourceIdentity {
  const exclusions = excludedFixtures.map((fixture) => relativeFixturePath(root, fixture));
  for (const fixture of exclusions) {
    try {
      const stat = lstatSync(path.resolve(root, fixture));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("excluded evidence fixture is not a regular file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const options = { cwd: root, encoding: "buffer" as const, maxBuffer: MAX_WORKTREE_EVIDENCE_BYTES, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
  const pathspec = ["--", ".", ...exclusions.map((fixture) => `:(top,literal,exclude)${fixture}`)];
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...pathspec], options);
  const diff = spawnSync("git", ["diff", "--binary", "HEAD", ...pathspec], options);
  if (status.status !== 0 || diff.status !== 0 || status.error || diff.error) throw new Error("could not bind evidence to the worktree");

  const digest = crypto.createHash("sha256").update(status.stdout).update(diff.stdout);
  const untracked = status.stdout.toString("utf8").split("\0").filter((entry) => entry.startsWith("?? ")).map((entry) => entry.slice(3)).sort();
  let untrackedBytes = 0;
  for (const relative of untracked) {
    const candidate = path.resolve(root, relative);
    const contained = path.relative(root, candidate);
    if (!contained || contained === ".." || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) throw new Error("untracked worktree path escaped the repository");
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error("untracked worktree content contains a symlink");
    if (!stat.isFile()) throw new Error("untracked worktree content is not a regular file");
    untrackedBytes += stat.size;
    if (untrackedBytes > MAX_WORKTREE_EVIDENCE_BYTES) throw new Error("untracked worktree content exceeds the evidence digest budget");
    digest.update("untracked\0").update(relative).update("\0file\0").update(`${stat.mode & 0o777}:${stat.size}\0`).update(readFileSync(candidate));
  }
  return { sourceRevision: sourceRevision(root, pathspec), sourceDirty: status.stdout.length > 0, worktreeDigest: digest.digest("hex") };
}
