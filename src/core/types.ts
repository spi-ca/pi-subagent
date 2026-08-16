/**
 * Shared type definitions for the subagent extension.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { AccountingUsage } from "./accounting-usage.js";
import { parseHerdrEnvironment } from "./herdr-environment.js";
import { getFinalAssistantText } from "./runner-events.js";

/** Context mode for delegated runs. */
export type DelegationMode = "spawn" | "fork";

/** Execution surface for delegated runs. */
export type TerminalMode = "inline" | "cmux-pane" | "tmux-pane" | "herdr-pane";

/** Display label for the subagent tool. */
export const SUBAGENT_TOOL_LABEL = "Subagent";

/** Default context mode for delegated runs. */
export const DEFAULT_DELEGATION_MODE: DelegationMode = "spawn";

/** Default execution surface for delegated runs. */
export const DEFAULT_TERMINAL_MODE: TerminalMode = "inline";

const CMUX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TMUX_PANE_ID_RE = /^%(?:0|[1-9][0-9]*)$/;
const CANONICAL_POSITIVE_PID_RE = /^[1-9][0-9]*$/;

/** Whether the current process has stable cmux UUID identity (refs are not identity). */
export function isInsideCmux(env: NodeJS.ProcessEnv = process.env): boolean {
	return CMUX_UUID_RE.test(env.CMUX_WORKSPACE_ID?.trim() ?? "") && CMUX_UUID_RE.test(env.CMUX_SURFACE_ID?.trim() ?? "");
}

/** Whether the process has the complete local Herdr pane identity. */
export function isInsideHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseHerdrEnvironment(env) !== null;
}

/** Whether the current process has a canonical tmux pane identity. */
export function isInsideTmux(env: NodeJS.ProcessEnv = process.env): boolean {
	// Keep this canonical parser local to avoid a core↔runtime dependency cycle.
	// The opaque socket prefix may be empty or contain whitespace and commas;
	// only the numeric right-side fields are structural.
	const match = /^(.*),\s*(\d+)\s*,\s*(\d+)\s*$/.exec(env.TMUX ?? "");
	return Boolean(match) && CANONICAL_POSITIVE_PID_RE.test(match?.[2] ?? "") && Number.isSafeInteger(Number(match?.[2])) && TMUX_PANE_ID_RE.test(env.TMUX_PANE?.trim() ?? "");
}

/** Explicit process-local override; invalid values intentionally retain safe auto-detection. */
export const SUBAGENT_TERMINAL_MODE_ENV = "PI_SUBAGENT_TERMINAL_MODE";

/** Default execution surface inferred from the current environment. */
export function getDefaultTerminalModeFromEnv(env: NodeJS.ProcessEnv = process.env, platform = process.platform): TerminalMode {
	if (platform === "win32") return DEFAULT_TERMINAL_MODE;
	const explicit = env[SUBAGENT_TERMINAL_MODE_ENV];
	if (explicit === "inline" || explicit === "cmux-pane" || explicit === "tmux-pane" || explicit === "herdr-pane") return explicit;
	if (isInsideCmux(env)) return "cmux-pane";
	if (isInsideHerdr(env)) return "herdr-pane";
	return isInsideTmux(env) ? "tmux-pane" : DEFAULT_TERMINAL_MODE;
}

/** Aggregated token usage from a subagent run. `contextTokens` tracks the latest assistant turn context size. */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** Result of a single subagent invocation. */
export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	stageLabel?: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	/** Legacy UI-only summary. Its semantics intentionally remain unchanged. */
	usage: UsageStats;
	/** Complete Pi usage accounting, including tool results and optional 0.81 fields. */
	accountingUsage?: AccountingUsage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	sawAgentEnd?: boolean;
}

/** Metadata attached to every tool result for rendering. */
export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	toolLabel: string;
	delegationMode: DelegationMode;
	terminalMode: TerminalMode;
	projectAgentsDir: string | null;
	results: SingleResult[];
	chainStageCount?: number;
	chainCompletedCount?: number;
	chainSkippedCount?: number;
	chainFailedCount?: number;
	chainCompletedWithErrorsCount?: number;
}

/** A display-friendly representation of a message part. */
export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Create an empty UsageStats object. */
export function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** Sum usage across multiple results. */
export function aggregateUsage(results: SingleResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

/** Whether the child emitted a final assistant text response. */
export function hasFinalAssistantOutput(r: Pick<SingleResult, "messages">): boolean {
	return getFinalAssistantText(r.messages).trim().length > 0;
}

/** Whether the child semantically completed the run. */
export function hasSemanticCompletion(r: Pick<SingleResult, "messages" | "sawAgentEnd">): boolean {
	return Boolean(r.sawAgentEnd) && hasFinalAssistantOutput(r);
}

/** Whether a result should be treated as successful by the wrapper/UI. */
export function isResultSuccess(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	if (hasSemanticCompletion(r)) return true;
	return r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
}

/** Whether a result represents an error. */
export function isResultError(r: SingleResult): boolean {
	if (r.exitCode === -1) return false;
	return !isResultSuccess(r);
}

/** Reconcile process exit status with semantic completion observed from Pi's event stream. */
export function normalizeCompletedResult(result: SingleResult, wasAborted: boolean): SingleResult {
	const hasSemanticSuccess = hasSemanticCompletion(result);

	if (wasAborted) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.stopReason === "aborted") result.stopReason = undefined;
			if (result.errorMessage === "Subagent was aborted.") {
				result.errorMessage = undefined;
			}
		} else {
			result.exitCode = 130;
			result.stopReason = "aborted";
			result.errorMessage = "Subagent was aborted.";
			if (!result.stderr.trim()) result.stderr = "Subagent was aborted.";
		}
		return result;
	}

	if (result.exitCode > 0) {
		if (hasSemanticSuccess) {
			result.exitCode = 0;
			if (result.stopReason === "error") result.stopReason = undefined;
			if (result.errorMessage === result.stderr.trim()) {
				result.errorMessage = undefined;
			}
		} else {
			if (!result.stopReason) result.stopReason = "error";
			if (!result.errorMessage && result.stderr.trim()) {
				result.errorMessage = result.stderr.trim();
			}
		}
	}

	return result;
}

/** Extract the last assistant text from a message history. */
export function getFinalOutput(messages: Message[]): string {
	return getFinalAssistantText(messages);
}

/** Extract all display-worthy items from a message history. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					items.push({ type: "text", text: part.text });
				} else if (part.type === "toolCall") {
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
				}
			}
		}
	}
	return items;
}
