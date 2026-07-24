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

function sourceRevision(root: string): "unknown" | string {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 && /^[0-9a-f]{40}$/i.test(result.stdout.trim()) ? result.stdout.trim().toLowerCase() : "unknown";
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
  const options = { cwd: root, encoding: "buffer" as const, maxBuffer: MAX_WORKTREE_EVIDENCE_BYTES, stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"] };
  const pathspec = ["--", ".", ...exclusions.map((fixture) => `:(exclude)${fixture}`)];
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
  return { sourceRevision: sourceRevision(root), sourceDirty: status.stdout.length > 0, worktreeDigest: digest.digest("hex") };
}
