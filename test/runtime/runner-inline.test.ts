import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildStoppedBootstrapArgv, monitorInlineProcess, resolvePiSpawnForTest, resumeStoppedBootstrapForTest, runAgent, signalUnixProcessTree, STOPPED_BOOTSTRAP_WATCHDOG_SECONDS, type StoppedProcessResumeProbe } from "../../src/runtime/runner";
import { getProcessStartedAt } from "../../src/runtime/run-protocol";
import { AssistantSignatureIndex } from "../../src/runtime/assistant-signature-index";
import { emptyUsage, getFinalOutput, normalizeCompletedResult } from "../../src/core/types";

describe("inline runner path", () => {
  test("uses an absolute Pi entrypoint only for Node and Bun interpreter hosts", () => {
    assert.deepEqual(resolvePiSpawnForTest({ execPath: "/opt/homebrew/bin/bun", argv: ["bun", "relative/pi.ts"] }), {
      command: "/opt/homebrew/bin/bun", prefixArgs: [path.resolve("relative/pi.ts")],
    });
    assert.deepEqual(resolvePiSpawnForTest({ execPath: "C:\\Tools\\bun.exe", argv: ["bun.exe", "C:\\Pi\\pi.js"] }), {
      command: "C:\\Tools\\bun.exe", prefixArgs: [path.resolve("C:\\Pi\\pi.js")],
    });
    assert.deepEqual(resolvePiSpawnForTest({ execPath: "/Applications/Pi.app/Contents/MacOS/pi", argv: ["pi", "/ignored/pi.ts"] }), {
      command: "/Applications/Pi.app/Contents/MacOS/pi", prefixArgs: [],
    });
    assert.deepEqual(resolvePiSpawnForTest({ execPath: "/usr/local/bin/deno", argv: ["deno", "/ignored/pi.ts"] }), {
      command: "/usr/local/bin/deno", prefixArgs: [],
    });
  });

  test("signals the Unix process group before falling back to the direct child", () => {
    const calls: Array<[number | string, string]> = [];
    const proc = {
      pid: 123,
      kill(signal: string) {
        calls.push(["direct", signal]);
        return true;
      },
    };
    signalUnixProcessTree(proc as any, "SIGTERM", (pid, signal) => {
      calls.push([pid, signal]);
      return true;
    });
    assert.deepEqual(calls, [[-123, "SIGTERM"]]);

    calls.length = 0;
    signalUnixProcessTree(proc as any, "SIGKILL", () => {
      throw new Error("missing process group");
    });
    assert.deepEqual(calls, [["direct", "SIGKILL"]]);
  });

  test("retries transient stopped-state probe failures before resuming an exact child", async () => {
    const signals: Array<[number, string]> = [];
    const states: Array<"unknown" | "stopped"> = ["unknown", "unknown", "stopped"];
    const probe: StoppedProcessResumeProbe = {
      getStartedAt: () => 101,
      getStoppedState: () => states.shift() ?? "stopped",
      classifyIdentity: () => "live",
      signal: (pid, signal) => { signals.push([pid, signal]); return true; },
      now: Date.now,
      sleep: async () => undefined,
    };

    const result = await resumeStoppedBootstrapForTest({ processId: 42, expectedStartedAt: 101, probe });
    assert.equal(result, "resumed");
    assert.deepEqual(signals, [[42, "SIGCONT"]]);
  });

  test("does not resume when the bootstrap start identity changed", async () => {
    const signals: Array<[number, string]> = [];
    const probe: StoppedProcessResumeProbe = {
      getStartedAt: () => 202,
      getStoppedState: () => { throw new Error("must not probe a changed identity"); },
      classifyIdentity: () => "dead",
      signal: (pid, signal) => { signals.push([pid, signal]); return true; },
      now: Date.now,
      sleep: async () => undefined,
    };

    assert.equal(await resumeStoppedBootstrapForTest({ processId: 42, expectedStartedAt: 101, probe }), "identity-changed");
    assert.deepEqual(signals, []);
  });

  test("does not resume an externally running bootstrap", async () => {
    const signals: Array<[number, string]> = [];
    const probe: StoppedProcessResumeProbe = {
      getStartedAt: () => 101,
      getStoppedState: () => "running",
      classifyIdentity: () => "live",
      signal: (pid, signal) => { signals.push([pid, signal]); return true; },
      now: Date.now,
      sleep: async () => undefined,
    };

    assert.equal(await resumeStoppedBootstrapForTest({ processId: 42, expectedStartedAt: 101, probe }), "not-stopped");
    assert.deepEqual(signals, []);
  });

  test("bounds transient stopped-state uncertainty by the resume deadline", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const probe: StoppedProcessResumeProbe = {
      getStartedAt: () => 101,
      getStoppedState: () => "unknown",
      classifyIdentity: () => "live",
      signal: () => { throw new Error("must not signal an unknown state"); },
      now: () => now,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; },
    };

    assert.equal(await resumeStoppedBootstrapForTest({ processId: 42, expectedStartedAt: 101, timeoutMs: 25, probe }), "timeout");
    assert.deepEqual(sleeps, [10, 10, 5]);
    assert.equal(now, 25);
  });

  test("resumes 16 exact production stopped bootstraps after a >2s identity-handling stagger with no residual group", { timeout: 20_000 }, async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const children = Array.from({ length: 16 }, () => spawn("/bin/sh", buildStoppedBootstrapArgv("/bin/sh", ["-c", "exit 0"]), { detached: true, stdio: "ignore" }));
    const exits = children.map((child) => new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }));
    const stopped = (pid: number): boolean => {
      const probe = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      return probe.status === 0 && /^[Tt]/.test(String(probe.stdout).trim());
    };
    const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    const noProcessGroup = (pid: number): boolean => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    const identities: number[] = [];
    try {
      for (const child of children) {
        assert.ok(child.pid);
        await waitFor(() => getProcessStartedAt(child.pid!) !== null && stopped(child.pid!), "production stopped bootstrap");
        const identity = getProcessStartedAt(child.pid!);
        assert.notEqual(identity, null);
        identities.push(identity!);
      }
      const staggerMs = 175;
      assert.ok(staggerMs * 15 > 2_000 && staggerMs * 15 < STOPPED_BOOTSTRAP_WATCHDOG_SECONDS * 1_000);
      const staggerStartedAt = Date.now();
      const resumes = await Promise.all(children.map(async (child, index) => {
        await new Promise((resolve) => setTimeout(resolve, index * staggerMs));
        return resumeStoppedBootstrapForTest({ processId: child.pid!, expectedStartedAt: identities[index]!, timeoutMs: 1_000 });
      }));
      assert.ok(Date.now() - staggerStartedAt > 2_000, "identity handling must extend past the former two-second watchdog");
      assert.deepEqual(resumes, Array(16).fill("resumed"));
      assert.deepEqual(await Promise.all(exits), Array(16).fill({ code: 0, signal: null }));
      await Promise.all(children.map((child) => waitFor(() => getProcessStartedAt(child.pid!) === null, "exact resumed bootstrap exit")));
      await Promise.all(children.map((child) => waitFor(() => noProcessGroup(child.pid!), "resumed bootstrap process-group cleanup")));
    } finally {
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]!, identity = identities[index];
        if (child.pid && child.exitCode === null && identity !== undefined && getProcessStartedAt(child.pid) === identity) {
          try { process.kill(child.pid, "SIGCONT"); } catch {}
          try { process.kill(-child.pid, "SIGKILL"); } catch {}
        }
      }
    }
  });

  test("production stopped-bootstrap watchdog expires when no exact resume is issued", { timeout: 22_000 }, async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const child = spawn("/bin/sh", buildStoppedBootstrapArgv("/bin/sh", ["-c", "exit 0"]), { detached: true, stdio: "ignore" });
    const waitFor = async (predicate: () => boolean, label: string, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    const stopped = (pid: number): boolean => {
      const probe = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      return probe.status === 0 && /^[Tt]/.test(String(probe.stdout).trim());
    };
    const noProcessGroup = (pid: number): boolean => {
      try {
        process.kill(-pid, 0);
        return false;
      } catch {
        return true;
      }
    };
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let identity: number | null = null;
    try {
      assert.ok(child.pid);
      await waitFor(() => getProcessStartedAt(child.pid!) !== null && stopped(child.pid!), "production stopped bootstrap", 2_000);
      identity = getProcessStartedAt(child.pid!);
      assert.notEqual(identity, null);
      assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
      await waitFor(() => getProcessStartedAt(child.pid!) === null, "watchdog-killed bootstrap exit", 2_000);
      await waitFor(() => noProcessGroup(child.pid!), "watchdog bootstrap process-group cleanup", 2_000);
    } finally {
      if (child.pid && child.exitCode === null && identity !== null && getProcessStartedAt(child.pid) === identity) {
        try { process.kill(child.pid, "SIGCONT"); } catch {}
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    }
  });

  test("recovers a signal exit that occurred before monitor listeners attach", async () => {
    const proc = new EventEmitter() as any;
    proc.pid = 12345; proc.exitCode = null; proc.signalCode = "SIGTERM"; proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => true; proc.unref = () => undefined;
    const outcome = await monitorInlineProcess(proc, { agent: "fixture", messages: [], stderr: "", usage: emptyUsage(), isError: false } as any, undefined, () => undefined, undefined, undefined, null, 10);
    assert.deepEqual(outcome, { exitCode: 1, wasAborted: false });
  });

  test("bounds abort settlement when child identity is unavailable", async () => {
    const proc = new EventEmitter() as any;
    proc.pid = 12345; proc.exitCode = null; proc.signalCode = null; proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    proc.kill = () => { throw new Error("identity-unavailable path must not signal"); }; proc.unref = () => undefined;
    const controller = new AbortController();
    const monitored = monitorInlineProcess(proc, { agent: "fixture", messages: [], stderr: "", usage: emptyUsage(), isError: false } as any, controller.signal, () => undefined, undefined, undefined, null, 10);
    controller.abort();
    const outcome = await monitored;
    assert.deepEqual(outcome, { exitCode: 130, wasAborted: true });
  });

  test("cleans async prompt, fork session, and task artifacts after a cwd launch failure", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-inline-cleanup-"));
    const uidSuffix = typeof process.getuid === "function" ? `-${process.getuid()}` : "";
    const runStateDir = path.join(root, `pi-subagent-runs${uidSuffix}`);
    const originalTmpDir = process.env.TMPDIR;
    const originalRunStateDir = process.env.PI_SUBAGENT_RUN_STATE_DIR;
    process.env.TMPDIR = root;
    process.env.PI_SUBAGENT_RUN_STATE_DIR = runStateDir;
    try {
      const result = await runAgent({
        cwd: process.cwd(),
        taskCwd: path.join(root, "missing-cwd"),
        agents: [{ name: "worker", description: "Worker", systemPrompt: "private prompt", source: "user", filePath: "/tmp/worker.md" }],
        agentName: "worker",
        task: "private task",
        delegationMode: "fork",
        forkSessionSnapshotJsonl: JSON.stringify({ type: "message", id: "parent-entry", message: { role: "user", content: "context" } }) + "\n",
        terminalMode: "inline",
        parentDepth: 0,
        parentAgentStack: [],
        maxDepth: 3,
        preventCycles: true,
        makeDetails: (results) => ({ mode: "single", toolLabel: "Subagent", delegationMode: "fork", terminalMode: "inline", projectAgentsDir: null, results }),
      });
      assert.notEqual(result.exitCode, 0);
      const entries = await fs.promises.readdir(root);
      assert.deepEqual(entries, [path.basename(runStateDir)]);
      assert.deepEqual(
        await fs.promises.readdir(runStateDir),
        ["state-root-marker.json"],
      );
    } finally {
      if (originalTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpDir;
      if (originalRunStateDir === undefined) delete process.env.PI_SUBAGENT_RUN_STATE_DIR;
      else process.env.PI_SUBAGENT_RUN_STATE_DIR = originalRunStateDir;
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  test("serializes index-backed line processing without changing callback order", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-inline-index-"));
    await fs.promises.chmod(directory, 0o700);
    try {
      const script = [
        'process.stdout.write("{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"A\\"}]}}\\n");',
        'process.stdout.write("{\\"type\\":\\"agent_end\\",\\"messages\\":[{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"A\\"}]},{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"B\\"}]}]}\\n");',
      ].join("\n");
      const proc = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      const result = {
        agent: "scout", agentSource: "user" as const, task: "inline order", exitCode: -1,
        messages: [], stderr: "", usage: emptyUsage(),
      };
      const updates: string[] = [];
      await monitorInlineProcess(proc as any, result as any, undefined, () => {
        updates.push(getFinalOutput(result.messages as any));
      }, new AssistantSignatureIndex(directory));

      assert.deepEqual(updates, ["A", "B"]);
      assert.equal(result.messages.length, 2);
      assert.equal(getFinalOutput(result.messages as any), "B");
      assert.equal((result as any).sawAgentEnd, true);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  });

  test("accounts reused tool-call IDs once per inline execution across cumulative agent-end snapshots", async () => {
    const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
    const first = { role: "toolResult", toolCallId: "reused", usage: usage(4) };
    const second = { role: "toolResult", toolCallId: "reused", usage: usage(7) };
    const events = [
      { type: "tool_execution_end", toolCallId: "reused", result: { usage: first.usage } },
      { type: "turn_end", toolResults: [first] },
      { type: "agent_end", messages: [first] },
      { type: "tool_execution_end", toolCallId: "reused", result: { usage: second.usage } },
      { type: "turn_end", toolResults: [second] },
      { type: "agent_end", messages: [first, second] },
      { type: "agent_end", messages: [first, second] },
    ];
    const proc = spawn(process.execPath, ["-e", `for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + "\\n");`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = {
      agent: "scout", agentSource: "user" as const, task: "inline reused call", exitCode: -1,
      messages: [], stderr: "", usage: emptyUsage(),
    };

    const monitored = await monitorInlineProcess(proc as any, result as any, undefined, () => {});
    assert.equal(monitored.exitCode, 0);
    assert.equal((result as any).accountingUsage.totalTokens, 11);
    assert.deepEqual(result.messages, []);
  });

  test("bounds unterminated stdout and stderr for managed inline children", async () => {
    for (const stream of ["stdout", "stderr"] as const) {
      const proc = spawn(process.execPath, ["-e", `process.${stream}.write("x".repeat(128)); setInterval(() => {}, 1000);`], {
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      });
      const result = {
        agent: "scout", agentSource: "user" as const, task: "bounded output", exitCode: -1,
        messages: [], stderr: "", usage: emptyUsage(),
      };
      const monitored = await monitorInlineProcess(proc as any, result as any, undefined, () => {}, undefined, 64);
      assert.equal(monitored.exitCode, 1);
      assert.match(result.stderr, /bounded safety limit/);
    }
  });

  test("bounds cumulative newline-delimited stdout for managed inline children", async () => {
    const script = 'for(let i=0;i<32;i++) process.stdout.write("{}\\n"); setInterval(() => {}, 1000);';
    const proc = spawn(process.execPath, ["-e", script], {
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const result = {
      agent: "scout", agentSource: "user" as const, task: "bounded records", exitCode: -1,
      messages: [], stderr: "", usage: emptyUsage(),
    };
    const monitored = await monitorInlineProcess(proc as any, result as any, undefined, () => {}, undefined, 64);
    assert.equal(monitored.exitCode, 1);
    assert.match(result.stderr, /bounded safety limit/);
  });

  test("preserves semantic completion across chunked JSONL output", async () => {
    const script = [
      'process.stdout.write("{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"DO");',
      'process.stdout.write("NE\\"}]}}\\n");',
      'setTimeout(() => {',
      '  process.stdout.write("{\\"type\\":\\"agent_end\\",\\"messages\\":[{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"DONE\\"}]}]}\\n");',
      '  process.exit(5);',
      '}, 10);',
    ].join("\n");

    const proc = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = {
      agent: "scout",
      agentSource: "user" as const,
      task: "inline test",
      exitCode: -1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
    };

    const monitored = await monitorInlineProcess(proc as any, result as any, undefined, () => {});
    result.exitCode = monitored.exitCode;
    const normalized = normalizeCompletedResult(result as any, monitored.wasAborted);

    assert.equal(monitored.wasAborted, false);
    assert.equal(normalized.exitCode, 0);
    assert.equal(getFinalOutput(normalized.messages as any), "DONE");
    assert.equal(normalized.sawAgentEnd, true);
  });
});
