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
import { spawn } from "node:child_process";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// UUID authority is string-only: RegExp.test() coerces arrays, objects, and
// numbers, so it must never inspect an untyped backend or artifact field.
const isUuidString = (value) => typeof value === "string" && UUID.test(value);
// Preserve backend UUID spelling, but never distinguish case aliases in authority checks.
const cmuxIdsEqual = (left, right) => isUuidString(left) && isUuidString(right) && left.toLowerCase() === right.toLowerCase();
const PANE = /^%(?:0|[1-9][0-9]*)$/;
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
function hasConsistentArgv() {
  // --project-root is accepted as an ignored compatibility argument from
  // parent processes loaded before executable path-policy removal.
  const valueFlags = new Set(["--run-dir", "--nonce", "--runtime", "--runtime-interpreter", "--backend", "--wrapper", "--project-root"]);
  let verifyGateCount = 0, acceptanceCheckpointCount = 0;
  for (let index = 2; index < process.argv.length; index += 1) {
    const value = process.argv[index];
    if (value === "--verify-gate") { verifyGateCount += 1; continue; }
    if (value === "--acceptance-preallocation-checkpoint") { acceptanceCheckpointCount += 1; continue; }
    if (!valueFlags.has(value) || index + 1 >= process.argv.length || process.argv[index + 1].startsWith("--")) return false;
    index += 1;
  }
  return verifyGateCount <= 1 && acceptanceCheckpointCount <= 1;
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
  ...["CMUX_SOCKET_PATH", "CMUX_SOCKET_CAPABILITY", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_BUNDLED_CLI_PATH", "TMUX", "TMUX_PANE"].flatMap((key) => typeof process.env[key] === "string" ? [[key, process.env[key]]] : []),
  // The isolated test harness may pass a synthetic pane PID to its backend
  // fixture. It is never available to production verifier processes.
  ...(process.env.PI_SUBAGENT_TEST_HARNESS === "1" && typeof process.env.PI_SUBAGENT_TEST_TMUX_PANE_PID === "string" ? [["PI_SUBAGENT_TEST_TMUX_PANE_PID", process.env.PI_SUBAGENT_TEST_TMUX_PANE_PID]] : []),
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

async function readExact(file) {
  try {
    const text = await fs.readFile(file, "utf8");
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) return null;
    const value = JSON.parse(text.slice(0, -1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
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
    && Object.keys(value).every((key) => ["socketPath", "sourcePaneId", "sourcePanePid", "serverPid"].includes(key))
    && typeof value.sourcePaneId === "string" && PANE.test(value.sourcePaneId)
    && Number.isSafeInteger(value.sourcePanePid) && value.sourcePanePid > 0
    && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && (value.socketPath === undefined || typeof value.socketPath === "string");
}
function tmuxSourceContainer(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["kind", "socketPath", "serverPid", "sessionId", "windowId", "paneId", "panePid"].includes(key))
    && ["kind", "serverPid", "sessionId", "windowId", "paneId", "panePid"].every((key) => Object.hasOwn(value, key))
    && value.kind === "tmux-source-pane" && (value.socketPath === undefined || typeof value.socketPath === "string")
    && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && typeof value.sessionId === "string" && SESSION.test(value.sessionId)
    && typeof value.windowId === "string" && WINDOW.test(value.windowId)
    && typeof value.paneId === "string" && PANE.test(value.paneId)
    && Number.isSafeInteger(value.panePid) && value.panePid > 0;
}
function tmuxSessionContainer(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["kind", "socketPath", "serverPid", "sessionId", "sourceWindowId"].includes(key))
    && ["kind", "serverPid", "sessionId", "sourceWindowId"].every((key) => Object.hasOwn(value, key))
    && value.kind === "tmux-session" && (value.socketPath === undefined || typeof value.socketPath === "string")
    && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && typeof value.sessionId === "string" && SESSION.test(value.sessionId)
    && typeof value.sourceWindowId === "string" && WINDOW.test(value.sourceWindowId);
}
function intent(value) {
  const base = value && value.version === 2 && typeof value.runId === "string" && value.runId === path.basename(runDir) && typeof value.parentSessionId === "string" && value.parentSessionId && Number.isSafeInteger(value.parentPid) && value.parentPid > 0 && Number.isFinite(value.parentStartedAt) && value.parentStartedAt > 0 && Number.isFinite(value.createdAt) && value.createdAt > 0 && artifactPathEquals(value.childSessionFile, "child-session.jsonl") && value.brokerNonce === expectedNonce && value.runtimePath === brokerRuntime && value.runtimeInterpreterPath === brokerInterpreter && value.backendPath === backendPath && value.brokerEntrypoint === brokerEntrypoint;
  if (!base) return null;
  const baseKeys = ["version", "runId", ...(Object.hasOwn(value, "parentRunId") ? ["parentRunId"] : []), "parentSessionId", "parentPid", "parentStartedAt", "terminalMode", "source", "childSessionFile", "createdAt", "brokerNonce", "runtimePath", "runtimeInterpreterPath", "backendPath", "brokerEntrypoint"];
  if (Object.hasOwn(value, "parentRunId") && (typeof value.parentRunId !== "string" || !value.parentRunId)) return null;
  const layoutKeys = ["layout", "placement", "container"];
  const hasLayout = layoutKeys.some((key) => Object.hasOwn(value, key));
  if (!exact(value, hasLayout ? [...baseKeys, ...layoutKeys] : baseKeys) || hasLayout && !layoutKeys.every((key) => Object.hasOwn(value, key))) return null;
  const sourceValid = value.terminalMode === "cmux-pane"
    ? exact(value.source, ["workspaceId", "sourceSurfaceId"]) && isUuidString(value.source.workspaceId) && isUuidString(value.source.sourceSurfaceId)
    : value.terminalMode === "tmux-pane" && tmuxSource(value.source);
  if (!sourceValid) return null;
  if (!hasLayout) return value;
  if (value.terminalMode === "cmux-pane") {
    if (value.placement === "cmux-split" && ["auto", "split"].includes(value.layout) && cmuxSourceContainer(value.container)) return value;
    if (value.placement === "cmux-new-surface" && value.layout === "auto" && (cmuxPaneContainer(value.container) || cmuxSourcePaneContainer(value.container))) return value;
    return null;
  }
  if (value.placement === "tmux-split" && value.layout === "split" && tmuxSourceContainer(value.container)) return value;
  if (value.placement === "tmux-new-window" && value.layout === "auto" && tmuxSessionContainer(value.container)) return value;
  return null;
}
function decision(value, runId) {
  if (!value || value.version !== 2 || value.runId !== runId || !Number.isFinite(value.decidedAt) || value.decidedAt <= 0) return null;
  if (value.kind === "cancel" && exact(value, ["version", "runId", "kind", "decidedAt", "reason"]) && ["parent-abort", "ready-timeout", "commit-timeout"].includes(value.reason)) return value;
  if (value.kind === "commit" && exact(value, ["version", "runId", "kind", "decidedAt", "allocationPath", "launchPath"]) && artifactPathEquals(value.allocationPath, "allocation.json") && artifactPathEquals(value.launchPath, "launch.json")) return value;
  return null;
}
function tmuxTarget(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["socketPath", "serverPid", "paneId", "panePid"].includes(key))
    && typeof value.paneId === "string" && PANE.test(value.paneId)
    && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && Number.isSafeInteger(value.panePid) && value.panePid > 0
    && (value.socketPath === undefined || typeof value.socketPath === "string");
}
function tmuxWindowContainer(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => ["kind", "socketPath", "serverPid", "sessionId", "windowId", "paneId", "panePid"].includes(key))
    && ["kind", "serverPid", "sessionId", "windowId", "paneId", "panePid"].every((key) => Object.hasOwn(value, key))
    && value.kind === "tmux-window" && Number.isSafeInteger(value.serverPid) && value.serverPid > 0
    && typeof value.sessionId === "string" && SESSION.test(value.sessionId)
    && typeof value.windowId === "string" && WINDOW.test(value.windowId)
    && typeof value.paneId === "string" && PANE.test(value.paneId)
    && Number.isSafeInteger(value.panePid) && value.panePid > 0
    && (value.socketPath === undefined || typeof value.socketPath === "string");
}
function allocation(value, runId) {
  if (!value || value.version !== 2 || value.runId !== runId || !Number.isFinite(value.allocatedAt) || value.allocatedAt <= 0 || !value.target || typeof value.target !== "object") return null;
  const hasLayout = ["layout", "placement", "container"].some((key) => Object.hasOwn(value, key));
  const baseKeys = ["version", "runId", "terminalMode", "target", "allocatedAt"];
  if (!exact(value, hasLayout ? [...baseKeys, "layout", "placement", "container"] : baseKeys)) return null;
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
  return value && exact(value, ["version", "runId", "terminalMode", "allocationPath", "childSessionFile", "committedAt", "ownership"]) && value.version === 2 && value.runId === runId && value.terminalMode === terminalMode && artifactPathEquals(value.allocationPath, "allocation.json") && artifactPathEquals(value.childSessionFile, "child-session.jsonl") && value.ownership === "parent-owned" && Number.isFinite(value.committedAt) && value.committedAt > 0 ? value : null;
}
function gate(value, runId, terminalMode) {
  return value && exact(value, ["version", "runId", "terminalMode", "launchPath", "publishedAt"]) && value.version === 2 && value.runId === runId && value.terminalMode === terminalMode && artifactPathEquals(value.launchPath, "launch.json") && Number.isFinite(value.publishedAt) && value.publishedAt > 0 ? value : null;
}
function targetFromAllocation(value) {
  return value.terminalMode === "cmux-pane"
    ? { mode: "cmux-pane", workspaceId: value.target.workspaceId, surfaceId: value.target.surfaceId, paneId: value.target.paneId }
    : { mode: "tmux-pane", socketPath: value.target.socketPath, serverPid: value.target.serverPid, paneId: value.target.paneId, panePid: value.target.panePid };
}
function sameTarget(left, right) {
  return left.mode === right.mode && (left.mode === "cmux-pane"
    ? cmuxIdsEqual(left.workspaceId, right.workspaceId) && cmuxIdsEqual(left.surfaceId, right.surfaceId) && cmuxIdsEqual(left.paneId, right.paneId)
    : left.socketPath === right.socketPath && left.serverPid === right.serverPid && left.paneId === right.paneId && left.panePid === right.panePid);
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
    : isTmuxSourceTarget(intentRecord, target);
}
function allocationMatchesIntentSource(intentRecord, allocationRecord) {
  if (!intentRecord || !allocationRecord || intentRecord.terminalMode !== allocationRecord.terminalMode) return false;
  const layoutIntent = Object.hasOwn(intentRecord, "layout"), layoutAllocation = Object.hasOwn(allocationRecord, "layout");
  if (layoutIntent !== layoutAllocation) return false;
  if (intentRecord.terminalMode === "cmux-pane") {
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
  const sourceMatches = allocationRecord.target.socketPath === intentRecord.source.socketPath
    && allocationRecord.target.serverPid === intentRecord.source.serverPid
    && allocationRecord.target.paneId !== intentRecord.source.sourcePaneId;
  if (!sourceMatches) return false;
  if (!layoutIntent) return true;
  if (intentRecord.layout !== allocationRecord.layout || intentRecord.placement !== allocationRecord.placement
    || allocationRecord.container.socketPath !== allocationRecord.target.socketPath
    || allocationRecord.container.serverPid !== allocationRecord.target.serverPid
    || allocationRecord.container.paneId !== allocationRecord.target.paneId
    || allocationRecord.container.panePid !== allocationRecord.target.panePid) return false;
  if (intentRecord.placement === "tmux-split") {
    const request = intentRecord.container;
    return request.kind === "tmux-source-pane" && request.socketPath === intentRecord.source.socketPath
      && request.serverPid === intentRecord.source.serverPid && request.paneId === intentRecord.source.sourcePaneId
      && request.panePid === intentRecord.source.sourcePanePid
      && allocationRecord.container.sessionId === request.sessionId && allocationRecord.container.windowId === request.windowId;
  }
  const request = intentRecord.container;
  return request.kind === "tmux-session" && request.socketPath === intentRecord.source.socketPath
    && request.serverPid === intentRecord.source.serverPid && allocationRecord.container.sessionId === request.sessionId
    && allocationRecord.container.windowId !== request.sourceWindowId;
}
function validStateDependencies(allocationRecord, decisionRecord, launchRecord, gateRecord) {
  if (decisionRecord?.kind === "commit" && !allocationRecord) return false;
  if (decisionRecord?.kind === "cancel" && (launchRecord || gateRecord)) return false;
  if (launchRecord && (!allocationRecord || decisionRecord?.kind !== "commit" || launchRecord.terminalMode !== allocationRecord.terminalMode)) return false;
  if (gateRecord && (!launchRecord || !allocationRecord || decisionRecord?.kind !== "commit" || gateRecord.terminalMode !== allocationRecord.terminalMode || gateRecord.terminalMode !== launchRecord.terminalMode)) return false;
  return true;
}
async function residualRisk(runId) {
  await immutable(p("residual-risk.json"), { version: 2, runId, reason: "possible-unrecorded-allocation", recordedAt: now() }).catch(() => {});
}
async function status(runId, phase, errorCode) {
  // Residual risk is immutable and authoritative: no later broker status can
  // make an uncertain allocation look committed or safe to delete.
  if (phase !== "failed" && await readExact(p("residual-risk.json"))) return;
  const value = { version: 2, runId, writer: "broker", pid: process.pid, phase, updatedAt: now(), ...(errorCode ? { errorCode } : {}) };
  await replace(p("broker-status.json"), value).catch(() => {});
}
async function riskAndFail(runId) { await residualRisk(runId); await status(runId, "failed", "possible-unrecorded-allocation"); }
async function rollback(target, intentRecord) {
  // A backend response that aliases the immutable source is never rollback
  // authority, even if its other fingerprint fields happen to match.
  if (isSourceTarget(intentRecord, target)) return false;
  if (target.mode === "cmux-pane") {
    // A surface can move workspaces. Establish both presence and its current
    // canonical workspace from one strict global topology before mutating.
    const before = await command(backendPath, ["--json", "--id-format", "both", "tree", "--all"]);
    const current = before.code === 0 ? canonicalCmuxSurface(parseCanonicalCmuxTopology(before.stdout), target.surfaceId) : null;
    if (current === false) return true;
    if (!current) return false;
    await command(backendPath, ["close-surface", "--workspace", current.workspaceId, "--surface", current.surfaceId]);
    const after = await command(backendPath, ["--json", "--id-format", "both", "tree", "--all"]);
    return after.code === 0 && canonicalCmuxSurface(parseCanonicalCmuxTopology(after.stdout), target.surfaceId) === false;
  }
  // A pane id can be recycled after server restart. Prove the complete target
  // fingerprint before issuing even a guarded mutation; malformed or duplicate
  // unrelated rows are ambiguous and therefore suppress the command.
  const socket = target.socketPath ? ["-S", target.socketPath] : [];
  const before = await command(backendPath, [...socket, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]);
  const fingerprint = before.code === 0 ? parseTmuxPanePidList(before.stdout, target.paneId) : null;
  if (fingerprint === false) return true;
  if (fingerprint !== target.panePid) return false;
  const condition = `#{&&:#{==:#{pid},${target.serverPid}},#{==:#{pane_pid},${target.panePid}}}`;
  await command(backendPath, [...socket, "if-shell", "-F", "-t", target.paneId, condition, `kill-pane -t ${target.paneId}`, ""]);
  const after = await command(backendPath, [...socket, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]);
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
  const treeResult = await command(backendPath, ["--json", "--id-format", "both", "tree", "--all"]);
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
  const result = await command(backendPath, args);
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
function parseTmuxPanePidList(stdout, targetPaneId, delimiter = "\t") {
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
  const fields = stripFinalLineEnding(stdout).split(layout ? "|" : "\t");
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
  const shellHome = await safeTmuxShellHome();
  if (!shellHome) throw new Error("tmux private shell home is unsafe");
  const server = await command(backendPath, [...socket, "display-message", "-p", "#{pid}"]);
  if (server.code || parsePidOutput(server.stdout) !== source.serverPid) throw new Error("tmux server identity changed before allocation");
  let request = null;
  const sessionFirst = layout && i.placement === "tmux-new-window";
  // One strict, complete pre-allocation snapshot preserves every pane ID and
  // fingerprint; a returned pane must be absent from this map.
  const panes = await command(backendPath, [...socket, "list-panes", "-a", "-F", sessionFirst ? "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}" : "#{pane_id}|#{session_id}|#{window_id}|#{pane_pid}"]);
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
    `TMPDIR=${commandEnv.TMPDIR}`, `TERM=${commandEnv.TERM}`,
    brokerRuntime, brokerEntrypoint, "--verify-gate", "--run-dir", runDir,
    "--wrapper", p("cmux-wrapper.sh"), "--nonce", expectedNonce,
    "--runtime", brokerRuntime, "--runtime-interpreter", brokerInterpreter,
    "--backend", backendPath,
  ];
  const launch = ["/usr/bin/env", ...stagedArgs];
  const allocationArgs = layout && i.placement === "tmux-new-window"
    ? [...socket, "new-window", "-d", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}", "-t", `${request.sessionId}:`, "-n", "subagent:broker", "-c", path.dirname(i.childSessionFile), ...paneEnvironment.flatMap((entry) => ["-e", entry]), ...launch]
    : [...socket, "split-window", "-h", "-d", "-P", "-F", layout ? "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}" : "#{pane_id}\t#{pane_pid}", "-t", source.sourcePaneId, "-c", path.dirname(i.childSessionFile), ...paneEnvironment.flatMap((entry) => ["-e", entry]), ...launch];
  const result = await command(backendPath, allocationArgs);
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
    mode: "tmux-pane", socketPath: source.socketPath, serverPid: source.serverPid, paneId: created.paneId, panePid: created.panePid,
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
async function main() {
  try { await validateRunAuthority(); } catch { process.exitCode = 2; return; }
  const i = intent(await readExact(p("launch-intent.json")));
  if (!i) { await status("unknown", "failed", "intent-invalid"); return; }
  backendMode = i.terminalMode;
  if (regularFile(i.backendPath, true) !== backendPath) { await status(i.runId, "failed", "intent-invalid"); return; }
  // A valid immutable decision is a completed checkpoint. A later broker must
  // not regress status or allocate another target, regardless of its kind.
  if (decision(await readExact(p("decision.json")), i.runId)) return;
  // The first immutable claim fences allocation. A duplicate process exits
  // silently; it must not overwrite the winning broker's status or risk state.
  const claim = { version: 2, runId: i.runId, brokerNonce: expectedNonce, pid: process.pid, claimedAt: now() };
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
  try { target = i.terminalMode === "cmux-pane" ? await allocateCmux(i) : await allocateTmux(i); } catch (error) {
    // Successful allocation with no canonical identity cannot be safely
    // rediscovered. Keep the intent/status for manual recovery.
    if (error?.message === "tmux possible-unrecorded-allocation" || error?.message === "tmux allocation reused source pane" || error?.message === "tmux split changed source container" || error?.message === "cmux possible-unrecorded-allocation" || error?.message === "cmux allocation reused source surface") await riskAndFail(i.runId);
    else await status(i.runId, "failed", "allocation-failed");
    return;
  }
  const candidate = i.terminalMode === "cmux-pane"
    ? { version: 2, runId: i.runId, terminalMode: i.terminalMode,
      ...(Object.hasOwn(i, "layout") ? { layout: i.layout, placement: i.placement, container: { kind: "cmux-pane", workspaceId: target.workspaceId, paneId: target.paneId } } : {}),
      target: { workspaceId: target.workspaceId, surfaceId: target.surfaceId, paneId: target.paneId }, allocatedAt: now() }
    : { version: 2, runId: i.runId, terminalMode: i.terminalMode,
      ...(Object.hasOwn(i, "layout") ? { layout: i.layout, placement: i.placement, container: { kind: "tmux-window", socketPath: target.socketPath, serverPid: target.serverPid, sessionId: target.sessionId, windowId: target.windowId, paneId: target.paneId, panePid: target.panePid } } : {}),
      target: { socketPath: target.socketPath, serverPid: target.serverPid, paneId: target.paneId, panePid: target.panePid }, allocatedAt: now() };
  if (!allocationMatchesIntentSource(i, candidate)) {
    // A target equal to the source is parent-owned and must never be closed.
    if (!isSourceTarget(i, target)) {
      try { await rollback(target, i); } catch { /* residual risk is authoritative below */ }
    }
    await riskAndFail(i.runId);
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
  const commit = { version: 2, runId: i.runId, kind: "commit", decidedAt: now(), allocationPath: p("allocation.json"), launchPath: p("launch.json") };
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
  const committed = { version: 2, runId: i.runId, terminalMode: i.terminalMode, allocationPath: p("allocation.json"), childSessionFile: i.childSessionFile, committedAt: now(), ownership: "parent-owned" };
  if (await immutable(p("launch.json"), committed) !== "published" && !launch(await readExact(p("launch.json")), i.runId, i.terminalMode)) {
    await riskAndFail(i.runId); return;
  }
  await status(i.runId, "committed");
}
async function verifyCmuxGateTarget(a) {
  // cmux assigns the new pane's identity. Do not reuse the source pane ids
  // captured by the allocating broker; that would authorize the wrong pane.
  // This is deliberately an environment fingerprint: the private socket
  // authority is not restored until the wrapper starts after this verifier.
  return cmuxIdsEqual(process.env.CMUX_WORKSPACE_ID, a.target.workspaceId) && cmuxIdsEqual(process.env.CMUX_SURFACE_ID, a.target.surfaceId);
}
async function verifyTmuxGateTarget(a) {
  // A direct argv split preserves its initial pane PID across exec. A
  // non-exec shebang wrapper leaves the verifier as its one child instead.
  // Do not permit further ancestry: only the allocated pane process itself
  // or its direct child may claim this immutable target.
  if (process.pid !== a.target.panePid && process.ppid !== a.target.panePid) return false;
  const socket = socketArgs(a.target.socketPath);
  const server = await command(backendPath, [...socket, "display-message", "-p", "#{pid}"], 2_000);
  if (server.code || parsePidOutput(server.stdout) !== a.target.serverPid) return false;
  // A locale-free tmux client may sanitize control-character separators such
  // as tab to `_`. Pane IDs and decimal PIDs cannot contain `|`.
  const panes = await command(backendPath, [...socket, "list-panes", "-a", "-F", "#{pane_id}|#{pane_pid}"], 2_000);
  if (panes.code !== 0) return false;
  return parseTmuxPipePanePidList(panes.stdout, a.target.paneId) === a.target.panePid;
}
async function verifyGate() {
  // The staged process is independently invoked by tmux. Re-establish every
  // immutable authority in order before it is allowed to inspect a target.
  try { await validateRunAuthority(); } catch { return; }
  const i = intent(await readExact(p("launch-intent.json")));
  if (!i) return;
  backendMode = i.terminalMode;
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
    if (d?.kind === "commit" && d.allocationPath === p("allocation.json") && d.launchPath === p("launch.json") && a && allocationMatchesIntentSource(i, a) && a.terminalMode === i.terminalMode && l && l.terminalMode === i.terminalMode && g && g.terminalMode === i.terminalMode && validStateDependencies(a, d, l, g) && wrapper && path.resolve(wrapper) === p("cmux-wrapper.sh")) {
      // Revalidate the selected executable immediately before the winning target
      // is probed; then probe only the strict winning allocation and its mode.
      if (regularFile(i.backendPath, true) !== backendPath) return;
      if (a.terminalMode === "cmux-pane" ? !await verifyCmuxGateTarget(a) : !await verifyTmuxGateTarget(a)) return;
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
if (process.argv.includes("--verify-gate")) await verifyGate(); else await main();
