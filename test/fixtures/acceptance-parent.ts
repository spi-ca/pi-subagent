import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getCurrentProcessStartedAt,
  getProcessStartedAt,
  prepareRunArtifactPaths,
  publishImmutableJson,
  startParentLeaseWriter,
  writePrivateExecutableFile,
  writePrivateFile,
} from "../../src/runtime/run-protocol.js";

type Spec = {
  root: string; mode: "tmux-pane" | "cmux-pane"; runtime: string; runtimeInterpreter: string; backend: string; brokerEntrypoint: string;
  checkpoint: "ready-before-allocation";
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
    ? ["CMUX_SOCKET_PATH", "CMUX_SOCKET_CAPABILITY", "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_BUNDLED_CLI_PATH"]
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
const source = spec.mode === "tmux-pane"
  ? { socketPath: spec.socket, sourcePaneId: spec.source!.id, sourcePanePid: spec.source!.pid, serverPid: spec.serverPid! }
  : { workspaceId: spec.workspaceId!, sourceSurfaceId: spec.sourceSurfaceId! };
const intent = {
  version: 2 as const, runId, parentSessionId: "acceptance-fixture", parentPid: process.pid, parentStartedAt,
  terminalMode: spec.mode, source, childSessionFile: paths.childSessionPath, createdAt: Date.now(), brokerNonce: nonce,
  runtimePath: spec.runtime, runtimeInterpreterPath: spec.runtimeInterpreter, backendPath: spec.backend, brokerEntrypoint: spec.brokerEntrypoint,
};
await writePrivateFile(paths.childSessionPath, "");
await writePrivateExecutableFile(paths.wrapperPath, `#!/bin/sh\ntouch ${shellQuote(path.join(paths.runDir, "fixture-child-started"))}\nexec sleep 600\n`);
if (await publishImmutableJson(paths.launchIntentPath, intent) !== "published") throw new Error("fixture intent publish failed");
const lease = startParentLeaseWriter({ filePath: paths.parentLeasePath, runId, parentStartedAt, intervalMs: 100 });
await lease.renew();
const brokerArgs = [spec.brokerEntrypoint, "--run-dir", paths.runDir, "--nonce", nonce, "--runtime", spec.runtime, "--runtime-interpreter", spec.runtimeInterpreter, "--backend", spec.backend, "--acceptance-preallocation-checkpoint"];
// The broker gets a private cwd and the same production-minimal environment as
// runner.ts. It never inherits provider credentials or arbitrary loader hooks.
const broker = spawn(spec.runtime, brokerArgs, { cwd: paths.runDir, detached: true, stdio: "ignore", env: { ...brokerEnvironment(spec.mode), PI_SUBAGENT_ACCEPTANCE_HARNESS: "1" } });
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
