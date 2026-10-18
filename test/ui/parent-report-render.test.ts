import { test } from "bun:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ParentReportAdmission, PARENT_REPORT_CUSTOM_TYPE } from "../../src/runtime/parent-report";
import { renderParentReport } from "../../src/ui/parent-report-render";

const theme = { fg: (_color: string, text: string) => text } as never;
function render(message: any, expanded = false, width = 120): string[] {
  const component = renderParentReport({ role: "custom", timestamp: 0, ...message }, { expanded, outputPad: 0 }, theme)!;
  const lines = component.render(width);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `line width ${visibleWidth(line)} exceeds ${width}: ${JSON.stringify(line)}`);
    assert.equal(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(line), false);
  }
  // Pi Text pads each terminal row to width; compare logical text without
  // that layout padding, after measuring the real rendered rows above.
  return lines.map(line => line.trimEnd());
}
function reports() {
  let now = 1_800_000_000_000; const sent: any[] = [];
  const admission = new ParentReportAdmission({ sendMessage: message => { sent.push(message); } }, () => now);
  admission.reset({ getSessionId: () => "render-session", getEntries: () => [] });
  for (let i = 0; i < 3; i++) {
    const submit = admission.bind({ jobId: "job", childId: `leaf-${i}`, agent: `검토😀e\u0301-${i}`, mode: "chain", stageIndex: i,
      ...(i === 0 ? { stageLabel: "단계" } : {}) }, () => true);
    assert.equal(submit(`full report body ${i}\n한글 😀`), true);
    now += 1000;
  }
  const batch = admission.draft()!;
  admission.bind({ jobId: "job", childId: "important-child", agent: "worker", mode: "single" }, () => true)("important full body", "blocked");
  return { batch, important: sent[0] };
}

test("single important and batch share a compact sender-aware renderer, full expanded content and immutable model metadata", () => {
  const { batch, important } = reports();
  const before = structuredClone({ batch, important });
  const compact = render(batch).join("\n");
  assert.match(compact, /Subagent reports \(3; untrusted\)/);
  assert.match(compact, /단계\(검토😀é-0\)/);
  assert.equal((compact.match(/\/ progress/g) ?? []).length, 3);
  assert.equal(compact.includes("subagent.parent-report"), false, "no repeated custom-type/details dumps");
  assert.equal(compact.includes("full report body"), false);
  assert.match(compact, /#.{8}… child:leaf-0 received:\d\d:\d\d:\d\d\.\d{3}Z submitted:/u);
  assert.ok(compact.length < 800);
  const expanded = render(batch, true, 1000).join("\n");
  assert.ok(expanded.includes(batch.content), "full exact normal content, no duplicate body in metadata");
  assert.match(expanded, /not commit, delivery or model read/);
  assert.equal(JSON.stringify(batch.details).includes("full report body"), false);
  const single = render(important).join("\n");
  assert.match(single, /Subagent reports \(1; untrusted\)/); assert.match(single, /worker \/ blocked/);
  assert.ok(render(important, true, 1000).join("\n").includes("important full body"));
  assert.deepEqual({ batch, important }, before);
});

test("actual Pi Text wraps narrow/wide Unicode, emoji and combining text within terminal columns", () => {
  const { batch, important } = reports();
  for (const width of [4, 8, 17, 40, 80, 160]) for (const expanded of [false, true]) {
    for (const message of [batch, important]) render(message, expanded, width);
  }
});

test("terminal/bidi/control content and metadata are escaped, never rendered as instructions or ANSI/Markdown", () => {
  const { important } = reports();
  const malicious = '\x1b]8;;https://bad\x07\r\x9b\u061c\u200e\u200f\u202e\u2066\u2069';
  important.details.agent = malicious + "# /skill:evil";
  important.details.stageLabel = malicious;
  important.details.reportId = malicious;
  important.details.childId = malicious;
  important.content = `${malicious}\n[link](https://bad)\t\0`;
  const snapshot = structuredClone(important);
  for (const width of [8, 40, 160]) for (const expanded of [false, true]) render(important, expanded, width);
  const text = render(important, true, 1000).join("\n");
  assert.match(text, /\\u001b/); assert.match(text, /\\u202e/); assert.match(text, /\\u0000/);
  assert.ok(text.includes("[link](https://bad)"));
  assert.deepEqual(important, snapshot, "sanitization is display-only");
});

test("legacy/malformed details fall back safely, omit forged sender fields, and bound giant historical content", () => {
  for (const details of [undefined, null, [], "bad", { kind: "subagent.parent-report", version: 1 },
    { kind: "subagent.parent-report", version: 2, agent: "forged" },
    { kind: "subagent.parent-report.batch", version: 2, reports: [null] },
    { kind: "subagent.parent-report.batch", version: 2, reports: Array(10000).fill({ agent: "forged" }) },
    { kind: "subagent.parent-report", version: 3, agent: "forged", reportKind: "evil", receivedAtMs: NaN }]) {
    const message = { customType: PARENT_REPORT_CUSTOM_TYPE, content: "stored legacy body\x1b\u202e", details };
    const compact = render(message).join("\n"); assert.match(compact, /legacy\/unknown/);
    assert.equal(compact.includes("forged"), false);
    assert.match(render(message, true).join("\n"), /stored legacy body\\u001b\\u202e/);
  }
  const huge = render({ content: "\x1b".repeat(200_000), details: null }, true, 1000).join("\n");
  assert.ok(huge.length < 132_000); assert.match(huge, /display truncated/);
  render({ content: [{ type: "image", data: "secret-image" }], details: {} }, true);
});
