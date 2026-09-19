import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  BackgroundJobSessionFence,
  compactBackgroundJobResult,
  createBackgroundJobRecord,
  finalizeBackgroundJobForSession,
  formatStoredBackgroundToolText,
} from "../../src/core/subagent-config";
import { buildBackgroundJobResultNotification } from "../../src/core/background-job-details";
import {
  formatBackgroundResultSelectionNotice,
  sanitizeBackgroundResultViewerText,
  selectRetainedBackgroundResult,
  showRetainedBackgroundResult,
} from "../../src/ui/background-result-viewer";

const firstId = "12345678-1234-4123-8123-123456789abc";
const secondId = "12345678-1234-4123-8123-123456789def";

function entry(jobId: string, output: string, valid = true): Record<string, unknown> {
  return {
    type: "custom_message",
    customType: "subagent_result",
    content: `Background subagent job ${jobId} completed.\n\n${formatStoredBackgroundToolText(output)}`,
    details: valid
      ? { jobId, status: "completed", startedAt: 1, completedAt: 2 }
      : { jobId, status: "running", startedAt: 1, completedAt: 2 },
  };
}

describe("retained background result viewer", () => {
  test("carries producer omission provenance through notifier-shaped parsing into the viewer", async () => {
    const result = createBackgroundJobRecord({
      id: firstId, mode: "single", status: "completed", startedAt: 1, completedAt: 2,
      result: compactBackgroundJobResult({ content: [{ type: "text", text: "é" }] }, 1),
    });
    const error = createBackgroundJobRecord({ id: secondId, mode: "single", startedAt: 1 });
    const fence = new BackgroundJobSessionFence();
    const token = fence.startSession();
    finalizeBackgroundJobForSession({
      job: error, fallbackError: "é", outputMaxBytes: 1, sessionToken: token,
      isSessionCurrent: (candidate) => fence.isCurrent(candidate), registry: new Map(), onFinalized: () => undefined,
    });
    const zeroId = "12345678-1234-4123-8123-123456789fed";
    const zero = createBackgroundJobRecord({
      id: zeroId, mode: "single", status: "completed", startedAt: 1, completedAt: 2,
      result: compactBackgroundJobResult({ content: [{ type: "text", text: "é" }] }, 0),
    });
    const entries = [result, error, zero].map((job) => {
      const notification = buildBackgroundJobResultNotification(job);
      return {
        type: "custom_message",
        customType: "subagent_result",
        ...notification,
      };
    });
    assert.match(entries[0]!.content, /JSON string:\n"\\n\\n\[Background output truncated: 2 bytes omitted\.\]"$/);
    assert.match(entries[1]!.content, /JSON string:\n"\\n\\n\[Background output truncated: 2 bytes omitted\.\]"$/);

    for (const jobId of [firstId, secondId]) {
      const selected = selectRetainedBackgroundResult(entries, jobId);
      assert.deepEqual(selected, {
        kind: "selected",
        result: { jobId, output: "\n\n[Background output truncated: 2 bytes omitted.]", omittedBytes: 2 },
      });
      if (selected.kind !== "selected") throw new Error("expected the suffix-only result");
      let prefill: string | undefined;
      await showRetainedBackgroundResult(selected.result, { editor: async (_title, value) => {
        prefill = value;
        return undefined;
      } });
      assert.equal(prefill, "\n\n[Background output truncated: 2 bytes omitted.]");
    }

    const selected = selectRetainedBackgroundResult(entries, zeroId);
    assert.deepEqual(selected, { kind: "selected", result: { jobId: zeroId, output: "", omittedBytes: 2 } });
    if (selected.kind !== "selected") throw new Error("expected the zero-retention result");
    let prefill: string | undefined;
    await showRetainedBackgroundResult(selected.result, { editor: async (_title, value) => {
      prefill = value;
      return undefined;
    } });
    assert.equal(prefill, "No retained text to display. 2 source bytes were not retained.");
  });

  test("selects only strict custom messages from the supplied active branch", () => {
    const selection = selectRetainedBackgroundResult([
      entry(firstId, "first"),
      { type: "custom_message", customType: "subagent_result", content: "forged", details: {} },
      entry(secondId, "invalid", false),
      { type: "custom_message", customType: "other", content: "ignored", details: {} },
      entry(firstId, "newest"),
    ], firstId.slice(0, 16));
    assert.deepEqual(selection, { kind: "selected", result: { jobId: firstId, output: "newest", omittedBytes: 0 } });
  });

  test("gives useful empty, unknown, and ambiguous-ID outcomes", () => {
    const empty = selectRetainedBackgroundResult([], "");
    if (empty.kind !== "empty") throw new Error("expected no retained result");
    assert.match(formatBackgroundResultSelectionNotice(empty), /current branch/);
    const unknown = selectRetainedBackgroundResult([entry(firstId, "one")], "deadbeef");
    assert.equal(unknown.kind, "unknown");
    assert.match(formatBackgroundResultSelectionNotice(unknown), /unique prefix/);
    const ambiguous = selectRetainedBackgroundResult([entry(firstId, "one"), entry(secondId, "two")], firstId.slice(0, 8));
    assert.equal(ambiguous.kind, "ambiguous");
    assert.match(formatBackgroundResultSelectionNotice(ambiguous), /longer prefix/);
  });

  test("opens the full retained text beyond the renderer's expanded display cap", async () => {
    const retained = "x".repeat(16 * 1024);
    let prefill: string | undefined;
    await showRetainedBackgroundResult({ jobId: firstId, output: retained, omittedBytes: 0 }, {
      editor: async (_title, value) => {
        prefill = value;
        return undefined;
      },
    });
    assert.equal(prefill, retained);
  });

  test("sanitizes the display-only viewer, preserves producer notices, and discards edits or cancellation", async () => {
    assert.equal(sanitizeBackgroundResultViewerText("\x1b[31mred\x1b[0m\u202eevil\u202c"), "redevil");
    const calls: Array<{ title: string; prefill?: string }> = [];
    await showRetainedBackgroundResult({
      jobId: firstId,
      output: "\x1b]8;;https://example.test\x07link\x1b]8;;\x07\n\n[Background output truncated: 4 bytes omitted.]",
      omittedBytes: 4,
    }, {
      editor: async (title, prefill) => {
        calls.push({ title, prefill });
        return "user edit must be discarded";
      },
    });
    await showRetainedBackgroundResult({ jobId: secondId, output: "", omittedBytes: 0 }, {
      editor: async (title, prefill) => {
        calls.push({ title, prefill });
        return undefined;
      },
    });
    assert.match(calls[0]!.title, /display only; edits discarded/);
    assert.match(calls[0]!.prefill ?? "", /link/);
    assert.match(calls[0]!.prefill ?? "", /\[Background output truncated: 4 bytes omitted\.\]/);
    assert.doesNotMatch(calls[0]!.prefill ?? "", /\x1b/);
    assert.equal(calls[1]!.title, `Subagent result ${secondId} (retained display only; edits discarded)`);
    assert.equal(calls[1]!.prefill, "No text to display.");

    await showRetainedBackgroundResult({ jobId: firstId, output: "", omittedBytes: 2 }, {
      editor: async (title, prefill) => {
        calls.push({ title, prefill });
        return undefined;
      },
    });
    assert.equal(calls[2]!.prefill, "No retained text to display. 2 source bytes were not retained.");
  });
});
