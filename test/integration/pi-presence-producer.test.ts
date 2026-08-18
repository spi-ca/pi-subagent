import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPresenceConsumer, EVENT_NAMES, type PresenceEventV2 } from "@pi/presence";
import { createPiSubagentPresenceProducer } from "../../src/integration/pi-presence-producer";

type Event = { name: string; payload: PresenceEventV2 };
type Status = "running" | "cancelling" | "completed" | "failed" | "cancelled";
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
const validEpoch = (value: string) => `${value}${"x".repeat(32)}`.slice(0, 32);

const snapshot = (recent: ReadonlyArray<{ id: string; status: Status; completedAt?: number }> = [], active: ReadonlyArray<{ id: string; status: "running" | "cancelling"; progress?: { completed: number; total: number } }> = [], generation = 0) => ({
  generation,
  active: active.map((item, index) => ({ ...item, generation, kind: "foreground" as const, agent: "private-agent", startedAt: index, updatedAt: index })),
  recent: recent.map((item, index) => ({ ...item, generation, kind: "foreground" as const, agent: "private-agent", startedAt: index, updatedAt: item.completedAt ?? index })),
});

function bus() {
  const events: Event[] = [];
  const listeners = new Set<(name: string, payload: unknown) => void>();
  return {
    events,
    emit: (name: string, payload: unknown) => {
      events.push({ name, payload: payload as PresenceEventV2 });
      for (const listener of [...listeners]) listener(name, payload);
    },
    listen: (listener: (name: string, payload: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

function producer(
  events: ReturnType<typeof bus>,
  scheduler = () => ({ active: 0, queued: 0 }),
  options: Partial<Parameters<typeof createPiSubagentPresenceProducer>[0]> = {},
) {
  const value = createPiSubagentPresenceProducer({
    emit: events.emit,
    getSchedulerCounts: scheduler,
    getInteractiveActiveCount: () => 0,
    ...options,
  });
  cleanup.push(() => value.stop());
  assert.equal(value.startSession("private-session", 0), true);
  return value;
}

/**
 * Production options intentionally expose no ordinal seeding. This helper uses
 * reflective private mutation only to reach wire-boundary states in this test.
 */
function seedWireOrdinalsForBoundaryTest(
  value: ReturnType<typeof createPiSubagentPresenceProducer>,
  state: Partial<{ wireGeneration: number; sequence: number; terminalOrdinal: number; opened: boolean }>,
): void {
  Object.assign(value as unknown as Record<string, unknown>, state);
}

function consumer(events: ReturnType<typeof bus>, id: "pi-cmux-presence" | "pi-herdr-presence", epoch: string) {
  const value = createPresenceConsumer({ id, sessionEpoch: validEpoch(epoch) });
  assert.ok(value);
  const accepted: PresenceEventV2[] = [];
  const unlisten = events.listen((name, payload) => {
    const event = value.accept(name, payload);
    if (event) accepted.push(event);
  });
  assert.equal(value.activate((name, ready) => events.emit(name, ready)), true);
  cleanup.push(() => { unlisten(); value.deactivate(); });
  return accepted;
}

describe("V2 subagent presence producer", () => {
  test("publishes an epoch-neutral structured aggregate with determinate progress only", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "structured-epoch");
    const value = producer(events, () => ({ active: 2, queued: 3 }));
    value.publish(snapshot([], [
      { id: "a", status: "running", progress: { completed: 1, total: 2 } },
      { id: "b", status: "cancelling", progress: { completed: 2, total: 3 } },
    ]));
    const state = events.events.find((event) => event.name === EVENT_NAMES.state)!.payload;
    assert.deepEqual(state, {
      version: 2, sessionEpoch: validEpoch("structured-epoch"), generation: 0, sequence: 0, source: "subagent", state: "running",
      progress: { completed: 3, total: 5 },
      subagents: { running: 1, cancelling: 1, queued: 3, completed: 0, failed: 0, cancelled: 0, omitted: 0 },
    });
  });

  test("assigns increasing state and terminal sequence plus private terminal dedupe ordinals", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "terminal-epoch");
    const value = producer(events);
    value.publish(snapshot([{ id: "first-private-id", status: "failed", completedAt: 1 }]));
    value.publish(snapshot([{ id: "first-private-id", status: "failed", completedAt: 1 }, { id: "second-private-id", status: "completed", completedAt: 2 }]));
    const observed = events.events.filter((event) => event.name !== EVENT_NAMES.consumerReady);
    assert.deepEqual(observed.map((event) => event.payload.sequence), [0, 1, 2, 3]);
    const terminals = observed.filter((event) => event.name === EVENT_NAMES.terminal).map((event) => event.payload as Extract<PresenceEventV2, { eventId: number }>);
    assert.deepEqual(terminals.map((event) => [event.eventId, event.outcome]), [[0, "failed"], [1, "completed"]]);
    const failureState = observed.find((event) => event.name === EVENT_NAMES.state)!.payload as Extract<PresenceEventV2, { state: string }>;
    assert.deepEqual(failureState.attention, { reason: "failure", occurrence: "new" });
  });

  test("replays retained state for consumer-first and producer-first consumers without replaying terminals", () => {
    const events = bus();
    const cmux = consumer(events, "pi-cmux-presence", "cmux-epoch");
    const value = producer(events);
    value.publish(snapshot([{ id: "failure", status: "failed", completedAt: 1 }]));
    assert.equal(cmux.filter((event) => "eventId" in event).length, 1);

    const herdr = consumer(events, "pi-herdr-presence", "herdr-epoch");
    assert.equal(herdr.length, 1, "a late consumer receives one retained state");
    assert.equal(herdr[0]!.sessionEpoch, validEpoch("herdr-epoch"));
    assert.equal("eventId" in herdr[0]!, false, "terminals are live-only");
    assert.deepEqual((herdr[0] as Extract<PresenceEventV2, { state: string }>).attention, { reason: "failure", occurrence: "retained" });
  });

  test("settles from the cached UX aggregate, then reopens with a higher wire generation", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "withdraw-epoch");
    const value = producer(events);
    value.publish(snapshot([], [{ id: "active", status: "running" }]));
    value.settle();
    assert.equal(events.events.some((event) => event.name === EVENT_NAMES.withdraw), false, "zero callback counts cannot override retained UX activity");
    value.publish(snapshot([{ id: "done", status: "completed", completedAt: 1 }]));
    const withdraw = events.events.find((event) => event.name === EVENT_NAMES.withdraw)!.payload;
    assert.equal(withdraw.sequence, 3);
    value.publish(snapshot([], [{ id: "new-active", status: "running" }]));
    const states = events.events.filter((event) => event.name === EVENT_NAMES.state).map((event) => event.payload as Extract<PresenceEventV2, { state: string }>);
    assert.deepEqual(states.map((event) => [event.generation, event.sequence]), [[0, 0], [0, 2], [1, 0]]);
  });

  test("rejects a stale UX snapshot before it can consume terminal dedupe or counts", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "generation-epoch");
    const value = producer(events);
    assert.equal(value.publish(snapshot([{ id: "terminal", status: "failed", completedAt: 1 }], [], 1)), false);
    assert.equal(value.publish(snapshot([{ id: "terminal", status: "failed", completedAt: 1 }])), true);
    const terminals = events.events.filter((event) => event.name === EVENT_NAMES.terminal);
    assert.equal(terminals.length, 1);
    const state = events.events.find((event) => event.name === EVENT_NAMES.state)!.payload as { subagents: { failed: number } };
    assert.equal(state.subagents.failed, 1);
  });

  test("counts running and cancelling at invocation granularity despite scheduler child counts", () => {
    const cases = [
      { active: [{ id: "origin", status: "running" as const }], scheduler: 1, interactive: ["origin"], expected: { running: 1, cancelling: 0 } },
      { active: [{ id: "inline", status: "running" as const }], scheduler: 1, interactive: ["old"], expected: { running: 2, cancelling: 0 } },
      { active: [{ id: "parallel", status: "running" as const }], scheduler: 2, interactive: ["parallel", "parallel"], expected: { running: 1, cancelling: 0 } },
      { active: [{ id: "origin", status: "running" as const }], scheduler: 1, interactive: [undefined], expected: { running: 2, cancelling: 0 } },
      // Three active scheduler children belong to this one cancelled parallel invocation.
      { active: [{ id: "parallel-cancelling", status: "cancelling" as const }], scheduler: 3, interactive: ["parallel-cancelling", "parallel-cancelling", "parallel-cancelling"], expected: { running: 0, cancelling: 1 } },
    ] as const;
    const events = bus();
    consumer(events, "pi-cmux-presence", "mixed-active-epoch");
    for (const item of cases) {
      const value = producer(events, () => ({ active: item.scheduler, queued: 0 }), {
        getInteractiveActiveCount: () => item.interactive.length,
        getInteractiveActiveInvocationIds: () => item.interactive,
      });
      value.publish(snapshot([], item.active));
      const state = events.events.filter((event) => event.name === EVENT_NAMES.state).at(-1)!.payload as { subagents: { running: number; cancelling: number } };
      assert.deepEqual({ running: state.subagents.running, cancelling: state.subagents.cancelling }, item.expected);
      value.stop();
    }
  });

  test("uses the complete cached aggregate for deferred and freshly quiescent settlement", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "settle-epoch");
    const value = producer(events);
    value.publish(snapshot([], [{ id: "still-running", status: "running" }]));
    value.settle();
    assert.equal(events.events.filter((event) => event.name === EVENT_NAMES.withdraw).length, 0);
    value.publish(snapshot([{ id: "done", status: "completed", completedAt: 1 }]));
    assert.equal(events.events.filter((event) => event.name === EVENT_NAMES.withdraw).length, 1, "deferred settlement withdraws only after a fresh quiescent UX projection");

    value.publish(snapshot([{ id: "later", status: "completed", completedAt: 2 }]));
    value.settle();
    assert.equal(events.events.filter((event) => event.name === EVENT_NAMES.withdraw).length, 2, "a fresh cached quiescent projection withdraws immediately");
  });

  test("dedupes against only the current recent window and emits terminals chronologically", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "recent-window-epoch");
    const value = producer(events);
    value.publish(snapshot([
      { id: "newest", status: "completed", completedAt: 20 },
      { id: "oldest", status: "failed", completedAt: 10 },
    ]));
    const terminals = events.events.filter((event) => event.name === EVENT_NAMES.terminal).map((event) => event.payload as Extract<PresenceEventV2, { outcome: string }>);
    assert.deepEqual(terminals.map((event) => event.outcome), ["failed", "completed"]);
    const state = events.events.filter((event) => event.name === EVENT_NAMES.state).at(-1)!.payload as Extract<PresenceEventV2, { state: string }>;
    assert.equal(state.state, "success");

    value.publish(snapshot());
    value.publish(snapshot([{ id: "oldest", status: "failed", completedAt: 30 }]));
    assert.equal(events.events.filter((event) => event.name === EVENT_NAMES.terminal).length, 3, "an ID that left recent is a new invocation");
  });

  test("uses one newest-first 4096-terminal window for freshness, omission, and retention", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "newest-window-epoch");
    const value = producer(events);
    const recent = [
      ...Array.from({ length: 4_096 }, (_, index) => ({ id: `eligible-${index}`, status: "completed" as const, completedAt: index })),
      { id: "omitted-terminal", status: "failed" as const, completedAt: 4_096 },
    ];

    assert.equal(value.publish(snapshot(recent)), true);
    assert.equal(events.events.filter((event) => event.name === EVENT_NAMES.terminal).length, 4_096);
    let state = events.events.filter((event) => event.name === EVENT_NAMES.state).at(-1)!.payload as { subagents: { completed: number; failed: number; omitted: number } };
    assert.equal(state.subagents.completed, 4_096);
    assert.equal(state.subagents.failed, 0);
    assert.equal(state.subagents.omitted, 1);

    assert.equal(value.publish(snapshot(recent)), true);
    assert.equal(events.events.filter((event) => event.name === EVENT_NAMES.terminal).length, 4_096, "an unchanged 4097-terminal snapshot emits no terminal twice");
    state = events.events.filter((event) => event.name === EVENT_NAMES.state).at(-1)!.payload as { subagents: { completed: number; failed: number; omitted: number } };
    assert.equal(state.subagents.completed, 4_096);
    assert.equal(state.subagents.failed, 0);
    assert.equal(state.subagents.omitted, 1);
  });

  test("continues terminal accounting after 4096 lifetime terminals without retaining an unbounded event array", () => {
    let terminalEvents = 0;
    consumer(bus(), "pi-cmux-presence", "terminal-lifetime-epoch");
    const value = createPiSubagentPresenceProducer({
      emit: (name) => { if (name === EVENT_NAMES.terminal) terminalEvents += 1; },
      getSchedulerCounts: () => ({ active: 0, queued: 0 }),
      getInteractiveActiveCount: () => 0,
    });
    cleanup.push(() => value.stop());
    assert.equal(value.startSession("private-session", 0), true);
    for (let index = 0; index <= 4_096; index += 1) value.publish(snapshot([{ id: `terminal-${index}`, status: "completed", completedAt: index }]));
    assert.equal(terminalEvents, 4_097);
  });

  test("accepts safe local UX generations solely as equality fences and starts wire generations at zero", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "large-ux-generation-epoch");
    for (const uxGeneration of [1_000_001, Number.MAX_SAFE_INTEGER]) {
      const eventOffset = events.events.length;
      const value = createPiSubagentPresenceProducer({
        emit: events.emit,
        getSchedulerCounts: () => ({ active: 0, queued: 0 }),
        getInteractiveActiveCount: () => 0,
      });
      cleanup.push(() => value.stop());
      assert.equal(value.startSession("private-session", uxGeneration), true);
      assert.equal(value.publish(snapshot([{ id: "stale", status: "failed", completedAt: 1 }], [], uxGeneration - 1)), false, "a mismatched UX generation is stale");
      assert.equal(value.publish(snapshot([{ id: "current", status: "completed", completedAt: 2 }], [], uxGeneration)), true);
      const observed = events.events.slice(eventOffset)
        .filter((event) => event.name === EVENT_NAMES.state || event.name === EVENT_NAMES.terminal)
        .map((event) => event.payload);
      assert.ok(observed.length > 0);
      assert.ok(observed.every((event) => event.generation === 0), "a fresh source handle resets bounded wire generation to zero");
      assert.ok(observed.every((event) => event.generation >= 0 && event.generation <= 1_000_000));
      assert.equal(observed.filter((event) => "eventId" in event).length, 1);
      value.stop();
    }
  });

  test("rotates source handles atomically before ordinal exhaustion and at maximum wire generation", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "ordinal-epoch");
    const value = producer(events);
    seedWireOrdinalsForBoundaryTest(value, { wireGeneration: 7, sequence: 999_998, terminalOrdinal: 1_000_000, opened: true });
    value.publish(snapshot([{ id: "boundary", status: "completed", completedAt: 1 }]));
    const observed = events.events.filter((event) => event.name !== EVENT_NAMES.consumerReady).map((event) => event.payload);
    assert.deepEqual(observed.map((event) => [event.generation, event.sequence]), [[7, 999_999], [0, 0], [0, 1]]);
    assert.equal((observed[1] as Extract<PresenceEventV2, { eventId: number }>).eventId, 0);
    value.stop();

    const maxEvents = bus();
    consumer(maxEvents, "pi-herdr-presence", "max-generation-epoch");
    const max = producer(maxEvents);
    seedWireOrdinalsForBoundaryTest(max, { wireGeneration: 1_000_000 });
    max.publish(snapshot([], [{ id: "active", status: "running" }]));
    max.publish(snapshot([{ id: "done", status: "completed", completedAt: 1 }]));
    max.settle();
    max.publish(snapshot([], [{ id: "next", status: "running" }]));
    const states = maxEvents.events
      .filter((event) => event.name === EVENT_NAMES.state && event.payload.sessionEpoch === validEpoch("max-generation-epoch"))
      .map((event) => event.payload);
    assert.deepEqual(states.map((event) => [event.generation, event.sequence]), [[1_000_000, 0], [1_000_000, 2], [0, 0]]);
  });

  test("fans out to both shared consumers and isolates throwing event buses", () => {
    const events = bus();
    const cmux = consumer(events, "pi-cmux-presence", "epoch-cmux");
    const herdr = consumer(events, "pi-herdr-presence", "epoch-herdr");
    const active = producer(events);
    active.publish(snapshot([], [{ id: "run", status: "running" }]));
    assert.equal(cmux.length, 1);
    assert.equal(herdr.length, 1);
    events.emit(EVENT_NAMES.state, {
      version: 2, sessionEpoch: validEpoch("epoch-cmux"), generation: 0, sequence: 99, source: "subagent", state: "running",
      subagents: { running: 1, cancelling: 0, queued: 0, completed: 0, failed: 0, cancelled: 0, omitted: 0 }, private: "rejected",
    });
    assert.equal(cmux.length, 1, "shared strict parser rejects malformed wire payloads");
    active.stop();

    const throwing = createPiSubagentPresenceProducer({ emit: () => { throw new Error("observer failure"); }, getSchedulerCounts: () => ({ active: 1, queued: 0 }), getInteractiveActiveCount: () => 0 });
    cleanup.push(() => throwing.stop());
    assert.doesNotThrow(() => { throwing.startSession("private-session", 5); throwing.publish(snapshot([], [{ id: "run", status: "running" }], 5)); throwing.stop(); });
  });

  test("relies on the shared parser and cannot project private data or couple to consumers/transports", () => {
    const events = bus();
    consumer(events, "pi-cmux-presence", "private-epoch");
    const value = producer(events);
    value.publish(snapshot([{ id: "invocation-id", status: "failed", completedAt: 1 }]));
    for (const { payload } of events.events) {
      const wire = JSON.stringify(payload);
      for (const forbidden of ["invocation-id", "private-agent", "private-session", "private-task", "private-output", "raw-error", "private-path", "usage", "label", "sessionId"]) assert.equal(wire.includes(forbidden), false, forbidden);
    }
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/integration/pi-presence-producer.ts"), "utf8");
    assert.match(source, /createPresenceProducer/);
    assert.doesNotMatch(source, /pi-cmux-presence|pi-herdr-presence|node:(?:net|child_process)|\b(?:spawn|exec|setInterval|setTimeout)\s*\(/);
  });
});
