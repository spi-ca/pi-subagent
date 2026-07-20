import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getProcessStartedAt,
  isParentLeaseStale,
  hasAllocationIntentSourceBinding,
  parseAllocationRecordV2,
  parseParentLease,
  parseBrokerStatusV2,
  parseLaunchIntentV2,
  parseResidualRiskV2,
  prepareRunArtifactPaths,
  publishImmutableJson,
  readBrokerJson,
  readJsonFile,
  type RunArtifactPaths,
} from "../../src/runtime/run-protocol.js";
import { reapStaleInteractiveRuns, resolveBrokerRuntime, resolveBackendExecutable, resolveRuntimeInterpreter } from "../../src/runtime/runner.js";
import { buildCmuxNewSplitArgs, buildCmuxRespawnPaneArgs, cmuxIdsEqual, inspectCanonicalCmuxSurfaceTree, isCanonicalCmuxId, parseCreatedCmuxSurface } from "../../src/runtime/cmux.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = path.join(ROOT, "test/fixtures/acceptance-parent.ts");
const BROKER_RELATIVE = "src/runtime/pane-launch-broker.mjs";
const LIVE_CMUX_ENV = "PI_SUBAGENT_LIVE_CMUX";
const LIVE_TMUX_ENV = "PI_SUBAGENT_LIVE_TMUX";
const PACKAGE_ENV = "PI_SUBAGENT_PACKAGE_ACCEPTANCE";
/** Registration contract checked against the separately packed/installable extension. */
export const PACKAGE_REGISTRATION_EXPECTED_FLAGS = [
  "subagent-max-depth",
  "subagent-prevent-cycles",
  "subagent-pane-layout",
] as const;
const PACKAGE_REGISTRATION_EXPECTED_EVENTS = ["session_start", "session_shutdown", "before_agent_start"] as const;
const PACKAGE_REGISTRATION_EXPECTED_TOOLS = ["subagent"] as const;

/** Reject unexpected, duplicate, and missing registrations without depending on registration order. */
export const assertExactPackageRegistrationNames = (
  actual: readonly unknown[],
  expected: readonly string[],
  kind: string,
): void => {
  for (const value of actual) {
    if (typeof value !== "string" || !expected.includes(value)) throw new Error(`unexpected ${kind} registration: ${String(value)}`);
  }
  for (const name of expected) {
    const count = actual.filter((value) => value === name).length;
    if (count === 0) throw new Error(`missing ${kind} registration: ${name}`);
    if (count > 1) throw new Error(`duplicate ${kind} registration: ${name}`);
  }
};
const BROKER_RECONCILIATION_TIMEOUT_MS = 5_000;
const BROKER_RECONCILIATION_POLL_MS = 50;
/** Positive on purpose: the reaper must reject the killed fixture by identity, not age alone. */
export const LIVE_REAPER_LEASE_FRESHNESS_MS = 5_000;

// Keep signal authorization aligned with production's platform parsers. Z is
// observable only as terminal evidence; X/x and any unfamiliar ps state are
// unknown rather than permission to signal a PID.
const DARWIN_SIGNALABLE_PROCESS_STATES = new Set(["R", "S", "D", "I", "T", "U"]);
const LINUX_SIGNALABLE_PROCESS_STATES = new Set(["R", "S", "D", "I", "T", "t"]);
const SIGNALABLE_PROCESS_STATES = process.platform === "darwin"
  ? DARWIN_SIGNALABLE_PROCESS_STATES
  : process.platform === "linux"
    ? LINUX_SIGNALABLE_PROCESS_STATES
    : new Set<string>();
const LINUX_OBSERVABLE_PROCESS_STATES = new Set([...LINUX_SIGNALABLE_PROCESS_STATES, "Z"]);
const DARWIN_OBSERVABLE_PROCESS_STATES = new Set([...DARWIN_SIGNALABLE_PROCESS_STATES, "Z"]);
const DARWIN_STAT_MODIFIERS = /^[<NLs+]*$/;

type PaneIdentity = { id: string; pid: number };
export type CmuxIdentity = { workspaceId: string; surfaceId: string; paneId: string };
type CmuxSurfaceIdentity = Pick<CmuxIdentity, "workspaceId" | "surfaceId">;
type TmuxTarget = { paneId: string; panePid: number; serverPid: number; socketPath?: string };
type CmuxTarget = { workspaceId: string; surfaceId: string; paneId: string };

export type HarnessMode = "tmux" | "cmux" | "package";
export interface HarnessOptions { mode: HarnessMode; dryRun: boolean; keep: boolean }
export interface ProcessIdentity { pid: number; startedAt: number; expectedCommand: string; runId: string }
export type ProcessState = { state: "present"; value: string } | { state: "absent" } | { state: "unknown" };
export type ProcessStateProbe = (pid: number) => ProcessState;
export type PidExistenceProbe = (pid: number) => "present" | "absent" | "unknown";
export type ProcessStateCommandRunner = (pid: number) => { status: number | null; stdout: string | Buffer; error?: NodeJS.ErrnoException };

export const probePidExistence: PidExistenceProbe = (pid) => {
  try { process.kill(pid, 0); return "present"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown"; }
};

export type FixtureTracker = {
  child: ChildProcess | null;
  parent: ProcessIdentity | null;
  broker: ProcessIdentity | null;
  paths: RunArtifactPaths | null;
};

type FixtureHandoff = { parent: ProcessIdentity; broker: ProcessIdentity; runDir: string };

export function parseHarnessArgs(argv: string[]): HarnessOptions {
  const [mode, ...flags] = argv;
  if (mode !== "tmux" && mode !== "cmux" && mode !== "package") throw new Error("usage: live-harness.ts <tmux|cmux|package> [--dry-run] [--keep]");
  if (flags.some((flag) => flag !== "--dry-run" && flag !== "--keep")) throw new Error("only --dry-run and --keep are accepted");
  return { mode, dryRun: flags.includes("--dry-run"), keep: flags.includes("--keep") || process.env.PI_SUBAGENT_ACCEPTANCE_KEEP === "1" };
}

export function requiredLiveGate(mode: HarnessMode): string {
  return mode === "cmux" ? LIVE_CMUX_ENV : mode === "tmux" ? LIVE_TMUX_ENV : PACKAGE_ENV;
}

export function requireLiveGate(mode: HarnessMode, env = process.env): void {
  const name = requiredLiveGate(mode);
  if (env[name] !== "1") throw new Error(`${name}=1 is required; use --dry-run to inspect without mutation.`);
}

function commandText(pid: number): string | null {
  const result = spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function probeProcessState(
  pid: number,
  runPs: ProcessStateCommandRunner = (targetPid) => spawnSync("/bin/ps", ["-o", "state=", "-p", String(targetPid)], { encoding: "utf8" }),
  probePid: PidExistenceProbe = probePidExistence,
  platform: NodeJS.Platform = process.platform,
): ProcessState {
  let result: ReturnType<ProcessStateCommandRunner>;
  try { result = runPs(pid); } catch { return { state: "unknown" }; }
  const value = String(result.stdout).trim();
  if (result.status === 0) {
    const primary = platform === "darwin" && DARWIN_OBSERVABLE_PROCESS_STATES.has(value[0] ?? "") && DARWIN_STAT_MODIFIERS.test(value.slice(1))
      ? value[0]!
      : platform === "linux" && LINUX_OBSERVABLE_PROCESS_STATES.has(value) ? value : null;
    return primary ? { state: "present", value: primary } : { state: "unknown" };
  }
  // ps commonly returns a generic nonzero status for a vanished PID. Prove
  // only ESRCH through kill(pid, 0); permissions and probe failures are not absence.
  if (result.error?.code === "EPERM") return { state: "unknown" };
  try { return probePid(pid) === "absent" ? { state: "absent" } : { state: "unknown" }; }
  catch { return { state: "unknown" }; }
}

/** This must succeed immediately before any lifecycle signal; PID existence is never enough. */
export function verifyProcessIdentity(identity: ProcessIdentity): boolean {
  const currentStart = getProcessStartedAt(identity.pid);
  const command = commandText(identity.pid);
  return currentStart === identity.startedAt && command !== null && command.includes(identity.expectedCommand);
}

function isSignalableProcessState(state: ProcessState): state is Extract<ProcessState, { state: "present" }> {
  return state.state === "present" && SIGNALABLE_PROCESS_STATES.has(state.value);
}

export function isIdentityStopped(identity: ProcessIdentity, stateProbe: ProcessStateProbe = probeProcessState): boolean {
  const state = stateProbe(identity.pid);
  return isSignalableProcessState(state) && state.value === "T" && verifyProcessIdentity(identity);
}

export function safeSignalFixture(identity: ProcessIdentity, signal: NodeJS.Signals = "SIGKILL", stateProbe: ProcessStateProbe = probeProcessState): void {
  if (signal !== "SIGKILL") throw new Error("acceptance harness only permits SIGKILL for the dedicated fixture");
  if (!isSignalableProcessState(stateProbe(identity.pid)) || !verifyProcessIdentity(identity)) {
    throw new Error("refusing to signal: fixture PID/start identity/expected command/signalable state no longer match");
  }
  process.kill(identity.pid, signal);
}

/** Resume only the identity-verified broker that is still OS-stopped. */
export function safeResumeBroker(identity: ProcessIdentity, stateProbe: ProcessStateProbe = probeProcessState): void {
  if (!isIdentityStopped(identity, stateProbe)) throw new Error("refusing to resume: broker PID/start/command/stopped identity no longer match");
  process.kill(identity.pid, "SIGCONT");
}

/** The exact parser is deliberately pinned to the live harness's supported cmux release. */
export function parseRequiredCmuxVersion(stdout: string): "0.64.20" | null {
  // cmux 0.64.20 reports its release build as `cmux 0.64.20 (100) [hash]`.
  // Keep the semantic version exact: a prefix such as 0.64.200 is not valid.
  return /^cmux (0\.64\.20)(?: \([0-9]+\) \[[0-9a-f]+\])?$/i.test(stdout.trim()) ? "0.64.20" : null;
}

function run(bin: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function waitFor<T>(probe: () => Promise<T | null>, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function parseTabPair(text: string, label: string): PaneIdentity {
  const [id, pidText, ...extra] = text.trim().split("\t");
  const pid = Number(pidText);
  if (!id || extra.length || !/^[1-9][0-9]*$/.test(pidText ?? "") || !Number.isSafeInteger(pid)) throw new Error(`invalid ${label} identity`);
  return { id, pid };
}

async function privateTempRoot(prefix: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  await fs.promises.chmod(root, 0o700);
  return root;
}

async function writeEvidence(root: string, evidence: Record<string, unknown>): Promise<void> {
  await fs.promises.writeFile(path.join(root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

function printEvidence(options: HarnessOptions, root: string, evidence: Record<string, unknown>): void {
  if (options.keep) {
    console.log(`acceptance evidence retained: ${path.join(root, "evidence.json")}`);
    return;
  }
  // Never print child output, environment, full paths, or artifact contents.
  console.log(JSON.stringify({
    mode: evidence.mode,
    outcome: evidence.outcome,
    runId: evidence.runId,
    targetAbsent: evidence.targetAbsent,
    sourceAndSentinelPreserved: evidence.sourceAndSentinelPreserved,
    cleanup: evidence.cleanup,
    residual: evidence.residual,
  }));
}

function brokerRuntime(): string {
  const runtime = resolveBrokerRuntime(process.env);
  if (!runtime) throw new Error("no usable Bun/Node broker runtime found");
  return runtime;
}

function brokerRuntimeInterpreter(runtime: string): string {
  const interpreter = resolveRuntimeInterpreter(runtime, process.env);
  if (!interpreter) throw new Error("no usable broker runtime interpreter found");
  return interpreter;
}

function backend(mode: "tmux-pane" | "cmux-pane"): string {
  const resolved = resolveBackendExecutable(mode, process.env);
  if (!resolved) throw new Error(`no usable ${mode} executable found`);
  return resolved;
}

function minimalBrokerEnv(mode: "tmux-pane" | "cmux-pane", base = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: base.PATH || "/usr/bin:/bin",
    HOME: base.HOME || os.homedir(),
    TMPDIR: base.TMPDIR || os.tmpdir(),
    TERM: base.TERM || "xterm-256color",
  };
  const keys = mode === "cmux-pane"
    ? ["CMUX_SOCKET_PATH", "CMUX_SOCKET_CAPABILITY", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_BUNDLED_CLI_PATH"]
    : ["TMUX", "TMUX_PANE"];
  for (const key of keys) if (typeof base[key] === "string") env[key] = base[key];
  return env;
}

function parseFixtureHandoff(value: unknown): FixtureHandoff | null {
  const isIdentity = (identity: unknown): identity is ProcessIdentity => Boolean(identity) && typeof identity === "object"
    && Number.isSafeInteger((identity as ProcessIdentity).pid) && (identity as ProcessIdentity).pid > 0
    && Number.isFinite((identity as ProcessIdentity).startedAt) && (identity as ProcessIdentity).startedAt > 0
    && typeof (identity as ProcessIdentity).expectedCommand === "string" && typeof (identity as ProcessIdentity).runId === "string";
  if (!value || typeof value !== "object") return null;
  const handoff = value as FixtureHandoff;
  return isIdentity(handoff.parent) && isIdentity(handoff.broker) && typeof handoff.runDir === "string" && path.isAbsolute(handoff.runDir)
    && handoff.parent.runId === handoff.broker.runId ? handoff : null;
}

export async function readFixtureBrokerStarted(root: string): Promise<FixtureHandoff | null> {
  try { return parseFixtureHandoff(JSON.parse(await fs.promises.readFile(path.join(root, "broker-started.json"), "utf8"))); }
  catch { return null; }
}

/** The broker handoff is read before ready.json so failure cleanup never loses it. */
export async function spawnFixture(spec: Record<string, unknown>, tracker: FixtureTracker): Promise<{ child: ChildProcess; identity: ProcessIdentity; paths: RunArtifactPaths; broker: ProcessIdentity }> {
  const root = String(spec.root);
  const specPath = path.join(root, "fixture-spec.json");
  await fs.promises.writeFile(specPath, `${JSON.stringify(spec)}\n`, { mode: 0o600 });
  const mode = spec.mode as "tmux-pane" | "cmux-pane";
  const child = spawn(process.execPath, [FIXTURE, "--spec", specPath], { cwd: root, env: minimalBrokerEnv(mode), stdio: "ignore" });
  tracker.child = child;
  const startedAt = await waitFor(async () => child.pid ? getProcessStartedAt(child.pid) : null, "fixture process identity");
  tracker.parent = { pid: child.pid!, startedAt, expectedCommand: "acceptance-parent.ts", runId: "unpublished" };
  const started = await waitFor(() => readFixtureBrokerStarted(root), "broker started handoff");
  const paths = (await import("../../src/runtime/run-protocol.js")).resolveRunArtifactPaths(started.parent.runId, path.join(root, "state"));
  tracker.parent = started.parent;
  tracker.broker = started.broker;
  tracker.paths = paths;
  const readyPath = path.join(root, "fixture-ready.json");
  const ready = await waitFor(async () => {
    try {
      const handoff = parseFixtureHandoff(JSON.parse(await fs.promises.readFile(readyPath, "utf8")));
      if (!handoff) return null;
      if (handoff.parent.runId !== started.parent.runId || handoff.broker.pid !== started.broker.pid || handoff.broker.startedAt !== started.broker.startedAt) throw new Error("fixture ready handoff disagrees with broker-started identity");
      return handoff;
    } catch (error) {
      if (error instanceof Error && error.message.includes("disagrees")) throw error;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("fixture exited before ready after broker-started handoff");
      return null;
    }
  }, "fixture ready");
  return { child, identity: ready.parent, broker: ready.broker, paths };
}

function isTerminalOwnedIdentity(_identity: ProcessIdentity, state: ProcessState): boolean {
  // ps has already supplied a concrete terminal state. The protocol parser
  // deliberately refuses zombie start identity as *liveness* authority, but a
  // zombie cannot execute or receive a later lifecycle signal.
  return state.state === "absent" || (state.state === "present" && state.value === "Z");
}

/** Read the fixture's actual terminal state immediately before reaping. */
export function verifyFixtureTerminationState(identity: ProcessIdentity, stateProbe: ProcessStateProbe = probeProcessState): "absent" | "zombie" | null {
  const state = stateProbe(identity.pid);
  if (state.state === "absent") return "absent";
  return state.state === "present" && state.value === "Z" ? "zombie" : null;
}

export async function awaitOwnedIdentityTermination(identity: ProcessIdentity, stateProbe: ProcessStateProbe = probeProcessState): Promise<boolean> {
  return await waitFor(async () => {
    const state = stateProbe(identity.pid);
    // An unknown probe is not absence and cannot authorize later teardown.
    if (state.state === "unknown") return false;
    if (isTerminalOwnedIdentity(identity, state)) return true;
    return verifyProcessIdentity(identity) ? null : false;
  }, "fixture process termination", 5_000).catch(() => false);
}

export async function terminateOwnedIdentity(identity: ProcessIdentity, stateProbe: ProcessStateProbe = probeProcessState): Promise<boolean> {
  const initial = stateProbe(identity.pid);
  if (initial.state === "unknown" || isTerminalOwnedIdentity(identity, initial)) return initial.state !== "unknown";
  if (!isSignalableProcessState(initial) || !verifyProcessIdentity(identity)) return false;
  if (initial.value === "T") {
    // This helper is used only for the dedicated fixture parent. Broker
    // teardown has a separate no-SIGCONT pre-allocation proof below.
    safeResumeBroker(identity, stateProbe);
  }
  // Recheck both state and identity adjacent to SIGTERM; a PID-only probe is
  // never authority and an unfamiliar state cannot authorize a signal.
  if (!isSignalableProcessState(stateProbe(identity.pid)) || !verifyProcessIdentity(identity)) return isTerminalOwnedIdentity(identity, stateProbe(identity.pid));
  process.kill(identity.pid, "SIGTERM");
  return await awaitOwnedIdentityTermination(identity, stateProbe);
}

async function verifyStoppedPreallocationBroker(broker: ProcessIdentity, paths: RunArtifactPaths, stateProbe: ProcessStateProbe = probeProcessState): Promise<boolean> {
  const [intent, status, allocation, decision] = await Promise.all([
    readBrokerJson(paths.launchIntentPath) as Promise<{ runId?: unknown } | null>,
    readBrokerJson(paths.brokerStatusPath) as Promise<{ runId?: unknown; writer?: unknown; pid?: unknown; phase?: unknown } | null>,
    readBrokerJson(paths.allocationPath), readBrokerJson(paths.decisionPath),
  ]);
  return intent?.runId === broker.runId && status?.runId === broker.runId && status.writer === "broker"
    && status.pid === broker.pid && status.phase === "ready" && allocation === null && decision === null
    && isIdentityStopped(broker, stateProbe);
}

/** SIGKILL is safe only for the dedicated broker frozen before allocation. */
export async function terminateStoppedPreallocationBroker(broker: ProcessIdentity, paths: RunArtifactPaths, stateProbe: ProcessStateProbe = probeProcessState): Promise<boolean> {
  const initial = stateProbe(broker.pid);
  if (initial.state === "unknown") return false;
  if (isTerminalOwnedIdentity(broker, initial)) return true;
  // The artifact proof and the final identity/stopped-state probe are adjacent:
  // do not SIGCONT this checkpoint, because that would enter allocation.
  if (!await verifyStoppedPreallocationBroker(broker, paths, stateProbe) || !isIdentityStopped(broker, stateProbe)) return false;
  process.kill(broker.pid, "SIGKILL");
  return await waitFor(async () => {
    const state = stateProbe(broker.pid);
    return state.state === "unknown" ? false : isTerminalOwnedIdentity(broker, state) ? true : null;
  }, "stopped pre-allocation broker termination", 5_000).catch(() => false);
}

type BrokerReconciliation = {
  state: "not-started" | "stopped-preallocation-killed" | "exited-with-allocation" | "exited-terminal" | "exited-unrecorded" | "residual-risk" | "handoff-unresolved" | "alive-with-allocation" | "alive-terminal" | "alive-timeout" | "identity-lost";
  allocationPublished: boolean;
  canFinishCleanup: boolean;
};

type FixtureCleanup = { broker: BrokerReconciliation; parent: boolean | "unidentified" };

type BrokerAuthority = { allocation: boolean; residualRisk: boolean; handoffUnresolved: boolean; terminal: boolean };

async function readBrokerAuthority(paths: RunArtifactPaths, runId: string): Promise<BrokerAuthority> {
  const [allocationValue, statusValue, riskValue] = await Promise.all([
    readBrokerJson(paths.allocationPath), readBrokerJson(paths.brokerStatusPath), readBrokerJson(paths.residualRiskPath),
  ]);
  const allocation = parseAllocationRecordV2(allocationValue, runId);
  const status = parseBrokerStatusV2(statusValue, runId);
  return {
    allocation: allocation !== null,
    residualRisk: parseResidualRiskV2(riskValue, runId) !== null || status?.phase === "failed" && status.errorCode === "possible-unrecorded-allocation",
    handoffUnresolved: status?.phase === "failed" && status.errorCode === "acceptance-handoff-unresolved",
    terminal: status?.writer === "broker" && (status.phase === "committed" || status.phase === "failed"),
  };
}

function classifyBrokerAuthority(authority: BrokerAuthority, brokerAlive: boolean): BrokerReconciliation {
  if (authority.residualRisk) return { state: "residual-risk", allocationPublished: authority.allocation, canFinishCleanup: false };
  // No allocation is permitted without the durable pre-checkpoint handshake;
  // retain acceptance evidence rather than treating this as routine terminal cleanup.
  if (authority.handoffUnresolved) return { state: "handoff-unresolved", allocationPublished: authority.allocation, canFinishCleanup: false };
  if (authority.allocation) return { state: brokerAlive ? "alive-with-allocation" : "exited-with-allocation", allocationPublished: true, canFinishCleanup: !brokerAlive };
  if (authority.terminal) return { state: brokerAlive ? "alive-terminal" : "exited-terminal", allocationPublished: false, canFinishCleanup: !brokerAlive };
  return { state: brokerAlive ? "alive-timeout" : "exited-unrecorded", allocationPublished: false, canFinishCleanup: false };
}

/**
 * A detached broker can allocate after its fixture parent dies. Never delete
 * its authority root until its identity is gone or its allocation boundary is
 * durable; a still-live broker always forces retained evidence.
 */
export async function reconcileFixtureBroker(fixture: Pick<FixtureTracker, "broker" | "paths">, stateProbe: ProcessStateProbe = probeProcessState): Promise<BrokerReconciliation> {
  if (!fixture.broker || !fixture.paths) return { state: "not-started", allocationPublished: false, canFinishCleanup: true };
  const { broker, paths } = fixture;
  if (isIdentityStopped(broker, stateProbe)) {
    if (!await terminateStoppedPreallocationBroker(broker, paths, stateProbe)) return { state: "identity-lost", allocationPublished: false, canFinishCleanup: false };
    const authority = await readBrokerAuthority(paths, broker.runId);
    if (authority.residualRisk || authority.allocation) return classifyBrokerAuthority(authority, false);
    return { state: "stopped-preallocation-killed", allocationPublished: false, canFinishCleanup: true };
  }

  const deadline = Date.now() + BROKER_RECONCILIATION_TIMEOUT_MS;
  while (true) {
    const state = stateProbe(broker.pid);
    // Unknown process state and a present-but-mismatched PID retain the root:
    // neither can authorize backend or artifact teardown.
    if (state.state === "unknown") return { state: "identity-lost", allocationPublished: false, canFinishCleanup: false };
    if (isTerminalOwnedIdentity(broker, state)) return classifyBrokerAuthority(await readBrokerAuthority(paths, broker.runId), false);
    if (!verifyProcessIdentity(broker)) return { state: "identity-lost", allocationPublished: false, canFinishCleanup: false };
    const authority = await readBrokerAuthority(paths, broker.runId);
    // A durable allocation can be exact-cleaned below, but this live broker
    // still prevents final teardown/root deletion until it exits.
    if (authority.allocation || authority.residualRisk || authority.terminal) return classifyBrokerAuthority(authority, true);
    if (Date.now() >= deadline) return { state: "alive-timeout", allocationPublished: false, canFinishCleanup: false };
    await new Promise((resolve) => setTimeout(resolve, BROKER_RECONCILIATION_POLL_MS));
  }
}

async function cleanupFixtureProcesses(fixture: FixtureTracker): Promise<FixtureCleanup> {
  const broker = await reconcileFixtureBroker(fixture).catch(() => ({ state: "identity-lost", allocationPublished: false, canFinishCleanup: false } as BrokerReconciliation));
  const parent = !fixture.child || fixture.child.exitCode !== null || fixture.child.signalCode !== null
    ? true
    : fixture.parent ? await terminateOwnedIdentity(fixture.parent).catch(() => false) : "unidentified";
  return { broker, parent };
}

export function bindAcceptanceTmuxAllocation(intentValue: unknown, allocationValue: unknown, runId: string): TmuxTarget | null {
  const intent = parseLaunchIntentV2(intentValue, runId);
  const allocation = parseAllocationRecordV2(allocationValue, runId);
  if (!intent || !allocation || intent.terminalMode !== "tmux-pane" || allocation.terminalMode !== "tmux-pane"
    || !hasAllocationIntentSourceBinding(intent, allocation)) return null;
  return { paneId: allocation.target.paneId, panePid: allocation.target.panePid, serverPid: allocation.target.serverPid, socketPath: allocation.target.socketPath };
}

async function durableTmuxTarget(paths: RunArtifactPaths | null): Promise<TmuxTarget | null> {
  if (!paths) return null;
  const [intent, allocation] = await Promise.all([
    readBrokerJson(paths.launchIntentPath), readBrokerJson(paths.allocationPath),
  ]);
  return bindAcceptanceTmuxAllocation(intent, allocation, path.basename(paths.runDir));
}

export type CmuxAllocationAuthority =
  | { state: "no-allocation" }
  | { state: "authorized"; target: CmuxTarget }
  | { state: "unresolved"; reason: "invalid-allocation" | "source-binding" | "source-surface" | "acceptance-source" | "wrong-workspace" | "caller-identity" };

/**
 * The harness treats broker artifacts as authority only when the complete V2
 * source chain binds the allocation to the isolated workspace. Caller IDs are
 * negative authority: even a valid-looking durable record must never target
 * them.
 */
export function bindAcceptanceCmuxAllocation(
  intentValue: unknown,
  allocationValue: unknown,
  runId: string,
  acceptance: CmuxWorkspaceIdentity,
  caller: CmuxIdentity,
): CmuxAllocationAuthority {
  const intent = parseLaunchIntentV2(intentValue, runId);
  const allocation = parseAllocationRecordV2(allocationValue, runId);
  if (!intent || !allocation || intent.terminalMode !== "cmux-pane" || allocation.terminalMode !== "cmux-pane") return { state: "unresolved", reason: "invalid-allocation" };
  const target = allocation.target;
  const sourceBound = hasAllocationIntentSourceBinding(intent, allocation);
  if (cmuxIdsEqual(target.surfaceId, intent.source.sourceSurfaceId)) return { state: "unresolved", reason: "source-surface" };
  if (cmuxIdsEqual(target.workspaceId, caller.workspaceId) || cmuxIdsEqual(target.surfaceId, caller.surfaceId) || cmuxIdsEqual(target.paneId, caller.paneId)
    || cmuxIdsEqual(intent.source.workspaceId, caller.workspaceId) || cmuxIdsEqual(intent.source.sourceSurfaceId, caller.surfaceId)) return { state: "unresolved", reason: "caller-identity" };
  if (!cmuxIdsEqual(target.workspaceId, acceptance.workspaceId)) return { state: "unresolved", reason: "wrong-workspace" };
  if (!cmuxIdsEqual(intent.source.workspaceId, acceptance.workspaceId) || !cmuxIdsEqual(intent.source.sourceSurfaceId, acceptance.surfaceId)) return { state: "unresolved", reason: "acceptance-source" };
  if (!sourceBound) return { state: "unresolved", reason: "source-binding" };
  return { state: "authorized", target };
}

async function durableCmuxTarget(
  paths: RunArtifactPaths | null,
  acceptance: CmuxWorkspaceIdentity | null,
  caller: CmuxIdentity,
): Promise<CmuxAllocationAuthority> {
  if (!paths || !acceptance) return { state: "no-allocation" };
  const allocation = await readBrokerJson(paths.allocationPath);
  // Missing allocation is not a cleanup target. Any present but malformed
  // allocation remains an unresolved residual rather than being guessed.
  if (allocation === null) return { state: "no-allocation" };
  return bindAcceptanceCmuxAllocation(
    await readBrokerJson(paths.launchIntentPath),
    allocation,
    path.basename(paths.runDir),
    acceptance,
    caller,
  );
}

async function verifyFixtureCheckpoint(identity: ProcessIdentity, broker: ProcessIdentity, paths: RunArtifactPaths, stateProbe: ProcessStateProbe = probeProcessState): Promise<boolean> {
  const [intent, status, allocation, decision] = await Promise.all([
    readBrokerJson(paths.launchIntentPath) as Promise<{ runId?: unknown; parentPid?: unknown; parentStartedAt?: unknown } | null>,
    readBrokerJson(paths.brokerStatusPath) as Promise<{ runId?: unknown; writer?: unknown; pid?: unknown; phase?: unknown } | null>,
    readBrokerJson(paths.allocationPath), readBrokerJson(paths.decisionPath),
  ]);
  return path.basename(paths.runDir) === identity.runId
    && intent?.runId === identity.runId
    && intent.parentPid === identity.pid
    && intent.parentStartedAt === identity.startedAt
    && status?.runId === identity.runId
    && status.writer === "broker"
    && status.pid === broker.pid
    && status.phase === "ready"
    && allocation === null
    && decision === null
    && isIdentityStopped(broker, stateProbe);
}

async function signalFixtureAtCheckpoint(identity: ProcessIdentity, broker: ProcessIdentity, paths: RunArtifactPaths, stateProbe: ProcessStateProbe = probeProcessState): Promise<void> {
  // Re-read immutable run identity plus the ready-without-allocation checkpoint,
  // then synchronously revalidate the dedicated parent immediately before its
  // only permitted SIGKILL. The broker is resumed only with SIGCONT.
  if (!await verifyFixtureCheckpoint(identity, broker, paths, stateProbe)) throw new Error("refusing to signal: fixture/broker stopped pre-allocation checkpoint no longer matches");
  safeSignalFixture(identity, "SIGKILL", stateProbe);
  // SIGKILL is asynchronous. Do not let the stopped broker allocate until the
  // exact fixture identity is absent or zombie (and never merely PID-reused).
  if (!await awaitOwnedIdentityTermination(identity, stateProbe)) throw new Error("fixture parent did not terminate with its verified identity before broker resume");
  // The SIGKILL can race process scheduling; prove the broker is still the
  // same stopped process immediately before its only permitted SIGCONT.
  safeResumeBroker(broker, stateProbe);
}

async function publishGate(paths: RunArtifactPaths, runId: string, mode: "tmux-pane" | "cmux-pane"): Promise<void> {
  const published = await publishImmutableJson(paths.launchGatePath, { version: 2, runId, terminalMode: mode, launchPath: paths.launchPath, publishedAt: Date.now() });
  if (published !== "published") throw new Error("launch gate was not published exactly once");
}

/** Assert the killed fixture's lease is still fresh so identity liveness, not age, drives the live reaper. */
export async function assertFreshFixtureParentLease(paths: RunArtifactPaths, parent: ProcessIdentity, freshnessMs = LIVE_REAPER_LEASE_FRESHNESS_MS): Promise<void> {
  const now = Date.now();
  const lease = parseParentLease(await readJsonFile(paths.parentLeasePath), parent.runId, now);
  if (!lease || lease.parentPid !== parent.pid || lease.parentStartedAt !== parent.startedAt || isParentLeaseStale(lease, now, freshnessMs)) {
    throw new Error("fixture parent lease is not valid and fresh immediately before reaper");
  }
}

/** A live acceptance pass requires its own run to be reaped, never skipped or invalid. */
export function assertFixtureRunReaped(runId: string, result: Pick<Awaited<ReturnType<typeof reapStaleInteractiveRuns>>, "reaped" | "skipped" | "invalid">): void {
  if (!result.reaped.includes(runId) || result.skipped.includes(runId) || result.invalid.includes(runId)) {
    throw new Error("reaper did not reap the exact acceptance fixture run");
  }
}

export type TmuxPaneProbe = "present" | "absent" | "unknown";

export function parseTmuxPanePairProbe(result: { code: number; stdout: string }, pair: PaneIdentity): TmuxPaneProbe {
  if (result.code !== 0) return "unknown";
  return result.stdout.split(/\r?\n/).includes(`${pair.id}\t${pair.pid}`) ? "present" : "absent";
}

async function probeTmuxPanePair(tmux: string, socket: string, pair: PaneIdentity): Promise<TmuxPaneProbe> {
  return parseTmuxPanePairProbe(await run(tmux, ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}\t#{pane_pid}"]), pair);
}

async function cleanupTmuxTarget(tmux: string, socket: string, target: TmuxTarget, source?: PaneIdentity): Promise<boolean> {
  // The acceptance source is never cleanup authority, even if a malformed
  // artifact attempts to present it as a durable child allocation.
  if (source && target.paneId === source.id && target.panePid === source.pid) return false;
  const current = await probeTmuxPanePair(tmux, socket, { id: target.paneId, pid: target.panePid });
  if (current === "absent") return true;
  if (current !== "present") return false;
  const condition = `#{&&:#{==:#{pid},${target.serverPid}},#{==:#{pane_pid},${target.panePid}}}`;
  if ((await run(tmux, ["-S", socket, "if-shell", "-F", "-t", target.paneId, condition, `kill-pane -t ${target.paneId}`, ""])).code !== 0) return false;
  return (await probeTmuxPanePair(tmux, socket, { id: target.paneId, pid: target.panePid })) === "absent";
}

export async function removePrivateStaleTmuxSocket(expectedRoot: string, socket: string): Promise<boolean> {
  const root = path.resolve(expectedRoot);
  if (path.resolve(socket) !== path.join(root, "tmux.sock")) return false;
  try {
    const rootStat = await fs.promises.lstat(root);
    const socketStat = await fs.promises.lstat(socket);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o700
      || (uid !== undefined && rootStat.uid !== uid) || !socketStat.isSocket() || socketStat.isSymbolicLink()
      || (uid !== undefined && socketStat.uid !== uid)) return false;
    await fs.promises.unlink(socket);
    return !fs.existsSync(socket);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export async function reconcileDeadTmuxServerEndpoint(
  expectedRoot: string,
  socket: string,
  serverAlive: () => boolean,
  probe: () => Promise<{ code: number }>,
): Promise<boolean> {
  if (serverAlive() || (await probe()).code === 0) return false;
  if (fs.existsSync(socket) && !await removePrivateStaleTmuxSocket(expectedRoot, socket)) return false;
  return !serverAlive() && !fs.existsSync(socket) && (await probe()).code !== 0;
}

async function tmuxServerAbsent(tmux: string, expectedRoot: string, socket: string, serverPid: number): Promise<boolean> {
  const tmuxProbe = () => run(tmux, ["-S", socket, "display-message", "-p", "#{pid}"]).catch(() => ({ code: 1, stdout: "" }));
  const serverAlive = () => { try { process.kill(serverPid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
  const before = await tmuxProbe();
  const reachablePid = Number(before.stdout.trim());
  // Do not send kill-server to a socket that now answers for another server.
  if (before.code === 0 && (!Number.isSafeInteger(reachablePid) || reachablePid !== serverPid)) return false;
  if (before.code === 0 && (await run(tmux, ["-S", socket, "kill-server"])).code !== 0) return false;
  return await waitFor(async () => serverAlive()
    ? null
    : await reconcileDeadTmuxServerEndpoint(expectedRoot, socket, serverAlive, tmuxProbe),
  "isolated tmux server absence", 5_000).catch(() => false);
}

async function runTmuxLive(options: HarnessOptions): Promise<void> {
  requireLiveGate("tmux");
  const root = await privateTempRoot("pi-subagent-accept-tmux");
  const socket = path.join(root, "tmux.sock"), session = "pi-subagent-accept";
  let serverStarted = false;
  let serverPid: number | null = null;
  let tmux: string | null = null;
  const fixture: FixtureTracker = { child: null, parent: null, broker: null, paths: null };
  let paths: RunArtifactPaths | null = null;
  let source: PaneIdentity | null = null;
  let target: TmuxTarget | null = null;
  let retainRoot = options.keep;
  let cleanupFailed = false;
  const evidence: Record<string, unknown> = { mode: "tmux", outcome: "failed" };
  try {
    tmux = backend("tmux-pane");
    const runtime = brokerRuntime(), runtimeInterpreter = brokerRuntimeInterpreter(runtime);
    if ((await run(tmux, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", session, "-c", root, "exec /bin/sh"])).code !== 0) throw new Error("could not create isolated tmux server");
    serverStarted = true;
    source = parseTabPair((await run(tmux, ["-S", socket, "display-message", "-p", "-t", `${session}:0.0`, "#{pane_id}\t#{pane_pid}"])).stdout, "source pane");
    const sentinel = parseTabPair((await run(tmux, ["-S", socket, "split-window", "-d", "-P", "-F", "#{pane_id}\t#{pane_pid}", "-t", source.id, "exec sleep 600"])).stdout, "sentinel pane");
    if ((await probeTmuxPanePair(tmux, socket, source)) !== "present" || (await probeTmuxPanePair(tmux, socket, sentinel)) !== "present") throw new Error("tmux source or sentinel identity is not stable before acceptance");
    serverPid = Number((await run(tmux, ["-S", socket, "display-message", "-p", "#{pid}"])).stdout.trim());
    if (!Number.isSafeInteger(serverPid) || serverPid <= 0) throw new Error("invalid isolated tmux server PID");
    const launchedFixture = await spawnFixture({ root, mode: "tmux-pane", socket, source, serverPid, runtime, runtimeInterpreter, backend: tmux, brokerEntrypoint: path.join(ROOT, BROKER_RELATIVE), checkpoint: "ready-before-allocation" }, fixture);
    paths = launchedFixture.paths;
    evidence.runId = launchedFixture.identity.runId; evidence.parent = launchedFixture.identity; evidence.broker = launchedFixture.broker; evidence.source = source; evidence.sentinel = sentinel;
    await waitFor(async () => {
      const status = await readBrokerJson(launchedFixture.paths.brokerStatusPath) as { phase?: unknown } | null;
      return status?.phase === "ready" ? {} : null;
    }, "broker ready checkpoint");
    await signalFixtureAtCheckpoint(launchedFixture.identity, launchedFixture.broker, launchedFixture.paths);
    await waitFor(async () => (await readBrokerJson(launchedFixture.paths.launchPath)) ? {} : null, "detached broker commit");
    const allocation = await readBrokerJson(launchedFixture.paths.allocationPath) as { target?: Partial<TmuxTarget> };
    if (!allocation.target?.paneId || !allocation.target.panePid || !allocation.target.serverPid) throw new Error("missing exact tmux allocation");
    target = { paneId: allocation.target.paneId, panePid: allocation.target.panePid, serverPid: allocation.target.serverPid, socketPath: allocation.target.socketPath };
    evidence.allocation = target;
    await publishGate(launchedFixture.paths, launchedFixture.identity.runId, "tmux-pane");
    await waitFor(async () => fs.existsSync(path.join(launchedFixture.paths.runDir, "fixture-child-started")) ? {} : null, "gated fixture child");
    await assertFreshFixtureParentLease(launchedFixture.paths, launchedFixture.identity);
    const fixtureTerminationState = verifyFixtureTerminationState(launchedFixture.identity);
    if (!fixtureTerminationState) throw new Error("fixture parent is not verified absent or zombie immediately before reaper");
    evidence.fixtureTerminationState = fixtureTerminationState;
    const reaped = await reapStaleInteractiveRuns({ rootDir: launchedFixture.paths.rootDir, staleAfterMs: LIVE_REAPER_LEASE_FRESHNESS_MS, diagnosticRetentionSeconds: 1, scheduleCleanup: () => undefined });
    assertFixtureRunReaped(launchedFixture.identity.runId, reaped);
    const targetAbsent = (await probeTmuxPanePair(tmux, socket, { id: target.paneId, pid: target.panePid })) === "absent";
    const sourceAndSentinelPreserved = (await probeTmuxPanePair(tmux, socket, source)) === "present" && (await probeTmuxPanePair(tmux, socket, sentinel)) === "present";
    if (!targetAbsent) throw new Error("recorded child pane is still present after reaper");
    if (!sourceAndSentinelPreserved) throw new Error("source or sentinel pane changed during isolated acceptance");
    Object.assign(evidence, { reaped, targetAbsent, sourceAndSentinelPreserved, outcome: "passed" });
  } finally {
    // Read before and after process reconciliation: a resumed broker can
    // durably publish allocation while the main-path launch wait times out.
    const trackedPaths = paths ?? fixture.paths;
    const durableBeforeCleanup = await durableTmuxTarget(trackedPaths).catch(() => null);
    const fixtureProcesses = await cleanupFixtureProcesses(fixture).catch(() => ({ broker: { state: "identity-lost", allocationPublished: false, canFinishCleanup: false } as BrokerReconciliation, parent: false }));
    const durableTarget = await durableTmuxTarget(trackedPaths).catch(() => null);
    target = durableTarget ?? durableBeforeCleanup ?? target;
    const residualRisk = trackedPaths ? await readBrokerJson(trackedPaths.residualRiskPath).catch(() => null) : null;
    const canExactCleanTarget = fixtureProcesses.broker.allocationPublished && fixtureProcesses.broker.state !== "residual-risk";
    const canFinishBackendTeardown = fixtureProcesses.parent === true && fixtureProcesses.broker.canFinishCleanup;
    const cleanup = {
      fixtureProcesses,
      target: target && tmux && canExactCleanTarget ? await cleanupTmuxTarget(tmux, socket, target, source ?? undefined).catch(() => false) : target ? "broker-unreconciled" : canFinishBackendTeardown ? "not-required" : "unrecorded-risk",
      server: serverStarted && tmux && serverPid !== null && canFinishBackendTeardown ? await tmuxServerAbsent(tmux, root, socket, serverPid).catch(() => false) : serverStarted ? "broker-unreconciled" : "not-started",
    };
    evidence.targetAbsent = cleanup.target === true || cleanup.target === "not-required";
    cleanupFailed = fixtureProcesses.parent !== true || !fixtureProcesses.broker.canFinishCleanup || (cleanup.target !== true && cleanup.target !== "not-required") || (serverStarted && cleanup.server !== true) || residualRisk !== null;
    if (cleanupFailed) {
      retainRoot = true;
      evidence.outcome = "failed";
      evidence.residual = residualRisk ? "broker reported residual allocation risk" : "isolated tmux cleanup could not prove exact recorded target/server absence";
      process.exitCode = 1;
    }
    evidence.cleanup = cleanup;
    await writeEvidence(root, evidence).catch(() => undefined);
    printEvidence({ ...options, keep: retainRoot }, root, evidence);
    if (!retainRoot) await fs.promises.rm(root, { recursive: true, force: true });
  }
  if (cleanupFailed) throw new Error("tmux acceptance cleanup was not proven; evidence root retained");
}

export interface CmuxWorkspaceIdentity extends CmuxIdentity { name: string }
export type CmuxWorkspaceProbe = "present" | "absent" | "unknown";
export type CmuxWorkspaceCreation =
  | { state: "created"; workspace: CmuxWorkspaceIdentity; recovery: "response-verified-tree" | "named-tree" | "nonzero-response-named-tree" }
  | { state: "unresolved"; recovery: "absent" | "ambiguous" | "unknown" };

type CmuxTreeWorkspace = CmuxWorkspaceIdentity;
type CanonicalCmuxWorkspaceTopology = {
  workspaceId: string;
  name: string;
  panes: Array<{ paneId: string; surfaceIds: string[] }>;
};

/** This is the exact cmux 0.64.20 JSON CLI shape used by the isolated harness. */
export function buildCmuxNewWorkspaceArgs(name: string, cwd: string): string[] {
  return ["--json", "--id-format", "both", "new-workspace", "--name", name, "--cwd", cwd, "--focus", "false"];
}

function cmuxJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function cmuxString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function parseCmuxWorkspaceResponse(stdout: string, name: string): CmuxWorkspaceIdentity | null {
  const parsed = cmuxJsonRecord(stdout);
  const record = parsed?.result && typeof parsed.result === "object" && !Array.isArray(parsed.result)
    ? parsed.result as Record<string, unknown> : parsed;
  if (!record) return null;
  const workspaceId = cmuxString(record, "workspace_id");
  const paneId = cmuxString(record, "pane_id");
  const surfaceId = cmuxString(record, "surface_id");
  return workspaceId && paneId && surfaceId && [workspaceId, paneId, surfaceId].every(isCanonicalCmuxId)
    ? { workspaceId, paneId, surfaceId, name } : null;
}

/** Parses only canonical `tree --all` topology; malformed output is unknown. */
export function parseCanonicalCmuxWorkspaces(stdout: string): CmuxTreeWorkspace[] | null {
  const tree = cmuxJsonRecord(stdout);
  if (!tree || !Array.isArray(tree.windows)) return null;
  const workspaces: CmuxTreeWorkspace[] = [];
  for (const window of tree.windows) {
    if (!window || typeof window !== "object" || Array.isArray(window) || !Array.isArray((window as Record<string, unknown>).workspaces)) return null;
    for (const workspace of (window as { workspaces: unknown[] }).workspaces) {
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return null;
      const ws = workspace as Record<string, unknown>;
      const workspaceId = cmuxString(ws, "id");
      const name = cmuxString(ws, "name") ?? cmuxString(ws, "title");
      if (!workspaceId || !isCanonicalCmuxId(workspaceId) || !name || !Array.isArray(ws.panes)) return null;
      const panes = ws.panes;
      if (panes.length !== 1) { continue; }
      const pane = panes[0];
      if (!pane || typeof pane !== "object" || Array.isArray(pane)) return null;
      const paneRecord = pane as Record<string, unknown>;
      const paneId = cmuxString(paneRecord, "id");
      if (!paneId || !isCanonicalCmuxId(paneId) || !Array.isArray(paneRecord.surfaces) || paneRecord.surfaces.length !== 1) return null;
      const surface = paneRecord.surfaces[0];
      if (!surface || typeof surface !== "object" || Array.isArray(surface)) return null;
      const surfaceRecord = surface as Record<string, unknown>;
      const surfaceId = cmuxString(surfaceRecord, "id");
      if (!surfaceId || !isCanonicalCmuxId(surfaceId) || !cmuxIdsEqual(surfaceRecord.pane_id, paneId)) return null;
      workspaces.push({ workspaceId, paneId, surfaceId, name });
    }
  }
  return workspaces;
}

export function recoverNamedCmuxWorkspace(stdout: string, name: string): CmuxWorkspaceCreation | null {
  const workspaces = parseCanonicalCmuxWorkspaces(stdout);
  if (workspaces === null) return { state: "unresolved", recovery: "unknown" };
  const matches = workspaces.filter((workspace) => workspace.name === name);
  if (matches.length === 0) return { state: "unresolved", recovery: "absent" };
  if (matches.length !== 1) return { state: "unresolved", recovery: "ambiguous" };
  return { state: "created", workspace: matches[0]!, recovery: "named-tree" };
}

/** Resolves the caller pane only from a fully canonical workspace tree. */
export function findCanonicalCmuxIdentity(stdout: string, workspaceId: string, surfaceId: string): CmuxIdentity | null {
  const tree = cmuxJsonRecord(stdout);
  if (!tree || !Array.isArray(tree.windows) || !isCanonicalCmuxId(workspaceId) || !isCanonicalCmuxId(surfaceId)) return null;
  let match: CmuxIdentity | null = null;
  for (const window of tree.windows) {
    if (!window || typeof window !== "object" || Array.isArray(window) || !Array.isArray((window as Record<string, unknown>).workspaces)) return null;
    for (const workspace of (window as { workspaces: unknown[] }).workspaces) {
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return null;
      const ws = workspace as Record<string, unknown>;
      const currentWorkspaceId = cmuxString(ws, "id");
      if (!currentWorkspaceId || !isCanonicalCmuxId(currentWorkspaceId) || !Array.isArray(ws.panes)) return null;
      for (const pane of ws.panes) {
        if (!pane || typeof pane !== "object" || Array.isArray(pane)) return null;
        const paneRecord = pane as Record<string, unknown>;
        const paneId = cmuxString(paneRecord, "id");
        if (!paneId || !isCanonicalCmuxId(paneId) || !Array.isArray(paneRecord.surfaces)) return null;
        for (const surface of paneRecord.surfaces) {
          if (!surface || typeof surface !== "object" || Array.isArray(surface)) return null;
          const surfaceRecord = surface as Record<string, unknown>;
          const currentSurfaceId = cmuxString(surfaceRecord, "id");
          if (!currentSurfaceId || !isCanonicalCmuxId(currentSurfaceId) || !cmuxIdsEqual(surfaceRecord.pane_id, paneId)) return null;
          if (cmuxIdsEqual(currentWorkspaceId, workspaceId) && cmuxIdsEqual(currentSurfaceId, surfaceId)) {
            if (match) return null;
            match = { workspaceId, paneId, surfaceId };
          }
        }
      }
    }
  }
  return match;
}

const CMUX_WORKSPACE_STABILIZATION_SNAPSHOTS = 3;
const CMUX_WORKSPACE_STABILIZATION_POLL_MS = 50;

type CmuxCommandResult = { code: number; stdout: string; stderr: string };
type CmuxCommandRunner = (args: string[]) => Promise<CmuxCommandResult>;

/** Hard-stop all later cmux commands after caller identity overlap is observed. */
export function createCmuxCommandGate(cmuxRun: CmuxCommandRunner): { run: CmuxCommandRunner; hardStop: () => void; readonly stopped: boolean } {
  let stopped = false;
  return {
    run: async (args) => stopped
      ? { code: 1, stdout: "", stderr: "cmux commands suppressed after caller identity overlap" }
      : await cmuxRun(args),
    hardStop: () => { stopped = true; },
    get stopped() { return stopped; },
  };
}

/**
 * Reconcile only one exact harness name. cmux has no publication barrier, so
 * canonical zero-match snapshots remain unresolved rather than proving absence.
 */
export async function reconcileAcceptanceCmuxWorkspace(
  cmuxRun: CmuxCommandRunner,
  name: string,
  snapshots = CMUX_WORKSPACE_STABILIZATION_SNAPSHOTS,
): Promise<CmuxWorkspaceCreation> {
  for (let snapshot = 0; snapshot < snapshots; snapshot += 1) {
    const tree = await cmuxRun(["--json", "--id-format", "both", "tree", "--all"]).catch(() => null);
    if (tree === null || tree.code !== 0) return { state: "unresolved", recovery: "unknown" };
    const recovered = recoverNamedCmuxWorkspace(tree.stdout, name)!;
    if (recovered.state !== "unresolved" || recovered.recovery !== "absent") return recovered;
    if (snapshot + 1 < snapshots) await new Promise((resolve) => setTimeout(resolve, CMUX_WORKSPACE_STABILIZATION_POLL_MS));
  }
  return { state: "unresolved", recovery: "absent" };
}

export async function createAcceptanceCmuxWorkspace(
  cmuxRun: CmuxCommandRunner,
  name: string,
  cwd: string,
): Promise<CmuxWorkspaceCreation> {
  const created = await cmuxRun(buildCmuxNewWorkspaceArgs(name, cwd)).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  const recovered = await reconcileAcceptanceCmuxWorkspace(cmuxRun, name, created.code !== 0 ? CMUX_WORKSPACE_STABILIZATION_SNAPSHOTS : 1);
  if (recovered.state !== "created") return recovered;
  if (created.code !== 0) return { state: "created", workspace: recovered.workspace, recovery: "nonzero-response-named-tree" };
  const direct = parseCmuxWorkspaceResponse(created.stdout, name);
  if (!direct) return recovered;
  const sameIdentity = cmuxIdsEqual(direct.workspaceId, recovered.workspace.workspaceId)
    && cmuxIdsEqual(direct.paneId, recovered.workspace.paneId) && cmuxIdsEqual(direct.surfaceId, recovered.workspace.surfaceId);
  return sameIdentity
    ? { state: "created", workspace: recovered.workspace, recovery: "response-verified-tree" }
    // Canonical listing, not a response, supplies cleanup authority.
    : recovered;
}

/** Lists every workspace ID only after validating all canonical tree links. */
export function parseCanonicalCmuxWorkspaceIds(stdout: string): string[] | null {
  const tree = cmuxJsonRecord(stdout);
  if (!tree || !Array.isArray(tree.windows)) return null;
  const ids: string[] = [];
  for (const window of tree.windows) {
    if (!window || typeof window !== "object" || Array.isArray(window) || !Array.isArray((window as Record<string, unknown>).workspaces)) return null;
    for (const workspace of (window as { workspaces: unknown[] }).workspaces) {
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return null;
      const ws = workspace as Record<string, unknown>;
      const workspaceId = cmuxString(ws, "id");
      if (!workspaceId || !isCanonicalCmuxId(workspaceId) || !Array.isArray(ws.panes)) return null;
      for (const pane of ws.panes) {
        if (!pane || typeof pane !== "object" || Array.isArray(pane)) return null;
        const paneRecord = pane as Record<string, unknown>;
        const paneId = cmuxString(paneRecord, "id");
        if (!paneId || !isCanonicalCmuxId(paneId) || !Array.isArray(paneRecord.surfaces)) return null;
        for (const surface of paneRecord.surfaces) {
          if (!surface || typeof surface !== "object" || Array.isArray(surface)) return null;
          const surfaceRecord = surface as Record<string, unknown>;
          const surfaceId = cmuxString(surfaceRecord, "id");
          if (!surfaceId || !isCanonicalCmuxId(surfaceId) || !cmuxIdsEqual(surfaceRecord.pane_id, paneId)) return null;
        }
      }
      ids.push(workspaceId);
    }
  }
  return ids;
}

export async function probeCmuxWorkspace(
  cmux: string,
  workspaceId: string,
  cmuxRun: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = (args) => run(cmux, args),
): Promise<CmuxWorkspaceProbe> {
  const result = await cmuxRun(["--json", "--id-format", "both", "tree", "--all"]);
  const workspaceIds = result.code === 0 ? parseCanonicalCmuxWorkspaceIds(result.stdout) : null;
  if (!workspaceIds) return "unknown";
  return workspaceIds.some((id) => cmuxIdsEqual(id, workspaceId)) ? "present" : "absent";
}

export function hasOverlappingCmuxIdentity(target: CmuxIdentity, caller: CmuxIdentity): boolean {
  const targetIds = [target.workspaceId, target.paneId, target.surfaceId];
  const callerIds = [caller.workspaceId, caller.paneId, caller.surfaceId];
  return targetIds.some((targetId) => callerIds.some((callerId) => cmuxIdsEqual(targetId, callerId)));
}

export function requireDisjointAcceptanceCmuxWorkspace(acceptance: CmuxIdentity, caller: CmuxIdentity): void {
  if (hasOverlappingCmuxIdentity(acceptance, caller)) throw new Error("acceptance workspace overlaps caller cmux identity");
}

function isCallerCmuxIdentity(target: CmuxIdentity, caller: CmuxIdentity): boolean {
  return hasOverlappingCmuxIdentity(target, caller);
}

/**
 * Parse every workspace/pane/surface in the full 0.64.20 tree. Duplicate IDs,
 * malformed links, or incomplete topology are unknown, never cleanup authority.
 */
function parseStrictCanonicalCmuxWorkspaceTopology(stdout: string): CanonicalCmuxWorkspaceTopology[] | null {
  const tree = cmuxJsonRecord(stdout);
  if (!tree || !Array.isArray(tree.windows)) return null;
  const allIds = new Set<string>();
  const workspaces: CanonicalCmuxWorkspaceTopology[] = [];
  for (const window of tree.windows) {
    if (!window || typeof window !== "object" || Array.isArray(window) || !Array.isArray((window as Record<string, unknown>).workspaces)) return null;
    for (const workspace of (window as { workspaces: unknown[] }).workspaces) {
      if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return null;
      const record = workspace as Record<string, unknown>;
      const workspaceId = cmuxString(record, "id");
      const name = cmuxString(record, "name") ?? cmuxString(record, "title");
      if (!workspaceId || !isCanonicalCmuxId(workspaceId) || !name || !Array.isArray(record.panes)) return null;
      const workspaceKey = workspaceId.toLowerCase();
      if (allIds.has(workspaceKey)) return null;
      allIds.add(workspaceKey);
      const panes: CanonicalCmuxWorkspaceTopology["panes"] = [];
      for (const pane of record.panes) {
        if (!pane || typeof pane !== "object" || Array.isArray(pane)) return null;
        const paneRecord = pane as Record<string, unknown>;
        const paneId = cmuxString(paneRecord, "id");
        if (!paneId || !isCanonicalCmuxId(paneId) || !Array.isArray(paneRecord.surfaces)) return null;
        const paneKey = paneId.toLowerCase();
        if (allIds.has(paneKey)) return null;
        allIds.add(paneKey);
        const surfaceIdsForPane: string[] = [];
        for (const surface of paneRecord.surfaces) {
          if (!surface || typeof surface !== "object" || Array.isArray(surface)) return null;
          const surfaceRecord = surface as Record<string, unknown>;
          const surfaceId = cmuxString(surfaceRecord, "id");
          if (!surfaceId || !isCanonicalCmuxId(surfaceId) || !cmuxIdsEqual(surfaceRecord.pane_id, paneId)) return null;
          const surfaceKey = surfaceId.toLowerCase();
          if (allIds.has(surfaceKey)) return null;
          allIds.add(surfaceKey);
          surfaceIdsForPane.push(surfaceId);
        }
        panes.push({ paneId, surfaceIds: surfaceIdsForPane });
      }
      workspaces.push({ workspaceId, name, panes });
    }
  }
  return workspaces;
}

/**
 * cmux 0.64.20 close-surface can leave its empty workspace intact. Before the
 * sole mutating command, prove the recorded workspace UUID and unique name
 * describe exactly one singleton pane/surface topology disjoint from caller.
 */
export async function closeAcceptanceCmuxWorkspaceAfterSingletonProof(
  cmux: string,
  acceptance: CmuxWorkspaceIdentity,
  caller: CmuxIdentity,
  cmuxRun: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = (args) => run(cmux, args),
): Promise<boolean> {
  if (![acceptance.workspaceId, acceptance.paneId, acceptance.surfaceId, caller.workspaceId, caller.paneId, caller.surfaceId].every(isCanonicalCmuxId)
    || isCallerCmuxIdentity(acceptance, caller)) return false;
  const before = await cmuxRun(["--json", "--id-format", "both", "tree", "--all"]);
  const topology = before.code === 0 ? parseStrictCanonicalCmuxWorkspaceTopology(before.stdout) : null;
  if (!topology) return false;
  const workspaceById = topology.filter((workspace) => cmuxIdsEqual(workspace.workspaceId, acceptance.workspaceId));
  const workspaceByName = topology.filter((workspace) => workspace.name === acceptance.name);
  if (workspaceById.length !== 1 || workspaceByName.length !== 1 || workspaceById[0] !== workspaceByName[0]) return false;
  const workspace = workspaceById[0]!;
  const pane = workspace.panes[0];
  if (workspace.panes.length !== 1 || !pane || !cmuxIdsEqual(pane.paneId, acceptance.paneId)
    || pane.surfaceIds.length !== 1 || !cmuxIdsEqual(pane.surfaceIds[0], acceptance.surfaceId)) return false;
  if ((await cmuxRun(["close-workspace", "--workspace", acceptance.workspaceId])).code !== 0) return false;
  const after = await cmuxRun(["--json", "--id-format", "both", "tree", "--all"]);
  const afterTopology = after.code === 0 ? parseStrictCanonicalCmuxWorkspaceTopology(after.stdout) : null;
  return afterTopology !== null && !afterTopology.some((candidate) => cmuxIdsEqual(candidate.workspaceId, acceptance.workspaceId));
}

export async function verifyCmuxCallerPreserved(
  cmux: string,
  caller: CmuxSurfaceIdentity,
  cmuxRun: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = (args) => run(cmux, args),
): Promise<boolean> {
  const result = await cmuxRun(["--json", "--id-format", "both", "tree", "--workspace", caller.workspaceId]);
  return result.code === 0 && inspectCanonicalCmuxSurfaceTree(result.stdout, caller.workspaceId, caller.surfaceId)?.exists === true;
}

async function inspectCmuxTarget(
  cmux: string,
  target: CmuxSurfaceIdentity,
  cmuxRun: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = (args) => run(cmux, args),
): Promise<{ exists: boolean; paneId?: string } | undefined> {
  const result = await cmuxRun(["--json", "--id-format", "both", "tree", "--workspace", target.workspaceId]);
  if (result.code !== 0) return undefined;
  // Production's strict canonical-topology parser deliberately makes malformed
  // or incomplete responses unknown, never proof of absence.
  const snapshot = inspectCanonicalCmuxSurfaceTree(result.stdout, target.workspaceId, target.surfaceId);
  if (!snapshot?.exists) return snapshot;
  const identity = findCanonicalCmuxIdentity(result.stdout, target.workspaceId, target.surfaceId);
  return identity ? { ...snapshot, paneId: identity.paneId } : undefined;
}

/**
 * A sentinel response is not authority until the canonical topology repeats
 * every response ID. Any overlap activates the shared command hard-stop before
 * throwing, so finalization cannot issue a later cmux command.
 */
export async function requireVerifiedAcceptanceCmuxSentinel(
  cmux: string,
  sentinel: CmuxIdentity,
  acceptance: CmuxWorkspaceIdentity,
  caller: CmuxIdentity,
  cmuxRun: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = (args) => run(cmux, args),
  hardStopOnIdentityOverlap: () => void,
): Promise<void> {
  const overlapsAcceptanceSource = cmuxIdsEqual(sentinel.surfaceId, acceptance.surfaceId) || cmuxIdsEqual(sentinel.paneId, acceptance.paneId);
  const overlapsCaller = hasOverlappingCmuxIdentity(sentinel, caller);
  if (overlapsAcceptanceSource || overlapsCaller) {
    hardStopOnIdentityOverlap();
    throw new Error("sentinel response overlaps an acceptance source or caller cmux identity");
  }
  if (![sentinel.workspaceId, sentinel.surfaceId, sentinel.paneId].every(isCanonicalCmuxId)
    || !cmuxIdsEqual(sentinel.workspaceId, acceptance.workspaceId)) {
    throw new Error("sentinel response is not a disjoint canonical acceptance identity");
  }
  const inspected = await inspectCmuxTarget(cmux, sentinel, cmuxRun);
  // The workspace and surface are the exact canonical query arguments; the
  // returned pane completes the response-to-topology identity comparison.
  if (inspected?.exists !== true || !cmuxIdsEqual(inspected.paneId, sentinel.paneId)) {
    throw new Error("sentinel response does not exactly match canonical topology");
  }
}

/** Never issue a surface close outside the isolated workspace or for caller IDs. */
export async function cleanupAcceptanceCmuxTarget(
  cmux: string,
  target: CmuxTarget,
  acceptance: CmuxWorkspaceIdentity,
  caller: CmuxIdentity,
  cmuxRun: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }> = (args) => run(cmux, args),
): Promise<boolean> {
  if (!isCanonicalCmuxId(target.workspaceId) || !isCanonicalCmuxId(target.surfaceId) || !isCanonicalCmuxId(target.paneId)
    || !cmuxIdsEqual(target.workspaceId, acceptance.workspaceId) || cmuxIdsEqual(target.surfaceId, acceptance.surfaceId) || isCallerCmuxIdentity(target, caller)) return false;
  const before = await inspectCmuxTarget(cmux, target, cmuxRun);
  if (before?.exists === false) return true;
  if (before?.exists !== true || !cmuxIdsEqual(before.paneId, target.paneId)) return false;
  if ((await cmuxRun(["close-surface", "--workspace", target.workspaceId, "--surface", target.surfaceId])).code !== 0) return false;
  return (await inspectCmuxTarget(cmux, target, cmuxRun))?.exists === false;
}

async function runCmuxLive(options: HarnessOptions): Promise<void> {
  requireLiveGate("cmux");
  const callerWorkspaceId = process.env.CMUX_WORKSPACE_ID?.trim(), callerSurfaceId = process.env.CMUX_SURFACE_ID?.trim();
  if (!callerWorkspaceId || !callerSurfaceId || !isCanonicalCmuxId(callerWorkspaceId) || !isCanonicalCmuxId(callerSurfaceId)) throw new Error("run from a cmux terminal with canonical CMUX_WORKSPACE_ID and CMUX_SURFACE_ID");
  const cmux = backend("cmux-pane");
  const runtime = brokerRuntime(), runtimeInterpreter = brokerRuntimeInterpreter(runtime);
  const parsedVersion = parseRequiredCmuxVersion((await run(cmux, ["--version"])).stdout);
  if (parsedVersion === null) throw new Error("cmux acceptance requires exact version 0.64.20");
  const root = await privateTempRoot("pi-subagent-accept-cmux");
  const workspaceName = `pi-subagent-accept-${crypto.randomUUID()}`;
  let caller: CmuxIdentity | null = null;
  let acceptance: CmuxWorkspaceIdentity | null = null;
  let sentinel: CmuxIdentity | null = null;
  const fixture: FixtureTracker = { child: null, parent: null, broker: null, paths: null };
  let paths: RunArtifactPaths | null = null;
  let target: CmuxTarget | null = null;
  let allocationAuthority: CmuxAllocationAuthority = { state: "no-allocation" };
  let workspaceUnresolved = false;
  let sentinelResponseUnresolved = false;
  let retainRoot = options.keep;
  let cleanupFailed = false;
  let identityOverlapHardStop = false;
  const cmuxCommandGate = createCmuxCommandGate((args) => run(cmux, args));
  const hardStopIdentityOverlap = () => {
    identityOverlapHardStop = true;
    cmuxCommandGate.hardStop();
    retainRoot = true;
    evidence.residual = "acceptance source/sentinel overlaps caller identity; all later cmux commands suppressed";
  };
  const evidence: Record<string, unknown> = { mode: "cmux", cmuxVersion: parsedVersion, workspaceName, caller: { workspaceId: callerWorkspaceId, surfaceId: callerSurfaceId }, outcome: "failed" };
  try {
    // The caller is observation-only. Resolve all three canonical IDs before
    // creation so every later destructive target can reject each one.
    const callerTree = await cmuxCommandGate.run(["--json", "--id-format", "both", "tree", "--workspace", callerWorkspaceId]);
    caller = callerTree.code === 0 ? findCanonicalCmuxIdentity(callerTree.stdout, callerWorkspaceId, callerSurfaceId) : null;
    if (!caller) throw new Error("caller cmux surface/pane is absent from canonical topology");
    evidence.caller = caller;
    evidence.callerBefore = "present";
    const creation = await createAcceptanceCmuxWorkspace(cmuxCommandGate.run, workspaceName, root);
    if (creation.state !== "created") {
      workspaceUnresolved = true;
      evidence.workspaceCreation = creation;
      throw new Error(`cmux workspace creation response recovery is ${creation.recovery}`);
    }
    acceptance = creation.workspace;
    // This must be the first action after create/recovery. The harness never
    // sends a sentinel split, fixture launch, respawn, or cleanup command when
    // the supposedly isolated workspace overlaps any caller identity.
    if (hasOverlappingCmuxIdentity(acceptance, caller)) {
      hardStopIdentityOverlap();
      throw new Error("acceptance workspace overlaps caller cmux identity");
    }
    Object.assign(evidence, { acceptanceWorkspace: acceptance, workspaceRecovery: creation.recovery });
    if ((await inspectCmuxTarget(cmux, { workspaceId: acceptance.workspaceId, surfaceId: acceptance.surfaceId }, cmuxCommandGate.run))?.exists !== true) throw new Error("acceptance workspace initial source surface is absent from canonical topology");
    const sentinelResult = await cmuxCommandGate.run(buildCmuxNewSplitArgs({ workspaceId: acceptance.workspaceId, sourceSurfaceId: acceptance.surfaceId }));
    const createdSentinel = sentinelResult.code === 0 ? parseCreatedCmuxSurface(sentinelResult.stdout, acceptance.workspaceId) : null;
    if (!createdSentinel || !isCanonicalCmuxId(createdSentinel.workspaceId) || !isCanonicalCmuxId(createdSentinel.surfaceId) || !createdSentinel.paneId || !isCanonicalCmuxId(createdSentinel.paneId) || !cmuxIdsEqual(createdSentinel.workspaceId, acceptance.workspaceId)) {
      sentinelResponseUnresolved = sentinelResult.code === 0;
      if (sentinelResponseUnresolved) evidence.residual = "successful cmux sentinel create had an unparseable response";
      throw new Error("could not create canonical harness-owned cmux sentinel");
    }
    const sentinelResponse = { workspaceId: createdSentinel.workspaceId, surfaceId: createdSentinel.surfaceId, paneId: createdSentinel.paneId };
    // No fixture, respawn, or other main-path mutation follows until the split
    // response is disjoint from the caller and exactly repeated by topology.
    await requireVerifiedAcceptanceCmuxSentinel(cmux, sentinelResponse, acceptance, caller, cmuxCommandGate.run, hardStopIdentityOverlap);
    sentinel = sentinelResponse;
    if ((await inspectCmuxTarget(cmux, { workspaceId: acceptance.workspaceId, surfaceId: acceptance.surfaceId }, cmuxCommandGate.run))?.exists !== true) throw new Error("acceptance workspace initial source surface is not stable before acceptance");
    const launchedFixture = await spawnFixture({ root, mode: "cmux-pane", workspaceId: acceptance.workspaceId, sourceSurfaceId: acceptance.surfaceId, runtime, runtimeInterpreter, backend: cmux, brokerEntrypoint: path.join(ROOT, BROKER_RELATIVE), checkpoint: "ready-before-allocation" }, fixture);
    paths = launchedFixture.paths;
    Object.assign(evidence, { runId: launchedFixture.identity.runId, parent: launchedFixture.identity, broker: launchedFixture.broker, source: { workspaceId: acceptance.workspaceId, surfaceId: acceptance.surfaceId }, sentinel });
    await waitFor(async () => {
      const status = await readBrokerJson(launchedFixture.paths.brokerStatusPath) as { phase?: unknown } | null;
      return status?.phase === "ready" ? {} : null;
    }, "broker ready checkpoint");
    await signalFixtureAtCheckpoint(launchedFixture.identity, launchedFixture.broker, launchedFixture.paths);
    await waitFor(async () => (await readBrokerJson(launchedFixture.paths.launchPath)) ? {} : null, "detached broker commit");
    allocationAuthority = await durableCmuxTarget(launchedFixture.paths, acceptance, caller);
    if (allocationAuthority.state !== "authorized") {
      evidence.allocationAuthority = allocationAuthority;
      throw new Error("cmux durable allocation is not bound to the isolated acceptance workspace");
    }
    target = allocationAuthority.target;
    evidence.allocation = target;
    await publishGate(launchedFixture.paths, launchedFixture.identity.runId, "cmux-pane");
    const respawn = await cmuxCommandGate.run(buildCmuxRespawnPaneArgs(target.workspaceId, target.surfaceId, launchedFixture.paths.wrapperPath));
    if (respawn.code !== 0) throw new Error("cmux sanitized respawn failed");
    await waitFor(async () => fs.existsSync(path.join(launchedFixture.paths.runDir, "fixture-child-started")) ? {} : null, "gated fixture child");
    await assertFreshFixtureParentLease(launchedFixture.paths, launchedFixture.identity);
    const fixtureTerminationState = verifyFixtureTerminationState(launchedFixture.identity);
    if (!fixtureTerminationState) throw new Error("fixture parent is not verified absent or zombie immediately before reaper");
    evidence.fixtureTerminationState = fixtureTerminationState;
    const reaped = await reapStaleInteractiveRuns({
      rootDir: launchedFixture.paths.rootDir,
      staleAfterMs: LIVE_REAPER_LEASE_FRESHNESS_MS,
      diagnosticRetentionSeconds: 1,
      scheduleCleanup: () => undefined,
      cmuxRun: async (args) => {
        const result = await cmuxCommandGate.run(args);
        return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr, aborted: false };
      },
    });
    assertFixtureRunReaped(launchedFixture.identity.runId, reaped);
    const targetAbsent = (await inspectCmuxTarget(cmux, target, cmuxCommandGate.run))?.exists === false;
    const sourceAndSentinelPreserved = (await inspectCmuxTarget(cmux, { workspaceId: acceptance.workspaceId, surfaceId: acceptance.surfaceId }, cmuxCommandGate.run))?.exists === true && (await inspectCmuxTarget(cmux, sentinel, cmuxCommandGate.run))?.exists === true;
    if (!targetAbsent) throw new Error("recorded cmux target is still present after reaper");
    if (!sourceAndSentinelPreserved) throw new Error("acceptance source or harness-owned sentinel changed during acceptance");
    Object.assign(evidence, { reaped, targetAbsent, sourceAndSentinelPreserved, outcome: "passed" });
  } finally {
    // A late cmux publication can appear after initial recovery returned zero
    // matches. Reconcile its exact private name again, but retain failure
    // evidence because cmux offers no publication barrier.
    if (!identityOverlapHardStop && !acceptance && workspaceUnresolved) {
      const recovered = await reconcileAcceptanceCmuxWorkspace(cmuxCommandGate.run, workspaceName).catch(() => ({ state: "unresolved", recovery: "unknown" } as CmuxWorkspaceCreation));
      evidence.teardownWorkspaceRecovery = recovered;
      if (recovered.state === "created") acceptance = recovered.workspace;
    }
    const trackedPaths = paths ?? fixture.paths;
    const durableBeforeCleanup = await durableCmuxTarget(trackedPaths, acceptance, caller ?? { workspaceId: callerWorkspaceId, surfaceId: callerSurfaceId, paneId: "" }).catch(() => ({ state: "unresolved", reason: "invalid-allocation" } as CmuxAllocationAuthority));
    const fixtureProcesses = await cleanupFixtureProcesses(fixture).catch(() => ({ broker: { state: "identity-lost", allocationPublished: false, canFinishCleanup: false } as BrokerReconciliation, parent: false }));
    const durableAfterCleanup = await durableCmuxTarget(trackedPaths, acceptance, caller ?? { workspaceId: callerWorkspaceId, surfaceId: callerSurfaceId, paneId: "" }).catch(() => ({ state: "unresolved", reason: "invalid-allocation" } as CmuxAllocationAuthority));
    const observedAuthorities = [allocationAuthority, durableBeforeCleanup, durableAfterCleanup];
    const unresolvedAuthority = observedAuthorities.find((authority): authority is Extract<CmuxAllocationAuthority, { state: "unresolved" }> => authority.state === "unresolved");
    const authorizedAuthority = observedAuthorities.find((authority): authority is Extract<CmuxAllocationAuthority, { state: "authorized" }> => authority.state === "authorized");
    target = authorizedAuthority?.target ?? target;
    const residualRisk = trackedPaths ? await readBrokerJson(trackedPaths.residualRiskPath).catch(() => null) : null;
    const canExactCleanTarget = fixtureProcesses.broker.allocationPublished && fixtureProcesses.broker.state !== "residual-risk" && !unresolvedAuthority;
    const canFinishBackendTeardown = fixtureProcesses.parent === true && fixtureProcesses.broker.canFinishCleanup;
    const targetCleanup = identityOverlapHardStop ? "identity-overlap-hard-stop" : unresolvedAuthority ? "non-authority" : target && acceptance && caller && canExactCleanTarget ? await cleanupAcceptanceCmuxTarget(cmux, target, acceptance, caller, cmuxCommandGate.run).catch(() => false) : target ? "broker-unreconciled" : canFinishBackendTeardown ? "not-required" : "unrecorded-risk";
    const sentinelCleanup = identityOverlapHardStop ? "identity-overlap-hard-stop" : sentinel && acceptance && caller && canFinishBackendTeardown ? await cleanupAcceptanceCmuxTarget(cmux, sentinel, acceptance, caller, cmuxCommandGate.run).catch(() => false) : sentinel ? "broker-unreconciled" : sentinelResponseUnresolved ? "unresolved-response" : "not-created";
    const targetProven = targetCleanup === true || targetCleanup === "not-required";
    const sentinelProven = sentinel ? sentinelCleanup === true : !sentinelResponseUnresolved;
    // After exact target/sentinel absence, cmux 0.64.20 requires an exact
    // singleton proof before closing the recorded private workspace itself.
    // Extra or malformed topology retains evidence without any workspace close.
    const workspaceCleanup = !identityOverlapHardStop && acceptance && caller && canFinishBackendTeardown && targetProven && sentinelProven && !unresolvedAuthority
      ? await closeAcceptanceCmuxWorkspaceAfterSingletonProof(cmux, acceptance, caller, cmuxCommandGate.run).catch(() => false)
      : acceptance ? "backend-unreconciled" : workspaceUnresolved ? "unresolved-create-response" : "not-required";
    const callerAfter = !identityOverlapHardStop && caller ? await verifyCmuxCallerPreserved(cmux, caller, cmuxCommandGate.run).catch(() => false) : false;
    const cleanup = { fixtureProcesses, allocationAuthority: unresolvedAuthority ?? authorizedAuthority ?? allocationAuthority, target: targetCleanup, sentinel: sentinelCleanup, workspace: workspaceCleanup, callerAfter };
    evidence.targetAbsent = targetCleanup === true || targetCleanup === "not-required";
    evidence.callerAfter = callerAfter ? "present" : "missing-or-unknown";
    cleanupFailed = identityOverlapHardStop || fixtureProcesses.parent !== true || !fixtureProcesses.broker.canFinishCleanup || !targetProven || !sentinelProven || (acceptance && workspaceCleanup !== true) || workspaceUnresolved || Boolean(unresolvedAuthority) || !callerAfter || residualRisk !== null;
    if (cleanupFailed) {
      retainRoot = true;
      evidence.outcome = "failed";
      evidence.residual ??= identityOverlapHardStop
        ? "acceptance source/sentinel/caller identity overlap hard-stopped all subsequent cmux commands"
        : unresolvedAuthority
        ? `durable cmux allocation retained without cleanup authority: ${unresolvedAuthority.reason}`
        : workspaceUnresolved ? "cmux workspace creation remained unresolved after exact-name reconciliation"
        : residualRisk ? "broker reported residual allocation risk"
        : "cmux cleanup could not prove exact target, sentinel, acceptance workspace, and caller preservation";
      process.exitCode = 1;
    }
    evidence.cleanup = cleanup;
    await writeEvidence(root, evidence).catch(() => undefined);
    printEvidence({ ...options, keep: retainRoot }, root, evidence);
    if (!retainRoot) await fs.promises.rm(root, { recursive: true, force: true });
  }
  if (cleanupFailed) throw new Error("cmux acceptance cleanup was not proven; evidence root retained");
}

async function packageSourceIdentifier(): Promise<Record<string, unknown>> {
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: ROOT }).catch(() => ({ code: 1, stdout: "" }));
  const dirty = await run("git", ["status", "--porcelain"], { cwd: ROOT }).catch(() => ({ code: 1, stdout: "" }));
  if (head.code === 0 && dirty.code === 0) return { gitHead: head.stdout.trim(), dirty: dirty.stdout.trim().length > 0 };
  const digest = crypto.createHash("sha256").update(await fs.promises.readFile(path.join(ROOT, "index.ts"))).digest("hex");
  return { sourceDigest: `index.ts-sha256:${digest}` };
}

async function runPackageHarness(options: HarnessOptions): Promise<void> {
  requireLiveGate("package");
  const root = await privateTempRoot("pi-subagent-accept-package");
  const evidence: Record<string, unknown> = { mode: "package", scope: "pack/install/exact-module-import/register only; not a full Pi session", timestamp: new Date().toISOString(), outcome: "failed" };
  try {
    const packRoot = path.join(root, "pack"), installRoot = path.join(root, "install");
    await fs.promises.mkdir(packRoot, { mode: 0o700 }); await fs.promises.mkdir(installRoot, { mode: 0o700 });
    // Bun 1.3.14 advertises --destination and --filename but rejects their
    // combination. Use destination alone and require exactly one tarball.
    const pack = await run("bun", ["pm", "pack", "--destination", packRoot, "--quiet"], { cwd: ROOT });
    if (pack.code !== 0) throw new Error("package pack failed");
    const tarballs = (await fs.promises.readdir(packRoot)).filter((entry) => entry.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error("package pack did not create exactly one tarball");
    const tarball = path.join(packRoot, tarballs[0]);
    const [bunVersion, source] = await Promise.all([run("bun", ["--version"]), packageSourceIdentifier()]);
    if (bunVersion.code !== 0) throw new Error("could not record Bun version");
    const tarballSha256 = crypto.createHash("sha256").update(await fs.promises.readFile(tarball)).digest("hex");
    if ((await run("bun", ["init", "-y"], { cwd: installRoot })).code !== 0 || (await run("bun", ["add", tarball], { cwd: installRoot })).code !== 0) throw new Error("isolated tarball install failed");
    // The extension declares Pi packages as optional peers. Populate the
    // isolated probe with the checkout's already-installed peer packages;
    // this supplies only the host API modules needed to import the tarball.
    const probePeers = [
      path.join(ROOT, "node_modules/typebox"),
      path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent"),
      path.join(ROOT, "node_modules/@earendil-works/pi-tui"),
    ];
    if (probePeers.some((peer) => !fs.existsSync(peer)) || (await run("bun", ["add", ...probePeers], { cwd: installRoot })).code !== 0) throw new Error("isolated registration probe peer install failed");
    const installed = path.join(installRoot, "node_modules/@mjakl/pi-subagent");
    const installedIndex = path.join(installed, "index.ts"), installedBroker = path.join(installed, BROKER_RELATIVE);
    if (!fs.existsSync(installedIndex) || !fs.existsSync(installedBroker) || path.resolve(installed) === ROOT) throw new Error("installed package paths are incomplete or point at the checkout");
    const probe = path.join(installRoot, "registration-probe.ts");
    await fs.promises.writeFile(probe, `import extension from ${JSON.stringify(installedIndex)};
const expectedFlags = ${JSON.stringify(PACKAGE_REGISTRATION_EXPECTED_FLAGS)};
const expectedEvents = ${JSON.stringify(PACKAGE_REGISTRATION_EXPECTED_EVENTS)};
const expectedTools = ${JSON.stringify(PACKAGE_REGISTRATION_EXPECTED_TOOLS)};
const assertExactRegistrationNames = ${assertExactPackageRegistrationNames.toString()};
const registeredFlags: unknown[] = [];
const registeredEvents: unknown[] = [];
const registeredTools: unknown[] = [];
const api = new Proxy({
  getFlag: (_name: string) => undefined,
  registerFlag: (name: unknown) => { registeredFlags.push(name); },
  on: (event: unknown, handler: unknown) => { if (typeof handler !== "function") throw new Error("non-function event handler"); registeredEvents.push(event); },
  registerTool: (tool: { name?: unknown }) => { registeredTools.push(tool?.name); },
}, { get(target, key, receiver) { if (typeof key !== "string" || !(key in target)) throw new Error("unexpected ExtensionAPI access: " + String(key)); return Reflect.get(target, key, receiver); } });
extension(api as never);
assertExactRegistrationNames(registeredFlags, expectedFlags, "flag");
assertExactRegistrationNames(registeredEvents, expectedEvents, "event");
assertExactRegistrationNames(registeredTools, expectedTools, "tool");
console.log("registered:subagent");
`, { mode: 0o600 });
    const registration = await run("bun", [probe], { cwd: installRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
    if (registration.code !== 0 || registration.stdout.trim() !== "registered:subagent") throw new Error("installed extension import/registration probe failed");
    const syntax = await run(brokerRuntime(), [installedBroker], { cwd: installRoot, env: minimalBrokerEnv("tmux-pane") });
    if (syntax.code !== 2) throw new Error("installed broker bootstrap did not fail closed as expected");
    Object.assign(evidence, { tarball: path.basename(tarball), tarballSha256, bunVersion: bunVersion.stdout.trim(), source, installedExtension: "node_modules/@mjakl/pi-subagent/index.ts", installedBroker: "node_modules/@mjakl/pi-subagent/src/runtime/pane-launch-broker.mjs", pack: "passed", install: "passed", import: "passed", register: "subagent", brokerBootstrap: "failed-closed-exit-2", outcome: "passed" });
  } finally {
    evidence.cleanup = options.keep ? "private temporary install retained" : "private temporary install removed";
    await writeEvidence(root, evidence).catch(() => undefined);
    printEvidence(options, root, evidence);
    if (!options.keep) await fs.promises.rm(root, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseHarnessArgs(argv);
  if (options.dryRun) {
    console.log(JSON.stringify({ mode: options.mode, dryRun: true, requiredGate: requiredLiveGate(options.mode), mutation: "none", evidence: options.keep ? "retained private evidence.json" : "redacted summary before cleanup" }));
    return;
  }
  if (options.mode === "tmux") return await runTmuxLive(options);
  if (options.mode === "cmux") return await runCmuxLive(options);
  return await runPackageHarness(options);
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
