import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getResultSummaryText, processPiEvent } from "../../src/core/runner-events";
import { emptyUsage, getFinalOutput } from "../../src/core/types";

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
