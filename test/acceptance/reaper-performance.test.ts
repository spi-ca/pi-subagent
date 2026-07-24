import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CREDENTIAL_CANARY,
	DEFAULT_RUN_DIRECTORIES,
	FIXTURE_PATH,
	GRAPH_NODE_COUNT,
	METRIC_UNITS,
	REAPER_BENCH_RUNS_ENV,
	createPrivateEvidenceRoot,
	createPrivateMarkedStateRoot,
	createReaperPerformanceSchemaTemplate,
	configuredRunDirectories,
	main,
	parseArgs,
	preflightReaperPerformance,
	validateReaperPerformanceEvidence,
	verifyCurrentReaperPerformanceEvidence,
	writePrivateEvidence,
} from "./reaper-performance";

describe("reaper Phase 7 local performance benchmark", () => {
	test("declares a non-mutating schema preflight separate from persisted evidence", async () => {
		const template = createReaperPerformanceSchemaTemplate();
		assert.deepEqual(template.requiredMetrics, METRIC_UNITS);
		assert.equal(template.filesystem.defaultRunDirectories, DEFAULT_RUN_DIRECTORIES);
		assert.equal(template.graph.nodeCount, GRAPH_NODE_COUNT);
		assert.equal(validateReaperPerformanceEvidence(template), false);
		await preflightReaperPerformance();
		assert.equal(configuredRunDirectories({}), DEFAULT_RUN_DIRECTORIES);
		assert.equal(configuredRunDirectories({ [REAPER_BENCH_RUNS_ENV]: "100000" }), 100_000);
		assert.throws(() => configuredRunDirectories({ [REAPER_BENCH_RUNS_ENV]: "10" }), /must be unset or 100000/);
	});

	test("creates an actual private marked state root", async () => {
		const { root, seedRunId } = await createPrivateMarkedStateRoot();
		try {
			assert.equal((await fs.promises.stat(root)).mode & 0o777, 0o700);
			assert.equal((await fs.promises.stat(path.join(root, "state-root-marker.json"))).mode & 0o777, 0o600);
			assert.equal((await fs.promises.stat(path.join(root, seedRunId, "run-directory-marker.json"))).mode & 0o777, 0o600);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	test("strictly accepts the measured 10k fixture and rejects credential or path canaries", async () => {
		const fixture = JSON.parse(await fs.promises.readFile(FIXTURE_PATH, "utf8"));
		assert.equal(validateReaperPerformanceEvidence(fixture), true);
		assert.equal(fixture.workload.filesystem.runDirectories, DEFAULT_RUN_DIRECTORIES);
		assert.equal(fixture.workload.filesystem.hundredKFilesystem.state, "not-run");
		assert.equal(fixture.workload.graph.nodeCount, GRAPH_NODE_COUNT);
		assert.equal(fixture.metrics.classifiedCount.value, DEFAULT_RUN_DIRECTORIES);
		assert.ok(fixture.metrics.validationConcurrencyObserved.value > 1);
		assert.ok(fixture.metrics.validationConcurrencyObserved.value <= 8);
		assert.equal(fixture.metrics.cleanupConcurrencyObserved.value, 0);
		assert.equal(fixture.metrics.mutationCount.value, 0);
		assert.deepEqual(fixture.cleanup.mutation, { scheduleCleanupCalls: 0, multiplexerCalls: 0 });
		assert.equal(JSON.stringify(fixture).includes(CREDENTIAL_CANARY), false);

		const extra = structuredClone(fixture) as Record<string, unknown>;
		extra.privatePath = "/private/credential-canary-must-never-be-persisted";
		assert.equal(validateReaperPerformanceEvidence(extra), false);
		const canary = structuredClone(fixture);
		canary.environment.sourceRevision = CREDENTIAL_CANARY;
		assert.equal(validateReaperPerformanceEvidence(canary), false);

		const evidenceRoot = await createPrivateEvidenceRoot();
		try {
			await assert.rejects(() => writePrivateEvidence(evidenceRoot, canary), /allowlist/);
		} finally {
			await fs.promises.rm(evidenceRoot, { recursive: true, force: true });
		}
	});

	test("requires exact metric and cleanup evidence", async () => {
		const fixture = JSON.parse(await fs.promises.readFile(FIXTURE_PATH, "utf8"));
		const missingMetric = structuredClone(fixture);
		delete missingMetric.metrics.graphPlanMs;
		assert.equal(validateReaperPerformanceEvidence(missingMetric), false);
		const mutatedBeforeGraph = structuredClone(fixture);
		mutatedBeforeGraph.metrics.mutationBeforeGraphCount.value = 1;
		assert.equal(validateReaperPerformanceEvidence(mutatedBeforeGraph), false);
		const incompleteCleanup = structuredClone(fixture);
		incompleteCleanup.cleanup.iterator.cancelAndDrain = false;
		assert.equal(validateReaperPerformanceEvidence(incompleteCleanup), false);
		const mutationObserved = structuredClone(fixture);
		mutationObserved.cleanup.mutation.scheduleCleanupCalls = 1;
		assert.equal(validateReaperPerformanceEvidence(mutationObserved), false);
		const serialValidation = structuredClone(fixture);
		serialValidation.metrics.validationConcurrencyObserved.value = 1;
		assert.equal(validateReaperPerformanceEvidence(serialValidation), false);
		const excessiveValidation = structuredClone(fixture);
		excessiveValidation.metrics.validationConcurrencyObserved.value = 9;
		assert.equal(validateReaperPerformanceEvidence(excessiveValidation), false);
	});

	test("binds the local baseline to the current worktree and rejects identity mismatches", async () => {
		const fixture = JSON.parse(await fs.promises.readFile(FIXTURE_PATH, "utf8"));
		assert.equal(verifyCurrentReaperPerformanceEvidence(fixture), true);
		const mismatch = structuredClone(fixture);
		mismatch.environment.sourceDirty = !fixture.environment.sourceDirty;
		assert.equal(verifyCurrentReaperPerformanceEvidence(mismatch), false);
	});

	test("dry-run and strict verify do not mutate the persisted fixture", async () => {
		const before = await fs.promises.readFile(FIXTURE_PATH, "utf8");
		await main(["--dry-run"]);
		await main(["--verify"]);
		assert.equal(await fs.promises.readFile(FIXTURE_PATH, "utf8"), before);
		assert.equal(parseArgs(["--record-local"]), "record-local");
		assert.throws(() => parseArgs(["--live"]), /usage/);
	});
});
