import { test } from "bun:test";
import assert from "node:assert/strict";
import { ParentReportMemo, MAX_PARENT_REPORT_MEMO, PARENT_REPORT_MEMO_TTL_MS } from "../../src/runtime/parent-report-memo";
import { PARENT_REPORT_ENV, registerParentReportTool } from "../../src/runtime/parent-report";

function latch() { let release!: () => void; return { promise: new Promise<void>(r => { release = r; }), release: () => release() }; }
function toolFixture(requestReport: (...args: any[]) => Promise<string>) {
  const hooks: Record<string, any> = {}; let tool: any;
  const saved = process.env[PARENT_REPORT_ENV]; process.env[PARENT_REPORT_ENV] = "1";
  try {
    registerParentReportTool({ registerTool: (value: any) => { tool = value; }, on: (name: string, fn: any) => { hooks[name] = fn; },
      getActiveTools: () => [], setActiveTools: () => {} } as never,
    () => ({ reportSupported: true, requestReport }) as never, () => true);
  } finally {
    if (saved === undefined) delete process.env[PARENT_REPORT_ENV]; else process.env[PARENT_REPORT_ENV] = saved;
  }
  let sessionId = "session-a";
  const ctx = { sessionManager: { getSessionId: () => sessionId } };
  const execute = (id: string, message = "private-body", kind?: string, signal?: AbortSignal) => tool.execute(id,
    kind === undefined ? { message } : { message, kind }, signal, undefined, ctx);
  return { execute, hooks, ctx, session: (id: string) => { sessionId = id; } };
}

test("same tool ID shares a concurrent send and replays success; kind default normalizes, distinct IDs remain distinct", async () => {
  const gate = latch(); let sends = 0;
  const f = toolFixture(async () => { sends++; await gate.promise; return "submitted"; });
  const first = f.execute("same");
  const duplicate = f.execute("same", "private-body", "progress", AbortSignal.abort());
  await Promise.resolve(); assert.equal(sends, 1);
  await assert.rejects(f.execute("same", "secret-conflict"), (e: Error) => !e.message.includes("secret-conflict") && /conflicts/.test(e.message));
  await assert.rejects(f.execute("same", "private-body", "finding"), /conflicts/);
  gate.release();
  const [a, b] = await Promise.all([first, duplicate]); assert.deepEqual(a, b);
  a.content[0].text = "mutated caller result";
  assert.deepEqual(await f.execute("same"), b); assert.equal(sends, 1);
  await f.execute("different"); assert.equal(sends, 2, "same text is not content deduplication");
  await f.execute("\ud800"); await f.execute("\ud801");
  assert.equal(sends, 4, "distinct IDs stay distinct even when raw UTF-8 encoding would replace lone surrogates");
});

for (const outcome of ["unknown", "rejected", "unavailable", "busy", "limit", "queue-full", "throw"]) {
  test(`${outcome} result is sanitized and replayed without another send, including concurrent callers`, async () => {
    let sends = 0; const gate = latch();
    const f = toolFixture(async () => { sends++; await gate.promise; if (outcome === "throw") throw Error("private-body transport error"); return outcome; });
    const error = async (p: Promise<unknown>) => {
      let message = "";
      await assert.rejects(p, (e: Error) => { message = e.message; return true; });
      return message;
    };
    const first = error(f.execute("same")), second = error(f.execute("same"));
    gate.release(); const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b); assert.equal(a.includes("private-body"), false);
    assert.equal(await error(f.execute("same")), a); assert.equal(sends, 1);
    await f.execute("same").catch((e: Error) => { e.message = "caller mutated error"; });
    assert.equal(await error(f.execute("same")), a, "caller mutation cannot rewrite the cached error");
    if (outcome === "unknown" || outcome === "throw") assert.match(a, /Do not retry automatically/);
  });
}

test("256 entries includes pending; active requests never expire or get evicted; settled TTL is ten minutes from settlement", async () => {
  let now = 0, sends = 0;
  const memo = new ParentReportMemo<{ ok: boolean }>(() => now), gate = latch();
  const send = async () => { sends++; await gate.promise; return { ok: true }; };
  const promises = Array.from({ length: MAX_PARENT_REPORT_MEMO }, (_, i) => memo.run(String(i), "normalized-payload", send));
  await Promise.resolve(); assert.equal(sends, 256);
  now = PARENT_REPORT_MEMO_TTL_MS * 2;
  await assert.rejects(memo.run("overflow", "payload", send), /capacity is full/);
  const replay = memo.run("0", "normalized-payload", send);
  gate.release(); await Promise.all([...promises, replay]); assert.equal(sends, 256);
  const retained = [...(memo as any).entries.values()][0];
  assert.deepEqual(Object.keys(retained).sort(), ["payloadHash", "promise", "settledAt"]);
  assert.equal(retained.payloadHash.length, 64);
  now += PARENT_REPORT_MEMO_TTL_MS - 1;
  await assert.rejects(memo.run("overflow", "payload", send), /capacity is full/);
  await memo.run("0", "normalized-payload", send); assert.equal(sends, 256, "replay does not refresh TTL");
  now++;
  await memo.run("0", "normalized-payload", send); assert.equal(sends, 257, "same ID can send again only outside retention horizon");
});

test("session lifecycle clears replay state, shutdown fences execution, and reset revokes pending dispatch authority", async () => {
  let sends = 0;
  const f = toolFixture(async () => { sends++; return "submitted"; });
  await f.execute("id"); await f.execute("id"); assert.equal(sends, 1);
  f.hooks.session_start({}, f.ctx); await f.execute("id"); assert.equal(sends, 2);
  f.session("new-session"); await f.execute("id"); assert.equal(sends, 3);
  f.hooks.session_shutdown(); f.session("changed-after-close");
  await assert.rejects(f.execute("id"), /unavailable/); assert.equal(sends, 3);
  f.hooks.session_start({}, f.ctx); await f.execute("id"); assert.equal(sends, 4);
  const memo = new ParentReportMemo<boolean>();
  const pending = memo.run("id", "body", async eligible => eligible());
  memo.reset(); assert.equal(await pending, false);
  assert.equal(await memo.run("id", "changed", async eligible => eligible()), true);
  memo.close(); await assert.rejects(memo.run("fresh", "body", async () => true), /unavailable/);
});
