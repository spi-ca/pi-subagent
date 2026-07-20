import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSessionTailState, drainSessionJsonl } from "../../src/runtime/session-tail";
import { emptyUsage, getFinalOutput } from "../../src/core/types";

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
});
