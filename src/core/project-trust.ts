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

function canonicalizeMutableProjectRootSet(roots: Set<string>): void {
  const canonical = canonicalizeProjectRootSet(roots);
  roots.clear();
  for (const root of canonical) roots.add(root);
}

export function applySessionProjectTrustOverride(
  projectAgentsDir: string | null,
  trustOverride: boolean | null,
  sessionTrustedProjectRoots: Set<string>,
  sessionDeniedProjectRoots: Set<string>,
): string | null {
  const projectRoot = getProjectRootFromAgentsDir(projectAgentsDir);
  if (!projectRoot || trustOverride === null) return projectRoot;

  canonicalizeMutableProjectRootSet(sessionTrustedProjectRoots);
  canonicalizeMutableProjectRootSet(sessionDeniedProjectRoots);
  if (trustOverride) {
    sessionDeniedProjectRoots.delete(projectRoot);
    sessionTrustedProjectRoots.add(projectRoot);
  } else {
    sessionTrustedProjectRoots.delete(projectRoot);
    sessionDeniedProjectRoots.add(projectRoot);
  }

  return projectRoot;
}

export function getSessionProjectTrustOverride(context: { isProjectTrusted?: unknown }): boolean | null {
  const isProjectTrusted = context.isProjectTrusted;
  if (typeof isProjectTrusted !== "function") return null;

  try {
    const trust = isProjectTrusted.call(context);
    return trust === true || trust === false ? trust : null;
  } catch {
    return null;
  }
}

export function resolveSessionProjectTrust(
  projectAgentsDir: string | null,
  trustOverride: boolean | null,
  sessionTrustedProjectRoots: Set<string>,
  sessionDeniedProjectRoots: Set<string>,
  options: Pick<ProjectTrustOptions, "configDir" | "trust"> = {},
): boolean {
  applySessionProjectTrustOverride(
    projectAgentsDir,
    trustOverride,
    sessionTrustedProjectRoots,
    sessionDeniedProjectRoots,
  );
  return isTrustedProjectAgentsDirWithSessionOverrides(projectAgentsDir, {
    ...options,
    sessionTrustedProjectRoots,
    sessionDeniedProjectRoots,
  });
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
