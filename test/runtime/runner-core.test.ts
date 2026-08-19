import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createJsonLineChunkProcessor } from "../../src/runtime/runner-core";
import { mapConcurrent, runCommandCapture } from "../../src/runtime/runner";

describe("runner core helpers", () => {
  for (const count of [17, 50]) test(`bounds N=${count} work to 16 workers and preserves result indexes`, async () => {
    let active = 0;
    let peak = 0;
    const results = await mapConcurrent(
      Array.from({ length: count }, (_, index) => index),
      16,
      async (item, index) => {
        active += 1;
        peak = Math.max(peak, active);
        // Yield twice so all initially admitted workers overlap deterministically.
        await Promise.resolve();
        await Promise.resolve();
        active -= 1;
        return `${index}:${item}`;
      },
    );

    assert.ok(peak <= 16);
    assert.deepEqual(results, Array.from({ length: count }, (_, index) => `${index}:${index}`));
  });

  for (const count of [17, 50]) test(`does not dequeue N=${count} work after an abort`, async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const results = await mapConcurrent(
      Array.from({ length: count }, (_, index) => index),
      16,
      async (item) => {
        started.push(item);
        controller.abort();
        return item;
      },
      { signal: controller.signal },
    );

    assert.deepEqual(started, [0]);
    assert.deepEqual(Array.from(results), [0, ...Array(count - 1).fill(undefined)]);
  });

  test("clears runCommandCapture SIGKILL escalation on early process settlement", async () => {
    if (process.platform === "win32") return;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timer = { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    let created = false;
    let cleared = false;
    try {
      (globalThis as any).setTimeout = (callback: () => void, delay?: number) => {
        if (delay === 5_000) {
          created = true;
          return timer;
        }
        return originalSetTimeout(callback, delay);
      };
      (globalThis as any).clearTimeout = (value: unknown) => {
        if (value === timer) cleared = true;
        else originalClearTimeout(value as ReturnType<typeof setTimeout>);
      };
      const controller = new AbortController();
      const pending = runCommandCapture(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
      controller.abort();
      const result = await pending;
      assert.equal(result.aborted, true);
      assert.equal(created, true);
      assert.equal(cleared, true);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
      (globalThis as any).clearTimeout = originalClearTimeout;
    }
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
