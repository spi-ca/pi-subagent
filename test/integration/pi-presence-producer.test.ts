import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  MAX_PRESENCE_COUNT,
  PI_PRESENCE_READY_EVENT,
  PI_PRESENCE_UPDATE_EVENT,
  createPiSubagentPresenceProducer,
  isPiCmuxPresenceCmuxStatusReady,
  parsePiPresenceReady,
  parsePiPresenceUpdate,
} from "../../src/integration/pi-presence-producer";

const update = {
  version: 1, sessionId: "session-1", generation: 0, sequence: 1,
  source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "idle",
  counts: { active: 0, completed: 0, failed: 0 },
} as const;
const snapshot = (generation = 0, recent: any[] = [], active: any[] = []) => ({ generation, active, recent });

describe("pi presence producer wire contract", () => {
  test("strictly parses bounded, private-data-free update and ready DTOs", () => {
    assert.deepEqual(parsePiPresenceUpdate(update), update);
    assert.equal(parsePiPresenceUpdate({ ...update, task: "private" }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, sessionId: "bad\nvalue" }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, source: { ...update.source, label: "\u202Espoof" } }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, counts: { ...update.counts, active: MAX_PRESENCE_COUNT + 1 } }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, progress: { value: 1.1 } }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, usage: { tokens: -1 } }), null);
    assert.deepEqual(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status"] } }), { version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status"] } });
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "x", capabilities: Array(17).fill("x") } }), null);
    assert.equal(isPiCmuxPresenceCmuxStatusReady({ version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status"] } }), true);
    assert.equal(isPiCmuxPresenceCmuxStatusReady({ version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-progress"] } }), false);
    assert.equal(isPiCmuxPresenceCmuxStatusReady({ version: 1, sessionId: "session-1", consumer: { id: "other", capabilities: ["cmux-status"] } }), false);

    const throwing = new Proxy({}, { get() { throw new Error("no getter execution"); } });
    assert.equal(parsePiPresenceUpdate(throwing), null);
    assert.equal(parsePiPresenceReady(throwing), null);
  });

  test("fences session/generation, replays only after a snapshot, and removes attention on replay", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const listeners = new Map<string, (value: unknown) => void>();
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => emitted.push({ channel, payload }),
      on: (channel, handler) => { listeners.set(channel, handler); return () => listeners.delete(channel); },
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    assert.equal(producer.startSession("session-1", 2), true);
    listeners.get(PI_PRESENCE_READY_EVENT)!({ version: 1, sessionId: "session-1" });
    assert.equal(emitted.length, 0);
    assert.equal(producer.publish(snapshot(1)), false);
    assert.equal(producer.publish(snapshot(2)), true);
    listeners.get(PI_PRESENCE_READY_EVENT)!({ version: 1, sessionId: "other" });
    assert.equal(emitted.length, 1);
    listeners.get(PI_PRESENCE_READY_EVENT)!({ version: 1, sessionId: "session-1" });
    assert.equal(emitted.length, 2);
    assert.equal(emitted[0]!.channel, PI_PRESENCE_UPDATE_EVENT);
    assert.deepEqual(emitted.map((entry) => entry.payload.sequence), [1, 2]);
    assert.equal(emitted[1]!.payload.attention, "none");
    producer.stop();
    assert.equal(listeners.size, 0);
  });

  test("advertises the exact cmux consumer only as a one-shot passive routing hint", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    let hints = 0;
    const producer = createPiSubagentPresenceProducer({
      emit: () => {}, on: (channel, handler) => { listeners.set(channel, handler); return () => listeners.delete(channel); },
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
      onCmuxStatusConsumer: () => { hints += 1; },
    });
    producer.startSession("session-1", 0);
    const ready = { version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status"] } };
    listeners.get(PI_PRESENCE_READY_EVENT)!({ ...ready, sessionId: "other" });
    listeners.get(PI_PRESENCE_READY_EVENT)!({ ...ready, consumer: { id: "other", capabilities: ["cmux-status"] } });
    listeners.get(PI_PRESENCE_READY_EVENT)!(ready);
    listeners.get(PI_PRESENCE_READY_EVENT)!(ready);
    assert.equal(hints, 1);
  });

  test("keeps cumulative terminal counts after UX recent history is pruned and isolates observer failures", () => {
    const emitted: any[] = [];
    const producer = createPiSubagentPresenceProducer({
      emit: (_channel, payload) => emitted.push(payload), getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    producer.startSession("session-1", 0);
    const one = { id: "one", status: "completed", generation: 0, kind: "foreground", agent: "safe", startedAt: 1, updatedAt: 2, completedAt: 2, progress: { completed: 1, total: 1 } };
    const two = { ...one, id: "two", status: "failed", startedAt: 3, updatedAt: 4, completedAt: 4 };
    producer.publish(snapshot(0, [one]));
    producer.publish(snapshot(0, [two])); // one has been pruned from registry history
    assert.deepEqual(emitted.map((event) => event.counts.completed), [1, 1]);
    assert.deepEqual(emitted.map((event) => event.counts.failed), [0, 1]);
    assert.equal(emitted[0].attention, "success");
    assert.equal(emitted[1].attention, "error");

    const throwing = createPiSubagentPresenceProducer({ emit: () => { throw new Error("listener"); }, getSchedulerCounts: () => { throw new Error("scheduler"); }, getInteractiveActiveCount: () => { throw new Error("interactive"); } });
    throwing.startSession("session-1", 0);
    assert.doesNotThrow(() => throwing.publish(snapshot()));
  });
});
