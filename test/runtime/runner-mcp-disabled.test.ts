import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { discoverAgents } from "../../src/core/agents";
const originalArgv = process.argv;
process.argv = ["bun", "pi", "--no-mcp", "--exclude-tools", "codemode,mcp__docs__delete", "--no-tools"];
const { buildPiArgs, buildInteractivePiArgs } = await import("../../src/runtime/runner");
process.argv = originalArgv;
const agent = { name: "reader", description: "", systemPrompt: "", source: "user" as const, filePath: "/reader.md" };

test("discovered empty frontmatter uses effective no-tools fallback in inherit and managed", async () => {
  const tempParent = path.join(process.cwd(), ".bun-tmp");
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, "mcp-empty-disabled-"));
  const agentsDir = path.join(root, "agents");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await fs.mkdir(agentsDir, { recursive: true });
    for (const [name, field] of [["omitted", ""], ["array", "tools: []\n"], ["string", 'tools: ""\n'], ["reader", "tools: read\n"]] as const) {
      await fs.writeFile(path.join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: Fixture\n${field}---\nFixture\n`);
    }
    const discovered = discoverAgents(root, "user").agents;
    assert.equal(discovered.length, 4);
    for (const config of discovered) {
      const explicitReader = config.name === "reader";
      assert.deepEqual(config.tools, explicitReader ? ["read"] : undefined);
      for (const policy of ["inherit", "managed"] as const) {
        const variants = [
          buildPiArgs(config, null, "/task", "spawn", null, undefined, policy, undefined, "1.1.0", true),
          buildPiArgs(config, null, "/task", "fork", "/session", undefined, policy, undefined, "1.1.0", true),
          buildInteractivePiArgs(config, null, "/task", "/session", undefined, policy, undefined, "1.1.0", true),
        ];
        for (const args of variants) {
          assert.ok(args.includes("--no-mcp"));
          assert.equal(args.includes("--no-tools"), !explicitReader);
          assert.equal(args.includes("--tools"), explicitReader);
          if (explicitReader) assert.equal(args[args.indexOf("--tools") + 1], "read");
        }
      }
    }
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("parent no-mcp and exclusions are unconditional, parent no-tools retains fallback precedence", () => {
  for (const tools of [undefined, [], ["read"], ["read", "codemode", "mcp__docs__*"]]) {
    const config = { ...agent, tools };
    const variants = [buildPiArgs(config, null, "/task", "spawn", null, undefined, "inherit", undefined, "1.1.0", true), buildPiArgs(config, null, "/task", "fork", "/session", undefined, "inherit", undefined, "1.1.0", true), buildInteractivePiArgs(config, null, "/task", "/session", undefined, "inherit", undefined, "1.1.0", true)];
    for (const args of variants) {
      assert.equal(args.filter((arg) => arg === "--no-mcp").length, 1);
      assert.equal(args[args.indexOf("--exclude-tools") + 1], "codemode,mcp__docs__delete");
      assert.equal(args.includes("--no-tools"), tools === undefined || tools.length === 0);
      if (tools?.length) assert.equal(args[args.indexOf("--tools") + 1], tools.join(","));
    }
  }
});
