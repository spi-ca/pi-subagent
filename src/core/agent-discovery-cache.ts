import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  discoverAgents,
  findNearestProjectAgentsDir,
  getUserAgentsDir,
  type AgentConfig,
  type AgentDiscoveryResult,
  type AgentScope,
  type TrustedProjectCandidateIdentity,
} from "./agents.js";
import { getConfigDir, isTrustedProjectAgentsDirWithSessionOverrides } from "./project-trust.js";
import { getProjectRootFromAgentsDir } from "./subagent-config.js";
import { canonicalizePathForTrust, isPathWithinRoot } from "./trust-path.js";

export interface CachedDiscoverAgentOptions {
  metadataOnly?: boolean;
  /** Exact canonical root the caller has already authorized for this discovery. */
  trustedProjectRoot?: string | null;
  sessionTrustedProjectRoots?: Iterable<string>;
  sessionDeniedProjectRoots?: Iterable<string>;
  /** Test-only seam used to deterministically exercise pathname races. */
  beforeTrustedProjectRead?: (resolvedPath: string) => void;
}

export interface AgentDiscoveryCacheSnapshot {
  generation: number;
  entries: number;
  hits: number;
  misses: number;
  fetches: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface CandidateManifest {
  logicalPath: string;
  resolvedPath: string;
  logical: FileIdentity;
  target: FileIdentity;
}

interface DirectoryManifest {
  logicalPath: string;
  resolvedPath: string;
  logical: FileIdentity;
  target: FileIdentity;
  entries: string[];
  candidates: CandidateManifest[];
}

interface DiscoveryManifest {
  user: DirectoryManifest;
  project: DirectoryManifest | null;
}

interface CacheEntry {
  manifest: DiscoveryManifest;
  result: AgentDiscoveryResult;
}

function identity(stat: fs.Stats): FileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function safeLstat(filePath: string): fs.Stats | null {
  try { return fs.lstatSync(filePath); } catch { return null; }
}

function safeStat(filePath: string): fs.Stats | null {
  try { return fs.statSync(filePath); } catch { return null; }
}

function safeRealpath(filePath: string): string | null {
  try { return fs.realpathSync.native(filePath); } catch { return null; }
}

/**
 * Capture only path/metadata evidence. This intentionally never opens a candidate
 * for content: metadata-only project discovery must not accidentally consume a body.
 */
function captureDirectoryManifest(logicalPath: string, projectRoot: string | null): DirectoryManifest | null {
  const directoryLstat = safeLstat(logicalPath);
  const resolvedPath = safeRealpath(logicalPath);
  if (!directoryLstat || !resolvedPath || (projectRoot && !isPathWithinRoot(resolvedPath, projectRoot))) return null;
  const directoryStat = safeStat(logicalPath);
  if (!directoryStat || !directoryStat.isDirectory()) return null;

  let dirents: fs.Dirent[];
  try { dirents = fs.readdirSync(logicalPath, { withFileTypes: true }); } catch { return null; }
  dirents.sort((a, b) => a.name.localeCompare(b.name));

  const candidates: CandidateManifest[] = [];
  for (const entry of dirents) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const candidatePath = path.join(logicalPath, entry.name);
    const candidateLstat = safeLstat(candidatePath);
    const candidateResolved = safeRealpath(candidatePath);
    const candidateStat = safeStat(candidatePath);
    if (!candidateLstat || !candidateResolved || !candidateStat || !candidateStat.isFile()) return null;
    if (projectRoot && !isPathWithinRoot(candidateResolved, projectRoot)) return null;
    candidates.push({
      logicalPath: candidatePath,
      resolvedPath: candidateResolved,
      logical: identity(candidateLstat),
      target: identity(candidateStat),
    });
  }

  return {
    logicalPath,
    resolvedPath,
    logical: identity(directoryLstat),
    target: identity(directoryStat),
    entries: dirents.map((entry) => entry.name),
    candidates,
  };
}

function sameDirectoryManifest(previous: DirectoryManifest, projectRoot: string | null): boolean {
  const current = captureDirectoryManifest(previous.logicalPath, projectRoot);
  if (!current) return false;
  if (current.resolvedPath !== previous.resolvedPath ||
    !sameIdentity(current.logical, previous.logical) || !sameIdentity(current.target, previous.target) ||
    current.entries.length !== previous.entries.length || current.candidates.length !== previous.candidates.length) return false;
  if (current.entries.some((entry, index) => entry !== previous.entries[index])) return false;
  return current.candidates.every((candidate, index) => {
    const old = previous.candidates[index];
    return candidate.logicalPath === old.logicalPath && candidate.resolvedPath === old.resolvedPath &&
      sameIdentity(candidate.logical, old.logical) && sameIdentity(candidate.target, old.target);
  });
}

function cloneAgent(agent: AgentConfig): AgentConfig {
  return { ...agent, tools: agent.tools ? [...agent.tools] : undefined };
}

function cloneResult(result: AgentDiscoveryResult): AgentDiscoveryResult {
  return { projectAgentsDir: result.projectAgentsDir, agents: result.agents.map(cloneAgent) };
}

function freezeResult(result: AgentDiscoveryResult): AgentDiscoveryResult {
  for (const agent of result.agents) {
    if (agent.tools) Object.freeze(agent.tools);
    Object.freeze(agent);
  }
  Object.freeze(result.agents);
  return Object.freeze(result);
}

/** Do not turn an invalid/unparseable candidate into a durable negative entry. */
function hasAllCandidates(result: AgentDiscoveryResult, manifest: DiscoveryManifest, scope: AgentScope): boolean {
  const matches = (candidate: CandidateManifest, source: "user" | "project") => result.agents.some((agent) =>
    agent.source === source &&
    (canonicalizePathForTrust(agent.filePath) === candidate.resolvedPath || agent.filePath === candidate.logicalPath),
  );
  if (scope !== "project" && !manifest.user.candidates.every((candidate) => matches(candidate, "user"))) return false;
  if (scope !== "user" && manifest.project && !manifest.project.candidates.every((candidate) => matches(candidate, "project"))) return false;
  return true;
}

function canonicalRoots(roots: Iterable<string> | undefined): string[] {
  return Array.from(new Set(Array.from(roots ?? [], canonicalizePathForTrust))).sort();
}

function trustFingerprint(): string {
  const trustPath = path.join(getConfigDir(), "trust.json");
  try {
    const content = fs.readFileSync(trustPath);
    // Do not treat malformed trust state as validated; its bytes still force a key change.
    JSON.parse(content.toString("utf8"));
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return "unvalidated";
  }
}

/** Session-local, trust-bound discovery cache. It is deliberately not a public tool API. */
export class AgentDiscoveryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private generation = 0;
  private hits = 0;
  private misses = 0;
  private fetches = 0;

  startSession(): void {
    this.generation += 1;
    this.entries.clear();
  }

  clear(): void {
    this.entries.clear();
  }

  snapshot(): AgentDiscoveryCacheSnapshot {
    return { generation: this.generation, entries: this.entries.size, hits: this.hits, misses: this.misses, fetches: this.fetches };
  }

  discover(cwd: string, scope: AgentScope, options: CachedDiscoverAgentOptions = {}): AgentDiscoveryResult {
    const metadataOnly = options.metadataOnly === true;
    const canonicalCwd = canonicalizePathForTrust(cwd);
    const userAgentsDir = getUserAgentsDir();
    const projectAgentsDir = findNearestProjectAgentsDir(cwd);
    const projectRoot = projectAgentsDir ? getProjectRootFromAgentsDir(projectAgentsDir) : null;
    const trustedProjectRoot = options.trustedProjectRoot ? canonicalizePathForTrust(options.trustedProjectRoot) : null;
    const trustedRoots = canonicalRoots(options.sessionTrustedProjectRoots);
    const deniedRoots = canonicalRoots(options.sessionDeniedProjectRoots);
    const trustContextValid = projectAgentsDir !== null && projectRoot !== null &&
      trustedProjectRoot === projectRoot && !deniedRoots.includes(projectRoot) &&
      isTrustedProjectAgentsDirWithSessionOverrides(projectAgentsDir, {
        sessionTrustedProjectRoots: trustedRoots,
        sessionDeniedProjectRoots: deniedRoots,
      });
    const fullProjectAllowed = !metadataOnly && trustContextValid;
    const manifest: DiscoveryManifest = {
      user: captureDirectoryManifest(userAgentsDir, null) ?? {
        logicalPath: userAgentsDir, resolvedPath: "", logical: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 },
        target: { dev: 0, ino: 0, size: 0, mtimeMs: 0, ctimeMs: 0 }, entries: [], candidates: [],
      },
      project: projectAgentsDir ? captureDirectoryManifest(projectAgentsDir, projectRoot) : null,
    };
    const manifestSafe = manifest.user.resolvedPath !== "" && (!projectAgentsDir || manifest.project !== null);
    const key = JSON.stringify({
      cwd: canonicalCwd,
      userAgentsDir: canonicalizePathForTrust(userAgentsDir),
      projectAgentsDir: projectAgentsDir ? canonicalizePathForTrust(projectAgentsDir) : null,
      scope,
      metadataOnly,
      // Full project bodies are authorized by this exact proof, not merely by
      // the session/persistent trust state. Keep failed or different proof
      // contexts from reusing a previously parsed project body.
      trustedProjectRoot,
      trustContextValid,
      trustedRoots,
      deniedRoots,
      trust: trustFingerprint(),
      generation: this.generation,
    });
    const cached = this.entries.get(key);
    if (cached && manifestSafe && this.isValid(cached.manifest, projectRoot)) {
      this.hits += 1;
      return cloneResult(cached.result);
    }
    this.misses += 1;

    // Recheck the same canonical persistent/session context immediately before
    // a body parser can run; a trust-file or override race is not cacheable.
    const trustedImmediatelyBeforeParse = fullProjectAllowed && isTrustedProjectAgentsDirWithSessionOverrides(projectAgentsDir, {
      sessionTrustedProjectRoots: trustedRoots,
      sessionDeniedProjectRoots: deniedRoots,
    });
    // A full project parse is permitted only after exact-root proof and metadata
    // evidence. Failure is fail-closed for the project portion, never a body read.
    const effectiveScope: AgentScope = trustedImmediatelyBeforeParse && manifestSafe
      ? scope
      : scope === "both" ? "user" : scope;
    let parseIssue = false;
    const trustedProjectCandidates = new Map<string, TrustedProjectCandidateIdentity>();
    if (manifest.project) for (const candidate of manifest.project.candidates) {
      trustedProjectCandidates.set(candidate.resolvedPath, { resolvedPath: candidate.resolvedPath, ...candidate.target });
    }
    const result = effectiveScope === "project" && !metadataOnly && !fullProjectAllowed
      ? { agents: [], projectAgentsDir }
      : discoverAgents(cwd, effectiveScope, {
        metadataOnly,
        projectAgentsDir,
        trustedProjectRoot: trustedImmediatelyBeforeParse ? projectRoot : null,
        trustedProjectCandidates,
        beforeTrustedProjectRead: options.beforeTrustedProjectRead,
        onParseIssue: () => { parseIssue = true; },
      });
    this.fetches += 1;

    const postManifest: DiscoveryManifest = {
      user: captureDirectoryManifest(userAgentsDir, null) ?? manifest.user,
      project: projectAgentsDir ? captureDirectoryManifest(projectAgentsDir, projectRoot) : null,
    };
    const projectStable = !trustedImmediatelyBeforeParse || (
      postManifest.project !== null && manifest.project !== null &&
      sameDirectoryManifest(manifest.project, projectRoot) &&
      sameDirectoryManifest(postManifest.project, projectRoot) &&
      isTrustedProjectAgentsDirWithSessionOverrides(projectAgentsDir, {
        sessionTrustedProjectRoots: trustedRoots,
        sessionDeniedProjectRoots: deniedRoots,
      })
    );
    // A changed manifest/proof invalidates the *read result*, not merely the
    // cache write. Project prompts are executable authority and cannot survive
    // a TOCTOU window between metadata proof and full-body parse.
    const stableResult = !projectStable
      ? { projectAgentsDir: result.projectAgentsDir, agents: result.agents.filter((agent) => agent.source !== "project") }
      : result;
    if (!parseIssue && projectStable && postManifest.user.resolvedPath !== "" && (!projectAgentsDir || postManifest.project !== null) &&
      hasAllCandidates(stableResult, postManifest, effectiveScope)) {
      this.entries.set(key, { manifest: postManifest, result: freezeResult(cloneResult(stableResult)) });
    }
    return cloneResult(stableResult);
  }

  private isValid(manifest: DiscoveryManifest, projectRoot: string | null): boolean {
    return sameDirectoryManifest(manifest.user, null) &&
      (manifest.project === null || (projectRoot !== null && sameDirectoryManifest(manifest.project, projectRoot)));
  }
}
