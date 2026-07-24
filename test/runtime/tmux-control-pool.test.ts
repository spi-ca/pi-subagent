import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { TmuxControlClient } from "../../src/runtime/tmux-control";
import {
  acquireTmuxControlLease,
  resetTmuxControlPoolForTest,
  shutdownTmuxControlPool,
  snapshotTmuxControlPoolForTest,
  type TmuxControlAuthority,
  type TmuxControlRun,
} from "../../src/runtime/tmux-control-pool";

const authority = (suffix = "a"): TmuxControlAuthority => ({
  controlContract: "tmux-control-v1", executableGeneration: { realpath: `/bin/tmux-${suffix}`, dev: "1", ino: suffix === "a" ? "1" : "2", size: "1", mtimeNs: "1", ctimeNs: "1" },
  canonicalSocketPath: `/tmp/tmux-${suffix}.sock`, socketDev: 1, socketIno: suffix === "a" ? 1 : 2,
  serverPid: 100, serverStartedAt: 200, attachedSessionId: "$1", sourcePaneId: "%1", sourcePanePid: 101, sourceWindowId: "@1",
});

class FakeTmuxControlChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = 123;
  kill() { this.emit("exit", 0, "SIGTERM"); return true; }
}

/** Production-shaped client factory: the pool callback is wired into TmuxControlClient itself. */
function productionClientFactory(children: FakeTmuxControlChild[], disconnects: Array<() => void>) {
  return async (onDisconnect: () => void) => {
    disconnects.push(onDisconnect);
    const child = new FakeTmuxControlChild();
    children.push(child);
    let response = 1;
    child.stdin.on("data", () => {
      const current = response++;
      queueMicrotask(() => child.stdout.write(`%begin 2 ${current} 0\n%end 2 ${current} 0\n`));
    });
    queueMicrotask(() => child.stdout.write("%begin 1 0 0\n%end 1 0 0\n"));
    const client = new TmuxControlClient({
      executable: "/usr/bin/tmux", socketPath: "/tmp/tmux-production.sock", sessionId: "$1",
      spawnProcess: (() => child) as any, onDisconnect,
    });
    await client.start();
    return client as any;
  };
}

function factory(log: string[], disconnects: Array<() => void>, clients: any[] = []) {
  return async (onDisconnect: () => void) => {
    disconnects.push(onDisconnect);
    let sequence = 0;
    let closed = false;
    const waiters = new Set<(reason: "notification" | "timeout" | "disconnect") => void>();
    const client = {
      close() { if (closed) return; closed = true; for (const resolve of waiters) resolve("disconnect"); waiters.clear(); },
      notificationSequence: () => sequence,
      lastNotificationAt: () => null,
      waitForNotification: (timeoutMs: number) => new Promise<"notification" | "timeout" | "disconnect">((resolve) => {
        const timer = setTimeout(() => { waiters.delete(done); resolve("timeout"); }, timeoutMs);
        const done = (reason: "notification" | "timeout" | "disconnect") => { clearTimeout(timer); waiters.delete(done); resolve(reason); };
        waiters.add(done);
      }),
      execute: async (line: string) => { log.push(line); return [line]; },
      notify() { sequence += 1; for (const resolve of waiters) resolve("notification"); waiters.clear(); },
    } as any;
    clients.push(client);
    return client;
  };
}

async function lease(options: { authority?: TmuxControlAuthority; log: string[]; disconnects: Array<() => void>; clients?: any[]; revalidate?: () => boolean | Promise<boolean> }) {
  return await acquireTmuxControlLease({
    authority: options.authority ?? authority(), createClient: factory(options.log, options.disconnects, options.clients),
    revalidate: async (_run: TmuxControlRun) => await (options.revalidate?.() ?? true),
  });
}

describe("process-local tmux control pool", () => {
  test("shares one physical client across sixteen same-authority leases and refcounts final close", async () => {
    resetTmuxControlPoolForTest();
    const log: string[] = [], disconnects: Array<() => void> = [];
    const leases = await Promise.all(Array.from({ length: 16 }, () => lease({ log, disconnects })));
    assert.ok(leases.every(Boolean));
    assert.equal(disconnects.length, 1);
    assert.deepEqual(snapshotTmuxControlPoolForTest(), { entries: 1, leases: 16, clients: 1 });
    leases[0]!.release(); leases[0]!.release();
    assert.deepEqual(snapshotTmuxControlPoolForTest(), { entries: 1, leases: 15, clients: 1 });
    for (const item of leases.slice(1)) item!.release();
    assert.deepEqual(snapshotTmuxControlPoolForTest(), { entries: 0, leases: 0, clients: 0 });
  });

  test("keeps distinct physical generations separate", async () => {
    resetTmuxControlPoolForTest();
    const log: string[] = [], disconnects: Array<() => void> = [];
    const first = await lease({ log, disconnects, authority: authority("a") });
    const second = await lease({ log, disconnects, authority: authority("b") });
    assert.ok(first && second); assert.equal(disconnects.length, 2);
    first.release(); second.release();
  });

  test("exposes only the current opaque accepted transport epoch", async () => {
    resetTmuxControlPoolForTest();
    const log: string[] = [], disconnects: Array<() => void> = [];
    const item = await lease({ log, disconnects });
    assert.ok(item);
    const accepted = item.acceptedTransport();
    assert.deepEqual(Object.keys(accepted ?? {}).sort(), ["epoch", "key"]);
    assert.equal(typeof accepted?.epoch, "number");
    assert.match(accepted?.key ?? "", /^tmux-transport-[1-9][0-9]*$/);
    assert.equal((accepted?.key ?? "").includes("/tmp/"), false);
    disconnects[0]!();
    assert.equal(item.acceptedTransport(), null);
    item.release();
  });

  test("uses the physical client FIFO runner", async () => {
    resetTmuxControlPoolForTest();
    const log: string[] = [], disconnects: Array<() => void> = [];
    const first = await lease({ log, disconnects }); const second = await lease({ log, disconnects });
    await Promise.all([first!.run(["display-message", "a"]), second!.run(["list-panes"]), first!.run(["display-message", "b"])]);
    assert.deepEqual(log.map((line) => line.split(" ")[0]), ["display-message", "list-panes", "display-message"]);
    first!.release(); second!.release();
  });

  test("maintains independent notification cursors and waiters", async () => {
    resetTmuxControlPoolForTest();
    const log: string[] = [], disconnects: Array<() => void> = [], clients: any[] = [];
    const first = await lease({ log, disconnects, clients }); const second = await lease({ log, disconnects, clients });
    const one = first!.waitForNotification(100); const two = second!.waitForNotification(100);
    clients[0]!.notify();
    assert.equal(await one, "notification"); assert.equal(await two, "notification");
    // First lease consumed its cursor; second has its own cursor and does not
    // consume or suppress the next notification for the first.
    const next = first!.waitForNotification(100); clients[0]!.notify();
    assert.equal(await next, "notification");
    first!.release(); second!.release();
  });

  test("poisons and reconnects once when an actual control client exits", async () => {
    resetTmuxControlPoolForTest();
    const children: FakeTmuxControlChild[] = [], disconnects: Array<() => void> = [];
    const item = await acquireTmuxControlLease({
      authority: authority(), createClient: productionClientFactory(children, disconnects),
      revalidate: async (run) => (await run(["display-message", "-p", "#{pane_id}"])).exitCode === 0,
    });
    assert.ok(item); assert.equal(children.length, 1); assert.equal(disconnects.length, 1);
    let poisoned = 0;
    item.onDisconnect(() => { poisoned += 1; });
    children[0]!.emit("exit", 1, null);
    assert.equal(poisoned, 1);
    assert.equal((await item.run(["kill-pane", "-t", "%9"])).exitCode, 1);
    assert.equal(await item.reconnect(), true);
    assert.equal(children.length, 2);
    assert.equal((await item.run(["display-message", "-p", "#{pane_id}"])).exitCode, 0);
    item.release();
  });

  test("singleflights reconnect and a failed lease proof does not authorize it", async () => {
    resetTmuxControlPoolForTest();
    const log: string[] = [], disconnects: Array<() => void> = [];
    let firstProof = true;
    const first = await lease({ log, disconnects, revalidate: () => firstProof });
    const second = await lease({ log, disconnects });
    assert.ok(first && second); assert.equal(disconnects.length, 1);
    disconnects[0]!();
    assert.deepEqual(await Promise.all([first!.reconnect(), second!.reconnect()]), [true, true]);
    assert.equal(disconnects.length, 2);
    // A subsequent generation cannot be authorized by another lease's proof.
    disconnects[1]!();
    firstProof = false;
    assert.equal(await first!.reconnect(), false);
    assert.equal((await first!.run(["kill-pane", "-t", "%9"])).exitCode, 1);
    assert.equal(await second!.reconnect(), true);
    first!.release(); second!.release();
  });

  test("revokes an accepted lease when revalidation fails or races a new generation", async () => {
    resetTmuxControlPoolForTest();
    const log: string[] = [], disconnects: Array<() => void> = [];
    let failProof = false;
    const item = await lease({ log, disconnects, revalidate: () => {
      if (failProof) throw new Error("authority proof failed");
      return true;
    } });
    assert.ok(item);
    assert.equal((await item.run(["kill-pane", "-t", "%9"])).exitCode, 0);
    failProof = true;
    assert.equal(await item.reconnect(), false);
    assert.equal((await item.run(["kill-pane", "-t", "%9"])).exitCode, 1);
    assert.equal(log.filter((line) => line.startsWith("kill-pane")).length, 1);
    item.release();

    resetTmuxControlPoolForTest();
    const raceLog: string[] = [], raceDisconnects: Array<() => void> = [];
    let proofs = 0, entered!: () => void, resume!: () => void;
    const proofEntered = new Promise<void>((resolve) => { entered = resolve; });
    const proofResume = new Promise<void>((resolve) => { resume = resolve; });
    const raced = await lease({ log: raceLog, disconnects: raceDisconnects, revalidate: async () => {
      proofs += 1;
      if (proofs === 4) { entered(); await proofResume; }
      return true;
    } });
    assert.ok(raced);
    raceDisconnects[0]!();
    const reconnecting = raced.reconnect();
    await proofEntered;
    // The captured client/run/epoch is no longer the live physical generation.
    raceDisconnects[1]!();
    assert.equal((await raced.run(["kill-pane", "-t", "%9"])).exitCode, 1);
    resume();
    assert.equal(await reconnecting, false);
    assert.equal((await raced.run(["kill-pane", "-t", "%9"])).exitCode, 1);
    raced.release();
  });

  test("fences shutdown races and never replays unknown mutations", async () => {
    resetTmuxControlPoolForTest();
    const log: string[] = [], disconnects: Array<() => void> = [];
    const item = await lease({ log, disconnects }); assert.ok(item);
    const mutation = await item.run(["kill-pane", "-t", "%9"]);
    assert.equal(mutation.dispatched, true);
    disconnects[0]!();
    assert.equal((await item.run(["kill-pane", "-t", "%9"])).exitCode, 1);
    assert.equal(log.filter((line) => line.startsWith("kill-pane")).length, 1);
    item.release();

    let finishCreate!: (client: any) => void;
    const connecting = acquireTmuxControlLease({
      authority: authority(), revalidate: async () => true,
      createClient: async (onDisconnect) => await new Promise((resolve) => { finishCreate = resolve; }).then(() => {
        const client = { close() {}, notificationSequence: () => 0, lastNotificationAt: () => null, waitForNotification: async () => "disconnect", execute: async () => [] } as any;
        void onDisconnect;
        return client;
      }),
    });
    shutdownTmuxControlPool();
    finishCreate(undefined);
    assert.equal(await connecting, null);
    assert.equal(await acquireTmuxControlLease({ authority: authority(), createClient: factory(log, disconnects), revalidate: async () => true }), null);
  });

  test("keeps a replacement entry through shutdown reset while old final leases clean up", async () => {
    resetTmuxControlPoolForTest();
    const log: string[] = [], disconnects: Array<() => void> = [];
    const oldLease = await lease({ log, disconnects });
    assert.ok(oldLease);
    shutdownTmuxControlPool();
    resetTmuxControlPoolForTest();
    const replacement = await lease({ log, disconnects });
    assert.ok(replacement);
    oldLease.release();
    assert.deepEqual(snapshotTmuxControlPoolForTest(), { entries: 1, leases: 1, clients: 1 });
    replacement.release();
    assert.deepEqual(snapshotTmuxControlPoolForTest(), { entries: 0, leases: 0, clients: 0 });
  });
});
