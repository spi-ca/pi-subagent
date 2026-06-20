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

