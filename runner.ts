/**
 * Subagent process runner.
 *
 * Spawns isolated `pi` processes and streams results back via callbacks.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  getAmbiguousInheritedCliApiKeyMessage,
  getProviderFromModelSpecifier,
  resolveInheritedCliApiKeyEnvBinding,
  type InheritedCliApiKeyEnvBinding,
  type InheritedCliAuthContext,
} from "./provider-auth.js";
import type { AgentConfig } from "./agents.js";
import { parseInheritedCliArgs } from "./runner-cli.js";
import { createJsonLineChunkProcessor, monitorZellijPaneLifecycle } from "./runner-core.js";
import { processPiJsonLine } from "./runner-events.js";
import { isTrustedProjectAgentsDirWithSessionOverrides } from "./project-trust.js";
import {
  type DelegationMode,
  type SingleResult,
  type SubagentDetails,
  type TerminalMode,
  emptyUsage,
  getFinalOutput,
  isInsideZellij,
  normalizeCompletedResult,
} from "./types.js";
import { canonicalizePathForTrust } from "./trust-path.js";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const POLL_INTERVAL_MS = 100;
const ABORT_WAIT_MS = 3000;
const ZELLIJ_SECRET_ENV_DIR_JANITOR_DELAY_SECONDS = 5;
const ZELLIJ_PRESERVED_ARTIFACT_JANITOR_DELAY_SECONDS = 24 * 60 * 60;
const SUBAGENT_DEPTH_ENV = "PI_SUBAGENT_DEPTH";
const SUBAGENT_MAX_DEPTH_ENV = "PI_SUBAGENT_MAX_DEPTH";
const SUBAGENT_STACK_ENV = "PI_SUBAGENT_STACK";
const SUBAGENT_PREVENT_CYCLES_ENV = "PI_SUBAGENT_PREVENT_CYCLES";
const SUBAGENT_TRUSTED_PROJECTS_ENV = "PI_SUBAGENT_TRUSTED_PROJECTS";
const SUBAGENT_DENIED_PROJECTS_ENV = "PI_SUBAGENT_DENIED_PROJECTS";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const SUBAGENT_ORIGINAL_AGENT_DIR_ENV = "PI_SUBAGENT_ORIGINAL_AGENT_DIR";
const SUBAGENT_INHERITED_API_KEY_ENV = "PI_SUBAGENT_INHERITED_API_KEY";
const PI_OFFLINE_ENV = "PI_OFFLINE";
const PANE_RENDERER_PATH = fileURLToPath(new URL("./pane-renderer.js", import.meta.url));

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Derive the spawn command from the current process context so child invocations
 * work on Unix and Windows without going through a shell wrapper.
 */
function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1]) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }
  return { command: process.execPath, prefixArgs: [] };
}

function resolveJsRuntimeCommand(): string {
  const candidates = [process.execPath, process.argv0];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /(^|[\\/])(node|bun)(?:\.exe)?$/i.test(candidate)) {
      return candidate;
    }
  }
  return "node";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildShellCommand(argv: string[]): string {
  return argv.map((arg) => shellQuote(arg)).join(" ");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch {
    return "";
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await fileExists(filePath)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

export async function createNamedPipe(filePath: string, signal?: AbortSignal): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    // ignore
  }
  const result = await runCommandCapture("mkfifo", [filePath], { signal });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `Failed to create FIFO at ${filePath}`);
  }
}

export function startJsonlPipeConsumer(
  filePath: string,
  onLine: (line: string) => void,
): { completed: Promise<void>; close: () => void } {
  const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const completed = new Promise<void>((resolve, reject) => {
    rl.on("line", onLine);
    rl.once("close", resolve);
    rl.once("error", reject);
    stream.once("error", reject);
  });
  return {
    completed,
    close: () => {
      rl.close();
      stream.destroy();
    },
  };
}

interface ZellijPaneDescriptor {
  id: string;
  rawId: number | string;
  isFocused?: boolean;
  isSelectable?: boolean;
  exited?: boolean;
  exitStatus?: number | null;
}

function normalizePaneId(raw: unknown, isPlugin = false): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return `${isPlugin ? "plugin" : "terminal"}_${raw}`;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^(terminal|plugin)_\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `${isPlugin ? "plugin" : "terminal"}_${trimmed}`;
  return trimmed;
}

function normalizeCreatedPaneId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^(terminal|plugin)_\d+$/.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) return `terminal_${trimmed}`;
  return null;
}

function parseZellijPaneList(json: string): ZellijPaneDescriptor[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const panes: ZellijPaneDescriptor[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawId = record["id"];
    const paneId = normalizePaneId(rawId, Boolean(record["is_plugin"]));
    if (!paneId) continue;
    panes.push({
      id: paneId,
      rawId: rawId as number | string,
      isFocused:
        record["is_focused"] === true ||
        record["focused"] === true ||
        record["isFocused"] === true,
      isSelectable:
        record["is_selectable"] === true ||
        record["selectable"] === true ||
        record["isSelectable"] === true,
      exited: record["exited"] === true,
      exitStatus:
        typeof record["exit_status"] === "number"
          ? (record["exit_status"] as number)
          : null,
    });
  }
  return panes;
}

export async function runCommandCapture(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string; signalCode: NodeJS.Signals | null; aborted: boolean }> {
  return await new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    let abortHandler: (() => void) | undefined;

    const finish = (exitCode: number, signalCode: NodeJS.Signals | null = null) => {
      if (settled) return;
      settled = true;
      if (options.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      resolve({ exitCode, stdout, stderr, signalCode, aborted });
    };

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => {
      if (!stderr.trim()) stderr = err.message;
      finish(1);
    });
    proc.on("close", (code, signalCode) => finish(code ?? 0, signalCode ?? null));

    if (options.signal) {
      abortHandler = () => {
        if (settled) return;
        aborted = true;
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.unref();
          }
          return;
        }
        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!settled) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };
      if (options.signal.aborted) abortHandler();
      else options.signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

async function getFocusedPaneId(signal?: AbortSignal): Promise<string | null> {
  const result = await runCommandCapture(
    "zellij",
    ["action", "list-panes", "--json", "--all"],
    { signal },
  );
  if (result.exitCode !== 0) return null;
  const panes = parseZellijPaneList(result.stdout);
  return panes.find((pane) => pane.isFocused && pane.isSelectable !== false)?.id ?? null;
}

async function focusPaneId(paneId: string, signal?: AbortSignal): Promise<void> {
  await runCommandCapture("zellij", ["action", "focus-pane-id", paneId], { signal });
}

async function closePaneId(paneId: string, signal?: AbortSignal): Promise<boolean> {
  const result = await runCommandCapture("zellij", ["action", "close-pane", "--pane-id", paneId], { signal });
  return result.exitCode === 0;
}

async function getPaneInfoById(paneId: string, signal?: AbortSignal): Promise<ZellijPaneDescriptor | null | undefined> {
  const result = await runCommandCapture(
    "zellij",
    ["action", "list-panes", "--json", "--all"],
    { signal },
  );
  if (result.exitCode !== 0) return undefined;
  return parseZellijPaneList(result.stdout).find((pane) => pane.id === paneId) ?? null;
}

function getDefaultZellijPaneName(result: Pick<SingleResult, "agent" | "stageLabel">): string {
  if (result.stageLabel) return `${result.stageLabel}(${result.agent})`;
  return `subagent-${result.agent}`;
}

function applyPaneTitleSuffix(baseName: string, suffix?: string): string {
  return suffix ? `${baseName} ${suffix}` : baseName;
}

function buildZellijNewPaneArgs(
  commandArgs: string[],
  taskCwd: string,
  paneName: string,
): string[] {
  return ["action", "new-pane", "--name", paneName, "--cwd", taskCwd, "--", ...commandArgs];
}

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function writeForkSessionToTempFile(
  agentName: string,
  sessionJsonl: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `fork-${safeName}.jsonl`);
  fs.writeFileSync(filePath, sessionJsonl, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function writeTaskToTempFile(
  agentName: string,
  task: string,
): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `task-${safeName}.md`);
  fs.writeFileSync(filePath, `Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function scheduleDelayedTempDirCleanup(
  dir: string | null,
  options: {
    delaySeconds?: number;
    spawnDetached?: typeof spawn;
    label?: string;
  } = {},
): "skipped" | "scheduled" | "timer" {
  if (!dir) return "skipped";

  const delaySeconds = Math.max(0, Math.floor(options.delaySeconds ?? ZELLIJ_SECRET_ENV_DIR_JANITOR_DELAY_SECONDS));
  const spawnDetached = options.spawnDetached ?? spawn;

  try {
    const janitor = spawnDetached(
      "sh",
      [
        "-c",
        'sleep "$1"; rmdir "$2" 2>/dev/null || rm -rf "$2" 2>/dev/null || true',
        options.label ?? "pi-subagent-temp-dir-janitor",
        String(delaySeconds),
        dir,
      ],
      {
        detached: true,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    janitor.unref();
    return "scheduled";
  } catch {
    const timer = setTimeout(() => cleanupTempDir(dir), delaySeconds * 1000);
    timer.unref?.();
    return "timer";
  }
}

export function scheduleDelayedInheritedApiKeyEnvDirCleanup(
  dir: string | null,
  options: {
    delaySeconds?: number;
    spawnDetached?: typeof spawn;
  } = {},
): "skipped" | "scheduled" | "timer" {
  return scheduleDelayedTempDirCleanup(dir, {
    ...options,
    label: "pi-subagent-env-dir-janitor",
  });
}

export function cleanupZellijTempArtifacts(opts: {
  wrapperDir: string | null;
  logDir: string | null;
  inheritedApiKeyEnvDir?: string | null;
  inputTempDirs?: string[];
  preservedInputTempDirs?: string[];
  preserveTempArtifacts: boolean;
  scheduleInheritedApiKeyEnvDirCleanup?: (dir: string | null) => unknown;
  schedulePreservedArtifactDirCleanup?: (dir: string | null) => unknown;
}): void {
  if (opts.preserveTempArtifacts) {
    const scheduleSecretCleanup = opts.scheduleInheritedApiKeyEnvDirCleanup ?? scheduleDelayedInheritedApiKeyEnvDirCleanup;
    const scheduleArtifactCleanup = opts.schedulePreservedArtifactDirCleanup ?? ((dir: string | null) =>
      scheduleDelayedTempDirCleanup(dir, {
        delaySeconds: ZELLIJ_PRESERVED_ARTIFACT_JANITOR_DELAY_SECONDS,
        label: "pi-subagent-preserved-artifact-janitor",
      }));
    scheduleSecretCleanup(opts.inheritedApiKeyEnvDir ?? null);
    for (const dir of opts.inputTempDirs ?? []) scheduleArtifactCleanup(dir);
    for (const dir of opts.preservedInputTempDirs ?? []) scheduleArtifactCleanup(dir);
    scheduleArtifactCleanup(opts.wrapperDir);
    scheduleArtifactCleanup(opts.logDir);
    return;
  }

  cleanupTempDir(opts.inheritedApiKeyEnvDir ?? null);
  for (const dir of opts.inputTempDirs ?? []) cleanupTempDir(dir);
  for (const dir of opts.preservedInputTempDirs ?? []) cleanupTempDir(dir);
  cleanupTempDir(opts.wrapperDir);
  cleanupTempDir(opts.logDir);
}

// ---------------------------------------------------------------------------
// Build pi CLI arguments
// ---------------------------------------------------------------------------

const inheritedCliArgs = parseInheritedCliArgs(process.argv);

function findNearestProjectAgentsDirForRunner(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // ignore
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function getProjectRootForCwd(cwd: string): string | null {
  const projectAgentsDir = findNearestProjectAgentsDirForRunner(cwd);
  return projectAgentsDir ? canonicalizePathForTrust(path.dirname(path.dirname(projectAgentsDir))) : null;
}

function buildPropagatedSubagentEnv(opts: {
  agentName: string;
  parentDepth: number;
  parentAgentStack: string[];
  maxDepth: number;
  preventCycles: boolean;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
}): Record<string, string> {
  const trustedProjectsEnv = JSON.stringify(opts.trustedProjectRoots ?? []);
  const deniedProjectsEnv = JSON.stringify(opts.deniedProjectRoots ?? []);
  const nextDepth = Math.max(0, Math.floor(opts.parentDepth)) + 1;
  const propagatedMaxDepth = Math.max(0, Math.floor(opts.maxDepth));
  const propagatedStack = [...opts.parentAgentStack, opts.agentName];

  return {
    [SUBAGENT_DEPTH_ENV]: String(nextDepth),
    [SUBAGENT_MAX_DEPTH_ENV]: String(propagatedMaxDepth),
    [SUBAGENT_STACK_ENV]: JSON.stringify(propagatedStack),
    [SUBAGENT_PREVENT_CYCLES_ENV]: opts.preventCycles ? "1" : "0",
    [SUBAGENT_TRUSTED_PROJECTS_ENV]: trustedProjectsEnv,
    [SUBAGENT_DENIED_PROJECTS_ENV]: deniedProjectsEnv,
    [PI_OFFLINE_ENV]: "1",
  };
}

export function resolveInheritedCliApiKeyForChild(
  inheritedCliArgs: InheritedCliAuthContext,
  agent?: Pick<AgentConfig, "source" | "model">,
  options: { projectAgentTrusted?: boolean } = {},
): { inheritedApiKeyBinding: InheritedCliApiKeyEnvBinding | null; warningMessage: string | null } {
  const parentExplicitProvider = inheritedCliArgs.provider?.trim().toLowerCase() || null;
  const parentModelProvider = getProviderFromModelSpecifier(inheritedCliArgs.fallbackModel);
  const parentAuthoritativeProvider = parentExplicitProvider ?? parentModelProvider;
  const parentHasAuthoritativeProviderHint = Boolean(parentAuthoritativeProvider);
  const agentModelProvider = getProviderFromModelSpecifier(agent?.model);
  if (inheritedCliArgs.apiKey?.trim() && parentExplicitProvider && parentModelProvider && parentExplicitProvider !== parentModelProvider) {
    return {
      inheritedApiKeyBinding: null,
      warningMessage: `Inherited CLI --api-key was not propagated because the parent provider hint (${parentExplicitProvider}) conflicts with the parent model provider (${parentModelProvider}). Use provider-specific environment variables or align the parent provider and model.`,
    };
  }
  if (inheritedCliArgs.apiKey?.trim() && parentAuthoritativeProvider && agentModelProvider && parentAuthoritativeProvider !== agentModelProvider) {
    return {
      inheritedApiKeyBinding: null,
      warningMessage: `Inherited CLI --api-key was not propagated because the parent provider hint (${parentAuthoritativeProvider}) conflicts with the child model provider (${agentModelProvider}). Use provider-specific environment variables or align the parent provider/model with the subagent model.`,
    };
  }
  const canUseAgentModelProvider =
    !parentHasAuthoritativeProviderHint &&
    agentModelProvider &&
    (
      agent?.source === "user" ||
      (agent?.source === "project" && options.projectAgentTrusted === true)
    )
      ? agentModelProvider
      : null;
  const providerHintModel =
    agent?.source === "user" &&
    !agentModelProvider &&
    !parentHasAuthoritativeProviderHint
      ? agent.model
      : undefined;

  const resolution = resolveInheritedCliApiKeyEnvBinding({
    ...inheritedCliArgs,
    provider: parentExplicitProvider ?? inheritedCliArgs.provider ?? canUseAgentModelProvider ?? undefined,
    providerHintModel,
  });
  if (resolution.state === "ambiguous") {
    return {
      inheritedApiKeyBinding: null,
      warningMessage: getAmbiguousInheritedCliApiKeyMessage(resolution),
    };
  }

  return {
    inheritedApiKeyBinding: resolution.state === "resolved" ? resolution.binding : null,
    warningMessage: null,
  };
}

function getDefaultPiAgentDir(baseEnv: NodeJS.ProcessEnv = process.env): string {
  return baseEnv[PI_AGENT_DIR_ENV] || path.join(os.homedir(), ".pi", "agent");
}

export function prepareInheritedApiKeyAgentDir(
  binding: InheritedCliApiKeyEnvBinding | null | undefined,
  options: {
    baseEnv?: NodeJS.ProcessEnv;
    mkdtempSync?: (prefix: string) => string;
    readdirSync?: typeof fs.readdirSync;
    symlinkSync?: typeof fs.symlinkSync;
    writeFileSync?: typeof fs.writeFileSync;
  } = {},
): string | null {
  if (!binding) return null;
  const baseEnv = options.baseEnv ?? process.env;
  const sourceAgentDir = baseEnv[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] || getDefaultPiAgentDir(baseEnv);
  const mkdtempSync = options.mkdtempSync ?? fs.mkdtempSync;
  const readdirSync = options.readdirSync ?? fs.readdirSync;
  const symlinkSync = options.symlinkSync ?? fs.symlinkSync;
  const writeFileSync = options.writeFileSync ?? fs.writeFileSync;
  const overlayDir = mkdtempSync(path.join(os.tmpdir(), "pi-subagent-agent-"));

  try {
    for (const entry of readdirSync(sourceAgentDir, { withFileTypes: true })) {
      if (entry.name === "auth.json") continue;
      symlinkSync(path.join(sourceAgentDir, entry.name), path.join(overlayDir, entry.name));
    }
  } catch {
    // Missing/unreadable agent dirs are acceptable; the child will see an
    // otherwise empty agent dir with just the inherited auth override.
  }

  try {
    const auth: Record<string, unknown> = {
      [binding.provider]: { type: "api_key", key: `$${SUBAGENT_INHERITED_API_KEY_ENV}` },
    };
    writeFileSync(path.join(overlayDir, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    return overlayDir;
  } catch (error) {
    cleanupTempDir(overlayDir);
    throw error;
  }
}

export function buildChildProcessEnv(opts: {
  agentName: string;
  parentDepth: number;
  parentAgentStack: string[];
  maxDepth: number;
  preventCycles: boolean;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
  inheritedApiKeyBinding?: InheritedCliApiKeyEnvBinding | null;
  inheritedApiKeyAgentDir?: string | null;
  baseEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(opts.baseEnv ?? process.env),
    ...buildPropagatedSubagentEnv(opts),
  };

  if (opts.inheritedApiKeyAgentDir) {
    env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] = env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] || getDefaultPiAgentDir(opts.baseEnv ?? process.env);
    env[PI_AGENT_DIR_ENV] = opts.inheritedApiKeyAgentDir;
    if (opts.inheritedApiKeyBinding) env[SUBAGENT_INHERITED_API_KEY_ENV] = opts.inheritedApiKeyBinding.value;
  } else {
    delete env[SUBAGENT_INHERITED_API_KEY_ENV];
    if (env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV]) {
      env[PI_AGENT_DIR_ENV] = env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV];
      delete env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV];
    } else if (opts.inheritedApiKeyBinding) {
      env[opts.inheritedApiKeyBinding.name] = opts.inheritedApiKeyBinding.value;
    }
  }

  return env;
}

export function buildZellijWrapperScript(opts: {
  propagatedEnv: Record<string, string>;
  inheritedApiKeyEnvFilePath?: string | null;
  paneDisplayName: string;
  isNested: boolean;
  isFork: boolean;
  effectiveCwd: string;
  task: string;
  childCommand: string[];
  stderrLogPath: string;
  stdoutPipePath: string;
  statusPath: string;
  cleanupDirs?: string[];
}): string {
  return [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    ...(opts.cleanupDirs?.length
      ? [
          "cleanup_subagent_temp() {",
          ...opts.cleanupDirs.map((dir) => `  rm -rf ${shellQuote(dir)} 2>/dev/null || true`),
          "}",
          "trap cleanup_subagent_temp EXIT",
        ]
      : []),
    ...(opts.inheritedApiKeyEnvFilePath
      ? [
          `. ${shellQuote(opts.inheritedApiKeyEnvFilePath)}`,
          `rm -f ${shellQuote(opts.inheritedApiKeyEnvFilePath)}`,
        ]
      : []),
    ...Object.entries(opts.propagatedEnv).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    `printf '%s\\n' ${shellQuote(`Subagent pane: ${opts.paneDisplayName}`)}`,
    `printf '%s\\n' ${shellQuote(`Mode: ${opts.isNested ? "nested" : "root"} / ${opts.isFork ? "fork" : "spawn"}`)}`,
    `printf '%s\\n' ${shellQuote(`CWD: ${opts.effectiveCwd}`)}`,
    `printf '%s\\n' 'Task: provided via temporary prompt file'`,
    `printf '%s\\n' '---'`,
    `printf '%s\\n' 'Live output bridge ready'`,
    `${buildShellCommand(opts.childCommand)} 2> >(tee -a ${shellQuote(opts.stderrLogPath)} >&2) | ${buildShellCommand([resolveJsRuntimeCommand(), PANE_RENDERER_PATH, opts.stdoutPipePath])}`,
    "status=$?",
    `printf '\\nSubagent exited with status %s\\n' \"$status\"`,
    `printf '%s\n' \"$status\" > ${shellQuote(opts.statusPath)}`,
    "exit \"$status\"",
    "",
  ].filter((line): line is string => line !== null).join("\n");
}

interface PreparedZellijTempArtifacts {
  logDir: string;
  stdoutPipePath: string;
  stderrLogPath: string;
  statusPath: string;
  wrapperTmp: { dir: string; filePath: string };
  inheritedApiKeyEnvDir: string | null;
  inheritedApiKeyEnvFilePath: string | null;
}

export function prepareZellijTempArtifacts(opts: {
  agentName: string;
  inheritedApiKeyBinding?: InheritedCliApiKeyEnvBinding | null;
  buildWrapperScript: (paths: {
    stdoutPipePath: string;
    stderrLogPath: string;
    statusPath: string;
    inheritedApiKeyEnvFilePath: string | null;
  }) => string;
  tempRootDir?: string;
  mkdtempSync?: (prefix: string) => string;
  writeFileSync?: (filePath: string, contents: string, options: { encoding: BufferEncoding; mode: number }) => void;
}): PreparedZellijTempArtifacts {
  const mkdtempSync = opts.mkdtempSync ?? fs.mkdtempSync;
  const writeFileSync = opts.writeFileSync ?? ((filePath, contents, options) => {
    fs.writeFileSync(filePath, contents, options);
  });
  const safeName = opts.agentName.replace(/[^\w.-]+/g, "_");
  const tmpPrefix = path.join(opts.tempRootDir ?? os.tmpdir(), "pi-subagent-");

  let logDir: string | null = null;
  let wrapperDir: string | null = null;
  let inheritedApiKeyEnvDir: string | null = null;

  try {
    logDir = mkdtempSync(tmpPrefix);
    const stdoutPipePath = path.join(logDir, `stdout-${safeName}.pipe`);
    const stderrLogPath = path.join(logDir, `stderr-${safeName}.log`);
    const statusPath = path.join(logDir, `status-${safeName}.txt`);

    wrapperDir = mkdtempSync(tmpPrefix);
    const wrapperPath = path.join(wrapperDir, `zellij-wrapper-${safeName}.sh`);

    inheritedApiKeyEnvDir = opts.inheritedApiKeyBinding ? mkdtempSync(tmpPrefix) : null;
    const inheritedApiKeyEnvFilePath = opts.inheritedApiKeyBinding && inheritedApiKeyEnvDir
      ? path.join(inheritedApiKeyEnvDir, `zellij-env-${safeName}.sh`)
      : null;
    if (opts.inheritedApiKeyBinding && inheritedApiKeyEnvFilePath) {
      writeFileSync(
        inheritedApiKeyEnvFilePath,
        `export ${SUBAGENT_INHERITED_API_KEY_ENV}=${shellQuote(opts.inheritedApiKeyBinding.value)}\n`,
        { encoding: "utf-8", mode: 0o600 },
      );
    }

    writeFileSync(
      wrapperPath,
      opts.buildWrapperScript({
        stdoutPipePath,
        stderrLogPath,
        statusPath,
        inheritedApiKeyEnvFilePath,
      }),
      { encoding: "utf-8", mode: 0o700 },
    );

    if (!logDir || !wrapperDir) {
      throw new Error("Failed to prepare Zellij temp artifacts.");
    }

    return {
      logDir,
      stdoutPipePath,
      stderrLogPath,
      statusPath,
      wrapperTmp: { dir: wrapperDir, filePath: wrapperPath },
      inheritedApiKeyEnvDir,
      inheritedApiKeyEnvFilePath,
    };
  } catch (error) {
    cleanupZellijTempArtifacts({
      wrapperDir,
      logDir,
      inheritedApiKeyEnvDir,
      preserveTempArtifacts: false,
    });
    throw error;
  }
}

function stripFlagWithValue(argv: string[], flagName: string): string[] {
  const filtered: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flagName) {
      i += 1;
      continue;
    }
    filtered.push(argv[i]!);
  }
  return filtered;
}

export function getInheritedCliArgsForAgent(
  agent: Pick<AgentConfig, "source" | "model">,
  alwaysProxy: string[] = inheritedCliArgs.alwaysProxy,
  fallbackModel: string | undefined = inheritedCliArgs.fallbackModel,
): string[] {
  if (!getProviderFromModelSpecifier(agent.model ?? fallbackModel)) return alwaysProxy;
  return stripFlagWithValue(alwaysProxy, "--provider");
}

export function buildPiArgs(
  agent: AgentConfig,
  systemPromptPath: string | null,
  taskFilePath: string,
  delegationMode: DelegationMode,
  forkSessionPath: string | null,
): string[] {
  const args: string[] = [
    "--mode",
    "json",
    ...inheritedCliArgs.extensionArgs,
    ...getInheritedCliArgsForAgent(agent),
    "-p",
  ];

  if (delegationMode === "spawn") {
    args.push("--no-session");
  } else if (forkSessionPath) {
    args.push("--session", forkSessionPath);
  }

  const model = agent.model ?? inheritedCliArgs.fallbackModel;
  if (model) args.push("--model", model);

  const thinking = agent.thinking ?? inheritedCliArgs.fallbackThinking;
  if (thinking) args.push("--thinking", thinking);

  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  } else if (agent.tools === undefined) {
    if (inheritedCliArgs.fallbackTools !== undefined) {
      args.push("--tools", inheritedCliArgs.fallbackTools);
    } else if (inheritedCliArgs.fallbackNoTools) {
      args.push("--no-tools");
    }
  }

  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);
  args.push(`@${taskFilePath}`);
  return args;
}

function isProjectAgentExplicitlyTrusted(
  agent: Pick<AgentConfig, "source" | "filePath"> | undefined,
  trustedProjectRoots?: string[],
  deniedProjectRoots?: string[],
): boolean {
  if (!agent || agent.source !== "project") return false;
  return isTrustedProjectAgentsDirWithSessionOverrides(path.dirname(agent.filePath), {
    sessionTrustedProjectRoots: trustedProjectRoots,
    sessionDeniedProjectRoots: deniedProjectRoots,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunAgentOptions {
  /** Fallback working directory when the task doesn't specify one. */
  cwd: string;
  /** All available agent configs. */
  agents: AgentConfig[];
  /** Name of the agent to run. */
  agentName: string;
  /** Task description. */
  task: string;
  /** Optional chain stage label used for UI display. */
  stageLabel?: string;
  /** Optional override working directory. */
  taskCwd?: string;
  /** Context mode: spawn (fresh) or fork (session snapshot + task). */
  delegationMode: DelegationMode;
  /** Execution surface for child runs. */
  terminalMode: TerminalMode;
  /** Optional suffix appended to pane titles to disambiguate concurrent runs. */
  paneTitleSuffix?: string;
  /** Optional pane id to restore focus to after creating a Zellij pane. */
  restoreFocusPaneId?: string;
  /** Trusted project roots to propagate to child processes as temporary approvals. */
  trustedProjectRoots?: string[];
  /** Denied project roots to propagate to child processes as temporary denials. */
  deniedProjectRoots?: string[];
  /** Serialized parent session snapshot used when delegationMode is "fork". */
  forkSessionSnapshotJsonl?: string;
  /** Current delegation depth of the caller process. */
  parentDepth: number;
  /** Delegation stack from the caller process (ancestor agent names). */
  parentAgentStack: string[];
  /** Maximum allowed delegation depth to propagate to child processes. */
  maxDepth: number;
  /** Whether cycle prevention should be enforced in child processes. */
  preventCycles: boolean;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Streaming update callback. */
  onUpdate?: OnUpdateCallback;
  /** Factory to wrap results into SubagentDetails. */
  makeDetails: (results: SingleResult[]) => SubagentDetails;
}

/**
 * Spawn a single subagent process and collect its results.
 *
 * Returns a SingleResult even on failure (exitCode > 0, stderr populated).
 */
export async function runAgent(opts: RunAgentOptions): Promise<SingleResult> {
  const {
    cwd,
    agents,
    agentName,
    task,
    stageLabel,
    taskCwd,
    delegationMode,
    terminalMode,
    paneTitleSuffix,
    restoreFocusPaneId,
    trustedProjectRoots,
    deniedProjectRoots,
    forkSessionSnapshotJsonl,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    signal,
    onUpdate,
    makeDetails,
  } = opts;

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      stageLabel,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
      usage: emptyUsage(),
    };
  }

  if (
    delegationMode === "fork" &&
    (!forkSessionSnapshotJsonl || !forkSessionSnapshotJsonl.trim())
  ) {
    return {
      agent: agentName,
      agentSource: agent.source,
      task,
      stageLabel,
      exitCode: 1,
      messages: [],
      stderr:
        "Cannot run in fork mode: missing parent session snapshot context.",
      usage: emptyUsage(),
      model: agent.model,
      stopReason: "error",
      errorMessage:
        "Cannot run in fork mode: missing parent session snapshot context.",
    };
  }

  const result: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    stageLabel,
    exitCode: -1,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    model: agent.model,
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getFinalOutput(result.messages) || "(running...)",
        },
      ],
      details: makeDetails([result]),
    });
  };

  const { inheritedApiKeyBinding, warningMessage: inheritedApiKeyWarningMessage } =
    resolveInheritedCliApiKeyForChild(inheritedCliArgs, agent, {
      projectAgentTrusted: isProjectAgentExplicitlyTrusted(agent, trustedProjectRoots, deniedProjectRoots),
    });
  if (inheritedApiKeyWarningMessage) {
    console.warn(`[pi-subagent] ${inheritedApiKeyWarningMessage}`);
  }

  // Write system prompt to temp file if needed
  let promptTmpDir: string | null = null;
  let promptTmpPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
    promptTmpDir = tmp.dir;
    promptTmpPath = tmp.filePath;
  }

  // Write forked session snapshot if needed
  let forkSessionTmpDir: string | null = null;
  let forkSessionTmpPath: string | null = null;
  if (delegationMode === "fork" && forkSessionSnapshotJsonl) {
    const tmp = writeForkSessionToTempFile(agent.name, forkSessionSnapshotJsonl);
    forkSessionTmpDir = tmp.dir;
    forkSessionTmpPath = tmp.filePath;
  }

  // Keep delegated task text out of child process argv and Zellij wrapper scripts.
  const taskTmp = writeTaskToTempFile(agent.name, task);
  let inheritedApiKeyAgentDir: string | null = null;
  let zellijOwnsInputTempDirs = false;

  try {
    inheritedApiKeyAgentDir = prepareInheritedApiKeyAgentDir(inheritedApiKeyBinding);
    const piArgs = buildPiArgs(
      agent,
      promptTmpPath,
      taskTmp.filePath,
      delegationMode,
      forkSessionTmpPath,
    );
    const effectiveCwd = taskCwd ?? cwd;
    const effectiveProjectRoot = getProjectRootForCwd(effectiveCwd);
    const trustedForCwd = Boolean(effectiveProjectRoot && (trustedProjectRoots ?? []).some((trustedRoot) => canonicalizePathForTrust(trustedRoot) === effectiveProjectRoot));
    const deniedForCwd = Boolean(effectiveProjectRoot && (deniedProjectRoots ?? []).some((deniedRoot) => canonicalizePathForTrust(deniedRoot) === effectiveProjectRoot));
    if (trustedForCwd) piArgs.push("--approve");
    else if (deniedForCwd) piArgs.push("--no-approve");
    if (terminalMode === "zellij-pane") {
      zellijOwnsInputTempDirs = true;
      return await runAgentInZellijPane({
        result,
        cwd,
        taskCwd,
        piArgs,
        signal,
        onUpdate: emitUpdate,
        parentDepth,
        parentAgentStack,
        maxDepth,
        preventCycles,
        makeDetails,
        paneTitleSuffix,
        restoreFocusPaneId,
        trustedProjectRoots,
        deniedProjectRoots,
        inheritedApiKeyBinding,
        inheritedApiKeyAgentDir,
        inputTempDirs: [promptTmpDir, forkSessionTmpDir, taskTmp.dir].filter((dir): dir is string => Boolean(dir)),
        preservedInputTempDirs: [inheritedApiKeyAgentDir].filter((dir): dir is string => Boolean(dir)),
      });
    }
    return await runAgentInline({
      result,
      cwd,
      taskCwd,
      piArgs,
      signal,
      onUpdate: emitUpdate,
      parentDepth,
      parentAgentStack,
      maxDepth,
      preventCycles,
      trustedProjectRoots,
      deniedProjectRoots,
      makeDetails,
      inheritedApiKeyBinding,
      inheritedApiKeyAgentDir,
    });
  } finally {
    if (!zellijOwnsInputTempDirs) {
      cleanupTempDir(promptTmpDir);
      cleanupTempDir(forkSessionTmpDir);
      cleanupTempDir(taskTmp.dir);
      cleanupTempDir(inheritedApiKeyAgentDir);
    }
  }
}

interface RunAgentExecutionOptions {
  result: SingleResult;
  cwd: string;
  taskCwd?: string;
  piArgs: string[];
  signal?: AbortSignal;
  onUpdate: () => void;
  parentDepth: number;
  parentAgentStack: string[];
  maxDepth: number;
  preventCycles: boolean;
  trustedProjectRoots?: string[];
  deniedProjectRoots?: string[];
  inheritedApiKeyBinding?: InheritedCliApiKeyEnvBinding | null;
  inheritedApiKeyAgentDir?: string | null;
  makeDetails: (results: SingleResult[]) => SubagentDetails;
  inputTempDirs?: string[];
  preservedInputTempDirs?: string[];
}

export async function monitorInlineProcess(
  proc: ChildProcessWithoutNullStreams,
  result: SingleResult,
  signal: AbortSignal | undefined,
  onUpdate: () => void,
): Promise<{ exitCode: number; wasAborted: boolean }> {
  let wasAborted = false;
  const exitCode = await new Promise<number>((resolve) => {
    let didClose = false;
    let settled = false;
    let abortHandler: (() => void) | undefined;
    let semanticCompletionTimer: NodeJS.Timeout | undefined;

    const clearSemanticCompletionTimer = () => {
      if (semanticCompletionTimer) {
        clearTimeout(semanticCompletionTimer);
        semanticCompletionTimer = undefined;
      }
    };

    const terminateChild = () => {
      if (isWindows) {
        if (proc.pid !== undefined) {
          const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
            stdio: "ignore",
          });
          killer.unref();
        }
        return;
      }

      proc.kill("SIGTERM");
      const sigkillTimer = setTimeout(() => {
        if (!didClose) proc.kill("SIGKILL");
      }, SIGKILL_TIMEOUT_MS);
      sigkillTimer.unref();
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearSemanticCompletionTimer();
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
      resolve(code);
    };

    const flushLine = (line: string) => {
      if (processPiJsonLine(line, result)) onUpdate();
      maybeFinishFromAgentEnd();
    };

    const chunkProcessor = createJsonLineChunkProcessor(flushLine);

    const maybeFinishFromAgentEnd = () => {
      if (!result.sawAgentEnd || didClose || settled) return;
      clearSemanticCompletionTimer();
      semanticCompletionTimer = setTimeout(() => {
        if (didClose || settled || !result.sawAgentEnd) return;
        chunkProcessor.flushRemainder();
        proc.stdout.removeListener("data", onStdoutData);
        proc.stderr.removeListener("data", onStderrData);
        finish(0);
        terminateChild();
      }, AGENT_END_GRACE_MS);
      semanticCompletionTimer.unref();
    };

    const onStdoutData = (chunk: Buffer) => {
      chunkProcessor.pushChunk(chunk.toString());
    };

    const onStderrData = (chunk: Buffer) => {
      result.stderr += chunk.toString();
    };

    proc.stdout.on("data", onStdoutData);
    proc.stderr.on("data", onStderrData);

    proc.on("close", (code) => {
      didClose = true;
      chunkProcessor.flushRemainder();
      finish(code ?? 0);
    });

    proc.on("error", (err) => {
      if (!result.stderr.trim()) result.stderr = err.message;
      finish(1);
    });

    if (signal) {
      abortHandler = () => {
        if (didClose || settled) return;
        wasAborted = true;
        terminateChild();
      };
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }
  });

  return { exitCode, wasAborted };
}

async function runAgentInline(opts: RunAgentExecutionOptions): Promise<SingleResult> {
  const {
    result,
    cwd,
    taskCwd,
    piArgs,
    signal,
    onUpdate,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    trustedProjectRoots,
    deniedProjectRoots,
    inheritedApiKeyBinding,
    inheritedApiKeyAgentDir,
  } = opts;

  const { command, prefixArgs } = resolvePiSpawn();
  const proc = spawn(command, [...prefixArgs, ...piArgs], {
    cwd: taskCwd ?? cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: buildChildProcessEnv({
      agentName: result.agent,
      parentDepth,
      parentAgentStack,
      maxDepth,
      preventCycles,
      trustedProjectRoots,
      deniedProjectRoots,
      inheritedApiKeyBinding,
      inheritedApiKeyAgentDir,
    }),
  });

  proc.stdin.on("error", () => {
    /* ignore broken pipe on fast exits */
  });
  proc.stdin.end();

  const { exitCode, wasAborted } = await monitorInlineProcess(proc, result, signal, onUpdate);
  result.exitCode = exitCode;
  return normalizeCompletedResult(result, wasAborted);
}

interface RunAgentInZellijPaneOptions extends RunAgentExecutionOptions {
  paneTitleSuffix?: string;
  restoreFocusPaneId?: string;
}

async function runAgentInZellijPane(
  opts: RunAgentInZellijPaneOptions,
): Promise<SingleResult> {
  const {
    result,
    cwd,
    taskCwd,
    piArgs,
    signal,
    onUpdate,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    paneTitleSuffix,
    restoreFocusPaneId,
    trustedProjectRoots,
    deniedProjectRoots,
    inheritedApiKeyBinding,
    inheritedApiKeyAgentDir,
    inputTempDirs,
    preservedInputTempDirs,
  } = opts;

  if (!isInsideZellij()) {
    result.exitCode = 1;
    result.stopReason = "error";
    result.errorMessage = "Zellij pane mode requires running inside a Zellij session.";
    result.stderr = result.errorMessage;
    return result;
  }

  const effectiveCwd = taskCwd ?? cwd;
  const propagatedEnv = buildPropagatedSubagentEnv({
    agentName: result.agent,
    parentDepth,
    parentAgentStack,
    maxDepth,
    preventCycles,
    trustedProjectRoots,
    deniedProjectRoots,
  });
  const originalAgentDir = process.env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] || getDefaultPiAgentDir();
  if (inheritedApiKeyAgentDir) {
    propagatedEnv[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] = originalAgentDir;
    propagatedEnv[PI_AGENT_DIR_ENV] = inheritedApiKeyAgentDir;
  } else {
    propagatedEnv[SUBAGENT_INHERITED_API_KEY_ENV] = "";
    if (process.env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV]) {
      propagatedEnv[SUBAGENT_ORIGINAL_AGENT_DIR_ENV] = "";
      propagatedEnv[PI_AGENT_DIR_ENV] = process.env[SUBAGENT_ORIGINAL_AGENT_DIR_ENV]!;
    }
  }
  const { command: piCommand, prefixArgs } = resolvePiSpawn();
  const childCommand = [piCommand, ...prefixArgs, ...piArgs];
  const paneDisplayName = applyPaneTitleSuffix(
    getDefaultZellijPaneName(result),
    paneTitleSuffix,
  );

  let tempArtifacts: PreparedZellijTempArtifacts | null = null;

  let paneId: string | null = null;
  let focusedPaneId: string | null = null;
  let wasAborted = false;
  let manualExitError: string | null = null;
  let preserveTempArtifacts = false;
  let pipeConsumerError: string | null = null;
  let pipeSawData = false;
  let pipeConsumer: ReturnType<typeof startJsonlPipeConsumer> | null = null;

  const finalizeLogs = async (waitForPipeEof: boolean) => {
    if (pipeSawData && pipeConsumer) {
      if (waitForPipeEof) {
        await pipeConsumer.completed.catch(() => undefined);
      } else {
        await Promise.race([
          pipeConsumer.completed.catch(() => undefined),
          delay(500),
        ]);
      }
    }
    const stderrText = tempArtifacts ? await readFileIfExists(tempArtifacts.stderrLogPath) : "";
    if (stderrText.trim()) result.stderr = stderrText;
    if (pipeConsumerError && !result.stderr.trim()) result.stderr = pipeConsumerError;
  };

  try {
    try {
      tempArtifacts = prepareZellijTempArtifacts({
        agentName: result.agent,
        inheritedApiKeyBinding,
        buildWrapperScript: ({
          stdoutPipePath,
          stderrLogPath,
          statusPath,
          inheritedApiKeyEnvFilePath,
        }) => buildZellijWrapperScript({
          propagatedEnv,
          inheritedApiKeyEnvFilePath,
          paneDisplayName,
          isNested: parentAgentStack.length > 0,
          isFork: piArgs.includes("--session"),
          effectiveCwd,
          task: result.task,
          childCommand,
          stderrLogPath,
          stdoutPipePath,
          statusPath,
          cleanupDirs: [...(inputTempDirs ?? []), ...(preservedInputTempDirs ?? [])],
        }),
      });
      await createNamedPipe(tempArtifacts.stdoutPipePath, signal);
      pipeConsumer = startJsonlPipeConsumer(tempArtifacts.stdoutPipePath, (line) => {
        pipeSawData = true;
        if (processPiJsonLine(line, result)) onUpdate();
      });
      pipeConsumer.completed.catch((error) => {
        pipeConsumerError = error instanceof Error ? error.message : String(error);
      });
    } catch (error) {
      wasAborted = Boolean(signal?.aborted);
      result.exitCode = wasAborted ? 130 : 1;
      result.stopReason = wasAborted ? "aborted" : "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
      if (!result.stderr.trim()) result.stderr = result.errorMessage;
      return normalizeCompletedResult(result, wasAborted);
    }

    const zellijTempArtifacts = tempArtifacts;
    if (!zellijTempArtifacts) {
      result.exitCode = wasAborted ? 130 : 1;
      result.stopReason = wasAborted ? "aborted" : "error";
      result.errorMessage = "Failed to prepare Zellij temp artifacts.";
      if (!result.stderr.trim()) result.stderr = result.errorMessage;
      return normalizeCompletedResult(result, wasAborted);
    }

    focusedPaneId = restoreFocusPaneId ?? await getFocusedPaneId(signal);
    const paneCreate = await runCommandCapture(
      "zellij",
      buildZellijNewPaneArgs([zellijTempArtifacts.wrapperTmp.filePath], effectiveCwd, paneDisplayName),
      { cwd: effectiveCwd, signal },
    );

    if (paneCreate.aborted || signal?.aborted) {
      wasAborted = true;
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      if (!result.stderr.trim()) result.stderr = paneCreate.stderr.trim() || "Subagent was aborted.";
      return normalizeCompletedResult(result, true);
    }

    if (paneCreate.exitCode !== 0) {
      result.exitCode = paneCreate.exitCode || 1;
      result.stopReason = "error";
      result.stderr = paneCreate.stderr.trim() || paneCreate.stdout.trim() || "Failed to create Zellij pane.";
      result.errorMessage = result.stderr;
      return result;
    }

    paneId = normalizeCreatedPaneId(paneCreate.stdout);
    if (!paneId) {
      result.exitCode = 1;
      result.stopReason = "error";
      result.stderr = `Failed to parse created Zellij pane id from output: ${paneCreate.stdout.trim() || "(empty)"}`;
      result.errorMessage = result.stderr;
      return result;
    }

    if (focusedPaneId && focusedPaneId !== paneId) {
      await focusPaneId(focusedPaneId, signal);
    }

    const lifecycle = await monitorZellijPaneLifecycle({
      paneId: paneId ?? "(unknown)",
      signal,
      abortWaitMs: ABORT_WAIT_MS,
      pollIntervalMs: POLL_INTERVAL_MS,
      fileExists: () => fileExists(zellijTempArtifacts.statusPath),
      getPaneInfo: () => (paneId ? getPaneInfoById(paneId, signal?.aborted ? undefined : signal) : Promise.resolve(null)),
      closePane: async () => {
        if (!paneId) return true;
        return await closePaneId(paneId);
      },
      delay,
      maxQueryFailures: 50,
    });
    const statusSeen = lifecycle.statusSeen;
    wasAborted = lifecycle.wasAborted;
    manualExitError = lifecycle.manualExitError;
    if (typeof lifecycle.exitCode === "number") result.exitCode = lifecycle.exitCode;

    if (statusSeen) {
      await delay(AGENT_END_GRACE_MS);
      await finalizeLogs(true);
      if (pipeConsumerError) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.errorMessage = pipeConsumerError;
        if (!result.stderr.trim()) result.stderr = pipeConsumerError;
        return normalizeCompletedResult(result, wasAborted);
      }
      const statusText = (await readFileIfExists(zellijTempArtifacts.statusPath)).trim();
      const parsedExit = Number.parseInt(statusText, 10);
      if (!Number.isFinite(parsedExit)) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.errorMessage = `Zellij pane ${paneId ?? "(unknown)"} wrote an invalid subagent status.`;
        if (!result.stderr.trim()) result.stderr = result.errorMessage;
        return normalizeCompletedResult(result, wasAborted);
      }
      result.exitCode = parsedExit;
      return normalizeCompletedResult(result, wasAborted);
    }

    await finalizeLogs(false);
    if (manualExitError) {
      result.exitCode = result.exitCode > 0 ? result.exitCode : 1;
      result.stopReason = "error";
      result.errorMessage = manualExitError;
      if (!result.stderr.trim()) result.stderr = manualExitError;
      return normalizeCompletedResult(result, wasAborted);
    }
    result.exitCode = wasAborted ? 130 : 1;
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    pipeConsumer?.close();
    if (wasAborted && paneId) {
      const paneInfo = await getPaneInfoById(paneId);
      preserveTempArtifacts = Boolean(paneInfo && !paneInfo.exited);
    }
    cleanupZellijTempArtifacts({
      wrapperDir: tempArtifacts?.wrapperTmp.dir ?? null,
      logDir: tempArtifacts?.logDir ?? null,
      inheritedApiKeyEnvDir: tempArtifacts?.inheritedApiKeyEnvDir ?? null,
      inputTempDirs,
      preservedInputTempDirs,
      preserveTempArtifacts,
    });
  }
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

/**
 * Map over items with a bounded number of concurrent workers.
 */
export async function mapConcurrent<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
