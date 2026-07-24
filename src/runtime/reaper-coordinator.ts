import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertSafeRunArtifactPaths, assertSafeStateRoot, classifyParentProcessIdentity, type ProcessIdentityStatus } from "./run-protocol.js";

export const REAPER_ROOT_LOCK_NAME = "reaper.lock";
export const REAPER_ROOT_LOCK_VERSION = 1 as const;
export const REAPER_CLEANUP_CLAIM_NAME = "reaper-claim.json";
export const REAPER_CLEANUP_CLAIM_VERSION = 1 as const;
const MAX_REAPER_ROOT_LOCK_BYTES = 16 * 1024;
const MAX_REAPER_ROOT_LOCK_MALFORMED_AGE_MS = 60 * 60 * 1000;
const MAX_REAPER_CLEANUP_CLAIM_BYTES = 16 * 1024;
const MAX_REAPER_CLEANUP_OWNERS = 64;
/** Whole-root graph planning must remain bounded even for hostile state roots. */
export const MAX_REAPER_GRAPH_ENTRIES = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_256_BIT_BASE64URL = /^[A-Za-z0-9_-]{43}$/;

export interface ReaperRootLockRecord {
	version: typeof REAPER_ROOT_LOCK_VERSION;
	ownerIdentity: string;
	token: string;
	acquiredAt: number;
}

export interface ReaperRootLock {
	path: string;
	token: string;
	dev: number;
	ino: number;
	/** Returns false if the token or the original pathname identity no longer matches. */
	assertCurrent(): Promise<boolean>;
	release(releaseToken?: string): Promise<boolean>;
}

export interface ReaperCleanupOwner {
	pid: number;
	startedAt: number;
}

type ReaperCleanupClaimState = "requested" | "acquired" | "released";

interface ReaperCleanupClaimRecord {
	version: typeof REAPER_CLEANUP_CLAIM_VERSION;
	state: ReaperCleanupClaimState;
	runId: string;
	epoch: string;
	token: string;
	rootLockToken: string;
	expectedOwners: ReaperCleanupOwner[];
	requestedAt: number;
	acquiredAt?: number;
	ownerProofs?: Array<ReaperCleanupOwner & { proof: "proven-dead"; checkedAt: number }>;
	releasedAt?: number;
}

export interface ReaperCleanupClaim {
	path: string;
	epoch: string;
	token: string;
	dev: number;
	ino: number;
	/** Returns false if the root lock or acquired claim authority was replaced. */
	assertCurrent(): Promise<boolean>;
	/** Atomically records release without unlinking the claim or mutating a cleanup target. */
	release(): Promise<boolean>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPrivateRegularFile(stat: fs.Stats): boolean {
	return stat.isFile() && !stat.isSymbolicLink()
		&& (typeof process.getuid !== "function" || stat.uid === process.getuid())
		&& (process.platform === "win32" || (stat.mode & 0o777) === 0o600);
}

function sameIdentity(stat: fs.Stats, dev: number, ino: number): boolean {
	return stat.dev === dev && stat.ino === ino;
}

function digest(bytes: Buffer): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

function isSafeRunId(runId: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId);
}

function isCleanupOwner(value: unknown): value is ReaperCleanupOwner {
	return isRecord(value) && Object.keys(value).length === 2 && Object.hasOwn(value, "pid") && Object.hasOwn(value, "startedAt")
		&& typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0
		&& typeof value.startedAt === "number" && Number.isFinite(value.startedAt) && value.startedAt > 0;
}

function sameOwners(left: readonly ReaperCleanupOwner[], right: readonly ReaperCleanupOwner[]): boolean {
	return left.length === right.length && left.every((owner, index) => owner.pid === right[index]?.pid && owner.startedAt === right[index]?.startedAt);
}

function validCleanupOwners(value: unknown): value is ReaperCleanupOwner[] {
	return Array.isArray(value) && value.length > 0 && value.length <= MAX_REAPER_CLEANUP_OWNERS
		&& value.every(isCleanupOwner) && new Set(value.map((owner) => `${owner.pid}:${owner.startedAt}`)).size === value.length;
}

function isCleanupClaimRecord(value: unknown): value is ReaperCleanupClaimRecord {
	if (!isRecord(value) || !Object.hasOwn(value, "state")) return false;
	const common = ["version", "state", "runId", "epoch", "token", "rootLockToken", "expectedOwners", "requestedAt"];
	const keys = value.state === "requested" ? common
		: value.state === "acquired" ? [...common, "acquiredAt", "ownerProofs"]
			: value.state === "released" && Object.hasOwn(value, "acquiredAt") ? [...common, "acquiredAt", "ownerProofs", "releasedAt"]
				: value.state === "released" ? [...common, "releasedAt"] : [];
	return keys.length > 0 && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
		&& value.version === REAPER_CLEANUP_CLAIM_VERSION && isSafeRunId(value.runId as string)
		&& typeof value.epoch === "string" && UUID.test(value.epoch)
		&& typeof value.token === "string" && TOKEN_256_BIT_BASE64URL.test(value.token)
		&& typeof value.rootLockToken === "string" && UUID.test(value.rootLockToken)
		&& validCleanupOwners(value.expectedOwners)
		&& typeof value.requestedAt === "number" && Number.isFinite(value.requestedAt)
		&& (value.state !== "acquired" || (typeof value.acquiredAt === "number" && Number.isFinite(value.acquiredAt)
			&& Array.isArray(value.ownerProofs) && value.ownerProofs.length === (value.expectedOwners as ReaperCleanupOwner[]).length
			&& value.ownerProofs.every((proof, index) => isRecord(proof) && Object.keys(proof).length === 4 && proof.proof === "proven-dead"
				&& isCleanupOwner({ pid: proof.pid, startedAt: proof.startedAt }) && typeof proof.checkedAt === "number" && Number.isFinite(proof.checkedAt)
				&& proof.pid === (value.expectedOwners as ReaperCleanupOwner[])[index]?.pid && proof.startedAt === (value.expectedOwners as ReaperCleanupOwner[])[index]?.startedAt)))
		&& (value.state !== "released" || (value.acquiredAt === undefined || (typeof value.acquiredAt === "number" && Number.isFinite(value.acquiredAt)
			&& Array.isArray(value.ownerProofs) && value.ownerProofs.length === (value.expectedOwners as ReaperCleanupOwner[]).length))
			&& typeof value.releasedAt === "number" && Number.isFinite(value.releasedAt));
}

/** Strictly parse the durable reaper-root lock authority record. */
export function parseReaperRootLock(value: unknown): ReaperRootLockRecord | null {
	if (!isRecord(value) || Object.keys(value).length !== 4
		|| !Object.hasOwn(value, "version") || !Object.hasOwn(value, "ownerIdentity")
		|| !Object.hasOwn(value, "token") || !Object.hasOwn(value, "acquiredAt")) return null;
	if (value.version !== REAPER_ROOT_LOCK_VERSION
		|| typeof value.ownerIdentity !== "string" || value.ownerIdentity.length < 1 || value.ownerIdentity.length > 512
		|| /[\r\n\u0000]/.test(value.ownerIdentity)
		|| typeof value.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.token)
		|| typeof value.acquiredAt !== "number" || !Number.isFinite(value.acquiredAt)) return null;
	return value as unknown as ReaperRootLockRecord;
}

async function fsyncDirectory(directory: string): Promise<void> {
	await fs.promises.open(directory, "r").then(async (handle) => {
		try { await handle.sync(); } finally { await handle.close(); }
	}).catch(() => undefined);
}

interface ReaperRootLockSnapshot {
	record: ReaperRootLockRecord | null;
	dev: number;
	ino: number;
	digest: string;
	mtimeMs: number;
}

/** Read one private lock inode and bind its bytes to the current pathname. */
async function readReaperRootLockSnapshot(lockPath: string): Promise<ReaperRootLockSnapshot | null> {
	if (!fs.constants.O_NOFOLLOW) return null;
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(lockPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!isPrivateRegularFile(before) || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > MAX_REAPER_ROOT_LOCK_BYTES) return null;
		const bytes = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead <= 0) return null;
			offset += bytesRead;
		}
		const [after, pathname] = await Promise.all([handle.stat(), fs.promises.lstat(lockPath)]);
		if (!sameIdentity(before, after.dev, after.ino) || !isPrivateRegularFile(pathname) || !sameIdentity(before, pathname.dev, pathname.ino)) return null;
		let record: ReaperRootLockRecord | null = null;
		try { record = parseReaperRootLock(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch { /* malformed locks are handled conservatively by the caller */ }
		return { record, dev: before.dev, ino: before.ino, digest: digest(bytes), mtimeMs: before.mtimeMs };
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

async function readLockAtIdentity(lockPath: string, dev: number, ino: number): Promise<ReaperRootLockRecord | null> {
	const snapshot = await readReaperRootLockSnapshot(lockPath);
	return snapshot && snapshot.dev === dev && snapshot.ino === ino ? snapshot.record : null;
}

function sameReaperRootLockSnapshot(left: ReaperRootLockSnapshot, right: ReaperRootLockSnapshot): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.digest === right.digest;
}

function parseProductionReaperOwnerIdentity(value: string): ReaperCleanupOwner | null {
	const match = /^([1-9][0-9]*):([1-9][0-9]*)$/.exec(value);
	if (!match) return null;
	const pid = Number(match[1]);
	const startedAt = Number(match[2]);
	return Number.isSafeInteger(pid) && Number.isSafeInteger(startedAt) ? { pid, startedAt } : null;
}

/** Let a concurrent writer settle before comparing descriptor/path-bound snapshots. */
async function yieldBeforeReaperRootLockRecheck(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function stableReaperRootLockSnapshot(lockPath: string, initial: ReaperRootLockSnapshot): Promise<ReaperRootLockSnapshot | null> {
	await yieldBeforeReaperRootLockRecheck();
	const rechecked = await readReaperRootLockSnapshot(lockPath);
	return rechecked !== null && sameReaperRootLockSnapshot(initial, rechecked) ? rechecked : null;
}

/** Unlink only the exact pathname inode that was stabilized above. */
async function unlinkReaperRootLockExact(lockPath: string, snapshot: ReaperRootLockSnapshot): Promise<boolean> {
	const pathname = await fs.promises.lstat(lockPath).catch(() => null);
	if (!pathname || !isPrivateRegularFile(pathname) || !sameIdentity(pathname, snapshot.dev, snapshot.ino)) return false;
	try {
		await fs.promises.unlink(lockPath);
		await fsyncDirectory(path.dirname(lockPath));
		return true;
	} catch {
		return false;
	}
}

/**
 * Node has no no-replace rename primitive. A same-directory hard-link followed
 * by exact-inode unlink has equivalent no-replace move semantics for a regular
 * lock file; any race leaves the source pathname intact.
 */
async function quarantineReaperRootLockExact(lockPath: string, snapshot: ReaperRootLockSnapshot): Promise<boolean> {
	const directory = path.dirname(lockPath);
	const quarantinePath = path.join(directory, `${REAPER_ROOT_LOCK_NAME}.quarantine-${crypto.randomUUID()}`);
	const before = await fs.promises.lstat(lockPath).catch(() => null);
	if (!before || !isPrivateRegularFile(before) || !sameIdentity(before, snapshot.dev, snapshot.ino)) return false;
	try {
		await fs.promises.link(lockPath, quarantinePath);
	} catch {
		return false;
	}
	const [source, quarantined] = await Promise.all([
		fs.promises.lstat(lockPath).catch(() => null),
		fs.promises.lstat(quarantinePath).catch(() => null),
	]);
	if (!source || !quarantined || !isPrivateRegularFile(source) || !isPrivateRegularFile(quarantined)
		|| !sameIdentity(source, snapshot.dev, snapshot.ino) || !sameIdentity(quarantined, snapshot.dev, snapshot.ino)) return false;
	return await unlinkReaperRootLockExact(lockPath, snapshot);
}

/**
 * Acquire the root-wide reaper mutex. Only dead production PID/start owners and
 * aged, stable malformed records may be reclaimed; all other existing locks block.
 */
export async function acquireReaperRootLock(rootDir: string, ownerIdentity: string, now = Date.now()): Promise<ReaperRootLock | null> {
	if (typeof ownerIdentity !== "string" || ownerIdentity.length < 1 || ownerIdentity.length > 512 || /[\r\n\u0000]/.test(ownerIdentity)) {
		throw new Error("Invalid reaper lock owner identity.");
	}
	if (!Number.isFinite(now)) throw new Error("Invalid reaper lock acquisition time.");
	await assertSafeStateRoot(rootDir);
	const safeRoot = path.resolve(rootDir);
	const lockPath = path.resolve(safeRoot, REAPER_ROOT_LOCK_NAME);
	if (path.dirname(lockPath) !== safeRoot) throw new Error("Reaper lock escaped its state root.");
	if (!fs.constants.O_NOFOLLOW) throw new Error("No-follow lock acquisition is unavailable on this platform.");

	const record: ReaperRootLockRecord = {
		version: REAPER_ROOT_LOCK_VERSION,
		ownerIdentity,
		token: crypto.randomUUID(),
		acquiredAt: now,
	};
	const openNewLock = async (): Promise<fs.promises.FileHandle | null> => {
		try {
			return await fs.promises.open(lockPath,
				fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
				0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
			throw error;
		}
	};
	let handle = await openNewLock();
	if (!handle) {
		const existing = await readReaperRootLockSnapshot(lockPath);
		if (!existing) return null;
		if (existing.record) {
			const owner = parseProductionReaperOwnerIdentity(existing.record.ownerIdentity);
			// Legacy/test owner strings are deliberately not liveness authority.
			if (!owner) return null;
			let ownerStatus: ProcessIdentityStatus = "unknown";
			try { ownerStatus = classifyParentProcessIdentity(owner.pid, owner.startedAt); } catch { /* fail closed */ }
			if (ownerStatus !== "dead") return null;
			const stable = await stableReaperRootLockSnapshot(lockPath, existing);
			if (!stable || !await unlinkReaperRootLockExact(lockPath, stable)) return null;
		} else {
			if (now - existing.mtimeMs < MAX_REAPER_ROOT_LOCK_MALFORMED_AGE_MS) return null;
			const stable = await stableReaperRootLockSnapshot(lockPath, existing);
			if (!stable || now - stable.mtimeMs < MAX_REAPER_ROOT_LOCK_MALFORMED_AGE_MS
				|| !await quarantineReaperRootLockExact(lockPath, stable)) return null;
		}
		// Reclaim grants exactly one fresh no-replace acquisition attempt.
		handle = await openNewLock();
		if (!handle) return null;
	}

	let identity: { dev: number; ino: number };
	try {
		await handle.chmod(0o600);
		await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
		await handle.sync();
		const stat = await handle.stat();
		if (!isPrivateRegularFile(stat)) throw new Error("Reaper lock is not a private regular file.");
		const pathname = await fs.promises.lstat(lockPath);
		if (!isPrivateRegularFile(pathname) || !sameIdentity(pathname, stat.dev, stat.ino)) {
			throw new Error("Reaper lock was replaced during acquisition.");
		}
		identity = { dev: stat.dev, ino: stat.ino };
	} finally {
		await handle.close();
	}
	await fsyncDirectory(safeRoot);

	let released = false;
	const assertCurrent = async (): Promise<boolean> => {
		if (released) return false;
		try { await assertSafeStateRoot(safeRoot); } catch { return false; }
		const current = await readLockAtIdentity(lockPath, identity.dev, identity.ino);
		return current?.token === record.token;
	};
	return {
		path: lockPath,
		token: record.token,
		dev: identity.dev,
		ino: identity.ino,
		assertCurrent,
		async release(releaseToken = record.token): Promise<boolean> {
			if (releaseToken !== record.token || !await assertCurrent()) return false;
			// Revalidate immediately before unlinking; a replacement is retained.
			const pathname = await fs.promises.lstat(lockPath).catch(() => null);
			if (!pathname || !isPrivateRegularFile(pathname) || !sameIdentity(pathname, identity.dev, identity.ino)) return false;
			try {
				await fs.promises.unlink(lockPath);
			} catch {
				return false;
			}
			await fsyncDirectory(safeRoot);
			released = true;
			return true;
		},
	};
}

/** A claim snapshot is bound to bytes read from one no-follow descriptor and its pathname identity. */
interface CleanupClaimSnapshot {
	record: ReaperCleanupClaimRecord;
	dev: number;
	ino: number;
	digest: string;
}

async function readCleanupClaimSnapshot(claimPath: string): Promise<CleanupClaimSnapshot | null> {
	if (!fs.constants.O_NOFOLLOW) return null;
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(claimPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const before = await handle.stat();
		if (!isPrivateRegularFile(before) || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > MAX_REAPER_CLEANUP_CLAIM_BYTES) return null;
		const bytes = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead <= 0) return null;
			offset += bytesRead;
		}
		const [after, pathname] = await Promise.all([handle.stat(), fs.promises.lstat(claimPath)]);
		if (!isPrivateRegularFile(after) || !isPrivateRegularFile(pathname) || !sameIdentity(before, after.dev, after.ino)
			|| !sameIdentity(before, pathname.dev, pathname.ino)) return null;
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) return null;
		const record: unknown = JSON.parse(text.slice(0, -1));
		return isCleanupClaimRecord(record) ? { record, dev: before.dev, ino: before.ino, digest: digest(bytes) } : null;
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function sameCleanupSnapshot(left: CleanupClaimSnapshot, right: CleanupClaimSnapshot): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.digest === right.digest;
}

async function writeNoReplaceClaim(filePath: string, record: ReaperCleanupClaimRecord): Promise<CleanupClaimSnapshot | null> {
	const content = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
	if (content.length > MAX_REAPER_CLEANUP_CLAIM_BYTES || !fs.constants.O_NOFOLLOW) return null;
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
		await handle.chmod(0o600);
		await handle.writeFile(content);
		await handle.sync();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
	return readCleanupClaimSnapshot(filePath);
}

/**
 * Replace only the exact claim bytes previously read through a no-follow descriptor.
 * POSIX rename makes the new record atomic; any failed precondition leaves both the
 * retained authority and its request untouched. Temporary records are deliberately
 * retained on a failed CAS: this helper never unlinks files or cleanup targets.
 */
async function replaceCleanupClaimExact(options: {
	claimPath: string;
	runDir: string;
	expected: CleanupClaimSnapshot;
	next: ReaperCleanupClaimRecord;
}): Promise<CleanupClaimSnapshot | null> {
	const current = await readCleanupClaimSnapshot(options.claimPath);
	if (!current || !sameCleanupSnapshot(current, options.expected)) return null;
	const temporaryPath = path.join(options.runDir, `.${REAPER_CLEANUP_CLAIM_NAME}.${options.next.epoch}.${options.next.state}.tmp`);
	const temporary = await writeNoReplaceClaim(temporaryPath, options.next);
	if (!temporary) return null;
	try { await assertSafeRunArtifactPaths({ rootDir: path.dirname(options.runDir), runDir: options.runDir }); } catch { return null; }
	const beforeRename = await readCleanupClaimSnapshot(options.claimPath);
	if (!beforeRename || !sameCleanupSnapshot(beforeRename, options.expected)) return null;
	try {
		await fs.promises.rename(temporaryPath, options.claimPath);
		await fsyncDirectory(options.runDir);
	} catch {
		return null;
	}
	const replaced = await readCleanupClaimSnapshot(options.claimPath);
	return replaced?.record.state === options.next.state && replaced.record.epoch === options.next.epoch
		&& replaced.record.token === options.next.token && replaced.digest === temporary.digest ? replaced : null;
}

/**
 * Acquire a run-local cleanup capability only after every immutable owner PID/start
 * identity is dead. Existing, malformed, requested, acquired, and crash-retained
 * claims block rather than being reclaimed. This records authority only; it never
 * unlinks a claim or mutates a cleanup target.
 */
export async function acquireRunCleanupClaim(options: {
	runDir: string;
	runId: string;
	rootLock: ReaperRootLock;
	expectedOwners: readonly ReaperCleanupOwner[];
	now?: number;
	isOwnerAlive?: (pid: number, startedAt: number) => boolean;
	classifyOwner?: (pid: number, startedAt: number) => ProcessIdentityStatus;
}): Promise<ReaperCleanupClaim | null> {
	const now = options.now ?? Date.now();
	if (!Number.isFinite(now) || !isSafeRunId(options.runId) || !validCleanupOwners(options.expectedOwners)
		|| (typeof options.classifyOwner !== "function" && typeof options.isOwnerAlive !== "function")) throw new Error("Invalid reaper cleanup claim options.");
	if (!options.rootLock || typeof options.rootLock.assertCurrent !== "function" || typeof options.rootLock.token !== "string" || !UUID.test(options.rootLock.token)) return null;
	const rootLockIsCurrent = async (): Promise<boolean> => {
		try { return await options.rootLock.assertCurrent(); } catch { return false; }
	};
	const runDir = path.resolve(options.runDir);
	const rootDir = path.dirname(runDir);
	if (path.basename(runDir) !== options.runId || !await rootLockIsCurrent()) return null;
	try { await assertSafeRunArtifactPaths({ rootDir, runDir }); } catch { return null; }
	const claimPath = path.join(runDir, REAPER_CLEANUP_CLAIM_NAME);
	if (path.dirname(claimPath) !== runDir || !fs.constants.O_NOFOLLOW) return null;

	const requested: ReaperCleanupClaimRecord = {
		version: REAPER_CLEANUP_CLAIM_VERSION,
		state: "requested",
		runId: options.runId,
		epoch: crypto.randomUUID(),
		token: crypto.randomBytes(32).toString("base64url"),
		rootLockToken: options.rootLock.token,
		expectedOwners: options.expectedOwners.map((owner) => ({ pid: owner.pid, startedAt: owner.startedAt })),
		requestedAt: now,
	};
	let request = await writeNoReplaceClaim(claimPath, requested);
	if (!request) {
		const previous = await readCleanupClaimSnapshot(claimPath);
		if (previous?.record.state !== "released" || !await rootLockIsCurrent()) return null;
		request = await replaceCleanupClaimExact({ claimPath, runDir, expected: previous, next: requested });
	}
	if (!request || request.record.state !== "requested" || !sameOwners(request.record.expectedOwners, requested.expectedOwners)
		|| request.record.epoch !== requested.epoch || request.record.token !== requested.token || request.record.rootLockToken !== options.rootLock.token) return null;

	const ownerStatus = (owner: ReaperCleanupOwner): ProcessIdentityStatus => {
		try {
			if (options.classifyOwner) return options.classifyOwner(owner.pid, owner.startedAt);
			return options.isOwnerAlive!(owner.pid, owner.startedAt) ? "live" : "dead";
		} catch { return "unknown"; }
	};
	const allOwnersProvenDead = (): boolean => requested.expectedOwners.every((owner) => ownerStatus(owner) === "dead");
	const releaseRequestedForLiveOwner = async (): Promise<void> => {
		const released: ReaperCleanupClaimRecord = { ...requested, state: "released", releasedAt: now };
		await replaceCleanupClaimExact({ claimPath, runDir, expected: request, next: released });
	};
	if (!await rootLockIsCurrent()) return null;
	if (!allOwnersProvenDead()) {
		await releaseRequestedForLiveOwner();
		return null;
	}
	// Check again immediately before the state transition: a live or unknown
	// identity is never safe cleanup authority.
	if (!await rootLockIsCurrent()) return null;
	if (!allOwnersProvenDead()) {
		await releaseRequestedForLiveOwner();
		return null;
	}

	const acquired: ReaperCleanupClaimRecord = { ...requested, state: "acquired", acquiredAt: now,
		ownerProofs: requested.expectedOwners.map((owner) => ({ ...owner, proof: "proven-dead" as const, checkedAt: Date.now() })) };
	const claim = await replaceCleanupClaimExact({ claimPath, runDir, expected: request, next: acquired });
	if (!claim || !await rootLockIsCurrent()) return null;
	let released = false;
	const assertCurrent = async (): Promise<boolean> => {
		if (released || !await rootLockIsCurrent()) return false;
		const current = await readCleanupClaimSnapshot(claimPath);
		return Boolean(current && sameCleanupSnapshot(current, claim) && current.record.state === "acquired"
			&& current.record.runId === options.runId && current.record.epoch === acquired.epoch && current.record.token === acquired.token
			&& current.record.rootLockToken === options.rootLock.token && sameOwners(current.record.expectedOwners, requested.expectedOwners));
	};
	return {
		path: claimPath,
		epoch: acquired.epoch,
		token: acquired.token,
		dev: claim.dev,
		ino: claim.ino,
		assertCurrent,
		async release(): Promise<boolean> {
			if (!await assertCurrent()) return false;
			const releasedRecord: ReaperCleanupClaimRecord = { ...acquired, state: "released", releasedAt: now };
			const result = await replaceCleanupClaimExact({ claimPath, runDir, expected: claim, next: releasedRecord });
			if (!result) return false;
			released = true;
			return true;
		},
	};
}

export interface RunDirectoryEnumerationOptions {
	startupBudgetMs?: number;
	startupEntryBudget?: number;
	/** A monotonic clock, used only to transfer the startup time budget. */
	now?: () => number;
}

export interface RunDirectoryEnumeration {
	/** Directory names read before either startup budget is exhausted. */
	startup: Promise<string[]>;
	/** The remaining directory names, read from the same open directory handle. */
	completion: Promise<string[]>;
	/** True when one additional directory proved the root exceeds the hard cap. */
	overflow: Promise<boolean>;
	/** Stop further reads and wait for the sole owner to close its handle. */
	cancelAndDrain(): Promise<void>;
}

function boundedBudget(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) throw new Error("Enumeration budget must be a non-negative finite number.");
	return Math.floor(value);
}

/**
 * Read a state root through one directory handle. Startup performs no callback
 * or mutation: it only transfers a bounded prefix to the caller, then the same
 * owner continues from precisely that cursor for completion.
 */
export function enumerateRunDirectories(rootDir: string, options: RunDirectoryEnumerationOptions = {}): RunDirectoryEnumeration {
	const startupBudgetMs = boundedBudget(options.startupBudgetMs, 200);
	const startupEntryBudget = boundedBudget(options.startupEntryBudget, 50);
	const now = options.now ?? performance.now.bind(performance);
	const startedAt = now();
	let resolveStartup!: (names: string[]) => void;
	let rejectStartup!: (error: unknown) => void;
	let resolveCompletion!: (names: string[]) => void;
	let rejectCompletion!: (error: unknown) => void;
	let resolveOverflow!: (overflow: boolean) => void;
	let rejectOverflow!: (error: unknown) => void;
	const startup = new Promise<string[]>((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
	const completion = new Promise<string[]>((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
	const overflow = new Promise<boolean>((resolve, reject) => { resolveOverflow = resolve; rejectOverflow = reject; });
	let cancelled = false;
	let settled = false;

	const worker = (async () => {
		let directory: fs.Dir | undefined;
		let startupSettled = false;
		try {
			await assertSafeStateRoot(rootDir);
			directory = await fs.promises.opendir(rootDir);
			const initial: string[] = [];
			const remaining: string[] = [];
			const deadline = startedAt + startupBudgetMs;
			let startupEntriesRead = 0;
			let directoriesRead = 0;
			let exceeded = false;
			let inStartup = true;
			while (!cancelled) {
				if (inStartup && (startupEntriesRead >= startupEntryBudget || now() >= deadline)) {
					inStartup = false;
					startupSettled = true;
					resolveStartup(initial);
				}
				const entry = await directory.read();
				if (entry === null) break;
				if (entry.isDirectory()) {
					// Read one extra directory but never retain it: this proves that a
					// complete graph cannot fit without allocating an unbounded root.
					if (++directoriesRead > MAX_REAPER_GRAPH_ENTRIES) { exceeded = true; break; }
					(inStartup ? initial : remaining).push(entry.name);
				}
				if (inStartup) startupEntriesRead += 1;
			}
			if (!startupSettled) {
				startupSettled = true;
				resolveStartup(initial);
			}
			resolveCompletion(remaining);
			resolveOverflow(exceeded);
		} catch (error) {
			if (!startupSettled) rejectStartup(error);
			rejectCompletion(error);
			rejectOverflow(error);
		} finally {
			// This worker is the exclusive owner, so close is invoked exactly once.
			if (directory) await Promise.resolve(directory.close()).catch(() => undefined);
			settled = true;
		}
	})();
	// The worker itself handles its errors by rejecting the public promises.
	void worker;
	return {
		startup,
		completion,
		overflow,
		async cancelAndDrain(): Promise<void> {
			cancelled = true;
			await worker;
			if (!settled) throw new Error("Directory enumeration did not settle.");
		},
	};
}

export interface ReaperGraphNode {
	runId: string;
	parentRunId?: string;
}

export interface UnifiedReaperGraphPlan {
	/** Safe run IDs in descendants-first order. */
	descendantsFirst: string[];
	/** IDs whose lineage is ambiguous, missing, cyclic, or descends from one. */
	unresolved: Set<string>;
	/** The caller supplied more entries than can be planned safely. */
	overflow: boolean;
}

/** Build a linear-time, fail-closed cleanup order for one-parent run graphs. */
export function planUnifiedReaperGraph(nodes: readonly ReaperGraphNode[]): UnifiedReaperGraphPlan {
	// Do not even copy an oversized input: callers must defer every mutation
	// until a later scan can construct the complete graph within this cap.
	if (nodes.length > MAX_REAPER_GRAPH_ENTRIES) return { descendantsFirst: [], unresolved: new Set(), overflow: true };
	const byId = new Map<string, ReaperGraphNode>();
	const duplicates = new Set<string>();
	for (const node of nodes) {
		if (typeof node?.runId !== "string" || node.runId.length === 0) continue;
		if (byId.has(node.runId)) duplicates.add(node.runId);
		else byId.set(node.runId, node);
	}
	const unresolved = new Set<string>(duplicates);
	const children = new Map<string, string[]>();
	for (const runId of byId.keys()) children.set(runId, []);
	for (const [runId, node] of byId) {
		if (duplicates.has(runId)) continue;
		if (node.parentRunId === undefined) continue;
		if (typeof node.parentRunId !== "string" || !byId.has(node.parentRunId) || duplicates.has(node.parentRunId)) {
			unresolved.add(runId);
			continue;
		}
		children.get(node.parentRunId)!.push(runId);
	}
	// Any node below an ambiguous or missing parent is equally unsafe to order.
	const unsafeQueue = [...unresolved];
	for (let index = 0; index < unsafeQueue.length; index += 1) {
		for (const child of children.get(unsafeQueue[index]) ?? []) {
			if (!unresolved.has(child)) { unresolved.add(child); unsafeQueue.push(child); }
		}
	}

	const childCount = new Map<string, number>();
	for (const runId of byId.keys()) if (!unresolved.has(runId)) childCount.set(runId, 0);
	for (const [runId, node] of byId) {
		if (unresolved.has(runId) || node.parentRunId === undefined || unresolved.has(node.parentRunId)) continue;
		childCount.set(node.parentRunId, (childCount.get(node.parentRunId) ?? 0) + 1);
	}
	const leaves: string[] = [];
	for (const [runId, count] of childCount) if (count === 0) leaves.push(runId);
	const descendantsFirst: string[] = [];
	for (let index = 0; index < leaves.length; index += 1) {
		const runId = leaves[index];
		descendantsFirst.push(runId);
		const parent = byId.get(runId)!.parentRunId;
		if (parent !== undefined && childCount.has(parent)) {
			const count = childCount.get(parent)! - 1;
			childCount.set(parent, count);
			if (count === 0) leaves.push(parent);
		}
	}
	// Remaining candidates form cycles. Retain the cycle and every node beneath
	// it rather than emitting a partial graph with an unsafe ancestor.
	const cyclicQueue: string[] = [];
	for (const [runId, count] of childCount) {
		if (count > 0 && !unresolved.has(runId)) { unresolved.add(runId); cyclicQueue.push(runId); }
	}
	for (let index = 0; index < cyclicQueue.length; index += 1) {
		for (const child of children.get(cyclicQueue[index]) ?? []) {
			if (!unresolved.has(child)) { unresolved.add(child); cyclicQueue.push(child); }
		}
	}
	return { descendantsFirst: descendantsFirst.filter((runId) => !unresolved.has(runId)), unresolved, overflow: false };
}
