import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { selectTmuxInteractivePlacement } from "../../src/runtime/interactive-layout";
import {
  executableGenerationKey,
  LaunchPreflightSingleFlight,
  readExecutableGeneration,
  readFileGeneration,
  sameExecutableGeneration,
  sameFileGeneration,
} from "../../src/runtime/launch-preflight";

describe("LaunchPreflightSingleFlight", () => {
  test("collapses concurrent read-only probes but separates strict keys", async () => {
    const preflight = new LaunchPreflightSingleFlight();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const probe = async () => { calls += 1; await gate; return "evidence"; };
    const first = preflight.read("cmux:generation-a", probe);
    const sibling = preflight.read("cmux:generation-a", probe);
    release();
    assert.deepEqual(await Promise.all([first, sibling]), ["evidence", "evidence"]);
    await preflight.read("cmux:generation-b", async () => { calls += 1; return "new"; });
    assert.equal(calls, 2);
    assert.deepEqual(preflight.metrics(), { fetches: 2, joins: 1, failures: 0 });
  });

  test("does not poison retries after a shared failure", async () => {
    const preflight = new LaunchPreflightSingleFlight();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const failing = async () => { await gate; throw new Error("unsupported"); };
    const one = preflight.read("tmux:source", failing);
    const two = preflight.read("tmux:source", failing);
    release();
    await assert.rejects(one, /unsupported/);
    await assert.rejects(two, /unsupported/);
    assert.equal(await preflight.read("tmux:source", async () => "fresh"), "fresh");
    assert.deepEqual(preflight.metrics(), { fetches: 2, joins: 1, failures: 1 });
  });

  test("fails closed when a shared tmux source snapshot mismatches its inherited identity", () => {
    assert.throws(() => selectTmuxInteractivePlacement({
      layout: "auto",
      source: { socketPath: "/tmp/canonical.sock", sourcePaneId: "%1", sourcePanePid: 100, serverPid: 99 },
      sourceTopology: { kind: "tmux-source-pane", socketPath: "/tmp/canonical.sock", serverPid: 99, paneId: "%1", panePid: 101, sessionId: "$0", windowId: "@0" },
    }), /exact source pane topology/);
  });

  test("fails closed when a canonical socket inode is replaced", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-socket-"));
    const socket = path.join(root, "tmux.sock");
    try {
      fs.writeFileSync(socket, "one");
      const before = readFileGeneration(socket);
      assert.ok(before);
      fs.renameSync(socket, `${socket}.old`);
      fs.writeFileSync(socket, "two");
      assert.equal(sameFileGeneration(before, readFileGeneration(socket)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the executable generation is replaced", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-preflight-"));
    const executable = path.join(root, "cmux");
    try {
      fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const before = readExecutableGeneration(executable);
      assert.ok(before);
      fs.renameSync(executable, `${executable}.old`);
      fs.writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      const after = readExecutableGeneration(executable);
      assert.ok(after);
      assert.notEqual(executableGenerationKey(before), executableGenerationKey(after));
      assert.equal(sameExecutableGeneration(before, after), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
