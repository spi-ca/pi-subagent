import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runAgent, resetInteractiveShutdownForSession } from "../../src/runtime/runner";
import { getFinalOutput } from "../../src/core/types";
import type { SteeringHandle, SteeringOutcome } from "../../src/core/subagent-steering";

test("inline runner retains one-shot JSON/stdin, loads bridge only on opt-in and cleans terminal transport", async () => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/runner-steering-"));
  const oldArgv = process.argv[1], oldTmp = process.env.TMPDIR, oldState = process.env.PI_SUBAGENT_RUN_STATE_DIR;
  const fake = path.join(root, "fake-pi.ts");
  const bridge = path.join(process.cwd(), "src/runtime/inline-steering-bridge.ts");
  await fs.writeFile(fake, `
    import bridge from ${JSON.stringify(bridge)};
    const handlers = new Map();
    let admit;
    const admitted = new Promise(resolve => { admit = resolve; });
    const emit = async (event, value = {}) => {
      let draft = value;
      for (const fn of handlers.get(event) ?? []) {
        const result = await fn(draft, ctx);
        if (result) draft = { ...draft, ...result };
      }
      return draft;
    };
    const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    const message = (text) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });
    const ctx = { isIdle: () => { admit(); return false; }, signal: new AbortController().signal, abort() {}, shutdown() {} };
    const pi = {
      on(event, fn) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
      sendUserMessage() { throw Error("steering must bypass native input"); }
    };
    const args = process.argv.slice(2);
    if (!args.includes("json")) throw Error("not JSON mode");
    await new Promise(resolve => { process.stdin.resume(); process.stdin.on("end", resolve); });
    if (!args.includes(${JSON.stringify(bridge)})) {
      output({ type: "agent_end", messages: [message("foreground untouched")] });
    } else {
      bridge(pi); await emit("session_start"); await emit("agent_start");
      output({ type: "message_end", message: message("ready") });
      await admitted;
      const boundary = await emit("turn_end", { entries: [], continue: false, outcome: "completed" });
      if (!boundary.continue || boundary.entries.length !== 1 || boundary.entries[0].type !== "custom_message") throw Error("invalid inbox continuation");
      output({ type: "agent_end", messages: [message("before continuation")] });
      await emit("agent_end", { messages: [message("before continuation")] });
      await emit("agent_start"); output({ type: "agent_start" });
      // Longer than foreground semantic end grace; await final settlement.
      await new Promise(resolve => setTimeout(resolve, 400));
      output({ type: "agent_end", messages: [message(boundary.entries[0].content)] });
      await emit("agent_end", { messages: [message(boundary.entries[0].content)] });
      await emit("agent_settled"); output({ type: "agent_settled", aborted: false });
    }
  `);
  process.argv[1] = fake;
  process.env.TMPDIR = root;
  process.env.PI_SUBAGENT_RUN_STATE_DIR = path.join(root, `pi-subagent-runs-${process.getuid?.()}`);
  let handle: SteeringHandle | undefined, retained: SteeringHandle | undefined;
  let submission: Promise<SteeringOutcome> | undefined;
  const opts = {
    cwd: process.cwd(), agents: [{ name: "worker", description: "worker", systemPrompt: "", source: "user" as const, filePath: path.join(root, "worker.md") }],
    agentName: "worker", task: "initial context", delegationMode: "spawn" as const, terminalMode: "inline" as const,
    parentDepth: 0, parentAgentStack: [], maxDepth: 3, preventCycles: true,
    makeDetails: (results: any[]) => ({ mode: "single" as const, toolLabel: "Subagent", delegationMode: "spawn" as const, terminalMode: "inline" as const, projectAgentsDir: null, results }),
  };
  try {
    const foreground = await runAgent(opts);
    assert.equal(foreground.exitCode, 0);
    assert.equal(getFinalOutput(foreground.messages), "foreground untouched");
    const background = await runAgent({ ...opts,
      onSteeringReady: (next) => { handle = next; if (next) retained = next; },
      onUpdate: (partial) => {
        if (getFinalOutput(partial.details.results[0]!.messages) === "ready" && !submission) {
          assert.ok(handle);
          submission = handle!("new message only");
        }
      },
    });
    assert.equal(await submission, "submitted");
    assert.equal(background.exitCode, 0);
    assert.equal(getFinalOutput(background.messages), "new message only");
    assert.equal(handle, undefined);
    assert.equal(await retained!("late"), "unavailable");
    assert.deepEqual((await fs.readdir(root)).sort(), ["fake-pi.ts", path.basename(process.env.PI_SUBAGENT_RUN_STATE_DIR)].sort());
  } finally {
    process.argv[1] = oldArgv;
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    if (oldState === undefined) delete process.env.PI_SUBAGENT_RUN_STATE_DIR; else process.env.PI_SUBAGENT_RUN_STATE_DIR = oldState;
    await resetInteractiveShutdownForSession();
    await fs.rm(root, { recursive: true, force: true });
  }
});
