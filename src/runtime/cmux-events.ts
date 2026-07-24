import { CmuxControlSocketError, CmuxControlSocketClient, CMUX_UUID_RE, parseCmuxNdjsonLine, type CmuxConnectionIdentity } from "./cmux-control-socket.mjs";

export type CmuxEventReconciliationHint = "gap" | "reorder" | "slow_consumer" | "overflow" | "auth_failure" | "malformed" | "heartbeat_timeout";
export interface CmuxEventCursor { boot_id: string; seq: number; }
export interface CmuxEvent {
	protocol: string;
	version: number;
	boot_id: string;
	seq: number;
	id: string;
	name: string;
	category: string;
	source: string;
	occurred_at: string;
	payload: Record<string, unknown>;
	workspace_id: string | null;
	window_id: string | null;
	pane_id: string | null;
	surface_id: string | null;
	payload_truncated?: boolean;
}
export interface CmuxEventsOptions {
	env?: NodeJS.ProcessEnv;
	password?: string;
	capability?: string;
	expectedConnection?: CmuxConnectionIdentity;
	cursor?: CmuxEventCursor;
	names?: string[];
	categories?: string[];
	includeHeartbeats?: boolean;
	ackTimeoutMs?: number;
	appVersionValidator?: (identify: Record<string, unknown>, capabilities: Record<string, unknown>) => boolean | Promise<boolean>;
	onEvent?: (event: CmuxEvent) => void;
	onReconcile?: (hint: CmuxEventReconciliationHint) => void;
	onDisconnect?: () => void;
	/** Testable policy seam; production defaults to two acknowledged intervals. */
	heartbeatTimeoutMultiplier?: number;
	setHeartbeatTimer?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
	clearHeartbeatTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface CmuxStreamAck {
	protocol: string;
	version: number;
	boot_id: string;
	subscription_id: string;
	heartbeat_interval_seconds: number;
	replay_count: number;
	resume: { after_seq: number | null; requested_after_seq: number; oldest_seq: number; latest_seq: number; next_seq: number; gap: boolean; gap_reason?: string };
	filters: { names: string[]; categories: string[] };
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function own(value: Record<string, unknown>, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => own(value, key)); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value; }
function uuid(value: unknown): value is string { return typeof value === "string" && CMUX_UUID_RE.test(value); }
function sequence(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function eventSequence(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
const MAX_HEARTBEAT_INTERVAL_SECONDS = 3_600;
function cursor(value: unknown): value is CmuxEventCursor { return object(value) && exactKeys(value, ["boot_id", "seq"]) && text(value.boot_id) && sequence(value.seq); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text) && new Set(value).size === value.length; }
function protocolFields(value: Record<string, unknown>): boolean { return value.protocol === "cmux-events" && value.version === 1 && uuid(value.boot_id); }
function nullableUuid(value: unknown): value is string | null { return value === null || uuid(value); }

/** Parse only the pinned upstream event-stream frames; these are never RPC responses. */
export function parseCmuxEventLine(line: string):
	| { kind: "ack"; ack: CmuxStreamAck }
	| { kind: "event"; event: CmuxEvent }
	| { kind: "heartbeat"; cursor: CmuxEventCursor; subscription_id: string }
	| { kind: "error"; code: string; message: string; latest_seq?: number } {
	const value = parseCmuxNdjsonLine(line);
	if (!text(value.type)) throw new CmuxControlSocketError("CMUX_EVENT", "cmux event type is invalid");
	if (value.type === "ack") {
		const keys = ["type", "protocol", "version", "boot_id", "subscription_id", "heartbeat_interval_seconds", "replay_count", "resume", "filters"];
		const resume = object(value.resume) ? value.resume : null;
		const filters = object(value.filters) ? value.filters : null;
		const resumeKeys = resume ? Object.keys(resume) : [];
		if (!exactKeys(value, keys) || !protocolFields(value) || !uuid(value.subscription_id) || !Number.isSafeInteger(value.heartbeat_interval_seconds) || (value.heartbeat_interval_seconds as number) <= 0 || (value.heartbeat_interval_seconds as number) > MAX_HEARTBEAT_INTERVAL_SECONDS || !sequence(value.replay_count) || !resume || !["after_seq", "requested_after_seq", "oldest_seq", "latest_seq", "next_seq", "gap"].every((key) => own(resume, key)) || resumeKeys.some((key) => !["after_seq", "requested_after_seq", "oldest_seq", "latest_seq", "next_seq", "gap", "gap_reason"].includes(key)) || !(resume.after_seq === null || sequence(resume.after_seq)) || !sequence(resume.requested_after_seq) || !sequence(resume.oldest_seq) || !sequence(resume.latest_seq) || !sequence(resume.next_seq) || typeof resume.gap !== "boolean" || own(resume, "gap_reason") !== resume.gap || (own(resume, "gap_reason") && !text(resume.gap_reason)) || !filters || !exactKeys(filters, ["names", "categories"]) || !strings(filters.names) || !strings(filters.categories)) throw new CmuxControlSocketError("CMUX_EVENT", "cmux event acknowledgement is invalid");
		return { kind: "ack", ack: value as unknown as CmuxStreamAck };
	}
	if (value.type === "event") {
		const idKeys = ["workspace_id", "window_id", "pane_id", "surface_id"];
		const required = ["type", "protocol", "version", "boot_id", "seq", "id", "name", "category", "source", "occurred_at", "payload", ...idKeys];
		const allowed = [...required, "payload_truncated"];
		if (!Object.keys(value).every((key) => allowed.includes(key)) || !required.every((key) => own(value, key)) || !protocolFields(value) || !eventSequence(value.seq)
			|| value.id !== `${value.boot_id}-${value.seq}` || !text(value.name) || !text(value.category) || !text(value.source) || !text(value.occurred_at)
			|| !object(value.payload) || idKeys.some((key) => !nullableUuid(value[key])) || (own(value, "payload_truncated") && value.payload_truncated !== true)) throw new CmuxControlSocketError("CMUX_EVENT", "cmux event envelope is invalid");
		return { kind: "event", event: value as unknown as CmuxEvent };
	}
	if (value.type === "heartbeat") {
		if (!exactKeys(value, ["type", "protocol", "version", "boot_id", "subscription_id", "latest_seq", "occurred_at"]) || !protocolFields(value) || !uuid(value.subscription_id) || !sequence(value.latest_seq) || !text(value.occurred_at)) throw new CmuxControlSocketError("CMUX_EVENT", "cmux heartbeat envelope is invalid");
		return { kind: "heartbeat", cursor: { boot_id: value.boot_id as string, seq: value.latest_seq as number }, subscription_id: value.subscription_id as string };
	}
	if (value.type === "error") {
		const error = object(value.error) ? value.error : null;
		if (!exactKeys(value, ["type", "ok", "error"]) || value.ok !== false || !error || !Object.keys(error).every((key) => ["code", "message", "latest_seq"].includes(key)) || !text(error.code) || !text(error.message)
			|| (own(error, "latest_seq") && !sequence(error.latest_seq)) || (error.code === "slow_consumer" && !sequence(error.latest_seq))) throw new CmuxControlSocketError("CMUX_EVENT", "cmux event error envelope is invalid");
		return { kind: "error", code: error.code, message: error.message, latest_seq: error.latest_seq as number | undefined };
	}
	throw new CmuxControlSocketError("CMUX_EVENT", "unknown cmux event envelope");
}

/** An event stream is a distinct socket with an ack frame, not an RPC response. */
export class CmuxEventsClient {
	private client?: CmuxControlSocketClient;
	private last?: CmuxEventCursor;
	private heartbeatTimer?: ReturnType<typeof setTimeout>;
	private heartbeatIntervalSeconds?: number;
	private subscriptionId?: string;
	private ackAccepted = false;
	private replayRemaining = 0;
	private replayLatestSeq = 0;
	private readonly requestedAfterSeq?: number;
	private readonly requestedNames: string[];
	private readonly requestedCategories: string[];
	private streamFailed = false;
	private readonly options: CmuxEventsOptions;
	constructor(options: CmuxEventsOptions = {}) {
		this.options = options;
		if (options.cursor && !cursor(options.cursor)) throw new CmuxControlSocketError("CMUX_CURSOR", "cmux event cursor is invalid");
		if (options.names && !strings(options.names)) throw new CmuxControlSocketError("CMUX_EVENT", "cmux event names are invalid");
		if (options.categories && !strings(options.categories)) throw new CmuxControlSocketError("CMUX_EVENT", "cmux event categories are invalid");
		if (options.heartbeatTimeoutMultiplier !== undefined && (!Number.isFinite(options.heartbeatTimeoutMultiplier) || options.heartbeatTimeoutMultiplier < 1 || options.heartbeatTimeoutMultiplier > 10)) throw new CmuxControlSocketError("CMUX_EVENT", "cmux heartbeat timeout multiplier is invalid");
		this.last = options.cursor;
		this.requestedAfterSeq = options.cursor?.seq;
		this.requestedNames = [...(options.names ?? [])].sort();
		this.requestedCategories = [...(options.categories ?? [])].sort();
	}
	get cursor(): CmuxEventCursor | undefined { return this.last && { ...this.last }; }
	get healthy(): boolean { return this.client !== undefined && !this.streamFailed; }
	async start(): Promise<void> {
		this.clearHeartbeat();
		this.streamFailed = false;
		this.ackAccepted = false;
		this.replayRemaining = 0;
		this.subscriptionId = undefined;
		const client = new CmuxControlSocketClient({ env: this.options.env, password: this.options.password, capability: this.options.capability });
		this.client = client;
		try {
			await client.connect();
			if (this.options.expectedConnection) {
				const actual = client.connectionIdentity();
				const expected = this.options.expectedConnection;
				if (!actual || actual.socketPath !== expected.socketPath || actual.socketDev !== expected.socketDev || actual.socketIno !== expected.socketIno) throw new CmuxControlSocketError("CMUX_SOCKET_ROTATED", "cmux event socket generation differs from request authority");
			}
			// In cmux 0.64.20 events.stream is a special stream upgrade and is not
			// included in system.capabilities.methods. The exact app-version gate
			// and pinned stream ack are the contract proof.
			await client.handshake({ requiredMethods: [], appVersionValidator: this.options.appVersionValidator });
			await new Promise<CmuxStreamAck>(async (resolve, reject) => {
				let settled = false;
				let timer: ReturnType<typeof setTimeout>;
				const fail = (error: unknown) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
				timer = setTimeout(() => fail(new CmuxControlSocketError("CMUX_EVENT_TIMEOUT", "events.stream acknowledgement timed out")), this.options.ackTimeoutMs ?? 5_000);
				client.onTransportError = (error: unknown) => {
					if (!settled) fail(error);
					else this.failStream("gap");
				};
				client.onNotification = (line: Record<string, unknown>) => {
					try {
						const parsed = parseCmuxEventLine(JSON.stringify(line));
						if (!settled) {
							if (parsed.kind !== "ack") throw new CmuxControlSocketError("CMUX_EVENT", "events.stream did not begin with an acknowledgement");
							this.acceptAck(parsed.ack); settled = true; clearTimeout(timer); resolve(parsed.ack); return;
						}
						this.consumeParsed(parsed);
					} catch (error) {
						if (!settled) { fail(error); this.hint("malformed"); client.close(); }
						else this.failStream("malformed");
					}
				};
				try {
					await client.startEventStream({ ...(this.last ? { after_seq: this.last.seq } : {}), names: this.options.names ?? [], categories: this.options.categories ?? [], include_heartbeats: this.options.includeHeartbeats ?? false });
				} catch (error) { fail(error); }
			});
		} catch (error) { this.clearHeartbeat(); client.close(); this.client = undefined; throw error; }
	}
	consume(line: string): void { this.consumeParsed(parseCmuxEventLine(line)); }
	private consumeParsed(parsed: ReturnType<typeof parseCmuxEventLine>): void {
		if (this.streamFailed) return;
		if (parsed.kind === "error") {
			this.failStream(parsed.code === "auth_failure" ? "auth_failure" : parsed.code === "slow_consumer" ? "slow_consumer" : parsed.code === "overflow" ? "overflow" : "malformed");
			return;
		}
		if (parsed.kind === "ack") { this.acceptAck(parsed.ack); return; }
		if (!this.ackAccepted) { this.failStream("malformed"); return; }
		if (parsed.kind === "heartbeat") {
			if (this.replayRemaining !== 0 || parsed.subscription_id !== this.subscriptionId) { this.failStream("malformed"); return; }
			if (this.last && parsed.cursor.boot_id !== this.last.boot_id) { this.failStream("gap"); return; }
			if (this.last && parsed.cursor.seq < this.last.seq) { this.failStream("reorder"); return; }
			// latest_seq is only a global watermark. A matching event with that
			// sequence may still be queued immediately behind this heartbeat.
			this.armHeartbeat();
			return;
		}
		const event = parsed.event;
		if (this.last && event.boot_id !== this.last.boot_id) { this.failStream("gap"); return; }
		const unfiltered = this.requestedNames.length === 0 && this.requestedCategories.length === 0;
		if (this.last && (event.seq <= this.last.seq || (unfiltered && event.seq !== this.last.seq + 1))) { this.failStream(event.seq <= this.last.seq ? "reorder" : "gap"); return; }
		if (this.replayRemaining > 0) {
			if (event.seq > this.replayLatestSeq) { this.failStream("gap"); return; }
			this.replayRemaining -= 1;
		}
		this.last = { boot_id: event.boot_id, seq: event.seq };
		this.armHeartbeat();
		this.options.onEvent?.(event);
	}
	private acceptAck(ack: CmuxStreamAck): void {
		if (this.ackAccepted) { this.failStream("malformed"); return; }
		const resume = ack.resume;
		const filtersMatch = JSON.stringify(ack.filters.names) === JSON.stringify(this.requestedNames)
			&& JSON.stringify(ack.filters.categories) === JSON.stringify(this.requestedCategories);
		const initialSubscription = this.requestedAfterSeq === undefined;
		const expectedRequested = this.requestedAfterSeq ?? resume.latest_seq;
		const maximumReplay = initialSubscription ? 0 : Math.max(0, resume.latest_seq - expectedRequested);
		const unfiltered = this.requestedNames.length === 0 && this.requestedCategories.length === 0;
		const retainedNonEmpty = resume.oldest_seq <= resume.latest_seq;
		const exactEmptyTuple = resume.oldest_seq === 1 && resume.latest_seq === 0 && resume.next_seq === 1;
		const expectedGap = !initialSubscription && (expectedRequested > resume.latest_seq || (retainedNonEmpty && expectedRequested < resume.oldest_seq - 1));
		const expectedUnfilteredReplay = initialSubscription || expectedRequested > resume.latest_seq ? 0
			: expectedGap ? resume.latest_seq - resume.oldest_seq + 1 : resume.latest_seq - expectedRequested;
		if (!filtersMatch || resume.after_seq !== (this.requestedAfterSeq ?? null) || resume.requested_after_seq !== expectedRequested
			|| resume.oldest_seq < 1 || resume.latest_seq >= Number.MAX_SAFE_INTEGER || resume.next_seq !== resume.latest_seq + 1
			|| !(retainedNonEmpty || exactEmptyTuple) || resume.gap !== expectedGap
			|| ack.replay_count > maximumReplay || (unfiltered && ack.replay_count !== expectedUnfilteredReplay) || (initialSubscription && (resume.gap || ack.replay_count !== 0))) {
			this.failStream("malformed");
			return;
		}
		this.ackAccepted = true;
		this.subscriptionId = ack.subscription_id;
		this.replayRemaining = ack.replay_count;
		this.replayLatestSeq = resume.latest_seq;
		this.heartbeatIntervalSeconds = ack.heartbeat_interval_seconds;
		if (this.last && ack.boot_id !== this.last.boot_id) {
			this.last = { boot_id: ack.boot_id, seq: resume.latest_seq };
			this.failStream("gap");
			return;
		}
		if (resume.gap) {
			this.last = { boot_id: ack.boot_id, seq: resume.latest_seq };
			this.failStream("gap");
			return;
		}
		this.last = { boot_id: ack.boot_id, seq: expectedRequested };
		this.armHeartbeat();
	}
	private armHeartbeat(): void {
		if (!(this.options.includeHeartbeats ?? false) || this.heartbeatIntervalSeconds === undefined || this.streamFailed) return;
		this.clearHeartbeat();
		const timeoutMs = this.heartbeatIntervalSeconds * 1_000 * (this.options.heartbeatTimeoutMultiplier ?? 2);
		const timer = this.options.setHeartbeatTimer
			? this.options.setHeartbeatTimer(() => this.failStream("heartbeat_timeout"), timeoutMs)
			: setTimeout(() => this.failStream("heartbeat_timeout"), timeoutMs);
		this.heartbeatTimer = timer;
		timer.unref?.();
	}
	private clearHeartbeat(): void {
		if (!this.heartbeatTimer) return;
		(this.options.clearHeartbeatTimer ?? clearTimeout)(this.heartbeatTimer);
		this.heartbeatTimer = undefined;
	}
	private failStream(hint: CmuxEventReconciliationHint): void {
		if (this.streamFailed) return;
		this.streamFailed = true;
		this.clearHeartbeat();
		const client = this.client;
		this.client = undefined;
		this.hint(hint);
		client?.close();
		try { this.options.onDisconnect?.(); } catch { /* observer only */ }
	}
	private hint(hint: CmuxEventReconciliationHint): void { try { this.options.onReconcile?.(hint); } catch { /* callbacks do not control the transport */ } }
	close(): void { this.streamFailed = true; this.clearHeartbeat(); this.client?.close(); this.client = undefined; }
}
