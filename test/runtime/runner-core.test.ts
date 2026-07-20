import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createJsonLineChunkProcessor } from "../../src/runtime/runner-core";
import { mapConcurrent } from "../../src/runtime/runner";

describe("runner core helpers", () => {
  test("does not dequeue additional concurrent work after abort", async () => {
    const controller = new AbortController();
    const started: number[] = [];

    const results = await mapConcurrent(
      [0, 1, 2, 3],
      1,
      async (item) => {
        started.push(item);
        controller.abort();
        return item;
      },
      { signal: controller.signal },
    );

    assert.deepEqual(started, [0]);
    assert.deepEqual(Array.from(results), [0, undefined, undefined, undefined]);
  });

  test("splits chunked JSONL lines like the inline runner", () => {
    const lines: string[] = [];
    const processor = createJsonLineChunkProcessor((line) => lines.push(line));

    processor.pushChunk('{"type":"message_end"');
    processor.pushChunk(',"message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}\n');
    processor.pushChunk('{"type":"agent_end","messages":[]}');
    processor.flushRemainder();

    assert.deepEqual(lines, [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}',
      '{"type":"agent_end","messages":[]}',
    ]);
  });
});
