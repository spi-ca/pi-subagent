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
      { action: "status", childId: "secret" }, { action: "cancel", childId: "secret" },
      { agent: "worker", task: "task", childId: "secret" }, { ...valid, childId: 1 },
      { ...valid, childId: " " }, { ...valid, childId: "a".repeat(129) },
    ]) {
      const error = validateSubagentInvocation(raw);
      assert.ok(error);
      assert.equal(error.message.includes("secret"), false);
    }
    assert.equal(validateSubagentInvocation({ ...valid, childId: valid.id }), null);
    assert.equal(Value.Check(SubagentParams, { ...valid, childId: valid.id }), true);
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

  test("dispatch eligibility follows session/job cancellation while known UNSENT outcomes stay unavailable", async () => {
    for (const race of ["cancel", "completion", "replacement", "session"]) {
      const job = createBackgroundJobRecord({ mode: "single" });
      let dispatch!: () => void;
      job.steer = (_message, eligible) => new Promise(resolve => {
        dispatch = () => resolve(eligible!() ? "submitted" : "unavailable");
      });
      const registry = new Map([[job.id, job]]);
      let current = true;
      const pending = steerBackgroundJob(registry, job.id, "waiting", () => current);
      if (race === "cancel") cancelBackgroundJobs(registry, job.id);
      if (race === "completion") job.status = "completed";
      if (race === "replacement") registry.delete(job.id);
      if (race === "session") current = false;
      dispatch();
      assert.equal(await pending, "unavailable", race);
    }
  });

  test("exact leaf routing never infers, broadcasts, or borrows a sibling/job authority", async () => {
    for (const mode of ["single", "parallel", "chain"] as const) {
      const job = createBackgroundJobRecord({ mode });
      const other = createBackgroundJobRecord({ mode });
      const registry = new Map([[job.id, job], [other.id, other]]);
      const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
      const calls: string[] = [];
      const leaves = ids.map(childId => ({ metadata: { childId, agent: "same-label", stageIndex: 0, taskIndex: 0 },
        steer: Object.assign(async () => { calls.push(childId); return "submitted" as const; }, { isAvailable: (): boolean => true }) }));
      job.activeLeaves = new Map(ids.map((id, i) => [id, leaves[i]!]));
      other.activeLeaves = new Map([["other-child", { ...leaves[0]!, metadata: { childId: "other-child", agent: "same-label" } }]]);
      for (const id of [ids[0]!.slice(0, 8), ` ${ids[0]}`, "future", "other-child", "same-label", job.id]) {
        assert.equal(await steerBackgroundJob(registry, job.id, "message", () => true, id), "unavailable");
      }
      assert.equal(await steerBackgroundJob(registry, job.id, "message", () => true, ids[1]), "submitted");
      assert.deepEqual(calls, [ids[1]]);
      // An installed handle without authenticated running activity is not eligible.
      leaves[0]!.steer.isAvailable = () => false;
      assert.equal(await steerBackgroundJob(registry, job.id, "message", () => true, ids[0]), "unavailable");
      const snap = snapshotBackgroundJob(job);
      assert.deepEqual(snap.liveLeaves?.map(leaf => leaf.steerable), [false, true]);
      assert.equal("activeLeaves" in snap, false);
      job.activeLeaves.delete(ids[1]!);
      assert.equal(await steerBackgroundJob(registry, job.id, "message", () => true, ids[1]), "unavailable", "ended leaf cannot target sibling");
      cancelBackgroundJobs(registry, job.id);
      assert.equal(job.activeLeaves, undefined);
      assert.equal(snapshotBackgroundJob(job).liveLeaves, undefined);
    }
  });

  test("leaf/handle replacement and removal fence both queued dispatch and awaited ACK", async () => {
    for (const race of ["leaf-replaced", "handle-replaced", "removed", "cancel", "terminal", "session"] as const) {
      for (const sent of [false, true]) {
        const job = createBackgroundJobRecord({ mode: "chain" });
        const registry = new Map([[job.id, job]]);
        const childId = "11111111-1111-4111-8111-111111111111";
        let settle!: () => void;
        const leaf = { metadata: { childId, agent: "a" }, steer: (_message: string, eligible?: () => boolean) => new Promise<"submitted" | "unavailable">(resolve => {
          settle = () => resolve(sent || eligible!() ? "submitted" : "unavailable");
        }) };
        job.activeLeaves = new Map([[childId, leaf]]);
        let current = true;
        const pending = steerBackgroundJob(registry, job.id, "message", () => current, childId);
        if (race === "leaf-replaced") job.activeLeaves.set(childId, { ...leaf });
        if (race === "handle-replaced") leaf.steer = async () => "submitted";
        if (race === "removed") job.activeLeaves.delete(childId);
        if (race === "cancel") cancelBackgroundJobs(registry, job.id);
        if (race === "terminal") job.status = "completed";
        if (race === "session") current = false;
        settle();
        assert.equal(await pending, sent ? "unknown" : "unavailable", `${race} sent=${sent}`);
      }
    }
  });

  for (const mode of ["single", "parallel", "chain"] as const) {
    for (const ack of ["submitted", "rejected"] as const) {
      test(`${mode} deferred ${ack} ACK fails closed when unchanged handle availability is revoked`, async () => {
        const job = createBackgroundJobRecord({ mode });
        const registry = new Map([[job.id, job]]);
        const childId = "11111111-1111-4111-8111-111111111111";
        for (const revocation of ["unavailable", "throws"] as const) {
          let available = true;
          let settle!: (outcome: typeof ack) => void;
          const handle = Object.assign(() => new Promise<typeof ack>(resolve => { settle = resolve; }), {
            isAvailable: () => { if (!available && revocation === "throws") throw Error("private authority failure"); return available; },
          });
          const leaf = { metadata: { childId, agent: "a" }, steer: handle };
          job.steer = handle;
          job.activeLeaves = new Map([[childId, leaf]]);
          const pending = steerBackgroundJob(registry, job.id, "message", () => true, mode === "single" ? undefined : childId);
          available = false;
          settle(ack);
          assert.equal(await pending, "unknown", revocation);
          assert.equal(registry.get(job.id), job);
          assert.equal(job.activeLeaves.get(childId), leaf);
          assert.equal(leaf.steer, handle, "identity never changes during availability revocation");
        }
      });
    }
  }

  test("availability participates in queued eligibility without relabeling known unsent outcomes", async () => {
    for (const outcome of ["unavailable", "busy", "queue-full"] as const) {
      const job = createBackgroundJobRecord({ mode: "single" });
      let available = true;
      let dispatch!: () => void;
      job.steer = Object.assign((_message: string, eligible?: () => boolean) => new Promise<typeof outcome>(resolve => {
        dispatch = () => { assert.equal(eligible!(), false); resolve(outcome); };
      }), { isAvailable: () => available });
      const pending = steerBackgroundJob(new Map([[job.id, job]]), job.id, "waiting", () => true);
      available = false;
      dispatch();
      assert.equal(await pending, outcome);
    }
  });

  test("authority observation exceptions before dispatch fail closed without transport", async () => {
    const job = createBackgroundJobRecord({ mode: "single" });
    let calls = 0;
    job.steer = Object.assign(async () => { calls++; return "submitted" as const; }, {
      isAvailable: () => { throw Error("private authority failure"); },
    });
    const registry = new Map([[job.id, job]]);
    assert.equal(await steerBackgroundJob(registry, job.id, "message", () => true), "unavailable");
    assert.equal(await steerBackgroundJob(registry, job.id, "message", () => { throw Error("private session failure"); }), "unavailable");
    assert.equal(calls, 0);
  });

  test("nested leaf projection bounds rows/escaped bytes with truthful omissions and no callbacks", () => {
    const job = createBackgroundJobRecord({ mode: "parallel" });
    job.activeLeaves = new Map(Array.from({ length: 50 }, (_, index) => {
      const childId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return [childId, { metadata: { childId, agent: "\"".repeat(3000), stageLabel: "\"".repeat(3000), taskIndex: index }, steer: async () => "submitted" as const }];
    }));
    const snapshot = snapshotBackgroundJob(job);
    assert.equal(snapshot.liveLeaves?.length, 32);
    assert.equal(snapshot.omittedLeaves, 18);
    const summary = buildBackgroundJobDetailSummary(snapshot);
    const result = withSubagentStructuredContent({ details: { kind: "subagent.background-job", version: 1, event: "status", job: summary } });
    assert.equal(Value.Check(SubagentOutputSchema, result.structuredContent), true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.structuredContent)) <= 65536);
    const projected = result.structuredContent.jobs[0]!;
    assert.equal(projected.liveLeaves!.length + projected.omittedLeaves!, 50);
    assert.equal(projected.clipped, true);
    assert.equal(projected.liveLeaves!.every(leaf => leaf.clipped), true);
    assert.doesNotMatch(JSON.stringify(result), /controller|activeLeaves|isAvailable/);
    assert.ok(parseBackgroundJobActionDetails({ kind: "subagent.background-job", version: 1, event: "status", job: summary }));
    finalizeBackgroundJobForSession({ job, registry: new Map([[job.id, job]]), sessionToken: 1, isSessionCurrent: () => true, onFinalized: () => {} });
    assert.equal(job.activeLeaves, undefined);
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
