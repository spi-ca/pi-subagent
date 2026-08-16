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
/** A reconciliation list must remain a bounded recovery operation. */
const HERDR_MAX_LISTED_PANES = 128;

export interface HerdrPaneHandle {
	workspaceId: string;
	tabId: string;
	paneId: string;
	/** Stable across pane moves; pane_id is deliberately not used as identity. */
	terminalId: string;
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
export function assertStrictHerdrSocket(socketPath: string): fs.Stats {
	if (!isHerdrSocketPath(socketPath) || (process.platform !== "linux" && process.platform !== "darwin")) throw new Error("Herdr pane mode requires an absolute normalized Unix-domain socket on Linux or macOS.");
	const stat = fs.lstatSync(socketPath);
	if (!stat.isSocket() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new Error("HERDR_SOCKET_PATH is not an owner-only Unix-domain socket.");
	return stat;
}
function sameSocket(left: fs.Stats, right: fs.Stats): boolean { return left.dev === right.dev && left.ino === right.ino && right.isSocket() && !right.isSymbolicLink(); }
function safeRequestId(): string { return `pi-subagent:${crypto.randomUUID()}`; }
/** Avoid shell parsing while producing the exact POSIX command sent to Herdr. */
export function shellQuoteHerdrWrapper(wrapperPath: string): string {
	if (!path.isAbsolute(wrapperPath) || wrapperPath.includes("\0")) throw new Error("Herdr wrapper path must be an absolute non-NUL path.");
	return `'${wrapperPath.replace(/'/g, `"'"'`)}'`;
}

/** Protocol payloads consistently nest the authoritative pane at one of these locations. */
function parsePane(value: unknown, protocol: HerdrProtocolVersion): HerdrPaneHandle | null {
	if (!isRecord(value) || !isHerdrPublicId(value.workspace_id) || !isHerdrPublicId(value.tab_id) || !isHerdrPublicId(value.pane_id) || !isHerdrPublicId(value.terminal_id)) return null;
	return { workspaceId: value.workspace_id, tabId: value.tab_id, paneId: value.pane_id, terminalId: value.terminal_id, protocol, socketPath: "" };
}
function paneFromSnapshot(value: unknown, protocol: HerdrProtocolVersion): HerdrPaneHandle | null {
	if (!isRecord(value)) return null;
	return parsePane(value.pane, protocol) ?? parsePane(value, protocol) ?? (isRecord(value.agent) ? parsePane(value.agent.pane, protocol) : null) ?? (isRecord(value.session) ? parsePane(value.session.pane, protocol) : null);
}
function bindPane(handle: HerdrPaneHandle, observed: HerdrPaneHandle | null): HerdrPaneHandle | null {
	if (!observed || observed.terminalId !== handle.terminalId) return null;
	// This intentionally mutates the live registry handle. A move changes its
	// address, not its lifecycle identity; all later inspect/focus/close calls
	// must use the current workspace/tab/pane binding.
	handle.workspaceId = observed.workspaceId; handle.tabId = observed.tabId; handle.paneId = observed.paneId;
	return handle;
}

/** Strict, one-request-per-connection NDJSON client. It never retries mutations. */
export class HerdrSocketClient {
	constructor(readonly socketPath: string, readonly timeoutMs = HERDR_DEFAULT_TIMEOUT_MS) {}
	async request(method: string, params: Record<string, unknown>, options: { mutation?: boolean; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
		const before = assertStrictHerdrSocket(this.socketPath); const id = safeRequestId(); const line = `${JSON.stringify({ id, method, params })}\n`;
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
						const after = assertStrictHerdrSocket(this.socketPath);
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
					if (Object.keys(response).length !== 2 || !Object.hasOwn(response, "result") || !isRecord(response.result)
						|| options.mutation && typeof response.result.type !== "string") return finish(uncertain("Herdr response envelope or result is invalid."));
					finish(undefined, response.result);
				});
				socket.once("error", (error) => finish(uncertain(`Herdr socket error: ${error.message}`)));
				socket.once("end", () => { if (!settled) finish(uncertain("Herdr closed the response before completion")); });
				if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener("abort", onAbort, { once: true });
			} catch (error) { finish(uncertain(error instanceof Error ? error.message : String(error))); }
		});
	}
	/** Negotiate only the reviewed common subset and optionally pin its prior result. */
	async assertSupportedProtocol(expected?: HerdrProtocolVersion): Promise<HerdrProtocolVersion> {
		const result = await this.request("ping", {});
		if (!isSupportedHerdrProtocol(result.protocol)) throw new HerdrProtocolError("Herdr protocol must be one of 19 or 20.");
		if (expected !== undefined && result.protocol !== expected) throw new HerdrProtocolError(`Herdr protocol changed from ${expected} to ${result.protocol}.`);
		return result.protocol;
	}
	/** `undefined` is malformed/unknown; only `null` is an explicit not-found response. */
	async getPane(paneId: string, protocol: HerdrProtocolVersion): Promise<HerdrPaneHandle | null | undefined> {
		if (!isHerdrPublicId(paneId)) return undefined;
		try {
			const pane = paneFromSnapshot(await this.request("pane.get", { pane_id: paneId }), protocol);
			return pane ? { ...pane, socketPath: this.socketPath } : undefined;
		} catch (error) {
			if (error instanceof HerdrRequestError && error.code === "pane_not_found") return null;
			throw error;
		}
	}
	/** The schema's `{}` list view spans workspaces, so a moved terminal can rebind its workspace and tab. */
	async listPanes(protocol: HerdrProtocolVersion): Promise<HerdrPaneHandle[] | undefined> {
		try {
			const result = await this.request("pane.list", {});
			if (!Array.isArray(result.panes) || result.panes.length > HERDR_MAX_LISTED_PANES) return undefined;
			const panes = result.panes.map((value) => parsePane(value, protocol));
			return panes.every((pane): pane is HerdrPaneHandle => pane !== null)
				? panes.map((pane) => ({ ...pane, socketPath: this.socketPath })) : undefined;
		} catch { return undefined; }
	}
}

/**
 * Reconcile by stable terminal_id and update a moved pane's current address.
 * A missing/reused public pane ID never proves absence: a bounded global list
 * must identify exactly one terminal, otherwise state is unknown.
 */
export async function reconcileHerdrPaneBinding(handle: HerdrPaneHandle, hintedPane?: unknown): Promise<HerdrPaneHandle | undefined> {
	const hinted = bindPane(handle, paneFromSnapshot(hintedPane, handle.protocol));
	if (hinted) return hinted;
	const client = new HerdrSocketClient(handle.socketPath);
	try {
		const observed = await client.getPane(handle.paneId, handle.protocol);
		const direct = bindPane(handle, observed ?? null);
		if (direct) return direct;
	} catch { /* use the separate bounded all-workspaces recovery query */ }
	const listed = await client.listPanes(handle.protocol);
	if (!listed) return undefined;
	const matches = listed.filter((pane) => pane.terminalId === handle.terminalId);
	return matches.length === 1 ? bindPane(handle, matches[0]!) ?? undefined : undefined;
}

export interface HerdrPaneSubscription { stop(): void; closed: Promise<void>; isHealthy(): boolean; }
/**
 * Events only wake a single coalesced authoritative reconciliation. A move
 * carries previous_pane_id plus the new pane object; matching terminal_id
 * updates the live binding before any "missing" result can be published.
 */
export function subscribeHerdrPane(options: { handle: HerdrPaneHandle; onReconcile: (pane: HerdrPaneHandle | undefined) => Promise<void> | void; onWake?: () => void; reconnectDelayMs?: number; }): HerdrPaneSubscription {
	let stopped = false; let healthy = false; let current: net.Socket | null = null; let reconciliation: Promise<void> | null = null; let reconciliationPending = false;
	const wake = () => options.onWake?.();
	const minDelay = Math.max(HERDR_RECONNECT_MIN_MS, options.reconnectDelayMs ?? HERDR_RECONNECT_MIN_MS);
	const sleep = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));
	const requestReconcile = (hint?: unknown) => {
		reconciliationPending = true;
		if (reconciliation) return;
		reconciliation = (async () => {
			let nextHint = hint;
			do { reconciliationPending = false; const pane = await reconcileHerdrPaneBinding(options.handle, nextHint); nextHint = undefined; await options.onReconcile(pane); } while (reconciliationPending && !stopped);
		})().catch(() => undefined).finally(() => { reconciliation = null; });
	};
	const closed = (async () => {
		let delay = minDelay;
		while (!stopped) {
			try {
				assertStrictHerdrSocket(options.handle.socketPath);
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
							// Herdr's pane.moved event carries the old public ID plus the
							// complete new PaneInfo under data.pane. The latter is the
							// authority that lets terminal_id survive a public-ID change.
							const eventPane = data && (data.pane ?? data);
							const moved = message.event === "pane.moved" && data?.previous_pane_id === options.handle.paneId
								&& paneFromSnapshot(data.pane, options.handle.protocol)?.terminalId === options.handle.terminalId;
							const samePane = data?.pane_id === options.handle.paneId
								|| paneFromSnapshot(eventPane, options.handle.protocol)?.terminalId === options.handle.terminalId;
							if (moved || samePane) { wake(); requestReconcile(eventPane); } }
					});
					socket.once("error", finish); socket.once("close", () => { if (stopped) finish(); else finish(new Error("Herdr subscription disconnected.")); });
				});
			} catch { /* bounded retry; direct pane queries remain authority */ }
			if (!stopped) { await sleep(delay); delay = Math.min(HERDR_RECONNECT_MAX_MS, delay * 2); }
		}
	})();
	return { stop: () => { stopped = true; healthy = false; wake(); current?.destroy(); }, closed, isHealthy: () => healthy && !stopped };
}

export async function resolveHerdrCallerPane(env: NodeJS.ProcessEnv = process.env): Promise<HerdrPaneHandle | null> {
	const configured = parseHerdrEnvironment(env); if (!configured) return null;
	const client = new HerdrSocketClient(configured.socketPath); const protocol = await client.assertSupportedProtocol();
	const pane = await client.getPane(configured.paneId, protocol);
	return pane && pane.workspaceId === configured.workspaceId && pane.tabId === configured.tabId ? pane : null;
}
/** Allocate, durably publish through the caller callback, then launch by text exactly once. */
export async function createHerdrSplit(options: { cwd: string; wrapperPath: string; signal?: AbortSignal; onAllocated?: (handle: HerdrPaneHandle) => Promise<void>; env?: NodeJS.ProcessEnv; }): Promise<HerdrPaneHandle> {
	const source = await resolveHerdrCallerPane(options.env); if (!source) throw new Error("Herdr pane mode requires exact HERDR_WORKSPACE_ID, HERDR_TAB_ID, HERDR_PANE_ID, and a matching pane.get response.");
	const client = new HerdrSocketClient(source.socketPath);
	// Never carry a preflight result across the mutation boundary.
	await client.assertSupportedProtocol(source.protocol);
	const current = await client.getPane(source.paneId, source.protocol);
	if (!current || current.terminalId !== source.terminalId || current.workspaceId !== source.workspaceId || current.tabId !== source.tabId) throw new Error("Herdr source binding changed before allocation.");
	const result = await client.request("pane.split", { target_pane_id: current.paneId, direction: "right", cwd: options.cwd, focus: false }, { mutation: true, signal: options.signal });
	const allocated = paneFromSnapshot(result, source.protocol);
	if (!allocated || allocated.workspaceId !== current.workspaceId || allocated.tabId !== current.tabId
		|| allocated.terminalId === current.terminalId) {
		throw new HerdrUnknownOutcomeError("Herdr pane.split did not return an exact new terminal binding; reconcile before any retry.", "pane.split");
	}
	const handle = { ...allocated, socketPath: source.socketPath };
	try { await options.onAllocated?.(handle); } catch (error) { await closeHerdrPane(handle).catch(() => undefined); throw error; }
	// send_text is a mutation too. Re-gate and rebind after durable allocation;
	// a moved pane keeps terminal_id but must receive text at its new pane_id.
	await client.assertSupportedProtocol(handle.protocol);
	// The allocation callback is a durable handoff boundary. Recover a move
	// missed during it by terminal_id before sending the one launch mutation.
	if (!await reconcileHerdrPaneBinding(handle)) throw new Error("Herdr allocated pane changed before launch delivery.");
	await client.request("pane.send_text", { pane_id: handle.paneId, text: `exec ${shellQuoteHerdrWrapper(options.wrapperPath)}\n` }, { mutation: true, signal: options.signal }); return handle;
}
export async function inspectHerdrPane(handle: HerdrPaneHandle): Promise<HerdrPaneSnapshot | undefined> {
	// Reconciliation deliberately has no negative result: a stale public pane
	// address can be moved, while malformed/ambiguous recovery evidence is
	// unknown rather than proof that our terminal disappeared.
	const pane = await reconcileHerdrPaneBinding(handle);
	return pane ? { exists: true } : undefined;
}
/**
 * Mutation authority is always re-established after the protocol gate. A pane
 * may move between a prior inspection and this boundary, so terminal_id—not a
 * stale pane_id—must select the address used for the mutation.
 */
async function revalidateHerdrMutationTarget(handle: HerdrPaneHandle): Promise<HerdrSocketClient | null> {
	const client = new HerdrSocketClient(handle.socketPath);
	await client.assertSupportedProtocol(handle.protocol);
	return await reconcileHerdrPaneBinding(handle) ? client : null;
}
export async function interruptHerdrPane(handle: HerdrPaneHandle): Promise<boolean> {
	const client = await revalidateHerdrMutationTarget(handle);
	if (!client) return false;
	await client.request("pane.send_keys", { pane_id: handle.paneId, keys: ["esc"] }, { mutation: true });
	return true;
}
export async function focusHerdrPane(handle: HerdrPaneHandle): Promise<boolean> {
	const client = await revalidateHerdrMutationTarget(handle);
	if (!client) return false;
	await client.request("pane.focus", { pane_id: handle.paneId }, { mutation: true });
	return true;
}
export async function closeHerdrPane(handle: HerdrPaneHandle): Promise<boolean> {
	const client = await revalidateHerdrMutationTarget(handle);
	if (!client) return true;
	await client.request("pane.close", { pane_id: handle.paneId }, { mutation: true });
	return (await inspectHerdrPane(handle))?.exists === false;
}
