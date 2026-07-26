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

function gitOutput(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
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

  test("preserves the full identity after a fixture-only commit", async () => {
    const root = await repository();
    const before = currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES);

    for (const fixture of GENERATED_BENCHMARK_EVIDENCE_FIXTURES) {
      const evidence = path.join(root, fixture);
      await fs.mkdir(path.dirname(evidence), { recursive: true });
      await fs.writeFile(evidence, `generated:${fixture}\n`);
    }
    git(root, ["add", "test/fixtures"]);
    git(root, ["commit", "-m", "regenerate benchmark evidence"]);

    assert.deepEqual(currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES), before);
  });

  test("fails closed for a fixture-only shallow checkout with no reachable source revision", async () => {
    const root = await repository();
    for (const fixture of GENERATED_BENCHMARK_EVIDENCE_FIXTURES) {
      const evidence = path.join(root, fixture);
      await fs.mkdir(path.dirname(evidence), { recursive: true });
      await fs.writeFile(evidence, `generated:${fixture}\n`);
    }
    git(root, ["add", "test/fixtures"]);
    git(root, ["commit", "-m", "regenerate benchmark evidence"]);

    const shallow = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktree-identity-shallow-"));
    await fs.rm(shallow, { recursive: true, force: true });
    roots.push(shallow);
    git(root, ["clone", "--depth=1", `file://${root}`, shallow]);

    assert.throws(() => currentWorktreeSourceIdentity(shallow, GENERATED_BENCHMARK_EVIDENCE_FIXTURES), /could not bind evidence to the source revision/);
  });

  test("advances source revision for non-fixture and mixed commits", async () => {
    const root = await repository();
    const initial = currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES);

    const source = path.join(root, "src", "other-source.ts");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "export const value = 1;\n");
    git(root, ["add", "src/other-source.ts"]);
    git(root, ["commit", "-m", "change source"]);
    const afterSource = currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES);
    assert.equal(afterSource.sourceRevision, gitOutput(root, ["rev-parse", "HEAD"]));
    assert.notEqual(afterSource.sourceRevision, initial.sourceRevision);

    const fixture = path.join(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES[0]);
    const docs = path.join(root, "docs", "other-doc.md");
    await fs.mkdir(path.dirname(fixture), { recursive: true });
    await fs.mkdir(path.dirname(docs), { recursive: true });
    await fs.writeFile(fixture, "generated\n");
    await fs.writeFile(docs, "source-bound documentation\n");
    git(root, ["add", GENERATED_BENCHMARK_EVIDENCE_FIXTURES[0], "docs/other-doc.md"]);
    git(root, ["commit", "-m", "change docs and regenerate evidence"]);
    const afterMixed = currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES);
    assert.equal(afterMixed.sourceRevision, gitOutput(root, ["rev-parse", "HEAD"]));
    assert.notEqual(afterMixed.sourceRevision, afterSource.sourceRevision);
  });

  test("rejects an exclusion that exists as a directory, symlink, or non-regular file", async () => {
    if (process.platform === "win32") return;
    const root = await repository(), fixture = path.join(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES[0]);
    await fs.mkdir(path.dirname(fixture), { recursive: true });

    await fs.mkdir(fixture);
    assert.throws(() => currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES), /excluded evidence fixture is not a regular file/);
    await fs.rm(fixture, { recursive: true });

    await fs.symlink("../../tracked.txt", fixture);
    assert.throws(() => currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES), /excluded evidence fixture is not a regular file/);
    await fs.rm(fixture);

    execFileSync("mkfifo", [fixture]);
    assert.throws(() => currentWorktreeSourceIdentity(root, GENERATED_BENCHMARK_EVIDENCE_FIXTURES), /excluded evidence fixture is not a regular file/);
  });

  test("excludes uncommitted exact generated evidence and rejects untracked symlinks", async () => {
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
    git(root, ["add", "test/fixtures"]);
    git(root, ["commit", "-m", "add generated benchmark evidence"]);

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
