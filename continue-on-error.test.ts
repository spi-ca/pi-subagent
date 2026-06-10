import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { shouldRunStage } from "./chain-helpers";

describe("continueOnError semantics", () => {
  test("default on_success stages still run after completed_with_errors", () => {
    const state = {
      hadError: true,
      hadCompletedWithErrors: true,
      hadBlockingError: false,
    } as const;

    assert.equal(shouldRunStage(undefined, state as any), true);
    assert.equal(shouldRunStage("on_success", state as any), true);
  });
});
