import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { GENERATED_BENCHMARK_EVIDENCE_FIXTURES, currentWorktreeSourceIdentity, type WorktreeSourceIdentity } from "./worktree-source-identity";
import { acquireReaperRootLock, enumerateRunDirectories, planUnifiedReaperGraph } from "../../src/runtime/reaper-coordinator";
import { startStaleInteractiveReaper } from "../../src/runtime/runner";
import { prepareRunArtifactPaths } from "../../src/runtime/run-protocol";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE_PATH = path.join(ROOT, "test/fixtures/reaper-performance-baseline.json");
export const DEFAULT_RUN_DIRECTORIES = 10_000;
export const FILESYSTEM_OVERRIDE_RUN_DIRECTORIES = 100_000;
export const GRAPH_NODE_COUNT = 100_000;
export const STARTUP_BUDGET_MS = 200;
export const STARTUP_ENTRY_BUDGET = 50;
export const REAPER_BENCH_RUNS_ENV = "PI_SUBAGENT_REAPER_BENCH_RUNS";
export const CREDENTIAL_CANARY = "credential-canary-must-never-be-persisted";

export const METRIC_UNITS = {
	startupLatencyMs: "ms",
	totalEnumerationMs: "ms",
	peakRssDeltaBytes: "bytes",
	eventLoopDelayMs: "ms",
	entryCount: "count",
	duplicates: "count",
	missing: "count",
	graphPlanMs: "ms",
	mutationBeforeGraphCount: "count",
	startupReturnMs: "ms",
	fullClassificationMs: "ms",
	classifiedCount: "count",
	validationConcurrencyObserved: "count",
	cleanupConcurrencyObserved: "count",
	mutationCount: "count",
} as const;

type MetricName = keyof typeof METRIC_UNITS;
type Metrics = { [K in MetricName]: { value: number; unit: (typeof METRIC_UNITS)[K] } };
type Mode = "dry-run" | "verify" | "record-local";
type HundredKFilesystemState = "not-run" | "executed";

export type ReaperPerformanceEvidence = {
	schemaVersion: 2;
	phase: "M7";
	evidenceKind: "local-reaper-performance-baseline";
	capturedAt: string;
	environment: { sourceRevision: string; sourceDirty: boolean; worktreeDigest: string; os: "darwin" | "linux" | "win32" | "other"; arch: string; bunVersion: string };
	execution: { executionMode: "record-local"; privateStateRoot: "marked-0700" };
	workload: {
		filesystem: {
			runDirectories: number;
			defaultRunDirectories: typeof DEFAULT_RUN_DIRECTORIES;
			overrideEnvironment: typeof REAPER_BENCH_RUNS_ENV;
			hundredKFilesystem: { state: HundredKFilesystemState; scale: typeof FILESYSTEM_OVERRIDE_RUN_DIRECTORIES };
		};
		graph: { storage: "in-memory"; nodeCount: typeof GRAPH_NODE_COUNT };
		startup: { budgetMs: typeof STARTUP_BUDGET_MS; entryBudget: typeof STARTUP_ENTRY_BUDGET; iterator: "single-handle-transfer" };
	};
	metrics: Metrics;
	cleanup: {
		lock: { acquired: true; released: true };
		iterator: { sameHandleTransfer: true; cancelAndDrain: true };
		mutation: { scheduleCleanupCalls: 0; multiplexerCalls: 0 };
	};
};

export type ReaperPerformanceSchemaTemplate = {
	schemaVersion: 2;
	executionMode: "record-local";
	requiredMetrics: typeof METRIC_UNITS;
	filesystem: { defaultRunDirectories: typeof DEFAULT_RUN_DIRECTORIES; overrideEnvironment: typeof REAPER_BENCH_RUNS_ENV; hundredKFilesystem: "override-gated" };
	graph: { storage: "in-memory"; nodeCount: typeof GRAPH_NODE_COUNT };
	startup: { budgetMs: typeof STARTUP_BUDGET_MS; entryBudget: typeof STARTUP_ENTRY_BUDGET; iterator: "single-handle-transfer" };
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isMetrics(value: unknown, runDirectories: number): value is Metrics {
	if (!isRecord(value) || !hasExactKeys(value, Object.keys(METRIC_UNITS))) return false;
	for (const name of Object.keys(METRIC_UNITS) as MetricName[]) {
		const metric = value[name];
		if (!isRecord(metric) || !hasExactKeys(metric, ["value", "unit"])
			|| !nonNegativeNumber(metric.value) || metric.unit !== METRIC_UNITS[name]) return false;
	}
	const metrics = value as unknown as Metrics;
	return metrics.entryCount.value === runDirectories && metrics.duplicates.value === 0 && metrics.missing.value === 0
		&& metrics.mutationBeforeGraphCount.value === 0 && metrics.classifiedCount.value === runDirectories
		&& metrics.validationConcurrencyObserved.value >= 1 && metrics.validationConcurrencyObserved.value <= 8
		&& metrics.validationConcurrencyObserved.value > 1 && metrics.cleanupConcurrencyObserved.value === 0
		&& metrics.mutationCount.value === 0 && Number.isInteger(metrics.entryCount.value)
		&& Number.isInteger(metrics.duplicates.value) && Number.isInteger(metrics.missing.value)
		&& Number.isInteger(metrics.mutationBeforeGraphCount.value) && Number.isInteger(metrics.classifiedCount.value)
		&& Number.isInteger(metrics.validationConcurrencyObserved.value) && Number.isInteger(metrics.cleanupConcurrencyObserved.value)
		&& Number.isInteger(metrics.mutationCount.value);
}

/** Strictly validates persisted, measured evidence; templates and paths are not evidence. */
export function validateReaperPerformanceEvidence(value: unknown): value is ReaperPerformanceEvidence {
	if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "phase", "evidenceKind", "capturedAt", "environment", "execution", "workload", "metrics", "cleanup"])
		|| value.schemaVersion !== 2 || value.phase !== "M7" || value.evidenceKind !== "local-reaper-performance-baseline" || !isIsoTimestamp(value.capturedAt)
		|| !isRecord(value.environment) || !hasExactKeys(value.environment, ["sourceRevision", "sourceDirty", "worktreeDigest", "os", "arch", "bunVersion"])
		|| !/^(unknown|[0-9a-f]{7,64})$/.test(String(value.environment.sourceRevision))
		|| typeof value.environment.sourceDirty !== "boolean" || typeof value.environment.worktreeDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.environment.worktreeDigest)
		|| !["darwin", "linux", "win32", "other"].includes(String(value.environment.os))
		|| typeof value.environment.arch !== "string" || !/^[a-z0-9_-]+$/i.test(value.environment.arch)
		|| typeof value.environment.bunVersion !== "string" || !/^\d+\.\d+\.\d+/.test(value.environment.bunVersion)
		|| !isRecord(value.execution) || !hasExactKeys(value.execution, ["executionMode", "privateStateRoot"])
		|| value.execution.executionMode !== "record-local" || value.execution.privateStateRoot !== "marked-0700"
		|| !isRecord(value.workload) || !hasExactKeys(value.workload, ["filesystem", "graph", "startup"])
		|| !isRecord(value.workload.filesystem) || !hasExactKeys(value.workload.filesystem, ["runDirectories", "defaultRunDirectories", "overrideEnvironment", "hundredKFilesystem"])
		|| ![DEFAULT_RUN_DIRECTORIES, FILESYSTEM_OVERRIDE_RUN_DIRECTORIES].includes(value.workload.filesystem.runDirectories as number)
		|| value.workload.filesystem.defaultRunDirectories !== DEFAULT_RUN_DIRECTORIES || value.workload.filesystem.overrideEnvironment !== REAPER_BENCH_RUNS_ENV
		|| !isRecord(value.workload.filesystem.hundredKFilesystem) || !hasExactKeys(value.workload.filesystem.hundredKFilesystem, ["state", "scale"])
		|| value.workload.filesystem.hundredKFilesystem.scale !== FILESYSTEM_OVERRIDE_RUN_DIRECTORIES
		|| value.workload.filesystem.hundredKFilesystem.state !== (value.workload.filesystem.runDirectories === FILESYSTEM_OVERRIDE_RUN_DIRECTORIES ? "executed" : "not-run")
		|| !isRecord(value.workload.graph) || !hasExactKeys(value.workload.graph, ["storage", "nodeCount"])
		|| value.workload.graph.storage !== "in-memory" || value.workload.graph.nodeCount !== GRAPH_NODE_COUNT
		|| !isRecord(value.workload.startup) || !hasExactKeys(value.workload.startup, ["budgetMs", "entryBudget", "iterator"])
		|| value.workload.startup.budgetMs !== STARTUP_BUDGET_MS || value.workload.startup.entryBudget !== STARTUP_ENTRY_BUDGET || value.workload.startup.iterator !== "single-handle-transfer"
		|| !isMetrics(value.metrics, value.workload.filesystem.runDirectories as number)
		|| !isRecord(value.cleanup) || !hasExactKeys(value.cleanup, ["lock", "iterator", "mutation"])
		|| !isRecord(value.cleanup.lock) || !hasExactKeys(value.cleanup.lock, ["acquired", "released"])
		|| value.cleanup.lock.acquired !== true || value.cleanup.lock.released !== true
		|| !isRecord(value.cleanup.iterator) || !hasExactKeys(value.cleanup.iterator, ["sameHandleTransfer", "cancelAndDrain"])
		|| value.cleanup.iterator.sameHandleTransfer !== true || value.cleanup.iterator.cancelAndDrain !== true
		|| !isRecord(value.cleanup.mutation) || !hasExactKeys(value.cleanup.mutation, ["scheduleCleanupCalls", "multiplexerCalls"])
		|| value.cleanup.mutation.scheduleCleanupCalls !== 0 || value.cleanup.mutation.multiplexerCalls !== 0) return false;
	return true;
}

export function createReaperPerformanceSchemaTemplate(): ReaperPerformanceSchemaTemplate {
	return {
		schemaVersion: 2,
		executionMode: "record-local",
		requiredMetrics: METRIC_UNITS,
		filesystem: { defaultRunDirectories: DEFAULT_RUN_DIRECTORIES, overrideEnvironment: REAPER_BENCH_RUNS_ENV, hundredKFilesystem: "override-gated" },
		graph: { storage: "in-memory", nodeCount: GRAPH_NODE_COUNT },
		startup: { budgetMs: STARTUP_BUDGET_MS, entryBudget: STARTUP_ENTRY_BUDGET, iterator: "single-handle-transfer" },
	};
}

/** Generated benchmark evidence is excluded as one set to avoid evidence-cycle churn. */
export function currentReaperSourceIdentity(): WorktreeSourceIdentity {
	return currentWorktreeSourceIdentity(ROOT, GENERATED_BENCHMARK_EVIDENCE_FIXTURES);
}

export function verifyCurrentReaperPerformanceEvidence(value: unknown): value is ReaperPerformanceEvidence {
	if (!validateReaperPerformanceEvidence(value)) return false;
	const identity = currentReaperSourceIdentity();
	return value.environment.sourceRevision === identity.sourceRevision
		&& value.environment.sourceDirty === identity.sourceDirty
		&& value.environment.worktreeDigest === identity.worktreeDigest;
}

function platform(): ReaperPerformanceEvidence["environment"]["os"] {
	return ["darwin", "linux", "win32"].includes(process.platform) ? process.platform as ReaperPerformanceEvidence["environment"]["os"] : "other";
}

function usage(): never {
	throw new Error("usage: reaper-performance.ts [--dry-run|--verify|--record-local]");
}

export function parseArgs(argv: string[]): Mode {
	if (argv.length !== 1) return usage();
	if (argv[0] === "--dry-run") return "dry-run";
	if (argv[0] === "--verify") return "verify";
	if (argv[0] === "--record-local") return "record-local";
	return usage();
}

export function configuredRunDirectories(environment: NodeJS.ProcessEnv = process.env): number {
	const configured = environment[REAPER_BENCH_RUNS_ENV];
	if (configured === undefined || configured === "") return DEFAULT_RUN_DIRECTORIES;
	if (configured === String(FILESYSTEM_OVERRIDE_RUN_DIRECTORIES)) return FILESYSTEM_OVERRIDE_RUN_DIRECTORIES;
	throw new Error(`${REAPER_BENCH_RUNS_ENV} must be unset or ${FILESYSTEM_OVERRIDE_RUN_DIRECTORIES}`);
}

/** Preflight validates only local runtime prerequisites and creates no state root or fixture. */
export async function preflightReaperPerformance(): Promise<void> {
	const executable = await fs.promises.stat(process.execPath);
	if (!executable.isFile()) throw new Error("benchmark runtime is not a regular file");
}

/** Creates a private state root and immutable ownership markers using production protocol code. */
export async function createPrivateMarkedStateRoot(): Promise<{ root: string; seedRunId: string }> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-performance-"));
	try {
		await fs.promises.chmod(root, 0o700);
		const seedRunId = "run-000000";
		await prepareRunArtifactPaths({ rootDir: root, runId: seedRunId });
		return { root, seedRunId };
	} catch (error) {
		await fs.promises.rm(root, { recursive: true, force: true });
		throw error;
	}
}

export async function createPrivateEvidenceRoot(): Promise<string> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-evidence-"));
	await fs.promises.chmod(root, 0o700);
	return root;
}

export async function writePrivateEvidence(root: string, evidence: ReaperPerformanceEvidence): Promise<string> {
	if (!validateReaperPerformanceEvidence(evidence)) throw new Error("refusing to persist evidence outside the schema allowlist");
	const file = path.join(root, "evidence.json");
	await fs.promises.writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
	await fs.promises.chmod(file, 0o600);
	return file;
}

async function populateRunDirectories(root: string, seedRunId: string, count: number): Promise<void> {
	for (let index = 0; index < count; index += 1) {
		const runId = `run-${String(index).padStart(6, "0")}`;
		if (runId !== seedRunId) await prepareRunArtifactPaths({ rootDir: root, runId });
	}
}

/** Keep authority-free marked directories fresh so production classification cannot clean them up. */
async function refreshRunDirectoryMtimes(root: string, count: number): Promise<void> {
	const refreshedAt = new Date();
	for (let index = 0; index < count; index += 1) {
		const runId = `run-${String(index).padStart(6, "0")}`;
		await fs.promises.utimes(path.join(root, runId), refreshedAt, refreshedAt);
	}
}

function metric<K extends MetricName>(name: K, value: number): Metrics[K] {
	return { value, unit: METRIC_UNITS[name] } as Metrics[K];
}

async function measureReaperWorkload(root: string, runDirectories: number): Promise<Metrics & { cleanup: ReaperPerformanceEvidence["cleanup"] }> {
	const rssStart = process.memoryUsage().rss;
	let peakRss = rssStart;
	const loop = monitorEventLoopDelay({ resolution: 1 });
	loop.enable();
	const rssSampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 1);
	let iteratorDrained = false;
	try {
		const lock = await acquireReaperRootLock(root, `benchmark:${process.pid}:${Date.now()}`);
		if (!lock) throw new Error("benchmark could not acquire its private reaper root lock");
		let rootLockReleased = false;
		let measured: Metrics | undefined;
		try {
			const enumerationStarted = performance.now();
			const enumeration = enumerateRunDirectories(root, { startupBudgetMs: STARTUP_BUDGET_MS, startupEntryBudget: STARTUP_ENTRY_BUDGET });
			try {
				const startup = await enumeration.startup;
				const startupLatencyMs = performance.now() - enumerationStarted;
				const completion = await enumeration.completion;
				const totalEnumerationMs = performance.now() - enumerationStarted;
				await enumeration.cancelAndDrain();
				iteratorDrained = true;
				const entries = [...startup, ...completion];
				const unique = new Set(entries);
				const duplicates = entries.length - unique.size;
				const missing = runDirectories - unique.size;
				if (duplicates !== 0 || missing !== 0) throw new Error("benchmark enumeration did not produce an exact run-directory set");
				const graphNodes = Array.from({ length: GRAPH_NODE_COUNT }, (_, index) => ({ runId: `graph-${index}`, ...(index === 0 ? {} : { parentRunId: `graph-${index - 1}` }) }));
				const graphStarted = performance.now();
				const graph = planUnifiedReaperGraph(graphNodes);
				const graphPlanMs = performance.now() - graphStarted;
				if (graph.unresolved.size !== 0 || graph.descendantsFirst.length !== GRAPH_NODE_COUNT) throw new Error("benchmark graph plan was incomplete");

				// The raw enumeration owns the benchmark lock; release it before invoking
				// production startup so it can take and release its own root lock.
				if (!await lock.release()) throw new Error("benchmark reaper root lock did not release");
				rootLockReleased = true;
				// These marked directories intentionally have no launch authority. Their fresh
				// mtimes make the production reaper classify each as invalid/skipped without
				// cleanup, avoiding one fresh durable lease write per directory.
				await refreshRunDirectoryMtimes(root, runDirectories);
				let scheduleCleanupCalls = 0;
				let multiplexerCalls = 0;
				let validationConcurrencyObserved = 0;
				const classificationStarted = performance.now();
				const reaper = await startStaleInteractiveReaper({
					rootDir: root,
					scheduleCleanup: () => { scheduleCleanupCalls += 1; },
					cmuxRun: async () => { multiplexerCalls += 1; throw new Error("benchmark classification unexpectedly called cmux"); },
					tmuxRun: async () => { multiplexerCalls += 1; throw new Error("benchmark classification unexpectedly called tmux"); },
					onValidationConcurrency: (active) => { validationConcurrencyObserved = Math.max(validationConcurrencyObserved, active); },
				});
				const startupReturnMs = performance.now() - classificationStarted;
				const classification = await reaper.completion;
				const fullClassificationMs = performance.now() - classificationStarted;
				if (classification.scanned !== runDirectories || classification.skipped.length !== runDirectories
					|| classification.invalid.length !== 0 || classification.reaped.length !== 0
					|| scheduleCleanupCalls !== 0 || multiplexerCalls !== 0) {
					throw new Error("benchmark production reaper classification was not mutation-free");
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				peakRss = Math.max(peakRss, process.memoryUsage().rss);
				measured = {
					startupLatencyMs: metric("startupLatencyMs", startupLatencyMs), totalEnumerationMs: metric("totalEnumerationMs", totalEnumerationMs),
					peakRssDeltaBytes: metric("peakRssDeltaBytes", Math.max(0, peakRss - rssStart)), eventLoopDelayMs: metric("eventLoopDelayMs", Number.isFinite(loop.max) ? loop.max / 1_000_000 : 0),
					entryCount: metric("entryCount", entries.length), duplicates: metric("duplicates", duplicates), missing: metric("missing", missing),
					graphPlanMs: metric("graphPlanMs", graphPlanMs), mutationBeforeGraphCount: metric("mutationBeforeGraphCount", 0),
					startupReturnMs: metric("startupReturnMs", startupReturnMs), fullClassificationMs: metric("fullClassificationMs", fullClassificationMs),
					classifiedCount: metric("classifiedCount", classification.scanned), validationConcurrencyObserved: metric("validationConcurrencyObserved", validationConcurrencyObserved),
					cleanupConcurrencyObserved: metric("cleanupConcurrencyObserved", 0), mutationCount: metric("mutationCount", scheduleCleanupCalls + multiplexerCalls),
				};
			} finally {
				if (!iteratorDrained) await enumeration.cancelAndDrain().catch(() => undefined);
			}
		} finally {
			if (!rootLockReleased && !await lock.release()) throw new Error("benchmark reaper root lock did not release");
		}
		if (!measured || !iteratorDrained) throw new Error("benchmark iterator did not drain");
		return {
			...measured,
			cleanup: {
				lock: { acquired: true, released: true },
				iterator: { sameHandleTransfer: true, cancelAndDrain: true },
				mutation: { scheduleCleanupCalls: 0, multiplexerCalls: 0 },
			},
		};
	} finally {
		clearInterval(rssSampler);
		loop.disable();
	}
}

/** Performs the only benchmark mutation: private, marked local state plus explicit cleanup. */
export async function recordLocalBenchmark(runDirectories = configuredRunDirectories()): Promise<ReaperPerformanceEvidence> {
	if (![DEFAULT_RUN_DIRECTORIES, FILESYSTEM_OVERRIDE_RUN_DIRECTORIES].includes(runDirectories)) throw new Error("unsupported filesystem benchmark scale");
	const { root, seedRunId } = await createPrivateMarkedStateRoot();
	try {
		await populateRunDirectories(root, seedRunId, runDirectories);
		const measured = await measureReaperWorkload(root, runDirectories);
		const { cleanup, ...metrics } = measured;
		const evidence: ReaperPerformanceEvidence = {
			schemaVersion: 2,
			phase: "M7",
			evidenceKind: "local-reaper-performance-baseline",
			capturedAt: new Date().toISOString(),
			environment: { ...currentReaperSourceIdentity(), os: platform(), arch: process.arch, bunVersion: process.versions.bun ?? process.version.replace(/^v/, "") },
			execution: { executionMode: "record-local", privateStateRoot: "marked-0700" },
			workload: {
				filesystem: { runDirectories, defaultRunDirectories: DEFAULT_RUN_DIRECTORIES, overrideEnvironment: REAPER_BENCH_RUNS_ENV, hundredKFilesystem: { state: runDirectories === FILESYSTEM_OVERRIDE_RUN_DIRECTORIES ? "executed" : "not-run", scale: FILESYSTEM_OVERRIDE_RUN_DIRECTORIES } },
				graph: { storage: "in-memory", nodeCount: GRAPH_NODE_COUNT },
				startup: { budgetMs: STARTUP_BUDGET_MS, entryBudget: STARTUP_ENTRY_BUDGET, iterator: "single-handle-transfer" },
			},
			metrics,
			cleanup,
		};
		if (!validateReaperPerformanceEvidence(evidence)) throw new Error("benchmark did not produce complete measured evidence");
		return evidence;
	} finally {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
}

async function readFixture(): Promise<unknown> {
	return JSON.parse(await fs.promises.readFile(FIXTURE_PATH, "utf8"));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const mode = parseArgs(argv);
	if (mode === "dry-run") {
		await preflightReaperPerformance();
		console.log(JSON.stringify({ phase: "M7", mode: "preflight", mutation: "none", schemaTemplate: createReaperPerformanceSchemaTemplate() }));
		return;
	}
	if (mode === "verify") {
		const fixture = await readFixture();
		if (!verifyCurrentReaperPerformanceEvidence(fixture)) throw new Error("Phase 7 baseline is not complete measured local evidence for the current worktree");
		console.log(JSON.stringify({ phase: "M7", mode: "verify", fixture: path.relative(ROOT, FIXTURE_PATH), valid: true }));
		return;
	}

	await preflightReaperPerformance();
	const evidenceRoot = await createPrivateEvidenceRoot();
	try {
		const evidence = await recordLocalBenchmark();
		const privateFile = await writePrivateEvidence(evidenceRoot, evidence);
		const persisted = JSON.parse(await fs.promises.readFile(privateFile, "utf8"));
		if (!validateReaperPerformanceEvidence(persisted)) throw new Error("private evidence failed strict baseline validation");
		await fs.promises.writeFile(FIXTURE_PATH, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o644 });
		await fs.promises.chmod(FIXTURE_PATH, 0o644);
		console.log(JSON.stringify({ phase: "M7", mode, fixture: path.relative(ROOT, FIXTURE_PATH), runDirectories: persisted.workload.filesystem.runDirectories, graphNodes: persisted.workload.graph.nodeCount, ...persisted.environment }));
	} finally {
		await fs.promises.rm(evidenceRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
