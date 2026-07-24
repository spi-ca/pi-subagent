import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertSafeStateRoot, ensureRunStateRoot, getCurrentProcessStartedAt, getRunStateRoot } from "./run-protocol.js";

const CONTRACT = "pi-subagent.fork-source-ownership" as const;
const VERSION = 1 as const;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_SESSION_BYTES = MAX_SOURCE_BYTES + 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRIVATE_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_RECONCILE_INVOCATIONS = 10_000;
const INLINE_NO_LAUNCH_GRACE_MS = 5_000;

/** Reserved state-root entry; it is never an interactive run directory. */
export const FORK_SOURCE_ROOT_NAME = ".fork-sources";

export type ForkSurface = "inline" | "interactive";
export type ForkTerminalReason = "no-launch" | "process-exited-before-ack" | "launch-failed";
export type OwnerStatus = "live" | "dead" | "unknown";

export interface ForkSourceManifestV1 {
	contract: typeof CONTRACT;
	version: typeof VERSION;
	invocationId: string;
	source: { algorithm: "sha256"; digest: string; byteLength: number; dev: number; ino: number };
	owner: { pid: number; startedAt: number };
	createdAt: number;
}
export interface ForkBootstrapV1 {
	invocationId: string;
	childId: string;
	surface: ForkSurface;
	runId: string | null;
	source: { path: string; digest: string; byteLength: number };
	session: { path: string; inheritedOffset: number; inheritedLength: number; inheritedDigest: string; dev: number; ino: number };
	createdAt: number;
}
export interface ForkBootstrapAckV1 {
	invocationId: string;
	childId: string;
	bootstrapDigest: string;
	source: { dev: number; ino: number };
	session: { dev: number; ino: number };
	child: { pid: number; startedAt: number };
	ackedAt: number;
}
export interface ForkProcessV1 {
	invocationId: string;
	childId: string;
	pid: number;
	startedAt: number;
	recordedAt: number;
}
/** Immutable registration survives a parent restart and binds bootstrap surface/run identity. */
export interface ForkRegistrationV1 {
	invocationId: string;
	childId: string;
	surface: ForkSurface;
	runId: string | null;
	registeredAt: number;
}
export interface ForkTerminalV1 {
	invocationId: string;
	childId: string;
	reason: ForkTerminalReason;
	at: number;
}
interface ForkRootMarkerV1 { contract: typeof CONTRACT; version: typeof VERSION; kind: "root"; }
interface ForkInvocationMarkerV1 { contract: typeof CONTRACT; version: typeof VERSION; kind: "invocation"; invocationId: string; }
interface ForkSealV1 { contract: typeof CONTRACT; version: typeof VERSION; invocationId: string; sealedAt: number; }
export interface ForkQuiescedV1 {
	contract: typeof CONTRACT;
	version: typeof VERSION;
	invocationId: string;
	owner: { pid: number; startedAt: number };
	sealDigest: string;
	quiescedAt: number;
}

export interface ForkSourceOwnershipPaths {
	stateRoot: string;
	rootDir: string;
	invocationDir: string;
	rootMarkerPath: string;
	invocationMarkerPath: string;
	sourcePath: string;
	manifestPath: string;
	sealPath: string;
	quiescedPath: string;
	childrenDir: string;
}
export interface ForkSourceOwnershipOptions {
	/** State-root parent. Fork records live in `<rootDir>/.fork-sources`. */
	rootDir?: string;
	ownerPid?: number;
	ownerStartedAt?: number;
	now?: () => number;
	ownerStatus?: (owner: { pid: number; startedAt: number }) => OwnerStatus;
}
export interface ForkReconcileOutcome { resolved: string[]; retained: string[]; removed: boolean; }
export interface ForkSourceOwnershipRootReconcileOutcome {
	scanned: string[];
	resolved: string[];
	retained: string[];
	removed: string[];
	invalid: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
	return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function identity(value: unknown): value is number { return nonnegative(value); }
function digest(value: unknown): value is string { return typeof value === "string" && SHA256.test(value); }
function token(value: unknown): value is string { return typeof value === "string" && SAFE_TOKEN.test(value); }
function absolute(value: unknown): value is string { return typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value; }
function hash(bytes: Buffer | string): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function jsonBytes(value: unknown): Buffer { return Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }
function nowValue(now: () => number): number {
	const value = now();
	if (!positive(value)) throw new Error("Fork ownership clock must return a positive safe integer");
	return value;
}
function assertToken(value: string, label: string): void { if (!token(value)) throw new Error(`Invalid ${label}`); }
function assertContained(candidate: string, parent: string): void {
	if (!absolute(candidate) || path.dirname(candidate) !== parent) throw new Error(`Unsafe fork ownership path: ${candidate}`);
}
function sameIdentity(stat: fs.Stats, expected: { dev: number; ino: number }): boolean {
	return stat.dev === expected.dev && stat.ino === expected.ino;
}

export function parseForkSourceManifest(value: unknown, invocationId?: string): ForkSourceManifestV1 | null {
	if (!exact(value, ["contract", "version", "invocationId", "source", "owner", "createdAt"])) return null;
	if (value.contract !== CONTRACT || value.version !== VERSION || !token(value.invocationId) || (invocationId !== undefined && value.invocationId !== invocationId)
		|| !exact(value.source, ["algorithm", "digest", "byteLength", "dev", "ino"]) || value.source.algorithm !== "sha256" || !digest(value.source.digest)
		|| !nonnegative(value.source.byteLength) || !identity(value.source.dev) || !positive(value.source.ino)
		|| !exact(value.owner, ["pid", "startedAt"]) || !positive(value.owner.pid) || !positive(value.owner.startedAt) || !positive(value.createdAt)) return null;
	return value as unknown as ForkSourceManifestV1;
}
export function parseForkBootstrap(value: unknown, invocationId?: string, childId?: string): ForkBootstrapV1 | null {
	if (!exact(value, ["invocationId", "childId", "surface", "runId", "source", "session", "createdAt"])) return null;
	if (!token(value.invocationId) || (invocationId !== undefined && value.invocationId !== invocationId) || !token(value.childId) || (childId !== undefined && value.childId !== childId)
		|| (value.surface !== "inline" && value.surface !== "interactive") || !(value.runId === null || token(value.runId))
		|| !exact(value.source, ["path", "digest", "byteLength"]) || !absolute(value.source.path) || !digest(value.source.digest) || !nonnegative(value.source.byteLength)
		|| !exact(value.session, ["path", "inheritedOffset", "inheritedLength", "inheritedDigest", "dev", "ino"]) || !absolute(value.session.path) || !nonnegative(value.session.inheritedOffset)
		|| !nonnegative(value.session.inheritedLength) || !digest(value.session.inheritedDigest) || !identity(value.session.dev) || !positive(value.session.ino) || !positive(value.createdAt)) return null;
	return value as unknown as ForkBootstrapV1;
}
export function parseForkBootstrapAck(value: unknown, invocationId?: string, childId?: string): ForkBootstrapAckV1 | null {
	if (!exact(value, ["invocationId", "childId", "bootstrapDigest", "source", "session", "child", "ackedAt"])) return null;
	if (!token(value.invocationId) || (invocationId !== undefined && value.invocationId !== invocationId) || !token(value.childId) || (childId !== undefined && value.childId !== childId)
		|| !digest(value.bootstrapDigest) || !exact(value.source, ["dev", "ino"]) || !identity(value.source.dev) || !positive(value.source.ino)
		|| !exact(value.session, ["dev", "ino"]) || !identity(value.session.dev) || !positive(value.session.ino)
		|| !exact(value.child, ["pid", "startedAt"]) || !positive(value.child.pid) || !positive(value.child.startedAt) || !positive(value.ackedAt)) return null;
	return value as unknown as ForkBootstrapAckV1;
}
export function parseForkProcess(value: unknown, invocationId?: string, childId?: string): ForkProcessV1 | null {
	if (!exact(value, ["invocationId", "childId", "pid", "startedAt", "recordedAt"]) || !token(value.invocationId) || !token(value.childId)
		|| (invocationId !== undefined && value.invocationId !== invocationId) || (childId !== undefined && value.childId !== childId)
		|| !positive(value.pid) || !positive(value.startedAt) || !positive(value.recordedAt)) return null;
	return value as unknown as ForkProcessV1;
}
export function parseForkRegistration(value: unknown, invocationId?: string, childId?: string): ForkRegistrationV1 | null {
	if (!exact(value, ["invocationId", "childId", "surface", "runId", "registeredAt"]) || !token(value.invocationId) || !token(value.childId)
		|| (invocationId !== undefined && value.invocationId !== invocationId) || (childId !== undefined && value.childId !== childId)
		|| (value.surface !== "inline" && value.surface !== "interactive") || !(value.runId === null || token(value.runId)) || !positive(value.registeredAt)) return null;
	return value as unknown as ForkRegistrationV1;
}
export function parseForkQuiesced(value: unknown, invocationId?: string): ForkQuiescedV1 | null {
	if (!exact(value, ["contract", "version", "invocationId", "owner", "sealDigest", "quiescedAt"]) || value.contract !== CONTRACT || value.version !== VERSION
		|| !token(value.invocationId) || (invocationId !== undefined && value.invocationId !== invocationId)
		|| !exact(value.owner, ["pid", "startedAt"]) || !positive(value.owner.pid) || !positive(value.owner.startedAt)
		|| !digest(value.sealDigest) || !positive(value.quiescedAt)) return null;
	return value as unknown as ForkQuiescedV1;
}
export function parseForkTerminal(value: unknown, invocationId?: string, childId?: string): ForkTerminalV1 | null {
	if (!exact(value, ["invocationId", "childId", "reason", "at"]) || !token(value.invocationId) || !token(value.childId)
		|| (invocationId !== undefined && value.invocationId !== invocationId) || (childId !== undefined && value.childId !== childId)
		|| (value.reason !== "no-launch" && value.reason !== "process-exited-before-ack" && value.reason !== "launch-failed") || !positive(value.at)) return null;
	return value as unknown as ForkTerminalV1;
}

async function assertPrivateDirectory(directory: string): Promise<string> {
	const stat = await fs.promises.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Fork ownership directory is unsafe: ${directory}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Fork ownership directory has another owner: ${directory}`);
	if (process.platform !== "win32" && (stat.mode & 0o777) !== PRIVATE_MODE) throw new Error(`Fork ownership directory is not 0700: ${directory}`);
	return fs.promises.realpath(directory);
}
async function ensurePrivateDirectory(directory: string): Promise<string> {
	await fs.promises.mkdir(directory, { recursive: true, mode: PRIVATE_MODE });
	return assertPrivateDirectory(directory);
}
async function fsyncDirectory(directory: string): Promise<void> {
	try { const handle = await fs.promises.open(directory, "r"); try { await handle.sync(); } finally { await handle.close(); } } catch { /* not supported by all platforms */ }
}
async function readPrivateBytes(file: string, maxBytes = MAX_JSON_BYTES, expectedPath?: string): Promise<Buffer | null> {
	if (!absolute(file) || (expectedPath !== undefined && file !== expectedPath)) return null;
	let handle: fs.promises.FileHandle | undefined;
	try {
		const before = await fs.promises.lstat(file);
		if (!before.isFile() || before.isSymbolicLink() || (typeof process.getuid === "function" && before.uid !== process.getuid())
			|| (process.platform !== "win32" && (before.mode & 0o777) !== FILE_MODE) || before.size > maxBytes) return null;
		handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const inside = await handle.stat();
		if (!inside.isFile() || !sameIdentity(inside, before) || inside.size > maxBytes) return null;
		const bytes = await handle.readFile();
		const after = await fs.promises.lstat(file);
		if (!sameIdentity(after, inside) || after.size !== inside.size) return null;
		return bytes;
	} catch { return null; } finally { await handle?.close(); }
}
async function readPrivateJson(file: string): Promise<unknown | null> {
	const bytes = await readPrivateBytes(file);
	if (!bytes) return null;
	try { return JSON.parse(bytes.toString("utf8")); } catch { return null; }
}
async function privateRegularStat(file: string, maxBytes = MAX_JSON_BYTES): Promise<fs.Stats> {
	if (!absolute(file) || !fs.constants.O_NOFOLLOW) throw new Error(`Unsafe private file path: ${file}`);
	const canonical = await fs.promises.realpath(file);
	if (canonical !== file) throw new Error(`Private file path is not canonical: ${file}`);
	const before = await fs.promises.lstat(file);
	if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes
		|| (typeof process.getuid === "function" && before.uid !== process.getuid())
		|| (process.platform !== "win32" && (before.mode & 0o777) !== FILE_MODE)) throw new Error(`Unsafe or unreadable private file: ${file}`);
	const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.size > maxBytes || !sameIdentity(opened, before)) throw new Error(`Private file identity changed: ${file}`);
		const after = await fs.promises.lstat(file);
		if (!sameIdentity(after, opened) || after.size !== opened.size) throw new Error(`Private file pathname changed: ${file}`);
		return opened;
	} finally { await handle.close(); }
}
async function publishNoReplace(file: string, value: unknown): Promise<boolean> {
	const parent = path.dirname(file);
	const temp = path.join(parent, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
	const handle = await fs.promises.open(temp, "wx", FILE_MODE);
	try {
		await handle.writeFile(jsonBytes(value));
		await handle.sync();
	} finally { await handle.close(); }
	try {
		await fs.promises.link(temp, file);
		await fsyncDirectory(parent);
		return true;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally { await fs.promises.unlink(temp).catch(() => undefined); }
}
async function publishBytesNoReplace(file: string, bytes: Buffer): Promise<boolean> {
	const parent = path.dirname(file);
	const temp = path.join(parent, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
	const handle = await fs.promises.open(temp, "wx", FILE_MODE);
	try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
	try { await fs.promises.link(temp, file); await fsyncDirectory(parent); return true; }
	catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
	finally { await fs.promises.unlink(temp).catch(() => undefined); }
}
function rootMarker(): ForkRootMarkerV1 { return { contract: CONTRACT, version: VERSION, kind: "root" }; }
function invocationMarker(invocationId: string): ForkInvocationMarkerV1 { return { contract: CONTRACT, version: VERSION, kind: "invocation", invocationId }; }
function parseRootMarker(value: unknown): boolean { return exact(value, ["contract", "version", "kind"]) && value.contract === CONTRACT && value.version === VERSION && value.kind === "root"; }
function parseInvocationMarker(value: unknown, invocationId: string): boolean { return exact(value, ["contract", "version", "kind", "invocationId"]) && value.contract === CONTRACT && value.version === VERSION && value.kind === "invocation" && value.invocationId === invocationId; }
function parseSeal(value: unknown, invocationId: string): ForkSealV1 | null {
	if (!exact(value, ["contract", "version", "invocationId", "sealedAt"]) || value.contract !== CONTRACT || value.version !== VERSION || value.invocationId !== invocationId || !positive(value.sealedAt)) return null;
	return value as unknown as ForkSealV1;
}
async function assertMarker(file: string, valid: (value: unknown) => boolean): Promise<void> {
	const value = await readPrivateJson(file);
	if (!valid(value)) throw new Error(`Invalid immutable fork ownership marker: ${file}`);
}
async function exactSegment(file: string, offset: number, length: number): Promise<Buffer> {
	const stat = await privateRegularStat(file, MAX_SESSION_BYTES);
	if (offset + length > stat.size) throw new Error("Inherited session segment is outside the session file");
	const handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const buffer = Buffer.alloc(length); const { bytesRead } = await handle.read(buffer, 0, length, offset);
		if (bytesRead !== length) throw new Error("Could not read inherited session segment");
		const after = await handle.stat(); if (!sameIdentity(after, stat)) throw new Error("Session file changed while being verified");
		return buffer;
	} finally { await handle.close(); }
}

async function validateBootstrapAt(bootstrapPath: string): Promise<{ bootstrap: ForkBootstrapV1; bytes: Buffer; sourceStat: fs.Stats; sessionStat: fs.Stats }> {
	const bytes = await readPrivateBytes(bootstrapPath);
	if (!bytes) throw new Error("Invalid fork bootstrap descriptor");
	let value: unknown; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Malformed fork bootstrap descriptor"); }
	const bootstrap = parseForkBootstrap(value);
	if (!bootstrap) throw new Error("Invalid fork bootstrap descriptor");
	const childDir = path.dirname(bootstrapPath);
	if (path.basename(bootstrapPath) !== "bootstrap.json" || path.basename(childDir) !== bootstrap.childId) throw new Error("Bootstrap path is not bound to its child id");
	const invocationDir = path.dirname(path.dirname(childDir));
	const registration = parseForkRegistration(await readPrivateJson(path.join(childDir, "registration.json")), bootstrap.invocationId, bootstrap.childId);
	if (!registration || registration.surface !== bootstrap.surface || registration.runId !== bootstrap.runId) throw new Error("Bootstrap is not bound to immutable child registration");
	const sourcePath = path.join(invocationDir, "source.jsonl");
	if (bootstrap.source.path !== sourcePath) throw new Error("Bootstrap source path is not contained by its invocation");
	const manifest = parseForkSourceManifest(await readPrivateJson(path.join(invocationDir, "manifest.json")), bootstrap.invocationId);
	if (!manifest || manifest.source.digest !== bootstrap.source.digest || manifest.source.byteLength !== bootstrap.source.byteLength) throw new Error("Bootstrap is not bound to its source manifest");
	const sourceStat = await privateRegularStat(bootstrap.source.path, MAX_SOURCE_BYTES);
	if (!sameIdentity(sourceStat, manifest.source)) throw new Error("Bootstrap source inode does not match its manifest");
	const sessionStat = await privateRegularStat(bootstrap.session.path, MAX_SESSION_BYTES);
	if (!sameIdentity(sessionStat, bootstrap.session)) throw new Error("Bootstrap session inode does not match its descriptor");
	if (sameIdentity(sourceStat, sessionStat)) throw new Error("Source and session files must be distinct");
	const source = await readPrivateBytes(bootstrap.source.path, MAX_SOURCE_BYTES);
	if (!source || source.length !== bootstrap.source.byteLength || hash(source) !== bootstrap.source.digest) throw new Error("Bootstrap source digest mismatch");
	const segment = await exactSegment(bootstrap.session.path, bootstrap.session.inheritedOffset, bootstrap.session.inheritedLength);
	if (segment.length !== bootstrap.source.byteLength || bootstrap.session.inheritedLength !== bootstrap.source.byteLength || hash(segment) !== bootstrap.session.inheritedDigest || bootstrap.session.inheritedDigest !== bootstrap.source.digest || !segment.equals(source)) throw new Error("Bootstrap session inheritance does not exactly match source");
	return { bootstrap, bytes, sourceStat, sessionStat };
}

/** Verify a child bootstrap and publish its immutable acknowledgement. */
export async function verifyAndAcknowledgeForkBootstrap(bootstrapPath: string, options: { pid?: number; startedAt?: number; now?: () => number } = {}): Promise<ForkBootstrapAckV1> {
	if (!absolute(bootstrapPath)) throw new Error("Bootstrap path must be absolute");
	const { bootstrap, bytes, sourceStat, sessionStat } = await validateBootstrapAt(bootstrapPath);
	const pid = options.pid ?? process.pid;
	const startedAt = options.startedAt ?? getCurrentProcessStartedAt();
	if (!positive(pid) || !positive(startedAt)) throw new Error("Unable to establish child process start identity");
	const ack: ForkBootstrapAckV1 = {
		invocationId: bootstrap.invocationId, childId: bootstrap.childId, bootstrapDigest: hash(bytes),
		source: { dev: sourceStat.dev, ino: sourceStat.ino }, session: { dev: sessionStat.dev, ino: sessionStat.ino },
		child: { pid, startedAt }, ackedAt: nowValue(options.now ?? Date.now),
	};
	const ackPath = path.join(path.dirname(bootstrapPath), "bootstrap-ack.json");
	if (await publishNoReplace(ackPath, ack)) return ack;
	const existing = parseForkBootstrapAck(await readPrivateJson(ackPath), bootstrap.invocationId, bootstrap.childId);
	if (!existing || existing.bootstrapDigest !== ack.bootstrapDigest || existing.source.dev !== ack.source.dev || existing.source.ino !== ack.source.ino
		|| existing.session.dev !== ack.session.dev || existing.session.ino !== ack.session.ino || existing.child.pid !== ack.child.pid || existing.child.startedAt !== ack.child.startedAt) throw new Error("Conflicting or malformed fork bootstrap acknowledgement");
	return existing;
}

export class ForkSourceOwnershipManager {
	readonly paths: ForkSourceOwnershipPaths;
	readonly invocationId: string;
	private readonly now: () => number;
	private readonly ownerStatus?: ForkSourceOwnershipOptions["ownerStatus"];
	private readonly role: "owner" | "recovery";
	private mutationTail: Promise<void> = Promise.resolve();
	private quiescing = false;
	private quiescePromise: Promise<void> | undefined;
	private constructor(paths: ForkSourceOwnershipPaths, invocationId: string, now: () => number, ownerStatus: ForkSourceOwnershipOptions["ownerStatus"] | undefined, role: "owner" | "recovery") {
		this.paths = paths; this.invocationId = invocationId; this.now = now; this.ownerStatus = ownerStatus; this.role = role;
	}
	private assertOwnerMutable(): void {
		if (this.role !== "owner") throw new Error("Fork source ownership manager is recovery-only");
		if (this.quiescing) throw new Error("Fork source ownership manager is quiescing");
	}
	private enqueueOwnerMutation<T>(operation: () => Promise<T>): Promise<T> {
		this.assertOwnerMutable();
		const result = this.mutationTail.then(operation);
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	/** Reopen durable ownership state without any process-local registration. */
	static async open(invocationDir: string, options: ForkSourceOwnershipOptions = {}): Promise<ForkSourceOwnershipManager> {
		if (!absolute(invocationDir)) throw new Error("Fork invocation directory must be absolute");
		const canonicalInvocation = await assertPrivateDirectory(invocationDir);
		const rootDir = path.dirname(invocationDir);
		const stateRoot = path.dirname(rootDir);
		if (path.basename(rootDir) !== FORK_SOURCE_ROOT_NAME || !token(path.basename(invocationDir))) throw new Error("Fork invocation is outside the reserved root");
		const canonicalRoot = await assertPrivateDirectory(rootDir);
		const canonicalStateRoot = await assertPrivateDirectory(stateRoot);
		if (path.dirname(canonicalRoot) !== canonicalStateRoot || path.dirname(canonicalInvocation) !== canonicalRoot) throw new Error("Fork invocation escaped private containment");
		const invocationId = path.basename(canonicalInvocation);
		const paths: ForkSourceOwnershipPaths = {
			stateRoot: canonicalStateRoot, rootDir: canonicalRoot, invocationDir: canonicalInvocation,
			rootMarkerPath: path.join(canonicalRoot, "root-marker.json"), invocationMarkerPath: path.join(canonicalInvocation, "invocation-marker.json"),
			sourcePath: path.join(canonicalInvocation, "source.jsonl"), manifestPath: path.join(canonicalInvocation, "manifest.json"),
			sealPath: path.join(canonicalInvocation, "sealed.json"), quiescedPath: path.join(canonicalInvocation, "quiesced.json"), childrenDir: path.join(canonicalInvocation, "children"),
		};
		await assertMarker(paths.rootMarkerPath, parseRootMarker);
		await assertMarker(paths.invocationMarkerPath, (value) => parseInvocationMarker(value, invocationId));
		const manifest = parseForkSourceManifest(await readPrivateJson(paths.manifestPath), invocationId);
		if (!manifest) throw new Error("Invalid fork source manifest");
		const canonicalChildren = await assertPrivateDirectory(paths.childrenDir);
		if (path.dirname(canonicalChildren) !== canonicalInvocation) throw new Error("Fork children escaped invocation");
		return new ForkSourceOwnershipManager(paths, invocationId, options.now ?? Date.now, options.ownerStatus, "recovery");
	}
	/** Alias used by startup recovery callers. */
	static async recover(invocationDir: string, options: ForkSourceOwnershipOptions = {}): Promise<ForkSourceOwnershipManager> {
		return await ForkSourceOwnershipManager.open(invocationDir, options);
	}

	static async create(sourceJsonl: string, options: ForkSourceOwnershipOptions = {}): Promise<ForkSourceOwnershipManager> {
		if (typeof sourceJsonl !== "string") throw new Error("Fork source must be a string");
		validateHeaderlessJsonl(sourceJsonl);
		const now = options.now ?? Date.now;
		const ownerPid = options.ownerPid ?? process.pid;
		const ownerStartedAt = options.ownerStartedAt ?? getCurrentProcessStartedAt();
		if (!positive(ownerPid) || !positive(ownerStartedAt)) throw new Error("Unable to establish fork owner process start identity");
		const stateRoot = await ensureRunStateRoot(path.resolve(options.rootDir ?? getRunStateRoot()));
		const rootDir = path.join(stateRoot, FORK_SOURCE_ROOT_NAME);
		await ensurePrivateDirectory(rootDir);
		const rootMarkerPath = path.join(rootDir, "root-marker.json");
		if (!(await publishNoReplace(rootMarkerPath, rootMarker()))) await assertMarker(rootMarkerPath, parseRootMarker);
		const invocationId = crypto.randomUUID();
		const invocationDir = path.join(rootDir, invocationId);
		await fs.promises.mkdir(invocationDir, { mode: PRIVATE_MODE });
		const canonicalInvocation = await assertPrivateDirectory(invocationDir);
		if (path.dirname(canonicalInvocation) !== await fs.promises.realpath(rootDir)) throw new Error("Fork invocation escaped reserved root");
		const paths: ForkSourceOwnershipPaths = {
			stateRoot, rootDir: await fs.promises.realpath(rootDir), invocationDir: canonicalInvocation, rootMarkerPath,
			invocationMarkerPath: path.join(canonicalInvocation, "invocation-marker.json"), sourcePath: path.join(canonicalInvocation, "source.jsonl"),
			manifestPath: path.join(canonicalInvocation, "manifest.json"), sealPath: path.join(canonicalInvocation, "sealed.json"), quiescedPath: path.join(canonicalInvocation, "quiesced.json"), childrenDir: path.join(canonicalInvocation, "children"),
		};
		try {
			if (!(await publishNoReplace(paths.invocationMarkerPath, invocationMarker(invocationId)))) throw new Error("Fork invocation marker already exists");
			const source = Buffer.from(sourceJsonl, "utf8");
			if (source.length > MAX_SOURCE_BYTES) throw new Error("Fork source exceeds 64MiB");
			if (!(await publishBytesNoReplace(paths.sourcePath, source))) throw new Error("Fork source already exists");
			const sourceStat = await privateRegularStat(paths.sourcePath, MAX_SOURCE_BYTES);
			const manifest: ForkSourceManifestV1 = { contract: CONTRACT, version: VERSION, invocationId, source: { algorithm: "sha256", digest: hash(source), byteLength: source.length, dev: sourceStat.dev, ino: sourceStat.ino }, owner: { pid: ownerPid, startedAt: ownerStartedAt }, createdAt: nowValue(now) };
			if (!(await publishNoReplace(paths.manifestPath, manifest))) throw new Error("Fork manifest already exists");
			await ensurePrivateDirectory(paths.childrenDir);
			return new ForkSourceOwnershipManager(paths, invocationId, now, options.ownerStatus, "owner");
		} catch (error) { await fs.promises.rm(canonicalInvocation, { recursive: true, force: true }); throw error; }
	}

	private childDir(childId: string): string { assertToken(childId, "child id"); return path.join(this.paths.childrenDir, childId); }
	private async manifestRecord(): Promise<ForkSourceManifestV1> {
		await assertPrivateDirectory(this.paths.invocationDir); await assertMarker(this.paths.invocationMarkerPath, (v) => parseInvocationMarker(v, this.invocationId));
		const manifest = parseForkSourceManifest(await readPrivateJson(this.paths.manifestPath), this.invocationId);
		if (!manifest) throw new Error("Invalid fork source manifest");
		return manifest;
	}
	private async manifest(): Promise<ForkSourceManifestV1> {
		const manifest = await this.manifestRecord();
		const source = await readPrivateBytes(this.paths.sourcePath, MAX_SOURCE_BYTES);
		const stat = await privateRegularStat(this.paths.sourcePath, MAX_SOURCE_BYTES);
		if (!source || !sameIdentity(stat, manifest.source) || source.length !== manifest.source.byteLength || hash(source) !== manifest.source.digest) throw new Error("Fork source no longer matches its manifest");
		return manifest;
	}
	async registerChild(input: { childId?: string; surface: ForkSurface; runId?: string | null }): Promise<{ childId: string; childDir: string }> {
		return await this.enqueueOwnerMutation(async () => {
		await this.manifest();
		if (input.surface !== "inline" && input.surface !== "interactive") throw new Error("Invalid fork child surface");
		if (input.runId !== undefined && input.runId !== null) assertToken(input.runId, "run id");
		const childId = input.childId ?? crypto.randomUUID(); assertToken(childId, "child id");
		const childDir = this.childDir(childId);
		try { await fs.promises.mkdir(childDir, { mode: PRIVATE_MODE }); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Fork child id already exists"); throw error; }
		await assertPrivateDirectory(childDir);
		const registration: ForkRegistrationV1 = {
			invocationId: this.invocationId, childId, surface: input.surface, runId: input.runId ?? null, registeredAt: nowValue(this.now),
		};
		if (!(await publishNoReplace(path.join(childDir, "registration.json"), registration))) throw new Error("Fork child registration already exists");
		return { childId, childDir };
		});
	}
	private async registration(childId: string): Promise<ForkRegistrationV1> {
		const record = parseForkRegistration(await readPrivateJson(path.join(this.childDir(childId), "registration.json")), this.invocationId, childId);
		if (!record) throw new Error("Invalid immutable fork child registration");
		return record;
	}
	async writeBootstrap(childId: string, input: { sessionPath: string; inheritedOffset: number; inheritedLength: number }): Promise<ForkBootstrapV1> {
		return await this.enqueueOwnerMutation(async () => {
		const manifest = await this.manifest(); const childDir = this.childDir(childId); await assertPrivateDirectory(childDir);
		const registration = await this.registration(childId);
		if (!absolute(input.sessionPath) || !nonnegative(input.inheritedOffset) || !nonnegative(input.inheritedLength)) throw new Error("Invalid inherited session descriptor");
		const sessionPath = await fs.promises.realpath(input.sessionPath);
		if (!absolute(sessionPath)) throw new Error("Inherited session path is not canonical");
		const source = await readPrivateBytes(this.paths.sourcePath, MAX_SOURCE_BYTES); if (!source) throw new Error("Unreadable fork source");
		const sourceStat = await privateRegularStat(this.paths.sourcePath, MAX_SOURCE_BYTES);
		const sessionStat = await privateRegularStat(sessionPath, MAX_SESSION_BYTES);
		if (sameIdentity(sourceStat, sessionStat)) throw new Error("Source and session files must be distinct");
		const segment = await exactSegment(sessionPath, input.inheritedOffset, input.inheritedLength);
		if (segment.length !== source.length || !segment.equals(source)) throw new Error("Inherited session bytes do not exactly match fork source");
		const childEntries = await fs.promises.readdir(childDir); if (childEntries.length !== 1 || childEntries[0] !== "registration.json") throw new Error("Fork child bootstrap cannot replace existing artifacts");
		const bootstrap: ForkBootstrapV1 = {
			invocationId: this.invocationId, childId, surface: registration.surface, runId: registration.runId,
			source: { path: this.paths.sourcePath, digest: manifest.source.digest, byteLength: manifest.source.byteLength },
			session: { path: sessionPath, inheritedOffset: input.inheritedOffset, inheritedLength: input.inheritedLength, inheritedDigest: hash(segment), dev: Number(sessionStat.dev), ino: Number(sessionStat.ino) }, createdAt: nowValue(this.now),
		};
		if (!(await publishNoReplace(path.join(childDir, "bootstrap.json"), bootstrap))) throw new Error("Fork bootstrap already exists");
		return bootstrap;
		});
	}
	async recordProcess(childId: string, input: { pid: number; startedAt: number }): Promise<ForkProcessV1> {
		return await this.enqueueOwnerMutation(async () => {
		await this.manifest(); const childDir = this.childDir(childId); await assertPrivateDirectory(childDir);
		if (!positive(input.pid) || !positive(input.startedAt)) throw new Error("Invalid child process identity");
		const record: ForkProcessV1 = { invocationId: this.invocationId, childId, pid: input.pid, startedAt: input.startedAt, recordedAt: nowValue(this.now) };
		const file = path.join(childDir, "process.json"); if (await publishNoReplace(file, record)) return record;
		const existing = parseForkProcess(await readPrivateJson(file), this.invocationId, childId);
		if (!existing || existing.pid !== record.pid || existing.startedAt !== record.startedAt) throw new Error("Conflicting or malformed fork process record"); return existing;
		});
	}
	async markTerminal(childId: string, reason: ForkTerminalReason): Promise<ForkTerminalV1> {
		return await this.enqueueOwnerMutation(async () => {
		await this.manifest(); const childDir = this.childDir(childId); await assertPrivateDirectory(childDir);
		const terminal: ForkTerminalV1 = { invocationId: this.invocationId, childId, reason, at: nowValue(this.now) };
		const file = path.join(childDir, "terminal.json"); if (await publishNoReplace(file, terminal)) return terminal;
		const existing = parseForkTerminal(await readPrivateJson(file), this.invocationId, childId);
		if (!existing || existing.reason !== reason) throw new Error("Conflicting or malformed fork terminal record"); return existing;
		});
	}
	private async publishAndReadSeal(): Promise<Buffer> {
		const seal: ForkSealV1 = { contract: CONTRACT, version: VERSION, invocationId: this.invocationId, sealedAt: nowValue(this.now) };
		await publishNoReplace(this.paths.sealPath, seal);
		const bytes = await readPrivateBytes(this.paths.sealPath);
		if (!bytes || !parseSeal(JSON.parse(bytes.toString("utf8")), this.invocationId)) throw new Error("Malformed fork seal");
		return bytes;
	}
	async seal(): Promise<void> {
		return await this.enqueueOwnerMutation(async () => { await this.manifest(); await this.publishAndReadSeal(); });
	}
	/** Fence local owner mutations and durably transfer recovery authority. */
	async quiesce(): Promise<void> {
		if (this.role !== "owner") throw new Error("Fork source ownership manager is recovery-only");
		if (this.quiescePromise) return await this.quiescePromise;
		this.quiescing = true;
		this.quiescePromise = (async () => {
			await this.manifest();
			const sealBytes = await this.publishAndReadSeal();
			await this.mutationTail;
			const manifest = await this.manifestRecord();
			const acknowledgement: ForkQuiescedV1 = {
				contract: CONTRACT, version: VERSION, invocationId: this.invocationId,
				owner: manifest.owner, sealDigest: hash(sealBytes), quiescedAt: nowValue(this.now),
			};
			await publishNoReplace(this.paths.quiescedPath, acknowledgement);
			const bytes = await readPrivateBytes(this.paths.quiescedPath);
			let existing: ForkQuiescedV1 | null = null;
			try { existing = bytes ? parseForkQuiesced(JSON.parse(bytes.toString("utf8")), this.invocationId) : null; } catch { existing = null; }
			if (!existing || existing.owner.pid !== acknowledgement.owner.pid || existing.owner.startedAt !== acknowledgement.owner.startedAt || existing.sealDigest !== acknowledgement.sealDigest) throw new Error("Conflicting or malformed fork quiesced acknowledgement");
		})();
		return await this.quiescePromise;
	}
	private async quiescedAuthority(manifest: ForkSourceManifestV1): Promise<"absent" | "valid" | "invalid"> {
		const exists = await fs.promises.lstat(this.paths.quiescedPath).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
		if (!exists) return "absent";
		const bytes = await readPrivateBytes(this.paths.quiescedPath);
		if (!bytes) return "invalid";
		let acknowledgement: ForkQuiescedV1 | null = null;
		try { acknowledgement = parseForkQuiesced(JSON.parse(bytes.toString("utf8")), this.invocationId); } catch { acknowledgement = null; }
		if (!acknowledgement || acknowledgement.owner.pid !== manifest.owner.pid || acknowledgement.owner.startedAt !== manifest.owner.startedAt) return "invalid";
		const sealBytes = await readPrivateBytes(this.paths.sealPath);
		if (!sealBytes) return "invalid";
		try { if (!parseSeal(JSON.parse(sealBytes.toString("utf8")), this.invocationId)) return "invalid"; } catch { return "invalid"; }
		return acknowledgement.sealDigest === hash(sealBytes) ? "valid" : "invalid";
	}
	private async markRecoveryTerminal(childId: string, reason: ForkTerminalReason): Promise<ForkTerminalV1> {
		if (this.role !== "recovery") throw new Error("Only recovery managers may reconcile terminal records");
		const childDir = this.childDir(childId); await assertPrivateDirectory(childDir);
		const terminal: ForkTerminalV1 = { invocationId: this.invocationId, childId, reason, at: nowValue(this.now) };
		const file = path.join(childDir, "terminal.json"); if (await publishNoReplace(file, terminal)) return terminal;
		const existing = parseForkTerminal(await readPrivateJson(file), this.invocationId, childId);
		if (!existing || existing.reason !== reason) throw new Error("Conflicting or malformed fork terminal record"); return existing;
	}
	async reconcile(options: { allowDeadOwnerSeal?: boolean } = {}): Promise<ForkReconcileOutcome> {
		const invocationExists = await fs.promises.lstat(this.paths.invocationDir).then(() => true).catch((cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? false : Promise.reject(cause));
		if (!invocationExists) return { resolved: [], retained: [], removed: true };
		let manifest: ForkSourceManifestV1;
		try { manifest = await this.manifest(); }
		catch (error) {
			// The only tolerated missing source is the crash window after it was unlinked
			// during sealed cleanup and before the invocation directory was removed.
			manifest = await this.manifestRecord();
			const sourceMissing = await fs.promises.lstat(this.paths.sourcePath).then(() => false).catch((cause: NodeJS.ErrnoException) => cause.code === "ENOENT");
			if (!sourceMissing || !parseSeal(await readPrivateJson(this.paths.sealPath), this.invocationId)) throw error;
		}
		const allowedInvocationEntries = new Set(["invocation-marker.json", "manifest.json", "sealed.json", "quiesced.json", "children", "source.jsonl"]);
		const invocationEntriesBeforeSeal = await fs.promises.readdir(this.paths.invocationDir);
		if (invocationEntriesBeforeSeal.some((name) => !allowedInvocationEntries.has(name))) return { resolved: [], retained: ["source"], removed: false };
		let quiesced = await this.quiescedAuthority(manifest);
		const names = await fs.promises.readdir(this.paths.childrenDir);
		const resolved: string[] = []; const retained: string[] = [];
		// A present acknowledgement is immutable authority evidence: if it is not
		// exact and manifest/seal-bound, retain every child and the source untouched.
		if (quiesced === "invalid") return { resolved, retained: ["source", ...names], removed: false };
		let sealed = parseSeal(await readPrivateJson(this.paths.sealPath), this.invocationId) !== null;
		const ownerDead = options.allowDeadOwnerSeal === true && this.ownerStatus?.(manifest.owner) === "dead";
		if (!sealed && ownerDead && this.role === "recovery") { await this.publishAndReadSeal(); sealed = true; quiesced = await this.quiescedAuthority(manifest); }
		const transferred = quiesced === "valid";
		if (!sealed) return { resolved, retained: ["source", ...names], removed: false };
		for (const childId of names) {
			if (!token(childId)) { retained.push(childId); continue; }
			const childDir = this.childDir(childId);
			try { await assertPrivateDirectory(childDir); } catch { retained.push(childId); continue; }
			const artifacts = await fs.promises.readdir(childDir).catch(() => null);
			if (!artifacts || artifacts.some((name) => !["registration.json", "bootstrap.json", "process.json", "bootstrap-ack.json", "terminal.json"].includes(name))) { retained.push(childId); continue; }
			const registration = artifacts.includes("registration.json") ? parseForkRegistration(await readPrivateJson(path.join(childDir, "registration.json")), this.invocationId, childId) : null;
			const terminalPath = path.join(childDir, "terminal.json");
			let terminal = artifacts.includes("terminal.json") ? parseForkTerminal(await readPrivateJson(terminalPath), this.invocationId, childId) : null;
			const bootstrap = artifacts.includes("bootstrap.json") ? parseForkBootstrap(await readPrivateJson(path.join(childDir, "bootstrap.json")), this.invocationId, childId) : null;
			const processRecord = artifacts.includes("process.json") ? parseForkProcess(await readPrivateJson(path.join(childDir, "process.json")), this.invocationId, childId) : null;
			// A present malformed record is never silently ignored, even if another ref is terminal.
			if (!registration || (artifacts.includes("terminal.json") && !terminal) || (artifacts.includes("bootstrap.json") && !bootstrap) || (artifacts.includes("process.json") && !processRecord)) { retained.push(childId); continue; }
			const ackValid = artifacts.includes("bootstrap-ack.json") ? await this.validAck(childDir, childId).catch(() => false) : false;
			if (artifacts.includes("bootstrap-ack.json") && !ackValid) { retained.push(childId); continue; }
			if (!terminal && !ackValid) {
				if (this.role !== "recovery" || !(ownerDead || transferred)) { retained.push(childId); continue; }
				let reason: ForkTerminalReason;
				if (processRecord) {
					if (this.ownerStatus?.({ pid: processRecord.pid, startedAt: processRecord.startedAt }) !== "dead") { retained.push(childId); continue; }
					reason = "process-exited-before-ack";
				} else if (!bootstrap) {
					reason = "no-launch";
				} else if (bootstrap.surface === "inline") {
					if (nowValue(this.now) - bootstrap.createdAt < INLINE_NO_LAUNCH_GRACE_MS) { retained.push(childId); continue; }
					reason = "no-launch";
				} else {
					const runDir = bootstrap.runId === null ? null : path.join(this.paths.stateRoot, bootstrap.runId);
					if (!runDir || await fs.promises.lstat(runDir).then(() => true).catch((error: NodeJS.ErrnoException) => error.code !== "ENOENT")) { retained.push(childId); continue; }
					reason = "no-launch";
				}
				terminal = await this.markRecoveryTerminal(childId, reason).catch(() => null);
				if (!terminal) { retained.push(childId); continue; }
				if (!artifacts.includes("terminal.json")) artifacts.push("terminal.json");
			}
			try {
				for (const artifact of artifacts) await fs.promises.unlink(path.join(childDir, artifact));
				await fs.promises.rmdir(childDir); resolved.push(childId);
			} catch { retained.push(childId); }
		}
		if (retained.length > 0) return { resolved, retained: ["source", ...retained], removed: false };
		const expectedEntries = new Set(["invocation-marker.json", "manifest.json", "sealed.json", "quiesced.json", "children", "source.jsonl"]);
		const invocationEntries = await fs.promises.readdir(this.paths.invocationDir);
		if (invocationEntries.some((name) => !expectedEntries.has(name))) return { resolved, retained: ["source"], removed: false };
		// Source is removed only after every child ref is resolved and its exact
		// manifest-bound inode/digest is revalidated. A crash after this unlink is
		// idempotently completed by the source-missing branch above.
		const sourceExists = await fs.promises.lstat(this.paths.sourcePath).then(() => true).catch((cause: NodeJS.ErrnoException) => cause.code === "ENOENT" ? false : Promise.reject(cause));
		if (sourceExists) {
			const source = await readPrivateBytes(this.paths.sourcePath, MAX_SOURCE_BYTES);
			const sourceStat = await privateRegularStat(this.paths.sourcePath, MAX_SOURCE_BYTES);
			if (!source || !sameIdentity(sourceStat, manifest.source) || source.length !== manifest.source.byteLength || hash(source) !== manifest.source.digest) {
				return { resolved, retained: ["source"], removed: false };
			}
			await fs.promises.unlink(this.paths.sourcePath);
			await fsyncDirectory(this.paths.invocationDir);
		}
		for (const file of [this.paths.quiescedPath, this.paths.sealPath, this.paths.manifestPath, this.paths.invocationMarkerPath]) await fs.promises.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
		await fs.promises.rmdir(this.paths.childrenDir);
		await fs.promises.rmdir(this.paths.invocationDir);
		await fsyncDirectory(this.paths.rootDir);
		return { resolved, retained: [], removed: true };
	}
	/** Public exact acknowledgement validation for parent launch/completion gates. */
	async validateChildAcknowledgement(childId: string): Promise<boolean> {
		const childDir = this.childDir(childId);
		await assertPrivateDirectory(childDir);
		const registration = await this.registration(childId);
		const bootstrapPath = path.join(childDir, "bootstrap.json");
		const verified = await validateBootstrapAt(bootstrapPath);
		if (verified.bootstrap.invocationId !== this.invocationId || verified.bootstrap.childId !== childId
			|| verified.bootstrap.surface !== registration.surface || verified.bootstrap.runId !== registration.runId) return false;
		const ack = parseForkBootstrapAck(await readPrivateJson(path.join(childDir, "bootstrap-ack.json")), this.invocationId, childId);
		if (!ack || ack.bootstrapDigest !== hash(verified.bytes) || !sameIdentity(verified.sourceStat, ack.source) || !sameIdentity(verified.sessionStat, ack.session)) return false;
		const processRecord = parseForkProcess(await readPrivateJson(path.join(childDir, "process.json")), this.invocationId, childId);
		return Boolean(processRecord) && processRecord!.pid === ack.child.pid && processRecord!.startedAt === ack.child.startedAt;
	}
	private async validAck(childDir: string, childId: string): Promise<boolean> {
		const bootstrapPath = path.join(childDir, "bootstrap.json");
		const bootstrapBytes = await readPrivateBytes(bootstrapPath);
		if (!bootstrapBytes) return false;
		let bootstrapValue: unknown;
		try { bootstrapValue = JSON.parse(bootstrapBytes.toString("utf8")); } catch { return false; }
		const bootstrap = parseForkBootstrap(bootstrapValue, this.invocationId, childId);
		const registration = await this.registration(childId).catch(() => null);
		const ack = parseForkBootstrapAck(await readPrivateJson(path.join(childDir, "bootstrap-ack.json")), this.invocationId, childId);
		const manifest = await this.manifestRecord().catch(() => null);
		if (!bootstrap || !registration || !ack || !manifest
			|| bootstrap.surface !== registration.surface || bootstrap.runId !== registration.runId
			|| bootstrap.source.path !== this.paths.sourcePath
			|| bootstrap.source.digest !== manifest.source.digest || bootstrap.source.byteLength !== manifest.source.byteLength
			|| ack.bootstrapDigest !== hash(bootstrapBytes)
			|| ack.source.dev !== manifest.source.dev || ack.source.ino !== manifest.source.ino
			|| ack.session.dev !== bootstrap.session.dev || ack.session.ino !== bootstrap.session.ino) return false;
		const processRecord = parseForkProcess(await readPrivateJson(path.join(childDir, "process.json")), this.invocationId, childId);
		return Boolean(processRecord) && processRecord!.pid === ack.child.pid && processRecord!.startedAt === ack.child.startedAt;
	}
}

function validateHeaderlessJsonl(source: string): void {
	const bytes = Buffer.byteLength(source, "utf8");
	if (bytes > MAX_SOURCE_BYTES) throw new Error("Fork source must be at most 64MiB");
	if (bytes === 0) return;
	const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
	if (lines.length === 0 || lines.some((line) => line.length === 0)) throw new Error("Fork source JSONL must not contain blank/header lines");
	for (const line of lines) { try { JSON.parse(line); } catch { throw new Error("Fork source contains invalid JSONL"); } }
}

/**
 * Reconcile durable fork-source records after a parent process dies. This is
 * deliberately descriptor-driven: no process-local registration is consulted.
 */
export async function reconcileForkSourceOwnershipRoot(options: {
	stateRoot: string;
	ownerStatus: (owner: { pid: number; startedAt: number }) => OwnerStatus;
	signal?: AbortSignal;
	now?: () => number;
}): Promise<ForkSourceOwnershipRootReconcileOutcome> {
	const outcome: ForkSourceOwnershipRootReconcileOutcome = { scanned: [], resolved: [], retained: [], removed: [], invalid: [] };
	const requestedStateRoot = path.resolve(options.stateRoot);
	const requestedRootDir = path.join(requestedStateRoot, FORK_SOURCE_ROOT_NAME);
	const rootExists = await fs.promises.lstat(requestedRootDir).then(() => true).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? false : Promise.reject(error));
	if (!rootExists || options.signal?.aborted) return outcome;
	let rootDir: string;
	try {
		await assertSafeStateRoot(requestedStateRoot);
		const canonicalStateRoot = await assertPrivateDirectory(requestedStateRoot);
		const canonicalRoot = await assertPrivateDirectory(requestedRootDir);
		if (path.dirname(canonicalRoot) !== canonicalStateRoot) throw new Error("Fork root escaped state root");
		await assertMarker(path.join(canonicalRoot, "root-marker.json"), parseRootMarker);
		rootDir = canonicalRoot;
	} catch {
		outcome.invalid.push(FORK_SOURCE_ROOT_NAME);
		return outcome;
	}
	let names: string[];
	try { names = (await fs.promises.readdir(rootDir)).sort(); }
	catch { outcome.invalid.push(FORK_SOURCE_ROOT_NAME); return outcome; }
	for (const name of names) {
		if (name === "root-marker.json") continue;
		if (!token(name)) { outcome.invalid.push(name); continue; }
		if (outcome.scanned.length >= MAX_RECONCILE_INVOCATIONS) { outcome.retained.push(name); continue; }
		if (options.signal?.aborted) { outcome.retained.push(name); continue; }
		const invocationDir = path.join(rootDir, name);
		let manager: ForkSourceOwnershipManager;
		try {
			manager = await ForkSourceOwnershipManager.open(invocationDir, { now: options.now ?? Date.now, ownerStatus: options.ownerStatus });
		} catch {
			outcome.invalid.push(name);
			continue;
		}
		outcome.scanned.push(name);
		try {
			const result = await manager.reconcile({ allowDeadOwnerSeal: true });
			outcome.resolved.push(...result.resolved.map((child) => `${name}/${child}`));
			if (result.removed) outcome.removed.push(name);
			else outcome.retained.push(...result.retained.map((item) => `${name}/${item}`));
		} catch {
			// A malformed invocation is immutable evidence: retain it untouched.
			outcome.invalid.push(name);
		}
	}
	return outcome;
}
