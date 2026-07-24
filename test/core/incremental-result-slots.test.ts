import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { IncrementalResultSlots } from "../../src/core/incremental-result-slots";
import { emptyUsage, type SingleResult } from "../../src/core/types";

function result(
  agent: string,
  exitCode = -1,
  usage: Partial<SingleResult["usage"]> = {},
): SingleResult {
  return {
    agent,
    agentSource: "user",
    task: `${agent} task`,
    exitCode,
    messages: [],
    stderr: "",
    usage: { ...emptyUsage(), ...usage },
    ...(exitCode === 0 ? { sawAgentEnd: true, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] } : {}),
  } as SingleResult;
}

describe("IncrementalResultSlots", () => {
  test("replaces repeated same-slot usage snapshots without double counting", () => {
    const slots = new IncrementalResultSlots([result("one")]);
    slots.replace(0, result("one", -1, { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1, turns: 1 }));
    slots.replace(0, result("one", -1, { input: 15, output: 5, cacheRead: 7, cacheWrite: 8, cost: 0.25, turns: 2 }));

    const snapshot = slots.snapshot();
    assert.deepEqual(snapshot.usage, { input: 15, output: 5, cacheRead: 7, cacheWrite: 8, cost: 0.25, turns: 2 });
    assert.equal(snapshot.runningCount, 1);
    assert.equal(snapshot.doneCount, 0);
  });

  test("accounts correctly when production mutates the same result object in place", () => {
    const mutable = result("one", -1, { input: 2, turns: 1 });
    const slots = new IncrementalResultSlots([mutable]);
    mutable.exitCode = 0;
    mutable.sawAgentEnd = true;
    mutable.messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] } as any];
    mutable.usage.input = 9;
    mutable.usage.turns = 2;
    slots.replace(0, mutable);

    const snapshot = slots.snapshot();
    assert.equal(snapshot.runningCount, 0);
    assert.equal(snapshot.doneCount, 1);
    assert.equal(snapshot.successCount, 1);
    assert.deepEqual(snapshot.usage, { input: 9, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 2 });
  });

  test("counts a running-to-terminal transition exactly once", () => {
    const slots = new IncrementalResultSlots([result("one")]);
    const completed = result("one", 0, { turns: 1 });
    slots.replace(0, completed);
    slots.replace(0, completed);

    const snapshot = slots.snapshot();
    assert.equal(snapshot.runningCount, 0);
    assert.equal(snapshot.doneCount, 1);
    assert.equal(snapshot.successCount, 1);
    assert.equal(snapshot.failureCount, 0);
    assert.equal(snapshot.usage.turns, 1);
  });

  test("keeps result order when child updates arrive out of order", () => {
    const slots = new IncrementalResultSlots([result("first"), result("second"), result("third")]);
    slots.replace(2, result("third", 1));
    slots.replace(0, result("first", 0));

    const snapshot = slots.snapshot();
    assert.deepEqual(snapshot.results.map((item) => item.agent), ["first", "second", "third"]);
    assert.equal(snapshot.runningCount, 1);
    assert.equal(snapshot.doneCount, 2);
    assert.equal(snapshot.successCount, 1);
    assert.equal(snapshot.failureCount, 1);
  });

  test("replaces usage independently across slots and does not aggregate context or model", () => {
    const slots = new IncrementalResultSlots([
      result("first", -1, { input: 10, contextTokens: 100, turns: 1 }),
      result("second", -1, { input: 20, contextTokens: 200, turns: 2 }),
    ]);
    slots.replace(0, result("first", -1, { input: 15, contextTokens: 300, turns: 3 }));

    const snapshot = slots.snapshot();
    assert.deepEqual(snapshot.usage, { input: 35, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 5 });
    assert.equal(snapshot.results[0].usage.contextTokens, 300);
    assert.equal(snapshot.results[1].usage.contextTokens, 200);
  });

  test("supports unchanged callback traces and heartbeat checks with isolated array snapshots", () => {
    const slots = new IncrementalResultSlots([result("one")]);
    const trace: Array<{ kind: string; running: boolean; results: SingleResult[] }> = [];
    const emit = (kind: string) => {
      const snapshot = slots.snapshot();
      trace.push({ kind, running: slots.hasRunning, results: snapshot.results });
    };

    emit("initial");
    if (slots.hasRunning) emit("heartbeat");
    slots.replace(0, result("one", -1, { turns: 1 }));
    emit("update");
    if (slots.hasRunning) emit("heartbeat");
    slots.replace(0, result("one", 0, { turns: 2 }));
    emit("terminal");

    assert.deepEqual(trace.map((entry) => entry.kind), ["initial", "heartbeat", "update", "heartbeat", "terminal"]);
    assert.deepEqual(trace.map((entry) => entry.running), [true, true, true, true, false]);
    trace[0].results.pop();
    assert.equal(slots.snapshot().results.length, 1);
  });
});
