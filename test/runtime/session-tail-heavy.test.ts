import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionTailState, drainSessionJsonl, SESSION_TAIL_RECENT_ID_LIMIT } from "../../src/runtime/session-tail";
import { emptyUsage } from "../../src/core/types";

const tempDirs: string[] = [];
afterEach(async () => {
	while (tempDirs.length > 0) await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
});

function makeResult() {
	return { agent: "scout", agentSource: "user" as const, task: "tail heavy test", exitCode: -1, messages: [], stderr: "", usage: emptyUsage() };
}

function assistantEntry(id: string, text: string) {
	return {
		type: "message", id, parentId: null, timestamp: new Date(0).toISOString(),
		message: { role: "assistant", content: [{ type: "text", text }], model: "provider/model", stopReason: "stop", usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: { total: 0.01 } } },
	};
}

function logPhase(phase: string, startedAt: number, count: number, sessionBytes: number, bucketCount?: number): void {
	console.info(JSON.stringify({ workload: "session-tail-heavy", phase, durationMs: Math.round(performance.now() - startedAt), count, sessionBytes, ...(bucketCount === undefined ? {} : { bucketCount }) }));
}

describe("session JSONL tail heavy workload", () => {
	test("replays 4 recent-cache windows of old IDs in reverse without growing messages or auxiliary state", { timeout: 240_000 }, async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const count = 4 * SESSION_TAIL_RECENT_ID_LIMIT;
		const lines: string[] = [];
		for (let index = 0; index < count; index += 1) lines.push(`${JSON.stringify(assistantEntry(`metric-${index}`, "x"))}\n`);
		const initialSession = lines.join("");
		const initialSessionBytes = Buffer.byteLength(initialSession);
		await fs.promises.writeFile(filePath, initialSession);
		const result = makeResult();
		const initialStartedAt = performance.now();
		let drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		const indexPath = drained.state.indexPath;
		const bucketCount = indexPath ? (await fs.promises.readdir(indexPath)).length : undefined;
		logPhase("initial-drain", initialStartedAt, count, initialSessionBytes, bucketCount);
		assert.equal(result.messages.length, count);
		assert.equal(drained.state.seenEntryIds.size, SESSION_TAIL_RECENT_ID_LIMIT);
		assert.equal(drained.state.seenEntryIds.has("metric-0"), false, "the first drain must evict old IDs from the recent cache");
		assert.equal(drained.state.seenEntryIds.has(`metric-${count - 1}`), true);
		assert.ok(indexPath && (await fs.promises.stat(indexPath)).isDirectory());
		assert.ok(bucketCount && bucketCount <= 4096);
		const usageAfterInitialDrain = structuredClone(result.usage);
		await fs.promises.appendFile(filePath, lines.reverse().join(""));
		const reverseStartedAt = performance.now();
		drained = await drainSessionJsonl({ filePath, state: drained.state, result: result as any });
		logPhase("reverse-drain", reverseStartedAt, count, initialSessionBytes * 2, bucketCount);
		assert.equal(drained.resultChanged, false);
		assert.equal(result.messages.length, count);
		assert.deepEqual(result.usage, usageAfterInitialDrain);
		assert.ok(drained.state.seenEntryIds.size <= SESSION_TAIL_RECENT_ID_LIMIT);
		assert.equal(drained.state.remainder.length, 0);
		assert.equal(drained.state.pendingIndexEntries.length, 0);
		assert.equal(drained.state.indexWriteDisabled, false);
		assert.equal(drained.state.fallbackIndexPath, undefined);
		assert.equal(drained.state.indexPath, indexPath, "reverse replay must retain the exact published disk index path");
		assert.ok(drained.state.indexPath && (await fs.promises.stat(drained.state.indexPath)).isDirectory());
		assert.ok(drained.state.indexBloom.length > 0 && drained.state.indexBloom.length <= 1024 * 1024);
		assert.equal((result as any).__processedAssistantSignatures, undefined);
	});
});
