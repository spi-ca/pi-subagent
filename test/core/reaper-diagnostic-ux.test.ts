import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { ReaperDiagnosticUx } from "../../src/core/reaper-diagnostic-ux";
import type { ReaperDiagnostic } from "../../src/runtime/runner";

const invalidDiagnostic: ReaperDiagnostic = {
  severity: "warning",
  code: "fork-source-invalid",
  message: "Fork source ownership records require inspection. Run /subagents doctor for status.",
  details: {
    scanned: ["554dab1c-4621-44d4-b5de-e45262d0df94"],
    invalid: ["554dab1c-4621-44d4-b5de-e45262d0df94"],
  },
};

describe("reaper diagnostic UX", () => {
  test("notifies a TUI once per diagnostic code without exposing durable details", () => {
    const ux = new ReaperDiagnosticUx();
    const generation = ux.startSession();
    const notifications: Array<{ message: string; type: string }> = [];
    const output = {
      hasUI: true,
      notify: (message: string, type: "warning" | "error") => notifications.push({ message, type }),
      warn: () => { throw new Error("TUI diagnostics must not use console output"); },
    };

    ux.report(generation, invalidDiagnostic, output);
    ux.report(generation, { ...invalidDiagnostic, details: { invalid: ["second-private-id"] } }, output);

    assert.deepEqual(notifications, [{ message: invalidDiagnostic.message, type: "warning" }]);
    assert.doesNotMatch(notifications[0]!.message, /554dab1c|second-private-id|\{/);
  });

  test("routes non-UI diagnostics to a detailed log once", () => {
    const ux = new ReaperDiagnosticUx();
    const generation = ux.startSession();
    const warnings: Array<{ message: string; details: unknown }> = [];
    const output = {
      hasUI: false,
      notify: () => { throw new Error("non-UI diagnostics must not notify"); },
      warn: (message: string, details?: unknown) => warnings.push({ message, details }),
    };

    ux.report(generation, invalidDiagnostic, output);
    ux.report(generation, invalidDiagnostic, output);

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]!.message, `[pi-subagent] ${invalidDiagnostic.message}`);
    assert.deepEqual(warnings[0]!.details, {
      scanned: { count: 1, values: ["554dab1c-4621-44d4-b5de-e45262d0df94"] },
      resolved: { count: 0, values: [] },
      retained: { count: 0, values: [] },
      removed: { count: 0, values: [] },
      invalid: { count: 1, values: ["554dab1c-4621-44d4-b5de-e45262d0df94"] },
    });
  });

  test("bounds detailed non-UI identifier logs", () => {
    const ux = new ReaperDiagnosticUx();
    const generation = ux.startSession();
    let details: unknown;
    const identifiers = Array.from({ length: 25 }, (_, index) => `private-${index}`);
    ux.report(generation, { ...invalidDiagnostic, details: { invalid: identifiers } }, {
      hasUI: false,
      notify: () => undefined,
      warn: (_message, value) => { details = value; },
    });
    assert.deepEqual((details as { invalid: { count: number; values: string[] } }).invalid, {
      count: 25,
      values: identifiers.slice(0, 20),
    });
  });

  test("keeps debug diagnostics silent and exposes sanitized aggregate doctor status", () => {
    const ux = new ReaperDiagnosticUx();
    const generation = ux.startSession();
    let outputCalls = 0;
    ux.report(generation, {
      severity: "debug",
      code: "graph-entry-cap",
      message: "Reaper graph entry cap exceeded; all mutation was deferred.",
      details: { limit: 100_000 },
    }, {
      hasUI: true,
      notify: () => { outputCalls += 1; },
      warn: () => { outputCalls += 1; },
    });
    ux.report(generation, invalidDiagnostic, {
      hasUI: true,
      notify: () => { outputCalls += 1; },
      warn: () => { outputCalls += 1; },
    });

    assert.equal(outputCalls, 1, "only the warning should notify");
    const status = ux.formatDoctorStatus().join("\n");
    assert.match(status, /graph-entry-cap/);
    assert.match(status, /fork-source-invalid, 1 unique invalid record/);
    assert.doesNotMatch(status, /554dab1c|100000|\{/);
  });

  test("falls back to bounded logging when a Pi notification throws", () => {
    const ux = new ReaperDiagnosticUx();
    const generation = ux.startSession();
    const warnings: unknown[] = [];
    ux.report(generation, invalidDiagnostic, {
      hasUI: true,
      notify: () => { throw new Error("TUI unavailable"); },
      warn: (_message, details) => warnings.push(details),
    });
    assert.equal(warnings.length, 1);
  });

  test("aggregates repeated diagnostics without repeating notifications", () => {
    const ux = new ReaperDiagnosticUx();
    const generation = ux.startSession();
    let notifications = 0;
    const output = { hasUI: true, notify: () => { notifications += 1; }, warn: () => undefined };
    ux.report(generation, invalidDiagnostic, output);
    ux.report(generation, { ...invalidDiagnostic, details: { invalid: ["second-private-id"] } }, output);
    assert.equal(notifications, 1);
    assert.match(ux.formatDoctorStatus().join("\n"), /2 occurrences, 2 unique invalid records/);
  });

  test("resets notification deduplication at the session boundary", () => {
    const ux = new ReaperDiagnosticUx();
    let generation = ux.startSession();
    let notifications = 0;
    const output = {
      hasUI: true,
      notify: () => { notifications += 1; },
      warn: () => undefined,
    };
    ux.report(generation, invalidDiagnostic, output);
    generation = ux.startSession();
    assert.deepEqual(ux.formatDoctorStatus(), ["reaper diagnostics: none"]);
    ux.report(generation, invalidDiagnostic, output);
    assert.equal(notifications, 2);
  });

  test("drops diagnostics from invalidated sessions", () => {
    const ux = new ReaperDiagnosticUx();
    const staleGeneration = ux.startSession();
    const currentGeneration = ux.invalidateSession();
    let outputCalls = 0;
    const output = {
      hasUI: true,
      notify: () => { outputCalls += 1; },
      warn: () => { outputCalls += 1; },
    };
    ux.report(staleGeneration, invalidDiagnostic, output);
    assert.equal(outputCalls, 0);
    assert.deepEqual(ux.formatDoctorStatus(), ["reaper diagnostics: none"]);

    ux.report(currentGeneration, invalidDiagnostic, output);
    assert.equal(outputCalls, 1);
  });

  test("maps reconciliation failures to error notifications independently", () => {
    const ux = new ReaperDiagnosticUx();
    const generation = ux.startSession();
    const types: string[] = [];
    ux.report(generation, invalidDiagnostic, {
      hasUI: true,
      notify: (_message, type) => types.push(type),
      warn: () => undefined,
    });
    ux.report(generation, {
      severity: "error",
      code: "fork-source-reconciliation-failed",
      message: "Fork source ownership reconciliation failed. Durable records were retained; run /subagents doctor.",
      details: { error: "private failure" },
    }, {
      hasUI: true,
      notify: (_message, type) => types.push(type),
      warn: () => undefined,
    });
    assert.deepEqual(types, ["warning", "error"]);
  });
});
