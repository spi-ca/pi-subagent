import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { compareStableSemver, isStableSemverAtLeast, parsePiVersionOutput } from "../../src/runtime/version-policy.mjs";

export const MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV = "PI_SUBAGENT_MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE";
export const MANAGED_CHILD_BASE_MINIMUM_PI_VERSION = "0.80.10";
export const MANAGED_CHILD_LIVE_MINIMUM_PI_VERSION = "0.81.1";
const MAX_PATH_CANDIDATES = 128;
const MAX_PATH_ENTRY_LENGTH = 4_096;
const VERSION_PROBE_TIMEOUT_MS = 5_000;

export interface ManagedChildPiExecutableGeneration {
  executable: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mode: number;
  uid: number;
  /** Credentialed live launches require the descriptor-validated native format. */
  nativeExecutable: boolean;
  /** A separately verified 0700 runtime root may terminate ancestry validation. */
  privateRoot?: string;
}

type CanonicalizeCandidate = (candidate: string) => string | null;
type ProbePiVersion = (executable: string) => string | null;

export interface ResolveManagedChildAcceptancePiOptions {
  pathValue: string | undefined;
  minimumVersion: string;
  delimiter?: string;
  maxPathCandidates?: number;
  canonicalizeCandidate?: CanonicalizeCandidate;
  probePiVersion?: ProbePiVersion;
}

export interface ResolveManagedChildExplicitAcceptancePiOptions {
  executable: string | undefined;
  minimumVersion: string;
  /** When set, accept only this exact stable version instead of a minimum. */
  exactVersion?: string;
  probePiVersion?: ProbePiVersion;
}

export type ResolveManagedChildLiveAcceptancePiOptions = ResolveManagedChildExplicitAcceptancePiOptions;

export interface ResolveManagedChildAcceptancePiGenerationOptions {
  liveNested: boolean;
  executable: string | undefined;
  pathValue: string | undefined;
  baseMinimumVersion: string;
  liveMinimumVersion: string;
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function isSafeOwner(uid: number, owner: number | null): boolean {
  // Root-owned system directories and files are safe ancestors alongside the
  // invoking user's private installation tree.
  return owner === null || uid === owner || uid === 0;
}

function safeMode(mode: number): boolean {
  return (mode & 0o022) === 0;
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs && left.mode === right.mode && left.uid === right.uid;
}

/** Accept only executable formats launched directly by the kernel, never scripts. */
function hasSupportedNativeExecutableMagic(descriptor: number): boolean {
  const header = Buffer.alloc(4);
  if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
  const magic = header.readUInt32BE(0);
  return magic === 0x7f454c46 // ELF
    || magic === 0xfeedface || magic === 0xcefaedfe // Mach-O 32-bit
    || magic === 0xfeedfacf || magic === 0xcffaedfe // Mach-O 64-bit
    || magic === 0xcafebabe || magic === 0xbebafeca // Mach-O universal
    || magic === 0xcafebabf || magic === 0xbfbafeca; // Mach-O universal 64-bit
}

function safeGeneration(executable: string, requireNativeExecutable = false, privateRoot?: string): ManagedChildPiExecutableGeneration | null {
  let descriptor: number | undefined;
  try {
    if (!path.isAbsolute(executable)) return null;
    const canonical = fs.realpathSync(executable);
    const canonicalPrivateRoot = privateRoot === undefined ? undefined : fs.realpathSync(privateRoot);
    if (!path.isAbsolute(canonical) || path.normalize(canonical) !== canonical) return null;
    const owner = currentUid();
    descriptor = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const file = fs.fstatSync(descriptor);
    // Ensure the descriptor remains bound to the canonical path selected above.
    const current = fs.lstatSync(canonical);
    if (current.isSymbolicLink() || !sameFileIdentity(file, current)
      || !file.isFile() || !safeMode(file.mode) || !isSafeOwner(file.uid, owner)) return null;
    fs.accessSync(canonical, fs.constants.X_OK);
    if (requireNativeExecutable && !hasSupportedNativeExecutableMagic(descriptor)) return null;

    // realpath removed symlinks. Every remaining path component is therefore
    // an actual ancestor of the executable generation we are about to launch.
    for (let ancestor = path.dirname(canonical); ; ancestor = path.dirname(ancestor)) {
      const stat = fs.statSync(ancestor);
      if (!stat.isDirectory() || !safeMode(stat.mode) || !isSafeOwner(stat.uid, owner)) return null;
      if (ancestor === canonicalPrivateRoot) break;
      if (ancestor === path.dirname(ancestor)) break;
    }
    if (canonicalPrivateRoot !== undefined) {
      const relative = path.relative(canonicalPrivateRoot, canonical);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    }
    return {
      executable: canonical,
      dev: Number(file.dev),
      ino: Number(file.ino),
      size: Number(file.size),
      mtimeMs: file.mtimeMs,
      ctimeMs: file.ctimeMs,
      mode: Number(file.mode),
      uid: Number(file.uid),
      nativeExecutable: requireNativeExecutable,
      ...(canonicalPrivateRoot === undefined ? {} : { privateRoot: canonicalPrivateRoot }),
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function sameGeneration(left: ManagedChildPiExecutableGeneration, right: ManagedChildPiExecutableGeneration): boolean {
  return left.executable === right.executable
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode && left.uid === right.uid
    && left.nativeExecutable === right.nativeExecutable && left.privateRoot === right.privateRoot;
}

/** Captures a canonical safe executable generation; base acceptance may use scripts. */
export function captureManagedChildPiExecutableGeneration(executable: string): ManagedChildPiExecutableGeneration {
  const generation = safeGeneration(executable);
  if (!generation) throw new Error("Managed-child acceptance executable is not a safe canonical regular executable.");
  return generation;
}

/** Captures a canonical safe native generation for a credentialed live child launch. */
export function captureManagedChildLivePiExecutableGeneration(executable: string, privateRoot?: string): ManagedChildPiExecutableGeneration {
  const generation = safeGeneration(executable, true, privateRoot);
  if (!generation) throw new Error("Managed-child live acceptance executable is not a safe canonical native executable.");
  return generation;
}

/** Fails closed if an executable, native-format, or safe-ancestry property changed. */
export function revalidateManagedChildPiExecutableGeneration(expected: ManagedChildPiExecutableGeneration): void {
  const actual = safeGeneration(expected.executable, expected.nativeExecutable, expected.privateRoot);
  if (!actual || !sameGeneration(actual, expected)) {
    throw new Error("Managed-child acceptance executable generation changed before spawn.");
  }
}

/** Resolve only regular, executable canonical paths with safe ownership/ancestry. */
function canonicalizeExecutable(candidate: string): string | null {
  return safeGeneration(candidate)?.executable ?? null;
}

function minimalProbeEnv(): NodeJS.ProcessEnv {
  // Do not give PATH-discovered base-compatible scripts loader hooks,
  // credentials, or caller configuration. Live mode rejects scripts before
  // probing, so this PATH cannot select a live interpreter.
  return { PATH: process.platform === "win32" ? process.env.SystemRoot : "/usr/bin:/bin" };
}

/** Probe the exact canonical executable directly, without a shell or PATH lookup. */
function probePiVersion(executable: string): string | null {
  try {
    const result = spawnSync(executable, ["--version"], {
      encoding: "utf8",
      timeout: VERSION_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: minimalProbeEnv(),
    });
    return result.status === 0 ? parsePiVersionOutput(String(result.stdout)) : null;
  } catch {
    return null;
  }
}

/**
 * Select the highest stable compatible Pi from a bounded prefix of PATH.
 * This base resolver is deliberately not used by credentialed live mode.
 */
export function resolveManagedChildAcceptancePiExecutable(options: ResolveManagedChildAcceptancePiOptions): string {
  const delimiter = options.delimiter ?? path.delimiter;
  const maxCandidates = options.maxPathCandidates ?? MAX_PATH_CANDIDATES;
  const canonicalize = options.canonicalizeCandidate ?? canonicalizeExecutable;
  const probe = options.probePiVersion ?? probePiVersion;
  const pathValue = options.pathValue ?? "";
  let offset = 0;
  let scanned = 0;
  const visited = new Set<string>();
  let selected: { executable: string; version: string } | null = null;

  while (scanned < maxCandidates && offset <= pathValue.length) {
    const next = pathValue.indexOf(delimiter, offset);
    const end = next === -1 ? pathValue.length : next;
    const directory = pathValue.slice(offset, end);
    scanned += 1;
    if (directory.length <= MAX_PATH_ENTRY_LENGTH) {
      const candidate = path.resolve(directory || ".", "pi");
      const executable = canonicalize(candidate);
      if (executable && !visited.has(executable)) {
        visited.add(executable);
        const version = probe(executable);
        if (version && isStableSemverAtLeast(version, options.minimumVersion)
          && (selected === null || compareStableSemver(version, selected.version)! > 0)) {
          selected = { executable, version };
        }
      }
    }
    if (next === -1) break;
    offset = next + delimiter.length;
  }

  if (!selected) throw new Error(`Managed-child acceptance requires a stable Pi >= ${options.minimumVersion}.`);
  return selected.executable;
}

/**
 * Validate an explicitly configured Pi without searching PATH, and retain its
 * safe generation for every subsequent child spawn.
 */
export function resolveManagedChildExplicitAcceptancePiExecutable(options: ResolveManagedChildExplicitAcceptancePiOptions): ManagedChildPiExecutableGeneration {
  const requested = options.executable?.trim();
  if (!requested || !path.isAbsolute(requested)) {
    throw new Error(`Managed-child acceptance requires explicit absolute ${MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV}.`);
  }
  const before = captureManagedChildPiExecutableGeneration(requested);
  const version = (options.probePiVersion ?? probePiVersion)(before.executable);
  const after = captureManagedChildPiExecutableGeneration(before.executable);
  if (!sameGeneration(before, after)) throw new Error("Managed-child acceptance executable generation changed during validation.");
  const compatible = version !== null && (options.exactVersion !== undefined
    ? version === options.exactVersion
    : isStableSemverAtLeast(version, options.minimumVersion));
  if (!compatible) {
    const requirement = options.exactVersion !== undefined
      ? `exact stable Pi ${options.exactVersion}`
      : `a stable Pi >= ${options.minimumVersion}`;
    throw new Error(`Managed-child acceptance requires ${requirement}.`);
  }
  return after;
}

/** Credentialed live acceptance requires an explicit native Pi >= 0.81.1. */
export function resolveManagedChildLiveAcceptancePiExecutable(options: ResolveManagedChildLiveAcceptancePiOptions): ManagedChildPiExecutableGeneration {
  const requested = options.executable?.trim();
  if (!requested || !path.isAbsolute(requested)) {
    throw new Error(`Managed-child acceptance requires explicit absolute ${MANAGED_CHILD_ACCEPTANCE_PI_EXECUTABLE_ENV}.`);
  }
  // Validate the exact descriptor before probing, so no script can resolve an
  // interpreter through a caller-controlled PATH before credentials are used.
  const before = captureManagedChildLivePiExecutableGeneration(requested);
  const version = (options.probePiVersion ?? probePiVersion)(before.executable);
  const after = captureManagedChildLivePiExecutableGeneration(before.executable);
  if (!sameGeneration(before, after)) throw new Error("Managed-child acceptance executable generation changed during validation.");
  if (version === null || !isStableSemverAtLeast(version, options.minimumVersion)) {
    throw new Error(`Managed-child acceptance requires a stable Pi >= ${options.minimumVersion}.`);
  }
  return after;
}

/**
 * Resolve the executable generation for the managed-child acceptance profile.
 * A configured executable always wins in base mode; only an unset value permits
 * bounded PATH selection.
 */
export function resolveManagedChildAcceptancePiGeneration(options: ResolveManagedChildAcceptancePiGenerationOptions): ManagedChildPiExecutableGeneration {
  if (options.liveNested) {
    return resolveManagedChildLiveAcceptancePiExecutable({
      executable: options.executable,
      minimumVersion: options.liveMinimumVersion,
    });
  }
  if (options.executable !== undefined) {
    return resolveManagedChildExplicitAcceptancePiExecutable({
      executable: options.executable,
      minimumVersion: options.baseMinimumVersion,
      exactVersion: options.baseMinimumVersion,
    });
  }
  return captureManagedChildPiExecutableGeneration(resolveManagedChildAcceptancePiExecutable({
    pathValue: options.pathValue,
    minimumVersion: options.baseMinimumVersion,
  }));
}
