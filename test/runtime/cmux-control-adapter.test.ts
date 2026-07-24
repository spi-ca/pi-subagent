import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCmuxControlCommandRunner, getCmuxControlRequestManager, matchingSupportedCmuxVersions, resetCmuxControlRequestManagersForTest } from "../../src/runtime/cmux-control-adapter.mjs";
import { fakeCmuxControlServer, type FakeCmuxServer } from "../helpers/fake-cmux-control-server";

const roots: string[] = []; const servers: FakeCmuxServer[] = [];
afterEach(async () => { resetCmuxControlRequestManagersForTest(); while (servers.length) await servers.pop()!.close(); while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true }); });
const workspace = "2ff1ce1c-5160-461b-9412-a5630ea19054", pane = "acdc865f-c84c-4c55-a88f-052b7e8dbda3", surface = "0f61df95-d7d5-44d4-b251-b2b44df0cf8b";
const capabilities = { version: 2, protocol: "cmux-socket", access_mode: "automation", methods: ["system.tree", "surface.split", "surface.create", "surface.respawn", "surface.send_key", "surface.close", "surface.focus", "tab.action"] };

describe("cmux control-v2 command adapter", () => {
  test("requires the running identify version to match the supported app bundle", () => {
    assert.equal(matchingSupportedCmuxVersions("0.64.20", "0.64.20"), "0.64.20");
    assert.equal(matchingSupportedCmuxVersions("0.65.0", "0.65.0"), "0.65.0");
    assert.equal(matchingSupportedCmuxVersions(undefined, "0.65.0"), "0.65.0");
    for (const pair of [["0.64.19", "0.64.20"], ["0.64.20", "0.65.0"], ["0.65.0-rc1", "0.65.0"]] as const) assert.equal(matchingSupportedCmuxVersions(pair[0], pair[1]), null);
  });
  test("accepts the pinned live 0.64.20 capabilities contract", async () => {
    const fixture = JSON.parse(await fs.readFile(path.join(process.cwd(), "test/fixtures/cmux-control-v2.json"), "utf8"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-adapter-pinned-")); roots.push(root); await fs.chmod(root, 0o700);
    const socket = path.join(root, "cmux.sock");
    const fake = await fakeCmuxControlServer(socket, (request, server) => server.send(request.socket, { id: request.id, ok: true, result: request.method === "system.capabilities" ? fixture.capabilities_result : fixture.identify_result })); servers.push(fake);
    const ready = await getCmuxControlRequestManager({ env: { CMUX_SOCKET_PATH: socket }, appVersionValidator: (identify: Record<string, unknown>) => identify.app_bundle_path === "/Applications/cmux.app" }).ensureReady();
    assert.equal(ready.protocol, "cmux-socket"); assert.equal(ready.access_mode, "automation");
  });
  test("accepts stable current/higher app versions and rejects below/prerelease/malformed without extra handshake", async () => {
    for (const [version, accepted] of [["0.64.20", true], ["0.64.21", true], ["0.65.0", true], ["1.0.0", true], ["0.64.19", false], ["0.65.0-rc1", false], ["garbage", false]] as const) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-adapter-version-")); roots.push(root); await fs.chmod(root, 0o700);
      const socket = path.join(root, "cmux.sock");
      const fake = await fakeCmuxControlServer(socket, (request, server) => server.send(request.socket, { id: request.id, ok: true, result: request.method === "system.capabilities" ? capabilities : { app_version: version } })); servers.push(fake);
      const manager = getCmuxControlRequestManager({ broker: true, env: { CMUX_SOCKET_PATH: socket }, appVersionValidator: () => true });
      if (accepted) { const ready = await manager.ensureReady(); assert.equal(ready.detectedAppVersion, version); }
      else await assert.rejects(() => manager.ensureReady());
      assert.equal(fake.requests.length, 2);
      manager.close();
    }
  });

  test("caches only an identical expected-control authority without another handshake", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-adapter-authority-")); roots.push(root); await fs.chmod(root, 0o700);
    const socket = path.join(root, "cmux.sock");
    const fake = await fakeCmuxControlServer(socket, (request, server) => server.send(request.socket, { id: request.id, ok: true, result: request.method === "system.capabilities" ? capabilities : { app_version: "0.64.20" } })); servers.push(fake);
    const preflight = getCmuxControlRequestManager({ broker: true, env: { CMUX_SOCKET_PATH: socket }, appVersionValidator: () => true });
    await preflight.ensureReady();
    const identity = preflight.identity(); assert.ok(identity); preflight.close();
    const expected = {
      transport: "cmux-control-v2" as const, socketPath: identity.socketPath, socketDev: identity.socketDev, socketIno: identity.socketIno,
      accessMode: "automation", apiVersion: 2 as const, appVersion: "0.64.20",
      identifyDigest: crypto.createHash("sha256").update(JSON.stringify({ app_version: "0.64.20" }, ["app_version"])).digest("hex"),
    };
    const first = getCmuxControlRequestManager({ env: { CMUX_SOCKET_PATH: socket }, expectedControl: expected, appVersionValidator: () => true });
    await first.ensureReady();
    await fs.mkdir(path.join(root, "alias"));
    const reused = getCmuxControlRequestManager({ env: { CMUX_SOCKET_PATH: `${root}/alias/../cmux.sock` }, expectedControl: { ...expected }, appVersionValidator: () => true });
    assert.equal(reused, first);
    await reused.ensureReady();
    assert.equal(fake.requests.length, 4);

    const conflictingAuthorities = [
      { socketPath: path.join(root, "other.sock") },
      { socketDev: identity.socketDev === "0" ? "1" : "0" },
      { socketIno: identity.socketIno === "0" ? "1" : "0" },
      { accessMode: "password" },
      { apiVersion: 3 },
      { appVersion: "0.64.21" },
      { identifyDigest: "0".repeat(64) },
      { bootIdentity: "other-boot" },
      { transport: "other-control-v2" },
    ];
    for (const change of conflictingAuthorities) {
      const manager = getCmuxControlRequestManager({ env: { CMUX_SOCKET_PATH: socket }, expectedControl: { ...expected, ...change } as any, appVersionValidator: () => true });
      assert.notEqual(manager, first);
      await assert.rejects(() => manager.ensureReady(), /generation changed after preflight/);
    }

    const passwordOne = getCmuxControlRequestManager({ env: { CMUX_SOCKET_PATH: socket }, expectedControl: expected, password: "secret", appVersionValidator: () => true });
    const passwordTwo = getCmuxControlRequestManager({ env: { CMUX_SOCKET_PATH: socket }, expectedControl: expected, password: "secret", appVersionValidator: () => true });
    assert.notEqual(passwordOne, first);
    assert.notEqual(passwordOne, passwordTwo);
    const brokerPassword = getCmuxControlRequestManager({ broker: true, env: { CMUX_SOCKET_PATH: socket }, password: "secret", appVersionValidator: () => true });
    await assert.rejects(() => brokerPassword.ensureReady(), /password authentication is unsupported/);
    assert.equal(fake.requests.length, 4 + conflictingAuthorities.length * 2);
  });

  test("evicts a cached manager when app identity revalidation changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-adapter-rotate-")); roots.push(root); await fs.chmod(root, 0o700);
    const socket = path.join(root, "cmux.sock"); let validations = 0;
    const fake = await fakeCmuxControlServer(socket, (request, server) => server.send(request.socket, { id: request.id, ok: true, result: request.method === "system.capabilities" ? capabilities : request.method === "system.identify" ? { app_version: "0.64.20" } : {} })); servers.push(fake);
    const manager = getCmuxControlRequestManager({ env: { CMUX_SOCKET_PATH: socket }, appVersionValidator: () => ++validations !== 2 });
    await manager.ensureReady();
    await assert.rejects(() => manager.call((client: any) => client.tree()), /app generation changed/);
    await manager.ensureReady();
    assert.equal(new Set(fake.requests.map((request) => request.socket)).size, 2);
  });

  test("serializes a failing queued read until an in-flight mutation settles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-adapter-fifo-")); roots.push(root); await fs.chmod(root, 0o700);
    const socket = path.join(root, "cmux.sock"); let releaseSplit!: (request: any) => void;
    const splitRequested = new Promise<any>((resolve) => { releaseSplit = resolve; });
    const fake = await fakeCmuxControlServer(socket, (request, server) => {
      if (request.method === "system.capabilities") return server.send(request.socket, { id: request.id, ok: true, result: capabilities });
      if (request.method === "system.identify") return server.send(request.socket, { id: request.id, ok: true, result: { app_version: "0.64.20" } });
      if (request.method === "surface.split") return releaseSplit(request);
      server.send(request.socket, { id: request.id, ok: true, result: {} });
    }); servers.push(fake);
    let validations = 0;
    const manager = getCmuxControlRequestManager({ broker: true, env: { CMUX_SOCKET_PATH: socket }, appVersionValidator: () => ++validations !== 3 });
    const mutation = manager.call((client: any) => client.split({ workspace_id: workspace, surface_id: surface }));
    const split = await splitRequested;
    const read = manager.call((client: any) => client.tree());
    await Promise.resolve();
    assert.deepEqual(fake.requests.map((request) => request.method), ["system.capabilities", "system.identify", "surface.split"]);
    fake.send(split.socket, { id: split.id, ok: true, result: { workspace_id: workspace, pane_id: pane, surface_id: surface } });
    await mutation;
    await assert.rejects(read, /app generation changed/);
    assert.deepEqual(fake.requests.map((request) => request.method), ["system.capabilities", "system.identify", "surface.split"]);
  });

  test("bounds manager calls, preserves FIFO order, and skips an aborted queued call", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-adapter-queue-")); roots.push(root); await fs.chmod(root, 0o700);
    const socket = path.join(root, "cmux.sock"); let releaseSplit!: (request: any) => void;
    const splitRequested = new Promise<any>((resolve) => { releaseSplit = resolve; });
    const fake = await fakeCmuxControlServer(socket, (request, server) => {
      if (request.method === "system.capabilities") return server.send(request.socket, { id: request.id, ok: true, result: capabilities });
      if (request.method === "system.identify") return server.send(request.socket, { id: request.id, ok: true, result: { app_version: "0.64.20" } });
      if (request.method === "surface.split") return releaseSplit(request);
      if (request.method === "system.tree") return server.send(request.socket, { id: request.id, ok: true, result: { windows: [] } });
    }); servers.push(fake);
    const manager = getCmuxControlRequestManager({ broker: true, maxCallQueue: 1, env: { CMUX_SOCKET_PATH: socket }, appVersionValidator: () => true });
    const mutation = manager.call((client: any) => client.split({ workspace_id: workspace, surface_id: surface }));
    const split = await splitRequested;
    const controller = new AbortController();
    const aborted = manager.call((client: any) => client.tree(), { signal: controller.signal });
    await assert.rejects(() => manager.call((client: any) => client.tree()), (error: any) => error?.code === "CMUX_QUEUE_FULL");
    controller.abort();
    await assert.rejects(aborted, (error: any) => error?.code === "CMUX_ABORTED" && error?.state === "queued");
    const orderedRead = manager.call((client: any) => client.tree());
    fake.send(split.socket, { id: split.id, ok: true, result: { workspace_id: workspace, pane_id: pane, surface_id: surface } });
    await mutation; await orderedRead;
    assert.deepEqual(fake.requests.map((request) => request.method), ["system.capabilities", "system.identify", "surface.split", "system.tree"]);
  });

  test("uses one persistent parent connection, exact argv translation, and no CLI fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-adapter-")); roots.push(root); await fs.chmod(root, 0o700);
    const socket = path.join(root, "cmux.sock");
    const fake = await fakeCmuxControlServer(socket, (request, server) => {
      const value = request.method === "system.capabilities" ? capabilities : request.method === "system.identify" ? { app_version: "0.64.20" }
        : request.method === "system.tree" ? { windows: [{ workspaces: [{ id: workspace, panes: [{ id: pane, surfaces: [{ id: surface, pane_id: pane }] }] }] }] }
          : { workspace_id: workspace, pane_id: pane, surface_id: surface };
      server.send(request.socket, { id: request.id, ok: true, result: value });
    }); servers.push(fake);
    const env = { CMUX_SOCKET_PATH: socket, CMUX_SOCKET_CAPABILITY: "test-capability" };
    const manager = getCmuxControlRequestManager({ env, capability: "test-capability", appVersionValidator: (identify: Record<string, unknown>) => identify.app_version === "0.64.20" });
    const run = createCmuxControlCommandRunner({ manager });
    assert.equal((await run(["--version"])).exitCode, 0);
    assert.equal((await run(["--json", "--id-format", "both", "tree", "--all"])).exitCode, 0);
    assert.equal((await run(["--json", "--id-format", "both", "new-split", "right", "--workspace", workspace, "--surface", surface, "--focus", "false"])).exitCode, 0);
    const rawCommand = "exec /bin/bash '/tmp/child wrapper.sh'";
    assert.equal((await run(["respawn-pane", "--workspace", workspace, "--surface", surface, "--command", rawCommand])).exitCode, 0);
    assert.equal((await run(["focus-panel", "--workspace", workspace, "--panel", surface])).exitCode, 0);
    assert.equal((await run(["unknown-command"])).exitCode, 1);
    assert.equal(new Set(fake.requests.map((request) => request.socket)).size, 1);
    assert.deepEqual(fake.requests.map((request) => request.method), ["system.capabilities", "system.identify", "system.tree", "surface.split", "surface.respawn", "surface.focus"]);
    assert.deepEqual(fake.requests.find((request) => request.method === "surface.respawn")?.params, {
      workspace_id: workspace, surface_id: surface,
      command: "/bin/sh -c 'exec /bin/bash '\"'\"'/tmp/child wrapper.sh'\"'\"''",
      tmux_start_command: rawCommand, focus: false,
    });
    assert.deepEqual(fake.requests.find((request) => request.method === "surface.focus")?.params, { surface_id: surface });
  });

  test("preserves control error code/state and distinct exit codes", async () => {
    const timeout = Object.assign(new Error("timed out"), { code: "CMUX_TIMEOUT", state: "flushed" });
    const run = createCmuxControlCommandRunner({ manager: { call: async () => { throw timeout; } } as any });
    const failed = await run(["--json", "--id-format", "both", "tree", "--all"]);
    assert.deepEqual(failed.diagnostic, { kind: "control", code: "CMUX_TIMEOUT", state: "flushed" });
    assert.equal(failed.exitCode, 124);
    assert.doesNotMatch(failed.stderr, /timed out/);
    const controller = new AbortController(); controller.abort();
    const aborted = await run(["--json", "--id-format", "both", "tree", "--all"], { signal: controller.signal });
    assert.equal(aborted.exitCode, 130);
    assert.equal(aborted.aborted, true);
    assert.deepEqual(aborted.diagnostic, { kind: "control", code: "CMUX_ABORTED", state: "queued" });
    const secretFailure = createCmuxControlCommandRunner({ manager: { call: async () => { throw Object.assign(new Error("secret-canary /private/cmux.sock"), { code: "CMUX_SECRET_CANARY", state: "secret-state-/private/path" }); } } as any });
    const sanitized = await secretFailure(["--json", "--id-format", "both", "tree", "--all"]);
    assert.doesNotMatch(sanitized.stderr, /secret-canary|\/private\/cmux\.sock/);
    assert.deepEqual(sanitized.diagnostic, { kind: "control", code: "CMUX_CONTROL_FAILURE" });
    const unsupported = await run(["unknown"]);
    assert.deepEqual(unsupported.diagnostic, { kind: "adapter", code: "CMUX_ADAPTER_ARGV" });
  });

  test("passes command abort signals into manager calls", async () => {
    let received: AbortSignal | undefined;
    const manager = { call: async (_method: unknown, options: { signal?: AbortSignal }) => { received = options.signal; return { windows: [] }; } };
    const run = createCmuxControlCommandRunner({ manager: manager as any }); const controller = new AbortController();
    assert.equal((await run(["--json", "--id-format", "both", "tree", "--all"], { signal: controller.signal })).exitCode, 0);
    assert.equal(received, controller.signal);
  });

  test("gives a detached broker an independent control connection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-adapter-broker-")); roots.push(root); await fs.chmod(root, 0o700);
    const socket = path.join(root, "cmux.sock");
    const fake = await fakeCmuxControlServer(socket, (request, server) => {
      const value = request.method === "system.capabilities" ? capabilities : { app_version: "0.64.20" };
      server.send(request.socket, { id: request.id, ok: true, result: value });
    }); servers.push(fake);
    const env = { CMUX_SOCKET_PATH: socket };
    const validator = (identify: Record<string, unknown>) => identify.app_version === "0.64.20";
    await getCmuxControlRequestManager({ env, appVersionValidator: validator }).ensureReady();
    await getCmuxControlRequestManager({ env, broker: true, appVersionValidator: validator }).ensureReady();
    assert.equal(new Set(fake.requests.map((request) => request.socket)).size, 2);
  });
});
