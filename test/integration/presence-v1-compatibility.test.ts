import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { SubagentUxRegistrySnapshot } from "../../src/core/subagent-ux";
import {
  PI_PRESENCE_READY_EVENT,
  PI_PRESENCE_REMOVE_EVENT,
  PI_PRESENCE_SUMMARY_EVENT,
  PI_PRESENCE_UPDATE_EVENT,
  createPiSubagentPresenceProducer,
  parsePiPresenceReady,
  parsePiPresenceRemove,
  parsePiPresenceSummary,
  parsePiPresenceUpdate,
} from "../../src/integration/pi-presence-producer";

type ConsumerProfile = {
  readonly name: string;
  readonly consumer: { readonly id: string; readonly capabilities: readonly string[] };
  readonly expectsSummary: boolean;
};
type Fixture = { readonly version: 1; readonly profiles: readonly ConsumerProfile[] };
type Event = { readonly channel: string; readonly payload: unknown };

const fixturePath = path.resolve(import.meta.dirname, "../fixtures/presence-v1-consumer-profiles.json");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
const runningSnapshot = {
  generation: 0,
  active: [{ id: "run-1", agent: "worker", kind: "foreground", status: "running", generation: 0, startedAt: 1, updatedAt: 1 }],
  recent: [],
} satisfies SubagentUxRegistrySnapshot;
const completedSnapshot = {
  generation: 0,
  active: [],
  recent: [{ id: "run-1", agent: "worker", status: "completed", generation: 0, kind: "foreground", startedAt: 1, updatedAt: 2, completedAt: 2 }],
} satisfies SubagentUxRegistrySnapshot;

function eventBus() {
  const events: Event[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emit = (channel: string, payload: unknown) => {
    events.push({ channel, payload });
    for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload);
  };
  const on = (channel: string, listener: (payload: unknown) => void) => {
    const channelListeners = listeners.get(channel) ?? new Set<(payload: unknown) => void>();
    channelListeners.add(listener);
    listeners.set(channel, channelListeners);
    return () => channelListeners.delete(listener);
  };
  return { events, emit, on };
}

function installConsumerFirstResponder(bus: ReturnType<typeof eventBus>, profile: ConsumerProfile): void {
  bus.on(PI_PRESENCE_READY_EVENT, (payload) => {
    const ready = parsePiPresenceReady(payload);
    if (ready && !ready.consumer) {
      bus.emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: ready.sessionId, consumer: profile.consumer });
    }
  });
}

function assertLifecycle(profile: ConsumerProfile, loadOrder: "consumer-first" | "producer-first"): void {
  const bus = eventBus();
  if (loadOrder === "consumer-first") installConsumerFirstResponder(bus, profile);
  const producer = createPiSubagentPresenceProducer({
    emit: bus.emit,
    on: bus.on,
    getSchedulerCounts: () => ({ active: 0, queued: 0 }),
    getInteractiveActiveCount: () => 0,
  });

  producer.startSession("fixture-session", 0);
  producer.publish(runningSnapshot);

  if (loadOrder === "producer-first") {
    // A late consumer follows V1 discovery: advertise, then request replay.
    bus.emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: "fixture-session", consumer: profile.consumer });
  }
  bus.emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: "fixture-session" });
  producer.publish(completedSnapshot);
  producer.settle();

  const updates = bus.events.filter((event) => event.channel === PI_PRESENCE_UPDATE_EVENT);
  const summaries = bus.events.filter((event) => event.channel === PI_PRESENCE_SUMMARY_EVENT);
  const removes = bus.events.filter((event) => event.channel === PI_PRESENCE_REMOVE_EVENT);
  assert.deepEqual(updates.map((event) => parsePiPresenceUpdate(event.payload)?.sequence), [1, 2, 3], `${profile.name}/${loadOrder}: update and replay sequence`);
  assert.deepEqual(removes.map((event) => parsePiPresenceRemove(event.payload)?.sequence), [4], `${profile.name}/${loadOrder}: remove follows terminal update`);
  assert.deepEqual(bus.events.filter((event) => event.channel === PI_PRESENCE_UPDATE_EVENT || event.channel === PI_PRESENCE_REMOVE_EVENT).map((event) => event.channel), [
    PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_REMOVE_EVENT,
  ], `${profile.name}/${loadOrder}: terminal update is emitted before lifecycle removal`);
  assert.equal(parsePiPresenceUpdate(updates[1]?.payload)?.attention, "none", `${profile.name}/${loadOrder}: replay is non-attention-grabbing`);
  assert.equal(parsePiPresenceUpdate(updates[2]?.payload)?.state, "success", `${profile.name}/${loadOrder}: terminal update precedes remove`);
  assert.equal(parsePiPresenceRemove(removes[0]?.payload)?.source.id, "pi-subagent");

  const summarySequences = summaries.map((event) => parsePiPresenceSummary(event.payload)?.sequence);
  assert.deepEqual(summarySequences, profile.expectsSummary ? [1, 2, 3] : [], `${profile.name}/${loadOrder}: declared capability boundary`);
  for (const sequence of summarySequences) {
    const updateIndex = bus.events.findIndex((event) => event.channel === PI_PRESENCE_UPDATE_EVENT && parsePiPresenceUpdate(event.payload)?.sequence === sequence);
    const summaryIndex = bus.events.findIndex((event) => event.channel === PI_PRESENCE_SUMMARY_EVENT && parsePiPresenceSummary(event.payload)?.sequence === sequence);
    assert.ok(updateIndex >= 0 && summaryIndex > updateIndex, `${profile.name}/${loadOrder}: summary follows its update`);
  }

  // The producer's active ready request and the consumer's later request are
  // the only replay discovery requests. Advertisements never add a replay.
  const requests = bus.events
    .filter((event) => event.channel === PI_PRESENCE_READY_EVENT)
    .map((event) => parsePiPresenceReady(event.payload))
    .filter((ready): ready is NonNullable<typeof ready> => ready !== null && !ready.consumer);
  assert.equal(requests.length, 2, `${profile.name}/${loadOrder}: one producer request and one consumer replay request`);
}

describe("presence V1 producer compatibility fixtures", () => {
  test("declare the fixed cmux V1 and summary-capable Herdr V1 profiles", () => {
    assert.equal(fixture.version, 1);
    assert.deepEqual(fixture.profiles.map((profile) => profile.name), ["cmux-fixed-v1", "herdr-summary-v1"]);
    const cmux = fixture.profiles[0]!;
    assert.equal(cmux.consumer.id, "pi-cmux-presence");
    assert.equal(cmux.consumer.capabilities.includes("presence-summary-v1"), false, "fixed cmux V1 must not advertise summary");
    assert.equal(cmux.expectsSummary, false);
    assert.equal(fixture.profiles[1]!.expectsSummary, true);
  });

  for (const profile of fixture.profiles) {
    test(`${profile.name} completes the deterministic consumer-first handshake and lifecycle`, () => assertLifecycle(profile, "consumer-first"));
    test(`${profile.name} completes the deterministic producer-first handshake, replay, and lifecycle`, () => assertLifecycle(profile, "producer-first"));
  }

  test("the producer remains event-only: no sibling consumer, socket, CLI, or polling runtime coupling", () => {
    const producerPath = path.resolve(import.meta.dirname, "../../src/integration/pi-presence-producer.ts");
    const source = fs.readFileSync(producerPath, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:pi-cmux-presence|pi-herdr-presence)[^"']*["']/);
    assert.doesNotMatch(source, /(?:node:)?(?:net|dgram|child_process)\b/);
    assert.doesNotMatch(source, /\b(?:Bun\.)?(?:spawn|spawnSync|exec|execFile)\s*\(/);
    assert.doesNotMatch(source, /\bset(?:Interval|Timeout)\s*\(/);
  });
});
