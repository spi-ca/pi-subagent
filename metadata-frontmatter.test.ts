import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { extractFrontmatterBlock, readFrontmatterOnly } from "./metadata-frontmatter";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("metadata frontmatter reader", () => {
  test("extracts CRLF frontmatter blocks", () => {
    const content = [
      "---",
      "name: crlf-agent",
      "description: Project agent stored with CRLF",
      "---",
      "Body line",
    ].join("\r\n");

    const block = extractFrontmatterBlock(content);
    assert.equal(block, "---\nname: crlf-agent\ndescription: Project agent stored with CRLF\n---\n");
  });

  test("accepts frontmatter that ends at EOF without a trailing newline", () => {
    const content = [
      "---",
      "name: eof-agent",
      "description: No trailing newline",
      "---",
    ].join("\n");

    const block = extractFrontmatterBlock(content);
    assert.equal(block, "---\nname: eof-agent\ndescription: No trailing newline\n---\n");
  });

  test("accepts closing delimiters with trailing spaces", () => {
    const content = [
      "---",
      "name: spaced-agent",
      "description: Closing delimiter has spaces",
      "---   ",
    ].join("\n");

    const block = extractFrontmatterBlock(content);
    assert.equal(block, "---\nname: spaced-agent\ndescription: Closing delimiter has spaces\n---   \n");
  });

  test("normalizes CR-only line endings", () => {
    const content = [
      "---",
      "name: cr-only-agent",
      "description: CR line endings",
      "---",
    ].join("\r");

    const block = extractFrontmatterBlock(content);
    assert.equal(block, "---\nname: cr-only-agent\ndescription: CR line endings\n---\n");
  });

  test("returns null when frontmatter exceeds the scan limit", async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-frontmatter-"));
    try {
      const filePath = path.join(tempDir, "too-large-frontmatter.md");
      await fs.promises.writeFile(filePath, `---\nname: big\ndescription: ${"x".repeat(70 * 1024)}\n---\nbody`, "utf-8");
      assert.equal(readFrontmatterOnly(filePath), null);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns null when an oversized frontmatter closes in the same chunk", async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-frontmatter-"));
    try {
      const filePath = path.join(tempDir, "oversized-same-chunk.md");
      await fs.promises.writeFile(filePath, `---\nname: big\ndescription: ${"x".repeat(64 * 1024 + 100)}\n---\n`, "utf-8");
      assert.equal(readFrontmatterOnly(filePath), null);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("fails fast on files without frontmatter", async () => {
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-frontmatter-"));
    try {
      const filePath = path.join(tempDir, "no-frontmatter.md");
      await fs.promises.writeFile(filePath, "not-frontmatter\n" + "x".repeat(10000), "utf-8");
      assert.equal(readFrontmatterOnly(filePath), null);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
