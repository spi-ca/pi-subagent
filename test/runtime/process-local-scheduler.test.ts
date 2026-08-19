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
    scheduler.shutdown();
    assert.equal(launches, 0);
    releaseFirst();
    await firstJob;
    scheduler.startSession(3);
    assert.equal(scheduler.maxActive, 3);
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
