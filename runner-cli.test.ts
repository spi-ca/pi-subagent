import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveInheritedCliApiKeyEnvBinding } from "./provider-auth";
import { parseInheritedCliArgs } from "./runner-cli.js";

async function withTempCwd<T>(run: (cwd: string) => Promise<T> | T): Promise<T> {
  const originalCwd = process.cwd();
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-cli-test-"));

  try {
    process.chdir(tempDir);
    return await run(tempDir);
  } finally {
    process.chdir(originalCwd);
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

describe("inherited CLI args", () => {
  test("filters split --api-key values while preserving non-secret inherited flags", () => {
    const parsed = parseInheritedCliArgs([
      "node",
      "pi",
      "--api-key",
      "super-secret",
      "--provider",
      "openrouter",
      "--theme",
      "night-owl",
      "--model",
      "gpt-5",
    ]);

    assert.equal(parsed.alwaysProxy.includes("--api-key"), false);
    assert.equal(parsed.alwaysProxy.includes("super-secret"), false);
    assert.deepEqual(parsed.alwaysProxy, ["--provider", "openrouter", "--theme", "night-owl"]);
    assert.equal(parsed.apiKey, "super-secret");
    assert.equal(parsed.provider, "openrouter");
    assert.equal(parsed.fallbackModel, "gpt-5");
    assert.deepEqual(resolveInheritedCliApiKeyEnvBinding(parsed), {
      state: "resolved",
      binding: {
        name: "OPENROUTER_API_KEY",
        value: "super-secret",
        provider: "openrouter",
      },
    });
  });

  test("does not infer provider mapping from inherited --models and does not forward --system-prompt", () => {
    const parsed = parseInheritedCliArgs([
      "node",
      "pi",
      "--api-key=super-secret",
      "--system-prompt=stay focused",
      "--models=openai/gpt-5",
    ]);

    assert.equal(parsed.alwaysProxy.includes("--api-key"), false);
    assert.equal(parsed.alwaysProxy.includes("super-secret"), false);
    assert.equal(parsed.alwaysProxy.includes("--system-prompt"), false);
    assert.deepEqual(parsed.alwaysProxy, ["--models", "openai/gpt-5"]);
    assert.equal(parsed.apiKey, "super-secret");
    assert.equal(parsed.models, "openai/gpt-5");
    assert.deepEqual(resolveInheritedCliApiKeyEnvBinding(parsed), {
      state: "ambiguous",
      reason: "missing-provider",
      provider: null,
    });
  });

  test("does not forward unknown flags while preserving explicit allowlisted non-secret flags", () => {
    const parsed = parseInheritedCliArgs([
      "node",
      "pi",
      "--theme",
      "night-owl",
      "--mystery-flag=shadow",
      "--verbose",
      "--odd",
      "value",
    ]);

    assert.deepEqual(parsed.alwaysProxy, ["--theme", "night-owl", "--verbose"]);
    assert.equal(parsed.alwaysProxy.includes("--mystery-flag"), false);
    assert.equal(parsed.alwaysProxy.includes("shadow"), false);
    assert.equal(parsed.alwaysProxy.includes("--odd"), false);
    assert.equal(parsed.alwaysProxy.includes("value"), false);
  });

  test("propagates parent context-file and tool restriction flags", () => {
    const parsed = parseInheritedCliArgs([
      "node",
      "pi",
      "--no-context-files",
      "-nc",
      "--no-builtin-tools",
      "-nbt",
      "--exclude-tools",
      "write,edit",
      "-xt",
      "bash",
      "--theme",
      "night-owl",
      "-t",
      "read,find",
      "-nt",
    ]);

    assert.deepEqual(parsed.alwaysProxy, [
      "--no-context-files",
      "-nc",
      "--no-builtin-tools",
      "-nbt",
      "--exclude-tools",
      "write,edit",
      "-xt",
      "bash",
      "--theme",
      "night-owl",
    ]);
    assert.equal(parsed.fallbackTools, "read,find");
    assert.equal(parsed.fallbackNoTools, true);
  });

  test("keeps bare theme, skill, and prompt-template names verbatim even when cwd entries collide", async () => {
    await withTempCwd(async (cwd) => {
      await fs.promises.mkdir(path.join(cwd, "night-owl"));
      await fs.promises.mkdir(path.join(cwd, "lint"));
      await fs.promises.writeFile(path.join(cwd, "docs-template"), "prompt");
      await fs.promises.writeFile(path.join(cwd, "night-owl.v2"), "{}");
      await fs.promises.writeFile(path.join(cwd, "lint.mdx"), "# lint");
      await fs.promises.writeFile(path.join(cwd, "docs-template.v1"), "prompt");
      await fs.promises.mkdir(path.join(cwd, "night-owl.json"));

      const parsed = parseInheritedCliArgs([
        "node",
        "pi",
        "--theme",
        "night-owl.v2",
        "--skill",
        "lint.mdx",
        "--prompt-template",
        "docs-template.v1",
        "--theme",
        "night-owl.json",
      ]);

      assert.deepEqual(parsed.alwaysProxy, [
        "--theme",
        "night-owl.v2",
        "--skill",
        "lint.mdx",
        "--prompt-template",
        "docs-template.v1",
        "--theme",
        "night-owl.json",
      ]);
    });
  });

  test("still resolves explicit relative asset paths against the parent cwd", async () => {
    await withTempCwd(async (cwd) => {
      await fs.promises.mkdir(path.join(cwd, "themes"), { recursive: true });
      await fs.promises.mkdir(path.join(cwd, "skills"), { recursive: true });
      await fs.promises.mkdir(path.join(cwd, "prompts"), { recursive: true });
      await fs.promises.writeFile(path.join(cwd, "themes", "night-owl.json"), "{}");
      await fs.promises.writeFile(path.join(cwd, "skills", "lint.md"), "# lint");
      await fs.promises.writeFile(path.join(cwd, "prompts", "docs.md"), "# docs");
      await fs.promises.writeFile(path.join(cwd, "custom-theme.json"), "{}");

      const parsed = parseInheritedCliArgs([
        "node",
        "pi",
        "--theme",
        "./themes/night-owl.json",
        "--skill",
        "./skills/lint.md",
        "--prompt-template",
        "./prompts/docs.md",
        "--theme",
        "custom-theme.json",
      ]);

      assert.deepEqual(parsed.alwaysProxy, [
        "--theme",
        path.join(cwd, "themes", "night-owl.json"),
        "--skill",
        path.join(cwd, "skills", "lint.md"),
        "--prompt-template",
        path.join(cwd, "prompts", "docs.md"),
        "--theme",
        path.join(cwd, "custom-theme.json"),
      ]);
    });
  });

  test("strips credentials from inherited git extension URLs while preserving safe extension sources", async () => {
    await withTempCwd(async (cwd) => {
      await fs.promises.writeFile(path.join(cwd, "local-extension.ts"), "export default {};\n");

      const parsed = parseInheritedCliArgs([
        "node",
        "pi",
        "--extension",
        "git:https://token@github.com/acme/private-extension.git?ref=main&token=secret&private_token=secret&client_secret=secret&X-Amz-Signature=abc#frag",
        "-e",
        "git:ssh://user:token@example.com/acme/private-extension.git?ref=v1&password=secret#frag",
        "--extension",
        "git:ssh://git@example.com/acme/git-user-extension.git?ref=v1&token=secret#frag",
        "--extension",
        "git:ssh://example.com/acme/public-extension.git?ref=v2&token=secret#frag",
        "--extension",
        "git:github.com/acme/pinned-extension@v1?token=secret#frag",
        "-e",
        "git:token@example.com/acme/drop-me.git?password=secret#frag",
        "-e",
        "token@gitlab.com:acme/drop-me-too.git",
        "-e",
        "git@gitlab.com:acme/scp-extension.git?token=secret",
        "-e",
        "git@gitlab.com:acme/scp-extension.git#frag",
        "-e",
        "git@gitlab.com:acme/scp-extension.git",
        "-e",
        "npm:@acme/safe-extension",
        "--extension",
        "./local-extension.ts",
      ]);

      assert.deepEqual(parsed.extensionArgs, [
        "--extension",
        "git:https://github.com/acme/private-extension.git?ref=main",
        "-e",
        "git:ssh://example.com/acme/private-extension.git?ref=v1",
        "--extension",
        "git:ssh://git@example.com/acme/git-user-extension.git?ref=v1",
        "--extension",
        "git:ssh://example.com/acme/public-extension.git?ref=v2",
        "--extension",
        "git:github.com/acme/pinned-extension@v1",
        "-e",
        "git@gitlab.com:acme/scp-extension.git",
        "-e",
        "npm:@acme/safe-extension",
        "--extension",
        path.join(cwd, "local-extension.ts"),
      ]);
    });
  });

  test("uses a fully-qualified inherited --model as the safe fallback provider hint", () => {
    const parsed = parseInheritedCliArgs([
      "node",
      "pi",
      "--api-key=super-secret",
      "--theme",
      "night-owl",
      "--model",
      "anthropic/claude-3-5-sonnet",
    ]);

    assert.deepEqual(resolveInheritedCliApiKeyEnvBinding(parsed), {
      state: "resolved",
      binding: {
        name: "ANTHROPIC_API_KEY",
        value: "super-secret",
        provider: "anthropic",
      },
    });
  });

  test("returns an ambiguous state for explicit providers without a known env var mapping", () => {
    const parsed = parseInheritedCliArgs([
      "node",
      "pi",
      "--api-key=super-secret",
      "--provider",
      "custom-provider",
    ]);

    assert.deepEqual(resolveInheritedCliApiKeyEnvBinding(parsed), {
      state: "ambiguous",
      reason: "unsupported-provider",
      provider: "custom-provider",
    });
  });

  test("returns an ambiguous state when no explicit provider hint is available", () => {
    const parsed = parseInheritedCliArgs([
      "node",
      "pi",
      "--api-key=super-secret",
      "--theme",
      "night-owl",
      "--model",
      "claude-3-5-sonnet",
    ]);

    assert.deepEqual(resolveInheritedCliApiKeyEnvBinding(parsed), {
      state: "ambiguous",
      reason: "missing-provider",
      provider: null,
    });
  });
});
