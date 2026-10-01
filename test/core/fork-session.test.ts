import { test } from "bun:test";
import assert from "node:assert/strict";
import { SessionManager, buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildForkBranchSourceJsonl } from "../../src/core/fork-session";

const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const system = { role: "system" as const, content: "base", sections: { cwd: "/workspace", skills: "skills" }, toolsAdded: [{ name: "read", description: "read", parameters: { type: "object" } }], timestamp: 0 };

test("0.99.2 canonical fork round-trips prompt deltas, edits and model-attributed usage", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(system);
  const user = manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
  manager.appendMessage({ role: "system", content: "", sections: { skills: null, cwd: "/changed" }, toolsRemoved: [{ name: "read" }], timestamp: 2 });
  manager.appendContextEdit(user, { content: "replaced" });
  manager.appendUsage("future_kind", "provider", "model", usage);
  const branch = manager.getBranch();
  const snapshot = buildForkBranchSourceJsonl(manager);
  assert.ok(snapshot);
  const restored = snapshot.trim().split("\n").map((line) => JSON.parse(line)) as SessionEntry[];
  assert.deepEqual(restored, branch, "raw history must not be flattened into projected messages");
  assert.deepEqual(buildSessionContext(restored), manager.buildSessionContext());
  assert.ok(buildSessionContext(restored).messages.some((message) => message.role === "user" && message.content === "replaced"));
  manager.appendContextEdit(user, null);
  assert.ok(buildForkBranchSourceJsonl(manager));
});

test("retain-none compaction preserves its own kept ID and complete prompt checkpoint", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage(system);
  manager.appendMessage({ role: "user", content: "summarized", timestamp: 1 });
  const id = manager.appendCompaction("summary", null, 10, undefined, false, usage);
  const entry = manager.getEntry(id)!;
  assert.equal(entry.type, "compaction");
  assert.equal((entry as any).firstKeptEntryId, id);
  assert.equal((entry as any).systemMessage.role, "system");
  const snapshot = buildForkBranchSourceJsonl(manager);
  assert.ok(snapshot);
  assert.deepEqual(buildSessionContext(snapshot.trim().split("\n").map((line) => JSON.parse(line))), manager.buildSessionContext());
  assert.equal(manager.buildSessionContext().messages.some((message) => message.role === "user"), false);
});

test("new fork shapes fail closed for malformed system, usage, edits and kept boundaries", () => {
  const base = { type: "message", id: "system", parentId: null, timestamp: new Date(0).toISOString(), message: system };
  const child = { id: "next", parentId: "system", timestamp: base.timestamp };
  for (const message of [
    { ...system, content: [{ type: "image", data: "x", mimeType: "image/png" }] },
    { ...system, sections: { skills: 42 } }, { ...system, toolsAdded: [{ name: "read" }] },
    { ...system, toolsRemoved: [{}] }, { ...system, replace: "true" },
  ]) assert.equal(buildForkBranchSourceJsonl({ getBranch: () => [{ ...base, message }] }), null);
  for (const entry of [
    { ...child, type: "context_edit", targetId: "system", replacement: null },
    { ...child, type: "context_edit", targetId: "missing", replacement: { content: "x" } },
    { ...child, type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: { ...usage, output: -1 } },
    { ...child, type: "compaction", summary: "s", tokensBefore: 1, firstKeptEntryId: "missing", systemMessage: system },
  ]) assert.equal(buildForkBranchSourceJsonl({ getBranch: () => [base, entry] }), null);
  const user = { ...base, id: "user", message: { role: "user", content: "x", timestamp: 0 } };
  for (const replacement of [undefined, "x", {}, { content: 1 }, { content: [{ type: "toolCall", id: "c", name: "t", arguments: {} }] }]) {
    assert.equal(buildForkBranchSourceJsonl({ getBranch: () => [user, { ...child, parentId: "user", type: "context_edit", targetId: "user", replacement }] }), null);
  }
});

test("state-only entries cannot grant context-edit authority", () => {
  const manager = SessionManager.inMemory();
  const id = manager.appendCustomEntry("state", { value: 1 });
  assert.throws(() => manager.appendContextEdit(id, null), /does not contribute editable model content/);
  const state = manager.getEntry(id)!;
  assert.ok(buildForkBranchSourceJsonl({ getBranch: () => [state] }));
  assert.equal(buildForkBranchSourceJsonl({ getBranch: () => [state, {
    type: "context_edit", id: "edit", parentId: id, timestamp: new Date(0).toISOString(), targetId: id, replacement: null,
  }] }), null);
});

test("state-only entries cannot borrow edit authority from an extra message role", () => {
  const timestamp = new Date(0).toISOString();
  const states = [
    { type: "custom", customType: "state", data: {} },
    { type: "thinking_level_change", thinkingLevel: "high" },
    { type: "model_change", provider: "p", modelId: "m" },
    { type: "usage", kind: "accounting", provider: "p", model: "m", usage },
    { type: "session_info", name: "session" },
  ];
  for (const state of states) {
    const entry = { ...state, id: "state", parentId: null, timestamp,
      message: { role: "user", content: "not model content", timestamp: 0 } };
    assert.ok(buildForkBranchSourceJsonl({ getBranch: () => [entry] }));
    assert.equal(buildForkBranchSourceJsonl({ getBranch: () => [entry, {
      type: "context_edit", id: "edit", parentId: "state", timestamp, targetId: "state", replacement: null,
    }] }), null);
  }
});
