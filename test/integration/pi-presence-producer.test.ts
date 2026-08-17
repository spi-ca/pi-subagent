import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  MAX_PRESENCE_COUNT,
  PI_PRESENCE_READY_EVENT,
  PI_PRESENCE_REMOVE_EVENT,
  PI_PRESENCE_UPDATE_EVENT,
  createPiSubagentPresenceProducer,
  isPiCmuxPresenceCmuxStatusReady,
  parsePiPresenceReady,
  parsePiPresenceRemove,
  parsePiPresenceUpdate,
} from "../../src/integration/pi-presence-producer";

const update = {
  version: 1, sessionId: "session-1", generation: 0, sequence: 1,
  source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "idle",
  counts: { active: 0, completed: 0, failed: 0 },
} as const;
const snapshot = (generation = 0, recent: any[] = [], active: any[] = []) => ({ generation, active, recent });
const running = (id = "running") => ({ id, status: "running" });
const completed = (id = "completed") => ({ id, status: "completed", generation: 0, kind: "foreground", agent: "safe", startedAt: 1, updatedAt: 2, completedAt: 2 });

describe("pi presence producer wire contract", () => {
  test("strictly parses bounded, private-data-free update and ready DTOs", () => {
    assert.deepEqual(parsePiPresenceUpdate(update), update);
    const remove = { version: 1, sessionId: "session-1", generation: 0, sequence: 2, source: { id: "pi-subagent" } } as const;
    assert.deepEqual(parsePiPresenceRemove(remove), remove);
    assert.equal(parsePiPresenceRemove({ ...remove, state: "idle" }), null);
    assert.equal(parsePiPresenceRemove({ ...remove, source: { id: "pi-subagent", label: "private" } }), null);
    assert.equal(parsePiPresenceRemove({ ...remove, sequence: 0 }), null);
    assert.equal(parsePiPresenceRemove({ ...remove, generation: -1 }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, task: "private" }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, sessionId: "bad\nvalue" }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, source: { ...update.source, label: "\u202Espoof" } }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, counts: { ...update.counts, active: MAX_PRESENCE_COUNT + 1 } }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, progress: { value: 1.1 } }), null);
    assert.equal(parsePiPresenceUpdate({ ...update, usage: { tokens: -1 } }), null);
    assert.deepEqual(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status"] } }), { version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status"] } });
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", source: "unexpected" }), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "x", capabilities: [], private: true } }), null);
    assert.equal(parsePiPresenceReady({ version: 1 }), null);
    assert.equal(parsePiPresenceReady({ sessionId: "session-1" }), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "x" } }), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { capabilities: [] } }), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "x", capabilities: Array(17).fill("x") } }), null);
    assert.equal(isPiCmuxPresenceCmuxStatusReady({ version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status"] } }), true);
    assert.equal(isPiCmuxPresenceCmuxStatusReady({ version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-progress"] } }), false);
    assert.equal(isPiCmuxPresenceCmuxStatusReady({ version: 1, sessionId: "session-1", consumer: { id: "other", capabilities: ["cmux-status"] } }), false);

    const throwing = new Proxy({}, { get() { throw new Error("no getter execution"); } });
    assert.equal(parsePiPresenceUpdate(throwing), null);
    assert.equal(parsePiPresenceRemove(throwing), null);
    assert.equal(parsePiPresenceReady(throwing), null);
  });

  test("accepts the canonical astral text boundary and rejects the next code point", () => {
    const atLimit = "😀".repeat(96);
    const overLimit = "😀".repeat(97);
    const remove = { version: 1, sessionId: atLimit, generation: 0, sequence: 1, source: { id: atLimit } } as const;
    const astralUpdate = { ...update, sessionId: atLimit, source: { id: atLimit, label: atLimit, kind: atLimit } } as const;
    const ready = { version: 1, sessionId: atLimit, consumer: { id: atLimit, capabilities: [atLimit] } } as const;

    assert.deepEqual(parsePiPresenceRemove(remove), remove);
    assert.deepEqual(parsePiPresenceUpdate(astralUpdate), astralUpdate);
    assert.deepEqual(parsePiPresenceReady(ready), ready);
    assert.equal(parsePiPresenceRemove({ ...remove, sessionId: overLimit }), null);
    assert.equal(parsePiPresenceUpdate({ ...astralUpdate, source: { ...astralUpdate.source, label: overLimit } }), null);
    assert.equal(parsePiPresenceReady({ ...ready, consumer: { ...ready.consumer, capabilities: [overLimit] } }), null);
  });

  test("snapshots each removal field once before constructing its owned DTO", () => {
    let versionReads = 0;
    let sessionReads = 0;
    let generationReads = 0;
    let sequenceReads = 0;
    let sourceReads = 0;
    let sourceIdReads = 0;
    const source = Object.create(Object.prototype, {
      id: { enumerable: true, get: () => ++sourceIdReads === 1 ? "pi-subagent" : "changed-source" },
    });
    const changing = Object.create(Object.prototype, {
      version: { enumerable: true, get: () => ++versionReads === 1 ? 1 : 2 },
      sessionId: { enumerable: true, get: () => ++sessionReads === 1 ? "session-1" : "changed-session" },
      generation: { enumerable: true, get: () => ++generationReads === 1 ? 0 : 1 },
      sequence: { enumerable: true, get: () => ++sequenceReads === 1 ? 1 : 2 },
      source: { enumerable: true, get: () => ++sourceReads === 1 ? source : { id: "changed-source" } },
    });

    assert.deepEqual(parsePiPresenceRemove(changing), {
      version: 1, sessionId: "session-1", generation: 0, sequence: 1, source: { id: "pi-subagent" },
    });
    assert.deepEqual({ versionReads, sessionReads, generationReads, sequenceReads, sourceReads, sourceIdReads }, {
      versionReads: 1, sessionReads: 1, generationReads: 1, sequenceReads: 1, sourceReads: 1, sourceIdReads: 1,
    });
  });

  test("snapshots every update field once before validation and construction", () => {
    const reads = new Map<string, number>();
    const changing = <T>(name: string, initial: T, later: T) => ({
      enumerable: true,
      get: () => {
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        return count === 1 ? initial : later;
      },
    });
    const source = Object.create(Object.prototype, {
      id: changing("source.id", "pi-subagent", "changed-id"),
      label: changing("source.label", "Subagents", "changed-label"),
      kind: changing("source.kind", "agent-group", "changed-kind"),
    });
    const counts = Object.create(Object.prototype, {
      active: changing("counts.active", 1, -1), completed: changing("counts.completed", 2, -1), failed: changing("counts.failed", 3, -1),
      queued: changing("counts.queued", 4, -1), cancelled: changing("counts.cancelled", 5, -1), total: changing("counts.total", 15, -1),
    });
    const progress = Object.create(Object.prototype, {
      value: changing("progress.value", 0.5, 2), label: changing("progress.label", "Half", "changed-label"),
    });
    const usage = Object.create(Object.prototype, {
      tokens: changing("usage.tokens", 10, -1), cost: changing("usage.cost", 0.25, -1), contextPercent: changing("usage.contextPercent", 50, -1),
    });
    const changingUpdate = Object.create(Object.prototype, {
      version: changing("version", 1, 2), sessionId: changing("sessionId", "session-1", "changed-session"),
      generation: changing("generation", 0, -1), sequence: changing("sequence", 1, 0), source: changing("source", source, null),
      state: changing("state", "running", "invalid"), counts: changing("counts", counts, null), progress: changing("progress", progress, null),
      usage: changing("usage", usage, null), attention: changing("attention", "info", "invalid"),
    });

    assert.deepEqual(parsePiPresenceUpdate(changingUpdate), {
      version: 1, sessionId: "session-1", generation: 0, sequence: 1,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "running",
      counts: { active: 1, completed: 2, failed: 3, queued: 4, cancelled: 5, total: 15 },
      progress: { value: 0.5, label: "Half" }, usage: { tokens: 10, cost: 0.25, contextPercent: 50 }, attention: "info",
    });
    assert.deepEqual(Object.fromEntries(reads), Object.fromEntries([
      "version", "sessionId", "generation", "sequence", "source", "state", "counts", "progress", "usage", "attention",
      "source.id", "source.label", "source.kind", "counts.active", "counts.completed", "counts.failed", "counts.queued", "counts.cancelled", "counts.total",
      "progress.value", "progress.label", "usage.tokens", "usage.cost", "usage.contextPercent",
    ].map((name) => [name, 1])));
  });

  test("strictly snapshots ready DTOs from own data properties", () => {
    const ready = { version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status"] } };
    const parsed = parsePiPresenceReady(ready);
    assert.deepEqual(parsed, ready);
    assert.ok(parsed?.consumer);
    assert.notEqual(parsed, ready);
    assert.notEqual(parsed.consumer, ready.consumer);
    assert.notEqual(parsed.consumer.capabilities, ready.consumer.capabilities);

    const sparseCapabilities = new Array<string>(1);
    const accessorCapabilities = ["cmux-status"];
    Object.defineProperty(accessorCapabilities, "0", { enumerable: true, get() { throw new Error("must not read index accessors"); } });
    const extraCapabilityProperty = ["cmux-status"] as string[] & { private?: string };
    extraCapabilityProperty.private = "no";
    const inheritedCapabilities = new Array<string>(1);
    Object.setPrototypeOf(inheritedCapabilities, { 0: "cmux-status" });
    const inheritedRoot = Object.create({ version: 1, sessionId: "session-1" });
    const inheritedConsumer = Object.create({ id: "consumer", capabilities: [] });
    let rootGetterReads = 0;
    const changingRoot = { version: 1, sessionId: "session-1" };
    Object.defineProperty(changingRoot, "consumer", { enumerable: true, get() { rootGetterReads += 1; return { id: "changed", capabilities: [] }; } });
    let consumerGetterReads = 0;
    const changingConsumer = { capabilities: [] as string[] };
    Object.defineProperty(changingConsumer, "id", { enumerable: true, get() { consumerGetterReads += 1; return "changed"; } });
    const versionAccessor = { sessionId: "session-1" };
    Object.defineProperty(versionAccessor, "version", { enumerable: true, get() { rootGetterReads += 1; return 1; } });
    const capabilitiesAccessor = { id: "consumer" };
    Object.defineProperty(capabilitiesAccessor, "capabilities", { enumerable: true, get() { consumerGetterReads += 1; return []; } });

    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: undefined }), null, "consumer-less requests must omit consumer");
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "x", capabilities: sparseCapabilities } }), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "x", capabilities: accessorCapabilities } }), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "x", capabilities: extraCapabilityProperty } }), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: { id: "x", capabilities: inheritedCapabilities } }), null);
    assert.equal(parsePiPresenceReady(inheritedRoot), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: inheritedConsumer }), null);
    assert.equal(parsePiPresenceReady(changingRoot), null);
    assert.equal(parsePiPresenceReady(versionAccessor), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: changingConsumer }), null);
    assert.equal(parsePiPresenceReady({ version: 1, sessionId: "session-1", consumer: capabilitiesAccessor }), null);
    assert.equal(rootGetterReads, 0, "root getters must not run");
    assert.equal(consumerGetterReads, 0, "consumer getters must not run");
    assert.equal(parsePiPresenceReady(new Proxy({}, { getPrototypeOf() { throw new Error("proxy rejected"); } })), null);
  });

  test("actively requests ready without self-replay and accepts a synchronous consumer response", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const emit = (channel: string, payload: unknown) => {
      emitted.push({ channel, payload });
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
    };
    const on = (channel: string, handler: (value: unknown) => void) => {
      const handlers = listeners.get(channel) ?? new Set<(value: unknown) => void>();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    };
    // A consumer loaded first responds synchronously to the producer request.
    on(PI_PRESENCE_READY_EVENT, (payload) => {
      const ready = parsePiPresenceReady(payload);
      if (ready && !ready.consumer) emit(PI_PRESENCE_READY_EVENT, {
        version: 1, sessionId: ready.sessionId,
        consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status", "presence-remove-v1"] },
      });
    });
    let hints = 0;
    const producer = createPiSubagentPresenceProducer({
      emit, on, getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
      onCmuxStatusConsumer: () => { hints += 1; },
    });

    assert.doesNotThrow(() => producer.startSession("session-1", 0));
    const requests = emitted.filter((entry) => entry.channel === PI_PRESENCE_READY_EVENT && !entry.payload.consumer);
    assert.deepEqual(requests.map((entry) => entry.payload), [{ version: 1, sessionId: "session-1" }]);
    assert.equal(Object.isFrozen(requests[0]!.payload), true, "the outgoing discovery request is frozen");
    assert.equal(emitted.filter((entry) => entry.channel === PI_PRESENCE_UPDATE_EVENT).length, 0, "own request cannot replay");
    assert.equal(hints, 1, "synchronous advertised response is still processed");
    assert.equal(producer.isPresenceRemoveCapabilityDetected(), true);
  });

  test("treats consumer advertisements as passive and replays only consumer-less requests", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const emit = (channel: string, payload: unknown) => {
      emitted.push({ channel, payload });
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
    };
    const on = (channel: string, handler: (value: unknown) => void) => {
      const handlers = listeners.get(channel) ?? new Set<(value: unknown) => void>();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    };
    const producer = createPiSubagentPresenceProducer({ emit, on, getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0 });

    producer.startSession("session-1", 0);
    producer.publish(snapshot(0, [], [running()]));
    const updates = () => emitted.filter((entry) => entry.channel === PI_PRESENCE_UPDATE_EVENT);
    emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: "session-1", consumer: { id: "pi-cmux-presence", capabilities: [] } });
    assert.equal(updates().length, 1, "advertisement alone cannot replay cached presence");

    // A later consumer advertises, then sends its own canonical consumer-less
    // request. Only that request performs the one replay.
    emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: "session-1" });
    assert.deepEqual(updates().map((entry) => entry.payload.sequence), [1, 2]);
    emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: "session-1" });
    assert.deepEqual(updates().map((entry) => entry.payload.sequence), [1, 2, 3], "legacy consumer-less requests still replay once");

    const requestsBeforeRestart = emitted.filter((entry) => entry.channel === PI_PRESENCE_READY_EVENT && !entry.payload.consumer).length;
    producer.startSession("session-2", 1);
    assert.equal(emitted.filter((entry) => entry.channel === PI_PRESENCE_READY_EVENT && !entry.payload.consumer).length, requestsBeforeRestart + 1, "one request per start");
    emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: "session-1" });
    assert.equal(emitted.filter((entry) => entry.channel === PI_PRESENCE_UPDATE_EVENT).length, 3, "old session ready is fenced after restart");
    producer.stop();
    emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: "session-2" });
    assert.equal(emitted.filter((entry) => entry.channel === PI_PRESENCE_UPDATE_EVENT).length, 3, "stop fences ready replay");
  });

  test("suppresses an exact self request even when synchronous delivery populates cached presence", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    let producer!: ReturnType<typeof createPiSubagentPresenceProducer>;
    const emit = (channel: string, payload: unknown) => {
      emitted.push({ channel, payload });
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
    };
    const on = (channel: string, handler: (value: unknown) => void) => {
      const handlers = listeners.get(channel) ?? new Set<(value: unknown) => void>();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    };
    // This listener runs before the producer listener and makes current non-null
    // while the producer's own ready request is still being delivered.
    on(PI_PRESENCE_READY_EVENT, (payload) => {
      if (!parsePiPresenceReady(payload)?.consumer) producer.publish(snapshot(0, [], [running()]));
    });
    producer = createPiSubagentPresenceProducer({ emit, on, getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0 });

    producer.startSession("session-1", 0);
    const updates = emitted.filter((entry) => entry.channel === PI_PRESENCE_UPDATE_EVENT);
    assert.deepEqual(updates.map((entry) => entry.payload.sequence), [1], "the exact self request cannot replay newly cached presence");
    assert.equal(Object.isFrozen(emitted.find((entry) => entry.channel === PI_PRESENCE_READY_EVENT)!.payload), true);
  });

  test("does not amplify a consumer request across multiple producers", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const emit = (channel: string, payload: unknown) => {
      emitted.push({ channel, payload });
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(payload);
    };
    const on = (channel: string, handler: (value: unknown) => void) => {
      const handlers = listeners.get(channel) ?? new Set<(value: unknown) => void>();
      handlers.add(handler);
      listeners.set(channel, handlers);
      return () => handlers.delete(handler);
    };
    // Each producer startup receives one consumer advertisement and the
    // consumer's own consumer-less discovery request. Before either producer
    // has current presence, neither exchange can emit an update.
    let startupResponsesRemaining = 2;
    let emittingOwnRequest = false;
    on(PI_PRESENCE_READY_EVENT, (payload) => {
      const ready = parsePiPresenceReady(payload);
      if (!ready || ready.consumer || emittingOwnRequest || startupResponsesRemaining === 0) return;
      startupResponsesRemaining -= 1;
      emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: ready.sessionId, consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status"] } });
      emittingOwnRequest = true;
      try { emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: ready.sessionId }); } finally { emittingOwnRequest = false; }
    });
    const options = { emit, on, getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0 };
    const first = createPiSubagentPresenceProducer(options);
    const second = createPiSubagentPresenceProducer(options);
    first.startSession("session-1", 0);
    second.startSession("session-1", 0);
    first.publish(snapshot(0, [], [running("first")]));
    second.publish(snapshot(0, [], [running("second")]));

    emit(PI_PRESENCE_READY_EVENT, { version: 1, sessionId: "session-1" });
    assert.deepEqual(emitted.filter((entry) => entry.channel === PI_PRESENCE_UPDATE_EVENT).map((entry) => entry.payload.sequence), [1, 1, 2, 2]);
  });

  test("fences session/generation, replays only after a snapshot, and removes attention on replay", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const listeners = new Map<string, (value: unknown) => void>();
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push({ channel, payload }); },
      on: (channel, handler) => { listeners.set(channel, handler); return () => listeners.delete(channel); },
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    assert.equal(producer.startSession("session-1", 2), true);
    listeners.get(PI_PRESENCE_READY_EVENT)!({ version: 1, sessionId: "session-1" });
    assert.equal(emitted.length, 0);
    assert.equal(producer.publish(snapshot(1)), false);
    assert.equal(producer.publish(snapshot(2, [], [running()])), true);
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

  test("stays lazy while idle and only opens a retained source for meaningful work", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push({ channel, payload }); },
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    producer.startSession("session-1", 0);
    assert.equal(producer.publish(snapshot()), false);
    producer.handleReady({ version: 1, sessionId: "session-1" });
    assert.equal(emitted.length, 0);
    assert.equal(producer.publish(snapshot(0, [completed()])), true);
    assert.equal(emitted[0]!.payload.sequence, 1);
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

  test("detects the passive remove capability from any valid same-session consumer advertisement", () => {
    const listeners = new Map<string, (value: unknown) => void>();
    let hints = 0;
    const producer = createPiSubagentPresenceProducer({
      emit: () => {}, on: (channel, handler) => { listeners.set(channel, handler); return () => listeners.delete(channel); },
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
      onCmuxStatusConsumer: () => { hints += 1; },
    });
    const ready = (sessionId: string, id: string, capabilities: unknown) => ({ version: 1, sessionId, consumer: { id, capabilities } });

    producer.startSession("session-1", 0);
    assert.equal(producer.isPresenceRemoveCapabilityDetected(), false);
    listeners.get(PI_PRESENCE_READY_EVENT)!(ready("other", "pi-herdr-presence", ["presence-remove-v1"]));
    listeners.get(PI_PRESENCE_READY_EVENT)!(ready("session-1", "other", ["cmux-status"]));
    listeners.get(PI_PRESENCE_READY_EVENT)!(ready("session-1", "pi-cmux-presence", ["cmux-status"]));
    listeners.get(PI_PRESENCE_READY_EVENT)!({ version: 1, sessionId: "session-1", consumer: { id: "pi-herdr-presence", capabilities: "presence-remove-v1" } });
    assert.equal(producer.isPresenceRemoveCapabilityDetected(), false);
    assert.equal(hints, 1, "cmux-status retains its one-shot callback behavior");

    listeners.get(PI_PRESENCE_READY_EVENT)!(ready("session-1", "pi-herdr-presence", ["presence-remove-v1"]));
    listeners.get(PI_PRESENCE_READY_EVENT)!(ready("session-1", "pi-herdr-presence", ["presence-remove-v1"]));
    assert.equal(producer.isPresenceRemoveCapabilityDetected(), true);
    assert.equal(hints, 1, "Herdr capability must not trigger cmux routing");

    producer.startSession("session-2", 1);
    assert.equal(producer.isPresenceRemoveCapabilityDetected(), false);
    producer.handleReady(ready("session-2", "future-consumer", ["presence-remove-v1"]));
    assert.equal(producer.isPresenceRemoveCapabilityDetected(), true);
    producer.stop();
    assert.equal(producer.isPresenceRemoveCapabilityDetected(), false);
  });

  test("removes immediately or after deferred quiescence without replaying stale presence", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    let scheduler = { active: 1, queued: 0 };
    let interactive = 0;
    let producer!: ReturnType<typeof createPiSubagentPresenceProducer>;
    producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => {
        if (channel !== PI_PRESENCE_READY_EVENT) emitted.push({ channel, payload });
        if (channel === PI_PRESENCE_REMOVE_EVENT) producer.handleReady({ version: 1, sessionId: "session-1" });
      },
      getSchedulerCounts: () => scheduler, getInteractiveActiveCount: () => interactive,
    });
    producer.startSession("session-1", 0);
    producer.publish(snapshot(0, [], [running()]));
    producer.settle();
    assert.deepEqual(emitted.map((event) => event.channel), [PI_PRESENCE_UPDATE_EVENT]);

    // Deferred settlement preserves a new active publication and removes only
    // after the last terminal update observes the already-computed zero aggregate.
    producer.publish(snapshot(0, [], [running("new-parent")]));
    scheduler = { active: 0, queued: 0 };
    producer.publish(snapshot(0, [completed("done")]));
    assert.deepEqual(emitted.map((event) => event.channel), [PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_REMOVE_EVENT]);
    assert.deepEqual(emitted.map((event) => event.payload.sequence), [1, 2, 3, 4]);
    assert.equal(emitted[2]!.payload.state, "success");
    assert.deepEqual(emitted[3]!.payload, { version: 1, sessionId: "session-1", generation: 0, sequence: 4, source: { id: "pi-subagent" } });
    producer.handleReady({ version: 1, sessionId: "session-1" });
    assert.equal(emitted.length, 4, "ready after remove cannot replay");

    scheduler = { active: 1, queued: 0 };
    producer.publish(snapshot(0, [], [running("next-burst")]));
    producer.handleReady({ version: 1, sessionId: "session-1" });
    assert.deepEqual(emitted.slice(4).map((event) => event.payload.sequence), [5, 6]);
    assert.equal(emitted[4]!.payload.counts.completed, 1, "terminal counts remain cumulative within a session");
  });

  test("scopes deferred settlement to the parent run that settled", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    let scheduler = { active: 1, queued: 0 };
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push({ channel, payload }); },
      getSchedulerCounts: () => scheduler, getInteractiveActiveCount: () => 0,
    });
    producer.startSession("session-1", 0);
    producer.publish(snapshot(0, [], [running("old-run")]));
    producer.settle();

    producer.beginAgentRun();
    scheduler = { active: 0, queued: 0 };
    producer.publish(snapshot(0, [completed("old-work-finished")]));
    assert.deepEqual(emitted.map((event) => event.channel), [PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_UPDATE_EVENT]);
    assert.equal(emitted[1]!.payload.counts.completed, 1, "terminal state remains cumulative across parent runs");

    producer.settle();
    assert.deepEqual(emitted.map((event) => event.channel), [PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_REMOVE_EVENT]);
  });

  test("removes immediately when the retained aggregate is already quiescent", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push({ channel, payload }); },
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    producer.startSession("session-1", 0);
    producer.publish(snapshot(0, [completed()]));
    producer.settle();
    producer.settle();
    assert.deepEqual(emitted.map((event) => event.channel), [PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_REMOVE_EVENT]);
  });

  test("defers settlement for queued or interactive aggregate work and removes exactly once", () => {
    for (const retained of [
      { name: "queued", scheduler: { active: 0, queued: 1 }, interactive: 0 },
      { name: "interactive", scheduler: { active: 0, queued: 0 }, interactive: 1 },
    ]) {
      const emitted: Array<{ channel: string; payload: any }> = [];
      let scheduler = retained.scheduler;
      let interactive = retained.interactive;
      const producer = createPiSubagentPresenceProducer({
        emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push({ channel, payload }); },
        getSchedulerCounts: () => scheduler, getInteractiveActiveCount: () => interactive,
      });
      producer.startSession("session-1", 0);
      producer.publish(snapshot());
      producer.settle();
      assert.equal(emitted.length, 1, retained.name);
      scheduler = { active: 0, queued: 0 };
      interactive = 0;
      producer.publish(snapshot(0, [completed(`done-${retained.name}`)]));
      producer.settle();
      producer.stop();
      producer.stop();
      assert.deepEqual(emitted.map((event) => event.channel), [PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_REMOVE_EVENT], retained.name);
    }
  });

  test("removes retained state during reload and ignores observer failures", () => {
    const emitted: Array<{ channel: string; payload: any }> = [];
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push({ channel, payload }); },
      getSchedulerCounts: () => ({ active: 1, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    producer.startSession("old-session", 0);
    producer.publish(snapshot(0, [], [running()]));
    producer.startSession("new-session", 1);
    assert.deepEqual(emitted.map((event) => event.channel), [PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_REMOVE_EVENT]);
    assert.equal(emitted[1]!.payload.sessionId, "old-session");
    producer.publish(snapshot(1, [], [running("new-session-run")]));
    producer.stop();
    producer.stop();
    assert.deepEqual(emitted.map((event) => event.channel), [PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_REMOVE_EVENT, PI_PRESENCE_UPDATE_EVENT, PI_PRESENCE_REMOVE_EVENT]);

    const throwing = createPiSubagentPresenceProducer({
      emit: () => { throw new Error("observer"); },
      getSchedulerCounts: () => ({ active: 1, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    assert.doesNotThrow(() => throwing.startSession("session-1", 0), "ready request emission failures are isolated");
    assert.doesNotThrow(() => { throwing.publish(snapshot(0, [], [running()])); throwing.settle(); throwing.stop(); });
  });

  test("keeps cached replay immutable and blocks synchronous ready recursion", () => {
    const emitted: any[] = [];
    let producer!: ReturnType<typeof createPiSubagentPresenceProducer>;
    producer = createPiSubagentPresenceProducer({
      emit: (channel, payload: any) => {
        if (channel !== PI_PRESENCE_READY_EVENT) emitted.push(payload);
        try { payload.counts.completed = 999; } catch { /* frozen observer payload */ }
        if (payload.sequence === 2) producer.handleReady({ version: 1, sessionId: "session-1" });
      },
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    producer.startSession("session-1", 0);
    producer.publish(snapshot(0, [{ id: "done", status: "completed", generation: 0, kind: "background", agent: "safe", startedAt: 1, updatedAt: 2, completedAt: 2 }]));
    producer.handleReady({ version: 1, sessionId: "session-1" });
    assert.equal(emitted.length, 2, "a replay-triggered ready cannot recurse synchronously");
    assert.equal(emitted[1].counts.completed, 1);
    assert.equal(emitted[1].attention, "none");
    assert.equal(Object.isFrozen(emitted[0]), true);
    assert.equal(Object.isFrozen(emitted[0].counts), true);
  });

  test("emits terminal attention for foreground and background runs, selects terminal state by newest completion, and projects queue state", () => {
    const emitted: any[] = [];
    let scheduler = { active: 0, queued: 0 };
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push(payload); }, getSchedulerCounts: () => scheduler, getInteractiveActiveCount: () => 0,
    });
    producer.startSession("session-1", 0);
    const completed = { id: "completed", status: "completed", generation: 0, kind: "foreground", agent: "safe", startedAt: 1, updatedAt: 30 };
    const failed = { id: "failed", status: "failed", generation: 0, kind: "background", agent: "safe", startedAt: 1, updatedAt: 20, completedAt: 20 };
    producer.publish(snapshot(0, [completed, failed]));
    assert.deepEqual(emitted[0].counts, { active: 0, completed: 1, failed: 1, queued: 0, cancelled: 0, total: 2 });
    assert.equal(emitted[0].state, "success", "newest terminal determines state, independent of snapshot order");
    assert.equal(emitted[0].attention, "error", "a failure wins over a simultaneous success across invocation kinds");

    const cancelled = { id: "cancelled", status: "cancelled", generation: 0, kind: "foreground", agent: "safe", startedAt: 1, updatedAt: 40, completedAt: 40 };
    producer.publish(snapshot(0, [cancelled]));
    assert.equal(emitted[1].state, "cancelled");
    assert.equal(emitted[1].attention, "none");

    producer.handleReady({ version: 1, sessionId: "session-1" });
    assert.equal(emitted[2].state, "cancelled");
    assert.equal(emitted[2].attention, "none", "replays never demand attention");

    scheduler = { active: 0, queued: 1 };
    producer.publish(snapshot());
    assert.equal(emitted[3].state, "waiting");
    scheduler = { active: 1, queued: 1 };
    producer.publish(snapshot());
    assert.equal(emitted[4].state, "running");
  });

  test("correlates interactive runs to exact active invocation IDs", () => {
    const cases = [
      { name: "managed 1/1/1", activeIds: ["origin"], scheduler: 1, interactiveIds: ["origin"], expected: 1 },
      { name: "transition while the originating invocation remains active", activeIds: ["origin"], scheduler: 0, interactiveIds: ["origin"], expected: 1 },
      { name: "retained old run plus unrelated inline invocation", activeIds: ["inline"], scheduler: 1, interactiveIds: ["old"], expected: 2 },
      { name: "two parallel interactive children", activeIds: ["parallel"], scheduler: 2, interactiveIds: ["parallel", "parallel"], expected: 2 },
      { name: "missing interactive invocation ID is unmatched", activeIds: ["inline"], scheduler: 1, interactiveIds: [undefined], expected: 2 },
      { name: "terminal interactive invocation ID is unmatched", activeIds: ["inline"], scheduler: 1, interactiveIds: ["terminal"], expected: 2 },
    ];

    for (const activeCase of cases) {
      const emitted: any[] = [];
      const producer = createPiSubagentPresenceProducer({
        emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push(payload); },
        getSchedulerCounts: () => ({ active: activeCase.scheduler, queued: 0 }),
        getInteractiveActiveCount: () => activeCase.interactiveIds.length,
        getInteractiveActiveInvocationIds: () => activeCase.interactiveIds,
      });
      producer.startSession("session-1", 0);
      producer.publish(snapshot(0, [], activeCase.activeIds.map((id) => ({ id, status: "running" }))));
      assert.equal(emitted[0].counts.active, activeCase.expected, activeCase.name);
    }
  });

  test("uses the legacy interactive count as an unmatched fallback", () => {
    const emitted: any[] = [];
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push(payload); },
      getSchedulerCounts: () => ({ active: 1, queued: 0 }),
      getInteractiveActiveCount: () => 1,
    });
    producer.startSession("session-1", 0);
    producer.publish(snapshot(0, [], [{ id: "origin", status: "running" }]));
    assert.equal(emitted[0].counts.active, 2);
  });

  test("projects each finalized accounting record once into cumulative v1 usage", () => {
    const emitted: any[] = [];
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => { if (channel === PI_PRESENCE_UPDATE_EVENT) emitted.push(payload); },
      getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    producer.startSession("session-1", 0);
    const first = { totalTokens: 7, cost: { total: 0.25 } };
    const second = { totalTokens: 3, cost: { total: 0.5 } };
    assert.equal(producer.recordFinalUsage("foreground-1", 0, first), true);
    assert.equal(producer.recordFinalUsage("foreground-1", 0, first), false, "duplicate finalization cannot double-count");
    assert.equal(producer.recordFinalUsage("background-1", 0, second), true);
    assert.equal(producer.recordFinalUsage("invalid", 0, { totalTokens: Number.POSITIVE_INFINITY, cost: { total: 1 } }), false);
    producer.publish(snapshot(0, [completed("foreground-1")]));
    assert.deepEqual(emitted[0].usage, { tokens: 10, cost: 0.75 });
    producer.handleReady({ version: 1, sessionId: "session-1" });
    assert.deepEqual(emitted[1].usage, { tokens: 10, cost: 0.75 }, "replay uses the retained aggregate without recounting");
    producer.startSession("session-2", 1);
    assert.equal(producer.recordFinalUsage("stale-foreground", 0, first), false, "a prior session generation cannot contaminate the new aggregate");
    assert.equal(producer.recordFinalUsage("foreground-1", 1, first), true, "dedupe is session-local");
    producer.publish(snapshot(1, [completed("session-2-done")]));
    assert.deepEqual(emitted.at(-1)?.usage, { tokens: 7, cost: 0.25 });
  });

  test("keeps cumulative terminal counts after UX recent history is pruned and isolates observer failures", () => {
    const emitted: any[] = [];
    const producer = createPiSubagentPresenceProducer({
      emit: (channel, payload) => { if (channel !== PI_PRESENCE_READY_EVENT) emitted.push(payload); }, getSchedulerCounts: () => ({ active: 0, queued: 0 }), getInteractiveActiveCount: () => 0,
    });
    producer.startSession("session-1", 0);
    const one = { id: "one", status: "completed", generation: 0, kind: "foreground", agent: "safe", startedAt: 1, updatedAt: 2, completedAt: 2, progress: { completed: 1, total: 1 } };
    const two = { ...one, id: "two", status: "failed", startedAt: 3, updatedAt: 4, completedAt: 4 };
    producer.publish(snapshot(0, [one]));
    producer.publish(snapshot(0, [two])); // one has been pruned from registry history
    assert.deepEqual(emitted.map((event) => event.counts.completed), [1, 1]);
    assert.deepEqual(emitted.map((event) => event.counts.failed), [0, 1]);
    assert.deepEqual(emitted.map((event) => event.state), ["success", "error"]);
    assert.deepEqual(emitted.map((event) => event.attention), ["success", "error"]);

    const throwing = createPiSubagentPresenceProducer({ emit: () => { throw new Error("listener"); }, getSchedulerCounts: () => { throw new Error("scheduler"); }, getInteractiveActiveCount: () => { throw new Error("interactive"); } });
    throwing.startSession("session-1", 0);
    assert.doesNotThrow(() => throwing.publish(snapshot()));
  });
});
