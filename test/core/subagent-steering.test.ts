import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { SubagentParams, validateSubagentInvocation, createBackgroundJobRecord, snapshotBackgroundJob, cancelBackgroundJobs, finalizeBackgroundJobForSession, steerBackgroundJob } from "../../src/core/subagent-config";
import { withSubagentStructuredContent, SubagentOutputSchema } from "../../src/core/structured-result";
import { buildBackgroundJobDetailSummary, parseBackgroundJobActionDetails } from "../../src/core/background-job-details";

describe("steering invocation contract", () => {
  test("strict small message/action shape, no coercion, no implicit broadcast", () => {
    const valid = { action: "steer", id: "12345678-1234-4234-8234-123456789012", message: "Keep context; focus on tests." };
    assert.equal(Value.Check(SubagentParams, valid), true);
    assert.equal(validateSubagentInvocation(valid), null);
    for (const raw of [
      { ...valid, id: undefined }, { ...valid, message: undefined }, { ...valid, message: " " },
      { ...valid, message: 12 }, { ...valid, message: "a".repeat(513) }, { ...valid, message: "한".repeat(171) },
      { ...valid, background: false }, { ...valid, agent: "worker", task: "task" },
      { ...valid, tasks: [{ agent: "worker", task: "task" }] }, { ...valid, chain: [{ agent: "worker", task: "task" }] },
      { action: "status", message: "secret" }, { agent: "worker", task: "task", message: "secret" },
    ]) {
      const error = validateSubagentInvocation(raw);
      assert.ok(error);
      assert.equal(error.message.includes("secret"), false);
    }
    assert.equal(validateSubagentInvocation({ ...valid, message: "\0".repeat(512) }), null, "JSON escaping is bounded by the socket frame cap");
  });

  test("live callbacks never appear in snapshots and are deleted on cancel/finalization", async () => {
    const job = createBackgroundJobRecord({ mode: "single" });
    job.steer = async () => "submitted";
    assert.equal("steer" in snapshotBackgroundJob(job), false);
    const registry = new Map([[job.id, job]]);
    cancelBackgroundJobs(registry, job.id);
    assert.equal(job.steer, undefined);
    job.steer = async () => "submitted";
    finalizeBackgroundJobForSession({ job, registry, sessionToken: 1, isSessionCurrent: () => true, onFinalized: () => undefined });
    assert.equal(job.steer, undefined);
    assert.equal(job.controller, undefined);
  });

  test("exact routing rejects fan-out, terminal, startup, stale and unavailable jobs without calling a transport", async () => {
    let calls = 0;
    for (const mode of ["single", "parallel", "chain"] as const) {
      const job = createBackgroundJobRecord({ mode });
      job.steer = async (message) => { calls += 1; assert.equal(message, "only message"); return "submitted"; };
      const registry = new Map([[job.id, job]]);
      assert.equal(await steerBackgroundJob(registry, job.id.slice(0, 8), "only message", () => true), "not-found");
      assert.equal(await steerBackgroundJob(registry, job.id, "only message", () => false), "unavailable");
      assert.equal(await steerBackgroundJob(registry, job.id, "only message", () => true), mode === "single" ? "submitted" : "unsupported");
      job.status = "completed";
      assert.equal(await steerBackgroundJob(registry, job.id, "only message", () => true), mode === "single" ? "unavailable" : "unsupported");
    }
    assert.equal(calls, 1);
    const queued = createBackgroundJobRecord({ mode: "single" });
    assert.equal(await steerBackgroundJob(new Map([[queued.id, queued]]), queued.id, "startup", () => true), "unavailable");
  });

  test("cancel, completion, replacement and failed transport never return a false submitted ACK", async () => {
    for (const race of ["cancel", "completion", "replacement", "session"]) {
      const job = createBackgroundJobRecord({ mode: "single" });
      let resolve!: (outcome: "submitted") => void;
      job.steer = () => new Promise((done) => { resolve = done; });
      const registry = new Map([[job.id, job]]);
      let current = true;
      const result = steerBackgroundJob(registry, job.id, "message", () => current);
      if (race === "cancel") cancelBackgroundJobs(registry, job.id);
      if (race === "completion") job.status = "completed";
      if (race === "replacement") registry.delete(job.id);
      if (race === "session") current = false;
      resolve("submitted");
      assert.equal(await result, "unknown");
    }
    const job = createBackgroundJobRecord({ mode: "single" });
    job.steer = async () => { throw new Error("raw child error or secret token"); };
    assert.equal(await steerBackgroundJob(new Map([[job.id, job]]), job.id, "message", () => true), "unknown");
  });

  test("steer structured result reports only submission, with no message/transport material", () => {
    const job = createBackgroundJobRecord({ mode: "single" });
    const details = { kind: "subagent.background-job", version: 1, event: "steering-submitted", job: buildBackgroundJobDetailSummary(snapshotBackgroundJob(job)) };
    assert.ok(parseBackgroundJobActionDetails(details));
    const result = withSubagentStructuredContent({ content: [{ type: "text", text: "submission only" }], details });
    assert.equal(result.structuredContent.operation, "steer");
    assert.equal(Value.Check(SubagentOutputSchema, result.structuredContent), true);
    assert.equal(JSON.stringify(result).includes("message"), false);
  });
});
