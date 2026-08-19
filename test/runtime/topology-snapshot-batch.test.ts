import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { TopologySnapshotBatch } from "../../src/runtime/topology-snapshot-batch";
import { inspectCanonicalCmuxSurfaceTree } from "../../src/runtime/cmux";
import { parseTmuxPaneSnapshots, parseTmuxServerPidOutput } from "../../src/runtime/tmux";

describe("TopologySnapshotBatch", () => {
  test("collapses only concurrent same-generation reads and drops settled evidence", async () => {
    const batch = new TopologySnapshotBatch();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = async () => { calls += 1; await gate; return { tree: calls }; };
    const [first, joined] = await Promise.all([
      batch.read({ generation: 4, key: "cmux:/bin/cmux:workspace", fetch }),
      batch.read({ generation: 4, key: "cmux:/bin/cmux:workspace", fetch }),
    ].map(async (pending) => { release(); return await pending; }));
    assert.deepEqual(first, { state: "known", value: { tree: 1 } });
    assert.deepEqual(joined, first);
    assert.equal(calls, 1);
    assert.deepEqual(batch.metrics(), { fetches: 1, joins: 1, unknown: 0 });

    const fresh = await batch.read({ generation: 4, key: "cmux:/bin/cmux:workspace", fetch: async () => ({ tree: ++calls }) });
    assert.deepEqual(fresh, { state: "known", value: { tree: 2 } });
    assert.equal(calls, 2, "settled snapshot must not become mutation/cache authority");
  });

  test("separates canonical keys and generations", async () => {
    const batch = new TopologySnapshotBatch();
    let calls = 0;
    await Promise.all([
      batch.read({ generation: 1, key: "cmux:a", fetch: async () => ++calls }),
      batch.read({ generation: 2, key: "cmux:a", fetch: async () => ++calls }),
      batch.read({ generation: 1, key: "cmux:b", fetch: async () => ++calls }),
    ]);
    assert.equal(calls, 3);
    assert.deepEqual(batch.metrics(), { fetches: 3, joins: 0, unknown: 0 });
  });

  test("does not join a stale tmux transport epoch to a fresh batch", async () => {
    const batch = new TopologySnapshotBatch();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetch = async () => { calls += 1; await gate; return calls; };
    const stale = batch.read({ generation: 7, key: "tmux:opaque-transport:0", fetch });
    const fresh = batch.read({ generation: 8, key: "tmux:opaque-transport:0", fetch });
    await Promise.resolve();
    assert.equal(calls, 2);
    release();
    assert.deepEqual(await stale, { state: "known", value: 2 });
    assert.deepEqual(await fresh, { state: "known", value: 2 });
    assert.deepEqual(batch.metrics(), { fetches: 2, joins: 0, unknown: 0 });
  });

  test("shares raw topology while each cmux/tmux handle parses its own strict fingerprint", async () => {
    const batch = new TopologySnapshotBatch();
    const workspace = "123e4567-e89b-12d3-a456-426614174000";
    const present = "123e4567-e89b-12d3-a456-426614174001";
    const absent = "123e4567-e89b-12d3-a456-426614174002";
    const pane = "123e4567-e89b-12d3-a456-426614174003";
    let cmuxFetches = 0;
    const rawTree = JSON.stringify({ windows: [{ workspaces: [{ id: workspace, panes: [{ id: pane, surfaces: [{ id: present, pane_id: pane }] }] }] }] });
    const [cmuxOne, cmuxTwo] = await Promise.all([
      batch.read({ generation: 3, key: "cmux:exe:workspace", fetch: async () => { cmuxFetches += 1; return rawTree; } }),
      batch.read({ generation: 3, key: "cmux:exe:workspace", fetch: async () => rawTree }),
    ]);
    assert.equal(cmuxFetches, 1);
    assert.equal(cmuxOne.state, "known");
    assert.equal(cmuxTwo.state, "known");
    if (cmuxOne.state === "known" && cmuxTwo.state === "known") {
      assert.deepEqual(inspectCanonicalCmuxSurfaceTree(cmuxOne.value, workspace, present), { exists: true, workspaceId: workspace, paneId: pane, surfaceId: present, title: undefined, type: undefined });
      assert.deepEqual(inspectCanonicalCmuxSurfaceTree(cmuxTwo.value, workspace, absent), { exists: false });
    }

    const tmux = await batch.read({
      generation: 3,
      key: "tmux:exe:socket:99",
      fetch: async () => ({ server: "99\n", panes: "%1|0|100\n%2|0|200\n" }),
    });
    assert.equal(tmux.state, "known");
    if (tmux.state === "known") {
      assert.equal(parseTmuxServerPidOutput(tmux.value.server), 99);
      const first = parseTmuxPaneSnapshots(tmux.value.panes)?.get("%1");
      const second = parseTmuxPaneSnapshots(tmux.value.panes)?.get("%2");
      assert.equal(first?.panePid, 100);
      assert.equal(second?.panePid, 200);
    }
  });

  test("clears and unrefs timeout timers while aborting cooperative work", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let fireTimeout!: () => void;
    let unreferenced = false;
    let clears = 0;
    const timer = { unref: () => { unreferenced = true; } } as unknown as ReturnType<typeof setTimeout>;
    try {
      (globalThis as any).setTimeout = (callback: () => void) => { fireTimeout = callback; return timer; };
      (globalThis as any).clearTimeout = (value: unknown) => { if (value === timer) clears += 1; };
      const batch = new TopologySnapshotBatch({ timeoutMs: 5 });
      let aborted = false;
      const pending = batch.read({
        generation: 1,
        key: "tmux:cooperative",
        fetch: async (signal) => await new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => { aborted = true; resolve("late"); }, { once: true });
        }),
      });
      await Promise.resolve();
      fireTimeout();
      assert.deepEqual(await pending, { state: "unknown" });
      assert.equal(aborted, true);
      assert.equal(unreferenced, true);
      assert.equal(clears, 1);
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
      (globalThis as any).clearTimeout = originalClearTimeout;
    }
  });

  test("keeps non-cooperative timed-out work single-flight until its backend settles", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timeoutCallbacks: Array<() => void> = [];
    try {
      (globalThis as any).setTimeout = (callback: () => void) => { timeoutCallbacks.push(callback); return { unref() {} }; };
      (globalThis as any).clearTimeout = () => {};
      const batch = new TopologySnapshotBatch({ timeoutMs: 5 });
      let calls = 0;
      let release!: () => void;
      const neverCooperates = async (_signal: AbortSignal) => {
        calls += 1;
        await new Promise<void>((resolve) => { release = resolve; });
        return "late";
      };
      const first = batch.read({ generation: 1, key: "tmux:s", fetch: neverCooperates });
      await Promise.resolve();
      timeoutCallbacks.shift()!();
      assert.deepEqual(await first, { state: "unknown" });

      const joined = await batch.read({ generation: 1, key: "tmux:s", fetch: neverCooperates });
      assert.deepEqual(joined, { state: "unknown" });
      assert.equal(calls, 1, "a retry cannot start another backend while the timed-out backend is still running");

      release();
      // Backend completion, its settled projection, and map cleanup are
      // deliberately separate microtasks from the timeout result.
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
      const fresh = await batch.read({ generation: 1, key: "tmux:s", fetch: async () => "fresh" });
      assert.deepEqual(fresh, { state: "known", value: "fresh" });
      assert.equal(calls, 1);
      assert.deepEqual(batch.metrics(), { fetches: 2, joins: 1, unknown: 2 });
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
      (globalThis as any).clearTimeout = originalClearTimeout;
    }
  });

  test("does not let a timed-out pre-reset backend remove a new-generation lookup", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timeoutCallbacks: Array<() => void> = [];
    try {
      (globalThis as any).setTimeout = (callback: () => void) => { timeoutCallbacks.push(callback); return { unref() {} }; };
      (globalThis as any).clearTimeout = () => {};
      const batch = new TopologySnapshotBatch({ timeoutMs: 5 });
      let calls = 0;
      let releaseOld!: () => void;
      let releaseFresh!: () => void;
      const fetch = async (_signal: AbortSignal) => {
        const call = ++calls;
        await new Promise<void>((resolve) => { if (call === 1) releaseOld = resolve; else releaseFresh = resolve; });
        return call === 1 ? "old" : "fresh";
      };

      const old = batch.read({ generation: 1, key: "tmux:s", fetch });
      await Promise.resolve();
      timeoutCallbacks.shift()!();
      assert.deepEqual(await old, { state: "unknown" });

      batch.reset();
      const fresh = batch.read({ generation: 1, key: "tmux:s", fetch });
      await Promise.resolve();
      assert.equal(calls, 2);
      releaseOld();
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();

      const joined = batch.read({ generation: 1, key: "tmux:s", fetch });
      assert.equal(calls, 2, "the old backend must not delete the post-reset in-flight entry");
      releaseFresh();
      assert.deepEqual(await fresh, { state: "known", value: "fresh" });
      assert.deepEqual(await joined, { state: "known", value: "fresh" });
    } finally {
      (globalThis as any).setTimeout = originalSetTimeout;
      (globalThis as any).clearTimeout = originalClearTimeout;
    }
  });

  test("fans out malformed sentinel and failure as unknown then retries", async () => {
    const batch = new TopologySnapshotBatch();
    const [failedOne, failedTwo] = await Promise.all([
      batch.read({ generation: 1, key: "tmux:s", fetch: async () => { throw new Error("malformed"); } }),
      batch.read({ generation: 1, key: "tmux:s", fetch: async () => undefined }),
    ]);
    assert.deepEqual(failedOne, { state: "unknown" });
    assert.deepEqual(failedTwo, { state: "unknown" });
    const retry = await batch.read({ generation: 1, key: "tmux:s", fetch: async () => "fresh" });
    assert.deepEqual(retry, { state: "known", value: "fresh" });
  });
});
