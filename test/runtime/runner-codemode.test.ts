import { test } from "bun:test";
import assert from "node:assert/strict";
import type { AgentConfig } from "../../src/core/agents";

// Each inventory file runs in its own process. Capture a real inherited CLI
// selection at module load without mutating globals during the tests.
const originalArgv = process.argv;
process.argv = ["bun", "pi", "--tools", "read,grep,codemode", "--extension", "/untrusted/extension.ts"];
const {
  assertManagedChildToolCompatibility, buildPiArgs, buildInteractivePiArgs,
  buildManagedExtensionArgs, collectManagedOverriddenBuiltinTools, applyChildProjectIsolation, runAgent,
} = await import("../../src/runtime/runner");
process.argv = originalArgv;

const agent: AgentConfig = { name: "reader", description: "", systemPrompt: "", source: "user", filePath: "/reader.md" };

test("managed builders load only literal native codemode when exactly selected, retaining self/bridge and isolation", () => {
  for (const mode of ["spawn", "fork"] as const) {
    const args = buildPiArgs(agent, null, "/task", mode, mode === "fork" ? "/session" : null, undefined, "managed", undefined, "1.1.0");
    assert.equal(args.filter((arg) => arg === "builtin:codemode").length, 1);
    assert.equal(args.filter((arg) => arg === "--extension").length, mode === "fork" ? 3 : 2);
    assert.ok(args.includes("--no-extensions") && args.includes("--no-mcp"));
    assert.equal(args.includes("/untrusted/extension.ts"), false);
    assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", "read,grep,codemode"]);
    applyChildProjectIsolation(args, process.cwd());
    assert.ok(args.includes("--no-approve") && args.includes("--no-context-files"));
  }
  const interactive = buildInteractivePiArgs(agent, null, "/task", "/session", undefined, "managed", undefined, "1.1.0");
  assert.equal(interactive.filter((arg) => arg === "--extension").length, 3);
  assert.ok(interactive.includes("builtin:codemode") && interactive.some((arg) => arg.endsWith("child-bridge.ts")));
  for (const tools of [["read"], []]) {
    const explicit = { ...agent, tools };
    assert.equal(buildPiArgs(explicit, null, "/task", "spawn", null, undefined, "managed", undefined, "1.1.0").includes("builtin:codemode"), false);
    assert.equal(buildInteractivePiArgs(explicit, null, "/task", "/session", undefined, "managed", undefined, "1.1.0").includes("builtin:codemode"), false);
  }
  assert.equal(buildManagedExtensionArgs(false).includes("builtin:codemode"), false);
  assert.equal(buildPiArgs(agent, null, "/task", "spawn", null, undefined, "inherit", undefined, "1.1.0").includes("builtin:codemode"), false);
});

test("codemode compatibility fails closed on versions and non-exact tool selections", () => {
  for (const version of ["1.0.4", "1.0.99", "1.1.0-beta.1", "1.2.0-rc.1", "unknown", "", "garbage"]) {
    assert.throws(() => assertManagedChildToolCompatibility({ tools: ["codemode"] }, undefined, [], false, version), /verified stable Pi >=1.1.0/);
    assert.throws(() => buildPiArgs(agent, null, "/task", "spawn", null, undefined, "managed", undefined, version), /verified stable/);
    assert.throws(() => buildInteractivePiArgs(agent, null, "/task", "/session", undefined, "managed", undefined, version), /verified stable/);
    assert.doesNotThrow(() => assertManagedChildToolCompatibility({ tools: ["read"] }, "codemode", [], false, version));
  }
  for (const version of ["1.1.0", "1.1.1", "2.0.0"]) assert.doesNotThrow(() => assertManagedChildToolCompatibility({}, "read,codemode", [], false, version));
  for (const name of ["+codemode", "-write", "code*", "*", "mcp__docs__read", "tool_search", "custom", "builtin:codemode"]) {
    assert.throws(() => assertManagedChildToolCompatibility({ tools: [name] }, undefined, [], false, "1.1.0"), /cannot preserve/);
    assert.throws(() => assertManagedChildToolCompatibility({}, name, [], false, "1.1.0"), /cannot preserve/);
  }
  assert.doesNotThrow(() => assertManagedChildToolCompatibility({}, undefined, ["codemode"], false, "unknown"), "no automatic codemode from registry or defaults");
});

test("override capture accepts native codemode only with both builtin owner fields", () => {
  assert.deepEqual(collectManagedOverriddenBuiltinTools([{ name: "codemode", sourceInfo: { source: "builtin", path: "builtin:codemode" } }]), []);
  for (const sourceInfo of [undefined, {}, { source: "builtin" }, { path: "builtin:codemode" }, { source: "extension", path: "builtin:codemode" }, { source: "builtin", path: "/replacement.ts" }]) {
    const overrides = collectManagedOverriddenBuiltinTools([{ name: "codemode", sourceInfo }]);
    assert.deepEqual(overrides, ["codemode"]);
    assert.throws(() => assertManagedChildToolCompatibility({ tools: ["codemode"] }, undefined, overrides, false, "1.1.0"), /extension overrides.*codemode/);
    assert.doesNotThrow(() => assertManagedChildToolCompatibility({ tools: ["read"] }, "codemode", overrides, false, "1.1.0"));
  }
  assert.deepEqual(collectManagedOverriddenBuiltinTools([
    { name: "read", sourceInfo: { source: "extension" } },
    { name: "grep", sourceInfo: { source: "builtin" } },
    { name: "subagent", sourceInfo: { source: "extension" } },
  ]), ["read"]);
});

test("managed codemode replacement reports an unstarted child error", async () => {
  const previous = process.env.PI_SUBAGENT_CMUX_CHILD_POLICY;
  process.env.PI_SUBAGENT_CMUX_CHILD_POLICY = "managed";
  try {
    const result = await runAgent({ cwd: process.cwd(), agents: [{ ...agent, tools: ["read", "codemode"] }], agentName: agent.name, task: "Never launch", delegationMode: "spawn", terminalMode: "inline", managedOverriddenBuiltinTools: ["codemode"], parentDepth: 0, parentAgentStack: [], maxDepth: 5, preventCycles: true, makeDetails: (results) => ({ mode: "single", results, toolLabel: "Subagent", delegationMode: "spawn", terminalMode: "inline", projectAgentsDir: null }) });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stopReason, "error");
    assert.deepEqual(result.messages, []);
    assert.match(result.errorMessage ?? "", /extension overrides.*codemode/);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CMUX_CHILD_POLICY;
    else process.env.PI_SUBAGENT_CMUX_CHILD_POLICY = previous;
  }
});
