import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProcessStartedAt, prepareRunArtifactPaths } from "../../src/runtime/run-protocol";
import { acceptanceAllocationCheckpointPath } from "./acceptance-allocation-checkpoint";
import { assertExactPackageRegistrationNames, assertFixtureRunReaped, awaitOwnedIdentityTermination, bindAcceptanceTmuxAllocation, createBoundedPackageProbeEvents, hasOverlappingCmuxIdentity, isIdentityStopped, PACKAGE_REGISTRATION_EXPECTED_FLAGS, parseHarnessArgs, parseRequiredCmuxVersion, parseTmuxPanePairProbe, probeProcessState, reconcileFixtureBroker, requireDisjointAcceptanceCmuxWorkspace, requiredLiveGate, requireLiveGate, safeSignalFixture, safeResumeBroker, spawnFixture, terminateOwnedIdentity, terminateStoppedPreallocationBroker, type FixtureTracker, verifyFixtureTerminationState, verifyProcessIdentity } from "./live-harness";

async function waitForStartedAt(pid: number): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const startedAt = getProcessStartedAt(pid);
    if (startedAt !== null) return startedAt;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("test child did not acquire process identity");
}

async function waitForCondition(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForChildExit(child: ReturnType<typeof spawn>, label: string, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`timed out waiting for ${label} exit`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    child.once("exit", onExit);
  });
}

describe("live acceptance harness safety guards", () => {
  test("derives the acceptance checkpoint path outside production run artifacts", () => {
    const runDir = path.join(os.tmpdir(), "pi-subagent-acceptance-checkpoint");
    const expected = path.join(runDir, "acceptance-allocation-checkpoint.json");
    assert.equal(acceptanceAllocationCheckpointPath(runDir), expected);
    assert.equal(acceptanceAllocationCheckpointPath({ runDir }), expected);
  });

  test("parses only explicit modes and non-mutating dry-run flags", () => {
    assert.deepEqual(parseHarnessArgs(["tmux", "--dry-run"]), { mode: "tmux", dryRun: true, keep: false });
    assert.deepEqual(parseHarnessArgs(["package", "--keep"]), { mode: "package", dryRun: false, keep: true });
    assert.throws(() => parseHarnessArgs(["tmux", "--force"]), /only --dry-run/);
    assert.throws(() => parseHarnessArgs(["unknown"]), /usage/);
  });

  test("requires a distinct explicit live gate for each mutable harness", () => {
    assert.equal(requiredLiveGate("cmux"), "PI_SUBAGENT_LIVE_CMUX");
    assert.equal(requiredLiveGate("tmux"), "PI_SUBAGENT_LIVE_TMUX");
    assert.throws(() => requireLiveGate("tmux", {}), /PI_SUBAGENT_LIVE_TMUX=1/);
    assert.doesNotThrow(() => requireLiveGate("package", { PI_SUBAGENT_PACKAGE_ACCEPTANCE: "1" }));
  });

  test("pins package registration flags and rejects unknown, duplicate, or missing names", () => {
    assert.deepEqual(PACKAGE_REGISTRATION_EXPECTED_FLAGS, ["subagent-max-depth", "subagent-max-active", "subagent-max-parallel-tasks", "subagent-max-chain-steps", "subagent-max-concurrency", "subagent-max-chain-parallel-tasks", "subagent-max-background-jobs", "subagent-background-history-limit", "subagent-background-history-ttl-ms", "subagent-background-output-max-bytes", "subagent-background-shutdown-settle-ms", "subagent-parallel-heartbeat-ms", "subagent-prevent-cycles", "subagent-pane-layout"]);
    assert.doesNotThrow(() => assertExactPackageRegistrationNames(PACKAGE_REGISTRATION_EXPECTED_FLAGS, PACKAGE_REGISTRATION_EXPECTED_FLAGS, "flag"));
    assert.throws(() => assertExactPackageRegistrationNames([...PACKAGE_REGISTRATION_EXPECTED_FLAGS, "other"], PACKAGE_REGISTRATION_EXPECTED_FLAGS, "flag"), /unexpected flag registration: other/);
    assert.throws(() => assertExactPackageRegistrationNames([...PACKAGE_REGISTRATION_EXPECTED_FLAGS, "subagent-pane-layout"], PACKAGE_REGISTRATION_EXPECTED_FLAGS, "flag"), /duplicate flag registration: subagent-pane-layout/);
    assert.throws(() => assertExactPackageRegistrationNames(PACKAGE_REGISTRATION_EXPECTED_FLAGS.slice(0, -1), PACKAGE_REGISTRATION_EXPECTED_FLAGS, "flag"), /missing flag registration: subagent-pane-layout/);
  });

  test("keeps bounded dashboard events separate from lifecycle registrations", () => {
    const events = createBoundedPackageProbeEvents();
    const received: unknown[] = [];
    events.on("pi-subagent:dashboard:v1", (payload: unknown) => { received.push(payload); });
    events.emit("pi-subagent:dashboard:v1", { active: 1 });
    assert.deepEqual(received, [{ active: 1 }]);
    assert.throws(() => events.on("session_start", () => undefined), /unexpected pi\.events channel/);
    assert.throws(() => events.on("pi-subagent:dashboard:v1", () => undefined), /duplicate pi\.events listener/);
    assert.throws(() => events.emit("unexpected", undefined), /unexpected pi\.events channel/);
  });

  test("requires an injectable OS-stopped state before resuming a broker", () => {
    const identity = { pid: process.pid, startedAt: -1, expectedCommand: "definitely-not-this-command", runId: "test" };
    assert.equal(isIdentityStopped(identity, () => ({ state: "present", value: "T" })), false);
    assert.throws(() => safeResumeBroker(identity, () => ({ state: "present", value: "T" })), /refusing to resume/);
  });

  test("never signals a PID when its start identity or expected command differs", () => {
    const identity = { pid: process.pid, startedAt: -1, expectedCommand: "definitely-not-this-command", runId: "test" };
    assert.equal(verifyProcessIdentity(identity), false);
    assert.throws(() => safeSignalFixture(identity), /refusing to signal/);
  });

  test("normalizes known Darwin state modifiers and otherwise fails closed", () => {
    for (const [value, primary] of [["S+", "S"], ["Ss", "S"], ["Ts", "T"], ["Z+", "Z"]]) {
      assert.deepEqual(probeProcessState(42, () => ({ status: 0, stdout: `${value}\n` }), undefined, "darwin"), { state: "present", value: primary });
    }
    for (const value of ["S!", "X", "x", "Q", "dead", "S\nextra"]) {
      assert.deepEqual(probeProcessState(42, () => ({ status: 0, stdout: `${value}\n` }), undefined, "darwin"), { state: "unknown" });
    }
    // Linux `ps -o state=` has no Darwin-style modifiers and stays exact.
    assert.deepEqual(probeProcessState(42, () => ({ status: 0, stdout: "S+\n" }), undefined, "linux"), { state: "unknown" });
    assert.deepEqual(probeProcessState(42, () => ({ status: 0, stdout: "T\n" }), undefined, "linux"), { state: "present", value: "T" });
    assert.deepEqual(probeProcessState(42, () => ({ status: 0, stdout: "Z\n" }), undefined, "linux"), { state: "present", value: "Z" });
    assert.deepEqual(probeProcessState(42, () => ({ status: 1, stdout: "" }), () => "absent"), { state: "absent" });
    assert.deepEqual(probeProcessState(42, () => ({ status: 1, stdout: "", error: Object.assign(new Error("denied"), { code: "EPERM" }) }), () => "absent"), { state: "unknown" });
    assert.deepEqual(probeProcessState(42, () => { throw new Error("spawn failed"); }), { state: "unknown" });
    assert.deepEqual(probeProcessState(42, () => ({ status: 1, stdout: "" }), () => { throw new Error("probe failed"); }), { state: "unknown" });
  });

  test("injected X or unknown states never authorize any fixture lifecycle signal", async () => {
    if (process.platform === "win32") return;
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-fixture-state-"));
    const child = spawn("/bin/sh", ["-c", "exec /bin/sleep 30"], { stdio: "ignore" });
    try {
      const identity = { pid: child.pid!, startedAt: await waitForStartedAt(child.pid!), expectedCommand: "/bin/sleep 30", runId: "injected-state" };
      const paths = await prepareRunArtifactPaths({ rootDir: root, runId: identity.runId });
      for (const probe of [() => ({ state: "present" as const, value: "X" }), () => ({ state: "unknown" as const })]) {
        assert.throws(() => safeSignalFixture(identity, "SIGKILL", probe), /refusing to signal/);
        assert.throws(() => safeResumeBroker(identity, probe), /refusing to resume/);
        assert.equal(await terminateOwnedIdentity(identity, probe), false);
        assert.equal(await terminateStoppedPreallocationBroker(identity, paths, probe), false);
        assert.doesNotThrow(() => process.kill(identity.pid, 0));
      }
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("records only an observed absent or zombie fixture termination state", () => {
    const identity = { pid: 42, startedAt: 1, expectedCommand: "fixture", runId: "terminal-state" };
    assert.equal(verifyFixtureTerminationState(identity, () => ({ state: "absent" })), "absent");
    assert.equal(verifyFixtureTerminationState(identity, () => ({ state: "present", value: "Z" })), "zombie");
    assert.equal(verifyFixtureTerminationState(identity, () => ({ state: "present", value: "X" })), null);
    assert.equal(verifyFixtureTerminationState(identity, () => ({ state: "unknown" })), null);
  });

  test("requires the exact fixture run in reaper output", () => {
    assert.doesNotThrow(() => assertFixtureRunReaped("fixture", { reaped: ["fixture"], skipped: [], invalid: [] }));
    for (const result of [
      { reaped: [], skipped: [], invalid: [] },
      { reaped: ["fixture"], skipped: ["fixture"], invalid: [] },
      { reaped: ["fixture"], skipped: [], invalid: ["fixture"] },
    ]) assert.throws(() => assertFixtureRunReaped("fixture", result), /exact acceptance fixture/);
  });

  test("unknown or mismatched identities never authorize fixture signals or cleanup", async () => {
    if (process.platform === "win32") return;
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-fixture-identity-"));
    const child = spawn("/bin/sh", ["-c", "exec /bin/sleep 30"], { stdio: "ignore" });
    try {
      const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "unknown-identity" });
      const mismatched = { pid: child.pid!, startedAt: -1, expectedCommand: "not-this-child", runId: "unknown-identity" };
      assert.throws(() => safeSignalFixture(mismatched, "SIGKILL", () => ({ state: "unknown" })), /refusing to signal/);
      assert.equal(await terminateOwnedIdentity(mismatched, () => ({ state: "unknown" })), false);
      assert.equal(await terminateStoppedPreallocationBroker(mismatched, paths, () => ({ state: "present", value: "T" })), false);
      assert.deepEqual(await reconcileFixtureBroker({ broker: mismatched, paths }, () => ({ state: "unknown" })), { state: "identity-lost", allocationPublished: false, canFinishCleanup: false });
      assert.doesNotThrow(() => process.kill(child.pid!, 0));
      assert.equal(fs.existsSync(paths.runDir), true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("resumes only an identity-bound OS-stopped dedicated process", { timeout: 10_000 }, async () => {
    if (process.platform === "win32") return;
    const child = spawn("/bin/sh", ["-c", "exec /bin/sleep 30"], { stdio: "ignore" });
    const identity = { pid: child.pid!, startedAt: await waitForStartedAt(child.pid!), expectedCommand: "/bin/sleep 30", runId: "test" };
    try {
      child.kill("SIGSTOP");
      await waitForCondition(() => isIdentityStopped(identity), "resumable child stop");
      assert.equal(isIdentityStopped(identity), true);
      safeResumeBroker(identity);
      assert.equal(isIdentityStopped(identity), false);
    } finally {
      if (child.exitCode === null) { child.kill("SIGCONT"); child.kill("SIGKILL"); }
    }
  });

  test("awaits an identity-verified fixture SIGKILL termination before broker resume", async () => {
    if (process.platform === "win32") return;
    const child = spawn("/bin/sh", ["-c", "exec /bin/sleep 30"], { stdio: "ignore" });
    const identity = { pid: child.pid!, startedAt: await waitForStartedAt(child.pid!), expectedCommand: "/bin/sleep 30", runId: "termination" };
    try {
      safeSignalFixture(identity);
      assert.equal(await awaitOwnedIdentityTermination(identity), true);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });

  test("does not fail the pre-allocation parent termination fence on a transient unknown ps probe", async () => {
    let probes = 0;
    const identity = { pid: process.pid, startedAt: getProcessStartedAt(process.pid)!, expectedCommand: "bun", runId: "termination-race" };
    assert.equal(await awaitOwnedIdentityTermination(identity, () => ++probes === 1 ? { state: "unknown" } : { state: "absent" }), true);
    assert.equal(probes, 2);
  });

  test("accepts stable cmux minimum and higher releases only", () => {
    assert.equal(parseRequiredCmuxVersion("cmux 0.64.20\n"), "0.64.20");
    assert.equal(parseRequiredCmuxVersion("cmux 0.64.20 (100) [a1b2c3d4]"), "0.64.20");
    assert.equal(parseRequiredCmuxVersion("cmux 0.64.200 (100) [a1b2c3d4]"), "0.64.200");
    assert.equal(parseRequiredCmuxVersion("cmux 0.64.21"), "0.64.21");
    assert.equal(parseRequiredCmuxVersion("cmux 1.0.0"), "1.0.0");
    assert.equal(parseRequiredCmuxVersion("cmux 0.64.19"), null);
    assert.equal(parseRequiredCmuxVersion("cmux 0.65.0-rc1"), null);
    assert.equal(parseRequiredCmuxVersion("cmux 0.64.20 (dev)"), null);
  });

  test("uses a strict full tmux pane list before proving target absence", () => {
    const pair = { id: "%7", pid: 42 };
    assert.equal(parseTmuxPanePairProbe({ code: 0, stdout: "%7|42\n" }, pair), "present");
    assert.equal(parseTmuxPanePairProbe({ code: 0, stdout: "%8|43\n" }, pair), "absent");
    for (const stdout of ["%8|43", "%8|43|extra\n", "%8|43\n%8|44\n", "%8|43\r\n", "%8|43\0\n", "%8|bad\n", "%8\t43\n"]) {
      assert.equal(parseTmuxPanePairProbe({ code: 0, stdout }, pair), "unknown");
    }
    assert.equal(parseTmuxPanePairProbe({ code: 1, stdout: "" }, pair), "unknown");
  });

  test("rejects a source-pane allocation before acceptance tmux cleanup", () => {
    const intent = {
      version: 2, runId: "tmux-source-alias", parentSessionId: "p", parentPid: 1, parentStartedAt: 1, terminalMode: "tmux-pane" as const,
      source: { socketPath: "/tmp/tmux.sock", sourcePaneId: "%1", sourcePanePid: 456, serverPid: 123 },
      childSessionFile: "/tmp/tmux-source-alias/child-session.jsonl", createdAt: 1, brokerNonce: "a".repeat(32),
      runtimePath: "/usr/bin/node", runtimeInterpreterPath: "/usr/bin/node", backendPath: "/usr/bin/tmux", brokerEntrypoint: "/usr/bin/broker",
    };
    const allocation = {
      version: 2, runId: intent.runId, terminalMode: "tmux-pane" as const,
      target: { socketPath: intent.source.socketPath, serverPid: intent.source.serverPid, paneId: intent.source.sourcePaneId, panePid: intent.source.sourcePanePid }, allocatedAt: 1,
    };
    assert.equal(bindAcceptanceTmuxAllocation(intent, allocation, intent.runId), null);
    assert.equal(bindAcceptanceTmuxAllocation(intent, { ...allocation, target: { ...allocation.target, panePid: 789 } }, intent.runId), null);
  });

  test("removes only an exact stale socket under its private acceptance root", async () => {
    if (process.platform === "win32") return;
    const { reconcileDeadTmuxServerEndpoint, removePrivateStaleTmuxSocket } = await import("./live-harness");
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-stale-tmux-"));
    await fs.promises.chmod(root, 0o700);
    const socket = path.join(root, "tmux.sock");
    const child = spawn(process.execPath, ["-e", `const server = Bun.listen({ unix: ${JSON.stringify(socket)}, socket: { data() {} } }); console.log("ready"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", (code) => { if (code !== null) reject(new Error(`socket fixture exited ${code}`)); });
      });
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      assert.equal(fs.existsSync(socket), true);
      let alive = false;
      let reachable = false;
      assert.equal(await reconcileDeadTmuxServerEndpoint(root, socket, () => alive, async () => ({ code: reachable ? 0 : 1 })), true);
      assert.equal(fs.existsSync(socket), false);
      const wrong = path.join(root, "other.sock");
      await fs.promises.writeFile(wrong, "not a socket", { mode: 0o600 });
      assert.equal(await removePrivateStaleTmuxSocket(root, wrong), false);
      assert.equal(fs.existsSync(wrong), true);
      assert.equal(await removePrivateStaleTmuxSocket(path.join(root, "wrong-root"), socket), false);
      alive = true;
      assert.equal(await reconcileDeadTmuxServerEndpoint(root, socket, () => alive, async () => ({ code: 1 })), false);
      alive = false; reachable = true;
      assert.equal(await reconcileDeadTmuxServerEndpoint(root, socket, () => alive, async () => ({ code: reachable ? 0 : 1 })), false);
      let probeCount = 0;
      assert.equal(await reconcileDeadTmuxServerEndpoint(root, socket, () => false, async () => ({ code: ++probeCount === 1 ? 1 : 0 })), false);
      let aliveChecks = 0;
      assert.equal(await reconcileDeadTmuxServerEndpoint(root, socket, () => ++aliveChecks > 1, async () => ({ code: 1 })), false);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  // The 20s process-state observation budget must not equal Bun's outer
  // timeout: a contended suite needs time to run termination and reaping.
  test("SIGKILLs only the identity-verified stopped pre-allocation broker", { timeout: 35_000 }, async () => {
    if (process.platform === "win32") return;
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-fixture-stopped-"));
    const child = spawn("/bin/sh", ["-c", "exec /bin/sleep 30"], { stdio: "ignore" });
    try {
      const identity = { pid: child.pid!, startedAt: await waitForStartedAt(child.pid!), expectedCommand: "/bin/sleep 30", runId: "stopped-preallocation" };
      const paths = await prepareRunArtifactPaths({ rootDir: root, runId: identity.runId });
      await fs.promises.writeFile(paths.launchIntentPath, `${JSON.stringify({ runId: identity.runId })}\n`, { mode: 0o600 });
      await fs.promises.writeFile(paths.brokerStatusPath, `${JSON.stringify({ runId: identity.runId, writer: "broker", pid: identity.pid, phase: "ready" })}\n`, { mode: 0o600 });
      // ChildProcess.kill is flaky for this fixture while Bun runs the full
      // suite in parallel. Send SIGSTOP directly only after the target's
      // PID/start/command identity is verified.
      assert.equal(verifyProcessIdentity(identity), true);
      process.kill(identity.pid, "SIGSTOP");
      // Observe the kernel stop state without repeatedly spawning a second
      // command-identity probe under full-suite contention. Immediately after
      // the observation, retain the identity-bound authorization assertion
      // that the lifecycle helper requires before SIGKILL.
      // The outer test timeout leaves 15s for verified termination, child
      // reaping, and finally cleanup after this bounded observation.
      await waitForCondition(() => {
        const state = probeProcessState(identity.pid);
        return state.state === "present" && state.value === "T";
      }, "preallocation child stop", 20_000);
      assert.equal(isIdentityStopped(identity), true);
      assert.equal(await terminateStoppedPreallocationBroker(identity, paths), true);
      await waitForChildExit(child, "stopped pre-allocation broker");
      assert.equal(child.signalCode, "SIGKILL");
      assert.deepEqual(probeProcessState(identity.pid), { state: "absent" });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        await waitForChildExit(child, "stopped pre-allocation broker cleanup").catch(() => undefined);
      }
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("does not signal a non-stopped broker without durable reconciliation", async () => {
    if (process.platform === "win32") return;
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-fixture-running-"));
    const child = spawn("/bin/sh", ["-c", "exec /bin/sleep 30"], { stdio: "ignore" });
    try {
      const identity = { pid: child.pid!, startedAt: await waitForStartedAt(child.pid!), expectedCommand: "/bin/sleep 30", runId: "running-preallocation" };
      const paths = await prepareRunArtifactPaths({ rootDir: root, runId: identity.runId });
      await fs.promises.writeFile(paths.launchIntentPath, `${JSON.stringify({ runId: identity.runId })}\n`, { mode: 0o600 });
      await fs.promises.writeFile(paths.brokerStatusPath, `${JSON.stringify({ runId: identity.runId, writer: "broker", pid: identity.pid, phase: "ready" })}\n`, { mode: 0o600 });
      assert.equal(await terminateStoppedPreallocationBroker(identity, paths), false);
      assert.doesNotThrow(() => process.kill(identity.pid, 0));
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("retains root cleanup authority while an identity-verified broker is alive after durable allocation", async () => {
    if (process.platform === "win32") return;
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-fixture-reconcile-"));
    const child = spawn("/bin/sh", ["-c", "exec /bin/sleep 30"], { stdio: "ignore" });
    try {
      const identity = { pid: child.pid!, startedAt: await waitForStartedAt(child.pid!), expectedCommand: "/bin/sleep 30", runId: "durable-allocation" };
      const paths = await prepareRunArtifactPaths({ rootDir: root, runId: identity.runId });
      await fs.promises.writeFile(paths.allocationPath, `${JSON.stringify({ version: 2, runId: identity.runId, terminalMode: "tmux-pane", target: { paneId: "%1", serverPid: 1, panePid: 2 }, allocatedAt: 1 })}\n`, { mode: 0o600 });
      const reconciliation = await reconcileFixtureBroker({ broker: identity, paths });
      assert.deepEqual(reconciliation, { state: "alive-with-allocation", allocationPublished: true, canFinishCleanup: false });
      assert.doesNotThrow(() => process.kill(identity.pid, 0));
    } finally {
      if (child.pid) assert.equal(await terminateOwnedIdentity({ pid: child.pid, startedAt: await waitForStartedAt(child.pid), expectedCommand: "/bin/sleep 30", runId: "durable-allocation" }), true);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("retains acceptance evidence when the pre-checkpoint handoff is unresolved", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-fixture-handoff-unresolved-"));
    try {
      const paths = await prepareRunArtifactPaths({ rootDir: root, runId: "handoff-unresolved" });
      await fs.promises.writeFile(paths.brokerStatusPath, `${JSON.stringify({ version: 2, runId: "handoff-unresolved", writer: "broker", pid: 1, phase: "failed", updatedAt: 1, errorCode: "acceptance-handoff-unresolved" })}\n`, { mode: 0o600 });
      const reconciliation = await reconcileFixtureBroker({ broker: { pid: 1, startedAt: 1, expectedCommand: "pane-launch-broker.mjs", runId: "handoff-unresolved" }, paths }, () => ({ state: "absent" }));
      assert.deepEqual(reconciliation, { state: "handoff-unresolved", allocationPublished: false, canFinishCleanup: false });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("retains the broker identity handoff when the fixture exits before ready", async () => {
    if (process.platform === "win32") return;
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-fixture-handoff-"));
    const tracker: FixtureTracker = { child: null, parent: null, broker: null, paths: null };
    try {
      await assert.rejects(() => spawnFixture({
        root, mode: "tmux-pane", socket: "/tmp/fixture.sock", source: { id: "%1", pid: 1 }, serverPid: 1,
        runtime: process.execPath, runtimeInterpreter: fs.realpathSync(process.execPath), backend: "/bin/true",
        brokerEntrypoint: path.resolve("src/runtime/pane-launch-broker.mjs"), checkpoint: "ready-before-allocation", failure: "exit-after-broker-started",
      }, tracker), /fixture exited before ready after broker-started handoff/);
      assert.ok(tracker.broker);
      assert.ok(tracker.paths);
      assert.equal(tracker.broker!.runId, tracker.parent!.runId);
      assert.equal(path.basename(tracker.paths!.runDir), tracker.broker!.runId);
    } finally {
      // The fixture writes this handoff before ready. Reconcile both dedicated
      // processes by PID/start/command identity before deleting their root so
      // a detached SIGSTOP broker cannot survive the unit test.
      assert.ok(tracker.broker);
      assert.ok(tracker.paths);
      await waitForCondition(() => isIdentityStopped(tracker.broker!), "fixture broker stop", 1_000).catch(() => undefined);
      if (isIdentityStopped(tracker.broker!)) {
        assert.equal(await terminateStoppedPreallocationBroker(tracker.broker!, tracker.paths!), true);
      } else {
        assert.equal(fs.existsSync(tracker.paths!.allocationPath), false);
        assert.equal(await terminateOwnedIdentity(tracker.broker!), true);
      }
      if (tracker.parent) assert.equal(await terminateOwnedIdentity(tracker.parent), true);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});

const CMUX_IDS = {
  callerWorkspace: "123e4567-e89b-12d3-a456-426614174000",
  callerPane: "123e4567-e89b-12d3-a456-426614174001",
  callerSurface: "123e4567-e89b-12d3-a456-426614174002",
  workspace: "123e4567-e89b-12d3-a456-426614174010",
  pane: "123e4567-e89b-12d3-a456-426614174011",
  surface: "123e4567-e89b-12d3-a456-426614174012",
  workspaceTwo: "123e4567-e89b-12d3-a456-426614174020",
  paneTwo: "123e4567-e89b-12d3-a456-426614174021",
  surfaceTwo: "123e4567-e89b-12d3-a456-426614174022",
};

type MockCmuxResult = { code: number; stdout: string; stderr: string };
function mockCmuxResult(value: unknown, code = 0): MockCmuxResult {
  return { code, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" };
}

function workspaceTree(entries: Array<{ id: string; pane: string; surface: string; name: string }>): string {
  return JSON.stringify({ windows: [{ workspaces: entries.map((entry) => ({
    id: entry.id, name: entry.name, panes: [{ id: entry.pane, surfaces: [{ id: entry.surface, pane_id: entry.pane }] }],
  })) }] });
}

const CMUX_RUN_ID = "acceptance-cmux-run";
const acceptanceWorkspace = { workspaceId: CMUX_IDS.workspace, paneId: CMUX_IDS.pane, surfaceId: CMUX_IDS.surface, name: "acceptance" };
const callerIdentity = { workspaceId: CMUX_IDS.callerWorkspace, paneId: CMUX_IDS.callerPane, surfaceId: CMUX_IDS.callerSurface };
function cmuxIntent(source = acceptanceWorkspace): Record<string, unknown> {
  return {
    version: 2, runId: CMUX_RUN_ID, parentSessionId: "acceptance", parentPid: 1, parentStartedAt: 1,
    terminalMode: "cmux-pane", source: { workspaceId: source.workspaceId, sourceSurfaceId: source.surfaceId },
    childSessionFile: "/private/acceptance/child-session.jsonl", createdAt: 1, brokerNonce: "a".repeat(32),
    runtimePath: "/usr/bin/bun", runtimeInterpreterPath: "/usr/bin/bun", backendPath: "/usr/bin/cmux", brokerEntrypoint: "/private/acceptance/broker.mjs",
  };
}
function cmuxAllocation(target: { workspaceId: string; paneId: string; surfaceId: string } = acceptanceWorkspace): Record<string, unknown> {
  return { version: 2, runId: CMUX_RUN_ID, terminalMode: "cmux-pane", target: { workspaceId: target.workspaceId, paneId: target.paneId, surfaceId: target.surfaceId }, allocatedAt: 1 };
}

describe("isolated cmux workspace acceptance harness", () => {
  test("rejects recovered acceptance overlap before any sentinel, fixture, or respawn command", () => {
    const calls: string[][] = [];
    const overlapping = { ...acceptanceWorkspace, paneId: CMUX_IDS.callerPane };
    assert.equal(hasOverlappingCmuxIdentity(overlapping, callerIdentity), true);
    assert.throws(() => {
      requireDisjointAcceptanceCmuxWorkspace(overlapping, callerIdentity);
      calls.push(["new-split"]);
    }, /overlaps caller cmux identity/);
    assert.deepEqual(calls, []);
  });

  test("rejects a caller-overlapping sentinel response before any further cmux command or fixture", async () => {
    const { requireVerifiedAcceptanceCmuxSentinel } = await import("./live-harness");
    const calls: string[][] = [];
    let fixtureSpawned = false;
    let hardStopped = false;
    const overlapping = { workspaceId: CMUX_IDS.workspace, surfaceId: CMUX_IDS.surfaceTwo, paneId: CMUX_IDS.callerPane };
    await assert.rejects(async () => {
      await requireVerifiedAcceptanceCmuxSentinel("cmux", overlapping, acceptanceWorkspace, callerIdentity, async (args) => {
        calls.push(args);
        return mockCmuxResult({});
      }, () => { hardStopped = true; });
      fixtureSpawned = true;
    }, /overlaps an acceptance source or caller cmux identity/);
    assert.deepEqual(calls, []);
    assert.equal(hardStopped, true);
    assert.equal(fixtureSpawned, false);
  });

  test("hard-stops the shared cmux command gate before sentinel-overlap finalization", async () => {
    const { createCmuxCommandGate, requireVerifiedAcceptanceCmuxSentinel } = await import("./live-harness");
    for (const sentinel of [
      { ...acceptanceWorkspace, surfaceId: CMUX_IDS.surfaceTwo },
      { ...acceptanceWorkspace, paneId: CMUX_IDS.paneTwo },
      { workspaceId: CMUX_IDS.callerWorkspace, surfaceId: CMUX_IDS.surfaceTwo, paneId: CMUX_IDS.paneTwo },
      { workspaceId: CMUX_IDS.workspace, surfaceId: CMUX_IDS.callerSurface, paneId: CMUX_IDS.paneTwo },
      { workspaceId: CMUX_IDS.workspace, surfaceId: CMUX_IDS.surfaceTwo, paneId: CMUX_IDS.callerPane },
    ]) {
      const calls: string[][] = [];
      const gate = createCmuxCommandGate(async (args) => { calls.push(args); return mockCmuxResult({}); });
      await assert.rejects(
        () => requireVerifiedAcceptanceCmuxSentinel("cmux", sentinel, acceptanceWorkspace, callerIdentity, gate.run, gate.hardStop),
        /overlaps an acceptance source or caller cmux identity/,
      );
      // This simulates the live runner's finally path. Once overlap is seen,
      // even teardown attempts are suppressed rather than reaching cmux.
      assert.equal((await gate.run(["close-surface", "--workspace", CMUX_IDS.workspace, "--surface", CMUX_IDS.surface])).code, 1);
      assert.equal(gate.stopped, true);
      assert.deepEqual(calls, []);
    }
  });

  test("fails a sentinel response/topology mismatch before fixture spawn or respawn", async () => {
    const { requireVerifiedAcceptanceCmuxSentinel } = await import("./live-harness");
    const calls: string[][] = [];
    let fixtureSpawned = false;
    let hardStopped = false;
    const response = { workspaceId: CMUX_IDS.workspace, surfaceId: CMUX_IDS.surfaceTwo, paneId: CMUX_IDS.paneTwo };
    await assert.rejects(async () => {
      await requireVerifiedAcceptanceCmuxSentinel("cmux", response, acceptanceWorkspace, callerIdentity, async (args) => {
        calls.push(args);
        return mockCmuxResult(workspaceTree([{ id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surfaceTwo, name: "acceptance" }]));
      }, () => { hardStopped = true; });
      fixtureSpawned = true;
    }, /does not exactly match canonical topology/);
    assert.deepEqual(calls, [["--json", "--id-format", "both", "tree", "--workspace", CMUX_IDS.workspace]]);
    assert.equal(hardStopped, false);
    assert.equal(fixtureSpawned, false);
  });

  test("creates a uniquely named private workspace and parses only its canonical initial IDs", async () => {
    const { buildCmuxNewWorkspaceArgs, createAcceptanceCmuxWorkspace } = await import("./live-harness");
    const calls: string[][] = [];
    const name = "pi-subagent-accept-unique";
    const root = "/private/acceptance-root";
    const created = await createAcceptanceCmuxWorkspace(async (args) => {
      calls.push(args);
      return calls.length === 1
        ? mockCmuxResult({ workspace_id: CMUX_IDS.workspace, pane_id: CMUX_IDS.pane, surface_id: CMUX_IDS.surface })
        : mockCmuxResult(workspaceTree([{ id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name }]));
    }, name, root);
    assert.deepEqual(calls, [buildCmuxNewWorkspaceArgs(name, root), ["--json", "--id-format", "both", "tree", "--all"]]);
    assert.deepEqual(created, { state: "created", workspace: { workspaceId: CMUX_IDS.workspace, paneId: CMUX_IDS.pane, surfaceId: CMUX_IDS.surface, name }, recovery: "response-verified-tree" });
  });

  test("never closes a durable allocation outside the acceptance workspace", async () => {
    const { bindAcceptanceCmuxAllocation, cleanupAcceptanceCmuxTarget } = await import("./live-harness");
    const wrongTarget = { workspaceId: CMUX_IDS.workspaceTwo, paneId: CMUX_IDS.paneTwo, surfaceId: CMUX_IDS.surfaceTwo };
    const authority = bindAcceptanceCmuxAllocation(cmuxIntent(), cmuxAllocation(wrongTarget), CMUX_RUN_ID, acceptanceWorkspace, callerIdentity);
    assert.deepEqual(authority, { state: "unresolved", reason: "wrong-workspace" });
    const calls: string[][] = [];
    assert.equal(await cleanupAcceptanceCmuxTarget("cmux", wrongTarget, acceptanceWorkspace, callerIdentity, async (args) => {
      calls.push(args);
      return mockCmuxResult({});
    }), false);
    assert.equal(calls.length, 0);
    const callerSurfaceTarget = { workspaceId: CMUX_IDS.workspace, paneId: CMUX_IDS.paneTwo, surfaceId: CMUX_IDS.callerSurface };
    const sourceSurfaceTarget = { ...acceptanceWorkspace, paneId: CMUX_IDS.paneTwo };
    assert.deepEqual(bindAcceptanceCmuxAllocation(cmuxIntent(), cmuxAllocation(sourceSurfaceTarget), CMUX_RUN_ID, acceptanceWorkspace, callerIdentity), { state: "unresolved", reason: "source-surface" });
    assert.equal(await cleanupAcceptanceCmuxTarget("cmux", sourceSurfaceTarget, acceptanceWorkspace, callerIdentity, async (args) => {
      calls.push(args); return mockCmuxResult({});
    }), false);
    assert.equal(calls.length, 0);
    assert.deepEqual(bindAcceptanceCmuxAllocation(cmuxIntent(), cmuxAllocation(callerSurfaceTarget), CMUX_RUN_ID, acceptanceWorkspace, callerIdentity), { state: "unresolved", reason: "caller-identity" });
    assert.equal(await cleanupAcceptanceCmuxTarget("cmux", callerSurfaceTarget, acceptanceWorkspace, callerIdentity, async (args: string[]): Promise<MockCmuxResult> => {
      calls.push(args);
      return mockCmuxResult({});
    }), false);
    assert.equal(calls.length, 0);
  });

  test("closes an exact acceptance target in its workspace instead of relying on the caller default", async () => {
    const { cleanupAcceptanceCmuxTarget } = await import("./live-harness");
    const target = { workspaceId: CMUX_IDS.workspace, paneId: CMUX_IDS.paneTwo, surfaceId: CMUX_IDS.surfaceTwo };
    const calls: string[][] = [];
    let targetLive = true;
    const runner = async (args: string[]): Promise<MockCmuxResult> => {
      calls.push(args);
      if (args[0] === "close-surface") {
        assert.deepEqual(args, ["close-surface", "--workspace", CMUX_IDS.workspace, "--surface", CMUX_IDS.surfaceTwo]);
        targetLive = false;
        return mockCmuxResult({});
      }
      assert.deepEqual(args, ["--json", "--id-format", "both", "tree", "--workspace", CMUX_IDS.workspace]);
      return mockCmuxResult(targetLive
        ? workspaceTree([{ id: CMUX_IDS.workspace, pane: CMUX_IDS.paneTwo, surface: CMUX_IDS.surfaceTwo, name: "acceptance" }])
        : workspaceTree([{ id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name: "acceptance" }]));
    };
    assert.equal(await cleanupAcceptanceCmuxTarget("cmux", target, acceptanceWorkspace, callerIdentity, runner), true);
    assert.deepEqual(calls.filter((args) => args[0] === "close-surface"), [["close-surface", "--workspace", CMUX_IDS.workspace, "--surface", CMUX_IDS.surfaceTwo]]);
  });

  test("recovers and closes the recorded singleton workspace after a nonzero create response", async () => {
    const { createAcceptanceCmuxWorkspace, closeAcceptanceCmuxWorkspaceAfterSingletonProof } = await import("./live-harness");
    const name = "pi-subagent-accept-nonzero-created";
    const calls: string[][] = [];
    const live = new Set([CMUX_IDS.callerWorkspace, CMUX_IDS.workspace]);
    const runner = async (args: string[]): Promise<MockCmuxResult> => {
      calls.push(args);
      if (args[3] === "new-workspace") return { ...mockCmuxResult("timed out", 1), stderr: "timed out" };
      if (args[0] === "close-workspace") { live.delete(CMUX_IDS.workspace); return mockCmuxResult({}); }
      assert.deepEqual(args, ["--json", "--id-format", "both", "tree", "--all"]);
      return mockCmuxResult(workspaceTree([
        ...(live.has(CMUX_IDS.callerWorkspace) ? [{ id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" }] : []),
        ...(live.has(CMUX_IDS.workspace) ? [{ id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name }] : []),
      ]));
    };
    const creation = await createAcceptanceCmuxWorkspace(runner, name, "/private/root");
    assert.deepEqual(creation, { state: "created", workspace: { ...acceptanceWorkspace, name }, recovery: "nonzero-response-named-tree" });
    assert.equal(creation.state === "created" && await closeAcceptanceCmuxWorkspaceAfterSingletonProof("cmux", creation.workspace, callerIdentity, runner), true);
    assert.deepEqual(calls.filter((args) => args[0] === "close-workspace"), [["close-workspace", "--workspace", CMUX_IDS.workspace]]);
    assert.equal(calls.some((args) => args[0] === "close-surface"), false);
  });

  test("fails closed when exhausted nonzero-create recovery has zero exact-name matches", async () => {
    const { createAcceptanceCmuxWorkspace } = await import("./live-harness");
    const calls: string[][] = [];
    const creation = await createAcceptanceCmuxWorkspace(async (args) => {
      calls.push(args);
      return calls.length === 1
        ? { ...mockCmuxResult("create failed", 1), stderr: "create failed" }
        : mockCmuxResult(workspaceTree([{ id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" }]));
    }, "pi-subagent-accept-not-created", "/private/root");
    assert.deepEqual(creation, { state: "unresolved", recovery: "absent" });
    assert.deepEqual(calls.slice(1), Array.from({ length: 3 }, () => ["--json", "--id-format", "both", "tree", "--all"]));
  });

  test("fails closed when successful-create recovery has zero exact-name matches", async () => {
    const { createAcceptanceCmuxWorkspace } = await import("./live-harness");
    const calls: string[][] = [];
    const creation = await createAcceptanceCmuxWorkspace(async (args) => {
      calls.push(args);
      return calls.length === 1
        ? mockCmuxResult({ workspace_id: CMUX_IDS.workspace, pane_id: CMUX_IDS.pane, surface_id: CMUX_IDS.surface })
        : mockCmuxResult(workspaceTree([{ id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" }]));
    }, "pi-subagent-accept-success-zero-match", "/private/root");
    assert.deepEqual(creation, { state: "unresolved", recovery: "absent" });
    assert.deepEqual(calls.slice(1), [["--json", "--id-format", "both", "tree", "--all"]]);
  });

  test("recovers a failed workspace create when a bounded canonical snapshot finds its exact name", async () => {
    const { createAcceptanceCmuxWorkspace } = await import("./live-harness");
    const name = "pi-subagent-accept-delayed";
    let treeSnapshots = 0;
    const creation = await createAcceptanceCmuxWorkspace(async () => {
      treeSnapshots += 1;
      if (treeSnapshots === 1) return { ...mockCmuxResult("create failed", 1), stderr: "create failed" };
      return treeSnapshots < 4
        ? mockCmuxResult(workspaceTree([{ id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" }]))
        : mockCmuxResult(workspaceTree([{ id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name }]));
    }, name, "/private/root");
    assert.deepEqual(creation, { state: "created", workspace: { ...acceptanceWorkspace, name }, recovery: "nonzero-response-named-tree" });
    assert.equal(treeSnapshots, 4);
  });

  test("recovers an unparseable successful create only through one exact harness name in canonical tree output", async () => {
    const { createAcceptanceCmuxWorkspace } = await import("./live-harness");
    const calls: string[][] = [];
    const name = "pi-subagent-accept-recover";
    const created = await createAcceptanceCmuxWorkspace(async (args) => {
      calls.push(args);
      return calls.length === 1 ? mockCmuxResult("{}") : mockCmuxResult(workspaceTree([{ id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name }]));
    }, name, "/private/root");
    assert.equal(created.state, "created");
    assert.equal(created.state === "created" && created.recovery, "named-tree");
    assert.deepEqual(calls[1], ["--json", "--id-format", "both", "tree", "--all"]);
  });

  test("fails ambiguous successful-create recovery without guessing or closing any workspace", async () => {
    const { createAcceptanceCmuxWorkspace } = await import("./live-harness");
    const calls: string[][] = [];
    const name = "pi-subagent-accept-ambiguous";
    const result = await createAcceptanceCmuxWorkspace(async (args) => {
      calls.push(args);
      return calls.length === 1 ? mockCmuxResult("{}") : mockCmuxResult(workspaceTree([
        { id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name },
        { id: CMUX_IDS.workspaceTwo, pane: CMUX_IDS.paneTwo, surface: CMUX_IDS.surfaceTwo, name },
      ]));
    }, name, "/private/root");
    assert.deepEqual(result, { state: "unresolved", recovery: "ambiguous" });
    assert.equal(calls.some((args) => args[0] === "close-surface"), false);
  });

  test("continues exact-name reconciliation for singleton-workspace teardown after an unresolved create", async () => {
    const { reconcileAcceptanceCmuxWorkspace, closeAcceptanceCmuxWorkspaceAfterSingletonProof } = await import("./live-harness");
    const name = "pi-subagent-accept-teardown-recovery";
    let treeReads = 0;
    const live = new Set([CMUX_IDS.callerWorkspace, CMUX_IDS.workspace]);
    const runner = async (args: string[]): Promise<MockCmuxResult> => {
      if (args[0] === "close-workspace") { live.delete(CMUX_IDS.workspace); return mockCmuxResult({}); }
      assert.deepEqual(args, ["--json", "--id-format", "both", "tree", "--all"]);
      treeReads += 1;
      return mockCmuxResult(workspaceTree([
        { id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" },
        ...(treeReads < 3 || !live.has(CMUX_IDS.workspace) ? [] : [{ id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name }]),
      ]));
    };
    const recovered = await reconcileAcceptanceCmuxWorkspace(runner, name);
    assert.deepEqual(recovered, { state: "created", workspace: { ...acceptanceWorkspace, name }, recovery: "named-tree" });
    assert.equal(recovered.state === "created" && await closeAcceptanceCmuxWorkspaceAfterSingletonProof("cmux", recovered.workspace, callerIdentity, runner), true);
  });

  test("rejects an injected extra acceptance surface without issuing any close command", async () => {
    const { closeAcceptanceCmuxWorkspaceAfterSingletonProof } = await import("./live-harness");
    const calls: string[][] = [];
    const runner = async (args: string[]): Promise<MockCmuxResult> => {
      calls.push(args);
      assert.deepEqual(args, ["--json", "--id-format", "both", "tree", "--all"]);
      return mockCmuxResult({ windows: [{ workspaces: [
        { id: CMUX_IDS.callerWorkspace, name: "caller", panes: [{ id: CMUX_IDS.callerPane, surfaces: [{ id: CMUX_IDS.callerSurface, pane_id: CMUX_IDS.callerPane }] }] },
        { id: CMUX_IDS.workspace, name: "acceptance", panes: [{ id: CMUX_IDS.pane, surfaces: [
          { id: CMUX_IDS.surface, pane_id: CMUX_IDS.pane },
          { id: CMUX_IDS.surfaceTwo, pane_id: CMUX_IDS.pane },
        ] }] },
      ] }] });
    };
    assert.equal(await closeAcceptanceCmuxWorkspaceAfterSingletonProof("cmux", acceptanceWorkspace, callerIdentity, runner), false);
    assert.deepEqual(calls, [["--json", "--id-format", "both", "tree", "--all"]]);
    assert.equal(calls.some((args) => args[0] === "close-workspace" || args[0] === "close-surface"), false);
  });

  test("fails closed without mutation for malformed, name-mismatched, duplicate, or caller-overlapping topology", async () => {
    const { closeAcceptanceCmuxWorkspaceAfterSingletonProof } = await import("./live-harness");
    const canonical = workspaceTree([
      { id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" },
      { id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name: "acceptance" },
    ]);
    const malformed = JSON.stringify({ windows: [{ workspaces: [
      { id: CMUX_IDS.callerWorkspace, name: "caller", panes: [{ id: CMUX_IDS.callerPane, surfaces: [{ id: CMUX_IDS.callerSurface, pane_id: CMUX_IDS.callerPane }] }] },
      { id: CMUX_IDS.workspace, name: "acceptance", panes: [{ id: CMUX_IDS.pane, surfaces: [{ id: CMUX_IDS.surface, pane_id: CMUX_IDS.paneTwo }] }] },
    ] }] });
    const duplicate = JSON.stringify({ windows: [{ workspaces: [
      { id: CMUX_IDS.callerWorkspace, name: "caller", panes: [{ id: CMUX_IDS.callerPane, surfaces: [{ id: CMUX_IDS.callerSurface, pane_id: CMUX_IDS.callerPane }] }] },
      { id: CMUX_IDS.workspace, name: "acceptance", panes: [{ id: CMUX_IDS.pane, surfaces: [{ id: CMUX_IDS.surface, pane_id: CMUX_IDS.pane }] }] },
      { id: CMUX_IDS.workspace, name: "acceptance", panes: [{ id: CMUX_IDS.paneTwo, surfaces: [{ id: CMUX_IDS.surfaceTwo, pane_id: CMUX_IDS.paneTwo }] }] },
    ] }] });
    const duplicateName = workspaceTree([
      { id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" },
      { id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name: "acceptance" },
      { id: CMUX_IDS.workspaceTwo, pane: CMUX_IDS.paneTwo, surface: CMUX_IDS.surfaceTwo, name: "acceptance" },
    ]);
    const crossTypeDuplicate = workspaceTree([
      { id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" },
      { id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name: "acceptance" },
      { id: CMUX_IDS.pane, pane: CMUX_IDS.paneTwo, surface: CMUX_IDS.surfaceTwo, name: "cross-type-duplicate" },
    ]);
    for (const [label, stdout, caller] of [
      ["malformed", malformed, callerIdentity],
      ["name mismatch", canonical.replace('"acceptance"', '"other"'), callerIdentity],
      ["duplicate workspace", duplicate, callerIdentity],
      ["duplicate exact name", duplicateName, callerIdentity],
      ["cross-type duplicate", crossTypeDuplicate, callerIdentity],
      ["caller overlap", canonical, { ...callerIdentity, workspaceId: CMUX_IDS.workspace }],
      ["cross-type caller overlap", canonical, { ...callerIdentity, surfaceId: CMUX_IDS.workspace }],
    ] as const) {
      const calls: string[][] = [];
      const result = await closeAcceptanceCmuxWorkspaceAfterSingletonProof("cmux", acceptanceWorkspace, caller, async (args) => {
        calls.push(args);
        return mockCmuxResult(stdout);
      });
      assert.equal(result, false, label);
      assert.equal(calls.some((args) => args[0] === "close-workspace" || args[0] === "close-surface"), false, label);
      if (label === "caller overlap" || label === "cross-type caller overlap") assert.deepEqual(calls, [], label);
      else assert.deepEqual(calls, [["--json", "--id-format", "both", "tree", "--all"]], label);
    }
  });

  test("closes only the exact acceptance workspace and preserves the recorded caller workspace", async () => {
    const { closeAcceptanceCmuxWorkspaceAfterSingletonProof, verifyCmuxCallerPreserved } = await import("./live-harness");
    const calls: string[][] = [];
    const live = new Set([CMUX_IDS.callerWorkspace, CMUX_IDS.workspace]);
    const runner = async (args: string[]): Promise<MockCmuxResult> => {
      calls.push(args);
      if (args[0] === "close-workspace") {
        assert.deepEqual(args, ["close-workspace", "--workspace", CMUX_IDS.workspace]);
        live.delete(CMUX_IDS.workspace);
        return mockCmuxResult({});
      }
      if (args[3] === "tree" && args[4] === "--workspace") {
        assert.deepEqual(args, ["--json", "--id-format", "both", "tree", "--workspace", CMUX_IDS.callerWorkspace]);
        return mockCmuxResult(workspaceTree([{ id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" }]));
      }
      assert.deepEqual(args, ["--json", "--id-format", "both", "tree", "--all"]);
      return mockCmuxResult(workspaceTree([
        ...(live.has(CMUX_IDS.callerWorkspace) ? [{ id: CMUX_IDS.callerWorkspace, pane: CMUX_IDS.callerPane, surface: CMUX_IDS.callerSurface, name: "caller" }] : []),
        ...(live.has(CMUX_IDS.workspace) ? [{ id: CMUX_IDS.workspace, pane: CMUX_IDS.pane, surface: CMUX_IDS.surface, name: "acceptance" }] : []),
      ]));
    };
    assert.equal(await closeAcceptanceCmuxWorkspaceAfterSingletonProof("cmux", acceptanceWorkspace, callerIdentity, runner), true);
    assert.equal(live.has(CMUX_IDS.callerWorkspace), true);
    assert.equal(await verifyCmuxCallerPreserved("cmux", callerIdentity, runner), true);
    assert.equal(calls.some((args) => args.includes(CMUX_IDS.callerWorkspace) && (args[0] === "close-workspace" || args[0] === "close-surface")), false);
  });
});
