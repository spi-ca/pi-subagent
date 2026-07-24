import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { aggregateUsage, getDefaultTerminalModeFromEnv, isInsideCmux, isInsideTmux, type SingleResult } from "../../src/core/types";
import { parseTmuxEnvironment } from "../../src/runtime/tmux";

const TRACKED_ENV = ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "TMUX", "TMUX_PANE"] as const;
const originalEnv = Object.fromEntries(TRACKED_ENV.map((name) => [name, process.env[name]]));

function setTerminalEnv(values: Partial<Record<(typeof TRACKED_ENV)[number], string>> = {}) {
	for (const name of TRACKED_ENV) {
		const value = values[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

afterEach(() => {
	for (const name of TRACKED_ENV) {
		const value = originalEnv[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("usage aggregation", () => {
	test("adds only additive usage fields and leaves context as a per-agent value", () => {
		const results = [
			{
				agent: "first",
				agentSource: "user",
				task: "first task",
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 0.1, contextTokens: 100, turns: 1 },
				model: "model-a",
			},
			{
				agent: "second",
				agentSource: "user",
				task: "second task",
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.02, contextTokens: 200, turns: 2 },
				model: "model-b",
			},
		] satisfies SingleResult[];

		assert.deepEqual(aggregateUsage(results), {
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			cost: 0.12000000000000001,
			contextTokens: 0,
			turns: 3,
		});
	});
});

describe("terminal environment detection", () => {
	test("prefers cmux when cmux and tmux identities are both present", () => {
		setTerminalEnv({
			CMUX_WORKSPACE_ID: "123e4567-e89b-42d3-a456-426614174000",
			CMUX_SURFACE_ID: "123e4567-e89b-42d3-a456-426614174001",
			TMUX: "/tmp/tmux/default,1,0",
			TMUX_PANE: "%1",
		});
		assert.equal(isInsideCmux(), true);
		assert.equal(getDefaultTerminalModeFromEnv(), "cmux-pane");
	});

	test("uses tmux when both tmux identity variables are present", () => {
		setTerminalEnv({ TMUX: "/tmp/tmux/default,1,0", TMUX_PANE: "%3" });
		assert.equal(isInsideTmux(), true);
		assert.equal(getDefaultTerminalModeFromEnv(), "tmux-pane");
		setTerminalEnv({ TMUX: "/tmp/tmux/default,01,0", TMUX_PANE: "%3" });
		assert.equal(isInsideTmux(), false);
	});

	test("requires complete multiplexer identities", () => {
		setTerminalEnv({ CMUX_WORKSPACE_ID: "123e4567-e89b-42d3-a456-426614174000", TMUX: "/tmp/tmux/default,1,0" });
		assert.equal(isInsideCmux(), false);
		assert.equal(isInsideTmux(), false);
		assert.equal(getDefaultTerminalModeFromEnv(), "inline");
	});

	test("matches the runtime tmux environment grammar", () => {
		const cases = [
			{ TMUX: ", 123 , 0 ", TMUX_PANE: " %1 " },
			{ TMUX: " socket, prefix ,\t123\t,\t00\t", TMUX_PANE: "%0" },
			{ TMUX: " ,1,0", TMUX_PANE: "%2" },
			{ TMUX: "/tmp/socket,01,0", TMUX_PANE: "%1" },
			{ TMUX: "/tmp/socket,0,0", TMUX_PANE: "%1" },
			{ TMUX: "/tmp/socket,9007199254740992,0", TMUX_PANE: "%1" },
			{ TMUX: "/tmp/socket,123x,0", TMUX_PANE: "%1" },
			{ TMUX: "/tmp/socket,123,-1", TMUX_PANE: "%1" },
			{ TMUX: "/tmp/socket,123,0x", TMUX_PANE: "%1" },
			{ TMUX: "/tmp/socket,123,0", TMUX_PANE: "%01" },
		] satisfies NodeJS.ProcessEnv[];
		for (const env of cases) assert.equal(isInsideTmux(env), parseTmuxEnvironment(env) !== null, JSON.stringify(env));
	});

	test("forces inline on Windows even with valid multiplexer identities", () => {
		setTerminalEnv({
			CMUX_WORKSPACE_ID: "123e4567-e89b-42d3-a456-426614174000",
			CMUX_SURFACE_ID: "123e4567-e89b-42d3-a456-426614174001",
			TMUX: "/tmp/tmux/default,1,0",
			TMUX_PANE: "%1",
		});
		assert.equal(getDefaultTerminalModeFromEnv(process.env, "win32"), "inline");
	});

	test("falls back to inline outside multiplexers", () => {
		setTerminalEnv();
		assert.equal(isInsideCmux(), false);
		assert.equal(isInsideTmux(), false);
		assert.equal(getDefaultTerminalModeFromEnv(), "inline");
	});

	test("ignores empty multiplexer env values", () => {
		setTerminalEnv({ CMUX_WORKSPACE_ID: " ", CMUX_SURFACE_ID: "", TMUX: "   ", TMUX_PANE: "" });
		assert.equal(isInsideCmux(), false);
		assert.equal(isInsideTmux(), false);
		assert.equal(getDefaultTerminalModeFromEnv(), "inline");
	});
});
