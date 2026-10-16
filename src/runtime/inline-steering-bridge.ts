import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LifecycleEventClient } from "./lifecycle-socket.js";
import { registerParentReportTool } from "./parent-report.js";
import { SteeringInbox } from "./steering-inbox.js";

export const INLINE_STEERING_STATE_PATH_ENV = "PI_SUBAGENT_INLINE_STEERING_STATE_PATH";

/** Loaded for inline background reporting or single-child steering. No SDK/RPC session or timers. */
export default function inlineSteeringBridge(pi: ExtensionAPI): void {
  const statePath = process.env[INLINE_STEERING_STATE_PATH_ENV];
  delete process.env[INLINE_STEERING_STATE_PATH_ENV];
  if (!statePath) return;
  let client: LifecycleEventClient | null = null;
  let running = false;
  let closed = false;
  let generation = 0;
  const reporting = registerParentReportTool(pi, () => client, (ctx) => running && !closed && Boolean(ctx.signal) && !ctx.signal?.aborted && !ctx.isIdle());
  const inbox = new SteeringInbox(() => running && !closed);
  inbox.registerBoundaries(pi);
  const close = () => {
    closed = true;
    running = false;
    generation += 1;
    inbox.close();
    client?.send("agent-settled");
    client?.close();
    client = null;
  };
  pi.on("session_start", async (_event, ctx) => {
    const token = ++generation;
    const connected = await LifecycleEventClient.connectFromEnvironment(process.env, statePath, false, reporting);
    if (closed || token !== generation) { connected?.close(); return; }
    client = connected;
    client?.setSteerHandler((message) => inbox.submit(ctx, message));
  });
  pi.on("agent_start", (_event, ctx) => {
    if (closed) return;
    running = true;
    inbox.start(ctx);
    client?.send("agent-started");
  });
  pi.on("agent_end", () => {
    running = false;
    inbox.pause();
    client?.send("agent-ended");
  });
  pi.on("agent_settled", (_event, ctx) => { close(); ctx.shutdown(); });
  pi.on("session_shutdown", close);
}
