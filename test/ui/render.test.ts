import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { emptyUsage, type SingleResult, type SubagentDetails } from "../../src/core/types";
import { Markdown } from "../../node_modules/@earendil-works/pi-tui/dist/components/markdown.js";
import { Spacer } from "../../node_modules/@earendil-works/pi-tui/dist/components/spacer.js";
import { Text } from "../../node_modules/@earendil-works/pi-tui/dist/components/text.js";
import { Container } from "../../node_modules/@earendil-works/pi-tui/dist/tui.js";

// The local TypeScript paths intentionally point at declaration files. Load
// the actual TUI components from their runtime modules, then supply them while
// stubbing the Markdown theme dependency before loading the renderer.
const { mock } = (await import("bun:test")) as unknown as {
	mock: { module(name: string, factory: () => Record<string, unknown>): void };
};
mock.module("@earendil-works/pi-coding-agent", () => ({
	getMarkdownTheme: () => ({}),
	// Shared global Bun module mocks can be observed by the discovery-cache
	// test worker too; retain the parser export that its core module needs.
	parseFrontmatter: (content: string) => {
		const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
		if (!match) throw new Error("invalid frontmatter");
		return {
			frontmatter: Object.fromEntries(match[1]!.split("\n").filter(Boolean).map((line) => {
				const separator = line.indexOf(":");
				return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
			})),
			body: match[2] ?? "",
		};
	},
}));
mock.module("@earendil-works/pi-tui", () => ({ Container, Markdown, Spacer, Text }));
const { renderCall, renderResult } = await import("../../src/ui/render");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function result(overrides: Partial<SingleResult> & Pick<SingleResult, "agent" | "exitCode">): SingleResult {
	return {
		agentSource: "user",
		task: `Task for ${overrides.agent}`,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		...overrides,
	};
}

function details(mode: "parallel" | "chain", results: SingleResult[]): SubagentDetails {
	return {
		mode,
		toolLabel: "Subagent",
		delegationMode: "spawn",
		terminalMode: "inline",
		projectAgentsDir: null,
		results,
		...(mode === "chain" ? { chainStageCount: 2 } : {}),
	};
}

function renderText(detailsValue: SubagentDetails, expanded: boolean): string {
	const component = renderResult({ content: [], details: detailsValue }, expanded, theme);
	return component
		.render(160)
		.join("\n")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[ ]+$/gm, "");
}

function totalLine(text: string): string {
	return text.split("\n").find((line) => line.includes("Total")) ?? "";
}

test("chain call rendering uses canonical trimmed and generated labels", () => {
	const component = renderCall({
		chain: [
			{ label: " \t", agent: "scout", task: "Inspect" },
			{ label: " plan ", agent: "planner", task: "Plan" },
		],
	}, theme);
	const text = component.render(160).join("\n");
	assert.match(text, /step-1\(scout\)/);
	assert.match(text, /plan\(planner\)/);
	assert.doesNotMatch(text, / plan /);
});

describe("parallel and chain usage rendering", () => {
	test("uses the expanded renderer while running and shows each agent usage/model", () => {
		const results = [
			result({
				agent: "running-agent",
				exitCode: -1,
				model: "model-running",
				usage: { input: 1200, output: 34, cacheRead: 5, cacheWrite: 6, cost: 0.0123, contextTokens: 900, turns: 2 },
			}),
			result({
				agent: "done-agent",
				exitCode: 0,
				model: "model-done",
				usage: { input: 300, output: 20, cacheRead: 7, cacheWrite: 8, cost: 0.004, contextTokens: 400, turns: 1 },
			}),
		];

		for (const mode of ["parallel", "chain"] as const) {
			const text = renderText(details(mode, results), true);
			assert.match(text, new RegExp(`Subagent ${mode}:`));
			assert.match(text, /running-agent/);
			assert.match(text, /done-agent/);
			assert.match(text, /2 turns ↑1\.2k ↓34 R5 W6 \$0\.0123 ctx\(last\):900 model-running/);
			assert.match(text, /1 turn ↑300 ↓20 R7 W8 \$0\.0040 ctx\(last\):400 model-done/);
			assert.equal(totalLine(text), "Total so far: 3 turns ↑1.5k ↓54 R12 W14 $0.0163");
		}
	});

	test("keeps compact agent usage/model in collapsed running and terminal views", () => {
		const running = result({
			agent: "model-only-agent",
			exitCode: -1,
			model: "model-known-before-usage",
		});
		const completed = result({
			agent: "completed-agent",
			exitCode: 0,
			model: "model-completed",
			usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 30, turns: 1 },
		});

		const runningText = renderText(details("parallel", [running, completed]), false);
		assert.match(runningText, /model-only-agent[\s\S]*model-known-before-usage/);
		assert.match(runningText, /completed-agent[\s\S]*1 turn ↑10 ↓20 ctx\(last\):30 model-completed/);
		assert.equal(totalLine(runningText), "Total so far: 1 turn ↑10 ↓20");

		const terminalText = renderText(details("parallel", [
			{ ...running, exitCode: 0 },
			completed,
		]), false);
		assert.match(terminalText, /model-only-agent[\s\S]*model-known-before-usage/);
		assert.equal(totalLine(terminalText), "Total: 1 turn ↑10 ↓20");
	});
});
