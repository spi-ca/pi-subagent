import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySessionProjectTrustOverride,
  isTrustedProjectAgentsDir,
  isTrustedProjectAgentsDirWithSessionOverrides,
} from "../../src/core/project-trust";

describe("project trust boundaries", () => {
  test("requires an exact trusted project root for the nearest .pi/agents directory", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-trust-"));
    try {
      const outerRoot = path.join(tempDir, "outer");
      const nestedRoot = path.join(outerRoot, "packages", "app");
      const nestedAgentsDir = path.join(nestedRoot, ".pi", "agents");
      const configDir = path.join(tempDir, "config");
      await fs.mkdir(nestedAgentsDir, { recursive: true });
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "trust.json"),
        JSON.stringify({ [outerRoot]: true }, null, 2),
        "utf-8",
      );

      assert.equal(isTrustedProjectAgentsDir(nestedAgentsDir, { configDir }), false);

      await fs.writeFile(
        path.join(configDir, "trust.json"),
        JSON.stringify({ [outerRoot]: true, [nestedRoot]: true }, null, 2),
        "utf-8",
      );

      assert.equal(isTrustedProjectAgentsDir(nestedAgentsDir, { configDir }), true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("canonicalizes trusted roots before exact matching", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-trust-"));
    try {
      const realRoot = path.join(tempDir, "real-project");
      const linkRoot = path.join(tempDir, "linked-project");
      const agentsDir = path.join(realRoot, ".pi", "agents");
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.symlink(realRoot, linkRoot, "dir");

      assert.equal(
        isTrustedProjectAgentsDir(path.join(linkRoot, ".pi", "agents"), {
          trust: { [realRoot]: true },
        }),
        true,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("applies exact-root session overrides before persisted trust", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-trust-"));
    try {
      const projectRoot = path.join(tempDir, "project");
      const agentsDir = path.join(projectRoot, ".pi", "agents");
      await fs.mkdir(agentsDir, { recursive: true });

      assert.equal(
        isTrustedProjectAgentsDirWithSessionOverrides(agentsDir, {
          trust: { [projectRoot]: true },
          sessionDeniedProjectRoots: [projectRoot],
        }),
        false,
      );

      assert.equal(
        isTrustedProjectAgentsDirWithSessionOverrides(agentsDir, {
          trust: {},
          sessionTrustedProjectRoots: [projectRoot],
        }),
        true,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("requires exact-root session approvals and lets denied roots override them", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-trust-"));
    try {
      const outerRoot = path.join(tempDir, "outer");
      const nestedRoot = path.join(outerRoot, "packages", "app");
      const nestedAgentsDir = path.join(nestedRoot, ".pi", "agents");
      await fs.mkdir(nestedAgentsDir, { recursive: true });

      assert.equal(
        isTrustedProjectAgentsDirWithSessionOverrides(nestedAgentsDir, {
          trust: {},
          sessionTrustedProjectRoots: [outerRoot],
        }),
        false,
      );

      assert.equal(
        isTrustedProjectAgentsDirWithSessionOverrides(nestedAgentsDir, {
          trust: {},
          sessionTrustedProjectRoots: [nestedRoot],
        }),
        true,
      );

      assert.equal(
        isTrustedProjectAgentsDirWithSessionOverrides(nestedAgentsDir, {
          trust: {},
          sessionTrustedProjectRoots: [nestedRoot],
          sessionDeniedProjectRoots: [nestedRoot],
        }),
        false,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("applies CLI trust overrides to the exact current project root and clears denials on approve", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-trust-"));
    try {
      const outerRoot = path.join(tempDir, "outer");
      const nestedRoot = path.join(outerRoot, "packages", "app");
      const nestedAgentsDir = path.join(nestedRoot, ".pi", "agents");
      await fs.mkdir(nestedAgentsDir, { recursive: true });

      const trustedRoots = new Set<string>();
      const deniedRoots = new Set<string>([nestedRoot]);

      assert.equal(
        isTrustedProjectAgentsDirWithSessionOverrides(nestedAgentsDir, {
          trust: {},
          sessionTrustedProjectRoots: trustedRoots,
          sessionDeniedProjectRoots: deniedRoots,
        }),
        false,
      );

      const approvedRoot = applySessionProjectTrustOverride(
        nestedAgentsDir,
        true,
        trustedRoots,
        deniedRoots,
      );
      assert.equal(approvedRoot, nestedRoot);
      assert.deepEqual(Array.from(trustedRoots), [nestedRoot]);
      assert.deepEqual(Array.from(deniedRoots), []);
      assert.equal(
        isTrustedProjectAgentsDirWithSessionOverrides(nestedAgentsDir, {
          trust: {},
          sessionTrustedProjectRoots: trustedRoots,
          sessionDeniedProjectRoots: deniedRoots,
        }),
        true,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
