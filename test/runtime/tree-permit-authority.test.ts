import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  adoptTreePermitAuthority,
  createTreePermitAuthority,
  reconcileTreePermitAuthorities,
  createSharedForegroundPermitScopeManager,
  MAX_TREE_PERMIT_LEASES,
  supportsTreePermitAuthority,
} from "../../src/runtime/tree-permit-authority";
import type { ProcessIdentity } from "../../src/runtime/tree-permit-authority";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await fs.promises.rm(roots.pop()!, { recursive: true, force: true }); });

function identities(initial: Record<string, "live" | "dead" | "unknown"> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    classify: (identity: ProcessIdentity) => values.get(`${identity.pid}:${identity.startedAt}`) ?? "unknown" as const,
    set: (identity: ProcessIdentity, status: "live" | "dead" | "unknown") => values.set(`${identity.pid}:${identity.startedAt}`, status),
  };
}
async function root(): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-tree-permit-"));
  roots.push(directory);
  return directory;
}
async function generations(authority: { authorityDir: string }): Promise<string[]> {
  return (await fs.promises.readdir(authority.authorityDir)).filter((name) => /^state-\d{20}\.json$/.test(name)).sort();
}
async function latest(authority: { authorityDir: string }): Promise<any> {
  const names = await generations(authority);
  return JSON.parse(await fs.promises.readFile(path.join(authority.authorityDir, names.at(-1)!), "utf8"));
}
async function checkpoints(authority: { authorityDir: string }): Promise<string[]> {
  return (await fs.promises.readdir(authority.authorityDir)).filter((name) => /^checkpoint-\d{20}\.json$/.test(name)).sort();
}
async function advance(authority: { acquireReservation(): Promise<any> }, pairs: number): Promise<void> {
  for (let index = 0; index < pairs; index += 1) {
    const lease = await authority.acquireReservation();
    assert.ok(lease);
    assert.equal(await lease.release(), true);
  }
}
async function publishCheckpoint(authority: { acquireReservation(): Promise<any>; authorityDir: string }): Promise<void> {
  await advance(authority, 64); // generation 128, before automatic compaction
  const lease = await authority.acquireReservation(); // compacts then appends generation 129
  assert.ok(lease);
  assert.equal(await lease.release(), true);
}
async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

// Fake exact identities model OS PID/start observations, including PID reuse,
// without killing the Bun test worker. This is a strong lifecycle model.
describe("tree permit authority immutable CAS snapshots", () => {
  test("declares tree permit authority support only for Darwin and Linux", () => {
    assert.equal(supportsTreePermitAuthority("darwin"), true);
    assert.equal(supportsTreePermitAuthority("linux"), true);
    assert.equal(supportsTreePermitAuthority("win32"), false);
    assert.equal(supportsTreePermitAuthority("freebsd"), false);
  });

  test("enforces the shared maxActive cap in create, persisted manifest, and adoption", async () => {
    const base = await root();
    const owner = { pid: 90, startedAt: 1 };
    const ids = identities({ "90:1": "live" });
    await assert.rejects(createTreePermitAuthority({ rootDir: base, maxActive: 257, classifyIdentity: ids.classify, currentIdentity: () => owner }), /at most 256/);
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 256, classifyIdentity: ids.classify, currentIdentity: () => owner });
    const manifestPath = path.join(authority.authorityDir, "authority.json");
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    await fs.promises.writeFile(manifestPath, `${JSON.stringify({ ...manifest, maxActive: 257 })}\n`, { mode: 0o600 });
    await fs.promises.chmod(manifestPath, 0o600);
    await assert.rejects(adoptTreePermitAuthority({ env: authority.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => owner }), /(identity|configuration).*invalid|mismatch/);
  });

  test("counts the initial ACTIVE root lease before admitting child reservations", async () => {
    const base = await root();
    const owner = { pid: 91, startedAt: 1 };
    const ids = identities({ "91:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 17, classifyIdentity: ids.classify, currentIdentity: () => owner });
    const children = await Promise.all(Array.from({ length: 16 }, () => authority.acquireReservation()));
    assert.equal(children.filter(Boolean).length, 16, "one root lease plus 16 child leases fills maxActive=17");
    assert.equal(await authority.acquireReservation(), null, "a seventeenth child would exceed the tree-wide cap");
    const state = await latest(authority);
    assert.equal(state.leases.filter((lease: { state: string }) => lease.state === "ACTIVE" || lease.state === "RESERVED").length, 17);
  });

  test("closed foreground scopes reject new reservations without waiting", async () => {
    const base = await root();
    const owner = { pid: 91, startedAt: 1 };
    const ids = identities({ "91:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => owner });
    const scope = await authority.beginForegroundDelegation();
    assert.equal(await scope.close(), true);
    assert.equal(scope.isClosed, true);
    assert.equal(scope.isResolved, true);
    assert.equal(await scope.waitForReservation(), null);
  });

  test("retries a closed foreground parent resume and creates a fresh shared scope", async () => {
    const base = await root();
    const owner = { pid: 96, startedAt: 1 };
    const ids = identities({ "96:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 2, classifyIdentity: ids.classify, currentIdentity: () => owner });
    const manager = createSharedForegroundPermitScopeManager();
    let resumeAttempts = 0;
    const resumeScope = (authority as any)._resumeScope.bind(authority);
    (authority as any)._resumeScope = async (scope: unknown) => ++resumeAttempts === 1 ? false : await resumeScope(scope);
    const first = await manager.acquire(authority);
    const lease = await (first as any).acquireReservation();
    assert.ok(lease);
    assert.equal(await manager.release(first), false, "the active child keeps the parent parked");
    assert.equal(await lease.release(), true, "the child release is durable even when its parent resume attempt loses");
    assert.equal((first as any).isResolved, false);
    const second = await manager.acquire(authority);
    assert.notEqual(second, first, "a retry clears the resolved closed scope before creating a new one");
    assert.equal(resumeAttempts, 2);
    assert.equal(await lease.release(), true, "the child membership callback remains idempotent");
    assert.equal(resumeAttempts, 2, "the released child does not invoke its scope callback twice");
    assert.equal(await manager.release(second), true);
  });

  test("retries rejected shared creation by adopting its exact durably parked parent lease", async () => {
    const base = await root();
    const owner = { pid: 97, startedAt: 1 };
    const ids = identities({ "97:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => owner });
    const manager = createSharedForegroundPermitScopeManager();
    const begin = authority.beginForegroundDelegation.bind(authority);
    let attempts = 0;
    (authority as any).beginForegroundDelegation = async () => {
      const created = await begin();
      if (++attempts === 1) throw new Error("response lost after durable park");
      return created;
    };

    await assert.rejects(() => manager.acquire(authority), /response lost after durable park/);
    assert.equal((await latest(authority)).leases[0].state, "PARKED_WAIT", "the first attempt durably parked before its response failed");
    const generationsAfterFailure = await generations(authority);
    const retry = await manager.acquire(authority);
    assert.equal(attempts, 2, "a rejected scope promise is not permanently cached");
    assert.deepEqual(await generations(authority), generationsAfterFailure, "retry adopts rather than double-parks the exact parent lease");
    assert.equal((await latest(authority)).leases[0].state, "PARKED_WAIT");
    assert.equal(await manager.release(retry), true);
    assert.equal((await latest(authority)).leases[0].state, "ACTIVE");
  });

  test("supports cap=1 nested child-to-grandchild delegation and queued local descendants", async () => {
    const base = await root();
    const parent = { pid: 101, startedAt: 1 }, child = { pid: 102, startedAt: 1 }, grandchild = { pid: 103, startedAt: 1 }, sibling = { pid: 104, startedAt: 1 };
    const ids = identities({ "101:1": "live", "102:1": "live", "103:1": "live", "104:1": "live" });
    let current = parent;
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => current });
    const parentScope = await authority.beginForegroundDelegation();
    const first = await parentScope.acquireReservation();
    assert.ok(first);
    assert.equal(await first.bindChildIdentity(child), true);
    assert.equal(await parentScope.acquireReservation(), null, "a queued sibling cannot exceed cap");

    current = child;
    const childAuthority = await adoptTreePermitAuthority({ env: first.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => current });
    const childScope = await childAuthority.beginForegroundDelegation();
    const nested = await childScope.acquireReservation();
    assert.ok(nested);
    assert.equal(await nested.bindChildIdentity(grandchild), true);
    current = grandchild;
    const grandchildAuthority = await adoptTreePermitAuthority({ env: nested.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => current });
    assert.equal(await grandchildAuthority.inheritedLease!.release(), true);

    current = child;
    assert.equal(await childScope.completeChild(nested), true);
    assert.equal(await childScope.close(), true, "child resumes only after its local descendant drains");
    assert.equal(await childAuthority.inheritedLease!.release(), true);

    current = parent;
    assert.equal(await parentScope.completeChild(first), true);
    const second = await parentScope.acquireReservation();
    assert.ok(second);
    assert.equal(await second.bindChildIdentity(sibling), true);
    current = sibling;
    const siblingAuthority = await adoptTreePermitAuthority({ env: second.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => current });
    assert.equal(await siblingAuthority.inheritedLease!.release(), true);
    current = parent;
    assert.equal(await parentScope.completeChild(second), true);
    assert.equal(await parentScope.close(), true);
    assert.equal((await latest(authority)).leases[0].state, "ACTIVE");
  });

  test("reconciles a result-before-exit child without releasing a live permit", async () => {
    const base = await root();
    const parent = { pid: 141, startedAt: 1 }, child = { pid: 142, startedAt: 1 };
    const ids = identities({ "141:1": "live", "142:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => parent });
    const resume = (authority as any)._resumeScope.bind(authority);
    let resumeAttempts = 0;
    (authority as any)._resumeScope = async (scope: unknown) => ++resumeAttempts < 3 ? false : await resume(scope);
    const manager = createSharedForegroundPermitScopeManager();
    const scope = await manager.acquire(authority);
    const lease = await (scope as any).acquireReservation();
    assert.ok(lease);
    assert.equal(await lease.bindChildIdentity(child), true);

    assert.equal(await (scope as any).completeChild(lease), false, "the result arrives while the exact child remains live");
    assert.equal((scope as any).watchChildSettlement(lease), true, "the failed immediate settlement starts exactly one watcher");
    assert.equal((scope as any).watchChildSettlement(lease), false, "a lease has at most one watcher");
    assert.equal(await manager.release(scope), false, "closing retains the watcher while the live child owns capacity");
    await new Promise<void>((resolve) => setTimeout(resolve, 12));
    assert.equal((await latest(authority)).leases.some((stored: any) => stored.id === lease.id), true, "the watcher does not revoke a live child");
    assert.equal(await (scope as any).acquireReservation(), null, "the live child retains the cap=1 capacity");

    setTimeout(() => ids.set(child, "dead"), 12);
    await waitFor(() => (scope as any).isResolved, "the exact child exit to resume the parked parent");
    assert.equal(resumeAttempts, 3, "the watcher retries a transient parent-resume CAS failure after exact-dead settlement");

    const later = await manager.acquire(authority);
    assert.notEqual(later, scope, "a later foreground invocation receives a fresh resumed scope");
    const nextLease = await (later as any).acquireReservation();
    assert.ok(nextLease, "the resumed parent can delegate again");
    assert.equal(await nextLease.release(), true);
    assert.equal(await manager.release(later), true);
  });

  test("transfers an active reservation from the stopped wrapper to the exact Pi child", async () => {
    const base = await root();
    const parent = { pid: 151, startedAt: 1 }, wrapper = { pid: 152, startedAt: 1 }, child = { pid: 153, startedAt: 1 };
    const ids = identities({ "151:1": "live", "152:1": "live", "153:1": "live" });
    let current = parent;
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 2, classifyIdentity: ids.classify, currentIdentity: () => current });
    const lease = await authority.acquireReservation(); assert.ok(lease);
    assert.equal(await lease.bindChildIdentity(wrapper), true);
    assert.equal(await lease.rebindChildIdentity(wrapper, child), true);
    current = child;
    const adopted = await adoptTreePermitAuthority({ env: lease.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => current });
    assert.ok(adopted.inheritedLease);
  });

  test("keeps background work separate, retries immutable CAS collisions, and supports cancellation-aware waiting", async () => {
    const base = await root();
    const owner = { pid: 201, startedAt: 1 };
    const ids = identities({ "201:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 16, classifyIdentity: ids.classify, currentIdentity: () => owner });
    // Concurrent writers deliberately derive the same successor generation;
    // hard-link EEXIST makes losers reload and retry rather than corrupting state.
    const leases = await Promise.all(Array.from({ length: 12 }, () => authority.acquireReservation()));
    assert.equal(leases.filter(Boolean).length, 12);
    const state = await latest(authority);
    assert.equal(state.leases.filter((lease: any) => lease.state === "ACTIVE" || lease.state === "RESERVED").length, 13);
    assert.ok(state.generation >= 12);

    const fullBase = await root();
    const full = await createTreePermitAuthority({ rootDir: fullBase, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => owner });
    // Hundreds of full waiters retry at the 4ms polling interval. They must
    // observe the existing immutable generation rather than publish no-ops.
    const controllers = Array.from({ length: 200 }, () => new AbortController());
    const waiting = controllers.map((controller) => full.waitForReservation({ signal: controller.signal }));
    setTimeout(() => controllers.forEach((controller) => controller.abort()), 20);
    assert.deepEqual(await Promise.all(waiting), Array(200).fill(null));
    assert.deepEqual(await generations(full), ["state-00000000000000000000.json"]);
    assert.equal((await latest(full)).leases.length, 1);
  });

  test("publishes dead-lease reclamation even when the requested release is absent", async () => {
    const base = await root();
    const owner = { pid: 251, startedAt: 1 }, observer = { pid: 252, startedAt: 1 };
    const ids = identities({ "251:1": "live", "252:1": "live" });
    let current = owner;
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => current });
    ids.set(owner, "dead");
    current = observer;
    assert.equal(await authority.inheritedLease!.release(), false, "the observer cannot release another owner's lease");
    const state = await latest(authority);
    assert.equal(state.generation, 1);
    assert.deepEqual(state.leases, []);
  });

  test("rolls back cancelled foreground acquisition and resumes only after the scope closes", async () => {
    const base = await root();
    const owner = { pid: 301, startedAt: 1 };
    const ids = identities({ "301:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => owner });
    const scope = await authority.beginForegroundDelegation();
    const controller = new AbortController();
    controller.abort();
    assert.equal(await scope.acquireReservation({ signal: controller.signal }), null);
    assert.equal((await latest(authority)).leases[0].state, "PARKED_WAIT");
    assert.equal(await scope.close(), true);
    const state = await latest(authority);
    assert.equal(state.leases.length, 1);
    assert.equal(state.leases[0].state, "ACTIVE");
  });

  test("marks a scope resolved when an aborted reservation durably resumes its parked parent", async () => {
    const base = await root();
    const owner = { pid: 341, startedAt: 1 };
    const ids = identities({ "341:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => owner });
    const manager = createSharedForegroundPermitScopeManager();
    const scope = await manager.acquire(authority);
    const controller = new AbortController();
    const link = fs.promises.link;
    let closing: Promise<boolean> | undefined;
    (fs.promises as any).link = async (existing: string, destination: string) => {
      const published = await link(existing, destination);
      if (path.basename(destination) === "state-00000000000000000002.json") {
        controller.abort();
        // close() sees this acquire as pending; _abortScopeReservation must
        // carry the resulting durable resume back to isResolved itself.
        closing = scope.close();
      }
      return published;
    };
    try {
      assert.equal(await (scope as any).acquireReservation({ signal: controller.signal }), null);
      await closing;
      assert.equal(scope.isClosed, true);
      assert.equal(scope.isResolved, true);
      assert.equal((await latest(authority)).leases[0].state, "ACTIVE");
      assert.equal(await manager.release(scope), false, "the manager observes the already-resolved closed scope");
      const fresh = await manager.acquire(authority);
      assert.notEqual(fresh, scope, "resolved scope is not retained for the next invocation");
      assert.equal(await manager.release(fresh), true);
    } finally { (fs.promises as any).link = link; }
  });

  test("trusted original owner detaches a live bound child and resumes its closed cap=1 scope", async () => {
    const base = await root();
    const parent = { pid: 351, startedAt: 1 }, child = { pid: 352, startedAt: 1 };
    const ids = identities({ "351:1": "live", "352:1": "live" });
    let current = parent;
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => current });
    const scope = await authority.beginForegroundDelegation();
    const lease = await scope.acquireReservation();
    assert.ok(lease);
    assert.equal(await lease.bindChildIdentity(child), true);
    assert.equal(await scope.close(), false, "the parked parent waits for its live child");

    current = child;
    const adoptedChild = await adoptTreePermitAuthority({ env: lease.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => current });
    assert.equal(await adoptedChild.inheritedLease!.detachBoundChild(), false, "an adopted bound child is not the original reservation owner");
    assert.equal((await latest(authority)).leases.some((stored: any) => stored.id === lease.id), true);
    current = parent;
    ids.set(parent, "unknown");
    assert.equal(await lease.detachBoundChild(), false, "an unknown original owner cannot detach");
    ids.set(parent, "live");

    assert.equal(await lease.detachBoundChild(), true, "the exact original owner may detach its live child");
    const state = await latest(authority);
    assert.equal(state.leases.length, 1);
    assert.equal(state.leases[0].state, "ACTIVE", "scope release callback resumes the closed parked parent");
    assert.equal(ids.classify(child), "live");
  });

  test("treats dead-child reclamation as one successful bound finalization or detachment", async () => {
    const run = async (operation: "finalize" | "detach") => {
      const base = await root();
      const parent = { pid: operation === "finalize" ? 361 : 371, startedAt: 1 }, child = { pid: operation === "finalize" ? 362 : 372, startedAt: 1 };
      const ids = identities({ [`${parent.pid}:1`]: "live", [`${child.pid}:1`]: "live" });
      let current = parent;
      const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => current });
      const scope = await authority.beginForegroundDelegation();
      const lease = await scope.acquireReservation(); assert.ok(lease);
      assert.equal(await lease.bindChildIdentity(child), true);
      assert.equal(await scope.close(), false);
      ids.set(child, "dead");
      assert.equal(await (operation === "finalize" ? lease.finalizeBoundChildIfDead() : lease.detachBoundChild()), true);
      const afterFirst = await latest(authority);
      assert.equal(afterFirst.leases.length, 1);
      assert.equal(afterFirst.leases[0].state, "ACTIVE", "the durable absence callback resumes the closed scope");
      assert.equal(await (operation === "finalize" ? lease.finalizeBoundChildIfDead() : lease.detachBoundChild()), true);
      assert.equal((await latest(authority)).generation, afterFirst.generation, "the already-settled callback is not run again");
    };
    await run("finalize");
    await run("detach");
  });

  test("adopts legacy v1 leases for child self-release without inferring parent provenance", async () => {
    const base = await root();
    const parent = { pid: 381, startedAt: 1 }, child = { pid: 382, startedAt: 1 };
    const ids = identities({ "381:1": "live", "382:1": "live" });
    let current = parent;
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 2, classifyIdentity: ids.classify, currentIdentity: () => current });
    const lease = await authority.acquireReservation(); assert.ok(lease);
    assert.equal(await lease.bindChildIdentity(child), true);
    const head = await latest(authority);
    for (const stored of head.leases) delete stored.reservedBy;
    const headName = (await generations(authority)).at(-1)!;
    await fs.promises.writeFile(path.join(authority.authorityDir, headName), `${JSON.stringify(head)}\n`, { mode: 0o600 });
    await fs.promises.chmod(path.join(authority.authorityDir, headName), 0o600);
    current = child;
    const adopted = await adoptTreePermitAuthority({ env: lease.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => current });
    assert.equal(await adopted.inheritedLease!.detachBoundChild(), false);
    assert.equal(await adopted.inheritedLease!.rebindChildIdentity(child, parent), false);
    assert.equal(await adopted.inheritedLease!.release(), true, "legacy active children retain self-release compatibility");
  });

  test("reclaims exact-dead RESERVED, ACTIVE, and PARKED leases, but retains unknown and PID-reused identities", async () => {
    const base = await root();
    const rootOwner = { pid: 401, startedAt: 1 }, child = { pid: 402, startedAt: 1 }, observer = { pid: 403, startedAt: 1 };
    const ids = identities({ "401:1": "live", "402:1": "live", "403:1": "live" });
    let current = rootOwner;
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 4, classifyIdentity: ids.classify, currentIdentity: () => current });
    const scope = await authority.beginForegroundDelegation(); // PARKED root
    const active = await scope.acquireReservation(); assert.ok(active);
    assert.equal(await active.bindChildIdentity(child), true); // ACTIVE child
    const reserved = await scope.acquireReservation(); assert.ok(reserved); // RESERVED root
    ids.set(rootOwner, "dead"); ids.set(child, "dead");
    current = observer;
    const observerAuthority = await adoptTreePermitAuthority({ env: authority.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => current });
    assert.ok(await observerAuthority.acquireReservation());
    assert.equal((await latest(authority)).leases.length, 1, "all exact-dead lifecycle states are reclaimed");

    const unknownBase = await root();
    const unknownOwner = { pid: 421, startedAt: 1 }, unknownObserver = { pid: 422, startedAt: 1 };
    const unknown = identities({ "421:1": "live", "422:1": "live" });
    const unknownAuthority = await createTreePermitAuthority({ rootDir: unknownBase, maxActive: 1, classifyIdentity: unknown.classify, currentIdentity: () => unknownOwner });
    unknown.set(unknownOwner, "unknown");
    current = unknownObserver;
    const unknownAdopter = await adoptTreePermitAuthority({ env: unknownAuthority.exportChildEnv(), classifyIdentity: unknown.classify, currentIdentity: () => current });
    assert.equal(await unknownAdopter.acquireReservation(), null, "unknown remains fail-closed");
    // A reused PID with another start time is modeled as exact death of old tuple.
    unknown.set(unknownOwner, "dead"); unknown.set({ pid: 421, startedAt: 2 }, "live");
    assert.ok(await unknownAdopter.acquireReservation());
  });

  test("retains a crashed root authority for live descendants and reclaims its dead root permit", async () => {
    const base = await root();
    const parent = { pid: 481, startedAt: 1 }, child = { pid: 482, startedAt: 1 };
    const ids = identities({ "481:1": "live", "482:1": "live" });
    let current = parent;
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 2, classifyIdentity: ids.classify, currentIdentity: () => current });
    const reservation = await authority.acquireReservation();
    assert.ok(reservation);
    assert.equal(await reservation.bindChildIdentity(child), true);
    ids.set(parent, "dead"); current = child;
    const reconciled = await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify });
    assert.ok(reconciled.retained.includes(authority.rootIdentity));
    const descendant = await adoptTreePermitAuthority({ env: reservation.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => current });
    assert.ok(await descendant.acquireReservation(), "the live descendant continues after dead-root permit reclamation");
  });

  test("uses a root-identity namespace for independent trees under one shared state root", async () => {
    const base = await root();
    const one = { pid: 501, startedAt: 1 }, two = { pid: 502, startedAt: 1 };
    const ids = identities({ "501:1": "live", "502:1": "live" });
    const first = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => one });
    const second = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => two });
    assert.notEqual(first.rootIdentity, second.rootIdentity);
    assert.notEqual(first.authorityDir, second.authorityDir);
    assert.equal(await first.acquireReservation(), null);
    assert.equal(await second.acquireReservation(), null);
  });

  test("persists bounded reconciliation progress past retained prefixes and safely restarts malformed or unsafe cursors", async () => {
    const base = await root();
    const live = { pid: 701, startedAt: 1 }, dead = { pid: 702, startedAt: 1 };
    const ids = identities({ "701:1": "live", "702:1": "dead" });
    let current = live;
    const existing = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => current });
    const namespace = existing.namespaceDir;
    const liveId = "00000000-0000-0000-0000-000000000001";
    const malformedId = "00000000-0000-0000-0000-000000000002";
    const firstDeadId = "00000000-0000-0000-0000-000000000003";
    const secondDeadId = "00000000-0000-0000-0000-000000000004";
    const writeCreation = async (id: string, creator: ProcessIdentity) => {
      const directory = path.join(namespace, id);
      await fs.promises.mkdir(directory, { mode: 0o700 });
      const creation = { version: 1, kind: "pi-subagent-tree-permit-creation", rootIdentity: id, token: "x".repeat(32), maxActive: 1, creator };
      await fs.promises.writeFile(path.join(directory, "creation.json"), `${JSON.stringify(creation)}\n`, { mode: 0o600 });
      await fs.promises.chmod(path.join(directory, "creation.json"), 0o600);
    };
    await writeCreation(liveId, live);
    await fs.promises.mkdir(path.join(namespace, malformedId), { mode: 0o700 });
    await writeCreation(firstDeadId, dead);
    await writeCreation(secondDeadId, dead);

    assert.deepEqual((await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 1 })).retained, [liveId]);
    assert.deepEqual((await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 1 })).retained, [malformedId]);
    assert.deepEqual((await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 1 })).retained, [firstDeadId], "legacy public incomplete directories are ambiguous and retained");

    const cursor = path.join(namespace, "reconcile-cursor.json");
    await fs.promises.writeFile(cursor, "not-json\n", { mode: 0o600 });
    await fs.promises.chmod(cursor, 0o600);
    assert.deepEqual((await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 1 })).retained, [liveId]);
    assert.equal(await fs.promises.stat(path.join(namespace, secondDeadId)).then(() => true, () => false), true, "a malformed cursor cannot skip the retained prefix to grant cleanup");

    await fs.promises.rm(cursor);
    const cursorTarget = path.join(base, "cursor-target");
    await fs.promises.writeFile(cursorTarget, "ignored\n", { mode: 0o600 });
    await fs.promises.symlink(cursorTarget, cursor);
    assert.deepEqual((await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 1 })).retained, [liveId]);
    assert.equal(await fs.promises.stat(path.join(namespace, secondDeadId)).then(() => true, () => false), true, "an unsafe cursor cannot grant cleanup");

    assert.deepEqual((await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 1 })).retained, [malformedId]);
    assert.deepEqual((await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 1 })).retained, [firstDeadId]);
    assert.deepEqual((await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 1 })).retained, [secondDeadId], "cursor progress also advances through retained legacy public directories");
  });

  test("retains an authority when its quarantine tombstone is substituted after rename", async () => {
    const base = await root();
    const owner = { pid: 571, startedAt: 1 };
    const ids = identities({ "571:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => owner });
    ids.set(owner, "dead");
    const rename = fs.promises.rename;
    let injected = false;
    (fs.promises as any).rename = async (from: string, to: string) => {
      await rename(from, to);
      if (!injected && from === authority.authorityDir && path.dirname(to) === authority.namespaceDir && path.basename(to).startsWith(".tree-permit-tombstone-")) {
        injected = true;
        await rename(to, path.join(authority.namespaceDir, ".saved-original"));
        await fs.promises.mkdir(to, { mode: 0o700 });
      }
    };
    try {
      const reconciled = await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify });
      assert.ok(injected);
      assert.ok(reconciled.retained.includes(authority.rootIdentity));
      const replacement = (await fs.promises.readdir(authority.namespaceDir)).find((name) => name.startsWith(".tree-permit-tombstone-"));
      assert.ok(replacement);
      assert.equal((await fs.promises.lstat(path.join(authority.namespaceDir, replacement!))).isDirectory(), true, "the substituted tombstone is retained rather than recursively deleted");
    } finally {
      (fs.promises as any).rename = rename;
    }
  });

  test("removes only aged exact-dead private stage, temp, and tombstone artifacts", async () => {
    const base = await root();
    const live = { pid: 901, startedAt: 1 }, dead = { pid: 902, startedAt: 1 };
    const ids = identities({ "901:1": "live", "902:1": "dead" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => live });
    const namespace = authority.namespaceDir;
    const rootId = "10000000-0000-0000-0000-000000000001";
    const old = new Date(Date.now() - 2_000);
    const stage = `.tree-permit-stage-${rootId}-902-1`;
    const temp = `.tree-permit-temp-YXV0aG9yaXR5Lmpzb24-902-1-${"x".repeat(32)}.tmp`;
    const tombstone = `.tree-permit-tombstone-${rootId}-902-1-${"y".repeat(32)}`;
    const retainedStage = `.tree-permit-stage-20000000-0000-0000-0000-000000000002-901-1`;
    await fs.promises.mkdir(path.join(namespace, stage), { mode: 0o700 });
    await fs.promises.writeFile(path.join(namespace, temp), "partial", { mode: 0o600 });
    await fs.promises.mkdir(path.join(namespace, tombstone), { mode: 0o700 });
    await fs.promises.mkdir(path.join(namespace, retainedStage), { mode: 0o700 });
    for (const name of [stage, temp, tombstone, retainedStage]) await fs.promises.utimes(path.join(namespace, name), old, old);
    const reconciled = await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 32 });
    assert.deepEqual(new Set(reconciled.removed), new Set([stage, temp, tombstone]));
    assert.ok(reconciled.retained.includes(retainedStage));
    assert.equal(await fs.promises.lstat(path.join(namespace, retainedStage)).then(() => true, () => false), true);
  });

  test("fails closed after a 10k-ish snapshot junk walk without collecting it", async () => {
    const base = await root();
    const owner = { pid: 906, startedAt: 1 };
    const ids = identities({ "906:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => owner });
    // Intentionally serial: this creates the hostile directory without a large
    // in-test promise/name array, matching the reader's bounded-memory goal.
    for (let index = 0; index < 10_000; index += 1) {
      await fs.promises.writeFile(path.join(authority.authorityDir, `junk-${String(index).padStart(5, "0")}`), "x", { mode: 0o600 });
    }
    await assert.rejects(adoptTreePermitAuthority({ env: authority.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => owner }), /state chain is invalid/);
  });

  test("crash before creation leaves a private stage and no public incomplete authority", async () => {
    const base = await root();
    const owner = { pid: 911, startedAt: 1 };
    const ids = identities({ "911:1": "live" });
    const open = fs.promises.open;
    let injected = false;
    (fs.promises as any).open = async (file: string, ...args: any[]) => {
      if (!injected && path.basename(path.dirname(file)).startsWith(".tree-permit-stage-")) {
        injected = true;
        throw new Error("simulated crash before creation publish");
      }
      return await open(file, ...args);
    };
    try {
      await assert.rejects(createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => owner }), /simulated crash/);
      assert.equal(injected, true);
      const namespace = path.join(base, ".tree-permits");
      const names = await fs.promises.readdir(namespace);
      assert.equal(names.some((name) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(name)), false);
      assert.equal(names.filter((name) => name.startsWith(".tree-permit-stage-")).length, 1);
    } finally { (fs.promises as any).open = open; }
  });

  test("validates every immutable snapshot digest from genesis through head", async () => {
    const base = await root();
    const owner = { pid: 581, startedAt: 1 };
    const ids = identities({ "581:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 3, classifyIdentity: ids.classify, currentIdentity: () => owner });
    assert.ok(await authority.acquireReservation());
    assert.ok(await authority.acquireReservation());
    const genesisPath = path.join(authority.authorityDir, "state-00000000000000000000.json");
    const genesis = JSON.parse(await fs.promises.readFile(genesisPath, "utf8"));
    genesis.previousDigest = "f".repeat(64);
    await fs.promises.writeFile(genesisPath, `${JSON.stringify(genesis)}\n`, { mode: 0o600 });
    await fs.promises.chmod(genesisPath, 0o600);
    await assert.rejects(authority.acquireReservation(), /state chain is invalid/);
  });

  test("compacts more than two epochs into a bounded, adoptable immutable tail", async () => {
    const base = await root();
    const owner = { pid: 801, startedAt: 1 };
    const ids = identities({ "801:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 16, classifyIdentity: ids.classify, currentIdentity: () => owner });
    await advance(authority, 132); // 264 legitimate mutations cross two checkpoint intervals.
    const files = await fs.promises.readdir(authority.authorityDir);
    assert.ok((await checkpoints(authority)).length === 1);
    assert.ok(files.filter((name) => /^(?:state|checkpoint)-/.test(name)).length <= 129, "the retained epoch is bounded");
    const adopted = await adoptTreePermitAuthority({ env: authority.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => owner });
    assert.ok(await adopted.acquireReservation());
  });

  test("adopts a valid interrupted checkpoint compaction with old states still present", async () => {
    const base = await root();
    const owner = { pid: 811, startedAt: 1 };
    const ids = identities({ "811:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 16, classifyIdentity: ids.classify, currentIdentity: () => owner });
    await advance(authority, 64);
    const head = await latest(authority);
    const digest = crypto.createHash("sha256").update(`${JSON.stringify(head)}\n`).digest("hex");
    const payload = { version: 1, kind: "pi-subagent-tree-permit-checkpoint", rootIdentity: authority.rootIdentity, maxActive: authority.maxActive, generation: head.generation, state: head, stateDigest: digest };
    const hmac = crypto.createHmac("sha256", authority.token).update(JSON.stringify(payload)).digest("hex");
    const checkpoint = { ...payload, hmac };
    const name = `checkpoint-${String(head.generation).padStart(20, "0")}.json`;
    await fs.promises.writeFile(path.join(authority.authorityDir, name), `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
    await fs.promises.chmod(path.join(authority.authorityDir, name), 0o600);
    assert.ok((await generations(authority)).length > 100, "the pre-compaction states intentionally coexist");
    assert.ok(await adoptTreePermitAuthority({ env: authority.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => owner }).then(() => true));
    assert.ok(await authority.acquireReservation(), "the next mutation finishes the idempotent compaction before appending");
    assert.ok((await generations(authority)).length < 4);
  });

  test("fails closed for corrupt checkpoint HMAC, canonical state, and checkpoint bytes", { timeout: 15_000 }, async () => {
    const run = async (corrupt: (value: any) => string) => {
      const base = await root();
      const owner = { pid: 821 + roots.length, startedAt: 1 };
      const ids = identities({ [`${owner.pid}:1`]: "live" });
      const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 16, classifyIdentity: ids.classify, currentIdentity: () => owner });
      await publishCheckpoint(authority);
      const name = (await checkpoints(authority))[0]!;
      const value = JSON.parse(await fs.promises.readFile(path.join(authority.authorityDir, name), "utf8"));
      await fs.promises.writeFile(path.join(authority.authorityDir, name), corrupt(value), { mode: 0o600 });
      await fs.promises.chmod(path.join(authority.authorityDir, name), 0o600);
      await assert.rejects(adoptTreePermitAuthority({ env: authority.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => owner }), /state chain is invalid/);
    };
    await run((value) => `${JSON.stringify({ ...value, hmac: "0".repeat(64) })}\n`);
    await run((value) => `${JSON.stringify({ ...value, state: { ...value.state, generation: value.state.generation + 1 } })}\n`);
    await run(() => "not-json\n");
  });

  test("keeps concurrent checkpoint compaction and successor CAS no-replay safe", async () => {
    const base = await root();
    const owner = { pid: 841, startedAt: 1 };
    const ids = identities({ "841:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 16, classifyIdentity: ids.classify, currentIdentity: () => owner });
    await advance(authority, 64);
    const leases = await Promise.all(Array.from({ length: 8 }, () => authority.acquireReservation()));
    assert.equal(leases.filter(Boolean).length, 8);
    assert.equal(new Set(leases.filter(Boolean).map((lease: any) => lease.id)).size, 8);
    assert.ok((await checkpoints(authority)).length === 1);
    assert.ok(await adoptTreePermitAuthority({ env: authority.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => owner }).then(() => true));
  });

  test("rejects oversized and excessive authority snapshot files before adoption", async () => {
    const setup = async (pid: number) => {
      const base = await root();
      const owner = { pid, startedAt: 1 };
      const ids = identities({ [`${pid}:1`]: "live" });
      const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 16, classifyIdentity: ids.classify, currentIdentity: () => owner });
      return { authority, owner, ids };
    };
    const oversized = await setup(851);
    await fs.promises.writeFile(path.join(oversized.authority.authorityDir, "state-00000000000000000001.json"), "x".repeat(64 * 1024 + 1), { mode: 0o600 });
    await fs.promises.chmod(path.join(oversized.authority.authorityDir, "state-00000000000000000001.json"), 0o600);
    await assert.rejects(adoptTreePermitAuthority({ env: oversized.authority.exportChildEnv(), classifyIdentity: oversized.ids.classify, currentIdentity: () => oversized.owner }), /state chain is invalid/);

    const excessive = await setup(852);
    await Promise.all(Array.from({ length: 140 }, async (_, generation) => {
      const name = `checkpoint-${String(generation).padStart(20, "0")}.json`;
      await fs.promises.writeFile(path.join(excessive.authority.authorityDir, name), "{}\n", { mode: 0o600 });
      await fs.promises.chmod(path.join(excessive.authority.authorityDir, name), 0o600);
    }));
    await assert.rejects(adoptTreePermitAuthority({ env: excessive.authority.exportChildEnv(), classifyIdentity: excessive.ids.classify, currentIdentity: () => excessive.owner }), /state chain is invalid/);

    const legacyExcessive = await setup(853);
    for (let generation = 1; generation <= 8192; generation += 1) {
      const name = `state-${String(generation).padStart(20, "0")}.json`;
      await fs.promises.writeFile(path.join(legacyExcessive.authority.authorityDir, name), "{}\n", { mode: 0o600 });
      await fs.promises.chmod(path.join(legacyExcessive.authority.authorityDir, name), 0o600);
    }
    await assert.rejects(adoptTreePermitAuthority({ env: legacyExcessive.authority.exportChildEnv(), classifyIdentity: legacyExcessive.ids.classify, currentIdentity: () => legacyExcessive.owner }), /state chain is invalid/);
  });

  test("recovers a 137-state checkpoint crash before unlink and rejects oversized parked admission", async () => {
    const base = await root();
    const owner = { pid: 856, startedAt: 1 };
    const ids = identities({ "856:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 16, classifyIdentity: ids.classify, currentIdentity: () => owner });
    await advance(authority, 64); // valid immutable states 0 through 128
    const head = await latest(authority);
    let previous = crypto.createHash("sha256").update(`${JSON.stringify(head)}\n`).digest("hex");
    for (let generation = 129; generation <= 136; generation += 1) {
      const state = { ...head, generation, previousDigest: previous };
      const content = `${JSON.stringify(state)}\n`;
      previous = crypto.createHash("sha256").update(content).digest("hex");
      const name = `state-${String(generation).padStart(20, "0")}.json`;
      await fs.promises.writeFile(path.join(authority.authorityDir, name), content, { mode: 0o600 });
      await fs.promises.chmod(path.join(authority.authorityDir, name), 0o600);
    }
    assert.equal((await generations(authority)).length, 137);
    // Simulate a crash after the checkpoint link/fsync but before any legacy
    // state unlink. The normal adopter must recognize this bounded migration
    // envelope instead of rejecting the oversized steady-state directory.
    const checkpointState = await latest(authority);
    const checkpointDigest = crypto.createHash("sha256").update(`${JSON.stringify(checkpointState)}\n`).digest("hex");
    const checkpointPayload = { version: 1, kind: "pi-subagent-tree-permit-checkpoint", rootIdentity: authority.rootIdentity, maxActive: authority.maxActive, generation: checkpointState.generation, state: checkpointState, stateDigest: checkpointDigest };
    const checkpoint = { ...checkpointPayload, hmac: crypto.createHmac("sha256", authority.token).update(JSON.stringify(checkpointPayload)).digest("hex") };
    await fs.promises.writeFile(path.join(authority.authorityDir, `checkpoint-${String(checkpointState.generation).padStart(20, "0")}.json`), `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
    assert.ok(await adoptTreePermitAuthority({ env: authority.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => owner }).then(() => true));
    assert.ok(await authority.acquireReservation(), "the next mutation resumes the interrupted deletion before appending");
    assert.equal((await checkpoints(authority)).length, 1);
    assert.ok((await generations(authority)).length < 3);

    const crowded = await createTreePermitAuthority({ rootDir: await root(), maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => owner });
    const crowdedHead = await latest(crowded);
    const inherited = crowdedHead.leases[0];
    crowdedHead.leases = [inherited, ...Array.from({ length: MAX_TREE_PERMIT_LEASES - 1 }, () => ({ id: crypto.randomUUID(), token: "x".repeat(32), state: "PARKED_WAIT", owner }))];
    const crowdedPath = path.join(crowded.authorityDir, (await generations(crowded)).at(-1)!);
    await fs.promises.writeFile(crowdedPath, `${JSON.stringify(crowdedHead)}\n`, { mode: 0o600 });
    await fs.promises.chmod(crowdedPath, 0o600);
    assert.equal(await crowded.acquireReservation(), null, "PARKED_WAIT leases consume the total representation cap");
    crowdedHead.leases.push({ id: crypto.randomUUID(), token: "y".repeat(32), state: "PARKED_WAIT", owner });
    await fs.promises.writeFile(crowdedPath, `${JSON.stringify(crowdedHead)}\n`, { mode: 0o600 });
    await fs.promises.chmod(crowdedPath, 0o600);
    assert.equal(await crowded.inheritedLease!.release(), true, "legacy oversized state can still shrink through release");
    assert.equal((await latest(crowded)).leases.length, MAX_TREE_PERMIT_LEASES);
  });

  test("adopts legacy no-checkpoint v1 history and compacts it on the next mutation", async () => {
    const base = await root();
    const owner = { pid: 861, startedAt: 1 };
    const ids = identities({ "861:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 16, classifyIdentity: ids.classify, currentIdentity: () => owner });
    await advance(authority, 64);
    assert.deepEqual(await checkpoints(authority), []);
    assert.ok(await adoptTreePermitAuthority({ env: authority.exportChildEnv(), classifyIdentity: ids.classify, currentIdentity: () => owner }).then(() => true));
    assert.ok(await authority.acquireReservation());
    assert.equal((await checkpoints(authority)).length, 1);
    assert.ok((await generations(authority)).length < 3);
  });

  test("fails closed for malformed generations and reconciles only exact-dead complete or recoverable incomplete authorities", async () => {
    const base = await root();
    const owner = { pid: 601, startedAt: 1 }, live = { pid: 602, startedAt: 1 };
    const ids = identities({ "601:1": "live", "602:1": "live" });
    const authority = await createTreePermitAuthority({ rootDir: base, maxActive: 2, classifyIdentity: ids.classify, currentIdentity: () => owner });
    await fs.promises.writeFile(path.join(authority.authorityDir, "state-not-a-generation.json"), "{}\n", { mode: 0o600 });
    await fs.promises.chmod(path.join(authority.authorityDir, "state-not-a-generation.json"), 0o600);
    await assert.rejects(authority.acquireReservation(), /state chain is invalid/);

    const complete = await createTreePermitAuthority({ rootDir: base, maxActive: 1, classifyIdentity: ids.classify, currentIdentity: () => live });
    ids.set(live, "dead");
    const incompleteId = crypto.randomUUID();
    const incomplete = path.join(complete.namespaceDir, incompleteId);
    await fs.promises.mkdir(incomplete, { mode: 0o700 });
    const creation = { version: 1, kind: "pi-subagent-tree-permit-creation", rootIdentity: incompleteId, token: "z".repeat(32), maxActive: 1, creator: live };
    await fs.promises.writeFile(path.join(incomplete, "creation.json"), `${JSON.stringify(creation)}\n`, { mode: 0o600 });
    await fs.promises.chmod(path.join(incomplete, "creation.json"), 0o600);
    const malformedId = crypto.randomUUID();
    const malformed = path.join(complete.namespaceDir, malformedId);
    await fs.promises.mkdir(malformed, { mode: 0o700 });
    await fs.promises.writeFile(path.join(malformed, "creation.json"), "not-json\n", { mode: 0o600 });
    await fs.promises.chmod(path.join(malformed, "creation.json"), 0o600);
    const malformedManifestId = crypto.randomUUID();
    const malformedManifest = path.join(complete.namespaceDir, malformedManifestId);
    await fs.promises.mkdir(malformedManifest, { mode: 0o700 });
    const deadCreation = { version: 1, kind: "pi-subagent-tree-permit-creation", rootIdentity: malformedManifestId, token: "q".repeat(32), maxActive: 1, creator: live };
    await fs.promises.writeFile(path.join(malformedManifest, "creation.json"), `${JSON.stringify(deadCreation)}\n`, { mode: 0o600 });
    await fs.promises.writeFile(path.join(malformedManifest, "authority.json"), "not-json\n", { mode: 0o600 });
    await fs.promises.chmod(path.join(malformedManifest, "creation.json"), 0o600);
    await fs.promises.chmod(path.join(malformedManifest, "authority.json"), 0o600);

    const reconciled = await reconcileTreePermitAuthorities({ rootDir: base, classifyIdentity: ids.classify, limit: 16 });
    assert.ok(reconciled.removed.includes(complete.rootIdentity));
    assert.ok(reconciled.retained.includes(incompleteId), "legacy public incomplete authorities are retained conservatively");
    assert.ok(reconciled.retained.includes(malformedId));
    assert.ok(reconciled.retained.includes(malformedManifestId), "a present malformed manifest is not a recoverable missing-manifest authority");
    assert.equal(await fs.promises.stat(malformed).then(() => true, () => false), true);
    assert.equal(await fs.promises.stat(malformedManifest).then(() => true, () => false), true);
  });
});
