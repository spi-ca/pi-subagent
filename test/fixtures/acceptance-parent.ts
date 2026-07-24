import { execFile, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createTmuxControlTransportGate, publishTmuxControlTransportGate } from "../../src/runtime/tmux-control-gate.js";
import { exactArtifactDigest } from "../../src/runtime/tmux-control-protocol.js";
import { getCmuxControlRequestManager } from "../../src/runtime/cmux-control-adapter.mjs";
import {
  getCurrentProcessStartedAt,
  getProcessStartedAt,
  prepareRunArtifactPaths,
  publishImmutableJson,
  startParentLeaseWriter,
  writePrivateExecutableFile,
  writePrivateFile,
} from "../../src/runtime/run-protocol.js";

const execFileAsync = promisify(execFile);

type Spec = {
  root: string; mode: "tmux-pane" | "cmux-pane"; runtime: string; runtimeInterpreter: string; backend: string; brokerEntrypoint: string;
  checkpoint: "ready-before-allocation" | "after-allocation-before-publication";
  failure?: "exit-after-broker-started";
  socket?: string; source?: { id: string; pid: number }; serverPid?: number; workspaceId?: string; sourceSurfaceId?: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

async function writeDurableHandoff(filePath: string, value: unknown): Promise<void> {
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await fs.promises.open(path.dirname(filePath), "r").then(async (directory) => {
    try { await directory.sync(); } finally { await directory.close(); }
  }).catch(() => undefined);
}

function brokerEnvironment(mode: Spec["mode"]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    TERM: process.env.TERM || "xterm-256color",
  };
  const keys = mode === "cmux-pane"
    ? ["CMUX_SOCKET_PATH", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_BUNDLED_CLI_PATH"]
    : ["TMUX", "TMUX_PANE"];
  for (const key of keys) if (typeof process.env[key] === "string") env[key] = process.env[key];
  return env;
}

const specPath = process.argv.indexOf("--spec") >= 0 ? process.argv[process.argv.indexOf("--spec") + 1] : undefined;
if (!specPath || !path.isAbsolute(specPath)) throw new Error("fixture requires an absolute --spec path");
const spec = JSON.parse(await fs.promises.readFile(specPath, "utf8")) as Spec;
if (!path.isAbsolute(spec.root)) throw new Error("fixture requires private absolute roots");
const runId = `accept-${crypto.randomUUID()}`;
const paths = await prepareRunArtifactPaths({ rootDir: path.join(spec.root, "state"), runId });
const parentStartedAt = getCurrentProcessStartedAt();
if (parentStartedAt === null) throw new Error("fixture cannot establish parent start identity");
const nonce = crypto.randomBytes(32).toString("base64url");
const tmuxControlV3 = spec.mode === "tmux-pane" && spec.failure === undefined;
let tmuxGate: Awaited<ReturnType<typeof createTmuxControlTransportGate>> | null = null;
let tmuxWindowId: string | null = null;
let tmuxGeneration: { socketPath: string; socketDev: string; socketIno: string; serverStartedAt: number } | null = null;
if (tmuxControlV3) {
  const serverStartedAt = getProcessStartedAt(spec.serverPid!);
  if (serverStartedAt === null || !spec.socket) throw new Error("fixture cannot establish tmux server generation");
  const canonicalSocketPath = path.join(fs.realpathSync(path.dirname(spec.socket)), path.basename(spec.socket));
  const socketStat = fs.lstatSync(canonicalSocketPath, { bigint: true });
  if (!socketStat.isSocket() || socketStat.dev > BigInt(Number.MAX_SAFE_INTEGER) || socketStat.ino > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("fixture tmux socket generation is invalid");
  const gateProbeLog: Array<{ args: string[]; exitCode: number; stdout: string; stderr: string }> = [];
  const runTmux = async (args: string[]) => {
    let captured: { exitCode: number; stdout: string; stderr: string };
    try {
      const result = await execFileAsync(spec.backend, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
      captured = { exitCode: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      captured = { exitCode: 1, stdout: String(failure.stdout ?? ""), stderr: String(failure.stderr ?? failure.message) };
    }
    gateProbeLog.push({ args, ...captured });
    await fs.promises.writeFile(path.join(spec.root, "tmux-gate-probe.json"), `${JSON.stringify(gateProbeLog)}\n`, { mode: 0o600 });
    return captured;
  };
  tmuxGate = await createTmuxControlTransportGate({ runId, executable: spec.backend, socketPath: canonicalSocketPath, sourcePaneId: spec.source!.id, serverStartedAt, run: runTmux });
  await publishTmuxControlTransportGate(paths.transportGatePath, tmuxGate);
  const window = await runTmux(["-S", canonicalSocketPath, "display-message", "-p", "-t", spec.source!.id, "#{window_id}"]);
  tmuxWindowId = window.exitCode === 0 ? window.stdout.trim() : null;
  if (!/^@[0-9]+$/.test(tmuxWindowId ?? "")) throw new Error("fixture cannot establish tmux source window");
  tmuxGeneration = { socketPath: canonicalSocketPath, socketDev: String(socketStat.dev), socketIno: String(socketStat.ino), serverStartedAt };
}
const source = spec.mode === "tmux-pane"
  ? tmuxControlV3
    ? { socketPath: tmuxGeneration!.socketPath, sourcePaneId: spec.source!.id, sourcePanePid: spec.source!.pid, serverPid: spec.serverPid!, generation: tmuxGeneration! }
    : { socketPath: spec.socket, sourcePaneId: spec.source!.id, sourcePanePid: spec.source!.pid, serverPid: spec.serverPid! }
  : { workspaceId: spec.workspaceId!, sourceSurfaceId: spec.sourceSurfaceId! };
let cmuxControl: Record<string, unknown> | undefined;
if (spec.mode === "cmux-pane") {
  const manager = getCmuxControlRequestManager({ broker: true, env: process.env });
  try {
    const handshake = await manager.ensureReady(), identity = manager.identity();
    if (!identity) throw new Error("fixture cannot establish cmux control identity");
    cmuxControl = { transport: "cmux-control-v2", socketPath: identity.socketPath, socketDev: identity.socketDev, socketIno: identity.socketIno, accessMode: handshake.access_mode, apiVersion: 2, appVersion: handshake.detectedAppVersion, identifyDigest: crypto.createHash("sha256").update(JSON.stringify(handshake.identify, Object.keys(handshake.identify).sort())).digest("hex"), ...(typeof handshake.identify.boot_id === "string" ? { bootIdentity: handshake.identify.boot_id } : {}) };
  } finally { manager.close(); }
}
const transportGateDigest = tmuxGate ? await exactArtifactDigest(paths.transportGatePath) : null;
if (tmuxGate && !transportGateDigest) throw new Error("fixture cannot hash tmux transport gate");
const intent = {
  version: tmuxControlV3 ? 3 as const : 2 as const, runId, parentSessionId: "acceptance-fixture", parentPid: process.pid, parentStartedAt,
  terminalMode: spec.mode, source,
  ...(spec.mode === "cmux-pane"
    ? { layout: "split", placement: "cmux-split", container: { kind: "cmux-source", workspaceId: spec.workspaceId!, sourceSurfaceId: spec.sourceSurfaceId! }, control: cmuxControl }
    : tmuxControlV3
      ? { layout: "split", placement: "tmux-split", container: { kind: "tmux-source-pane", socketPath: tmuxGeneration!.socketPath, serverPid: spec.serverPid!, sessionId: tmuxGate!.probeResult.attachedSessionId, windowId: tmuxWindowId!, paneId: spec.source!.id, panePid: spec.source!.pid, generation: tmuxGeneration! }, transport: "tmux-control-v1", transportGatePath: paths.transportGatePath, transportGateDigest }
      : {}),
  childSessionFile: paths.childSessionPath, createdAt: Date.now(), brokerNonce: nonce,
  runtimePath: spec.runtime, runtimeInterpreterPath: spec.runtimeInterpreter, backendPath: spec.backend, brokerEntrypoint: spec.brokerEntrypoint,
};
await writePrivateFile(paths.childSessionPath, "");
await writePrivateExecutableFile(paths.wrapperPath, `#!/bin/sh\ntouch ${shellQuote(path.join(paths.runDir, "fixture-child-started"))}\nexec sleep 600\n`);
if (await publishImmutableJson(paths.launchIntentPath, intent) !== "published") throw new Error("fixture intent publish failed");
const lease = startParentLeaseWriter({ filePath: paths.parentLeasePath, runId, parentStartedAt, intervalMs: 100 });
await lease.renew();
const brokerArgs = [spec.brokerEntrypoint, "--run-dir", paths.runDir, "--nonce", nonce, "--runtime", spec.runtime, "--runtime-interpreter", spec.runtimeInterpreter, "--backend", spec.backend,
  spec.checkpoint === "ready-before-allocation" ? "--acceptance-preallocation-checkpoint" : "--acceptance-postallocation-checkpoint"];
// The broker gets a private cwd and the same production-minimal environment as
// runner.ts. It never inherits provider credentials or arbitrary loader hooks.
const brokerStderr = fs.openSync(path.join(spec.root, "broker-stderr.log"), "wx", 0o600);
const broker = spawn(spec.runtime, brokerArgs, { cwd: paths.runDir, detached: true, stdio: ["ignore", "ignore", brokerStderr], env: { ...brokerEnvironment(spec.mode), PI_SUBAGENT_ACCEPTANCE_HARNESS: "1" } });
fs.closeSync(brokerStderr);
broker.unref();
const brokerStartedAt = await (async () => {
  for (let i = 0; i < 100; i += 1) {
    const started = getProcessStartedAt(broker.pid!);
    if (started !== null) return started;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("fixture cannot establish broker start identity");
})();
const handoff = {
  parent: { pid: process.pid, startedAt: parentStartedAt, expectedCommand: "acceptance-parent.ts", runId },
  broker: { pid: broker.pid, startedAt: brokerStartedAt, expectedCommand: "pane-launch-broker.mjs", runId }, runDir: paths.runDir,
};
// Publish a durable external identity before permitting the broker's stopped
// checkpoint. The controller can reconcile it even if this fixture dies before
// ready; the broker independently requires the run-local matching handshake.
await writeDurableHandoff(path.join(spec.root, "broker-started.json"), handoff);
await publishImmutableJson(path.join(paths.runDir, "acceptance-handoff.json"), {
  version: 1, runId, brokerNonce: nonce, broker: handoff.broker,
});
if (spec.failure === "exit-after-broker-started") process.exit(70);
await fs.promises.writeFile(path.join(spec.root, "fixture-ready.json"), `${JSON.stringify(handoff)}\n`, { mode: 0o600 });
// The controller kills only this fixture, then resumes the identity-verified
// broker from its deterministic pre-allocation SIGSTOP checkpoint.
await new Promise<void>(() => {});
