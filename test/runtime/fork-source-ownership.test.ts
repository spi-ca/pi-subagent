import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	FORK_SOURCE_ROOT_NAME,
	ForkSourceOwnershipManager,
	parseForkBootstrap,
	parseForkBootstrapAck,
	parseForkRegistration,
	parseForkQuiesced,
	parseForkSourceManifest,
	reconcileForkSourceOwnershipRoot,
	verifyAndAcknowledgeForkBootstrap,
} from "../../src/runtime/fork-source-ownership";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await fs.promises.rm(dirs.pop()!, { recursive: true, force: true }); });

async function fixture() {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-fork-source-")); dirs.push(root);
	let tick = 100;
	const manager = await ForkSourceOwnershipManager.create('{"role":"user"}\n', { rootDir: root, ownerPid: 10, ownerStartedAt: 20, now: () => ++tick });
	const session = path.join(root, "session.jsonl");
	await fs.promises.writeFile(session, Buffer.from("prefix\n{\"role\":\"user\"}\npostfix\n"), { mode: 0o600 });
	await fs.promises.chmod(session, 0o600);
	return { root, manager, session, offset: Buffer.byteLength("prefix\n") };
}

describe("fork source ownership", () => {
	test("creates private marked source records and exact parsers reject extra keys", async () => {
		const { manager } = await fixture();
		for (const item of [manager.paths.rootDir, manager.paths.invocationDir, manager.paths.childrenDir]) assert.equal((await fs.promises.stat(item)).mode & 0o777, 0o700);
		for (const item of [manager.paths.rootMarkerPath, manager.paths.invocationMarkerPath, manager.paths.sourcePath, manager.paths.manifestPath]) assert.equal((await fs.promises.stat(item)).mode & 0o777, 0o600);
		const manifest = JSON.parse(await fs.promises.readFile(manager.paths.manifestPath, "utf8"));
		assert.equal(parseForkSourceManifest(manifest, manager.invocationId)?.source.digest.length, 64);
		assert.equal(parseForkSourceManifest({ ...manifest, extra: true }, manager.invocationId), null);
		assert.equal(parseForkBootstrap({ invocationId: manager.invocationId }), null);
		assert.equal(parseForkBootstrapAck({ invocationId: manager.invocationId }), null);
	});

	test("persists registration and supports an empty exact source segment", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-fork-source-")); dirs.push(root);
		const manager = await ForkSourceOwnershipManager.create("", { rootDir: root, ownerPid: 10, ownerStartedAt: 20, now: () => 30 });
		const child = await manager.registerChild({ childId: "empty", surface: "inline" });
		const registration = parseForkRegistration(JSON.parse(await fs.promises.readFile(path.join(child.childDir, "registration.json"), "utf8")), manager.invocationId, child.childId);
		assert.equal(registration?.runId, null);
		const session = path.join(root, "empty-session.jsonl");
		await fs.promises.writeFile(session, "header\n", { mode: 0o600 }); await fs.promises.chmod(session, 0o600);
		await manager.writeBootstrap(child.childId, { sessionPath: session, inheritedOffset: Buffer.byteLength("header\n"), inheritedLength: 0 });
		await verifyAndAcknowledgeForkBootstrap(path.join(child.childDir, "bootstrap.json"), { pid: 91, startedAt: 92, now: () => 93 });
		assert.equal(await manager.validateChildAcknowledgement(child.childId), false, "an unbound same-UID acknowledgement is not authority");
		await manager.recordProcess(child.childId, { pid: 91, startedAt: 92 });
		assert.equal(await manager.validateChildAcknowledgement(child.childId), true);
	});

	test("supports fork sources larger than 64KiB without weakening the JSON artifact bound", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-fork-source-")); dirs.push(root);
		const source = `${JSON.stringify({ type: "message", content: "x".repeat(70 * 1024) })}\n`;
		const manager = await ForkSourceOwnershipManager.create(source, { rootDir: root });
		const session = path.join(root, "large-session.jsonl");
		const prefix = '{"type":"session"}\n';
		await fs.promises.writeFile(session, `${prefix}${source}`, { mode: 0o600 });
		const child = await manager.registerChild({ surface: "inline" });
		await manager.writeBootstrap(child.childId, { sessionPath: session, inheritedOffset: Buffer.byteLength(prefix), inheritedLength: Buffer.byteLength(source) });
		const acknowledgement = await verifyAndAcknowledgeForkBootstrap(path.join(child.childDir, "bootstrap.json"));
		await manager.recordProcess(child.childId, acknowledgement.child);
		await manager.seal();
		assert.equal((await manager.reconcile()).removed, true);
	});

	test("rejects symlink roots, traversal, unsafe sessions, and source/session aliases", async () => {
		if (process.platform === "win32") return;
		const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-fork-source-")); dirs.push(base);
		const actual = path.join(base, "actual"); const linked = path.join(base, "linked");
		await fs.promises.mkdir(actual, { mode: 0o700 }); await fs.promises.symlink(actual, linked);
		await assert.rejects(() => ForkSourceOwnershipManager.create('{"x":1}\n', { rootDir: linked }), /must not be a symlink|unsafe/);
		const { manager } = await fixture();
		await assert.rejects(() => manager.registerChild({ childId: "../escape", surface: "inline" }), /Invalid/);
		const child = await manager.registerChild({ surface: "inline" });
		await assert.rejects(() => manager.writeBootstrap(child.childId, { sessionPath: "relative", inheritedOffset: 0, inheritedLength: 1 }), /Invalid/);
		await assert.rejects(() => manager.writeBootstrap(child.childId, { sessionPath: manager.paths.sourcePath, inheritedOffset: 0, inheritedLength: 16 }), /distinct|exactly/);
	});

	test("binds source bytes and inode to an exact inherited session segment and acknowledges it", async () => {
		const { manager, session, offset } = await fixture();
		const { childId, childDir } = await manager.registerChild({ childId: "child-a", surface: "interactive", runId: "run-1" });
		const bootstrap = await manager.writeBootstrap(childId, { sessionPath: session, inheritedOffset: offset, inheritedLength: Buffer.byteLength('{"role":"user"}\n') });
		assert.equal(bootstrap.surface, "interactive"); assert.equal(bootstrap.runId, "run-1");
		const ack = await verifyAndAcknowledgeForkBootstrap(path.join(childDir, "bootstrap.json"), { pid: 91, startedAt: 92, now: () => 93 });
		assert.equal(ack.child.pid, 91); assert.equal((await fs.promises.stat(path.join(childDir, "bootstrap-ack.json"))).mode & 0o777, 0o600);
		await assert.rejects(() => manager.writeBootstrap(childId, { sessionPath: session, inheritedOffset: offset, inheritedLength: 16 }), /cannot replace|existing/);
		const inodeBound = await manager.registerChild({ childId: "child-inode", surface: "inline" });
		await manager.writeBootstrap(inodeBound.childId, { sessionPath: session, inheritedOffset: offset, inheritedLength: 16 });
		const original = await fs.promises.readFile(manager.paths.sourcePath);
		await fs.promises.unlink(manager.paths.sourcePath); await fs.promises.writeFile(manager.paths.sourcePath, original, { mode: 0o600 }); await fs.promises.chmod(manager.paths.sourcePath, 0o600);
		await assert.rejects(() => verifyAndAcknowledgeForkBootstrap(path.join(inodeBound.childDir, "bootstrap.json"), { pid: 91, startedAt: 92 }), /inode/);
	});

	test("uses hard-link no-replace publication and rejects malformed or conflicting acknowledgements", async () => {
		const { manager, session, offset } = await fixture();
		const { childId, childDir } = await manager.registerChild({ childId: "child-a", surface: "inline" });
		await manager.writeBootstrap(childId, { sessionPath: session, inheritedOffset: offset, inheritedLength: 16 });
		const bootstrap = path.join(childDir, "bootstrap.json");
		const acks = await Promise.all(Array.from({ length: 8 }, () => verifyAndAcknowledgeForkBootstrap(bootstrap, { pid: 42, startedAt: 43, now: () => 44 })));
		assert.equal(new Set(acks.map((ack) => ack.bootstrapDigest)).size, 1);
		const bad = await manager.registerChild({ childId: "child-b", surface: "inline" });
		await manager.writeBootstrap(bad.childId, { sessionPath: session, inheritedOffset: offset, inheritedLength: 16 });
		await fs.promises.writeFile(path.join(bad.childDir, "bootstrap-ack.json"), "{}", { mode: 0o600 }); await fs.promises.chmod(path.join(bad.childDir, "bootstrap-ack.json"), 0o600);
		await assert.rejects(() => verifyAndAcknowledgeForkBootstrap(path.join(bad.childDir, "bootstrap.json"), { pid: 42, startedAt: 43 }), /Conflicting|malformed/);
	});

	test("retains source before seal and pending references, then cleans derived resolved refs", async () => {
		const { manager, session, offset } = await fixture();
		const acknowledged = await manager.registerChild({ childId: "ack", surface: "inline" });
		await manager.writeBootstrap(acknowledged.childId, { sessionPath: session, inheritedOffset: offset, inheritedLength: 16 });
		await manager.recordProcess(acknowledged.childId, { pid: 2, startedAt: 3 });
		await verifyAndAcknowledgeForkBootstrap(path.join(acknowledged.childDir, "bootstrap.json"), { pid: 2, startedAt: 3 });
		const pending = await manager.registerChild({ childId: "pending", surface: "inline" });
		const before = await manager.reconcile(); assert.equal(before.removed, false); assert.ok(before.retained.includes("source"));
		await manager.seal();
		const pendingResult = await manager.reconcile(); assert.deepEqual(pendingResult.resolved, ["ack"]); assert.ok(pendingResult.retained.includes("pending"));
		await manager.markTerminal(pending.childId, "no-launch");
		const final = await manager.reconcile(); assert.equal(final.removed, true); assert.equal(await fs.promises.stat(manager.paths.invocationDir).then(() => true).catch(() => false), false);
	});

	test("reconciles a durable child ack after the private child session is already removed", async () => {
		const { manager, session, offset } = await fixture();
		const child = await manager.registerChild({ childId: "durable-ack", surface: "inline" });
		await manager.writeBootstrap(child.childId, { sessionPath: session, inheritedOffset: offset, inheritedLength: 16 });
		await manager.recordProcess(child.childId, { pid: 91, startedAt: 92 });
		await verifyAndAcknowledgeForkBootstrap(path.join(child.childDir, "bootstrap.json"), { pid: 91, startedAt: 92 });
		await fs.promises.unlink(session);
		await manager.seal();
		const outcome = await manager.reconcile();
		assert.equal(outcome.removed, true);
	});

	test("cleans source ownership after tree permit acquisition fails", async () => {
		const { manager } = await fixture();
		const permitFailure = new Error("tree permit acquisition failed");
		const acquireTreePermit = async (): Promise<void> => { throw permitFailure; };
		let observed: unknown;
		try {
			await acquireTreePermit();
		} catch (error) {
			observed = error;
		} finally {
			await manager.quiesce();
			const recovery = await ForkSourceOwnershipManager.open(manager.paths.invocationDir);
			assert.equal((await recovery.reconcile({ allowDeadOwnerSeal: true })).removed, true);
		}
		assert.equal(observed, permitFailure, "cleanup must not replace the permit acquisition error");
		assert.equal(fs.existsSync(manager.paths.invocationDir), false);
	});

	test("can implicitly seal only a proven dead owner and is idempotent after source unlink crash window", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-fork-source-")); dirs.push(root);
		const manager = await ForkSourceOwnershipManager.create('{"x":1}\n', { rootDir: root, ownerPid: 8, ownerStartedAt: 9, now: () => 10, ownerStatus: () => "dead" });
		const recovered = await ForkSourceOwnershipManager.open(manager.paths.invocationDir, { ownerStatus: () => "dead" });
		const result = await recovered.reconcile({ allowDeadOwnerSeal: true }); assert.equal(result.removed, true);
		const manager2 = await ForkSourceOwnershipManager.create('{"x":2}\n', { rootDir: root, ownerPid: 8, ownerStartedAt: 9, now: () => 11 });
		await manager2.seal(); await fs.promises.unlink(manager2.paths.sourcePath);
		const cleanup = await manager2.reconcile(); assert.equal(cleanup.removed, true);
		const second = await manager2.reconcile(); assert.equal(second.removed, true);
	});

	test("startup reconciliation reopens durable records and resolves dead-owner acknowledgement after session deletion", async () => {
		const { root, manager, session, offset } = await fixture();
		const child = await manager.registerChild({ childId: "restart-ack", surface: "inline" });
		await manager.writeBootstrap(child.childId, { sessionPath: session, inheritedOffset: offset, inheritedLength: 16 });
		await manager.recordProcess(child.childId, { pid: 91, startedAt: 92 });
		await verifyAndAcknowledgeForkBootstrap(path.join(child.childDir, "bootstrap.json"), { pid: 91, startedAt: 92 });
		await fs.promises.unlink(session);
		const outcome = await reconcileForkSourceOwnershipRoot({ stateRoot: root, ownerStatus: () => "dead", now: () => 10_000 });
		assert.deepEqual(outcome.scanned, [manager.invocationId]);
		assert.deepEqual(outcome.resolved, [`${manager.invocationId}/restart-ack`]);
		assert.deepEqual(outcome.removed, [manager.invocationId]);
	});

	test("dead-owner pending process and no-launch records reconcile conservatively", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-fork-source-")); dirs.push(root);
		let clock = 100;
		const manager = await ForkSourceOwnershipManager.create('{"x":1}\n', { rootDir: root, ownerPid: 8, ownerStartedAt: 9, now: () => ++clock });
		const processChild = await manager.registerChild({ childId: "dead-process", surface: "inline" });
		await manager.recordProcess(processChild.childId, { pid: 91, startedAt: 92 });
		const noLaunch = await manager.registerChild({ childId: "no-launch", surface: "inline" });
		const retained = await reconcileForkSourceOwnershipRoot({ stateRoot: root, ownerStatus: ({ pid }) => pid === 91 ? "live" : "dead", now: () => 10_000 });
		assert.ok(retained.retained.includes(`${manager.invocationId}/dead-process`));
		assert.ok(retained.resolved.includes(`${manager.invocationId}/${noLaunch.childId}`));
		const resolved = await reconcileForkSourceOwnershipRoot({ stateRoot: root, ownerStatus: () => "dead", now: () => 10_000 });
		assert.ok(resolved.resolved.includes(`${manager.invocationId}/dead-process`));
	});

	test("inline watchdog grace and an extant interactive run directory retain pending launch state", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-fork-source-")); dirs.push(root);
		let clock = 100;
		const inline = await ForkSourceOwnershipManager.create('{"x":1}\n', { rootDir: root, ownerPid: 8, ownerStartedAt: 9, now: () => ++clock });
		const session = path.join(root, "session.jsonl");
		await fs.promises.writeFile(session, 'prefix\n{"x":1}\n', { mode: 0o600 }); await fs.promises.chmod(session, 0o600);
		const inlineChild = await inline.registerChild({ childId: "inline", surface: "inline" });
		await inline.writeBootstrap(inlineChild.childId, { sessionPath: session, inheritedOffset: 7, inheritedLength: 8 });
		const interactive = await ForkSourceOwnershipManager.create('{"x":2}\n', { rootDir: root, ownerPid: 8, ownerStartedAt: 9, now: () => ++clock });
		const interactiveSession = path.join(root, "interactive-session.jsonl");
		await fs.promises.writeFile(interactiveSession, 'prefix\n{"x":2}\n', { mode: 0o600 }); await fs.promises.chmod(interactiveSession, 0o600);
		const interactiveChild = await interactive.registerChild({ childId: "interactive", surface: "interactive", runId: "interactive-run" });
		await interactive.writeBootstrap(interactiveChild.childId, { sessionPath: interactiveSession, inheritedOffset: 7, inheritedLength: 8 });
		await fs.promises.mkdir(path.join(root, "interactive-run"), { mode: 0o700 });
		const pending = await reconcileForkSourceOwnershipRoot({ stateRoot: root, ownerStatus: () => "dead", now: () => 200 });
		assert.ok(pending.retained.includes(`${inline.invocationId}/inline`));
		assert.ok(pending.retained.includes(`${interactive.invocationId}/interactive`));
		await fs.promises.rmdir(path.join(root, "interactive-run"));
		const resolved = await reconcileForkSourceOwnershipRoot({ stateRoot: root, ownerStatus: () => "dead", now: () => 6_000 });
		assert.ok(resolved.resolved.includes(`${inline.invocationId}/inline`));
		assert.ok(resolved.resolved.includes(`${interactive.invocationId}/interactive`));
	});

	test("reserved root refuses malformed markers and leaves extra artifacts untouched", async () => {
		const { root, manager } = await fixture();
		const extra = path.join(manager.paths.invocationDir, "extra");
		await fs.promises.writeFile(extra, "keep", { mode: 0o600 }); await fs.promises.chmod(extra, 0o600);
		const retained = await reconcileForkSourceOwnershipRoot({ stateRoot: root, ownerStatus: () => "dead", now: () => 10_000 });
		assert.ok(retained.retained.includes(`${manager.invocationId}/source`));
		assert.equal(fs.existsSync(extra), true);
		assert.equal(fs.existsSync(manager.paths.sealPath), false, "malformed invocation is not implicitly sealed");
		await fs.promises.writeFile(path.join(root, FORK_SOURCE_ROOT_NAME, "root-marker.json"), "{}", { mode: 0o600 });
		const malformed = await reconcileForkSourceOwnershipRoot({ stateRoot: root, ownerStatus: () => "dead" });
		assert.deepEqual(malformed.invalid, [FORK_SOURCE_ROOT_NAME]);
		assert.equal(fs.existsSync(extra), true);
	});

	test("quiesce fences new mutations, drains queued registrations, and is idempotent", async () => {
		const { manager } = await fixture();
		const queued = manager.registerChild({ childId: "queued", surface: "inline" });
		const first = manager.quiesce();
		const child = await queued;
		await first;
		const acknowledgementBytes = await fs.promises.readFile(manager.paths.quiescedPath);
		const acknowledgement = parseForkQuiesced(JSON.parse(acknowledgementBytes.toString("utf8")), manager.invocationId);
		assert.equal(acknowledgement?.owner.pid, 10);
		assert.equal(parseForkQuiesced({ ...acknowledgement, extra: true }, manager.invocationId), null);
		assert.equal(fs.existsSync(path.join(child.childDir, "registration.json")), true);
		await manager.quiesce();
		assert.deepEqual(await fs.promises.readFile(manager.paths.quiescedPath), acknowledgementBytes);
		await assert.rejects(() => manager.registerChild({ childId: "late", surface: "inline" }), /quiescing/);
		await assert.rejects(() => manager.writeBootstrap(child.childId, { sessionPath: path.join(manager.paths.stateRoot, "missing"), inheritedOffset: 0, inheritedLength: 0 }), /quiescing/);
		await assert.rejects(() => manager.recordProcess(child.childId, { pid: 1, startedAt: 1 }), /quiescing/);
		await assert.rejects(() => manager.markTerminal(child.childId, "no-launch"), /quiescing/);
	});

	test("malformed or conflicting quiesced acknowledgement retains all durable state", async () => {
		const { manager } = await fixture();
		const child = await manager.registerChild({ childId: "pending", surface: "inline" });
		await manager.seal();
		await fs.promises.writeFile(manager.paths.quiescedPath, "{}", { mode: 0o600 }); await fs.promises.chmod(manager.paths.quiescedPath, 0o600);
		await assert.rejects(() => manager.quiesce(), /Conflicting|malformed/);
		const retained = await manager.reconcile();
		assert.equal(retained.removed, false);
		assert.ok(retained.retained.includes(child.childId));
		assert.equal(fs.existsSync(manager.paths.sourcePath), true);
	});

	test("a valid quiesced transfer lets recovery clean dead process and no-launch refs while owner remains live", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-fork-source-")); dirs.push(root);
		let tick = 100;
		const ownerStatus = ({ pid }: { pid: number }) => pid === 10 ? "live" as const : "dead" as const;
		const manager = await ForkSourceOwnershipManager.create('{"x":1}\n', { rootDir: root, ownerPid: 10, ownerStartedAt: 20, now: () => ++tick, ownerStatus });
		const deadProcess = await manager.registerChild({ childId: "dead-process", surface: "inline" });
		await manager.recordProcess(deadProcess.childId, { pid: 91, startedAt: 92 });
		await manager.registerChild({ childId: "no-launch", surface: "inline" });
		const session = path.join(root, "transfer-session.jsonl");
		await fs.promises.writeFile(session, 'prefix\n{"x":1}\n', { mode: 0o600 }); await fs.promises.chmod(session, 0o600);
		const inline = await manager.registerChild({ childId: "inline-grace", surface: "inline" });
		await manager.writeBootstrap(inline.childId, { sessionPath: session, inheritedOffset: 7, inheritedLength: 8 });
		const interactive = await manager.registerChild({ childId: "interactive-absent", surface: "interactive", runId: "gone-run" });
		await manager.writeBootstrap(interactive.childId, { sessionPath: session, inheritedOffset: 7, inheritedLength: 8 });
		await manager.quiesce();
		const recovered = await ForkSourceOwnershipManager.open(manager.paths.invocationDir, { ownerStatus, now: () => 10_000 });
		const outcome = await recovered.reconcile({ allowDeadOwnerSeal: true });
		assert.deepEqual(outcome.resolved.sort(), ["dead-process", "inline-grace", "interactive-absent", "no-launch"]);
		assert.equal(outcome.removed, true);
	});

	test("a live owner without a quiesced acknowledgement and mismatched acknowledgement bindings retain state", async () => {
		const { manager } = await fixture();
		const child = await manager.registerChild({ childId: "pending", surface: "inline" });
		await manager.seal();
		const liveRecovery = await ForkSourceOwnershipManager.open(manager.paths.invocationDir, { ownerStatus: () => "live" });
		const noAcknowledgement = await liveRecovery.reconcile({ allowDeadOwnerSeal: true });
		assert.ok(noAcknowledgement.retained.includes(child.childId));
		const sealDigest = "0".repeat(64);
		const wrongSeal = { contract: "pi-subagent.fork-source-ownership", version: 1, invocationId: manager.invocationId, owner: { pid: 10, startedAt: 20 }, sealDigest, quiescedAt: 100 };
		await fs.promises.writeFile(manager.paths.quiescedPath, `${JSON.stringify(wrongSeal)}\n`, { mode: 0o600 }); await fs.promises.chmod(manager.paths.quiescedPath, 0o600);
		const wrongSealRetained = await liveRecovery.reconcile({ allowDeadOwnerSeal: true });
		assert.ok(wrongSealRetained.retained.includes(child.childId));
		await fs.promises.unlink(manager.paths.quiescedPath);
		const wrongOwner = { ...wrongSeal, owner: { pid: 999, startedAt: 20 } };
		await fs.promises.writeFile(manager.paths.quiescedPath, `${JSON.stringify(wrongOwner)}\n`, { mode: 0o600 }); await fs.promises.chmod(manager.paths.quiescedPath, 0o600);
		const wrongOwnerRetained = await liveRecovery.reconcile({ allowDeadOwnerSeal: true });
		assert.ok(wrongOwnerRetained.retained.includes(child.childId));
		assert.equal(fs.existsSync(manager.paths.sourcePath), true);
	});

});
