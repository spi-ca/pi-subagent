import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { getResultSummaryText, processPiEvent } from "../../src/core/runner-events";
import { emptyUsage, getFinalOutput } from "../../src/core/types";
import { emptyAccountingUsage } from "../../src/core/accounting-usage";

describe("runner event summaries", () => {
  test("prefers explicit error details over assistant text on failures", () => {
    const result = {
      exitCode: 1,
      stopReason: "error",
      errorMessage: "actual failure",
      stderr: "stderr failure",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "partial output" }],
        },
      ],
    };

    assert.equal(getResultSummaryText(result), "actual failure");
  });

  test("accounts assistant and tool usage without exposing tool messages", () => {
    const result = {
      agent: "scout", agentSource: "user" as const, task: "event test", exitCode: -1,
      messages: [], stderr: "", usage: emptyUsage(), accountingUsage: emptyAccountingUsage(),
    };
    const assistant = {
      role: "assistant", content: [{ type: "text", text: "A" }],
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cacheWrite1h: 6, reasoning: 7, totalTokens: 99, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 21 } },
    };
    const firstTool = { role: "toolResult", toolCallId: "call-1", usage: { input: 8, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 8, cost: { input: 8, output: 0, cacheRead: 0, cacheWrite: 0, total: 8 } } };
    const secondTool = { role: "toolResult", toolCallId: "call-2", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } } };
    const fallbackTool = { role: "toolResult", toolName: "no-id", usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 } } };

    assert.equal(processPiEvent({ type: "message_end", message: assistant }, result as any), true);
    assert.equal(processPiEvent({ type: "tool_execution_end", toolCallId: "call-1", result: { usage: firstTool.usage } }, result as any), false);
    assert.equal(processPiEvent({ type: "turn_end", message: assistant, toolResults: [firstTool, secondTool] }, result as any), false);
    assert.equal(processPiEvent({ type: "agent_end", messages: [assistant, firstTool, secondTool] }, result as any), false);
    assert.equal(processPiEvent({ type: "message_end", message: fallbackTool }, result as any), false);
    assert.equal(processPiEvent({ type: "message_end", message: fallbackTool }, result as any), false);

    assert.deepEqual(result.messages, [assistant]);
    assert.equal(result.accountingUsage.totalTokens, 30);
    assert.equal(result.accountingUsage.cacheWrite1h, 6);
    assert.equal(result.accountingUsage.reasoning, 7);
    assert.equal(result.accountingUsage.cost.total, 37);
  });

  test("does not merge distinct no-ID tool-result occurrences", () => {
    const result = {
      agent: "scout", agentSource: "user" as const, task: "no-ID tool results", exitCode: -1,
      messages: [], stderr: "", usage: emptyUsage(), accountingUsage: emptyAccountingUsage(),
    };
    const tool = {
      role: "toolResult", toolName: "no-id", content: [{ type: "text", text: "same" }],
      usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };

    processPiEvent({ type: "message_end", message: tool }, result as any);
    processPiEvent({ type: "message_end", message: tool }, result as any);
    processPiEvent({ type: "agent_end", messages: [tool, tool] }, result as any);
    processPiEvent({ type: "agent_end", messages: [tool, tool] }, result as any);

    assert.equal(result.accountingUsage.totalTokens, 6);
  });

  test("counts reused inline tool-call IDs once per execution across lifecycle sources", () => {
    const result = {
      agent: "scout", agentSource: "user" as const, task: "reused inline calls", exitCode: -1,
      messages: [], stderr: "", usage: emptyUsage(), accountingUsage: emptyAccountingUsage(),
    };
    const firstUsage = { input: 4, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const secondUsage = { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const first = { role: "toolResult", toolCallId: "reused", usage: firstUsage };
    const second = { role: "toolResult", toolCallId: "reused", usage: secondUsage };

    for (const tool of [first, second]) {
      assert.equal(processPiEvent({ type: "tool_execution_end", toolCallId: "reused", result: { usage: tool.usage } }, result as any), false);
      assert.equal(processPiEvent({ type: "message_end", message: tool }, result as any), false);
      assert.equal(processPiEvent({ type: "turn_end", toolResults: [tool] }, result as any), false);
    }
    assert.equal(processPiEvent({ type: "agent_end", messages: [first, second] }, result as any), false);
    assert.equal(processPiEvent({ type: "agent_end", messages: [first, second] }, result as any), false);

    assert.equal(result.accountingUsage.totalTokens, 11);
    assert.deepEqual(result.messages, []);
  });

  test("sums multiple assistant turns while preserving latest UI context and de-duplicates every lifecycle copy", () => {
    const result = {
      agent: "scout", agentSource: "user" as const, task: "turns", exitCode: -1,
      messages: [], stderr: "", usage: emptyUsage(),
    };
    const first = { role: "assistant", content: [{ type: "text", text: "first" }], usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.3 } } };
    const second = { role: "assistant", content: [{ type: "text", text: "second" }], stopReason: "error", usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, totalTokens: 75, cost: { input: 0.3, output: 0.4, cacheRead: 0.5, cacheWrite: 0.6, total: 1.8 } } };

    for (const assistant of [first, second]) {
      processPiEvent({ type: "message_start", message: assistant }, result as any);
      assert.equal(processPiEvent({ type: "message_end", message: assistant }, result as any), true);
      assert.equal(processPiEvent({ type: "turn_end", message: assistant, toolResults: [] }, result as any), false);
    }
    assert.equal(processPiEvent({ type: "agent_end", messages: [first, second] }, result as any), false);

    assert.deepEqual(result.usage, { input: 5, output: 5, cacheRead: 5, cacheWrite: 6, cost: 2.1, contextTokens: 75, turns: 2 });
    assert.deepEqual((result as any).accountingUsage, {
      input: 5, output: 5, cacheRead: 5, cacheWrite: 6, totalTokens: 21,
      cost: { input: 0.5, output: 0.5, cacheRead: 0.5, cacheWrite: 0.6, total: 2.1 },
    });
    assert.equal(result.messages.length, 2);
    assert.equal((result as any).stopReason, "error");
  });

  test("ignores missing and malformed accounting values without changing callback semantics", () => {
    const result = {
      agent: "scout", agentSource: "user" as const, task: "malformed", exitCode: -1,
      messages: [], stderr: "", usage: emptyUsage(),
    };
    const malformed = { role: "toolResult", toolCallId: "bad", usage: { input: -1, output: NaN, cacheRead: Infinity, cacheWrite: 1.5, totalTokens: 999, cost: { input: Infinity, output: -1, cacheRead: NaN, cacheWrite: 0, total: Infinity } } };
    assert.equal(processPiEvent({ type: "message_end", message: { role: "toolResult", toolCallId: "missing" } }, result as any), false);
    assert.equal(processPiEvent({ type: "message_end", message: malformed }, result as any), false);
    assert.deepEqual((result as any).accountingUsage, emptyAccountingUsage());
    assert.deepEqual(result.messages, []);
  });

  test("accounts compaction and branch-summary generation once across lifecycle forms", () => {
    const result = {
      agent: "scout", agentSource: "user" as const, task: "summary usage", exitCode: -1,
      messages: [], stderr: "", usage: emptyUsage(), accountingUsage: emptyAccountingUsage(),
    };
    const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 } };
    const compactionResult = { summary: "compact", firstKeptEntryId: "kept", tokensBefore: 9, usage };
    const duplicateCompaction = { id: "compaction-1", ...compactionResult };
    const firstBranch = { id: "branch-1", fromId: "root", summary: "branch", usage };
    const secondBranch = { id: "branch-2", fromId: "root", summary: "branch", usage };

    assert.equal(processPiEvent({ type: "compaction_end", result: compactionResult }, result as any), false);
    assert.equal(processPiEvent({ type: "session_compact", compactionEntry: duplicateCompaction }, result as any), false);
    assert.equal(processPiEvent({ type: "extension", event: { type: "session_tree", summaryEntry: firstBranch } }, result as any), false);
    assert.equal(processPiEvent({ type: "session_tree", summaryEntry: firstBranch }, result as any), false);
    assert.equal(processPiEvent({ type: "session_tree", summaryEntry: secondBranch }, result as any), false);

    assert.deepEqual(result.messages, []);
    assert.equal(result.usage.turns, 0);
    assert.equal(result.accountingUsage.totalTokens, 9);
    assert.equal(result.accountingUsage.cost.total, 9);
  });

  test("keeps distinct no-ID summary occurrences while pairing one with its identified copy", () => {
    const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 3 } };
    const makeResult = () => ({
      agent: "scout", agentSource: "user" as const, task: "summary identity", exitCode: -1,
      messages: [], stderr: "", usage: emptyUsage(), accountingUsage: emptyAccountingUsage(),
    });
    const noId = { summary: "same compaction", firstKeptEntryId: "kept", tokensBefore: 9, usage };

    const distinctOccurrences = makeResult();
    processPiEvent({ type: "compaction_end", result: noId }, distinctOccurrences as any);
    processPiEvent({ type: "compaction_end", result: noId }, distinctOccurrences as any);
    assert.equal(distinctOccurrences.accountingUsage.totalTokens, 6);

    const pairedCopies = makeResult();
    processPiEvent({ type: "compaction_end", result: noId }, pairedCopies as any);
    processPiEvent({ type: "session_compact", compactionEntry: { id: "persisted-compaction", ...noId } }, pairedCopies as any);
    assert.equal(pairedCopies.accountingUsage.totalTokens, 3);
  });

  test("adds agent_end assistant messages even when only the latest message is present", () => {
    const result = {
      agent: "scout",
      agentSource: "user" as const,
      task: "event test",
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
    };

    processPiEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }, result as any);
    processPiEvent({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "A" }] },
    }, result as any);
    processPiEvent({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "B" }] }],
    }, result as any);

    assert.equal(result.messages.length, 2);
    assert.equal(getFinalOutput(result.messages as any), "B");
  });
});
