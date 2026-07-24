import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  PI_SUBAGENT_AGGREGATE_COMPLETED_EVENT,
  PI_SUBAGENT_DASHBOARD_EVENT,
  PI_SUBAGENT_DETACHED_EVENT,
  createPiSubagentDashboardPublisher,
  isPiSubagentAggregateCompletedPayload,
  isPiSubagentDashboardPayload,
  isPiSubagentDetachedPayload,
  parsePiSubagentDetachedPayload,
  type PiSubagentUxSnapshotLike,
} from "../../src/integration/pi-cmux-contract";

function snapshot(generation = 0): PiSubagentUxSnapshotLike {
  return {
    generation,
    active: [{
      id: "run-1",
      agent: "worker",
      kind: "foreground",
      status: "running",
      generation,
      startedAt: 10,
      updatedAt: 11,
    }],
    recent: [],
  };
}

function terminalSnapshot(generation = 0): PiSubagentUxSnapshotLike {
  return {
    generation,
    active: [],
    recent: [{
      id: "run-1",
      agent: "worker",
      kind: "background",
      status: "completed",
      generation,
      startedAt: 10,
      updatedAt: 20,
      completedAt: 20,
    }],
  };
}

describe("Pi cmux parent event contract", () => {
  test("validates exact, bounded public payload schemas", () => {
    const dashboard = {
      version: 1,
      sessionId: "session-1",
      generation: 0,
      sequence: 1,
      emittedAt: 1,
      counts: { running: 1, cancelling: 0, completed: 0, failed: 0, cancelled: 0, schedulerActive: 1, schedulerQueued: 0, interactiveActive: 0 },
      active: [{ id: "run-1", agent: "worker", kind: "foreground", status: "running", startedAt: 1, updatedAt: 1 }],
    } as const;
    assert.equal(isPiSubagentDashboardPayload(dashboard), true);
    assert.equal(isPiSubagentDashboardPayload({ ...dashboard, task: "must not exist" }), false);
    assert.equal(isPiSubagentDashboardPayload({ ...dashboard, sessionId: "bad\nvalue" }), false);
    assert.equal(isPiSubagentDashboardPayload({ ...dashboard, sessionId: "x".repeat(257) }), false);
    assert.equal(isPiSubagentDashboardPayload({ ...dashboard, sequence: 0 }), false);
    assert.equal(isPiSubagentDashboardPayload({ ...dashboard, counts: { ...dashboard.counts, running: -1 } }), false);
    assert.equal(isPiSubagentDashboardPayload({ ...dashboard, active: [{ ...dashboard.active[0], status: "completed" }] }), false);
    assert.equal(isPiSubagentDashboardPayload({ ...dashboard, active: Array.from({ length: 65 }, () => dashboard.active[0]) }), false);

    const aggregate = {
      version: 1,
      sessionId: "session-1",
      generation: 0,
      sequence: 2,
      emittedAt: 2,
      invocation: { id: "run-1", agent: "worker", kind: "background", status: "completed", startedAt: 1, completedAt: 2 },
    } as const;
    assert.equal(isPiSubagentAggregateCompletedPayload(aggregate), true);
    assert.equal(isPiSubagentAggregateCompletedPayload({ ...aggregate, invocation: { ...aggregate.invocation, status: "running" } }), false);
    assert.equal(isPiSubagentAggregateCompletedPayload({ ...aggregate, invocation: { ...aggregate.invocation, output: "private" } }), false);
  });

  test("exports the exact detached parser contract without private target identifiers", () => {
    const detached = {
      version: 1,
      sessionId: "session-1",
      generation: 2,
      sequence: 3,
      emittedAt: 4,
      runId: "run-1",
      agent: "worker",
      backend: "cmux-pane",
      detachedAt: 4,
    } as const;
    assert.equal(PI_SUBAGENT_DETACHED_EVENT, "pi-subagent:detached:v1");
    assert.deepEqual(parsePiSubagentDetachedPayload(detached), detached);
    assert.equal(isPiSubagentDetachedPayload({ ...detached, targetId: "private-pane" }), false);
    assert.equal(isPiSubagentDetachedPayload({ ...detached, backend: "inline" }), false);
    assert.equal(isPiSubagentDetachedPayload({ ...detached, agent: "worker\u0000" }), false);
  });

  test("publishes sanitized dashboard snapshots with monotonic sequences and a 64-item active bound", () => {
    const emitted: Array<{ channel: string; payload: unknown }> = [];
    const publisher = createPiSubagentDashboardPublisher({
      emit: (channel, payload) => emitted.push({ channel, payload }),
      getSchedulerCounts: () => ({ active: 2, queued: 3 }),
      getInteractiveActiveCount: () => 4,
      now: () => 50,
    });
    publisher.startSession("session-1", 0);
    const active = Array.from({ length: 65 }, (_, index) => ({
      id: `run-${index}`,
      agent: "worker",
      kind: "foreground" as const,
      status: "running" as const,
      generation: 0,
      startedAt: index,
      updatedAt: index,
      task: "never expose",
      cwd: "/private",
      preview: "never expose",
    }));
    assert.equal(publisher.publish({ generation: 0, active, recent: [] }), true);

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].channel, PI_SUBAGENT_DASHBOARD_EVENT);
    const payload = emitted[0].payload;
    assert.equal(isPiSubagentDashboardPayload(payload), true);
    assert.deepEqual(Object.keys(payload as object).sort(), ["active", "counts", "emittedAt", "generation", "sequence", "sessionId", "version"]);
    assert.equal((payload as { active: unknown[] }).active.length, 64);
    assert.equal((payload as { counts: { running: number; schedulerActive: number; schedulerQueued: number; interactiveActive: number } }).counts.running, 65);
    assert.equal((payload as { counts: { schedulerActive: number } }).counts.schedulerActive, 2);
    assert.equal((payload as { counts: { schedulerQueued: number } }).counts.schedulerQueued, 3);
    assert.equal((payload as { counts: { interactiveActive: number } }).counts.interactiveActive, 4);
    assert.equal(JSON.stringify(payload).includes("private"), false);
  });

  test("fences stale generations, emits each terminal invocation once, and resets session state", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const publisher = createPiSubagentDashboardPublisher({
      emit: (channel, payload) => emitted.push({ channel, payload }),
      getSchedulerCounts: () => ({ active: 0, queued: 0 }),
      getInteractiveActiveCount: () => 0,
      now: () => 100,
    });
    publisher.startSession("session-1", 1);
    assert.equal(publisher.publish(snapshot(0)), false);
    assert.equal(emitted.length, 0);

    assert.equal(publisher.publish(terminalSnapshot(1)), true);
    assert.equal(publisher.publish(terminalSnapshot(1)), true);
    assert.deepEqual(emitted.map((entry) => entry.channel), [
      PI_SUBAGENT_DASHBOARD_EVENT,
      PI_SUBAGENT_AGGREGATE_COMPLETED_EVENT,
      PI_SUBAGENT_DASHBOARD_EVENT,
    ]);
    assert.deepEqual(emitted.map((entry) => entry.payload.sequence), [1, 2, 3]);
    assert.equal(publisher.rememberedTerminalCount, 1);

    publisher.startSession("session-2", 2);
    assert.equal(publisher.publish(terminalSnapshot(2)), true);
    assert.equal(emitted.at(-2)?.payload.sequence, 1);
    assert.equal(emitted.at(-1)?.channel, PI_SUBAGENT_AGGREGATE_COMPLETED_EVENT);
    assert.equal(publisher.rememberedTerminalCount, 1);
  });

  test("publishes one session-fenced detached event with the shared sequence", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const publisher = createPiSubagentDashboardPublisher({
      emit: (channel, payload) => emitted.push({ channel, payload }),
      getSchedulerCounts: () => ({ active: 0, queued: 0 }),
      getInteractiveActiveCount: () => 0,
      now: () => 10,
    });
    publisher.startSession("session-1", 3);
    assert.equal(publisher.publishDetached({ runId: "run-1", agent: "worker", backend: "tmux-pane", detachedAt: 9 }), true);
    assert.equal(publisher.publishDetached({ runId: "run-1", agent: "worker", backend: "tmux-pane", detachedAt: 9 }), false);
    assert.equal(publisher.publishDetached({ runId: "run-2", agent: "worker", backend: "inline" as any, detachedAt: 9 }), false);
    assert.deepEqual(emitted.map((entry) => entry.channel), [PI_SUBAGENT_DETACHED_EVENT]);
    assert.equal(emitted[0]?.payload.sequence, 1);
    assert.equal(emitted[0]?.payload.generation, 3);
    assert.equal(isPiSubagentDetachedPayload(emitted[0]?.payload), true);
    publisher.startSession("session-2", 4);
    assert.equal(publisher.publishDetached({ runId: "run-1", agent: "worker", backend: "cmux-pane", detachedAt: 10 }), true);
    assert.equal(emitted.at(-1)?.payload.sequence, 1);
  });

  test("bounds terminal memory and isolates emit failures from publishing", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const publisher = createPiSubagentDashboardPublisher({
      emit: (channel, payload) => emitted.push({ channel, payload }),
      getSchedulerCounts: () => ({ active: 0, queued: 0 }),
      getInteractiveActiveCount: () => 0,
      rememberedTerminalLimit: 2,
    });
    publisher.startSession("session-1", 0);
    const recent = ["one", "two", "three"].map((id, index) => ({
      id,
      agent: "worker",
      kind: "foreground" as const,
      status: "failed" as const,
      generation: 0,
      startedAt: index,
      updatedAt: index + 1,
      completedAt: index + 1,
    }));
    publisher.publish({ generation: 0, active: [], recent });
    assert.equal(publisher.rememberedTerminalCount, 2);
    assert.equal(emitted.filter((entry) => entry.channel === PI_SUBAGENT_AGGREGATE_COMPLETED_EVENT).length, 3);

    const throwingPublisher = createPiSubagentDashboardPublisher({
      emit: () => { throw new Error("listener failed"); },
      getSchedulerCounts: () => { throw new Error("scheduler failed"); },
      getInteractiveActiveCount: () => { throw new Error("interactive failed"); },
    });
    throwingPublisher.startSession("session-1", 0);
    assert.doesNotThrow(() => throwingPublisher.publish(terminalSnapshot(0)));
  });
});
