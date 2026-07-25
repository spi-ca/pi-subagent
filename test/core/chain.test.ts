import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildChainTaskFromStages,
  shouldRunStage,
  validateChainLabels,
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

  test("rejects duplicate labels", () => {
    assert.match(validateChainLabels([
      { label: "x", agent: "scout", task: "Inspect" },
      { label: "x", agent: "planner", task: "Plan" },
    ] as any) ?? "", /Duplicate chain label/);
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
});
