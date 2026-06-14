import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  findNearestProjectAgentsDirWithinRoot,
  getProjectAgentConfigFilePath,
  resolveProjectAgentFilePathWithinRoot,
} from "../../src/core/project-agent-paths";

describe("project agent discovery hardening", () => {
  test("ignores a nearest .pi/agents symlink that escapes the project root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agents-"));
    try {
      const projectRoot = path.join(tempDir, "project");
      const projectPiDir = path.join(projectRoot, ".pi");
      const outsideAgentsDir = path.join(tempDir, "outside-agents");
      const cwd = path.join(projectRoot, "packages", "app");
      await fs.mkdir(projectPiDir, { recursive: true });
      await fs.mkdir(outsideAgentsDir, { recursive: true });
      await fs.mkdir(cwd, { recursive: true });
      await fs.symlink(outsideAgentsDir, path.join(projectPiDir, "agents"), "dir");

      assert.equal(findNearestProjectAgentsDirWithinRoot(cwd), null);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("keeps the logical .pi/agents file path for trusted in-root symlink directories", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agents-"));
    try {
      const projectRoot = path.join(tempDir, "project");
      const projectPiDir = path.join(projectRoot, ".pi");
      const realAgentsDir = path.join(projectRoot, "config", "agents");
      const logicalAgentsDir = path.join(projectPiDir, "agents");
      await fs.mkdir(realAgentsDir, { recursive: true });
      await fs.mkdir(projectPiDir, { recursive: true });
      await fs.writeFile(
        path.join(realAgentsDir, "worker.md"),
        "---\nname: worker\ndescription: worker\nmodel: anthropic/claude\n---\nWorker prompt\n",
        "utf-8",
      );
      await fs.symlink(realAgentsDir, logicalAgentsDir, "dir");

      const logicalFilePath = path.join(logicalAgentsDir, "worker.md");
      assert.equal(resolveProjectAgentFilePathWithinRoot(logicalFilePath, projectRoot), path.join(realAgentsDir, "worker.md"));
      assert.equal(getProjectAgentConfigFilePath(logicalFilePath), logicalFilePath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ignores project agent files whose realpath escapes the project root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agents-"));
    try {
      const projectRoot = path.join(tempDir, "project");
      const agentsDir = path.join(projectRoot, ".pi", "agents");
      const outsideDir = path.join(tempDir, "outside");
      const localAgentPath = path.join(agentsDir, "local.md");
      const escapedAgentPath = path.join(outsideDir, "escaped.md");
      const escapedLinkPath = path.join(agentsDir, "escaped-link.md");
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(
        localAgentPath,
        "---\nname: local-agent\ndescription: local\n---\nLocal prompt\n",
        "utf-8",
      );
      await fs.writeFile(
        escapedAgentPath,
        "---\nname: escaped-agent\ndescription: escaped\n---\nEscaped prompt\n",
        "utf-8",
      );
      await fs.symlink(escapedAgentPath, escapedLinkPath, "file");

      assert.equal(
        resolveProjectAgentFilePathWithinRoot(localAgentPath, projectRoot),
        localAgentPath,
      );
      assert.equal(
        resolveProjectAgentFilePathWithinRoot(escapedLinkPath, projectRoot),
        null,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
