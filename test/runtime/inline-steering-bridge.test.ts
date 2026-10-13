import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import inlineBridge, { INLINE_STEERING_STATE_PATH_ENV } from "../../src/runtime/inline-steering-bridge";
import { STEERING_CUSTOM_TYPE } from "../../src/runtime/steering-inbox";
import { LifecycleEventServer, SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV, SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV, writeLifecycleBootstrapToken } from "../../src/runtime/lifecycle-socket";

const servers: LifecycleEventServer[] = [];
const roots: string[] = [];
const saved = { ...process.env };
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

async function fixture() {
  const server = await LifecycleEventServer.start(); servers.push(server);
  const root = await fs.mkdtemp(path.join(process.cwd(), ".bun-tmp/steering-")); roots.push(root);
  const id = "inline-steer-test", token = server.registerRun(id, true);
  server.activateRun(id);
  await writeLifecycleBootstrapToken(path.join(root, "lifecycle-token"), token);
  Object.assign(process.env, {
    PI_SUBAGENT_RUN_ID: id,
    [INLINE_STEERING_STATE_PATH_ENV]: path.join(root, "state.json"),
    [SUBAGENT_LIFECYCLE_SOCKET_PATH_ENV]: server.socketPath,
    [SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV]: path.join(root, "lifecycle-token"),
  });
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const sent: unknown[] = [];
  let idle = false, shutdowns = 0;
  const abort = new AbortController();
  const pi = { on: (name: string, handler: (...args: any[]) => any) => {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  }, sendUserMessage: (...args: unknown[]) => sent.push(args) };
  const ctx = { isIdle: () => idle, signal: abort.signal, shutdown: () => { shutdowns += 1; }, abort: () => abort.abort() };
  inlineBridge(pi as never);
  const emit = async (name: string, event = {}) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
    return results;
  };
  return { server, id, sent, emit, abort, handlers, setIdle: (value: boolean) => { idle = value; }, shutdowns: () => shutdowns };
}

describe("inline CLI steering extension", () => {
  test("uses existing child context and only submits the new literal message; closes on settled", async () => {
    const f = await fixture();
    await f.emit("session_start");
    assert.equal(process.env[INLINE_STEERING_STATE_PATH_ENV], undefined);
    assert.equal(process.env[SUBAGENT_LIFECYCLE_TOKEN_PATH_ENV], undefined);
    const wake = f.server.waitForEvent(f.id, 200);
    await f.emit("agent_start"); await wake;
    assert.equal(await f.server.requestSteer(f.id, "/skill:literal new message"), "submitted");
    assert.deepEqual(f.sent, []);
    assert.equal(await f.server.requestSteer(f.id, "busy"), "rejected");
    assert.deepEqual(await f.emit("turn_end", { entries: [], continue: false, outcome: "completed" }),
      [{ entries: [{ type: "custom_message", customType: STEERING_CUSTOM_TYPE, content: "/skill:literal new message", display: true }], continue: true }]);
    assert.deepEqual(await f.emit("turn_end", { entries: [], continue: false, outcome: "completed" }), [undefined]);
    f.setIdle(true);
    assert.equal(await f.server.requestSteer(f.id, "idle"), "rejected");
    const settled = f.server.waitForEvent(f.id, 200);
    await f.emit("agent_settled"); await settled;
    assert.equal(f.shutdowns(), 1);
    assert.equal(await f.server.requestSteer(f.id, "too late"), "unavailable");
    assert.equal(f.handlers.has("input"), false);
    assert.equal(f.handlers.has("before_agent_start"), false);
    assert.equal(f.sent.length, 0);
  });

  test("shutdown while session-start handshake is pending cannot restore a control client", async () => {
    const f = await fixture();
    const startup = f.emit("session_start");
    await f.emit("session_shutdown");
    await startup;
    await f.emit("agent_start");
    assert.equal(await f.server.requestSteer(f.id, "stale"), "unavailable");
    assert.equal(f.sent.length, 0);
  });

  test("agent_end drops pending steering, rejects pre-settle, and permits a normal continuation", async () => {
    const f = await fixture();
    await f.emit("session_start");
    const wake = f.server.waitForEvent(f.id, 200);
    await f.emit("agent_start"); await wake;
    assert.equal(await f.server.requestSteer(f.id, "unconsumed"), "submitted");
    const ended = f.server.waitForEvent(f.id, 200);
    await f.emit("agent_end", { messages: [] }); await ended;
    assert.equal(await f.server.requestSteer(f.id, "before settle"), "unavailable");
    assert.equal(f.handlers.has("agent_before_settle"), false);
    assert.deepEqual(await f.emit("agent_before_settle", { entries: [], continue: false, outcome: "completed" }), []);
    const restarted = f.server.waitForEvent(f.id, 200);
    await f.emit("agent_start"); await restarted;
    assert.deepEqual(await f.emit("turn_end", { entries: [], continue: false, outcome: "completed" }), [undefined]);
    assert.equal(await f.server.requestSteer(f.id, "normal continuation"), "submitted");
    assert.equal((await f.emit("turn_end", { entries: [], continue: false, outcome: "completed" }))[0].entries[0].content, "normal continuation");
    assert.equal(await f.server.requestSteer(f.id, "pending abort"), "submitted");
    f.abort.abort();
    assert.equal(await f.server.requestSteer(f.id, "already aborted"), "rejected");
    assert.deepEqual(await f.emit("turn_end", { entries: [], continue: false, outcome: "aborted" }), [undefined]);
    assert.equal(f.sent.length, 0);
  });
});
