import * as fs from "node:fs";
import type { SingleResult } from "../core/types.js";
import { processPiEvent } from "../core/runner-events.js";

export interface SessionTailState {
	offset: number;
	remainder: Buffer;
	malformedLines: number;
	seenEntryIds: Set<string>;
}

export interface SessionTailDrainResult {
	state: SessionTailState;
	entriesRead: number;
	resultChanged: boolean;
}

export function createSessionTailState(): SessionTailState {
	return { offset: 0, remainder: Buffer.alloc(0), malformedLines: 0, seenEntryIds: new Set() };
}

function processSessionLine(
	lineBuffer: Buffer,
	result: SingleResult,
	seenEntryIds: Set<string>,
	onEntry?: (entry: unknown) => void,
): { parsed: boolean; changed: boolean } {
	const text = lineBuffer.toString("utf-8").replace(/\r$/, "");
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
	const entryId = typeof record.id === "string" ? record.id : undefined;
	if (entryId && seenEntryIds.has(entryId)) return { parsed: true, changed: false };
	if (entryId) seenEntryIds.add(entryId);
	if (record.type !== "message" || !record.message || typeof record.message !== "object") {
		return { parsed: true, changed: false };
	}
	const message = record.message as Record<string, unknown>;
	if (message.role !== "assistant") return { parsed: true, changed: false };
	return {
		parsed: true,
		changed: processPiEvent({ type: "message_end", message }, result),
	};
}

export async function drainSessionJsonl(options: {
	filePath: string;
	state: SessionTailState;
	result: SingleResult;
	final?: boolean;
	onEntry?: (entry: unknown) => void;
}): Promise<SessionTailDrainResult> {
	let state = options.state;
	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(options.filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { state, entriesRead: 0, resultChanged: false };
		}
		throw error;
	}

	if (stat.size < state.offset) {
		state = { ...createSessionTailState(), seenEntryIds: state.seenEntryIds };
	}
	const bytesToRead = stat.size - state.offset;
	let incoming = Buffer.alloc(0);
	if (bytesToRead > 0) {
		const handle = await fs.promises.open(options.filePath, "r");
		try {
			incoming = Buffer.alloc(bytesToRead);
			let bytesRead = 0;
			while (bytesRead < bytesToRead) {
				const read = await handle.read(incoming, bytesRead, bytesToRead - bytesRead, state.offset + bytesRead);
				if (read.bytesRead === 0) break;
				bytesRead += read.bytesRead;
			}
			incoming = incoming.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	}

	const combined = state.remainder.length > 0 ? Buffer.concat([state.remainder, incoming]) : incoming;
	let start = 0;
	let entriesRead = 0;
	let resultChanged = false;
	let malformedLines = state.malformedLines;
	for (let index = 0; index < combined.length; index += 1) {
		if (combined[index] !== 0x0a) continue;
		const processed = processSessionLine(combined.subarray(start, index), options.result, state.seenEntryIds, options.onEntry);
		if (processed.parsed) entriesRead += 1;
		else malformedLines += 1;
		if (processed.changed) resultChanged = true;
		start = index + 1;
	}

	let remainder = combined.subarray(start);
	if (options.final && remainder.length > 0) {
		const processed = processSessionLine(remainder, options.result, state.seenEntryIds, options.onEntry);
		if (processed.parsed) entriesRead += 1;
		else malformedLines += 1;
		if (processed.changed) resultChanged = true;
		remainder = Buffer.alloc(0);
	}

	return {
		state: {
			offset: state.offset + incoming.length,
			remainder: Buffer.from(remainder),
			malformedLines,
			seenEntryIds: state.seenEntryIds,
		},
		entriesRead,
		resultChanged,
	};
}
