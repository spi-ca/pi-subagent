import * as PiHost from "@earendil-works/pi-coding-agent";
import type { AgentActivityOutcome, BoundaryResult, BoundaryState, ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { isSteeringMessage } from "../core/subagent-steering.js";
import { isStableSemverAtLeast } from "./version-policy.mjs";

export const MINIMUM_STEERING_PI_VERSION = "1.1.0";
export const STEERING_INBOX_CAPACITY = 8;
export const STEERING_CUSTOM_TYPE = "pi-subagent-steering";
type SteeringContext = Pick<ExtensionContext, "isIdle" | "signal">;

/** Literal FIFO context messages, owned by the current run. No native input pipeline or new prompt. */
export class SteeringInbox {
  private pending: string[] = [];
  private active = false;
  private closed = false;
  readonly supported: boolean;

  constructor(private readonly available: () => boolean, version: string = PiHost.VERSION) {
    // Feature-specific guard: older backends remain usable, but cannot ACK steering.
    this.supported = isStableSemverAtLeast(version, MINIMUM_STEERING_PI_VERSION);
  }

  registerBoundaries(pi: ExtensionAPI): void {
    if (!this.supported) return;
    pi.on("turn_end", (event, ctx) => this.drain(event, ctx));
  }

  start(_ctx: SteeringContext): void {
    if (this.closed) return;
    this.active = true;
  }
  /** End this low-level run without fencing a normal retry/continuation. */
  pause(): void { this.active = false; this.pending = []; }
  close(): void { this.closed = true; this.pause(); }
  observeOutcome(outcome: AgentActivityOutcome): void { if (outcome !== "completed") this.pause(); }

  /** ACK means bounded inbox admission only, not transcript commit or model application. */
  submit(ctx: SteeringContext, message: string): boolean {
    if (!this.canAccept(ctx)) { this.pending = []; return false; }
    if (this.pending.length >= STEERING_INBOX_CAPACITY || !isSteeringMessage(message)) return false;
    this.pending.push(message);
    return true;
  }

  private canAccept(ctx: SteeringContext): boolean {
    // Pre-settle cancellation is private host state. No current low-level
    // signal means we cannot prove safety, even if the session is not idle.
    const signal = ctx.signal;
    return this.supported && this.active && !this.closed && this.available()
      && signal !== undefined && !signal.aborted && !ctx.isIdle();
  }

  drain(event: BoundaryState, ctx: SteeringContext): BoundaryResult | undefined {
    this.observeOutcome(event.outcome);
    if (!this.canAccept(ctx)) { this.pending = []; return; }
    if (this.pending.length === 0) return; // Leave earlier handlers' entries/continue untouched.
    const entries: SessionBoundaryDraft[] = this.pending.map(content => ({
      type: "custom_message", customType: STEERING_CUSTOM_TYPE, content, display: true,
    }));
    this.pending = [];
    // Custom content becomes a user-role model message. Appending it makes this
    // continuation valid even when the prior preview ended in an assistant.
    return { entries: [...event.entries, ...entries], continue: true };
  }
}
