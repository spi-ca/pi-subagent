import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { GENERATED_BENCHMARK_EVIDENCE_FIXTURES, currentWorktreeSourceIdentity, type WorktreeSourceIdentity } from "./worktree-source-identity";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURE_PATH = path.join(ROOT, "test/fixtures/transport-performance-phase0-baseline.json");
export const ACTIVE_RUN_MATRIX = [1, 4, 8, 16] as const;
export const WORKLOADS = ["idle-wait", "short-response", "long-response", "cancel", "external-close"] as const;
export const METRIC_UNITS = {
  monotonicDurationMs: "ms",
  settlementLatencyMs: "ms",
  childSpawnCount: "count",
  statusPollingCount: "count",
  parentCpuDeltaMs: "ms",
  peakParentRssBytes: "bytes",
  eventLoopDelayMs: "ms",
  peakChildCount: "count",
} as const;

export type Workload = typeof WORKLOADS[number];
type MetricName = keyof typeof METRIC_UNITS;
type MeasuredMetrics = { [K in MetricName]: { value: number; unit: (typeof METRIC_UNITS)[K] } };
type Cleanup = { expectedChildExitCount: number; settledChildExitCount: number; residualChildCount: number; result: "clean" };
type Sample = { sample: number; metrics: MeasuredMetrics; cleanup: Cleanup };
type MatrixEntry = { activeRuns: number; workload: Workload; samples: Sample[] };

export type PerformanceEvidence = {
  schemaVersion: 3;
  phase: "M0";
  evidenceKind: "local-benchmark-baseline";
  capturedAt: string;
  environment: {
    sourceRevision: string;
    sourceDirty: boolean;
    worktreeDigest: string;
    os: "darwin" | "linux" | "win32" | "other";
    arch: string;
    bunVersion: string;
    transportContracts: { cmux: "not-applicable"; tmux: "not-applicable" };
  };
  execution: { executionMode: "record-local"; backend: "fixed-local-child-process" };
  workloadDefinition: { childProgram: "fixed-local-barrier-v1"; activeRunMatrix: number[]; workloads: Workload[] };
  repetition: { count: 1; aggregation: "single-sample" };
  matrix: MatrixEntry[];
  cleanup: { result: "clean"; residualChildCount: 0 };
};

export type Phase0SchemaTemplate = {
  schemaVersion: 3;
  executionMode: "record-local";
  backend: "fixed-local-child-process";
  requiredMetrics: typeof METRIC_UNITS;
  activeRunMatrix: typeof ACTIVE_RUN_MATRIX;
  workloads: typeof WORKLOADS;
};

const CHILD_PROGRAM = String.raw`
const workload = process.argv[1];
let started = false;
let finished = false;
const finish = (state) => {
  if (finished) return;
  finished = true;
  process.stdout.write(state + "\n");
  process.exit(0);
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    if (line === "start" && !started) {
      started = true;
      process.stdout.write("started\n");
      if (workload === "short-response") setTimeout(() => finish("settled"), 5);
      else if (workload === "long-response") setTimeout(() => finish("settled"), 45);
      else if (workload === "idle-wait") setTimeout(() => finish("settled"), 30);
      else setTimeout(() => finish("settled"), 1000);
    }
    if (line === "cancel" && workload === "cancel") finish("cancelled");
  }
});
process.stdout.write("ready\n");
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isMeasuredMetrics(value: unknown): value is MeasuredMetrics {
  if (!isRecord(value) || !hasExactKeys(value, Object.keys(METRIC_UNITS))) return false;
  return (Object.keys(METRIC_UNITS) as MetricName[]).every((name) => {
    const metric = value[name];
    return isRecord(metric) && hasExactKeys(metric, ["value", "unit"])
      && isNonNegativeNumber(metric.value) && metric.unit === METRIC_UNITS[name];
  });
}

function isCleanup(value: unknown, activeRuns: number): value is Cleanup {
  return isRecord(value) && hasExactKeys(value, ["expectedChildExitCount", "settledChildExitCount", "residualChildCount", "result"])
    && value.expectedChildExitCount === activeRuns && value.settledChildExitCount === activeRuns
    && value.residualChildCount === 0 && value.result === "clean";
}

/** Validates the persisted baseline, not the preflight/template declaration. */
export function validatePerformanceEvidence(value: unknown): value is PerformanceEvidence {
  if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "phase", "evidenceKind", "capturedAt", "environment", "execution", "workloadDefinition", "repetition", "matrix", "cleanup"])
    || value.schemaVersion !== 3 || value.phase !== "M0" || value.evidenceKind !== "local-benchmark-baseline" || !isIsoTimestamp(value.capturedAt)
    || !isRecord(value.environment) || !hasExactKeys(value.environment, ["sourceRevision", "sourceDirty", "worktreeDigest", "os", "arch", "bunVersion", "transportContracts"])
    || !/^(unknown|[0-9a-f]{7,64})$/.test(String(value.environment.sourceRevision))
    || typeof value.environment.sourceDirty !== "boolean" || typeof value.environment.worktreeDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.environment.worktreeDigest)
    || !["darwin", "linux", "win32", "other"].includes(String(value.environment.os))
    || typeof value.environment.arch !== "string" || !/^[a-z0-9_-]+$/i.test(value.environment.arch)
    || typeof value.environment.bunVersion !== "string" || !/^\d+\.\d+\.\d+/.test(value.environment.bunVersion)
    || !isRecord(value.environment.transportContracts) || !hasExactKeys(value.environment.transportContracts, ["cmux", "tmux"])
    || value.environment.transportContracts.cmux !== "not-applicable" || value.environment.transportContracts.tmux !== "not-applicable"
    || !isRecord(value.execution) || !hasExactKeys(value.execution, ["executionMode", "backend"])
    || value.execution.executionMode !== "record-local" || value.execution.backend !== "fixed-local-child-process"
    || !isRecord(value.workloadDefinition) || !hasExactKeys(value.workloadDefinition, ["childProgram", "activeRunMatrix", "workloads"])
    || value.workloadDefinition.childProgram !== "fixed-local-barrier-v1" || !Array.isArray(value.workloadDefinition.activeRunMatrix)
    || !Array.isArray(value.workloadDefinition.workloads) || !isRecord(value.repetition) || !hasExactKeys(value.repetition, ["count", "aggregation"])
    || value.repetition.count !== 1 || value.repetition.aggregation !== "single-sample" || !Array.isArray(value.matrix)
    || value.matrix.length !== ACTIVE_RUN_MATRIX.length * WORKLOADS.length || !isRecord(value.cleanup)
    || value.cleanup.result !== "clean" || value.cleanup.residualChildCount !== 0) return false;

  if (JSON.stringify(value.workloadDefinition.activeRunMatrix) !== JSON.stringify(ACTIVE_RUN_MATRIX)
    || JSON.stringify(value.workloadDefinition.workloads) !== JSON.stringify(WORKLOADS)) return false;

  const seen = new Set<string>();
  for (const entry of value.matrix) {
    if (!isRecord(entry) || !hasExactKeys(entry, ["activeRuns", "workload", "samples"])
      || !ACTIVE_RUN_MATRIX.includes(entry.activeRuns as typeof ACTIVE_RUN_MATRIX[number])
      || !WORKLOADS.includes(entry.workload as Workload) || !Array.isArray(entry.samples) || entry.samples.length !== 1) return false;
    const sample = entry.samples[0];
    if (!isRecord(sample) || !hasExactKeys(sample, ["sample", "metrics", "cleanup"]) || sample.sample !== 1
      || !isMeasuredMetrics(sample.metrics) || !isCleanup(sample.cleanup, entry.activeRuns as number)) return false;
    const metrics = sample.metrics as MeasuredMetrics;
    if (metrics.childSpawnCount.value !== entry.activeRuns || metrics.peakChildCount.value !== entry.activeRuns
      || metrics.statusPollingCount.value !== 0) return false;
    const key = `${entry.activeRuns}:${entry.workload}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return ACTIVE_RUN_MATRIX.every((activeRuns) => WORKLOADS.every((workload) => seen.has(`${activeRuns}:${workload}`)));
}

/** A declarative schema/preflight product; it is intentionally not baseline evidence. */
export function createPhase0SchemaTemplate(): Phase0SchemaTemplate {
  return { schemaVersion: 3, executionMode: "record-local", backend: "fixed-local-child-process", requiredMetrics: METRIC_UNITS, activeRunMatrix: ACTIVE_RUN_MATRIX, workloads: WORKLOADS };
}

/** Generated benchmark evidence is excluded as one set to avoid evidence-cycle churn. */
export function currentPhase0SourceIdentity(): WorktreeSourceIdentity {
  return currentWorktreeSourceIdentity(ROOT, GENERATED_BENCHMARK_EVIDENCE_FIXTURES);
}

export function verifyCurrentPerformanceEvidence(value: unknown): value is PerformanceEvidence {
  if (!validatePerformanceEvidence(value)) return false;
  const identity = currentPhase0SourceIdentity();
  return value.environment.sourceRevision === identity.sourceRevision
    && value.environment.sourceDirty === identity.sourceDirty
    && value.environment.worktreeDigest === identity.worktreeDigest;
}

function platform(): PerformanceEvidence["environment"]["os"] {
  return ["darwin", "linux", "win32"].includes(process.platform) ? process.platform as PerformanceEvidence["environment"]["os"] : "other";
}

function usage(): never {
  throw new Error("usage: performance-phase0.ts [--dry-run|--verify|--record-local]");
}

export function parseArgs(argv: string[]): "dry-run" | "verify" | "record-local" {
  if (argv.length !== 1) return usage();
  if (argv[0] === "--dry-run") return "dry-run";
  if (argv[0] === "--verify") return "verify";
  if (argv[0] === "--record-local") return "record-local";
  return usage();
}

/** Preflight performs no benchmark and writes no evidence. */
export async function preflightLocalBenchmark(): Promise<void> {
  const executable = await fs.promises.stat(process.execPath);
  if (!executable.isFile()) throw new Error("local benchmark runtime is not a regular file");
}

export async function createPrivateEvidenceRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-performance-phase0-"));
  await fs.promises.chmod(root, 0o700);
  return root;
}

export async function writePrivateEvidence(root: string, evidence: PerformanceEvidence): Promise<string> {
  if (!validatePerformanceEvidence(evidence)) throw new Error("refusing to persist evidence outside the schema allowlist");
  const file = path.join(root, "evidence.json");
  await fs.promises.writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.chmod(file, 0o600);
  return file;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([promise, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), 5_000))]);
}

type LocalChild = { child: ChildProcess; ready: Promise<void>; started: Promise<void>; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> };

function spawnFixedChild(workload: Workload): LocalChild {
  const ready = deferred<void>();
  const started = deferred<void>();
  const closed = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const child = spawn(process.execPath, ["-e", CHILD_PROGRAM, workload], { cwd: ROOT, env: {}, stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line === "ready") ready.resolve();
      else if (line === "started") started.resolve();
    }
  });
  child.once("error", (error) => { ready.reject(error); started.reject(error); closed.reject(error); });
  child.once("close", (code, signal) => closed.resolve({ code, signal }));
  return { child, ready: ready.promise, started: started.promise, closed: closed.promise };
}

function writeCommand(child: ChildProcess, command: "start" | "cancel"): void {
  if (!child.stdin || child.stdin.destroyed || !child.stdin.write(`${command}\n`)) return;
}

async function measureSample(activeRuns: number, workload: Workload): Promise<Sample> {
  const cpuStart = process.cpuUsage();
  const durationStart = performance.now();
  const loop = monitorEventLoopDelay({ resolution: 1 });
  loop.enable();
  let peakRss = process.memoryUsage().rss;
  let activeChildren = 0;
  let peakChildren = 0;
  const rssSampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 1);
  const children: LocalChild[] = [];
  try {
    for (let index = 0; index < activeRuns; index += 1) {
      children.push(spawnFixedChild(workload));
      activeChildren += 1;
      peakChildren = Math.max(peakChildren, activeChildren);
    }
    await withTimeout(Promise.all(children.map((child) => child.ready)), "barrier readiness");
    const releaseAt = performance.now();
    children.forEach(({ child }) => writeCommand(child, "start"));
    await withTimeout(Promise.all(children.map((child) => child.started)), "barrier start");
    if (workload === "cancel") children.forEach(({ child }) => writeCommand(child, "cancel"));
    if (workload === "external-close") children.forEach(({ child }) => child.kill("SIGTERM"));
    const exits = await withTimeout(Promise.all(children.map((child) => child.closed)), "child settlement");
    activeChildren = 0;
    for (const exit of exits) {
      const expectedSignal = workload === "external-close" ? "SIGTERM" : null;
      if (expectedSignal ? exit.signal !== expectedSignal : exit.code !== 0) throw new Error(`unexpected local child exit for ${workload}`);
    }
    const durationEnd = performance.now();
    const cpu = process.cpuUsage(cpuStart);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    return {
      sample: 1,
      metrics: {
        monotonicDurationMs: { value: durationEnd - durationStart, unit: "ms" },
        settlementLatencyMs: { value: durationEnd - releaseAt, unit: "ms" },
        childSpawnCount: { value: children.length, unit: "count" },
        statusPollingCount: { value: 0, unit: "count" },
        parentCpuDeltaMs: { value: (cpu.user + cpu.system) / 1_000, unit: "ms" },
        peakParentRssBytes: { value: peakRss, unit: "bytes" },
        eventLoopDelayMs: { value: Number.isFinite(loop.max) ? loop.max / 1_000_000 : 0, unit: "ms" },
        peakChildCount: { value: peakChildren, unit: "count" },
      },
      cleanup: { expectedChildExitCount: activeRuns, settledChildExitCount: exits.length, residualChildCount: activeChildren, result: "clean" },
    };
  } finally {
    clearInterval(rssSampler);
    loop.disable();
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

export async function recordLocalBenchmark(): Promise<PerformanceEvidence> {
  const matrix: MatrixEntry[] = [];
  for (const activeRuns of ACTIVE_RUN_MATRIX) for (const workload of WORKLOADS) {
    matrix.push({ activeRuns, workload, samples: [await measureSample(activeRuns, workload)] });
  }
  const evidence: PerformanceEvidence = {
    schemaVersion: 3,
    phase: "M0",
    evidenceKind: "local-benchmark-baseline",
    capturedAt: new Date().toISOString(),
    environment: { ...currentPhase0SourceIdentity(), os: platform(), arch: process.arch, bunVersion: process.versions.bun ?? process.version.replace(/^v/, ""), transportContracts: { cmux: "not-applicable", tmux: "not-applicable" } },
    execution: { executionMode: "record-local", backend: "fixed-local-child-process" },
    workloadDefinition: { childProgram: "fixed-local-barrier-v1", activeRunMatrix: [...ACTIVE_RUN_MATRIX], workloads: [...WORKLOADS] },
    repetition: { count: 1, aggregation: "single-sample" },
    matrix,
    cleanup: { result: "clean", residualChildCount: 0 },
  };
  if (!validatePerformanceEvidence(evidence)) throw new Error("local benchmark did not produce complete measured evidence");
  return evidence;
}

async function readFixture(): Promise<unknown> {
  return JSON.parse(await fs.promises.readFile(FIXTURE_PATH, "utf8"));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const mode = parseArgs(argv);
  if (mode === "dry-run") {
    await preflightLocalBenchmark();
    console.log(JSON.stringify({ phase: "M0", mode: "preflight", mutation: "none", schemaTemplate: createPhase0SchemaTemplate() }));
    return;
  }
  if (mode === "verify") {
    const fixture = await readFixture();
    if (!verifyCurrentPerformanceEvidence(fixture)) throw new Error("Phase 0 baseline is not complete measured local evidence for the current worktree");
    console.log(JSON.stringify({ phase: "M0", mode: "verify", fixture: path.relative(ROOT, FIXTURE_PATH), valid: true }));
    return;
  }

  await preflightLocalBenchmark();
  const root = await createPrivateEvidenceRoot();
  try {
    const evidence = await recordLocalBenchmark();
    const privateFile = await writePrivateEvidence(root, evidence);
    const persisted = JSON.parse(await fs.promises.readFile(privateFile, "utf8"));
    if (!validatePerformanceEvidence(persisted)) throw new Error("private evidence failed strict baseline validation");
    await fs.promises.writeFile(FIXTURE_PATH, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o644 });
    await fs.promises.chmod(FIXTURE_PATH, 0o644);
    console.log(JSON.stringify({ phase: "M0", mode, fixture: path.relative(ROOT, FIXTURE_PATH), matrixEntries: persisted.matrix.length, ...persisted.environment }));
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
