import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents, formatInvalidAgentWarning, safeDiagnosticPath } from "../../src/core/agents";
import {
  findNearestProjectAgentsDirWithinRoot,
  getProjectAgentConfigFilePath,
  resolveProjectAgentFilePathWithinRoot,
} from "../../src/core/project-agent-paths";

describe("agent discovery", () => {
  test("sanitizes agent warning paths and never accepts parser exception text", () => {
    const filename = `bad-${String.fromCharCode(0x1b)}]8;;osc-target${String.fromCharCode(0x07)}-${String.fromCharCode(0x1b)}[31mansi-${String.fromCharCode(0x202e)}-${String.fromCharCode(1)}.md`;
    const warning = formatInvalidAgentWarning(`/untrusted/${filename}`, true);
    assert.match(warning, /invalid frontmatter/);
    assert.equal(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(warning), false);
    assert.equal(warning.includes("\\x1b]8;;osc-target\\x07"), true);
    assert.equal(warning.includes("\\x1b[31mansi"), true);
    assert.equal(formatInvalidAgentWarning.length, 1, "formatter accepts no parser exception argument");
  });

  test("escapes Unicode line separators in repository-controlled diagnostic paths", () => {
    const sanitized = safeDiagnosticPath(`bad-${String.fromCharCode(0x2028)}-${String.fromCharCode(0x2029)}.md`);
    assert.equal(/[\u2028\u2029]/.test(sanitized), false);
    assert.equal(sanitized.includes("\\u2028"), true);
    assert.equal(sanitized.includes("\\u2029"), true);
  });

  test("does not include starter agent creation code", async () => {
    const agentsSource = await fs.readFile(
      path.join(process.cwd(), "src", "core", "agents.ts"),
      "utf-8",
    );
    const extensionSource = await fs.readFile(
      path.join(process.cwd(), "index.ts"),
      "utf-8",
    );

    assert.equal(agentsSource.includes("discoverAgentsWithStarter"), false);
    assert.equal(agentsSource.includes("STARTER_AGENT"), false);
    assert.equal(agentsSource.includes("writeStarterAgentFile"), false);
    assert.equal(extensionSource.includes("discoverAgentsWithStarter"), false);
  });
});

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
      const canonicalWorkerPath = await fs.realpath(path.join(realAgentsDir, "worker.md"));
      assert.equal(resolveProjectAgentFilePathWithinRoot(logicalFilePath, projectRoot), canonicalWorkerPath);
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
        await fs.realpath(localAgentPath),
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
