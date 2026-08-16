import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { MINIMUM_CMUX_VERSION, isStableSemverAtLeast } from "./version-policy.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isValidTmuxWindowLabel } from "./tmux-window-label.mjs";

export const RUN_PROTOCOL_VERSION = 1 as const;
/** Version for the detached one-shot launch broker protocol. */
export const BROKER_PROTOCOL_VERSION = 2 as const;
export const RUN_STATE_DIR_ENV = "PI_SUBAGENT_RUN_STATE_DIR";
export const SUBAGENT_RUN_ID_ENV = "PI_SUBAGENT_RUN_ID";
export const SUBAGENT_RUN_STATE_PATH_ENV = "PI_SUBAGENT_RUN_STATE_PATH";
export const SUBAGENT_RUN_COMPLETION_PATH_ENV = "PI_SUBAGENT_RUN_COMPLETION_PATH";
/** Private child/parent callback completion handshake. */
export const SUBAGENT_COMPLETION_FENCE_PATH_ENV = "PI_SUBAGENT_COMPLETION_FENCE_PATH";
export const SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV = "PI_SUBAGENT_COMPLETION_FENCE_ACK_PATH";
export const SUBAGENT_COMPLETION_FENCE_NONCE_ENV = "PI_SUBAGENT_COMPLETION_FENCE_NONCE";
export const SUBAGENT_PARENT_LEASE_PATH_ENV = "PI_SUBAGENT_PARENT_LEASE_PATH";
export const SUBAGENT_CHILD_SESSION_PATH_ENV = "PI_SUBAGENT_CHILD_SESSION_PATH";
export const SUBAGENT_RUN_OWNERSHIP_ENV = "PI_SUBAGENT_RUN_OWNERSHIP";
/** Private immutable ownership-transfer artifacts, never inherited beyond the child. */
export const SUBAGENT_PROMOTION_REQUEST_PATH_ENV = "PI_SUBAGENT_PROMOTION_REQUEST_PATH";
export const SUBAGENT_PROMOTION_ACK_PATH_ENV = "PI_SUBAGENT_PROMOTION_ACK_PATH";
/** Immutable fork descriptor consumed by child-bridge before agent input. */
export const SUBAGENT_FORK_BOOTSTRAP_PATH_ENV = "PI_SUBAGENT_FORK_BOOTSTRAP_PATH";
/** Opt-in only: newer parents permit child V3 failures to carry a session boundary. */
export const SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV = "PI_SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY";
export const V3_FAILURE_BOUNDARY_CAPABILITY = "v1";
export function hasV3FailureBoundaryCapability(value: string | undefined): boolean {
	return value === V3_FAILURE_BOUNDARY_CAPABILITY;
}
/** Opt-in only: newer parents accept success boundaries whose tail ends in linked Pi metadata. */
export const SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV = "PI_SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY";
export const V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY = "v1";
export function hasV3MetadataTailSuccessBoundaryCapability(value: string | undefined): boolean {
	return value === V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY;
}
export const SUBAGENT_LEASE_STALE_MS_ENV = "PI_SUBAGENT_LEASE_STALE_MS";
export const SUBAGENT_LEASE_CHECK_MS_ENV = "PI_SUBAGENT_LEASE_CHECK_MS";
/** Immutable parent identity copied from the committed launch intent into the child bootstrap. */
export const SUBAGENT_EXPECTED_PARENT_PID_ENV = "PI_SUBAGENT_EXPECTED_PARENT_PID";
export const SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV = "PI_SUBAGENT_EXPECTED_PARENT_STARTED_AT";
export const DEFAULT_PARENT_LEASE_RENEW_MS = 2000;
export const DEFAULT_PARENT_LEASE_STALE_MS = 12_000;
/** A child cannot extend a lease indefinitely by writing a far-future clock value. */
export const MAX_PARENT_LEASE_FUTURE_MS = 5_000;
/** Immutable, non-secret ownership boundaries for all state cleanup. */
export const STATE_ROOT_MARKER_NAME = "state-root-marker.json";
export const RUN_DIRECTORY_MARKER_NAME = "run-directory-marker.json";

export type RunOwnership = "parent-owned" | "detached";
export type RunPhase =
	| "starting"
	| "idle"
	| "running"
	| "settled"
	| "shutting-down"
	| "shutdown"
	| "failed"
	| "orphaned";
export type CompletionStatus = "completed" | "failed" | "aborted" | "orphaned";
export type CompletionErrorCode = "child-error" | "bridge-error" | "lease-expired" | "surface-closed";

export interface LaunchRecordV1 {
	version: typeof RUN_PROTOCOL_VERSION;
	runId: string;
	parentRunId?: string;
	parentSessionId: string;
	ownership: RunOwnership;
	terminalMode: "cmux-pane" | "tmux-pane" | "herdr-pane";
	cmuxWorkspaceId?: string;
	cmuxSurfaceId?: string;
	cmuxSurfaceUuid?: string;
	cmuxPaneId?: string;
	tmuxPaneId?: string;
	tmuxSocketPath?: string;
	tmuxServerPid?: number;
	tmuxPanePid?: number;
	childSessionFile: string;
	createdAt: number;
}

export interface RunStateV1 {
	version: typeof RUN_PROTOCOL_VERSION;
	runId: string;
	sequence: number;
	phase: RunPhase;
	updatedAt: number;
	childPid?: number;
	childStartedAt?: number;
	childProcessGroupId?: number;
	lastEvent?: string;
}

export interface CompletionRecordV1 {
	version: typeof RUN_PROTOCOL_VERSION;
	runId: string;
	status: CompletionStatus;
	completedAt: number;
	stopReason?: string;
	errorCode?: CompletionErrorCode;
	childSessionFile: string;
}

export interface ParentLeaseV1 {
	version: typeof RUN_PROTOCOL_VERSION;
	runId: string;
	parentPid: number;
	parentStartedAt: number;
	renewedAt: number;
}

/** Immutable, exact, private completion callback fence records. */
export interface CompletionFenceV1 {
	version: 1;
	kind: "completion-fence";
	runId: string;
	nonce: string;
	publishedAt: number;
}
export interface CompletionFenceAckV1 {
	version: 1;
	kind: "completion-fence-ack";
	runId: string;
	nonce: string;
	acknowledgedAt: number;
}

/**
 * Legacy private ownership marker. Read-only compatibility for markers written
 * before the public detached-ownership v1 contract; never publish this shape.
 */
export interface LegacyUserOwnershipRecordV1 {
	version: 1;
	runId: string;
	promotedAt: number;
	allocationDigest: string;
}

/** @deprecated Legacy read-only compatibility parser. */
export function parseUserOwnershipRecord(value: unknown, runId: string): LegacyUserOwnershipRecordV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "runId", "promotedAt", "allocationDigest"])) return null;
	if (value.version !== 1 || value.runId !== runId || !isSafeRunId(value.runId)
		|| !Number.isSafeInteger(value.promotedAt) || (value.promotedAt as number) <= 0
		|| typeof value.allocationDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.allocationDigest)) return null;
	return value as unknown as LegacyUserOwnershipRecordV1;
}

export interface OwnershipTransferRequestV1 {
	contract: "pi-subagent.detached-transfer";
	version: 1;
	kind: "request";
	transferId: string;
	runId: string;
	allocation: { algorithm: "sha256"; digest: string };
	parent: { pid: number; startedAt: number };
	child: { pid: number; startedAt: number };
	requestedAt: number;
}

export interface OwnershipTransferAckV1 extends Omit<OwnershipTransferRequestV1, "kind" | "requestedAt"> {
	kind: "ack";
	acknowledgedAt: number;
}

function parseOwnershipTransferBase(value: unknown, runId: string, kind: "request" | "ack"): OwnershipTransferRequestV1 | OwnershipTransferAckV1 | null {
	const timing = kind === "request" ? "requestedAt" : "acknowledgedAt";
	const keys = ["contract", "version", "kind", "transferId", "runId", "allocation", "parent", "child", timing];
	if (!isRecord(value) || !hasExactKeys(value, keys) || value.contract !== "pi-subagent.detached-transfer" || value.version !== 1
		|| value.kind !== kind || value.runId !== runId || !isSafeRunId(value.runId)
		|| typeof value.transferId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.transferId)
		|| !isRecord(value.allocation) || !hasExactKeys(value.allocation, ["algorithm", "digest"]) || value.allocation.algorithm !== "sha256" || typeof value.allocation.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.allocation.digest)
		|| !isRecord(value.parent) || !hasExactKeys(value.parent, ["pid", "startedAt"]) || !pid(value.parent.pid) || !positive(value.parent.startedAt)
		|| !isRecord(value.child) || !hasExactKeys(value.child, ["pid", "startedAt"]) || !pid(value.child.pid) || !positive(value.child.startedAt)
		|| !Number.isSafeInteger(value[timing]) || (value[timing] as number) <= 0) return null;
	return value as unknown as OwnershipTransferRequestV1 | OwnershipTransferAckV1;
}

export function parseOwnershipTransferRequest(value: unknown, runId: string): OwnershipTransferRequestV1 | null {
	return parseOwnershipTransferBase(value, runId, "request") as OwnershipTransferRequestV1 | null;
}

export function parseOwnershipTransferAck(value: unknown, runId: string): OwnershipTransferAckV1 | null {
	return parseOwnershipTransferBase(value, runId, "ack") as OwnershipTransferAckV1 | null;
}

export function sameOwnershipTransfer(request: OwnershipTransferRequestV1, ack: OwnershipTransferAckV1): boolean {
	return request.transferId === ack.transferId && request.runId === ack.runId
		&& request.allocation.digest === ack.allocation.digest && request.parent.pid === ack.parent.pid && request.parent.startedAt === ack.parent.startedAt
		&& request.child.pid === ack.child.pid && request.child.startedAt === ack.child.startedAt;
}

export interface DetachedOwnershipRecordV1 {
	contract: "pi-subagent.detached-ownership";
	version: 1;
	runId: string;
	owner: "user";
	detachedAt: number;
	allocation: { algorithm: "sha256"; digest: string };
}

/** Strict parser for the public detached ownership v1 marker. */
export function parseDetachedOwnershipRecord(value: unknown, runId: string): DetachedOwnershipRecordV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["contract", "version", "runId", "owner", "detachedAt", "allocation"])) return null;
	if (value.contract !== "pi-subagent.detached-ownership" || value.version !== 1 || value.runId !== runId || !isSafeRunId(value.runId)
		|| value.owner !== "user" || !Number.isSafeInteger(value.detachedAt) || (value.detachedAt as number) <= 0
		|| !isRecord(value.allocation)
		|| !hasExactKeys(value.allocation, ["algorithm", "digest"]) || value.allocation.algorithm !== "sha256"
		|| typeof value.allocation.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.allocation.digest)) return null;
	return value as unknown as DetachedOwnershipRecordV1;
}

export interface RunArtifactPaths {
	rootDir: string;
	runDir: string;
	/** Non-secret immutable authority markers; never copied or replaced. */
	rootMarkerPath: string;
	runMarkerPath: string;
	taskPath: string;
	systemPromptPath: string;
	childSessionPath: string;
	/** Transient 0600 lifecycle capability bootstrap; consumed and unlinked by the child. */
	lifecycleTokenPath: string;
	/** Immutable tmux control-mode selection evidence, when the V3 branch is used. */
	transportGatePath: string;
	/** V2 committed launch record. */
	launchPath: string;
	launchIntentPath: string;
	allocationPath: string;
	decisionPath: string;
	launchGatePath: string;
	brokerClaimPath: string;
	residualRiskPath: string;
	/** Exact allocation retained after pane.send_text was dispatched but unacknowledged. */
	launchDeliveryUnknownPath: string;
	brokerStatusPath: string;
	/** Public immutable detached-ownership v1 authority; excludes the target from reaping. */
	detachedOwnershipPath: string;
	/** Private immutable request/ack pair for a live child ownership transfer. */
	promotionRequestPath: string;
	promotionAckPath: string;
	/** Legacy private read-only ownership marker; retained only for compatibility. */
	userOwnershipPath: string;
	statePath: string;
	completionPath: string;
	/** Immutable child completion fence and parent acknowledgement. */
	completionFencePath: string;
	completionFenceAckPath: string;
	parentLeasePath: string;
	wrapperStatusPath: string;
	stderrPath: string;
	wrapperPath: string;
	secretEnvPath: string;
	/** Empty private HOME/ZDOTDIR used while tmux starts its configured shell. */
	shellHomePath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSafeRunId(runId: unknown): runId is string {
	return typeof runId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId);
}

function assertRunId(runId: string): void {
	if (!isSafeRunId(runId)) {
		throw new Error(`Invalid subagent run id: ${JSON.stringify(runId)}`);
	}
}

export function createRunId(): string {
	return crypto.randomUUID();
}

function isPrivateOwnedDirectorySync(directory: string): boolean {
	try {
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
		return process.platform === "win32" || (stat.mode & 0o777) === 0o700;
	} catch {
		return false;
	}
}

function hasValidStateRootMarkerSync(root: string): boolean {
	try {
		if (!isPrivateOwnedDirectorySync(root)) return false;
		const markerPath = path.join(root, STATE_ROOT_MARKER_NAME);
		const stat = fs.lstatSync(markerPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return false;
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
		if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) return false;
		const text = fs.readFileSync(markerPath, "utf8");
		if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) return false;
		const value = JSON.parse(text.slice(0, -1)) as unknown;
		return isRecord(value)
			&& hasExactKeys(value, ["version", "kind"])
			&& value.version === 1
			&& value.kind === "pi-subagent-state-root";
	} catch {
		return false;
	}
}

function hasPrivateMarkerlessLegacyState(defaultRoot: string): boolean {
	try {
		if (!isPrivateOwnedDirectorySync(defaultRoot)) return false;
		if (fs.existsSync(path.join(defaultRoot, STATE_ROOT_MARKER_NAME))) return false;
		const entries = fs.readdirSync(defaultRoot);
		if (entries.some((name) => name.startsWith(`.${STATE_ROOT_MARKER_NAME}.`) && name.endsWith(".tmp"))) return false;
		return entries.length > 0;
	} catch {
		return false;
	}
}

export function selectDefaultRunStateRoot(defaultRoot: string): string {
	const resolved = path.resolve(defaultRoot);
	if (!hasPrivateMarkerlessLegacyState(resolved)) return resolved;
	// A previous migration fallback can itself predate root markers or lose its
	// marker while retaining private recovery artifacts. Preserve it untouched
	// and advance deterministically instead of making the extension unloadable.
	for (let generation = 1; ; generation += 1) {
		const fallback = `${resolved}-owned-v1${generation === 1 ? "" : `-${generation}`}`;
		if (hasValidStateRootMarkerSync(fallback) || !hasPrivateMarkerlessLegacyState(fallback)) return fallback;
	}
}

export function getRunStateRoot(baseEnv: NodeJS.ProcessEnv = process.env): string {
	const configured = baseEnv[RUN_STATE_DIR_ENV]?.trim();
	if (configured) return path.resolve(configured);
	const uidSuffix = typeof process.getuid === "function" ? `-${process.getuid()}` : "";
	return selectDefaultRunStateRoot(path.join(os.tmpdir(), `pi-subagent-runs${uidSuffix}`));
}

export async function isPrivateOwnedDirectory(directory: string): Promise<boolean> {
	try {
		const stat = await fs.promises.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
		if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) return false;
		return true;
	} catch {
		return false;
	}
}

async function assertSafeAncestorChain(directory: string, canonical: boolean): Promise<void> {
	const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
	const checked = canonical ? await fs.promises.realpath(directory) : path.resolve(directory);
	const parts = checked.split(path.sep).filter(Boolean);
	let current = path.parse(checked).root;
	for (const part of parts) {
		current = path.join(current, part);
		const stat = await fs.promises.lstat(current).catch(() => null);
		if (!stat) break; // remaining components will be created privately below.
		if (stat.isSymbolicLink()) {
			// System aliases such as /var -> /private/var are safe only when the
			// link itself is root-owned and its already-checked parent is not writable.
			if (stat.uid !== 0) throw new Error(`Subagent state ancestor is a symlink: ${current}`);
			continue;
		}
		if (!stat.isDirectory()) throw new Error(`Subagent state ancestor is not a directory: ${current}`);
		if (process.platform !== "win32" && (stat.mode & 0o022) !== 0) {
			// A root-owned sticky directory (notably the system temp root) prevents
			// other users from replacing our entry. Other writable ancestors do not.
			if (!((stat.mode & 0o1000) !== 0 && (uid === undefined || stat.uid !== uid))) {
				throw new Error(`Subagent state ancestor is group/other writable: ${current}`);
			}
		}
	}
}

async function assertPrivateStateRootDirectory(directory: string): Promise<void> {
	directory = path.resolve(directory);
	const configured = await fs.promises.lstat(directory);
	if (configured.isSymbolicLink()) throw new Error(`Subagent state root must not be a symlink: ${directory}`);
	await assertSafeAncestorChain(directory, false);
	await assertSafeAncestorChain(directory, true);
	if (!await isPrivateOwnedDirectory(directory)) throw new Error(`Subagent state path is not a private directory: ${directory}`);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function readOwnershipMarker(filePath: string, expected: Record<string, unknown>): Promise<boolean> {
	try {
		const stat = await fs.promises.lstat(filePath);
		if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600)) return false;
		const text = await fs.promises.readFile(filePath, "utf8");
		if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) return false;
		const value: unknown = JSON.parse(text.slice(0, -1));
		return isRecord(value) && hasExactKeys(value, Object.keys(expected)) && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
	} catch { return false; }
}

async function publishOwnershipMarker(directory: string, name: string, value: Record<string, unknown>): Promise<void> {
	const filePath = path.join(directory, name);
	const temporaryPath = path.join(directory, `.${name}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
		await handle.close(); handle = undefined;
		try { await fs.promises.link(temporaryPath, filePath); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
		await fsyncDirectory(directory);
	}
	if (!await readOwnershipMarker(filePath, value)) throw new Error(`Subagent ownership marker is missing or invalid: ${filePath}`);
}

/** Validate both lexical/canonical ancestry and the immutable root boundary. */
export async function assertSafeStateRoot(directory: string): Promise<void> {
	directory = path.resolve(directory);
	await assertPrivateStateRootDirectory(directory);
	if (!await readOwnershipMarker(path.join(directory, STATE_ROOT_MARKER_NAME), { version: 1, kind: "pi-subagent-state-root" })) {
		throw new Error(`Subagent state root ownership marker is missing or invalid: ${directory}`);
	}
}

/** Revalidate root/run containment and both immutable ownership markers before mutation. */
export async function assertSafeRunArtifactPaths(paths: Pick<RunArtifactPaths, "rootDir" | "runDir">): Promise<void> {
	await assertSafeStateRoot(paths.rootDir);
	if (!await isPrivateOwnedDirectory(paths.runDir)) throw new Error(`Subagent run directory is not private: ${paths.runDir}`);
	const [canonicalRoot, canonicalRun] = await Promise.all([fs.promises.realpath(paths.rootDir), fs.promises.realpath(paths.runDir)]);
	if (path.dirname(canonicalRun) !== canonicalRoot) throw new Error(`Subagent run directory escaped its state root: ${paths.runDir}`);
	const runId = path.basename(paths.runDir);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || !await readOwnershipMarker(path.join(paths.runDir, RUN_DIRECTORY_MARKER_NAME), { version: 1, kind: "pi-subagent-run-directory", runId })) {
		throw new Error(`Subagent run directory ownership marker is missing or invalid: ${paths.runDir}`);
	}
}

async function assertSafeExistingAncestorChains(directory: string): Promise<void> {
	const lexical = path.resolve(directory);
	await assertSafeAncestorChain(lexical, false);
	// realpath only works for an existing component. Validate the canonical
	// chain before mkdir so an unsafe existing ancestor is never chmodded or
	// mutated by recursive creation.
	let existing = lexical;
	while (true) {
		try {
			await fs.promises.lstat(existing);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			existing = parent;
		}
	}
	await assertSafeAncestorChain(await fs.promises.realpath(existing), true);
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
	directory = path.resolve(directory);
	let existed = false;
	try {
		await fs.promises.lstat(directory);
		existed = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existed) {
		// Existing roots are authority boundaries. Validate them as-is; never
		// repair their mode with chmod because that mutates an untrusted path.
		await assertPrivateStateRootDirectory(directory);
		const markerPath = path.join(directory, STATE_ROOT_MARKER_NAME);
		try {
			await fs.promises.lstat(markerPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			// Marker-less roots are legacy/untrusted. Only an empty, already-private
			// directory can be initialized; a populated root is retained untouched.
			if ((await fs.promises.readdir(directory)).length !== 0) {
				throw new Error(`Subagent state root ownership marker is missing from nonempty root: ${directory}`);
			}
			await publishOwnershipMarker(directory, STATE_ROOT_MARKER_NAME, { version: 1, kind: "pi-subagent-state-root" });
		}
		await assertSafeStateRoot(directory);
		return;
	}
	await assertSafeExistingAncestorChains(directory);
	await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.promises.lstat(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Subagent state root must be a directory: ${directory}`);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Subagent state directory is owned by a different user: ${directory}`);
	// The path was absent when validated and is revalidated immediately after
	// creation before its private mode is enforced.
	await assertSafeAncestorChain(directory, false);
	await assertSafeAncestorChain(directory, true);
	await fs.promises.chmod(directory, 0o700);
	await publishOwnershipMarker(directory, STATE_ROOT_MARKER_NAME, { version: 1, kind: "pi-subagent-state-root" });
	await assertSafeStateRoot(directory);
}

/** Initialize or validate the shared private state root without creating a run. */
export async function ensureRunStateRoot(rootDir = getRunStateRoot()): Promise<string> {
	const resolved = path.resolve(rootDir);
	await ensurePrivateDirectory(resolved);
	return await fs.promises.realpath(resolved);
}

export function resolveRunArtifactPaths(runId: string, rootDir = getRunStateRoot()): RunArtifactPaths {
	assertRunId(runId);
	rootDir = path.resolve(rootDir);
	const runDir = path.join(rootDir, runId);
	if (path.dirname(runDir) !== rootDir) throw new Error("Subagent run directory escaped its state root.");
	return {
		rootDir,
		runDir,
		rootMarkerPath: path.join(rootDir, STATE_ROOT_MARKER_NAME),
		runMarkerPath: path.join(runDir, RUN_DIRECTORY_MARKER_NAME),
		taskPath: path.join(runDir, "task.md"),
		systemPromptPath: path.join(runDir, "system-prompt.md"),
		childSessionPath: path.join(runDir, "child-session.jsonl"),
		lifecycleTokenPath: path.join(runDir, "lifecycle-token"),
		transportGatePath: path.join(runDir, "transport-gate.json"),
		launchPath: path.join(runDir, "launch.json"),
		launchIntentPath: path.join(runDir, "launch-intent.json"),
		allocationPath: path.join(runDir, "allocation.json"),
		decisionPath: path.join(runDir, "decision.json"),
		launchGatePath: path.join(runDir, "launch.gate"),
		brokerClaimPath: path.join(runDir, "broker-claim.json"),
		residualRiskPath: path.join(runDir, "residual-risk.json"),
		launchDeliveryUnknownPath: path.join(runDir, "launch-delivery-unknown.json"),
		brokerStatusPath: path.join(runDir, "broker-status.json"),
		detachedOwnershipPath: path.join(runDir, "detached-ownership.json"),
		promotionRequestPath: path.join(runDir, "promotion-request.json"),
		promotionAckPath: path.join(runDir, "promotion-ack.json"),
		userOwnershipPath: path.join(runDir, "user-ownership.json"),
		statePath: path.join(runDir, "state.json"),
		completionPath: path.join(runDir, "complete.json"),
		completionFencePath: path.join(runDir, "completion-fence.json"),
		completionFenceAckPath: path.join(runDir, "completion-fence-ack.json"),
		parentLeasePath: path.join(runDir, "parent-lease.json"),
		wrapperStatusPath: path.join(runDir, "wrapper-status"),
		stderrPath: path.join(runDir, "stderr.log"),
		wrapperPath: path.join(runDir, "cmux-wrapper.sh"),
		secretEnvPath: path.join(runDir, "secret-env.sh"),
		shellHomePath: path.join(runDir, "shell-home"),
	};
}

export async function prepareRunArtifactPaths(options: {
	runId?: string;
	rootDir?: string;
	/** Optional owner proof published before this function returns. */
	initialParentLease?: { parentPid: number; parentStartedAt: number; renewedAt?: number };
} = {}): Promise<RunArtifactPaths> {
	const runId = options.runId ?? createRunId();
	const paths = resolveRunArtifactPaths(runId, options.rootDir ?? getRunStateRoot());
	await ensurePrivateDirectory(paths.rootDir);
	await fs.promises.mkdir(paths.runDir, { recursive: false, mode: 0o700 });
	await fs.promises.chmod(paths.runDir, 0o700);
	if (!await isPrivateOwnedDirectory(paths.runDir)) throw new Error(`Subagent run directory is not private: ${paths.runDir}`);
	const [canonicalRoot, canonicalRun] = await Promise.all([fs.promises.realpath(paths.rootDir), fs.promises.realpath(paths.runDir)]);
	if (path.dirname(canonicalRun) !== canonicalRoot) throw new Error(`Subagent run directory escaped its state root: ${paths.runDir}`);
	await publishOwnershipMarker(paths.runDir, RUN_DIRECTORY_MARKER_NAME, { version: 1, kind: "pi-subagent-run-directory", runId });
	await assertSafeRunArtifactPaths(paths);
	if (options.initialParentLease) {
		const lease: ParentLeaseV1 = { version: RUN_PROTOCOL_VERSION, runId, parentPid: options.initialParentLease.parentPid,
			parentStartedAt: options.initialParentLease.parentStartedAt, renewedAt: options.initialParentLease.renewedAt ?? Date.now() };
		if (!parseParentLease(lease, runId, lease.renewedAt)) throw new Error("Invalid initial parent lease identity.");
		await atomicWriteJson(paths.parentLeasePath, lease);
	}
	// tmux must start its configured shell before it can exec the staged broker.
	// Keep all shell startup files out of the project and persist the empty HOME.
	await fs.promises.mkdir(paths.shellHomePath, { recursive: false, mode: 0o700 });
	await fs.promises.chmod(paths.shellHomePath, 0o700);
	if (!await isPrivateOwnedDirectory(paths.shellHomePath)) throw new Error(`Subagent shell home is not private: ${paths.shellHomePath}`);
	await fsyncDirectory(paths.runDir);
	return paths;
}

async function fsyncDirectory(directory: string): Promise<void> {
	// Some filesystems/platforms do not permit directory fsync. Durability is
	// best-effort there, while the artifact file itself is always synced.
	await fs.promises.open(directory, "r").then(async (handle) => {
		try { await handle.sync(); } finally { await handle.close(); }
	}).catch(() => undefined);
}

async function writePrivateArtifact(filePath: string, content: string, mode: number): Promise<void> {
	const directory = path.dirname(filePath);
	await assertSafeRunArtifactPaths({ rootDir: path.dirname(directory), runDir: directory });
	const parent = await fs.promises.lstat(directory);
	if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(`Refusing artifact write through unsafe directory: ${directory}`);
	// Initial private artifacts are authority inputs. Never follow or replace a
	// pre-existing pathname which could have been planted between preparation and write.
	const handle = await fs.promises.open(filePath, "wx", mode);
	try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
	const stat = await fs.promises.lstat(filePath);
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Private artifact was replaced during write: ${filePath}`);
	await fs.promises.chmod(filePath, mode);
	await fsyncDirectory(directory);
}

export async function writePrivateFile(filePath: string, content: string): Promise<void> {
	await writePrivateArtifact(filePath, content, 0o600);
}

/** Synchronously durable, no-replace executable wrapper publication. */
export async function writePrivateExecutableFile(filePath: string, content: string): Promise<void> {
	await writePrivateArtifact(filePath, content, 0o700);
}

/** Replaceable artifact write: synced temp + rename + best-effort directory fsync. */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	const directory = path.dirname(filePath);
	await assertSafeRunArtifactPaths({ rootDir: path.dirname(directory), runDir: directory });
	const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
		await handle.close(); handle = undefined;
		await fs.promises.rename(temporaryPath, filePath);
		await fs.promises.chmod(filePath, 0o600);
	} finally {
		await handle?.close().catch(() => undefined);
		await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
		await fsyncDirectory(directory);
	}
}

export async function readJsonFile(filePath: string): Promise<unknown | null> {
	try {
		return JSON.parse(await fs.promises.readFile(filePath, "utf-8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

const DEFAULT_BOUNDED_PRIVATE_JSON_MAX_BYTES = 256 * 1024;

export interface ReadBoundedPrivateJsonOptions {
	maxBytes?: number;
	/** Immutable broker records are exactly one LF-terminated JSON line. */
	requireSingleLineTerminated?: boolean;
}

function isPrivateRunArtifact(stat: fs.Stats): boolean {
	return stat.isFile() && !stat.isSymbolicLink()
		&& (typeof process.getuid !== "function" || stat.uid === process.getuid())
		&& (process.platform === "win32" || (stat.mode & 0o777) === 0o600);
}

function isSameArtifactIdentity(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

/**
 * Read one small run-private JSON artifact from a stable no-follow descriptor.
 * Any unsafe, malformed, changed, or inaccessible artifact fails closed.
 */
export async function readBoundedPrivateJson(filePath: string, options: ReadBoundedPrivateJsonOptions = {}): Promise<unknown | null> {
	const maxBytes = options.maxBytes ?? DEFAULT_BOUNDED_PRIVATE_JSON_MAX_BYTES;
	const requiredOpenFlags = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
	if (!path.isAbsolute(filePath) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !fs.constants.O_NOFOLLOW || !fs.constants.O_NONBLOCK) return null;
	const resolvedPath = path.resolve(filePath);
	const directory = path.dirname(resolvedPath);
	let handle: fs.promises.FileHandle | undefined;
	try {
		await assertSafeRunArtifactPaths({ rootDir: path.dirname(directory), runDir: directory });
		handle = await fs.promises.open(resolvedPath, fs.constants.O_RDONLY | requiredOpenFlags);
		const before = await handle.stat();
		if (!isPrivateRunArtifact(before) || !Number.isSafeInteger(before.size) || before.size < 1 || before.size > maxBytes) return null;

		const bytes = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < bytes.length) {
			const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (bytesRead <= 0) return null;
			offset += bytesRead;
		}

		const [after, pathname] = await Promise.all([handle.stat(), fs.promises.lstat(resolvedPath)]);
		if (!isPrivateRunArtifact(after) || !isPrivateRunArtifact(pathname)
			|| !isSameArtifactIdentity(before, after) || !isSameArtifactIdentity(before, pathname)) return null;
		await assertSafeRunArtifactPaths({ rootDir: path.dirname(directory), runDir: directory });
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (options.requireSingleLineTerminated) {
			if (!text.endsWith("\n") || text.slice(0, -1).includes("\n")) return null;
			return JSON.parse(text.slice(0, -1));
		}
		return JSON.parse(text);
	} catch {
		return null;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** Only wrapper-owned, canonical PID temporary status files are removable. */
export function isWrapperStatusTemporaryArtifactName(name: string): boolean {
	const match = /^wrapper-status\.tmp\.([1-9][0-9]*)$/.exec(name);
	if (!match) return false;
	const processId = Number(match[1]);
	return Number.isSafeInteger(processId) && processId > 0 && String(processId) === match[1];
}

/**
 * Remove abandoned wrapper status temporaries without treating a caller-provided
 * pattern as authority. The run directory is revalidated before enumeration,
 * and only exact regular-file names produced by the wrapper are unlinked.
 */
export async function removeWrapperStatusTemporaryArtifacts(paths: Pick<RunArtifactPaths, "rootDir" | "runDir">): Promise<void> {
	await assertSafeRunArtifactPaths(paths);
	const entries = await fs.promises.readdir(paths.runDir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile() || !isWrapperStatusTemporaryArtifactName(entry.name)) continue;
		const temporaryPath = path.join(paths.runDir, entry.name);
		const stat = await fs.promises.lstat(temporaryPath).catch(() => null);
		if (!stat?.isFile() || stat.isSymbolicLink()) continue;
		await fs.promises.unlink(temporaryPath).catch(() => undefined);
	}
}

export function parseLaunchRecord(value: unknown, expectedRunId?: string): LaunchRecordV1 | null {
	if (!isRecord(value)) return null;
	if (value.version !== RUN_PROTOCOL_VERSION || typeof value.runId !== "string") return null;
	if (expectedRunId !== undefined && value.runId !== expectedRunId) return null;
	if (value.ownership !== "parent-owned" && value.ownership !== "detached") return null;
	if (value.terminalMode !== "cmux-pane" && value.terminalMode !== "tmux-pane") return null;
	for (const key of ["parentSessionId", "childSessionFile"] as const) {
		if (typeof value[key] !== "string" || !(value[key] as string).trim()) return null;
	}
	if (value.terminalMode === "cmux-pane") {
		if (typeof value.cmuxWorkspaceId !== "string" || !value.cmuxWorkspaceId.trim()) return null;
		if (typeof value.cmuxSurfaceId !== "string" || !value.cmuxSurfaceId.trim()) return null;
	} else {
		if (typeof value.tmuxPaneId !== "string" || !/^%\d+$/.test(value.tmuxPaneId)) return null;
		if (!Number.isSafeInteger(value.tmuxServerPid) || (value.tmuxServerPid as number) <= 0) return null;
		if (!Number.isSafeInteger(value.tmuxPanePid) || (value.tmuxPanePid as number) <= 0) return null;
	}
	if (!path.isAbsolute(value.childSessionFile as string)) return null;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
	return value as unknown as LaunchRecordV1;
}

export function parseRunState(value: unknown, expectedRunId?: string): RunStateV1 | null {
	if (!isRecord(value)) return null;
	if (value.version !== RUN_PROTOCOL_VERSION || typeof value.runId !== "string") return null;
	if (expectedRunId !== undefined && value.runId !== expectedRunId) return null;
	if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) return null;
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
	if (value.childPid !== undefined && !pid(value.childPid)) return null;
	if (value.childStartedAt !== undefined && !positive(value.childStartedAt)) return null;
	if ((value.childPid === undefined) !== (value.childStartedAt === undefined)) return null;
	const phases: RunPhase[] = ["starting", "idle", "running", "settled", "shutting-down", "shutdown", "failed", "orphaned"];
	if (!phases.includes(value.phase as RunPhase)) return null;
	return value as unknown as RunStateV1;
}

export function parseCompletionRecord(value: unknown, expectedRunId?: string): CompletionRecordV1 | null {
	if (!isRecord(value)) return null;
	if (value.version !== RUN_PROTOCOL_VERSION || typeof value.runId !== "string") return null;
	if (expectedRunId !== undefined && value.runId !== expectedRunId) return null;
	if (!["completed", "failed", "aborted", "orphaned"].includes(String(value.status))) return null;
	if (typeof value.completedAt !== "number" || !Number.isFinite(value.completedAt)) return null;
	if (typeof value.childSessionFile !== "string" || !path.isAbsolute(value.childSessionFile)) return null;
	return value as unknown as CompletionRecordV1;
}

export function parseParentLease(value: unknown, expectedRunId?: string, now = Date.now()): ParentLeaseV1 | null {
	if (!isRecord(value)) return null;
	if (value.version !== RUN_PROTOCOL_VERSION || typeof value.runId !== "string") return null;
	if (expectedRunId !== undefined && value.runId !== expectedRunId) return null;
	if (!Number.isSafeInteger(value.parentPid) || (value.parentPid as number) <= 0) return null;
	if (typeof value.parentStartedAt !== "number" || !Number.isFinite(value.parentStartedAt)) return null;
	if (typeof value.renewedAt !== "number" || !Number.isFinite(value.renewedAt) || value.renewedAt > now + MAX_PARENT_LEASE_FUTURE_MS) return null;
	return value as unknown as ParentLeaseV1;
}

function isCompletionFenceNonce(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function parseCompletionFence(value: unknown, runId: string, nonce: string): CompletionFenceV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "kind", "runId", "nonce", "publishedAt"])
		|| value.version !== 1 || value.kind !== "completion-fence" || value.runId !== runId || !isSafeRunId(value.runId)
		|| value.nonce !== nonce || !isCompletionFenceNonce(value.nonce)
		|| !Number.isSafeInteger(value.publishedAt) || (value.publishedAt as number) <= 0) return null;
	return value as unknown as CompletionFenceV1;
}

export function parseCompletionFenceAck(value: unknown, runId: string, nonce: string): CompletionFenceAckV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "kind", "runId", "nonce", "acknowledgedAt"])
		|| value.version !== 1 || value.kind !== "completion-fence-ack" || value.runId !== runId || !isSafeRunId(value.runId)
		|| value.nonce !== nonce || !isCompletionFenceNonce(value.nonce)
		|| !Number.isSafeInteger(value.acknowledgedAt) || (value.acknowledgedAt as number) <= 0) return null;
	return value as unknown as CompletionFenceAckV1;
}

export function isParentLeaseStale(
	lease: ParentLeaseV1,
	now = Date.now(),
	staleAfterMs = DEFAULT_PARENT_LEASE_STALE_MS,
): boolean {
	return lease.renewedAt > now + MAX_PARENT_LEASE_FUTURE_MS || now - lease.renewedAt > staleAfterMs;
}

export interface ProcessIdentity {
	startedAt: number;
	isZombie: boolean;
}

// These are the only OS state families that can execute, sleep, or be stopped.
// Z and X/x are terminal, and an unfamiliar state is not PID liveness authority.
const LINUX_LIVE_PROCESS_STATES = new Set(["R", "S", "D", "I", "T", "t"]);
const DARWIN_LIVE_PROCESS_STATES = new Set(["R", "S", "D", "I", "T", "U"]);
const DARWIN_STAT_MODIFIERS = /^[<NLs+]*$/;
const DARWIN_LSTART = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:[1-9]|0[1-9]|[12][0-9]|3[01]) [0-2][0-9]:[0-5][0-9]:[0-5][0-9] [0-9]{4}$/;

/** Parse Linux /proc/<pid>/stat without trusting a PID-only liveness probe. */
export function parseLinuxProcessIdentity(stat: string): ProcessIdentity | null {
	const open = stat.indexOf("(");
	const close = stat.lastIndexOf(")");
	const processId = Number(stat.slice(0, open).trim());
	if (open <= 0 || close <= open || !Number.isSafeInteger(processId) || processId <= 0) return null;
	const fields = stat.slice(close + 1).trim().split(/\s+/);
	const state = fields[0]; // field 3, after pid/comm
	const startedAtText = fields[19]; // field 22, after pid/comm
	if (!state || !LINUX_LIVE_PROCESS_STATES.has(state) || !startedAtText || !/^[1-9][0-9]*$/.test(startedAtText)) return null;
	const startedAt = Number(startedAtText);
	if (!Number.isSafeInteger(startedAt)) return null;
	return { startedAt, isZombie: false };
}

/** Parse `ps -o stat= -o lstart=` output. */
export function parseDarwinProcessIdentity(output: string): ProcessIdentity | null {
	const [stat, ...startedAtFields] = output.trim().split(/\s+/);
	const state = stat?.[0];
	const startedAtText = startedAtFields.join(" ");
	if (!stat || !state || !DARWIN_LIVE_PROCESS_STATES.has(state) || !DARWIN_STAT_MODIFIERS.test(stat.slice(1)) || !DARWIN_LSTART.test(startedAtText)) return null;
	// ps lstart has no zone. Canonicalize it as UTC so a broker/controller
	// pair with different TZ environments still binds the same process.
	const startedAt = Date.parse(`${startedAtText} UTC`);
	if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
	return { startedAt, isZombie: false };
}

const DEFAULT_DARWIN_PROCESS_IDENTITY_PROBE_TIMEOUT_MS = 1_000;
const DARWIN_PROCESS_IDENTITY_PROBE_MAX_BUFFER = 8 * 1024;

export interface ProcessIdentityProbeOptions {
	/** Bound a Darwin /bin/ps probe; invalid or exhausted budgets fail closed. */
	timeoutMs?: number;
}

function resolveDarwinProcessIdentityProbeTimeout(options: ProcessIdentityProbeOptions = {}): number | null {
	const timeoutMs = options.timeoutMs ?? DEFAULT_DARWIN_PROCESS_IDENTITY_PROBE_TIMEOUT_MS;
	return Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
}

function probeDarwinProcessIdentity(processId: number, options: ProcessIdentityProbeOptions = {}) {
	const timeout = resolveDarwinProcessIdentityProbeTimeout(options);
	if (timeout === null) return null;
	return spawnSync("/bin/ps", ["-o", "stat=", "-o", "lstart=", "-p", String(processId)], {
		encoding: "utf8", timeout, maxBuffer: DARWIN_PROCESS_IDENTITY_PROBE_MAX_BUFFER,
	});
}

function getProcessIdentity(processId: number): ProcessIdentity | null {
	if (!pid(processId)) return null;
	try {
		if (process.platform === "linux") return parseLinuxProcessIdentity(fs.readFileSync(`/proc/${processId}/stat`, "utf8"));
		if (process.platform === "darwin") {
			const probe = probeDarwinProcessIdentity(processId);
			return probe?.status === 0 && !probe.error ? parseDarwinProcessIdentity(String(probe.stdout)) : null;
		}
	} catch { /* dead or inaccessible process */ }
	return null;
}

/**
 * Return an OS-issued process start identity. On Linux the kernel's /proc
 * start-tick field is stable for a PID lifetime; macOS uses only absolute
 * /bin/ps. Unknown platforms fail closed rather than trusting a PID alone.
 */
export function getProcessStartedAt(processId: number): number | null {
	return getProcessIdentity(processId)?.startedAt ?? null;
}

export function isMatchingLiveProcessIdentity(identity: ProcessIdentity | null, expectedStartedAt: number): boolean {
	return identity !== null && !identity.isZombie && identity.startedAt === expectedStartedAt;
}

export type ParentProcessIdentityChecker = (parentPid: number, parentStartedAt: number) => boolean;
export type ProcessIdentityStatus = "live" | "dead" | "unknown";

/** Tri-state identity proof: probe/parse/permission uncertainty is never death. */
export function classifyParentProcessIdentity(
	parentPid: number,
	parentStartedAt: number,
	options: ProcessIdentityProbeOptions = {},
): ProcessIdentityStatus {
	if (!pid(parentPid) || !Number.isFinite(parentStartedAt) || parentStartedAt <= 0) return "unknown";
	try {
		if (process.platform === "linux") {
			let raw: string;
			try { raw = fs.readFileSync(`/proc/${parentPid}/stat`, "utf8"); }
			catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "dead" : "unknown"; }
			const identity = parseLinuxProcessIdentity(raw);
			if (identity) return identity.startedAt === parentStartedAt ? "live" : "dead";
			const close = raw.lastIndexOf(")");
			const state = close >= 0 ? raw.slice(close + 1).trim().split(/\s+/)[0] : undefined;
			return state === "Z" || state === "X" || state === "x" ? "dead" : "unknown";
		}
		if (process.platform === "darwin") {
			const probe = probeDarwinProcessIdentity(parentPid, options);
			if (!probe || probe.error) return "unknown";
			if (probe.status === 0) {
				const output = String(probe.stdout);
				const identity = parseDarwinProcessIdentity(output);
				if (identity) return identity.startedAt === parentStartedAt ? "live" : "dead";
				return /^\s*[ZXx]/.test(output) ? "dead" : "unknown";
			}
			try { process.kill(parentPid, 0); return "unknown"; }
			catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
		}
	} catch { return "unknown"; }
	return "unknown";
}

/** A matching PID/start identity must also be runnable; unknown is not alive authority. */
export const isParentProcessIdentityAlive: ParentProcessIdentityChecker = (parentPid, parentStartedAt) =>
	classifyParentProcessIdentity(parentPid, parentStartedAt) === "live";

export function getCurrentProcessStartedAt(): number | null {
	return getProcessStartedAt(process.pid);
}

export function isUsableParentLease(options: {
	lease: ParentLeaseV1 | null;
	now?: number;
	staleAfterMs?: number;
	parentPid?: number;
	parentStartedAt?: number;
	isProcessIdentityAlive?: ParentProcessIdentityChecker;
}): boolean {
	const { lease } = options;
	if (!lease || isParentLeaseStale(lease, options.now, options.staleAfterMs)) return false;
	if (options.parentPid !== undefined && (lease.parentPid !== options.parentPid || lease.parentStartedAt !== options.parentStartedAt)) return false;
	return (options.isProcessIdentityAlive ?? isParentProcessIdentityAlive)(lease.parentPid, lease.parentStartedAt);
}

export function startParentLeaseWriter(options: {
	filePath: string;
	runId: string;
	intervalMs?: number;
	parentPid?: number;
	parentStartedAt?: number;
	/** Wall clock used only for the durable renewedAt value. */
	now?: () => number;
	/** Test-only monotonic scheduling and I/O seams. */
	monotonicNow?: () => number;
	write?: (filePath: string, value: ParentLeaseV1) => Promise<void>;
	setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
	clearTimer?: (timer: NodeJS.Timeout) => void;
}): { renew: () => Promise<void>; stop: () => void; stopAndDrain: () => Promise<void> } {
	const intervalMs = Math.max(1, options.intervalMs ?? DEFAULT_PARENT_LEASE_RENEW_MS);
	const now = options.now ?? Date.now;
	const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
	const write = options.write ?? atomicWriteJson;
	const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
	const parentStartedAt = options.parentStartedAt ?? getCurrentProcessStartedAt();
	if (parentStartedAt === null) throw new Error("Unable to establish parent process start identity.");
	let stopped = false;
	let pending = false;
	let inFlight: Promise<void> | null = null;
	let timer: NodeJS.Timeout | undefined;
	const idleWaiters: Array<() => void> = [];
	const epoch = monotonicNow();
	let nextDue = epoch + intervalMs;

	const resolveIdle = () => {
		if (inFlight || pending) return;
		while (idleWaiters.length) idleWaiters.pop()!();
	};
	const drain = () => !inFlight && !pending ? Promise.resolve() : new Promise<void>((resolve) => idleWaiters.push(resolve));
	const schedule = () => {
		if (stopped) return;
		const current = monotonicNow();
		// Skip missed slots rather than replaying them. Remaining slots stay
		// anchored to the original monotonic epoch and therefore cannot drift.
		if (nextDue <= current) nextDue = epoch + (Math.floor((current - epoch) / intervalMs) + 1) * intervalMs;
		timer = setTimer(() => {
			timer = undefined;
			void requestRenew().catch(() => undefined);
			schedule();
		}, Math.max(0, nextDue - monotonicNow()));
		timer.unref?.();
	};
	const startWrite = (): Promise<void> => {
		const writeLease = async () => {
			if (stopped) return;
			await write(options.filePath, {
				version: RUN_PROTOCOL_VERSION,
				runId: options.runId,
				parentPid: options.parentPid ?? process.pid,
				parentStartedAt,
				renewedAt: now(),
			});
		};
		const current = writeLease();
		inFlight = current;
		void current.catch(() => undefined).finally(() => {
			if (inFlight !== current) return;
			inFlight = null;
			if (!stopped && pending) {
				pending = false;
				startWrite();
			} else {
				pending = false;
				resolveIdle();
			}
		});
		return current;
	};
	const requestRenew = (): Promise<void> => {
		if (stopped) return Promise.resolve();
		if (inFlight) {
			pending = true; // latest-pending only; never queue every missed tick.
			return drain();
		}
		return startWrite();
	};
	const stop = () => {
		if (stopped) return;
		stopped = true;
		pending = false;
		if (timer) { clearTimer(timer); timer = undefined; }
		resolveIdle();
	};
	schedule();
	return { renew: requestRenew, stop, stopAndDrain: async () => { stop(); await drain(); } };
}

export function scheduleRunArtifactCleanup(runDir: string, delaySeconds: number, deadline?: number): void {
	// A persisted completion/launch timestamp supplies an absolute deadline so
	// a process restart cannot grant an already-retained run a fresh TTL.
	const delayMs = Number.isFinite(deadline)
		? Math.max(0, deadline! - Date.now())
		: Math.max(0, delaySeconds) * 1000;
	const timer = setTimeout(() => {
		const paths = { rootDir: path.dirname(runDir), runDir };
		void assertSafeRunArtifactPaths(paths)
			.then(async () => {
				await removeWrapperStatusTemporaryArtifacts(paths);
				await fs.promises.rm(runDir, { recursive: true, force: true });
			})
			.catch(() => undefined);
	}, delayMs);
	timer.unref?.();
}

export async function removeRunArtifacts(paths: RunArtifactPaths): Promise<void> {
	await assertSafeRunArtifactPaths(paths);
	await removeWrapperStatusTemporaryArtifacts(paths);
	await fs.promises.rm(paths.runDir, { recursive: true, force: true });
	// Keep the private root in place to avoid a predictable-path preemption window.
}

// V2 detached broker protocol.  These parsers deliberately reject unknown keys:
// artifacts are command authority, not a forward-compatible configuration format.
export const CMUX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** UUID spelling is presentation; durable cmux authority compares case-insensitively. */
export function cmuxIdsEqual(left: unknown, right: unknown): boolean {
	return typeof left === "string" && typeof right === "string" && CMUX_UUID_RE.test(left) && CMUX_UUID_RE.test(right)
		&& left.toLowerCase() === right.toLowerCase();
}
export const TMUX_PANE_ID_RE = /^%(?:0|[1-9][0-9]*)$/;
export const TMUX_SESSION_ID_RE = /^\$(?:0|[1-9][0-9]*)$/;
export const TMUX_WINDOW_ID_RE = /^@(?:0|[1-9][0-9]*)$/;
type V2Mode = "cmux-pane" | "tmux-pane" | "herdr-pane";
/** Herdr IDs are opaque public protocol values, never shell/URL fragments. */
/** `protocol` is the immutable result of the exact pre-allocation ping gate. */
export type HerdrProtocolVersion = 19 | 20;
export type HerdrSocketGenerationV2 = { socketDev: string; socketIno: string };
/** Generation-less Herdr records are retained only for diagnostics, never mutation authority. */
export type HerdrSourceV2 = { socketPath: string; workspaceId: string; tabId: string; sourcePaneId: string; sourceTerminalId: string; protocol: HerdrProtocolVersion; generation?: HerdrSocketGenerationV2 };
export type CmuxSourceV2 = { workspaceId: string; sourceSurfaceId: string };
/** Immutable control-v2 connection generation, never a credential. */
export type CmuxControlTransportV2 = { transport: "cmux-control-v2"; socketPath: string; socketDev: string; socketIno: string; accessMode: string; apiVersion: 2; appVersion: string; identifyDigest: string; bootIdentity?: string };
/**
 * Socket device/inode values are decimal strings from bigint stat fields.
 * Numbers would silently lose identity precision on filesystems with wide IDs.
 */
export type TmuxGenerationV2 = { socketPath: string; socketDev: string; socketIno: string; serverStartedAt: number };
/** Missing generation denotes retained legacy V2 diagnostics, never mutation authority. */
export type TmuxSourceV2 = { socketPath?: string; sourcePaneId: string; sourcePanePid: number; serverPid: number; generation?: TmuxGenerationV2 };

/** The V2 layout policy selected by the parent coordinator. */
export type LayoutModeV2 = "auto" | "split";
export type PlacementV2 = "cmux-split" | "cmux-new-surface" | "tmux-split" | "tmux-new-window" | "herdr-split" | "herdr-new-tab";
export type CmuxSourceContainerV2 = { kind: "cmux-source"; workspaceId: string; sourceSurfaceId: string };
export type CmuxPaneContainerV2 = { kind: "cmux-pane"; workspaceId: string; paneId: string };
export type CmuxSourcePaneContainerV2 = { kind: "cmux-source-pane"; workspaceId: string; sourceSurfaceId: string; paneId: string };
export type TmuxSourcePaneContainerV2 = { kind: "tmux-source-pane"; socketPath?: string; serverPid: number; sessionId: string; windowId: string; paneId: string; panePid: number; generation?: TmuxGenerationV2 };
export type TmuxSessionContainerV2 = { kind: "tmux-session"; socketPath?: string; serverPid: number; sessionId: string; sourceWindowId: string; generation?: TmuxGenerationV2 };
export type HerdrSourceContainerV2 = { kind: "herdr-source"; workspaceId: string; tabId: string; paneId: string; terminalId: string };
export type HerdrWorkspaceContainerV2 = { kind: "herdr-workspace"; workspaceId: string };
export type HerdrTabContainerV2 = { kind: "herdr-tab"; workspaceId: string; tabId: string };
export type LayoutContainerV2 = CmuxSourceContainerV2 | CmuxPaneContainerV2 | CmuxSourcePaneContainerV2 | TmuxSourcePaneContainerV2 | TmuxSessionContainerV2 | HerdrSourceContainerV2 | HerdrWorkspaceContainerV2;
export type LayoutPlacementRequestV2 =
	| { layout: LayoutModeV2; placement: "cmux-split"; container: CmuxSourceContainerV2 }
	| { layout: "auto"; placement: "cmux-new-surface"; container: CmuxPaneContainerV2 | CmuxSourcePaneContainerV2 }
	| { layout: "split"; placement: "tmux-split"; container: TmuxSourcePaneContainerV2 }
	| { layout: "auto"; placement: "tmux-new-window"; container: TmuxSessionContainerV2 }
	| { layout: "split"; placement: "herdr-split"; container: HerdrSourceContainerV2 }
	| { layout: "auto"; placement: "herdr-new-tab"; container: HerdrWorkspaceContainerV2 };
export type CmuxAllocatedContainerV2 = { kind: "cmux-pane"; workspaceId: string; paneId: string };
export type TmuxAllocatedContainerV2 = { kind: "tmux-window"; socketPath?: string; serverPid: number; sessionId: string; windowId: string; paneId: string; panePid: number; generation?: TmuxGenerationV2 };
export type HerdrAllocatedContainerV2 = HerdrTabContainerV2;
export type AllocatedContainerV2 = CmuxAllocatedContainerV2 | TmuxAllocatedContainerV2 | HerdrAllocatedContainerV2;
export type LayoutAllocationFieldsV2 =
	| { layout: LayoutModeV2; placement: "cmux-split"; container: CmuxAllocatedContainerV2 }
	| { layout: "auto"; placement: "cmux-new-surface"; container: CmuxAllocatedContainerV2 }
	| { layout: "split"; placement: "tmux-split"; container: TmuxAllocatedContainerV2 }
	| { layout: "auto"; placement: "tmux-new-window"; container: TmuxAllocatedContainerV2 }
	| { layout: "split"; placement: "herdr-split"; container: HerdrAllocatedContainerV2 }
	| { layout: "auto"; placement: "herdr-new-tab"; container: HerdrAllocatedContainerV2 };

type LaunchIntentV2Base = { version: 2; runId: string; parentRunId?: string; parentSessionId: string; parentPid: number; parentStartedAt: number; childSessionFile: string; /** Exact normalized child cwd; absent only in retained legacy artifacts. */ workingDirectory?: string; createdAt: number; brokerNonce: string; runtimePath: string; runtimeInterpreterPath: string; backendPath: string; brokerEntrypoint: string };
type LegacyCmuxLaunchIntentV2 = LaunchIntentV2Base & { terminalMode: "cmux-pane"; source: CmuxSourceV2 };
type LegacyTmuxLaunchIntentV2 = LaunchIntentV2Base & { terminalMode: "tmux-pane"; source: TmuxSourceV2 };
type HerdrLaunchIntentV2 = LaunchIntentV2Base & { terminalMode: "herdr-pane"; source: HerdrSourceV2 };
type LayoutCmuxLaunchIntentV2 = LaunchIntentV2Base & { terminalMode: "cmux-pane"; source: CmuxSourceV2; control?: CmuxControlTransportV2 } & Extract<LayoutPlacementRequestV2, { placement: "cmux-split" | "cmux-new-surface" }>;
type LayoutTmuxLaunchIntentV2 = LaunchIntentV2Base & { terminalMode: "tmux-pane"; source: TmuxSourceV2 } & (
	| Extract<LayoutPlacementRequestV2, { placement: "tmux-split" }>
	| (Extract<LayoutPlacementRequestV2, { placement: "tmux-new-window" }> & { windowLabel: string })
);
type LayoutHerdrLaunchIntentV2 = LaunchIntentV2Base & { terminalMode: "herdr-pane"; source: HerdrSourceV2 } & (
	| Extract<LayoutPlacementRequestV2, { placement: "herdr-split" }>
	| (Extract<LayoutPlacementRequestV2, { placement: "herdr-new-tab" }> & { tabLabel: string })
);
/** Legacy cmux records without control are diagnostic-only and never production mutation authority. */
export type LaunchIntentV2 = LegacyCmuxLaunchIntentV2 | LegacyTmuxLaunchIntentV2 | HerdrLaunchIntentV2 | LayoutCmuxLaunchIntentV2 | LayoutTmuxLaunchIntentV2 | LayoutHerdrLaunchIntentV2;
export interface BrokerClaimV2 { version: 2; runId: string; brokerNonce: string; pid: number; brokerStartedAt?: number; claimedAt: number }
export interface ResidualRiskV2 { version: 2; runId: string; reason: "possible-unrecorded-allocation"; recordedAt: number }
/** Not an allocation-unknown quarantine: this binds the already recorded Herdr target. */
export interface LaunchDeliveryUnknownV2 { version: 2; runId: string; terminalMode: "herdr-pane"; allocationPath: string; recordedAt: number; }
type LegacyCmuxAllocationRecordV2 = { version: 2; runId: string; terminalMode: "cmux-pane"; target: { workspaceId: string; surfaceId: string; paneId: string }; allocatedAt: number };
type LegacyTmuxAllocationRecordV2 = { version: 2; runId: string; terminalMode: "tmux-pane"; target: { socketPath?: string; serverPid: number; paneId: string; panePid: number; generation?: TmuxGenerationV2 }; allocatedAt: number };
type HerdrAllocationRecordV2 = { version: 2; runId: string; terminalMode: "herdr-pane"; target: { socketPath: string; workspaceId: string; tabId: string; paneId: string; terminalId: string; protocol: HerdrProtocolVersion; generation?: HerdrSocketGenerationV2 }; allocatedAt: number };
type LayoutCmuxAllocationRecordV2 = LegacyCmuxAllocationRecordV2 & { control?: CmuxControlTransportV2 } & Extract<LayoutAllocationFieldsV2, { placement: "cmux-split" | "cmux-new-surface" }>;
type LayoutTmuxAllocationRecordV2 = LegacyTmuxAllocationRecordV2 & Extract<LayoutAllocationFieldsV2, { placement: "tmux-split" | "tmux-new-window" }>;
type LayoutHerdrAllocationRecordV2 = HerdrAllocationRecordV2 & Extract<LayoutAllocationFieldsV2, { placement: "herdr-split" | "herdr-new-tab" }>;
export type AllocationRecordV2 = LegacyCmuxAllocationRecordV2 | LegacyTmuxAllocationRecordV2 | HerdrAllocationRecordV2 | LayoutCmuxAllocationRecordV2 | LayoutTmuxAllocationRecordV2 | LayoutHerdrAllocationRecordV2;
export interface CommittedLaunchRecordV2 { version: 2; runId: string; terminalMode: V2Mode; allocationPath: string; childSessionFile: string; committedAt: number; ownership: "parent-owned" }
export type DecisionV2 =
	| { version: 2; runId: string; kind: "cancel"; decidedAt: number; reason: "parent-abort" | "ready-timeout" | "commit-timeout" }
	| { version: 2; runId: string; kind: "commit"; decidedAt: number; allocationPath: string; launchPath: string };
export type BrokerStatusV2 =
	| { version: 2; runId: string; writer: "broker"; pid: number; phase: "ready" | "committed"; updatedAt: number }
	| { version: 2; runId: string; writer: "broker"; pid: number; phase: "failed"; updatedAt: number; errorCode: "intent-invalid" | "allocation-failed" | "commit-failed" | "possible-unrecorded-allocation" | "launch-delivery-unknown" | "acceptance-handoff-unresolved" }
	| { version: 2; runId: string; writer: "parent"; phase: "failed"; updatedAt: number; errorCode: "possible-unrecorded-allocation" };
export type LaunchGateV2 =
	| { version: 2; runId: string; terminalMode: "cmux-pane" | "tmux-pane"; launchPath: string; publishedAt: number }
	| { version: 2; runId: string; terminalMode: "herdr-pane"; protocol: HerdrProtocolVersion; launchPath: string; publishedAt: number };
export type CompletionErrorCodeV2 = "child-error" | "bridge-error" | "lease-expired" | "surface-closed" | "parent-aborted" | "wrapper-exited" | "pane-missing" | "inspect-exhausted" | "reaper-cleanup-failed";
export interface CompletionRecordV2 { version: 2; runId: string; status: CompletionStatus; completedAt: number; errorCode?: CompletionErrorCodeV2 }
/** A digest-bound, LF-complete JSONL prefix. This shape is intentionally exact. */
export interface SessionBoundaryV3 { byteOffset: number; finalEntryId: string; digestAlgorithm: "sha256"; prefixDigest: string }
export interface CompletionSuccessV3 { version: 3; runId: string; producer: "child"; status: "completed"; completedAt: number; session: SessionBoundaryV3 }
export type ChildCompletionErrorCodeV3 = "child-error" | "bridge-error" | "lease-expired" | "surface-closed";
/** Legacy boundary-less V3 child failure, retained for existing writers/readers and rolling parents. */
export interface ChildFailureV3 { version: 3; runId: string; producer: "child"; status: "failed" | "aborted" | "orphaned"; completedAt: number; errorCode: ChildCompletionErrorCodeV3; stopReason: string | null }
/** A child failure may bind a generic complete JSONL prefix, without asserting successful completion. */
export interface ChildFailureWithSessionBoundaryV3 extends ChildFailureV3 { session: SessionBoundaryV3 }
export type ObserverCompletionErrorCodeV3 = ChildCompletionErrorCodeV3 | "child-exited" | "completion-boundary-unproven" | "parent-aborted" | "transport-lost";
export type CompletionEvidenceRefV3 = "launch" | "allocation" | "state" | "lease" | "wrapper-status" | "process-identity" | "target-snapshot";
/** Legacy boundary-less V3 parent/reaper failure, retained for existing writers/readers. */
export interface ObserverFailureV3 { version: 3; runId: string; producer: "parent" | "reaper"; status: "failed" | "aborted" | "orphaned"; completedAt: number; errorCode: ObserverCompletionErrorCodeV3; evidenceRefs: CompletionEvidenceRefV3[] }
/** An observer failure may bind a parent-verified generic complete JSONL prefix. */
export interface ObserverFailureWithSessionBoundaryV3 extends ObserverFailureV3 { session: SessionBoundaryV3 }
export type CompletionRecordV3 = CompletionSuccessV3 | ChildFailureV3 | ChildFailureWithSessionBoundaryV3 | ObserverFailureV3 | ObserverFailureWithSessionBoundaryV3;
export type CompletionRecord = CompletionRecordV2 | CompletionRecordV3;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function pid(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function containedPath(value: unknown, runDir: string, base: string): value is string {
	return typeof value === "string" && path.resolve(value) === path.join(runDir, base);
}
function validRun(value: Record<string, unknown>, expectedRunId?: string): boolean {
	return value.version === BROKER_PROTOCOL_VERSION && typeof value.runId === "string" && (!expectedRunId || value.runId === expectedRunId);
}

function hasOnlyOptionalKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	return Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => key in value);
}
function isCmuxControlTransport(value: unknown): value is CmuxControlTransportV2 {
	return isRecord(value) && hasOnlyOptionalKeys(value, ["transport", "socketPath", "socketDev", "socketIno", "accessMode", "apiVersion", "appVersion", "identifyDigest"], ["bootIdentity"])
		&& (value.bootIdentity === undefined || typeof value.bootIdentity === "string") && value.transport === "cmux-control-v2" && typeof value.socketPath === "string" && path.isAbsolute(value.socketPath)
		&& typeof value.socketDev === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketDev)
		&& typeof value.socketIno === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketIno)
		&& typeof value.accessMode === "string" && value.accessMode.length > 0 && value.apiVersion === 2
		&& typeof value.appVersion === "string" && isStableSemverAtLeast(value.appVersion, MINIMUM_CMUX_VERSION)
		&& typeof value.identifyDigest === "string" && /^[a-f0-9]{64}$/.test(value.identifyDigest);
}
function isHerdrPublicId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function isHerdrProtocol(value: unknown): value is HerdrProtocolVersion { return value === 19 || value === 20; }
function isHerdrSocketGeneration(value: unknown): value is HerdrSocketGenerationV2 {
	return isRecord(value) && exactKeys(value, ["socketDev", "socketIno"])
		&& typeof value.socketDev === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketDev)
		&& typeof value.socketIno === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketIno);
}
export function hasHerdrSocketGeneration(value: { generation?: HerdrSocketGenerationV2 } | null | undefined): value is { generation: HerdrSocketGenerationV2 } {
	return Boolean(value?.generation && isHerdrSocketGeneration(value.generation));
}
/** Bound parser keeps generation-less records visible for diagnosis; callers must reject them for mutation. */
function isHerdrSource(value: unknown): value is HerdrSourceV2 {
	return isRecord(value) && hasOnlyOptionalKeys(value, ["socketPath", "workspaceId", "tabId", "sourcePaneId", "sourceTerminalId", "protocol"], ["generation"])
		&& typeof value.socketPath === "string" && path.isAbsolute(value.socketPath) && path.normalize(value.socketPath) === value.socketPath
		&& isHerdrPublicId(value.workspaceId) && isHerdrPublicId(value.tabId) && isHerdrPublicId(value.sourcePaneId)
		&& isHerdrPublicId(value.sourceTerminalId) && isHerdrProtocol(value.protocol)
		&& (value.generation === undefined || isHerdrSocketGeneration(value.generation));
}
export function isValidHerdrTabLabel(value: unknown, runId: unknown): value is string {
	if (!isSafeRunId(runId) || typeof value !== "string" || Buffer.byteLength(value, "utf8") > 128) return false;
	const prefix = `pi-subagent:${runId}:`;
	const suffix = value.slice(prefix.length);
	return value.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(suffix);
}
export function buildHerdrTabLabel(agent: unknown, runId: string): string {
	const slug = String(agent).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "agent";
	const value = `pi-subagent:${runId}:${slug}`;
	if (!isValidHerdrTabLabel(value, runId)) throw new Error("Unable to build bounded Herdr tab label.");
	return value;
}
function isCmuxSource(value: unknown): value is CmuxSourceV2 {
	return isRecord(value) && exactKeys(value, ["workspaceId", "sourceSurfaceId"])
		&& typeof value.workspaceId === "string" && CMUX_UUID_RE.test(value.workspaceId)
		&& typeof value.sourceSurfaceId === "string" && CMUX_UUID_RE.test(value.sourceSurfaceId);
}
function isTmuxGeneration(value: unknown): value is TmuxGenerationV2 {
	return isRecord(value) && exactKeys(value, ["socketPath", "socketDev", "socketIno", "serverStartedAt"])
		&& typeof value.socketPath === "string" && path.isAbsolute(value.socketPath)
		&& typeof value.socketDev === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketDev)
		&& typeof value.socketIno === "string" && /^(?:0|[1-9][0-9]*)$/.test(value.socketIno) && positive(value.serverStartedAt);
}
export function hasTmuxGeneration(value: { generation?: TmuxGenerationV2 } | null | undefined): value is { generation: TmuxGenerationV2 } {
	return Boolean(value?.generation && isTmuxGeneration(value.generation));
}
function sameTmuxGeneration(left: TmuxGenerationV2 | undefined, right: TmuxGenerationV2 | undefined): boolean {
	return Boolean(left && right && left.socketPath === right.socketPath && left.socketDev === right.socketDev
		&& left.socketIno === right.socketIno && left.serverStartedAt === right.serverStartedAt);
}
function isTmuxSource(value: unknown): value is TmuxSourceV2 {
	return isRecord(value) && hasOnlyOptionalKeys(value, ["sourcePaneId", "sourcePanePid", "serverPid"], ["socketPath", "generation"])
		&& typeof value.sourcePaneId === "string" && TMUX_PANE_ID_RE.test(value.sourcePaneId)
		&& pid(value.sourcePanePid) && pid(value.serverPid)
		&& (value.socketPath === undefined || typeof value.socketPath === "string")
		&& (value.generation === undefined || isTmuxGeneration(value.generation));
}
function parseLayoutContainerV2(value: unknown): LayoutContainerV2 | null {
	if (!isRecord(value) || typeof value.kind !== "string") return null;
	if (value.kind === "cmux-source" && exactKeys(value, ["kind", "workspaceId", "sourceSurfaceId"])
		&& typeof value.workspaceId === "string" && CMUX_UUID_RE.test(value.workspaceId)
		&& typeof value.sourceSurfaceId === "string" && CMUX_UUID_RE.test(value.sourceSurfaceId)) return value as CmuxSourceContainerV2;
	if (value.kind === "cmux-pane" && exactKeys(value, ["kind", "workspaceId", "paneId"])
		&& typeof value.workspaceId === "string" && CMUX_UUID_RE.test(value.workspaceId)
		&& typeof value.paneId === "string" && CMUX_UUID_RE.test(value.paneId)) return value as CmuxPaneContainerV2;
	if (value.kind === "cmux-source-pane" && exactKeys(value, ["kind", "workspaceId", "sourceSurfaceId", "paneId"])
		&& typeof value.workspaceId === "string" && CMUX_UUID_RE.test(value.workspaceId)
		&& typeof value.sourceSurfaceId === "string" && CMUX_UUID_RE.test(value.sourceSurfaceId)
		&& typeof value.paneId === "string" && CMUX_UUID_RE.test(value.paneId)) return value as CmuxSourcePaneContainerV2;
	if (value.kind === "tmux-source-pane" && hasOnlyOptionalKeys(value, ["kind", "serverPid", "sessionId", "windowId", "paneId", "panePid"], ["socketPath", "generation"])
		&& pid(value.serverPid) && typeof value.sessionId === "string" && TMUX_SESSION_ID_RE.test(value.sessionId)
		&& typeof value.windowId === "string" && TMUX_WINDOW_ID_RE.test(value.windowId)
		&& typeof value.paneId === "string" && TMUX_PANE_ID_RE.test(value.paneId) && pid(value.panePid)
		&& (value.socketPath === undefined || typeof value.socketPath === "string") && (value.generation === undefined || isTmuxGeneration(value.generation))) return value as TmuxSourcePaneContainerV2;
	if (value.kind === "tmux-session" && hasOnlyOptionalKeys(value, ["kind", "serverPid", "sessionId", "sourceWindowId"], ["socketPath", "generation"])
		&& pid(value.serverPid) && typeof value.sessionId === "string" && TMUX_SESSION_ID_RE.test(value.sessionId)
		&& typeof value.sourceWindowId === "string" && TMUX_WINDOW_ID_RE.test(value.sourceWindowId)
		&& (value.socketPath === undefined || typeof value.socketPath === "string") && (value.generation === undefined || isTmuxGeneration(value.generation))) return value as TmuxSessionContainerV2;
	if (value.kind === "herdr-source" && exactKeys(value, ["kind", "workspaceId", "tabId", "paneId", "terminalId"])
		&& [value.workspaceId, value.tabId, value.paneId, value.terminalId].every(isHerdrPublicId)) return value as HerdrSourceContainerV2;
	if (value.kind === "herdr-workspace" && exactKeys(value, ["kind", "workspaceId"]) && isHerdrPublicId(value.workspaceId)) return value as HerdrWorkspaceContainerV2;
	return null;
}
function parseAllocatedContainerV2(value: unknown): AllocatedContainerV2 | null {
	if (!isRecord(value) || typeof value.kind !== "string") return null;
	if (value.kind === "cmux-pane" && exactKeys(value, ["kind", "workspaceId", "paneId"])
		&& typeof value.workspaceId === "string" && CMUX_UUID_RE.test(value.workspaceId)
		&& typeof value.paneId === "string" && CMUX_UUID_RE.test(value.paneId)) return value as CmuxAllocatedContainerV2;
	if (value.kind === "tmux-window" && hasOnlyOptionalKeys(value, ["kind", "serverPid", "sessionId", "windowId", "paneId", "panePid"], ["socketPath", "generation"])
		&& pid(value.serverPid) && typeof value.sessionId === "string" && TMUX_SESSION_ID_RE.test(value.sessionId)
		&& typeof value.windowId === "string" && TMUX_WINDOW_ID_RE.test(value.windowId)
		&& typeof value.paneId === "string" && TMUX_PANE_ID_RE.test(value.paneId) && pid(value.panePid)
		&& (value.socketPath === undefined || typeof value.socketPath === "string") && (value.generation === undefined || isTmuxGeneration(value.generation))) return value as TmuxAllocatedContainerV2;
	if (value.kind === "herdr-tab" && exactKeys(value, ["kind", "workspaceId", "tabId"])
		&& isHerdrPublicId(value.workspaceId) && isHerdrPublicId(value.tabId)) return value as HerdrAllocatedContainerV2;
	return null;
}
function hasValidLayoutIntentPlacement(terminalMode: unknown, layout: unknown, placement: unknown, container: LayoutContainerV2): boolean {
	return terminalMode === "cmux-pane"
		? placement === "cmux-split" && (layout === "auto" || layout === "split") && container.kind === "cmux-source"
			|| placement === "cmux-new-surface" && layout === "auto" && (container.kind === "cmux-pane" || container.kind === "cmux-source-pane")
		: terminalMode === "tmux-pane"
			? placement === "tmux-split" && layout === "split" && container.kind === "tmux-source-pane"
				|| placement === "tmux-new-window" && layout === "auto" && container.kind === "tmux-session"
			: terminalMode === "herdr-pane"
				? placement === "herdr-split" && layout === "split" && container.kind === "herdr-source"
					|| placement === "herdr-new-tab" && layout === "auto" && container.kind === "herdr-workspace"
				: false;
}
function hasValidLayoutAllocation(terminalMode: unknown, layout: unknown, placement: unknown, container: AllocatedContainerV2, target: Record<string, unknown>): boolean {
	if (terminalMode === "cmux-pane") return container.kind === "cmux-pane"
		&& (placement === "cmux-split" && (layout === "auto" || layout === "split") || placement === "cmux-new-surface" && layout === "auto")
		&& cmuxIdsEqual(container.workspaceId, target.workspaceId) && cmuxIdsEqual(container.paneId, target.paneId);
	if (terminalMode === "tmux-pane") return container.kind === "tmux-window"
		&& (placement === "tmux-split" && layout === "split" || placement === "tmux-new-window" && layout === "auto")
		&& container.socketPath === target.socketPath && container.serverPid === target.serverPid
		&& container.paneId === target.paneId && container.panePid === target.panePid;
	return terminalMode === "herdr-pane" && container.kind === "herdr-tab"
		&& (placement === "herdr-split" && layout === "split" || placement === "herdr-new-tab" && layout === "auto")
		&& container.workspaceId === target.workspaceId && container.tabId === target.tabId;
}

export interface LaunchIntentParseOptions {
	/** Read-only recovery compatibility for pre-label tmux-new-window artifacts. */
	allowLegacyTmuxWindowLabel?: boolean;
}

export function parseLaunchIntentV2(value: unknown, expectedRunId?: string, runDir?: string, options: LaunchIntentParseOptions = {}): LaunchIntentV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId) || typeof value.parentSessionId !== "string" || !value.parentSessionId || !pid(value.parentPid) || !positive(value.parentStartedAt) || !positive(value.createdAt) || typeof value.childSessionFile !== "string" || !path.isAbsolute(value.childSessionFile)
		|| value.workingDirectory !== undefined && (typeof value.workingDirectory !== "string" || !path.isAbsolute(value.workingDirectory) || path.normalize(value.workingDirectory) !== value.workingDirectory)) return null;
	if (value.parentRunId !== undefined && (typeof value.parentRunId !== "string" || !value.parentRunId)) return null;
	if (runDir && !containedPath(value.childSessionFile, runDir, "child-session.jsonl")) return null;
	const legacyIntentKeys = ["version", "runId", "parentRunId", "parentSessionId", "parentPid", "parentStartedAt", "terminalMode", "source", "childSessionFile", "workingDirectory", "createdAt", "brokerNonce", "runtimePath", "runtimeInterpreterPath", "backendPath", "brokerEntrypoint"];
	const layoutIntentKeys = [...legacyIntentKeys, "layout", "placement", "container", "control", "windowLabel", "tabLabel"];
	const executionPaths = [value.runtimePath, value.runtimeInterpreterPath, value.backendPath, value.brokerEntrypoint];
	if (typeof value.brokerNonce !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value.brokerNonce) || !executionPaths.every((field) => typeof field === "string" && field.length > 0 && path.isAbsolute(field))) return null;
	const sourceIsValid = value.terminalMode === "cmux-pane" ? isCmuxSource(value.source)
		: value.terminalMode === "tmux-pane" ? isTmuxSource(value.source)
			: value.terminalMode === "herdr-pane" && isHerdrSource(value.source);
	if (!sourceIsValid) return null;
	const layoutFieldNames = ["layout", "placement", "container"];
	const hasAnyLayoutField = layoutFieldNames.some((key) => Object.hasOwn(value, key));
	if (!hasAnyLayoutField && Object.keys(value).every((key) => legacyIntentKeys.includes(key))) return value as LaunchIntentV2;
	if (!hasOnlyOptionalKeys(value, layoutIntentKeys.filter((key) => key !== "parentRunId" && key !== "workingDirectory" && key !== "control" && key !== "windowLabel" && key !== "tabLabel"), ["parentRunId", "workingDirectory", "control", "windowLabel", "tabLabel"])
		|| !layoutFieldNames.every((key) => Object.hasOwn(value, key))) return null;
	if (value.control !== undefined && (value.terminalMode !== "cmux-pane" || !isCmuxControlTransport(value.control))) return null;
	const container = parseLayoutContainerV2(value.container);
	if (!container || !hasValidLayoutIntentPlacement(value.terminalMode, value.layout, value.placement, container)) return null;
	const isTmuxNewWindow = value.terminalMode === "tmux-pane" && value.placement === "tmux-new-window";
	if (isTmuxNewWindow) {
		if (value.windowLabel === undefined) {
			if (!options.allowLegacyTmuxWindowLabel) return null;
		} else if (!isValidTmuxWindowLabel(value.windowLabel, value.runId)) return null;
	} else if (value.windowLabel !== undefined) return null;
	const isHerdrAutoTab = value.terminalMode === "herdr-pane" && value.placement === "herdr-new-tab";
	if (isHerdrAutoTab ? !isValidHerdrTabLabel(value.tabLabel, value.runId) : value.tabLabel !== undefined) return null;
	// Existing artifacts remain readable for diagnostics/reaping. The detached
	// broker separately rejects a new direct Herdr layout without this field.
	if (value.terminalMode === "tmux-pane") {
		const source = value.source as TmuxSourceV2;
		const generated = hasTmuxGeneration(source) || ("generation" in container && hasTmuxGeneration(container));
		if (generated && (!("generation" in container) || !hasTmuxGeneration(source) || !hasTmuxGeneration(container)
			|| !sameTmuxGeneration(source.generation, container.generation))) return null;
	}
	return value as LaunchIntentV2;
}
export function parseAllocationRecordV2(value: unknown, expectedRunId?: string): AllocationRecordV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId) || !positive(value.allocatedAt) || !isRecord(value.target)) return null;
	const legacyAllocationKeys = ["version", "runId", "terminalMode", "target", "allocatedAt"];
	const layoutAllocationKeys = [...legacyAllocationKeys, "layout", "placement", "container", "control"];
	const targetIsValid = value.terminalMode === "cmux-pane"
		? exactKeys(value.target, ["workspaceId", "surfaceId", "paneId"]) && [value.target.workspaceId, value.target.surfaceId, value.target.paneId].every((id) => typeof id === "string" && CMUX_UUID_RE.test(id))
		: value.terminalMode === "tmux-pane" ? hasOnlyOptionalKeys(value.target, ["serverPid", "paneId", "panePid"], ["socketPath", "generation"])
			&& typeof value.target.paneId === "string" && TMUX_PANE_ID_RE.test(value.target.paneId) && pid(value.target.serverPid) && pid(value.target.panePid) && (value.target.socketPath === undefined || typeof value.target.socketPath === "string") && (value.target.generation === undefined || isTmuxGeneration(value.target.generation))
			: value.terminalMode === "herdr-pane" && hasOnlyOptionalKeys(value.target, ["socketPath", "workspaceId", "tabId", "paneId", "terminalId", "protocol"], ["generation"])
				&& typeof value.target.socketPath === "string" && path.isAbsolute(value.target.socketPath) && path.normalize(value.target.socketPath) === value.target.socketPath
				&& [value.target.workspaceId, value.target.tabId, value.target.paneId, value.target.terminalId].every(isHerdrPublicId) && isHerdrProtocol(value.target.protocol)
				&& (value.target.generation === undefined || isHerdrSocketGeneration(value.target.generation));
	if (!targetIsValid) return null;
	const layoutFieldNames = ["layout", "placement", "container"];
	const hasAnyLayoutField = layoutFieldNames.some((key) => Object.hasOwn(value, key));
	if (!hasAnyLayoutField && exactKeys(value, legacyAllocationKeys)) return value as AllocationRecordV2;
	if (!hasOnlyOptionalKeys(value, layoutAllocationKeys.filter((key) => key !== "control"), ["control"]) || !layoutFieldNames.every((key) => Object.hasOwn(value, key))) return null;
	if (value.control !== undefined && (value.terminalMode !== "cmux-pane" || !isCmuxControlTransport(value.control))) return null;
	const container = parseAllocatedContainerV2(value.container);
	if (!container || !hasValidLayoutAllocation(value.terminalMode, value.layout, value.placement, container, value.target)) return null;
	if (value.terminalMode === "tmux-pane") {
		const target = value.target as { generation?: TmuxGenerationV2 };
		const generated = hasTmuxGeneration(target) || ("generation" in container && hasTmuxGeneration(container));
		if (generated && (!("generation" in container) || !hasTmuxGeneration(target) || !hasTmuxGeneration(container)
			|| !sameTmuxGeneration(target.generation, container.generation))) return null;
	}
	return value as AllocationRecordV2;
}
export function parseDecisionV2(value: unknown, expectedRunId?: string, runDir?: string): DecisionV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId) || !positive(value.decidedAt)) return null;
	if (value.kind === "cancel" && exactKeys(value, ["version", "runId", "kind", "decidedAt", "reason"]) && ["parent-abort", "ready-timeout", "commit-timeout"].includes(String(value.reason))) return value as DecisionV2;
	if (value.kind === "commit" && exactKeys(value, ["version", "runId", "kind", "decidedAt", "allocationPath", "launchPath"]) && typeof value.allocationPath === "string" && typeof value.launchPath === "string" && (!runDir || (containedPath(value.allocationPath, runDir, "allocation.json") && containedPath(value.launchPath, runDir, "launch.json")))) return value as DecisionV2;
	return null;
}
export function parseCommittedLaunchRecordV2(value: unknown, expectedRunId?: string, runDir?: string): CommittedLaunchRecordV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId) || !exactKeys(value, ["version", "runId", "terminalMode", "allocationPath", "childSessionFile", "committedAt", "ownership"]) || (value.terminalMode !== "cmux-pane" && value.terminalMode !== "tmux-pane" && value.terminalMode !== "herdr-pane") || value.ownership !== "parent-owned" || !positive(value.committedAt) || typeof value.allocationPath !== "string" || typeof value.childSessionFile !== "string" || !path.isAbsolute(value.childSessionFile)) return null;
	if (runDir && (!containedPath(value.allocationPath, runDir, "allocation.json") || !containedPath(value.childSessionFile, runDir, "child-session.jsonl"))) return null;
	return value as unknown as CommittedLaunchRecordV2;
}
export function parseBrokerClaimV2(value: unknown, expectedRunId?: string): BrokerClaimV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId)
		|| !(exactKeys(value, ["version", "runId", "brokerNonce", "pid", "claimedAt"])
			|| exactKeys(value, ["version", "runId", "brokerNonce", "pid", "brokerStartedAt", "claimedAt"]))
		|| typeof value.brokerNonce !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(value.brokerNonce) || !pid(value.pid)
		|| (value.brokerStartedAt !== undefined && !positive(value.brokerStartedAt)) || !positive(value.claimedAt)) return null;
	return value as unknown as BrokerClaimV2;
}
export function parseResidualRiskV2(value: unknown, expectedRunId?: string): ResidualRiskV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId) || !exactKeys(value, ["version", "runId", "reason", "recordedAt"]) || value.reason !== "possible-unrecorded-allocation" || !positive(value.recordedAt)) return null;
	return value as unknown as ResidualRiskV2;
}
export function parseLaunchDeliveryUnknownV2(value: unknown, expectedRunId?: string, runDir?: string): LaunchDeliveryUnknownV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId) || !exactKeys(value, ["version", "runId", "terminalMode", "allocationPath", "recordedAt"])
		|| value.terminalMode !== "herdr-pane" || typeof value.allocationPath !== "string" || !positive(value.recordedAt)
		|| (runDir !== undefined && !containedPath(value.allocationPath, runDir, "allocation.json"))) return null;
	return value as unknown as LaunchDeliveryUnknownV2;
}
export function parseLaunchGateV2(value: unknown, expectedRunId?: string, runDir?: string): LaunchGateV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId) || !positive(value.publishedAt) || typeof value.launchPath !== "string" || (runDir && !containedPath(value.launchPath, runDir, "launch.json"))) return null;
	if (value.terminalMode === "herdr-pane" && exactKeys(value, ["version", "runId", "terminalMode", "protocol", "launchPath", "publishedAt"]) && isHerdrProtocol(value.protocol)) return value as LaunchGateV2;
	if ((value.terminalMode === "cmux-pane" || value.terminalMode === "tmux-pane") && exactKeys(value, ["version", "runId", "terminalMode", "launchPath", "publishedAt"])) return value as LaunchGateV2;
	return null;
}
export function parseBrokerStatusV2(value: unknown, expectedRunId?: string): BrokerStatusV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId) || !positive(value.updatedAt)) return null;
	if (value.writer === "broker" && typeof value.pid === "number" && pid(value.pid) && ((value.phase === "ready" || value.phase === "committed") ? exactKeys(value, ["version", "runId", "writer", "pid", "phase", "updatedAt"]) : value.phase === "failed" && exactKeys(value, ["version", "runId", "writer", "pid", "phase", "updatedAt", "errorCode"]) && ["intent-invalid", "allocation-failed", "commit-failed", "possible-unrecorded-allocation", "launch-delivery-unknown", "acceptance-handoff-unresolved"].includes(String(value.errorCode)))) return value as BrokerStatusV2;
	if (value.writer === "parent" && value.phase === "failed" && exactKeys(value, ["version", "runId", "writer", "phase", "updatedAt", "errorCode"]) && value.errorCode === "possible-unrecorded-allocation") return value as BrokerStatusV2;
	return null;
}
export function parseCompletionRecordV2(value: unknown, expectedRunId?: string): CompletionRecordV2 | null {
	if (!isRecord(value) || !validRun(value, expectedRunId) || !["completed", "failed", "aborted", "orphaned"].includes(String(value.status)) || !positive(value.completedAt) || !Object.keys(value).every((key) => ["version", "runId", "status", "completedAt", "errorCode"].includes(key))) return null;
	if (value.errorCode !== undefined && !["child-error", "bridge-error", "lease-expired", "surface-closed", "parent-aborted", "wrapper-exited", "pane-missing", "inspect-exhausted", "reaper-cleanup-failed"].includes(String(value.errorCode))) return null;
	return value as unknown as CompletionRecordV2;
}

const CHILD_COMPLETION_ERRORS_V3 = ["child-error", "bridge-error", "lease-expired", "surface-closed"] as const;
const OBSERVER_COMPLETION_ERRORS_V3 = [...CHILD_COMPLETION_ERRORS_V3, "child-exited", "completion-boundary-unproven", "parent-aborted", "transport-lost"] as const;
const COMPLETION_EVIDENCE_REFS_V3 = ["allocation", "launch", "lease", "process-identity", "state", "target-snapshot", "wrapper-status"] as const;
function isSessionBoundaryV3(value: unknown): value is SessionBoundaryV3 {
	return isRecord(value) && exactKeys(value, ["byteOffset", "finalEntryId", "digestAlgorithm", "prefixDigest"])
		&& Number.isSafeInteger(value.byteOffset) && (value.byteOffset as number) > 0
		&& typeof value.finalEntryId === "string" && /^[^\u0000-\u001f\u007f]{1,512}$/.test(value.finalEntryId)
		&& value.digestAlgorithm === "sha256" && typeof value.prefixDigest === "string" && /^[a-f0-9]{64}$/.test(value.prefixDigest);
}
export function parseCompletionRecordV3(value: unknown, expectedRunId?: string): CompletionRecordV3 | null {
	if (!isRecord(value) || value.version !== 3 || typeof value.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.runId)
		|| (expectedRunId !== undefined && value.runId !== expectedRunId) || !positive(value.completedAt)) return null;
	if (value.producer === "child" && value.status === "completed") {
		if (!exactKeys(value, ["version", "runId", "producer", "status", "completedAt", "session"]) || !isSessionBoundaryV3(value.session)) return null;
		return value as unknown as CompletionSuccessV3;
	}
	if (value.producer === "child") {
		const hasSession = Object.hasOwn(value, "session");
		if (!(hasSession ? exactKeys(value, ["version", "runId", "producer", "status", "completedAt", "errorCode", "stopReason", "session"])
			: exactKeys(value, ["version", "runId", "producer", "status", "completedAt", "errorCode", "stopReason"]))
			|| !["failed", "aborted", "orphaned"].includes(String(value.status)) || !CHILD_COMPLETION_ERRORS_V3.includes(value.errorCode as ChildCompletionErrorCodeV3)
			|| !(value.stopReason === null || typeof value.stopReason === "string" && value.stopReason.length <= 256)
			|| (hasSession && !isSessionBoundaryV3(value.session))) return null;
		return value as unknown as ChildFailureV3 | ChildFailureWithSessionBoundaryV3;
	}
	if (value.producer === "parent" || value.producer === "reaper") {
		const hasSession = Object.hasOwn(value, "session");
		const evidenceRefs = Array.isArray(value.evidenceRefs) ? value.evidenceRefs : null;
		if (!(hasSession ? exactKeys(value, ["version", "runId", "producer", "status", "completedAt", "errorCode", "evidenceRefs", "session"])
			: exactKeys(value, ["version", "runId", "producer", "status", "completedAt", "errorCode", "evidenceRefs"]))
			|| !["failed", "aborted", "orphaned"].includes(String(value.status)) || !OBSERVER_COMPLETION_ERRORS_V3.includes(value.errorCode as ObserverCompletionErrorCodeV3)
			|| !evidenceRefs || evidenceRefs.length === 0 || !evidenceRefs.every((entry) => COMPLETION_EVIDENCE_REFS_V3.includes(entry as CompletionEvidenceRefV3))
			|| new Set(evidenceRefs).size !== evidenceRefs.length || evidenceRefs.some((entry, index) => index > 0 && String(evidenceRefs[index - 1]).localeCompare(String(entry)) >= 0)
			|| (hasSession && !isSessionBoundaryV3(value.session))) return null;
		return value as unknown as ObserverFailureV3 | ObserverFailureWithSessionBoundaryV3;
	}
	return null;
}
export function parseCompletionAuthority(value: unknown, expectedRunId?: string): CompletionRecord | null {
	return parseCompletionRecordV3(value, expectedRunId) ?? parseCompletionRecordV2(value, expectedRunId);
}

/** V2 artifacts are a dependency graph, not independently-valid hints. */
function isLayoutIntentV2(intent: LaunchIntentV2): intent is LayoutCmuxLaunchIntentV2 | LayoutTmuxLaunchIntentV2 | LayoutHerdrLaunchIntentV2 {
	return "layout" in intent;
}
function isLayoutAllocationV2(allocation: AllocationRecordV2): allocation is LayoutCmuxAllocationRecordV2 | LayoutTmuxAllocationRecordV2 | LayoutHerdrAllocationRecordV2 {
	return "layout" in allocation;
}

/** Bind a durable allocation to the immutable backend source that created it. */
export function hasAllocationIntentSourceBinding(
	intent: LaunchIntentV2 | null,
	allocation: AllocationRecordV2 | null,
): boolean {
	if (!intent || !allocation || intent.terminalMode !== allocation.terminalMode) return false;
	const layoutIntent = isLayoutIntentV2(intent);
	const layoutAllocation = isLayoutAllocationV2(allocation);
	// Layout-aware records are a separate exact branch: never bind one of them
	// to a legacy split artifact that has no placement/container authority.
	if (!layoutIntent && !layoutAllocation) {
		if (intent.terminalMode === "cmux-pane" && allocation.terminalMode === "cmux-pane") {
			return cmuxIdsEqual(allocation.target.workspaceId, intent.source.workspaceId)
				&& !cmuxIdsEqual(allocation.target.surfaceId, intent.source.sourceSurfaceId);
		}
		if (intent.terminalMode === "herdr-pane" && allocation.terminalMode === "herdr-pane") {
			return hasHerdrSocketGeneration(intent.source) && hasHerdrSocketGeneration(allocation.target)
				&& intent.source.generation.socketDev === allocation.target.generation.socketDev && intent.source.generation.socketIno === allocation.target.generation.socketIno
				&& allocation.target.socketPath === intent.source.socketPath && allocation.target.workspaceId === intent.source.workspaceId
				&& allocation.target.tabId === intent.source.tabId && allocation.target.protocol === intent.source.protocol
				&& allocation.target.paneId !== intent.source.sourcePaneId
				&& allocation.target.terminalId !== intent.source.sourceTerminalId;
		}
		if (intent.terminalMode === "tmux-pane" && allocation.terminalMode === "tmux-pane") {
			return hasTmuxGeneration(intent.source) && hasTmuxGeneration(allocation.target)
				&& sameTmuxGeneration(intent.source.generation, allocation.target.generation)
				&& allocation.target.socketPath === intent.source.socketPath
				&& allocation.target.serverPid === intent.source.serverPid
				// Pane identity alone is source authority; a changed PID is not a
				// new allocation and must be quarantined without lifecycle mutation.
				&& allocation.target.paneId !== intent.source.sourcePaneId;
		}
		return false;
	}
	if (!layoutIntent || !layoutAllocation) return false;
	if (intent.layout !== allocation.layout || intent.placement !== allocation.placement) return false;
	if (intent.terminalMode === "cmux-pane" && allocation.terminalMode === "cmux-pane" && allocation.container.kind === "cmux-pane") {
		// New production cmux records must bind the exact socket generation and
		// non-secret identify fingerprint. Legacy no-control records remain
		// parseable diagnostics but cannot bind to this branch.
		if ((intent.control !== undefined || allocation.control !== undefined)
			&& (!intent.control || !allocation.control || JSON.stringify(intent.control) !== JSON.stringify(allocation.control))) return false;
		const request = intent.container;
		const sourceMatches = cmuxIdsEqual(allocation.target.workspaceId, intent.source.workspaceId)
			&& !cmuxIdsEqual(allocation.target.surfaceId, intent.source.sourceSurfaceId);
		if (!sourceMatches || !cmuxIdsEqual(allocation.container.workspaceId, allocation.target.workspaceId)
			|| !cmuxIdsEqual(allocation.container.paneId, allocation.target.paneId)) return false;
		if (request.kind === "cmux-source") return cmuxIdsEqual(request.workspaceId, intent.source.workspaceId)
			&& cmuxIdsEqual(request.sourceSurfaceId, intent.source.sourceSurfaceId);
		if (request.kind === "cmux-pane") return cmuxIdsEqual(request.workspaceId, intent.source.workspaceId)
			&& cmuxIdsEqual(request.workspaceId, allocation.container.workspaceId)
			&& cmuxIdsEqual(request.paneId, allocation.container.paneId);
		return request.kind === "cmux-source-pane"
			&& cmuxIdsEqual(request.workspaceId, intent.source.workspaceId)
			&& cmuxIdsEqual(request.sourceSurfaceId, intent.source.sourceSurfaceId)
			&& cmuxIdsEqual(request.workspaceId, allocation.container.workspaceId)
			&& cmuxIdsEqual(request.paneId, allocation.container.paneId);
	}
	if (intent.terminalMode === "herdr-pane" && allocation.terminalMode === "herdr-pane" && allocation.container.kind === "herdr-tab") {
		const request = intent.container;
		const sourceMatches = hasHerdrSocketGeneration(intent.source) && hasHerdrSocketGeneration(allocation.target)
			&& intent.source.generation.socketDev === allocation.target.generation.socketDev && intent.source.generation.socketIno === allocation.target.generation.socketIno
			&& allocation.target.socketPath === intent.source.socketPath
			&& allocation.target.workspaceId === intent.source.workspaceId
			&& allocation.target.protocol === intent.source.protocol
			&& allocation.target.paneId !== intent.source.sourcePaneId
			&& allocation.target.terminalId !== intent.source.sourceTerminalId
			&& allocation.container.workspaceId === allocation.target.workspaceId
			&& allocation.container.tabId === allocation.target.tabId;
		if (!sourceMatches) return false;
		return request.kind === "herdr-source"
			? request.workspaceId === intent.source.workspaceId && request.tabId === intent.source.tabId
				&& request.paneId === intent.source.sourcePaneId && request.terminalId === intent.source.sourceTerminalId
				&& allocation.target.tabId === intent.source.tabId
			: request.kind === "herdr-workspace" && request.workspaceId === intent.source.workspaceId
				&& allocation.target.tabId !== intent.source.tabId;
	}
	if (intent.terminalMode === "tmux-pane" && allocation.terminalMode === "tmux-pane" && allocation.container.kind === "tmux-window") {
		const request = intent.container;
		const sourceMatches = hasTmuxGeneration(intent.source) && hasTmuxGeneration(allocation.target)
			&& hasTmuxGeneration(allocation.container) && sameTmuxGeneration(intent.source.generation, allocation.target.generation)
			&& sameTmuxGeneration(intent.source.generation, allocation.container.generation)
			&& allocation.target.socketPath === intent.source.socketPath
			&& allocation.target.serverPid === intent.source.serverPid
			&& allocation.target.paneId !== intent.source.sourcePaneId;
		if (!sourceMatches || allocation.container.socketPath !== allocation.target.socketPath
			|| allocation.container.serverPid !== allocation.target.serverPid
			|| allocation.container.paneId !== allocation.target.paneId
			|| allocation.container.panePid !== allocation.target.panePid) return false;
		if (request.kind === "tmux-source-pane") return hasTmuxGeneration(request)
			&& sameTmuxGeneration(intent.source.generation, request.generation)
			&& request.socketPath === intent.source.socketPath
			&& request.serverPid === intent.source.serverPid
			&& request.paneId === intent.source.sourcePaneId
			&& request.panePid === intent.source.sourcePanePid
			&& allocation.container.sessionId === request.sessionId
			&& allocation.container.windowId === request.windowId;
		return request.kind === "tmux-session" && hasTmuxGeneration(request)
			&& sameTmuxGeneration(intent.source.generation, request.generation)
			&& request.socketPath === intent.source.socketPath
			&& request.serverPid === intent.source.serverPid
			&& request.sessionId === allocation.container.sessionId
			&& request.sourceWindowId !== allocation.container.windowId;
	}
	return false;
}

export function hasValidV2StateDependencies(options: {
	allocation: AllocationRecordV2 | null;
	decision: DecisionV2 | null;
	launch: CommittedLaunchRecordV2 | null;
	gate: LaunchGateV2 | null;
}): boolean {
	const { allocation, decision, launch, gate } = options;
	// Commit owns a durable exact allocation; cancel is strictly pre-launch.
	if (decision?.kind === "commit" && !allocation) return false;
	if (decision?.kind === "cancel" && (launch || gate)) return false;
	// launch and gate can only follow the complete committed chain for the
	// exact same terminal backend; an opposite-mode record is never handle
	// authority, even when its paths and run id are otherwise valid.
	if (launch && (!allocation || decision?.kind !== "commit" || launch.terminalMode !== allocation.terminalMode)) return false;
	if (gate && (!launch || !allocation || decision?.kind !== "commit" || gate.terminalMode !== allocation.terminalMode || gate.terminalMode !== launch.terminalMode)) return false;
	if (allocation?.terminalMode === "herdr-pane" && gate?.terminalMode === "herdr-pane" && gate.protocol !== allocation.target.protocol) return false;
	return true;
}

/** Immutable no-replace publication. Existing malformed authority is deliberately never replaced. */
export async function publishImmutableJson(filePath: string, value: unknown): Promise<"published" | "exists"> {
	const directory = path.dirname(filePath);
	await assertSafeRunArtifactPaths({ rootDir: path.dirname(directory), runDir: directory });
	const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
	let fd: fs.promises.FileHandle | undefined;
	try {
		fd = await fs.promises.open(temporaryPath, "wx", 0o600);
		await fd.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await fd.sync();
		await fd.close(); fd = undefined;
		try { await fs.promises.link(temporaryPath, filePath); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
			throw error;
		}
		return "published";
	} finally {
		await fd?.close().catch(() => undefined);
		await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
		await fs.promises.open(directory, "r").then(async (dir) => { await dir.sync().catch(() => undefined); await dir.close(); }).catch(() => undefined);
	}
}

/** Exact artifact decoder: UTF-8 JSON object with one final newline only. */
/** Publish completion once. A valid existing completion is the immutable winner;
 * malformed existing authority is deliberately recovery-blocking. */
export async function publishCompletionRecordV2(filePath: string, record: CompletionRecordV2): Promise<CompletionRecordV2> {
	await publishImmutableJson(filePath, record);
	const winner = parseCompletionRecordV2(await readBrokerJson(filePath), record.runId);
	if (!winner) throw new Error(`Completion authority is malformed or does not match run ${record.runId}.`);
	return winner;
}
export async function publishCompletionRecordV3(filePath: string, record: CompletionRecordV3): Promise<CompletionRecord> {
	if (!parseCompletionRecordV3(record, record.runId)) throw new Error(`Completion V3 record is malformed for run ${record.runId}.`);
	await publishImmutableJson(filePath, record);
	const winner = parseCompletionAuthority(await readBrokerJson(filePath), record.runId);
	if (!winner) throw new Error(`Completion authority is malformed or does not match run ${record.runId}.`);
	return winner;
}

export type BrokerArtifactRead =
	| { outcome: "missing" }
	| { outcome: "valid"; value: Record<string, unknown> }
	| { outcome: "invalid" };

/** Tri-state immutable-authority read. Invalid is deliberately distinct from missing. */
export async function readBrokerArtifact(filePath: string): Promise<BrokerArtifactRead> {
	try {
		await fs.promises.lstat(filePath);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { outcome: "missing" } : { outcome: "invalid" };
	}
	const value = await readBoundedPrivateJson(filePath, { requireSingleLineTerminated: true });
	return isRecord(value) ? { outcome: "valid", value } : { outcome: "invalid" };
}

export async function readBrokerJson(filePath: string): Promise<unknown | null> {
	const artifact = await readBrokerArtifact(filePath);
	return artifact.outcome === "valid" ? artifact.value : null;
}
