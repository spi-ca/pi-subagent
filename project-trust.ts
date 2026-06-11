import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectRootFromAgentsDir } from "./subagent-config.js";
import { canonicalizePathForTrust } from "./trust-path.js";

interface ProjectTrustOptions {
  configDir?: string;
  trust?: Record<string, unknown> | null;
  sessionTrustedProjectRoots?: Iterable<string>;
  sessionDeniedProjectRoots?: Iterable<string>;
}

export function getConfigDir(): string {
  return process.env["PI_CODING_AGENT_DIR"]?.trim() || path.join(os.homedir(), ".pi", "agent");
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getTrustedProjectRoots(trust: Record<string, unknown>): Set<string> {
  return new Set(
    Object.entries(trust)
      .filter(([, isTrusted]) => isTrusted === true)
      .map(([projectRoot]) => canonicalizePathForTrust(projectRoot)),
  );
}

export function isTrustedProjectAgentsDir(
  projectAgentsDir: string | null,
  options: Pick<ProjectTrustOptions, "configDir" | "trust"> = {},
): boolean {
  if (!projectAgentsDir) return false;

  const projectRoot = getProjectRootFromAgentsDir(projectAgentsDir);
  if (!projectRoot) return false;

  const trust = options.trust ?? readJsonObject(path.join(options.configDir ?? getConfigDir(), "trust.json"));
  if (!trust) return false;

  return getTrustedProjectRoots(trust).has(projectRoot);
}

function canonicalizeProjectRootSet(roots: Iterable<string> | undefined): Set<string> {
  return new Set(Array.from(roots ?? [], (root) => canonicalizePathForTrust(root)));
}

export function applySessionProjectTrustOverride(
  projectAgentsDir: string | null,
  trustOverride: boolean | null,
  sessionTrustedProjectRoots: Set<string>,
  sessionDeniedProjectRoots: Set<string>,
): string | null {
  const projectRoot = getProjectRootFromAgentsDir(projectAgentsDir);
  if (!projectRoot || trustOverride === null) return projectRoot;

  if (trustOverride) {
    sessionDeniedProjectRoots.delete(projectRoot);
    sessionTrustedProjectRoots.add(projectRoot);
  } else {
    sessionTrustedProjectRoots.delete(projectRoot);
    sessionDeniedProjectRoots.add(projectRoot);
  }

  return projectRoot;
}

export function isTrustedProjectAgentsDirWithSessionOverrides(
  projectAgentsDir: string | null,
  options: ProjectTrustOptions = {},
): boolean {
  if (!projectAgentsDir) return false;

  const projectRoot = getProjectRootFromAgentsDir(projectAgentsDir);
  if (!projectRoot) return false;

  const deniedRoots = canonicalizeProjectRootSet(options.sessionDeniedProjectRoots);
  if (deniedRoots.has(projectRoot)) return false;

  const trustedRoots = canonicalizeProjectRootSet(options.sessionTrustedProjectRoots);
  if (trustedRoots.has(projectRoot)) return true;

  return isTrustedProjectAgentsDir(projectAgentsDir, options);
}
