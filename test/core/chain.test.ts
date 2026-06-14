import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildChainTaskFromStages, shouldRunStage, validateChainStages } from "../../src/core/chain-helpers";

describe("mixed chain helpers", () => {
  test("accepts sequential stages and parallel stages", () => {
    const error = validateChainStages([
      { label: "discover", type: "parallel", tasks: [
        { agent: "scout", task: "Inspect local code" },
        { agent: "researcher", task: "Check docs" },
      ] },
      { label: "plan", agent: "planner", task: "Plan from discovery" },
    ] as any);

    assert.equal(error, null);
  });

  test("rejects duplicate labels and empty parallel groups", () => {
    assert.match(validateChainStages([
      { label: "x", agent: "scout", task: "Inspect" },
      { label: "x", agent: "planner", task: "Plan" },
    ] as any) ?? "", /Duplicate chain label/);

    assert.match(validateChainStages([
      { label: "empty", type: "parallel", tasks: [] },
    ] as any) ?? "", /requires a non-empty tasks array/);
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
