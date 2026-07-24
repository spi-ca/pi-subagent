import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  SubagentUxRegistry,
  formatSubagentUxCompactStatus,
  formatSubagentUxDetail,
  formatSubagentUxFooter,
  formatSubagentUxList,
  parseSubagentsCommand,
} from "../../src/core/subagent-ux";

describe("SubagentUxRegistry", () => {
  test("keeps only sanitized immutable presentation snapshots", () => {
    let now = 10;
    const registry = new SubagentUxRegistry({ now: () => now, createId: () => "job-1" });
    const job = registry.start({
      agent: "\x1b[31mwor\u202eker\x1b[0m\n",
      kind: "background",
      task: "do not expose this",
      path: "/secret/path",
      secret: "do not expose this either",
    });

    assert.deepEqual(job, {
      id: "job-1",
      agent: "worker",
      kind: "background",
      status: "running",
      generation: 0,
      startedAt: 10,
      updatedAt: 10,
    });
    assert.ok(Object.isFrozen(job));
    assert.equal(JSON.stringify(job).includes("secret"), false);
    assert.equal(JSON.stringify(job).includes("task"), false);
    assert.equal(JSON.stringify(job).includes("path"), false);

    now = 12;
    const completed = registry.complete("job-1")!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.completedAt, 12);
    assert.deepEqual(registry.snapshot().active, []);
    assert.equal(registry.snapshot().recent[0]?.id, "job-1");
  });

  test("validates generation-fenced determinate progress and completes it on terminal state", () => {
    let now = 0;
    const registry = new SubagentUxRegistry({ now: () => ++now, createId: () => "progress" });
    const job = registry.start({ agent: "worker", kind: "foreground", progressTotal: 3 });
    assert.deepEqual(job.progress, { completed: 0, total: 3 });
    assert.equal(registry.updateProgress(job.id, 2, 3)?.progress?.completed, 2);
    assert.equal(registry.updateProgress(job.id, 4, 3), undefined);
    assert.equal(registry.updateProgress(job.id, 1, 0), undefined);
    assert.equal(registry.updateProgress(job.id, 1, 3, registry.captureGeneration() + 1), undefined);
    assert.deepEqual(registry.complete(job.id)?.progress, { completed: 3, total: 3 });
    assert.throws(() => registry.start({ id: "invalid-progress", agent: "worker", kind: "foreground", progressTotal: 0 }), /progressTotal/);
  });

  test("uses exact full IDs and makes cancellation idempotent", () => {
    let now = 1;
    const ids = ["full-id-one", "full-id-two"];
    const registry = new SubagentUxRegistry({ now: () => ++now, createId: () => ids.shift()! });
    let cancelled = 0;
    registry.start({ agent: "one", kind: "foreground", cancel: () => { cancelled += 1; } });
    registry.start({ agent: "two", kind: "background" });

    assert.deepEqual(registry.cancel("full-id"), { found: false, changed: false });
    const first = registry.cancel("full-id-one");
    assert.equal(first.found, true);
    assert.equal(first.changed, true);
    assert.equal(first.snapshot?.status, "cancelling");
    assert.equal(cancelled, 1);
    const repeated = registry.cancel("full-id-one");
    assert.equal(repeated.found, true);
    assert.equal(repeated.changed, false);
    assert.equal(repeated.snapshot?.status, "cancelling");
    assert.equal(cancelled, 1);

    assert.equal(registry.cancelled("full-id-one")?.status, "cancelled");
    assert.equal(registry.cancel("full-id-one").changed, false);
  });

  test("bounds recent history, emits immutable observer state, and fences a reset generation", () => {
    let now = 0;
    let id = 0;
    const registry = new SubagentUxRegistry({ recentLimit: 1, now: () => ++now, createId: () => `job-${++id}` });
    const observed: number[] = [];
    const unsubscribe = registry.subscribe((snapshot) => {
      assert.ok(Object.isFrozen(snapshot));
      assert.ok(Object.isFrozen(snapshot.active));
      observed.push(snapshot.generation);
    });

    const first = registry.start({ agent: "first", kind: "foreground" });
    const token = registry.captureGeneration();
    const second = registry.start({ agent: "second", kind: "background" });
    registry.fail(second.id);
    registry.complete(first.id);
    assert.deepEqual(registry.snapshot().recent.map((job) => job.id), ["job-1"]);

    assert.equal(registry.reset(), 1);
    assert.equal(registry.complete(second.id, token), undefined);
    assert.deepEqual(registry.list(), []);
    unsubscribe();
    registry.start({ agent: "third", kind: "foreground" });
    assert.equal(observed.length, 5);
  });
});

describe("subagents command and status formatting", () => {
  test("parses only complete supported commands", () => {
    assert.deepEqual(parseSubagentsCommand(""), { kind: "list" });
    assert.deepEqual(parseSubagentsCommand("  list  "), { kind: "list" });
    assert.deepEqual(parseSubagentsCommand("doctor"), { kind: "doctor" });
    assert.deepEqual(parseSubagentsCommand("cancel full-id"), { kind: "cancel", id: "full-id" });
    for (const kind of ["details", "focus", "keep", "promote"] as const) assert.deepEqual(parseSubagentsCommand(`${kind} full-id`), { kind, id: "full-id" });
    for (const invalid of ["status", "list now", "doctor now", "cancel", "cancel full id", "cancel full-id now", "Cancel full-id", "cancel bad\u202eid", "cancel bad\u061cid", "cancel bad\u200fid"]) {
      assert.equal(parseSubagentsCommand(invalid), null, invalid);
    }
  });

  test("formats list, detail, and compact output without terminal controls in labels", () => {
    const job = new SubagentUxRegistry({ now: () => 5, createId: () => "job-1" })
      .start({ agent: "\x1b]8;;https://example.test\x07agent\x1b]8;;\x07\r\n", kind: "foreground" });
    const registry = new SubagentUxRegistry({ now: () => 6, createId: () => "preview" });
    const previewJob = registry.start({ agent: "preview", kind: "background" });
    registry.updatePreview(previewJob.id, "\x1b[31mworking\u202e now\nsecret-free\x1b[0m");
    const previewDetail = formatSubagentUxDetail(registry.get(previewJob.id)!);
    assert.match(previewDetail, /preview: working now secret-free/);
    assert.doesNotMatch(previewDetail, /\x1b|\u202e/);
    const compact = formatSubagentUxCompactStatus(job);
    const list = formatSubagentUxList([job]);
    const detail = formatSubagentUxDetail(job);

    for (const text of [compact, list, detail]) assert.doesNotMatch(text, /\x1b|\r|[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    assert.match(compact, /job-1 \[running\] foreground agent/);
    assert.match(list, /^- /);
    assert.match(detail, /^Subagent job-1/m);
    assert.equal(formatSubagentUxList([]), "No subagents.");
    assert.equal(formatSubagentUxFooter({ generation: 0, active: [job], recent: [] }), "subagents: ●1 ✓0 ✕0");
    assert.equal(formatSubagentUxFooter({ generation: 0, active: [], recent: [] }), undefined);
  });
});
