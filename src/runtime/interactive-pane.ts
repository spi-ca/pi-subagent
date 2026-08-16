import type { TerminalMode } from "../core/types.js";
import {
	closeHerdrPane,
	createHerdrSplit,
	createHerdrTab,
	focusHerdrPane,
	inspectHerdrPane,
	inspectHerdrPaneForUx,
	interruptHerdrPane,
	parseHerdrEnvironment,
	type HerdrPaneHandle,
} from "./herdr.js";
import {
	closeCmuxSurface,
	isCanonicalCmuxId,
	createCmuxSplit,
	inspectCmuxSurface,
	interruptCmuxSurface,
	type CmuxSurfaceHandle,
} from "./cmux.js";
import {
	closeTmuxPane,
	createTmuxPane,
	inspectTmuxPaneFingerprint,
	inspectTmuxPaneFingerprintForUx,
	interruptTmuxPane,
	parseTmuxEnvironment,
	type TmuxPaneHandle,
} from "./tmux.js";

export type InteractivePaneMode = Extract<TerminalMode, "cmux-pane" | "tmux-pane" | "herdr-pane">;

export interface InteractivePanePlacementDiagnostics {
	layout: "auto" | "split";
	placement: "cmux-split" | "cmux-new-surface" | "tmux-split" | "tmux-new-window" | "herdr-split" | "herdr-new-tab";
}

export type InteractivePaneHandle =
	| { mode: "cmux-pane"; native: CmuxSurfaceHandle; placement?: InteractivePanePlacementDiagnostics }
	| { mode: "tmux-pane"; native: TmuxPaneHandle; placement?: InteractivePanePlacementDiagnostics }
	| { mode: "herdr-pane"; native: HerdrPaneHandle; placement?: InteractivePanePlacementDiagnostics };

export interface InteractivePaneSnapshot {
	exists: boolean;
	exited?: boolean;
	title?: string;
}

export interface InteractivePaneLaunchOptions {
	cwd: string;
	wrapperPath: string;
	/** Published by the durable allocation callback to release tmux's staged wrapper. */
	launchGatePath?: string;
	signal?: AbortSignal;
	/** Resolved policy; omitted direct callers retain the default auto layout. */
	layout?: "auto" | "split";
	/**
	 * Persist the exact backend allocation before any child wrapper can run.
	 * Backends must close that newly allocated target if this rejects.
	 */
	onAllocated?: (handle: InteractivePaneHandle) => Promise<void>;
}

export interface InteractivePaneBackend {
	readonly mode: InteractivePaneMode;
	availabilityError(env?: NodeJS.ProcessEnv): string | null;
	launch(options: InteractivePaneLaunchOptions): Promise<InteractivePaneHandle>;
	/** Lifecycle authority only; it never reads diagnostic pane titles. */
	inspect(handle: InteractivePaneHandle): Promise<InteractivePaneSnapshot | undefined>;
	/** Optional post-fingerprint diagnostic observation for interactive UX only. */
	inspectForUx?(handle: InteractivePaneHandle): Promise<InteractivePaneSnapshot | undefined>;
	interrupt(handle: InteractivePaneHandle): Promise<boolean>;
	close(handle: InteractivePaneHandle): Promise<boolean>;
	/** Optional exact-target user-requested focus; unsupported backends fail closed. */
	focus?(handle: InteractivePaneHandle): Promise<boolean>;
}

export const cmuxInteractivePaneBackend: InteractivePaneBackend = {
	mode: "cmux-pane",
	availabilityError(env = process.env) {
		if (process.platform === "win32") return "Interactive terminal pane backends are unavailable on Windows.";
		return isCanonicalCmuxId(env.CMUX_WORKSPACE_ID?.trim()) && isCanonicalCmuxId(env.CMUX_SURFACE_ID?.trim())
			? null
			: "cmux pane mode requires canonical CMUX_WORKSPACE_ID and CMUX_SURFACE_ID UUIDs.";
	},
	async launch(options) {
		const workspaceId = process.env.CMUX_WORKSPACE_ID?.trim();
		const sourceSurfaceId = process.env.CMUX_SURFACE_ID?.trim();
		if (!workspaceId || !sourceSurfaceId) throw new Error(this.availabilityError()!);
		return {
			mode: "cmux-pane",
			native: await createCmuxSplit({
			workspaceId,
			sourceSurfaceId,
			wrapperPath: options.wrapperPath,
			signal: options.signal,
			onAllocated: async (native) => await options.onAllocated?.({ mode: "cmux-pane", native }),
		}),
		};
	},
	async inspect(handle) {
		if (handle.mode !== "cmux-pane") throw new Error("cmux backend received a non-cmux handle.");
		return await inspectCmuxSurface(handle.native);
	},
	async interrupt(handle) {
		if (handle.mode !== "cmux-pane") return false;
		return await interruptCmuxSurface(handle.native);
	},
	async close(handle) {
		if (handle.mode !== "cmux-pane") return false;
		return await closeCmuxSurface(handle.native);
	},
};

export const herdrInteractivePaneBackend: InteractivePaneBackend = {
	mode: "herdr-pane",
	availabilityError(env = process.env) {
		if (process.platform === "win32") return "Interactive terminal pane backends are unavailable on Windows.";
		return parseHerdrEnvironment(env) ? null : "Herdr pane mode requires HERDR_ENV=1, an absolute HERDR_SOCKET_PATH, and exact workspace/tab/pane IDs.";
	},
	async launch(options) {
		const layout = options.layout ?? "auto";
		const create = layout === "auto" ? createHerdrTab : createHerdrSplit;
		return {
			mode: "herdr-pane",
			native: await create({
				cwd: options.cwd,
				wrapperPath: options.wrapperPath,
				signal: options.signal,
				onAllocated: async (native) => await options.onAllocated?.({ mode: "herdr-pane", native }),
			}),
			placement: { layout, placement: layout === "auto" ? "herdr-new-tab" : "herdr-split" },
		};
	},
	async inspect(handle) {
		return handle.mode === "herdr-pane" ? await inspectHerdrPane(handle.native) : undefined;
	},
	async inspectForUx(handle) {
		return handle.mode === "herdr-pane" ? await inspectHerdrPaneForUx(handle.native) : undefined;
	},
	async interrupt(handle) {
		return handle.mode === "herdr-pane" && await interruptHerdrPane(handle.native);
	},
	async close(handle) {
		return handle.mode === "herdr-pane" && await closeHerdrPane(handle.native);
	},
	async focus(handle) {
		return handle.mode === "herdr-pane" && await focusHerdrPane(handle.native);
	},
};

export const tmuxInteractivePaneBackend: InteractivePaneBackend = {
	mode: "tmux-pane",
	availabilityError(env = process.env) {
		if (process.platform === "win32") return "Interactive terminal pane backends are unavailable on Windows.";
		return parseTmuxEnvironment(env) ? null : "tmux pane mode requires TMUX and canonical TMUX_PANE.";
	},
	async launch(options) {
		const identity = parseTmuxEnvironment();
		if (!identity) throw new Error(this.availabilityError()!);
		return {
			mode: "tmux-pane",
			native: await createTmuxPane({
				sourcePaneId: identity.paneId,
				socketPath: identity.socketPath,
				serverPid: identity.serverPid,
				cwd: options.cwd,
				wrapperPath: options.wrapperPath,
				launchGatePath: options.launchGatePath,
				signal: options.signal,
				onAllocated: async (native) => await options.onAllocated?.({ mode: "tmux-pane", native }),
			}),
		};
	},
	async inspect(handle) {
		if (handle.mode !== "tmux-pane") throw new Error("tmux backend received a non-tmux handle.");
		const snapshot = await inspectTmuxPaneFingerprint(handle.native);
		return snapshot && { exists: snapshot.exists, exited: snapshot.dead };
	},
	async inspectForUx(handle) {
		if (handle.mode !== "tmux-pane") throw new Error("tmux backend received a non-tmux handle.");
		const snapshot = await inspectTmuxPaneFingerprintForUx(handle.native);
		return snapshot && { exists: snapshot.exists, exited: snapshot.dead, title: snapshot.title };
	},
	async interrupt(handle) {
		if (handle.mode !== "tmux-pane") return false;
		return await interruptTmuxPane(handle.native);
	},
	async close(handle) {
		if (handle.mode !== "tmux-pane") return false;
		return await closeTmuxPane(handle.native);
	},
};

export function getInteractivePaneBackend(mode: TerminalMode): InteractivePaneBackend | null {
	if (mode === "cmux-pane") return cmuxInteractivePaneBackend;
	if (mode === "tmux-pane") return tmuxInteractivePaneBackend;
	if (mode === "herdr-pane") return herdrInteractivePaneBackend;
	return null;
}
