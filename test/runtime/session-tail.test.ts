import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
	createSessionTailState,
	drainSessionJsonl,
	SESSION_TAIL_MAX_REMAINDER_BYTES,
	SESSION_TAIL_RECENT_ID_LIMIT,
} from "../../src/runtime/session-tail";
import { emptyUsage, getFinalOutput } from "../../src/core/types";
import { processPiEvent } from "../../src/core/runner-events";
import { getSessionFileIdentity, MAX_COMPLETION_SESSION_ENTRY_BYTES } from "../../src/runtime/completion-v3";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
	}
});

function makeResult() {
	return {
		agent: "scout",
		agentSource: "user" as const,
		task: "tail test",
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
	};
}

function toolResultEntry(id: string, toolCallId: string, input: number) {
	return {
		type: "message", id, parentId: null, timestamp: new Date(0).toISOString(),
		message: {
			role: "toolResult", toolCallId, toolName: "tool", content: [], isError: false,
			usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		},
	};
}

function assistantEntry(id: string, text: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "provider/model",
			stopReason: "stop",
			usage: {
				input: 3,
				output: 2,
				cacheRead: 1,
				cacheWrite: 0,
				totalTokens: 6,
				cost: { total: 0.01 },
			},
		},
	};
}

describe("session JSONL tail", () => {
	test("reads append-only assistant entries once and aggregates usage", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		await fs.promises.writeFile(filePath, `${JSON.stringify({ type: "session", version: 3, id: "s" })}\n`);
		const result = makeResult();
		let state = createSessionTailState();

		let drained = await drainSessionJsonl({ filePath, state, result: result as any });
		state = drained.state;
		assert.equal(result.messages.length, 0);

		await fs.promises.appendFile(filePath, `${JSON.stringify(assistantEntry("m1", "DONE"))}\n`);
		drained = await drainSessionJsonl({ filePath, state, result: result as any });
		state = drained.state;
		assert.equal(drained.resultChanged, true);
		assert.equal(getFinalOutput(result.messages as any), "DONE");
		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 3);

		drained = await drainSessionJsonl({ filePath, state, result: result as any });
		assert.equal(drained.resultChanged, false);
		assert.equal(result.messages.length, 1);
	});

	test("accounts session tool results once by entry ID without exposing them publicly", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const tool = toolResultEntry("tool-entry", "nested-call", 9);
		await fs.promises.writeFile(filePath, `${JSON.stringify(tool)}\n${JSON.stringify(tool)}\n`);
		const result = makeResult();
		const drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		assert.equal(drained.resultChanged, false);
		assert.equal(result.messages.length, 0);
		assert.equal((result as any).accountingUsage.totalTokens, 9);
	});

	test("pairs each persisted tool entry with one reused-ID lifecycle occurrence", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const first = toolResultEntry("tool-entry-1", "reused-call", 4);
		const secondUsage = toolResultEntry("unused", "reused-call", 7).message.usage;
		await fs.promises.writeFile(filePath, `${JSON.stringify(first)}\n${JSON.stringify(first)}\n`);
		const result = makeResult();
		processPiEvent({ type: "tool_execution_end", toolCallId: "reused-call", result: { usage: first.message.usage } }, result as any);
		processPiEvent({ type: "tool_execution_end", toolCallId: "reused-call", result: { usage: secondUsage } }, result as any);
		await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		assert.equal((result as any).accountingUsage.totalTokens, 11);
	});

	test("accounts persisted summary usage once by entry ID without retained-tail replay", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const usage = { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, total: 5 } };
		const compaction = {
			type: "compaction", id: "compact-entry", parentId: null, timestamp: new Date(0).toISOString(),
			summary: "compact", tokensBefore: 9, usage,
			retainedTail: [{ ...assistantEntry("retained", "already accounted").message, usage: { ...usage, input: 50, totalTokens: 51, cost: { ...usage.cost, input: 50, total: 51 } } }],
		};
		const branchSummary = {
			type: "branch_summary", id: "branch-entry", parentId: "compact-entry", timestamp: new Date(0).toISOString(),
			fromId: "root", summary: "branch", usage,
		};
		await fs.promises.writeFile(filePath, `${JSON.stringify(compaction)}\n${JSON.stringify(branchSummary)}\n${JSON.stringify(compaction)}\n`);
		const result = makeResult();
		let drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		assert.equal(drained.resultChanged, false);
		assert.deepEqual(result.messages, []);
		assert.equal((result as any).accountingUsage.totalTokens, 10);

		await fs.promises.appendFile(filePath, `${JSON.stringify(branchSummary)}\n`);
		drained = await drainSessionJsonl({ filePath, state: drained.state, result: result as any });
		assert.equal(drained.resultChanged, false);
		assert.equal((result as any).accountingUsage.totalTokens, 10);
	});

	test("preserves UTF-8 bytes and partial lines across drains", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const line = Buffer.from(`${JSON.stringify(assistantEntry("m-utf8", "완료 ✅"))}\n`, "utf-8");
		const split = line.indexOf(Buffer.from("완", "utf-8")) + 1;
		await fs.promises.writeFile(filePath, line.subarray(0, split));
		const result = makeResult();
		let drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		assert.equal(result.messages.length, 0);

		await fs.promises.appendFile(filePath, line.subarray(split));
		drained = await drainSessionJsonl({ filePath, state: drained.state, result: result as any });
		assert.equal(getFinalOutput(result.messages as any), "완료 ✅");
		assert.equal(drained.state.remainder.length, 0);
	});

	test("handles truncation without duplicating entry ids", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const firstLine = `${JSON.stringify(assistantEntry("same", "first"))}\n`;
		await fs.promises.writeFile(filePath, `${firstLine}${" ".repeat(100)}`);
		const result = makeResult();
		let drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		assert.equal(result.messages.length, 1);

		await fs.promises.writeFile(filePath, firstLine);
		drained = await drainSessionJsonl({ filePath, state: drained.state, result: result as any });
		assert.equal(result.messages.length, 1);
		assert.equal(drained.state.offset, Buffer.byteLength(firstLine));
	});

	test("rejects a FIFO before it can block a live tail and remains usable", async () => {
		if (process.platform === "win32") return;
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const fifoPath = path.join(dir, "session.fifo");
		assert.equal(spawnSync("/usr/bin/mkfifo", [fifoPath]).status, 0);
		await fs.promises.chmod(fifoPath, 0o600);
		const startedAt = performance.now();
		await assert.rejects(() => drainSessionJsonl({ filePath: fifoPath, state: createSessionTailState(), result: makeResult() as any }));
		assert.ok(performance.now() - startedAt < 150, "a FIFO must be rejected before its absent writer blocks the tail worker");

		const regularPath = path.join(dir, "session.jsonl");
		await fs.promises.writeFile(regularPath, `${JSON.stringify(assistantEntry("after-fifo", "drained"))}\n`);
		const result = makeResult();
		const drained = await drainSessionJsonl({ filePath: regularPath, state: createSessionTailState(), result: result as any });
		assert.equal(drained.resultChanged, true);
		assert.equal(getFinalOutput(result.messages as any), "drained");
	});

	test("fails closed for identity-bound live tail replacement and truncation", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const replacementPath = path.join(dir, "replacement.jsonl");
		const firstLine = `${JSON.stringify(assistantEntry("first", "first"))}\n`;
		await fs.promises.writeFile(filePath, firstLine);
		const expectedIdentity = await getSessionFileIdentity(filePath);
		assert.ok(expectedIdentity);
		const result = makeResult();
		const drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any, expectedIdentity });

		await fs.promises.writeFile(replacementPath, `${JSON.stringify(assistantEntry("replacement", "replacement"))}\n`);
		await fs.promises.rename(replacementPath, filePath);
		await assert.rejects(
			() => drainSessionJsonl({ filePath, state: drained.state, result: result as any, expectedIdentity }),
			/identity does not match|replaced/,
		);

		const truncatePath = path.join(dir, "truncate.jsonl");
		const longLine = `${JSON.stringify(assistantEntry("long", "long"))}\n`;
		await fs.promises.writeFile(truncatePath, `${longLine}${" ".repeat(32)}`);
		const truncateIdentity = await getSessionFileIdentity(truncatePath);
		assert.ok(truncateIdentity);
		const truncateResult = makeResult();
		const beforeTruncate = await drainSessionJsonl({ filePath: truncatePath, state: createSessionTailState(), result: truncateResult as any, expectedIdentity: truncateIdentity });
		await fs.promises.writeFile(truncatePath, longLine);
		await assert.rejects(
			() => drainSessionJsonl({ filePath: truncatePath, state: beforeTruncate.state, result: truncateResult as any, expectedIdentity: truncateIdentity }),
			/truncated/,
		);
	});

	test("starts after an inherited fork snapshot so parent output and usage never enter the child result", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const inherited = `${JSON.stringify({ type: "session", version: 3, id: "child" })}\n${JSON.stringify(assistantEntry("parent-assistant", "PARENT"))}\n`;
		await fs.promises.writeFile(filePath, inherited);
		const result = makeResult();
		let state = createSessionTailState();
		state.offset = Buffer.byteLength(inherited);
		await fs.promises.appendFile(filePath, `${JSON.stringify(assistantEntry("child-assistant", "CHILD"))}\n`);
		const drained = await drainSessionJsonl({ filePath, state, result: result as any, final: true });
		assert.equal(getFinalOutput(result.messages as any), "CHILD");
		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 3);
		assert.equal(drained.entriesRead, 1);
	});

	test("does not turn inherited fork output into a response when the child writes nothing", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const inherited = `${JSON.stringify({ type: "session", version: 3, id: "child" })}\n${JSON.stringify(assistantEntry("parent-assistant", "PARENT"))}\n`;
		await fs.promises.writeFile(filePath, inherited);
		const result = makeResult();
		const state = { ...createSessionTailState(), offset: Buffer.byteLength(inherited) };
		const drained = await drainSessionJsonl({ filePath, state, result: result as any, final: true });
		assert.equal(drained.resultChanged, false);
		assert.equal(result.messages.length, 0);
		assert.equal(result.usage.turns, 0);
	});

	test("keeps the fork offset and entry-ID index positions during verified replay", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const inherited = `${JSON.stringify({ type: "session", version: 3, id: "child" })}\n${JSON.stringify(assistantEntry("parent-assistant", "PARENT"))}\n`;
		const child = Buffer.from(`${JSON.stringify(assistantEntry("child-assistant", "CHILD"))}\n`);
		const forkOffset = Buffer.byteLength(inherited);
		await fs.promises.writeFile(filePath, Buffer.concat([Buffer.from(inherited), child]));
		const result = makeResult();
		const drained = await drainSessionJsonl({
			filePath,
			state: { ...createSessionTailState(), offset: forkOffset },
			result: result as any,
			final: true,
			maxOffset: forkOffset + child.length,
			verifiedBytes: child,
			maxCompleteEntryBytes: MAX_COMPLETION_SESSION_ENTRY_BYTES,
		});
		assert.equal(drained.state.offset, forkOffset + child.length);
		assert.equal(getFinalOutput(result.messages as any), "CHILD");
		const buckets = await fs.promises.readdir(drained.state.indexPath!);
		const entries = (await Promise.all(buckets.map(async (bucket) => (await fs.promises.readFile(path.join(drained.state.indexPath!, bucket), "utf-8")).trim().split("\n"))))
			.flat().filter(Boolean).map((line) => JSON.parse(line));
		const indexEntry = entries.find((entry) => entry.id === "child-assistant");
		assert.equal(indexEntry.generation, `${drained.state.indexNamespace}:0`);
		assert.equal(indexEntry.start, forkOffset);
		assert.equal(indexEntry.end, forkOffset + child.length);
		assert.match(indexEntry.digest, /^[a-f0-9]{64}$/);
	});

	test("counts malformed lines and optionally flushes a final unterminated line", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		await fs.promises.writeFile(filePath, `not-json\n${JSON.stringify(assistantEntry("m-final", "final"))}`);
		const result = makeResult();
		const drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any, final: true });
		assert.equal(drained.state.malformedLines, 1);
		assert.equal(getFinalOutput(result.messages as any), "final");
	});

	test("rejects symlinks and resets on a replacement while suppressing an old entry ID", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const replacementPath = path.join(dir, "replacement.jsonl");
		await fs.promises.writeFile(filePath, `${JSON.stringify(assistantEntry("old", "first"))}\n`);
		const result = makeResult();
		let drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		await fs.promises.appendFile(filePath, Array.from(
			{ length: SESSION_TAIL_RECENT_ID_LIMIT + 1 },
			(_, index) => `${JSON.stringify(assistantEntry(`filler-${index}`, "filler"))}\n`,
		).join(""));
		drained = await drainSessionJsonl({ filePath, state: drained.state, result: result as any });
		assert.equal(drained.state.seenEntryIds.has("old"), false);
		await fs.promises.writeFile(replacementPath, `${JSON.stringify(assistantEntry("old", "replacement copy"))}\n${JSON.stringify(assistantEntry("new", "second"))}\n`);
		await fs.promises.rename(replacementPath, filePath);
		drained = await drainSessionJsonl({ filePath, state: drained.state, result: result as any });
		assert.equal(drained.state.generation, 1);
		assert.equal(result.messages.length, SESSION_TAIL_RECENT_ID_LIMIT + 3);
		assert.equal(getFinalOutput(result.messages as any), "second");

		const symlinkPath = path.join(dir, "session-link.jsonl");
		await fs.promises.symlink(filePath, symlinkPath);
		await assert.rejects(() => drainSessionJsonl({ filePath: symlinkPath, state: createSessionTailState(), result: makeResult() as any }));
	});

	test("treats malformed UTF-8 as fatal", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		await fs.promises.writeFile(filePath, Buffer.from([0x7b, 0xff, 0x7d, 0x0a]));
		await assert.rejects(
			() => drainSessionJsonl({ filePath, state: createSessionTailState(), result: makeResult() as any }),
			/malformed UTF-8/,
		);
	});

	test("bounds an overlong remainder and recovers at the next newline", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		await fs.promises.writeFile(filePath, Buffer.alloc(SESSION_TAIL_MAX_REMAINDER_BYTES * 2, 0x78));
		const result = makeResult();
		let drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		assert.ok(drained.state.remainder.length <= SESSION_TAIL_MAX_REMAINDER_BYTES);
		assert.equal(drained.state.discardingOverlongLine, true);
		await fs.promises.appendFile(filePath, `\n${JSON.stringify(assistantEntry("after-long", "recovered"))}\n`);
		drained = await drainSessionJsonl({ filePath, state: drained.state, result: result as any });
		assert.equal(drained.state.malformedLines, 1);
		assert.equal(getFinalOutput(result.messages as any), "recovered");
	});

	test("replays an 8 MiB descriptor-verified entry without accumulated chunk copying", { timeout: 30_000 }, async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const text = "x".repeat(MAX_COMPLETION_SESSION_ENTRY_BYTES - 1024);
		const bytes = Buffer.from(`${JSON.stringify(assistantEntry("large-final", text))}\n`);
		assert.ok(bytes.length > SESSION_TAIL_MAX_REMAINDER_BYTES);
		assert.ok(bytes.length - 1 <= MAX_COMPLETION_SESSION_ENTRY_BYTES);
		await fs.promises.writeFile(filePath, bytes);
		const result = makeResult();
		const originalConcat = Buffer.concat;
		let concatCalls = 0;
		Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
			concatCalls += 1;
			return totalLength === undefined ? originalConcat(list) : originalConcat(list, totalLength);
		}) as typeof Buffer.concat;
		try {
			const drained = await drainSessionJsonl({
				filePath,
				state: createSessionTailState(),
				result: result as any,
				final: true,
				maxOffset: bytes.length,
				verifiedBytes: bytes,
				maxCompleteEntryBytes: MAX_COMPLETION_SESSION_ENTRY_BYTES,
			});
			assert.equal(drained.state.malformedLines, 0);
		} finally {
			Buffer.concat = originalConcat;
		}
		assert.equal(concatCalls, 0, "verified single-entry replay must not concatenate every 64 KiB chunk");
		assert.equal(getFinalOutput(result.messages as any), text);
	});

	test("replays roughly 64 MiB of multiple descriptor-verified entries", { timeout: 60_000 }, async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const text = "x".repeat(4 * 1024 * 1024);
		const bytes = Buffer.concat(Array.from(
			{ length: 16 },
			(_, index) => Buffer.from(`${JSON.stringify(assistantEntry(`large-${index}`, text))}\n`),
		));
		assert.ok(bytes.length >= 64 * 1024 * 1024);
		await fs.promises.writeFile(filePath, bytes);
		const result = makeResult();
		const drained = await drainSessionJsonl({
			filePath,
			state: createSessionTailState(),
			result: result as any,
			final: true,
			maxOffset: bytes.length,
			verifiedBytes: bytes,
			maxCompleteEntryBytes: MAX_COMPLETION_SESSION_ENTRY_BYTES,
		});
		assert.equal(drained.entriesRead, 16);
		assert.equal(drained.resultChanged, true);
		assert.equal(result.messages.length, 16);
		assert.equal(getFinalOutput(result.messages as any), text);
	});

	test("rejects a malformed or incomplete descriptor-verified final replay", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const bytes = Buffer.from(`not-json\n${JSON.stringify(assistantEntry("partial", "must not close"))}`);
		await fs.promises.writeFile(filePath, bytes);
		await assert.rejects(() => drainSessionJsonl({
			filePath,
			state: createSessionTailState(),
			result: makeResult() as any,
			final: true,
			maxOffset: bytes.length,
			verifiedBytes: bytes,
			maxCompleteEntryBytes: MAX_COMPLETION_SESSION_ENTRY_BYTES,
		}), /malformed or incomplete/);
	});

	test("keeps a bounded recent ID cache while the private index remains readable and private", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const indexPath = path.join(dir, "entry-id.index");
		await fs.promises.writeFile(filePath, Array.from(
			{ length: SESSION_TAIL_RECENT_ID_LIMIT + 32 },
			(_, index) => `${JSON.stringify(assistantEntry(`id-${index}`, String(index)))}\n`,
		).join(""));
		const result = makeResult();
		const drained = await drainSessionJsonl({ filePath, indexPath, state: createSessionTailState(), result: result as any });
		assert.ok(drained.state.seenEntryIds.size <= SESSION_TAIL_RECENT_ID_LIMIT);
		assert.equal(result.messages.length, SESSION_TAIL_RECENT_ID_LIMIT + 32);
		assert.equal((await fs.promises.stat(indexPath)).mode & 0o777, 0o700);
		const buckets = await fs.promises.readdir(indexPath);
		assert.ok(buckets.length > 0 && buckets.length <= 4096);
		assert.ok(buckets.every((bucket) => /^[a-f0-9]{3}\.jsonl$/.test(bucket)));
		const indexContents = await Promise.all(buckets.map((bucket) => fs.promises.readFile(path.join(indexPath, bucket), "utf-8"))).then((contents) => contents.join(""));
		assert.match(indexContents, /"generation":"tail-/);
		assert.match(indexContents, /"start":/);
		assert.match(indexContents, /"digest":"[a-f0-9]{64}"/);
		await Promise.all(buckets.map(async (bucket) => assert.equal((await fs.promises.stat(path.join(indexPath, bucket))).mode & 0o777, 0o600)));
		await fs.promises.appendFile(filePath, `${JSON.stringify(assistantEntry("id-0", "duplicate"))}\n`);
		const duplicate = await drainSessionJsonl({ filePath, indexPath, state: drained.state, result: result as any });
		assert.equal(duplicate.resultChanged, false);
		assert.equal(result.messages.length, SESSION_TAIL_RECENT_ID_LIMIT + 32);
	});

	test("uses a private descriptor-bound fallback index when the primary pathname is unusable", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl"), indexPath = path.join(dir, "entry.index");
		await fs.promises.writeFile(indexPath, "not a directory", { mode: 0o600 });
		await fs.promises.writeFile(filePath, `${JSON.stringify(assistantEntry("fallback-id", "once"))}\n`);
		const result = makeResult();
		let drained = await drainSessionJsonl({ filePath, indexPath, state: createSessionTailState(), result: result as any });
		assert.equal(drained.state.indexWriteDisabled, false);
		assert.equal(drained.state.indexPath, `${indexPath}.fallback`);
		assert.equal((await fs.promises.stat(`${indexPath}.fallback`)).mode & 0o777, 0o700);
		assert.equal((await fs.promises.readdir(`${indexPath}.fallback`)).length, 1);
		await fs.promises.appendFile(filePath, `${JSON.stringify(assistantEntry("fallback-id", "duplicate"))}\n`);
		drained = await drainSessionJsonl({ filePath, indexPath, state: drained.state, result: result as any });
		assert.equal(result.messages.length, 1);
		assert.equal(getFinalOutput(result.messages as any), "once");
	});

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

	test("does not register arbitrary object IDs in the exact index", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tail-"));
		tempDirs.push(dir);
		const filePath = path.join(dir, "session.jsonl");
		const entry = { ...assistantEntry("ignored", "object ID"), id: { arbitrary: true } };
		await fs.promises.writeFile(filePath, `${JSON.stringify(entry)}\n${JSON.stringify(entry)}\n`);
		const result = makeResult();
		const drained = await drainSessionJsonl({ filePath, state: createSessionTailState(), result: result as any });
		assert.equal(result.messages.length, 2);
		assert.equal(drained.state.indexPath, `${filePath}.entry-index`);
		await assert.rejects(() => fs.promises.stat(drained.state.indexPath!));
	});
});
