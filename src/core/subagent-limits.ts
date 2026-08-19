import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface SubagentLimits {
  maxActive: number;
  maxParallelTasks: number;
  maxChainSteps: number;
  maxConcurrency: number;
  maxChainParallelTasks: number;
  maxBackgroundJobs: number;
  backgroundHistoryLimit: number;
  backgroundHistoryTtlMs: number;
  backgroundOutputMaxBytes: number;
  backgroundShutdownSettleMs: number;
  parallelHeartbeatMs: number;
}

type LimitName = keyof SubagentLimits;
type LimitDefinition = {
  flag: string;
  env: string;
  defaultValue: number;
  positive?: boolean;
  maxValue?: number;
};

export type SubagentLimitConfig = Partial<SubagentLimits> & { $schema?: string };

/** Hard representation and scheduling ceiling shared by config, CLI, and tree permits. */
export const MAX_SUBAGENT_ACTIVE = 256;
/** Backwards-compatible descriptive alias for consumers of the limits module. */
export const MAX_SUBAGENT_MAX_ACTIVE = MAX_SUBAGENT_ACTIVE;

/**
 * Practical representation ceilings. They preserve the established defaults
 * while preventing unbounded call-shape traversal and retained job state.
 * Task/concurrency/background caps align with the existing 256 active-permit
 * ceiling and existing dashboard terminal bound; 64 KiB output aligns with
 * the live session-tail chunk bound. Together history and output retain at
 * most roughly 16 MiB of caller-visible text before small truncation notices.
 */
export const MAX_SUBAGENT_TASKS = MAX_SUBAGENT_ACTIVE;
export const MAX_SUBAGENT_CHAIN_STEPS = MAX_SUBAGENT_ACTIVE;
export const MAX_SUBAGENT_BACKGROUND_JOBS = MAX_SUBAGENT_ACTIVE;
export const MAX_SUBAGENT_BACKGROUND_HISTORY = MAX_SUBAGENT_ACTIVE;
export const MAX_SUBAGENT_BACKGROUND_OUTPUT_BYTES = 64 * 1024;
/** Per-field cap for completed background agent/task status metadata. */
export const MAX_SUBAGENT_BACKGROUND_METADATA_BYTES = 4 * 1024;

export const SUBAGENT_CONFIG_FILENAME = "pi-subagent.json";
/** Keep config reads bounded even when a file is unexpectedly large. */
export const MAX_SUBAGENT_CONFIG_BYTES = 64 * 1024;
/** Node clamps larger timer delays to 1 ms, which inverts timeout behavior. */
export const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

export const SUBAGENT_LIMIT_DEFINITIONS: Record<LimitName, LimitDefinition> = {
  maxActive: { flag: "subagent-max-active", env: "PI_SUBAGENT_MAX_ACTIVE", defaultValue: 16, positive: true, maxValue: MAX_SUBAGENT_ACTIVE },
  maxParallelTasks: { flag: "subagent-max-parallel-tasks", env: "PI_SUBAGENT_MAX_PARALLEL_TASKS", defaultValue: 50, maxValue: MAX_SUBAGENT_TASKS },
  maxChainSteps: { flag: "subagent-max-chain-steps", env: "PI_SUBAGENT_MAX_CHAIN_STEPS", defaultValue: 12, maxValue: MAX_SUBAGENT_CHAIN_STEPS },
  maxConcurrency: { flag: "subagent-max-concurrency", env: "PI_SUBAGENT_MAX_CONCURRENCY", defaultValue: 16, positive: true, maxValue: MAX_SUBAGENT_ACTIVE },
  maxChainParallelTasks: { flag: "subagent-max-chain-parallel-tasks", env: "PI_SUBAGENT_MAX_CHAIN_PARALLEL_TASKS", defaultValue: 8, maxValue: MAX_SUBAGENT_TASKS },
  maxBackgroundJobs: { flag: "subagent-max-background-jobs", env: "PI_SUBAGENT_MAX_BACKGROUND_JOBS", defaultValue: 16, maxValue: MAX_SUBAGENT_BACKGROUND_JOBS },
  backgroundHistoryLimit: { flag: "subagent-background-history-limit", env: "PI_SUBAGENT_BACKGROUND_HISTORY_LIMIT", defaultValue: 20, maxValue: MAX_SUBAGENT_BACKGROUND_HISTORY },
  backgroundHistoryTtlMs: { flag: "subagent-background-history-ttl-ms", env: "PI_SUBAGENT_BACKGROUND_HISTORY_TTL_MS", defaultValue: 3_600_000, maxValue: Number.MAX_SAFE_INTEGER },
  backgroundOutputMaxBytes: { flag: "subagent-background-output-max-bytes", env: "PI_SUBAGENT_BACKGROUND_OUTPUT_MAX_BYTES", defaultValue: 16_384, maxValue: MAX_SUBAGENT_BACKGROUND_OUTPUT_BYTES },
  backgroundShutdownSettleMs: { flag: "subagent-background-shutdown-settle-ms", env: "PI_SUBAGENT_BACKGROUND_SHUTDOWN_SETTLE_MS", defaultValue: 3_000, maxValue: MAX_NODE_TIMER_DELAY_MS },
  parallelHeartbeatMs: { flag: "subagent-parallel-heartbeat-ms", env: "PI_SUBAGENT_PARALLEL_HEARTBEAT_MS", defaultValue: 1_000, positive: true, maxValue: MAX_NODE_TIMER_DELAY_MS },
};

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = Object.fromEntries(
  (Object.entries(SUBAGENT_LIMIT_DEFINITIONS) as Array<[LimitName, LimitDefinition]>).map(([name, definition]) => [name, definition.defaultValue]),
) as unknown as SubagentLimits;

function isValidLimitNumber(value: number, definition: LimitDefinition): boolean {
  return Number.isSafeInteger(value)
    && value >= (definition.positive ? 1 : 0)
    && (definition.maxValue === undefined || value <= definition.maxValue);
}

export function parseLimitValue(raw: unknown, positive = false, maxValue = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return isValidLimitNumber(parsed, { flag: "", env: "", defaultValue: 0, positive, maxValue }) ? parsed : null;
}

function parseConfigLimitValue(raw: unknown, definition: LimitDefinition): number | null {
  return typeof raw === "number" && isValidLimitNumber(raw, definition) ? raw : null;
}

function expectedLimitValue(definition: LimitDefinition): string {
  return `${definition.positive ? "positive" : "non-negative"} safe integer${definition.maxValue === undefined ? "" : ` at most ${definition.maxValue}`}`;
}

export function getSubagentLimitConfigPaths(options: { agentDir: string; cwd: string; configDirName: string }): {
  globalPath: string;
  projectPath: string;
} {
  return {
    globalPath: path.join(options.agentDir, SUBAGENT_CONFIG_FILENAME),
    projectPath: path.join(options.cwd, options.configDirName, SUBAGENT_CONFIG_FILENAME),
  };
}

async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<string | null> {
  let initialStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    initialStat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!initialStat.isFile() || initialStat.isSymbolicLink()) throw new Error("must be a regular non-symlink file");
  if (initialStat.size > maxBytes) throw new Error(`exceeds ${maxBytes} byte limit`);

  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.dev !== initialStat.dev || openedStat.ino !== initialStat.ino) {
      throw new Error("changed while being opened or is not a regular file");
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`exceeds ${maxBytes} byte limit`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Reads one optional JSON source. Failures are warnings so lower-precedence sources still apply. */
export async function loadSubagentLimitConfigFile(
  filePath: string,
  options: { warn?: (message: string) => void; maxBytes?: number } = {},
): Promise<SubagentLimitConfig> {
  const warn = options.warn ?? console.warn;
  let text: string | null;
  try {
    text = await readBoundedRegularFile(filePath, options.maxBytes ?? MAX_SUBAGENT_CONFIG_BYTES);
  } catch (error) {
    warn(`[pi-subagent] Ignoring config file ${filePath}: ${error instanceof Error ? error.message : String(error)}.`);
    return {};
  }
  if (text === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    warn(`[pi-subagent] Ignoring malformed JSON in ${filePath}: ${error instanceof Error ? error.message : String(error)}.`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warn(`[pi-subagent] Ignoring config file ${filePath}: expected a JSON object.`);
    return {};
  }

  const source = parsed as Record<string, unknown>;
  const config: SubagentLimitConfig = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === "$schema") {
      if (typeof value === "string") config.$schema = value;
      else warn(`[pi-subagent] Ignoring invalid $schema in ${filePath}: expected a string.`);
      continue;
    }
    if (!(key in SUBAGENT_LIMIT_DEFINITIONS)) {
      warn(`[pi-subagent] Ignoring unknown config key "${key}" in ${filePath}.`);
      continue;
    }
    const name = key as LimitName;
    const definition = SUBAGENT_LIMIT_DEFINITIONS[name];
    const limit = parseConfigLimitValue(value, definition);
    if (limit === null) {
      warn(`[pi-subagent] Ignoring invalid ${key} in ${filePath}. Expected a ${expectedLimitValue(definition)} JSON number.`);
      continue;
    }
    config[name] = limit;
  }
  return config;
}

export async function loadSubagentLimitConfigSources(options: {
  agentDir: string;
  cwd: string;
  configDirName: string;
  projectTrusted: boolean;
  warn?: (message: string) => void;
}): Promise<{ globalConfig: SubagentLimitConfig; projectConfig: SubagentLimitConfig; globalPath: string; projectPath: string }> {
  const { globalPath, projectPath } = getSubagentLimitConfigPaths(options);
  const globalConfig = await loadSubagentLimitConfigFile(globalPath, options);
  let projectConfig: SubagentLimitConfig = {};
  if (options.projectTrusted) {
    try {
      const canonicalRoot = await fs.realpath(options.cwd);
      let canonicalParent: string;
      try { canonicalParent = await fs.realpath(path.dirname(projectPath)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; canonicalParent = ""; }
      if (canonicalParent) {
        const relative = path.relative(canonicalRoot, canonicalParent);
        if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
          projectConfig = await loadSubagentLimitConfigFile(path.join(canonicalParent, path.basename(projectPath)), options);
        } else {
          (options.warn ?? console.warn)(`[pi-subagent] Ignoring project config ${projectPath}: canonical path escapes the trusted project.`);
        }
      }
    } catch (error) {
      (options.warn ?? console.warn)(`[pi-subagent] Ignoring project config ${projectPath}: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
  return { globalConfig, projectConfig, globalPath, projectPath };
}

export async function resolveSubagentLimitsForSession(options: {
  agentDir: string;
  cwd: string;
  configDirName: string;
  projectTrusted: boolean;
  env?: NodeJS.ProcessEnv;
  getFlag?: (name: string) => unknown;
  warn?: (message: string) => void;
}): Promise<SubagentLimits> {
  const sources = await loadSubagentLimitConfigSources(options);
  return resolveSubagentLimits({ env: options.env, getFlag: options.getFlag, warn: options.warn, ...sources });
}

export function resolveSubagentLimits(options: {
  env?: NodeJS.ProcessEnv;
  getFlag?: (name: string) => unknown;
  globalConfig?: SubagentLimitConfig;
  projectConfig?: SubagentLimitConfig;
  warn?: (message: string) => void;
} = {}): SubagentLimits {
  const env = options.env ?? process.env;
  const warn = options.warn ?? console.warn;
  const resolved = {} as SubagentLimits;

  for (const [name, definition] of Object.entries(SUBAGENT_LIMIT_DEFINITIONS) as Array<[LimitName, LimitDefinition]>) {
    const expected = expectedLimitValue(definition);
    const flagValue = options.getFlag?.(definition.flag);
    const parsedFlag = parseLimitValue(flagValue, definition.positive, definition.maxValue);
    if (flagValue !== undefined && flagValue !== null && parsedFlag === null) {
      warn(`[pi-subagent] Ignoring invalid --${definition.flag} value "${String(flagValue)}". Expected a ${expected}.`);
    }
    if (parsedFlag !== null) {
      resolved[name] = parsedFlag;
      continue;
    }

    const envValue = env[definition.env];
    const parsedEnv = parseLimitValue(envValue, definition.positive, definition.maxValue);
    if (envValue !== undefined && parsedEnv === null) {
      warn(`[pi-subagent] Ignoring invalid ${definition.env}="${envValue}". Expected a ${expected}.`);
    }
    if (parsedEnv !== null) {
      resolved[name] = parsedEnv;
      continue;
    }

    const projectValue = options.projectConfig?.[name];
    if (projectValue !== undefined) {
      const parsedProject = parseConfigLimitValue(projectValue, definition);
      if (parsedProject !== null) {
        resolved[name] = parsedProject;
        continue;
      }
      warn(`[pi-subagent] Ignoring invalid ${name} in project config. Expected a ${expected} JSON number.`);
    }

    const globalValue = options.globalConfig?.[name];
    if (globalValue !== undefined) {
      const parsedGlobal = parseConfigLimitValue(globalValue, definition);
      if (parsedGlobal !== null) {
        resolved[name] = parsedGlobal;
        continue;
      }
      warn(`[pi-subagent] Ignoring invalid ${name} in global config. Expected a ${expected} JSON number.`);
    }
    resolved[name] = DEFAULT_SUBAGENT_LIMITS[name];
  }
  return resolved;
}

export function subagentLimitsToEnv(limits: SubagentLimits): Record<string, string> {
  return Object.fromEntries(
    (Object.entries(SUBAGENT_LIMIT_DEFINITIONS) as Array<[LimitName, LimitDefinition]>).map(([name, definition]) => [definition.env, String(limits[name])]),
  );
}
