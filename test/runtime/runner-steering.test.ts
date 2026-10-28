import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ts from "typescript";
import { runAgent, beginInteractiveShutdownForSession, canStartInteractiveRun, getInteractiveShutdownGenerationForTest, resetInteractiveShutdownForSession } from "../../src/runtime/runner";
import { LifecycleEventServer } from "../../src/runtime/lifecycle-socket";
import { getFinalOutput } from "../../src/core/types";
import type { SteeringHandle, SteeringOutcome } from "../../src/core/subagent-steering";

// Execute the actual lexical handle-registration statements without launching a
// broker, provider or UI. AST selection avoids duplicating the authority guards
// and keeps production free of a test-only public factory/export.
async function runnerSteeringBoundary(kind: "inline" | "interactive", bindings: Record<string, unknown>) {
  const source = await fs.readFile(new URL("../../src/runtime/runner.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("runner.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let statements: readonly ts.Statement[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node)) {
      const ready = node.statements.at(-1);
      if (ready && ts.isExpressionStatement(ready) && ts.isCallExpression(ready.expression)
        && ts.isPropertyAccessExpression(ready.expression.expression)
        && ready.expression.expression.name.text === "onSteeringReady"
        && ready.expression.expression.expression.getText(file) === (kind === "inline" ? "opts" : "options")) {
        const start = node.statements.findIndex(statement => ts.isVariableStatement(statement)
          && statement.declarationList.declarations.some(declaration => declaration.name.getText(file) === "available"));
        if (start >= 0) { assert.equal(statements, undefined, "one production boundary"); statements = node.statements.slice(start); }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(statements, "production steering boundary must exist");
  const code = ts.transpileModule(`
    let completionFenced = false;
    let handle;
    options.onSteeringReady = opts.onSteeringReady = value => { handle = value; };
    ${statements.map(statement => statement.getText(file)).join("\n")}
    return { handle, complete: () => { completionFenced = true; } };
  `, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as { handle: SteeringHandle; complete: () => void };
}

for (const ack of ["submitted", "rejected"] as const) {
  for (const race of ["promotion", "completion", "durable-completion", "completion-read-failure", "shutdown", "generation", "signal", "availability", "eligibility-exception"] as const) {
    test(`interactive deferred ${ack} ACK is unknown after ${race} revokes live authority`, async () => {
      await resetInteractiveShutdownForSession();
      const generation = getInteractiveShutdownGenerationForTest();
      const controller = new AbortController();
      const run = { ownership: "managed" };
      let available = true, durableCompletion = false, readFailure = false, eligible = true;
      let admit!: () => void, settle!: (outcome: SteeringOutcome) => void;
      const admitted = new Promise<void>(resolve => { admit = resolve; });
      let requests = 0;
      const server = { isSteeringAvailable: () => available, requestSteer: () => {
        requests++; admit(); return new Promise<SteeringOutcome>(resolve => { settle = resolve; });
      } };
      const { handle, complete } = await runnerSteeringBoundary("interactive", {
        server, controlRunId: "exact-run", options: { signal: controller.signal, interactiveShutdownGeneration: generation }, opts: {},
        canStartInteractiveRun,
        activeInteractiveRuns: new Map([["exact-run", run]]), paths: {}, completionFenceNonce: "nonce",
        readVerifiedCompletionFence: async () => { if (readFailure) throw Error("private I/O failure"); return durableCompletion; },
      });
      const pending = handle("message", () => { if (!eligible) throw Error("private eligibility failure"); return true; });
      await admitted;
      if (race === "promotion") run.ownership = "transferring"; // promoteInteractiveRun's revocation point, before durable ACK
      if (race === "completion") complete();
      if (race === "durable-completion") durableCompletion = true;
      if (race === "completion-read-failure") readFailure = true;
      if (race === "shutdown") await beginInteractiveShutdownForSession();
      if (race === "generation") await resetInteractiveShutdownForSession();
      if (race === "signal") controller.abort();
      if (race === "availability") available = false;
      if (race === "eligibility-exception") eligible = false;
      settle(ack);
      assert.equal(await pending, "unknown");
      assert.equal(requests, 1, "possible delivery is never retried");
    });
  }
}

for (const kind of ["inline", "interactive"] as const) {
  test(`${kind} ACK fence preserves valid ACKs and known unsent outcomes`, async () => {
    for (const outcome of ["submitted", "rejected", "unavailable", "busy", "queue-full", "unknown"] as const) {
      let reads = 0, available = true;
      const boundary = await runnerSteeringBoundary(kind, {
        server: { isSteeringAvailable: () => available, requestSteer: async () => {
          if (outcome !== "submitted" && outcome !== "rejected") available = false;
          return outcome;
        } }, controlRunId: "exact-run", runId: "exact-run", options: {}, opts: {}, signal: undefined,
        interactiveShutdownGeneration: 0, canStartInteractiveRun: () => true,
        activeInteractiveRuns: new Map([["exact-run", { ownership: "kept" }]]), paths: {}, completionFenceNonce: "nonce",
        readVerifiedCompletionFence: async () => { reads++; return false; },
      });
      assert.equal(await boundary.handle("message"), outcome);
      assert.equal(reads, kind === "inline" ? 0 : outcome === "submitted" || outcome === "rejected" ? 2 : 1);
    }
  });
}

test("interactive deferred completion validation rechecks live authority after its await", async () => {
  let reads = 0, settle!: (value: boolean) => void, enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const run = { ownership: "managed" };
  const boundary = await runnerSteeringBoundary("interactive", {
    server: { isSteeringAvailable: () => true, requestSteer: async () => "submitted" },
    controlRunId: "exact-run", options: {}, opts: {}, canStartInteractiveRun: () => true,
    activeInteractiveRuns: new Map([["exact-run", run]]), paths: {}, completionFenceNonce: "nonce",
    readVerifiedCompletionFence: async () => {
      if (++reads === 1) return false;
      enter(); return new Promise<boolean>(resolve => { settle = resolve; });
    },
  });
  const pending = boundary.handle("message");
  assert.equal(await Promise.race([entered.then(() => true), pending.then(() => false)]), true,
    "ACK must not settle before durable completion is revalidated");
  run.ownership = "transferring";
  settle(false);
  assert.equal(await pending, "unknown");
});

for (const kind of ["inline", "interactive"] as const) {
  test(`${kind} deferred ACK fails closed on availability observation exceptions`, async () => {
    let broken = false, settle!: (outcome: SteeringOutcome) => void, admit!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const boundary = await runnerSteeringBoundary(kind, {
      server: { isSteeringAvailable: () => { if (broken) throw Error("private authority error"); return true; },
        requestSteer: () => { admit(); return new Promise<SteeringOutcome>(resolve => { settle = resolve; }); } },
      controlRunId: "exact-run", runId: "exact-run", options: {}, opts: {}, signal: undefined, interactiveShutdownGeneration: 0,
      canStartInteractiveRun: () => true, activeInteractiveRuns: new Map([["exact-run", { ownership: "managed" }]]),
      paths: {}, completionFenceNonce: "nonce", readVerifiedCompletionFence: async () => false,
    });
    const pending = boundary.handle("message");
    await admitted; broken = true; settle("submitted");
    assert.equal(await pending, "unknown");
  });
}

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

test("inline background runner automatically binds reporting, preserves no-tools and degrades without a socket", { timeout: 10_000 }, async () => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/runner-report-"));
  const oldArgv = process.argv[1], saved = { ...process.env };
  const fake = path.join(root, "fake-pi.ts"), bridgePath = path.join(process.cwd(), "src/runtime/inline-steering-bridge.ts");
  await fs.writeFile(fake, `
    import bridge from ${JSON.stringify(bridgePath)};
    const handlers = new Map(), tools = [];
    let active = process.argv.includes("--no-tools") ? [] : (process.argv.includes("--tools") ? process.argv[process.argv.indexOf("--tools") + 1].split(",") : ["grep", "ls"]);
    const pi = { on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); }, registerTool(tool) { tools.push(tool); },
      getActiveTools() { return active; }, setActiveTools(names) { active = names; } };
    const ctx = { isIdle: () => false, signal: new AbortController().signal, shutdown() {} };
    const emit = async event => { for (const fn of handlers.get(event) ?? []) await fn({}, ctx); };
    const output = text => process.stdout.write(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] }) + "\\n");
    if (process.argv.includes(${JSON.stringify(bridgePath)})) {
      bridge(pi); await emit("session_start"); await emit("agent_start");
      const selected = active.includes("report_to_parent");
      if (selected) {
        if (tools.length !== 1 || tools[0].name !== "report_to_parent") throw Error("missing tool");
        const expected = process.argv.includes("--tools") ? ["read", "report_to_parent"] : ["grep", "ls", "report_to_parent"];
        if (JSON.stringify(active) !== JSON.stringify(expected)) throw Error("widened or lost tools: " + active);
        if (process.env.PI_SUBAGENT_PARENT_REPORT || process.env.PI_SUBAGENT_LIFECYCLE_TOKEN_PATH || process.env.PI_SUBAGENT_LIFECYCLE_SOCKET_PATH) throw Error("nested ambient leak");
        const result = await tools[0].execute("call", { message: "/skill:literal report" }, ctx.signal, undefined, ctx);
        output(result.content[0].text);
      } else {
        if (tools.length) throw Error("forbidden tool auto-enabled");
        output("not selected");
      }
      await emit("agent_settled");
      process.stdout.write(JSON.stringify({ type: "agent_settled", aborted: false }) + "\\n");
    } else {
      if (process.env.PI_SUBAGENT_PARENT_REPORT) throw Error("ambient report capability leak");
      output("foreground untouched");
    }
  `);
  process.argv[1] = fake;
  process.env.TMPDIR = root;
  process.env.PI_SUBAGENT_RUN_STATE_DIR = path.join(root, `pi-subagent-runs-${process.getuid?.()}`);
  process.env.PI_SUBAGENT_PARENT_REPORT = "1"; // must not be inherited as authority
  const agent = { name: "child", description: "", systemPrompt: "", source: "user" as const, filePath: path.join(root, "child.md"), tools: ["read"] };
  const opts = { cwd: process.cwd(), agents: [agent], agentName: agent.name, task: "task", delegationMode: "spawn" as const, terminalMode: "inline" as const, parentDepth: 0, parentAgentStack: [], maxDepth: 3, preventCycles: true,
    makeDetails: (results: any[]) => ({ mode: "single" as const, toolLabel: "Subagent", delegationMode: "spawn" as const, terminalMode: "inline" as const, projectAgentsDir: null, results }) };
  const reports: string[] = [];
  const onParentReport = (message: string) => { reports.push(message); return true; };
  try {
    const foreground = await runAgent(opts);
    assert.equal(foreground.exitCode, 0); assert.equal(getFinalOutput(foreground.messages), "foreground untouched");
    for (const delegationMode of ["spawn", "fork"] as const) {
      for (const tools of [["read"], undefined]) {
        const selected = await runAgent({ ...opts, delegationMode, forkSessionSnapshotJsonl: "", agents: [{ ...agent, tools }], onParentReport });
        assert.equal(selected.exitCode, 0, selected.stderr);
        assert.match(getFinalOutput(selected.messages), /Parent notification submitted/);
        assert.equal(JSON.stringify(selected).includes("lifecycle-token"), false);
      }
    }
    assert.equal(reports.length, 4);
    const noTools = await runAgent({ ...opts, agents: [{ ...agent, tools: [] }], onSteeringReady: () => undefined, onParentReport });
    assert.equal(noTools.exitCode, 0, noTools.stderr);
    assert.equal(getFinalOutput(noTools.messages), "not selected");
    assert.equal(reports.length, 4);
    // Inherited --no-tools is captured at module load, so use a fresh process.
    // An explicit role allowlist still overrides that fallback, as before.
    const fallback = spawnSync(process.execPath, ["--eval", `
      import assert from "node:assert/strict";
      process.argv = [process.execPath, ${JSON.stringify(fake)}, "--no-tools", "--exclude-tools", "bash"];
      const { runAgent, buildPiArgs, buildInteractivePiArgs, resetInteractiveShutdownForSession } = await import(${JSON.stringify(path.join(process.cwd(), "src/runtime/runner.ts"))});
      const base = ${JSON.stringify(opts)};
      base.makeDetails = results => ({ mode: "single", results, toolLabel: "Subagent", delegationMode: "spawn", terminalMode: "inline", projectAgentsDir: null });
      let reports = 0;
      try {
        for (const tools of [undefined, ["read"]]) {
          const agent = { ...base.agents[0], tools };
          for (const args of [buildPiArgs(agent, null, "/task", "fork", "/session", undefined, "managed", undefined, "1.3.0", true),
            buildInteractivePiArgs(agent, null, "/task", "/session", undefined, "managed", undefined, "1.3.0", true)]) {
            assert.equal(args.includes("--no-tools"), tools === undefined);
            assert.equal(args[args.indexOf("--exclude-tools") + 1], "bash");
            if (tools) assert.equal(args[args.indexOf("--tools") + 1], "read,report_to_parent");
            else assert.equal(args.includes("--tools"), false);
          }
          const result = await runAgent({ ...base, agents: [agent], onParentReport: () => { reports++; return true; } });
          assert.equal(result.exitCode, 0, result.stderr);
          assert.equal(reports, tools ? 1 : 0);
        }
      } finally { await resetInteractiveShutdownForSession(); }
    `], { encoding: "utf8", timeout: 10_000 });
    assert.equal(fallback.status, 0, fallback.stderr);
    const foreign = await runAgent({ ...opts, managedOverriddenBuiltinTools: ["report_to_parent"], onParentReport });
    assert.equal(foreign.exitCode, 1); assert.match(foreign.errorMessage ?? "", /unrelated extension override/);

    await resetInteractiveShutdownForSession();
    const start = LifecycleEventServer.start;
    LifecycleEventServer.start = async () => { throw Error("socket unsupported"); };
    try {
      const unsupported = await runAgent({ ...opts, onParentReport });
      assert.equal(unsupported.exitCode, 0, unsupported.stderr);
      assert.equal(getFinalOutput(unsupported.messages), "foreground untouched", "automatic report omitted when socket unavailable");
      const explicit = await runAgent({ ...opts, agents: [{ ...agent, tools: ["read", "report_to_parent"] }], onParentReport });
      assert.equal(explicit.exitCode, 1); assert.match(explicit.errorMessage ?? "", /socket could not be enabled/);
    } finally { LifecycleEventServer.start = start; }
  } finally {
    process.argv[1] = oldArgv;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await resetInteractiveShutdownForSession();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("automatic reporting never starts a lifecycle server for shutdown, stale or cancelled invocations", async () => {
  await resetInteractiveShutdownForSession();
  const generation = getInteractiveShutdownGenerationForTest();
  const start = LifecycleEventServer.start;
  let starts = 0;
  LifecycleEventServer.start = async () => { starts++; throw Error("unexpected server preparation"); };
  const opts = {
    cwd: process.cwd(),
    agents: [{ name: "child", description: "", systemPrompt: "", source: "user" as const, filePath: "/child.md", tools: ["read"] }],
    agentName: "child", task: "must not launch", delegationMode: "spawn" as const, terminalMode: "inline" as const,
    interactiveShutdownGeneration: generation, parentDepth: 0, parentAgentStack: [], maxDepth: 3, preventCycles: true,
    onParentReport: () => true,
    makeDetails: (results: any[]) => ({ mode: "single" as const, results, toolLabel: "Subagent", delegationMode: "spawn" as const, terminalMode: "inline" as const, projectAgentsDir: null }),
  };
  try {
    await beginInteractiveShutdownForSession();
    assert.equal((await runAgent(opts)).exitCode, 130);
    assert.equal(starts, 0, "shutdown invocation must not reopen the server");
    await beginInteractiveShutdownForSession();
    await resetInteractiveShutdownForSession();
    assert.equal((await runAgent(opts)).exitCode, 130);
    assert.equal(starts, 0, "previous generation must not prepare a server after reset");
    const abort = new AbortController(); abort.abort();
    assert.equal((await runAgent({ ...opts, interactiveShutdownGeneration: getInteractiveShutdownGenerationForTest(), signal: abort.signal })).exitCode, 130);
    assert.equal(starts, 0, "cancelled invocation must not prepare a server");
  } finally {
    LifecycleEventServer.start = start;
    await resetInteractiveShutdownForSession();
  }
});
