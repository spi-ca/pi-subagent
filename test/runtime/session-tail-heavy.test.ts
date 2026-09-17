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

describe("session JSONL tail heavy workload", () => {
	test("replays 100,000 old IDs in reverse without growing messages or auxiliary state", { timeout: 240_000 }, async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const count = 100_000;
		const lines: string[] = [];
		for (let index = 0; index < count; index += 1) lines.push(`${JSON.stringify(assistantEntry(`metric-${index}`, "x"))}\n`);
		await fs.promises.writeFile(filePath, lines.join(""));
		const result = makeResult();
		let drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		assert.equal(result.messages.length, count);
		await fs.promises.appendFile(filePath, lines.reverse().join(""));
		drained = await drainSessionJsonl({ filePath, state: drained.state, result: result as any });
		assert.equal(result.messages.length, count);
		assert.ok(drained.state.seenEntryIds.size <= SESSION_TAIL_RECENT_ID_LIMIT);
		assert.equal(drained.state.remainder.length, 0);
		assert.equal(drained.state.pendingIndexEntries.length, 0);
		assert.equal(drained.state.indexWriteDisabled, false);
		assert.equal(drained.state.fallbackIndexPath, undefined);
		assert.ok(drained.state.indexPath && (await fs.promises.stat(drained.state.indexPath)).isDirectory());
		assert.ok(drained.state.indexBloom.length > 0 && drained.state.indexBloom.length <= 1024 * 1024);
		assert.equal((result as any).__processedAssistantSignatures, undefined);
	});
});
