import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertCmuxLayoutSupport,
	buildCmuxFullTreeArgs,
	buildCmuxNewSplitArgs,
	buildCmuxNewSurfaceArgs,
	buildCmuxRespawnPaneArgs,
	closeCmuxSurface,
	cmuxIdsEqual,
	createCmuxSplit,
	createCmuxSurface,
	interruptCmuxSurface,
	inspectCmuxSurface,
	parseCmuxCapabilities,
	parseCreatedCmuxSurface,
	diagnoseCanonicalCmuxSurfacePane,
	parseCmuxLayoutPhase0Fixture,
	resolveCanonicalCmuxSurfacePane,
	sanitizeCreatedCmuxSurfaceResponse,
	type CmuxCommandResult,
} from "../../src/runtime/cmux";
import { isInsideCmux } from "../../src/core/types";

const originalWorkspace = process.env.CMUX_WORKSPACE_ID;
const originalSurface = process.env.CMUX_SURFACE_ID;
const workspaceId = "123e4567-e89b-12d3-a456-426614174000";
const sourceSurfaceId = "123e4567-e89b-12d3-a456-426614174001";
const surfaceId = "123e4567-e89b-12d3-a456-426614174002";
const paneId = "123e4567-e89b-12d3-a456-426614174003";
const newSurfaceId = "123e4567-e89b-12d3-a456-426614174004";

afterEach(() => {
	if (originalWorkspace === undefined) delete process.env.CMUX_WORKSPACE_ID;
	else process.env.CMUX_WORKSPACE_ID = originalWorkspace;
	if (originalSurface === undefined) delete process.env.CMUX_SURFACE_ID;
	else process.env.CMUX_SURFACE_ID = originalSurface;
});

function outcome(stdout = "", exitCode = 0, stderr = ""): CmuxCommandResult {
	return { stdout, stderr, exitCode, aborted: false };
}

describe("cmux adapter", () => {
	test("requires both inherited cmux identity variables", () => {
		process.env.CMUX_WORKSPACE_ID = "123e4567-e89b-12d3-a456-426614174000";
		delete process.env.CMUX_SURFACE_ID;
		assert.equal(isInsideCmux(), false);
		process.env.CMUX_SURFACE_ID = "123e4567-e89b-12d3-a456-426614174001";
		assert.equal(isInsideCmux(), true);
		process.env.CMUX_SURFACE_ID = "surface:1";
		assert.equal(isInsideCmux(), false);
	});

	test("requires semantic cmux layout support and uses a full topology query", async () => {
		assert.deepEqual(buildCmuxFullTreeArgs(workspaceId), ["--json", "--id-format", "both", "tree", "--all"]);
		const calls: string[][] = [];
		await assertCmuxLayoutSupport(async (args) => {
			calls.push(args);
			return args[0] === "--version"
				? outcome("cmux 0.64.20")
				: outcome(JSON.stringify({ methods: ["surface.create", "surface.close", "surface.send_key", "surface.respawn"] }));
		});
		assert.deepEqual(calls, [["--version"], ["--json", "capabilities"]]);
		await assert.rejects(() => assertCmuxLayoutSupport(async () => outcome("cmux 0.64.19")), /--subagent-pane-layout=split/);
	});

	test("builds explicit non-focusing split arguments", () => {
		assert.deepEqual(buildCmuxNewSplitArgs({ workspaceId: "w", sourceSurfaceId: "s" }), [
			"--json", "--id-format", "both", "new-split", "right",
			"--workspace", "w", "--surface", "s", "--focus", "false",
		]);
	});

	test("keeps cmux socket authorities out of respawn argv while preserving the new pane identity", () => {
		const wrapperPath = "/tmp/it's literal\\n\\r\\t wrapper.sh";
		const args = buildCmuxRespawnPaneArgs("workspace-id", "surface-id", wrapperPath);
		assert.deepEqual(args.slice(0, -1), ["respawn-pane", "--workspace", "workspace-id", "--surface", "surface-id", "--command"]);
		const command = args[args.length - 1]!;
		assert.match(command, /^exec \/usr\/bin\/env -u BASH_ENV /);
		assert.match(command, /\/bin\/bash/);
		for (const secret of ["CMUX_SOCKET_PATH", "CMUX_SOCKET_CAPABILITY", "CMUX_BUNDLED_CLI_PATH", "/safe/socket", "safe-capability", "/safe/cmux"]) assert.doesNotMatch(command, new RegExp(secret));
		assert.doesNotMatch(command, /CMUX_(?:WORKSPACE|SURFACE)_ID/);
		assert.equal(command.includes("\n"), false);
		assert.equal(command.includes("\r"), false);
		assert.match(command, /'\/tmp\/it'"'"'s literal\\n\\r\\t wrapper\.sh'$/);
	});

	test("keeps the residual new-split shell free of run and child authorities until post-allocation", async () => {
		const sensitive = ["/private/run", "/private/wrapper.sh", "/private/secret-env.sh", "secret task", "child-command"];
		const calls: string[][] = [];
		await createCmuxSplit({
			workspaceId: workspaceId, sourceSurfaceId: sourceSurfaceId, wrapperPath: sensitive[1]!,
			onAllocated: async () => {
				assert.deepEqual(calls, [buildCmuxNewSplitArgs({ workspaceId: workspaceId, sourceSurfaceId: sourceSurfaceId })]);
				for (const authority of sensitive) assert.equal(calls[0]!.includes(authority), false);
			},
			run: async (args) => {
				calls.push(args);
				return calls.length === 1 ? outcome(JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId })) : outcome();
			},
		});
		assert.equal(calls[1]?.[0], "respawn-pane");
	});

	test("parses stable IDs and refs from split JSON", () => {
		assert.deepEqual(parseCreatedCmuxSurface(JSON.stringify({
			workspace_id: workspaceId,
			workspace_ref: "workspace:2",
			pane_id: paneId,
			pane_ref: "pane:4",
			surface_id: surfaceId,
			surface_ref: "surface:7",
		})), {
			workspaceId: workspaceId,
			workspaceRef: "workspace:2",
			paneId: paneId,
			paneRef: "pane:4",
			surfaceId: surfaceId,
			surfaceRef: "surface:7",
		});
	});

	test("requires direct canonical workspace, surface, and pane IDs from a created response", () => {
		for (const response of [
			{ workspace_id: "workspace:2", surface_id: surfaceId, pane_id: paneId },
			{ workspace_id: workspaceId, surface_ref: "surface:7", pane_id: paneId },
			{ workspace_id: workspaceId, surface_id: "surface:7", pane_id: paneId },
			{ workspace_id: workspaceId, surface_id: surfaceId },
			{ workspace_ref: "workspace:2", surface_id: surfaceId, pane_id: paneId },
			{ workspace_id: workspaceId, pane_id: paneId, id: surfaceId },
		]) assert.equal(parseCreatedCmuxSurface(JSON.stringify(response)), null);
		assert.equal(parseCreatedCmuxSurface(JSON.stringify({ surface_id: surfaceId, pane_id: paneId })), null);
	});

	test("rejects malformed own result envelopes instead of falling back to top-level IDs", () => {
		const direct = { workspace_id: workspaceId, pane_id: paneId, surface_id: surfaceId };
		for (const result of [null, [], "not-an-object"]) {
			assert.equal(parseCreatedCmuxSurface(JSON.stringify({ ...direct, result })), null);
		}
		assert.deepEqual(parseCreatedCmuxSurface(JSON.stringify({ result: direct })), {
			workspaceId, paneId, surfaceId,
			workspaceRef: undefined, paneRef: undefined, surfaceRef: undefined,
		});
	});

	test("sanitizes created responses without moving their result envelope", () => {
		const direct = { workspace_id: workspaceId, pane_id: paneId, surface_id: surfaceId };
		assert.deepEqual(sanitizeCreatedCmuxSurfaceResponse(JSON.stringify({ ...direct, surface_ref: "surface:7", ignored: true })), direct);
		assert.deepEqual(sanitizeCreatedCmuxSurfaceResponse(JSON.stringify({ result: { ...direct, pane_ref: "pane:4" }, metadata: "ignored" })), { result: direct });
		assert.equal(sanitizeCreatedCmuxSurfaceResponse(JSON.stringify({ ...direct, result: null })), null);
	});

	test("creates a split, then respawns it with the quoted wrapper command", async () => {
		const calls: string[][] = [];
		const run = async (args: string[]) => {
			calls.push(args);
			return calls.length === 1
				? outcome(JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, surface_ref: "surface:7", pane_id: paneId }))
				: outcome();
		};
		const handle = await createCmuxSplit({
			workspaceId: workspaceId,
			sourceSurfaceId: sourceSurfaceId,
			wrapperPath: "/tmp/run/wrapper.sh",
			run,
		});
		assert.equal(handle.surfaceId, surfaceId);
		assert.deepEqual(calls, [
			buildCmuxNewSplitArgs({ workspaceId: workspaceId, sourceSurfaceId: sourceSurfaceId }),
			buildCmuxRespawnPaneArgs(workspaceId, surfaceId, "/tmp/run/wrapper.sh"),
		]);
		assert.equal(calls[1]?.join(" ").includes("Task:"), false);
	});

	test("does not create a split when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const calls: string[][] = [];
		await assert.rejects(() => createCmuxSplit({
			workspaceId: workspaceId,
			sourceSurfaceId: sourceSurfaceId,
			wrapperPath: "/tmp/wrapper.sh",
			signal: controller.signal,
			run: async (args) => {
				calls.push(args);
				return outcome();
			},
		}), /split creation was aborted/);
		assert.deepEqual(calls, []);
	});

	test("treats uppercase UUID aliases as the same split authority while preserving response spelling", async () => {
		const uppercaseWorkspace = workspaceId.toUpperCase();
		const uppercaseSurface = surfaceId.toUpperCase();
		const calls: string[][] = [];
		const handle = await createCmuxSplit({
			workspaceId, sourceSurfaceId, wrapperPath: "/tmp/wrapper.sh",
			run: async (args) => {
				calls.push(args);
				return calls.length === 1
					? outcome(JSON.stringify({ workspace_id: uppercaseWorkspace, surface_id: uppercaseSurface, pane_id: paneId.toUpperCase() }))
					: outcome();
			},
		});
		assert.equal(handle.workspaceId, uppercaseWorkspace);
		assert.deepEqual(calls[1], buildCmuxRespawnPaneArgs(uppercaseWorkspace, uppercaseSurface, "/tmp/wrapper.sh"));
	});

	test("rejects a split response that aliases the immutable source without closing it", async () => {
		const calls: string[][] = [];
		await assert.rejects(() => createCmuxSplit({
			workspaceId: workspaceId, sourceSurfaceId: sourceSurfaceId, wrapperPath: "/tmp/wrapper.sh",
			run: async (args) => {
				calls.push(args);
				return outcome(JSON.stringify({ workspace_id: workspaceId, surface_id: sourceSurfaceId, pane_id: paneId }));
			},
		}), /reused the source surface/);
		assert.deepEqual(calls, [buildCmuxNewSplitArgs({ workspaceId: workspaceId, sourceSurfaceId: sourceSurfaceId })]);
		const uppercaseCalls: string[][] = [];
		await assert.rejects(() => createCmuxSplit({
			workspaceId, sourceSurfaceId, wrapperPath: "/tmp/wrapper.sh",
			run: async (args) => { uppercaseCalls.push(args); return outcome(JSON.stringify({ workspace_id: workspaceId.toUpperCase(), surface_id: sourceSurfaceId.toUpperCase(), pane_id: paneId })); },
		}), /reused the source surface/);
		assert.deepEqual(uppercaseCalls, [buildCmuxNewSplitArgs({ workspaceId, sourceSurfaceId })]);
	});

	test("publishes and closes an exact split response before handling a nonzero result", async () => {
		const calls: string[][] = [];
		const events: string[] = [];
		await assert.rejects(() => createCmuxSplit({
			workspaceId, sourceSurfaceId, wrapperPath: "/tmp/wrapper.sh",
			onAllocated: async (handle) => {
				assert.equal(handle.surfaceId, newSurfaceId);
				events.push("published");
			},
			run: async (args) => {
				calls.push(args);
				events.push(args[0] === "close-surface" ? "closed" : "created");
				return calls.length === 1
					? outcome(JSON.stringify({ workspace_id: workspaceId, surface_id: newSurfaceId, pane_id: paneId }), 1, "split failed")
					: outcome();
			},
		}), /split failed/);
		assert.deepEqual(events, ["created", "published", "closed"]);
		assert.deepEqual(calls, [
			buildCmuxNewSplitArgs({ workspaceId, sourceSurfaceId }),
			["close-surface", "--workspace", workspaceId, "--surface", newSurfaceId],
		]);
	});

	test("does not publish or mutate for a malformed nonzero split response", async () => {
		const calls: string[][] = [];
		await assert.rejects(() => createCmuxSplit({
			workspaceId, sourceSurfaceId, wrapperPath: "/tmp/wrapper.sh",
			onAllocated: async () => assert.fail("malformed response must not publish"),
			run: async (args) => {
				calls.push(args);
				return outcome(JSON.stringify({ workspace_id: workspaceId, surface_id: newSurfaceId }), 1, "split failed");
			},
		}), /split failed/);
		assert.deepEqual(calls, [buildCmuxNewSplitArgs({ workspaceId, sourceSurfaceId })]);
	});

	test("never publishes, respawns, or rolls back ref-only, malformed, or cross-workspace responses", async () => {
		const foreignWorkspaceId = "123e4567-e89b-12d3-a456-426614174099";
		for (const response of [
			{ workspace_id: workspaceId, surface_ref: "surface:7" },
			{ workspace_id: foreignWorkspaceId, surface_id: surfaceId, pane_id: paneId },
			{ workspace_id: workspaceId, surface_id: surfaceId },
		]) {
			const calls: string[][] = [];
			await assert.rejects(() => createCmuxSplit({
				workspaceId, sourceSurfaceId, wrapperPath: "/tmp/wrapper.sh",
				onAllocated: async () => assert.fail("malformed response must not publish"),
				run: async (args) => { calls.push(args); return outcome(JSON.stringify(response)); },
			}), /exact canonical cmux split response/);
			assert.deepEqual(calls, [buildCmuxNewSplitArgs({ workspaceId, sourceSurfaceId })]);
		}
	});

	test("rejects noncanonical source authority before issuing a cmux command", async () => {
		const calls: string[][] = [];
		await assert.rejects(() => createCmuxSplit({
			workspaceId, sourceSurfaceId: "surface:1", wrapperPath: "/tmp/wrapper.sh",
			run: async (args) => { calls.push(args); return outcome(); },
		}), /requires canonical requested workspace/);
		assert.deepEqual(calls, []);
	});

	test("recovers and closes a split created immediately before abort", async () => {
		const controller = new AbortController();
		const calls: Array<{ args: string[]; signal?: AbortSignal }> = [];
		await assert.rejects(() => createCmuxSplit({
			workspaceId: workspaceId,
			sourceSurfaceId: sourceSurfaceId,
			wrapperPath: "/tmp/wrapper.sh",
			signal: controller.signal,
			run: async (args, options) => {
				calls.push({ args, signal: options?.signal });
				if (calls.length === 1) {
					controller.abort();
					return outcome(JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId }));
				}
				return outcome();
			},
		}), /split creation was aborted/);
		assert.deepEqual(calls.map(({ args }) => args), [
			buildCmuxNewSplitArgs({ workspaceId: workspaceId, sourceSurfaceId: sourceSurfaceId }),
			["close-surface", "--workspace", workspaceId, "--surface", surfaceId],
		]);
		assert.equal(calls[0]?.signal, undefined);
	});

	test("closes only the newly allocated surface when durable publication fails before respawn", async () => {
		const calls: string[][] = [];
		await assert.rejects(() => createCmuxSplit({
			workspaceId: workspaceId,
			sourceSurfaceId: sourceSurfaceId,
			wrapperPath: "/tmp/run/wrapper.sh",
			onAllocated: async (handle) => {
				assert.equal(handle.surfaceId, newSurfaceId);
				throw new Error("simulated parent crash before launch.json");
			},
			run: async (args) => {
				calls.push(args);
				return calls.length === 1
					? outcome(JSON.stringify({ workspace_id: workspaceId, surface_id: newSurfaceId, pane_id: paneId }))
					: outcome();
			},
		}), /simulated parent crash/);
		assert.deepEqual(calls, [
			buildCmuxNewSplitArgs({ workspaceId: workspaceId, sourceSurfaceId: sourceSurfaceId }),
			["close-surface", "--workspace", workspaceId, "--surface", newSurfaceId],
		]);
		assert.equal(calls.some((args) => args.includes("surface-unrelated")), false);
	});

	test("closes the created surface when respawning it fails", async () => {
		const calls: string[][] = [];
		const run = async (args: string[]) => {
			calls.push(args);
			if (calls.length === 1) return outcome(JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId }));
			if (calls.length === 2) return outcome("", 1, "send failed");
			return outcome();
		};
		await assert.rejects(() => createCmuxSplit({
			workspaceId: workspaceId,
			sourceSurfaceId: sourceSurfaceId,
			wrapperPath: "/tmp/wrapper.sh",
			run,
		}), /send failed/);
		assert.deepEqual(calls[2], ["close-surface", "--workspace", workspaceId, "--surface", surfaceId]);
	});

	test("closes the created surface when respawning is aborted", async () => {
		const calls: string[][] = [];
		const run = async (args: string[]) => {
			calls.push(args);
			if (calls.length === 1) return outcome(JSON.stringify({ workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId }));
			if (calls.length === 2) return { ...outcome(), aborted: true };
			return outcome();
		};
		await assert.rejects(() => createCmuxSplit({
			workspaceId: workspaceId,
			sourceSurfaceId: sourceSurfaceId,
			wrapperPath: "/tmp/wrapper.sh",
			run,
		}), /was aborted/);
		assert.deepEqual(calls, [
			buildCmuxNewSplitArgs({ workspaceId: workspaceId, sourceSurfaceId: sourceSurfaceId }),
			buildCmuxRespawnPaneArgs(workspaceId, surfaceId, "/tmp/wrapper.sh"),
			["close-surface", "--workspace", workspaceId, "--surface", surfaceId],
		]);
	});

	test("resolves the original surface globally before lifecycle commands", async () => {
		const handle = { workspaceId, surfaceId: sourceSurfaceId, surfaceRef: "surface:7" };
		const tree = {
			windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [
				{ id: surfaceId, pane_id: paneId, ref: "surface:6", title: "other" },
				{ id: sourceSurfaceId, pane_id: paneId, ref: "surface:7", title: "subagent", type: "terminal" },
			] }] }] }],
		};
		const snapshot = await inspectCmuxSurface(handle, async () => outcome(JSON.stringify(tree)));
		assert.deepEqual(snapshot, { exists: true, workspaceId, paneId, surfaceId: sourceSurfaceId, title: "subagent", type: "terminal" });
		const interruptCalls: string[][] = [];
		assert.equal(await interruptCmuxSurface(handle, async (args) => {
			interruptCalls.push(args);
			return args.includes("tree") ? outcome(JSON.stringify(tree)) : outcome();
		}), true);
		assert.deepEqual(interruptCalls, [
			buildCmuxFullTreeArgs(workspaceId),
			["send-key", "--workspace", workspaceId, "--surface", sourceSurfaceId, "escape"],
		]);
		const closeCalls: string[][] = [];
		assert.equal(await closeCmuxSurface(handle, async (args) => {
			closeCalls.push(args);
			return args.includes("tree") ? outcome(JSON.stringify(tree)) : outcome();
		}), true);
		assert.deepEqual(closeCalls, [
			buildCmuxFullTreeArgs(workspaceId),
			["close-surface", "--workspace", workspaceId, "--surface", sourceSurfaceId],
		]);
	});

	test("resolves a surface moved to another workspace and targets its current location", async () => {
		const movedWorkspaceId = "123e4567-e89b-12d3-a456-426614174005";
		const movedPaneId = "123e4567-e89b-12d3-a456-426614174006";
		const handle = { workspaceId, surfaceId: sourceSurfaceId };
		const tree = {
			windows: [{ workspaces: [
				{ id: workspaceId, panes: [] },
				{ id: movedWorkspaceId, panes: [{ id: movedPaneId, surfaces: [{ id: sourceSurfaceId, pane_id: movedPaneId, title: "moved", type: "terminal" }] }] },
			] }],
		};
		assert.deepEqual(await inspectCmuxSurface(handle, async () => outcome(JSON.stringify(tree))), {
			exists: true, workspaceId: movedWorkspaceId, paneId: movedPaneId, surfaceId: sourceSurfaceId, title: "moved", type: "terminal",
		});
		for (const [command, invoke] of [
			[["send-key", "--workspace", movedWorkspaceId, "--surface", sourceSurfaceId, "escape"], interruptCmuxSurface],
			[["close-surface", "--workspace", movedWorkspaceId, "--surface", sourceSurfaceId], closeCmuxSurface],
		] as const) {
			const calls: string[][] = [];
			assert.equal(await invoke(handle, async (args) => {
				calls.push(args);
				return args.includes("tree") ? outcome(JSON.stringify(tree)) : outcome();
			}), true);
			assert.deepEqual(calls, [buildCmuxFullTreeArgs(workspaceId), command]);
		}
	});

	test("rejects ref and noncanonical lifecycle handles before issuing commands", async () => {
		for (const handle of [
			{ workspaceId: "workspace:2", surfaceId },
			{ workspaceId, surfaceId: "surface:7" },
		]) {
			const calls: string[][] = [];
			const run = async (args: string[]) => { calls.push(args); return outcome(); };
			assert.equal(await inspectCmuxSurface(handle, run), undefined);
			assert.equal(await interruptCmuxSurface(handle, run), false);
			assert.equal(await closeCmuxSurface(handle, run), false);
			assert.deepEqual(calls, []);
		}
	});

	test("does not treat an empty or arbitrary nested topology as proof a canonical surface is absent", async () => {
		const handle = {
			workspaceId: "123e4567-e89b-12d3-a456-426614174000",
			surfaceId: "123e4567-e89b-12d3-a456-426614174001",
		};
		assert.equal(await inspectCmuxSurface(handle, async () => outcome("{}")), undefined);
		assert.equal(await inspectCmuxSurface(handle, async () => outcome(JSON.stringify({ error: { surfaces: [] } }))), undefined);
		assert.deepEqual(await inspectCmuxSurface(handle, async () => outcome(JSON.stringify({ windows: [{ workspaces: [{ id: handle.workspaceId, panes: [] }] }] }))), { exists: false });
	});

	test("confirms global absence only after complete strict topology and never mutates", async () => {
		const handle = { workspaceId, surfaceId: sourceSurfaceId };
		const tree = { windows: [{ workspaces: [{ id: "123e4567-e89b-12d3-a456-426614174099", panes: [] }] }] };
		assert.deepEqual(await inspectCmuxSurface(handle, async () => outcome(JSON.stringify(tree))), { exists: false });
		for (const invoke of [interruptCmuxSurface, closeCmuxSurface]) {
			const calls: string[][] = [];
			assert.equal(await invoke(handle, async (args) => {
				calls.push(args);
				return outcome(JSON.stringify(tree));
			}), false);
			assert.deepEqual(calls, [buildCmuxFullTreeArgs(workspaceId)]);
		}
	});

	test("fails closed for duplicate, cross-type, or malformed global topology", async () => {
		const handle = { workspaceId, surfaceId: sourceSurfaceId };
		const foreignWorkspaceId = "123e4567-e89b-12d3-a456-426614174099";
		for (const tree of [
			{ windows: [{ workspaces: [
				{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: sourceSurfaceId, pane_id: paneId }] }] },
				{ id: foreignWorkspaceId, panes: [{ id: newSurfaceId, surfaces: [{ id: sourceSurfaceId.toUpperCase(), pane_id: newSurfaceId }] }] },
			] }] },
			{ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: sourceSurfaceId, surfaces: [] }] }] }] },
			{ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: surfaceId, pane_id: "pane:7" }] }] }] }] },
		]) {
			assert.equal(await inspectCmuxSurface(handle, async () => outcome(JSON.stringify(tree))), undefined);
			for (const invoke of [interruptCmuxSurface, closeCmuxSurface]) {
				const calls: string[][] = [];
				assert.equal(await invoke(handle, async (args) => {
					calls.push(args);
					return outcome(JSON.stringify(tree));
				}), false);
				assert.deepEqual(calls, [buildCmuxFullTreeArgs(workspaceId)]);
			}
		}
	});

	test("strictly validates only the sanitized Phase 0 fixture schema", () => {
		const direct = { workspace_id: workspaceId, pane_id: paneId, surface_id: surfaceId };
		const valid = {
			schema_version: 1, contract_id: "cmux-layout-v1", cmux_version: "0.64.20",
			new_split_response: direct,
			new_surface_response: { result: { ...direct, surface_id: newSurfaceId } },
			last_surface_pane: "empty",
			capabilities: { "surface.create": true, "surface.close": true, "surface.send_key": true, "surface.respawn": true },
		};
		assert.ok(parseCmuxLayoutPhase0Fixture(valid));
		assert.equal(parseCmuxLayoutPhase0Fixture({ ...valid, cmux_version: "0.65.0" })?.cmuxVersion, "0.65.0");
		for (const invalid of [
			{ ...valid, unknown: true },
			{ ...valid, contract_id: "cmux-layout-0.64.20" },
			{ ...valid, cmux_version: "0.64.19" },
			{ ...valid, cmux_version: "0.65.0-rc1" },
			{ ...valid, cmux_version: "garbage" },
			{ ...valid, capabilities: { ...valid.capabilities, unknown: true } },
			{ ...valid, new_split_response: { ...direct, surface_ref: "surface:7" } },
			{ ...valid, new_surface_response: { result: { ...direct, surface_id: newSurfaceId }, extra: true } },
			{ ...valid, new_surface_response: { result: null } },
		]) assert.equal(parseCmuxLayoutPhase0Fixture(invalid), null);
	});

	test("builds strict unfocused terminal new-surface arguments and parses required capabilities", () => {
		assert.deepEqual(buildCmuxNewSurfaceArgs({ workspaceId: "w", paneId: "p", cwd: "/work" }), [
			"--json", "--id-format", "both", "new-surface", "--type", "terminal",
			"--workspace", "w", "--pane", "p", "--working-directory", "/work", "--focus", "false",
		]);
		assert.deepEqual(parseCmuxCapabilities(JSON.stringify({ methods: [
			"surface.create", "surface.close", "surface.send_key", "surface.respawn", "workspace.list",
		] })), { "surface.create": true, "surface.close": true, "surface.send_key": true, "surface.respawn": true });
		for (const response of [
			{ methods: ["surface.create", "surface.close", "surface.send_key"] },
			{ methods: ["surface.create", "surface.close", "surface.send_key", "surface.respawn", "surface.create"] },
			{ methods: ["surface.create", "surface.close", "surface.send_key", " surface.respawn"] },
			{ methods: "surface.create" },
		]) assert.equal(parseCmuxCapabilities(JSON.stringify(response)), null);
	});

	test("resolves a source pane only from a complete unique canonical tree", () => {
		const tree = {
			windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [
				{ id: sourceSurfaceId, pane_id: paneId },
			] }] }] }],
		};
		assert.deepEqual(resolveCanonicalCmuxSurfacePane(JSON.stringify(tree), workspaceId.toUpperCase(), sourceSurfaceId.toUpperCase()), {
			workspaceId, paneId, surfaceId: sourceSurfaceId,
		});
		assert.deepEqual(diagnoseCanonicalCmuxSurfacePane("not-json", workspaceId, sourceSurfaceId), { ok: false, reason: "invalid-json" });
		assert.deepEqual(diagnoseCanonicalCmuxSurfacePane(JSON.stringify({ windows: [] }), workspaceId, sourceSurfaceId), { ok: false, reason: "source-absent" });
		assert.deepEqual(diagnoseCanonicalCmuxSurfacePane(JSON.stringify({ windows: [{ workspaces: [{ id: workspaceId, panes: [] }, { id: workspaceId, panes: [] }] }] }), workspaceId, sourceSurfaceId), { ok: false, reason: "duplicate-identity" });
		for (const invalid of [
			{ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: sourceSurfaceId, pane_id: "pane:1" }] }] }] }] },
			{ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [{ id: sourceSurfaceId, pane_id: paneId }] }] }, { id: newSurfaceId, panes: [{ id: sourceSurfaceId, surfaces: [] }] }] }] },
			{ windows: [{ workspaces: [{ id: workspaceId, panes: [{ id: paneId, surfaces: [] }] }] }] },
		]) assert.equal(resolveCanonicalCmuxSurfacePane(JSON.stringify(invalid), workspaceId, sourceSurfaceId), undefined);
	});

	test("creates an exact new surface and rolls back only it after publication or respawn failure", async () => {
		const calls: string[][] = [];
		const handle = await createCmuxSurface({
			workspaceId, paneId, cwd: "/work", wrapperPath: "/tmp/wrapper.sh",
			onAllocated: async (allocated) => assert.equal(allocated.surfaceId, newSurfaceId),
			run: async (args) => {
				calls.push(args);
				return calls.length === 1
					? outcome(JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, surface_id: newSurfaceId }))
					: outcome();
			},
		});
		assert.equal(handle.surfaceId, newSurfaceId);
		assert.deepEqual(calls, [
			buildCmuxNewSurfaceArgs({ workspaceId, paneId, cwd: "/work" }),
			buildCmuxRespawnPaneArgs(workspaceId, newSurfaceId, "/tmp/wrapper.sh"),
		]);

		const failedCalls: string[][] = [];
		await assert.rejects(() => createCmuxSurface({
			workspaceId, paneId, cwd: "/work", wrapperPath: "/tmp/wrapper.sh",
			onAllocated: async () => { throw new Error("publication failed"); },
			run: async (args) => {
				failedCalls.push(args);
				return failedCalls.length === 1
					? outcome(JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, surface_id: newSurfaceId }))
					: outcome();
			},
		}), /publication failed/);
		assert.deepEqual(failedCalls, [
			buildCmuxNewSurfaceArgs({ workspaceId, paneId, cwd: "/work" }),
			["close-surface", "--workspace", workspaceId, "--surface", newSurfaceId],
		]);
	});

	test("publishes an exact create response before aborted or nonzero rollback", async () => {
		for (const { response, expected } of [
			{ response: { ...outcome(JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, surface_id: newSurfaceId })), aborted: true }, expected: /surface creation was aborted/ },
			{ response: outcome(JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, surface_id: newSurfaceId }), 1, "create failed"), expected: /create failed/ },
		]) {
			const calls: string[][] = [];
			const events: string[] = [];
			await assert.rejects(() => createCmuxSurface({
				workspaceId, paneId, cwd: "/work", wrapperPath: "/tmp/wrapper.sh",
				onAllocated: async (handle) => {
					assert.equal(handle.surfaceId, newSurfaceId);
					events.push("published");
				},
				run: async (args) => {
					calls.push(args);
					events.push(args[0] === "close-surface" ? "closed" : "created");
					return calls.length === 1 ? response : outcome();
				},
			}), expected);
			assert.deepEqual(events, ["created", "published", "closed"]);
			assert.deepEqual(calls, [
				buildCmuxNewSurfaceArgs({ workspaceId, paneId, cwd: "/work" }),
				["close-surface", "--workspace", workspaceId, "--surface", newSurfaceId],
			]);
		}
	});

	test("publishes an exact create response before signal cancellation rollback", async () => {
		const controller = new AbortController();
		const calls: string[][] = [];
		const events: string[] = [];
		await assert.rejects(() => createCmuxSurface({
			workspaceId, paneId, cwd: "/work", wrapperPath: "/tmp/wrapper.sh", signal: controller.signal,
			onAllocated: async () => { events.push("published"); },
			run: async (args) => {
				calls.push(args);
				events.push(args[0] === "close-surface" ? "closed" : "created");
				if (calls.length === 1) controller.abort();
				return calls.length === 1
					? outcome(JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, surface_id: newSurfaceId }))
					: outcome();
			},
		}), /surface creation was aborted/);
		assert.deepEqual(events, ["created", "published", "closed"]);
		assert.deepEqual(calls, [
			buildCmuxNewSurfaceArgs({ workspaceId, paneId, cwd: "/work" }),
			["close-surface", "--workspace", workspaceId, "--surface", newSurfaceId],
		]);
	});

	test("closes only the exact returned surface when respawn fails or is aborted", async () => {
		for (const { response, expected } of [
			{ response: outcome("", 1, "respawn failed"), expected: /respawn failed/ },
			{ response: { ...outcome(), aborted: true }, expected: /command delivery was aborted/ },
		]) {
			const calls: string[][] = [];
			await assert.rejects(() => createCmuxSurface({
				workspaceId, paneId, cwd: "/work", wrapperPath: "/tmp/wrapper.sh",
				run: async (args) => {
					calls.push(args);
					if (calls.length === 1) return outcome(JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, surface_id: newSurfaceId }));
					return calls.length === 2 ? response : outcome();
				},
			}), expected);
			assert.deepEqual(calls, [
				buildCmuxNewSurfaceArgs({ workspaceId, paneId, cwd: "/work" }),
				buildCmuxRespawnPaneArgs(workspaceId, newSurfaceId, "/tmp/wrapper.sh"),
				["close-surface", "--workspace", workspaceId, "--surface", newSurfaceId],
			]);
		}
	});

	test("does not publish or roll back a malformed nonzero create response", async () => {
		const calls: string[][] = [];
		await assert.rejects(() => createCmuxSurface({
			workspaceId, paneId, cwd: "/work", wrapperPath: "/tmp/wrapper.sh",
			onAllocated: async () => assert.fail("malformed response must not publish"),
			run: async (args) => {
				calls.push(args);
				return outcome(JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, surface_id: "surface:7" }), 1, "create failed");
			},
		}), /create failed/);
		assert.deepEqual(calls, [buildCmuxNewSurfaceArgs({ workspaceId, paneId, cwd: "/work" })]);
	});

	test("rejects invalid, wrong-container, and source-alias new-surface responses without unsafe cleanup", async () => {
		const noCommand: string[][] = [];
		await assert.rejects(() => createCmuxSurface({
			workspaceId, paneId: "pane:1", cwd: "/work", wrapperPath: "/tmp/wrapper.sh",
			run: async (args) => { noCommand.push(args); return outcome(); },
		}), /requires canonical requested workspace/);
		assert.deepEqual(noCommand, []);
		const foreignWorkspaceId = "123e4567-e89b-12d3-a456-426614174099";
		for (const response of [
			{ workspace_id: foreignWorkspaceId, pane_id: paneId, surface_id: newSurfaceId },
			{ workspace_id: workspaceId, pane_id: "123e4567-e89b-12d3-a456-426614174098", surface_id: newSurfaceId },
			{ workspace_id: workspaceId, pane_id: paneId, surface_id: "surface:7" },
		]) {
			const calls: string[][] = [];
			await assert.rejects(() => createCmuxSurface({
				workspaceId, paneId, cwd: "/work", wrapperPath: "/tmp/wrapper.sh",
				run: async (args) => { calls.push(args); return outcome(JSON.stringify(response)); },
			}), /exact canonical cmux surface response/);
			assert.deepEqual(calls, [buildCmuxNewSurfaceArgs({ workspaceId, paneId, cwd: "/work" })]);
		}
		const calls: string[][] = [];
		await assert.rejects(() => createCmuxSurface({
			workspaceId, paneId, cwd: "/work", wrapperPath: "/tmp/wrapper.sh", sourceSurfaceId,
			run: async (args) => { calls.push(args); return outcome(JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, surface_id: sourceSurfaceId.toUpperCase() })); },
		}), /exact canonical cmux surface response/);
		assert.deepEqual(calls, [buildCmuxNewSurfaceArgs({ workspaceId, paneId, cwd: "/work" })]);

		const abortedCalls: string[][] = [];
		await assert.rejects(() => createCmuxSurface({
			workspaceId, paneId, cwd: "/work", wrapperPath: "/tmp/wrapper.sh",
			run: async (args) => {
				abortedCalls.push(args);
				return abortedCalls.length === 1
					? { ...outcome(JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, surface_id: newSurfaceId }), 1), aborted: true }
					: outcome();
			},
		}), /surface creation was aborted/);
		assert.deepEqual(abortedCalls, [
			buildCmuxNewSurfaceArgs({ workspaceId, paneId, cwd: "/work" }),
			["close-surface", "--workspace", workspaceId, "--surface", newSurfaceId],
		]);
	});

	test("validates the mandatory version-independent cmux layout fixture", () => {
		const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/cmux-layout-contract-v1.json");
		assert.equal(fs.existsSync(fixturePath), true, "Phase 0 fixture is mandatory; promote it only with the explicitly gated live probe.");
		const fixture = parseCmuxLayoutPhase0Fixture(JSON.parse(fs.readFileSync(fixturePath, "utf8")));
		assert.ok(fixture, "fixture must contain sanitized direct canonical IDs, exact envelopes, and exact relationships");
		assert.equal(fixture.contractId, "cmux-layout-v1");
		assert.equal(fixture.cmuxVersion, "0.64.20");
		assert.equal(cmuxIdsEqual(fixture.newSplit.workspaceId, fixture.newSurface.workspaceId), true);
		assert.equal(cmuxIdsEqual(fixture.newSplit.paneId, fixture.newSurface.paneId), true);
		assert.equal(cmuxIdsEqual(fixture.newSplit.surfaceId, fixture.newSurface.surfaceId), false);
	});
});
