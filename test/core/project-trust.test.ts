import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applySessionProjectTrustOverride,
  getSessionProjectTrustOverride,
  isTrustedProjectAgentsDir,
  isTrustedProjectAgentsDirWithSessionOverrides,
  resolveSessionProjectTrust,
} from "../../src/core/project-trust";
import { loadSubagentLimitConfigSources } from "../../src/core/subagent-limits";

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

  test("uses true, false, or unavailable session trust without replacing prior exact-root state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-trust-"));
    try {
      const projectRoot = path.join(tempDir, "project");
      const agentsDir = path.join(projectRoot, ".pi", "agents");
      const agentDir = path.join(tempDir, "agent");
      const existingTrustedRoot = path.join(tempDir, "already-trusted");
      const existingDeniedRoot = path.join(tempDir, "already-denied");
      await Promise.all([
        fs.mkdir(agentsDir, { recursive: true }),
        fs.mkdir(agentDir, { recursive: true }),
        fs.mkdir(existingTrustedRoot, { recursive: true }),
        fs.mkdir(existingDeniedRoot, { recursive: true }),
      ]);
      await fs.writeFile(
        path.join(projectRoot, ".pi", "pi-subagent.json"),
        JSON.stringify({ maxActive: 3 }),
        "utf-8",
      );
      const canonicalProjectRoot = await fs.realpath(projectRoot);
      const canonicalTrustedRoot = await fs.realpath(existingTrustedRoot);
      const canonicalDeniedRoot = await fs.realpath(existingDeniedRoot);
      const projectConfig = async (projectTrusted: boolean) =>
        (await loadSubagentLimitConfigSources({
          agentDir,
          cwd: projectRoot,
          configDirName: ".pi",
          projectTrusted,
          warn: () => {},
        })).projectConfig;

      const approvedTrustedRoots = new Set([existingTrustedRoot]);
      const approvedDeniedRoots = new Set([projectRoot, existingDeniedRoot]);
      const approvedProjectTrusted = resolveSessionProjectTrust(
        agentsDir,
        getSessionProjectTrustOverride({ isProjectTrusted: () => true }),
        approvedTrustedRoots,
        approvedDeniedRoots,
        { trust: {} },
      );
      assert.equal(approvedProjectTrusted, true);
      assert.deepEqual(Array.from(approvedTrustedRoots), [canonicalTrustedRoot, canonicalProjectRoot]);
      assert.deepEqual(Array.from(approvedDeniedRoots), [canonicalDeniedRoot]);
      assert.deepEqual(await projectConfig(approvedProjectTrusted), { maxActive: 3 });

      const deniedTrustedRoots = new Set([existingTrustedRoot, projectRoot]);
      const deniedRoots = new Set([existingDeniedRoot]);
      const deniedProjectTrusted = resolveSessionProjectTrust(
        agentsDir,
        getSessionProjectTrustOverride({ isProjectTrusted: () => false }),
        deniedTrustedRoots,
        deniedRoots,
        { trust: { [projectRoot]: true } },
      );
      assert.equal(deniedProjectTrusted, false);
      assert.deepEqual(Array.from(deniedTrustedRoots), [canonicalTrustedRoot]);
      assert.deepEqual(Array.from(deniedRoots), [canonicalDeniedRoot, canonicalProjectRoot]);
      assert.deepEqual(await projectConfig(deniedProjectTrusted), {});

      const unavailableTrustedRoots = new Set([existingTrustedRoot]);
      const unavailableDeniedRoots = new Set([existingDeniedRoot]);
      const unavailableProjectTrusted = resolveSessionProjectTrust(
        agentsDir,
        getSessionProjectTrustOverride({}),
        unavailableTrustedRoots,
        unavailableDeniedRoots,
        { trust: { [projectRoot]: true } },
      );
      assert.equal(unavailableProjectTrusted, true);
      assert.deepEqual(Array.from(unavailableTrustedRoots), [existingTrustedRoot]);
      assert.deepEqual(Array.from(unavailableDeniedRoots), [existingDeniedRoot]);
      assert.deepEqual(await projectConfig(unavailableProjectTrusted), { maxActive: 3 });

      const unavailableDeniedTrustedRoots = new Set([existingTrustedRoot]);
      const unavailableCurrentDeniedRoots = new Set([projectRoot, existingDeniedRoot]);
      const unavailableDeniedProjectTrusted = resolveSessionProjectTrust(
        agentsDir,
        getSessionProjectTrustOverride({}),
        unavailableDeniedTrustedRoots,
        unavailableCurrentDeniedRoots,
        { trust: { [projectRoot]: true } },
      );
      assert.equal(unavailableDeniedProjectTrusted, false);
      assert.deepEqual(Array.from(unavailableDeniedTrustedRoots), [existingTrustedRoot]);
      assert.deepEqual(Array.from(unavailableCurrentDeniedRoots), [projectRoot, existingDeniedRoot]);
      assert.deepEqual(await projectConfig(unavailableDeniedProjectTrusted), {});
      assert.equal(getSessionProjectTrustOverride({ isProjectTrusted: () => { throw new Error("unavailable"); } }), null);
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

      const canonicalNestedRoot = await fs.realpath(nestedRoot);
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
      assert.equal(approvedRoot, canonicalNestedRoot);
      assert.deepEqual(Array.from(trustedRoots), [canonicalNestedRoot]);
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
