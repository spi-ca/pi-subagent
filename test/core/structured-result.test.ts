import { test } from "bun:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { SubagentOutputSchema, withSubagentStructuredContent, STRUCTURED_RESULT_MAX_BYTES } from "../../src/core/structured-result";
import { emptyUsage, type SingleResult } from "../../src/core/types";
import { buildBackgroundJobDetailSummary } from "../../src/core/background-job-details";

const result = (output = "actual output"): SingleResult => ({
  agent: "worker", agentSource: "user", task: "private task", exitCode: 0, stderr: "private stderr", usage: emptyUsage(),
  messages: [{ role: "assistant", content: [{ type: "text", text: output }], timestamp: 0 } as any],
});
for (const mode of ["single", "parallel", "chain"] as const) test(`structured ${mode} data comes from results, not human text`, () => {
  const original = { content: [{ type: "text", text: "misleading human output" }], usage: { input: 5 }, details: {
    mode, toolLabel: "Subagent", delegationMode: "fork", terminalMode: "inline", projectAgentsDir: null,
    results: [result()], chainStageCount: 2, chainCompletedCount: 1,
  } };
  const actual = withSubagentStructuredContent(original);
  assert.equal(Value.Check(SubagentOutputSchema, actual.structuredContent), true);
  assert.equal(actual.structuredContent.operation, mode);
  assert.equal(actual.structuredContent.results[0].output, "actual output");
  assert.equal(actual.content, original.content); assert.equal(actual.details, original.details); assert.equal(actual.usage, original.usage);
  assert.equal(JSON.stringify(actual.structuredContent).includes("private task"), false);
});
for (const event of ["accepted", "status", "status-list", "cancel-list", "cancellation-requested", "already-terminal"] as const) test(`structured background ${event}`, () => {
  const job = buildBackgroundJobDetailSummary({ id: "54ab6219-8862-40da-922c-15663c41d895", status: event === "cancellation-requested" ? "cancelling" : "running", startedAt: 1, result: { content: [{ type: "text", text: "producer result" }], details: undefined } } as any);
  const details = { kind: "subagent.background-job", version: 1, event, ...(event.endsWith("-list") ? { jobs: [job] } : { job }) };
  const actual = withSubagentStructuredContent({ content: [], details });
  assert.equal(Value.Check(SubagentOutputSchema, actual.structuredContent), true);
  assert.equal(actual.structuredContent.jobs[0].jobId, job.jobId);
  assert.equal(actual.structuredContent.jobs[0].output, "producer result");
  assert.equal(actual.structuredContent.operation, event === "accepted" ? "background" : event === "status" || event === "status-list" ? "status" : "cancel");
});
test("structured data caps rows and JSON-escaped byte size without changing details or error flags", () => {
  const details = { mode: "parallel", results: Array.from({ length: 256 }, () => ({ ...result("\u0000".repeat(10000)), agent: "a".repeat(10000), errorMessage: "e".repeat(10000) })) };
  const actual = withSubagentStructuredContent({ content: [], details, isError: true });
  assert.equal(Value.Check(SubagentOutputSchema, actual.structuredContent), true);
  assert.ok(Buffer.byteLength(JSON.stringify(actual.structuredContent)) <= STRUCTURED_RESULT_MAX_BYTES);
  assert.ok(actual.structuredContent.results.length <= 32);
  assert.equal(actual.structuredContent.omittedResults, 256 - actual.structuredContent.results.length);
  assert.equal(actual.structuredContent.clipped, true);
  assert.equal(actual.details, details); assert.equal(actual.isError, true);
});

test("machine output preserves text-block selection and Unicode prefix boundaries without a full transcript join", () => {
  const source = result();
  (source.messages[0] as any).content = [{ type: "text", text: "" }, { type: "text", text: "a" }, { type: "text", text: "b" }];
  const details = { mode: "single", results: [source] };
  assert.equal(withSubagentStructuredContent({ details }).structuredContent.results[0].output, "a\nb");
  (source.messages[0] as any).content = [{ type: "text", text: "a".repeat(2047) + "😀" + "suffix" }];
  const machine = withSubagentStructuredContent({ details }).structuredContent.results[0];
  assert.equal(machine.output, "a".repeat(2047)); assert.equal(machine.clipped, true);
});
