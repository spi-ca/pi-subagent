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

export interface DiscoverAgentOptions {
	metadataOnly?: boolean;
}

export interface StarterAgentDiscoveryResult {
	discovery: AgentDiscoveryResult;
	createdAgentPath: string | null;
	error?: string;
}

export const STARTER_AGENT_NAME = "explorer";
export const STARTER_AGENT_FILE_NAME = "explorer.md";

const STARTER_AGENT_MARKDOWN = `---
name: explorer
description: Read-only codebase exploration specialist for focused searches, repository reconnaissance, and evidence-backed summaries. Use when you need fast context from files without edits.
tools: read, grep, find, ls
---

You are a codebase exploration specialist. Your job is to quickly gather reliable,
targeted context from the local repository and return it in a form another agent
can use without repeating the same search.

## Operating mode

- Work read-only.
- Never create, edit, delete, or commit files.
- Do not make changes to the environment or repository state.
- Prefer fast discovery first, then selective reading.
- Keep scope tight to the task; do not broaden the investigation unless needed.

## Search strategy

1. Start broad: find likely files, symbols, call sites, configs, tests, and docs.
2. Narrow down: read only the most relevant files or sections.
3. Stop when you have enough evidence; avoid exhaustive exploration unless asked.

## Output rules

- Return file paths as absolute paths when possible.
- Include line ranges whenever you rely on file contents.
- Be factual and precise.
- Distinguish facts supported by inspected files from inferences.
- If something is not found, say what you checked.

Keep the response concise, structured, and optimized for agent handoff.
`;

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
function parseAgentFile(filePath: string, source: "user" | "project"): AgentConfig | null {
	let content: string;
	try { content = fs.readFileSync(filePath, "utf-8"); } catch { return null; }

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(content);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-subagent] Skipping invalid agent file "${filePath}": ${message}`);
		return null;
	}

	const frontmatter = parsed.frontmatter ?? {};
	const body = parsed.body ?? "";

	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return null;

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
			`[pi-subagent] Ignoring invalid tools field in "${filePath}". Expected a comma-separated string or string array.`,
		);
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

function parseAgentMetadataOnly(filePath: string, source: "user" | "project"): AgentConfig | null {
	const frontmatterOnly = readFrontmatterOnly(filePath);
	if (!frontmatterOnly) return null;

	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(frontmatterOnly);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.warn(`[pi-subagent] Skipping invalid agent metadata in "${filePath}": ${message}`);
		return null;
	}

	const frontmatter = parsed.frontmatter ?? {};
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return null;

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
				`[pi-subagent] Ignoring project agents directory "${dir}" because it resolves outside project root "${projectRoot}".`,
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
					`[pi-subagent] Ignoring project agent file "${filePath}" because it resolves outside project root "${projectRoot}".`,
				);
			}
			continue;
		}
		const agent = options.metadataOnly
			? parseAgentMetadataOnly(parsePath, source)
			: parseAgentFile(parsePath, source);
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

function getStarterAgentFileName(attempt: number): string {
	if (attempt === 0) return STARTER_AGENT_FILE_NAME;
	if (attempt === 1) return "explorer-starter.md";
	return `explorer-starter-${attempt}.md`;
}

function isFileExistsError(err: unknown): boolean {
	return (
		typeof err === "object" &&
		err !== null &&
		"code" in err &&
		(err as { code?: unknown }).code === "EEXIST"
	);
}

function writeStarterAgentFile(filePath: string): void {
	const fd = fs.openSync(filePath, "wx", 0o600);
	try {
		fs.writeFileSync(fd, STARTER_AGENT_MARKDOWN, { encoding: "utf-8" });
	} finally {
		fs.closeSync(fd);
	}
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
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user", options);
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", options);

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

/**
 * Discover user/project agents, creating a starter user agent when none exist.
 *
 * This intentionally has no marker file: if a user deletes every agent, the
 * starter will be recreated on the next discovery that needs runnable agents.
 * Existing files are never overwritten.
 */
export function discoverAgentsWithStarterForScope(cwd: string, scope: AgentScope, options: DiscoverAgentOptions = {}): StarterAgentDiscoveryResult {
	const initial = discoverAgents(cwd, scope, options);
	if (initial.agents.length > 0) {
		return { discovery: initial, createdAgentPath: null };
	}

	const userAgentsDir = getUserAgentsDir();

	try {
		fs.mkdirSync(userAgentsDir, { recursive: true });

		for (let attempt = 0; attempt < 100; attempt++) {
			const latest = attempt === 0 ? initial : discoverAgents(cwd, scope, options);
			if (latest.agents.length > 0) {
				return { discovery: latest, createdAgentPath: null };
			}

			const filePath = path.join(userAgentsDir, getStarterAgentFileName(attempt));
			try {
				writeStarterAgentFile(filePath);
				return {
					discovery: discoverAgents(cwd, scope, options),
					createdAgentPath: filePath,
				};
			} catch (err) {
				if (isFileExistsError(err)) continue;
				throw err;
			}
		}

		return {
			discovery: initial,
			createdAgentPath: null,
			error: `Could not find an unused starter agent filename in ${userAgentsDir}.`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			discovery: initial,
			createdAgentPath: null,
			error: `Could not create starter agent in ${userAgentsDir}: ${message}`,
		};
	}
}

export function discoverAgentsWithStarter(cwd: string): StarterAgentDiscoveryResult {
	return discoverAgentsWithStarterForScope(cwd, "both");
}
