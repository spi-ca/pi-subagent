import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import net from "node:net";
import { recordPhase0LiveTelemetry } from "./phase0-live-telemetry.mjs";

const DEFAULT_SOCKET = path.join(os.homedir(), ".local/state/cmux/cmux.sock");
const MAX_LINE_BYTES = 64 * 1024;
const MAX_QUEUE = 32;
const DEFAULT_TIMEOUT_MS = 5_000;
const MUTATING_METHODS = new Set(["surface.split", "surface.create", "surface.respawn", "surface.send_key", "surface.close", "surface.focus", "tab.action"]);
export const CMUX_REQUIRED_METHODS = Object.freeze(["system.tree", "surface.split", "surface.create", "surface.respawn", "surface.send_key", "surface.close", "tab.action"]);
export const CMUX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CmuxControlSocketError extends Error {
	constructor(code, message, options = {}) { super(message, options); this.name = "CmuxControlSocketError"; this.code = code; this.state = options.state; this.data = options.data; this.remote = options.remote === true; }
}
export class CmuxUnknownOutcomeError extends CmuxControlSocketError {
	constructor(method, cause) { super("CMUX_UNKNOWN_OUTCOME", `cmux mutation ${method} may have completed; it will not be replayed`, { cause, state: "flushed" }); this.name = "CmuxUnknownOutcomeError"; this.method = method; }
}

function fail(code, message, options) { throw new CmuxControlSocketError(code, message, options); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
function exactKeys(value, keys) { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => own(value, key)); }
function isSafeString(value) { return typeof value === "string" && value.length > 0 && value.trim() === value; }
function isCapabilityToken(value) { return typeof value === "string" && value.length > 0 && !/[\s\0]/.test(value); }
function isUuid(value) { return typeof value === "string" && CMUX_UUID_RE.test(value); }
function validateUuid(value, name) { if (!isUuid(value)) fail("CMUX_RESULT", `cmux ${name} must be a canonical UUID`); return value; }

/** The only accepted authority is the configured path or cmux's stable default. */
export function configuredCmuxSocketPath(env = process.env) {
	const configured = env.CMUX_SOCKET_PATH;
	if (configured !== undefined && (!isSafeString(configured) || configured.includes("\0"))) fail("CMUX_SOCKET_PATH", "CMUX_SOCKET_PATH must be a non-blank path");
	return configured ?? DEFAULT_SOCKET;
}

async function socketIdentity(socketPath) {
	const parent = await fs.realpath(path.dirname(socketPath));
	const parentStat = await fs.lstat(parent, { bigint: true });
	if (!parentStat.isDirectory()) fail("CMUX_SOCKET_PARENT", "cmux socket parent is not a directory");
	if (typeof process.getuid === "function" && parentStat.uid !== BigInt(process.getuid())) fail("CMUX_SOCKET_OWNER", "cmux socket parent is not owned by this uid");
	if ((parentStat.mode & 0o022n) !== 0n) fail("CMUX_SOCKET_MODE", "cmux socket parent must not be group/world writable");
	let resolved;
	try { resolved = await fs.realpath(socketPath); }
	catch (error) { if (error?.code !== "EOPNOTSUPP") throw error; resolved = path.join(parent, path.basename(socketPath)); }
	if (path.dirname(resolved) !== parent) fail("CMUX_SOCKET_PARENT", "cmux socket escaped its resolved parent");
	const stat = await fs.lstat(resolved, { bigint: true });
	if (!stat.isSocket()) fail("CMUX_SOCKET_TYPE", "cmux control path is not a Unix socket");
	if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) fail("CMUX_SOCKET_OWNER", "cmux control socket is not owned by this uid");
	if ((stat.mode & 0o077n) !== 0n) fail("CMUX_SOCKET_MODE", "cmux control socket mode must be owner-only");
	return { parent, resolved, dev: stat.dev, ino: stat.ino };
}
async function assertSameSocket(identity) {
	const after = await socketIdentity(identity.resolved);
	if (after.parent !== identity.parent || after.dev !== identity.dev || after.ino !== identity.ino) fail("CMUX_SOCKET_ROTATED", "cmux control socket changed during connect");
}

/* JSON.parse accepts duplicate keys; scan the complete grammar first and reject them. */
function rejectDuplicateJsonKeys(text) {
	let i = 0;
	const ws = () => { while (/\s/.test(text[i] ?? "")) i += 1; };
	const string = () => { const start = i; if (text[i++] !== '"') throw new Error("string"); while (i < text.length) { const c = text[i++]; if (c === '"') return JSON.parse(text.slice(start, i)); if (c === "\\") { const e = text[i++]; if (!e) throw new Error("escape"); if (e === "u") i += 4; } else if (c < " ") throw new Error("control"); } throw new Error("unterminated string"); };
	const value = () => { ws(); const c = text[i]; if (c === '"') { string(); return; } if (c === "{") { object(); return; } if (c === "[") { array(); return; } const m = text.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/); if (!m) throw new Error("value"); i += m[0].length; };
	const object = () => { i += 1; ws(); const keys = new Set(); if (text[i] === "}") { i += 1; return; } while (true) { ws(); if (text[i] !== '"') throw new Error("key"); const key = string(); if (keys.has(key)) throw new Error("duplicate key"); keys.add(key); ws(); if (text[i++] !== ":") throw new Error("colon"); value(); ws(); if (text[i] === "}") { i += 1; return; } if (text[i++] !== ",") throw new Error("comma"); } };
	const array = () => { i += 1; ws(); if (text[i] === "]") { i += 1; return; } while (true) { value(); ws(); if (text[i] === "]") { i += 1; return; } if (text[i++] !== ",") throw new Error("comma"); } };
	value(); ws(); if (i !== text.length) throw new Error("trailing data");
}
export function parseCmuxNdjsonLine(line) {
	if (!line || line.includes("\r") || Buffer.byteLength(line) > MAX_LINE_BYTES) fail("CMUX_NDJSON", "cmux control line is not bounded bare-LF NDJSON");
	try { rejectDuplicateJsonKeys(line); const parsed = JSON.parse(line); if (!isObject(parsed)) fail("CMUX_ENVELOPE", "cmux control envelope must be an object"); return parsed; }
	catch (error) { if (error instanceof CmuxControlSocketError) throw error; fail("CMUX_JSON", "cmux control line is invalid JSON", { cause: error }); }
}

/** Return only canonical UUID authority fields; unknown and non-UUID fields never become authority. */
export function parseCmuxUuidResult(result, fields, optionalFields = {}) {
	if (!isObject(result) || !Array.isArray(fields) || fields.length === 0 || new Set(fields).size !== fields.length || !isObject(optionalFields)) fail("CMUX_RESULT", "cmux UUID result is invalid");
	const allowed = new Set([...fields, ...Object.keys(optionalFields)]);
	if (Object.keys(result).some((key) => !allowed.has(key)) || fields.some((key) => !own(result, key))) fail("CMUX_RESULT", "cmux UUID result is invalid");
	const parsed = {};
	for (const field of fields) {
		if (!isSafeString(field)) fail("CMUX_RESULT", "cmux UUID result field is invalid");
		parsed[field] = validateUuid(result[field], field);
	}
	for (const [field, validator] of Object.entries(optionalFields)) if (own(result, field) && !validator(result[field])) fail("CMUX_RESULT", `cmux optional result field ${field} is invalid`);
	return parsed;
}
const CMUX_SURFACE_RESULT_FIELDS = Object.freeze({ workspace_id: isUuid, window_id: isUuid, pane_id: isUuid, workspace_ref: isSafeString, window_ref: isSafeString, pane_ref: isSafeString, surface_ref: isSafeString, type: (value) => value === "terminal" });

function validateResponse(response, id) {
	if (!own(response, "id") || response.id !== id || typeof response.ok !== "boolean") fail("CMUX_ENVELOPE", "cmux response has an invalid envelope or id");
	if (response.ok === true) {
		if (!exactKeys(response, ["id", "ok", "result"])) fail("CMUX_ENVELOPE", "cmux success response has invalid keys");
		return response.result;
	}
	if (!exactKeys(response, own(response.error ?? {}, "data") ? ["id", "ok", "error"] : ["id", "ok", "error"]) || !isObject(response.error)) fail("CMUX_ENVELOPE", "cmux failure response has invalid keys");
	const errorKeys = Object.keys(response.error);
	if (!errorKeys.every((key) => key === "code" || key === "message" || key === "data") || !own(response.error, "code") || !own(response.error, "message") || !isSafeString(response.error.code) || !isSafeString(response.error.message)) fail("CMUX_ENVELOPE", "cmux response error is invalid");
	throw new CmuxControlSocketError(response.error.code, response.error.message, { data: response.error.data, remote: true });
}
function validateMethods(methods) { return Array.isArray(methods) && methods.every(isSafeString) && new Set(methods).size === methods.length; }
function strictParams(params, keys, values) {
	if (!isObject(params) || !exactKeys(params, keys)) fail("CMUX_REQUEST", "cmux helper parameters are invalid");
	for (const [key, validator] of Object.entries(values)) if (!validator(params[key])) fail("CMUX_REQUEST", `cmux helper parameter ${key} is invalid`);
	return params;
}
function writeLine(socket, line) { return new Promise((resolve, reject) => socket.write(line, (error) => error ? reject(error) : resolve())); }

export class CmuxControlSocketClient {
	constructor(options = {}) {
		this.options = options; this.socket = undefined; this.buffer = ""; this.queue = []; this.active = undefined; this.nextId = 1; this.closed = false; this.generation = 0; this.streaming = false; this.requestBacklogHighWater = 0; this.lineBacklogHighWater = 0; this.byteBacklogHighWater = 0;
		this.socketPath = configuredCmuxSocketPath(options.env);
		// Capabilities are credentials. Never consume one implicitly from the
		// ambient environment: callers must provide a memory-owned value after
		// choosing a supported authorization path.
		this.capability = options.capability;
		if (this.capability !== undefined && !isCapabilityToken(this.capability)) fail("CMUX_CAPABILITY", "cmux capability must not contain whitespace, newline, or NUL");
	}
	async connect() {
		if (this.socket && !this.socket.destroyed) return this;
		if (this.closed) fail("CMUX_CLOSED", "cmux control client is closed");
		const generation = this.generation;
		this.identity = await socketIdentity(this.socketPath);
		if (!this.#isCurrentGeneration(generation)) fail("CMUX_CLOSED", "cmux control client is closed");
		if (this.socket && !this.socket.destroyed) return this;
		const socket = net.createConnection({ path: this.identity.resolved }); this.socket = socket;
		const current = () => this.#isCurrentGeneration(generation, socket);
		socket.setNoDelay(true); socket.setEncoding("utf8"); socket.on("data", (chunk) => { if (current()) this.#data(chunk); }); socket.on("error", (error) => { if (current()) this.#transportFailure(error); }); socket.on("end", () => { if (current()) this.#transportFailure(new Error("cmux control socket ended")); }); socket.on("close", () => { if (current()) this.#transportFailure(new Error("cmux control socket closed")); });
		await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
		if (!current()) { socket.destroy(); fail("CMUX_CLOSED", "cmux control client is closed"); }
		await new Promise((resolve) => setImmediate(resolve));
		if (!current()) { socket.destroy(); fail("CMUX_CLOSED", "cmux control client is closed"); }
		try { await assertSameSocket(this.identity); } catch (error) { socket.destroy(); throw error; }
		if (!current()) { socket.destroy(); fail("CMUX_CLOSED", "cmux control client is closed"); }
		if (this.options.password !== undefined) await this.request("auth.login", { password: this.options.password }, { mutation: false });
		return this;
	}
	connectionIdentity() {
		if (!this.identity) return undefined;
		return { socketPath: this.identity.resolved, socketDev: this.identity.dev.toString(), socketIno: this.identity.ino.toString() };
	}
	isConnected() { return Boolean(this.socket && !this.socket.destroyed); }
	async assertCurrentIdentity() {
		if (!this.identity) fail("CMUX_SOCKET_ROTATED", "cmux control connection has no socket identity");
		await assertSameSocket(this.identity);
	}
	async handshake(options = {}) {
		const capabilities = await this.request("system.capabilities", {}, { mutation: false });
		const capabilityKeys = isObject(capabilities) ? Object.keys(capabilities) : [];
		if (!isObject(capabilities) || !["version", "access_mode", "methods", "protocol", "socket_path"].every((key) => capabilityKeys.includes(key) || key === "socket_path")
			|| capabilityKeys.some((key) => !["version", "access_mode", "methods", "protocol", "socket_path"].includes(key))
			|| capabilities.version !== 2 || capabilities.protocol !== "cmux-socket" || !isSafeString(capabilities.access_mode) || !validateMethods(capabilities.methods)
			|| (capabilities.socket_path !== undefined && capabilities.socket_path !== this.connectionIdentity()?.socketPath)) fail("CMUX_HANDSHAKE", "cmux capabilities handshake is invalid");
		const required = options.requiredMethods ?? CMUX_REQUIRED_METHODS;
		if (!Array.isArray(required) || !required.every(isSafeString) || !required.every((name) => capabilities.methods.includes(name))) fail("CMUX_HANDSHAKE", "cmux lacks required control methods");
		const identify = await this.request("system.identify", {}, { mutation: false });
		if (!isObject(identify)) fail("CMUX_IDENTIFY", "cmux identify response is invalid");
		if (options.identify && await options.identify(identify, capabilities) !== true) fail("CMUX_IDENTIFY", "cmux identify callback rejected server");
		if (options.appVersionValidator && await options.appVersionValidator(identify, capabilities) !== true) fail("CMUX_VERSION", "cmux app version validator rejected server");
		return { ...capabilities, identify, connection: this.connectionIdentity() };
	}
	request(name, params = {}, options = {}) {
		if (this.closed) return Promise.reject(new CmuxControlSocketError("CMUX_CLOSED", "cmux control client generation is closed"));
		if (this.options.password !== undefined && !this.isConnected()) return Promise.reject(new CmuxControlSocketError("CMUX_AUTH_STATE", "password-authenticated cmux requests require an explicit connected generation"));
		if (this.streaming) return Promise.reject(new CmuxControlSocketError("CMUX_STREAMING", "cmux stream connection accepts no RPC responses"));
		if (!isSafeString(name) || !isObject(params)) return Promise.reject(new CmuxControlSocketError("CMUX_REQUEST", "cmux method and params must be strict"));
		if (this.queue.length >= (this.options.maxQueue ?? MAX_QUEUE)) return Promise.reject(new CmuxControlSocketError("CMUX_QUEUE_FULL", "cmux control queue is full", { state: "queued" }));
		const mutation = options.mutation ?? MUTATING_METHODS.has(name); const id = this.nextId++;
		recordPhase0LiveTelemetry("cmux", "backendRequests");
		return new Promise((resolve, reject) => { this.queue.push({ id, name, params, mutation, resolve, reject, state: "queued", timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS }); const pending = this.queue.length + (this.active ? 1 : 0); if (pending > this.requestBacklogHighWater) { this.requestBacklogHighWater = pending; recordPhase0LiveTelemetry("cmux", "requestBacklogHighWater", pending); } this.#drain(); });
	}
	async startEventStream(params) {
		if (!isObject(params) || this.streaming || this.active || this.queue.length) fail("CMUX_STREAMING", "cmux stream connection is not idle");
		await this.connect();
		const request = { id: this.nextId++, method: "events.stream", params };
		// The server may send its stream ack before the local write callback runs.
		this.streaming = true;
		try { await writeLine(this.socket, this.#physicalLine(request)); } catch (error) { this.streaming = false; throw error; }
	}
	#physicalLine(request) { const json = JSON.stringify(request); return this.capability === undefined ? `${json}\n` : `_cmux_capability_v1 ${this.capability} ${json}\n`; }
	#isCurrentGeneration(generation, socket) { return !this.closed && this.generation === generation && (socket === undefined || (this.socket === socket && !socket.destroyed)); }
	#drain() {
		if (this.active || !this.queue.length) return;
		const item = this.queue.shift(); item.state = "connecting"; this.active = item;
		const generation = this.generation;
		item.timer = setTimeout(() => this.#finishTransport(item, new CmuxControlSocketError("CMUX_TIMEOUT", "cmux control request timed out", { state: item.state })), item.timeoutMs);
		this.connect().then(async () => {
			const socket = this.socket;
			if (this.active !== item || !socket || !this.#isCurrentGeneration(generation, socket)) return;
			const request = { id: item.id, method: item.name, params: item.params }; item.state = "writing";
			try { await writeLine(socket, this.#physicalLine(request)); if (this.active === item && this.#isCurrentGeneration(generation, socket)) item.state = "flushed"; } catch (error) { this.#finishTransport(item, error); }
		}).catch((error) => this.#finishTransport(item, error));
	}
	#data(chunk) {
		this.buffer += chunk;
		const bufferedBytes = Buffer.byteLength(this.buffer), bufferedLines = this.buffer.split("\n").length - 1;
		if (bufferedBytes > this.byteBacklogHighWater) { this.byteBacklogHighWater = bufferedBytes; recordPhase0LiveTelemetry("cmux", "byteBacklogHighWater", bufferedBytes); }
		if (bufferedLines > this.lineBacklogHighWater) { this.lineBacklogHighWater = bufferedLines; recordPhase0LiveTelemetry("cmux", "lineBacklogHighWater", bufferedLines); }
		if (bufferedBytes > MAX_LINE_BYTES + 1) return this.#transportFailure(new CmuxControlSocketError("CMUX_NDJSON", "cmux response exceeds line bound"));
		let end;
		while ((end = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1); let response;
			try { response = parseCmuxNdjsonLine(line); } catch (error) { return this.#transportFailure(error); }
			const item = this.active;
			if (!item) {
				if (this.streaming && typeof this.onNotification === "function") { try { this.onNotification(response); } catch (error) { this.#transportFailure(error); } continue; }
				return this.#transportFailure(new CmuxControlSocketError("CMUX_ENVELOPE", "unsolicited cmux response"));
			}
			if (item.state !== "writing" && item.state !== "flushed") return this.#finishTransport(item, new CmuxControlSocketError("CMUX_ENVELOPE", "cmux response arrived before request dispatch"));
			try { const result = validateResponse(response, item.id); item.state = "response-received"; clearTimeout(item.timer); this.active = undefined; item.resolve(result); this.#drain(); } catch (error) {
				if (error instanceof CmuxControlSocketError && error.remote) { clearTimeout(item.timer); this.active = undefined; item.reject(error); this.#drain(); }
				else this.#finishTransport(item, error);
			}
		}
	}
	#finishTransport(item, error) {
		if (this.active !== item) return;
		clearTimeout(item.timer); this.active = undefined;
		if (item.mutation && (item.state === "writing" || item.state === "flushed" || item.state === "response-received")) { recordPhase0LiveTelemetry("cmux", "unknownOutcomes"); item.reject(new CmuxUnknownOutcomeError(item.name, error)); } else item.reject(error);
		this.#failGeneration(error);
	}
	#failGeneration(error) {
		if (this.closed) return;
		this.closed = true; this.generation += 1; this.socket?.destroy(); this.socket = undefined;
		const failure = error instanceof CmuxControlSocketError ? error : new CmuxControlSocketError("CMUX_TRANSPORT", "cmux control transport generation failed", { cause: error });
		for (const item of this.queue.splice(0)) item.reject(failure);
	}
	#transportFailure(error) { const item = this.active; if (item) this.#finishTransport(item, error); else this.#failGeneration(error); try { this.onTransportError?.(error); } catch { /* observer only */ } }
	close() { if (this.closed) return; this.closed = true; this.generation += 1; const error = new CmuxControlSocketError("CMUX_CLOSED", "cmux control client closed"); const active = this.active; if (active) { clearTimeout(active.timer); this.active = undefined; if (active.mutation && (active.state === "writing" || active.state === "flushed" || active.state === "response-received")) { recordPhase0LiveTelemetry("cmux", "unknownOutcomes"); active.reject(new CmuxUnknownOutcomeError(active.name, error)); } else active.reject(error); } this.socket?.destroy(); this.socket = undefined; for (const item of this.queue.splice(0)) item.reject(error); }
	async tree() { recordPhase0LiveTelemetry("cmux", "exactSnapshots", 1, "tree"); return await this.request("system.tree", { all_windows: true }); }
	async split(params) { strictParams(params, ["workspace_id", "surface_id"], { workspace_id: isUuid, surface_id: isUuid }); const result = await this.request("surface.split", { workspace_id: params.workspace_id, surface_id: params.surface_id, direction: "right", type: "terminal", focus: false }, { mutation: true }); return parseCmuxUuidResult(result, ["workspace_id", "pane_id", "surface_id"], CMUX_SURFACE_RESULT_FIELDS); }
	async create(params) { strictParams(params, ["workspace_id", "pane_id", "working_directory"], { workspace_id: isUuid, pane_id: isUuid, working_directory: isSafeString }); const result = await this.request("surface.create", { workspace_id: params.workspace_id, pane_id: params.pane_id, type: "terminal", working_directory: params.working_directory, focus: false }, { mutation: true }); return parseCmuxUuidResult(result, ["workspace_id", "pane_id", "surface_id"], CMUX_SURFACE_RESULT_FIELDS); }
	async respawn(params) { strictParams(params, ["workspace_id", "surface_id", "command", "tmux_start_command"], { workspace_id: isUuid, surface_id: isUuid, command: isSafeString, tmux_start_command: isSafeString }); const result = await this.request("surface.respawn", { ...params, focus: false }, { mutation: true }); return parseCmuxUuidResult(result, ["workspace_id", "surface_id"], CMUX_SURFACE_RESULT_FIELDS); }
	async sendKey(params) { strictParams(params, ["workspace_id", "surface_id"], { workspace_id: isUuid, surface_id: isUuid }); const result = await this.request("surface.send_key", { ...params, key: "escape" }, { mutation: true }); return parseCmuxUuidResult(result, ["workspace_id", "surface_id"], CMUX_SURFACE_RESULT_FIELDS); }
	async closeSurface(params) { strictParams(params, ["workspace_id", "surface_id"], { workspace_id: isUuid, surface_id: isUuid }); recordPhase0LiveTelemetry("cmux", "exactCleanupMutations", 1, "close"); const result = await this.request("surface.close", params, { mutation: true }); return parseCmuxUuidResult(result, ["workspace_id", "surface_id"], CMUX_SURFACE_RESULT_FIELDS); }
	async focusSurface(params) { strictParams(params, ["surface_id"], { surface_id: isUuid }); const result = await this.request("surface.focus", params, { mutation: true }); return parseCmuxUuidResult(result, ["surface_id"], CMUX_SURFACE_RESULT_FIELDS); }
	async tabAction(params) { strictParams(params, ["action", "title"], { action: (value) => value === "rename", title: isSafeString }); const result = await this.request("tab.action", params, { mutation: true }); if (!isObject(result) || !exactKeys(result, ["action", "title"]) || result.action !== "rename" || !isSafeString(result.title)) fail("CMUX_RESULT", "tab.action rename result is invalid"); return result; }
}
export async function connectCmuxControlSocket(options = {}) { const client = new CmuxControlSocketClient(options); await client.connect(); return client; }
export const cmuxControlMethods = Object.freeze({ tree: "system.tree", split: "surface.split", create: "surface.create", respawn: "surface.respawn", sendKey: "surface.send_key", close: "surface.close", tabAction: "tab.action" });
