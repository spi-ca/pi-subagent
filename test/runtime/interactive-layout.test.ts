import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	INTERACTIVE_PANE_LAYOUT_ENV,
	InteractiveLayoutCoordinator,
	resolveInteractivePaneLayout,
	selectTmuxInteractivePlacement,
	type CmuxCommittedLayoutAllocation,
} from "../../src/runtime/interactive-layout";
import type { CmuxSourceV2 } from "../../src/runtime/run-protocol";

const workspaceId = "123e4567-e89b-12d3-a456-426614174000";
const sourceSurfaceId = "123e4567-e89b-12d3-a456-426614174001";
const source: CmuxSourceV2 = { workspaceId, sourceSurfaceId };
const validPane = async () => true;
const pane = (suffix: string) => `123e4567-e89b-12d3-a456-426614174${suffix}`;

function committed(request: { layout: "auto" | "split"; placement: "cmux-split" | "cmux-new-surface"; container: { kind: string; workspaceId: string; paneId?: string } }, surfaceSuffix: string): CmuxCommittedLayoutAllocation {
	const paneId = request.placement === "cmux-split"
		? pane("090")
		: request.container.paneId!;
	return {
		committed: true,
		layout: request.layout,
		placement: request.placement,
		container: { kind: "cmux-pane", workspaceId, paneId },
		target: { workspaceId, paneId, surfaceId: pane(surfaceSuffix) },
	};
}

describe("interactive pane layout resolver", () => {
	test("defaults to auto, honors CLI before env, and rejects non-exact values", () => {
		assert.equal(resolveInteractivePaneLayout(undefined, {}), "auto");
		assert.equal(resolveInteractivePaneLayout(undefined, { [INTERACTIVE_PANE_LAYOUT_ENV]: "split" }), "split");
		assert.equal(resolveInteractivePaneLayout("auto", { [INTERACTIVE_PANE_LAYOUT_ENV]: "split" }), "auto");
		assert.throws(() => resolveInteractivePaneLayout(undefined, { [INTERACTIVE_PANE_LAYOUT_ENV]: " auto" }), /exactly/);
		assert.throws(() => resolveInteractivePaneLayout("AUTO", {}), /--subagent-pane-layout/);
	});
});

describe("InteractiveLayoutCoordinator", () => {
	test("serializes concurrent foreground and background root allocations into one split and shared surfaces", async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		const requests: string[] = [];
		let sequence = 10;
		const allocate = async (request: Parameters<typeof committed>[0]) => {
			requests.push(request.placement);
			await Promise.resolve();
			return committed(request, String(sequence++).padStart(3, "0"));
		};
		const leases = await Promise.all(Array.from({ length: 6 }, (_, index) => coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: `foreground-or-background-${index}`, allocate,
		})));
		assert.equal(requests.filter((placement) => placement === "cmux-split").length, 1);
		assert.equal(requests.filter((placement) => placement === "cmux-new-surface").length, 5);
		assert.equal(coordinator.activeCmuxSurfaceCount(source), 6);
		await Promise.all(leases.map((lease) => coordinator.releaseCmux({ lease, close: async () => true })));
	});

	test("uses the exact nested source pane without splitting", async () => {
		const nestedSource = { workspaceId, sourceSurfaceId: pane("020") };
		const coordinator = new InteractiveLayoutCoordinator({
			validateCmuxPane: validPane,
			resolveCmuxSourcePane: async (resolved) => ({ kind: "cmux-source-pane", workspaceId: resolved.workspaceId, sourceSurfaceId: resolved.sourceSurfaceId, paneId: pane("021") }),
		});
		const lease = await coordinator.allocateCmux({
			rootSource: source, source: nestedSource, depth: 1, layout: "auto", runId: "nested",
			allocate: async (request) => committed(request, "022"),
		});
		assert.deepEqual(lease.request, {
			layout: "auto", placement: "cmux-new-surface",
			container: { kind: "cmux-source-pane", workspaceId, sourceSurfaceId: pane("020"), paneId: pane("021") },
		});
		await coordinator.releaseCmux({ lease, close: async () => true });
	});

	test("split layout always selects cmux-split", async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		const lease = await coordinator.allocateCmux({
			source, depth: 4, layout: "split", runId: "split",
			allocate: async (request) => committed(request, "030"),
		});
		assert.equal(lease.request.placement, "cmux-split");
		assert.equal(lease.request.layout, "split");
	});

	test("preserves siblings, retires the final state after failed close, and never reuses that pane", async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		let sequence = 40;
		const allocate = async (request: Parameters<typeof committed>[0]) => committed(request, String(sequence++).padStart(3, "0"));
		const first = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "first", allocate });
		const second = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "second", allocate });
		await coordinator.releaseCmux({ lease: first, close: async () => true });
		assert.equal(coordinator.activeCmuxSurfaceCount(source), 1);
		await assert.rejects(coordinator.releaseCmux({ lease: second, close: async () => false }), /Failed to close/);
		assert.equal(coordinator.activeCmuxSurfaceCount(source), 0);
		const replacement = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "replacement", allocate });
		assert.equal(replacement.request.placement, "cmux-split");
	});

	test("invalidates a stale shared pane before selecting a new split", async () => {
		let valid = true;
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: async () => valid });
		const first = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "first", allocate: async (request) => committed(request, "050") });
		valid = false;
		const replacement = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "replacement", allocate: async (request) => committed(request, "051") });
		assert.equal(replacement.request.placement, "cmux-split");
		await coordinator.releaseCmux({ lease: first, close: async () => true });
		await coordinator.releaseCmux({ lease: replacement, close: async () => true });
	});

	test("requires a validator and fails closed when shared-pane validation throws", async () => {
		assert.throws(
			// @ts-expect-error The validator is a required coordinator dependency.
			() => new InteractiveLayoutCoordinator({}),
			/cmux pane validator/,
		);
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: async () => { throw new Error("inspection failed"); } });
		await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "first", allocate: async (request) => committed(request, "052") });
		const replacement = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "replacement", allocate: async (request) => committed(request, "053") });
		assert.equal(replacement.request.placement, "cmux-split");
	});

	test("rejects duplicate canonical target surfaces and malformed cmux discriminants", async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		const first = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "first", allocate: async (request) => committed(request, "054") });
		await assert.rejects(coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: "duplicate",
			allocate: async (request) => {
				const allocation = committed(request, "054");
				return { ...allocation, target: { ...allocation.target, surfaceId: allocation.target.surfaceId.toUpperCase() } };
			},
		}), /already adopted/);
		await coordinator.releaseCmux({ lease: first, close: async () => true });
		await assert.rejects(coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: "bad-container",
			allocate: async (request) => ({ ...committed(request, "055"), container: { kind: "cmux-source", workspaceId, paneId: pane("090") } } as unknown as CmuxCommittedLayoutAllocation),
		}), /not adopted/);
		await assert.rejects(coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: "bad-layout",
			allocate: async (request) => ({ ...committed(request, "058"), layout: "AUTO" } as unknown as CmuxCommittedLayoutAllocation),
		}), /not adopted/);
	});

	test("retains failed close leases for retry after false or thrown close", async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		const falseLease = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "false", allocate: async (request) => committed(request, "056") });
		let falseCloses = 0;
		await assert.rejects(coordinator.releaseCmux({ lease: falseLease, close: async () => { falseCloses += 1; return false; } }), /Failed to close/);
		await coordinator.releaseCmux({ lease: falseLease, close: async () => { falseCloses += 1; return true; } });
		assert.equal(falseCloses, 2);
		const thrownLease = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "throw", allocate: async (request) => committed(request, "057") });
		await assert.rejects(coordinator.releaseCmux({ lease: thrownLease, close: async () => { throw new Error("close exploded"); } }), /close exploded/);
		await coordinator.releaseCmux({ lease: thrownLease, close: async () => true });
	});

	test("does not adopt failed or mismatched allocations", async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		await assert.rejects(coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: "failed", allocate: async () => { throw new Error("broker failed"); },
		}), /broker failed/);
		const mismatched = await assert.rejects(coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: "mismatch", allocate: async (request) => ({ ...committed(request, "060"), placement: "cmux-new-surface" }),
		}), /not adopted/);
		assert.equal(mismatched, undefined);
		const lease = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "good", allocate: async (request) => committed(request, "061") });
		assert.equal(lease.request.placement, "cmux-split");
	});

	test("concurrent duplicate releases share one failed close and a later retry", async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		const lease = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "duplicate-release", allocate: async (request) => committed(request, "069") });
		let unblock!: () => void;
		const gate = new Promise<void>((resolve) => { unblock = resolve; });
		let closes = 0;
		const first = coordinator.releaseCmux({ lease, close: async () => { closes += 1; await gate; return false; } });
		const second = coordinator.releaseCmux({ lease, close: async () => { closes += 1; return true; } });
		unblock();
		const results = await Promise.allSettled([first, second]);
		assert.equal(closes, 1);
		assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
		await coordinator.releaseCmux({ lease, close: async () => { closes += 1; return true; } });
		assert.equal(closes, 2);
	});

	test("release is serialized with allocation and idempotent", async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		const first = await coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "race", allocate: async (request) => committed(request, "070") });
		let releaseClose!: () => void;
		const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
		let closes = 0;
		const releasing = coordinator.releaseCmux({ lease: first, close: async () => { closes += 1; await closeGate; return true; } });
		const next = coordinator.allocateCmux({ source, depth: 0, layout: "auto", runId: "after-race", allocate: async (request) => committed(request, "071") });
		await Promise.resolve();
		releaseClose();
		await Promise.all([releasing, coordinator.releaseCmux({ lease: first, close: async () => { closes += 1; return true; } })]);
		assert.equal(closes, 1);
		assert.equal((await next).request.placement, "cmux-split");
	});

	for (const count of [1, 6, 16, 17, 50]) test(`keeps root auto allocation deterministic for N=${count} under staggered reverse release`, async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		const placements: string[] = [];
		const leases = await Promise.all(Array.from({ length: count }, (_, index) => coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: `root-${count}-${index}`,
			allocate: async (request) => {
				placements.push(request.placement);
				await Promise.resolve();
				return committed(request, String(100 + index));
			},
		})));
		assert.equal(placements.filter((placement) => placement === "cmux-split").length, 1);
		assert.equal(placements.filter((placement) => placement === "cmux-new-surface").length, count - 1);
		assert.equal(new Set(leases.map((lease) => lease.allocation.target.surfaceId.toLowerCase())).size, count);
		assert.equal(coordinator.activeCmuxSurfaceCount(source), count);

		const closed: string[] = [];
		const reverseLeases = [...leases].reverse();
		for (const lease of reverseLeases) {
			await Promise.resolve(); // deterministic stagger without relying on wall-clock timing
			await coordinator.releaseCmux({ lease, close: async (allocation) => {
				closed.push(allocation.target.surfaceId);
				return true;
			} });
		}
		assert.deepEqual(closed, reverseLeases.map((lease) => lease.allocation.target.surfaceId));
		assert.equal(new Set(closed.map((id) => id.toLowerCase())).size, count);
		assert.equal(coordinator.activeCmuxSurfaceCount(source), 0);
	});

	for (const count of [1, 6, 16, 17, 50]) test(`uses independent root locks and exact nested sources for split N=${count}`, async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		const secondRoot = { workspaceId, sourceSurfaceId: pane("080") };
		const nestedSource = { workspaceId, sourceSurfaceId: pane("081") };
		const requests = await Promise.all(Array.from({ length: count }, async (_, index) => {
			const useNested = index % 2 === 1;
			const currentSource = useNested ? nestedSource : index % 4 === 0 ? secondRoot : source;
			const rootSource = useNested ? secondRoot : currentSource;
			const lease = await coordinator.allocateCmux({
				rootSource, source: currentSource, depth: useNested ? 3 : 0, layout: "split", runId: `split-${count}-${index}`,
				allocate: async (request) => committed(request, String(200 + index)),
			});
			return { lease, currentSource };
		}));
		for (const { lease, currentSource } of requests) {
			assert.equal(lease.request.placement, "cmux-split");
			assert.deepEqual(lease.request.container, { kind: "cmux-source", workspaceId, sourceSurfaceId: currentSource.sourceSurfaceId });
		}
		assert.equal(new Set(requests.map(({ lease }) => lease.allocation.target.surfaceId.toLowerCase())).size, count);
		await Promise.all(requests.map(({ lease }) => coordinator.releaseCmux({ lease, close: async () => true })));
		assert.equal(coordinator.activeCmuxSurfaceCount(source), 0);
		assert.equal(coordinator.activeCmuxSurfaceCount(secondRoot), 0);
	});

	test("lets a queued root allocation recover from a failed first split without phantom shared state", async () => {
		const coordinator = new InteractiveLayoutCoordinator({ validateCmuxPane: validPane });
		let firstEntered!: () => void;
		const firstReady = new Promise<void>((resolve) => { firstEntered = resolve; });
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
		const failed = coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: "failed-first",
			allocate: async () => { firstEntered(); await firstGate; throw new Error("injected first split failure"); },
		});
		await firstReady;
		const successor = coordinator.allocateCmux({
			source, depth: 0, layout: "auto", runId: "successor",
			allocate: async (request) => committed(request, "260"),
		});
		releaseFirst();
		await assert.rejects(failed, /injected first split failure/);
		const lease = await successor;
		assert.equal(lease.request.placement, "cmux-split");
		assert.equal(coordinator.activeCmuxSurfaceCount(source), 1);
		await coordinator.releaseCmux({ lease, close: async () => true });
		assert.equal(coordinator.activeCmuxSurfaceCount(source), 0);
	});
});

describe("tmux stateless layout selector", () => {
	const generation = { socketPath: "/tmp/tmux.sock", socketDev: "1", socketIno: "2", serverStartedAt: 3 };
	const tmuxSource = { socketPath: "/tmp/tmux.sock", serverPid: 10, sourcePaneId: "%1", sourcePanePid: 11, generation };
	const topology = { kind: "tmux-source-pane" as const, socketPath: "/tmp/tmux.sock", serverPid: 10, sessionId: "$1", windowId: "@2", paneId: "%1", panePid: 11, generation };

	test("selects exact source topology for split and exact source session for auto", () => {
		assert.deepEqual(selectTmuxInteractivePlacement({ layout: "split", source: tmuxSource, sourceTopology: topology }), {
			layout: "split", placement: "tmux-split", container: topology,
		});
		assert.deepEqual(selectTmuxInteractivePlacement({ layout: "auto", source: tmuxSource, sourceTopology: topology }), {
			layout: "auto", placement: "tmux-new-window",
			container: { kind: "tmux-session", socketPath: "/tmp/tmux.sock", serverPid: 10, sessionId: "$1", sourceWindowId: "@2", generation },
		});
	});

	test("rejects malformed source kind, layout, and topology", () => {
		assert.throws(() => selectTmuxInteractivePlacement({ layout: "auto", source: tmuxSource, sourceTopology: { ...topology, panePid: 12 } }), /exact source pane topology/);
		assert.throws(() => selectTmuxInteractivePlacement({ layout: "auto", source: tmuxSource, sourceTopology: { ...topology, kind: "tmux-session" } as never }), /exact source pane topology/);
		assert.throws(() => selectTmuxInteractivePlacement({ layout: "AUTO" as never, source: tmuxSource, sourceTopology: topology }), /exact source pane topology/);
	});
});
