import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GENERATED_BENCHMARK_EVIDENCE_FIXTURES, currentWorktreeSourceIdentity } from "./worktree-source-identity";

const roots: string[] = [];

afterEach(async () => { while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true }); });

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktree-identity-"));
  roots.push(root);
  git(root, ["init"]); git(root, ["config", "user.email", "test@example.invalid"]); git(root, ["config", "user.name", "Test"]);
  await fs.writeFile(path.join(root, "tracked.txt"), "initial\n", { mode: 0o644 });
  git(root, ["add", "tracked.txt"]); git(root, ["commit", "-m", "initial"]);
  return root;
}

describe("worktree source identity", () => {
  test("detects tracked and untracked content and modes, but not timestamps", async () => {
    if (process.platform === "win32") return;
    const root = await repository();
    const clean = currentWorktreeSourceIdentity(root, []);
    assert.equal(clean.sourceDirty, false);

    const tracked = path.join(root, "tracked.txt");
    await fs.writeFile(tracked, "changed\n");
    const trackedContent = currentWorktreeSourceIdentity(root, []);
    assert.equal(trackedContent.sourceDirty, true);
    assert.notEqual(trackedContent.worktreeDigest, clean.worktreeDigest);
    await fs.utimes(tracked, new Date(1_000_000), new Date(2_000_000));
    assert.equal(currentWorktreeSourceIdentity(root, []).worktreeDigest, trackedContent.worktreeDigest);
    await fs.chmod(tracked, 0o755);
    const trackedMode = currentWorktreeSourceIdentity(root, []);
    assert.notEqual(trackedMode.worktreeDigest, trackedContent.worktreeDigest);

    const untracked = path.join(root, "untracked.txt");
    await fs.writeFile(untracked, "one\n", { mode: 0o600 });
    const untrackedContent = currentWorktreeSourceIdentity(root, []);
    assert.notEqual(untrackedContent.worktreeDigest, trackedMode.worktreeDigest);
    await fs.utimes(untracked, new Date(3_000_000), new Date(4_000_000));
    assert.equal(currentWorktreeSourceIdentity(root, []).worktreeDigest, untrackedContent.worktreeDigest);
    await fs.chmod(untracked, 0o700);
    assert.notEqual(currentWorktreeSourceIdentity(root, []).worktreeDigest, untrackedContent.worktreeDigest);
  });

  test("excludes exactly the generated benchmark-evidence set and rejects untracked symlinks", async () => {
    if (process.platform === "win32") return;
    const root = await repository();
    assert.deepEqual(GENERATED_BENCHMARK_EVIDENCE_FIXTURES, [
      "test/fixtures/transport-performance-phase0-baseline.json",
      "test/fixtures/reaper-performance-baseline.json",
      "test/fixtures/transport-performance-phase0-live-routine.json",
      "test/fixtures/transport-performance-phase0-live-concurrency.json",
    ]);
    for (const fixture of GENERATED_BENCHMARK_EVIDENCE_FIXTURES) {
      const evidence = path.join(root, fixture);
      await fs.mkdir(path.dirname(evidence), { recursive: true });
      await fs.writeFile(evidence, "first\n");
    }

    const before = currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES);
    for (const fixture of GENERATED_BENCHMARK_EVIDENCE_FIXTURES) {
      await fs.writeFile(path.join(root, fixture), `regenerated:${fixture}\n`);
      assert.deepEqual(currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES), before);
    }

    await fs.writeFile(path.join(root, "tracked.txt"), "changed\n");
    let previous = currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES);
    assert.notEqual(previous.worktreeDigest, before.worktreeDigest);

    for (const otherContent of ["src/other-source.ts", "test/other-test.ts", "docs/other-doc.md"]) {
      const other = path.join(root, otherContent);
      await fs.mkdir(path.dirname(other), { recursive: true });
      await fs.writeFile(other, otherContent);
      const current = currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES);
      assert.notEqual(current.worktreeDigest, previous.worktreeDigest);
      previous = current;
    }

    await fs.symlink("tracked.txt", path.join(root, "untracked-link"));
    assert.throws(() => currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES), /symlink/);
  });
});
