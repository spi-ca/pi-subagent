import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createNamedPipe, runCommandCapture, startJsonlPipeConsumer } from "./runner";
import { processPiJsonLine } from "./runner-events";
import { emptyUsage, getFinalOutput } from "./types";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const isPosix = process.platform !== "win32";

describe("runner FIFO helpers", () => {
  test("creates a named pipe and forwards JSONL into the parent parser", { skip: !isPosix }, async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
    tempDirs.push(tempDir);
    const pipePath = path.join(tempDir, "events.pipe");

    await createNamedPipe(pipePath);
    const stats = await fs.promises.stat(pipePath);
    assert.equal(stats.isFIFO(), true);

    const result = {
      agent: "scout",
      agentSource: "user" as const,
      task: "test",
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
    };

    const seenLines: string[] = [];
    const consumer = startJsonlPipeConsumer(pipePath, (line) => {
      seenLines.push(line);
      processPiJsonLine(line, result as any);
    });

    const writer = fs.createWriteStream(pipePath, { encoding: "utf-8" });
    writer.write(JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
      },
    }) + "\n");
    writer.write(JSON.stringify({
      type: "agent_end",
      messages: [{
        role: "assistant",
        content: [{ type: "text", text: "DONE" }],
      }],
    }) + "\n");
    writer.end();

    await consumer.completed;

    assert.equal(seenLines.length, 2);
    assert.equal(result.messages.length, 1);
    assert.equal(getFinalOutput(result.messages as any), "DONE");
    assert.equal(result.usage.turns, 1);
    assert.equal((result as any).sawAgentEnd, true);
  });

  test("marks helper commands as aborted when the abort signal fires", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50);
    const outcome = await runCommandCapture(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    assert.equal(outcome.aborted, true);
  });
});
