import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_SUBAGENT_LIMITS,
  MAX_NODE_TIMER_DELAY_MS,
  MAX_SUBAGENT_ACTIVE,
  MAX_SUBAGENT_BACKGROUND_HISTORY,
  MAX_SUBAGENT_BACKGROUND_JOBS,
  MAX_SUBAGENT_BACKGROUND_METADATA_BYTES,
  MAX_SUBAGENT_BACKGROUND_OUTPUT_BYTES,
  MAX_SUBAGENT_CHAIN_STEPS,
  MAX_SUBAGENT_TASKS,
  SUBAGENT_LIMIT_DEFINITIONS,
  getSubagentLimitConfigPaths,
  loadSubagentLimitConfigSources,
  parseLimitValue,
  resolveSubagentLimits,
  resolveSubagentLimitsForSession,
  subagentLimitsToEnv,
} from "../../src/core/subagent-limits";

describe("subagent limits", () => {
  test("uses documented defaults", () => {
    assert.deepEqual(resolveSubagentLimits({ env: {}, warn: () => {} }), {
      maxActive: 16,
      maxParallelTasks: 50,
      maxChainSteps: 12,
      maxConcurrency: 16,
      maxChainParallelTasks: 8,
      maxBackgroundJobs: 16,
      backgroundHistoryLimit: 20,
      backgroundHistoryTtlMs: 3_600_000,
      backgroundOutputMaxBytes: 16_384,
      backgroundShutdownSettleMs: 3_000,
      parallelHeartbeatMs: 1_000,
    });
  });

  test("uses CLI over environment and falls back after invalid configured values", () => {
    const warnings: string[] = [];
    const limits = resolveSubagentLimits({
      getFlag: (name) => name === "subagent-max-parallel-tasks" ? "7" : name === "subagent-max-concurrency" ? "0" : undefined,
      env: { PI_SUBAGENT_MAX_PARALLEL_TASKS: "4", PI_SUBAGENT_MAX_CONCURRENCY: "3", PI_SUBAGENT_MAX_CHAIN_STEPS: "bad" },
      warn: (message) => warnings.push(message),
    });
    assert.equal(limits.maxParallelTasks, 7);
    assert.equal(limits.maxConcurrency, 3);
    assert.equal(limits.maxChainSteps, 12);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((message) => /--subagent-max-concurrency/.test(message)));
    assert.ok(warnings.some((message) => /PI_SUBAGENT_MAX_CHAIN_STEPS/.test(message)));
  });

  test("enforces documented practical representation ceilings across every source", () => {
    const warnings: string[] = [];
    assert.equal(MAX_SUBAGENT_ACTIVE, 256);
    assert.equal(MAX_SUBAGENT_TASKS, 256);
    assert.equal(MAX_SUBAGENT_CHAIN_STEPS, 256);
    assert.equal(MAX_SUBAGENT_BACKGROUND_JOBS, 256);
    assert.equal(MAX_SUBAGENT_BACKGROUND_HISTORY, 256);
    assert.equal(MAX_SUBAGENT_BACKGROUND_OUTPUT_BYTES, 65_536);
    assert.equal(MAX_SUBAGENT_BACKGROUND_METADATA_BYTES, 4_096);
    const maximum = resolveSubagentLimits({
      env: {
        PI_SUBAGENT_MAX_ACTIVE: "256",
        PI_SUBAGENT_MAX_PARALLEL_TASKS: "256",
        PI_SUBAGENT_MAX_CHAIN_STEPS: "256",
        PI_SUBAGENT_MAX_CONCURRENCY: "256",
        PI_SUBAGENT_MAX_CHAIN_PARALLEL_TASKS: "256",
        PI_SUBAGENT_MAX_BACKGROUND_JOBS: "256",
        PI_SUBAGENT_BACKGROUND_HISTORY_LIMIT: "256",
        PI_SUBAGENT_BACKGROUND_OUTPUT_MAX_BYTES: "65536"
      },
      warn: () => {},
    });
    assert.equal(maximum.maxParallelTasks, MAX_SUBAGENT_TASKS);
    assert.equal(maximum.maxChainSteps, MAX_SUBAGENT_CHAIN_STEPS);
    assert.equal(maximum.maxConcurrency, MAX_SUBAGENT_ACTIVE);
    assert.equal(maximum.maxChainParallelTasks, MAX_SUBAGENT_TASKS);
    assert.equal(maximum.maxBackgroundJobs, MAX_SUBAGENT_BACKGROUND_JOBS);
    assert.equal(maximum.backgroundHistoryLimit, MAX_SUBAGENT_BACKGROUND_HISTORY);
    assert.equal(maximum.backgroundOutputMaxBytes, MAX_SUBAGENT_BACKGROUND_OUTPUT_BYTES);
    const rejected = resolveSubagentLimits({
      env: {
        PI_SUBAGENT_MAX_ACTIVE: "257",
        PI_SUBAGENT_MAX_PARALLEL_TASKS: "257",
        PI_SUBAGENT_MAX_CHAIN_STEPS: "257",
        PI_SUBAGENT_MAX_CONCURRENCY: "257",
        PI_SUBAGENT_MAX_CHAIN_PARALLEL_TASKS: "257",
        PI_SUBAGENT_MAX_BACKGROUND_JOBS: "257",
        PI_SUBAGENT_BACKGROUND_HISTORY_LIMIT: "257",
        PI_SUBAGENT_BACKGROUND_OUTPUT_MAX_BYTES: "65537",
      },
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(rejected, DEFAULT_SUBAGENT_LIMITS);
    assert.ok(warnings.every((message) => /at most (?:256|65536)/.test(message)));
  });

  test("uses pi.getFlag as authoritative and never scans positional argv after --", () => {
    const original = process.argv;
    try {
      process.argv = ["bun", "pi", "--", "--subagent-max-active=1"];
      assert.equal(resolveSubagentLimits({ env: { PI_SUBAGENT_MAX_ACTIVE: "2" }, getFlag: (name) => name === "subagent-max-active" ? "3" : undefined, warn: () => {} }).maxActive, 3);
    } finally { process.argv = original; }
  });

  test("permits zero only for non-negative limits and rejects unsafe values", () => {
    assert.equal(parseLimitValue("0"), 0);
    assert.equal(parseLimitValue("0", true), null);
    assert.equal(parseLimitValue("1", true), 1);
    assert.equal(parseLimitValue("-1"), null);
    assert.equal(parseLimitValue("9007199254740992"), null);
  });

  test("rejects timer values above Node's maximum and falls back through CLI, env, then defaults", () => {
    const warnings: string[] = [];
    const limits = resolveSubagentLimits({
      getFlag: (name) => name === "subagent-background-shutdown-settle-ms" ? "2147483648" : undefined,
      env: {
        PI_SUBAGENT_BACKGROUND_SHUTDOWN_SETTLE_MS: "42",
        PI_SUBAGENT_PARALLEL_HEARTBEAT_MS: "2147483648",
      },
      warn: (message) => warnings.push(message),
    });

    assert.equal(limits.backgroundShutdownSettleMs, 42);
    assert.equal(limits.parallelHeartbeatMs, 1_000);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((message) => /at most 2147483647/.test(message)));
  });

  test("loads optional global and trusted project files with per-key fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-limits-"));
    try {
      const agentDir = path.join(root, "agent");
      const cwd = path.join(root, "project");
      const paths = getSubagentLimitConfigPaths({ agentDir, cwd, configDirName: ".pi" });
      await fs.mkdir(path.dirname(paths.globalPath), { recursive: true });
      await fs.mkdir(path.dirname(paths.projectPath), { recursive: true });
      const absent = await loadSubagentLimitConfigSources({ agentDir, cwd, configDirName: ".pi", projectTrusted: true, warn: () => {} });
      assert.deepEqual(absent.globalConfig, {});
      assert.deepEqual(absent.projectConfig, {});
      assert.deepEqual(resolveSubagentLimits({ env: {}, ...absent, warn: () => {} }), DEFAULT_SUBAGENT_LIMITS);
      await fs.writeFile(paths.globalPath, JSON.stringify({ maxParallelTasks: 7, maxConcurrency: 3 }));
      await fs.writeFile(paths.projectPath, JSON.stringify({ maxParallelTasks: 9 }));

      const trusted = await loadSubagentLimitConfigSources({ agentDir, cwd, configDirName: ".pi", projectTrusted: true, warn: () => {} });
      const resolved = resolveSubagentLimits({ env: {}, ...trusted, warn: () => {} });
      assert.equal(trusted.globalPath, path.join(agentDir, "pi-subagent.json"));
      assert.equal(trusted.projectPath, path.join(cwd, ".pi", "pi-subagent.json"));
      assert.equal(resolved.maxParallelTasks, 9);
      assert.equal(resolved.maxConcurrency, 3);
      assert.equal(resolved.maxChainSteps, DEFAULT_SUBAGENT_LIMITS.maxChainSteps);

      await fs.writeFile(paths.globalPath, JSON.stringify({ maxParallelTasks: 7, maxConcurrency: 2 }));
      const reloaded = await loadSubagentLimitConfigSources({ agentDir, cwd, configDirName: ".pi", projectTrusted: true, warn: () => {} });
      assert.equal(resolveSubagentLimits({ env: {}, ...reloaded, warn: () => {} }).maxConcurrency, 2);

      const untrusted = await loadSubagentLimitConfigSources({ agentDir, cwd, configDirName: ".pi", projectTrusted: false, warn: () => {} });
      assert.deepEqual(untrusted.projectConfig, {});
      assert.equal(resolveSubagentLimits({ env: {}, ...untrusted, warn: () => {} }).maxParallelTasks, 7);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("reloads files independently for startup, reload, resume, and fork session starts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-session-config-"));
    try {
      const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"); await fs.mkdir(agentDir); await fs.mkdir(path.join(cwd, ".pi"), { recursive: true });
      const configPath = path.join(cwd, ".pi", "pi-subagent.json");
      for (const [index, reason] of ["startup", "reload", "resume", "fork"].entries()) {
        await fs.writeFile(configPath, JSON.stringify({ maxActive: index + 1 }));
        const limits = await resolveSubagentLimitsForSession({ agentDir, cwd, configDirName: ".pi", projectTrusted: true, env: {}, getFlag: () => undefined, warn: () => {} });
        assert.equal(limits.maxActive, index + 1, reason);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("warns and safely falls through malformed, non-object, unknown, and invalid file values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-limits-"));
    const warnings: string[] = [];
    try {
      const agentDir = path.join(root, "agent");
      const cwd = path.join(root, "project");
      const paths = getSubagentLimitConfigPaths({ agentDir, cwd, configDirName: ".pi" });
      await fs.mkdir(path.dirname(paths.globalPath), { recursive: true });

      await fs.writeFile(paths.globalPath, "{");
      let sources = await loadSubagentLimitConfigSources({ agentDir, cwd, configDirName: ".pi", projectTrusted: true, warn: (message) => warnings.push(message) });
      assert.deepEqual(sources.globalConfig, {});
      await fs.writeFile(paths.globalPath, "true");
      sources = await loadSubagentLimitConfigSources({ agentDir, cwd, configDirName: ".pi", projectTrusted: true, warn: (message) => warnings.push(message) });
      assert.deepEqual(sources.globalConfig, {});
      await fs.writeFile(paths.globalPath, "[]");
      sources = await loadSubagentLimitConfigSources({ agentDir, cwd, configDirName: ".pi", projectTrusted: true, warn: (message) => warnings.push(message) });
      assert.deepEqual(sources.globalConfig, {});
      await fs.writeFile(paths.globalPath, JSON.stringify({ $schema: "https://example.test/schema", unknownTypo: 1, maxConcurrency: 0, maxChainSteps: 4 }));
      sources = await loadSubagentLimitConfigSources({ agentDir, cwd, configDirName: ".pi", projectTrusted: true, warn: (message) => warnings.push(message) });
      assert.equal(sources.globalConfig.$schema, "https://example.test/schema");
      assert.equal(sources.globalConfig.maxConcurrency, undefined);
      assert.equal(sources.globalConfig.maxChainSteps, 4);
      const resolved = resolveSubagentLimits({ env: {}, ...sources, warn: () => {} });
      assert.equal(resolved.maxConcurrency, DEFAULT_SUBAGENT_LIMITS.maxConcurrency);
      assert.equal(resolved.maxChainSteps, 4);
      assert.ok(warnings.some((message) => /malformed JSON/.test(message)));
      assert.ok(warnings.some((message) => /expected a JSON object/.test(message)));
      assert.ok(warnings.some((message) => /unknown config key/.test(message)));
      assert.ok(warnings.some((message) => /invalid maxConcurrency/.test(message)));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a final symlink config rather than following it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-limits-"));
    const warnings: string[] = [];
    try {
      const agentDir = path.join(root, "agent");
      const target = path.join(root, "target.json");
      const configPath = path.join(agentDir, "pi-subagent.json");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(target, JSON.stringify({ maxParallelTasks: 1 }));
      await fs.symlink(target, configPath, "file");
      const sources = await loadSubagentLimitConfigSources({
        agentDir,
        cwd: path.join(root, "project"),
        configDirName: ".pi",
        projectTrusted: false,
        warn: (message) => warnings.push(message),
      });
      assert.deepEqual(sources.globalConfig, {});
      assert.ok(warnings.some((message) => /regular non-symlink file/.test(message)));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a trusted project config whose symlinked .pi directory escapes the project", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-containment-")); const warnings: string[] = [];
    try {
      const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), outside = path.join(root, "outside");
      await fs.mkdir(agentDir); await fs.mkdir(cwd); await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "pi-subagent.json"), JSON.stringify({ maxActive: 1 }));
      await fs.symlink(outside, path.join(cwd, ".pi"), "dir");
      const sources = await loadSubagentLimitConfigSources({ agentDir, cwd, configDirName: ".pi", projectTrusted: true, warn: (message) => warnings.push(message) });
      assert.deepEqual(sources.projectConfig, {});
      assert.ok(warnings.some((message) => /escapes the trusted project/.test(message)));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  test("gives authoritative Pi flags and environment values precedence over file sources", () => {
    const limits = resolveSubagentLimits({
      getFlag: (name) => name === "subagent-max-parallel-tasks" ? "8" : undefined,
      env: { PI_SUBAGENT_MAX_ACTIVE: "7", PI_SUBAGENT_MAX_PARALLEL_TASKS: "7", PI_SUBAGENT_MAX_CONCURRENCY: "6" },
      globalConfig: { maxActive: 4, maxParallelTasks: 5, maxConcurrency: 4 },
      projectConfig: { maxActive: 5, maxParallelTasks: 6, maxConcurrency: 5 },
      warn: () => {},
    });
    assert.equal(limits.maxParallelTasks, 8);
    assert.equal(limits.maxConcurrency, 6);
    assert.equal(limits.maxActive, 7);
  });

  test("matches the published schema to runtime definitions", async () => {
    const schema = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../../pi-subagent.schema.json"), "utf8")) as {
      additionalProperties: boolean;
      properties: Record<string, { type?: string; minimum?: number; maximum?: number; default?: number }>;
    };
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.$schema.type, "string");
    assert.deepEqual(Object.keys(schema.properties).filter((name) => name !== "$schema").sort(), Object.keys(SUBAGENT_LIMIT_DEFINITIONS).sort());
    for (const [name, definition] of Object.entries(SUBAGENT_LIMIT_DEFINITIONS)) {
      const property = schema.properties[name];
      assert.equal(property.type, "integer");
      assert.equal(property.minimum, definition.positive ? 1 : 0);
      assert.equal(property.default, definition.defaultValue);
      assert.equal(property.maximum, definition.maxValue);
    }
    assert.equal(MAX_NODE_TIMER_DELAY_MS, 2_147_483_647);
  });

  test("keeps README and configuration tables in parity with runtime keys", async () => {
    const readme = await fs.readFile(path.resolve(import.meta.dirname, "../../README.md"), "utf8");
    const configuration = await fs.readFile(path.resolve(import.meta.dirname, "../../docs/configuration.md"), "utf8");
    for (const name of Object.keys(SUBAGENT_LIMIT_DEFINITIONS)) {
      assert.match(readme, new RegExp("\\| `" + name + "` \\|"));
      assert.match(configuration, new RegExp("\\| `" + name + "` \\|"));
    }
    const packageJson = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../../package.json"), "utf8")) as { files?: string[] };
    assert.ok(packageJson.files?.includes("pi-subagent.schema.json"));
  });

  test("serializes every resolved limit for nested child policy", () => {
    const limits = resolveSubagentLimits({ env: {}, warn: () => {} });
    const propagated = subagentLimitsToEnv({ ...limits, maxBackgroundJobs: 0 });
    assert.equal(Object.keys(propagated).length, Object.keys(SUBAGENT_LIMIT_DEFINITIONS).length);
    assert.equal(propagated.PI_SUBAGENT_MAX_BACKGROUND_JOBS, "0");
    assert.equal(propagated.PI_SUBAGENT_MAX_CONCURRENCY, "16");
  });
});
