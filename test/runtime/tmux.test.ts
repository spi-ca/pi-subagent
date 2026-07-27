import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	buildGuardedTmuxPaneCommandArgs,
	buildTmuxNewWindowArgs,
	buildTmuxPaneSnapshotArgs,
	buildTmuxSourceTopologyArgs,
	buildTmuxSplitArgs,
	closeTmuxPane,
	createTmuxPane,
	createTmuxWindow,
	inspectTmuxPane,
	inspectTmuxPaneFingerprint,
	inspectTmuxPaneFingerprintForUx,
	interruptTmuxPane,
	isInsideTmux,
	matchesTmuxPaneFingerprint,
	parseCreatedTmuxPane,
	parseCreatedTmuxWindow,
	parsePositivePid,
	parseTmuxPaneSnapshots,
	readTmuxPaneTitle,
	parseTmuxSourceTopology,
	parseTmuxEnvironment,
	type TmuxCommandResult,
} from "../../src/runtime/tmux";
import { buildTmuxWindowLabel, isValidTmuxWindowLabel } from "../../src/runtime/tmux-window-label.mjs";

function outcome(stdout = "", exitCode = 0, stderr = ""): TmuxCommandResult {
	return { stdout, stderr, exitCode, aborted: false };
}

describe("tmux adapter", () => {
	test("parses pane and socket identity from the environment", () => {
		const env = { TMUX: "/tmp/tmux-501/default,123,0", TMUX_PANE: "%7" };
		assert.deepEqual(parseTmuxEnvironment(env), { paneId: "%7", socketPath: "/tmp/tmux-501/default", serverPid: 123 });
		assert.equal(isInsideTmux(env), true);
		assert.equal(parseTmuxEnvironment({ TMUX: " /tmp/socket with spaces , 123 , 0 ", TMUX_PANE: "%0" })?.socketPath, " /tmp/socket with spaces ");
		assert.equal(parseTmuxEnvironment({ TMUX: env.TMUX, TMUX_PANE: "%01" }), null);
		assert.equal(parseTmuxEnvironment({ TMUX: env.TMUX, TMUX_PANE: "bad" }), null);
	});

	test("builds a detached horizontal split with direct wrapper launch", () => {
		assert.deepEqual(buildTmuxSplitArgs({
			sourcePaneId: "%1",
			socketPath: "/tmp/tmux/default",
			cwd: "/tmp/project",
			wrapperPath: "/tmp/run/wrapper.sh",
		}), [
			"-S", "/tmp/tmux/default", "split-window", "-h", "-d", "-P", "-F", "#{pane_id}|#{pane_pid}",
			"-t", "%1", "-c", "/tmp/project", "exec '/tmp/run/wrapper.sh'",
		]);
	});

	test("queries strict printable source topology and rejects ambiguous or malformed rows", () => {
		assert.deepEqual(buildTmuxSourceTopologyArgs("/tmp/tmux/default"), [
			"-S", "/tmp/tmux/default", "list-panes", "-a", "-F", "#{pane_id}|#{session_id}|#{window_id}|#{pane_pid}",
		]);
		assert.deepEqual(parseTmuxSourceTopology("%7|$0|@0|101\n%8|$4|@10|102\n", "%7"), {
			paneId: "%7", sessionId: "$0", windowId: "@0",
		});
		for (const output of [
			"%7|$00|@9|101\n", "%7|$4|@00|101\n", "%7|$4|@9|extra\n", "%7\t$4\t@9\t101\n",
			"%7|$4|@9|101\n%7|$4|@10|102\n", "%7|$4|@9|101\nmalformed\n", "%7|$4|@9|0101\n",
		]) assert.equal(parseTmuxSourceTopology(output, "%7"), null);
		assert.equal(parseTmuxSourceTopology("%8|$4|@9|102\n", "%7"), null);
	});

	test("canonicalizes a bounded ASCII tmux window label and rejects injected forms", () => {
		assert.equal(buildTmuxWindowLabel("", ""), "subagent:agent:run");
		assert.equal(buildTmuxWindowLabel("review agent!", "abc123456789"), "subagent:review-agent:abc12345");
		assert.equal(buildTmuxWindowLabel("\u03b1\u0000\u001b[31m\u202E", "\u03b2"), "subagent:agent:run");
		assert.equal(buildTmuxWindowLabel("x".repeat(99), "r".repeat(99)), `subagent:${"x".repeat(24)}:${"r".repeat(8)}`);
		for (const label of ["subagent:agent:abc12345\n", "subagent:\u03b1:abc12345", "subagent:agent:#{pane_id}", "subagent:agent:abc123456"]) {
			assert.equal(isValidTmuxWindowLabel(label, "abc123456789"), false);
		}
		assert.equal(isValidTmuxWindowLabel("subagent:agent:abc12345", "abc123456789"), true);
	});

	test("builds a detached same-session window with direct argv and stable label", () => {
		const args = buildTmuxNewWindowArgs({
			sessionId: "$0", socketPath: "/tmp/tmux/default", cwd: "/tmp/project",
			agentName: "review agent!", runId: "abc123456789-untrusted-task-text",
			command: ["/usr/bin/env", "node", "/tmp/run/broker.mjs"],
		});
		assert.deepEqual(args, [
			"-S", "/tmp/tmux/default", "new-window", "-d", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}|#{pane_pid}",
			"-t", "$0:", "-n", "subagent:review-agent:abc12345", "-c", "/tmp/project",
			"/usr/bin/env", "node", "/tmp/run/broker.mjs",
		]);
		assert.equal(args.join(" ").includes("untrusted-task-text"), false);
		assert.throws(() => buildTmuxNewWindowArgs({
			sessionId: "$00", cwd: "/tmp/project", agentName: "worker", runId: "run-123", command: ["true"],
		}), /canonical session ID/);
	});

	test("parses only exact same-session new-window fingerprints", () => {
		assert.deepEqual(parseCreatedTmuxWindow("$0|@0|%12|212\n", "$0"), {
			sessionId: "$0", windowId: "@0", paneId: "%12", panePid: 212,
		});
		for (const output of [
			"$5|@9|%12|212\n", "$00|@9|%12|212\n", "$4|@00|%12|212\n", "$4|@9|%12|0212\n",
			"$4|@9|%12|212|extra\n", "$4\t@9\t%12\t212\n",
		]) assert.equal(parseCreatedTmuxWindow(output, "$4"), null);
		assert.equal(parseCreatedTmuxWindow("$0|@0|%12|212\n", "$00"), null);
	});

	test("parses only stable tmux pane ids and canonical PIDs", () => {
		assert.equal(parseCreatedTmuxPane("%12|212\n"), "%12");
		assert.equal(parseCreatedTmuxPane("%12\n"), null);
		assert.equal(parseCreatedTmuxPane("%12|212 \n"), null);
		assert.equal(parseCreatedTmuxPane("pane 12"), null);
		assert.equal(parsePositivePid("212"), 212);
		for (const malformed of ["0212", "212x", "212 ", "+212", "0"]) assert.equal(parsePositivePid(malformed), null);
	});

	test("keeps arbitrary titles out of authoritative snapshots", async () => {
		assert.deepEqual(buildTmuxPaneSnapshotArgs("/tmp/tmux"), ["-S", "/tmp/tmux", "list-panes", "-a", "-F", "#{pane_id}|#{pane_dead}|#{pane_pid}"]);
		assert.equal(buildTmuxPaneSnapshotArgs().at(-1)?.includes("pane_title"), false);
		assert.equal(parseTmuxPaneSnapshots("%1|0|101\n")?.get("%1")?.panePid, 101);
		for (const title of ["carriage\rreturn", "nul\0title"]) {
			const snapshot = parseTmuxPaneSnapshots("%1|0|101\n");
			assert.equal(snapshot?.get("%1")?.panePid, 101);
			assert.equal(await readTmuxPaneTitle("%1", "/tmp/tmux", async () => outcome(`${title}\n`)), undefined);
		}
		assert.equal(parseTmuxPaneSnapshots("%1|0|101\n")?.get("%1")?.panePid, 101);
		assert.equal(await readTmuxPaneTitle("%1", "/tmp/tmux", async () => outcome("pipe|title\n")), "pipe|title");
		assert.equal(parseTmuxPaneSnapshots("%1|0|101|extra\n"), null);
		assert.equal(parseTmuxPaneSnapshots("%1\t0\t101\n"), null);
	});

	test("reads pane titles only after an exact fingerprint for UX", async () => {
		const handle = { paneId: "%1", socketPath: "/tmp/tmux", serverPid: 123, panePid: 456 };
		const calls: string[][] = [];
		const readablePipeTitle = await inspectTmuxPaneFingerprintForUx(handle, async (args) => {
			calls.push(args);
			if (args.at(-1) === "#{pid}") return outcome("123\n");
			if (args.at(-1) === "#{pane_title}") return outcome("readable|pipe title\n");
			return outcome("%1|0|456\n");
		});
		assert.deepEqual(readablePipeTitle, { exists: true, dead: false, panePid: 456, title: "readable|pipe title" });
		assert.deepEqual(calls.map((args) => args.at(-1)), ["#{pid}", "#{pane_id}|#{pane_dead}|#{pane_pid}", "#{pane_title}"]);
		for (const titleResult of [outcome("bad\nvalue\n"), outcome("", 1)]) {
			const snapshot = await inspectTmuxPaneFingerprintForUx(handle, async (args) => {
				if (args.at(-1) === "#{pid}") return outcome("123\n");
				if (args.at(-1) === "#{pane_title}") return titleResult;
				return outcome("%1|0|456\n");
			});
			assert.deepEqual(snapshot, { exists: true, dead: false, panePid: 456 });
		}
		let titleRead = false;
		assert.deepEqual(await inspectTmuxPaneFingerprintForUx(handle, async (args) => {
			if (args.at(-1) === "#{pid}") return outcome("123\n");
			if (args.at(-1) === "#{pane_title}") titleRead = true;
			return outcome("%1|0|999\n");
		}), { exists: false });
		assert.equal(titleRead, false, "a failed fingerprint must not read a UX title");
	});

	test("refuses to split when the inherited tmux server was replaced", async () => {
		const calls: string[][] = [];
		await assert.rejects(
			() => createTmuxPane({
				sourcePaneId: "%1",
				socketPath: "/tmp/tmux/default",
				serverPid: 123,
				cwd: "/tmp/project",
				wrapperPath: "/tmp/run/wrapper.sh",
				run: async (args) => {
					calls.push(args);
					return outcome("999\n");
				},
			}),
			/server identity no longer matches/,
		);
		assert.equal(calls.some((args) => args.includes("split-window")), false);
	});

	test("rejects malformed tmux server PID probe output", async () => {
		await assert.rejects(() => createTmuxPane({
			sourcePaneId: "%1", serverPid: 123, cwd: "/tmp/project", wrapperPath: "/tmp/run/wrapper.sh",
			run: async () => outcome("123suffix\n"),
		}), /server identity no longer matches/);
	});

	test("refuses a detached window when its server fingerprint changed", async () => {
		const calls: string[][] = [];
		await assert.rejects(() => createTmuxWindow({
			sessionId: "$4", socketPath: "/tmp/tmux/default", serverPid: 123, cwd: "/tmp/project",
			agentName: "worker", runId: "run-123", command: ["/usr/bin/env", "true"],
			run: async (args) => { calls.push(args); return outcome("999\n"); },
		}), /server identity no longer matches/);
		assert.equal(calls.some((args) => args.includes("new-window")), false);
	});

	test("publishes a window fingerprint and rolls back only its exact pane on publication failure", async () => {
		const calls: string[][] = [];
		await assert.rejects(() => createTmuxWindow({
			sessionId: "$4", socketPath: "/tmp/tmux/default", serverPid: 123, cwd: "/tmp/project",
			agentName: "worker", runId: "run-123", command: ["/usr/bin/env", "true"],
			onAllocated: async (handle) => {
				assert.deepEqual(handle, {
					paneId: "%12", socketPath: "/tmp/tmux/default", serverPid: 123, panePid: 212,
					sessionId: "$4", windowId: "@9",
				});
				throw new Error("simulated publication failure");
			},
			run: async (args) => {
				calls.push(args);
				if (args.includes("display-message")) return outcome("123\n");
				if (args.includes("new-window")) return outcome("$4|@9|%12|212\n");
				if (args.includes("list-panes")) return outcome("%13|0|313\n%12|0|212\n");
				return outcome();
			},
		}), /simulated publication failure/);
		const close = calls.find((args) => args.includes("if-shell") && args.some((arg) => arg === "kill-pane -t %12"));
		assert.ok(close);
		assert.equal(calls.some((args) => args.includes("kill-window") || args.includes("kill-session")), false);
		assert.equal(calls.some((args) => args.some((arg) => arg === "kill-pane -t %13")), false);
	});

	test("publishes exact nonzero tmux targets before pane-only rollback and never guesses malformed output", async () => {
		for (const [kind, window] of [["pane", false], ["window", true]] as const) {
			const calls: string[][] = []; const published: unknown[] = [];
			const run = async (args: string[]) => {
				calls.push(args);
				if (args.includes("display-message")) return outcome("123\n");
				if (args.includes(window ? "new-window" : "split-window")) return outcome(window ? "$4|@9|%12|212\n" : "%12|212\n", 1, "tmux reported failure");
				if (args.includes("list-panes")) return outcome("%12|0|212\n");
				return outcome();
			};
			const create = window ? createTmuxWindow({ sessionId: "$4", serverPid: 123, cwd: "/tmp/project", agentName: "worker", runId: "run", command: ["true"], onAllocated: async (handle) => { published.push(handle); }, run }) : createTmuxPane({ sourcePaneId: "%1", serverPid: 123, cwd: "/tmp/project", wrapperPath: "/tmp/run/wrapper.sh", onAllocated: async (handle) => { published.push(handle); }, run });
			await assert.rejects(() => create, /tmux reported failure/);
			assert.equal(published.length, 1);
			assert.ok(calls.some((args) => args.includes("if-shell") && args.some((arg) => arg === "kill-pane -t %12")));
			assert.equal(calls.some((args) => args.includes("kill-window") || args.includes("kill-session")), false);
		}
		const calls: string[][] = [];
		await assert.rejects(() => createTmuxPane({
			sourcePaneId: "%1", serverPid: 123, cwd: "/tmp/project", wrapperPath: "/tmp/run/wrapper.sh",
			onAllocated: async () => assert.fail("malformed target must not publish"),
			run: async (args) => { calls.push(args); return args.includes("display-message") ? outcome("123\n") : outcome("malformed", 1, "tmux failed"); },
		}), /tmux failed/);
		assert.equal(calls.some((args) => args.includes("if-shell")), false);
	});

	test("does not roll back a pane when its fingerprint no longer matches", async () => {
		const calls: string[][] = [];
		await assert.rejects(() => createTmuxWindow({
			sessionId: "$4", serverPid: 123, cwd: "/tmp/project", agentName: "worker", runId: "run-123",
			command: ["/usr/bin/env", "true"], onAllocated: async () => { throw new Error("publication failed"); },
			run: async (args) => {
				calls.push(args);
				if (args.includes("display-message")) return outcome("123\n");
				if (args.includes("new-window")) return outcome("$4|@9|%12|212\n");
				return outcome("%12|0|999\n");
			},
		}), /publication failed/);
		assert.equal(calls.some((args) => args.includes("if-shell")), false);
	});

	test("publishes a stable pane before releasing the staged wrapper and closes only it on publication failure", async () => {
		const calls: string[][] = [];
		await assert.rejects(() => createTmuxPane({
			sourcePaneId: "%1",
			socketPath: "/tmp/tmux/default",
			serverPid: 123,
			cwd: "/tmp/project",
			wrapperPath: "/tmp/run/wrapper.sh",
			launchGatePath: "/tmp/run/launch.json",
			onAllocated: async (handle) => {
				assert.deepEqual(handle, { paneId: "%12", socketPath: "/tmp/tmux/default", serverPid: 123, panePid: 212 });
				throw new Error("simulated parent crash before launch.json");
			},
			run: async (args) => {
				calls.push(args);
				if (args.includes("display-message")) return outcome("123\n");
				if (args.includes("split-window")) return outcome("%12|212\n");
				if (args.includes("list-panes")) return outcome("%13|0|313\n%12|0|212\n");
				return outcome();
			},
		}), /simulated parent crash/);
		const split = calls.find((args) => args.includes("split-window"));
		assert.ok(split);
		assert.equal(split.at(-1), "while [ ! -f '/tmp/run/launch.json' ]; do sleep 0.05; done; exec '/tmp/run/wrapper.sh'");
		const close = calls.find((args) => args.includes("if-shell") && args.some((arg) => arg === "kill-pane -t %12"));
		assert.ok(close);
		assert.equal(calls.some((args) => args.some((arg) => arg === "kill-pane -t %13")), false);
	});

	test("uses a fixed nonempty false branch for guarded pane mutations", () => {
		const handle = { paneId: "%12", socketPath: "/tmp/tmux/default", serverPid: 123, panePid: 212 };
		for (const command of ["interrupt", "close"] as const) {
			const args = buildGuardedTmuxPaneCommandArgs(handle, command);
			assert.equal(args.at(-1), "display-message -p -l pi-subagent-guard-noop");
		}
	});

	test("creates, inspects, interrupts, and closes the exact pane", async () => {
		const calls: string[][] = [];
		const run = async (args: string[]) => {
			calls.push(args);
			if (args.includes("split-window")) return outcome("%12|212\n");
			if (args.includes("list-panes")) return outcome("%11|0|201\n%12|0|212\n");
			if (args.includes("display-message")) return outcome("123\n");
			return outcome();
		};
		const handle = await createTmuxPane({
			sourcePaneId: "%1",
			socketPath: "/tmp/tmux/default",
			serverPid: 123,
			cwd: "/tmp/project",
			wrapperPath: "/tmp/run/wrapper.sh",
			run,
		});
		assert.deepEqual(handle, { paneId: "%12", socketPath: "/tmp/tmux/default", serverPid: 123, panePid: 212 });
		assert.deepEqual(await inspectTmuxPane(handle, run), { exists: true, dead: false, panePid: 212 });
		assert.equal(await matchesTmuxPaneFingerprint(handle, run), true);
		assert.equal(await interruptTmuxPane(handle, run), true);
		assert.equal(await closeTmuxPane(handle, run), true);
		assert.equal(calls.some((args) => args.join(" ").includes("send-keys -t %12 Escape")), true);
		assert.deepEqual(calls.at(-1), buildGuardedTmuxPaneCommandArgs(handle, "close"));
		assert.equal(calls.some((args) => args[0] === "kill-pane" || args.at(-3) === "kill-pane"), false);
	});

	test("treats reused server or pane fingerprints as no longer owned", async () => {
		const handle = { paneId: "%12", socketPath: "/tmp/tmux/default", serverPid: 123, panePid: 212 };
		assert.deepEqual(await inspectTmuxPaneFingerprint(handle, async (args) => {
			if (args.includes("display-message")) return outcome("999\n");
			return outcome("%12|0|212\n");
		}), { exists: false });
		assert.deepEqual(await inspectTmuxPaneFingerprint(handle, async (args) => {
			if (args.includes("display-message")) return outcome("123\n");
			return outcome("%12|0|999\n");
		}), { exists: false });
		assert.equal(await inspectTmuxPaneFingerprint(handle, async () => outcome("", 1)), undefined);
	});

	test("rejects malformed or duplicate unrelated lifecycle rows rather than proving absence", async () => {
		const handle = { paneId: "%9", serverPid: 123, panePid: 999 };
		for (const output of [
			"%1|2|101\n", "%1|0|bad\n", "%1|0|101|extra\n",
			"%1|0|101\n%1|0|102\n", "%9|0|bad\n", "%1|0|101\0\n",
		]) assert.equal(await inspectTmuxPane(handle, async () => outcome(output)), undefined);
	});

	test("reports a missing pane only from a fully valid complete list", async () => {
		const snapshot = await inspectTmuxPane(
			{ paneId: "%9", serverPid: 123, panePid: 999 },
			async () => outcome("%1|0|101\n"),
		);
		assert.deepEqual(snapshot, { exists: false });
	});
});
