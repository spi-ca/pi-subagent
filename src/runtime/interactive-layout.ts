import { cmuxIdsEqual, isCanonicalCmuxId } from "./cmux.js";
import { TMUX_PANE_ID_RE, TMUX_SESSION_ID_RE, TMUX_WINDOW_ID_RE } from "./tmux.js";
import type {
	CmuxAllocatedContainerV2,
	CmuxSourceContainerV2,
	CmuxSourcePaneContainerV2,
	CmuxSourceV2,
	LayoutPlacementRequestV2,
	TmuxSourcePaneContainerV2,
	TmuxSourceV2,
} from "./run-protocol.js";

/** Environment override for the interactive terminal layout policy. */
export const INTERACTIVE_PANE_LAYOUT_ENV = "PI_SUBAGENT_PANE_LAYOUT";
export type InteractivePaneLayout = "auto" | "split";

/** Resolve an exact layout value; whitespace and aliases are deliberately invalid. */
export function resolveInteractivePaneLayout(
	cliValue: unknown = undefined,
	env: NodeJS.ProcessEnv = process.env,
): InteractivePaneLayout {
	const value = cliValue === undefined ? env[INTERACTIVE_PANE_LAYOUT_ENV] : cliValue;
	if (value === undefined) return "auto";
	if (value === "auto" || value === "split") return value;
	const origin = cliValue === undefined ? INTERACTIVE_PANE_LAYOUT_ENV : "--subagent-pane-layout";
	throw new Error(`${origin} must be exactly "auto" or "split" (received ${JSON.stringify(value)}).`);
}

export interface CmuxCommittedLayoutAllocation {
	/** The broker has durably committed this exact allocation. */
	committed: true;
	layout: InteractivePaneLayout;
	placement: "cmux-split" | "cmux-new-surface";
	container: CmuxAllocatedContainerV2;
	target: { workspaceId: string; paneId: string; surfaceId: string };
}

export interface CmuxLayoutLease {
	readonly id: number;
	readonly rootKey: string;
	readonly runId: string;
	readonly request: Extract<LayoutPlacementRequestV2, { placement: "cmux-split" | "cmux-new-surface" }>;
	readonly allocation: CmuxCommittedLayoutAllocation;
}

export interface CmuxLayoutAllocationOptions {
	/** A stable root source makes foreground, background, and nested calls share one lock. */
	rootSource?: CmuxSourceV2;
	/** The current calling surface. For root calls this is normally rootSource. */
	source: CmuxSourceV2;
	depth: number;
	layout: InteractivePaneLayout;
	runId: string;
	/** Called under the root lock only after placement has been selected. */
	allocate(request: Extract<LayoutPlacementRequestV2, { placement: "cmux-split" | "cmux-new-surface" }>): Promise<CmuxCommittedLayoutAllocation>;
}

export interface CmuxLayoutReleaseOptions {
	lease: CmuxLayoutLease;
	/** Closes only lease.allocation.target, and runs while the root lock is held. */
	close(allocation: CmuxCommittedLayoutAllocation): Promise<boolean>;
}

export interface InteractiveLayoutCoordinatorOptions {
	/** Resolves the exact enclosing pane for a nested source surface. */
	resolveCmuxSourcePane?: (source: CmuxSourceV2) => Promise<CmuxSourcePaneContainerV2 | undefined>;
	/** Required fail-closed validation before a root shared pane is reused. */
	validateCmuxPane(pane: CmuxAllocatedContainerV2): Promise<boolean>;
}

type CmuxPlacement = Extract<LayoutPlacementRequestV2, { placement: "cmux-split" | "cmux-new-surface" }>;
type SharedState = {
	token: number;
	pane: CmuxAllocatedContainerV2;
	active: Set<number>;
};

function assertCmuxSource(source: CmuxSourceV2, label: string): void {
	if (!isCanonicalCmuxId(source.workspaceId) || !isCanonicalCmuxId(source.sourceSurfaceId)
		|| cmuxIdsEqual(source.workspaceId, source.sourceSurfaceId)) {
		throw new Error(`${label} requires distinct canonical cmux workspace and source surface IDs.`);
	}
}

function cmuxRootKey(source: CmuxSourceV2): string {
	return `${source.workspaceId.toLowerCase()}:${source.sourceSurfaceId.toLowerCase()}`;
}

function sameCmuxPane(left: CmuxAllocatedContainerV2, right: CmuxAllocatedContainerV2): boolean {
	return cmuxIdsEqual(left.workspaceId, right.workspaceId) && cmuxIdsEqual(left.paneId, right.paneId);
}

function validCmuxAllocation(
	allocation: unknown,
	request: CmuxPlacement,
	source: CmuxSourceV2,
): boolean {
	if (!allocation || typeof allocation !== "object") return false;
	const candidate = allocation as CmuxCommittedLayoutAllocation;
	if (candidate.committed !== true || (candidate.layout !== "auto" && candidate.layout !== "split")
		|| (candidate.placement !== "cmux-split" && candidate.placement !== "cmux-new-surface")
		|| candidate.layout !== request.layout || candidate.placement !== request.placement
		|| candidate.container?.kind !== "cmux-pane" || !isCanonicalCmuxId(candidate.target?.workspaceId)
		|| !isCanonicalCmuxId(candidate.target?.paneId) || !isCanonicalCmuxId(candidate.target?.surfaceId)
		|| !isCanonicalCmuxId(candidate.container.workspaceId) || !isCanonicalCmuxId(candidate.container.paneId)
		|| !cmuxIdsEqual(candidate.target.workspaceId, source.workspaceId)
		|| cmuxIdsEqual(candidate.target.surfaceId, source.sourceSurfaceId)
		|| !sameCmuxPane(candidate.container, { kind: "cmux-pane", workspaceId: candidate.target.workspaceId, paneId: candidate.target.paneId })) return false;
	if (request.placement === "cmux-split") return request.container.kind === "cmux-source"
		&& cmuxIdsEqual(request.container.workspaceId, source.workspaceId)
		&& cmuxIdsEqual(request.container.sourceSurfaceId, source.sourceSurfaceId);
	return request.container.kind === "cmux-pane"
		? sameCmuxPane(request.container, candidate.container)
		: request.container.kind === "cmux-source-pane"
			&& cmuxIdsEqual(request.container.workspaceId, source.workspaceId)
			&& cmuxIdsEqual(request.container.sourceSurfaceId, source.sourceSurfaceId)
			&& cmuxIdsEqual(request.container.paneId, candidate.container.paneId);
}

function splitPlacement(layout: InteractivePaneLayout, source: CmuxSourceV2): CmuxPlacement {
	const container: CmuxSourceContainerV2 = {
		kind: "cmux-source", workspaceId: source.workspaceId, sourceSurfaceId: source.sourceSurfaceId,
	};
	return { layout, placement: "cmux-split", container };
}

function rootSurfacePlacement(pane: CmuxAllocatedContainerV2): CmuxPlacement {
	return { layout: "auto", placement: "cmux-new-surface", container: pane };
}

function nestedSurfacePlacement(sourcePane: CmuxSourcePaneContainerV2): CmuxPlacement {
	return { layout: "auto", placement: "cmux-new-surface", container: sourcePane };
}

/**
 * Process-local cmux placement coordinator. It has no backend commands or
 * durable authority: callers give it a committed broker allocation to adopt.
 */
export class InteractiveLayoutCoordinator {
	private readonly resolveCmuxSourcePane?: InteractiveLayoutCoordinatorOptions["resolveCmuxSourcePane"];
	private readonly validateCmuxPane: InteractiveLayoutCoordinatorOptions["validateCmuxPane"];
	private readonly states = new Map<string, SharedState>();
	private readonly locks = new Map<string, Promise<void>>();
	private readonly activeSurfaceIds = new Set<string>();
	private readonly released = new Set<number>();
	private readonly recovery = new Set<number>();
	private readonly releasesInFlight = new Map<number, Promise<void>>();
	private nextToken = 1;
	private nextLeaseId = 1;

	constructor(options: InteractiveLayoutCoordinatorOptions) {
		if (typeof options?.validateCmuxPane !== "function") {
			throw new Error("InteractiveLayoutCoordinator requires a cmux pane validator.");
		}
		this.resolveCmuxSourcePane = options.resolveCmuxSourcePane;
		this.validateCmuxPane = options.validateCmuxPane;
	}

	private async withRootLock<T>(rootKey: string, work: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(rootKey) ?? Promise.resolve();
		let unlock!: () => void;
		const current = new Promise<void>((resolve) => { unlock = resolve; });
		const tail = previous.then(() => current);
		this.locks.set(rootKey, tail);
		await previous;
		try {
			return await work();
		} finally {
			unlock();
			if (this.locks.get(rootKey) === tail) this.locks.delete(rootKey);
		}
	}

	/** Select, broker-allocate, validate, and adopt a cmux allocation atomically per root source. */
	async allocateCmux(options: CmuxLayoutAllocationOptions): Promise<CmuxLayoutLease> {
		assertCmuxSource(options.source, "cmux layout source");
		const rootSource = options.rootSource ?? options.source;
		assertCmuxSource(rootSource, "cmux layout root source");
		if (!Number.isSafeInteger(options.depth) || options.depth < 0) throw new Error("cmux layout depth must be a non-negative integer.");
		if (options.layout !== "auto" && options.layout !== "split") throw new Error("cmux layout must be exactly \"auto\" or \"split\".");
		if (!options.runId) throw new Error("cmux layout requires a non-empty run ID.");
		const rootKey = cmuxRootKey(rootSource);
		return await this.withRootLock(rootKey, async () => {
			let request: CmuxPlacement;
			let state: SharedState | undefined;
			if (options.layout === "split") {
				request = splitPlacement("split", options.source);
			} else if (options.depth > 0) {
				const sourcePane = await this.resolveCmuxSourcePane?.(options.source);
				if (!sourcePane || sourcePane.kind !== "cmux-source-pane"
					|| !cmuxIdsEqual(sourcePane.workspaceId, options.source.workspaceId)
					|| !cmuxIdsEqual(sourcePane.sourceSurfaceId, options.source.sourceSurfaceId)
					|| !isCanonicalCmuxId(sourcePane.paneId)) {
					throw new Error("Nested cmux auto layout requires an exact, valid source-pane resolver result.");
				}
				request = nestedSurfacePlacement(sourcePane);
			} else {
				state = this.states.get(rootKey);
				if (state) {
					let valid = false;
					try { valid = await this.validateCmuxPane(state.pane) === true; } catch { /* fail closed */ }
					if (!valid) {
						// A stale or unverifiable pane is never reused, even if old leases later release.
						this.states.delete(rootKey);
						state = undefined;
					}
				}
				request = state ? rootSurfacePlacement(state.pane) : splitPlacement("auto", options.source);
			}

			const allocation = await options.allocate(request);
			if (!validCmuxAllocation(allocation, request, options.source)) {
				throw new Error("Broker returned an uncommitted or mismatched cmux layout allocation; it was not adopted.");
			}
			const surfaceId = allocation.target.surfaceId.toLowerCase();
			if (this.activeSurfaceIds.has(surfaceId)) {
				throw new Error("Broker returned a cmux target surface already adopted by an active lease.");
			}

			const leaseId = this.nextLeaseId++;
			this.activeSurfaceIds.add(surfaceId);
			if (options.layout === "auto" && options.depth === 0) {
				if (!state) {
					state = { token: this.nextToken++, pane: allocation.container, active: new Set() };
					this.states.set(rootKey, state);
				}
				state.active.add(leaseId);
			}
			return { id: leaseId, rootKey, runId: options.runId, request, allocation };
		});
	}

	/**
	 * Idempotently close one exact allocation under the same root lock. Failed
	 * closes remain retryable recovery leases, while their pane is retired.
	 */
	releaseCmux(options: CmuxLayoutReleaseOptions): Promise<void> {
		const { lease } = options;
		if (this.released.has(lease.id)) return Promise.resolve();
		const inFlight = this.releasesInFlight.get(lease.id);
		if (inFlight) return inFlight;
		const release = this.withRootLock(lease.rootKey, async () => {
			if (this.released.has(lease.id)) return;
			try {
				if (!await options.close(lease.allocation)) {
					throw new Error(`Failed to close cmux layout allocation for run ${lease.runId}.`);
				}
			} catch (error) {
				this.recovery.add(lease.id);
				const state = this.states.get(lease.rootKey);
				// Retire only the state that owns this lease; a replacement state is safe.
				if (state?.active.has(lease.id)) this.states.delete(lease.rootKey);
				throw error;
			}
			this.recovery.delete(lease.id);
			this.released.add(lease.id);
			this.activeSurfaceIds.delete(lease.allocation.target.surfaceId.toLowerCase());
			const state = this.states.get(lease.rootKey);
			if (state?.active.delete(lease.id) && state.active.size === 0) this.states.delete(lease.rootKey);
		});
		this.releasesInFlight.set(lease.id, release);
		void release.then(
			() => { if (this.releasesInFlight.get(lease.id) === release) this.releasesInFlight.delete(lease.id); },
			() => { if (this.releasesInFlight.get(lease.id) === release) this.releasesInFlight.delete(lease.id); },
		);
		return release;
	}

	/** Test/diagnostic snapshot only; it exposes no command authority. */
	activeCmuxSurfaceCount(rootSource: CmuxSourceV2): number {
		assertCmuxSource(rootSource, "cmux layout root source");
		return this.states.get(cmuxRootKey(rootSource))?.active.size ?? 0;
	}
}

export interface TmuxLayoutPlacementOptions {
	layout: InteractivePaneLayout;
	source: TmuxSourceV2;
	/** Exact topology of source.sourcePaneId, obtained by the caller. */
	sourceTopology: TmuxSourcePaneContainerV2;
}

/** Stateless tmux policy selector; it never runs a backend command. */
export function selectTmuxInteractivePlacement(options: TmuxLayoutPlacementOptions): Extract<LayoutPlacementRequestV2, { placement: "tmux-split" | "tmux-new-window" }> {
	const { source, sourceTopology } = options;
	if ((options.layout !== "auto" && options.layout !== "split") || sourceTopology.kind !== "tmux-source-pane"
		|| (source.socketPath !== undefined && typeof source.socketPath !== "string")
		|| (sourceTopology.socketPath !== undefined && typeof sourceTopology.socketPath !== "string")
		|| !TMUX_PANE_ID_RE.test(source.sourcePaneId) || !Number.isSafeInteger(source.sourcePanePid) || source.sourcePanePid <= 0
		|| !Number.isSafeInteger(source.serverPid) || source.serverPid <= 0 || !TMUX_PANE_ID_RE.test(sourceTopology.paneId)
		|| !TMUX_SESSION_ID_RE.test(sourceTopology.sessionId) || !TMUX_WINDOW_ID_RE.test(sourceTopology.windowId)
		|| !Number.isSafeInteger(sourceTopology.serverPid) || sourceTopology.serverPid <= 0
		|| !Number.isSafeInteger(sourceTopology.panePid) || sourceTopology.panePid <= 0
		|| !source.generation || !sourceTopology.generation
		|| source.generation.socketPath !== sourceTopology.generation.socketPath
		|| source.generation.socketDev !== sourceTopology.generation.socketDev
		|| source.generation.socketIno !== sourceTopology.generation.socketIno
		|| source.generation.serverStartedAt !== sourceTopology.generation.serverStartedAt
		|| source.socketPath !== sourceTopology.socketPath || source.serverPid !== sourceTopology.serverPid
		|| source.sourcePaneId !== sourceTopology.paneId || source.sourcePanePid !== sourceTopology.panePid) {
		throw new Error("tmux layout requires exact source pane topology matching the inherited tmux identity.");
	}
	if (options.layout === "split") return { layout: "split", placement: "tmux-split", container: sourceTopology };
	return {
		layout: "auto",
		placement: "tmux-new-window",
		container: {
			kind: "tmux-session", socketPath: sourceTopology.socketPath, serverPid: sourceTopology.serverPid,
			sessionId: sourceTopology.sessionId, sourceWindowId: sourceTopology.windowId, generation: sourceTopology.generation,
		},
	};
}

/** Short alias for callers that do not need to distinguish the backend in their naming. */
export const selectTmuxLayoutPlacement = selectTmuxInteractivePlacement;
