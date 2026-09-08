import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES,
  MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES,
  formatBoundedForegroundEnvelope,
  formatBoundedForegroundRecords,
  formatBoundedForegroundResultRecordEnvelope,
  formatBoundedForegroundResultRecords,
  formatBoundedForegroundResultSummary,
  formatBoundedForegroundThrownError,
} from "../../src/core/foreground-output";
import { emptyUsage, type SingleResult } from "../../src/core/types";

function result(agent: string, output: string): SingleResult {
  return {
    agent,
    agentSource: "user",
    task: "task",
    exitCode: 0,
    messages: [{ role: "assistant", content: [{ type: "text", text: output }] }] as any,
    stderr: "",
    usage: emptyUsage(),
  };
}

describe("foreground model-visible output bounds", () => {
  test("omits an oversized single result explicitly without slicing its body", () => {
    const secret = "secret-output-must-not-be-partially-exposed".repeat(8);
    const text = formatBoundedForegroundResultSummary(result("worker", secret), 80);
    assert.match(text, /Agent output omitted: \d+ UTF-8 bytes or \d+ lines exceeds/);
    assert.equal(text.includes(secret.slice(0, 20)), false);
  });

  test("keeps result records whole or reports one explicit aggregate omission", () => {
    const first = result("machine-id-1", "small complete output");
    const oversized = result("machine-id-2", "x".repeat(2_000));
    const text = formatBoundedForegroundResultRecords([first, oversized], 500);
    assert.match(text, /### \[machine-id-1\]\ncompleted: small complete output/);
    assert.match(text, /\[1 subagent result record omitted: the fixed model-visible output budget was exhausted/);
    assert.equal(text.includes("x".repeat(100)), false);
  });

  test("never silently slices an identifier when even its omission record cannot fit", () => {
    const identifier = "machine-identifier-".repeat(20);
    const text = formatBoundedForegroundRecords([{ identifier, body: "body" }], 180, "fixture record");
    assert.equal(text.includes(identifier.slice(0, 10)), false);
    assert.match(text, /\[1 fixture record omitted: the fixed model-visible output budget was exhausted/);
  });

  test("enforces both production byte and line limits at multibyte whole-record boundaries", () => {
    const multibyte = "😀".repeat(14_000);
    const text = formatBoundedForegroundRecords([
      { identifier: "first", body: "complete" },
      { identifier: "multibyte", body: multibyte },
      { identifier: "line-heavy", body: Array(2_100).fill("complete-line").join("\n") },
    ]);
    assert.ok(Buffer.byteLength(text, "utf8") <= MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES);
    assert.ok(text.split("\n").length <= MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES);
    assert.match(text, /### \[first\]\ncomplete/);
    assert.equal(text.includes(multibyte.slice(0, 100)), false);
    assert.equal(text.includes("complete-line\ncomplete-line"), false);
  });

  test("reserves a terminal aggregate omission instead of silently dropping near-full records", () => {
    const text = formatBoundedForegroundRecords([
      { identifier: "first", body: "complete" },
      { identifier: "second", body: "complete" },
      { identifier: "third", body: "complete" },
    ], 160, "fixture record");
    assert.match(text, /### \[first\]\ncomplete/);
    assert.match(text, /\[2 fixture records omitted:/);
    assert.equal(text.includes("### [second]"), false);
    assert.ok(Buffer.byteLength(text, "utf8") <= 160);
  });

  test("bounds >50KiB and >2,000-line unexpected execute errors without preserving a tail", () => {
    const enormous = `${"agent-or-task ".repeat(5_000)}${Array(2_001).fill("cycle").join("\n")}`;
    const text = formatBoundedForegroundThrownError(new Error(enormous));
    assert.ok(Buffer.byteLength(text, "utf8") <= MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES);
    assert.ok(text.split("\n").length <= MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES);
    assert.match(text, /Subagent error omitted/);
    assert.equal(text.includes("agent-or-task agent-or-task"), false);
  });

  test("keeps final headers and errors within the same combined bound", () => {
    const body = formatBoundedForegroundRecords([{ identifier: "worker", body: "x".repeat(MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES) }]);
    const final = formatBoundedForegroundEnvelope("Subagent error (child-execution). Parallel: 0/1 succeeded", body);
    assert.ok(Buffer.byteLength(final, "utf8") <= MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES);
    assert.ok(final.split("\n").length <= MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES);
    assert.match(final, /^Subagent error \(child-execution\)\. Parallel: 0\/1 succeeded/);
  });

  test("keeps the parallel aggregate count in the final 51,200-byte envelope", () => {
    const header = "Parallel: 1/3 succeeded";
    const aggregate = "[2 subagent result records omitted: the fixed model-visible output budget was exhausted; full structured result remains in tool details.]";
    const bodyBudget = MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES - Buffer.byteLength(header) - Buffer.byteLength("\n\n");
    const firstOutputBytes = bodyBudget - Buffer.byteLength("### [first]\ncompleted: ") - Buffer.byteLength("\n\n") - Buffer.byteLength(aggregate);
    const final = formatBoundedForegroundResultRecordEnvelope(header, [
      result("first", "x".repeat(firstOutputBytes)),
      result("second", "second output"),
      result("third", "third output"),
    ]);
    assert.equal(Buffer.byteLength(final), MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES);
    assert.equal(final.endsWith(aggregate), true);
    assert.equal(final.includes("Output records omitted"), false);
  });

  test("keeps the parallel aggregate count in the final line-limit envelope", () => {
    const header = "Parallel: 1/3 succeeded";
    const final = formatBoundedForegroundResultRecordEnvelope(header, [
      result("first", Array(1_995).fill("line").join("\n")),
      result("second", "second output"),
      result("third", "third output"),
    ], "tool-result", MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_BYTES, MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES);
    assert.equal(final.split("\n").length, MAX_FOREGROUND_MODEL_VISIBLE_OUTPUT_LINES);
    assert.match(final, /\[2 subagent result records omitted:/);
    assert.equal(final.includes("Output records omitted"), false);
  });

  test("does not promise tool details to a chain handoff or thrown error", () => {
    const record = [{ identifier: "agent", body: "x".repeat(500) }];
    for (const destination of ["chain-handoff", "thrown-error"] as const) {
      const text = formatBoundedForegroundRecords(record, 160, "fixture", destination);
      assert.equal(text.includes("tool details"), false);
      assert.match(text, /unavailable to this chain handoff|unavailable from this thrown error/);
    }
  });
});
