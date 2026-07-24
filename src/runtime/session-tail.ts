import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { SingleResult } from "../core/types.js";
import type { SessionFileIdentity } from "./completion-v3.js";
import { processPiEvent } from "../core/runner-events.js";

/** The tail never retains an unbounded unterminated JSONL line. */
export const SESSION_TAIL_MAX_REMAINDER_BYTES = 64 * 1024;
/** File reads and index publications are deliberately capped. */
export const SESSION_TAIL_READ_CHUNK_BYTES = 64 * 1024;
/** Recent IDs are only an accelerator; the on-disk index is authoritative. */
export const SESSION_TAIL_RECENT_ID_LIMIT = 1_024;
const SESSION_TAIL_INDEX_BATCH_BYTES = 64 * 1024;
const SESSION_TAIL_INDEX_BLOOM_BYTES = 1024 * 1024;
let nextTailNamespace = 0;

interface FileIdentity {
	dev: number;
	ino: number;
}

interface SessionTailIndexEntry {
	generation: string;
	id: string;
	start: number;
	end: number;
	digest: string;
}

export interface SessionTailState {
	offset: number;
	remainder: Buffer;
	malformedLines: number;
	/** Bounded insertion-ordered cache for the current observed generation. */
	seenEntryIds: Set<string>;
	generation: number;
	indexNamespace: string;
	fileIdentity?: FileIdentity;
	discardingOverlongLine: boolean;
	indexPath?: string;
	pendingIndexEntries: SessionTailIndexEntry[];
	pendingIndexBytes: number;
	indexWriteDisabled: boolean;
	/** Alternate descriptor-bound index selected if the primary pathname is unusable. */
	fallbackIndexPath?: string;
	/** Fixed-size, exactness-neutral prefilter for disk index lookups. */
	indexBloom: Buffer;
	/** Private bucket directory already created and validated for this state. */
	indexBucketDirectory?: string;
	/** Once true, the primary/fallback index is authoritative and cannot be switched. */
	indexPublished: boolean;
}

export interface SessionTailDrainResult {
	state: SessionTailState;
	entriesRead: number;
	resultChanged: boolean;
}

export function createSessionTailState(): SessionTailState {
	return {
		offset: 0,
		remainder: Buffer.alloc(0),
		malformedLines: 0,
		seenEntryIds: new Set(),
		generation: 0,
		indexNamespace: `tail-${process.pid}-${nextTailNamespace++}`,
		discardingOverlongLine: false,
		pendingIndexEntries: [],
		pendingIndexBytes: 0,
		indexWriteDisabled: false,
		indexPublished: false,
		indexBloom: Buffer.alloc(SESSION_TAIL_INDEX_BLOOM_BYTES),
	};
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function identityFrom(stat: fs.Stats): FileIdentity {
	return { dev: stat.dev, ino: stat.ino };
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function openNoFollow(filePath: string, flags: number): Promise<{ handle: fs.promises.FileHandle; stat: fs.Stats }> {
	// A read-only open of a FIFO blocks before fstat can reject it. Unix must
	// provide O_NONBLOCK so this descriptor-bound validation stays nonblocking.
	if (!fs.constants.O_NOFOLLOW || (process.platform !== "win32" && !fs.constants.O_NONBLOCK)) {
		throw new Error("Safe nonblocking session-tail opens are unavailable on this platform.");
	}
	const handle = await fs.promises.open(filePath, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
	try {
		const descriptorStat = await handle.stat();
		const pathnameStat = await fs.promises.lstat(filePath);
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (!descriptorStat.isFile() || pathnameStat.isSymbolicLink() || (uid !== undefined && (descriptorStat.uid !== uid || pathnameStat.uid !== uid)) || !sameIdentity(identityFrom(descriptorStat), identityFrom(pathnameStat))) {
			throw new Error(`Session tail path changed while opening: ${filePath}`);
		}
		return { handle, stat: descriptorStat };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function assertPathStillMatches(filePath: string, descriptorStat: fs.Stats): Promise<void> {
	const pathnameStat = await fs.promises.lstat(filePath);
	if (pathnameStat.isSymbolicLink() || !sameIdentity(identityFrom(descriptorStat), identityFrom(pathnameStat))) {
		throw new Error(`Session tail path changed while reading: ${filePath}`);
	}
}

function indexGeneration(state: SessionTailState): string {
	return `${state.indexNamespace}:${state.generation}`;
}

function digest(buffer: Buffer): string {
	return crypto.createHash("sha256").update(buffer).digest("hex");
}

function bloomPositions(namespace: string, id: string): number[] {
	const hash = crypto.createHash("sha256").update(namespace).update("\0").update(id).digest();
	const bits = SESSION_TAIL_INDEX_BLOOM_BYTES * 8;
	return [hash.readUInt32BE(0) % bits, hash.readUInt32BE(4) % bits, hash.readUInt32BE(8) % bits];
}

function bloomMayContain(state: SessionTailState, id: string): boolean {
	return bloomPositions(state.indexNamespace, id).every((position) => (state.indexBloom[position >>> 3] & (1 << (position & 7))) !== 0);
}

function addToBloom(state: SessionTailState, id: string): void {
	for (const position of bloomPositions(state.indexNamespace, id)) state.indexBloom[position >>> 3] |= 1 << (position & 7);
}

function rememberRecentId(state: SessionTailState, id: string): void {
	state.seenEntryIds.delete(id);
	state.seenEntryIds.add(id);
}

function evictRecentIds(state: SessionTailState): void {
	while (state.seenEntryIds.size > SESSION_TAIL_RECENT_ID_LIMIT) {
		const oldest = state.seenEntryIds.values().next().value;
		if (oldest === undefined) return;
		state.seenEntryIds.delete(oldest);
	}
}

function parseIndexEntry(line: Buffer): SessionTailIndexEntry {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
	} catch {
		throw new Error("Session tail entry-ID index is malformed.");
	}
	if (!parsed || typeof parsed !== "object") throw new Error("Session tail entry-ID index is malformed.");
	const record = parsed as Record<string, unknown>;
	const start = record.start;
	const end = record.end;
	if (
		typeof record.generation !== "string" || typeof record.id !== "string" ||
		typeof start !== "number" || typeof end !== "number" ||
		!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
		typeof record.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.digest) ||
		start < 0 || end < start
	) throw new Error("Session tail entry-ID index is malformed.");
	return { generation: record.generation, id: record.id, start, end, digest: record.digest };
}

function indexBucketPath(indexPath: string, id: string): string {
	return path.join(indexPath, `${crypto.createHash("sha256").update(id).digest("hex").slice(0, 3)}.jsonl`);
}

async function openPrivateIndexDirectory(indexPath: string, create: boolean): Promise<void> {
	if (create) await fs.promises.mkdir(indexPath, { mode: 0o700, recursive: false }).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "EEXIST") throw error;
	});
	const handle = await fs.promises.open(indexPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
	try {
		const descriptorStat = await handle.stat();
		const pathnameStat = await fs.promises.lstat(indexPath);
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if (!descriptorStat.isDirectory() || pathnameStat.isSymbolicLink() || (uid !== undefined && descriptorStat.uid !== uid) || (descriptorStat.mode & 0o777) !== 0o700 || !sameIdentity(identityFrom(descriptorStat), identityFrom(pathnameStat))) {
			throw new Error("Session tail entry-ID index directory is not run-private.");
		}
	} finally {
		await handle.close();
	}
}

async function prepareIndexDirectory(state: SessionTailState, indexPath: string): Promise<void> {
	await openPrivateIndexDirectory(indexPath, state.indexBucketDirectory !== indexPath);
	if (state.indexBucketDirectory === indexPath) return;
	await openPrivateIndexDirectory(indexPath, false);
	state.indexBucketDirectory = indexPath;
}

async function scanIndex(indexPath: string, namespace: string, id: string): Promise<boolean> {
	await openPrivateIndexDirectory(indexPath, false);
	const bucketPath = indexBucketPath(indexPath, id);
	let opened: { handle: fs.promises.FileHandle; stat: fs.Stats };
	try {
		opened = await openNoFollow(bucketPath, fs.constants.O_RDONLY);
	} catch (error) {
		if (isMissing(error)) throw new Error("Session tail entry-ID index bucket disappeared.");
		throw error;
	}
	const { handle, stat } = opened;
	try {
		const chunk = Buffer.alloc(SESSION_TAIL_READ_CHUNK_BYTES);
		let position = 0;
		let remainder = Buffer.alloc(0);
		while (position < stat.size) {
			const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
			if (bytesRead === 0) throw new Error("Session tail entry-ID index changed while reading.");
			position += bytesRead;
			const combined = remainder.length ? Buffer.concat([remainder, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
			let start = 0;
			for (let index = 0; index < combined.length; index += 1) {
				if (combined[index] !== 0x0a) continue;
				const entry = parseIndexEntry(combined.subarray(start, index));
				if (entry.generation.startsWith(`${namespace}:`) && entry.id === id) {
					await assertPathStillMatches(bucketPath, stat);
					await openPrivateIndexDirectory(indexPath, false);
					return true;
				}
				start = index + 1;
			}
			remainder = Buffer.from(combined.subarray(start));
			if (remainder.length > SESSION_TAIL_MAX_REMAINDER_BYTES) throw new Error("Session tail entry-ID index record exceeds the bound.");
		}
		if (remainder.length > 0) throw new Error("Session tail entry-ID index is incomplete.");
		await assertPathStillMatches(bucketPath, stat);
		await openPrivateIndexDirectory(indexPath, false);
		return false;
	} finally {
		await handle.close();
	}
}

function publicationStarted(error: unknown): boolean {
	return Boolean((error as { sessionTailPublicationStarted?: unknown } | undefined)?.sessionTailPublicationStarted);
}

async function appendIndexEntries(indexPath: string, entries: readonly SessionTailIndexEntry[]): Promise<void> {
	if (entries.length === 0) return;
	const bucketPath = indexBucketPath(indexPath, entries[0].id);
	if (entries.some((entry) => indexBucketPath(indexPath, entry.id) !== bucketPath)) throw new Error("Session tail entry-ID index batch crosses buckets.");
	const encoded = Buffer.from(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf-8");
	if (encoded.length > SESSION_TAIL_INDEX_BATCH_BYTES) throw new Error("Session tail entry-ID index batch exceeds the bound.");
	let started = false;
	try {
		let opened: { handle: fs.promises.FileHandle; stat: fs.Stats };
		try {
			opened = await openNoFollow(bucketPath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
		} catch (error) {
			if (!isMissing(error)) throw error;
			const handle = await fs.promises.open(bucketPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
			opened = { handle, stat: await handle.stat() };
		}
		const { handle, stat } = opened;
		const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
		if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600) { await handle.close(); throw new Error("Session tail entry-ID index bucket is not private."); }
		try {
			const start = stat.size;
			let written = 0;
			while (written < encoded.length) {
				const result = await handle.write(encoded, written, encoded.length - written, start + written);
				if (result.bytesWritten === 0) throw new Error("Could not publish session tail entry-ID index.");
				started = true;
				written += result.bytesWritten;
			}
			await handle.sync();
			await assertPathStillMatches(bucketPath, stat);
		} finally {
			await handle.close();
		}
		const readBack = await openNoFollow(bucketPath, fs.constants.O_RDONLY);
		try {
			const buffer = Buffer.alloc(encoded.length);
			let bytesRead = 0;
			while (bytesRead < buffer.length) {
				const result = await readBack.handle.read(buffer, bytesRead, buffer.length - bytesRead, stat.size + bytesRead);
				if (result.bytesRead === 0) throw new Error("Could not read back session tail entry-ID index.");
				bytesRead += result.bytesRead;
			}
			if (!buffer.equals(encoded)) throw new Error("Session tail entry-ID index read-back mismatch.");
			await assertPathStillMatches(bucketPath, readBack.stat);
		} finally {
			await readBack.handle.close();
		}
	} catch (error) {
		if (started && error && typeof error === "object") (error as { sessionTailPublicationStarted?: boolean }).sessionTailPublicationStarted = true;
		throw error;
	}
}

async function publishPendingIndex(indexPath: string, pending: readonly SessionTailIndexEntry[]): Promise<void> {
	const buckets = new Map<string, SessionTailIndexEntry[]>();
	for (const entry of pending) {
		const bucketPath = indexBucketPath(indexPath, entry.id);
		const entries = buckets.get(bucketPath) ?? [];
		entries.push(entry);
		buckets.set(bucketPath, entries);
	}
	for (const entries of buckets.values()) {
		if (Buffer.byteLength(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""), "utf-8") > SESSION_TAIL_INDEX_BATCH_BYTES) throw new Error("Session tail entry-ID index batch exceeds the bound.");
	}
	let started = false;
	try {
		for (const entries of buckets.values()) {
			await appendIndexEntries(indexPath, entries);
			started = true;
		}
	} catch (error) {
		if (started && error && typeof error === "object") (error as { sessionTailPublicationStarted?: boolean }).sessionTailPublicationStarted = true;
		throw error;
	}
}

async function flushPendingIndex(state: SessionTailState): Promise<void> {
	if (state.pendingIndexEntries.length === 0) return;
	if (state.indexWriteDisabled || !state.indexPath) throw new Error("Session tail exact entry-ID index is unavailable.");
	const pending = state.pendingIndexEntries;
	try {
		await prepareIndexDirectory(state, state.indexPath);
		await publishPendingIndex(state.indexPath, pending);
	} catch (error) {
		if (state.indexPublished || publicationStarted(error)) {
			state.indexWriteDisabled = true;
			throw new Error("Session tail exact entry-ID index publication failed.");
		}
		const fallbackPath = state.fallbackIndexPath ?? `${state.indexPath}.fallback`;
		try {
			await prepareIndexDirectory(state, fallbackPath);
			await publishPendingIndex(fallbackPath, pending);
			state.fallbackIndexPath = fallbackPath;
			state.indexPath = fallbackPath;
		} catch {
			state.indexWriteDisabled = true;
			throw new Error("Session tail exact entry-ID index publication failed.");
		}
	}
	state.pendingIndexEntries = [];
	state.pendingIndexBytes = 0;
	state.indexPublished = true;
	for (const entry of pending) addToBloom(state, entry.id);
}

async function registerEntryIdentity(state: SessionTailState, id: string, line: Buffer, start: number, end: number, indexPath: string): Promise<boolean> {
	state.indexPath ??= indexPath;
	if (state.indexWriteDisabled) throw new Error("Session tail exact entry-ID index is unavailable.");
	const generation = indexGeneration(state);
	if (state.seenEntryIds.has(id)) {
		rememberRecentId(state, id);
		return true;
	}
	if (bloomMayContain(state, id) && await scanIndex(state.indexPath, state.indexNamespace, id)) return true;

	const entry: SessionTailIndexEntry = { generation, id, start, end, digest: digest(line) };
	const encodedBytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf-8");
	if (encodedBytes > SESSION_TAIL_INDEX_BATCH_BYTES) throw new Error("Session tail entry-ID index record exceeds the bound.");
	if (state.pendingIndexBytes + encodedBytes > SESSION_TAIL_INDEX_BATCH_BYTES) await flushPendingIndex(state);
	state.pendingIndexEntries.push(entry);
	state.pendingIndexBytes += encodedBytes;
	rememberRecentId(state, id);
	if (state.seenEntryIds.size > SESSION_TAIL_RECENT_ID_LIMIT) {
		await flushPendingIndex(state);
		evictRecentIds(state);
	}
	return false;
}

async function processSessionLine(
	lineBuffer: Buffer,
	lineStart: number,
	lineEnd: number,
	result: SingleResult,
	state: SessionTailState,
	indexPath: string,
	onEntry?: (entry: unknown) => void,
): Promise<{ parsed: boolean; changed: boolean }> {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(lineBuffer).replace(/\r$/, "");
	} catch {
		throw new Error("Session JSONL contains malformed UTF-8.");
	}
	if (!text.trim()) return { parsed: true, changed: false };
	let entry: unknown;
	try {
		entry = JSON.parse(text);
	} catch {
		return { parsed: false, changed: false };
	}
	onEntry?.(entry);
	if (!entry || typeof entry !== "object") return { parsed: true, changed: false };
	const record = entry as Record<string, unknown>;
	const entryId = typeof record.id === "string" && /^[^\u0000-\u001f\u007f]{1,512}$/.test(record.id) ? record.id : undefined;

	if (record.type === "compaction" || record.type === "branch_summary") {
		// Compaction retainedTail replays prior context and must never be counted.
		// Only the persisted summary-generation usage on this entry belongs to
		// the child total, under the same exact entry-ID de-duplication as messages.
		const duplicate = entryId ? await registerEntryIdentity(state, entryId, lineBuffer, lineStart, lineEnd, indexPath) : false;
		if (!duplicate) {
			processPiEvent(
				record.type === "compaction"
					? { type: "session_compact", compactionEntry: record }
					: { type: "session_tree", summaryEntry: record },
				result,
			);
		}
		return { parsed: true, changed: false };
	}

	if (record.type !== "message" || !record.message || typeof record.message !== "object") return { parsed: true, changed: false };
	const message = record.message as Record<string, unknown>;
	// Session tails retain only assistant messages publicly, but tool-result
	// usage is still accounted after the same entry-ID de-duplication.
	if (message.role !== "assistant" && message.role !== "toolResult") return { parsed: true, changed: false };
	const duplicate = entryId ? await registerEntryIdentity(state, entryId, lineBuffer, lineStart, lineEnd, indexPath) : false;
	if (duplicate) return { parsed: true, changed: false };
	return {
		parsed: true,
		changed: processPiEvent(
			{ type: "message_end", message },
			result,
			{
				trackAssistantSignatures: false,
				// The persisted SessionEntry ID, scoped to this tail, is the
				// authoritative accounting identity. toolCallId only pairs one
				// lifecycle copy with one persisted execution.
				toolResultIdentity: entryId ? `session-entry:${state.indexNamespace}:${entryId}` : undefined,
			},
		),
	};
}

export async function drainSessionJsonl(options: {
	filePath: string;
	state: SessionTailState;
	result: SingleResult;
	final?: boolean;
	/** Parent-captured identity required for ordinary pathname-based live reads. */
	expectedIdentity?: SessionFileIdentity;
	/** Read no bytes at or beyond an already-verified completion boundary. */
	maxOffset?: number;
	/** Descriptor-bound verified bytes for [state.offset, maxOffset); bypasses pathname re-open. */
	verifiedBytes?: Buffer;
	/**
	 * Maximum bytes in one complete JSONL entry. This higher replay-only budget
	 * is accepted solely for descriptor-verified bytes; pathname live tails keep
	 * the 64 KiB bound.
	 */
	maxCompleteEntryBytes?: number;
	/** Defaults to a private sibling of the child session file. */
	indexPath?: string;
	onEntry?: (entry: unknown) => void;
}): Promise<SessionTailDrainResult> {
	let state = options.state;
	if (options.maxOffset !== undefined && (!Number.isSafeInteger(options.maxOffset) || options.maxOffset < 0)) {
		throw new Error("Invalid session tail completion boundary.");
	}
	if (options.maxCompleteEntryBytes !== undefined && (!options.verifiedBytes
		|| !Number.isSafeInteger(options.maxCompleteEntryBytes) || options.maxCompleteEntryBytes < 1)) {
		throw new Error("Invalid verified session entry bound.");
	}
	const maxCompleteEntryBytes = options.maxCompleteEntryBytes ?? SESSION_TAIL_MAX_REMAINDER_BYTES;

	let descriptor: { handle: fs.promises.FileHandle; stat: fs.Stats } | undefined;
	let stat: fs.Stats;
	try {
		if (options.verifiedBytes && options.maxOffset !== undefined) {
			stat = { size: options.maxOffset } as fs.Stats;
		} else {
			descriptor = await openNoFollow(options.filePath, fs.constants.O_RDONLY);
			stat = descriptor.stat;
		}
	} catch (error) {
		if (isMissing(error)) return { state, entriesRead: 0, resultChanged: false };
		throw error;
	}

	try {
		const identity = descriptor ? identityFrom(stat) : state.fileIdentity;
		// Completion replay supplies descriptor-bound verified bytes, so it does
		// not re-open a pathname or need this live-tail binding. Ordinary drains
		// must remain on the parent-captured child-session generation.
		const identityMismatch = Boolean(descriptor && options.expectedIdentity
			&& (BigInt(stat.dev) !== options.expectedIdentity.dev || BigInt(stat.ino) !== options.expectedIdentity.ino));
		if (identityMismatch) throw new Error("Session tail identity does not match the parent-captured session.");
		const replaced = Boolean(identity && state.fileIdentity && !sameIdentity(identity, state.fileIdentity));
		if (replaced || stat.size < state.offset) {
			if (options.expectedIdentity) throw new Error(replaced
				? "Session tail was replaced during an identity-bound live drain."
				: "Session tail was truncated during an identity-bound live drain.");
			state = {
				...state,
				offset: 0,
				remainder: Buffer.alloc(0),
				malformedLines: 0,
				generation: state.generation + 1,
				fileIdentity: identity,
				discardingOverlongLine: false,
				indexPath: state.indexPath ?? options.indexPath,
			};
		}
		if (options.maxOffset !== undefined && options.maxOffset < state.offset) throw new Error("Invalid session tail completion boundary.");
		const effectiveSize = options.maxOffset === undefined ? stat.size : Math.min(stat.size, options.maxOffset);
		const bytesToRead = effectiveSize - state.offset;
		if (options.verifiedBytes && (options.maxOffset === undefined || options.verifiedBytes.length !== bytesToRead)) {
			throw new Error("Invalid verified session bytes.");
		}

		const indexPath = state.indexPath ?? options.indexPath ?? `${options.filePath}.entry-index`;
		state.indexPath = indexPath;
		let remainder: Buffer<ArrayBufferLike> = Buffer.from(state.remainder);
		let remainderStart = state.offset - remainder.length;
		let discardingOverlongLine = state.discardingOverlongLine;
		let entriesRead = 0;
		let resultChanged = false;
		let malformedLines = state.malformedLines;

		const consume = async (incoming: Buffer, incomingStart: number): Promise<void> => {
			let combined: Buffer;
			let combinedStart: number;
			if (remainder.length > 0) {
				combined = Buffer.concat([remainder, incoming]);
				combinedStart = remainderStart;
			} else {
				combined = incoming;
				combinedStart = incomingStart;
			}
			let start = 0;
			if (discardingOverlongLine) {
				const newline = combined.indexOf(0x0a);
				if (newline === -1) {
					remainder = Buffer.alloc(0);
					remainderStart = incomingStart + incoming.length;
					return;
				}
				malformedLines += 1;
				start = newline + 1;
				discardingOverlongLine = false;
			}
			for (let index = start; index < combined.length; index += 1) {
				if (combined[index] !== 0x0a) continue;
				if (index - start > maxCompleteEntryBytes) {
					malformedLines += 1;
					start = index + 1;
					continue;
				}
				const processed = await processSessionLine(combined.subarray(start, index), combinedStart + start, combinedStart + index + 1, options.result, state, indexPath, options.onEntry);
				if (processed.parsed) entriesRead += 1;
				else malformedLines += 1;
				if (processed.changed) resultChanged = true;
				start = index + 1;
			}
			remainder = Buffer.from(combined.subarray(start));
			remainderStart = combinedStart + start;
			if (remainder.length > maxCompleteEntryBytes) {
				remainder = Buffer.alloc(0);
				discardingOverlongLine = true;
			}
		};

		// Completion replay already owns a bounded descriptor-verified buffer. Scan
		// it directly so an entry that spans many live-tail chunk sizes is never
		// repeatedly copied into an accumulated remainder.
		const consumeVerified = async (incoming: Buffer, incomingStart: number): Promise<void> => {
			let start = 0;
			if (discardingOverlongLine) {
				const newline = incoming.indexOf(0x0a);
				if (newline === -1) {
					remainder = Buffer.alloc(0);
					remainderStart = incomingStart + incoming.length;
					return;
				}
				malformedLines += 1;
				start = newline + 1;
				discardingOverlongLine = false;
			}

			// Only a line split before the verified range needs materialization, and
			// then only once when its newline arrives.
			if (remainder.length > 0) {
				const newline = incoming.indexOf(0x0a, start);
				if (newline === -1) {
					if (remainder.length + incoming.length - start > maxCompleteEntryBytes) {
						remainder = Buffer.alloc(0);
						remainderStart = incomingStart + incoming.length;
						discardingOverlongLine = true;
					} else {
						remainder = Buffer.concat([remainder, incoming.subarray(start)]);
					}
					return;
				}
				if (remainder.length + newline - start > maxCompleteEntryBytes) {
					malformedLines += 1;
				} else {
					const line = Buffer.concat([remainder, incoming.subarray(start, newline)]);
					const processed = await processSessionLine(line, remainderStart, incomingStart + newline + 1, options.result, state, indexPath, options.onEntry);
					if (processed.parsed) entriesRead += 1;
					else malformedLines += 1;
					if (processed.changed) resultChanged = true;
				}
				remainder = Buffer.alloc(0);
				start = newline + 1;
			}

			while (start < incoming.length) {
				const newline = incoming.indexOf(0x0a, start);
				if (newline === -1) {
					const trailing = incoming.subarray(start);
					if (trailing.length > maxCompleteEntryBytes) {
						remainder = Buffer.alloc(0);
						discardingOverlongLine = true;
					} else {
						remainder = trailing;
					}
					remainderStart = incomingStart + start;
					return;
				}
				if (newline - start > maxCompleteEntryBytes) {
					malformedLines += 1;
				} else {
					const processed = await processSessionLine(incoming.subarray(start, newline), incomingStart + start, incomingStart + newline + 1, options.result, state, indexPath, options.onEntry);
					if (processed.parsed) entriesRead += 1;
					else malformedLines += 1;
					if (processed.changed) resultChanged = true;
				}
				start = newline + 1;
			}
			remainder = Buffer.alloc(0);
			remainderStart = incomingStart + incoming.length;
		};

		if (options.verifiedBytes) {
			await consumeVerified(options.verifiedBytes, state.offset);
		} else if (descriptor && bytesToRead > 0) {
			const chunk = Buffer.alloc(SESSION_TAIL_READ_CHUNK_BYTES);
			let position = 0;
			while (position < bytesToRead) {
				const { bytesRead } = await descriptor.handle.read(chunk, 0, Math.min(chunk.length, bytesToRead - position), state.offset + position);
				if (bytesRead === 0) break;
				await consume(chunk.subarray(0, bytesRead), state.offset + position);
				position += bytesRead;
			}
			if (position !== bytesToRead) throw new Error("Session JSONL changed while reading.");
		}

		// Completion bytes were verified from an exact descriptor-bound boundary.
		// Do not turn a malformed, discarded, or unterminated record into a
		// terminal result: the caller must retain recovery authority instead.
		if (options.final && options.verifiedBytes && (malformedLines > 0 || discardingOverlongLine || remainder.length > 0)) {
			throw new Error("Verified session replay contains malformed or incomplete entries.");
		}
		if (options.final && discardingOverlongLine) {
			malformedLines += 1;
			discardingOverlongLine = false;
		}
		if (options.final && remainder.length > 0) {
			const processed = await processSessionLine(remainder, remainderStart, effectiveSize, options.result, state, indexPath, options.onEntry);
			if (processed.parsed) entriesRead += 1;
			else malformedLines += 1;
			if (processed.changed) resultChanged = true;
			remainder = Buffer.alloc(0);
		}
		// A descriptor can keep yielding the old inode after an atomic pathname
		// replacement. Do not publish those bytes as a live-generation result.
		if (descriptor) await assertPathStillMatches(options.filePath, descriptor.stat);
		await flushPendingIndex(state);
		evictRecentIds(state);

		return {
			state: {
				...state,
				offset: effectiveSize,
				remainder,
				malformedLines,
				discardingOverlongLine,
				fileIdentity: identity,
			},
			entriesRead,
			resultChanged,
		};
	} finally {
		if (descriptor) await descriptor.handle.close();
	}
}
