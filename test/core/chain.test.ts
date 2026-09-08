import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildChainTaskFromStages,
  formatChainStageEnvelope,
  shouldRunStage,
  validateChainLabels,
  validateChainLeafTaskLimit,
  validateChainParallelLimit,
} from "../../src/core/chain-helpers";

describe("mixed chain helpers", () => {
  test("accepts sequential stages and parallel stages", () => {
    const error = validateChainLabels([
      { label: "discover", type: "parallel", tasks: [
        { agent: "scout", task: "Inspect local code" },
        { agent: "researcher", task: "Check docs" },
      ] },
      { label: "plan", agent: "planner", task: "Plan from discovery" },
    ] as any);

    assert.equal(error, null);
  });

  test("rejects duplicate labels without exposing their raw value", () => {
    const secretLabel = "secret-chain-label";
    const message = validateChainLabels([
      { label: secretLabel, agent: "scout", task: "Inspect" },
      { label: secretLabel, agent: "planner", task: "Plan" },
    ] as any) ?? "";
    assert.match(message, /Duplicate chain label at chain\[1\]/);
    assert.equal(message.includes(secretLabel), false);
  });

  test("uses the configured chain parallel limit rather than the legacy default of eight", () => {
    const stage = [{
      label: "fan-out",
      type: "parallel",
      tasks: Array.from({ length: 9 }, (_, index) => ({ agent: `worker-${index}`, task: "Inspect" })),
    }] as any;

    assert.equal(validateChainParallelLimit(stage, 9), null);
    assert.match(validateChainParallelLimit(stage, 8) ?? "", /Max is 8/);
  });

  test("enforces one aggregate ceiling across sequential and parallel leaf tasks", () => {
    const chain = [
      { agent: "scout", task: "one" },
      { type: "parallel", tasks: [{ agent: "worker", task: "two" }, { agent: "worker", task: "three" }] },
      { agent: "planner", task: "four" },
    ] as any;
    assert.equal(validateChainLeafTaskLimit(chain, 4), null);
    assert.match(validateChainLeafTaskLimit(chain, 3) ?? "", /aggregate leaf tasks.*\(4\).*Max is 3/);
  });

  test("evaluates conditions from accumulated chain state", () => {
    assert.equal(shouldRunStage(undefined, { hadError: false, hadCompletedWithErrors: false, hadBlockingError: false } as any), true);
    assert.equal(shouldRunStage("on_success", { hadError: true, hadCompletedWithErrors: true, hadBlockingError: true } as any), false);
    assert.equal(shouldRunStage("on_success", { hadError: true, hadCompletedWithErrors: true, hadBlockingError: false } as any), true);
    assert.equal(shouldRunStage("on_error", { hadError: true, hadCompletedWithErrors: false, hadBlockingError: false } as any), true);
    assert.equal(shouldRunStage("on_completed_with_errors", { hadError: true, hadCompletedWithErrors: true, hadBlockingError: false } as any), true);
    assert.equal(shouldRunStage("always", { hadError: true, hadCompletedWithErrors: false, hadBlockingError: true } as any), true);
  });

  test("omits skipped stages from injected task context", () => {
    const task = buildChainTaskFromStages("Do current work", [
      { label: "optional", type: "chain", status: "skipped", results: [], reason: "condition on_error not met" },
    ] as any);

    assert.equal(task, "Do current work");
  });

  test("keeps the chain aggregate count in the final line-limit envelope", () => {
    const stages = ["first", "second", "third"].map((label, index) => ({
      label,
      type: "chain" as const,
      status: "completed" as const,
      results: [{
        agent: `worker-${index + 1}`,
        agentSource: "user" as const,
        task: "task",
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: index === 0 ? Array(1_993).fill("line").join("\n") : "small" }] }],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      }],
    }));
    const text = formatChainStageEnvelope("Chain: 1/3 stages completed", stages as any);
    assert.equal(text.split("\n").length, 2_000);
    assert.match(text, /\[2 chain stage records omitted:/);
    assert.equal(text.includes("Output records omitted"), false);
  });

  test("bounds prior-stage handoffs by whole records without displacing the current task", () => {
    const priorOutput = "prior-output-must-not-be-partially-injected ".repeat(2_000);
    const currentTask = "Current task: preserve this exact instruction and machine-id-42";
    const task = buildChainTaskFromStages(currentTask, [{
      label: "discover-machine-id-1",
      type: "chain",
      status: "completed",
      results: [{
        agent: "scout-machine-id-2",
        agentSource: "user",
        task: "discover",
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: priorOutput }] }],
        stderr: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      }],
    }] as any);

    assert.match(task, /\[1 chain stage record omitted: the fixed model-visible output budget was exhausted; content is unavailable to this chain handoff\.\]/);
    assert.equal(task.includes(priorOutput.slice(0, 100)), false);
    assert.equal(task.includes("tool details"), false, "a child handoff cannot access parent tool details");
    assert.ok(task.endsWith(`Current task:\n${currentTask}`));
  });
});
