import crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { MAX_SUBAGENT_ACTIVE } from "../core/subagent-limits";
import {
  assertSafeStateRoot,
  classifyParentProcessIdentity,
  ensureRunStateRoot,
  getCurrentProcessStartedAt,
  getRunStateRoot,
  type ProcessIdentityStatus,
} from "./run-protocol.js";

/** Durable, root-scoped permit authority for nested subagent trees. */
export const TREE_PERMIT_ROOT_ENV = "PI_SUBAGENT_TREE_PERMIT_ROOT";
export const TREE_PERMIT_ROOT_ID_ENV = "PI_SUBAGENT_TREE_PERMIT_ROOT_ID";
export const TREE_PERMIT_TOKEN_ENV = "PI_SUBAGENT_TREE_PERMIT_TOKEN";
export const TREE_PERMIT_MAX_ACTIVE_ENV = "PI_SUBAGENT_TREE_PERMIT_MAX_ACTIVE";
export const TREE_PERMIT_LEASE_ID_ENV = "PI_SUBAGENT_TREE_PERMIT_LEASE_ID";
export const TREE_PERMIT_LEASE_TOKEN_ENV = "PI_SUBAGENT_TREE_PERMIT_LEASE_TOKEN";

/** Tree permits require exact process identity support; Windows intentionally falls back to process-local scheduling. */
export function supportsTreePermitAuthority(platform: string = process.platform): boolean {
  return platform === "darwin" || platform === "linux";
}

const NAMESPACE = ".tree-permits";
const CREATION = "creation.json";
const MANIFEST = "authority.json";
/** Namespace-scoped progress marker; it is never an authority entry. */
const RECONCILE_CURSOR = "reconcile-cursor.json";
const VERSION = 1 as const;
const GENERATION_WIDTH = 20;
const GENESIS_DIGEST = "0".repeat(64);
const RETRY_MS = 4;
/** Detached-result settlement retries forever, but backs off to this ceiling. */
const SETTLEMENT_WATCH_MAX_DELAY_MS = 250;
const MAX_CAS_RETRIES = 256;
const MAX_SNAPSHOT_LOAD_RETRIES = 8;
/** Keep the immutable tail short without changing the v1 state format. */
const CHECKPOINT_INTERVAL = 128;
/** All lease states count: nested foreground delegation can accumulate PARKED_WAIT entries. */
export const MAX_TREE_PERMIT_LEASES = 1024;
/** Sized for a legacy oversized lease set while keeping the regular tail disk-bounded. */
const SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_FILES = CHECKPOINT_INTERVAL + 8;
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
/** Pre-checkpoint v1 histories are migration input, not an unbounded steady-state tail. */
export const MAX_LEGACY_SNAPSHOT_FILES = 8192;
const MAX_LEGACY_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** Directory walk overhead beyond the largest supported legacy protocol tail. */
const MAX_SNAPSHOT_DIRECTORY_ENTRIES = MAX_LEGACY_SNAPSHOT_FILES + 16;
/** A full reconciliation pass streams at most this many namespace entries. */
const MAX_RECONCILE_SCAN_ENTRIES = 100_000;
const MAX_RECONCILE_LIMIT = 128;
const RECONCILE_YIELD_EVERY = 32;
const ARTIFACT_MINIMUM_AGE_MS = 1_000;
const CHECKPOINT_KIND = "pi-subagent-tree-permit-checkpoint";
/** Only scopes minted by beginForegroundDelegation may use foreground internals. */
const foregroundScopes = new WeakSet<ForegroundDelegationScope>();

type LeaseState = "RESERVED" | "ACTIVE" | "PARKED_WAIT";
export interface ProcessIdentity { pid: number; startedAt: number; }
/** `reservedBy` was added after v1 records existed; absent means provenance is unknown. */
interface StoredLease { id: string; token: string; state: LeaseState; owner: ProcessIdentity; reservedBy?: ProcessIdentity; }
interface PermitState {
  version: 1;
  rootIdentity: string;
  maxActive: number;
  generation: number;
  previousDigest: string;
  leases: StoredLease[];
}
interface CreationRecord {
  version: 1;
  kind: "pi-subagent-tree-permit-creation";
  rootIdentity: string;
  token: string;
  maxActive: number;
  creator: ProcessIdentity;
}
interface Manifest {
  version: 1;
  kind: "pi-subagent-tree-permit-authority";
  rootIdentity: string;
  token: string;
  maxActive: number;
  creator: ProcessIdentity;
}
interface ReconcileCursor { version: 1; lastScanned: string; lastArtifact?: string; }
interface Checkpoint {
  version: 1;
  kind: typeof CHECKPOINT_KIND;
  rootIdentity: string;
  maxActive: number;
  generation: number;
  state: PermitState;
  stateDigest: string;
  hmac: string;
}
interface Snapshot {
  state: PermitState;
  digest: string;
  checkpointGeneration: number;
  requiresCompaction: boolean;
  fileCount: number;
  totalBytes: number;
}
/** Signals that a requested mutation made no change and must not publish. */
const NO_COMMIT = Symbol("tree-permit-no-commit");
type MutationResult<T> = T | typeof NO_COMMIT;

export interface TreePermitAuthorityOptions {
  rootDir?: string;
  maxActive: number;
  /** Test seam; production uses OS PID/start identity classification. */
  classifyIdentity?: (identity: ProcessIdentity) => ProcessIdentityStatus;
  /** Test seam; production reads this process's exact PID/start identity. */
  currentIdentity?: () => ProcessIdentity | null;
}
export interface AdoptTreePermitAuthorityOptions {
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
  classifyIdentity?: (identity: ProcessIdentity) => ProcessIdentityStatus;
  currentIdentity?: () => ProcessIdentity | null;
}
export interface AcquireReservationOptions { signal?: AbortSignal; }
export interface ReconcileTreePermitAuthoritiesOptions {
  rootDir?: string;
  /** Reconciliation is deliberately bounded; malformed, live, and unknown entries are retained. */
  limit?: number;
  classifyIdentity?: (identity: ProcessIdentity) => ProcessIdentityStatus;
}
export interface ReconcileTreePermitAuthoritiesResult { removed: string[]; retained: string[]; scanned: number; }

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function validMaxActive(value: unknown): value is number { return positive(value) && value <= MAX_SUBAGENT_ACTIVE; }
function generation(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function token(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value); }
function digest(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value); }
function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean { return left.pid === right.pid && left.startedAt === right.startedAt; }
function validIdentity(value: unknown): value is ProcessIdentity {
  return !!value && typeof value === "object" && exact(value as Record<string, unknown>, ["pid", "startedAt"])
    && positive((value as ProcessIdentity).pid) && positive((value as ProcessIdentity).startedAt);
}
function parseLease(value: unknown): StoredLease | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  // Older v1 snapshots omitted reservation provenance. They remain readable,
  // but parent-only operations must not recover that provenance by inference.
  if (!exact(record, ["id", "token", "state", "owner"]) && !exact(record, ["id", "token", "state", "owner", "reservedBy"])) return null;
  const lease = value as StoredLease;
  return uuid(lease.id) && token(lease.token) && ["RESERVED", "ACTIVE", "PARKED_WAIT"].includes(lease.state) && validIdentity(lease.owner)
    && (lease.reservedBy === undefined || validIdentity(lease.reservedBy)) ? lease : null;
}
function parseState(value: unknown): PermitState | null {
  if (!value || typeof value !== "object" || !exact(value as Record<string, unknown>, ["version", "rootIdentity", "maxActive", "generation", "previousDigest", "leases"])) return null;
  const state = value as PermitState;
  if (state.version !== VERSION || !uuid(state.rootIdentity) || !validMaxActive(state.maxActive) || !generation(state.generation) || !digest(state.previousDigest) || !Array.isArray(state.leases)) return null;
  const leases = state.leases.map(parseLease);
  if (leases.some((lease) => !lease) || new Set(leases.map((lease) => lease!.id)).size !== leases.length) return null;
  return state;
}
function parseCreation(value: unknown): CreationRecord | null {
  if (!value || typeof value !== "object" || !exact(value as Record<string, unknown>, ["version", "kind", "rootIdentity", "token", "maxActive", "creator"])) return null;
  const record = value as CreationRecord;
  return record.version === VERSION && record.kind === "pi-subagent-tree-permit-creation" && uuid(record.rootIdentity) && token(record.token) && validMaxActive(record.maxActive) && validIdentity(record.creator) ? record : null;
}
function parseManifest(value: unknown): Manifest | null {
  if (!value || typeof value !== "object" || !exact(value as Record<string, unknown>, ["version", "kind", "rootIdentity", "token", "maxActive", "creator"])) return null;
  const manifest = value as Manifest;
  return manifest.version === VERSION && manifest.kind === "pi-subagent-tree-permit-authority" && uuid(manifest.rootIdentity) && token(manifest.token) && validMaxActive(manifest.maxActive) && validIdentity(manifest.creator) ? manifest : null;
}
function parseReconcileCursor(value: unknown): ReconcileCursor | null {
  if (!value || typeof value !== "object" || (!exact(value as Record<string, unknown>, ["version", "lastScanned"]) && !exact(value as Record<string, unknown>, ["version", "lastScanned", "lastArtifact"]))) return null;
  const cursor = value as ReconcileCursor;
  const validName = (name: unknown) => typeof name === "string" && name.length > 0 && name.length <= 512 && !/[\\/\0\r\n]/.test(name);
  // Separate artifact progress prevents retained stages from starving UUIDs.
  return cursor.version === VERSION && validName(cursor.lastScanned) && (cursor.lastArtifact === undefined || validName(cursor.lastArtifact)) ? cursor : null;
}
function parseCheckpoint(value: unknown): Checkpoint | null {
  if (!value || typeof value !== "object" || !exact(value as Record<string, unknown>, ["version", "kind", "rootIdentity", "maxActive", "generation", "state", "stateDigest", "hmac"])) return null;
  const checkpoint = value as Checkpoint;
  return checkpoint.version === VERSION && checkpoint.kind === CHECKPOINT_KIND && uuid(checkpoint.rootIdentity)
    && validMaxActive(checkpoint.maxActive) && generation(checkpoint.generation) && !!parseState(checkpoint.state)
    && digest(checkpoint.stateDigest) && digest(checkpoint.hmac) ? checkpoint : null;
}
function randomToken(): string { return crypto.randomBytes(32).toString("base64url"); }
function privateFile(stat: fs.Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && (process.platform === "win32" || (stat.mode & 0o777) === 0o600)
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}
function privateDirectory(stat: fs.Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && (process.platform === "win32" || (stat.mode & 0o777) === 0o700)
    && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}
function stateName(value: number): string {
  if (!generation(value)) throw new Error("Tree permit snapshot generation is unsafe.");
  return `state-${String(value).padStart(GENERATION_WIDTH, "0")}.json`;
}
function checkpointName(value: number): string {
  if (!generation(value)) throw new Error("Tree permit checkpoint generation is unsafe.");
  return `checkpoint-${String(value).padStart(GENERATION_WIDTH, "0")}.json`;
}
function identityName(identity: ProcessIdentity): string { return `${identity.pid}-${identity.startedAt}`; }
function stageName(rootIdentity: string, creator: ProcessIdentity): string { return `.tree-permit-stage-${rootIdentity}-${identityName(creator)}`; }
function temporaryName(name: string, publisher: ProcessIdentity): string {
  return `.tree-permit-temp-${Buffer.from(name, "utf8").toString("base64url")}-${identityName(publisher)}-${randomToken()}.tmp`;
}
function tombstoneName(rootIdentity: string, publisher: ProcessIdentity): string {
  return `.tree-permit-tombstone-${rootIdentity}-${identityName(publisher)}-${randomToken()}`;
}
interface PrivateArtifact { kind: "stage" | "temp" | "tombstone"; owner: ProcessIdentity; rootIdentity?: string; }
function parsePrivateArtifact(name: string): PrivateArtifact | null {
  let match = /^\.tree-permit-stage-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})-(\d+)-(\d+)$/.exec(name);
  if (match) {
    const owner = { pid: Number(match[2]), startedAt: Number(match[3]) };
    return validIdentity(owner) ? { kind: "stage", rootIdentity: match[1], owner } : null;
  }
  match = /^\.tree-permit-temp-([A-Za-z0-9_-]{1,256})-(\d+)-(\d+)-([A-Za-z0-9_-]{32,256})\.tmp$/.exec(name);
  if (match) {
    const owner = { pid: Number(match[2]), startedAt: Number(match[3]) };
    return validIdentity(owner) ? { kind: "temp", owner } : null;
  }
  match = /^\.tree-permit-tombstone-([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})-(\d+)-(\d+)-([A-Za-z0-9_-]{32,256})$/.exec(name);
  if (match) {
    const owner = { pid: Number(match[2]), startedAt: Number(match[3]) };
    return validIdentity(owner) ? { kind: "tombstone", rootIdentity: match[1], owner } : null;
  }
  return null;
}
function stateContent(state: PermitState): string {
  return `${JSON.stringify({ version: state.version, rootIdentity: state.rootIdentity, maxActive: state.maxActive, generation: state.generation, previousDigest: state.previousDigest, leases: state.leases })}\n`;
}
function contentDigest(content: string): string { return crypto.createHash("sha256").update(content).digest("hex"); }
function checkpointPayload(checkpoint: Omit<Checkpoint, "hmac">): string {
  return JSON.stringify({ version: checkpoint.version, kind: checkpoint.kind, rootIdentity: checkpoint.rootIdentity, maxActive: checkpoint.maxActive, generation: checkpoint.generation, state: checkpoint.state, stateDigest: checkpoint.stateDigest });
}
function checkpointContent(checkpoint: Checkpoint): string {
  return `${JSON.stringify({ version: checkpoint.version, kind: checkpoint.kind, rootIdentity: checkpoint.rootIdentity, maxActive: checkpoint.maxActive, generation: checkpoint.generation, state: checkpoint.state, stateDigest: checkpoint.stateDigest, hmac: checkpoint.hmac })}\n`;
}
function checkpointMac(tokenValue: string, checkpoint: Omit<Checkpoint, "hmac">): string {
  return crypto.createHmac("sha256", tokenValue).update(checkpointPayload(checkpoint)).digest("hex");
}
function equalMac(left: string, right: string): boolean {
  return /^[0-9a-f]{64}$/.test(left) && /^[0-9a-f]{64}$/.test(right) && crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function cloneState(state: PermitState): PermitState { return JSON.parse(JSON.stringify(state)) as PermitState; }
function used(state: PermitState): number { return state.leases.filter((lease) => lease.state === "ACTIVE" || lease.state === "RESERVED").length; }
/** Reserve enough room for both immutable representations before admitting a lease. */
function fitsSnapshotEnvelope(state: PermitState): boolean {
  const stateBytes = Buffer.byteLength(stateContent(state), "utf8");
  const checkpoint: Checkpoint = {
    version: VERSION, kind: CHECKPOINT_KIND, rootIdentity: state.rootIdentity, maxActive: state.maxActive,
    generation: state.generation, state, stateDigest: "0".repeat(64), hmac: "0".repeat(64),
  };
  return stateBytes <= SNAPSHOT_FILE_BYTES && Buffer.byteLength(checkpointContent(checkpoint), "utf8") <= SNAPSHOT_FILE_BYTES;
}
function defaultCurrentIdentity(): ProcessIdentity | null {
  const startedAt = getCurrentProcessStartedAt();
  return startedAt === null ? null : { pid: process.pid, startedAt };
}
async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => done(true), ms);
    const abort = () => done(false);
    const done = (result: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** A result-settlement retry must not keep an otherwise-idle Pi process alive. */
async function sleepUnref(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => done(true), ms);
    timer.unref();
    const abort = () => done(false);
    const done = (result: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * A same-UID cooperative authority, not a security boundary against a hostile
 * child. Only the trusted launcher should call bindChildIdentity after spawn.
 */
export class TreePermitAuthority {
  readonly rootDir: string;
  readonly maxActive: number;
  readonly rootIdentity: string;
  readonly token: string;
  readonly namespaceDir: string;
  readonly authorityDir: string;
  readonly inheritedLease: TreePermitLease | null;
  #classify: (identity: ProcessIdentity) => ProcessIdentityStatus;
  #currentIdentity: () => ProcessIdentity | null;

  private constructor(config: { rootDir: string; manifest: Manifest; inherited?: StoredLease; classifyIdentity?: (identity: ProcessIdentity) => ProcessIdentityStatus; currentIdentity?: () => ProcessIdentity | null; }) {
    this.rootDir = config.rootDir;
    this.maxActive = config.manifest.maxActive;
    this.rootIdentity = config.manifest.rootIdentity;
    this.token = config.manifest.token;
    this.namespaceDir = path.join(this.rootDir, NAMESPACE);
    this.authorityDir = path.join(this.namespaceDir, this.rootIdentity);
    this.#classify = config.classifyIdentity ?? ((identity) => classifyParentProcessIdentity(identity.pid, identity.startedAt));
    this.#currentIdentity = config.currentIdentity ?? defaultCurrentIdentity;
    this.inheritedLease = config.inherited ? new TreePermitLease(this, config.inherited.id, config.inherited.token, config.inherited.reservedBy) : null;
  }

  static async create(options: TreePermitAuthorityOptions): Promise<TreePermitAuthority> {
    if (!validMaxActive(options.maxActive)) throw new Error(`Tree permit maxActive must be a positive safe integer at most ${MAX_SUBAGENT_ACTIVE}.`);
    const rootDir = await ensureRunStateRoot(options.rootDir ?? getRunStateRoot());
    const classify = options.classifyIdentity ?? ((identity: ProcessIdentity) => classifyParentProcessIdentity(identity.pid, identity.startedAt));
    const current = options.currentIdentity?.() ?? defaultCurrentIdentity();
    if (!current || !validIdentity(current) || classify(current) !== "live") throw new Error("Unable to establish a live exact process identity for tree permits.");
    const namespaceDir = await ensureNamespace(rootDir);
    const rootIdentity = crypto.randomUUID();
    const authorityDir = path.join(namespaceDir, rootIdentity);
    const stagingDir = path.join(namespaceDir, stageName(rootIdentity, current));
    if (path.dirname(stagingDir) !== namespaceDir) throw new Error("Tree permit staging directory escaped namespace.");
    await fs.promises.mkdir(stagingDir, { mode: 0o700 });
    await fs.promises.chmod(stagingDir, 0o700);
    await fsyncDirectory(namespaceDir);
    try {
      const creation: CreationRecord = { version: VERSION, kind: "pi-subagent-tree-permit-creation", rootIdentity, token: randomToken(), maxActive: options.maxActive, creator: current };
      await publishImmutableJson(stagingDir, CREATION, creation, current);
      const manifest: Manifest = { version: VERSION, kind: "pi-subagent-tree-permit-authority", rootIdentity, token: creation.token, maxActive: creation.maxActive, creator: creation.creator };
      await publishImmutableJson(stagingDir, MANIFEST, manifest, current);
      const initialLease: StoredLease = { id: crypto.randomUUID(), token: randomToken(), state: "ACTIVE", owner: current, reservedBy: current };
      const initial: PermitState = { version: VERSION, rootIdentity, maxActive: manifest.maxActive, generation: 0, previousDigest: GENESIS_DIGEST, leases: [initialLease] };
      if (!await publishSnapshot(stagingDir, initial, current)) throw new Error("Initial tree permit state unexpectedly collided.");
      const snapshot = await loadLatestSnapshot(stagingDir, manifest);
      if (!snapshot || snapshot.state.generation !== 0) throw new Error("Tree permit authority state was not durably published.");
      const staged = await fs.promises.lstat(stagingDir);
      if (!privateDirectory(staged)) throw new Error("Tree permit staging directory is unsafe.");
      await fsyncDirectory(stagingDir);
      await fs.promises.rename(stagingDir, authorityDir);
      await fsyncDirectory(namespaceDir);
      const published = await fs.promises.lstat(authorityDir);
      if (!privateDirectory(published) || published.dev !== staged.dev || published.ino !== staged.ino) throw new Error("Tree permit authority publication was replaced.");
      return new TreePermitAuthority({ rootDir, manifest, inherited: initialLease, classifyIdentity: options.classifyIdentity, currentIdentity: options.currentIdentity });
    } catch (error) {
      // Before the atomic public rename a crash leaves an owner-identifiable
      // stage, never a public authority missing its creation record.
      throw error;
    }
  }

  static async reconcile(options: ReconcileTreePermitAuthoritiesOptions = {}): Promise<ReconcileTreePermitAuthoritiesResult> {
    return await reconcileTreePermitAuthorities(options);
  }

  static async adopt(options: AdoptTreePermitAuthorityOptions = {}): Promise<TreePermitAuthority> {
    const env = options.env ?? process.env;
    const configuredRoot = env[TREE_PERMIT_ROOT_ENV];
    const configuredId = env[TREE_PERMIT_ROOT_ID_ENV];
    const configuredToken = env[TREE_PERMIT_TOKEN_ENV];
    const configuredCap = env[TREE_PERMIT_MAX_ACTIVE_ENV];
    if (!configuredRoot || !configuredId || !configuredToken || !configuredCap || !uuid(configuredId) || /[\r\n\0]/.test(configuredRoot + configuredId + configuredToken + configuredCap)) throw new Error("Missing or invalid tree permit authority environment.");
    const rootDir = path.resolve(options.rootDir ?? configuredRoot);
    if (options.rootDir && path.resolve(configuredRoot) !== rootDir) throw new Error("Tree permit authority root mismatch.");
    await assertSafeStateRoot(rootDir);
    const namespaceDir = await ensureNamespace(rootDir);
    const authorityDir = await assertAuthorityDirectory(namespaceDir, configuredId);
    const manifest = await readPrivateJson(path.join(authorityDir, MANIFEST), parseManifest);
    if (!manifest || manifest.rootIdentity !== configuredId || manifest.token !== configuredToken || String(manifest.maxActive) !== configuredCap) throw new Error("Tree permit authority identity, cap, or token mismatch.");
    const creation = await readPrivateJson(path.join(authorityDir, CREATION), parseCreation);
    if (!creation || !sameAuthority(creation, manifest)) throw new Error("Tree permit authority creation record is invalid.");
    const snapshot = await loadStableLatestSnapshot(authorityDir, manifest);
    if (!snapshot) throw new Error("Tree permit authority state chain is invalid.");
    const leaseId = env[TREE_PERMIT_LEASE_ID_ENV];
    const leaseToken = env[TREE_PERMIT_LEASE_TOKEN_ENV];
    if ((leaseId === undefined) !== (leaseToken === undefined)) throw new Error("Incomplete inherited tree permit lease environment.");
    let inherited: StoredLease | undefined;
    if (leaseId !== undefined && leaseToken !== undefined) {
      const current = options.currentIdentity?.() ?? defaultCurrentIdentity();
      inherited = snapshot.state.leases.find((lease) => lease.id === leaseId && lease.token === leaseToken);
      if (!inherited || !current || !sameIdentity(inherited.owner, current)) throw new Error("Inherited tree permit lease is not bound to this exact process identity.");
    }
    return new TreePermitAuthority({ rootDir, manifest, inherited, classifyIdentity: options.classifyIdentity, currentIdentity: options.currentIdentity });
  }

  exportChildEnv(lease?: TreePermitLease): Record<string, string> {
    const env: Record<string, string> = {
      [TREE_PERMIT_ROOT_ENV]: this.rootDir,
      [TREE_PERMIT_ROOT_ID_ENV]: this.rootIdentity,
      [TREE_PERMIT_TOKEN_ENV]: this.token,
      [TREE_PERMIT_MAX_ACTIVE_ENV]: String(this.maxActive),
    };
    if (lease) {
      if (lease.authority !== this) throw new Error("Tree permit lease belongs to a different authority.");
      env[TREE_PERMIT_LEASE_ID_ENV] = lease.id;
      env[TREE_PERMIT_LEASE_TOKEN_ENV] = lease.token;
    }
    return env;
  }

  /** Background work never transfers the inherited permit. */
  async acquireReservation(options: AcquireReservationOptions = {}): Promise<TreePermitLease | null> {
    return await this.#acquire(false, options);
  }

  /** Wait for background capacity, returning null only when cancelled. */
  async waitForReservation(options: AcquireReservationOptions = {}): Promise<TreePermitLease | null> {
    while (!options.signal?.aborted) {
      const lease = await this.acquireReservation(options);
      if (lease) return lease;
      if (!await sleep(RETRY_MS, options.signal)) return null;
    }
    return null;
  }

  /** Park this inherited foreground lease once and coordinate local descendants. */
  async beginForegroundDelegation(): Promise<ForegroundDelegationScope> {
    const inherited = this.inheritedLease;
    const current = this.#currentIdentity();
    if (!inherited || !current || this.#classify(current) !== "live") throw new Error("No live inherited foreground lease is available.");
    let adoptedParkedLease = false;
    const parked = await this.#mutate((state) => {
      const parent = state.leases.find((lease) => lease.id === inherited.id && lease.token === inherited.token);
      // A caller can lose the response after durable parking. Only its own
      // exact inherited lease may be adopted on retry; any other state/owner
      // remains unavailable and never receives a second park transition.
      if (!parent || !sameIdentity(parent.owner, current) || (parent.state !== "ACTIVE" && parent.state !== "PARKED_WAIT")) return NO_COMMIT;
      if (parent.state === "PARKED_WAIT") {
        adoptedParkedLease = true;
        return NO_COMMIT;
      }
      parent.state = "PARKED_WAIT";
      return true;
    }, false);
    if (!parked && !adoptedParkedLease) throw new Error("Inherited foreground lease is not available to park.");
    const scope = new ForegroundDelegationScope(this, inherited);
    foregroundScopes.add(scope);
    return scope;
  }

  /** Trusted launcher API: bind a spawned child exact identity to its reservation. */
  async bindLease(lease: TreePermitLease, child: ProcessIdentity): Promise<boolean> {
    if (lease.authority !== this || !validIdentity(child) || this.#classify(child) !== "live") return false;
    return await this.#mutate((state) => {
      const stored = state.leases.find((candidate) => candidate.id === lease.id && candidate.token === lease.token);
      if (!lease.reservedBy || !stored || stored.state !== "RESERVED" || !stored.reservedBy
        || !sameIdentity(stored.reservedBy, lease.reservedBy) || !sameIdentity(stored.owner, lease.reservedBy)) return NO_COMMIT;
      stored.state = "ACTIVE";
      stored.owner = child;
      return true;
    }, false);
  }

  /** Release is allowed to the reservation owner before bind or active child after bind. */
  async releaseLease(lease: TreePermitLease): Promise<boolean> {
    const current = this.#currentIdentity();
    if (lease.authority !== this || !current) return false;
    return await this.#mutate((state, durable) => {
      const original = durable.leases.find((candidate) => candidate.id === lease.id && candidate.token === lease.token);
      // An exact lease removed by the parent detached-ownership settlement is
      // a successful idempotent child self-release. A reused id is never one.
      if (!original) return durable.leases.some((candidate) => candidate.id === lease.id) ? NO_COMMIT : true;
      const index = state.leases.findIndex((candidate) => candidate.id === lease.id && candidate.token === lease.token);
      if (index < 0 || !sameIdentity(state.leases[index]!.owner, current)) return NO_COMMIT;
      state.leases.splice(index, 1);
      return true;
    }, false);
  }

  /** Trusted launcher handoff from a live stopped wrapper to the exact Pi child. */
  async rebindActiveLease(lease: TreePermitLease, expectedOwner: ProcessIdentity, child: ProcessIdentity): Promise<boolean> {
    const current = this.#currentIdentity();
    const reservedBy = lease.reservedBy;
    if (lease.authority !== this || !reservedBy || !current || !sameIdentity(current, reservedBy) || !validIdentity(expectedOwner) || !validIdentity(child)
      || this.#classify(expectedOwner) !== "live" || this.#classify(child) !== "live") return false;
    return await this.#mutate((state) => {
      const stored = state.leases.find((candidate) => candidate.id === lease.id && candidate.token === lease.token);
      if (!stored || !stored.reservedBy || !sameIdentity(stored.reservedBy, reservedBy)
        || stored.state !== "ACTIVE" || !sameIdentity(stored.owner, expectedOwner)) return NO_COMMIT;
      stored.owner = child;
      return true;
    }, false);
  }

  /** The parent can reclaim a bound child only after exact-dead proof. */
  async finalizeBoundLeaseIfDead(lease: TreePermitLease): Promise<boolean> {
    const current = this.#currentIdentity();
    const reservedBy = lease.reservedBy;
    if (lease.authority !== this || !reservedBy || !current || this.#classify(current) !== "live" || !sameIdentity(current, reservedBy)) return false;
    return await this.#mutate((state, durable) => {
      const original = durable.leases.find((candidate) => candidate.id === lease.id && candidate.token === lease.token);
      // A same-id record with a different token proves this is not an idempotent
      // retry of the original lease.
      if (!original && durable.leases.some((candidate) => candidate.id === lease.id)) return NO_COMMIT;
      if (original && (!original.reservedBy || !sameIdentity(original.reservedBy, reservedBy))) return NO_COMMIT;
      const index = state.leases.findIndex((candidate) => candidate.id === lease.id && candidate.token === lease.token);
      // Dead-lease reclamation runs before this callback. An exact, durable
      // lease that disappeared that way is a successful idempotent finalization.
      if (index < 0) return true;
      const stored = state.leases[index]!;
      if (stored.state !== "ACTIVE" || sameIdentity(stored.owner, reservedBy) || this.#classify(stored.owner) !== "dead") return NO_COMMIT;
      state.leases.splice(index, 1);
      return true;
    }, false);
  }

  /** Trusted external-detachment path for the exact original reservation owner. */
  async detachBoundLease(lease: TreePermitLease): Promise<boolean> {
    const current = this.#currentIdentity();
    const reservedBy = lease.reservedBy;
    if (lease.authority !== this || !reservedBy || !current || this.#classify(current) !== "live" || !sameIdentity(current, reservedBy)) return false;
    return await this.#mutate((state, durable) => {
      const original = durable.leases.find((candidate) => candidate.id === lease.id && candidate.token === lease.token);
      if (!original && durable.leases.some((candidate) => candidate.id === lease.id)) return NO_COMMIT;
      if (original && (!original.reservedBy || !sameIdentity(original.reservedBy, reservedBy))) return NO_COMMIT;
      const index = state.leases.findIndex((candidate) => candidate.id === lease.id && candidate.token === lease.token);
      if (index < 0) return true;
      const stored = state.leases[index]!;
      if (stored.state !== "ACTIVE" || sameIdentity(stored.owner, reservedBy)) return NO_COMMIT;
      state.leases.splice(index, 1);
      return true;
    }, false);
  }

  async #acquire(foreground: boolean, options: AcquireReservationOptions): Promise<TreePermitLease | null> {
    if (options.signal?.aborted) return null;
    const current = this.#currentIdentity();
    if (!current || this.#classify(current) !== "live") throw new Error("Current process no longer has a live exact identity.");
    const lease = await this.#mutate((state) => {
      if (options.signal?.aborted || used(state) >= state.maxActive || state.leases.length >= MAX_TREE_PERMIT_LEASES) return NO_COMMIT;
      const reserved: StoredLease = { id: crypto.randomUUID(), token: randomToken(), state: "RESERVED", owner: current, reservedBy: current };
      state.leases.push(reserved);
      // Reject the admission before any successor/checkpoint serialization.
      if (!fitsSnapshotEnvelope(state)) { state.leases.pop(); return NO_COMMIT; }
      return reserved;
    }, null);
    if (!lease) return null;
    const reservation = new TreePermitLease(this, lease.id, lease.token, lease.reservedBy);
    if (options.signal?.aborted) { await reservation.release(); return null; }
    return reservation;
  }

  /** @internal ForegroundDelegationScope-only acquisition path. */
  async _acquireForeground(scope: ForegroundDelegationScope, options: AcquireReservationOptions): Promise<TreePermitLease | null> {
    if (!foregroundScopes.has(scope) || scope.authority !== this) throw new Error("Invalid foreground delegation scope.");
    if (options.signal?.aborted) return null;
    const current = this.#currentIdentity();
    if (!current || this.#classify(current) !== "live") throw new Error("Current process no longer has a live exact identity.");
    const lease = await this.#mutate((state) => {
      if (options.signal?.aborted || used(state) >= state.maxActive || state.leases.length >= MAX_TREE_PERMIT_LEASES) return NO_COMMIT;
      const reserved: StoredLease = { id: crypto.randomUUID(), token: randomToken(), state: "RESERVED", owner: current, reservedBy: current };
      state.leases.push(reserved);
      // Reject the admission before any successor/checkpoint serialization.
      if (!fitsSnapshotEnvelope(state)) { state.leases.pop(); return NO_COMMIT; }
      return reserved;
    }, null);
    if (!lease) return null;
    if (options.signal?.aborted) {
      await this._abortScopeReservation(scope, lease);
      return null;
    }
    return new TreePermitLease(this, lease.id, lease.token, lease.reservedBy, (released) => scope._released(released));
  }

  /** @internal Atomically remove an aborted reservation and resume when drained. */
  async _abortScopeReservation(scope: ForegroundDelegationScope, lease: StoredLease): Promise<void> {
    if (!foregroundScopes.has(scope) || scope.authority !== this) throw new Error("Invalid foreground delegation scope.");
    // This runs from the acquire's finally path while that acquire is still
    // counted as pending.  Record a durable resume before returning so close()
    // and the shared manager never retain a scope whose parent is already live.
    const resumed = await this.#mutate((state) => {
      const index = state.leases.findIndex((candidate) => candidate.id === lease.id && candidate.token === lease.token && candidate.state === "RESERVED");
      if (index >= 0) state.leases.splice(index, 1);
      const parentResumed = scope._canResumeNow(true) && this.#resumeInState(state, scope.parentLease);
      if (index < 0 && !parentResumed) return NO_COMMIT;
      return parentResumed;
    }, false);
    if (resumed) scope._resumedDurably();
  }

  /** @internal ForegroundDelegationScope-only parent resume path. */
  async _resumeScope(scope: ForegroundDelegationScope): Promise<boolean> {
    if (!foregroundScopes.has(scope) || scope.authority !== this) throw new Error("Invalid foreground delegation scope.");
    return await this.#mutate((state) => {
      return scope._canResumeNow() && this.#resumeInState(state, scope.parentLease) ? true : NO_COMMIT;
    }, false);
  }

  /** @internal Check that this exact child lease has already released itself. */
  async _leaseAbsent(lease: TreePermitLease): Promise<boolean> {
    const manifest = await this.#readManifest();
    const snapshot = await loadStableLatestSnapshot(this.authorityDir, manifest);
    if (!snapshot) throw new Error("Tree permit authority state chain is invalid.");
    const sameId = snapshot.state.leases.filter((candidate) => candidate.id === lease.id);
    // A same-id/different-token record is not absence of this authority. It is
    // anomalous (and must remain fail-closed), never permission to resume.
    return sameId.length === 0;
  }

  #resumeInState(state: PermitState, parentLease: TreePermitLease): boolean {
    const parent = state.leases.find((lease) => lease.id === parentLease.id && lease.token === parentLease.token);
    const current = this.#currentIdentity();
    if (!parent || !current || parent.state !== "PARKED_WAIT" || !sameIdentity(parent.owner, current) || used(state) >= state.maxActive) return false;
    parent.state = "ACTIVE";
    return true;
  }

  async #mutate<T>(change: (state: PermitState, durable: PermitState) => MutationResult<T>, noCommitResult: T): Promise<T> {
    await assertSafeStateRoot(this.rootDir);
    await ensureNamespace(this.rootDir);
    let sawInvalidSnapshot = false;
    let compactionRequired = false;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt += 1) {
      const manifest = await this.#readManifest();
      const snapshot = await loadLatestSnapshot(this.authorityDir, manifest);
      // A reader can observe an unlink in a completed checkpoint compaction.
      // Retry the whole load/CAS cycle; malformed data never becomes accepted.
      if (!snapshot) { sawInvalidSnapshot = true; await sleep(RETRY_MS); continue; }
      if (compactionRequired || snapshot.requiresCompaction || snapshot.state.generation - snapshot.checkpointGeneration >= CHECKPOINT_INTERVAL
        || snapshot.totalBytes + (2 * SNAPSHOT_FILE_BYTES) > MAX_SNAPSHOT_BYTES) {
        compactionRequired = true;
        // A concurrent compactor can unlink an enumerated old state between
        // inspection and removal. Retry from a fresh immutable head instead
        // of treating that transient disappearance as an accepted chain.
        try { await ensureCheckpointAndCompact(this.authorityDir, manifest, snapshot); compactionRequired = false; } catch { sawInvalidSnapshot = true; }
        await sleep(RETRY_MS);
        continue;
      }
      const state = cloneState(snapshot.state);
      const leaseCount = state.leases.length;
      state.leases = state.leases.filter((lease) => this.#classify(lease.owner) !== "dead");
      const reclaimed = state.leases.length !== leaseCount;
      const result = change(state, snapshot.state);
      if (used(state) > state.maxActive) throw new Error("Tree permit active cap invariant would be violated.");
      // Old v1 state may contain more parked leases than the new representation
      // allows. Only mutations that shrink it may proceed until it is repaired.
      if (state.leases.length > MAX_TREE_PERMIT_LEASES && state.leases.length >= snapshot.state.leases.length) {
        throw new Error("Tree permit total lease cap invariant would be violated.");
      }
      if (result === NO_COMMIT && !reclaimed) return noCommitResult;
      const nextGeneration = snapshot.state.generation + 1;
      if (!generation(nextGeneration)) throw new Error("Tree permit snapshot generation is unsafe.");
      state.generation = nextGeneration;
      state.previousDigest = snapshot.digest;
      if (!fitsSnapshotEnvelope(state)) throw new Error("Tree permit state exceeds its reserved checkpoint envelope.");
      if (await publishSnapshot(this.authorityDir, state, this.#currentIdentity() ?? undefined)) return result === NO_COMMIT ? noCommitResult : result;
      await sleep(RETRY_MS);
    }
    if (sawInvalidSnapshot) throw new Error("Tree permit authority state chain is invalid.");
    throw new Error("Tree permit authority CAS contention limit exceeded.");
  }

  async #readManifest(): Promise<Manifest> {
    await assertAuthorityDirectory(this.namespaceDir, this.rootIdentity);
    const manifest = await readPrivateJson(path.join(this.authorityDir, MANIFEST), parseManifest);
    const creation = await readPrivateJson(path.join(this.authorityDir, CREATION), parseCreation);
    if (!manifest || !creation || !sameAuthority(creation, manifest) || manifest.rootIdentity !== this.rootIdentity || manifest.token !== this.token || manifest.maxActive !== this.maxActive) throw new Error("Tree permit authority configuration changed or is invalid.");
    return manifest;
  }
}

/** Foreground-only delegation lifecycle; background acquisition exposes no transfer operation. */
interface ChildSettlementWatcher { controller: AbortController; completion: Promise<void>; }

export class ForegroundDelegationScope {
  #closed = false;
  #pending = 0;
  #active = new Set<TreePermitLease>();
  #watchers = new Map<TreePermitLease, ChildSettlementWatcher>();
  /** Suppress cancellation only while this watcher's dead-child finalization calls back. */
  #finalizingFromWatcher = new Set<TreePermitLease>();
  #resumed = false;
  constructor(readonly authority: TreePermitAuthority, readonly parentLease: TreePermitLease) {}

  /** A closed scope must never be reused to reserve work for a new invocation. */
  get isClosed(): boolean { return this.#closed; }
  /** True only after the parked parent lease is durably active again. */
  get isResolved(): boolean { return this.#resumed; }

  async acquireReservation(options: AcquireReservationOptions = {}): Promise<TreePermitLease | null> {
    if (this.#closed || options.signal?.aborted) return null;
    this.#pending += 1;
    try {
      const lease = await this.authority._acquireForeground(this, options);
      if (lease) this.#active.add(lease);
      return lease;
    } finally { this.#pending -= 1; }
  }

  async waitForReservation(options: AcquireReservationOptions = {}): Promise<TreePermitLease | null> {
    while (!this.#closed && !options.signal?.aborted) {
      const lease = await this.acquireReservation(options);
      if (lease) return lease;
      if (!await sleep(RETRY_MS, options.signal)) return null;
    }
    return null;
  }

  /**
   * Mark a launched descendant settled after the launcher observes its exit.
   * This removes local bookkeeping only if the child released itself, or after
   * exact-dead reclamation; it cannot revoke a live child.
   */
  async completeChild(lease: TreePermitLease): Promise<boolean> {
    return await this.#completeChild(lease, false);
  }

  async #completeChild(lease: TreePermitLease, retainWatcher: boolean): Promise<boolean> {
    if (!this.#active.has(lease)) return false;
    let settled = await this.authority._leaseAbsent(lease);
    if (!settled) {
      if (retainWatcher) this.#finalizingFromWatcher.add(lease);
      try { settled = await lease.finalizeBoundChildIfDead(); }
      finally { if (retainWatcher) this.#finalizingFromWatcher.delete(lease); }
    }
    if (!settled) return false;
    this.#active.delete(lease);
    if (!retainWatcher) this.#cancelWatcher(lease);
    await this.#maybeResume();
    return true;
  }

  /**
   * Retain one unref'd reconciliation loop for a result whose exact child may
   * still be transiently alive. Unknown authority state is deliberately
   * retried: only durable absence or exact-dead finalization settles a lease.
   */
  watchChildSettlement(lease: TreePermitLease): boolean {
    if (!this.#active.has(lease) || !lease.hasBoundChild || this.#watchers.has(lease)) return false;
    const controller = new AbortController();
    const watcher: ChildSettlementWatcher = {
      controller,
      completion: Promise.resolve(),
    };
    watcher.completion = this.#reconcileChildUntilSettled(lease, controller.signal)
      .catch(() => undefined)
      .finally(() => { if (this.#watchers.get(lease) === watcher) this.#watchers.delete(lease); });
    this.#watchers.set(lease, watcher);
    return true;
  }

  /** Stop accepting descendants; retain or begin reconciliation for every active child. */
  async close(): Promise<boolean> {
    this.#closed = true;
    for (const lease of this.#active) this.watchChildSettlement(lease);
    return await this.#maybeResume();
  }

  /**
   * Session shutdown may cancel only idle scope watchers. Active children keep
   * their watcher so this still-live Pi process can resume its parked parent
   * after an exact child exit; cancellation never releases a permit.
   */
  async cancelSettlementWatchersIfIdle(): Promise<boolean> {
    if (this.#active.size !== 0) return false;
    const watchers = Array.from(this.#watchers.values());
    for (const watcher of watchers) watcher.controller.abort();
    await Promise.all(watchers.map((watcher) => watcher.completion));
    return true;
  }

  /** Internal callback from a locally owned lease after durable release. */
  async _released(lease: TreePermitLease): Promise<void> {
    this.#active.delete(lease);
    // An independently durable child release ends reconciliation. A watcher
    // finalizing an exact-dead child retains itself long enough to retry the
    // parked-parent resume if the first CAS loses.
    if (!this.#finalizingFromWatcher.has(lease)) this.#cancelWatcher(lease);
    await this.#maybeResume();
  }

  #cancelWatcher(lease: TreePermitLease): void {
    const watcher = this.#watchers.get(lease);
    if (watcher) watcher.controller.abort();
  }

  async #reconcileChildUntilSettled(lease: TreePermitLease, signal: AbortSignal): Promise<void> {
    let delay = RETRY_MS;
    while (!signal.aborted) {
      if (this.#active.has(lease)) {
        try { await this.#completeChild(lease, true); } catch {
          // Invalid, replaced, or unreadable authority state is not proof that
          // this exact child ended. Preserve capacity and retry fail-closed.
        }
      }
      // A child can settle before this invocation closes its shared scope. Keep
      // the one watcher until close makes a parent resume legal, then retry a
      // transiently lost resume CAS with the same bounded backoff.
      if (!this.#active.has(lease) && this.#closed) {
        try { if (this.#resumed || await this.#maybeResume()) return; } catch {
          // Authority failures are fail-closed; retry rather than unpark.
        }
      }
      if (!await sleepUnref(delay, signal)) return;
      delay = Math.min(delay * 2, SETTLEMENT_WATCH_MAX_DELAY_MS);
    }
  }

  /** The abort mutation already durably resumed the exact parked parent. */
  _resumedDurably(): void { this.#resumed = true; }

  /** Internal state predicate; an abort runs while its own acquire is pending. */
  _canResumeNow(allowCurrentPending = false): boolean {
    return this.#closed && this.#active.size === 0 && (this.#pending === 0 || allowCurrentPending && this.#pending === 1);
  }

  async #maybeResume(): Promise<boolean> {
    if (this.#resumed || !this.#closed || this.#pending !== 0 || this.#active.size !== 0) return false;
    const resumed = await this.authority._resumeScope(this);
    if (resumed) this.#resumed = true;
    return resumed;
  }
}

export class TreePermitLease {
  #released = false;
  #boundChild = false;
  #onRelease?: (lease: TreePermitLease) => Promise<void>;
  constructor(readonly authority: TreePermitAuthority, readonly id: string, readonly token: string, readonly reservedBy: ProcessIdentity | undefined, onRelease?: (lease: TreePermitLease) => Promise<void>) {
    this.#onRelease = onRelease;
  }
  get hasBoundChild(): boolean { return this.#boundChild; }
  async #markReleased(): Promise<void> {
    this.#released = true;
    const scope = this.#onRelease;
    if (scope) await scope(this);
  }
  async bindChildIdentity(child: ProcessIdentity): Promise<boolean> {
    const bound = await this.authority.bindLease(this, child);
    if (bound) this.#boundChild = true;
    return bound;
  }
  async rebindChildIdentity(expectedOwner: ProcessIdentity, child: ProcessIdentity): Promise<boolean> {
    const rebound = await this.authority.rebindActiveLease(this, expectedOwner, child);
    if (rebound) this.#boundChild = true;
    return rebound;
  }
  async release(): Promise<boolean> {
    if (this.#released) return true;
    const released = await this.authority.releaseLease(this);
    if (released) await this.#markReleased();
    return released;
  }
  /** Only the original reservation owner may reclaim an exact-dead bound child. */
  async finalizeBoundChildIfDead(): Promise<boolean> {
    if (this.#released) return true;
    const finalized = await this.authority.finalizeBoundLeaseIfDead(this);
    if (finalized) await this.#markReleased();
    return finalized;
  }
  /** Trusted path after durable external user detachment; it may remove a live bound child. */
  async detachBoundChild(): Promise<boolean> {
    if (this.#released) return true;
    const detached = await this.authority.detachBoundLease(this);
    if (detached) await this.#markReleased();
    return detached;
  }
  exportChildEnv(): Record<string, string> { return this.authority.exportChildEnv(this); }
}

export async function createTreePermitAuthority(options: TreePermitAuthorityOptions): Promise<TreePermitAuthority> { return await TreePermitAuthority.create(options); }
export async function adoptTreePermitAuthority(options: AdoptTreePermitAuthorityOptions = {}): Promise<TreePermitAuthority> { return await TreePermitAuthority.adopt(options); }

/** Remove only bounded, exact-dead complete public authorities and private artifacts. */
export async function reconcileTreePermitAuthorities(options: ReconcileTreePermitAuthoritiesOptions = {}): Promise<ReconcileTreePermitAuthoritiesResult> {
  const rootDir = path.resolve(options.rootDir ?? getRunStateRoot());
  try {
    await fs.promises.lstat(rootDir);
  } catch (error) {
    // First startup has no retained state to reconcile. Do not initialize the
    // root here: authority creation remains responsible for that transition.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: [], retained: [], scanned: 0 };
    throw error;
  }
  await assertSafeStateRoot(rootDir);
  const namespaceDir = await ensureNamespace(rootDir);
  const classify = options.classifyIdentity ?? ((identity: ProcessIdentity) => classifyParentProcessIdentity(identity.pid, identity.startedAt));
  const limit = options.limit ?? 32;
  if (!positive(limit) || limit > MAX_RECONCILE_LIMIT) throw new Error(`Tree permit reconciliation limit must be a positive integer at most ${MAX_RECONCILE_LIMIT}.`);
  const cursor = await readPrivateJson(path.join(namespaceDir, RECONCILE_CURSOR), parseReconcileCursor);
  const entries = await collectReconcileEntries(namespaceDir, cursor?.lastScanned, cursor?.lastArtifact, limit);
  const result: ReconcileTreePermitAuthoritiesResult = { removed: [], retained: [], scanned: entries.length };
  for (const entry of entries) {
    const target = path.join(namespaceDir, entry.name);
    if (path.dirname(target) !== namespaceDir) { result.retained.push(entry.name); continue; }
    if (entry.artifact) {
      if (classify(entry.artifact.owner) !== "dead" || !await removeDeadPrivateArtifact(namespaceDir, target, entry.artifact)) result.retained.push(entry.name);
      else result.removed.push(entry.name);
      continue;
    }
    const stat = await fs.promises.lstat(target).catch(() => null);
    if (!stat || !privateDirectory(stat)) { result.retained.push(entry.name); continue; }
    const creation = await readPrivateJson(path.join(target, CREATION), parseCreation);
    if (!creation || creation.rootIdentity !== entry.name) { result.retained.push(entry.name); continue; }
    const manifest = await readPrivateJson(path.join(target, MANIFEST), parseManifest);
    // Public names from before staging can be incomplete.  They are ambiguous
    // legacy authorities, so retain them instead of treating them as cleanup.
    if (!manifest || !sameAuthority(creation, manifest)) { result.retained.push(entry.name); continue; }
    const snapshot = await loadStableLatestSnapshot(target, manifest);
    if (!snapshot || snapshot.state.leases.some((lease) => classify(lease.owner) !== "dead") || classify(creation.creator) !== "dead") { result.retained.push(entry.name); continue; }
    const stable = await fs.promises.lstat(target).catch(() => null);
    if (!stable || !samePrivateNode(stable, stat, true) || !await quarantineAndRemoveAuthority(namespaceDir, target, stable, entry.name)) { result.retained.push(entry.name); continue; }
    result.removed.push(entry.name);
  }
  if (entries.length > 0) {
    const lastAuthority = entries.filter((entry) => !entry.artifact).at(-1)?.name;
    const lastArtifact = entries.filter((entry) => entry.artifact).at(-1)?.name;
    await writeReconcileCursor(namespaceDir, lastAuthority ?? cursor?.lastScanned ?? lastArtifact!, lastArtifact ?? cursor?.lastArtifact);
  }
  return result;
}

interface ReconcileEntry { name: string; artifact: PrivateArtifact | null; }
function insertCandidate(candidates: ReconcileEntry[], candidate: ReconcileEntry, limit: number): void {
  const position = candidates.findIndex((existing) => existing.name > candidate.name);
  if (position < 0) candidates.push(candidate); else candidates.splice(position, 0, candidate);
  if (candidates.length > limit) candidates.pop();
}
async function collectReconcileEntries(namespaceDir: string, after: string | undefined, artifactAfter: string | undefined, limit: number, allowWrap = true): Promise<ReconcileEntry[]> {
  // Stream the whole bounded namespace. Directory enumeration order is not
  // lexical; stopping at a physical page can permanently starve a later UUID.
  // Candidate arrays remain bounded even for a namespace near the hard cap.
  const authorityCandidates: ReconcileEntry[] = [];
  const artifactCandidates: ReconcileEntry[] = [];
  let directory: fs.Dir;
  try { directory = await fs.promises.opendir(namespaceDir); } catch { return []; }
  try {
    let worked = 0;
    for await (const entry of directory) {
      if (++worked > MAX_RECONCILE_SCAN_ENTRIES) return [];
      if (worked % RECONCILE_YIELD_EVERY === 0) await sleep(0);
      if (uuid(entry.name as unknown)) {
        if (!after || entry.name > after) insertCandidate(authorityCandidates, { name: entry.name, artifact: null }, limit);
      } else {
        const artifact = parsePrivateArtifact(entry.name);
        if (artifact && (!artifactAfter || entry.name > artifactAfter)) insertCandidate(artifactCandidates, { name: entry.name, artifact }, limit);
      }
    }
  } catch { return []; }
  // Reserve at most half the requested mutations for private artifacts. This
  // preserves authority progress while `limit` remains a hard mutation bound.
  const authorityLimit = Math.max(1, Math.ceil(limit / 2));
  const artifactLimit = limit - authorityLimit;
  // With one mutation slot, finish the public-authority pass before spending
  // it on artifacts; once that cursor reaches its end, artifacts still make
  // progress instead of being permanently excluded by a zero-sized lane.
  const selected = (limit === 1
    ? (authorityCandidates.length > 0 ? authorityCandidates.slice(0, 1) : artifactCandidates.slice(0, 1))
    : [
      ...authorityCandidates.slice(0, authorityLimit),
      ...artifactCandidates.slice(0, artifactLimit),
    ]).sort((left, right) => left.name.localeCompare(right.name));
  if (selected.length === 0 && allowWrap && (after || artifactAfter)) return await collectReconcileEntries(namespaceDir, undefined, undefined, limit, false);
  return selected;
}
function samePrivateNode(current: fs.Stats | null, expected: fs.Stats, directory: boolean): boolean {
  return !!current && current.dev === expected.dev && current.ino === expected.ino
    && (directory ? privateDirectory(current) : privateFile(current));
}
async function removeDeadPrivateArtifact(namespaceDir: string, artifactPath: string, artifact: PrivateArtifact): Promise<boolean> {
  const expectedDirectory = artifact.kind !== "temp";
  const first = await fs.promises.lstat(artifactPath).catch(() => null);
  if (!first || !samePrivateNode(first, first, expectedDirectory) || Date.now() - first.mtimeMs < ARTIFACT_MINIMUM_AGE_MS) return false;
  const stable = await fs.promises.lstat(artifactPath).catch(() => null);
  if (!stable || !samePrivateNode(stable, first, expectedDirectory) || stable.mtimeMs !== first.mtimeMs || Date.now() - stable.mtimeMs < ARTIFACT_MINIMUM_AGE_MS) return false;
  const publisher = defaultCurrentIdentity();
  if (!publisher) return false;
  const quarantine = path.join(namespaceDir, tombstoneName(artifact.rootIdentity ?? crypto.randomUUID(), publisher));
  if (path.dirname(quarantine) !== namespaceDir) return false;
  try { await fs.promises.rename(artifactPath, quarantine); } catch { return false; }
  const quarantined = await fs.promises.lstat(quarantine).catch(() => null);
  if (!samePrivateNode(quarantined, first, expectedDirectory)) return false;
  try {
    if (expectedDirectory) await fs.promises.rm(quarantine, { recursive: true, force: false });
    else await fs.promises.unlink(quarantine);
    await fsyncDirectory(namespaceDir);
    return true;
  } catch { return false; }
}

/** Move a verified public inode to an identity-bound tombstone before removal. */
async function quarantineAndRemoveAuthority(namespaceDir: string, authorityDir: string, expected: fs.Stats, rootIdentity: string): Promise<boolean> {
  const publisher = defaultCurrentIdentity();
  if (!publisher) return false;
  const tombstone = path.join(namespaceDir, tombstoneName(rootIdentity, publisher));
  if (path.dirname(tombstone) !== namespaceDir) return false;
  try { await fs.promises.rename(authorityDir, tombstone); } catch { return false; }
  const quarantined = await fs.promises.lstat(tombstone).catch(() => null);
  if (!samePrivateNode(quarantined, expected, true)) return false;
  try {
    await fs.promises.rm(tombstone, { recursive: true, force: false });
    await fsyncDirectory(namespaceDir);
    return true;
  } catch { return false; }
}

export interface TreePermitAuthorityLifecycleOptions {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  create?: (options: { maxActive: number }) => Promise<TreePermitAuthority>;
  adopt?: () => Promise<TreePermitAuthority>;
  reconcile?: () => Promise<unknown>;
  sleep?: (milliseconds: number) => Promise<void>;
  warn?: (message: string) => void;
}

/** Platform-gated authority lifecycle with process-local fallback. */
export function createTreePermitAuthorityLifecycle(options: TreePermitAuthorityLifecycleOptions = {}) {
  const enabled = supportsTreePermitAuthority(options.platform);
  const env = options.env ?? process.env;
  const create = options.create ?? createTreePermitAuthority;
  const adopt = options.adopt ?? adoptTreePermitAuthority;
  const reconcile = options.reconcile ?? reconcileTreePermitAuthorities;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const warn = options.warn ?? console.warn;
  let authority: TreePermitAuthority | null = null;
  let authorityPromise: Promise<TreePermitAuthority> | null = null;

  const get = async (maxActive: number): Promise<TreePermitAuthority | null> => {
    if (!enabled) return null;
    if (authority) return authority;
    if (!authorityPromise) {
      authorityPromise = (async () => {
        if (!env[TREE_PERMIT_ROOT_ENV]) return await create({ maxActive });
        const deadline = Date.now() + 10_000;
        let lastError: unknown;
        do {
          try { return await adopt(); } catch (error) { lastError = error; }
          await sleep(25);
        } while (Date.now() < deadline);
        throw lastError instanceof Error ? lastError : new Error("Tree permit authority adoption timed out.");
      })().then((created) => (authority = created));
    }
    return await authorityPromise;
  };

  return {
    get,
    async startup(maxActive: number): Promise<TreePermitAuthority | null> {
      if (!enabled) return null;
      if (!env[TREE_PERMIT_ROOT_ENV] && !authority) {
        await reconcile().catch((error) => {
          warn(`[pi-subagent] Tree permit startup reconciliation retained state: ${error instanceof Error ? error.message : String(error)}`);
        });
        return await get(maxActive);
      }
      if (authority && authority.maxActive !== maxActive) {
        warn(`[pi-subagent] Tree permit cap remains ${authority.maxActive} for the lifetime of this Pi process; the new session requested ${maxActive}.`);
      }
      return authority;
    },
  };
}

export interface SharedForegroundPermitScope {
  readonly isClosed: boolean;
  /** A closed scope is reusable only for retrying its durable parent resume. */
  readonly isResolved: boolean;
  close(): Promise<boolean>;
  /** Optional so lightweight lifecycle seams need not emulate child watchers. */
  cancelSettlementWatchersIfIdle?(): Promise<boolean>;
}

/** Shares a live foreground scope and retries a closed unresolved parent resume. */
export function createSharedForegroundPermitScopeManager() {
  let scope: SharedForegroundPermitScope | null = null;
  let scopePromise: Promise<SharedForegroundPermitScope> | null = null;
  let users = 0;
  const clearResolvedScope = (candidate: SharedForegroundPermitScope) => {
    if (scope === candidate && candidate.isResolved) {
      scope = null;
      scopePromise = null;
    }
  };
  return {
    async acquire(authority: { beginForegroundDelegation(): Promise<SharedForegroundPermitScope> }): Promise<SharedForegroundPermitScope> {
      if (scope?.isClosed) {
        // `close` is idempotent but its durable CAS may have lost capacity or
        // contention on a previous attempt. Retry it before admitting another
        // foreground invocation; a parked parent must never be abandoned.
        const closed = scope;
        await closed.close();
        clearResolvedScope(closed);
        if (scope === closed) throw new Error("Tree permit foreground scope remains unresolved; new reservations are blocked.");
      }
      if (!scopePromise) {
        const pending = authority.beginForegroundDelegation().then((created) => (scope = created));
        scopePromise = pending;
        // A rejected creation can follow a durable parent park (for example,
        // after an ambiguous response failure). Do not cache that rejection:
        // the next acquire must retry and adopt the exact parked parent lease.
        void pending.catch(() => { if (scopePromise === pending) scopePromise = null; });
      }
      const acquired = await scopePromise;
      if (acquired.isClosed) {
        await acquired.close();
        clearResolvedScope(acquired);
        if (scope === acquired) throw new Error("Tree permit foreground scope remains unresolved; new reservations are blocked.");
        return await this.acquire(authority);
      }
      users += 1;
      return acquired;
    },
    async release(released: SharedForegroundPermitScope): Promise<boolean> {
      if (released !== scope || users <= 0) return false;
      users -= 1;
      if (users > 0) return true;
      const resumed = await released.close();
      clearResolvedScope(released);
      return resumed;
    },
    async cancelSettlementWatchersIfIdle(): Promise<boolean> {
      return await scope?.cancelSettlementWatchersIfIdle?.() ?? true;
    },
  };
}

function sameAuthority(creation: CreationRecord, manifest: Manifest): boolean {
  return creation.rootIdentity === manifest.rootIdentity && creation.token === manifest.token && creation.maxActive === manifest.maxActive && sameIdentity(creation.creator, manifest.creator);
}
async function ensureNamespace(rootDir: string): Promise<string> {
  await assertSafeStateRoot(rootDir);
  const root = await fs.promises.realpath(rootDir);
  const namespace = path.join(root, NAMESPACE);
  if (path.dirname(namespace) !== root) throw new Error("Tree permit namespace escaped state root.");
  const existing = await fs.promises.lstat(namespace).catch(() => null);
  if (!existing) {
    try { await fs.promises.mkdir(namespace, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const created = await fs.promises.lstat(namespace);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error("Tree permit namespace was replaced during creation.");
    await fs.promises.chmod(namespace, 0o700);
  } else if (!privateDirectory(existing)) throw new Error("Tree permit namespace is not a private non-symlink directory.");
  const checked = await fs.promises.lstat(namespace);
  if (!privateDirectory(checked) || path.dirname(await fs.promises.realpath(namespace)) !== root) throw new Error("Tree permit namespace is unsafe.");
  return namespace;
}
async function assertAuthorityDirectory(namespaceDir: string, rootIdentity: string): Promise<string> {
  const authorityDir = path.join(namespaceDir, rootIdentity);
  if (path.dirname(authorityDir) !== namespaceDir) throw new Error("Tree permit authority escaped namespace.");
  const stat = await fs.promises.lstat(authorityDir).catch(() => null);
  if (!stat || !privateDirectory(stat) || path.dirname(await fs.promises.realpath(authorityDir)) !== await fs.promises.realpath(namespaceDir)) throw new Error("Tree permit authority directory is unsafe or missing.");
  return authorityDir;
}
async function readPrivateText(filePath: string, maximumBytes = SNAPSHOT_FILE_BYTES): Promise<string | null> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!privateFile(stat) || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximumBytes) return null;
    const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!privateFile(opened) || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) return null;
      // Allocate exactly the size already authenticated by lstat/fstat; never
      // let readFile grow an attacker-raced descriptor allocation.
      const bytes = Buffer.allocUnsafe(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) return null;
        offset += bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      if ((await handle.read(probe, 0, 1, stat.size)).bytesRead !== 0) return null;
      const after = await handle.stat();
      if (!privateFile(after) || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) return null;
      // Buffer's UTF-8 conversion replaces malformed sequences. State input is
      // an authenticated protocol, so reject rather than normalize it.
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally { await handle.close(); }
  } catch { return null; }
}
async function readPrivateJson<T>(filePath: string, parse: (value: unknown) => T | null): Promise<T | null> {
  const text = await readPrivateText(filePath);
  if (!text || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) return null;
  try { return parse(JSON.parse(text.slice(0, -1))); } catch { return null; }
}
async function publishImmutableJson(directory: string, name: string, value: unknown, publisher?: ProcessIdentity): Promise<void> {
  if (!await publishImmutableContent(directory, name, `${JSON.stringify(value)}\n`, publisher)) throw new Error(`Tree permit immutable file already exists: ${name}`);
}
async function writeReconcileCursor(namespaceDir: string, lastScanned: string, lastArtifact?: string): Promise<void> {
  const publisher = defaultCurrentIdentity();
  if (!publisher || !validIdentity(publisher)) throw new Error("Unable to establish cursor publisher identity.");
  const content = `${JSON.stringify(lastArtifact ? { version: VERSION, lastScanned, lastArtifact } : { version: VERSION, lastScanned })}\n`;
  const destination = path.join(namespaceDir, RECONCILE_CURSOR);
  const temporary = path.join(namespaceDir, temporaryName(RECONCILE_CURSOR, publisher));
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    await fs.promises.rename(temporary, destination);
    await fsyncDirectory(namespaceDir);
    const cursor = await readPrivateJson(destination, parseReconcileCursor);
    if (!cursor || cursor.lastScanned !== lastScanned) throw new Error("Tree permit reconciliation cursor is unsafe after publish.");
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}
async function publishSnapshot(directory: string, state: PermitState, publisher?: ProcessIdentity): Promise<boolean> {
  return await publishImmutableContent(directory, stateName(state.generation), stateContent(state), publisher);
}
async function publishImmutableContent(directory: string, name: string, content: string, publisher = defaultCurrentIdentity()): Promise<boolean> {
  if (!publisher || !validIdentity(publisher)) throw new Error("Unable to establish immutable publisher identity.");
  if (Buffer.byteLength(content, "utf8") < 1 || Buffer.byteLength(content, "utf8") > SNAPSHOT_FILE_BYTES) throw new Error("Tree permit authority file exceeds the explicit byte cap.");
  const destination = path.join(directory, name);
  const temporary = path.join(directory, temporaryName(name, publisher));
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close(); handle = undefined;
    try { await fs.promises.link(temporary, destination); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    await fs.promises.unlink(temporary);
    await fsyncDirectory(directory);
    const stat = await fs.promises.lstat(destination);
    if (!privateFile(stat) || stat.size !== Buffer.byteLength(content, "utf8")) throw new Error("Tree permit immutable file is not private after publish.");
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
  }
}
function snapshotGeneration(name: string, prefix: "state" | "checkpoint"): number | null {
  const match = new RegExp(`^${prefix}-(\\d{${GENERATION_WIDTH}})\\.json$`).exec(name);
  if (!match) return null;
  const value = Number(match[1]);
  return generation(value) && (prefix === "state" ? stateName(value) : checkpointName(value)) === name ? value : null;
}

/** Bound untrusted directory enumeration before any protocol parsing or reads. */
interface InspectedSnapshotFiles {
  stateNames: string[];
  checkpointNames: string[];
  totalBytes: number;
  legacyNoCheckpoint: boolean;
}

async function inspectSnapshotFiles(directory: string, allowMigrationCompaction = false): Promise<InspectedSnapshotFiles | null> {
  let handle: fs.Dir;
  try { handle = await fs.promises.opendir(directory); } catch { return null; }
  const stateNames: string[] = [];
  const checkpointNames: string[] = [];
  let entries = 0;
  let bytes = 0;
  let hasCheckpoint = false;
  try {
    for await (const entry of handle) {
      // Do not turn a hostile directory into an unbounded names array.  The
      // legacy cap is the only large collection this reader is allowed to hold.
      if (++entries > MAX_SNAPSHOT_DIRECTORY_ENTRIES) return null;
      const name = entry.name;
      const isState = name.startsWith("state-");
      const isCheckpoint = name.startsWith("checkpoint-");
      if (!isState && !isCheckpoint) continue;
      if (snapshotGeneration(name, isState ? "state" : "checkpoint") === null) return null;
      const stat = await fs.promises.lstat(path.join(directory, name)).catch(() => null);
      if (!stat || !privateFile(stat) || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > SNAPSHOT_FILE_BYTES) return null;
      if (isCheckpoint) hasCheckpoint = true;
      // A crash can leave a valid new checkpoint beside an oversized legacy
      // chain.  Enumeration cannot decide that until it has validated the
      // checkpoint and tail, so it always uses the bounded migration envelope.
      // loadLatestSnapshot restores the smaller steady-state limit afterwards.
      if (stateNames.length + checkpointNames.length >= MAX_LEGACY_SNAPSHOT_FILES) return null;
      bytes += stat.size;
      if (!Number.isSafeInteger(bytes) || bytes > MAX_LEGACY_SNAPSHOT_BYTES) return null;
      (isState ? stateNames : checkpointNames).push(name);
    }
  } catch { return null; }
  stateNames.sort();
  checkpointNames.sort();
  return { stateNames, checkpointNames, totalBytes: bytes, legacyNoCheckpoint: !hasCheckpoint };
}

async function loadLatestSnapshot(directory: string, manifest: Manifest): Promise<Snapshot | null> {
  const files = await inspectSnapshotFiles(directory);
  if (!files) return null;
  let checkpoint: Snapshot | null = null;
  // Check every checkpoint, not merely the selected one: a corrupt older
  // checkpoint must not be silently hidden by a newer valid one.
  for (const name of files.checkpointNames) {
    const expectedGeneration = snapshotGeneration(name, "checkpoint");
    const candidate = expectedGeneration === null ? null : await readCheckpoint(directory, name, manifest, expectedGeneration);
    if (!candidate) return null;
    checkpoint = candidate;
  }
  const checkpointGeneration = checkpoint?.state.generation ?? 0;
  const oldStateNames = checkpoint
    ? files.stateNames.filter((name) => (snapshotGeneration(name, "state") ?? Number.MAX_SAFE_INTEGER) <= checkpointGeneration)
    : [];
  const laterStates = files.stateNames.filter((name) => !checkpoint || (snapshotGeneration(name, "state") ?? -1) > checkpointGeneration);
  if (!checkpoint && files.stateNames.length === 0) return null;
  // Only one exact checkpoint plus its pre-checkpoint immutable chain can be
  // an interrupted compaction. Multiple checkpoints or an oversized current
  // tail are not migration input and fail closed.
  const migrationInProgress = checkpoint !== null && files.checkpointNames.length === 1
    && oldStateNames.length > 0
    && files.stateNames.length + files.checkpointNames.length > MAX_SNAPSHOT_FILES;
  if (checkpoint && !migrationInProgress
    && (files.stateNames.length + files.checkpointNames.length > MAX_SNAPSHOT_FILES || files.totalBytes > MAX_SNAPSHOT_BYTES)) return null;
  let previousDigest = checkpoint?.digest ?? GENESIS_DIGEST;
  let latest = checkpoint;
  let expectedGeneration = checkpoint ? checkpointGeneration + 1 : 0;
  for (const name of laterStates) {
    if (name !== stateName(expectedGeneration)) return null;
    const snapshot = await readSnapshot(directory, name, manifest, expectedGeneration);
    if (!snapshot || snapshot.state.previousDigest !== previousDigest) return null;
    previousDigest = snapshot.digest;
    latest = snapshot;
    expectedGeneration += 1;
  }
  const requiresCompaction = checkpoint
    ? migrationInProgress || files.checkpointNames.length > 1 || oldStateNames.length > 0
    // A no-checkpoint history is migration input only once it exceeds the
    // compact steady-state tail. Its full chain was still validated above.
    : files.stateNames.length > MAX_SNAPSHOT_FILES;
  return latest ? { ...latest, checkpointGeneration, requiresCompaction, fileCount: files.stateNames.length + files.checkpointNames.length, totalBytes: files.totalBytes } : null;
}

async function loadStableLatestSnapshot(directory: string, manifest: Manifest): Promise<Snapshot | null> {
  for (let attempt = 0; attempt < MAX_SNAPSHOT_LOAD_RETRIES; attempt += 1) {
    const snapshot = await loadLatestSnapshot(directory, manifest);
    if (snapshot) return snapshot;
    await sleep(RETRY_MS);
  }
  return null;
}

async function readSnapshot(directory: string, name: string, manifest: Manifest, expectedGeneration: number): Promise<Snapshot | null> {
  const text = await readPrivateText(path.join(directory, name));
  if (!text || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) return null;
  let state: PermitState | null = null;
  try { state = parseState(JSON.parse(text.slice(0, -1))); } catch { return null; }
  if (!state || stateContent(state) !== text || state.rootIdentity !== manifest.rootIdentity || state.maxActive !== manifest.maxActive || state.generation !== expectedGeneration || used(state) > state.maxActive) return null;
  return { state, digest: contentDigest(text), checkpointGeneration: 0, requiresCompaction: false, fileCount: 0, totalBytes: 0 };
}

async function readCheckpoint(directory: string, name: string, manifest: Manifest, expectedGeneration: number): Promise<Snapshot | null> {
  const text = await readPrivateText(path.join(directory, name));
  if (!text || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) return null;
  let checkpoint: Checkpoint | null = null;
  try { checkpoint = parseCheckpoint(JSON.parse(text.slice(0, -1))); } catch { return null; }
  if (!checkpoint || checkpointContent(checkpoint) !== text || checkpoint.rootIdentity !== manifest.rootIdentity || checkpoint.maxActive !== manifest.maxActive || checkpoint.generation !== expectedGeneration
    || checkpoint.state.rootIdentity !== manifest.rootIdentity || checkpoint.state.maxActive !== manifest.maxActive || checkpoint.state.generation !== expectedGeneration
    || used(checkpoint.state) > checkpoint.state.maxActive || checkpoint.stateDigest !== contentDigest(stateContent(checkpoint.state))
    || !equalMac(checkpoint.hmac, checkpointMac(manifest.token, { version: checkpoint.version, kind: checkpoint.kind, rootIdentity: checkpoint.rootIdentity, maxActive: checkpoint.maxActive, generation: checkpoint.generation, state: checkpoint.state, stateDigest: checkpoint.stateDigest }))) return null;
  return { state: checkpoint.state, digest: checkpoint.stateDigest, checkpointGeneration: checkpoint.generation, requiresCompaction: false, fileCount: 0, totalBytes: 0 };
}

async function ensureCheckpointAndCompact(directory: string, manifest: Manifest, snapshot: Snapshot): Promise<void> {
  const checkpointWithoutMac = { version: VERSION, kind: CHECKPOINT_KIND, rootIdentity: manifest.rootIdentity, maxActive: manifest.maxActive, generation: snapshot.state.generation, state: snapshot.state, stateDigest: snapshot.digest } as const;
  const checkpoint: Checkpoint = { ...checkpointWithoutMac, hmac: checkpointMac(manifest.token, checkpointWithoutMac) };
  const beforePublish = await inspectSnapshotFiles(directory);
  const checkpointBytes = Buffer.byteLength(checkpointContent(checkpoint), "utf8");
  const checkpointAlreadyPresent = beforePublish?.checkpointNames.includes(checkpointName(checkpoint.generation));
  // Legacy no-checkpoint migration may temporarily exceed the steady-state
  // tail count; compaction immediately removes the legacy chain afterwards.
  if (!beforePublish || (!checkpointAlreadyPresent && !beforePublish.legacyNoCheckpoint
    && beforePublish.stateNames.length + beforePublish.checkpointNames.length >= MAX_SNAPSHOT_FILES)
    || (!checkpointAlreadyPresent && beforePublish.totalBytes + checkpointBytes > MAX_LEGACY_SNAPSHOT_BYTES)) {
    throw new Error("Tree permit checkpoint exceeds the authority file cap.");
  }
  if (!await publishImmutableContent(directory, checkpointName(checkpoint.generation), checkpointContent(checkpoint))) {
    // Another publisher may have won. It must be exactly this immutable state,
    // not merely a valid checkpoint at the same generation.
  }
  const verified = await readCheckpoint(directory, checkpointName(checkpoint.generation), manifest, checkpoint.generation);
  if (!verified || verified.digest !== snapshot.digest || stateContent(verified.state) !== stateContent(snapshot.state)) throw new Error("Tree permit checkpoint publish verification failed.");
  const files = await inspectSnapshotFiles(directory, true);
  if (!files) throw new Error("Tree permit checkpoint compaction cannot inspect authority files.");
  for (const name of files.stateNames) {
    const value = snapshotGeneration(name, "state");
    if (value !== null && value <= checkpoint.generation) await fs.promises.unlink(path.join(directory, name)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  for (const name of files.checkpointNames) {
    const value = snapshotGeneration(name, "checkpoint");
    if (value !== null && value < checkpoint.generation) await fs.promises.unlink(path.join(directory, name)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
  await fsyncDirectory(directory);
  if (!await loadLatestSnapshot(directory, manifest)) throw new Error("Tree permit checkpoint compaction verification failed.");
}
