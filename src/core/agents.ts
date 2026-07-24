/**
 * Agent discovery and configuration.
 *
 * Agents are Markdown files with YAML frontmatter that define name, description,
 * optional model/tools, and a system prompt body.
 *
 * Lookup locations:
 *   - User agents:    ~/.pi/agent/agents/*.md by default, or
 *                     $PI_CODING_AGENT_DIR/agents/*.md when the env var is set
 *   - Project agents: .pi/agents/*.md  (walks up from cwd)
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFrontmatterOnly } from "./metadata-frontmatter.js";
import {
	findNearestProjectAgentsDirWithinRoot,
	getProjectAgentConfigFilePath,
	isProjectAgentsDirWithinRoot,
	resolveProjectAgentFilePathWithinRoot,
} from "./project-agent-paths.js";
import { getProjectRootFromAgentsDir } from "./subagent-config.js";
import { isPathWithinRoot } from "./trust-path.js";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export interface TrustedProjectCandidateIdentity {
	resolvedPath: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

export interface DiscoverAgentOptions {
	metadataOnly?: boolean;
	/** Internal callers that already performed path validation can pin the directory. */
	projectAgentsDir?: string | null;
	/** Exact canonical root authorizing a full project body read. */
	trustedProjectRoot?: string | null;
	/** Pre-body-read target proof captured by the discovery manifest. */
	trustedProjectCandidates?: ReadonlyMap<string, TrustedProjectCandidateIdentity>;
	/** Deterministic test seam between manifest capture and trusted FD open. */
	beforeTrustedProjectRead?: (resolvedPath: string) => void;
	/** Internal cache hook: warnings/failures must not become negative entries. */
	onParseIssue?: () => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export function getUserAgentsDir(): string {
	const configDir = process.env["PI_CODING_AGENT_DIR"]?.trim() || path.join(os.homedir(), ".pi", "agent");
	return path.join(configDir, "agents");
}

/** Walk up from `cwd` looking for a `.pi/agents` directory. */
export function findNearestProjectAgentsDir(cwd: string): string | null {
	return findNearestProjectAgentsDirWithinRoot(cwd);
}

/** Parse a single agent markdown file into an AgentConfig. Returns null on skip. */
function sameFileStat(left: fs.Stats, right: fs.Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size
		&& left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

/**
 * Read a trusted project body from a verified resolved target, never by
 * reopening its logical pathname. O_NOFOLLOW and the before/after fd identity
 * checks make a replacement or symlink race fail closed.
 */
function readTrustedProjectBody(
	resolvedPath: string,
	projectRoot: string,
	expected: TrustedProjectCandidateIdentity | undefined,
	beforeRead?: (resolvedPath: string) => void,
): string | null {
	// Full-body authority is the pre-manifest target, the opened FD before/after
	// read, and the current resolved pathname target all being exactly equal.
	if (!expected || expected.resolvedPath !== resolvedPath || !isPathWithinRoot(resolvedPath, projectRoot)) return null;
	let fd: number | undefined;
	try {
		beforeRead?.(resolvedPath);
		fd = fs.openSync(resolvedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const before = fs.fstatSync(fd);
		if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.size !== expected.size
			|| before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs) return null;
		const bytes = fs.readFileSync(fd);
		const after = fs.fstatSync(fd);
		const currentResolved = fs.realpathSync.native(resolvedPath);
		const current = fs.statSync(currentResolved);
		if (currentResolved !== expected.resolvedPath || !isPathWithinRoot(currentResolved, projectRoot)
			|| !sameFileStat(before, after) || !sameFileStat(before, current)) return null;
		return bytes.toString("utf8");
	} catch {
		return null;
	} finally {
		if (fd !== undefined) try { fs.closeSync(fd); } catch { /* fail closed above */ }
	}
}

const MAX_DIAGNOSTIC_PATH_CHARS = 160;

/**
 * Repository configuration can control agent filenames and paths. Keep warnings
 * useful without allowing terminal controls or unbounded path text into logs.
 */
export function safeDiagnosticPath(value: string): string {
	const basename = path.basename(value) || "unknown";
	const escaped = basename.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (character) => {
		const code = character.codePointAt(0)!;
		return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
	});
	return escaped.length <= MAX_DIAGNOSTIC_PATH_CHARS
		? escaped
		: `${escaped.slice(0, MAX_DIAGNOSTIC_PATH_CHARS - 1)}…`;
}

export function formatInvalidAgentWarning(filePath: string, metadataOnly = false): string {
	return `[pi-subagent] Skipping invalid agent${metadataOnly ? " metadata" : " file"} "${safeDiagnosticPath(filePath)}": invalid frontmatter.`;
}

function parseAgentFile(filePath: string, source: "user" | "project", options: DiscoverAgentOptions = {}): AgentConfig | null {
	let content: string | null;
	if (source === "project") {
		content = options.trustedProjectRoot ? readTrustedProjectBody(
			filePath, options.trustedProjectRoot, options.trustedProjectCandidates?.get(filePath), options.beforeTrustedProjectRead,
		) : null;
	} else {
		try { content = fs.readFileSync(filePath, "utf-8"); } catch { content = null; }
	}
	if (content === null) { options.onParseIssue?.(); return null; }

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch {
		console.warn(formatInvalidAgentWarning(filePath));
		options.onParseIssue?.();
		return null;
	}

	const frontmatter = parsed.frontmatter ?? {};
	const body = parsed.body ?? "";

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) {
		options.onParseIssue?.();
		return null;
	}

	let tools: string[] | undefined;
	if (typeof frontmatter.tools === "string") {
		const parsedTools = frontmatter.tools
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (Array.isArray(frontmatter.tools)) {
		const parsedTools = frontmatter.tools
			.filter((t): t is string => typeof t === "string")
			.map((t) => t.trim())
			.filter(Boolean);
		if (parsedTools.length > 0) tools = parsedTools;
	} else if (frontmatter.tools !== undefined) {
		console.warn(
			`[pi-subagent] Ignoring invalid tools field in "${safeDiagnosticPath(filePath)}". Expected a comma-separated string or string array.`,
		);
		options.onParseIssue?.();
	}

	return {
		name,
		description,
		tools,
		model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
		systemPrompt: body,
		source,
		filePath,
	};
}

function parseAgentMetadataOnly(filePath: string, source: "user" | "project", onParseIssue?: () => void): AgentConfig | null {
	const frontmatterOnly = readFrontmatterOnly(filePath);
	if (!frontmatterOnly) {
		onParseIssue?.();
		return null;
	}

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(frontmatterOnly);
	} catch {
		console.warn(formatInvalidAgentWarning(filePath, true));
		onParseIssue?.();
		return null;
	}

	const frontmatter = parsed.frontmatter ?? {};
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) {
		onParseIssue?.();
		return null;
	}

	return {
		name,
		description,
		tools: undefined,
		model: undefined,
		thinking: undefined,
		systemPrompt: "",
		source,
		filePath,
	};
}

/** Load all agent definitions from a directory. */
function loadAgentsFromDir(dir: string, source: "user" | "project", options: DiscoverAgentOptions = {}): AgentConfig[] {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
	entries.sort((a, b) => a.name.localeCompare(b.name));

	const projectRoot = source === "project" ? getProjectRootFromAgentsDir(dir) : null;
	if (source === "project") {
		if (!projectRoot) return [];
		if (!isProjectAgentsDirWithinRoot(dir, projectRoot)) {
			console.warn(
				`[pi-subagent] Ignoring project agents directory "${safeDiagnosticPath(dir)}" because it resolves outside project root "${safeDiagnosticPath(projectRoot)}".`,
			);
			return [];
		}
	}

	const agents: AgentConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		const parsePath = source === "project" && projectRoot
			? resolveProjectAgentFilePathWithinRoot(filePath, projectRoot)
			: filePath;
		if (!parsePath) {
			if (source === "project" && projectRoot) {
				console.warn(
					`[pi-subagent] Ignoring project agent file "${safeDiagnosticPath(filePath)}" because it resolves outside project root "${safeDiagnosticPath(projectRoot)}".`,
				);
			}
			continue;
		}
		const agent = options.metadataOnly
			? parseAgentMetadataOnly(parsePath, source, options.onParseIssue)
			: parseAgentFile(parsePath, source, options);
		if (agent) {
			// Preserve the logical project-agent path for trust checks. `parsePath` may be a
			// realpath inside the project when `.pi/agents` or an agent file is a symlink;
			// deriving the project root from that realpath can break exact-root trust.
			if (source === "project") agent.filePath = getProjectAgentConfigFilePath(filePath);
			agents.push(agent);
		}
	}
	return agents;
}

export function mergeAgents(...groups: AgentConfig[][]): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();
	for (const group of groups) {
		for (const agent of group) agentMap.set(agent.name, agent);
	}
	return Array.from(agentMap.values());
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover all available agents according to the requested scope.
 *
 * Precedence is: user < project.
 */
export function discoverAgents(cwd: string, scope: AgentScope, options: DiscoverAgentOptions = {}): AgentDiscoveryResult {
	const userAgentsDir = getUserAgentsDir();
	const projectAgentsDir = options.projectAgentsDir === undefined
		? findNearestProjectAgentsDir(cwd)
		: options.projectAgentsDir;

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user", options);
	const projectAgents = scope === "user" || !projectAgentsDir
		? []
		: options.metadataOnly || (options.trustedProjectRoot && getProjectRootFromAgentsDir(projectAgentsDir) === options.trustedProjectRoot)
			? loadAgentsFromDir(projectAgentsDir, "project", options)
			: [];

	if (scope === "user") {
		return { agents: userAgents, projectAgentsDir };
	}
	if (scope === "project") {
		return { agents: projectAgents, projectAgentsDir };
	}
	return {
		agents: mergeAgents(userAgents, projectAgents),
		projectAgentsDir,
	};
}

