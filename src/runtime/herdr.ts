import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import {
	HERDR_MAX_PUBLIC_ID_BYTES,
	isHerdrPublicId,
	isHerdrSocketPath,
	parseHerdrEnvironment,
} from "../core/herdr-environment.js";

export { HERDR_MAX_PUBLIC_ID_BYTES, isHerdrPublicId, parseHerdrEnvironment } from "../core/herdr-environment.js";

/** v0.8.0 speaks protocol 19; current preview builds speak protocol 20. */
export const HERDR_SUPPORTED_PROTOCOLS = new Set([19, 20] as const);
export type HerdrProtocolVersion = 19 | 20;
export function isSupportedHerdrProtocol(value: unknown): value is HerdrProtocolVersion {
	return typeof value === "number" && HERDR_SUPPORTED_PROTOCOLS.has(value as HerdrProtocolVersion);
}
const HERDR_MAX_LINE_BYTES = 256 * 1024;
const HERDR_DEFAULT_TIMEOUT_MS = 5_000;
const HERDR_SUBSCRIBE_CONNECT_TIMEOUT_MS = 5_000;
const HERDR_SUBSCRIBE_ACK_TIMEOUT_MS = 5_000;
const HERDR_RECONNECT_MIN_MS = 100;
const HERDR_RECONNECT_MAX_MS = 5_000;
const HERDR_AGENT_WAIT_SERVER_TIMEOUT_MS = 1_000;
const HERDR_AGENT_WAIT_CLIENT_TIMEOUT_MS = 1_250;
const HERDR_AGENT_WAIT_MAX_OBSERVERS = 16;
/** A reconciliation list must remain a bounded recovery operation. */
const HERDR_MAX_LISTED_PANES = 128;
/** Every consumed Herdr response has the schema's exact tagged-union arm. */
const HERDR_RESULT_TYPES: Readonly<Record<string, string>> = Object.freeze({
	ping: "pong", "pane.get": "pane_info", "pane.list": "pane_list",
	"pane.split": "pane_info", "pane.focus": "pane_info",
	"pane.send_text": "ok", "pane.send_keys": "ok", "pane.close": "ok",
	"pane.report_metadata": "ok", "layout.apply": "layout_apply",
	"agent.get": "agent_info", "agent.wait": "agent_info", "agent.focus": "agent_info",
});
const HERDR_MAX_TAB_LABEL_BYTES = 128;
function defaultHerdrTabLabel(wrapperPath: string): string {
	const slug = path.basename(wrapperPath).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "agent";
	return `pi-subagent:direct:${slug}`;
}
function safeHerdrTabLabel(value: unknown, fallback: string): string {
	const label = typeof value === "string" ? value : fallback;
	if (Buffer.byteLength(label, "utf8") > HERDR_MAX_TAB_LABEL_BYTES || !/^pi-subagent:[A-Za-z0-9._-]+:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) throw new Error("Herdr tab label is not a bounded structured diagnostic label.");
	return label;
}

export interface HerdrSocketGeneration {
	/** Decimal bigint stat fields; numeric conversion can lose identity bits. */
	socketDev: string;
	socketIno: string;
}

export interface HerdrPaneHandle extends HerdrSocketGeneration {
	workspaceId: string;
	tabId: string;
	paneId: string;
	/** Stable across pane moves; pane_id is deliberately not used as identity. */
	terminalId: string;
	/** Immutable child-tab provenance for auto layout cleanup. */
	allocatedTabId?: string;
	/** Immutable ping result; every mutation rechecks this exact revision. */
	protocol: HerdrProtocolVersion;
	socketPath: string;
}

export interface HerdrPaneSnapshot { exists: boolean; exited?: boolean; title?: string; }

export class HerdrUnknownOutcomeError extends Error {
	readonly unknownOutcome = true;
	constructor(message: string, readonly method: string) { super(message); this.name = "HerdrUnknownOutcomeError"; }
}
export class HerdrRequestError extends Error {
	constructor(readonly code: string, message: string, readonly method: string) { super(message); this.name = "HerdrRequestError"; }
}
export class HerdrProtocolError extends Error {
	constructor(message: string) { super(message); this.name = "HerdrProtocolError"; }
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

/** Check the owner-only local authority socket immediately before connecting. */
export function assertStrictHerdrSocket(socketPath: string): fs.BigIntStats {
	if (!isHerdrSocketPath(socketPath) || (process.platform !== "linux" && process.platform !== "darwin")) throw new Error("Herdr pane mode requires an absolute normalized Unix-domain socket on Linux or macOS.");
	const stat = fs.lstatSync(socketPath, { bigint: true });
	if (!stat.isSocket() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) || (stat.mode & 0o077n) !== 0n) throw new Error("HERDR_SOCKET_PATH is not an owner-only Unix-domain socket.");
	return stat;
}
function sameSocket(left: fs.BigIntStats, right: fs.BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino && right.isSocket() && !right.isSymbolicLink(); }
function socketGeneration(stat: fs.BigIntStats): HerdrSocketGeneration { return { socketDev: stat.dev.toString(), socketIno: stat.ino.toString() }; }
function isSocketGeneration(value: Partial<HerdrSocketGeneration>): value is HerdrSocketGeneration {
	return typeof value.socketDev === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketDev)
		&& typeof value.socketIno === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketIno);
}
/** Capture the owner-only socket identity once; all durable Herdr authority uses it. */
export function captureHerdrSocketGeneration(socketPath: string): HerdrSocketGeneration { return socketGeneration(assertStrictHerdrSocket(socketPath)); }
function assertHerdrSocketGeneration(socketPath: string, expected: Partial<HerdrSocketGeneration>): fs.BigIntStats {
	const stat = assertStrictHerdrSocket(socketPath);
	if (!isSocketGeneration(expected) || socketGeneration(stat).socketDev !== expected.socketDev || socketGeneration(stat).socketIno !== expected.socketIno) throw new Error("HERDR_SOCKET_PATH generation changed or is unbound.");
	return stat;
}
function safeRequestId(): string { return `pi-subagent:${crypto.randomUUID()}`; }
/** Avoid shell parsing while producing the exact POSIX command sent to Herdr. */
export function shellQuoteHerdrWrapper(wrapperPath: string): string {
	if (!path.isAbsolute(wrapperPath) || wrapperPath.includes("\0")) throw new Error("Herdr wrapper path must be an absolute non-NUL path.");
	return `'${wrapperPath.replace(/'/g, `"'"'`)}'`;
}

/** Protocol payloads consistently nest the authoritative pane at one of these locations. */
function parsePane(value: unknown, protocol: HerdrProtocolVersion): Omit<HerdrPaneHandle, keyof HerdrSocketGeneration> | null {
	if (!isRecord(value) || !isHerdrPublicId(value.workspace_id) || !isHerdrPublicId(value.tab_id) || !isHerdrPublicId(value.pane_id) || !isHerdrPublicId(value.terminal_id)) return null;
	return { workspaceId: value.workspace_id, tabId: value.tab_id, paneId: value.pane_id, terminalId: value.terminal_id, protocol, socketPath: "" };
}
function paneFromSnapshot(value: unknown, protocol: HerdrProtocolVersion): Omit<HerdrPaneHandle, keyof HerdrSocketGeneration> | null {
	if (!isRecord(value)) return null;
	return parsePane(value.pane, protocol) ?? parsePane(value, protocol) ?? (isRecord(value.agent) ? parsePane(value.agent.pane, protocol) : null) ?? (isRecord(value.session) ? parsePane(value.session.pane, protocol) : null);
}

export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export interface HerdrAgentInfo {
	workspaceId: string;
	tabId: string;
	paneId: string;
	terminalId: string;
	status: HerdrAgentStatus;
	focused: boolean;
	revision: number;
	stateChangeSeq: number;
}
const HERDR_AGENT_STATUS_VALUES = ["idle", "working", "blocked", "done", "unknown"] as const;
const HERDR_AGENT_STATUSES = new Set<HerdrAgentStatus>(HERDR_AGENT_STATUS_VALUES);
function isNonnegativeSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
/** AgentInfo is a lifecycle hint only after every bounded identity field validates. */
function parseAgentInfo(value: unknown): HerdrAgentInfo | null {
	const agent = isRecord(value) && isRecord(value.agent) ? value.agent : null;
	if (!agent || !isHerdrPublicId(agent.workspace_id) || !isHerdrPublicId(agent.tab_id) || !isHerdrPublicId(agent.pane_id) || !isHerdrPublicId(agent.terminal_id)
		|| typeof agent.agent_status !== "string" || !HERDR_AGENT_STATUSES.has(agent.agent_status as HerdrAgentStatus)
		|| typeof agent.focused !== "boolean" || !isNonnegativeSafeInteger(agent.revision)
		|| Object.hasOwn(agent, "state_change_seq") && !isNonnegativeSafeInteger(agent.state_change_seq)) return null;
	return { workspaceId: agent.workspace_id, tabId: agent.tab_id, paneId: agent.pane_id, terminalId: agent.terminal_id,
		status: agent.agent_status as HerdrAgentStatus, focused: agent.focused, revision: agent.revision, stateChangeSeq: Object.hasOwn(agent, "state_change_seq") ? agent.state_change_seq as number : 0 };
}
function sameAgentBinding(agent: HerdrAgentInfo, handle: HerdrPaneHandle): boolean {
	return agent.terminalId === handle.terminalId && agent.workspaceId === handle.workspaceId && agent.tabId === handle.tabId && agent.paneId === handle.paneId;
}
/** Strict direct-layout acknowledgement. Herdr creates one new tab whose sole
 * root pane is also focused; terminal identity is obtained only from pane.get. */
function layoutAppliedRootPane(value: unknown, workspaceId: string, sourceTabId: string, wrapperPath: string, cwd: string): { tabId: string; paneId: string } | null {
	const layout = isRecord(value) && isRecord(value.layout) ? value.layout : null;
	const root = layout && isRecord(layout.root) ? layout.root : null;
	if (!isRecord(value) || value.type !== "layout_apply" || !layout
		|| layout.workspace_id !== workspaceId || !isHerdrPublicId(layout.tab_id) || layout.tab_id === sourceTabId
		|| !isHerdrPublicId(layout.focused_pane_id) || !root || root.type !== "pane" || !isHerdrPublicId(root.pane_id)
		|| layout.focused_pane_id !== root.pane_id || root.cwd !== cwd
		|| !Array.isArray(root.command) || root.command.length !== 1 || root.command[0] !== wrapperPath) return null;
	return { tabId: layout.tab_id, paneId: root.pane_id };
}

/** Explicitly clear startup/injection hooks before any shell or JS starts. */
export const HERDR_DIRECT_STARTUP_ENV = Object.freeze({
	BASH_ENV: "", ENV: "", NODE_OPTIONS: "", NODE_PATH: "", BUN_OPTIONS: "",
	LD_PRELOAD: "", LD_LIBRARY_PATH: "", LD_AUDIT: "", DYLD_INSERT_LIBRARIES: "",
	DYLD_LIBRARY_PATH: "", DYLD_FRAMEWORK_PATH: "",
});
function bindPane(handle: HerdrPaneHandle, observed: Omit<HerdrPaneHandle, keyof HerdrSocketGeneration> | null): HerdrPaneHandle | null {
	if (!observed || observed.terminalId !== handle.terminalId) return null;
	// This intentionally mutates the live registry handle. A move changes its
	// address, not its lifecycle identity; all later inspect/focus/close calls
	// must use the current workspace/tab/pane binding.
	handle.workspaceId = observed.workspaceId; handle.tabId = observed.tabId; handle.paneId = observed.paneId;
	return handle;
}

/** Strict, one-request-per-connection NDJSON client. It never retries mutations. */
export class HerdrSocketClient {
	constructor(readonly socketPath: string, readonly timeoutMs = HERDR_DEFAULT_TIMEOUT_MS, readonly generation?: HerdrSocketGeneration) {}
	async request(method: string, params: Record<string, unknown>, options: { mutation?: boolean; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
		if (options.signal?.aborted) throw new HerdrProtocolError("Herdr request was aborted before dispatch.");
		const before = this.generation ? assertHerdrSocketGeneration(this.socketPath, this.generation) : assertStrictHerdrSocket(this.socketPath); const id = safeRequestId(); const line = `${JSON.stringify({ id, method, params })}\n`;
		if (Buffer.byteLength(line, "utf8") > HERDR_MAX_LINE_BYTES) throw new Error("Herdr request exceeds the strict wire limit.");
		return await new Promise<Record<string, unknown>>((resolve, reject) => {
			let socket: net.Socket | undefined; let settled = false; let dispatched = false; let received = Buffer.alloc(0);
			const finish = (error?: Error, value?: Record<string, unknown>) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort); socket?.destroy(); error ? reject(error) : resolve(value!); };
			// Once mutation bytes leave this process, only an exact matching success
			// or an exact server error is conclusive. Every other wire defect is
			// intentionally a typed unknown outcome, never a message convention.
			const uncertain = (reason: string) => options.mutation && dispatched
				? new HerdrUnknownOutcomeError(`${reason}; reconcile pane state before any retry.`, method)
				: new HerdrProtocolError(reason);
			const onAbort = () => finish(uncertain("Herdr request was aborted"));
			const timer = setTimeout(() => finish(uncertain("Herdr request timed out")), this.timeoutMs);
			try {
				socket = net.createConnection({ path: this.socketPath });
				socket.once("connect", () => {
					try {
						const after = this.generation ? assertHerdrSocketGeneration(this.socketPath, this.generation) : assertStrictHerdrSocket(this.socketPath);
						if (!sameSocket(before, after)) return finish(new HerdrProtocolError("HERDR_SOCKET_PATH changed while connecting."));
						dispatched = true;
						socket!.write(line, (error) => { if (error) finish(uncertain(`Herdr request write failed: ${error.message}`)); });
					} catch (error) { finish(uncertain(error instanceof Error ? error.message : String(error))); }
				});
				socket.on("data", (chunk: Buffer) => {
					received = Buffer.concat([received, chunk]);
					if (received.length > HERDR_MAX_LINE_BYTES) return finish(uncertain("Herdr response exceeds the strict wire limit."));
					const newline = received.indexOf(0x0a);
					if (newline < 0) return;
					if (newline !== received.length - 1) return finish(uncertain("Herdr response contains more than one line."));
					let response: unknown;
					try { response = JSON.parse(received.subarray(0, newline).toString("utf8")); }
					catch { return finish(uncertain("Herdr returned malformed JSON.")); }
					if (!isRecord(response) || response.id !== id) return finish(uncertain("Herdr response id does not match the request."));
					if (Object.keys(response).length === 2 && Object.hasOwn(response, "error") && isRecord(response.error)
						&& Object.keys(response.error).length === 2 && typeof response.error.code === "string" && typeof response.error.message === "string") {
						return finish(new HerdrRequestError(response.error.code, response.error.message, method));
					}
					const expectedType = HERDR_RESULT_TYPES[method];
					if (Object.keys(response).length !== 2 || !Object.hasOwn(response, "result") || !isRecord(response.result)
						|| expectedType !== undefined && response.result.type !== expectedType) return finish(uncertain("Herdr response envelope or result discriminator is invalid."));
					finish(undefined, response.result);
				});
				socket.once("error", (error) => finish(uncertain(`Herdr socket error: ${error.message}`)));
				socket.once("end", () => { if (!settled) finish(uncertain("Herdr closed the response before completion")); });
				if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
			} catch (error) { finish(uncertain(error instanceof Error ? error.message : String(error))); }
		});
	}
	/** Negotiate only the reviewed common subset and optionally pin its prior result. */
	async assertSupportedProtocol(expected?: HerdrProtocolVersion, signal?: AbortSignal): Promise<HerdrProtocolVersion> {
		const result = await this.request("ping", {}, { signal });
		if (!isSupportedHerdrProtocol(result.protocol)) throw new HerdrProtocolError("Herdr protocol must be one of 19 or 20.");
		if (expected !== undefined && result.protocol !== expected) throw new HerdrProtocolError(`Herdr protocol changed from ${expected} to ${result.protocol}.`);
		return result.protocol;
	}
	/** `undefined` is malformed/unknown; only `null` is an explicit not-found response. */
	async getPane(paneId: string, protocol: HerdrProtocolVersion, signal?: AbortSignal): Promise<HerdrPaneHandle | null | undefined> {
		if (!isHerdrPublicId(paneId) || signal?.aborted) return undefined;
		try {
			const pane = paneFromSnapshot(await this.request("pane.get", { pane_id: paneId }, { signal }), protocol);
			return pane ? { ...pane, socketPath: this.socketPath, ...(this.generation ?? {}) } as HerdrPaneHandle : undefined;
		} catch (error) {
			if (error instanceof HerdrRequestError && error.code === "pane_not_found") return null;
			throw error;
		}
	}
	/** Strict agent reads are observation-only and require the protocol's nested AgentInfo arm. */
	async getAgent(paneId: string, signal?: AbortSignal): Promise<HerdrAgentInfo | undefined> {
		if (!isHerdrPublicId(paneId) || signal?.aborted) return undefined;
		return parseAgentInfo(await this.request("agent.get", { target: paneId }, { signal })) ?? undefined;
	}
	async waitForAgent(paneId: string, until: readonly HerdrAgentStatus[], timeoutMs: number, signal?: AbortSignal): Promise<HerdrAgentInfo | undefined> {
		if (!isHerdrPublicId(paneId) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > HERDR_AGENT_WAIT_SERVER_TIMEOUT_MS
			|| until.length === 0 || !until.every((status) => HERDR_AGENT_STATUSES.has(status))) return undefined;
		return parseAgentInfo(await this.request("agent.wait", { target: paneId, until: [...until], timeout_ms: timeoutMs }, { signal })) ?? undefined;
	}
	async focusAgent(paneId: string): Promise<HerdrAgentInfo | undefined> {
		if (!isHerdrPublicId(paneId)) return undefined;
		return parseAgentInfo(await this.request("agent.focus", { target: paneId }, { mutation: true })) ?? undefined;
	}
	/** The schema's `{}` list view spans workspaces, so a moved terminal can rebind its workspace and tab. */
	async listPanes(protocol: HerdrProtocolVersion, signal?: AbortSignal): Promise<HerdrPaneHandle[] | undefined> {
		if (signal?.aborted) return undefined;
		try {
			const result = await this.request("pane.list", {}, { signal });
			if (!Array.isArray(result.panes) || result.panes.length > HERDR_MAX_LISTED_PANES) return undefined;
			const panes = result.panes.map((value) => parsePane(value, protocol));
			if (!panes.every((pane): pane is HerdrPaneHandle => pane !== null)) return undefined;
			const paneIds = new Set<string>(), terminalIds = new Set<string>();
			for (const pane of panes) {
				if (paneIds.has(pane.paneId) || terminalIds.has(pane.terminalId)) return undefined;
				paneIds.add(pane.paneId); terminalIds.add(pane.terminalId);
			}
			return panes.map((pane) => ({ ...pane, socketPath: this.socketPath, ...(this.generation ?? {}) } as HerdrPaneHandle));
		} catch { return undefined; }
	}
}

export type HerdrTerminalClassification = { state: "present"; handle: HerdrPaneHandle } | { state: "absent" } | { state: "unknown" };
/**
 * Classify an owned terminal without treating a failed lookup as absence.
 * Only a complete bounded global pane.list with zero terminal_id matches is
 * absence proof; all malformed, failed, duplicate, and replacement evidence
 * remains unknown.
 */
export async function classifyHerdrTerminal(handle: HerdrPaneHandle, signal?: AbortSignal): Promise<HerdrTerminalClassification> {
	if (signal?.aborted) return { state: "unknown" };
	try { assertHerdrSocketGeneration(handle.socketPath, handle); } catch { return { state: "unknown" }; }
	const client = new HerdrSocketClient(handle.socketPath, HERDR_DEFAULT_TIMEOUT_MS, { socketDev: handle.socketDev, socketIno: handle.socketIno });
	try {
		const observed = await client.getPane(handle.paneId, handle.protocol, signal);
		if (signal?.aborted) return { state: "unknown" };
		const direct = bindPane(handle, observed ?? null);
		if (direct) return { state: "present", handle: direct };
	} catch {
		if (signal?.aborted) return { state: "unknown" };
		/* list is the only separate absence proof */
	}
	if (signal?.aborted) return { state: "unknown" };
	const listed = await client.listPanes(handle.protocol, signal);
	if (signal?.aborted || !listed) return { state: "unknown" };
	const matches = listed.filter((pane) => pane.terminalId === handle.terminalId);
	if (matches.length === 0) return { state: "absent" };
	if (matches.length !== 1) return { state: "unknown" };
	const rebound = bindPane(handle, matches[0]!);
	return rebound ? { state: "present", handle: rebound } : { state: "unknown" };
}
/** Rebind a present terminal; callers needing absence proof use classifyHerdrTerminal. */
export async function reconcileHerdrPaneBinding(handle: HerdrPaneHandle, signal?: AbortSignal): Promise<HerdrPaneHandle | undefined> {
	const result = await classifyHerdrTerminal(handle, signal);
	return result.state === "present" ? result.handle : undefined;
}

export interface HerdrPaneSubscription { stop(): void; closed: Promise<void>; isHealthy(): boolean; }
export interface HerdrAgentWaitObserver { stop(): void; closed: Promise<void>; isActive(): boolean; }
let activeHerdrAgentWaitObservers = 0;
/**
 * A bounded observation-only wait supplements event wakeups. It has no
 * lifecycle, cleanup, or absence authority: snapshots remain authoritative.
 */
export function observeHerdrAgentWait(options: { handle: HerdrPaneHandle; onWake: () => void; serverTimeoutMs?: number; clientTimeoutMs?: number; retryDelayMs?: number; }): HerdrAgentWaitObserver {
	const serverTimeoutMs = options.serverTimeoutMs ?? HERDR_AGENT_WAIT_SERVER_TIMEOUT_MS;
	const clientTimeoutMs = options.clientTimeoutMs ?? HERDR_AGENT_WAIT_CLIENT_TIMEOUT_MS;
	const retryDelayMs = options.retryDelayMs ?? HERDR_RECONNECT_MIN_MS;
	if (!Number.isSafeInteger(serverTimeoutMs) || serverTimeoutMs <= 0 || serverTimeoutMs > HERDR_AGENT_WAIT_SERVER_TIMEOUT_MS
		|| !Number.isSafeInteger(clientTimeoutMs) || clientTimeoutMs <= serverTimeoutMs || clientTimeoutMs > HERDR_AGENT_WAIT_CLIENT_TIMEOUT_MS
		|| !Number.isSafeInteger(retryDelayMs) || retryDelayMs < HERDR_RECONNECT_MIN_MS || retryDelayMs > HERDR_RECONNECT_MAX_MS) {
		throw new Error("Herdr agent wait observer requires finite ordered timeouts.");
	}
	if (activeHerdrAgentWaitObservers >= HERDR_AGENT_WAIT_MAX_OBSERVERS) return { stop: () => undefined, closed: Promise.resolve(), isActive: () => false };
	activeHerdrAgentWaitObservers += 1;
	let stopped = false;
	let running = true;
	const controller = new AbortController();
	const sleep = async (ms: number) => await new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => { if (timer) clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
		timer = setTimeout(finish, ms);
		if (controller.signal.aborted) finish(); else controller.signal.addEventListener("abort", finish, { once: true });
	});
	const wake = () => { if (!stopped) options.onWake(); };
	const closed = (async () => {
		let delay = retryDelayMs;
		try {
			while (!stopped) {
				const terminal = await classifyHerdrTerminal(options.handle, controller.signal);
				if (stopped) return;
				if (terminal.state === "absent") { wake(); return; }
				if (terminal.state !== "present") { wake(); await sleep(delay); delay = Math.min(HERDR_RECONNECT_MAX_MS, delay * 2); continue; }
				try {
					const client = new HerdrSocketClient(options.handle.socketPath, clientTimeoutMs, { socketDev: options.handle.socketDev, socketIno: options.handle.socketIno });
					const current = await client.getAgent(options.handle.paneId, controller.signal);
					if (stopped) return;
					if (!current || !sameAgentBinding(current, options.handle)) { wake(); await sleep(delay); delay = Math.min(HERDR_RECONNECT_MAX_MS, delay * 2); continue; }
					const until = HERDR_AGENT_STATUS_VALUES.filter((status) => status !== current.status);
					const observed = await client.waitForAgent(options.handle.paneId, until, serverTimeoutMs, controller.signal);
					// A wait result merely schedules authoritative reconciliation; it never
					// publishes terminal state, completion, cleanup, or absence itself.
					wake();
					if (stopped) return;
					// The server must return the requested terminal binding and one of the
					// requested transition states. Even a valid completion is rate-limited
					// before another get/wait cycle to prevent immediate-result hot loops.
					if (!observed || !sameAgentBinding(observed, options.handle) || !until.includes(observed.status)) {
						await sleep(delay); delay = Math.min(HERDR_RECONNECT_MAX_MS, delay * 2);
					} else { delay = retryDelayMs; await sleep(retryDelayMs); }
				} catch (error) {
					if (stopped) return;
					wake();
					if (error instanceof HerdrRequestError && ["timeout", "agent_not_running", "agent_not_found"].includes(error.code)) {
						delay = retryDelayMs; await sleep(retryDelayMs);
					} else { await sleep(delay); delay = Math.min(HERDR_RECONNECT_MAX_MS, delay * 2); }
				}
			}
		} finally { running = false; activeHerdrAgentWaitObservers -= 1; }
	})();
	return { stop: () => { if (!stopped) { stopped = true; running = false; controller.abort(); } }, closed, isActive: () => running };
}
/** Events only wake a single coalesced authoritative reconciliation. Event
 * payloads can establish relevance but never update a live binding or presence. */
export function subscribeHerdrPane(options: { handle: HerdrPaneHandle; onReconcile: (pane: HerdrPaneHandle | undefined) => Promise<void> | void; onWake?: () => void; reconnectDelayMs?: number; }): HerdrPaneSubscription {
	let stopped = false; let healthy = false; let current: net.Socket | null = null; let reconciliation: Promise<void> | null = null; let reconciliationPending = false;
	const controller = new AbortController();
	const wake = () => { if (!stopped) options.onWake?.(); };
	const minDelay = Math.max(HERDR_RECONNECT_MIN_MS, options.reconnectDelayMs ?? HERDR_RECONNECT_MIN_MS);
	const sleep = async (ms: number) => await new Promise<void>((resolve) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => { if (timer) clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
		timer = setTimeout(finish, ms);
		if (controller.signal.aborted) finish(); else controller.signal.addEventListener("abort", finish, { once: true });
	});
	const requestReconcile = () => {
		if (stopped || controller.signal.aborted) return;
		reconciliationPending = true;
		if (reconciliation) return;
		reconciliation = (async () => {
			do {
				reconciliationPending = false;
				if (stopped || controller.signal.aborted) return;
				const pane = await reconcileHerdrPaneBinding(options.handle, controller.signal);
				if (stopped || controller.signal.aborted) return;
				await options.onReconcile(pane);
			} while (reconciliationPending && !stopped && !controller.signal.aborted);
		})().catch(() => undefined).finally(() => { reconciliation = null; });
	};
	const closed = (async () => {
		let delay = minDelay;
		while (!stopped) {
			try {
				assertHerdrSocketGeneration(options.handle.socketPath, options.handle);
				await new Promise<void>((resolve, reject) => {
					const id = safeRequestId(); let buffer = Buffer.alloc(0); let acknowledged = false; let settled = false;
					const socket = current = net.createConnection({ path: options.handle.socketPath });
					const finish = (error?: Error) => { if (settled) return; settled = true; healthy = false; wake(); clearTimeout(connectTimer); clearTimeout(ackTimer); socket.destroy(); current = null; error ? reject(error) : resolve(); };
					const connectTimer = setTimeout(() => finish(new Error("Herdr subscription connect timed out.")), HERDR_SUBSCRIBE_CONNECT_TIMEOUT_MS);
					let ackTimer: ReturnType<typeof setTimeout> | undefined;
					socket.once("connect", () => { clearTimeout(connectTimer); ackTimer = setTimeout(() => finish(new Error("Herdr subscription acknowledgement timed out.")), HERDR_SUBSCRIBE_ACK_TIMEOUT_MS); socket.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: [
						{ type: "pane.closed" }, { type: "pane.exited" }, { type: "pane.updated" }, { type: "pane.moved" },
						{ type: "pane.agent_status_changed", pane_id: options.handle.paneId },
					] } })}\n`, (error) => { if (error) finish(error); }); });
					socket.on("data", (chunk: Buffer) => {
						buffer = Buffer.concat([buffer, chunk]); if (buffer.length > HERDR_MAX_LINE_BYTES) return finish(new Error("Herdr subscription exceeded the strict wire limit."));
						for (;;) { const newline = buffer.indexOf(0x0a); if (newline < 0) return; const line = buffer.subarray(0, newline); buffer = buffer.subarray(newline + 1); let message: unknown; try { message = JSON.parse(line.toString("utf8")); } catch { return finish(new Error("Herdr subscription returned malformed JSON.")); } if (!isRecord(message)) return finish(new Error("Herdr subscription returned a non-object frame.")); if (!acknowledged) { if (message.id !== id || !isRecord(message.result) || message.result.type !== "subscription_started") return finish(new Error("Herdr subscription acknowledgement is invalid.")); acknowledged = true; healthy = true; wake(); clearTimeout(ackTimer); delay = minDelay; requestReconcile(); continue; }
							const data = isRecord(message.data) ? message.data : null;
							// Event payloads only establish relevance. Every binding and presence
							// decision below comes from a fresh pane.get or bounded pane.list.
							const eventPane = data && (data.pane ?? data);
							const moved = message.event === "pane.moved" && data?.previous_pane_id === options.handle.paneId
								&& paneFromSnapshot(data.pane, options.handle.protocol)?.terminalId === options.handle.terminalId;
							const samePane = data?.pane_id === options.handle.paneId
								|| paneFromSnapshot(eventPane, options.handle.protocol)?.terminalId === options.handle.terminalId;
							if (moved || samePane) { wake(); requestReconcile(); } }
					});
					socket.once("error", finish); socket.once("close", () => { if (stopped) finish(); else finish(new Error("Herdr subscription disconnected.")); });
				});
			} catch { /* bounded retry; direct pane queries remain authority */ }
			if (!stopped) { await sleep(delay); delay = Math.min(HERDR_RECONNECT_MAX_MS, delay * 2); }
		}
		await Promise.resolve(reconciliation).catch(() => undefined);
	})();
	return { stop: () => {
		if (stopped) return;
		stopped = true; healthy = false; reconciliationPending = false; controller.abort(); current?.destroy();
	}, closed, isHealthy: () => healthy && !stopped };
}

export async function resolveHerdrCallerPane(env: NodeJS.ProcessEnv = process.env): Promise<HerdrPaneHandle | null> {
	const configured = parseHerdrEnvironment(env); if (!configured) return null;
	const generation = captureHerdrSocketGeneration(configured.socketPath);
	const client = new HerdrSocketClient(configured.socketPath, HERDR_DEFAULT_TIMEOUT_MS, generation); const protocol = await client.assertSupportedProtocol();
	const pane = await client.getPane(configured.paneId, protocol);
	return pane && pane.paneId === configured.paneId && pane.workspaceId === configured.workspaceId && pane.tabId === configured.tabId ? { ...pane, ...generation } : null;
}
/** Allocate, durably publish through the caller callback, then launch by text exactly once. */
async function createHerdrPane(options: { cwd: string; wrapperPath: string; tabLabel?: string; signal?: AbortSignal; onAllocated?: (handle: HerdrPaneHandle) => Promise<void>; env?: NodeJS.ProcessEnv; layout: "split" | "auto"; }): Promise<HerdrPaneHandle> {
	const source = await resolveHerdrCallerPane(options.env); if (!source) throw new Error("Herdr pane mode requires exact HERDR_WORKSPACE_ID, HERDR_TAB_ID, HERDR_PANE_ID, and a matching pane.get response.");
	const client = new HerdrSocketClient(source.socketPath, HERDR_DEFAULT_TIMEOUT_MS, { socketDev: source.socketDev, socketIno: source.socketIno });
	await client.assertSupportedProtocol(source.protocol);
	const current = await client.getPane(source.paneId, source.protocol);
	if (!current || current.terminalId !== source.terminalId || current.workspaceId !== source.workspaceId || current.tabId !== source.tabId) throw new Error("Herdr source binding changed before allocation.");
	const method = options.layout === "auto" ? "layout.apply" : "pane.split";
	// The layout's initial process executes the direct gate's Bun verifier.
	// Never let a configurable run state directory select its Bun project root.
	const bootstrapCwd = path.parse(options.wrapperPath).root;
	if (!path.isAbsolute(path.normalize(options.cwd)) || path.normalize(options.cwd) !== options.cwd
		|| !path.isAbsolute(options.wrapperPath) || !path.isAbsolute(bootstrapCwd) || path.normalize(bootstrapCwd) !== bootstrapCwd) throw new Error("Herdr direct layout requires normalized absolute cwd and wrapper path.");
	let result: Record<string, unknown>;
	try {
		result = await client.request(method, options.layout === "auto"
			// `tab_id` is deliberately absent: layout.apply creates one new tab with
			// one root pane and starts the private wrapper directly, not through a shell.
			? { workspace_id: current.workspaceId, focus: false, tab_label: safeHerdrTabLabel(options.tabLabel, defaultHerdrTabLabel(options.wrapperPath)), root: { type: "pane", cwd: bootstrapCwd, command: [options.wrapperPath], env: HERDR_DIRECT_STARTUP_ENV } }
			: { target_pane_id: current.paneId, direction: "right", cwd: bootstrapCwd, focus: false }, { mutation: true, signal: options.signal });
	} catch (error) {
		if (options.layout === "auto") throw error instanceof HerdrUnknownOutcomeError ? error : new HerdrUnknownOutcomeError(`Herdr ${method} dispatch outcome is unknown; reconcile before any retry.`, method);
		throw error;
	}
	let allocated: Omit<HerdrPaneHandle, keyof HerdrSocketGeneration> | null = null;
	try {
		if (options.layout === "auto") {
			const root = layoutAppliedRootPane(result, current.workspaceId, current.tabId, options.wrapperPath, bootstrapCwd);
			if (root) {
				const observed = await client.getPane(root.paneId, source.protocol);
				allocated = observed && observed.workspaceId === current.workspaceId && observed.tabId === root.tabId && observed.paneId === root.paneId ? observed : null;
			}
		} else allocated = paneFromSnapshot(result, source.protocol);
	} catch (error) {
		throw error instanceof HerdrUnknownOutcomeError ? error : new HerdrUnknownOutcomeError(`Herdr ${method} post-dispatch verification failed; reconcile before any retry.`, method);
	}
	if (!allocated || allocated.workspaceId !== current.workspaceId
		|| options.layout === "auto" && allocated.tabId === current.tabId
		|| options.layout === "split" && allocated.tabId !== current.tabId
		|| allocated.paneId === current.paneId
		|| allocated.terminalId === current.terminalId) {
		throw new HerdrUnknownOutcomeError(`Herdr ${method} did not return an exact new terminal binding; reconcile before any retry.`, method);
	}
	const handle: HerdrPaneHandle = { ...allocated, socketPath: source.socketPath, socketDev: source.socketDev, socketIno: source.socketIno, ...(options.layout === "auto" ? { allocatedTabId: allocated.tabId } : {}) };
	try { await options.onAllocated?.(handle); } catch (error) {
		// The direct auto layout wrapper is already running behind its durable
		// gate. Its allocation is recovery state, never rollback authority.
		if (options.layout !== "auto") await closeHerdrPane(handle).catch(() => undefined);
		throw error;
	}
	if (options.layout === "auto") return handle;
	await client.assertSupportedProtocol(handle.protocol);
	if (!await reconcileHerdrPaneBinding(handle)) throw new Error("Herdr allocated pane changed before launch delivery.");
	await client.request("pane.send_text", { pane_id: handle.paneId, text: `exec ${shellQuoteHerdrWrapper(options.wrapperPath)}\n` }, { mutation: true, signal: options.signal }); return handle;
}
/** Explicit compatibility layout: allocate one right-side pane. */
export async function createHerdrSplit(options: { cwd: string; wrapperPath: string; signal?: AbortSignal; onAllocated?: (handle: HerdrPaneHandle) => Promise<void>; env?: NodeJS.ProcessEnv; }): Promise<HerdrPaneHandle> {
	return await createHerdrPane({ ...options, layout: "split" });
}
/** Default auto layout: one unfocused new tab/root pane directly execs the wrapper. */
export async function createHerdrTab(options: { cwd: string; wrapperPath: string; tabLabel?: string; signal?: AbortSignal; onAllocated?: (handle: HerdrPaneHandle) => Promise<void>; env?: NodeJS.ProcessEnv; }): Promise<HerdrPaneHandle> {
	return await createHerdrPane({ ...options, layout: "auto" });
}
export type ChildHerdrMetadataLifecycle = "ready" | "running" | "waiting" | "returning" | "failed";
export interface ChildHerdrMetadataReporter {
	report(lifecycle: ChildHerdrMetadataLifecycle): void;
	/** Bounded best-effort source-scoped cleanup; it never changes agent authority. */
	close(): Promise<void>;
}
const HERDR_CHILD_METADATA_TTL_MS = 120_000;
const HERDR_CHILD_METADATA_CLOSE_TIMEOUT_MS = 250;
const HERDR_CHILD_METADATA_SOURCE_PREFIX = "pi-subagent:";
const HERDR_CHILD_METADATA_UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
const HERDR_CHILD_METADATA_STATE_LABELS = Object.freeze({ idle: "Ready", working: "Running", blocked: "Waiting", unknown: "Finished" });
function safeChildMetadataText(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 80 && !HERDR_CHILD_METADATA_UNSAFE_TEXT.test(value) ? value : undefined;
}
function childMetadataSource(runId: string): string | undefined {
	const source = `${HERDR_CHILD_METADATA_SOURCE_PREFIX}${runId}`;
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,67}$/.test(runId) && /^[A-Za-z0-9._:-]{1,80}$/.test(source) ? source : undefined;
}
type ChildMetadataPayload = Record<string, unknown>;
/**
 * Child-local diagnostic metadata never establishes or releases Herdr agent
 * authority. It retains just one active request and one latest replacement.
 */
export function createChildHerdrMetadataReporter(options: { handle: HerdrPaneHandle; runId: string; title?: unknown; }): ChildHerdrMetadataReporter | null {
	const source = childMetadataSource(options.runId);
	if (!source || !isSocketGeneration(options.handle)) return null;
	const title = safeChildMetadataText(options.title);
	const runToken = options.runId.slice(0, 16);
	if (!/^[A-Za-z0-9._-]{1,16}$/.test(runToken)) return null;
	let sequence = 0;
	let active: Promise<void> | null = null;
	let pending: ChildMetadataPayload | null = null;
	let closed = false;
	let deadlineExpired = false;
	let closeDeadline: number | null = null;
	let closePromise: Promise<void> | null = null;
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	let resolveClose: (() => void) | null = null;
	const controller = new AbortController();
	const expireCloseDeadline = () => {
		if (deadlineExpired || closeDeadline === null || performance.now() < closeDeadline) return false;
		deadlineExpired = true;
		pending = null;
		controller.abort();
		if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
		resolveClose?.();
		return true;
	};
	const next = () => {
		sequence += 1;
		return sequence;
	};
	const execute = async (payload: ChildMetadataPayload) => {
		try {
			if (expireCloseDeadline() || controller.signal.aborted) return;
			// Keep all identity and protocol observations adjacent to this one
			// mutation; classification can rebind a user-moved terminal by ID.
			assertHerdrSocketGeneration(options.handle.socketPath, options.handle);
			const client = new HerdrSocketClient(options.handle.socketPath, HERDR_DEFAULT_TIMEOUT_MS, { socketDev: options.handle.socketDev, socketIno: options.handle.socketIno });
			await client.assertSupportedProtocol(options.handle.protocol, controller.signal);
			if (expireCloseDeadline() || controller.signal.aborted) return;
			const terminal = await classifyHerdrTerminal(options.handle, controller.signal);
			if (expireCloseDeadline() || controller.signal.aborted || terminal.state !== "present") return;
			await client.request("pane.report_metadata", { pane_id: terminal.handle.paneId, ...payload }, { mutation: true, signal: controller.signal });
		} catch {
			// Metadata is diagnostic-only. An aborted post-dispatch mutation is
			// handled here and never retried; later lifecycle data has a new seq.
		}
	};
	const pump = () => {
		if (expireCloseDeadline() || deadlineExpired || controller.signal.aborted || active || !pending) return;
		const payload = pending;
		pending = null;
		active = execute(payload).finally(() => { active = null; pump(); });
		void active.catch(() => undefined);
	};
	const enqueue = (payload: ChildMetadataPayload) => { pending = payload; pump(); };
	return {
		report(lifecycle) {
			if (closed) return;
			enqueue({ source, applies_to_source: "herdr:pi", agent: "pi", seq: next(), ttl_ms: HERDR_CHILD_METADATA_TTL_MS,
				...(title ? { title } : {}), display_agent: "Pi", state_labels: HERDR_CHILD_METADATA_STATE_LABELS, tokens: { run: runToken, lifecycle } });
		},
		async close() {
			if (closePromise) return await closePromise;
			closed = true;
			// Record the absolute monotonic boundary before enqueuing the clear.
			// `pump` and `execute` enforce it even if the timer callback is delayed.
			closeDeadline = performance.now() + HERDR_CHILD_METADATA_CLOSE_TIMEOUT_MS;
			closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
			const enforceCloseDeadline = () => {
				if (expireCloseDeadline() || closeDeadline === null) return;
				closeTimer = setTimeout(enforceCloseDeadline, Math.max(0, closeDeadline - performance.now()));
				closeTimer.unref?.();
			};
			closeTimer = setTimeout(enforceCloseDeadline, HERDR_CHILD_METADATA_CLOSE_TIMEOUT_MS);
			closeTimer.unref?.();
			enqueue({ source, applies_to_source: "herdr:pi", agent: "pi", seq: next(), ttl_ms: HERDR_CHILD_METADATA_TTL_MS,
				clear_title: true, clear_display_agent: true, clear_state_labels: true, tokens: { run: null, lifecycle: null } });
			const drain = async () => {
				while (active || pending) {
					if (expireCloseDeadline()) return;
					if (active) await active;
					else await Promise.resolve();
				}
				if (!expireCloseDeadline()) {
					if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
					resolveClose?.();
				}
			};
			void drain();
			return await closePromise;
		},
	};
}

export async function inspectHerdrPane(handle: HerdrPaneHandle): Promise<HerdrPaneSnapshot | undefined> {
	const result = await classifyHerdrTerminal(handle);
	return result.state === "present" ? { exists: true } : result.state === "absent" ? { exists: false } : undefined;
}
const HERDR_MAX_DIAGNOSTIC_TITLE_BYTES = 512;
const HERDR_UNSAFE_TITLE_CODE_POINT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u;
function safeDiagnosticTitle(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > HERDR_MAX_DIAGNOSTIC_TITLE_BYTES || HERDR_UNSAFE_TITLE_CODE_POINT.test(value)) return undefined;
	return value;
}
/** Read terminal titles solely for UX after lifecycle identity has been established. */
export async function inspectHerdrPaneForUx(handle: HerdrPaneHandle): Promise<HerdrPaneSnapshot | undefined> {
	const result = await classifyHerdrTerminal(handle);
	if (result.state !== "present") return result.state === "absent" ? { exists: false } : undefined;
	try {
		const client = new HerdrSocketClient(handle.socketPath, HERDR_DEFAULT_TIMEOUT_MS, { socketDev: handle.socketDev, socketIno: handle.socketIno });
		const value = await client.request("pane.get", { pane_id: handle.paneId });
		const pane = paneFromSnapshot(value, handle.protocol);
		if (!pane || pane.terminalId !== handle.terminalId) return { exists: true };
		return { exists: true, title: safeDiagnosticTitle((isRecord(value.pane) ? value.pane : value).terminal_title_stripped)
			?? safeDiagnosticTitle((isRecord(value.pane) ? value.pane : value).terminal_title) };
	} catch { return { exists: true }; }
}
/**
 * Mutation authority is always re-established after the protocol gate. A pane
 * may move between a prior inspection and this boundary, so terminal_id—not a
 * stale pane_id—must select the address used for the mutation.
 */
async function revalidateHerdrMutationTarget(handle: HerdrPaneHandle): Promise<HerdrSocketClient | null> {
	if (!isSocketGeneration(handle)) return null;
	const client = new HerdrSocketClient(handle.socketPath, HERDR_DEFAULT_TIMEOUT_MS, { socketDev: handle.socketDev, socketIno: handle.socketIno });
	await client.assertSupportedProtocol(handle.protocol);
	return (await classifyHerdrTerminal(handle)).state === "present" ? client : null;
}
export async function interruptHerdrPane(handle: HerdrPaneHandle): Promise<boolean> {
	const client = await revalidateHerdrMutationTarget(handle);
	if (!client) return false;
	// Direct new-tab children are cooperative-only lifecycle targets. Their
	// parent never sends terminal keys, whether still placed or user-moved.
	if (handle.allocatedTabId !== undefined) return false;
	await client.request("pane.send_keys", { pane_id: handle.paneId, keys: ["esc"] }, { mutation: true });
	return true;
}
export async function focusHerdrPane(handle: HerdrPaneHandle): Promise<boolean> {
	const client = await revalidateHerdrMutationTarget(handle);
	if (!client) return false;
	// Focus is user initiated, but it is still a one-way mutation: establish the
	// current exact agent binding first, issue exactly one agent.focus, then use
	// read-only terminal classification to confirm the target remains present.
	const before = await client.getAgent(handle.paneId);
	if (!before || !sameAgentBinding(before, handle)) return false;
	const focused = await client.focusAgent(handle.paneId);
	if (!focused || !focused.focused || !sameAgentBinding(focused, handle)) return false;
	const terminal = await classifyHerdrTerminal(handle);
	return terminal.state === "present" && terminal.handle.terminalId === before.terminalId;
}
export async function closeHerdrPane(handle: HerdrPaneHandle): Promise<boolean> {
	const client = await revalidateHerdrMutationTarget(handle);
	if (!client) return (await classifyHerdrTerminal(handle)).state === "absent";
	// Direct new-tab children are never parent close authority. Confirmed
	// absence is handled by read-only recovery, not a Herdr mutation.
	if (handle.allocatedTabId !== undefined) return false;
	await client.request("pane.close", { pane_id: handle.paneId }, { mutation: true });
	return (await classifyHerdrTerminal(handle)).state === "absent";
}
