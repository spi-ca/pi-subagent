import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildInteractiveExtensionArgs, buildManagedExtensionArgs, buildStoppedBootstrapArgv } from "../../src/runtime/runner.js";
import { classifyParentProcessIdentity, getProcessStartedAt, prepareRunArtifactPaths } from "../../src/runtime/run-protocol.js";
import {
  MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV,
  MANAGED_CHILD_BASE_MINIMUM_PI_VERSION,
  MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
  resolveManagedChildAcceptancePiGeneration,
  revalidateManagedChildPiExecutableGeneration,
  type ManagedChildPiExecutableGeneration,
} from "./managed-child-pi-executable.js";

if (process.env.PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE !== "1") {
  console.log(JSON.stringify({ mode: "managed-child", state: "not-run", reason: "PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE=1 required", foregroundUsagePersistence: false }));
  process.exit(0);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-subagent-managed-"));
const sentinelName = "inherited-sentinel";
const expectedActiveTools = ["read", "subagent"];
const liveNestedGate = process.env.PI_SUBAGENT_MANAGED_CHILD_LIVE_NESTED === "1";
const liveChildModel = "openai-codex/gpt-5.4-mini";
const liveTimeoutMs = 120_000;
const managedChildPiGeneration: ManagedChildPiExecutableGeneration = resolveManagedChildAcceptancePiGeneration({
  liveNested: liveNestedGate,
  executable: process.env[MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV],
  pathValue: process.env.PATH,
  baseMinimumVersion: MANAGED_CHILD_BASE_MINIMUM_PI_VERSION,
  liveMinimumVersion: MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION,
});
const managedChildPiExecutable = managedChildPiGeneration.executable;

type ToolProfile = { all: string[]; active: string[]; commands: string[] };
type ChildState = { runId?: string; phase?: string; lastEvent?: string };
type JsonRecord = Record<string, unknown>;

const usageBaseFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const sessionStatsFields = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const maxPrivateSessionBytes = 16 * 1024 * 1024;
const maxPrivateSessionEntries = 128;
const maxPrivateSessionDepth = 8;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function textContentEquals(value: unknown, expected: string): boolean {
  if (!Array.isArray(value)) return false;
  const blocks = value.map(asRecord);
  const text = blocks.filter((part): part is JsonRecord => part?.type === "text");
  return blocks.every((part) => part?.type === "text" || part?.type === "thinking")
    && text.length === 1 && text[0]!.text === expected;
}

function assertExactBaseUsage(actual: unknown, expected: unknown, label: string): JsonRecord {
  const actualUsage = asRecord(actual);
  const expectedUsage = asRecord(expected);
  if (!actualUsage || !expectedUsage) throw new Error(`${label} is missing usage.`);
  for (const field of usageBaseFields) {
    if (!Number.isSafeInteger(actualUsage[field]) || !Number.isSafeInteger(expectedUsage[field])
      || (actualUsage[field] as number) < 0 || (expectedUsage[field] as number) < 0
      || actualUsage[field] !== expectedUsage[field]) throw new Error(`${label} base usage does not exactly match.`);
  }
  return actualUsage;
}

function parseStrictLfJsonl(bytes: Buffer, label: string): JsonRecord[] {
  if (bytes.length > maxPrivateSessionBytes) throw new Error(`${label} exceeded its bounded size.`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  if (!text.endsWith("\n") || text.includes("\r")) throw new Error(`${label} is not strict LF JSONL.`);
  const records: JsonRecord[] = [];
  for (const line of text.slice(0, -1).split("\n")) {
    if (!line) throw new Error(`${label} contains an empty JSONL record.`);
    try {
      const parsed = asRecord(JSON.parse(line));
      if (!parsed) throw new Error("not an object");
      records.push(parsed);
    } catch {
      throw new Error(`${label} contains invalid JSONL.`);
    }
  }
  return records;
}

async function findPrivateSessionJsonl(sessionDir: string): Promise<{ path: string; entries: JsonRecord[] }> {
  const sessionPaths: string[] = [];
  let visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxPrivateSessionDepth) throw new Error("Private session directory exceeded its bounded shape.");
    for (const name of await fs.readdir(directory)) {
      if (++visited > maxPrivateSessionEntries) throw new Error("Private session directory exceeded its bounded shape.");
      const candidate = path.join(directory, name);
      const info = await fs.lstat(candidate);
      if (info.isSymbolicLink()) throw new Error("Private session directory contains a symbolic link.");
      if (info.isDirectory()) await visit(candidate, depth + 1);
      else if (info.isFile() && name.endsWith(".jsonl")) {
        if (info.size > maxPrivateSessionBytes) throw new Error("Private session JSONL exceeded its bounded size.");
        sessionPaths.push(candidate);
      }
    }
  };
  await visit(sessionDir, 0);
  if (sessionPaths.length !== 1) throw new Error("Private session directory did not contain exactly one session JSONL.");
  const sessionPath = sessionPaths[0]!;
  return { path: sessionPath, entries: parseStrictLfJsonl(await fs.readFile(sessionPath), "Private session JSONL") };
}

function assertPersistedForegroundUsage(entries: JsonRecord[], expectedUsage: JsonRecord): void {
  const messages = entries.map((entry) => asRecord(entry.message)).filter((message): message is JsonRecord => message !== null);
  const toolResults = messages.filter((message) => message.role === "toolResult");
  const subagentResults = toolResults.filter((message) => message.toolName === "subagent");
  if (toolResults.length !== 1 || subagentResults.length !== 1) {
    throw new Error("Private parent session did not persist exactly one subagent tool usage.");
  }
  assertExactBaseUsage(subagentResults[0]!.usage, expectedUsage, "Persisted parent subagent tool result");
  const parentAssistantMessages = messages.filter((message) => message.role === "assistant");
  if (parentAssistantMessages.length === 0) throw new Error("Private parent session did not persist scripted parent assistant messages.");
  for (const message of parentAssistantMessages) {
    assertExactBaseUsage(message.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, "Scripted parent assistant");
  }
}

const loaderEnvironmentNames = new Set([
  "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "DENO_DIR", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "BASH_ENV", "ENV",
  "SHELLOPTS", "BASHOPTS", "PS4", "PROMPT_COMMAND", "CDPATH", "GLOBIGNORE", "KSH_ENV", "ZDOTDIR", "FPATH", "INPUTRC",
]);
function sanitizedAcceptanceEnv(overrides: NodeJS.ProcessEnv, forceInline = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const credentialLike = /(?:^|_)(?:API_?KEY|TOKEN(?:_FILE)?|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i.test(name)
      || /^(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AWS_WEB_IDENTITY_TOKEN_FILE|AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(name);
    // A nested acceptance process must not inherit a caller's run authority:
    // protocol, lease, promotion, tree and Phase-0 variables are all scoped to
    // the parent run. Explicit overrides below are the complete child contract.
    if (!loaderEnvironmentNames.has(name) && !name.startsWith("BASH_FUNC_")
      && !name.startsWith("PI_SUBAGENT_") && !credentialLike
      && (!forceInline || !name.startsWith("CMUX") && !name.startsWith("TMUX"))) env[name] = value;
  }
  return { ...env, ...overrides };
}

async function prepareLiveAgentDir(agentDir: string): Promise<void> {
  const sourceAgentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  const sourceAuth = path.join(sourceAgentDir, "auth.json");
  const privateAuth = path.join(agentDir, "auth.json");
  try {
    await fs.chmod(agentDir, 0o700);
    const handle = await fs.open(sourceAuth, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let authBytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 1024 * 1024 || (process.getuid !== undefined && before.uid !== process.getuid())) throw new Error("invalid auth source");
      const bounded = Buffer.alloc(before.size + 1);
      let bytesRead = 0;
      while (bytesRead < bounded.length) {
        const result = await handle.read(bounded, bytesRead, bounded.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead !== before.size) throw new Error("auth source exceeded or changed from its bounded size");
      authBytes = bounded.subarray(0, bytesRead);
      const [after, current] = await Promise.all([handle.stat(), fs.lstat(sourceAuth)]);
      if (!current.isFile() || current.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size
        || before.mtimeMs !== current.mtimeMs || before.ctimeMs !== current.ctimeMs) throw new Error("auth source changed");
    } finally {
      await handle.close();
    }
    await fs.mkdir(path.join(agentDir, "agents"), { mode: 0o700 });
    await fs.writeFile(privateAuth, authBytes, { mode: 0o600, flag: "wx" });
    await fs.chmod(privateAuth, 0o600);
    await fs.writeFile(path.join(agentDir, "agents", "managed-child-live.md"), [
      "---",
      "name: managed-child-live",
      "description: Return the live managed-child acceptance sentinel.",
      `model: ${liveChildModel}`,
      "tools: read",
      "---",
      "Reply with exactly CHILD_FINAL. Do not call tools or add any other text.",
      "",
    ].join("\n"), { mode: 0o600 });
  } catch {
    throw new Error("Unable to prepare private provider authentication for the live nested acceptance.");
  }
}

async function runLiveNested(agentDir: string, parentExtension: string, sessionDir: string): Promise<JsonRecord[]> {
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputTooLarge = false;
  let diagnosticsTooLarge = false;
  let timedOut = false;
  const child = spawnPausedPi([
    "--mode", "json",
    ...buildManagedExtensionArgs(false),
    "--extension", parentExtension,
    "--model", liveChildModel,
    "--session-dir", sessionDir,
    "--no-context-files",
    "-p", "Run the managed child acceptance delegation.",
  ], sanitizedAcceptanceEnv({
    PI_CODING_AGENT_DIR: agentDir,
    PI_SUBAGENT_CMUX_CHILD_POLICY: "managed",
    [MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV]: managedChildPiExecutable,
    PI_OFFLINE: "1",
  }, true), ["ignore", "pipe", "pipe"]);
  const childStartedAt = await getChildStartedAt(child);
  if (process.platform !== "win32" && childStartedAt === null) {
    child.kill("SIGKILL");
    throw new Error("Unable to bind live acceptance child process identity.");
  }
  await resumePausedPi(child, childStartedAt);
  const killGroup = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== "win32" && child.pid !== undefined) {
        if (childStartedAt === null) return;
        const identityStatus = classifyParentProcessIdentity(child.pid, childStartedAt);
        if (identityStatus === "unknown") return;
        if (identityStatus === "dead" && getProcessStartedAt(child.pid) !== null) return;
        process.kill(-child.pid, signal);
      } else child.kill(signal);
    } catch {
      // The process group may already have exited.
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 16 * 1024 * 1024) {
      if (!outputTooLarge) {
        outputTooLarge = true;
        killGroup("SIGTERM");
        setTimeout(() => killGroup("SIGKILL"), 1_000).unref();
      }
      return;
    }
    stdout.push(chunk);
  });
  // Drain diagnostics without retaining or exposing provider/model text.
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024 && !diagnosticsTooLarge) {
      diagnosticsTooLarge = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 1_000).unref();
    }
  });

  const exitCode = await new Promise<number>((resolve) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 1_000).unref();
    }, liveTimeoutMs);
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(1);
    });
  });
  if (timedOut) throw new Error("Live nested managed-child acceptance timed out.");
  if (outputTooLarge) throw new Error("Live nested managed-child acceptance exceeded its output limit.");
  if (diagnosticsTooLarge) throw new Error("Live nested managed-child acceptance exceeded its diagnostics limit.");
  if (exitCode !== 0) throw new Error("Live nested managed-child acceptance failed.");

  return parseStrictLfJsonl(Buffer.concat(stdout), "Live nested managed-child acceptance output");
}

function assertLiveNested(events: JsonRecord[]): JsonRecord {
  const subagentEvents = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
  if (subagentEvents.length !== 1) throw new Error("Live nested acceptance did not produce exactly one subagent result.");

  const result = asRecord(subagentEvents[0]!.result);
  const details = asRecord(result?.details);
  const nestedResults = details?.results;
  const nested = Array.isArray(nestedResults) && nestedResults.length === 1 ? asRecord(nestedResults[0]) : null;
  const nestedMessages = Array.isArray(nested?.messages) ? nested.messages.map(asRecord).filter((message): message is JsonRecord => message !== null) : [];
  const nestedAssistant = nestedMessages.filter((message) => message.role === "assistant").at(-1);
  const contract = {
    success: subagentEvents[0]!.isError === false,
    inline: details?.terminalMode === "inline",
    exit: nested?.exitCode === 0,
    model: nested?.model === liveChildModel,
    provider: nestedAssistant?.provider === "openai-codex",
    api: nestedAssistant?.api === "openai-codex-responses",
    actualModel: nestedAssistant?.model === "gpt-5.4-mini",
    childFinal: textContentEquals(result?.content, "CHILD_FINAL") && textContentEquals(nestedAssistant?.content, "CHILD_FINAL"),
  };
  if (!Object.values(contract).every(Boolean)) {
    const failed = Object.entries(contract).filter(([, passed]) => !passed).map(([name]) => name).join(",");
    throw new Error(`Live nested managed-child result did not satisfy: ${failed}.`);
  }
  const parentUsage = assertExactBaseUsage(result?.usage, nested?.accountingUsage, "Foreground subagent tool result");
  if (parentUsage.totalTokens === 0) throw new Error("Foreground subagent tool result did not report positive token usage.");

  const agentEnds = events.filter((event) => event.type === "agent_end");
  const finalMessages = agentEnds.length === 1 && Array.isArray(agentEnds[0]!.messages)
    ? agentEnds[0]!.messages.map(asRecord).filter((message): message is JsonRecord => message?.role === "assistant" && textContentEquals(message.content, "PARENT_FINAL"))
    : [];
  if (finalMessages.length !== 1) throw new Error("Live nested acceptance did not produce exactly one parent final sentinel.");
  return parentUsage;
}

async function waitForProfile(marker: string, statePath: string, child: ChildProcess): Promise<{ profile: ToolProfile; state: ChildState }> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [profile, state] = await Promise.all([
      fs.readFile(marker, "utf8").then((value) => JSON.parse(value) as ToolProfile).catch(() => null),
      fs.readFile(statePath, "utf8").then((value) => JSON.parse(value) as ChildState).catch(() => null),
    ]);
    if (profile && state) return { profile, state };
    if (child.exitCode !== null) throw new Error(`Pi RPC child exited before session_start (exit ${child.exitCode}).`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Pi RPC session_start tool profile and child bridge state.");
}

function spawnPausedPi(args: string[], env: NodeJS.ProcessEnv, stdio: ["ignore" | "pipe", "ignore" | "pipe", "ignore" | "pipe"]): ChildProcess {
  revalidateManagedChildPiExecutableGeneration(managedChildPiGeneration);
  if (process.platform === "win32") return spawn(managedChildPiExecutable, args, { env, stdio });
  return spawn("/bin/sh", buildStoppedBootstrapArgv(managedChildPiExecutable, args), {
    env, stdio, detached: true,
  });
}

async function resumePausedPi(child: ChildProcess, expectedStartedAt: number | null, timeoutMs = 500): Promise<void> {
  if (process.platform === "win32" || child.pid === undefined) return;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (expectedStartedAt === null || getProcessStartedAt(child.pid) !== expectedStartedAt) throw new Error("Pi acceptance bootstrap identity changed before resume.");
    const probe = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(child.pid)], { encoding: "utf8" });
    if (probe.status === 0 && /^\s*T/.test(String(probe.stdout))) break;
    if (child.exitCode !== null || Date.now() >= deadline) throw new Error("Pi acceptance bootstrap did not enter its stopped identity gate.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (getProcessStartedAt(child.pid) !== expectedStartedAt) throw new Error("Pi acceptance bootstrap identity changed at resume.");
  process.kill(child.pid, "SIGCONT");
}

async function getChildStartedAt(child: ChildProcess, timeoutMs = 100): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (child.pid !== undefined) {
    const startedAt = getProcessStartedAt(child.pid);
    if (startedAt !== null) return startedAt;
    if (child.exitCode !== null || Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

function signalOwnedChildGroup(child: ChildProcess, childStartedAt: number | null, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32" || child.pid === undefined) {
      child.kill(signal);
      return;
    }
    if (childStartedAt === null) return;
    const status = classifyParentProcessIdentity(child.pid, childStartedAt);
    if (status === "unknown" || status === "dead" && getProcessStartedAt(child.pid) !== null) return;
    process.kill(-child.pid, signal);
  } catch {
    // The exact child group has already exited.
  }
}

async function stopChild(child: ChildProcess, childStartedAt: number | null): Promise<void> {
  const waitForClose = () => child.exitCode !== null
    ? Promise.resolve()
    : Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
  child.stdin?.end();
  await waitForClose();
  signalOwnedChildGroup(child, childStartedAt, "SIGTERM");
  await waitForClose();
  signalOwnedChildGroup(child, childStartedAt, "SIGKILL");
  await waitForClose();
}

async function getPersistedSessionStats(agentDir: string, sessionDir: string, sessionPath: string): Promise<JsonRecord> {
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const child = spawnPausedPi([
    "--mode", "rpc",
    "--session", sessionPath,
    "--session-dir", sessionDir,
    "--no-extensions",
    "--no-context-files",
  ], sanitizedAcceptanceEnv({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }, true), ["pipe", "pipe", "pipe"]);
  const childStartedAt = await getChildStartedAt(child);
  if (process.platform !== "win32" && childStartedAt === null) {
    child.kill("SIGKILL");
    throw new Error("Unable to bind persisted-session RPC process identity.");
  }
  try {
    const response = await new Promise<JsonRecord>((resolve, reject) => {
      let settled = false;
      const finish = (value: JsonRecord | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const timeout = setTimeout(() => finish(new Error("Persisted-session RPC stats timed out.")), 10_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 1024 * 1024) return finish(new Error("Persisted-session RPC output exceeded its bounded limit."));
        stdout.push(chunk);
        try {
          const completeBytes = Buffer.concat(stdout);
          const lastLf = completeBytes.lastIndexOf(0x0a);
          if (lastLf < 0) return;
          const records = parseStrictLfJsonl(completeBytes.subarray(0, lastLf + 1), "Persisted-session RPC output");
          if (records.length !== 1) throw new Error("Persisted-session RPC produced an unexpected response count.");
          const stats = records[0]!;
          if (stats.type !== "response" || stats.id !== "foreground-usage-stats"
            || stats.command !== "get_session_stats" || stats.success !== true) {
            throw new Error("Persisted-session RPC response did not exactly match get_session_stats.");
          }
          finish(stats);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > 64 * 1024) finish(new Error("Persisted-session RPC diagnostics exceeded their bounded limit."));
      });
      child.once("error", () => finish(new Error("Persisted-session RPC process failed.")));
      child.once("close", () => {
        if (!settled) finish(new Error("Persisted-session RPC process exited before get_session_stats."));
      });
      void resumePausedPi(child, childStartedAt).then(() => {
        child.stdin?.write(`${JSON.stringify({ id: "foreground-usage-stats", type: "get_session_stats" })}\n`);
      }).catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    });
    return response;
  } finally {
    await stopChild(child, childStartedAt);
  }
}

function assertPersistedSessionStats(response: JsonRecord, sessionPath: string, usage: JsonRecord): void {
  const data = asRecord(response.data);
  const tokens = asRecord(data?.tokens);
  if (!data || !tokens || data.sessionFile !== sessionPath) throw new Error("Persisted-session RPC stats did not bind to the exact parent session.");
  const expected = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens];
  if (!expected.every((value) => Number.isSafeInteger(value) && (value as number) >= 0)) throw new Error("Foreground tool usage is invalid for session stats comparison.");
  const expectedTotals = expected as number[];
  for (let index = 0; index < sessionStatsFields.length; index += 1) {
    const actual = tokens[sessionStatsFields[index]!];
    if (!Number.isSafeInteger(actual) || actual !== expectedTotals[index]!) {
      throw new Error("Persisted-session token totals do not exactly match the sole foreground subagent tool usage.");
    }
  }
}

async function inspectProfile(name: string, extensionArgs: string[], tools?: readonly string[]): Promise<ToolProfile> {
  const runId = `${name}-test`;
  const paths = await prepareRunArtifactPaths({ rootDir: path.join(root, "state"), runId });
  const marker = path.join(root, `${name}-profile.json`);
  let stderrBytes = 0;
  let diagnosticsOverflow = false;
  const child = spawnPausedPi([
    "--mode", "rpc",
    ...extensionArgs,
    "--extension", audit,
    "--session", paths.childSessionPath,
    ...(tools ? ["--tools", tools.join(",")] : []),
  ], sanitizedAcceptanceEnv({
    MARKER: marker,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
    PI_SUBAGENT_RUN_ID: runId,
    PI_SUBAGENT_RUN_STATE_PATH: paths.statePath,
    PI_SUBAGENT_RUN_COMPLETION_PATH: paths.completionPath,
    PI_SUBAGENT_PARENT_LEASE_PATH: paths.parentLeasePath,
    PI_SUBAGENT_CHILD_SESSION_PATH: paths.childSessionPath,
    PI_SUBAGENT_RUN_OWNERSHIP: "detached",
  }), ["pipe", "ignore", "pipe"]);
  const childStartedAt = await getChildStartedAt(child);
  if (process.platform !== "win32" && childStartedAt === null) {
    child.kill("SIGKILL");
    throw new Error(`Unable to bind ${name} RPC child process identity.`);
  }
  await resumePausedPi(child, childStartedAt);
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 64 * 1024 && !diagnosticsOverflow) {
      diagnosticsOverflow = true;
      signalOwnedChildGroup(child, childStartedAt, "SIGTERM");
    }
  });
  try {
    const { profile, state } = await waitForProfile(marker, paths.statePath, child);
    if (state.runId !== runId || state.phase !== "idle" || state.lastEvent !== "session_start") {
      throw new Error(`${name} child bridge did not write the expected session_start state: ${JSON.stringify(state)}`);
    }
    return profile;
  } catch (error) {
    const reason = diagnosticsOverflow ? " Pi RPC diagnostics exceeded the bounded limit." : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${reason}`);
  } finally {
    await stopChild(child, childStartedAt);
  }
}

function assertProfile(name: string, profile: ToolProfile): void {
  if (!Array.isArray(profile.all) || !Array.isArray(profile.active) || !Array.isArray(profile.commands)) throw new Error(`${name} audit did not report final Pi registries.`);
  for (const tool of profile.active) if (!profile.all.includes(tool)) throw new Error(`${name} final getAllTools is missing active ${tool}.`);
}

function assertExplicitTools(name: string, profile: ToolProfile): void {
  assertProfile(name, profile);
  if (JSON.stringify(profile.active) !== JSON.stringify(expectedActiveTools)) {
    throw new Error(`${name} --tools read,subagent profile mismatch: ${JSON.stringify(profile.active)}`);
  }
}

const sentinel = path.join(root, "sentinel.ts");
const audit = path.join(root, "audit.ts");
const agentDir = path.join(root, "agent");
const liveAgentDir = path.join(root, "live-agent");
const liveSessionDir = path.join(root, "live-sessions");
const liveParentExtension = path.join(root, "live-parent-provider.ts");
try {
  await fs.mkdir(agentDir, { mode: 0o700 });
  await fs.writeFile(sentinel, `import { Type } from "typebox"; export default function(pi:any){pi.registerTool({name:${JSON.stringify(sentinelName)},label:"Inherited sentinel",description:"acceptance sentinel",parameters:Type.Object({}),async execute(){return {content:[{type:"text",text:"sentinel"}],details:{}}}})}`);
  await fs.writeFile(audit, `import * as fs from "node:fs"; export default function(pi:any){pi.on("session_start",()=>{fs.writeFileSync(process.env.MARKER!,JSON.stringify({all:pi.getAllTools().map((tool:any)=>tool.name).sort(),active:pi.getActiveTools().slice().sort(),commands:pi.getCommands().filter((command:any)=>command.source==="extension").map((command:any)=>command.name).sort()}))})}`);

  if (liveNestedGate) {
    await fs.mkdir(liveAgentDir, { mode: 0o700 });
    await fs.mkdir(liveSessionDir, { mode: 0o700 });
    await prepareLiveAgentDir(liveAgentDir);
    await fs.writeFile(liveParentExtension, `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const piExecutable = process.env[${JSON.stringify(MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV)}]?.trim();
const api = "openai-codex-responses";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function message(content:any[], stopReason:"stop"|"toolUse") { return { role: "assistant", content, api, provider: "openai-codex", model: "gpt-5.4-mini", usage, stopReason, timestamp: Date.now() }; }
function emit(stream:any, output:any) {
  const partial = { ...output, content: [] as any[] };
  stream.push({ type: "start", partial: { ...partial } });
  const block = output.content[0];
  if (block.type === "toolCall") {
    partial.content = [{ type: "toolCall", id: block.id, name: block.name, arguments: {} }];
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: { ...partial } });
    stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(block.arguments), partial: { ...partial } });
    partial.content[0].arguments = block.arguments;
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: { ...partial } });
  } else {
    partial.content = [{ type: "text", text: "" }];
    stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial } });
    partial.content[0].text = block.text;
    stream.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: { ...partial } });
    stream.push({ type: "text_end", contentIndex: 0, content: block.text, partial: { ...partial } });
  }
  stream.push({ type: "done", reason: output.stopReason, message: output });
  stream.end(output);
}
export default function(pi:any) {
  // Pi's Bun launcher exposes Bun as process.execPath. The acceptance parent
  // receives its already validated, canonical Pi path from the harness.
  if (!piExecutable) throw new Error("Managed-child acceptance Pi executable is unavailable.");
  process.execPath = piExecutable;
  pi.registerProvider("openai-codex", {
    api,
    streamSimple(_model:any, context:any) {
      const stream = createAssistantMessageEventStream();
      const hasSubagentResult = context.messages.some((entry:any) => entry.role === "toolResult" && entry.toolName === "subagent");
      const output = hasSubagentResult
        ? message([{ type: "text", text: "PARENT_FINAL" }], "stop")
        : message([{ type: "toolCall", id: "managed-child-live-call", name: "subagent", arguments: { agent: "managed-child-live", task: "Reply with exactly CHILD_FINAL.", mode: "spawn" } }], "toolUse");
      queueMicrotask(() => emit(stream, output));
      return stream;
    },
  });
}` , { mode: 0o600 });
  }

  // These are the exact production child extension builders. The audit extension
  // only observes their fully initialized RPC session, after every tool filter.
  const inheritArgs = buildInteractiveExtensionArgs(["--no-extensions", "--extension", sentinel]);
  const managedArgs = buildManagedExtensionArgs(true);
  const inherited = await inspectProfile("inherit-default", inheritArgs);
  const managed = await inspectProfile("managed-default", managedArgs);
  assertProfile("inherit", inherited);
  assertProfile("managed", managed);
  if (!inherited.all.includes(sentinelName) || managed.all.includes(sentinelName)
    || !inherited.active.includes(sentinelName) || managed.active.includes(sentinelName)
    || !inherited.commands.includes("subagents") || !managed.commands.includes("subagents")) {
    throw new Error(`inherited sentinel extension contract failed: ${JSON.stringify({ inherit: inherited, managed })}`);
  }

  const inheritedExplicit = await inspectProfile("inherit-explicit", inheritArgs, expectedActiveTools);
  const managedExplicit = await inspectProfile("managed-explicit", managedArgs, expectedActiveTools);
  assertExplicitTools("inherit", inheritedExplicit);
  assertExplicitTools("managed", managedExplicit);
  if (JSON.stringify(inheritedExplicit) !== JSON.stringify(managedExplicit)) {
    throw new Error(`--tools read,subagent is not equivalent: ${JSON.stringify({ inherit: inheritedExplicit, managed: managedExplicit })}`);
  }

  if (liveNestedGate) {
    const foregroundUsage = assertLiveNested(await runLiveNested(liveAgentDir, liveParentExtension, liveSessionDir));
    const persisted = await findPrivateSessionJsonl(liveSessionDir);
    assertPersistedForegroundUsage(persisted.entries, foregroundUsage);
    assertPersistedSessionStats(await getPersistedSessionStats(liveAgentDir, liveSessionDir, persisted.path), persisted.path, foregroundUsage);
  }
  console.log(JSON.stringify({ mode: "managed-child", state: "passed", rpcSessionStart: true, lifecycleBridge: true, subagentsCommand: true, explicitToolsEquivalent: true, inheritedSentinel: true, providerBackedNestedExecution: liveNestedGate, foregroundUsagePersistence: liveNestedGate }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
