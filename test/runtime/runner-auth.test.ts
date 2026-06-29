import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildChildProcessEnv,
  buildPiArgs,
  buildZellijWrapperScript,
  cleanupZellijTempArtifacts,
  getInheritedCliArgsForAgent,
  prepareInheritedApiKeyAgentDir,
  prepareZellijTempArtifacts,
  resolveInheritedCliApiKeyForChild,
  runAgent,
  scheduleDelayedInheritedApiKeyEnvDirCleanup,
} from "../../src/runtime/runner";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("subagent auth propagation", () => {
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

  test("preserves existing provider env/auth when no CLI key binding is propagated", () => {
    const env = buildChildProcessEnv({
      agentName: "worker",
      parentDepth: 0,
      parentAgentStack: [],
      maxDepth: 3,
      preventCycles: true,
      inheritedApiKeyBinding: null,
      baseEnv: {
        OPENAI_API_KEY: "existing-env-secret",
        PATH: "/usr/bin",
      },
    });

    assert.equal(env.OPENAI_API_KEY, "existing-env-secret");
    assert.equal(env.PI_SUBAGENT_DEPTH, "1");
  });

  test("keeps secrets out of zellij wrapper scripts and self-deletes sourced env files", () => {
    const script = buildZellijWrapperScript({
      propagatedEnv: {
        PI_SUBAGENT_DEPTH: "1",
        PI_SUBAGENT_MAX_DEPTH: "3",
        PI_SUBAGENT_STACK: JSON.stringify(["worker"]),
        PI_SUBAGENT_PREVENT_CYCLES: "1",
        PI_SUBAGENT_TRUSTED_PROJECTS: "[]",
        PI_SUBAGENT_DENIED_PROJECTS: "[]",
        PI_OFFLINE: "1",
        PI_SUBAGENT_ORIGINAL_AGENT_DIR: "/home/user/.pi/agent",
        PI_CODING_AGENT_DIR: "/tmp/pi-subagent-agent-overlay",
      },
      inheritedApiKeyEnvFilePath: "/tmp/secret-env/secret.sh",
      paneDisplayName: "subagent-worker",
      isNested: false,
      isFork: false,
      effectiveCwd: "/repo",
      task: "review secret details",
      childCommand: ["pi", "--mode", "json", "-p", "@/tmp/task.md"],
      stderrLogPath: "/tmp/stderr.log",
      stdoutPipePath: "/tmp/stdout.pipe",
      statusPath: "/tmp/status.txt",
      cleanupDirs: ["/tmp/input-dir"],
    });

    assert.equal(script.includes("super-secret"), false);
    assert.equal(script.includes("--api-key"), false);
    assert.equal(script.includes("review secret details"), false);
    assert.equal(script.includes("Task: provided via temporary prompt file"), true);
    assert.equal(script.includes("/tmp/secret-env/secret.sh"), true);
    assert.equal(script.includes("rm -f '/tmp/secret-env/secret.sh'"), true);
    assert.equal(script.includes("sleep 5"), false);
    assert.equal(script.includes("rmdir '/tmp/secret-env'"), false);
    assert.equal(script.includes("rm -rf '/tmp/secret-env'"), false);
    assert.equal(script.includes("trap cleanup_subagent_temp EXIT"), true);
    assert.equal(script.includes("rm -rf '/tmp/input-dir'"), true);
    assert.equal(script.includes("export PI_SUBAGENT_ORIGINAL_AGENT_DIR='/home/user/.pi/agent'"), true);
    assert.equal(script.includes("export PI_CODING_AGENT_DIR='/tmp/pi-subagent-agent-overlay'"), true);
  });

  test("schedules parent-side delayed env-dir cleanup without embedding secrets", () => {
    const spawnCalls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    let unrefCalled = false;

    const result = scheduleDelayedInheritedApiKeyEnvDirCleanup("/tmp/secret-env", {
      spawnDetached: ((command: string, args: string[], options: Record<string, unknown>) => {
        spawnCalls.push({ command, args, options });
        return {
          unref() {
            unrefCalled = true;
          },
        } as never;
      }) as unknown as typeof import("node:child_process").spawn,
    });

    assert.equal(result, "scheduled");
    assert.equal(unrefCalled, true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0]?.command, "sh");
    assert.equal(spawnCalls[0]?.args.includes("/tmp/secret-env"), true);
    assert.equal(spawnCalls[0]?.args.join(" ").includes("super-secret"), false);
    assert.equal(spawnCalls[0]?.args.join(" ").includes("sleep \"$1\""), true);
    assert.deepEqual(spawnCalls[0]?.options, {
      detached: true,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin" },
    });
  });

  test("preserves non-secret zellij temp dirs while scheduling delayed secret env-dir cleanup", async () => {
    const wrapperDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
    const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
    const envDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
    const inputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
    tempDirs.push(wrapperDir, logDir, envDir, inputDir);

    await fs.promises.writeFile(path.join(wrapperDir, "wrapper.sh"), "wrapper");
    await fs.promises.writeFile(path.join(logDir, "stderr.log"), "logs");
    await fs.promises.writeFile(path.join(envDir, "secret.sh"), "secret");
    await fs.promises.writeFile(path.join(inputDir, "task.md"), "Task: keep until pane exits");

    let scheduledSecretDir: string | null = null;
    const scheduledArtifactDirs: Array<string | null> = [];

    cleanupZellijTempArtifacts({
      wrapperDir,
      logDir,
      inheritedApiKeyEnvDir: envDir,
      inputTempDirs: [inputDir],
      preserveTempArtifacts: true,
      scheduleInheritedApiKeyEnvDirCleanup: (dir) => {
        scheduledSecretDir = dir;
      },
      schedulePreservedArtifactDirCleanup: (dir) => {
        scheduledArtifactDirs.push(dir);
      },
    });

    assert.equal(scheduledSecretDir, envDir);
    assert.deepEqual(scheduledArtifactDirs, [inputDir, wrapperDir, logDir]);
    assert.equal(fs.existsSync(wrapperDir), true);
    assert.equal(fs.existsSync(logDir), true);
    assert.equal(fs.existsSync(envDir), true);
    assert.equal(fs.existsSync(inputDir), true);
  });

  test("best-effort cleans zellij temp dirs once artifacts are not preserved", async () => {
    const wrapperDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
    const logDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
    const envDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
    const inputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));

    await fs.promises.writeFile(path.join(wrapperDir, "wrapper.sh"), "wrapper");
    await fs.promises.writeFile(path.join(logDir, "stderr.log"), "logs");
    await fs.promises.writeFile(path.join(envDir, "secret.sh"), "secret");
    await fs.promises.writeFile(path.join(inputDir, "task.md"), "Task: cleanup after pane exits");

    cleanupZellijTempArtifacts({
      wrapperDir,
      logDir,
      inheritedApiKeyEnvDir: envDir,
      inputTempDirs: [inputDir],
      preserveTempArtifacts: false,
    });

    assert.equal(fs.existsSync(wrapperDir), false);
    assert.equal(fs.existsSync(logDir), false);
    assert.equal(fs.existsSync(envDir), false);
    assert.equal(fs.existsSync(inputDir), false);
  });

  test("cleans zellij temp artifacts when sync setup fails before pane launch", async () => {
    const tempRootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-test-"));
    tempDirs.push(tempRootDir);

    let writeCount = 0;
    assert.throws(
      () => prepareZellijTempArtifacts({
        agentName: "worker",
        inheritedApiKeyBinding: {
          name: "OPENROUTER_API_KEY",
          value: "super-secret",
          provider: "openrouter",
        },
        tempRootDir,
        buildWrapperScript: () => "#!/usr/bin/env bash\nexit 0\n",
        writeFileSync: (filePath, contents, options) => {
          writeCount += 1;
          if (writeCount === 2) {
            throw new Error("wrapper write failed");
          }
          fs.writeFileSync(filePath, contents, options);
        },
      }),
      /wrapper write failed/,
    );

    assert.deepEqual(await fs.promises.readdir(tempRootDir), []);
  });
});
