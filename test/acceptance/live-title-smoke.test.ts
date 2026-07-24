import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { LIVE_TITLE_GATE, parseLiveTitleArgs, requireLiveTitleGate, runLiveTitleSmoke } from "./live-title-smoke";

describe("opt-in live title smoke guards", () => {
  test("accepts only explicit backend and optional dry-run", () => {
    assert.deepEqual(parseLiveTitleArgs(["tmux"]), { mode: "tmux", dryRun: false });
    assert.deepEqual(parseLiveTitleArgs(["cmux", "--dry-run"]), { mode: "cmux", dryRun: true });
    for (const argv of [[], ["inline"], ["tmux", "--live"], ["tmux", "--dry-run", "extra"]]) {
      assert.throws(() => parseLiveTitleArgs(argv), /usage/);
    }
  });

  test("requires a distinct live gate but dry-run never requires tools or mutates", async () => {
    assert.throws(() => requireLiveTitleGate({}), new RegExp(LIVE_TITLE_GATE));
    assert.doesNotThrow(() => requireLiveTitleGate({ [LIVE_TITLE_GATE]: "1" }));
    assert.deepEqual(await runLiveTitleSmoke({ mode: "tmux", dryRun: true }, {}), {
      mode: "tmux", dryRun: true, mutation: "none", requiredGate: `${LIVE_TITLE_GATE}=1`,
    });
    assert.deepEqual(await runLiveTitleSmoke({ mode: "cmux", dryRun: true }, {}), {
      mode: "cmux", dryRun: true, mutation: "none", requiredGate: `${LIVE_TITLE_GATE}=1`,
    });
  });
});
