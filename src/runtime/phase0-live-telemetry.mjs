import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const PHASE0_LIVE_TELEMETRY_DIR_ENV = "PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_DIR";
export const PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV = "PI_SUBAGENT_PHASE0_LIVE_TELEMETRY_CAPABILITY";
export const PHASE0_LIVE_TELEMETRY_GATE_ENV = "PI_SUBAGENT_PHASE0_LIVE";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RECORD_BYTES = 512;
const METRICS = ["backendRequests", "backendSpawns", "requestBacklogHighWater", "lineBacklogHighWater", "byteBacklogHighWater", "controlDisconnects", "reconnects", "unknownOutcomes", "exactSnapshots", "exactCleanupMutations", "residualRecovery", "persistentClientCreates", "persistentClientRestarts", "healthyPeriodicStatusQueries", "notificationToReconcileLatencyMs", "lifecycleCompletionLatencyMs"];
const METRIC_SET = new Set(METRICS);
let sink;

function privateDirectory(directory) {
  try {
    if (!path.isAbsolute(directory)) return null;
    const canonical = fs.realpathSync(directory);
    if (canonical !== directory) return null;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    return canonical;
  } catch { return null; }
}
function initialize(env = process.env) {
  if (sink !== undefined) return sink;
  sink = null;
  const directory = env[PHASE0_LIVE_TELEMETRY_DIR_ENV], capability = env[PHASE0_LIVE_TELEMETRY_CAPABILITY_ENV];
  if (env[PHASE0_LIVE_TELEMETRY_GATE_ENV] !== "1" || typeof directory !== "string" || !/^[a-f0-9]{64}$/.test(capability ?? "")) return sink;
  const root = privateDirectory(directory);
  if (!root) return sink;
  try {
    const file = path.join(root, `transport-${process.pid}-${crypto.randomBytes(12).toString("hex")}.ndjson`);
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) { fs.closeSync(fd); fs.unlinkSync(file); return sink; }
    sink = { fd, capability: Buffer.from(capability, "hex"), bytes: 0, backend: null, initialized: false, presenceComplete: false, failed: false, ended: false };
    process.once("beforeExit", finalize);
    // Detached brokers terminate with process.exit() after awaited cleanup;
    // only the synchronous exit hook runs on that path.
    process.once("exit", finalize);
  } catch { sink = null; }
  return sink;
}
function tag(capability, payload) { return crypto.createHmac("sha256", capability).update(payload).digest("hex"); }
function emit(target, event) {
  const payload = JSON.stringify(event);
  const line = JSON.stringify({ ...event, tag: tag(target.capability, payload) }) + "\n";
  const bytes = Buffer.byteLength(line);
  if (bytes > MAX_RECORD_BYTES || target.bytes + bytes > MAX_FILE_BYTES) { target.failed = true; return false; }
  try { fs.writeSync(target.fd, line, undefined, "utf8"); target.bytes += bytes; return true; } catch { target.failed = true; return false; }
}
function initializeMetricPresence(target, backend) {
  if (target.initialized) return target.backend === backend;
  target.backend = backend;
  target.initialized = true;
  return true;
}
function completeMetricPresence(target, backend, recordedMetric) {
  if (target.presenceComplete) return true;
  for (const metric of METRICS) if (metric !== recordedMetric && !emit(target, { version: 1, type: "counter", pid: process.pid, backend, metric, value: 0, reason: "presence" })) return false;
  target.presenceComplete = true;
  return true;
}
/** Emit a signed end marker per metric. Missing markers and any reported write loss fail benchmark aggregation closed. */
function finalize() {
  const target = sink;
  if (!target || target.ended) return;
  target.ended = true;
  if (target.initialized) {
    if (target.failed) for (const metric of METRICS) emit(target, { version: 1, type: "dropped", pid: process.pid, backend: target.backend, metric, reason: "write-failed" });
    for (const metric of METRICS) emit(target, { version: 1, type: "end", pid: process.pid, backend: target.backend, metric });
  }
  try { fs.closeSync(target.fd); } catch {}
}
/** Synchronous, bounded telemetry is intentionally active only in the explicit live benchmark. */
export function recordPhase0LiveTelemetry(backend, metric, value = 1, reason) {
  if ((backend !== "cmux" && backend !== "tmux") || !METRIC_SET.has(metric) || !Number.isFinite(value) || value < 0 || (reason !== undefined && (typeof reason !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(reason)))) return false;
  const target = initialize();
  if (!target || target.ended || !initializeMetricPresence(target, backend)) return false;
  const wrote = emit(target, { version: 1, type: "counter", pid: process.pid, backend, metric, value, ...(reason ? { reason } : {}) });
  return wrote && completeMetricPresence(target, backend, metric);
}
export function phase0LiveTelemetryEnabled(env = process.env) { return Boolean(initialize(env)); }
export function closePhase0LiveTelemetryForTest() { finalize(); sink = undefined; }
