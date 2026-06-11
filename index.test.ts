import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  SubagentParams,
  getProjectRootFromAgentsDir,
  parseProjectRootEnvValue,
} from "./subagent-config";

describe("subagent tool schema", () => {
  test("does not expose removed top-level execution or approval fields", () => {
    const properties = (SubagentParams as any).properties ?? {};
    assert.equal(Object.hasOwn(properties, "terminal"), false);
    assert.equal(Object.hasOwn(properties, "zellij"), false);
    assert.equal(Object.hasOwn(properties, "confirmProjectAgents"), false);
    assert.equal(Object.hasOwn(properties, "mode"), true);
  });
});

describe("trust root canonicalization", () => {
  test("canonicalizes env-provided roots and project agent roots consistently", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-index-"));
    try {
      const realProjectRoot = path.join(tempDir, "real-project");
      const symlinkProjectRoot = path.join(tempDir, "symlink-project");
      const agentsDir = path.join(realProjectRoot, ".pi", "agents");
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.symlink(realProjectRoot, symlinkProjectRoot, "dir");

      const canonicalRoot = await fs.realpath(realProjectRoot);
      assert.equal(
        getProjectRootFromAgentsDir(path.join(symlinkProjectRoot, ".pi", "agents")),
        canonicalRoot,
      );
      assert.deepEqual(
        parseProjectRootEnvValue(JSON.stringify([symlinkProjectRoot, realProjectRoot, "   ", 123])),
        [canonicalRoot],
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
