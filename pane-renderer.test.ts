import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createNamedPipe, startJsonlPipeConsumer } from "./runner";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const isPosix = process.platform !== "win32";

describe("pane-renderer CLI", () => {
  test("mirrors raw JSONL into FIFO and renders readable output", { skip: !isPosix }, async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-renderer-"));
    tempDirs.push(tempDir);
    const pipePath = path.join(tempDir, "events.pipe");
    await createNamedPipe(pipePath);

    const lines: string[] = [];
    const consumer = startJsonlPipeConsumer(pipePath, (line) => lines.push(line));
    const proc = spawn(process.execPath, ["./pane-renderer.js", pipePath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.stdin.write('{"type":"message_start","message":{"role":"assistant","content":[]}}\n');
    proc.stdin.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hel"}}\n');
    proc.stdin.write('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"lo"}}\n');
    proc.stdin.write('{"type":"tool_execution_start","toolCallId":"call-1","toolName":"read","args":{"path":"README.md"}}\n');
    proc.stdin.write('{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}\n');
    proc.stdin.end();

    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.on("error", reject);
      proc.on("close", (code) => resolve(code ?? 0));
    });
    await consumer.completed;

    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.match(stdout, /Hello\n→ read README\.md\n/);
    assert.deepEqual(lines, [
      '{"type":"message_start","message":{"role":"assistant","content":[]}}',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hel"}}',
      '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"lo"}}',
      '{"type":"tool_execution_start","toolCallId":"call-1","toolName":"read","args":{"path":"README.md"}}',
      '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]}}',
    ]);
  });
});
