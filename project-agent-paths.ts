import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalizePathForTrust, isPathWithinRoot } from "./trust-path.js";

function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function isProjectAgentsDirWithinRoot(projectAgentsDir: string, projectRoot: string): boolean {
  return isPathWithinRoot(projectAgentsDir, projectRoot);
}

export function resolveProjectAgentFilePathWithinRoot(filePath: string, projectRoot: string): string | null {
  try {
    const resolved = fs.realpathSync.native(filePath);
    return isPathWithinRoot(resolved, projectRoot) ? resolved : null;
  } catch {
    return null;
  }
}

export function getProjectAgentConfigFilePath(logicalFilePath: string): string {
  return logicalFilePath;
}

export function findNearestProjectAgentsDirWithinRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    if (isDirectory(candidate)) {
      const projectRoot = canonicalizePathForTrust(dir);
      if (isProjectAgentsDirWithinRoot(candidate, projectRoot)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
