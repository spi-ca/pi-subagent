/** Process-local launch preflight single-flight; settled results are never cached. */
import * as fs from "node:fs";
import * as path from "node:path";

export interface ExecutableGeneration {
  readonly realpath: string;
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface FileGeneration {
  readonly realpath: string;
  readonly dev: string;
  readonly ino: string;
}

/** A tmux socket is authority only while this exact inode remains in place. */
export function readFileGeneration(candidate: string, requireSocket = false): FileGeneration | null {
  try {
    const realpath = path.join(fs.realpathSync.native(path.dirname(candidate)), path.basename(candidate));
    const stat = fs.lstatSync(realpath, { bigint: true });
    if (requireSocket && !stat.isSocket()) return null;
    return { realpath, dev: stat.dev.toString(), ino: stat.ino.toString() };
  } catch {
    return null;
  }
}

export function sameFileGeneration(left: FileGeneration, right: FileGeneration | null): boolean {
  return right !== null && left.realpath === right.realpath && left.dev === right.dev && left.ino === right.ino;
}

export interface LaunchPreflightMetrics {
  readonly fetches: number;
  readonly joins: number;
  readonly failures: number;
}

/** Returns an immutable executable identity, or null instead of guessing. */
export function readExecutableGeneration(candidate: string, executable = true): ExecutableGeneration | null {
  try {
    const realpath = fs.realpathSync.native(candidate);
    const stat = fs.statSync(realpath, { bigint: true });
    if (!stat.isFile()) return null;
    fs.accessSync(realpath, executable ? fs.constants.X_OK : fs.constants.R_OK);
    return {
      realpath,
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(),
    };
  } catch {
    return null;
  }
}

export function executableGenerationKey(generation: ExecutableGeneration): string {
  return `${generation.realpath}\u0000${generation.dev}\u0000${generation.ino}\u0000${generation.size}\u0000${generation.mtimeNs}\u0000${generation.ctimeNs}`;
}

export function sameExecutableGeneration(left: ExecutableGeneration, right: ExecutableGeneration | null): boolean {
  return right !== null && executableGenerationKey(left) === executableGenerationKey(right);
}

/**
 * Collapses concurrent read-only preflights only. Auth, credentials, durable
 * publication, allocation, and lifecycle mutations must never use this class.
 */
export class LaunchPreflightSingleFlight {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private fetches = 0;
  private joins = 0;
  private failures = 0;

  async read<T>(key: string, probe: () => Promise<T>): Promise<T> {
    if (!key) throw new Error("Launch preflight requires a canonical non-empty key.");
    const pending = this.inFlight.get(key) as Promise<T> | undefined;
    if (pending) {
      this.joins += 1;
      return await pending;
    }
    this.fetches += 1;
    const current = Promise.resolve().then(probe);
    this.inFlight.set(key, current);
    try {
      return await current;
    } catch (error) {
      this.failures += 1;
      throw error;
    } finally {
      if (this.inFlight.get(key) === current) this.inFlight.delete(key);
    }
  }

  reset(): void {
    this.inFlight.clear();
  }

  metrics(): LaunchPreflightMetrics {
    return { fetches: this.fetches, joins: this.joins, failures: this.failures };
  }
}
