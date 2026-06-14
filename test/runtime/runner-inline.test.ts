import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { monitorInlineProcess } from "../../src/runtime/runner";
import { emptyUsage, getFinalOutput, normalizeCompletedResult } from "../../src/core/types";

describe("inline runner path", () => {
  test("preserves semantic completion across chunked JSONL output", async () => {
    const script = [
      'process.stdout.write("{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"DO");',
      'process.stdout.write("NE\\"}]}}\\n");',
      'setTimeout(() => {',
      '  process.stdout.write("{\\"type\\":\\"agent_end\\",\\"messages\\":[{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"DONE\\"}]}]}\\n");',
      '  process.exit(5);',
      '}, 10);',
    ].join("\n");

    const proc = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = {
      agent: "scout",
      agentSource: "user" as const,
      task: "inline test",
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
    };

    const monitored = await monitorInlineProcess(proc as any, result as any, undefined, () => {});
    result.exitCode = monitored.exitCode;
    const normalized = normalizeCompletedResult(result as any, monitored.wasAborted);

    assert.equal(monitored.wasAborted, false);
    assert.equal(normalized.exitCode, 0);
    assert.equal(getFinalOutput(normalized.messages as any), "DONE");
    assert.equal(normalized.sawAgentEnd, true);
  });
});
