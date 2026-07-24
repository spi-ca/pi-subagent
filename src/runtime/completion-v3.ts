import * as crypto from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import type { SessionBoundaryV3 } from "./run-protocol.js";

export const MAX_COMPLETION_SESSION_BYTES = 64 * 1024 * 1024;
/** Per-entry limits bound parser retention independently of the full 64 MiB prefix cap. */
export const MAX_COMPLETION_SESSION_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_COMPLETION_SESSION_ENTRY_COUNT = 100_000;
export const MAX_COMPLETION_SESSION_ENTRY_ID_BYTES = 8 * 1024 * 1024;
const DEFAULT_SESSION_VERIFICATION_TIMEOUT_MS = 5_000;

/** Parent-captured identity only; it is deliberately not part of child completion data. */
export interface SessionFileIdentity { dev: bigint; ino: bigint }
export interface SessionBoundaryVerificationOptions { expectedSessionIdentity?: SessionFileIdentity }

/**
 * Owns the global verification-buffer reservation for returned session bytes.
 * Consumers must release after parsing; release is idempotent for safe cleanup.
 */
export interface VerifiedSessionSuffixLease {
	bytes: Buffer;
	release(): void;
}

/** A test-only positional-read seam; production uses FileHandle.read directly. */
export type SessionVerificationPositionalRead = (
	handle: fs.FileHandle,
	buffer: Buffer,
	offset: number,
	length: number,
	position: number,
) => Promise<number>;

/**
 * Every verifier reserves its one, exact-size prefix buffer before allocating it.
 * The reservation remains held by a returned suffix lease or by an unresolved
 * positional read, so no caller can overcommit process memory by racing I/O.
 */
let verificationBufferLimit = MAX_COMPLETION_SESSION_BYTES;
let verificationBufferUsed = 0;
let verificationReservationTimeoutMs = DEFAULT_SESSION_VERIFICATION_TIMEOUT_MS;
let verificationReadTimeoutMs = DEFAULT_SESSION_VERIFICATION_TIMEOUT_MS;
let verificationPositionalRead: SessionVerificationPositionalRead | undefined;
interface VerificationWaiter {
	bytes: number;
	resolve: (release: (() => void) | null) => void;
	timer: ReturnType<typeof setTimeout>;
}
const verificationWaiters: VerificationWaiter[] = [];

function releaseVerificationBuffer(bytes: number): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		verificationBufferUsed -= bytes;
		drainVerificationWaiters();
	};
}

function drainVerificationWaiters(): void {
	while (verificationWaiters.length > 0) {
		const waiter = verificationWaiters[0]!;
		if (verificationBufferUsed + waiter.bytes > verificationBufferLimit) return;
		verificationWaiters.shift();
		clearTimeout(waiter.timer);
		verificationBufferUsed += waiter.bytes;
		waiter.resolve(releaseVerificationBuffer(waiter.bytes));
	}
}

async function reserveVerificationBuffer(bytes: number): Promise<(() => void) | null> {
	if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > verificationBufferLimit) return null;
	if (verificationWaiters.length === 0 && verificationBufferUsed + bytes <= verificationBufferLimit) {
		verificationBufferUsed += bytes;
		return releaseVerificationBuffer(bytes);
	}
	return await new Promise((resolve) => {
		let waiter: VerificationWaiter;
		const timer = setTimeout(() => {
			const index = verificationWaiters.indexOf(waiter);
			if (index < 0) return;
			verificationWaiters.splice(index, 1);
			resolve(null);
			drainVerificationWaiters();
		}, verificationReservationTimeoutMs);
		timer.unref?.();
		waiter = { bytes, resolve, timer };
		verificationWaiters.push(waiter);
		drainVerificationWaiters();
	});
}

/** Test seam for asserting reservation ownership; production always uses the 64 MiB limit. */
export function setSessionVerificationBufferLimitForTesting(limit: number): () => void {
	if (!Number.isSafeInteger(limit) || limit < 0 || verificationWaiters.length > 0 || verificationBufferUsed > limit) {
		throw new Error("Cannot change the session verification buffer limit while reservations are active.");
	}
	const previous = verificationBufferLimit;
	verificationBufferLimit = limit;
	return () => { verificationBufferLimit = previous; drainVerificationWaiters(); };
}

/** Test seam for short, deterministic acquisition and positional-read deadlines. */
export function setSessionVerificationTimeoutForTesting(timeoutMs: number): () => void {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Error("The session verification timeout must be between 1 and 60000 ms.");
	const previousReservation = verificationReservationTimeoutMs;
	const previousRead = verificationReadTimeoutMs;
	verificationReservationTimeoutMs = timeoutMs;
	verificationReadTimeoutMs = timeoutMs;
	return () => {
		verificationReservationTimeoutMs = previousReservation;
		verificationReadTimeoutMs = previousRead;
	};
}

/** Test seam for a stalled or partial positional read. */
export function setSessionVerificationPositionalReadForTesting(read: SessionVerificationPositionalRead | undefined): () => void {
	const previous = verificationPositionalRead;
	verificationPositionalRead = read;
	return () => { verificationPositionalRead = previous; };
}

/** Test-only visibility for asserting that a full prefix buffer is accounted for. */
export function getSessionVerificationBufferUsageForTesting(): Readonly<{ limit: number; used: number; waiters: number }> {
	return { limit: verificationBufferLimit, used: verificationBufferUsed, waiters: verificationWaiters.length };
}

function isBoundary(value: SessionBoundaryV3): boolean {
	return Number.isSafeInteger(value.byteOffset) && value.byteOffset > 0
		&& typeof value.finalEntryId === "string" && validSessionEntryId(value.finalEntryId)
		&& value.digestAlgorithm === "sha256" && /^[a-f0-9]{64}$/.test(value.prefixDigest);
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function matchesExpectedIdentity(stat: BigIntStats, expected: SessionFileIdentity | undefined): boolean {
	return !expected || (stat.dev === expected.dev && stat.ino === expected.ino);
}

type SessionEntry = { id?: string; kind: "assistant" } | { id?: string; kind: "metadata"; parentId: string } | { id?: string; kind: "other" };
type ValidationMode = "generic" | "completion" | "legacy-completion";
type PrefixRead = { digest: string; finalEntryId: string | null; byteOffset: number; bytes: Buffer };
type TimedOutRead = { settled: Promise<void> };

/** Pi 0.81 can append these linked, non-message records after agent settlement. */
function validCompletionMetadata(entry: Record<string, unknown>, id: string | undefined): entry is Record<string, unknown> & { parentId: string } {
	if (!id || !validSessionEntryId(entry.parentId) || typeof entry.timestamp !== "string" || !entry.timestamp) return false;
	switch (entry.type) {
		case "thinking_level_change":
			return typeof entry.thinkingLevel === "string" && entry.thinkingLevel.length > 0;
		case "model_change":
			return typeof entry.provider === "string" && entry.provider.length > 0
				&& typeof entry.modelId === "string" && entry.modelId.length > 0;
		case "compaction":
			return typeof entry.summary === "string" && typeof entry.tokensBefore === "number" && Number.isFinite(entry.tokensBefore)
				&& (typeof entry.firstKeptEntryId === "string" || Array.isArray(entry.retainedTail));
		case "branch_summary":
			return typeof entry.fromId === "string" && entry.fromId.length > 0 && typeof entry.summary === "string";
		case "custom":
			return typeof entry.customType === "string" && entry.customType.length > 0;
		case "custom_message":
			return typeof entry.customType === "string" && entry.customType.length > 0 && typeof entry.display === "boolean";
		case "label":
			return typeof entry.targetId === "string" && entry.targetId.length > 0
				&& (entry.label === undefined || typeof entry.label === "string");
		case "session_info":
			return entry.name === undefined || typeof entry.name === "string";
		default:
			return false;
	}
}

/** Parse one JSONL entry. Generic boundaries require every ID; completion accepts a linked Pi metadata tail. */
function sessionEntry(line: Buffer): SessionEntry | null {
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const entry = value as Record<string, unknown>;
		const id = validSessionEntryId(entry.id) ? entry.id : undefined;
		if (entry.type === "message" && entry.message && typeof entry.message === "object" && !Array.isArray(entry.message)
			&& (entry.message as { role?: unknown }).role === "assistant") return id ? { id, kind: "assistant" } : null;
		if (validCompletionMetadata(entry, id)) return { id, kind: "metadata", parentId: entry.parentId };
		return id ? { id, kind: "other" } : { kind: "other" };
	} catch { return null; }
}

function validSessionEntryId(value: unknown): value is string {
	return typeof value === "string" && /^[^\u0000-\u001f\u007f]{1,512}$/.test(value);
}

function validateLegacyCompletionPrefix(prefix: Buffer): { byteOffset: number; finalEntryId: string } | null {
	// Keep full-tail validation and its entry/ID limits. Only the published
	// boundary is legacy-shaped; malformed or unlinked metadata never becomes a
	// reason to relax the normal success proof.
	if (!validatePrefix(prefix, "completion")) return null;
	let lastAssistantOffset = 0;
	let lineStart = 0;
	while (lineStart < prefix.length) {
		const lineEnd = prefix.indexOf(0x0a, lineStart);
		if (lineEnd < 0) return null;
		const entry = sessionEntry(prefix.subarray(lineStart, lineEnd));
		if (entry?.kind === "assistant" && entry.id) lastAssistantOffset = lineEnd + 1;
		lineStart = lineEnd + 1;
	}
	if (lineStart !== prefix.length || lastAssistantOffset === 0) return null;
	// Validate exactly the legacy-bound prefix. Later Pi metadata is deliberately
	// excluded so an older parent sees the final assistant it expects.
	const finalEntryId = validatePrefix(prefix.subarray(0, lastAssistantOffset), "completion");
	return finalEntryId ? { byteOffset: lastAssistantOffset, finalEntryId } : null;
}

function validatePrefix(prefix: Buffer, mode: Exclude<ValidationMode, "legacy-completion">): string | null {
	const entryIds = new Set<string>();
	let entryCount = 0;
	let entryIdBytes = 0;
	let genericFinalEntryId: string | null = null;
	let completionFinalEntryId: string | null = null;
	let hasValidCompletionTail = false;
	let lineStart = 0;

	while (lineStart < prefix.length) {
		const lineEnd = prefix.indexOf(0x0a, lineStart);
		if (lineEnd < 0 || lineEnd - lineStart > MAX_COMPLETION_SESSION_ENTRY_BYTES
			|| entryCount >= MAX_COMPLETION_SESSION_ENTRY_COUNT) return null;
		// subarray is a view into the one reservation-backed prefix buffer; no
		// per-chunk retention or line concatenation is needed.
		const entry = sessionEntry(prefix.subarray(lineStart, lineEnd));
		if (!entry?.id || entryIds.has(entry.id)) return null;
		const idBytes = Buffer.byteLength(entry.id, "utf8");
		if (idBytes > MAX_COMPLETION_SESSION_ENTRY_ID_BYTES - entryIdBytes) return null;
		entryIds.add(entry.id);
		entryIdBytes += idBytes;
		entryCount += 1;
		if (mode === "generic") genericFinalEntryId = entry.id;
		if (mode === "completion") {
			if (entry.kind === "assistant") {
				completionFinalEntryId = entry.id;
				hasValidCompletionTail = true;
			} else if (!hasValidCompletionTail || entry.kind !== "metadata" || entry.parentId !== completionFinalEntryId) {
				hasValidCompletionTail = false;
			} else {
				completionFinalEntryId = entry.id;
			}
		}
		lineStart = lineEnd + 1;
	}
	if (lineStart !== prefix.length || (mode === "generic" && genericFinalEntryId === null)) return null;
	return mode === "completion" ? (hasValidCompletionTail ? completionFinalEntryId : null) : genericFinalEntryId;
}

async function readExactPrefix(handle: fs.FileHandle, prefix: Buffer): Promise<boolean> {
	const positionalRead = verificationPositionalRead;
	let position = 0;
	while (position < prefix.length) {
		const bytesRead = positionalRead
			? await positionalRead(handle, prefix, position, prefix.length - position, position)
			: (await handle.read(prefix, position, prefix.length - position, position)).bytesRead;
		if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > prefix.length - position) return false;
		position += bytesRead;
	}
	return true;
}

async function readAndHashPrefix(handle: fs.FileHandle, byteOffset: number, mode: ValidationMode): Promise<PrefixRead | TimedOutRead | null> {
	if (!Number.isSafeInteger(byteOffset) || byteOffset <= 0 || byteOffset > MAX_COMPLETION_SESSION_BYTES) return null;
	let prefix: Buffer;
	try { prefix = Buffer.allocUnsafe(byteOffset); } catch { return null; }
	// Catch here, before racing the deadline, so an I/O error that arrives after
	// the caller has timed out cannot become an unhandled rejection.
	const read = readExactPrefix(handle, prefix).catch(() => false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), verificationReadTimeoutMs);
		timer.unref?.();
	});
	const result = await Promise.race([read, timeout]);
	if (result === "timeout") return { settled: read.then(() => undefined) };
	clearTimeout(timer);
	if (!result) return null;
	const legacyBoundary = mode === "legacy-completion" ? validateLegacyCompletionPrefix(prefix) : null;
	const finalEntryId = legacyBoundary?.finalEntryId ?? (mode === "legacy-completion" ? null : validatePrefix(prefix, mode));
	if (!finalEntryId) return null;
	const boundaryByteOffset = legacyBoundary?.byteOffset ?? byteOffset;
	return {
		digest: crypto.createHash("sha256").update(prefix.subarray(0, boundaryByteOffset)).digest("hex"),
		finalEntryId,
		byteOffset: boundaryByteOffset,
		bytes: prefix,
	};
}

async function withSessionFile<T>(
	filePath: string,
	operation: (handle: fs.FileHandle, before: BigIntStats, deferClose: (cleanup: Promise<void>) => void) => Promise<T | null>,
	options: SessionBoundaryVerificationOptions = {},
	allowAppendAfterOffset?: number,
): Promise<T | null> {
	// A FIFO can block in open before fstat rejects its non-regular inode.
	// Require O_NONBLOCK on Unix so all verifier operations fail closed promptly.
	if (!fsConstants.O_NOFOLLOW || (process.platform !== "win32" && !fsConstants.O_NONBLOCK)) return null;
	const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	let deferredCleanup: Promise<void> | undefined;
	try {
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || !matchesExpectedIdentity(before, options.expectedSessionIdentity)) return null;
		const result = await operation(handle, before, (cleanup) => { deferredCleanup = cleanup; });
		// A timed-out read still owns the FileHandle and its reservation. Do not
		// await close (which may wait for that read), and do not perform a
		// post-read stability check on a prefix we have already failed closed.
		if (deferredCleanup) return null;
		const [after, pathname] = await Promise.all([handle.stat({ bigint: true }), fs.lstat(filePath, { bigint: true })]);
		const sameIdentity = before.dev === after.dev && before.ino === after.ino
			&& pathname.dev === before.dev && pathname.ino === before.ino && pathname.isFile() && !pathname.isSymbolicLink()
			&& matchesExpectedIdentity(after, options.expectedSessionIdentity) && matchesExpectedIdentity(pathname, options.expectedSessionIdentity);
		const stable = allowAppendAfterOffset === undefined
			? sameIdentity && sameFile(before, after) && sameFile(before, pathname)
			: sameIdentity && after.size >= BigInt(allowAppendAfterOffset) && pathname.size >= BigInt(allowAppendAfterOffset);
		return stable ? result : null;
	} finally {
		if (deferredCleanup) {
			void deferredCleanup.then(() => handle.close(), () => handle.close()).catch(() => {});
		} else {
			await handle.close();
		}
	}
}

async function withVerifiedBoundary<T>(
	filePath: string,
	boundary: SessionBoundaryV3,
	mode: ValidationMode,
	operation: (read: PrefixRead) => T | null,
	options: SessionBoundaryVerificationOptions,
): Promise<T | null> {
	if (!isBoundary(boundary)) return null;
	return await withSessionFile(filePath, async (handle, before, deferClose) => {
		if (before.size < BigInt(boundary.byteOffset)) return null;
		const release = await reserveVerificationBuffer(boundary.byteOffset);
		if (!release) return null;
		let deferred = false;
		try {
			const read = await readAndHashPrefix(handle, boundary.byteOffset, mode);
			if (read && "settled" in read) {
				deferred = true;
				deferClose(read.settled.then(() => release()));
				return null;
			}
			return read && read.digest === boundary.prefixDigest && read.finalEntryId === boundary.finalEntryId ? operation(read) : null;
		} finally { if (!deferred) release(); }
	}, options, boundary.byteOffset);
}

/** Capture a parent-side identity binding without putting it in child-supplied completion data. */
export async function getSessionFileIdentity(filePath: string): Promise<SessionFileIdentity | null> {
	return await withSessionFile(filePath, async (_handle, before) => ({ dev: before.dev, ino: before.ino }));
}

async function computeSessionBoundary(filePath: string, mode: ValidationMode, options: SessionBoundaryVerificationOptions): Promise<SessionBoundaryV3 | null> {
	return await withSessionFile(filePath, async (handle, before, deferClose) => {
		if (before.size <= 0n || before.size > BigInt(MAX_COMPLETION_SESSION_BYTES)) return null;
		const byteOffset = Number(before.size);
		const release = await reserveVerificationBuffer(byteOffset);
		if (!release) return null;
		let deferred = false;
		try {
			const read = await readAndHashPrefix(handle, byteOffset, mode);
			if (read && "settled" in read) {
				deferred = true;
				deferClose(read.settled.then(() => release()));
				return null;
			}
			return read?.finalEntryId ? { byteOffset: read.byteOffset, finalEntryId: read.finalEntryId, digestAlgorithm: "sha256", prefixDigest: read.digest } : null;
		} finally { if (!deferred) release(); }
	}, options);
}

/** Compute a generic complete JSONL boundary suitable for abnormal completion evidence. */
export async function computeSessionFailureBoundary(filePath: string, options: SessionBoundaryVerificationOptions = {}): Promise<SessionBoundaryV3 | null> {
	return await computeSessionBoundary(filePath, "generic", options);
}

/** Compute a success boundary while retaining final-assistant/linked-metadata-chain validation. */
export async function computeSessionCompletionBoundary(filePath: string, options: SessionBoundaryVerificationOptions = {}): Promise<SessionBoundaryV3 | null> {
	return await computeSessionBoundary(filePath, "completion", options);
}

/**
 * Compute the pre-metadata-tail success boundary for an older parent verifier.
 * The descriptor-bound snapshot, resource limits, and optional identity binding
 * are identical to the full completion boundary; only later metadata is omitted.
 */
export async function computeLegacySessionCompletionBoundary(filePath: string, options: SessionBoundaryVerificationOptions = {}): Promise<SessionBoundaryV3 | null> {
	return await computeSessionBoundary(filePath, "legacy-completion", options);
}

async function readVerifiedSessionSuffixLease(
	filePath: string,
	boundary: SessionBoundaryV3,
	mode: ValidationMode,
	fromOffset: number,
	options: SessionBoundaryVerificationOptions,
): Promise<VerifiedSessionSuffixLease | null> {
	if (!isBoundary(boundary) || !Number.isSafeInteger(fromOffset) || fromOffset < 0 || fromOffset > boundary.byteOffset) return null;
	const leaseState: { candidate?: VerifiedSessionSuffixLease } = {};
	try {
		const result = await withSessionFile(filePath, async (handle, before, deferClose) => {
			if (before.size < BigInt(boundary.byteOffset)) return null;
			const release = await reserveVerificationBuffer(boundary.byteOffset);
			if (!release) return null;
			let retained = false;
			try {
				const read = await readAndHashPrefix(handle, boundary.byteOffset, mode);
				if (read && "settled" in read) {
					retained = true;
					deferClose(read.settled.then(() => release()));
					return null;
				}
				if (!read || read.digest !== boundary.prefixDigest || read.finalEntryId !== boundary.finalEntryId) return null;
				// The suffix is a view into the reservation-backed full prefix buffer.
				leaseState.candidate = { bytes: read.bytes.subarray(fromOffset), release };
				retained = true;
				return leaseState.candidate;
			} finally { if (!retained) release(); }
		}, options, boundary.byteOffset);
		// withSessionFile validates identity/stability after the callback returns.
		// Reclaim a candidate that did not escape that final check.
		if (!result) leaseState.candidate?.release();
		return result;
	} catch (error) {
		leaseState.candidate?.release();
		throw error;
	}
}

/** Read a suffix only after generically validating the exact digest-bound prefix. */
export async function readVerifiedSessionSuffix(filePath: string, boundary: SessionBoundaryV3, fromOffset: number, options: SessionBoundaryVerificationOptions = {}): Promise<VerifiedSessionSuffixLease | null> {
	return await readVerifiedSessionSuffixLease(filePath, boundary, "generic", fromOffset, options);
}

/** Verify a generic complete JSONL prefix; later appends on the same inode are allowed. */
export async function verifySessionBoundary(filePath: string, boundary: SessionBoundaryV3, options: SessionBoundaryVerificationOptions = {}): Promise<boolean> {
	return await withVerifiedBoundary(filePath, boundary, "generic", () => true, options) ?? false;
}

/** Read a suffix after the additional success-specific final-assistant/linked-metadata-chain validation. */
export async function readVerifiedSessionCompletionSuffix(filePath: string, boundary: SessionBoundaryV3, fromOffset: number, options: SessionBoundaryVerificationOptions = {}): Promise<VerifiedSessionSuffixLease | null> {
	return await readVerifiedSessionSuffixLease(filePath, boundary, "completion", fromOffset, options);
}

/** Verify a successful-completion prefix with its final assistant/linked-metadata-chain semantics. */
export async function verifySessionCompletionBoundary(filePath: string, boundary: SessionBoundaryV3, options: SessionBoundaryVerificationOptions = {}): Promise<boolean> {
	return await withVerifiedBoundary(filePath, boundary, "completion", () => true, options) ?? false;
}

/** Explicit failure aliases make call sites self-describing while using generic semantics. */
export const readVerifiedSessionFailureSuffix = readVerifiedSessionSuffix;
export const verifySessionFailureBoundary = verifySessionBoundary;
