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
} from "../../src/integration/pi-presence-producer";
import { createFrozenConsumerContract, type FrozenConsumerContract, type PresenceChannel } from "../fixtures/presence-v1-frozen-consumer-contracts";

type ConsumerProfile = {
  readonly name: string;
  readonly consumer: { readonly id: string; readonly capabilities: readonly string[] };
  readonly acceptsSummary: boolean;
  readonly frozenFrom: { readonly repository: string; readonly revision: string; readonly scope: string };
};
type Fixture = {
  readonly version: 1;
  readonly fixtureScope: string;
  readonly profiles: readonly ConsumerProfile[];
};
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

function installFrozenConsumer(bus: ReturnType<typeof eventBus>, consumer: FrozenConsumerContract, sessionId: string) {
  const accepted: string[] = [];
  const channels: PresenceChannel[] = [PI_PRESENCE_READY_EVENT, PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_SUMMARY_EVENT, PI_PRESENCE_REMOVE_EVENT];
  for (const channel of channels) {
    bus.on(channel, (payload) => {
      if (!consumer.accept(channel, payload, sessionId)) return;
      if (channel === PI_PRESENCE_READY_EVENT) {
        // A consumer-owned strict request parser accepted this consumer-less
        // request; respond with its frozen current ready advertisement.
        bus.emit(channel, { version: 1, sessionId, consumer: consumer.readyAdvertisement });
        return;
      }
      const sequence = (payload as { sequence: number }).sequence;
      accepted.push(`${channel}:${sequence}`);
    });
  }
  return accepted;
}

function assertLifecycle(profile: ConsumerProfile, loadOrder: "consumer-first" | "producer-first"): void {
  const bus = eventBus();
  const sessionId = "fixture-session";
  const consumer = createFrozenConsumerContract(profile.name);
  let accepted: string[] | undefined;
  if (loadOrder === "consumer-first") accepted = installFrozenConsumer(bus, consumer, sessionId);
  const producer = createPiSubagentPresenceProducer({
    emit: bus.emit,
    on: bus.on,
    getSchedulerCounts: () => ({ active: 0, queued: 0 }),
    getInteractiveActiveCount: () => 0,
  });

  producer.startSession(sessionId, 0);
  producer.publish(runningSnapshot);

  if (loadOrder === "producer-first") {
    accepted = installFrozenConsumer(bus, consumer, sessionId);
    // A late consumer first advertises its exact ready identity, then sends
    // its independent consumer-less replay request.
    bus.emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId, consumer: consumer.readyAdvertisement });
  }
  bus.emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId });
  producer.publish(completedSnapshot);
  producer.settle();

  const expected = profile.acceptsSummary
    ? [
      "pi-presence:update:v1:1", "pi-presence:summary:v1:1",
      "pi-presence:update:v1:2", "pi-presence:summary:v1:2",
      "pi-presence:update:v1:3", "pi-presence:summary:v1:3",
      "pi-presence:remove:v1:4",
    ]
    : ["pi-presence:update:v1:1", "pi-presence:update:v1:2", "pi-presence:update:v1:3", "pi-presence:remove:v1:4"];
  const consumerExpected = loadOrder === "producer-first" ? expected.filter((entry) => !entry.endsWith(":1")) : expected;
  assert.deepEqual(accepted, consumerExpected, `${profile.name}/${loadOrder}: independently frozen consumer accepts the available lifecycle`);

  const emitted = bus.events.filter((event) => event.channel === PI_PRESENCE_UPDATE_EVENT || event.channel === PI_PRESENCE_SUMMARY_EVENT || event.channel === PI_PRESENCE_REMOVE_EVENT);
  assert.deepEqual(emitted.map((event) => event.channel), expected.map((entry) => entry.slice(0, entry.lastIndexOf(":"))), `${profile.name}/${loadOrder}: consumer acceptance preserves update/summary/remove order`);
  const readyRequests = bus.events
    .filter((event) => event.channel === PI_PRESENCE_READY_EVENT && !(event.payload as { consumer?: unknown }).consumer);
  assert.equal(readyRequests.length, 2, `${profile.name}/${loadOrder}: one producer request and one consumer replay request`);
}

describe("presence V1 frozen consumer compatibility fixtures", () => {
  test("mirror the exact current cmux and Herdr ready consumer identities and capability advertisements", () => {
    assert.equal(fixture.version, 1);
    assert.match(fixture.fixtureScope, /no sibling runtime import or live E2E/);
    assert.deepEqual(fixture.profiles.map((profile) => profile.name), ["pi-cmux-presence-ready-v1", "pi-herdr-presence-ready-v1"]);
    assert.deepEqual(fixture.profiles.map((profile) => profile.consumer), [
      { id: "pi-cmux-presence", capabilities: ["cmux-status", "cmux-progress", "cmux-attention", "presence-remove-v1"] },
      { id: "pi-herdr-presence", capabilities: ["presence-remove-v1", "presence-summary-v1", "herdr-pane-report-agent-v1", "herdr-pane-report-metadata-v1"] },
    ]);
    assert.deepEqual(fixture.profiles.map((profile) => profile.frozenFrom), [
      { repository: "pi-cmux-presence", revision: "2ef26ac", scope: "current ready advertisement and V1 update/remove acceptance" },
      { repository: "pi-herdr-presence", revision: "0918827", scope: "current ready advertisement and pi-subagent update/remove/summary acceptance" },
    ]);
    for (const profile of fixture.profiles) {
      const consumer = createFrozenConsumerContract(profile.name);
      assert.deepEqual(consumer.readyAdvertisement, profile.consumer, `${profile.name}: consumer-owned fixture and JSON advertisement stay exact`);
      assert.equal(consumer.acceptsSummary, profile.acceptsSummary, `${profile.name}: consumer-owned summary scope stays exact`);
    }
  });

  for (const profile of fixture.profiles) {
    test(`${profile.name} independently accepts the deterministic consumer-first handshake and lifecycle`, () => assertLifecycle(profile, "consumer-first"));
    test(`${profile.name} independently accepts the deterministic producer-first handshake, replay, and lifecycle`, () => assertLifecycle(profile, "producer-first"));
  }

  test("frozen consumer rules retain cmux summary rejection and Herdr's same-fence summary acceptance", () => {
    const sessionId = "consumer-rule-session";
    const update = {
      version: 1, sessionId, generation: 0, sequence: 1,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: "running", counts: { active: 1, completed: 0, failed: 0 },
    };
    const summary = { version: 1, sessionId, generation: 0, sequence: 1, source: { id: "pi-subagent" }, active: [], omitted: 1 };
    const cmux = createFrozenConsumerContract("pi-cmux-presence-ready-v1");
    const herdr = createFrozenConsumerContract("pi-herdr-presence-ready-v1");
    assert.equal(cmux.accept(PI_PRESENCE_UPDATE_EVENT, update, sessionId), true);
    assert.equal(cmux.accept(PI_PRESENCE_SUMMARY_EVENT, summary, sessionId), false, "cmux does not consume summary:v1");
    assert.equal(herdr.accept(PI_PRESENCE_SUMMARY_EVENT, summary, sessionId), false, "Herdr requires an accepted matching update first");
    assert.equal(herdr.accept(PI_PRESENCE_UPDATE_EVENT, update, sessionId), true);
    assert.equal(herdr.accept(PI_PRESENCE_SUMMARY_EVENT, summary, sessionId), true);
    assert.equal(herdr.accept(PI_PRESENCE_SUMMARY_EVENT, { ...summary, source: { id: "other" } }, sessionId), false, "Herdr summary scope is exact pi-subagent");
  });

  test("the producer remains event-only: no sibling consumer, socket, CLI, or polling runtime coupling", () => {
    const producerPath = path.resolve(import.meta.dirname, "../../src/integration/pi-presence-producer.ts");
    const source = fs.readFileSync(producerPath, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:pi-cmux-presence|pi-herdr-presence)[^"']*["']/);
    assert.doesNotMatch(source, /(?:node:)?(?:net|dgram|child_process)\b/);
    assert.doesNotMatch(source, /\b(?:Bun\.)?(?:spawn|spawnSync|exec|execFile)\s*\(/);
    assert.doesNotMatch(source, /\bset(?:Interval|Timeout)\s*\(/);
  });
});
