import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatStoredBackgroundToolText } from "../../src/core/subagent-config";
import { createBackgroundResultRenderer } from "../../src/ui/background-result";
import {
  DEFAULT_TOOL_DISPLAY_PREVIEW_LINES,
  getToolDisplayConfigPath,
  loadToolDisplayPreviewLines,
  MAX_TOOL_DISPLAY_CONFIG_BYTES,
  normalizeToolDisplayPreviewLines,
} from "../../src/ui/tool-display-config";

describe("tool-display preview configuration", () => {
  test("mirrors pi-tool-display agent-dir fallback, home expansion, and literal whitespace", () => {
    const home = "/home/example";
    assert.equal(
      getToolDisplayConfigPath({ env: { PI_CODING_AGENT_DIR: "/safe/agent" } as NodeJS.ProcessEnv, home }),
      "/safe/agent/extensions/pi-tool-display/config.json",
    );
    assert.equal(
      getToolDisplayConfigPath({ env: {} as NodeJS.ProcessEnv, home }),
      "/home/example/.pi/agent/extensions/pi-tool-display/config.json",
    );
    assert.equal(
      getToolDisplayConfigPath({ env: { PI_CODING_AGENT_DIR: "" } as NodeJS.ProcessEnv, home }),
      "/home/example/.pi/agent/extensions/pi-tool-display/config.json",
    );
    assert.equal(
      getToolDisplayConfigPath({ env: { PI_CODING_AGENT_DIR: "~" } as NodeJS.ProcessEnv, home }),
      "/home/example/extensions/pi-tool-display/config.json",
    );
    assert.equal(
      getToolDisplayConfigPath({ env: { PI_CODING_AGENT_DIR: "~/custom-agent" } as NodeJS.ProcessEnv, home }),
      "/home/example/custom-agent/extensions/pi-tool-display/config.json",
    );
    assert.equal(
      getToolDisplayConfigPath({ env: { PI_CODING_AGENT_DIR: "~\\custom-agent" } as NodeJS.ProcessEnv, home }),
      "/home/example/custom-agent/extensions/pi-tool-display/config.json",
    );
    assert.equal(
      getToolDisplayConfigPath({ env: { PI_CODING_AGENT_DIR: " " } as NodeJS.ProcessEnv, home }),
      " /extensions/pi-tool-display/config.json",
    );
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = "/process/agent";
      assert.equal(getToolDisplayConfigPath(), "/process/agent/extensions/pi-tool-display/config.json");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  test("matches the finite 1–80 tool-display preview normalization", () => {
    assert.equal(normalizeToolDisplayPreviewLines(3.9), 3);
    assert.equal(normalizeToolDisplayPreviewLines(0), 1);
    assert.equal(normalizeToolDisplayPreviewLines(81), 80);
    assert.equal(normalizeToolDisplayPreviewLines(Number.POSITIVE_INFINITY), DEFAULT_TOOL_DISPLAY_PREVIEW_LINES);
    assert.equal(normalizeToolDisplayPreviewLines("8"), DEFAULT_TOOL_DISPLAY_PREVIEW_LINES);
  });

  test("passes a configured budget of 80 into the compact renderer while expanded limits remain separate", () => {
    const output = Array.from({ length: 81 }, (_, index) => `row ${index + 1}`).join("\n");
    const renderer = createBackgroundResultRenderer({ previewLines: 80 });
    const lines = renderer({
      content: `Background subagent job 12345678-1234-4123-8123-123456789abc completed.\n\n${formatStoredBackgroundToolText(output)}`,
      details: { jobId: "12345678-1234-4123-8123-123456789abc", status: "completed", startedAt: 1, completedAt: 2 },
    }, { expanded: false, outputPad: 0 }, {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string, text: string) => text,
    } as never).render(120);
    assert.match(lines.join("\n"), /row 80/);
    assert.doesNotMatch(lines.join("\n"), /row 81/);
    assert.match(lines.join("\n"), /1 more line/);
  });

  test("reads only bounded regular JSON config files and defaults for absent, invalid, or symlinked input", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tool-display-"));
    const configPath = path.join(directory, "config.json");
    try {
      assert.equal(await loadToolDisplayPreviewLines({ configPath }), DEFAULT_TOOL_DISPLAY_PREVIEW_LINES);
      await fs.writeFile(configPath, JSON.stringify({ previewLines: 80, mode: "ignored" }));
      assert.equal(await loadToolDisplayPreviewLines({ configPath }), 80);
      // A new session_start/reload call reads this source again rather than
      // retaining the preceding factory's budget.
      await fs.writeFile(configPath, JSON.stringify({ previewLines: 3 }));
      assert.equal(await loadToolDisplayPreviewLines({ configPath }), 3);
      await fs.writeFile(configPath, JSON.stringify({ previewLines: null }));
      assert.equal(await loadToolDisplayPreviewLines({ configPath }), DEFAULT_TOOL_DISPLAY_PREVIEW_LINES);
      await fs.writeFile(configPath, "x".repeat(MAX_TOOL_DISPLAY_CONFIG_BYTES + 1));
      assert.equal(await loadToolDisplayPreviewLines({ configPath }), DEFAULT_TOOL_DISPLAY_PREVIEW_LINES);

      const target = path.join(directory, "target.json");
      const link = path.join(directory, "link.json");
      await fs.writeFile(target, JSON.stringify({ previewLines: 2 }));
      await fs.symlink(target, link);
      assert.equal(await loadToolDisplayPreviewLines({ configPath: link }), DEFAULT_TOOL_DISPLAY_PREVIEW_LINES);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
