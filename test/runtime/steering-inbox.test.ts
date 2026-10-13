import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import type { BoundaryState, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { SteeringInbox, STEERING_CUSTOM_TYPE } from "../../src/runtime/steering-inbox";

const ctx = () => ({ isIdle: () => false, signal: new AbortController().signal });
const boundary = (overrides: Partial<BoundaryState> = {}): BoundaryState => ({
  entries: [], continue: false, outcome: "completed", context: { canContinue: false } as never, ...overrides,
});

describe("bounded boundary steering inbox", () => {
  test("turn_end composes drafts, preserves earlier continuation, consumes exactly once", () => {
    const inbox = new SteeringInbox(() => true, "1.1.0"), context = ctx();
    const handlers = new Map<string, Function>();
    inbox.registerBoundaries({ on: (event: string, handler: Function) => handlers.set(event, handler) } as never);
    assert.deepEqual([...handlers.keys()], ["turn_end"]);
    inbox.start(context);
    const earlier: SessionBoundaryDraft = { type: "custom", customType: "earlier", data: 1 };
    const event = boundary({ entries: [earlier], continue: true });
    assert.equal(handlers.get("turn_end")!(event, context), undefined);
    assert.equal(inbox.submit(context, "/skill:literal $ARGUMENTS"), true);
    assert.equal(inbox.submit(context, "bounded second"), false);
    const result = handlers.get("turn_end")!(event, context);
    assert.deepEqual(result, { entries: [earlier, { type: "custom_message", customType: STEERING_CUSTOM_TYPE, content: "/skill:literal $ARGUMENTS", display: true }], continue: true });
    assert.deepEqual(event.entries, [earlier]);
    assert.equal(handlers.get("turn_end")!(event, context), undefined);
    assert.equal(inbox.submit(context, "next admission after drain"), true);
    assert.equal(inbox.drain(boundary(), context)?.continue, true);
    assert.equal(inbox.drain(boundary(), context), undefined);
  });

  for (const outcome of ["aborted", "error"] as const) {
    test(`${outcome} drops pending without clobbering earlier handlers`, () => {
      const inbox = new SteeringInbox(() => true), context = ctx();
      inbox.start(context);
      assert.equal(inbox.submit(context, "pending"), true);
      const event = boundary({ outcome, entries: [{ type: "custom", customType: "earlier" }], continue: true });
      assert.equal(inbox.drain(event, context), undefined);
      assert.equal(event.continue, true);
      assert.equal(event.entries.length, 1);
      assert.equal(inbox.submit(context, "late"), false);
      inbox.start(context);
      assert.equal(inbox.drain(boundary(), context), undefined);
      assert.equal(inbox.submit(context, "normal retry"), true);
    });
  }

  test("startup, idle, aborted, ownership/terminal/unavailable, settled and shutdown gates", () => {
    let available = true;
    const inbox = new SteeringInbox(() => available), context = ctx();
    assert.equal(inbox.submit(context, "startup"), false);
    inbox.start(context);
    assert.equal(inbox.submit(context, " "), false);
    assert.equal(inbox.submit(context, "x".repeat(513)), false);
    assert.equal(inbox.submit(context, "pending"), true);
    available = false;
    assert.equal(inbox.drain(boundary(), context), undefined);
    available = true;
    assert.equal(inbox.drain(boundary(), context), undefined);
    assert.equal(inbox.submit({ ...context, isIdle: () => true }, "idle"), false);
    const abort = new AbortController();
    assert.equal(inbox.submit(context, "pending abort"), true);
    abort.abort();
    assert.equal(inbox.drain(boundary(), { ...context, signal: abort.signal }), undefined);
    assert.equal(inbox.drain(boundary(), context), undefined);
    inbox.close(); inbox.start(context);
    assert.equal(inbox.submit(context, "settled or shutdown"), false);
  });

  test("missing current signal fails closed despite completed outcome and unaborted preceding signal", () => {
    const context = ctx();
    const inbox = new SteeringInbox(() => true); inbox.start(context);
    assert.equal(inbox.submit(context, "pending"), true);
    const beforeSettleContext = { isIdle: () => false, signal: undefined };
    assert.equal(context.signal.aborted, false);
    assert.equal(inbox.drain(boundary(), beforeSettleContext), undefined);
    assert.equal(inbox.submit(beforeSettleContext, "pre-settle"), false);
    assert.equal(inbox.drain(boundary(), context), undefined);
  });

  test("agent_end pause drops unconsumed inbox and resumes only on a normal agent_start", () => {
    const inbox = new SteeringInbox(() => true), context = ctx();
    inbox.start(context);
    assert.equal(inbox.submit(context, "unconsumed"), true);
    inbox.pause();
    assert.equal(inbox.submit(context, "ended"), false);
    assert.equal(inbox.drain(boundary(), context), undefined);
    inbox.start(context);
    assert.equal(inbox.drain(boundary(), context), undefined);
    assert.equal(inbox.submit(context, "continuation"), true);
    assert.equal(inbox.drain(boundary(), context)?.continue, true);
  });

  test("only stable Pi >=1.1 can register actionable boundaries or admit steering", () => {
    for (const version of ["0.80.10", "0.81.1", "1.0.0", "1.1.0-rc.1", "unknown"]) {
      const inbox = new SteeringInbox(() => true, version), context = ctx();
      inbox.registerBoundaries({ on: () => { throw Error("unsupported boundary registration"); } } as never);
      inbox.start(context);
      assert.equal(inbox.supported, false);
      assert.equal(inbox.submit(context, "unsupported"), false);
      assert.equal(inbox.drain(boundary(), context), undefined);
    }
    for (const version of ["1.1.0", "1.2.0", "2.0.0"]) assert.equal(new SteeringInbox(() => true, version).supported, true);
  });
});
