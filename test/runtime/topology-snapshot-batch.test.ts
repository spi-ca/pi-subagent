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

  test("fans out timeout, malformed sentinel, and failure as unknown then retries", async () => {
    const timeout = new TopologySnapshotBatch({ timeoutMs: 5 });
    let pendingCalls = 0;
    const never = async () => { pendingCalls += 1; return await new Promise<string>(() => {}); };
    const [one, two] = await Promise.all([
      timeout.read({ generation: 1, key: "tmux:s", fetch: never }),
      timeout.read({ generation: 1, key: "tmux:s", fetch: never }),
    ]);
    assert.deepEqual(one, { state: "unknown" });
    assert.deepEqual(two, { state: "unknown" });
    assert.equal(pendingCalls, 1);
    assert.deepEqual(timeout.metrics(), { fetches: 1, joins: 1, unknown: 2 });

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
