import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { ACTIVE_RUN_MATRIX, FIXTURE_PATH, METRIC_UNITS, WORKLOADS, createPhase0SchemaTemplate, createPrivateEvidenceRoot, main, parseArgs, preflightLocalBenchmark, recordLocalBenchmark, validatePerformanceEvidence, verifyCurrentPerformanceEvidence, writePrivateEvidence } from "./performance-phase0";

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

  test("recording is an explicit mode; dry-run and verify do not mutate the fixture", async () => {
    const before = await fs.promises.readFile(FIXTURE_PATH, "utf8");
    await main(["--dry-run"]);
    await main(["--verify"]);
    assert.equal(await fs.promises.readFile(FIXTURE_PATH, "utf8"), before);
    assert.equal(parseArgs(["--record-local"]), "record-local");
    assert.throws(() => parseArgs(["--live"]), /usage/);
  });

  test("binds the local baseline to the current worktree and rejects identity mismatches", async () => {
    const fixture = JSON.parse(await fs.promises.readFile(FIXTURE_PATH, "utf8"));
    assert.equal(verifyCurrentPerformanceEvidence(fixture), true);
    const mismatch = structuredClone(fixture);
    mismatch.environment.worktreeDigest = "0".repeat(64);
    assert.equal(verifyCurrentPerformanceEvidence(mismatch), false);
  });

  test("baseline fixture is measured, timestamped, and complete", async () => {
    const fixture = JSON.parse(await fs.promises.readFile(FIXTURE_PATH, "utf8"));
    assert.equal(validatePerformanceEvidence(fixture), true);
  });
});
