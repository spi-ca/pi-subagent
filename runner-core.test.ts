import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createJsonLineChunkProcessor, monitorZellijPaneLifecycle, updatePaneWatchState } from "./runner-core";

describe("runner core helpers", () => {
  test("splits chunked JSONL lines like the inline runner", () => {
    const lines: string[] = [];
    const processor = createJsonLineChunkProcessor((line) => lines.push(line));

    processor.pushChunk('{"type":"message_end"');
    processor.pushChunk(',"message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}\n');
    processor.pushChunk('{"type":"agent_end","messages":[]}');
    processor.flushRemainder();

    assert.deepEqual(lines, [
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"DONE"}]}}',
      '{"type":"agent_end","messages":[]}',
    ]);
  });

  test("marks manual pane disappearance after the grace interval", () => {
    const start = 1000;
    const initial = updatePaneWatchState(
      { abortDeadline: null, paneExitedAt: null, paneMissingAt: null, wasAborted: false, closeRequested: false, queryFailureCount: 0 },
      { now: start, abortWaitMs: 3000, signalAborted: false, paneInfo: null, paneId: "terminal_1" },
    );
    assert.equal(initial.shouldBreak, false);

    const expired = updatePaneWatchState(initial.state, {
      now: start + 3001,
      abortWaitMs: 3000,
      signalAborted: false,
      paneInfo: null,
      paneId: "terminal_1",
    });
    assert.equal(expired.shouldBreak, true);
    assert.equal(expired.manualExitError, "Zellij pane terminal_1 closed before writing subagent status.");
  });

  test("propagates exited pane status after the grace interval", () => {
    const start = 2000;
    const initial = updatePaneWatchState(
      { abortDeadline: null, paneExitedAt: null, paneMissingAt: null, wasAborted: false, closeRequested: false, queryFailureCount: 0 },
      { now: start, abortWaitMs: 3000, signalAborted: false, paneInfo: { exited: true, exitStatus: 7 }, paneId: "terminal_3" },
    );
    assert.equal(initial.shouldBreak, false);

    const expired = updatePaneWatchState(initial.state, {
      now: start + 3001,
      abortWaitMs: 3000,
      signalAborted: false,
      paneInfo: { exited: true, exitStatus: 7 },
      paneId: "terminal_3",
    });
    assert.equal(expired.shouldBreak, true);
    assert.equal(expired.manualExitError, "Zellij pane terminal_3 exited without writing subagent status.");
    assert.equal(expired.exitCode, 7);
  });

  test("resets exited timing when pane becomes missing before reappearing as exited", () => {
    const firstExit = updatePaneWatchState(
      { abortDeadline: null, paneExitedAt: null, paneMissingAt: null, wasAborted: false, closeRequested: false, queryFailureCount: 0 },
      { now: 1000, abortWaitMs: 3000, signalAborted: false, paneInfo: { exited: true, exitStatus: 9 }, paneId: "terminal_4" },
    );
    const missing = updatePaneWatchState(firstExit.state, {
      now: 2000,
      abortWaitMs: 3000,
      signalAborted: false,
      paneInfo: null,
      paneId: "terminal_4",
    });
    const exitedAgain = updatePaneWatchState(missing.state, {
      now: 2500,
      abortWaitMs: 3000,
      signalAborted: false,
      paneInfo: { exited: true, exitStatus: 9 },
      paneId: "terminal_4",
    });
    assert.equal(exitedAgain.shouldBreak, false);
  });

  test("runs lifecycle polling and closes the pane when aborted", async () => {
    const paneInfoCalls: Array<undefined | null | { exited?: boolean; exitStatus?: number | null }> = [undefined, undefined];
    const closed: string[] = [];
    const controller = new AbortController();
    controller.abort();

    const result = await monitorZellijPaneLifecycle({
      paneId: "terminal_5",
      signal: controller.signal,
      abortWaitMs: 3000,
      pollIntervalMs: 1,
      fileExists: async () => false,
      getPaneInfo: async () => paneInfoCalls.shift(),
      closePane: async () => {
        closed.push("closed");
        return true;
      },
      delay: async () => undefined,
      now: (() => {
        let now = 0;
        return () => (now += 3001);
      })(),
    });

    assert.equal(result.statusSeen, false);
    assert.equal(result.wasAborted, true);
    assert.equal(closed.length >= 1, true);
  });

  test("returns manual close errors from lifecycle polling", async () => {
    const sequence: Array<null> = [null, null];
    const result = await monitorZellijPaneLifecycle({
      paneId: "terminal_6",
      signal: undefined,
      abortWaitMs: 3000,
      pollIntervalMs: 1,
      fileExists: async () => false,
      getPaneInfo: async () => sequence.shift() ?? null,
      closePane: async () => true,
      delay: async () => undefined,
      now: (() => {
        let now = 1000;
        return () => (now += 3001);
      })(),
    });

    assert.equal(result.manualExitError, "Zellij pane terminal_6 closed before writing subagent status.");
  });

  test("fails after repeated pane query errors", () => {
    const first = updatePaneWatchState(
      { abortDeadline: null, paneExitedAt: null, paneMissingAt: null, wasAborted: false, closeRequested: false, queryFailureCount: 0 },
      { now: 1, abortWaitMs: 3000, signalAborted: false, paneInfo: undefined, paneId: "terminal_7", maxQueryFailures: 2 },
    );
    assert.equal(first.shouldBreak, false);
    assert.equal(first.queryFailed, true);

    const second = updatePaneWatchState(first.state, {
      now: 2,
      abortWaitMs: 3000,
      signalAborted: false,
      paneInfo: undefined,
      paneId: "terminal_7",
      maxQueryFailures: 2,
    });
    assert.equal(second.shouldBreak, true);
    assert.equal(second.manualExitError, "Zellij pane terminal_7 could not be queried after 2 attempts.");
  });

  test("breaks aborted pane polling even when pane queries keep failing", () => {
    const outcome = updatePaneWatchState(
      { abortDeadline: null, paneExitedAt: null, paneMissingAt: null, wasAborted: false, closeRequested: false, queryFailureCount: 0 },
      { now: 5000, abortWaitMs: 3000, signalAborted: true, paneInfo: undefined, paneId: "terminal_2" },
    );
    assert.equal(outcome.shouldClosePane, true);
    assert.equal(outcome.shouldBreak, false);
    assert.equal(outcome.queryFailed, true);

    const expired = updatePaneWatchState(outcome.state, {
      now: 8001,
      abortWaitMs: 3000,
      signalAborted: true,
      paneInfo: undefined,
      paneId: "terminal_2",
    });
    assert.equal(expired.shouldBreak, true);
    assert.equal(expired.state.wasAborted, true);
  });
});
