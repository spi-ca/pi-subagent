import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  buildChainTaskFromStages,
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
});
