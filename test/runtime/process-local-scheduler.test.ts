import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_ACTIVE,
  ProcessLocalScheduler,
  parsePositiveSafeInteger,
  resolveMaxActive,
} from "../../src/runtime/process-local-scheduler";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe("process-local scheduler", () => {
  test("dispatches work without a tree permit authority", async () => {
    const scheduler = new ProcessLocalScheduler(1);
    const handle = scheduler.createHandle();
    assert.deepEqual(await scheduler.schedule(handle, async () => "process-local"), {
      started: true,
      value: "process-local",
    });
  });

  test("resolves authoritative runtime CLI over environment over the default", () => {
    assert.equal(resolveMaxActive({ runtimeFlag: "3", env: { PI_SUBAGENT_MAX_ACTIVE: "2" }, warn: () => {} }), 3);
    assert.equal(resolveMaxActive({ env: { PI_SUBAGENT_MAX_ACTIVE: "2" }, warn: () => {} }), 2);
    assert.equal(resolveMaxActive({ env: {}, warn: () => {} }), DEFAULT_MAX_ACTIVE);
    assert.equal(resolveMaxActive({ runtimeFlag: "0", env: { PI_SUBAGENT_MAX_ACTIVE: "2" }, warn: () => {} }), 2);
    assert.equal(parsePositiveSafeInteger("9007199254740992"), null);
  });

  test("records fixed-size queue and local-slot timing metrics across completion and rejection", async () => {
    let now = 10;
    const scheduler = new ProcessLocalScheduler(1, { clock: () => now });
    const handle = scheduler.createHandle();
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const first = scheduler.schedule(handle, async () => { await firstGate.promise; return "first"; });
    now = 15;
    const second = scheduler.schedule(handle, async () => { await secondGate.promise; throw new Error("second rejected"); });

    now = 25;
    firstGate.resolve();
    await tick();
    now = 40;
    secondGate.resolve();
    await assert.rejects(second, /second rejected/);
    assert.deepEqual(await first, { started: true, value: "first" });

    const metrics = scheduler.getMetricsSnapshot();
    assert.ok(Object.isFrozen(metrics));
    assert.ok(Object.isFrozen(metrics.enqueueToDispatch));
    assert.equal(metrics.accepted, 2);
    assert.equal(metrics.started, 2);
    assert.equal(metrics.cancelledBeforeStart, 0);
    assert.equal(metrics.settled, 2);
    assert.deepEqual(metrics.enqueueToDispatch, { count: 2, sumMs: 10, maxMs: 10 });
    assert.deepEqual(metrics.dispatchToLocalSlotRelease, { count: 2, sumMs: 30, maxMs: 15 });
  });

  test("keeps one metrics epoch across provisional and resolved scheduler generations", async () => {
    let now = 1;
    const scheduler = new ProcessLocalScheduler(1, { clock: () => now });
    scheduler.resetMetrics();
    const provisional = scheduler.createHandle();
    const activeGate = deferred<void>();
    const active = scheduler.schedule(provisional, async () => { await activeGate.promise; return "active"; });
    now = 2;
    const queued = scheduler.schedule(provisional, async () => "queued");

    scheduler.startSession(2);
    assert.deepEqual(await queued, { started: false });
    const afterResolvedGeneration = scheduler.getMetricsSnapshot();
    assert.equal(afterResolvedGeneration.accepted, 2);
    assert.equal(afterResolvedGeneration.started, 1);
    assert.equal(afterResolvedGeneration.cancelledBeforeStart, 1);
    assert.equal(afterResolvedGeneration.settled, 0);

    now = 3;
    activeGate.resolve();
    await active;
    await tick();
    const settled = scheduler.getMetricsSnapshot();
    assert.equal(settled.epoch, afterResolvedGeneration.epoch);
    assert.equal(settled.settled, 1);
  });

  test("ignores late prior-epoch releases and queued cancellations while still returning capacity", async () => {
    const scheduler = new ProcessLocalScheduler(1, { clock: () => { throw new Error("clock unavailable"); } });
    const oldHandle = scheduler.createHandle();
    const oldGate = deferred<void>();
    const old = scheduler.schedule(oldHandle, async () => { await oldGate.promise; return "old"; });
    const oldQueued = scheduler.schedule(oldHandle, async () => "old queued");
    scheduler.resetMetrics();
    scheduler.startSession();
    assert.deepEqual(await oldQueued, { started: false });
    const currentMetrics = scheduler.getMetricsSnapshot();
    oldGate.resolve();
    await old;
    assert.deepEqual(scheduler.getMetricsSnapshot(), currentMetrics, "late old work must not mutate the replacement metrics epoch");

    const currentHandle = scheduler.createHandle();
    assert.deepEqual(await scheduler.schedule(currentHandle, async () => "current"), { started: true, value: "current" });
    await tick();
    const metrics = scheduler.getMetricsSnapshot();
    assert.deepEqual(
      { accepted: metrics.accepted, started: metrics.started, cancelledBeforeStart: metrics.cancelledBeforeStart, settled: metrics.settled },
      { accepted: 1, started: 1, cancelledBeforeStart: 0, settled: 1 },
      "a failed clock must not affect dispatch, capacity release, or replacement metrics",
    );
    assert.deepEqual(metrics.enqueueToDispatch, { count: 0, sumMs: 0, maxMs: 0 });
    assert.deepEqual(metrics.dispatchToLocalSlotRelease, { count: 0, sumMs: 0, maxMs: 0 });
  });

  test("keeps metrics finite for invalid and backwards clocks, saturates counters, and isolates snapshots", async () => {
    const clockValues = [10, 5, Number.NaN, Number.POSITIVE_INFINITY, -1, Number.NEGATIVE_INFINITY, 15];
    const scheduler = new ProcessLocalScheduler(1, { clock: () => clockValues.shift() ?? 20 });
    const handle = scheduler.createHandle();
    const initial = scheduler.getMetricsSnapshot();
    const firstGate = deferred<void>();
    const first = scheduler.schedule(handle, async () => { await firstGate.promise; return "first"; });
    const second = scheduler.schedule(handle, async () => "second");
    firstGate.resolve();
    await Promise.all([first, second]);

    const metrics = scheduler.getMetricsSnapshot();
    assert.equal(initial.accepted, 0, "a snapshot is copied rather than a live metrics view");
    assert.throws(() => { (initial as { accepted: number }).accepted = 99; }, TypeError);
    assert.throws(() => { (initial.enqueueToDispatch as { count: number }).count = 99; }, TypeError);
    assert.deepEqual(metrics.enqueueToDispatch, { count: 1, sumMs: 0, maxMs: 0 }, "backward timestamps clamp to zero and invalid samples are skipped");
    for (const value of [metrics.epoch, metrics.accepted, metrics.started, metrics.cancelledBeforeStart, metrics.settled, ...Object.values(metrics.enqueueToDispatch), ...Object.values(metrics.dispatchToLocalSlotRelease)]) {
      assert.ok(Number.isFinite(value) && value >= 0, "all metrics must remain finite non-negative numbers");
    }

    const maximum = Number.MAX_SAFE_INTEGER;
    const saturated = new ProcessLocalScheduler(1, { clock: () => 1 });
    const internal = saturated as unknown as { metrics: {
      epoch: number; accepted: number; started: number; cancelledBeforeStart: number; settled: number;
      enqueueToDispatch: { count: number; sumMs: number; maxMs: number };
      dispatchToLocalSlotRelease: { count: number; sumMs: number; maxMs: number };
    } };
    internal.metrics = {
      epoch: maximum, accepted: maximum, started: maximum, cancelledBeforeStart: maximum, settled: maximum,
      enqueueToDispatch: { count: maximum, sumMs: maximum, maxMs: maximum },
      dispatchToLocalSlotRelease: { count: maximum, sumMs: maximum, maxMs: maximum },
    };
    const saturatedHandle = saturated.createHandle();
    await saturated.schedule(saturatedHandle, async () => "saturated");
    const beforeEpochSaturation = saturated.getMetricsSnapshot();
    for (const value of [beforeEpochSaturation.epoch, beforeEpochSaturation.accepted, beforeEpochSaturation.started, beforeEpochSaturation.cancelledBeforeStart, beforeEpochSaturation.settled, ...Object.values(beforeEpochSaturation.enqueueToDispatch), ...Object.values(beforeEpochSaturation.dispatchToLocalSlotRelease)]) {
      assert.equal(value, maximum, "count and sum updates saturate rather than overflow");
    }
    saturated.resetMetrics();
    const saturatedMetrics = saturated.getMetricsSnapshot();
    assert.equal(saturatedMetrics.epoch, maximum, "epoch increments saturate");
    for (const value of [saturatedMetrics.epoch, saturatedMetrics.accepted, saturatedMetrics.started, saturatedMetrics.cancelledBeforeStart, saturatedMetrics.settled, ...Object.values(saturatedMetrics.enqueueToDispatch), ...Object.values(saturatedMetrics.dispatchToLocalSlotRelease)]) {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= maximum);
    }
  });

  test("clock callbacks cannot leave scheduled work stale, unresolved, or recursively re-entered", async () => {
    let scheduler!: ProcessLocalScheduler;
    let clockCalls = 0;
    scheduler = new ProcessLocalScheduler(1, { clock: () => {
      clockCalls += 1;
      if (clockCalls === 1) scheduler.shutdown();
      return 1;
    } });
    const enqueueHandle = scheduler.createHandle();
    let enqueueLaunches = 0;
    assert.deepEqual(await scheduler.schedule(enqueueHandle, async () => { enqueueLaunches += 1; return "never"; }), { started: false });
    assert.deepEqual({ active: scheduler.activeCount, queued: scheduler.queuedCount, launches: enqueueLaunches }, { active: 0, queued: 0, launches: 0 });
    assert.deepEqual(scheduler.getMetricsSnapshot(), {
      epoch: 0, accepted: 0, started: 0, cancelledBeforeStart: 0, settled: 0,
      enqueueToDispatch: { count: 0, sumMs: 0, maxMs: 0 }, dispatchToLocalSlotRelease: { count: 0, sumMs: 0, maxMs: 0 },
    });

    let resetScheduler!: ProcessLocalScheduler;
    clockCalls = 0;
    resetScheduler = new ProcessLocalScheduler(1, { clock: () => {
      clockCalls += 1;
      if (clockCalls === 1) resetScheduler.resetMetrics();
      return 1;
    } });
    const resetHandle = resetScheduler.createHandle();
    assert.deepEqual(await resetScheduler.schedule(resetHandle, async () => "replacement epoch"), { started: true, value: "replacement epoch" });
    await tick();
    assert.deepEqual(
      resetScheduler.getMetricsSnapshot(),
      { epoch: 1, accepted: 1, started: 1, cancelledBeforeStart: 0, settled: 1, enqueueToDispatch: { count: 1, sumMs: 0, maxMs: 0 }, dispatchToLocalSlotRelease: { count: 1, sumMs: 0, maxMs: 0 } },
      "a clock-triggered metrics reset occurs before queue acceptance rather than splitting a transition",
    );

    let dispatchScheduler!: ProcessLocalScheduler;
    clockCalls = 0;
    dispatchScheduler = new ProcessLocalScheduler(1, { clock: () => {
      clockCalls += 1;
      if (clockCalls === 2) dispatchScheduler.shutdown();
      return 1;
    } });
    const dispatchHandle = dispatchScheduler.createHandle();
    let dispatchLaunches = 0;
    assert.deepEqual(await dispatchScheduler.schedule(dispatchHandle, async () => { dispatchLaunches += 1; return "never"; }), { started: false });
    assert.deepEqual({ active: dispatchScheduler.activeCount, queued: dispatchScheduler.queuedCount, launches: dispatchLaunches }, { active: 0, queued: 0, launches: 0 });
    assert.deepEqual(
      dispatchScheduler.getMetricsSnapshot(),
      { epoch: 0, accepted: 1, started: 0, cancelledBeforeStart: 1, settled: 0, enqueueToDispatch: { count: 0, sumMs: 0, maxMs: 0 }, dispatchToLocalSlotRelease: { count: 0, sumMs: 0, maxMs: 0 } },
    );

    let sessionScheduler!: ProcessLocalScheduler;
    clockCalls = 0;
    sessionScheduler = new ProcessLocalScheduler(1, { clock: () => {
      clockCalls += 1;
      if (clockCalls === 2) sessionScheduler.startSession();
      return 1;
    } });
    const staleHandle = sessionScheduler.createHandle();
    let staleLaunches = 0;
    assert.deepEqual(await sessionScheduler.schedule(staleHandle, async () => { staleLaunches += 1; return "stale"; }), { started: false });
    assert.deepEqual({ active: sessionScheduler.activeCount, queued: sessionScheduler.queuedCount, launches: staleLaunches }, { active: 0, queued: 0, launches: 0 });

    let recursiveScheduler!: ProcessLocalScheduler;
    let recursiveHandle!: ReturnType<ProcessLocalScheduler["createHandle"]>;
    let nested!: Promise<unknown>;
    clockCalls = 0;
    const launches: string[] = [];
    recursiveScheduler = new ProcessLocalScheduler(1, { clock: () => {
      clockCalls += 1;
      if (clockCalls === 1) nested = recursiveScheduler.schedule(recursiveHandle, async () => { launches.push("nested"); return "nested"; });
      return 1;
    } });
    recursiveHandle = recursiveScheduler.createHandle();
    const outer = recursiveScheduler.schedule(recursiveHandle, async () => { launches.push("outer"); return "outer"; });
    assert.deepEqual(await Promise.all([outer, nested]), [{ started: true, value: "outer" }, { started: true, value: "nested" }]);
    assert.deepEqual(launches, ["nested", "outer"]);
    assert.ok(clockCalls < 10, "recursive clock sampling is guarded");
  });

  test("enforces the active cap and returns permits after completion or launch failure", async () => {
    const scheduler = new ProcessLocalScheduler(2);
    const handle = scheduler.createHandle();
    let active = 0;
    let peak = 0;
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const jobs = gates.map((gate) => scheduler.schedule(handle, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
      return active;
    }));
    await tick();
    assert.equal(peak, 2);
    gates[0].resolve(); gates[1].resolve();
    await tick();
    assert.equal(peak, 2);
    gates[2].resolve(); gates[3].resolve();
    await Promise.all(jobs);

    await assert.rejects(scheduler.schedule(handle, async () => { throw new Error("launch failed"); }), /launch failed/);
    assert.deepEqual(await scheduler.schedule(handle, async () => "recovered"), { started: true, value: "recovered" });
  });

  test("uses FIFO per invocation and strict round-robin across three invocations", async () => {
    const scheduler = new ProcessLocalScheduler(1);
    const handles = {
      A: scheduler.createHandle(),
      B: scheduler.createHandle(),
      C: scheduler.createHandle(),
    };
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    const launch = (name: string) => scheduler.schedule(handles[name[0] as keyof typeof handles], async () => {
      order.push(name);
      const gate = deferred<void>();
      gates.set(name, gate);
      await gate.promise;
      return name;
    });
    const expected = ["A1", "B1", "C1", "A2", "B2", "C2"];
    const jobs = [launch("A1"), launch("A2"), launch("B1"), launch("B2"), launch("C1"), launch("C2")];
    for (let index = 0; index < expected.length; index += 1) {
      await tick();
      assert.deepEqual(order, expected.slice(0, index + 1));
      gates.get(expected[index])!.resolve();
    }
    await Promise.all(jobs);
  });

  test("queued abort and shutdown never launch work, while a new session uses a new generation", async () => {
    const scheduler = new ProcessLocalScheduler(1);
    const first = scheduler.createHandle();
    let releaseFirst!: () => void;
    const firstJob = scheduler.schedule(first, () => new Promise<string>((resolve) => { releaseFirst = () => resolve("first"); }));
    const controller = new AbortController();
    let launches = 0;
    const cancelled = scheduler.schedule(first, async () => { launches += 1; return "cancelled"; }, controller.signal);
    controller.abort();
    assert.deepEqual(await cancelled, { started: false });
    const shutdownCancelled = scheduler.schedule(first, async () => { launches += 1; return "shutdown-cancelled"; });
    scheduler.shutdown();
    assert.deepEqual(await shutdownCancelled, { started: false });
    assert.equal(launches, 0);
    releaseFirst();
    await firstJob;
    await tick();
    const beforeEpochBoundary = scheduler.getMetricsSnapshot();
    assert.deepEqual(
      {
        epoch: beforeEpochBoundary.epoch,
        accepted: beforeEpochBoundary.accepted,
        started: beforeEpochBoundary.started,
        cancelledBeforeStart: beforeEpochBoundary.cancelledBeforeStart,
        settled: beforeEpochBoundary.settled,
      },
      { epoch: 0, accepted: 3, started: 1, cancelledBeforeStart: 2, settled: 1 },
      "abort and shutdown each count only queued work before the epoch boundary",
    );
    scheduler.resetMetrics();
    scheduler.startSession(3);
    assert.equal(scheduler.maxActive, 3);
    assert.deepEqual(scheduler.getMetricsSnapshot(), {
      epoch: 1,
      accepted: 0,
      started: 0,
      cancelledBeforeStart: 0,
      settled: 0,
      enqueueToDispatch: { count: 0, sumMs: 0, maxMs: 0 },
      dispatchToLocalSlotRelease: { count: 0, sumMs: 0, maxMs: 0 },
    });
    const second = scheduler.createHandle();
    assert.deepEqual(await scheduler.schedule(second, async () => "new"), { started: true, value: "new" });
  });

  test("keeps old-generation capacity while projecting only current-generation active work", async () => {
    const scheduler = new ProcessLocalScheduler(1);
    const states: Array<{ active: number; queued: number; generation: number }> = [];
    scheduler.subscribe((state) => states.push({ active: state.active, queued: state.queued, generation: state.generation }));

    const oldHandle = scheduler.createHandle();
    const oldGate = deferred<void>();
    const oldWork = scheduler.schedule(oldHandle, async () => {
      await oldGate.promise;
      return "old";
    });
    assert.deepEqual({ active: scheduler.activeCount, queued: scheduler.queuedCount }, { active: 1, queued: 0 });

    scheduler.startSession();
    const currentGeneration = scheduler.createHandle().generation;
    assert.deepEqual({ active: scheduler.activeCount, queued: scheduler.queuedCount }, { active: 0, queued: 0 });
    assert.deepEqual(states.at(-1), { active: 0, queued: 0, generation: currentGeneration });

    const currentGate = deferred<void>();
    let currentStarted = false;
    const currentHandle = scheduler.createHandle();
    const currentWork = scheduler.schedule(currentHandle, async () => {
      currentStarted = true;
      await currentGate.promise;
      return "current";
    });
    assert.deepEqual({ active: scheduler.activeCount, queued: scheduler.queuedCount }, { active: 0, queued: 1 });

    oldGate.resolve();
    await tick();
    assert.equal(currentStarted, true, "old work releases shared capacity for the current generation");
    assert.deepEqual({ active: scheduler.activeCount, queued: scheduler.queuedCount }, { active: 1, queued: 0 });

    currentGate.resolve();
    await Promise.all([oldWork, currentWork]);
    assert.deepEqual({ active: scheduler.activeCount, queued: scheduler.queuedCount }, { active: 0, queued: 0 });
    assert.ok(states.filter((state) => state.generation === currentGeneration).every((state) => state.active >= 0 && state.queued >= 0));
  });

  test("notifies immutable state observers when saturated work dispatches or is cancelled", async () => {
    const scheduler = new ProcessLocalScheduler(1);
    const states: Array<{ active: number; queued: number }> = [];
    const unsubscribe = scheduler.subscribe((state) => {
      assert.ok(Object.isFrozen(state));
      states.push({ active: state.active, queued: state.queued });
    });
    const handle = scheduler.createHandle();
    const firstGate = deferred<void>();
    const first = scheduler.schedule(handle, async () => {
      await firstGate.promise;
      return "first";
    });
    const dispatchedGate = deferred<void>();
    const dispatched = scheduler.schedule(handle, async () => {
      await dispatchedGate.promise;
      return "dispatched";
    });

    assert.equal(scheduler.activeCount, 1);
    assert.equal(scheduler.queuedCount, 1);
    assert.ok(states.some((state) => state.active === 1 && state.queued === 1));

    const stateCountBeforeDispatch = states.length;
    firstGate.resolve();
    await tick();
    assert.equal(scheduler.queuedCount, 0);
    assert.ok(states.slice(stateCountBeforeDispatch).some((state) => state.active === 1 && state.queued === 0));
    dispatchedGate.resolve();
    await Promise.all([first, dispatched]);

    const blockedGate = deferred<void>();
    const blocked = scheduler.schedule(handle, async () => {
      await blockedGate.promise;
      return "blocked";
    });
    const controller = new AbortController();
    const cancelled = scheduler.schedule(handle, async () => "cancelled", controller.signal);
    assert.equal(scheduler.queuedCount, 1);
    const stateCountBeforeCancellation = states.length;
    controller.abort();
    assert.deepEqual(await cancelled, { started: false });
    assert.equal(scheduler.queuedCount, 0);
    assert.ok(states.slice(stateCountBeforeCancellation).some((state) => state.active === 1 && state.queued === 0));
    blockedGate.resolve();
    await blocked;
    unsubscribe();
  });
});
