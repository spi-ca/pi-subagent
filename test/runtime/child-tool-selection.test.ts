import { test } from "bun:test";
import assert from "node:assert/strict";
import { captureParentNativeCodemodeActive, resolveInheritedChildToolSelection as resolve } from "../../src/runtime/child-tool-selection";

const hostVersion = "1.1.0";
const select = (agentTools?: string[], fallbackTools?: string, alwaysProxy: string[] = [], fallbackNoTools = false, parentNativeCodemodeActive = true) => resolve({ agentTools, fallbackTools, alwaysProxy, fallbackNoTools, hostVersion, parentNativeCodemodeActive });

test("ordinary local choices retain MCP and gain codemode without modifying the source list", () => {
  const tools = ["read", "grep"];
  assert.deepEqual(select(tools), { tools: ["read", "grep", "codemode"], noTools: false, disableMcp: false });
  assert.deepEqual(tools, ["read", "grep"]);
  assert.deepEqual(select(), { tools: undefined, noTools: false, disableMcp: false });
  assert.deepEqual(select(undefined, "+read,-write").tools, ["+read", "-write", "+codemode"]);
  assert.deepEqual(select(undefined, "read,grep").tools, ["read", "grep", "codemode"]);
});

test("empty selection and effective no-tools disable everything, but explicit selection overrides parent fallback", () => {
  for (const value of [select([]), select(undefined, ""), select(undefined, undefined, [], true)]) {
    assert.equal(value.noTools, true);
    assert.equal(value.disableMcp, true);
    assert.deepEqual(value.tools, []);
  }
  assert.equal(select(["read"], undefined, [], true).noTools, false);
  assert.equal(select(undefined, "read", [], true).noTools, false);
  assert.equal(select(["+read"], undefined, [], true).noTools, false);
});

test("parent MCP selection survives local override and only intersects explicit child selection", () => {
  assert.deepEqual(select(["read"], "bash,mcp__docs__*").tools, ["read", "mcp__docs__*", "codemode"]);
  for (const [parent, child, expected] of [
    ["mcp__docs__*", "mcp__docs__read", "mcp__docs__read"],
    ["mcp__docs__read", "mcp__docs__*", "mcp__docs__read"],
    ["mcp__docs__read*", "mcp__*", "mcp__docs__read*"],
    ["mcp__docs__*", "mcp__docs__read*", "mcp__docs__read*"],
    ["mcp__docs__*read*", "mcp__docs__read", "mcp__docs__read"],
    ["mcp__docs__*read*", "mcp__docs__*read*", "mcp__docs__*read*"],
  ]) assert.deepEqual(select(["read", child!], parent).tools, ["read", expected, "codemode"]);
  const disjoint = select(["read", "mcp__other__*"], "mcp__docs__*");
  assert.equal(disjoint.disableMcp, true);
  assert.deepEqual(disjoint.tools, ["read"]);
  assert.deepEqual(select(["read", "mcp__docs__*", "mcp__other__*"], "mcp__docs__read,mcp__docs__write").tools, ["read", "mcp__docs__read", "mcp__docs__write", "codemode"]);
});

test("unsupported exact intersection never widens or silently approximates", () => {
  assert.throws(() => select(["read", "mcp__docs__*read"], "mcp__docs__get*"), /Cannot safely intersect/);
  for (const tools of [["+read"], ["*"], ["read", "m*"], ["read_mcp_resource"]]) {
    assert.throws(() => select(tools, "mcp__docs__*"), /Cannot preserve|Cannot refine/);
  }
  assert.throws(() => select(["read"], "read_mcp_resource,mcp__docs__*"), /Cannot refine/);
});

test("parent disables and exclusions remain final; no automatic gateway over explicit removals", () => {
  assert.deepEqual(select(["read"], "mcp__docs__*", ["--no-mcp"]), { tools: ["read"], noTools: false, disableMcp: true });
  for (const proxy of [["--exclude-tools", "code*"], ["-xt", "codemode"], ["--no-extensions"], ["-ne"]]) assert.deepEqual(select(["read"], undefined, proxy).tools, ["read"]);
  assert.deepEqual(select(["read"], "-codemode").tools, ["read"]);
  assert.deepEqual(select(undefined, "+read,-codemode").tools, ["+read", "-codemode"]);
  assert.deepEqual(select(["read"], undefined, ["--exclude-tools", "mcp__docs__delete"]).tools, ["read", "codemode"]);
});

test("only the last exclude-tools occurrence decides gateway supplementation, across both aliases", () => {
  for (const first of ["--exclude-tools", "-xt"]) {
    for (const last of ["--exclude-tools", "-xt"]) {
      for (const prior of ["codemode", "code*", "*"]) {
        assert.deepEqual(select(["read"], undefined, [first, prior, last, "bash"]).tools, ["read", "codemode"]);
        assert.deepEqual(select(["read"], undefined, [first, prior, last, ""]).tools, ["read", "codemode"]);
      }
      for (const final of ["codemode", "code*", "*"]) {
        assert.deepEqual(select(["read"], undefined, [first, "bash", last, final]).tools, ["read"]);
      }
    }
  }
});

test("ordered exact modifiers preserve final removals and permit overridden parent removals", () => {
  for (const fallback of ["-codemode,+codemode", "+read,-codemode,+codemode,-write"]) {
    assert.deepEqual(select(["read"], fallback).tools, ["read", "codemode"]);
    assert.deepEqual(select(undefined, fallback).tools, fallback.split(","));
    assert.deepEqual(select(["+read"], fallback).tools, ["+read", "+codemode"]);
  }
  for (const fallback of ["+codemode,-codemode", "-codemode,+codemode,-codemode,+read"]) {
    assert.deepEqual(select(["read"], fallback).tools, ["read"]);
    assert.deepEqual(select(undefined, fallback).tools, fallback.split(","));
    assert.deepEqual(select(["+read"], fallback).tools, ["+read"]);
  }
  for (const tools of [["-codemode", "+codemode"], ["+codemode", "-codemode"], ["+codemode", "-codemode", "+read"]]) {
    assert.deepEqual(select(tools).tools, tools, "never append a gateway over the effective modifier list");
  }
  assert.deepEqual(select(["read", "codemode"], "-codemode").tools, ["read", "codemode"], "explicit agent selection remains loader-owned");
  assert.deepEqual(select(["read"], "-codemode,+codemode", ["-xt", "codemode"]).tools, ["read"], "final exclusion wins over addition");
  for (const proxy of [["--no-mcp"], ["--no-extensions"], ["-ne"]]) {
    assert.deepEqual(select(["read"], "-codemode,+codemode", proxy).tools, ["read"]);
  }
  assert.deepEqual(select(["read"], "-codemode,+codemode", [], false, false).tools, ["read"], "ordered modifiers do not replace parent capability evidence");
});

test("automatic codemode is stable native >=1.1 only; explicit native ownership stays with loader", () => {
  for (const version of ["0.80.10", "1.0.3", "1.0.4", "1.1.0-beta.1", "unknown", ""]) {
    assert.deepEqual(resolve({ agentTools: ["read"], hostVersion: version, parentNativeCodemodeActive: true }).tools, ["read"]);
    assert.deepEqual(resolve({ agentTools: ["read", "codemode"], hostVersion: version }).tools, ["read", "codemode"]);
  }
  for (const version of ["1.1.0", "1.1.1", "2.0.0"]) assert.deepEqual(resolve({ agentTools: ["read"], hostVersion: version, parentNativeCodemodeActive: true }).tools, ["read", "codemode"]);
});


test("gateway supplementation requires active native ownership from both public APIs", () => {
  for (const active of [false, true]) {
    for (const sourceInfo of [
      { source: "builtin", path: "builtin:codemode" },
      { source: "extension", path: "builtin:codemode" },
      { source: "builtin", path: "/custom.ts" },
      { source: "builtin" }, { path: "builtin:codemode" }, undefined,
    ]) {
      let activeReads = 0;
      let ownerReads = 0;
      const evidence = captureParentNativeCodemodeActive({
        getActiveTools: () => { activeReads++; return active ? ["read", "codemode"] : ["read"]; },
        getAllTools: () => { ownerReads++; return [{ name: "codemode", sourceInfo }]; },
      });
      const expected = active && sourceInfo?.source === "builtin" && sourceInfo.path === "builtin:codemode";
      assert.equal(evidence, expected);
      assert.equal(activeReads, 1);
      assert.equal(ownerReads, 1);
      assert.deepEqual(select(["read"], undefined, [], false, evidence).tools, expected ? ["read", "codemode"] : ["read"]);
      assert.deepEqual(select(["read", "codemode"], undefined, [], false, evidence).tools, ["read", "codemode"], "explicit gateway selection is not an ownership ban");
    }
  }
  for (const registry of [{}, { getActiveTools: () => ["codemode"] }, { getActiveTools: () => ["codemode"], getAllTools: () => [] }, { getActiveTools: () => { throw new Error("unavailable"); }, getAllTools: () => [] }]) {
    assert.equal(captureParentNativeCodemodeActive(registry), false);
  }
  assert.deepEqual(resolve({ agentTools: ["read"], hostVersion }).tools, ["read"], "missing evidence defaults to false");
  assert.deepEqual(select(undefined, "+read,-write", [], false, false).tools, ["+read", "-write"]);
});
