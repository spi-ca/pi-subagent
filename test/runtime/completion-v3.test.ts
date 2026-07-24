import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import {
	MAX_COMPLETION_SESSION_BYTES,
	MAX_COMPLETION_SESSION_ENTRY_BYTES,
	MAX_COMPLETION_SESSION_ENTRY_COUNT,
	MAX_COMPLETION_SESSION_ENTRY_ID_BYTES,
	computeLegacySessionCompletionBoundary,
	computeSessionCompletionBoundary,
	computeSessionFailureBoundary,
	getSessionFileIdentity,
	readVerifiedSessionCompletionSuffix,
	readVerifiedSessionSuffix,
	getSessionVerificationBufferUsageForTesting,
	setSessionVerificationBufferLimitForTesting,
	setSessionVerificationPositionalReadForTesting,
	setSessionVerificationTimeoutForTesting,
	verifySessionBoundary,
	verifySessionCompletionBoundary,
} from "../../src/runtime/completion-v3";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function sessionTextFile(content: string): Promise<string> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-completion-v3-"));
	tempDirs.push(root);
	const filePath = path.join(root, "session.jsonl");
	await fs.promises.writeFile(filePath, content, { mode: 0o600 });
	return filePath;
}

async function sessionFile(lines: unknown[]): Promise<string> {
	return await sessionTextFile(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

describe("CompletionRecordV3 session boundary", () => {
	test("computes and verifies an exact stable JSONL prefix", async () => {
		const filePath = await sessionFile([{ type: "session", id: "header" }, { type: "message", id: "final", message: { role: "assistant" } }]);
		const boundary = await computeSessionCompletionBoundary(filePath);
		assert.ok(boundary);
		assert.equal(boundary.finalEntryId, "final");
		assert.equal(boundary.byteOffset, (await fs.promises.stat(filePath)).size);
		assert.match(boundary.prefixDigest, /^[a-f0-9]{64}$/);
		assert.equal(await verifySessionCompletionBoundary(filePath, boundary), true);
	});

	test("computes generic abnormal-completion boundaries for header-only and usage JSONL", async () => {
		const headerOnly = await sessionFile([{ type: "session", id: "header" }]);
		const headerBoundary = await computeSessionFailureBoundary(headerOnly);
		assert.ok(headerBoundary);
		assert.equal(headerBoundary.finalEntryId, "header");
		assert.equal(await verifySessionBoundary(headerOnly, headerBoundary), true);
		assert.equal(await computeSessionCompletionBoundary(headerOnly), null);

		const usage = await sessionFile([{ type: "session", id: "header" }, { type: "usage", id: "usage-1", inputTokens: 3 }]);
		const usageBoundary = await computeSessionFailureBoundary(usage);
		assert.ok(usageBoundary);
		assert.equal(usageBoundary.finalEntryId, "usage-1");
		assert.equal(await verifySessionBoundary(usage, usageBoundary), true);
	});

	test("rejects FIFO compute and verify calls without starving a regular verifier", async () => {
		if (process.platform === "win32") return;
		const regularPath = await sessionFile([{ type: "session", id: "header" }]);
		const regularBoundary = await computeSessionFailureBoundary(regularPath);
		assert.ok(regularBoundary);
		const fifoPath = path.join(path.dirname(regularPath), "session.fifo");
		assert.equal(spawnSync("/usr/bin/mkfifo", [fifoPath]).status, 0);
		await fs.promises.chmod(fifoPath, 0o600);
		const startedAt = performance.now();
		const [computed, verified, regular] = await Promise.all([
			computeSessionFailureBoundary(fifoPath),
			verifySessionBoundary(fifoPath, regularBoundary),
			computeSessionFailureBoundary(regularPath),
		]);
		assert.equal(computed, null);
		assert.equal(verified, false);
		assert.ok(regular, "a FIFO must not starve an unrelated verification worker");
		assert.ok(performance.now() - startedAt < 150, "FIFO compute/verify must fail before an absent writer blocks a worker");
	});

	test("supports a final assistant JSONL entry larger than one hash chunk", async () => {
		assert.ok(MAX_COMPLETION_SESSION_ENTRY_BYTES >= 70 * 1024);
		const filePath = await sessionFile([{ type: "message", id: "large-final", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(70 * 1024) }] } }]);
		const boundary = await computeSessionCompletionBoundary(filePath);
		assert.ok(boundary);
		assert.equal(boundary.finalEntryId, "large-final");
		assert.equal(await verifySessionCompletionBoundary(filePath, boundary), true);
	});

	test("rejects overlong complete JSONL entries before retaining their full prefix", async () => {
		const filePath = await sessionFile([{
			type: "message",
			id: "overlong",
			message: { role: "assistant", content: "x".repeat(MAX_COMPLETION_SESSION_ENTRY_BYTES) },
		}]);
		assert.equal(await computeSessionFailureBoundary(filePath), null);
		assert.equal(await computeSessionCompletionBoundary(filePath), null);

		// Resource-limit rejection must release the global reservation.
		const recovery = await sessionFile([{ type: "session", id: "recovery" }]);
		const restore = setSessionVerificationBufferLimitForTesting((await fs.promises.stat(recovery)).size);
		try {
			assert.ok(await computeSessionFailureBoundary(recovery));
		} finally { restore(); }
	});

	test("rejects prefixes with too many complete JSONL entries in both modes", async () => {
		const filePath = await sessionTextFile(Array.from(
			{ length: MAX_COMPLETION_SESSION_ENTRY_COUNT + 1 },
			(_, index) => JSON.stringify({ type: "message", id: `entry-${index}`, message: { role: "assistant" } }),
		).join("\n") + "\n");
		assert.equal(await computeSessionFailureBoundary(filePath), null);
		assert.equal(await computeSessionCompletionBoundary(filePath), null);
	});

	test("rejects prefixes whose cumulative entry-ID UTF-8 bytes exceed the budget in both modes", async () => {
		const idCharacterLength = 512;
		const idUtf8Bytes = 1024;
		const filePath = await sessionTextFile(Array.from(
			{ length: Math.floor(MAX_COMPLETION_SESSION_ENTRY_ID_BYTES / idUtf8Bytes) + 1 },
			(_, index) => JSON.stringify({
				type: "message",
				// 512 non-ASCII characters use 1,024 UTF-8 bytes; the final two preserve uniqueness.
				id: "é".repeat(idCharacterLength - 2) + String.fromCharCode(0x100 + (index >> 8), 0x100 + (index & 0xff)),
				message: { role: "assistant" },
			}),
		).join("\n") + "\n");
		assert.equal(await computeSessionFailureBoundary(filePath), null);
		assert.equal(await computeSessionCompletionBoundary(filePath), null);
	});

	test("accepts linked custom entries after the final assistant and binds them into the verified prefix", async () => {
		const filePath = await sessionFile([
			{ type: "message", id: "final", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
			{ type: "custom", id: "observation", parentId: "final", timestamp: "2026-07-21T00:00:00.000Z", customType: "om.observations.recorded", data: { count: 1 } },
			{ type: "custom", id: "reflection", parentId: "observation", timestamp: "2026-07-21T00:00:01.000Z", customType: "om.reflections.recorded", data: { count: 1 } },
		]);
		const boundary = await computeSessionCompletionBoundary(filePath);
		assert.ok(boundary);
		assert.equal(boundary.finalEntryId, "reflection");
		assert.equal(boundary.byteOffset, (await fs.promises.stat(filePath)).size);
		assert.equal(await verifySessionCompletionBoundary(filePath, boundary), true);
		const suffixLease = await readVerifiedSessionCompletionSuffix(filePath, boundary, 0);
		assert.ok(suffixLease);
		try { assert.deepEqual(suffixLease.bytes, await fs.promises.readFile(filePath)); }
		finally { suffixLease.release(); }

		const bytes = await fs.promises.readFile(filePath);
		const customEntryOffset = bytes.indexOf(Buffer.from("om.reflections.recorded"));
		assert.ok(customEntryOffset > 0);
		bytes[customEntryOffset] ^= 1;
		await fs.promises.writeFile(filePath, bytes);
		assert.equal(await verifySessionCompletionBoundary(filePath, boundary), false);
	});

	test("uses an assistant-only legacy success boundary when Pi 0.81 metadata follows", async () => {
		const assistant = { type: "message", id: "final", message: { role: "assistant", content: [{ type: "text", text: "done" }] } };
		const compaction = { type: "compaction", id: "compact", parentId: "final", timestamp: "2026-07-21T00:00:00.000Z", summary: "compact", tokensBefore: 9, retainedTail: [], usage: { totalTokens: 5 } };
		const filePath = await sessionFile([assistant, compaction]);
		const boundary = await computeLegacySessionCompletionBoundary(filePath);
		assert.ok(boundary);
		const assistantPrefix = Buffer.from(`${JSON.stringify(assistant)}\n`);
		assert.equal(boundary.byteOffset, assistantPrefix.length);
		assert.equal(boundary.finalEntryId, "final");
		assert.equal(boundary.prefixDigest, crypto.createHash("sha256").update(assistantPrefix).digest("hex"));
		assert.equal(await verifySessionCompletionBoundary(filePath, boundary), true, "the assistant-only prefix remains verifiable by legacy success semantics");
	});

	test("accepts linked Pi 0.81 compaction and branch summaries after the final assistant", async () => {
		const usage = { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, total: 5 } };
		const filePath = await sessionFile([
			{ type: "message", id: "final", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
			{ type: "compaction", id: "compact", parentId: "final", timestamp: "2026-07-21T00:00:00.000Z", summary: "compact", tokensBefore: 9, retainedTail: [], usage },
			{ type: "branch_summary", id: "branch", parentId: "compact", timestamp: "2026-07-21T00:00:01.000Z", fromId: "final", summary: "branch", usage },
		]);
		const boundary = await computeSessionCompletionBoundary(filePath);
		assert.ok(boundary);
		assert.equal(boundary.finalEntryId, "branch");
		const suffix = await readVerifiedSessionCompletionSuffix(filePath, boundary, 0);
		assert.ok(suffix);
		try {
			const entries = suffix.bytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
			assert.deepEqual(entries[1].usage, usage, "the bound compaction usage remains recoverable");
			assert.deepEqual(entries[2].usage, usage, "the bound branch-summary usage remains recoverable");
		} finally { suffix.release(); }
	});

	test("rejects unlinked, malformed, or message entries after the final assistant", async () => {
		const assistant = { type: "message", id: "final", message: { role: "assistant" } };
		for (const trailing of [
			{ type: "custom", id: "unlinked", parentId: "other", timestamp: "2026-07-21T00:00:00.000Z", customType: "om.observations.recorded" },
			{ type: "branch_summary", id: "unlinked-summary", parentId: "other", timestamp: "2026-07-21T00:00:00.000Z", fromId: "final", summary: "later" },
			{ type: "custom", id: "missing-timestamp", parentId: "final", customType: "om.observations.recorded" },
			{ type: "message", id: "user-after", parentId: "final", message: { role: "user", content: "continue" } },
			{ type: "message", id: "tool-after", parentId: "final", message: { role: "toolResult", content: [] } },
			{ type: "compaction", id: "compaction-after", parentId: "final", timestamp: "2026-07-21T00:00:00.000Z", summary: "later" },
		]) assert.equal(await computeSessionCompletionBoundary(await sessionFile([assistant, trailing])), null);
	});

	test("rejects malformed or invalid UTF-8 entries after the final assistant", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-completion-v3-"));
		tempDirs.push(root);
		const assistant = `${JSON.stringify({ type: "message", id: "final", message: { role: "assistant" } })}\n`;
		const malformed = path.join(root, "trailing-malformed.jsonl");
		await fs.promises.writeFile(malformed, `${assistant}{bad}\n`, { mode: 0o600 });
		assert.equal(await computeSessionCompletionBoundary(malformed), null);
		const malformedUtf8 = path.join(root, "trailing-malformed-utf8.jsonl");
		await fs.promises.writeFile(malformedUtf8, Buffer.concat([Buffer.from(assistant), Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d, 0x0a])]), { mode: 0o600 });
		assert.equal(await computeSessionCompletionBoundary(malformedUtf8), null);
		assert.equal(await computeSessionCompletionBoundary(await sessionFile([
			{ type: "session", id: "duplicate" },
			{ type: "message", id: "duplicate", message: { role: "assistant" } },
		])), null);
	});

	test("accepts later appends but rejects mutation or truncation inside the completion prefix", async () => {
		const filePath = await sessionFile([{ type: "message", id: "final", message: { role: "assistant", content: "done" } }]);
		const boundary = await computeSessionCompletionBoundary(filePath);
		assert.ok(boundary);
		await fs.promises.appendFile(filePath, `${JSON.stringify({ type: "message", id: "later" })}\n`);
		assert.equal(await verifySessionCompletionBoundary(filePath, boundary), true);
		const verifiedSuffix = await readVerifiedSessionCompletionSuffix(filePath, boundary, 5);
		assert.ok(verifiedSuffix);
		try { assert.deepEqual(verifiedSuffix.bytes, (await fs.promises.readFile(filePath)).subarray(5, boundary.byteOffset)); }
		finally { verifiedSuffix.release(); }
		const original = await fs.promises.readFile(filePath);
		original[10] ^= 1;
		await fs.promises.writeFile(filePath, original);
		assert.equal(await verifySessionCompletionBoundary(filePath, boundary), false);
		await fs.promises.truncate(filePath, boundary.byteOffset - 1);
		assert.equal(await verifySessionCompletionBoundary(filePath, boundary), false);
	});

	test("rejects duplicate IDs, malformed UTF-8, and incomplete generic prefixes", async () => {
		for (const lines of [
			[{ type: "session", id: "header" }, { type: "usage", id: "header" }],
			[{ type: "session", id: "header" }, { type: "message", id: "header", message: { role: "assistant" } }],
			[{ type: "session" }],
		]) assert.equal(await computeSessionFailureBoundary(await sessionFile(lines)), null);
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-completion-v3-"));
		tempDirs.push(root);
		const partial = path.join(root, "partial.jsonl");
		await fs.promises.writeFile(partial, '{"id":"header"}', { mode: 0o600 });
		assert.equal(await computeSessionFailureBoundary(partial), null);
		const malformedUtf8 = path.join(root, "utf8.jsonl");
		await fs.promises.writeFile(malformedUtf8, Buffer.from([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d, 0x0a]), { mode: 0o600 });
		assert.equal(await computeSessionFailureBoundary(malformedUtf8), null);
	});

	test("binds generic verification to an optional parent-captured device/inode identity", async () => {
		const filePath = await sessionFile([{ type: "session", id: "header" }]);
		const identity = await getSessionFileIdentity(filePath);
		const boundary = await computeSessionFailureBoundary(filePath, { expectedSessionIdentity: identity! });
		assert.ok(boundary && identity);
		assert.equal(await verifySessionBoundary(filePath, boundary, { expectedSessionIdentity: identity }), true);
		await fs.promises.appendFile(filePath, `${JSON.stringify({ type: "usage", id: "later-usage" })}\n`);
		assert.equal(await verifySessionBoundary(filePath, boundary, { expectedSessionIdentity: identity }), true, "same-inode appends are outside the bound prefix");
		const replacement = `${JSON.stringify({ type: "session", id: "header" })}\n${JSON.stringify({ type: "usage", id: "later-usage" })}\n`;
		const replacementPath = `${filePath}.replacement`;
		await fs.promises.writeFile(replacementPath, replacement, { mode: 0o600 });
		await fs.promises.rename(replacementPath, filePath);
		assert.equal(await verifySessionBoundary(filePath, boundary, { expectedSessionIdentity: identity }), false, "parent identity binding rejects replacement even with matching prefix bytes");
		assert.equal(await verifySessionBoundary(filePath, boundary, { expectedSessionIdentity: { dev: identity.dev, ino: identity.ino + 100000000n } }), false);
	});

	test("uses a process-global FIFO verification reservation and releases it after failures", async () => {
		const filePath = await sessionFile([{ type: "session", id: "header" }]);
		const first = await computeSessionFailureBoundary(filePath);
		assert.ok(first);
		const byteOffset = (await fs.promises.stat(filePath)).size;
		const restore = setSessionVerificationBufferLimitForTesting(byteOffset);
		try {
			const [rejected, queued] = await Promise.all([
				readVerifiedSessionSuffix(filePath, { ...first, prefixDigest: "0".repeat(64) }, 0),
				computeSessionFailureBoundary(filePath),
			]);
			assert.equal(rejected, null);
			assert.ok(queued, "a FIFO-queued verification must run after a failed verifier releases its reservation");
			const suffix = await readVerifiedSessionSuffix(filePath, queued, 0);
			assert.ok(suffix);
			try { assert.deepEqual(suffix.bytes, await fs.promises.readFile(filePath)); }
			finally { suffix.release(); }
		} finally { restore(); }
	});

	test("holds a verified suffix reservation until its idempotent lease release", async () => {
		const filePath = await sessionFile([{ type: "session", id: "header" }]);
		const boundary = await computeSessionFailureBoundary(filePath);
		assert.ok(boundary);
		const restore = setSessionVerificationBufferLimitForTesting(boundary.byteOffset);
		try {
			const first = await readVerifiedSessionSuffix(filePath, boundary, 0);
			assert.ok(first);
			let secondSettled = false;
			const secondPromise = readVerifiedSessionSuffix(filePath, boundary, 0).then((lease) => {
				secondSettled = true;
				return lease;
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(secondSettled, false, "a full reservation remains owned until parsing releases its lease");
			first.release();
			first.release();
			const second = await secondPromise;
			assert.ok(second);
			second.release();
		} finally { restore(); }
	});

	test("uses one exact reservation-backed prefix Buffer and never concatenates line fragments", async () => {
		const filePath = await sessionFile([{ type: "message", id: "large-final", message: { role: "assistant", content: "x".repeat(20 * 1024) } }]);
		const boundary = await computeSessionCompletionBoundary(filePath);
		assert.ok(boundary);
		const seen: Buffer[] = [];
		const restoreRead = setSessionVerificationPositionalReadForTesting(async (handle, buffer, offset, length, position) => {
			seen.push(buffer);
			return (await handle.read(buffer, offset, Math.min(length, 97), position)).bytesRead;
		});
		const originalConcat = Buffer.concat;
		(Buffer as unknown as { concat: typeof Buffer.concat }).concat = () => { throw new Error("prefix validation must not concatenate lines"); };
		try {
			const suffix = await readVerifiedSessionCompletionSuffix(filePath, boundary, 7);
			assert.ok(suffix);
			try {
				assert.equal(seen.length > 1, true, "the partial-read seam exercises repeated positional reads");
				assert.equal(seen.every((buffer) => buffer === seen[0]), true, "all positional reads target the same prefix Buffer");
				assert.equal(seen[0]!.length, boundary.byteOffset, "the one prefix Buffer is exactly the bound prefix size");
				assert.equal(suffix.bytes.length, boundary.byteOffset - 7);
			} finally { suffix.release(); }
		} finally {
			(Buffer as unknown as { concat: typeof Buffer.concat }).concat = originalConcat;
			restoreRead();
		}
	});

	test("fails queued reservations closed at their bounded acquisition deadline", async () => {
		const filePath = await sessionFile([{ type: "session", id: "header" }]);
		const boundary = await computeSessionFailureBoundary(filePath);
		assert.ok(boundary);
		const restoreLimit = setSessionVerificationBufferLimitForTesting(boundary.byteOffset);
		const restoreTimeout = setSessionVerificationTimeoutForTesting(15);
		try {
			const first = await readVerifiedSessionSuffix(filePath, boundary, 0);
			assert.ok(first);
			const queued = await readVerifiedSessionSuffix(filePath, boundary, 0);
			assert.equal(queued, null);
			assert.deepEqual(getSessionVerificationBufferUsageForTesting(), { limit: boundary.byteOffset, used: boundary.byteOffset, waiters: 0 });
			first.release();
		} finally {
			restoreTimeout();
			restoreLimit();
		}
	});

	test("times out stalled positional reads without reclaiming their reservation until they settle", async () => {
		const filePath = await sessionFile([{ type: "session", id: "header" }]);
		const boundary = await computeSessionFailureBoundary(filePath);
		assert.ok(boundary);
		const restoreLimit = setSessionVerificationBufferLimitForTesting(boundary.byteOffset);
		const restoreTimeout = setSessionVerificationTimeoutForTesting(15);
		let settleRead: ((bytesRead: number) => void) | undefined;
		const restoreRead = setSessionVerificationPositionalReadForTesting(async () => await new Promise<number>((resolve) => { settleRead = resolve; }));
		try {
			assert.equal(await verifySessionBoundary(filePath, boundary), false, "verification-only callers fail closed at the I/O deadline");
			assert.deepEqual(getSessionVerificationBufferUsageForTesting(), { limit: boundary.byteOffset, used: boundary.byteOffset, waiters: 0 });
			assert.equal(await computeSessionFailureBoundary(filePath), null, "unrelated compute callers do not wait indefinitely behind stalled I/O");
			assert.equal(getSessionVerificationBufferUsageForTesting().waiters, 0);
			settleRead?.(0);
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.deepEqual(getSessionVerificationBufferUsageForTesting(), { limit: boundary.byteOffset, used: 0, waiters: 0 }, "the late I/O settlement releases its retained reservation");
			assert.equal(await computeSessionFailureBoundary(filePath), null, "compute callers use the same positional I/O deadline");
			assert.equal(getSessionVerificationBufferUsageForTesting().used, boundary.byteOffset);
			settleRead?.(0);
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(getSessionVerificationBufferUsageForTesting().used, 0);
		} finally {
			restoreRead();
			restoreTimeout();
			restoreLimit();
		}
	});

	test("rejects incomplete, malformed, missing-id, symlink, and replaced snapshots", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-completion-v3-"));
		tempDirs.push(root);
		for (const [name, content] of [["empty", ""], ["partial", '{"id":"x"}'], ["bad", "{bad}\n"], ["missing-id", '{"type":"message"}\n'], ["non-assistant", '{"type":"message","id":"x","message":{"role":"user"}}\n']] as const) {
			const filePath = path.join(root, `${name}.jsonl`);
			await fs.promises.writeFile(filePath, content, { mode: 0o600 });
			assert.equal(await computeSessionCompletionBoundary(filePath), null);
		}
		const malformedUtf8 = path.join(root, "malformed-utf8.jsonl");
		await fs.promises.writeFile(malformedUtf8, Buffer.from([0x7b, 0x22, 0x74, 0x79, 0x70, 0x65, 0x22, 0x3a, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x2c, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x2c, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3a, 0x7b, 0x22, 0x72, 0x6f, 0x6c, 0x65, 0x22, 0x3a, 0x22, 0x61, 0x73, 0x73, 0x69, 0x73, 0x74, 0x61, 0x6e, 0x74, 0x22, 0x7d, 0x7d, 0x0a]), { mode: 0o600 });
		assert.equal(await computeSessionCompletionBoundary(malformedUtf8), null);
		const oversized = path.join(root, "oversized.jsonl");
		await fs.promises.writeFile(oversized, "", { mode: 0o600 });
		await fs.promises.truncate(oversized, MAX_COMPLETION_SESSION_BYTES + 1);
		assert.equal(await computeSessionCompletionBoundary(oversized), null);
		const target = path.join(root, "target.jsonl");
		const link = path.join(root, "link.jsonl");
		await fs.promises.writeFile(target, '{"id":"x"}\n', { mode: 0o600 });
		await fs.promises.symlink(target, link);
		await assert.rejects(() => computeSessionCompletionBoundary(link));
	});
});
