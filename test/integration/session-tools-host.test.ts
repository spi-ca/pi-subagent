import { test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  VERSION, createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../src/core/agents";
import { buildForkBranchSourceJsonl } from "../../src/core/fork-session";
import { assertSelectedPiHost, SELECTED_PI_VERSION } from "../helpers/selected-pi-host";

// Capture an unconfigured parent CLI, independently of Bun's test arguments.
const originalArgv = process.argv;
process.argv = ["bun", "pi"];
const {
  buildPiArgs, buildInteractivePiArgs, buildInteractiveChildSessionJsonl,
  assertManagedChildToolCompatibility, collectManagedOverriddenBuiltinTools, runAgent,
} = await import("../../src/runtime/runner");
process.argv = originalArgv;
// Deliberately exercise the installed CLI parser, not a local --tools emulator.
const { parseArgs } = await import(new URL("./cli/args.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const agent: AgentConfig = { name: "reader", description: "", systemPrompt: "", source: "user", filePath: "/reader.md" };

for (const checkpoint of [false, true]) {
  test(`Pi ${SELECTED_PI_VERSION} fork/resume ${checkpoint ? "compaction checkpoint" : "system deltas"}: explicit tools win; omissions restore; modifiers apply to restored tools`, { timeout: 20_000 }, async () => {
    assertSelectedPiHost();
    const previousOffline = process.env.PI_OFFLINE, originalFetch = globalThis.fetch;
    let forbiddenCalls = 0;
    const forbidden = (): never => { forbiddenCalls++; throw new Error("No credentials, network or provider calls in offline tool restoration test"); };
    process.env.PI_OFFLINE = "1";
    globalThis.fetch = forbidden as unknown as typeof fetch;
    await fs.mkdir(path.join(process.cwd(), ".bun-tmp"), { recursive: true });
    const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/session-tools-"));
    const agentDir = path.join(root, "agent"), cwd = path.join(root, "workspace");
    const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
    try {
      await fs.mkdir(agentDir); await fs.mkdir(cwd);
      const settingsManager = SettingsManager.inMemory({ extensions: [], packages: [], defaultTools: ["read", "bash", "edit", "write"], cacheWarming: "off" });
      const resourceLoader = new DefaultResourceLoader({
        cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
        noPromptTemplates: true, noThemes: true, noContextFiles: true,
      });
      await resourceLoader.reload({ resolveProjectTrust: async () => false });
      assert.deepEqual(resourceLoader.getExtensions().errors, []);
      const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
        credentials: { read: forbidden, list: forbidden, modify: forbidden, delete: forbidden } });
      const model = modelRuntime.getModels()[0]; assert.ok(model);
      modelRuntime.stream = forbidden; modelRuntime.streamSimple = forbidden; modelRuntime.getAuth = forbidden;
      modelRuntime.checkAuth = forbidden; modelRuntime.classify = forbidden; modelRuntime.generateImages = forbidden;
      async function host(manager: SessionManager, argv: string[]) {
        const parsed = parseArgs(argv);
        // Same CLI -> SDK selection mapping as Pi main.ts. No prompt or provider.
        const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, modelRuntime, model,
          thinkingLevel: "off", sessionManager: manager, tools: parsed.tools, noTools: parsed.noTools ? "all" : undefined });
        sessions.push(session);
        await session.bindExtensions({});
        return session;
      }
      const parent = SessionManager.inMemory(cwd);
      const parentHost = await host(parent, []);
      assert.deepEqual(parentHost.getActiveToolNames().sort(), ["bash", "edit", "read", "write"], "no transcript declaration uses host defaults");
      const declarations = (names: string[]) => names.map(name => {
        const tool = parentHost.getAllTools().find(tool => tool.name === name)!;
        assert.ok(tool);
        return { name: tool.name, description: tool.description, parameters: tool.parameters };
      });
      // Native persisted system-message contract, with real built-in declarations.
      parent.appendMessage({ role: "system", content: "", toolsAdded: declarations(["read", "write"]), timestamp: 1 });
      parent.appendMessage({ role: "system", content: "", toolsRemoved: [{ name: "write" }], toolsAdded: declarations(["grep"]), timestamp: 2 });
      parent.appendMessage({ role: "user", content: "branch anchor", timestamp: 3 });
      if (checkpoint) {
        // Retain-none compaction must restore its complete checkpoint, not the
        // pre-compaction write declaration or current host defaults.
        parent.appendCompaction("offline checkpoint", null, 100);
      }
      const snapshot = buildForkBranchSourceJsonl(parent);
      assert.notEqual(snapshot, null);
      assert.equal(snapshot, parent.getBranch().map(entry => JSON.stringify(entry)).join("\n") + "\n");
      const parentBefore = JSON.stringify(parent.getBranch());
      const overridden = collectManagedOverriddenBuiltinTools([
        { name: "grep", sourceInfo: { source: "extension", path: "/parent/grep-wrapper.ts" } },
      ]);
      assert.deepEqual(overridden, ["grep"]);
      const previousPolicy = process.env.PI_SUBAGENT_CMUX_CHILD_POLICY;
      process.env.PI_SUBAGENT_CMUX_CHILD_POLICY = "managed";
      try {
        for (const terminalMode of ["inline", "tmux-pane"] as const) {
          for (const delegationMode of ["fork", "spawn"] as const) {
            for (const tools of [undefined, ["read", "ls"]]) {
              const result = await runAgent({
                cwd, agents: [{ ...agent, tools }], agentName: agent.name, task: "Never launch",
                delegationMode, terminalMode, forkSessionSnapshotJsonl: snapshot!,
                managedOverriddenBuiltinTools: overridden,
                // The next prelaunch fence is a sentinel: permitted selections
                // reach it without ever creating artifacts or launching a child.
                interactiveShutdownGeneration: -1,
                parentDepth: 0, parentAgentStack: [], maxDepth: 5, preventCycles: true,
                makeDetails: results => ({ mode: "single", results, toolLabel: "Subagent", delegationMode, terminalMode, projectAgentsDir: null }),
              });
              if (delegationMode === "fork" && tools === undefined) {
                assert.equal(result.exitCode, 1, "omitted fork tools must fail compatibility before the launch fence");
                assert.equal(result.stopReason, "error");
                assert.match(result.errorMessage ?? "", /extension overrides.*grep/);
              } else {
                assert.equal(result.exitCode, 130, "explicit lists without grep and fresh spawn remain compatible");
                assert.match(result.errorMessage ?? "", /shutdown fenced/);
              }
              assert.deepEqual(result.messages, []);
            }
          }
        }
      } finally {
        if (previousPolicy === undefined) delete process.env.PI_SUBAGENT_CMUX_CHILD_POLICY;
        else process.env.PI_SUBAGENT_CMUX_CHILD_POLICY = previousPolicy;
      }
      const selections = [
        { tools: ["read", "ls"], expected: ["ls", "read"], policy: "managed" as const },
        { tools: ["read", "ls"], expected: ["ls", "read"], policy: "inherit" as const },
        { tools: undefined, expected: ["grep", "read"], policy: "managed" as const },
        { tools: undefined, expected: ["grep", "read"], policy: "inherit" as const },
        { tools: ["+ls", "-grep"], expected: ["ls", "read"], policy: "inherit" as const },
      ];
      for (const [index, selection] of selections.entries()) {
        for (const interactive of [false, true]) {
          const sessionPath = path.join(root, `child-${index}-${interactive}.jsonl`);
          await fs.writeFile(sessionPath, buildInteractiveChildSessionJsonl({ cwd, parentSessionFile: "/never-open-parent.jsonl", forkSessionSnapshotJsonl: snapshot! }));
          const role = { ...agent, tools: selection.tools };
          const argv = interactive
            ? buildInteractivePiArgs(role, null, "/task", sessionPath, undefined, selection.policy, undefined, VERSION)
            : buildPiArgs(role, null, "/task", "fork", sessionPath, undefined, selection.policy, undefined, VERSION);
          const parsed = parseArgs(argv);
          assert.equal(parsed.session, sessionPath);
          assert.deepEqual(parsed.tools, selection.tools, "builders must not rewrite full allowlists into modifiers");
          if (selection.policy === "managed") assert.ok(argv.includes("--no-mcp") && argv.includes("--no-extensions"));
          // Opening the production child snapshot, then reopening the same file,
          // covers both initial fork startup and ordinary persisted resume.
          for (const phase of ["fork", "resume"]) {
            const manager = SessionManager.open(parsed.session, root);
            assert.equal(manager.getHeader()?.parentSession, undefined);
            const session = await host(manager, argv);
            assert.deepEqual(session.getActiveToolNames().sort(), selection.expected, `${phase}, interactive=${interactive}, tools=${selection.tools}`);
            assert.equal(session.getActiveToolNames().includes("write"), false);
            if (selection.tools && !selection.tools[0]!.startsWith("+")) {
              assert.deepEqual(session.getAllTools().map(tool => tool.name).sort(), selection.expected, "explicit role also restricts the registry");
            }
            session.dispose();
          }
        }
      }
      const empty = SessionManager.inMemory(cwd);
      empty.appendMessage({ role: "system", content: "", toolsAdded: [], timestamp: 5 });
      assert.deepEqual((await host(empty, [])).getActiveToolNames(), [], "an explicitly empty transcript loadout is not host defaults");
      assert.deepEqual((await host(parent, ["--no-tools"])).getActiveToolNames(), [], "explicit no-tools disables restoration");
      assert.throws(() => assertManagedChildToolCompatibility({ tools: ["+ls", "-grep"] }, undefined, [], false, VERSION), /cannot preserve/,
        "managed mode must retain its fail-closed exact-selection guard");
      assert.equal(JSON.stringify(parent.getBranch()), parentBefore, "fork startup must not mutate parent branch bytes");
      assert.equal(forbiddenCalls, 0);
    } finally {
      for (const session of sessions) session.dispose();
      globalThis.fetch = originalFetch;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
