import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getCurrentProcessStartedAt, prepareRunArtifactPaths } from "../../src/runtime/run-protocol";
import {
	MAX_REAPER_GRAPH_ENTRIES,
	acquireReaperRootLock,
	acquireRunCleanupClaim,
	enumerateRunDirectories,
	parseReaperRootLock,
	planUnifiedReaperGraph,
} from "../../src/runtime/reaper-coordinator";

const tempDirs: string[] = [];
afterEach(async () => {
	while (tempDirs.length) await fs.promises.rm(tempDirs.pop()!, { recursive: true, force: true });
});

async function stateRoot(): Promise<string> {
	const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-reaper-coordinator-"));
	tempDirs.push(root);
	await prepareRunArtifactPaths({ rootDir: root, runId: "initial" });
	return root;
}

describe("reaper coordinator", () => {
	test("uses a durable private no-replace root lock and retains existing authority", async () => {
		const root = await stateRoot();
		const first = await acquireReaperRootLock(root, "coordinator-one", 123);
		assert.ok(first);
		const stat = await fs.promises.stat(first.path);
		assert.equal(stat.mode & 0o777, 0o600);
		assert.equal(stat.dev, first.dev);
		assert.equal(stat.ino, first.ino);
		assert.deepEqual(parseReaperRootLock(JSON.parse(await fs.promises.readFile(first.path, "utf8"))), {
			version: 1, ownerIdentity: "coordinator-one", token: first.token, acquiredAt: 123,
		});
		assert.equal(await acquireReaperRootLock(root, "contender"), null);
		assert.equal(await first.assertCurrent(), true);
		assert.equal(await first.release("wrong-token"), false);
		assert.equal(await first.release(), true);
		assert.equal(await first.assertCurrent(), false);

		const [left, right] = await Promise.all([
			acquireReaperRootLock(root, "left"),
			acquireReaperRootLock(root, "right"),
		]);
		const winner = left ?? right;
		assert.ok(winner);
		assert.equal(Number(left !== null) + Number(right !== null), 1);
		assert.equal(await winner.release(), true);

		await fs.promises.writeFile(path.join(root, "reaper.lock"), "{malformed}\n", { mode: 0o600 });
		await fs.promises.chmod(path.join(root, "reaper.lock"), 0o600);
		assert.equal(await acquireReaperRootLock(root, "blocked-by-malformed"), null);
	});

	test("reclaims a stable valid root lock only after its production owner is dead", async () => {
		const root = await stateRoot();
		const lockPath = path.join(root, "reaper.lock");
		await fs.promises.writeFile(lockPath, `${JSON.stringify({
			version: 1, ownerIdentity: `${process.pid}:1`, token: "11111111-1111-4111-8111-111111111111", acquiredAt: 1,
		})}\n`, { mode: 0o600 });
		await fs.promises.chmod(lockPath, 0o600);
		const reclaimed = await acquireReaperRootLock(root, "reclaimer", Date.now());
		assert.ok(reclaimed);
		assert.equal(JSON.parse(await fs.promises.readFile(lockPath, "utf8")).ownerIdentity, "reclaimer");
		assert.equal(await reclaimed.release(), true);
	});

	test("retains a valid root lock while its production owner remains live", async () => {
		const root = await stateRoot();
		const startedAt = getCurrentProcessStartedAt();
		assert.notEqual(startedAt, null);
		const lockPath = path.join(root, "reaper.lock");
		await fs.promises.writeFile(lockPath, `${JSON.stringify({
			version: 1, ownerIdentity: `${process.pid}:${startedAt}`, token: "22222222-2222-4222-8222-222222222222", acquiredAt: 1,
		})}\n`, { mode: 0o600 });
		await fs.promises.chmod(lockPath, 0o600);
		assert.equal(await acquireReaperRootLock(root, "contender"), null);
		assert.equal(JSON.parse(await fs.promises.readFile(lockPath, "utf8")).ownerIdentity, `${process.pid}:${startedAt}`);
	});

	test("retains a fresh malformed root lock", async () => {
		const root = await stateRoot();
		const lockPath = path.join(root, "reaper.lock");
		const now = Date.now();
		await fs.promises.writeFile(lockPath, "{malformed}\n", { mode: 0o600 });
		await fs.promises.chmod(lockPath, 0o600);
		assert.equal(await acquireReaperRootLock(root, "contender", now), null);
		assert.equal(await fs.promises.readFile(lockPath, "utf8"), "{malformed}\n");
	});

	test("quarantines an aged stable malformed root lock instead of deleting it", async () => {
		const root = await stateRoot();
		const lockPath = path.join(root, "reaper.lock");
		const malformed = "{malformed}\n";
		const now = Date.now();
		await fs.promises.writeFile(lockPath, malformed, { mode: 0o600 });
		await fs.promises.chmod(lockPath, 0o600);
		await fs.promises.utimes(lockPath, new Date(now - 3_601_000), new Date(now - 3_601_000));
		const lock = await acquireReaperRootLock(root, "reclaimer", now);
		assert.ok(lock);
		const quarantines = (await fs.promises.readdir(root)).filter((name) => name.startsWith("reaper.lock.quarantine-"));
		assert.equal(quarantines.length, 1);
		assert.equal(await fs.promises.readFile(path.join(root, quarantines[0]), "utf8"), malformed);
		assert.equal(JSON.parse(await fs.promises.readFile(lockPath, "utf8")).ownerIdentity, "reclaimer");
		assert.equal(await lock.release(), true);
	});

	test("binds lock release to both token and inode", async () => {
		const root = await stateRoot();
		const lock = await acquireReaperRootLock(root, "inode-owner");
		assert.ok(lock);
		await fs.promises.unlink(lock.path);
		await fs.promises.writeFile(lock.path, "{malformed}\n", { mode: 0o600 });
		await fs.promises.chmod(lock.path, 0o600);
		assert.equal(await lock.assertCurrent(), false);
		assert.equal(await lock.release(), false);
		assert.equal(await fs.promises.readFile(lock.path, "utf8"), "{malformed}\n");
	});

	test("acquires one per-run cleanup claim under contention and binds acquired authority", async () => {
		const root = await stateRoot();
		const run = await prepareRunArtifactPaths({ rootDir: root, runId: "cleanup-contention" });
		const lock = await acquireReaperRootLock(root, "cleanup-coordinator");
		assert.ok(lock);
		const options = {
			runDir: run.runDir, runId: "cleanup-contention", rootLock: lock,
			expectedOwners: [{ pid: 41, startedAt: 101 }], now: 1234, isOwnerAlive: () => false,
		};
		const [left, right] = await Promise.all([acquireRunCleanupClaim(options), acquireRunCleanupClaim(options)]);
		const claim = left ?? right;
		assert.ok(claim);
		assert.equal(Number(left !== null) + Number(right !== null), 1);
		assert.equal(await claim.assertCurrent(), true);
		const record = JSON.parse(await fs.promises.readFile(claim.path, "utf8"));
		assert.equal(record.state, "acquired");
		assert.equal(record.rootLockToken, lock.token);
		assert.match(record.epoch, /^[0-9a-f-]{36}$/i);
		assert.match(record.token, /^[A-Za-z0-9_-]{43}$/);
		assert.deepEqual(record.expectedOwners, options.expectedOwners);
		assert.deepEqual(record.ownerProofs.map(({ pid, startedAt, proof }: any) => ({ pid, startedAt, proof })), [{ pid: 41, startedAt: 101, proof: "proven-dead" }]);
		assert.equal(await claim.release(), true);
		assert.equal(await lock.release(), true);
	});

	test("releases only its requested claim when an expected owner is live", async () => {
		const root = await stateRoot();
		const run = await prepareRunArtifactPaths({ rootDir: root, runId: "cleanup-live-owner" });
		const lock = await acquireReaperRootLock(root, "cleanup-coordinator");
		assert.ok(lock);
		assert.equal(await acquireRunCleanupClaim({
			runDir: run.runDir, runId: "cleanup-live-owner", rootLock: lock,
			expectedOwners: [{ pid: 42, startedAt: 102 }], now: 1235,
			isOwnerAlive: (pid, startedAt) => pid === 42 && startedAt === 102,
		}), null);
		const record = JSON.parse(await fs.promises.readFile(path.join(run.runDir, "reaper-claim.json"), "utf8"));
		assert.equal(record.state, "released");
		assert.equal(Object.hasOwn(record, "acquiredAt"), false);
		assert.equal(await lock.release(), true);
	});

	test("never records unknown owner identity as proven dead", async () => {
		const root = await stateRoot();
		const run = await prepareRunArtifactPaths({ rootDir: root, runId: "cleanup-unknown" });
		const lock = await acquireReaperRootLock(root, "cleanup-unknown-owner"); assert.ok(lock);
		const claim = await acquireRunCleanupClaim({ runDir: run.runDir, runId: "cleanup-unknown", rootLock: lock,
			expectedOwners: [{ pid: 41, startedAt: 101 }], classifyOwner: () => "unknown", now: 1234 });
		assert.equal(claim, null);
		assert.equal(JSON.parse(await fs.promises.readFile(path.join(run.runDir, "reaper-claim.json"), "utf8")).state, "released");
		await lock.release();
	});

	test("fails closed when an acquired cleanup claim is replaced or its token changes", async () => {
		const root = await stateRoot();
		const run = await prepareRunArtifactPaths({ rootDir: root, runId: "cleanup-replacement" });
		const lock = await acquireReaperRootLock(root, "cleanup-coordinator");
		assert.ok(lock);
		const claim = await acquireRunCleanupClaim({
			runDir: run.runDir, runId: "cleanup-replacement", rootLock: lock,
			expectedOwners: [{ pid: 43, startedAt: 103 }], now: 1236, isOwnerAlive: () => false,
		});
		assert.ok(claim);
		const original = JSON.parse(await fs.promises.readFile(claim.path, "utf8"));
		const originalStat = await fs.promises.stat(claim.path);
		const tokenMismatch = { ...original, token: "A".repeat(43) };
		await fs.promises.writeFile(claim.path, `${JSON.stringify(tokenMismatch)}\n`);
		const tokenMismatchStat = await fs.promises.stat(claim.path);
		assert.equal(tokenMismatchStat.dev, originalStat.dev);
		assert.equal(tokenMismatchStat.ino, originalStat.ino);
		assert.equal(await claim.assertCurrent(), false);
		assert.equal(await claim.release(), false);
		await fs.promises.rename(claim.path, `${claim.path}.old`);
		await fs.promises.writeFile(claim.path, `${JSON.stringify(original)}\n`, { mode: 0o600 });
		await fs.promises.chmod(claim.path, 0o600);
		assert.equal(await claim.assertCurrent(), false);
		assert.equal(await acquireRunCleanupClaim({
			runDir: run.runDir, runId: "cleanup-replacement", rootLock: lock,
			expectedOwners: [{ pid: 43, startedAt: 103 }], now: 1237, isOwnerAlive: () => false,
		}), null);
		assert.equal(await lock.release(), true);
	});

	test("records acquired then released cleanup claims without unlinking or reclaiming them", async () => {
		const root = await stateRoot();
		const run = await prepareRunArtifactPaths({ rootDir: root, runId: "cleanup-release" });
		const target = path.join(run.runDir, "cleanup-target");
		await fs.promises.writeFile(target, "untouched", { mode: 0o600 });
		await fs.promises.chmod(target, 0o600);
		const lock = await acquireReaperRootLock(root, "cleanup-coordinator");
		assert.ok(lock);
		const options = {
			runDir: run.runDir, runId: "cleanup-release", rootLock: lock,
			expectedOwners: [{ pid: 44, startedAt: 104 }], now: 1238, isOwnerAlive: () => false,
		};
		const claim = await acquireRunCleanupClaim(options);
		assert.ok(claim);
		assert.equal(await claim.release(), true);
		assert.equal(await claim.assertCurrent(), false);
		assert.equal(JSON.parse(await fs.promises.readFile(claim.path, "utf8")).state, "released");
		assert.equal(await fs.promises.readFile(target, "utf8"), "untouched");
		const retry = await acquireRunCleanupClaim(options);
		assert.ok(retry);
		assert.notEqual(retry.epoch, claim.epoch);
		assert.equal(await retry.release(), true);
		assert.equal(await lock.release(), true);
	});

	test("transfers the startup enumeration budget through one handle and closes it once", async () => {
		const originalOpendir = fs.promises.opendir;
		let closeCalls = 0;
		let cursor = 0;
		const entries = ["first", "second", "third"].map((name) => ({ name, isDirectory: () => true })) as unknown as fs.Dirent[];
		Object.defineProperty(fs.promises, "opendir", {
			configurable: true,
			writable: true,
			value: (async () => ({
				read: async () => entries[cursor++] ?? null,
				close: async () => { closeCalls += 1; },
			})) as unknown as typeof fs.promises.opendir,
		});
		try {
			const root = await stateRoot();
			const enumeration = enumerateRunDirectories(root, { startupEntryBudget: 1, startupBudgetMs: 100, now: () => 0 });
			assert.deepEqual(await enumeration.startup, ["first"]);
			assert.deepEqual(await enumeration.completion, ["second", "third"]);
			await enumeration.cancelAndDrain();
			assert.equal(closeCalls, 1);
		} finally {
			Object.defineProperty(fs.promises, "opendir", { configurable: true, writable: true, value: originalOpendir });
		}
	});

	test("plans only safe nodes descendants-first and retains malformed lineages", () => {
		const plan = planUnifiedReaperGraph([
			{ runId: "root" }, { runId: "child", parentRunId: "root" },
			{ runId: "duplicate" }, { runId: "duplicate" }, { runId: "duplicate-child", parentRunId: "duplicate" },
			{ runId: "missing-parent", parentRunId: "absent" },
			{ runId: "cycle-a", parentRunId: "cycle-b" }, { runId: "cycle-b", parentRunId: "cycle-a" }, { runId: "cycle-child", parentRunId: "cycle-a" },
		]);
		assert.deepEqual(plan.descendantsFirst, ["child", "root"]);
		assert.deepEqual(plan.unresolved, new Set(["duplicate", "duplicate-child", "missing-parent", "cycle-a", "cycle-b", "cycle-child"]));
	});

	test("fails closed before planning a 100001-entry graph", () => {
		const plan = planUnifiedReaperGraph(Array.from({ length: MAX_REAPER_GRAPH_ENTRIES + 1 }, (_, index) => ({ runId: `overflow-${index}` })));
		assert.equal(plan.overflow, true);
		assert.equal(plan.descendantsFirst.length, 0);
		assert.equal(plan.unresolved.size, 0);
	});

	test("handles a 100k-node graph in linear descendants-first order", () => {
		const nodes = Array.from({ length: 100_000 }, (_, index) => ({
			runId: `run-${index}`,
			...(index === 0 ? {} : { parentRunId: `run-${index - 1}` }),
		}));
		const plan = planUnifiedReaperGraph(nodes);
		assert.equal(plan.unresolved.size, 0);
		assert.equal(plan.descendantsFirst.length, nodes.length);
		assert.equal(plan.descendantsFirst[0], "run-99999");
		assert.equal(plan.descendantsFirst.at(-1), "run-0");
	});
});
