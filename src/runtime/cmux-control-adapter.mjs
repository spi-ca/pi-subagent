import * as crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CmuxControlSocketClient, CmuxControlSocketError, CMUX_REQUIRED_METHODS } from "./cmux-control-socket.mjs";
import { MINIMUM_CMUX_VERSION, isStableSemverAtLeast, parseStableSemver } from "./version-policy.mjs";
import { recordPhase0LiveTelemetry } from "./phase0-live-telemetry.mjs";

export const CMUX_MINIMUM_APP_VERSION = MINIMUM_CMUX_VERSION;
const managers = new Map();
// Domain functions use `exitCode`; the detached broker's legacy-shaped
// command boundary uses `code`. Keep both synchronized until that internal
// adapter boundary is removed.
const result = (stdout = "", stderr = "", exitCode = 0) => ({ code: exitCode, exitCode, stdout, stderr, aborted: false });
const CONTROL_CODES = new Set(["CMUX_ABORTED", "CMUX_AUTH_STATE", "CMUX_CAPABILITY", "CMUX_CLOSED", "CMUX_ENVELOPE", "CMUX_HANDSHAKE", "CMUX_IDENTIFY", "CMUX_JSON", "CMUX_NDJSON", "CMUX_QUEUE_FULL", "CMUX_REQUEST", "CMUX_RESULT", "CMUX_SOCKET_MODE", "CMUX_SOCKET_OWNER", "CMUX_SOCKET_PARENT", "CMUX_SOCKET_PATH", "CMUX_SOCKET_ROTATED", "CMUX_SOCKET_TYPE", "CMUX_STREAMING", "CMUX_TIMEOUT", "CMUX_TRANSPORT", "CMUX_UNKNOWN_OUTCOME", "CMUX_VERSION"]);
const CONTROL_STATES = new Set(["queued", "connecting", "writing", "flushed", "response-received"]);
const MAX_MANAGER_CALL_QUEUE = 32;
const CONTROL_METHODS = new Set(["auth.login", "system.capabilities", "system.identify", "system.tree", "surface.split", "surface.create", "surface.respawn", "surface.send_key", "surface.close", "surface.focus", "tab.action"]);
export const diagnoseCmuxControlError = (error) => {
  const remote = error?.remote === true;
  const code = !remote && typeof error?.code === "string" && CONTROL_CODES.has(error.code) ? error.code : remote ? "CMUX_REMOTE_ERROR" : "CMUX_CONTROL_FAILURE";
  return { kind: "control", code, ...(typeof error?.state === "string" && CONTROL_STATES.has(error.state) ? { state: error.state } : {}), ...(typeof error?.method === "string" && CONTROL_METHODS.has(error.method) ? { method: error.method } : {}), ...(remote ? { remote: true } : {}) };
};
const controlExitCode = (code) => code === "CMUX_ABORTED" ? 130 : code === "CMUX_TIMEOUT" ? 124 : code === "CMUX_UNKNOWN_OUTCOME" ? 70 : 1;
const bad = (message, diagnostic = { kind: "adapter", code: "CMUX_ADAPTER_FAILURE" }, dispatched = false) => ({ ...result("", message, controlExitCode(diagnostic.code)), diagnostic, ...(diagnostic.code === "CMUX_ABORTED" ? { aborted: true } : {}), ...(dispatched ? { dispatched: true } : {}) });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const text = (value) => typeof value === "string" && value.length > 0 && value.trim() === value;
const shellQuote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
const shellInvokedStartCommand = (value) => `/bin/sh -c ${shellQuote(value)}`;

export function matchingSupportedCmuxVersions(reportedVersion, bundleVersion, minimum = CMUX_MINIMUM_APP_VERSION) {
  if (!parseStableSemver(bundleVersion) || !isStableSemverAtLeast(bundleVersion, minimum)) return null;
  if (reportedVersion === undefined) return bundleVersion;
  return parseStableSemver(reportedVersion) && reportedVersion === bundleVersion ? bundleVersion : null;
}

/** Read one canonical, non-writable macOS app-bundle stable version. */
export async function readCmuxAppBundleVersion(identify, minimum = CMUX_MINIMUM_APP_VERSION) {
  if (process.platform !== "darwin" || !identify || typeof identify !== "object" || !text(identify.app_bundle_path) || !path.isAbsolute(identify.app_bundle_path)
    || (identify.app_version !== undefined && !text(identify.app_version))) return null;
  try {
    const bundle = path.resolve(identify.app_bundle_path);
    const canonicalBundle = await fs.realpath(bundle);
    if (canonicalBundle !== bundle) return false;
    const bundleStat = await fs.lstat(canonicalBundle, { bigint: true });
    const uid = typeof process.getuid === "function" ? BigInt(process.getuid()) : bundleStat.uid;
    if (!bundleStat.isDirectory() || (bundleStat.mode & 0o022n) !== 0n || (bundleStat.uid !== 0n && bundleStat.uid !== uid)) return false;
    const info = path.join(canonicalBundle, "Contents", "Info.plist");
    const handle = await fs.open(info, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size <= 0n || stat.size > 1024n * 1024n || (stat.mode & 0o022n) !== 0n || (stat.uid !== 0n && stat.uid !== uid)) return false;
      const raw = await handle.readFile("utf8");
      // cmux's shipped plist is XML. Binary/unparseable plists fail closed rather
      // than invoking a system parser with an attacker-controlled path.
      const match = raw.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      const detected = match?.[1];
      return matchingSupportedCmuxVersions(identify.app_version, detected, minimum);
    } finally { await handle.close(); }
  } catch { return null; }
}

export async function validateCmuxAppBundleVersion(identify, minimum = CMUX_MINIMUM_APP_VERSION) {
  return typeof await readCmuxAppBundleVersion(identify, minimum) === "string";
}

function exact(args, expected) { return args.length === expected.length && args.every((value, index) => value === expected[index]); }
function option(args, name) { const index = args.indexOf(name); return index >= 0 && index + 1 < args.length ? args[index + 1] : null; }
function onlyOptionCommand(args, fixed, values) {
  if (args.length !== fixed.length + values.length * 2 || !fixed.every((value, index) => args[index] === value)) return null;
  const rest = args.slice(fixed.length); const parsed = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!values.includes(rest[index]) || own(parsed, rest[index]) || !text(rest[index + 1])) return null;
    parsed[rest[index]] = rest[index + 1];
  }
  return Object.keys(parsed).length === values.length ? parsed : null;
}

export class CmuxControlRequestManager {
  constructor(options = {}) {
    this.options = options; this.client = undefined; this.ready = undefined; this.handshake = undefined; this.generations = 0; this.generation = 0;
    this.callQueue = []; this.callActive = false;
    this.maxCallQueue = Number.isSafeInteger(options.maxCallQueue) && options.maxCallQueue > 0 ? Math.min(options.maxCallQueue, MAX_MANAGER_CALL_QUEUE) : MAX_MANAGER_CALL_QUEUE;
  }
  #aborted() { return new CmuxControlSocketError("CMUX_ABORTED", "cmux control call aborted", { state: "queued" }); }
  #queueFull() { return new CmuxControlSocketError("CMUX_QUEUE_FULL", "cmux control call queue is full", { state: "queued" }); }
  #closeGeneration(generation, client = this.client) {
    if (this.generation !== generation || (client && this.client !== client)) return false;
    this.generation += 1; client?.close(); this.client = undefined; this.ready = undefined; this.handshake = undefined;
    return true;
  }
  #drainCalls() {
    if (this.callActive) return;
    while (this.callQueue.length) {
      const entry = this.callQueue.shift(); entry.signal?.removeEventListener("abort", entry.onAbort);
      if (entry.signal?.aborted) { entry.reject(this.#aborted()); continue; }
      this.callActive = true;
      void this.#runCall(entry).then(entry.resolve, entry.reject).finally(() => { this.callActive = false; this.#drainCalls(); });
      return;
    }
  }
  async #runCall(entry) {
    if (entry.signal?.aborted) throw this.#aborted();
    let handshake = await this.ensureReady(); let client = this.client; let generation = this.generation;
    if (!client?.isConnected()) {
      this.#closeGeneration(generation, client); handshake = await this.ensureReady(); client = this.client; generation = this.generation;
    }
    try {
      if (!client?.isConnected() || this.generation !== generation || this.client !== client) throw new CmuxControlSocketError("CMUX_CLOSED", "cmux control connection is unavailable");
      await client.assertCurrentIdentity();
      const detectedAppVersion = await this.detectAppVersion(handshake.identify, handshake);
      if (detectedAppVersion !== handshake.detectedAppVersion) throw new Error("cmux control-v2 app generation changed after handshake");
      // An accepted operation is never cancelled or replayed. Abort is honored
      // only while the call is still queued, immediately before dispatch.
      if (entry.signal?.aborted) throw this.#aborted();
      return await entry.method(client, handshake);
    } catch (error) {
      if (error?.code !== "CMUX_ABORTED") this.#closeGeneration(generation, client);
      throw error;
    } finally {
      if (this.generation === generation && this.client === client && !client?.isConnected()) this.#closeGeneration(generation, client);
    }
  }
  async detectAppVersion(identify, capabilities) {
    if (this.options.appVersionValidator) {
      if (await this.options.appVersionValidator(identify, capabilities) !== true) return null;
      const candidate = typeof identify?.app_version === "string" ? identify.app_version : this.options.expectedControl?.appVersion;
      return candidate && parseStableSemver(candidate) && isStableSemverAtLeast(candidate, CMUX_MINIMUM_APP_VERSION) ? candidate : null;
    }
    return await readCmuxAppBundleVersion(identify);
  }
  async ensureReady() {
    if (this.ready) return await this.ready;
    const generation = ++this.generation; let client;
    const ready = (async () => {
      // There is no secure inherited FD/pipe password protocol for a detached
      // broker. Reject before opening a socket or allocating an artifact.
      if (this.options.broker && this.options.password !== undefined) throw new Error("cmux password authentication is unsupported for detached broker control-v2");
      this.generations += 1;
      recordPhase0LiveTelemetry("cmux", this.generations === 1 ? "persistentClientCreates" : "persistentClientRestarts");
      if (this.generations > 1) recordPhase0LiveTelemetry("cmux", "reconnects");
      client = new CmuxControlSocketClient({ env: this.options.env, capability: this.options.capability, password: this.options.password });
      this.client = client;
      await client.connect();
      let detectedAppVersion;
      const validator = async (identify, capabilities) => {
        detectedAppVersion = await this.detectAppVersion(identify, capabilities);
        return detectedAppVersion !== null;
      };
      const baseHandshake = await client.handshake({ requiredMethods: CMUX_REQUIRED_METHODS, appVersionValidator: validator });
      if (!detectedAppVersion) throw new Error("cmux control-v2 detected app version is unavailable");
      const handshake = { ...baseHandshake, detectedAppVersion };
      const supportedAccess = handshake.access_mode === "automation" || handshake.access_mode === "cmuxOnly"
        || (handshake.access_mode === "password" && this.options.password !== undefined);
      if (!supportedAccess) throw new Error(`unsupported cmux control-v2 access mode: ${handshake.access_mode}`);
      if (this.options.expectedControl) {
        const expected = this.options.expectedControl;
        const identity = client.connectionIdentity();
        const digest = crypto.createHash("sha256").update(JSON.stringify(handshake.identify, Object.keys(handshake.identify).sort())).digest("hex");
        if (!identity || expected.transport !== "cmux-control-v2" || expected.socketPath !== identity.socketPath || expected.socketDev !== identity.socketDev || expected.socketIno !== identity.socketIno || expected.accessMode !== handshake.access_mode || expected.apiVersion !== handshake.version || expected.appVersion !== detectedAppVersion || expected.identifyDigest !== digest || (expected.bootIdentity !== undefined && handshake.identify.boot_id !== expected.bootIdentity)) throw new Error("cmux control-v2 generation changed after preflight");
      }
      if (this.generation !== generation || this.client !== client) throw new CmuxControlSocketError("CMUX_CLOSED", "cmux control generation was closed during handshake");
      this.handshake = handshake;
      return handshake;
    })();
    this.ready = ready;
    try { return await ready; } catch (error) { this.#closeGeneration(generation, client); throw error; }
  }
  call(method, options = {}) {
    if (options.signal?.aborted) return Promise.reject(this.#aborted());
    if (this.callQueue.length >= this.maxCallQueue) return Promise.reject(this.#queueFull());
    return new Promise((resolve, reject) => {
      const entry = { method, signal: options.signal, resolve, reject, onAbort: undefined };
      entry.onAbort = () => {
        const index = this.callQueue.indexOf(entry);
        if (index < 0) return;
        this.callQueue.splice(index, 1); entry.signal?.removeEventListener("abort", entry.onAbort); reject(this.#aborted());
      };
      entry.signal?.addEventListener("abort", entry.onAbort, { once: true }); this.callQueue.push(entry); this.#drainCalls();
    });
  }
  identity() { return this.handshake?.connection; }
  appVersion() { return this.handshake?.detectedAppVersion; }
  async assertCurrentIdentity() { return await this.call(async (client) => client.connectionIdentity()); }
  close() {
    const client = this.client;
    this.generation += 1; this.client = undefined; this.ready = undefined; this.handshake = undefined; client?.close();
  }
}

/** Process-owned persistent parent client. Broker callers pass broker:true and get an independent manager. */
export function getCmuxControlRequestManager(options = {}) {
  // Credential-bearing managers are explicitly owned by their caller and are
  // never placed in a process-global cache keyed by secret material.
  if (options.broker || options.capability !== undefined || options.password !== undefined) return new CmuxControlRequestManager(options);
  const env = options.env ?? process.env;
  const expected = options.expectedControl;
  const maxCallQueue = Number.isSafeInteger(options.maxCallQueue) && options.maxCallQueue > 0 ? Math.min(options.maxCallQueue, MAX_MANAGER_CALL_QUEUE) : MAX_MANAGER_CALL_QUEUE;
  // A validated manager is authority-bound. Use the canonical socket identity
  // recorded by preflight when present, rather than the caller's potentially
  // non-canonical environment spelling, and include every expected field that
  // ensureReady validates before reuse.
  const key = JSON.stringify(expected
    ? ["expected-control-v1", expected.transport, expected.socketPath, expected.socketDev, expected.socketIno, expected.accessMode, expected.apiVersion, expected.appVersion, expected.identifyDigest, expected.bootIdentity ?? null, maxCallQueue]
    : ["unvalidated-control-v1", env.CMUX_SOCKET_PATH ?? "", maxCallQueue]);
  let manager = managers.get(key);
  if (!manager) { manager = new CmuxControlRequestManager(options); managers.set(key, manager); }
  return manager;
}
export function resetCmuxControlRequestManagersForTest() { for (const manager of managers.values()) manager.close(); managers.clear(); }

/**
 * Compatibility seam for existing domain functions. Only the legacy argv
 * vocabulary emitted by this package is accepted; unknown argv never reaches
 * cmux and cannot silently fall back to the CLI.
 */
export function createCmuxControlCommandRunner(options = {}) {
  const manager = options.manager ?? getCmuxControlRequestManager(options);
  return async (args, runOptions = {}) => {
    try {
      if (runOptions.signal?.aborted) return bad("aborted", { kind: "control", code: "CMUX_ABORTED", state: "queued" });
      const call = (method) => manager.call(method, { signal: runOptions.signal });
      if (exact(args, ["--version"])) {
        const handshake = await call(async (_client, current) => current); return result(`cmux ${handshake.detectedAppVersion}\n`);
      }
      if (exact(args, ["--json", "capabilities"])) {
        const handshake = await call(async (_client, current) => current); return result(`${JSON.stringify({ methods: handshake.methods })}\n`);
      }
      if (exact(args, ["--json", "--id-format", "both", "tree", "--all"])) {
        const tree = await call((client) => client.tree());
        return result(`${JSON.stringify(tree)}\n`);
      }
      const split = onlyOptionCommand(args, ["--json", "--id-format", "both", "new-split", "right"], ["--workspace", "--surface", "--focus"]);
      if (split && split["--focus"] === "false") {
        const value = await call((client) => client.split({ workspace_id: split["--workspace"], surface_id: split["--surface"] }));
        return result(`${JSON.stringify(value)}\n`);
      }
      const create = onlyOptionCommand(args, ["--json", "--id-format", "both", "new-surface", "--type", "terminal"], ["--workspace", "--pane", "--working-directory", "--focus"]);
      if (create && create["--focus"] === "false") {
        const value = await call((client) => client.create({ workspace_id: create["--workspace"], pane_id: create["--pane"], working_directory: create["--working-directory"] }));
        return result(`${JSON.stringify(value)}\n`);
      }
      const respawn = onlyOptionCommand(args, ["respawn-pane"], ["--workspace", "--surface", "--command"]);
      if (respawn) {
        const rawCommand = respawn["--command"];
        const value = await call((client) => client.respawn({
          workspace_id: respawn["--workspace"], surface_id: respawn["--surface"],
          // Match cmux 0.64.20's public CLI contract: Ghostty execs one
          // executable, so arbitrary pane commands must be wrapped by /bin/sh.
          command: shellInvokedStartCommand(rawCommand), tmux_start_command: rawCommand,
        }));
        return result(`${JSON.stringify(value)}\n`);
      }
      if (args.length === 6 && args[0] === "send-key" && args[1] === "--workspace" && args[3] === "--surface" && args[5] === "escape" && text(args[2]) && text(args[4])) {
        const value = await call((client) => client.sendKey({ workspace_id: args[2], surface_id: args[4] }));
        return result(`${JSON.stringify(value)}\n`);
      }
      const focus = onlyOptionCommand(args, ["focus-panel"], ["--workspace", "--panel"]);
      if (focus) {
        const value = await call(async (client, handshake) => handshake.methods.includes("surface.focus")
          ? await client.focusSurface({ surface_id: focus["--panel"] }) : null);
        if (value === null) return bad("cmux control-v2 lacks surface.focus", { kind: "adapter", code: "CMUX_HANDSHAKE" });
        return result(`${JSON.stringify(value)}\n`);
      }
      const close = onlyOptionCommand(args, ["close-surface"], ["--workspace", "--surface"]);
      if (close) {
        const value = await call((client) => client.closeSurface({ workspace_id: close["--workspace"], surface_id: close["--surface"] }));
        return result(`${JSON.stringify(value)}\n`);
      }
      return bad("Unsupported cmux CLI compatibility argv for control-v2.", { kind: "adapter", code: "CMUX_ADAPTER_ARGV" });
    } catch (error) {
      const diagnostic = diagnoseCmuxControlError(error);
      const state = diagnostic.state ? ` state=${diagnostic.state}` : "";
      const method = diagnostic.method ? ` method=${diagnostic.method}` : "";
      return bad(`cmux control-v2 failure: code=${diagnostic.code}${state}${method}`, diagnostic, diagnostic.code === "CMUX_UNKNOWN_OUTCOME");
    }
  };
}
