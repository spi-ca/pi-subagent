import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildChildProcessEnv,
  buildPrivateChildEnvironmentScript,
  buildPiArgs,
  applyChildProjectIsolation,
  getInheritedCliArgsForAgent,
  prepareInheritedApiKeyAgentDir,
  resolveInheritedCliApiKeyForChild,
  runAgent,
} from "../../src/runtime/runner";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("subagent auth propagation", () => {
  test("propagates the exact resolved pane layout to nested inline and interactive children", () => {
    const common = {
      agentName: "worker",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      baseEnv: {},
    };
    assert.equal(buildChildProcessEnv({ ...common, interactivePaneLayout: "auto" }).PI_SUBAGENT_PANE_LAYOUT, "auto");
    assert.equal(buildChildProcessEnv({ ...common, interactivePaneLayout: "split" }).PI_SUBAGENT_PANE_LAYOUT, "split");
  });

  test("uses an inherited API-key agent-dir overlay instead of argv/env key injection", async () => {
    const sourceAgentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-source-"));
    tempDirs.push(sourceAgentDir);
    await fs.promises.writeFile(path.join(sourceAgentDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "stored-key" } }));
    await fs.promises.mkdir(path.join(sourceAgentDir, "agents"));

    const overlayDir = prepareInheritedApiKeyAgentDir({
      name: "OPENROUTER_API_KEY",
      value: "super-secret",
      provider: "openrouter",
    }, { baseEnv: { PI_CODING_AGENT_DIR: sourceAgentDir } });
    assert.ok(overlayDir);
    tempDirs.push(overlayDir);

    const env = buildChildProcessEnv({
      agentName: "worker",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      inheritedApiKeyBinding: {
        name: "OPENROUTER_API_KEY",
        value: "super-secret",
        provider: "openrouter",
      },
      inheritedApiKeyAgentDir: overlayDir,
      baseEnv: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: sourceAgentDir },
    });

    const auth = JSON.parse(await fs.promises.readFile(path.join(overlayDir, "auth.json"), "utf-8"));
    assert.equal(auth.openrouter.key, "$PI_SUBAGENT_INHERITED_API_KEY");
    assert.deepEqual(Object.keys(auth), ["openrouter"]);
    assert.equal(env.OPENROUTER_API_KEY, undefined);
    assert.equal(env.PI_SUBAGENT_INHERITED_API_KEY, "super-secret");
    assert.equal(env.PI_CODING_AGENT_DIR, overlayDir);
    assert.equal(env.PI_SUBAGENT_DEPTH, "1");
    assert.equal(env.PI_SUBAGENT_STACK, JSON.stringify(["worker"]));
    assert.equal(env.PATH, "/usr/bin");
  });

  test("cleans an inherited API-key overlay if auth writing fails", async () => {
    let overlayDir: string | null = null;

    assert.throws(() => prepareInheritedApiKeyAgentDir({
      name: "OPENROUTER_API_KEY",
      value: "super-secret",
      provider: "openrouter",
    }, {
      baseEnv: { PI_CODING_AGENT_DIR: "/missing-agent-dir" },
      mkdtempSync: (prefix) => {
        overlayDir = fs.mkdtempSync(prefix);
        return overlayDir;
      },
      writeFileSync: () => {
        throw new Error("disk full");
      },
    }), /disk full/);

    assert.ok(overlayDir);
    assert.equal(fs.existsSync(overlayDir), false);
  });

  test("restores the original agent dir for nested children without a new CLI key overlay", () => {
    const env = buildChildProcessEnv({
      agentName: "nested",
      parentDepth: 1,
      parentAgentStack: ["worker"],
      maxDepth: 3,
      preventCycles: true,
      inheritedApiKeyBinding: null,
      baseEnv: {
        PI_CODING_AGENT_DIR: "/tmp/pi-subagent-agent-overlay",
        PI_SUBAGENT_ORIGINAL_AGENT_DIR: "/home/user/.pi/agent",
        PI_SUBAGENT_INHERITED_API_KEY: "super-secret",
        PATH: "/usr/bin",
      },
    });

    assert.equal(env.PI_CODING_AGENT_DIR, "/home/user/.pi/agent");
    assert.equal(env.PI_SUBAGENT_ORIGINAL_AGENT_DIR, undefined);
    assert.equal(env.PI_SUBAGENT_INHERITED_API_KEY, undefined);
    assert.equal(env.PI_SUBAGENT_DEPTH, "2");
  });

  test("drops an ambiguous inherited CLI --api-key but keeps delegation available", () => {
    const outcome = resolveInheritedCliApiKeyForChild({
      apiKey: "super-secret",
      fallbackModel: "claude-3-5-sonnet",
    });

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /child will not inherit the CLI key/i);
    assert.match(outcome.warningMessage ?? "", /--provider/);
    assert.match(outcome.warningMessage ?? "", /--model/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("uses a user agent model as a provider hint when parent hints are absent", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        fallbackModel: "claude-3-5-sonnet",
      },
      {
        source: "user",
        model: "anthropic/claude-3-5-sonnet",
      },
    );

    assert.deepEqual(outcome, {
      inheritedApiKeyBinding: {
        name: "ANTHROPIC_API_KEY",
        value: "super-secret",
        provider: "anthropic",
      },
      warningMessage: null,
    });
  });

  test("normalizes explicit parent provider case before conflict checks", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        provider: "OpenRouter",
        fallbackModel: "openrouter/openai/gpt-5",
      },
      { source: "user", model: "openrouter/openai/gpt-5" },
    );

    assert.deepEqual(outcome.inheritedApiKeyBinding, {
      name: "OPENROUTER_API_KEY",
      value: "super-secret",
      provider: "openrouter",
    });
    assert.equal(outcome.warningMessage, null);
  });

  test("does not propagate a CLI key when parent provider conflicts with user agent model", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        provider: "openrouter",
        fallbackModel: "openrouter/openai/gpt-5",
      },
      {
        source: "user",
        model: "anthropic/claude-3-5-sonnet",
      },
    );

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /conflicts with the child model provider/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("does not propagate a CLI key when explicit parent provider conflicts with parent model provider", () => {
    const outcome = resolveInheritedCliApiKeyForChild({
      apiKey: "super-secret",
      provider: "openrouter",
      fallbackModel: "anthropic/claude-3-5-sonnet",
    });

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /conflicts with the parent model provider/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("does not propagate a CLI key when parent model provider conflicts with user agent model", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        fallbackModel: "openrouter/openai/gpt-5",
      },
      {
        source: "user",
        model: "anthropic/claude-3-5-sonnet",
      },
    );

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /conflicts with the child model provider/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("does not propagate a CLI key when parent provider conflicts with trusted project agent model", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        provider: "openrouter",
        fallbackModel: "openrouter/openai/gpt-5",
      },
      {
        source: "project",
        model: "anthropic/claude-3-5-sonnet",
      },
      { projectAgentTrusted: true },
    );

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /conflicts with the child model provider/);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("uses a trusted project agent model as a provider hint when parent hints are absent", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        fallbackModel: "claude-3-5-sonnet",
      },
      {
        source: "project",
        model: "anthropic/claude-3-5-sonnet",
      },
      { projectAgentTrusted: true },
    );

    assert.deepEqual(outcome, {
      inheritedApiKeyBinding: {
        name: "ANTHROPIC_API_KEY",
        value: "super-secret",
        provider: "anthropic",
      },
      warningMessage: null,
    });
  });

  test("does not use an untrusted project agent model as a provider hint", () => {
    const outcome = resolveInheritedCliApiKeyForChild(
      {
        apiKey: "super-secret",
        fallbackModel: "claude-3-5-sonnet",
      },
      {
        source: "project",
        model: "anthropic/claude-3-5-sonnet",
      },
    );

    assert.equal(outcome.inheritedApiKeyBinding, null);
    assert.match(outcome.warningMessage ?? "", /child will not inherit the CLI key/i);
    assert.equal((outcome.warningMessage ?? "").includes("super-secret"), false);
  });

  test("drops inherited --provider when the effective child model is fully-qualified", () => {
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "user", model: "anthropic/claude-3-5-sonnet" },
        ["--provider", "openrouter", "--theme", "night-owl"],
      ),
      ["--theme", "night-owl"],
    );
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "project", model: "anthropic/claude-3-5-sonnet" },
        ["--provider", "openrouter", "--theme", "night-owl"],
      ),
      ["--theme", "night-owl"],
    );
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "user", model: undefined },
        ["--provider", "openrouter", "--theme", "night-owl"],
        "anthropic/claude-3-5-sonnet",
      ),
      ["--theme", "night-owl"],
    );
  });

  test("keeps the parent provider in child args for user agents with unqualified models", () => {
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "user", model: "claude-3-5-sonnet" },
        ["--provider", "openrouter", "--theme", "night-owl"],
      ),
      ["--provider", "openrouter", "--theme", "night-owl"],
    );
  });

  test("uses per-call model override when deciding child model args and inherited provider flags", () => {
    assert.deepEqual(
      getInheritedCliArgsForAgent(
        { source: "user", model: "claude-3-5-sonnet" },
        ["--provider", "openrouter", "--theme", "night-owl"],
        undefined,
        "anthropic/claude-sonnet-4",
      ),
      ["--theme", "night-owl"],
    );

    const args = buildPiArgs(
      {
        name: "worker",
        description: "Worker",
        systemPrompt: "",
        source: "user",
        filePath: "/tmp/worker.md",
        model: "openai/gpt-4.1",
      },
      null,
      "/tmp/task-worker.md",
      "spawn",
      null,
      "anthropic/claude-sonnet-4",
    );

    assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
      "--model",
      "anthropic/claude-sonnet-4",
    ]);
    assert.equal(args.includes("openai/gpt-4.1"), false);
  });

  test("keeps per-call model override on early unknown-agent results", async () => {
    const result = await runAgent({
      cwd: process.cwd(),
      agents: [],
      agentName: "missing",
      task: "Do work",
      model: "anthropic/claude-sonnet-4",
      delegationMode: "spawn",
      terminalMode: "inline",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      makeDetails: (results) => ({
        mode: "single",
        toolLabel: "Subagent",
        delegationMode: "spawn",
        terminalMode: "inline",
        projectAgentsDir: null,
        results,
      }),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.model, "anthropic/claude-sonnet-4");
    assert.match(result.stderr, /Unknown agent/);
  });

  test("keeps inline children project-unapproved after project-agent approval", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-project-"));
    tempDirs.push(root);
    await fs.promises.mkdir(path.join(root, ".pi", "agents"), { recursive: true });
    const args = buildPiArgs({
      name: "project-worker", description: "Worker", systemPrompt: "", source: "project", filePath: path.join(root, ".pi", "agents", "worker.md"),
    }, null, "/tmp/task.md", "spawn", null);
    args.unshift("--context-file", "/tmp/untrusted-context.md", "-nc", "--approve");
    applyChildProjectIsolation(args, root);
    assert.equal(args.includes("--approve"), false);
    assert.equal(args.includes("--context-file"), false);
    assert.equal(args.includes("-nc"), false);
    assert.equal(args.filter((arg) => arg === "--no-context-files").length, 1);
    assert.equal(args.filter((arg) => arg === "--no-approve").length, 1);
  });

  test("passes delegated task via @file instead of argv text", () => {
    const args = buildPiArgs(
      {
        name: "worker",
        description: "Worker",
        systemPrompt: "",
        source: "user",
        filePath: "/tmp/worker.md",
      },
      null,
      "/tmp/task-worker.md",
      "spawn",
      null,
    );

    assert.equal(args.includes("Task: secret task"), false);
    assert.equal(args.at(-1), "@/tmp/task-worker.md");
  });

  test("keeps documented provider environment aligned for inline and private interactive children", () => {
    const providerEnv = {
      OPENAI_API_KEY: "existing-env-secret",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-secret",
      RADIUS_API_KEY: "radius-secret",
      AZURE_OPENAI_BASE_URL: "https://resource.openai.azure.com",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      GOOGLE_CLOUD_PROJECT: "vertex-project",
      GOOGLE_APPLICATION_CREDENTIALS: "/private/vertex.json",
      AWS_WEB_IDENTITY_TOKEN_FILE: "/private/irsa-token",
      HTTPS_PROXY: "http://proxy",
      UNRELATED_SECRET: "must-not-pass-to-interactive-child",
      PATH: "/usr/bin",
    };
    const env = buildChildProcessEnv({
      agentName: "worker",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      inheritedApiKeyBinding: null,
      baseEnv: providerEnv,
    });
    const privateInteractiveEnv = buildPrivateChildEnvironmentScript(env);

    for (const [name, value] of Object.entries(providerEnv)) {
      assert.equal(env[name], value);
      if (name !== "UNRELATED_SECRET") assert.ok(privateInteractiveEnv.includes(`export ${name}='${value}'`));
    }
    assert.equal(privateInteractiveEnv.includes("UNRELATED_SECRET="), false);
    assert.equal(env.PI_SUBAGENT_DEPTH, "1");
  });


});
