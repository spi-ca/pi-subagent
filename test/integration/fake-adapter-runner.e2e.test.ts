import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  listActiveInteractiveRunIds,
  resetInteractivePiVersionChecksForTest,
  resetInteractiveShutdownForSession,
  runAgent,
  resolveBackendExecutable,
  shutdownActiveInteractiveRuns,
  unregisterCommittedInteractiveRun,
} from "../../src/runtime/runner";
import type { AgentConfig } from "../../src/core/agents";
import type { SingleResult, SubagentDetails } from "../../src/core/types";

const roots: string[] = [];
const original = { execPath: process.execPath, path: process.env.PATH, tmux: process.env.TMUX, tmuxPane: process.env.TMUX_PANE, stateRoot: process.env.PI_SUBAGENT_RUN_STATE_DIR, brokerRuntime: process.env.PI_SUBAGENT_BROKER_RUNTIME };

afterEach(async () => {
  await shutdownActiveInteractiveRuns().catch(() => undefined);
  await resetInteractiveShutdownForSession();
  resetInteractivePiVersionChecksForTest();
  process.execPath = original.execPath;
  for (const [name, value] of Object.entries({ PATH: original.path, TMUX: original.tmux, TMUX_PANE: original.tmuxPane, PI_SUBAGENT_RUN_STATE_DIR: original.stateRoot, PI_SUBAGENT_BROKER_RUNTIME: original.brokerRuntime })) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  while (roots.length) await fs.promises.rm(roots.pop()!, { recursive: true, force: true });
});

const agent: AgentConfig = {
  name: "fake-worker",
  description: "Deterministic fake interactive worker",
  systemPrompt: "Use the fake runner.",
  source: "user",
  filePath: "/tmp/fake-worker.md",
};

const details = (results: SingleResult[]): SubagentDetails => ({
  mode: "single",
  toolLabel: "Subagent",
  delegationMode: "spawn",
  terminalMode: "tmux-pane",
  projectAgentsDir: null,
  results,
});

async function waitFor<T>(read: () => T | null | undefined, message: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null && value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}.`);
}

async function waitForFile(filePath: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(() => fs.existsSync(filePath) ? true : null, filePath, timeoutMs);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function startSocket(socketPath: string): Promise<net.Server> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.promises.writeFile(filePath, content, { mode: 0o700 });
  await fs.promises.chmod(filePath, 0o700);
}

async function makeFakeExecutables(root: string): Promise<{ pi: string; bin: string }> {
  const bin = path.join(root, "bin");
  await fs.promises.mkdir(bin, { mode: 0o700 });
  const pi = path.join(bin, "pi");
  const broker = pathToFileURL(path.resolve("src/runtime/pane-launch-broker.mjs")).href;
  const permits = pathToFileURL(path.resolve("src/runtime/tree-permit-authority.ts")).href;
  await writeExecutable(pi, `#!/usr/bin/env bun
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { getCurrentProcessStartedAt } from ${JSON.stringify(pathToFileURL(path.resolve("src/runtime/run-protocol.ts")).href)};

const runArgument = process.argv.indexOf("--run-dir");
const logPath = runArgument >= 0 ? path.join(process.argv[runArgument + 1], "fake-pi.log") : process.env.PI_SUBAGENT_CHILD_SESSION_PATH ? path.join(path.dirname(process.env.PI_SUBAGENT_CHILD_SESSION_PATH), "fake-pi.log") : null;
if (logPath) await fs.appendFile(logPath, JSON.stringify({ pid: process.pid, argv: process.argv }) + "\\n").catch(() => undefined);
if (process.argv.includes("--version")) { console.log("0.80.10"); process.exit(0); }
if (process.argv[2] && pathToFileURL(process.argv[2]).href === ${JSON.stringify(broker)}) {
  process.argv = [process.argv[0], process.argv[2], ...process.argv.slice(3)];
  await import(${JSON.stringify(broker)});
  process.exit(process.exitCode ?? 0);
}
const env = process.env;
const state = { version: 1, runId: env.PI_SUBAGENT_RUN_ID, sequence: 1, phase: "running", updatedAt: Date.now(), childPid: process.pid, childStartedAt: getCurrentProcessStartedAt(), lastEvent: "fake-child-start" };
await fs.writeFile(env.PI_SUBAGENT_RUN_STATE_PATH, JSON.stringify(state) + "\\n", { mode: 0o600 });
const taskArg = process.argv.find((value) => value.startsWith("@"));
const task = taskArg ? await fs.readFile(taskArg.slice(1), "utf8") : "";
const marker = new URL("fake-child.json", pathToFileURL(env.PI_SUBAGENT_CHILD_SESSION_PATH)).pathname;
await fs.writeFile(marker, JSON.stringify({ pid: process.pid, task, treePermit: Boolean(env.PI_SUBAGENT_TREE_PERMIT_LEASE_ID) }) + "\\n", { mode: 0o600 });
if (task.includes("malformed completion after fence")) {
  const nonce = env.PI_SUBAGENT_COMPLETION_FENCE_NONCE;
  const fence = { version: 1, kind: "completion-fence", runId: env.PI_SUBAGENT_RUN_ID, nonce, publishedAt: Date.now() };
  await fs.writeFile(env.PI_SUBAGENT_COMPLETION_FENCE_PATH, JSON.stringify(fence) + "\\n", { mode: 0o600, flag: "wx" });
  let acknowledged;
  while (!acknowledged) {
    try {
      const candidate = JSON.parse(await fs.readFile(env.PI_SUBAGENT_COMPLETION_FENCE_ACK_PATH, "utf8"));
      acknowledged = candidate && candidate.version === 1 && candidate.kind === "completion-fence-ack" && candidate.runId === env.PI_SUBAGENT_RUN_ID && candidate.nonce === nonce;
    } catch {}
    if (!acknowledged) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const postFence = { type: "message", id: "malformed-after-fence", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "must not drain after malformed completion" }] } };
  await fs.appendFile(env.PI_SUBAGENT_CHILD_SESSION_PATH, JSON.stringify(postFence) + "\\n");
  await fs.writeFile(env.PI_SUBAGENT_RUN_COMPLETION_PATH, "{\\\"version\\\":3}\\n", { mode: 0o600, flag: "wx" });
  await new Promise(() => {});
}
if (task.includes("hold")) await new Promise(() => {});
if (task.includes("completion fence race")) {
  const runDir = path.dirname(env.PI_SUBAGENT_RUN_STATE_PATH);
  const eventsPath = path.join(path.dirname(runDir), "completion-fence-race.json");
  const events = { runId: env.PI_SUBAGENT_RUN_ID, entries: [] };
  const record = async (stage, extra = {}) => {
    events.entries.push({ stage, at: Date.now(), ...extra });
    await fs.writeFile(eventsPath, JSON.stringify(events) + "\\n", { mode: 0o600 });
  };
  const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const message = (id, text, value) => ({ type: "message", id, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text }], usage: value, stopReason: "stop" } });
  const live = message("race-live", "pre-fence visible", usage(2, 3));
  await fs.appendFile(env.PI_SUBAGENT_CHILD_SESSION_PATH, JSON.stringify(live) + "\\n");
  await record("live-appended");
  const callbackStarted = path.join(runDir, "race-callback-started");
  const callbackDeadline = Date.now() + 5_000;
  let callbackObserved = false;
  while (Date.now() < callbackDeadline) {
    try { await fs.access(callbackStarted); callbackObserved = true; break; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
  }
  await record(callbackObserved ? "callback-observed" : "callback-timeout");
  const nonce = env.PI_SUBAGENT_COMPLETION_FENCE_NONCE;
  const fence = { version: 1, kind: "completion-fence", runId: env.PI_SUBAGENT_RUN_ID, nonce, publishedAt: Date.now() };
  await fs.writeFile(env.PI_SUBAGENT_COMPLETION_FENCE_PATH, JSON.stringify(fence) + "\\n", { mode: 0o600, flag: "wx" });
  await record("fence-published");
  let acknowledged;
  while (!acknowledged) {
    try {
      const candidate = JSON.parse(await fs.readFile(env.PI_SUBAGENT_COMPLETION_FENCE_ACK_PATH, "utf8"));
      acknowledged = candidate && candidate.version === 1 && candidate.kind === "completion-fence-ack" && candidate.runId === env.PI_SUBAGENT_RUN_ID && candidate.nonce === nonce;
    } catch {}
    if (!acknowledged) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await record("ack-observed");
  const boundary = message("race-boundary", "completion-fence boundary", usage(5, 7));
  await fs.appendFile(env.PI_SUBAGENT_CHILD_SESSION_PATH, JSON.stringify(boundary) + "\\n");
  const bytes = await fs.readFile(env.PI_SUBAGENT_CHILD_SESSION_PATH);
  const session = { byteOffset: bytes.length, finalEntryId: boundary.id, digestAlgorithm: "sha256", prefixDigest: crypto.createHash("sha256").update(bytes).digest("hex") };
  await record("boundary-captured", { session });
  const postFence = message("race-post-fence", "post-fence must be excluded", usage(11, 13));
  await fs.appendFile(env.PI_SUBAGENT_CHILD_SESSION_PATH, JSON.stringify(postFence) + "\\n");
  await record("post-fence-appended");
  const completion = { version: 3, runId: env.PI_SUBAGENT_RUN_ID, producer: "child", status: "completed", completedAt: Date.now(), session };
  await fs.writeFile(env.PI_SUBAGENT_RUN_COMPLETION_PATH, JSON.stringify(completion) + "\\n", { mode: 0o600, flag: "wx" });
  process.exit(0);
}
const entry = { type: "message", id: "fake-assistant-" + env.PI_SUBAGENT_RUN_ID, parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "fake interactive completion" }] } };
await fs.appendFile(env.PI_SUBAGENT_CHILD_SESSION_PATH, JSON.stringify(entry) + "\\n");
const bytes = await fs.readFile(env.PI_SUBAGENT_CHILD_SESSION_PATH);
const completion = { version: 3, runId: env.PI_SUBAGENT_RUN_ID, producer: "child", status: "completed", completedAt: Date.now(), session: { byteOffset: bytes.length, finalEntryId: entry.id, digestAlgorithm: "sha256", prefixDigest: crypto.createHash("sha256").update(bytes).digest("hex") } };
await fs.writeFile(env.PI_SUBAGENT_RUN_COMPLETION_PATH, JSON.stringify(completion) + "\\n", { mode: 0o600, flag: "wx" });
if (env.PI_SUBAGENT_TREE_PERMIT_LEASE_ID) {
  const { adoptTreePermitAuthority } = await import(${JSON.stringify(permits)});
  await new Promise((resolve) => setTimeout(resolve, 100));
  await (await adoptTreePermitAuthority()).inheritedLease?.release();
}
`);
  await writeExecutable(path.join(bin, "tmux"), `#!/usr/bin/env bun
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
const args = process.argv.slice(2);
const socket = (process.env.TMUX ?? "").replace(/,\\s*\\d+\\s*,\\s*\\d+\\s*$/, "");
const statePath = socket + ".fake-state.json";
try { fs.appendFileSync(statePath + ".log", JSON.stringify(args) + "\\n"); } catch {}
process.on("uncaughtException", (error) => { try { fs.appendFileSync(statePath + ".log", "ERROR " + error.stack + "\\n"); } catch {}; process.exit(1); });
const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = (value) => fs.writeFileSync(statePath, JSON.stringify(value) + "\\n", { mode: 0o600 });
const current = () => state();
const rows = (separator, format) => {
  const value = current();
  const source = ["%1", "$1", "@1", String(value.sourcePid)];
  const target = value.target && !value.closed ? ["%2", "$1", "@2", String(value.target)] : null;
  if (format.includes("pane_dead")) return [source, target].filter(Boolean).map((row) => [row[0], "0", row[0] === "%2" ? "fake-target" : "source-sentinel", row[3]].join("\\t")).join("\\n") + "\\n";
  if (format.includes("session_id") && format.startsWith("#{session_id}")) return [source, target].filter(Boolean).map((row) => [row[1], row[2], row[0], row[3]].join("|")).join("\\n") + "\\n";
  if (format.includes("session_id")) return [source, target].filter(Boolean).map((row) => row.join("|")).join("\\n") + "\\n";
  return [source, target].filter(Boolean).map((row) => [row[0], row[3]].join(separator)).join("\\n") + "\\n";
};
if (args.includes("-V")) { console.log("tmux 3.7b"); process.exit(0); }
if (args.includes("display-message")) { console.log(String(current().sourcePid)); process.exit(0); }
if (args.includes("list-panes")) { const format = args[args.indexOf("-F") + 1] ?? ""; process.stdout.write(rows(format.includes("|") ? "|" : "\\t", format)); process.exit(0); }
if (args.includes("new-window") || args.includes("split-window")) {
  const runDir = args[args.indexOf("--run-dir") + 1];
  if (!runDir) process.exit(2);
  const child = spawn("/bin/bash", ["-c", "while [ ! -f $1 ]; do sleep 0.01; done; $2 & child=$!; trap 'kill -TERM $child 2>/dev/null; wait $child; exit' TERM INT; wait $child; while :; do sleep 1; done", "fake-tmux-gate", path.join(runDir, "launch.gate"), path.join(runDir, "cmux-wrapper.sh")], { detached: true, stdio: "ignore" });
  child.unref();
  const value = current(); value.target = child.pid; value.closed = false; value.history = [...(value.history ?? []), child.pid]; save(value);
  console.log("$1|" + (args.includes("split-window") ? "@1" : "@2") + "|%2|" + child.pid); process.exit(0);
}
if (args.includes("if-shell")) {
  if (args.some((value) => value.includes("kill-pane"))) { const value = current(); value.closed = true; value.closeCount = (value.closeCount ?? 0) + 1; save(value); if (value.target) try { process.kill(-value.target, "SIGTERM"); } catch {} }
  else { const value = current(); value.interruptCount = (value.interruptCount ?? 0) + 1; save(value); }
  process.exit(0);
}
process.exit(0);
`);
  return { pi, bin };
}

async function clearFakeTarget(socketPath: string): Promise<void> {
  const statePath = `${socketPath}.fake-state.json`;
  const state = JSON.parse(await fs.promises.readFile(statePath, "utf8")) as { target?: number; closed?: boolean };
  state.closed = true;
  await fs.promises.writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  if (state.target && alive(state.target)) { try { process.kill(-state.target, "SIGTERM"); } catch { process.kill(state.target, "SIGTERM"); } }
  for (const runId of listActiveInteractiveRunIds()) unregisterCommittedInteractiveRun(runId, true);
  const deadline = Date.now() + 2_000;
  while (state.target && alive(state.target) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function runFake(task: string, options: { signal?: AbortSignal; onUpdate?: (update: any) => void } = {}): Promise<SingleResult> {
  return await runAgent({
    cwd: process.cwd(), agents: [agent], agentName: agent.name, task,
    delegationMode: "spawn", terminalMode: "tmux-pane", interactivePaneLayout: "split",
    parentDepth: 0, parentAgentStack: [], maxDepth: 5, maxActive: 2, preventCycles: true,
    signal: options.signal, onUpdate: options.onUpdate, makeDetails: details,
  });
}

describe("fake-adapter interactive runAgent E2E", () => {
  test("runs allocation through gate, wrapper, child completion, exact close, cancellation, external close, and session reload without real tmux", { timeout: 30_000 }, async () => {
    if (process.platform === "win32") return;
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-runner-e2e-"));
    roots.push(root);
    const stateRoot = path.join(root, "runs");
    await fs.promises.mkdir(stateRoot, { mode: 0o700 });
    const socketPath = path.join(root, "tmux.sock");
    const socket = await startSocket(socketPath);
    try {
      const { pi, bin } = await makeFakeExecutables(root);
      const sentinel = path.join(root, "source-sentinel");
      await fs.promises.writeFile(sentinel, "source survives\n", { mode: 0o600 });
      await fs.promises.writeFile(`${socketPath}.fake-state.json`, `${JSON.stringify({ sourcePid: process.pid, target: null, closed: false, history: [] })}\n`, { mode: 0o600 });
      process.execPath = pi;
      process.env.PI_SUBAGENT_BROKER_RUNTIME = pi;
      process.env.PATH = `${bin}${path.delimiter}${original.path ?? ""}`;
      process.env.TMUX = `${socketPath},${process.pid},0`;
      process.env.TMUX_PANE = "%1";
      process.env.PI_SUBAGENT_RUN_STATE_DIR = stateRoot;
      assert.equal(resolveBackendExecutable("tmux-pane"), fs.realpathSync(path.join(bin, "tmux")));
      await resetInteractiveShutdownForSession();

      const completed = await runFake("complete normally");
      assert.equal(completed.exitCode, 0, `${completed.errorMessage ?? ""}\n${completed.stderr}`);
      assert.match(JSON.stringify(completed.messages), /fake interactive completion/);
      await clearFakeTarget(socketPath);
      assert.deepEqual(listActiveInteractiveRunIds(), []);
      await resetInteractiveShutdownForSession();

      const updates: string[] = [];
      let callbackBlocked = false;
      let callbackExitingAt = 0;
      const raced = await runFake("completion fence race", {
        onUpdate: (update) => {
          const snapshot = JSON.stringify(update);
          updates.push(snapshot);
          if (callbackBlocked || !snapshot.includes("pre-fence visible")) return;
          callbackBlocked = true;
          for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) fs.writeFileSync(path.join(stateRoot, entry.name, "race-callback-started"), "entered\\n", { mode: 0o600 });
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
          callbackExitingAt = Date.now();
        },
      });
      const race = JSON.parse(await fs.promises.readFile(path.join(stateRoot, "completion-fence-race.json"), "utf8")) as {
        runId: string;
        entries: Array<{ stage: string; at: number; session?: { finalEntryId: string; byteOffset: number } }>;
      };
      const stage = (name: string) => race.entries.findIndex((entry) => entry.stage === name);
      const ack = race.entries.find((entry) => entry.stage === "ack-observed")!;
      const boundary = race.entries.find((entry) => entry.stage === "boundary-captured")!;
      assert.equal(raced.exitCode, 0, `${raced.errorMessage ?? ""}\n${raced.stderr}`);
      assert.equal(callbackBlocked, true, "an ordinary live drain must invoke onUpdate before the fence");
      assert.ok(stage("live-appended") < stage("fence-published") && stage("fence-published") < stage("ack-observed") && stage("ack-observed") < stage("boundary-captured") && stage("boundary-captured") < stage("post-fence-appended"));
      assert.ok(ack.at >= callbackExitingAt, "parent ACK must wait for the in-flight callback/drain to exit");
      assert.equal(boundary.session?.finalEntryId, "race-boundary", "child captures only after the exact ACK");
      assert.deepEqual(raced.usage, { input: 7, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 12, turns: 2 });
      assert.equal(JSON.stringify(raced.messages).includes("post-fence must be excluded"), false);
      assert.ok(updates.every((snapshot) => !snapshot.includes("post-fence must be excluded")), "callbacks must never expose bytes appended after the captured fence boundary");
      for (const artifact of ["completion-fence.json", "completion-fence-ack.json", "secret-env.sh"]) {
        assert.equal(fs.existsSync(path.join(stateRoot, race.runId, artifact)), false, `sensitive ${artifact} must be removed`);
      }
      await clearFakeTarget(socketPath);
      await resetInteractiveShutdownForSession();

      let malformedUpdates = 0;
      const malformedController = new AbortController();
      const malformedCompletion = runFake("malformed completion after fence", {
        signal: malformedController.signal,
        onUpdate: () => { malformedUpdates += 1; },
      });
      const malformedRunDir = await waitFor(() => {
        for (const entry of fs.readdirSync(stateRoot, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const completionPath = path.join(stateRoot, entry.name, "complete.json");
          if (fs.existsSync(completionPath) && fs.readFileSync(completionPath, "utf8") === "{\"version\":3}\n") return path.join(stateRoot, entry.name);
        }
        return null;
      }, "malformed completion after fence");
      const malformedRunId = path.basename(malformedRunDir);
      malformedController.abort();
      const malformedStartedAt = Date.now();
      const malformedResult = await malformedCompletion;
      assert.ok(Date.now() - malformedStartedAt < 2_000, "malformed completion must not leave cancellation fenced indefinitely");
      assert.equal(malformedResult.errorMessage, "completion-authority-invalid");
      assert.equal(malformedUpdates, 0, "post-fence bytes must not drain or callback after malformed completion");
      assert.equal(JSON.stringify(malformedResult.messages).includes("must not drain after malformed completion"), false, "post-fence bytes must not enter the result");
      assert.equal(listActiveInteractiveRunIds().includes(malformedRunId), true, "malformed completion retains the exact active target for recovery");
      const malformedState = JSON.parse(await fs.promises.readFile(`${socketPath}.fake-state.json`, "utf8"));
      assert.equal(malformedState.closeCount ?? 0, 0, "malformed completion must not close the target");
      await clearFakeTarget(socketPath);
      await resetInteractiveShutdownForSession();

      const controller = new AbortController();
      const cancelling = runFake("hold for cancellation", { signal: controller.signal });
      await waitFor(() => listActiveInteractiveRunIds()[0], "cancellable active run");
      controller.abort();
      const cancelled = await cancelling;
      assert.equal(cancelled.exitCode, 130);
      await clearFakeTarget(socketPath);

      const externallyClosing = runFake("hold for external close");
      await waitFor(() => listActiveInteractiveRunIds()[0], "externally closed active run");
      const external = JSON.parse(await fs.promises.readFile(`${socketPath}.fake-state.json`, "utf8"));
      external.closed = true;
      external.externalClose = true;
      await fs.promises.writeFile(`${socketPath}.fake-state.json`, `${JSON.stringify(external)}\n`, { mode: 0o600 });
      try { process.kill(-external.target, "SIGTERM"); } catch { process.kill(external.target, "SIGTERM"); }
      const externalResult = await externallyClosing;
      assert.notEqual(externalResult.exitCode, 0);
      await clearFakeTarget(socketPath);

      const shuttingDown = runFake("hold for session shutdown");
      await waitFor(() => listActiveInteractiveRunIds()[0], "shutdown active run");
      await shutdownActiveInteractiveRuns();
      const shutdownResult = await shuttingDown;
      assert.notEqual(shutdownResult.exitCode, 0);
      await clearFakeTarget(socketPath);
      await resetInteractiveShutdownForSession();
      const reloaded = await runFake("complete after session reload");
      assert.equal(reloaded.exitCode, 0);
      await clearFakeTarget(socketPath);

      const fake = JSON.parse(await fs.promises.readFile(`${socketPath}.fake-state.json`, "utf8"));
      assert.equal(fake.sourcePid, process.pid, "source pane identity must never be mutated");
      assert.equal(await fs.promises.readFile(sentinel, "utf8"), "source survives\n");
      assert.ok(fake.history.every((pid: number) => !alive(pid)), "fake pane child processes must not leak");
      assert.deepEqual(listActiveInteractiveRunIds(), []);

      const retained = (await fs.promises.readdir(stateRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
      assert.ok(retained.length >= 1, "aborted/failed runs retain conservative recovery metadata");
      const childPids: number[] = [];
      for (const runId of retained) {
        assert.equal(fs.existsSync(path.join(stateRoot, runId, "secret-env.sh")), false, "retained artifacts must not retain child secrets");
        const log = await fs.promises.readFile(path.join(stateRoot, runId, "fake-pi.log"), "utf8").catch(() => "");
        for (const line of log.trim().split("\n")) if (line) childPids.push((JSON.parse(line) as { pid: number }).pid);
      }
      assert.ok(childPids.length >= 4, "the E2E must observe actual fake Pi child processes");
      assert.ok(childPids.every((pid) => !alive(pid)), "fake Pi child processes must not leak after exact pane cleanup");
    } finally {
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      await fs.promises.rm(socketPath, { force: true });
    }
  });
});
