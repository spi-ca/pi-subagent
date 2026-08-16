#!/usr/bin/env node
/**
 * One-shot V2 launch broker.  It intentionally uses only Node built-ins so the
 * packaged file can be run by either bun or node without TypeScript loading.
 * Do not add target discovery here: cmux cannot safely rediscover an
 * unrecorded allocation after this process dies between response and record.
 */
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createCmuxControlCommandRunner, getCmuxControlRequestManager } from "./cmux-control-adapter.mjs";
import { TmuxControlClient, createTmuxControlCommandRunner } from "./tmux-control.mjs";
import { MINIMUM_CMUX_VERSION, MINIMUM_TMUX_VERSION, isStableSemverAtLeast, isStableTmuxVersionAtLeast } from "./version-policy.mjs";
import { recordPhase0LiveTelemetry } from "./phase0-live-telemetry.mjs";
import { isValidTmuxWindowLabel } from "./tmux-window-label.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// UUID authority is string-only: RegExp.test() coerces arrays, objects, and
// numbers, so it must never inspect an untyped backend or artifact field.
const isUuidString = (value) => typeof value === "string" && UUID.test(value);
// Preserve backend UUID spelling, but never distinguish case aliases in authority checks.
const cmuxIdsEqual = (left, right) => isUuidString(left) && isUuidString(right) && left.toLowerCase() === right.toLowerCase();
const PANE = /^%(?:0|[1-9][0-9]*)$/;
const HERDR_SUPPORTED_PROTOCOLS = new Set([19, 20]);
const isHerdrProtocol = (value) => HERDR_SUPPORTED_PROTOCOLS.has(value);
const HERDR_ID = /^[^\u0000-\u001f\u007f-\u009f]{1,256}$/u;
const HERDR_MAX_LINE_BYTES = 256 * 1024;
const HERDR_MAX_LISTED_PANES = 128;
const isHerdrId = (value) => typeof value === "string" && Buffer.byteLength(value, "utf8") <= 256 && HERDR_ID.test(value);
class HerdrUnknownOutcomeError extends Error {
  constructor(method, message) { super(message); this.name = "HerdrUnknownOutcomeError"; this.method = method; this.unknownOutcome = true; }
}
class HerdrRequestError extends Error {
  constructor(method, code, message) { super(message); this.name = "HerdrRequestError"; this.method = method; this.code = code; }
}
function isHerdrUnknownOutcome(error) { return error instanceof HerdrUnknownOutcomeError; }
function herdrSource(value) {
  return exact(value, ["socketPath", "workspaceId", "tabId", "sourcePaneId", "sourceTerminalId", "protocol"])
    && typeof value.socketPath === "string" && path.isAbsolute(value.socketPath) && path.normalize(value.socketPath) === value.socketPath
    && isHerdrId(value.workspaceId) && isHerdrId(value.tabId) && isHerdrId(value.sourcePaneId) && isHerdrId(value.sourceTerminalId) && isHerdrProtocol(value.protocol);
}
function herdrTarget(value) {
  return exact(value, ["socketPath", "workspaceId", "tabId", "paneId", "terminalId", "protocol"])
    && typeof value.socketPath === "string" && path.isAbsolute(value.socketPath) && path.normalize(value.socketPath) === value.socketPath
    && [value.workspaceId, value.tabId, value.paneId, value.terminalId].every(isHerdrId) && isHerdrProtocol(value.protocol);
}
function strictHerdrSocket(socketPath) {
  try { const stat = fsSync.lstatSync(socketPath); return stat.isSocket() && !stat.isSymbolicLink() && (typeof process.getuid !== "function" || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0 ? stat : null; } catch { return null; }
}
async function herdrRequest(socketPath, method, params, mutation = false) {
  const before = strictHerdrSocket(socketPath); if (!before) throw new Error("unsafe Herdr socket");
  const id = `pi-subagent:${crypto.randomUUID()}`, line = `${JSON.stringify({ id, method, params })}\n`;
  if (Buffer.byteLength(line, "utf8") > HERDR_MAX_LINE_BYTES) throw new Error("Herdr request exceeds the strict wire limit");
  return await new Promise((resolve, reject) => {
    let dispatched = false, settled = false, bytes = Buffer.alloc(0);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    // After mutation dispatch, only a strict matching response is decisive.
    // All transport/envelope failures retain typed uncertainty for the caller.
    const unknown = (message) => mutation && dispatched ? new HerdrUnknownOutcomeError(method, message) : new Error(message);
    const socket = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => finish(unknown("Herdr request timed out")), 5000);
    socket.once("connect", () => {
      try {
        const after = strictHerdrSocket(socketPath);
        if (!after || before.dev !== after.dev || before.ino !== after.ino) return finish(new Error("Herdr socket changed during connection"));
        dispatched = true; socket.write(line, (error) => { if (error) finish(unknown(`Herdr request write failed: ${error.message}`)); });
      } catch (error) { finish(unknown(error instanceof Error ? error.message : String(error))); }
    });
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]); if (bytes.length > HERDR_MAX_LINE_BYTES) return finish(unknown("Herdr response too large"));
      const at = bytes.indexOf(10); if (at < 0) return;
      if (at !== bytes.length - 1) return finish(unknown("Herdr response framing invalid"));
      let response; try { response = JSON.parse(bytes.subarray(0, at).toString("utf8")); } catch { return finish(unknown("Herdr response malformed")); }
      if (!response || typeof response !== "object" || Array.isArray(response) || response.id !== id) return finish(unknown("Herdr response binding mismatch"));
      if (Object.keys(response).length === 2 && Object.hasOwn(response, "error") && response.error && typeof response.error === "object" && !Array.isArray(response.error)
        && Object.keys(response.error).length === 2 && typeof response.error.code === "string" && typeof response.error.message === "string") return finish(new HerdrRequestError(method, response.error.code, response.error.message));
      if (Object.keys(response).length !== 2 || !Object.hasOwn(response, "result") || !response.result || typeof response.result !== "object" || Array.isArray(response.result)
        || mutation && typeof response.result.type !== "string") return finish(unknown("Herdr response envelope or result is invalid"));
      finish(null, response.result);
    });
    socket.once("error", (error) => finish(unknown(error.message))); socket.once("end", () => { if (!settled) finish(unknown("Herdr closed the response before completion")); });
  });
}
function parseHerdrPane(value, socketPath, protocol) {
  const pane = value?.pane ?? value?.agent?.pane ?? value?.session?.pane ?? value;
  return pane && typeof pane === "object" && !Array.isArray(pane) && isHerdrId(pane.workspace_id) && isHerdrId(pane.tab_id) && isHerdrId(pane.pane_id) && isHerdrId(pane.terminal_id) && isHerdrProtocol(protocol)
    ? { mode: "herdr-pane", socketPath, workspaceId: pane.workspace_id, tabId: pane.tab_id, paneId: pane.pane_id, terminalId: pane.terminal_id, protocol } : null;
}
async function assertHerdrProtocol(socketPath, expectedProtocol) {
  const pong = await herdrRequest(socketPath, "ping", {});
  if (!isHerdrProtocol(pong.protocol)) throw new Error("Herdr protocol must be one of 19 or 20");
  if (expectedProtocol !== undefined && pong.protocol !== expectedProtocol) throw new Error(`Herdr protocol changed from ${expectedProtocol} to ${pong.protocol}`);
  return pong.protocol;
}
/** A pane move changes public address, never the terminal identity we own. */
async function revalidateHerdrTarget(target) {
  await assertHerdrProtocol(target.socketPath, target.protocol);
  try {
    const observed = parseHerdrPane(await herdrRequest(target.socketPath, "pane.get", { pane_id: target.paneId }), target.socketPath, target.protocol);
    if (observed?.terminalId === target.terminalId) {
      target.workspaceId = observed.workspaceId; target.tabId = observed.tabId; target.paneId = observed.paneId;
      return target;
    }
  } catch { /* a new bounded all-workspaces query may recover a moved pane */ }
  try {
    const result = await herdrRequest(target.socketPath, "pane.list", {});
    if (!Array.isArray(result.panes) || result.panes.length > HERDR_MAX_LISTED_PANES) return null;
    const panes = result.panes.map((pane) => parseHerdrPane(pane, target.socketPath, target.protocol));
    if (panes.some((pane) => !pane)) return null;
    const matches = panes.filter((pane) => pane.terminalId === target.terminalId);
    if (matches.length !== 1) return null;
    const observed = matches[0];
    target.workspaceId = observed.workspaceId; target.tabId = observed.tabId; target.paneId = observed.paneId;
    return target;
  } catch { return null; }
}
const SESSION = /^\$(?:0|[1-9][0-9]*)$/;
const WINDOW = /^@(?:0|[1-9][0-9]*)$/;
const PID = /^[1-9][0-9]*$/;
const parsePid = (value) => {
  if (typeof value !== "string" || !PID.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};
const stripFinalLineEnding = (value) => value.endsWith("\r\n") ? value.slice(0, -2) : value.endsWith("\n") ? value.slice(0, -1) : value;
const parsePidOutput = (value) => parsePid(stripFinalLineEnding(value));
function processStartedAt(pid) {
  try {
    if (process.platform === "linux") { const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8"); const close = stat.lastIndexOf(")"); const fields = stat.slice(close + 1).trim().split(/\s+/); const started = Number(fields[19]); return Number.isSafeInteger(started) && started > 0 ? started : null; }
    if (process.platform === "darwin") {
      const probe = spawnSync("/bin/ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
      if (probe.status !== 0) return null;
      const [stat, ...startedAtFields] = String(probe.stdout).trim().split(/\s+/); const state = stat?.[0]; const startedAtText = startedAtFields.join(" ");
      if (!stat || !state || !new Set(["R", "S", "D", "I", "T", "U"]).has(state) || !/^[<NLs+]*$/.test(stat.slice(1))
        || !/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|0[1-9]|[12][0-9]|3[01]) [0-2][0-9]:[0-5][0-9]:[0-5][0-9] [0-9]{4}$/.test(startedAtText)) return null;
      // ps lstart omits a zone; use the same UTC canonicalization as the
      // controller's run protocol so test checkpoint identity survives TZ.
      const started = Date.parse(`${startedAtText} UTC`);
      return Number.isFinite(started) && started > 0 ? started : null;
    }
  } catch {}
  return null;
}
function tmuxGeneration(value) {
  return value && exact(value, ["socketPath", "socketDev", "socketIno", "serverStartedAt"])
    && typeof value.socketPath === "string" && path.isAbsolute(value.socketPath)
    && typeof value.socketDev === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketDev)
    && typeof value.socketIno === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketIno)
    && Number.isFinite(value.serverStartedAt) && value.serverStartedAt > 0 ? value : null;
}
function sameTmuxGeneration(left, right) {
  return Boolean(left && right && left.socketPath === right.socketPath && left.socketDev === right.socketDev && left.socketIno === right.socketIno && left.serverStartedAt === right.serverStartedAt);
}
function currentTmuxGeneration(generation, serverPid) {
  // Deterministic broker fixtures may inject the live-generation proof. This
  // seam is unavailable unless the explicit test harness marker is present.
  if (process.env.PI_SUBAGENT_TEST_HARNESS === "1" && process.env.PI_SUBAGENT_TEST_TMUX_GENERATION === "1") return Boolean(tmuxGeneration(generation));
  if (!tmuxGeneration(generation) || serverPid <= 0) return false;
  try {
    const resolved = path.join(fsSync.realpathSync.native(path.dirname(generation.socketPath)), path.basename(generation.socketPath));
    const stat = fsSync.lstatSync(resolved, { bigint: true }), startedAt = processStartedAt(serverPid);
    if (!stat.isSocket()) return false;
    const current = resolved === generation.socketPath && stat.dev.toString() === generation.socketDev && stat.ino.toString() === generation.socketIno && startedAt === generation.serverStartedAt;
    if (!current && process.env.PI_SUBAGENT_ACCEPTANCE_HARNESS === "1") console.error(`[pi-subagent acceptance broker] tmux generation mismatch: path=${resolved === generation.socketPath} dev=${stat.dev.toString() === generation.socketDev} ino=${stat.ino.toString() === generation.socketIno} started=${startedAt === generation.serverStartedAt}`);
    return current;
  } catch (error) {
    if (process.env.PI_SUBAGENT_ACCEPTANCE_HARNESS === "1") console.error(`[pi-subagent acceptance broker] tmux generation probe error: ${error instanceof Error ? error.message : "unknown"}`);
    return false;
  }
}
function hasConsistentArgv() {
  // --project-root is accepted as an ignored compatibility argument from
  // parent processes loaded before executable path-policy removal.
  const valueFlags = new Set(["--run-dir", "--nonce", "--runtime", "--runtime-interpreter", "--backend", "--wrapper", "--project-root"]);
  let verifyGateCount = 0, acceptanceCheckpointCount = 0, acceptancePostallocationCheckpointCount = 0;
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === "--verify-gate") { verifyGateCount += 1; continue; }
    if (value === "--acceptance-preallocation-checkpoint") { acceptanceCheckpointCount += 1; continue; }
    if (value === "--acceptance-postallocation-checkpoint") { acceptancePostallocationCheckpointCount += 1; continue; }
    if (!valueFlags.has(value) || index + 1 >= process.argv.length || process.argv[index + 1].startsWith("--")) return false;
    index += 1;
  }
  return verifyGateCount <= 1 && acceptanceCheckpointCount <= 1 && acceptancePostallocationCheckpointCount <= 1;
}
function singleArg(name) {
  const positions = process.argv.flatMap((value, index) => value === name ? [index] : []);
  return positions.length === 1 && positions[0] + 1 < process.argv.length ? process.argv[positions[0] + 1] : null;
}
if (!hasConsistentArgv()) process.exit(2);
const runDir = singleArg("--run-dir");
const expectedNonce = singleArg("--nonce");
const expectedRuntime = singleArg("--runtime");
const expectedRuntimeInterpreter = singleArg("--runtime-interpreter");
const expectedBackend = singleArg("--backend");
if (!runDir || !path.isAbsolute(runDir) || !expectedNonce || !/^[A-Za-z0-9_-]{32,256}$/.test(expectedNonce) || !expectedRuntime || !expectedRuntimeInterpreter || !expectedBackend) process.exit(2);
function regularFile(candidate, executable) {
  try {
    const resolved = fsSync.realpathSync(candidate), file = fsSync.statSync(resolved);
    if (!file.isFile()) return null;
    fsSync.accessSync(resolved, executable ? fsSync.constants.X_OK : fsSync.constants.R_OK);
    return resolved;
  } catch { return null; }
}
// `--runtime` is the resolver-selected invocation command (which may be a
// native runtime, env shebang, or shell wrapper). `--runtime-interpreter` is
// its resolver-derived initial interpreter. A wrapper may exec Bun/Node, so
// neither value is a provenance assertion about this broker's process.execPath.
const brokerRuntime = regularFile(expectedRuntime, true);
const brokerInterpreter = regularFile(expectedRuntimeInterpreter, true);
const backendPath = regularFile(expectedBackend, true);
let backendMode = null;
let protocolVersion = 2;
const legacyCmuxHarness = process.env.PI_SUBAGENT_TEST_HARNESS === "1";
// A detached broker has a separate process-owned UDS client. No cmux binary
// is spawned for allocation, rollback, inspection, or gate checks.
let cmuxCommand = null;
let cmuxManager = null;
let tmuxCommand = null;
let tmuxManager = null;
const cmuxBrokerOptions = { broker: true,
  ...(process.env.PI_SUBAGENT_TEST_HARNESS === "1" ? { appVersionValidator: (identify) => isStableSemverAtLeast(identify?.app_version, MINIMUM_CMUX_VERSION) || identify?.app_bundle_path === "/Applications/cmux.app" } : {}) };
const brokerEntrypoint = regularFile(path.resolve(process.argv[1] || ""), false);
if (!brokerRuntime || !brokerInterpreter || !backendPath || !brokerEntrypoint || !regularFile(process.execPath, true)) process.exit(2);
const rootDir = path.dirname(runDir);
const p = (name) => path.join(runDir, name);
const json = (value) => `${JSON.stringify(value)}\n`;
const now = () => Date.now();
const commandEnv = Object.fromEntries([
  // The resolver-selected executable may have an env shebang. Preserve the
  // same explicit user PATH so /usr/bin/env can resolve its interpreter.
  ["PATH", process.env.PATH || "/usr/bin:/bin"],
  ["HOME", process.env.HOME || os.homedir()],
  ["TMPDIR", process.env.TMPDIR || os.tmpdir()],
  ["TERM", process.env.TERM || "xterm-256color"],
  // Never forward a raw caller TMUX_BIN. The broker's argv already carries
  // the resolver-selected canonical executable, which is the only child/nested
  // backend identity permitted through this boundary.
  ...(path.isAbsolute(backendPath) ? [["TMUX_BIN", backendPath]] : []),
  ...["CMUX_SOCKET_PATH", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_BUNDLED_CLI_PATH", "TMUX", "TMUX_PANE"].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]]] : []),
  // The isolated test harness may pass a synthetic pane PID to its backend
  // fixture. It is never available to production verifier processes.
  ...(process.env.PI_SUBAGENT_TEST_HARNESS === "1" && typeof process.env.PI_SUBAGENT_TEST_TMUX_PANE_PID === "string" ? [["PI_SUBAGENT_TEST_TMUX_PANE_PID", process.env.PI_SUBAGENT_TEST_TMUX_PANE_PID]] : []),
  ...(process.env.PI_SUBAGENT_TEST_HARNESS === "1" && typeof process.env.PI_SUBAGENT_TEST_TMUX_SERVER_PID === "string" ? [["PI_SUBAGENT_TEST_TMUX_SERVER_PID", process.env.PI_SUBAGENT_TEST_TMUX_SERVER_PID]] : []),
]);
async function validateRunAuthority() {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const privateDir = async (directory) => {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)) throw new Error("unsafe run authority directory");
  };
  const marker = async (file, expected) => {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) throw new Error("unsafe ownership marker");
    const text = await fs.readFile(file, "utf8");
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) throw new Error("invalid ownership marker");
    const value = JSON.parse(text.slice(0, -1)); const keys = Object.keys(expected);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key) && value[key] === expected[key])) throw new Error("invalid ownership marker");
  };
  if (!path.isAbsolute(rootDir) || path.resolve(runDir) !== path.join(path.resolve(rootDir), path.basename(runDir))) throw new Error("unsafe run authority path");
  await privateDir(rootDir); await privateDir(runDir);
  await marker(path.join(rootDir, "state-root-marker.json"), { version: 1, kind: "pi-subagent-state-root" });
  await marker(path.join(runDir, "run-directory-marker.json"), { version: 1, kind: "pi-subagent-run-directory", runId: path.basename(runDir) });
  const [canonicalRoot, canonicalRun] = await Promise.all([fs.realpath(rootDir), fs.realpath(runDir)]);
  if (path.dirname(canonicalRun) !== canonicalRoot) throw new Error("run authority escaped root");
}
async function requireSafeRunAuthority() { await validateRunAuthority(); }

async function readBoundExact(file) {
  let handle;
  try {
    handle = await fs.open(file, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > 1024n * 1024n) return null;
    const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const pathname = await fs.lstat(file, { bigint: true });
    if (bytes.length !== Number(before.size) || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || pathname.isSymbolicLink() || pathname.dev !== after.dev || pathname.ino !== after.ino || pathname.size !== after.size || pathname.mtimeNs !== after.mtimeNs) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)); const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? { value, digest: crypto.createHash("sha256").update(bytes).digest("hex") } : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}
async function readExact(file) { return (await readBoundExact(file))?.value ?? null; }
async function exactDigest(file) { return (await readBoundExact(file))?.digest ?? null; }
async function immutable(file, value) {
  await requireSafeRunAuthority();
  const tmp = path.join(runDir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  let handle;
  try {
    handle = await fs.open(tmp, "wx", 0o600);
    await handle.writeFile(json(value)); await handle.sync(); await handle.close(); handle = undefined;
    await requireSafeRunAuthority();
    try { await fs.link(tmp, file); return "published"; } catch (error) {
      if (error?.code === "EEXIST") return "exists";
      throw error;
    }
  } finally { await handle?.close().catch(() => {}); await fs.rm(tmp, { force: true }).catch(() => {}); await fsyncDir(); }
}
async function fsyncDir() { await fs.open(runDir, "r").then(async (h) => { try { await h.sync(); } finally { await h.close(); } }).catch(() => {}); }
async function replace(file, value) {
  await requireSafeRunAuthority();
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try { handle = await fs.open(tmp, "wx", 0o600); await handle.writeFile(json(value)); await handle.sync(); await handle.close(); handle = undefined; await requireSafeRunAuthority(); await fs.rename(tmp, file); }
  finally { await handle?.close().catch(() => {}); await fs.rm(tmp, { force: true }).catch(() => {}); await fsyncDir(); }
}
async function command(bin, args, timeoutMs = 0) {
  if (bin === backendPath && (!backendMode || regularFile(backendPath, true) !== backendPath)) return { code: 1, stdout: "", stderr: "backend executable is no longer available" };
  return await new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, env: commandEnv }); let stdout = "", stderr = "", settled = false;
    let dispatched = false;
    const finish = (code, extra = "") => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr: stderr || extra, dispatched }); };
    const append = (prior, chunk) => (prior + chunk.toString()).slice(0, 64 * 1024);
    child.stdout.on("data", (c) => { stdout = append(stdout, c); }); child.stderr.on("data", (c) => { stderr = append(stderr, c); });
    child.once("spawn", () => { dispatched = true; });
    child.once("error", (error) => finish(1, error.message)); child.once("close", (code) => finish(code));
    const timer = timeoutMs > 0 ? setTimeout(() => { child.kill("SIGTERM"); finish(1, "command probe timed out"); }, timeoutMs) : null;
  });
}
function artifactPathEquals(value, name) { return typeof value === "string" && path.resolve(value) === p(name); }
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
function cmuxSourceContainer(value) {
  return exact(value, ["kind", "workspaceId", "sourceSurfaceId"])
    && value.kind === "cmux-source" && isUuidString(value.workspaceId) && isUuidString(value.sourceSurfaceId);
}
function cmuxPaneContainer(value) {
  return exact(value, ["kind", "workspaceId", "paneId"])
    && value.kind === "cmux-pane" && isUuidString(value.workspaceId) && isUuidString(value.paneId);
}
function cmuxSourcePaneContainer(value) {
  return exact(value, ["kind", "workspaceId", "sourceSurfaceId", "paneId"])
    && value.kind === "cmux-source-pane" && isUuidString(value.workspaceId) && isUuidString(value.sourceSurfaceId) && isUuidString(value.paneId);
}
function cmuxAllocatedContainer(value) { return cmuxPaneContainer(value); }
function tmuxSource(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["socketPath", "sourcePaneId", "sourcePanePid", "serverPid", "generation"].includes(key))
    && typeof value.sourcePaneId === "string" && PANE.test(value.sourcePaneId)
    && Number.isSafeInteger(value.sourcePanePid) && value.sourcePanePid > 0
    && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && (value.socketPath === undefined || typeof value.socketPath === "string")
    && (value.generation === undefined || tmuxGeneration(value.generation));
}
function tmuxSourceContainer(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["kind", "socketPath", "serverPid", "sessionId", "windowId", "paneId", "panePid", "generation"].includes(key))
    && ["kind", "serverPid", "sessionId", "windowId", "paneId", "panePid"].every((key) => Object.hasOwn(value, key))
    && value.kind === "tmux-source-pane" && (value.socketPath === undefined || typeof value.socketPath === "string")
    && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && typeof value.sessionId === "string" && SESSION.test(value.sessionId)
    && typeof value.windowId === "string" && WINDOW.test(value.windowId)
    && typeof value.paneId === "string" && PANE.test(value.paneId)
    && Number.isSafeInteger(value.panePid) && value.panePid > 0
    && (value.generation === undefined || tmuxGeneration(value.generation));
}
function tmuxSessionContainer(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["kind", "socketPath", "serverPid", "sessionId", "sourceWindowId", "generation"].includes(key))
    && ["kind", "serverPid", "sessionId", "sourceWindowId"].every((key) => Object.hasOwn(value, key))
    && value.kind === "tmux-session" && (value.socketPath === undefined || typeof value.socketPath === "string")
    && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && typeof value.sessionId === "string" && SESSION.test(value.sessionId)
    && typeof value.sourceWindowId === "string" && WINDOW.test(value.sourceWindowId)
    && (value.generation === undefined || tmuxGeneration(value.generation));
}
function intent(value) {
  const tmuxControlV3 = value?.version === 3 && value?.terminalMode === "tmux-pane";
  const base = value && (value.version === 2 || tmuxControlV3) && typeof value.runId === "string" && value.runId === path.basename(runDir) && typeof value.parentSessionId === "string" && value.parentSessionId && Number.isSafeInteger(value.parentPid) && value.parentPid > 0 && Number.isFinite(value.parentStartedAt) && value.parentStartedAt > 0 && Number.isFinite(value.createdAt) && value.createdAt > 0 && artifactPathEquals(value.childSessionFile, "child-session.jsonl") && value.brokerNonce === expectedNonce && value.runtimePath === brokerRuntime && value.runtimeInterpreterPath === brokerInterpreter && value.backendPath === backendPath && value.brokerEntrypoint === brokerEntrypoint;
  if (!base) return null;
  const baseKeys = ["version", "runId", ...(Object.hasOwn(value, "parentRunId") ? ["parentRunId"] : []), "parentSessionId", "parentPid", "parentStartedAt", "terminalMode", "source", "childSessionFile", "createdAt", "brokerNonce", "runtimePath", "runtimeInterpreterPath", "backendPath", "brokerEntrypoint"];
  if (Object.hasOwn(value, "parentRunId") && (typeof value.parentRunId !== "string" || !value.parentRunId)) return null;
  const layoutKeys = ["layout", "placement", "container"];
  const hasLayout = layoutKeys.some((key) => Object.hasOwn(value, key));
  const control = (candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && Object.keys(candidate).every((key) => ["transport", "socketPath", "socketDev", "socketIno", "accessMode", "apiVersion", "appVersion", "identifyDigest", "bootIdentity"].includes(key))
    && ["transport", "socketPath", "socketDev", "socketIno", "accessMode", "apiVersion", "appVersion", "identifyDigest"].every((key) => Object.hasOwn(candidate, key))
    && candidate.transport === "cmux-control-v2" && typeof candidate.socketPath === "string" && path.isAbsolute(candidate.socketPath)
    && /^(?:0|[1-9][0-9]*)$/.test(candidate.socketDev) && /^(?:0|[1-9][0-9]*)$/.test(candidate.socketIno)
    && typeof candidate.accessMode === "string" && candidate.accessMode.length > 0 && candidate.apiVersion === 2 && typeof candidate.appVersion === "string" && isStableSemverAtLeast(candidate.appVersion, MINIMUM_CMUX_VERSION) && /^[a-f0-9]{64}$/.test(candidate.identifyDigest)
    && (candidate.bootIdentity === undefined || typeof candidate.bootIdentity === "string");
  const requiresControl = value.terminalMode === "cmux-pane" && !legacyCmuxHarness;
  const transportKeys = tmuxControlV3 ? ["transport", "transportGatePath", "transportGateDigest"] : [];
  const tmuxNewWindow = value.terminalMode === "tmux-pane" && value.placement === "tmux-new-window";
  const expected = hasLayout ? [...baseKeys, ...layoutKeys, ...(tmuxNewWindow ? ["windowLabel"] : []), ...(requiresControl ? ["control"] : []), ...transportKeys] : [...baseKeys, ...transportKeys];
  if (!exact(value, expected) || hasLayout && !layoutKeys.every((key) => Object.hasOwn(value, key))
    || tmuxNewWindow && !isValidTmuxWindowLabel(value.windowLabel, value.runId)
    || value.terminalMode === "cmux-pane" && ((!hasLayout && !legacyCmuxHarness) || requiresControl && !control(value.control))
    || tmuxControlV3 && (value.transport !== "tmux-control-v1" || !artifactPathEquals(value.transportGatePath, "transport-gate.json") || typeof value.transportGateDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.transportGateDigest))) return null;
  const sourceValid = value.terminalMode === "cmux-pane"
    ? exact(value.source, ["workspaceId", "sourceSurfaceId"]) && isUuidString(value.source.workspaceId) && isUuidString(value.source.sourceSurfaceId)
    : value.terminalMode === "tmux-pane" ? tmuxSource(value.source)
      : value.terminalMode === "herdr-pane" && herdrSource(value.source);
  if (!sourceValid) return null;
  // New tmux authority is always generation-bound. Generation-less V2
  // records remain parseable diagnostics in the parent, but this broker must
  // never allocate or mutate from them.
  if (value.terminalMode === "tmux-pane" && (!tmuxGeneration(value.source.generation) || value.source.socketPath !== value.source.generation.socketPath || (value.version === 3 && !hasLayout))) return null;
  if (!hasLayout) return value;
  if (value.terminalMode === "cmux-pane") {
    if (value.placement === "cmux-split" && ["auto", "split"].includes(value.layout) && cmuxSourceContainer(value.container)) return value;
    if (value.placement === "cmux-new-surface" && value.layout === "auto" && (cmuxPaneContainer(value.container) || cmuxSourcePaneContainer(value.container))) return value;
    return null;
  }
  if (value.placement === "tmux-split" && value.layout === "split" && tmuxSourceContainer(value.container)
    && tmuxGeneration(value.container.generation) && sameTmuxGeneration(value.source.generation, value.container.generation)
    && value.container.socketPath === value.source.socketPath && value.container.serverPid === value.source.serverPid) return value;
  if (value.placement === "tmux-new-window" && value.layout === "auto" && tmuxSessionContainer(value.container)
    && tmuxGeneration(value.container.generation) && sameTmuxGeneration(value.source.generation, value.container.generation)
    && value.container.socketPath === value.source.socketPath && value.container.serverPid === value.source.serverPid) return value;
  return null;
}
function decision(value, runId) {
  if (!value || value.version !== protocolVersion || value.runId !== runId || !Number.isFinite(value.decidedAt) || value.decidedAt <= 0) return null;
  if (value.kind === "cancel" && exact(value, ["version", "runId", "kind", "decidedAt", "reason"]) && ["parent-abort", "ready-timeout", "commit-timeout"].includes(value.reason)) return value;
  if (value.kind === "commit" && exact(value, ["version", "runId", "kind", "decidedAt", "allocationPath", "launchPath"]) && artifactPathEquals(value.allocationPath, "allocation.json") && artifactPathEquals(value.launchPath, "launch.json")) return value;
  return null;
}
function tmuxTarget(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["socketPath", "serverPid", "paneId", "panePid", "generation"].includes(key))
    && typeof value.paneId === "string" && PANE.test(value.paneId)
    && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && Number.isSafeInteger(value.panePid) && value.panePid > 0
    && (value.socketPath === undefined || typeof value.socketPath === "string") && (value.generation === undefined || tmuxGeneration(value.generation));
}
function tmuxWindowContainer(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["kind", "socketPath", "serverPid", "sessionId", "windowId", "paneId", "panePid", "generation"].includes(key))
    && ["kind", "serverPid", "sessionId", "windowId", "paneId", "panePid"].every((key) => Object.hasOwn(value, key))
    && value.kind === "tmux-window" && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && typeof value.sessionId === "string" && SESSION.test(value.sessionId)
    && typeof value.windowId === "string" && WINDOW.test(value.windowId)
    && typeof value.paneId === "string" && PANE.test(value.paneId)
    && Number.isSafeInteger(value.panePid) && value.panePid > 0
    && (value.socketPath === undefined || typeof value.socketPath === "string") && (value.generation === undefined || tmuxGeneration(value.generation));
}
function allocation(value, runId) {
  if (!value || value.version !== protocolVersion || value.runId !== runId || !Number.isFinite(value.allocatedAt) || value.allocatedAt <= 0 || !value.target || typeof value.target !== "object") return null;
  const hasLayout = ["layout", "placement", "container"].some((key) => Object.hasOwn(value, key));
  const baseKeys = ["version", "runId", "terminalMode", "target", "allocatedAt"];
  const requiresControl = value.terminalMode === "cmux-pane" && !legacyCmuxHarness;
  const transportKeys = value.version === 3 ? ["transport", "intentDigest"] : [];
  if (!exact(value, hasLayout ? [...baseKeys, "layout", "placement", "container", ...(requiresControl ? ["control"] : []), ...transportKeys] : [...baseKeys, ...transportKeys])) return null;
  if (value.version === 3 && (value.terminalMode !== "tmux-pane" || value.transport !== "tmux-control-v1" || typeof value.intentDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.intentDigest))) return null;
  if (requiresControl && (!value.control || value.control.transport !== "cmux-control-v2" || !isStableSemverAtLeast(value.control.appVersion, MINIMUM_CMUX_VERSION))) return null;
  if (value.terminalMode === "herdr-pane") return !hasLayout && herdrTarget(value.target) ? value : null;
  if (value.terminalMode === "cmux-pane" && exact(value.target, ["workspaceId", "surfaceId", "paneId"]) && isUuidString(value.target.workspaceId) && isUuidString(value.target.surfaceId) && isUuidString(value.target.paneId)) {
    if (!hasLayout) return value;
    return cmuxAllocatedContainer(value.container)
      && cmuxIdsEqual(value.container.workspaceId, value.target.workspaceId)
      && cmuxIdsEqual(value.container.paneId, value.target.paneId)
      && ((value.placement === "cmux-split" && ["auto", "split"].includes(value.layout))
        || (value.placement === "cmux-new-surface" && value.layout === "auto")) ? value : null;
  }
  if (value.terminalMode !== "tmux-pane" || !tmuxTarget(value.target)) return null;
  if (!hasLayout) return value;
  if (!tmuxWindowContainer(value.container) || value.container.socketPath !== value.target.socketPath || value.container.serverPid !== value.target.serverPid || value.container.paneId !== value.target.paneId || value.container.panePid !== value.target.panePid) return null;
  return (value.placement === "tmux-split" && value.layout === "split" || value.placement === "tmux-new-window" && value.layout === "auto") ? value : null;
}
function launch(value, runId, terminalMode) {
  const keys = ["version", "runId", "terminalMode", ...(protocolVersion === 3 ? ["transport"] : []), "allocationPath", ...(protocolVersion === 3 ? ["allocationDigest"] : []), "childSessionFile", "committedAt", "ownership"];
  return value && exact(value, keys) && value.version === protocolVersion && value.runId === runId && value.terminalMode === terminalMode
    && (protocolVersion !== 3 || value.transport === "tmux-control-v1" && typeof value.allocationDigest === "string" && /^[a-f0-9]{64}$/.test(value.allocationDigest))
    && artifactPathEquals(value.allocationPath, "allocation.json") && artifactPathEquals(value.childSessionFile, "child-session.jsonl") && value.ownership === "parent-owned" && Number.isFinite(value.committedAt) && value.committedAt > 0 ? value : null;
}
function gate(value, runId, terminalMode) {
  const base = value && value.version === protocolVersion && value.runId === runId && value.terminalMode === terminalMode && artifactPathEquals(value.launchPath, "launch.json") && Number.isFinite(value.publishedAt) && value.publishedAt > 0;
  if (!base) return null;
  if (terminalMode === "herdr-pane") return exact(value, ["version", "runId", "terminalMode", "protocol", "launchPath", "publishedAt"]) && isHerdrProtocol(value.protocol) ? value : null;
  return exact(value, ["version", "runId", "terminalMode", "launchPath", "publishedAt"]) ? value : null;
}
function targetFromAllocation(value) {
  return value.terminalMode === "cmux-pane"
    ? { mode: "cmux-pane", workspaceId: value.target.workspaceId, surfaceId: value.target.surfaceId, paneId: value.target.paneId }
    : value.terminalMode === "herdr-pane"
      ? { mode: "herdr-pane", ...value.target }
      : { mode: "tmux-pane", socketPath: value.target.socketPath, serverPid: value.target.serverPid, paneId: value.target.paneId, panePid: value.target.panePid, generation: value.target.generation };
}
function sameTarget(left, right) {
  return left.mode === right.mode && (left.mode === "cmux-pane"
    ? cmuxIdsEqual(left.workspaceId, right.workspaceId) && cmuxIdsEqual(left.surfaceId, right.surfaceId) && cmuxIdsEqual(left.paneId, right.paneId)
    : left.mode === "herdr-pane"
      ? left.socketPath === right.socketPath && left.workspaceId === right.workspaceId && left.tabId === right.tabId && left.paneId === right.paneId && left.terminalId === right.terminalId && left.protocol === right.protocol
      : left.socketPath === right.socketPath && left.serverPid === right.serverPid && left.paneId === right.paneId && left.panePid === right.panePid && sameTmuxGeneration(left.generation, right.generation));
}
function isTmuxSourceTarget(intentRecord, target) {
  // Pane IDs are the backend's allocation identity. A recycled or changed PID
  // never turns the immutable source pane into rollback authority.
  return intentRecord?.terminalMode === "tmux-pane" && target?.mode === "tmux-pane"
    && target.paneId === intentRecord.source.sourcePaneId;
}
function isSourceTarget(intentRecord, target) {
  return intentRecord?.terminalMode === "cmux-pane"
    ? target?.mode === "cmux-pane" && cmuxIdsEqual(target.workspaceId, intentRecord.source.workspaceId) && cmuxIdsEqual(target.surfaceId, intentRecord.source.sourceSurfaceId)
    : intentRecord?.terminalMode === "herdr-pane"
      ? target?.mode === "herdr-pane" && target.socketPath === intentRecord.source.socketPath && target.protocol === intentRecord.source.protocol && target.terminalId === intentRecord.source.sourceTerminalId
      : isTmuxSourceTarget(intentRecord, target);
}
function allocationMatchesIntentSource(intentRecord, allocationRecord) {
  if (!intentRecord || !allocationRecord || intentRecord.terminalMode !== allocationRecord.terminalMode) return false;
  const layoutIntent = Object.hasOwn(intentRecord, "layout"), layoutAllocation = Object.hasOwn(allocationRecord, "layout");
  if (layoutIntent !== layoutAllocation) return false;
  if (intentRecord.terminalMode === "herdr-pane") {
    return !layoutIntent && allocationRecord.target.socketPath === intentRecord.source.socketPath
      && allocationRecord.target.workspaceId === intentRecord.source.workspaceId && allocationRecord.target.tabId === intentRecord.source.tabId
      && allocationRecord.target.protocol === intentRecord.source.protocol && allocationRecord.target.terminalId !== intentRecord.source.sourceTerminalId;
  }
  if (intentRecord.terminalMode === "cmux-pane") {
    if (!legacyCmuxHarness && (!intentRecord.control || !allocationRecord.control || JSON.stringify(intentRecord.control) !== JSON.stringify(allocationRecord.control))) return false;
    const sourceMatches = cmuxIdsEqual(allocationRecord.target.workspaceId, intentRecord.source.workspaceId)
      && !cmuxIdsEqual(allocationRecord.target.surfaceId, intentRecord.source.sourceSurfaceId);
    if (!sourceMatches) return false;
    if (!layoutIntent) return true;
    if (intentRecord.layout !== allocationRecord.layout || intentRecord.placement !== allocationRecord.placement
      || !cmuxIdsEqual(allocationRecord.container.workspaceId, allocationRecord.target.workspaceId)
      || !cmuxIdsEqual(allocationRecord.container.paneId, allocationRecord.target.paneId)) return false;
    const request = intentRecord.container;
    if (request.kind === "cmux-source") return cmuxIdsEqual(request.workspaceId, intentRecord.source.workspaceId)
      && cmuxIdsEqual(request.sourceSurfaceId, intentRecord.source.sourceSurfaceId);
    if (request.kind === "cmux-pane") return cmuxIdsEqual(request.workspaceId, intentRecord.source.workspaceId)
      && cmuxIdsEqual(request.workspaceId, allocationRecord.container.workspaceId)
      && cmuxIdsEqual(request.paneId, allocationRecord.container.paneId);
    return request.kind === "cmux-source-pane"
      && cmuxIdsEqual(request.workspaceId, intentRecord.source.workspaceId)
      && cmuxIdsEqual(request.sourceSurfaceId, intentRecord.source.sourceSurfaceId)
      && cmuxIdsEqual(request.workspaceId, allocationRecord.container.workspaceId)
      && cmuxIdsEqual(request.paneId, allocationRecord.container.paneId);
  }
  const sourceMatches = tmuxGeneration(intentRecord.source.generation) && tmuxGeneration(allocationRecord.target.generation)
    && sameTmuxGeneration(intentRecord.source.generation, allocationRecord.target.generation)
    && allocationRecord.target.socketPath === intentRecord.source.socketPath
    && allocationRecord.target.serverPid === intentRecord.source.serverPid
    && allocationRecord.target.paneId !== intentRecord.source.sourcePaneId;
  if (!sourceMatches) return false;
  if (!layoutIntent) return true;
  if (!tmuxGeneration(allocationRecord.container.generation)
    || !sameTmuxGeneration(intentRecord.source.generation, allocationRecord.container.generation)
    || intentRecord.layout !== allocationRecord.layout || intentRecord.placement !== allocationRecord.placement
    || allocationRecord.container.socketPath !== allocationRecord.target.socketPath
    || allocationRecord.container.serverPid !== allocationRecord.target.serverPid
    || allocationRecord.container.paneId !== allocationRecord.target.paneId
    || allocationRecord.container.panePid !== allocationRecord.target.panePid) return false;
  if (intentRecord.placement === "tmux-split") {
    const request = intentRecord.container;
    return request.kind === "tmux-source-pane" && tmuxGeneration(request.generation)
      && sameTmuxGeneration(intentRecord.source.generation, request.generation)
      && request.socketPath === intentRecord.source.socketPath
      && request.serverPid === intentRecord.source.serverPid && request.paneId === intentRecord.source.sourcePaneId
      && request.panePid === intentRecord.source.sourcePanePid
      && allocationRecord.container.sessionId === request.sessionId && allocationRecord.container.windowId === request.windowId;
  }
  const request = intentRecord.container;
  return request.kind === "tmux-session" && tmuxGeneration(request.generation)
    && sameTmuxGeneration(intentRecord.source.generation, request.generation)
    && request.socketPath === intentRecord.source.socketPath
    && request.serverPid === intentRecord.source.serverPid && allocationRecord.container.sessionId === request.sessionId
    && allocationRecord.container.windowId !== request.sourceWindowId;
}
async function validV3Chain(i, a, l) {
  if (i.version !== 3) return true;
  const [gateArtifact, intentArtifact, allocationArtifact, launchArtifact] = await Promise.all([
    readBoundExact(i.transportGatePath), readBoundExact(p("launch-intent.json")), readBoundExact(p("allocation.json")), readBoundExact(p("launch.json")),
  ]);
  return gateArtifact?.digest === i.transportGateDigest
    && intentArtifact?.digest === a?.intentDigest && JSON.stringify(intentArtifact?.value) === JSON.stringify(i)
    && a?.transport === "tmux-control-v1" && allocationArtifact?.digest === l?.allocationDigest && JSON.stringify(allocationArtifact?.value) === JSON.stringify(a)
    && l?.transport === "tmux-control-v1" && JSON.stringify(launchArtifact?.value) === JSON.stringify(l);
}
function validStateDependencies(allocationRecord, decisionRecord, launchRecord, gateRecord) {
  if (decisionRecord?.kind === "commit" && !allocationRecord) return false;
  if (decisionRecord?.kind === "cancel" && (launchRecord || gateRecord)) return false;
  if (launchRecord && (!allocationRecord || decisionRecord?.kind !== "commit" || launchRecord.terminalMode !== allocationRecord.terminalMode)) return false;
  if (gateRecord && (!launchRecord || !allocationRecord || decisionRecord?.kind !== "commit" || gateRecord.terminalMode !== allocationRecord.terminalMode || gateRecord.terminalMode !== launchRecord.terminalMode)) return false;
  if (allocationRecord?.terminalMode === "herdr-pane" && gateRecord?.terminalMode === "herdr-pane" && gateRecord.protocol !== allocationRecord.target.protocol) return false;
  return true;
}
async function residualRisk(runId) {
  recordPhase0LiveTelemetry(backendMode === "tmux-pane" ? "tmux" : backendMode === "herdr-pane" ? "herdr" : "cmux", "residualRecovery", 1, "broker");
  await immutable(p("residual-risk.json"), { version: protocolVersion, runId, reason: "possible-unrecorded-allocation", recordedAt: now() }).catch(() => {});
}
async function status(runId, phase, errorCode) {
  // Residual risk is immutable and authoritative: no later broker status can
  // make an uncertain allocation look committed or safe to delete.
  if (phase !== "failed" && await readExact(p("residual-risk.json"))) return;
  const value = { version: protocolVersion, runId, writer: "broker", pid: process.pid, phase, updatedAt: now(), ...(errorCode ? { errorCode } : {}) };
  await replace(p("broker-status.json"), value).catch(() => {});
}
async function riskAndFail(runId) { await residualRisk(runId); await status(runId, "failed", "possible-unrecorded-allocation"); }
async function recordLaunchDeliveryUnknown(runId) {
  // Allocation is already immutable and exact: retain it for bounded parent /
  // reaper reconciliation instead of conflating it with an unknown split.
  await immutable(p("launch-delivery-unknown.json"), { version: protocolVersion, runId, terminalMode: "herdr-pane", allocationPath: p("allocation.json"), recordedAt: now() });
  await status(runId, "failed", "launch-delivery-unknown");
}
async function rollback(target, intentRecord) {
  // A backend response that aliases the immutable source is never rollback
  // authority, even if its other fingerprint fields happen to match.
  if (isSourceTarget(intentRecord, target)) return false;
  if (target.mode === "herdr-pane") {
    // The protocol gate and stable-terminal rebinding are immediately before
    // the close mutation; an old pane_id after pane.moved is never authority.
    const current = await revalidateHerdrTarget(target);
    if (!current) return false;
    await herdrRequest(current.socketPath, "pane.close", { pane_id: current.paneId }, true);
    return parseHerdrPane(await herdrRequest(current.socketPath, "pane.get", { pane_id: current.paneId }).catch(() => ({ pane: null })), current.socketPath, current.protocol) === null;
  }
  if (target.mode === "cmux-pane") {
    // A surface can move workspaces. Establish both presence and its current
    // canonical workspace from one strict global topology before mutating.
    const before = await cmuxCommand(["--json", "--id-format", "both", "tree", "--all"]);
    const current = before.code === 0 ? canonicalCmuxSurface(parseCanonicalCmuxTopology(before.stdout), target.surfaceId) : null;
    if (current === false) return true;
    if (!current) return false;
    await cmuxCommand(["close-surface", "--workspace", current.workspaceId, "--surface", current.surfaceId]);
    const after = await cmuxCommand(["--json", "--id-format", "both", "tree", "--all"]);
    return after.code === 0 && canonicalCmuxSurface(parseCanonicalCmuxTopology(after.stdout), target.surfaceId) === false;
  }
  // A pane id can be recycled after server restart. Prove the complete target
  // fingerprint before issuing even a guarded mutation; malformed or duplicate
  // unrelated rows are ambiguous and therefore suppress the command.
  if (!tmuxGeneration(target.generation) || !currentTmuxGeneration(target.generation, target.serverPid)) return false;
  const socket = target.socketPath ? ["-S", target.socketPath] : [];
  const runTmux = tmuxCommand ?? (async (args) => await command(backendPath, args));
  const before = await runTmux([...socket, "list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}"]);
  const fingerprint = before.code === 0 ? parseTmuxPanePidList(before.stdout, target.paneId) : null;
  if (fingerprint === false) return true;
  if (fingerprint !== target.panePid) return false;
  const condition = `#{&&:#{==:#{pid},${target.serverPid}},#{==:#{pane_pid},${target.panePid}}}`;
  await runTmux([...socket, "if-shell", "-F", "-t", target.paneId, condition, `kill-pane -t ${target.paneId}`, "display-message -p -l pi-subagent-guard-noop"]);
  const after = await runTmux([...socket, "list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}"]);
  return after.code === 0 && parseTmuxPanePidList(after.stdout, target.paneId) === false;
}
function parseCanonicalCmuxTopology(stdout) {
  let tree; try { tree = JSON.parse(stdout); } catch { return null; }
  if (!tree || typeof tree !== "object" || Array.isArray(tree) || !Array.isArray(tree.windows)) return null;
  // Preserve each global namespace so a returned allocation identity can prove
  // novelty against the exact pre-mutation topology.
  const workspaceIds = new Set(), paneIds = new Set(), surfaceIds = new Set(), workspaces = [];
  for (const window of tree.windows) {
    if (!window || typeof window !== "object" || Array.isArray(window) || !Array.isArray(window.workspaces)) return null;
    for (const workspace of window.workspaces) {
      const workspaceKey = typeof workspace?.id === "string" ? workspace.id.toLowerCase() : "";
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace) || !isUuidString(workspace.id) || !Array.isArray(workspace.panes) || workspaceIds.has(workspaceKey)) return null;
      workspaceIds.add(workspaceKey); const panes = [];
      for (const pane of workspace.panes) {
        const paneKey = typeof pane?.id === "string" ? pane.id.toLowerCase() : "";
        if (!pane || typeof pane !== "object" || Array.isArray(pane) || !isUuidString(pane.id) || !Array.isArray(pane.surfaces) || paneIds.has(paneKey)) return null;
        paneIds.add(paneKey); const surfaces = [];
        for (const surface of pane.surfaces) {
          const surfaceKey = typeof surface?.id === "string" ? surface.id.toLowerCase() : "";
          if (!surface || typeof surface !== "object" || Array.isArray(surface) || !isUuidString(surface.id) || !cmuxIdsEqual(surface.pane_id, pane.id) || surfaceIds.has(surfaceKey)) return null;
          surfaceIds.add(surfaceKey); surfaces.push(surface.id);
        }
        panes.push({ id: pane.id, surfaces });
      }
      workspaces.push({ id: workspace.id, panes });
    }
  }
  return { workspaces, workspaceIds, paneIds, surfaceIds };
}
function canonicalCmuxPane(topology, workspaceId, paneId) {
  if (!topology || !isUuidString(workspaceId) || !isUuidString(paneId)) return null;
  const matchingWorkspaces = topology.workspaces.filter((workspace) => cmuxIdsEqual(workspace.id, workspaceId));
  if (matchingWorkspaces.length !== 1) return null;
  const matchingPanes = matchingWorkspaces[0].panes.filter((pane) => cmuxIdsEqual(pane.id, paneId));
  return matchingPanes.length === 1 ? matchingPanes[0] : null;
}
function canonicalCmuxSourcePane(topology, workspaceId, surfaceId) {
  if (!topology || !isUuidString(workspaceId) || !isUuidString(surfaceId)) return null;
  const matchingWorkspaces = topology.workspaces.filter((workspace) => cmuxIdsEqual(workspace.id, workspaceId));
  if (matchingWorkspaces.length !== 1) return null;
  const matches = matchingWorkspaces[0].panes.filter((pane) => pane.surfaces.some((surface) => cmuxIdsEqual(surface, surfaceId)));
  return matches.length === 1 ? matches[0] : null;
}
function canonicalCmuxSurface(topology, surfaceId) {
  if (!topology || !isUuidString(surfaceId)) return null;
  const matches = [];
  for (const workspace of topology.workspaces) for (const pane of workspace.panes) {
    if (pane.surfaces.some((surface) => cmuxIdsEqual(surface, surfaceId))) matches.push({ workspaceId: workspace.id, paneId: pane.id, surfaceId: pane.surfaces.find((surface) => cmuxIdsEqual(surface, surfaceId)) });
  }
  return matches.length === 0 ? false : matches.length === 1 ? matches[0] : null;
}
function cmuxResponseValue(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.hasOwn(parsed, "result")
      ? parsed.result && typeof parsed.result === "object" && !Array.isArray(parsed.result) ? parsed.result : null
      : parsed;
  } catch { return null; }
}
async function allocateCmux(i) {
  const layout = Object.hasOwn(i, "layout");
  // Every allocation captures one strict, global pre-mutation topology. It is
  // both source authority and the novelty baseline for returned identities.
  const treeResult = await cmuxCommand(["--json", "--id-format", "both", "tree", "--all"]);
  const topology = treeResult.code === 0 ? parseCanonicalCmuxTopology(treeResult.stdout) : null;
  const sourcePane = topology && canonicalCmuxSourcePane(topology, i.source.workspaceId, i.source.sourceSurfaceId);
  if (!topology || !sourcePane) throw new Error("cmux source topology changed before allocation");
  let requestedPaneId = null, args, split = true;
  if (layout) {
    if (!cmuxIdsEqual(i.container.workspaceId, i.source.workspaceId)) throw new Error("cmux source topology changed before allocation");
    if (i.placement === "cmux-split") {
      if (!cmuxIdsEqual(i.container.sourceSurfaceId, i.source.sourceSurfaceId)) throw new Error("cmux split source changed before allocation");
    } else {
      split = false;
      const requestedPane = canonicalCmuxPane(topology, i.container.workspaceId, i.container.paneId);
      if (!requestedPane) throw new Error("cmux requested pane topology changed before allocation");
      if (i.container.kind === "cmux-source-pane" && (!cmuxIdsEqual(i.container.sourceSurfaceId, i.source.sourceSurfaceId) || !cmuxIdsEqual(sourcePane.id, requestedPane.id))) throw new Error("cmux source pane topology changed before allocation");
      requestedPaneId = requestedPane.id;
    }
  }
  if (split) args = ["--json", "--id-format", "both", "new-split", "right", "--workspace", i.source.workspaceId, "--surface", i.source.sourceSurfaceId, "--focus", "false"];
  else args = ["--json", "--id-format", "both", "new-surface", "--type", "terminal", "--workspace", i.container.workspaceId, "--pane", requestedPaneId, "--working-directory", path.dirname(i.childSessionFile), "--focus", "false"];
  const result = await cmuxCommand(args);
  const value = cmuxResponseValue(result.stdout);
  const exact = value && isUuidString(value.workspace_id) && isUuidString(value.surface_id) && isUuidString(value.pane_id)
    && cmuxIdsEqual(value.workspace_id, i.source.workspaceId)
    && !cmuxIdsEqual(value.surface_id, i.source.sourceSurfaceId)
    && !topology.surfaceIds.has(value.surface_id.toLowerCase())
    && (split
      ? !topology.paneIds.has(value.pane_id.toLowerCase()) && !cmuxIdsEqual(value.pane_id, sourcePane.id)
      : cmuxIdsEqual(value.pane_id, requestedPaneId));
  if (!exact) {
    // A named result which is stale, pre-existing, or aliases the source is
    // never owned by this broker. After dispatch it is residual risk only.
    if (!result.dispatched) throw new Error(result.stderr || result.stdout || "cmux allocation failed");
    throw new Error("cmux possible-unrecorded-allocation");
  }
  return {
    mode: "cmux-pane", workspaceId: value.workspace_id, surfaceId: value.surface_id, paneId: value.pane_id,
    ...(result.code !== 0 ? { allocationFailed: true, allocationError: result.stderr || result.stdout || "cmux allocation failed" } : {}),
  };
}
async function allocateHerdr(i) {
  // Intent protocol binding and this preflight prevent an older/incompatible
  // server from ever observing a split mutation. Repeat at the boundary.
  await assertHerdrProtocol(i.source.socketPath, i.source.protocol);
  const sourceResponse = await herdrRequest(i.source.socketPath, "pane.get", { pane_id: i.source.sourcePaneId });
  const source = parseHerdrPane(sourceResponse, i.source.socketPath, i.source.protocol);
  if (!source || source.workspaceId !== i.source.workspaceId || source.tabId !== i.source.tabId
    || source.paneId !== i.source.sourcePaneId || source.terminalId !== i.source.sourceTerminalId) throw new Error("Herdr source binding changed before allocation");
  await assertHerdrProtocol(i.source.socketPath, i.source.protocol);
  const current = parseHerdrPane(await herdrRequest(i.source.socketPath, "pane.get", { pane_id: source.paneId }), i.source.socketPath, i.source.protocol);
  // The immutable terminal identity, not the public pane address, is the
  // authority revalidated immediately before the split mutation.
  if (!current || current.terminalId !== i.source.sourceTerminalId || current.workspaceId !== source.workspaceId || current.tabId !== source.tabId) throw new Error("Herdr source binding changed immediately before allocation");
  const split = await herdrRequest(i.source.socketPath, "pane.split", { target_pane_id: current.paneId, direction: "right", cwd: path.dirname(i.childSessionFile), focus: false }, true);
  const target = parseHerdrPane(split, i.source.socketPath, i.source.protocol);
  if (!target || target.workspaceId !== source.workspaceId || target.tabId !== source.tabId || target.terminalId === i.source.sourceTerminalId) {
    throw new HerdrUnknownOutcomeError("pane.split", "Herdr pane.split did not return an exact new terminal binding");
  }
  return target;
}
function socketArgs(socket) { return socket ? ["-S", socket] : []; }
async function safeTmuxShellHome() {
  const shellHome = p("shell-home");
  try {
    const stat = await fs.lstat(shellHome);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) || path.resolve(shellHome) !== path.join(path.resolve(runDir), "shell-home")) return null;
    return shellHome;
  } catch { return null; }
}
function parseTmuxPanePidList(stdout, targetPaneId, delimiter = "|") {
  const text = stripFinalLineEnding(stdout); if (text.endsWith("\r") || !PANE.test(targetPaneId)) return null;
  let target = false; const seen = new Set();
  for (const line of text ? text.split("\n") : []) {
    const fields = line.split(delimiter); if (fields.length !== 2) return null;
    const [paneId, panePidText] = fields, panePid = parsePid(panePidText);
    if (!PANE.test(paneId) || panePid === null || seen.has(paneId)) return null;
    seen.add(paneId); if (paneId === targetPaneId) target = panePid;
  }
  return target;
}
function parseTmuxPipePanePidList(stdout, targetPaneId) { return parseTmuxPanePidList(stdout, targetPaneId, "|"); }
function parseTmuxTopologyFingerprint(stdout, sourcePaneId, sessionFirst = false) {
  const text = stripFinalLineEnding(stdout); if (!text || text.endsWith("\r")) return null;
  let source = null; const panes = new Map();
  for (const line of text.split("\n")) {
    const fields = line.split("|"); if (fields.length !== 4) return null;
    const [first, second, third, panePidText] = fields;
    const [paneId, sessionId, windowId] = sessionFirst ? [third, first, second] : [first, second, third];
    const panePid = parsePid(panePidText);
    if (!PANE.test(paneId) || !SESSION.test(sessionId) || !WINDOW.test(windowId) || panePid === null || panes.has(paneId)) return null;
    const fingerprint = { paneId, sessionId, windowId, panePid };
    panes.set(paneId, fingerprint); if (paneId === sourcePaneId) source = fingerprint;
  }
  return source ? { panes, source } : null;
}
function parseTmuxCreatedPane(stdout, layout, sessionId) {
  const fields = stripFinalLineEnding(stdout).split("|");
  if (layout) {
    const [createdSessionId, windowId, paneId, panePidText, ...extra] = fields, panePid = parsePid(panePidText);
    return !extra.length && createdSessionId === sessionId && SESSION.test(createdSessionId) && WINDOW.test(windowId) && PANE.test(paneId) && panePid !== null
      ? { sessionId: createdSessionId, windowId, paneId, panePid } : null;
  }
  const [paneId, panePidText, ...extra] = fields, panePid = parsePid(panePidText);
  return !extra.length && PANE.test(paneId) && panePid !== null ? { paneId, panePid } : null;
}
async function allocateTmux(i) {
  const source = i.source, socket = socketArgs(source.socketPath), layout = Object.hasOwn(i, "layout");
  const runTmux = tmuxCommand ?? (async (args) => await command(backendPath, args));
  if (!tmuxGeneration(source.generation) || source.socketPath !== source.generation.socketPath || !currentTmuxGeneration(source.generation, source.serverPid)) throw new Error("tmux generation changed before allocation");
  const shellHome = await safeTmuxShellHome();
  if (!shellHome) throw new Error("tmux private shell home is unsafe");
  const server = await runTmux([...socket, "display-message", "-p", "#{pid}"]);
  if (server.code || parsePidOutput(server.stdout) !== source.serverPid) throw new Error("tmux server identity changed before allocation");
  let request = null;
  const sessionFirst = layout && i.placement === "tmux-new-window";
  // One strict, complete pre-allocation snapshot preserves every pane ID and
  // fingerprint; a returned pane must be absent from this map.
  const panes = await runTmux([...socket, "list-panes", "-a", "-F", sessionFirst ? "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}" : "#{pane_id}|#{session_id}|#{window_id}|#{pane_pid}"]);
  const topology = panes.code ? null : parseTmuxTopologyFingerprint(panes.stdout, source.sourcePaneId, sessionFirst);
  const fingerprint = topology?.source;
  if (!fingerprint || fingerprint.panePid !== source.sourcePanePid) throw new Error("tmux source pane fingerprint changed before allocation");
  if (layout) {
    request = i.container;
    if (request.socketPath !== source.socketPath || request.serverPid !== source.serverPid) throw new Error("tmux layout container changed before allocation");
    if (i.placement === "tmux-split") {
      if (request.paneId !== source.sourcePaneId || request.panePid !== source.sourcePanePid || fingerprint.sessionId !== request.sessionId || fingerprint.windowId !== request.windowId) throw new Error("tmux source pane fingerprint changed before allocation");
    } else if (fingerprint.sessionId !== request.sessionId || fingerprint.windowId !== request.sourceWindowId) {
      throw new Error("tmux source pane fingerprint changed before allocation");
    }
  }
  // tmux 3.7 directly execs a command supplied as multiple argv values. This
  // bypasses the configured default shell. Native env clears the inherited
  // tmux-server environment before Bun/Node or a script interpreter starts.
  const paneEnvironment = ["NODE_OPTIONS=", "NODE_PATH=", "BUN_OPTIONS=", "LD_PRELOAD=", "LD_LIBRARY_PATH=", "LD_AUDIT=", "DYLD_INSERT_LIBRARIES=", "DYLD_LIBRARY_PATH=", "DYLD_FRAMEWORK_PATH="];
  const stagedArgs = [
    "-i", `HOME=${shellHome}`, `XDG_CONFIG_HOME=${shellHome}`, `PATH=${commandEnv.PATH}`,
    `TMPDIR=${commandEnv.TMPDIR}`, `TERM=${commandEnv.TERM}`, `TMUX_BIN=${backendPath}`,
    brokerRuntime, brokerEntrypoint, "--verify-gate", "--run-dir", runDir,
    "--wrapper", p("cmux-wrapper.sh"), "--nonce", expectedNonce,
    "--runtime", brokerRuntime, "--runtime-interpreter", brokerInterpreter,
    "--backend", backendPath,
  ];
  const launch = ["/usr/bin/env", ...stagedArgs];
  const allocationArgs = layout && i.placement === "tmux-new-window"
    ? [...socket, "new-window", "-d", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}", "-t", `${request.sessionId}:`, "-n", i.windowLabel, "-c", path.dirname(i.childSessionFile), ...paneEnvironment.flatMap((entry) => ["-e", entry]), ...launch]
    : [...socket, "split-window", "-h", "-d", "-P", "-F", layout ? "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}" : "#{pane_id}|#{pane_pid}", "-t", source.sourcePaneId, "-c", path.dirname(i.childSessionFile), ...paneEnvironment.flatMap((entry) => ["-e", entry]), ...launch];
  const result = await runTmux(allocationArgs);
  // A complete response stays rollback authority even on nonzero. Parse it
  // before status handling; malformed nonzero output never authorizes mutation.
  const created = parseTmuxCreatedPane(result.stdout, layout, layout && i.placement === "tmux-new-window" ? request.sessionId : request?.sessionId);
  if (!created) {
    // Once tmux has spawned the allocation command, malformed output cannot
    // prove that no pane/window was created, regardless of exit status.
    if (!result.dispatched) throw new Error(result.stderr || result.stdout || "tmux allocation failed");
    throw new Error("tmux possible-unrecorded-allocation");
  }
  if (layout && i.placement === "tmux-split" && (created.sessionId !== request.sessionId || created.windowId !== request.windowId)) throw new Error("tmux possible-unrecorded-allocation");
  // Pane ID equality is an alias even when the PID changed; all pre-existing
  // IDs are similarly unowned and must never reach rollback.
  if (created.paneId === source.sourcePaneId || topology.panes.has(created.paneId)) throw new Error("tmux possible-unrecorded-allocation");
  return {
    mode: "tmux-pane", socketPath: source.socketPath, serverPid: source.serverPid, paneId: created.paneId, panePid: created.panePid, generation: source.generation,
    ...(layout ? { sessionId: created.sessionId, windowId: created.windowId } : {}),
    ...(result.code ? { allocationFailed: true, allocationError: result.stderr || result.stdout || "tmux allocation failed" } : {}),
  };
}
function shellQuote(value) { return `'${value.replace(/'/g, `'"'"'`)}'`; }
function acceptanceHandoff(value, intentRecord) {
  return value && exact(value, ["version", "runId", "brokerNonce", "broker"])
    && value.version === 1 && value.runId === intentRecord.runId && value.brokerNonce === intentRecord.brokerNonce
    && value.broker && exact(value.broker, ["pid", "startedAt", "expectedCommand", "runId"])
    && value.broker.pid === process.pid && Number.isFinite(value.broker.startedAt) && value.broker.startedAt > 0
    && value.broker.expectedCommand === "pane-launch-broker.mjs" && value.broker.runId === intentRecord.runId;
}
async function awaitAcceptanceHandoff(intentRecord) {
  // The fixture publishes this immutable identity before it permits this
  // broker to stop. If the fixture dies first, fail closed without allocation.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (acceptanceHandoff(await readExact(p("acceptance-handoff.json")), intentRecord)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
function acceptancePostallocationCheckpointEnabled() {
  return process.argv.includes("--acceptance-postallocation-checkpoint") && process.env.PI_SUBAGENT_ACCEPTANCE_HARNESS === "1";
}
function startAcceptanceCheckpointWatchdog(identity) {
  // A stopped test broker cannot run its own timer. A separate, identity-bound
  // watchdog eventually resumes it, so an interrupted acceptance controller
  // retains the normal durable-publication recovery path. It verifies the
  // broker start identity again before SIGCONT, preventing PID-reuse signals.
  const script = `const fs=require("node:fs"),{spawnSync}=require("node:child_process");const [pidText,startedText,file]=process.argv.slice(1);const pid=Number(pidText),started=Number(startedText);const current=()=>{try{if(process.platform==="linux"){const s=fs.readFileSync("/proc/"+pid+"/stat","utf8"),i=s.lastIndexOf(")"),f=s.slice(i+1).trim().split(/\\s+/);return Number(f[19])}const r=spawnSync("/bin/ps",["-o","lstart=","-p",String(pid)],{encoding:"utf8"});return r.status===0?Date.parse(String(r.stdout).trim()+" UTC"):null}catch{return null}};setTimeout(()=>{try{const v=JSON.parse(fs.readFileSync(file,"utf8"));if(v&&v.broker&&v.broker.pid===pid&&v.broker.startedAt===started&&current()===started)process.kill(pid,"SIGCONT")}catch{}},5000);`;
  const watchdog = spawn(process.execPath, ["-e", script, String(identity.pid), String(identity.startedAt), p("acceptance-allocation-checkpoint.json")], { detached: true, stdio: "ignore" });
  watchdog.unref();
}
async function stopAtAcceptancePostallocationCheckpoint(intentRecord, candidate, brokerStartedAt) {
  if (!acceptancePostallocationCheckpointEnabled()) return "disabled";
  const checkpoint = {
    version: 1, runId: intentRecord.runId, brokerNonce: expectedNonce,
    broker: { pid: process.pid, startedAt: brokerStartedAt, expectedCommand: "pane-launch-broker.mjs", runId: intentRecord.runId },
    allocation: candidate,
  };
  const publication = await immutable(p("acceptance-allocation-checkpoint.json"), checkpoint);
  if (publication !== "published") throw new Error("acceptance postallocation checkpoint unavailable");
  startAcceptanceCheckpointWatchdog(checkpoint.broker);
  process.kill(process.pid, "SIGSTOP");
  return "stopped";
}
async function validateTmuxControlGate(intentRecord, allowAdditionalPanes = false) {
  const gateArtifact = await readBoundExact(intentRecord.transportGatePath);
  const gateRecord = gateArtifact?.value;
  const gateKeys = ["version", "runId", "selectedTransport", "fixtureContractId", "pinnedSourceCommit", "executableGeneration", "probeRecipeId", "probeResult", "probeDigestAlgorithm", "probeDigest", "canonicalSocketPath", "socketDev", "socketIno", "serverStartedAt", "createdAt"];
  if (!gateRecord || !exact(gateRecord, gateKeys) || gateRecord.version !== 1 || gateRecord.runId !== intentRecord.runId
    || gateRecord.selectedTransport !== "tmux-control-v1" || gateRecord.fixtureContractId !== "tmux-control-v1"
    || gateRecord.pinnedSourceCommit !== "e802909de06012a4df6209d55e86487c56223163" || gateRecord.probeRecipeId !== "tmux-control-readonly-v1"
    || gateRecord.probeDigestAlgorithm !== "sha256" || typeof gateRecord.probeDigest !== "string" || !/^[a-f0-9]{64}$/.test(gateRecord.probeDigest)
    || gateRecord.canonicalSocketPath !== intentRecord.source.socketPath || gateRecord.serverStartedAt !== intentRecord.source.generation.serverStartedAt) return false;
  const generation = gateRecord.executableGeneration;
  if (!generation || !exact(generation, ["realpath", "dev", "ino", "size", "mtimeNs", "ctimeNs"]) || generation.realpath !== backendPath) return false;
  try {
    const executableStat = fsSync.statSync(backendPath, { bigint: true });
    const canonicalSocketPath = path.join(fsSync.realpathSync.native(path.dirname(gateRecord.canonicalSocketPath)), path.basename(gateRecord.canonicalSocketPath));
    const socketStat = fsSync.lstatSync(canonicalSocketPath, { bigint: true });
    if (!executableStat.isFile() || !socketStat.isSocket() || canonicalSocketPath !== gateRecord.canonicalSocketPath
      || String(executableStat.dev) !== generation.dev || String(executableStat.ino) !== generation.ino || String(executableStat.size) !== generation.size || String(executableStat.mtimeNs) !== generation.mtimeNs || String(executableStat.ctimeNs) !== generation.ctimeNs
      || Number(socketStat.dev) !== gateRecord.socketDev || Number(socketStat.ino) !== gateRecord.socketIno
      || processStartedAt(intentRecord.source.serverPid) !== gateRecord.serverStartedAt) return false;
  } catch { return false; }
  const probe = gateRecord.probeResult;
  if (!probe || !exact(probe, ["detectedTmuxVersion", "serverPid", "attachedSessionId", "sourcePaneId", "sourcePanePid", "paneRows"])
    || typeof probe.detectedTmuxVersion !== "string" || !isStableTmuxVersionAtLeast(probe.detectedTmuxVersion, MINIMUM_TMUX_VERSION)
    || probe.serverPid !== intentRecord.source.serverPid || probe.sourcePaneId !== intentRecord.source.sourcePaneId || probe.sourcePanePid !== intentRecord.source.sourcePanePid
    || probe.attachedSessionId !== intentRecord.container.sessionId || !Array.isArray(probe.paneRows)) return false;
  const canonicalProbe = `${JSON.stringify({ detectedTmuxVersion: probe.detectedTmuxVersion, serverPid: probe.serverPid, attachedSessionId: probe.attachedSessionId, sourcePaneId: probe.sourcePaneId, sourcePanePid: probe.sourcePanePid, paneRows: probe.paneRows })}\n`;
  if (crypto.createHash("sha256").update(canonicalProbe).digest("hex") !== gateRecord.probeDigest) return false;
  const [identity, panes] = await Promise.all([
    command(backendPath, ["-S", gateRecord.canonicalSocketPath, "display-message", "-p", "-t", probe.sourcePaneId, "#{pid}|#{session_id}|#{pane_id}|#{pane_pid}"]),
    command(backendPath, ["-S", gateRecord.canonicalSocketPath, "list-panes", "-a", "-F", "#{session_id}|#{pane_id}|#{pane_pid}"]),
  ]);
  if (identity.code !== 0 || panes.code !== 0 || !identity.stdout.endsWith("\n") || identity.stdout.includes("\r") || identity.stdout.slice(0, -1).includes("\n")
    || !panes.stdout.endsWith("\n") || panes.stdout.includes("\r") || panes.stdout.slice(0, -1).endsWith("\n")) return false;
  const identityFields = identity.stdout.slice(0, -1).split("|");
  if (identityFields.length !== 4 || !/^[1-9][0-9]*$/.test(identityFields[0]) || !/^\$[0-9]+$/.test(identityFields[1]) || !/^%[0-9]+$/.test(identityFields[2]) || !/^[1-9][0-9]*$/.test(identityFields[3])
    || !Number.isSafeInteger(Number(identityFields[0])) || !Number.isSafeInteger(Number(identityFields[3]))) return false;
  const rowFields = panes.stdout.slice(0, -1).split("\n").map((line) => line.split("|"));
  if (rowFields.length === 0 || rowFields.some((fields) => fields.length !== 3 || !/^\$[0-9]+$/.test(fields[0]) || !/^%[0-9]+$/.test(fields[1]) || !/^[1-9][0-9]*$/.test(fields[2]))) return false;
  const currentRows = rowFields.map(([sessionId, paneId, panePid]) => ({ sessionId, paneId, panePid: Number(panePid) }));
  if (currentRows.some((row) => !Number.isSafeInteger(row.panePid)) || new Set(currentRows.map((row) => `${row.sessionId}\0${row.paneId}`)).size !== currentRows.length) return false;
  currentRows.sort((left, right) => Number(left.sessionId.slice(1)) - Number(right.sessionId.slice(1)) || Number(left.paneId.slice(1)) - Number(right.paneId.slice(1)) || left.panePid - right.panePid);
  const rowsMatch = allowAdditionalPanes
    ? probe.paneRows.every((expected) => currentRows.some((current) => current.sessionId === expected.sessionId && current.paneId === expected.paneId && current.panePid === expected.panePid))
    : JSON.stringify(currentRows) === JSON.stringify(probe.paneRows);
  return identityFields.length === 4 && Number(identityFields[0]) === probe.serverPid && identityFields[1] === probe.attachedSessionId && identityFields[2] === probe.sourcePaneId && Number(identityFields[3]) === probe.sourcePanePid
    && rowsMatch && gateArtifact.digest === intentRecord.transportGateDigest;
}

async function main() {
  try { await validateRunAuthority(); } catch { process.exitCode = 2; return; }
  const intentArtifact = await readBoundExact(p("launch-intent.json"));
  const i = intent(intentArtifact?.value);
  if (!i) { await status("unknown", "failed", "intent-invalid"); return; }
  backendMode = i.terminalMode;
  protocolVersion = i.version;
  if (i.version === 3) {
    if (!await validateTmuxControlGate(i)) { await status(i.runId, "failed", "intent-invalid"); return; }
    tmuxManager = new TmuxControlClient({ executable: backendPath, socketPath: i.source.socketPath, sessionId: i.container.sessionId });
    try { await tmuxManager.start(); } catch { await status(i.runId, "failed", "intent-invalid"); return; }
    const controlRun = createTmuxControlCommandRunner(tmuxManager, i.source.socketPath);
    tmuxCommand = async (args, options) => { const result = await controlRun(args, options); return { ...result, code: result.exitCode }; };
  }
  if (i.terminalMode === "cmux-pane") {
    if (legacyCmuxHarness) cmuxCommand = async (args) => await command(backendPath, args);
    else { cmuxManager = getCmuxControlRequestManager({ ...cmuxBrokerOptions, expectedControl: i.control }); cmuxCommand = createCmuxControlCommandRunner({ manager: cmuxManager }); }
  }
  if (regularFile(i.backendPath, true) !== backendPath) { await status(i.runId, "failed", "intent-invalid"); return; }
  // A valid immutable decision is a completed checkpoint. A later broker must
  // not regress status or allocate another target, regardless of its kind.
  if (decision(await readExact(p("decision.json")), i.runId)) return;
  // The first immutable claim fences allocation. A duplicate process exits
  // silently; it must not overwrite the winning broker's status or risk state.
  const brokerStartedAt = processStartedAt(process.pid);
  if (brokerStartedAt === null) { await status(i.runId, "failed", "authority-mismatch"); return; }
  const claim = { version: protocolVersion, runId: i.runId, brokerNonce: expectedNonce, pid: process.pid, brokerStartedAt, claimedAt: now() };
  if (await immutable(p("broker-claim.json"), claim) !== "published") return;
  if (decision(await readExact(p("decision.json")), i.runId)) return;
  await status(i.runId, "ready");
  // Acceptance only: stop at an externally observable pre-allocation point.
  // Both the explicit argv opt-in and harness-only environment marker are
  // required, so production broker launches cannot enter this checkpoint.
  if (process.argv.includes("--acceptance-preallocation-checkpoint") && process.env.PI_SUBAGENT_ACCEPTANCE_HARNESS === "1") {
    if (!await awaitAcceptanceHandoff(i)) { await status(i.runId, "failed", "acceptance-handoff-unresolved"); return; }
    process.kill(process.pid, "SIGSTOP");
  }
  let target;
  try { target = i.terminalMode === "cmux-pane" ? await allocateCmux(i) : i.terminalMode === "herdr-pane" ? await allocateHerdr(i) : await allocateTmux(i); } catch (error) {
    if (process.env.PI_SUBAGENT_ACCEPTANCE_HARNESS === "1") console.error(`[pi-subagent acceptance broker] allocation failed: ${error instanceof Error ? error.message : "unknown"}`);
    // Successful allocation with no canonical identity cannot be safely
    // rediscovered. Keep the intent/status for manual recovery.
    if (isHerdrUnknownOutcome(error)
      || error?.message === "tmux possible-unrecorded-allocation" || error?.message === "tmux allocation reused source pane" || error?.message === "tmux split changed source container" || error?.message === "cmux possible-unrecorded-allocation" || error?.message === "cmux allocation reused source surface") await riskAndFail(i.runId);
    else await status(i.runId, "failed", "allocation-failed");
    return;
  }
  const candidate = i.terminalMode === "cmux-pane"
    ? { version: protocolVersion, runId: i.runId, terminalMode: i.terminalMode,
      ...(Object.hasOwn(i, "layout") ? { layout: i.layout, placement: i.placement, container: { kind: "cmux-pane", workspaceId: target.workspaceId, paneId: target.paneId }, control: i.control } : {}),
      target: { workspaceId: target.workspaceId, surfaceId: target.surfaceId, paneId: target.paneId }, allocatedAt: now() }
    : i.terminalMode === "herdr-pane"
      ? { version: protocolVersion, runId: i.runId, terminalMode: i.terminalMode, target: { socketPath: target.socketPath, workspaceId: target.workspaceId, tabId: target.tabId, paneId: target.paneId, terminalId: target.terminalId, protocol: target.protocol }, allocatedAt: now() }
      : { version: protocolVersion, runId: i.runId, terminalMode: i.terminalMode,
        ...(protocolVersion === 3 ? { transport: "tmux-control-v1", intentDigest: intentArtifact.digest } : {}),
        ...(Object.hasOwn(i, "layout") ? { layout: i.layout, placement: i.placement, container: { kind: "tmux-window", socketPath: target.socketPath, serverPid: target.serverPid, sessionId: target.sessionId, windowId: target.windowId, paneId: target.paneId, panePid: target.panePid, generation: target.generation } } : {}),
        target: { socketPath: target.socketPath, serverPid: target.serverPid, paneId: target.paneId, panePid: target.panePid, generation: target.generation }, allocatedAt: now() };
  if (!allocationMatchesIntentSource(i, candidate)) {
    // A target equal to the source is parent-owned and must never be closed.
    if (!isSourceTarget(i, target)) {
      try { await rollback(target, i); } catch { /* residual risk is authoritative below */ }
    }
    await riskAndFail(i.runId);
    return;
  }
  // Acceptance-only response-to-record kill window. The exact parsed
  // candidate and PID/start/run binding are fsync-published before SIGSTOP;
  // production never enters this branch. A watchdog resumes an abandoned
  // checkpoint so the usual allocation publication/rollback path recovers.
  try {
    await stopAtAcceptancePostallocationCheckpoint(i, candidate, brokerStartedAt);
  } catch {
    let absent = false;
    try { absent = await rollback(target, i); } catch { /* residual risk below */ }
    if (absent) await status(i.runId, "failed", "allocation-failed");
    else await residualRisk(i.runId);
    return;
  }
  if (target.allocationFailed) {
    // A nonzero cmux command can still report the exact target it created.
    // Publish that authority before mutation whenever possible, then roll back
    // only that target. It is terminal failure and can never commit or launch.
    let publication;
    try {
      publication = await immutable(p("allocation.json"), candidate);
    } catch {
      if (await rollback(target, i)) await status(i.runId, "failed", "allocation-failed");
      else await riskAndFail(i.runId);
      return;
    }
    if (publication !== "published") {
      const winner = allocation(await readExact(p("allocation.json")), i.runId);
      // A competing record cannot represent this exact failed allocation.
      // Preserve it for quarantine, but close only the known in-memory target.
      if (!winner || winner.terminalMode !== i.terminalMode || !allocationMatchesIntentSource(i, winner)
        || !sameTarget(target, targetFromAllocation(winner))) {
        try { await rollback(target, i); } catch { /* residual risk below */ }
        await riskAndFail(i.runId);
        return;
      }
    }
    if (await rollback(target, i)) await status(i.runId, "failed", "allocation-failed");
    else await riskAndFail(i.runId);
    return;
  }
  let durable = candidate;
  let allocationPublication;
  try {
    allocationPublication = await immutable(p("allocation.json"), candidate);
  } catch {
    // The target exists but its exact durable authority did not publish. Roll
    // back only this recorded in-memory target and downgrade to residual risk
    // unless a canonical absence probe confirms the rollback.
    let absent = false;
    try { absent = await rollback(target, i); } catch { /* residual risk below */ }
    if (absent) await status(i.runId, "failed", "allocation-failed");
    else await residualRisk(i.runId);
    return;
  }
  if (allocationPublication !== "published") {
    const winner = allocation(await readExact(p("allocation.json")), i.runId);
    // A malformed/opposite-mode immutable winner is preserved for quarantine,
    // but it cannot identify this broker's just-created target. Roll back only
    // the exact in-memory candidate and retain immutable residual risk even if
    // its canonical absence probe succeeds: the competing authority remains
    // malformed and must never be overwritten or deleted here.
    if (!winner || winner.terminalMode !== i.terminalMode || !allocationMatchesIntentSource(i, winner)) {
      try { await rollback(target, i); } catch { /* residual risk is authoritative below */ }
      await riskAndFail(i.runId);
      return;
    }
    const winnerTarget = targetFromAllocation(winner);
    if (!sameTarget(target, winnerTarget) && !await rollback(target, i)) { await riskAndFail(i.runId); return; }
    durable = winner;
    target = winnerTarget;
  }
  const commit = { version: protocolVersion, runId: i.runId, kind: "commit", decidedAt: now(), allocationPath: p("allocation.json"), launchPath: p("launch.json") };
  let decided = decision(await readExact(p("decision.json")), i.runId);
  if (!decided) {
    await immutable(p("decision.json"), commit);
    decided = decision(await readExact(p("decision.json")), i.runId);
  }
  // Allocation is durable before the decision. A cancel winner must therefore
  // clean up the exact durable allocation, not assume pre-allocation safety.
  if (!decided) { await riskAndFail(i.runId); return; }
  if (decided.kind === "cancel") {
    if (!await rollback(target, i)) await riskAndFail(i.runId);
    else await status(i.runId, "failed", "commit-failed");
    return;
  }
  const committed = { version: protocolVersion, runId: i.runId, terminalMode: i.terminalMode,
    ...(protocolVersion === 3 ? { transport: "tmux-control-v1", allocationDigest: await exactDigest(p("allocation.json")) } : {}),
    allocationPath: p("allocation.json"), childSessionFile: i.childSessionFile, committedAt: now(), ownership: "parent-owned" };
  if (await immutable(p("launch.json"), committed) !== "published" && !launch(await readExact(p("launch.json")), i.runId, i.terminalMode)) {
    await riskAndFail(i.runId); return;
  }
  await status(i.runId, "committed");
  if (i.terminalMode === "herdr-pane") {
    const outcome = await launchHerdrAfterGate(i, target);
    // An unknown send_text delivery may already have exec'd the wrapper. Keep
    // its exact durable allocation for reaper/parent reconciliation; never
    // replay the command or close a potentially running child.
    if (outcome === "unknown") await recordLaunchDeliveryUnknown(i.runId);
    else if (outcome !== "launched") {
      if (!await rollback(target, i)) await riskAndFail(i.runId);
      else await status(i.runId, "failed", "commit-failed");
    }
  }
}
async function launchHerdrAfterGate(i, target) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [rawDecision, rawAllocation, rawLaunch, rawGate] = await Promise.all([readExact(p("decision.json")), readExact(p("allocation.json")), readExact(p("launch.json")), readExact(p("launch.gate"))]);
    const d = decision(rawDecision, i.runId), a = allocation(rawAllocation, i.runId), l = launch(rawLaunch, i.runId, i.terminalMode), g = gate(rawGate, i.runId, i.terminalMode);
    if ((rawDecision && !d) || (rawAllocation && !a) || (rawLaunch && !l) || (rawGate && !g) || d?.kind === "cancel") return "not-launched";
    if (d?.kind === "commit" && a && l && g && validStateDependencies(a, d, l, g) && allocationMatchesIntentSource(i, a) && g.protocol === target.protocol && sameTarget(target, targetFromAllocation(a))) {
      // Gate and rebind again at the final mutation boundary. A positive
      // response is still required; unknown delivery is recorded separately.
      let current;
      try { current = await revalidateHerdrTarget(target); } catch { return "not-launched"; }
      if (!current) return "not-launched";
      try { await herdrRequest(current.socketPath, "pane.send_text", { pane_id: current.paneId, text: `exec ${shellQuote(p("cmux-wrapper.sh"))}\n` }, true); return "launched"; }
      catch (error) { return isHerdrUnknownOutcome(error) ? "unknown" : "not-launched"; }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return "not-launched";
}
async function verifyCmuxGateTarget(a) {
  // cmux assigns the new pane's identity. Do not reuse the source pane ids
  // captured by the allocating broker; that would authorize the wrong pane.
  // This is deliberately an environment fingerprint: the private socket
  // authority is not restored until the wrapper starts after this verifier.
  return cmuxIdsEqual(process.env.CMUX_WORKSPACE_ID, a.target.workspaceId) && cmuxIdsEqual(process.env.CMUX_SURFACE_ID, a.target.surfaceId);
}
async function verifyTmuxGateTarget(a, intentRecord) {
  // A direct argv split preserves its initial pane PID across exec. A
  // non-exec shebang wrapper leaves the verifier as its one child instead.
  // Do not permit further ancestry: only the allocated pane process itself
  // or its direct child may claim this immutable target.
  if (process.pid !== a.target.panePid && process.ppid !== a.target.panePid) return false;
  if (!tmuxGeneration(a.target.generation) || !currentTmuxGeneration(a.target.generation, a.target.serverPid)) return false;
  const socket = socketArgs(a.target.socketPath);
  const runTmux = tmuxCommand ?? (async (args) => await command(backendPath, args, 2_000));
  const server = await runTmux([...socket, "display-message", "-p", "#{pid}"]);
  if (server.code || parsePidOutput(server.stdout) !== a.target.serverPid) return false;
  // A locale-free tmux client may sanitize control-character separators such
  // as tab to `_`. Pane IDs and decimal PIDs cannot contain `|`.
  const panes = await runTmux([...socket, "list-panes", "-a", "-F", intentRecord.version === 3 ? "#{session_id}|#{pane_id}|#{pane_pid}" : "#{pane_id}|#{pane_pid}"]);
  if (panes.code !== 0) return false;
  if (intentRecord.version !== 3) return parseTmuxPipePanePidList(panes.stdout, a.target.paneId) === a.target.panePid;
  const rows = stripFinalLineEnding(panes.stdout).split("\n").map((line) => line.split("|"));
  if (rows.some((fields) => fields.length !== 3 || !/^\$[0-9]+$/.test(fields[0]) || !/^%[0-9]+$/.test(fields[1]) || !Number.isSafeInteger(Number(fields[2])) || Number(fields[2]) <= 0)) return false;
  const current = rows.map(([sessionId, paneId, panePid]) => ({ sessionId, paneId, panePid: Number(panePid) }));
  if (new Set(current.map((row) => `${row.sessionId}:${row.paneId}`)).size !== current.length) return false;
  const gateRecord = await readExact(intentRecord.transportGatePath);
  if (!gateRecord?.probeResult?.paneRows || !Array.isArray(gateRecord.probeResult.paneRows)) return false;
  const expected = [...gateRecord.probeResult.paneRows, { sessionId: a.container.sessionId, paneId: a.target.paneId, panePid: a.target.panePid }];
  const order = (left, right) => Number(left.sessionId.slice(1)) - Number(right.sessionId.slice(1)) || Number(left.paneId.slice(1)) - Number(right.paneId.slice(1)) || left.panePid - right.panePid;
  current.sort(order); expected.sort(order);
  return JSON.stringify(current) === JSON.stringify(expected);
}
async function verifyGate() {
  // The staged process is independently invoked by tmux. Re-establish every
  // immutable authority in order before it is allowed to inspect a target.
  try { await validateRunAuthority(); } catch { return; }
  const i = intent(await readExact(p("launch-intent.json")));
  if (!i) return;
  backendMode = i.terminalMode;
  protocolVersion = i.version;
  if (i.version === 3) {
    if (!await validateTmuxControlGate(i, true)) return;
    tmuxManager = new TmuxControlClient({ executable: backendPath, socketPath: i.source.socketPath, sessionId: i.container.sessionId });
    try { await tmuxManager.start(); } catch { return; }
    const controlRun = createTmuxControlCommandRunner(tmuxManager, i.source.socketPath);
    tmuxCommand = async (args, options) => { const result = await controlRun(args, options); return { ...result, code: result.exitCode }; };
  }
  if (i.terminalMode === "cmux-pane") {
    if (legacyCmuxHarness) cmuxCommand = async (args) => await command(backendPath, args);
    else { cmuxManager = getCmuxControlRequestManager({ ...cmuxBrokerOptions, expectedControl: i.control }); cmuxCommand = createCmuxControlCommandRunner({ manager: cmuxManager }); }
  }
  if (regularFile(i.backendPath, true) !== backendPath) return;
  const wrapperAt = process.argv.indexOf("--wrapper"); const wrapper = wrapperAt >= 0 ? process.argv[wrapperAt + 1] : null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const [rawDecision, rawAllocation, rawLaunch, rawGate] = await Promise.all([
      readExact(p("decision.json")), readExact(p("allocation.json")), readExact(p("launch.json")), readExact(p("launch.gate")),
    ]);
    const d = decision(rawDecision, i.runId);
    const a = allocation(rawAllocation, i.runId);
    const l = launch(rawLaunch, i.runId, i.terminalMode);
    const g = gate(rawGate, i.runId, i.terminalMode);
    // A present but mismatched authority is terminally invalid, not a pending
    // publication. Never wait for it to become acceptable.
    if ((rawDecision && !d) || (rawAllocation && !a) || (rawLaunch && !l) || (rawGate && !g)
      || (a && (!allocationMatchesIntentSource(i, a) || a.terminalMode !== i.terminalMode)) || (l && l.terminalMode !== i.terminalMode) || (g && g.terminalMode !== i.terminalMode)) return;
    if (d?.kind === "cancel") return;
    if (d?.kind === "commit" && d.allocationPath === p("allocation.json") && d.launchPath === p("launch.json") && a && allocationMatchesIntentSource(i, a) && a.terminalMode === i.terminalMode && l && l.terminalMode === i.terminalMode && g && g.terminalMode === i.terminalMode && validStateDependencies(a, d, l, g) && await validV3Chain(i, a, l) && wrapper && path.resolve(wrapper) === p("cmux-wrapper.sh")) {
      // Revalidate the selected executable immediately before the winning target
      // is probed; then probe only the strict winning allocation and its mode.
      if (regularFile(i.backendPath, true) !== backendPath) return;
      if (a.terminalMode === "cmux-pane" ? !await verifyCmuxGateTarget(a) : !await verifyTmuxGateTarget(a, i)) return;
      // Preserve a constrained bootstrap environment; the wrapper sources the
      // private explicit environment artifact before execing Pi.
      const { spawn: launch } = await import("node:child_process");
      const launchEnv = a.terminalMode === "tmux-pane"
        ? { ...commandEnv, TMUX: `${a.target.socketPath ?? ""},${a.target.serverPid},0`, TMUX_PANE: a.target.paneId }
        : commandEnv;
      const child = launch(wrapper, [], { cwd: runDir, stdio: "inherit", shell: false, env: launchEnv });
      child.once("exit", (code) => process.exit(code ?? 1)); return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.exitCode = 0;
}
const verifyGateMode = process.argv.includes("--verify-gate");
try {
  if (verifyGateMode) await verifyGate(); else await main();
} finally {
  cmuxManager?.close();
  tmuxManager?.close();
}
// The allocation broker is a one-shot process. Explicit exit prevents a
// transport implementation detail from extending its lifetime; all durable
// publications above are awaited and fsync-complete before this point.
if (!verifyGateMode) process.exit(process.exitCode ?? 0);
