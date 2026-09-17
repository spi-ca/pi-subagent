import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { ACTIVE_RUN_MATRIX, FIXTURE_PATH, METRIC_UNITS, WORKLOADS, createLocalChild, createPhase0SchemaTemplate, createPrivateEvidenceRoot, main, measureSample, parseArgs, preflightLocalBenchmark, recordLocalBenchmark, type LocalChild, validatePerformanceEvidence, verifyCurrentPerformanceEvidence, withTimeout, writePrivateEvidence } from "./performance-phase0";

const CREDENTIAL_CANARY = "credential-canary-must-never-be-persisted";

describe("performance Phase 0 local benchmark", () => {
  test("keeps the preflight schema declaration separate from measured baseline validation", async () => {
    const template = createPhase0SchemaTemplate();
    assert.deepEqual(template.activeRunMatrix, ACTIVE_RUN_MATRIX);
    assert.deepEqual(template.workloads, WORKLOADS);
    assert.deepEqual(template.requiredMetrics, METRIC_UNITS);
    await preflightLocalBenchmark();
    assert.equal(validatePerformanceEvidence(template), false);
  });

  test("rejects extensions, missing measured metrics, wrong canonical units, and unmeasured transport metrics", async () => {
    const evidence = await recordLocalBenchmark();
    assert.equal(validatePerformanceEvidence(evidence), true);
    const extra = structuredClone(evidence) as Record<string, unknown>;
    extra.unexpected = true;
    assert.equal(validatePerformanceEvidence(extra), false);

    const missing = structuredClone(evidence);
    delete (missing.matrix[0]!.samples[0]!.metrics as Record<string, unknown>).peakChildCount;
    assert.equal(validatePerformanceEvidence(missing), false);

    const wrongUnit = structuredClone(evidence);
    wrongUnit.matrix[0]!.samples[0]!.metrics.peakParentRssBytes.unit = "ms" as never;
    assert.equal(validatePerformanceEvidence(wrongUnit), false);

    const unmeasured = structuredClone(evidence) as Record<string, unknown>;
    (unmeasured.environment as Record<string, unknown>).transportContracts = { cmux: "not-instrumented", tmux: "not-applicable" };
    assert.equal(validatePerformanceEvidence(unmeasured), false);
  });

  test("records a fixed local barrier with exact peak concurrency and complete cleanup", async () => {
    const evidence = await recordLocalBenchmark();
    for (const entry of evidence.matrix) {
      const sample = entry.samples[0]!;
      assert.equal(sample.metrics.childSpawnCount.value, entry.activeRuns);
      assert.equal(sample.metrics.peakChildCount.value, entry.activeRuns);
      assert.equal(sample.metrics.statusPollingCount.value, 0);
      assert.equal(sample.cleanup.settledChildExitCount, entry.activeRuns);
      assert.equal(sample.cleanup.residualChildCount, 0);
      assert.equal(sample.cleanup.result, "clean");
    }
  });

  test("uses actual private 0700/0600 evidence permissions and rejects a credential canary by allowlisted schema", async () => {
    const root = await createPrivateEvidenceRoot();
    try {
      assert.equal((await fs.promises.stat(root)).mode & 0o777, 0o700);
      const evidence = await recordLocalBenchmark();
      const file = await writePrivateEvidence(root, evidence);
      assert.equal((await fs.promises.stat(file)).mode & 0o777, 0o600);
      assert.equal((await fs.promises.readFile(file, "utf8")).includes(CREDENTIAL_CANARY), false);

      const canary = structuredClone(evidence);
      canary.environment.sourceRevision = CREDENTIAL_CANARY;
      await assert.rejects(() => writePrivateEvidence(root, canary), /allowlist/);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("recording is explicit and ordinary unit CI does not invoke the retained-evidence gate", async () => {
    const before = await fs.promises.readFile(FIXTURE_PATH, "utf8");
    await main(["--dry-run"]);
    assert.equal(await fs.promises.readFile(FIXTURE_PATH, "utf8"), before);
    assert.equal(parseArgs(["--record-local"]), "record-local");
    assert.throws(() => parseArgs(["--live"]), /usage/);
  });

  test("clears benchmark timeout guards after both success and failure", async () => {
    const timers = new Set<number>();
    let cleared = 0;
    const hooks = {
      setTimeout: ((callback: () => void) => {
        const id = timers.size + 1;
        timers.add(id);
        void callback;
        return id as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
        if (timers.delete(id as unknown as number)) cleared += 1;
      }) as typeof clearTimeout,
    };
    assert.equal(await withTimeout(Promise.resolve("ok"), "success", 5_000, hooks), "ok");
    await assert.rejects(() => withTimeout(Promise.reject(new Error("injected")), "failure", 5_000, hooks), /injected/);
    assert.equal(cleared, 2);
    assert.equal(timers.size, 0);
  });

  test("observes ENOENT startup failure and waits for its close and stdout latches", async () => {
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", observeUnhandled);
    let local!: LocalChild;
    let childClosed = false;
    let stdoutClosed = false;
    try {
      await assert.rejects(() => measureSample(1, "long-response", {
        spawnChild: () => {
          const child = spawn(path.join(process.cwd(), "__phase0-intentional-ENOENT__"), [], { stdio: ["pipe", "pipe", "ignore"] });
          local = createLocalChild(child);
          void local.closed.then(() => { childClosed = true; });
          void local.stdoutClosed.then(() => { stdoutClosed = true; });
          return local;
        },
        timeoutMs: 2_000,
      }), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      // The sample's finally block is the join point: a failed spawn must not
      // leave a process or source stream closing after the sample returns.
      assert.equal(childClosed, true, "cleanup waited for the actual ChildProcess close latch");
      assert.equal(stdoutClosed, true, "cleanup waited for the actual stdout close latch");
      assert.equal(local.child.pid, undefined, "ENOENT created no child process to leak");
      assert.equal(local.child.stdout?.destroyed, true, "ENOENT stdout was fully closed");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, [], "all startup-stage failures were observed immediately");
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  test("reaps an injected owned tiny child and drains late stdout after sample failure", async () => {
    let local!: LocalChild;
    let abortCalled = false;
    let lateBody!: () => void;
    const lateBodySeen = new Promise<void>((resolve) => { lateBody = resolve; });
    const spawnTinyChild = (): LocalChild => {
      const child = spawn(process.execPath, ["-e", `
        process.stdin.setEncoding("utf8");
        process.stdout.write("ready\\n");
        process.stdin.on("data", (value) => {
          if (value.includes("start")) {
            process.stdout.write("started\\n");
            setImmediate(() => process.stdout.write("late-body\\n"));
          }
        });
      `], { stdio: ["pipe", "pipe", "ignore"] });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString("utf8").includes("ready\n")) resolve(); }); child.once("error", reject);
      });
      const started = new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString("utf8").includes("started\n")) resolve(); }); child.once("error", reject);
      });
      const stdoutClosed = new Promise<void>((resolve, reject) => { child.stdout!.once("close", resolve); child.stdout!.once("error", reject); });
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("close", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
      child.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString("utf8").includes("late-body\n")) lateBody(); });
      return { child, ready, started, closed, stdoutClosed, abort: () => { abortCalled = true; child.stdin?.destroy(); } };
    };
    await assert.rejects(() => measureSample(1, "long-response", {
      spawnChild: () => (local = spawnTinyChild()),
      timeoutMs: 2_000,
      afterStarted: async () => { await lateBodySeen; throw new Error("injected sample failure"); },
    }), /injected sample failure/);
    await local.stdoutClosed;
    assert.equal(abortCalled, true, "sample cleanup aborts its pending local work before reaping");
    assert.ok(local.child.exitCode !== null || local.child.signalCode !== null, "the exact owned child was reaped");
  });

  test("binds fresh synthetic evidence to the current worktree and rejects identity mismatches", async () => {
    const fresh = await recordLocalBenchmark();
    assert.equal(verifyCurrentPerformanceEvidence(fresh), true);
    const mismatch = structuredClone(fresh);
    mismatch.environment.worktreeDigest = "0".repeat(64);
    assert.equal(verifyCurrentPerformanceEvidence(mismatch), false);
  });

  test("baseline fixture is measured, timestamped, and complete", async () => {
    const fixture = JSON.parse(await fs.promises.readFile(FIXTURE_PATH, "utf8"));
    assert.equal(validatePerformanceEvidence(fixture), true);
  });
});
