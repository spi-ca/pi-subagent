import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalAssistantMessage, processPiJsonLineWithAssistantSignatureIndex } from "../../src/core/runner-events";
import { AssistantSignatureIndex } from "../../src/runtime/assistant-signature-index";
import { emptyUsage } from "../../src/core/types";
import { emptyAccountingUsage } from "../../src/core/accounting-usage";

function result() {
  return {
    agent: "worker",
    agentSource: "user" as const,
    task: "test",
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    accountingUsage: emptyAccountingUsage(),
  };
}

async function privateDirectory(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-signatures-"));
  await fs.promises.chmod(directory, 0o700);
  return directory;
}

describe("inline assistant signature index", () => {
  test("publishes a private metadata-only record with read-back and is removed with its task directory", async () => {
    const directory = await privateDirectory();
    try {
      const index = new AssistantSignatureIndex(directory);
      await index.append("canonical assistant payload", 7);

      const stat = await fs.promises.stat(index.filePath);
      const raw = await fs.promises.readFile(index.filePath, "utf8");
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(raw.includes("canonical assistant payload"), false);
      assert.deepEqual(JSON.parse(raw), {
        v: 1,
        c: 1,
        s: 0,
        d: crypto.createHash("sha256").update("canonical assistant payload", "utf8").digest("hex"),
        b: Buffer.byteLength("canonical assistant payload", "utf8"),
        m: 7,
      });
      assert.equal(await index.findCandidateOverlap(["canonical assistant payload"]), 1);

      await fs.promises.rm(directory, { recursive: true, force: false });
      await assert.rejects(fs.promises.stat(index.filePath), { code: "ENOENT" });
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("uses exact public-message fallback for digest collisions and invalid index records", async () => {
    const directory = await privateDirectory();
    try {
      const index = new AssistantSignatureIndex(directory, { digest: () => "0".repeat(64) });
      const state = result();
      const first = { role: "assistant", content: [{ type: "text", text: "A" }] };
      (state.messages as any[]).push(first);
      await index.append(canonicalAssistantMessage(first), 0);

      const second = { role: "assistant", content: [{ type: "text", text: "B" }] };
      assert.equal(await processPiJsonLineWithAssistantSignatureIndex(JSON.stringify({ type: "agent_end", messages: [second] }), state as any, index), true);
      assert.deepEqual(state.messages, [first, second]);

      await fs.promises.writeFile(index.filePath, "not-json\n", { mode: 0o600 });
      const third = { role: "assistant", content: [{ type: "text", text: "C" }] };
      assert.equal(await processPiJsonLineWithAssistantSignatureIndex(JSON.stringify({ type: "agent_end", messages: [second, third] }), state as any, index), true);
      assert.deepEqual(state.messages, [first, second, third]);
      assert.equal(index.isEnabled, false);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("accounts agent_end tool results while its assistant overlap is indexed", async () => {
    const directory = await privateDirectory();
    try {
      const index = new AssistantSignatureIndex(directory);
      const state = result();
      const assistant = { role: "assistant", content: [{ type: "text", text: "A" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const tool = { role: "toolResult", toolCallId: "nested", usage: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      await processPiJsonLineWithAssistantSignatureIndex(JSON.stringify({ type: "message_end", message: assistant }), state as any, index);
      await processPiJsonLineWithAssistantSignatureIndex(JSON.stringify({ type: "agent_end", messages: [assistant, tool] }), state as any, index);
      assert.equal(state.messages.length, 1);
      assert.equal(state.accountingUsage.totalTokens, 4);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("streams a large sequence without retaining records in persistent state", async () => {
    const directory = await privateDirectory();
    try {
      const filePath = path.join(directory, "assistant-signatures.idx");
      const count = 4_000;
      const records = Array.from({ length: count }, (_, sequence) => {
        const canonical = `message-${sequence}`;
        return JSON.stringify({
          v: 1,
          c: 1,
          s: sequence,
          d: crypto.createHash("sha256").update(canonical, "utf8").digest("hex"),
          b: Buffer.byteLength(canonical, "utf8"),
          m: sequence,
        });
      });
      await fs.promises.writeFile(filePath, `${records.join("\n")}\n`, { mode: 0o600 });
      await fs.promises.chmod(filePath, 0o600);

      const index = new AssistantSignatureIndex(directory);
      assert.equal(await index.findCandidateOverlap([`message-${count - 2}`, `message-${count - 1}`]), 2);
      assert.equal(Object.keys(index as unknown as Record<string, unknown>).some((key) => /record|cache/i.test(key)), false);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });
});
