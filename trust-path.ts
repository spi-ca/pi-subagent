import * as fs from "node:fs";
import * as path from "node:path";

export function canonicalizePathForTrust(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function isPathWithinRoot(value: string, root: string): boolean {
  const canonicalValue = canonicalizePathForTrust(value);
  const canonicalRoot = canonicalizePathForTrust(root);
  const relative = path.relative(canonicalRoot, canonicalValue);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
