import { spawn } from "node:child_process";

/** cmux 0.64.20 returns UUIDs and human refs together; refs are never authority. */
export const CMUX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isCanonicalCmuxId(value: unknown): value is string {
	return typeof value === "string" && CMUX_UUID_RE.test(value);
}

/** UUID spelling is presentation; authority identity is case-insensitive. */
export function cmuxIdsEqual(left: unknown, right: unknown): boolean {
	return isCanonicalCmuxId(left) && isCanonicalCmuxId(right) && left.toLowerCase() === right.toLowerCase();
}

export interface CmuxCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	aborted: boolean;
}

export type CmuxCommandRunner = (
	args: string[],
	options?: { signal?: AbortSignal },
) => Promise<CmuxCommandResult>;

export interface CmuxSurfaceHandle {
	workspaceId: string;
	workspaceRef?: string;
	paneId?: string;
	paneRef?: string;
	surfaceId: string;
	surfaceRef?: string;
}

export interface CmuxSurfaceSnapshot {
	exists: boolean;
	/** Present only when strict global topology resolves the exact surface. */
	workspaceId?: string;
	paneId?: string;
	surfaceId?: string;
	title?: string;
	type?: string;
}

export interface CmuxSurfaceIdentity {
	workspaceId: string;
	paneId: string;
	surfaceId: string;
}

export const CMUX_REQUIRED_SURFACE_CAPABILITIES = [
	"surface.create",
	"surface.close",
	"surface.send_key",
	"surface.respawn",
] as const;

export type CmuxRequiredSurfaceCapability = (typeof CMUX_REQUIRED_SURFACE_CAPABILITIES)[number];
export type CmuxSurfaceCapabilities = Record<CmuxRequiredSurfaceCapability, true>;
export const MIN_CMUX_LAYOUT_VERSION = [0, 64, 20] as const;

export interface CmuxLayoutPhase0Fixture {
	cmuxVersion: "0.64.20";
	newSplit: CmuxSurfaceIdentity;
	newSurface: CmuxSurfaceIdentity;
	lastSurfacePane: "removed" | "empty";
	capabilities: CmuxSurfaceCapabilities;
}

export const runCmuxCommand: CmuxCommandRunner = async (args, options = {}) => await new Promise((resolve) => {
	const proc = spawn("cmux", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	let settled = false;
	let aborted = false;
	let abortHandler: (() => void) | undefined;
	const finish = (exitCode: number) => {
		if (settled) return;
		settled = true;
		if (options.signal && abortHandler) options.signal.removeEventListener("abort", abortHandler);
		resolve({ exitCode, stdout, stderr, aborted });
	};
	proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
	proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
	proc.on("error", (error) => {
		if (!stderr.trim()) stderr = error.message;
		finish(1);
	});
	proc.on("close", (code) => finish(code ?? 0));
	if (options.signal) {
		abortHandler = () => {
			aborted = true;
			proc.kill("SIGTERM");
		};
		if (options.signal.aborted) abortHandler();
		else options.signal.addEventListener("abort", abortHandler, { once: true });
	}
});

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function own(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function createdResponseRecord(parsed: Record<string, unknown>): { record: Record<string, unknown>; nested: boolean } | null {
	if (!own(parsed, "result")) return { record: parsed, nested: false };
	const result = parsed.result;
	if (!result || typeof result !== "object" || Array.isArray(result)) return null;
	return { record: result as Record<string, unknown>, nested: true };
}

function parseCreatedCmuxSurfaceRecord(parsed: Record<string, unknown>): CmuxSurfaceHandle | null {
	const response = createdResponseRecord(parsed);
	if (!response) return null;
	const { record } = response;
	const workspaceId = stringField(record, "workspace_id");
	const paneId = stringField(record, "pane_id");
	const surfaceId = stringField(record, "surface_id");
	// cmux 0.64.20 allocation authority requires every canonical UUID directly
	// in the response. Refs and caller workspace fallbacks are never authority.
	if (!isCanonicalCmuxId(workspaceId) || !isCanonicalCmuxId(surfaceId) || !isCanonicalCmuxId(paneId)) return null;
	return {
		workspaceId,
		workspaceRef: stringField(record, "workspace_ref"),
		paneId,
		paneRef: stringField(record, "pane_ref"),
		surfaceId,
		surfaceRef: stringField(record, "surface_ref", "ref"),
	};
}

// The legacy second argument is retained for callers compiled against older
// adapters, but is intentionally ignored: response identity has no fallback.
export function parseCreatedCmuxSurface(stdout: string, _legacyWorkspaceId?: string): CmuxSurfaceHandle | null {
	const parsed = parseJsonObject(stdout);
	return parsed ? parseCreatedCmuxSurfaceRecord(parsed) : null;
}

type CmuxFixtureCreatedResponse =
	| { workspace_id: string; pane_id: string; surface_id: string }
	| { result: { workspace_id: string; pane_id: string; surface_id: string } };

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(record);
	return actual.length === keys.length && keys.every((key) => own(record, key));
}

function parseFixtureCreatedResponse(value: unknown): CmuxSurfaceIdentity | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const response = value as Record<string, unknown>;
	const record = hasExactKeys(response, ["result"])
		? response.result
		: hasExactKeys(response, ["workspace_id", "pane_id", "surface_id"])
			? response
			: null;
	if (!record || typeof record !== "object" || Array.isArray(record)) return null;
	const direct = record as Record<string, unknown>;
	if (!hasExactKeys(direct, ["workspace_id", "pane_id", "surface_id"])
		|| !isCanonicalCmuxId(direct.workspace_id) || !isCanonicalCmuxId(direct.pane_id) || !isCanonicalCmuxId(direct.surface_id)) return null;
	return { workspaceId: direct.workspace_id, paneId: direct.pane_id, surfaceId: direct.surface_id };
}

/** Removes refs and unknown fields while retaining whether cmux used a result envelope. */
export function sanitizeCreatedCmuxSurfaceResponse(stdout: string): CmuxFixtureCreatedResponse | null {
	const parsed = parseJsonObject(stdout);
	if (!parsed) return null;
	const response = createdResponseRecord(parsed);
	const handle = parseCreatedCmuxSurfaceRecord(parsed);
	if (!response || !handle) return null;
	const direct = { workspace_id: handle.workspaceId, pane_id: handle.paneId!, surface_id: handle.surfaceId };
	return response.nested ? { result: direct } : direct;
}

/** Validates the sanitized evidence promoted by the explicitly gated Phase 0 probe. */
export function parseCmuxLayoutPhase0Fixture(value: unknown): CmuxLayoutPhase0Fixture | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const fixtureKeys = ["schema_version", "cmux_version", "new_split_response", "new_surface_response", "last_surface_pane", "capabilities"];
	if (!hasExactKeys(record, fixtureKeys) || record.schema_version !== 1 || record.cmux_version !== "0.64.20") return null;
	const newSplit = parseFixtureCreatedResponse(record.new_split_response);
	const newSurface = parseFixtureCreatedResponse(record.new_surface_response);
	if (!newSplit || !newSurface || !cmuxIdsEqual(newSplit.workspaceId, newSurface.workspaceId)
		|| !cmuxIdsEqual(newSplit.paneId, newSurface.paneId)
		|| cmuxIdsEqual(newSplit.surfaceId, newSurface.surfaceId)) return null;
	if (record.last_surface_pane !== "removed" && record.last_surface_pane !== "empty") return null;
	if (!record.capabilities || typeof record.capabilities !== "object" || Array.isArray(record.capabilities)) return null;
	const capabilityRecord = record.capabilities as Record<string, unknown>;
	if (!hasExactKeys(capabilityRecord, CMUX_REQUIRED_SURFACE_CAPABILITIES)
		|| CMUX_REQUIRED_SURFACE_CAPABILITIES.some((name) => capabilityRecord[name] !== true)) return null;
	return {
		cmuxVersion: "0.64.20",
		newSplit,
		newSurface,
		lastSurfacePane: record.last_surface_pane,
		capabilities: Object.fromEntries(CMUX_REQUIRED_SURFACE_CAPABILITIES.map((name) => [name, true])) as CmuxSurfaceCapabilities,
	};
}

/**
 * Parses cmux's JSON capabilities response without accepting aliases, blank
 * method names, or duplicate entries. Extra advertised methods are allowed.
 */
export function isCmuxVersionAtLeast(rawVersion: string, minimum = MIN_CMUX_LAYOUT_VERSION): boolean {
	const match = rawVersion.trim().match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/);
	if (!match) return false;
	const actual = [Number(match[1]), Number(match[2]), Number(match[3])];
	for (let index = 0; index < minimum.length; index += 1) {
		if (actual[index]! > minimum[index]!) return true;
		if (actual[index]! < minimum[index]!) return false;
	}
	return true;
}

/** Fail closed unless the exact backend supports layout allocation commands. */
export async function assertCmuxLayoutSupport(run: CmuxCommandRunner): Promise<void> {
	const version = await run(["--version"]);
	if (version.exitCode !== 0 || !isCmuxVersionAtLeast(version.stdout || version.stderr)) {
		throw new Error(`cmux auto pane layout requires cmux >= ${MIN_CMUX_LAYOUT_VERSION.join(".")}; use --subagent-pane-layout=split or upgrade cmux.`);
	}
	const capabilities = await run(["--json", "capabilities"]);
	if (capabilities.exitCode !== 0 || !parseCmuxCapabilities(capabilities.stdout)) {
		throw new Error("cmux auto pane layout requires surface.create, surface.close, surface.send_key, and surface.respawn capabilities; use --subagent-pane-layout=split or upgrade cmux.");
	}
}

export function parseCmuxCapabilities(stdout: string): CmuxSurfaceCapabilities | null {
	const parsed = parseJsonObject(stdout);
	if (!parsed || !Array.isArray(parsed.methods)) return null;
	const methods = new Set<string>();
	for (const method of parsed.methods) {
		if (typeof method !== "string" || !method || method.trim() !== method || methods.has(method)) return null;
		methods.add(method);
	}
	if (CMUX_REQUIRED_SURFACE_CAPABILITIES.some((name) => !methods.has(name))) return null;
	return Object.fromEntries(CMUX_REQUIRED_SURFACE_CAPABILITIES.map((name) => [name, true])) as CmuxSurfaceCapabilities;
}

/**
 * The full topology is required for strict identity authority checks. The
 * legacy workspace parameter is intentionally ignored: filtering it would
 * make a surface moved to another workspace look absent.
 */
export function buildCmuxFullTreeArgs(_workspaceId?: string): string[] {
	return ["--json", "--id-format", "both", "tree", "--all"];
}

export function buildCmuxNewSplitArgs(options: {
	workspaceId: string;
	sourceSurfaceId: string;
	direction?: "left" | "right" | "up" | "down";
}): string[] {
	return [
		"--json",
		"--id-format",
		"both",
		"new-split",
		options.direction ?? "right",
		"--workspace",
		options.workspaceId,
		"--surface",
		options.sourceSurfaceId,
		"--focus",
		"false",
	];
}

/** Build the unfocused terminal-surface allocation command for one known pane. */
export function buildCmuxNewSurfaceArgs(options: {
	workspaceId: string;
	paneId: string;
	cwd: string;
}): string[] {
	return [
		"--json",
		"--id-format",
		"both",
		"new-surface",
		"--type",
		"terminal",
		"--workspace",
		options.workspaceId,
		"--pane",
		options.paneId,
		"--working-directory",
		options.cwd,
		"--focus",
		"false",
	];
}

function shellQuote(value: string): string {
	// A shell command is unavoidable for cmux's --command API. Keep the
	// wrapper path as one POSIX single-quoted word; embedded quotes are the
	// standard close/quoted-quote/reopen marker and never become syntax.
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Respawn only after the parent has durably committed and gated the allocation.
 * cmux's initial `new-split` shell is an unavoidable backend residual: it gets
 * no run authority, task, wrapper, secret path, or child command.  The new
 * pane supplies its own dynamic workspace/surface identity to this command.
 */
export function buildCmuxRespawnPaneArgs(workspaceId: string, surfaceId: string, wrapperPath: string): string[] {
	// Do not put socket capability, socket path, or bundled CLI authority in
	// cmux argv. The wrapper clears inherited state and then reads those values
	// from its private 0600 secret environment script.
	return [
		"respawn-pane", "--workspace", workspaceId, "--surface", surfaceId, "--command",
		`exec /usr/bin/env -u BASH_ENV -u ENV -u NODE_OPTIONS -u NODE_PATH -u BUN_OPTIONS -u LD_PRELOAD -u LD_LIBRARY_PATH -u LD_AUDIT -u DYLD_INSERT_LIBRARIES -u DYLD_LIBRARY_PATH -u DYLD_FRAMEWORK_PATH /bin/bash ${shellQuote(wrapperPath)}`,
	];
}

async function rollbackCanonicalCreatedCmuxSplit(
	run: CmuxCommandRunner,
	handle: CmuxSurfaceHandle,
	requestedWorkspaceId: string,
	sourceSurfaceId: string,
): Promise<void> {
	// The split response is not cleanup authority unless every identity is
	// canonical, it names the requested immutable workspace, and it cannot be
	// the caller's source surface. Refs and fallback workspace guesses never
	// reach a mutating command.
	if (!isCanonicalCmuxId(requestedWorkspaceId) || !isCanonicalCmuxId(sourceSurfaceId)
		|| !isCanonicalCmuxId(handle.workspaceId) || !isCanonicalCmuxId(handle.surfaceId)
		|| !cmuxIdsEqual(handle.workspaceId, requestedWorkspaceId) || cmuxIdsEqual(handle.surfaceId, sourceSurfaceId)) return;
	await run(["close-surface", "--workspace", handle.workspaceId, "--surface", handle.surfaceId]).catch(() => undefined);
}

async function rollbackCanonicalCreatedCmuxSurface(
	run: CmuxCommandRunner,
	handle: CmuxSurfaceHandle,
	requestedWorkspaceId: string,
	requestedPaneId: string,
	sourceSurfaceId?: string,
): Promise<void> {
	// A new-surface rollback is allowed to close only the directly returned
	// surface. It never targets a pane, a sibling, or a caller-provided source.
	if (!isCanonicalCmuxId(requestedWorkspaceId) || !isCanonicalCmuxId(requestedPaneId)
		|| !isCanonicalCmuxId(handle.workspaceId) || !isCanonicalCmuxId(handle.paneId) || !isCanonicalCmuxId(handle.surfaceId)
		|| !cmuxIdsEqual(handle.workspaceId, requestedWorkspaceId) || !cmuxIdsEqual(handle.paneId, requestedPaneId)
		|| cmuxIdsEqual(handle.surfaceId, handle.workspaceId) || cmuxIdsEqual(handle.surfaceId, handle.paneId)
		|| (sourceSurfaceId !== undefined && (!isCanonicalCmuxId(sourceSurfaceId) || cmuxIdsEqual(handle.surfaceId, sourceSurfaceId)))) return;
	await run(["close-surface", "--workspace", handle.workspaceId, "--surface", handle.surfaceId]).catch(() => undefined);
}

export async function createCmuxSplit(options: {
	workspaceId: string;
	sourceSurfaceId: string;
	wrapperPath: string;
	signal?: AbortSignal;
	onAllocated?: (handle: CmuxSurfaceHandle) => Promise<void>;
	run?: CmuxCommandRunner;
}): Promise<CmuxSurfaceHandle> {
	const run = options.run ?? runCmuxCommand;
	if (!isCanonicalCmuxId(options.workspaceId) || !isCanonicalCmuxId(options.sourceSurfaceId)) {
		throw new Error("cmux split requires canonical requested workspace and source surface IDs.");
	}
	if (options.signal?.aborted) throw new Error("cmux split creation was aborted.");
	// Do not abort this command after it starts: cmux may create the surface before
	// its response arrives, and we need that response to clean up the allocation.
	const created = await run(buildCmuxNewSplitArgs(options));
	const handle = parseCreatedCmuxSurface(created.stdout);
	const exact = handle && cmuxIdsEqual(handle.workspaceId, options.workspaceId)
		&& !cmuxIdsEqual(handle.surfaceId, options.sourceSurfaceId);
	// An exact response remains durable-publication and cleanup authority even
	// when cmux reports interrupted delivery or a nonzero status. Publish it
	// before handling that status so the parent can reconcile the allocation.
	if (exact) {
		try {
			await options.onAllocated?.(handle);
		} catch (error) {
			await rollbackCanonicalCreatedCmuxSplit(run, handle, options.workspaceId, options.sourceSurfaceId);
			throw error;
		}
	}
	if (created.aborted || options.signal?.aborted) {
		if (exact) await rollbackCanonicalCreatedCmuxSplit(run, handle, options.workspaceId, options.sourceSurfaceId);
		throw new Error("cmux split creation was aborted.");
	}
	if (created.exitCode !== 0) {
		if (exact) await rollbackCanonicalCreatedCmuxSplit(run, handle, options.workspaceId, options.sourceSurfaceId);
		throw new Error(created.stderr.trim() || created.stdout.trim() || "Failed to create cmux split.");
	}
	if (!exact) {
		if (handle && cmuxIdsEqual(handle.workspaceId, options.workspaceId)
			&& cmuxIdsEqual(handle.surfaceId, options.sourceSurfaceId)) {
			throw new Error("cmux split allocation reused the source surface.");
		}
		throw new Error(`Failed to parse an exact canonical cmux split response: ${created.stdout.trim() || "(empty)"}`);
	}
	const respawned = await run(buildCmuxRespawnPaneArgs(handle.workspaceId, handle.surfaceId, options.wrapperPath), { signal: options.signal });
	if (respawned.aborted || options.signal?.aborted || respawned.exitCode !== 0) {
		await rollbackCanonicalCreatedCmuxSplit(run, handle, options.workspaceId, options.sourceSurfaceId);
		if (respawned.aborted || options.signal?.aborted) throw new Error("cmux command delivery was aborted.");
		throw new Error(respawned.stderr.trim() || respawned.stdout.trim() || "Failed to start subagent in cmux surface.");
	}
	return handle;
}

/**
 * Allocates an unfocused terminal surface in an exact existing pane. As with a
 * split, the callback is the durable publication point and runs before the
 * surface receives wrapper authority through respawn.
 */
export async function createCmuxSurface(options: {
	workspaceId: string;
	paneId: string;
	cwd: string;
	wrapperPath: string;
	/** When supplied, the allocation must not reuse this immutable source. */
	sourceSurfaceId?: string;
	signal?: AbortSignal;
	onAllocated?: (handle: CmuxSurfaceHandle) => Promise<void>;
	run?: CmuxCommandRunner;
}): Promise<CmuxSurfaceHandle> {
	const run = options.run ?? runCmuxCommand;
	if (!isCanonicalCmuxId(options.workspaceId) || !isCanonicalCmuxId(options.paneId)
		|| cmuxIdsEqual(options.workspaceId, options.paneId)
		|| (options.sourceSurfaceId !== undefined && (!isCanonicalCmuxId(options.sourceSurfaceId)
			|| cmuxIdsEqual(options.sourceSurfaceId, options.workspaceId) || cmuxIdsEqual(options.sourceSurfaceId, options.paneId)))) {
		throw new Error("cmux surface requires canonical requested workspace, pane, and optional source surface IDs.");
	}
	if (options.signal?.aborted) throw new Error("cmux surface creation was aborted.");
	// Do not abort after dispatch: a response is needed to establish the exact
	// allocation authority required for any cleanup.
	const created = await run(buildCmuxNewSurfaceArgs(options));
	const handle = parseCreatedCmuxSurface(created.stdout);
	const exact = handle && cmuxIdsEqual(handle.workspaceId, options.workspaceId)
		&& cmuxIdsEqual(handle.paneId, options.paneId)
		&& !cmuxIdsEqual(handle.surfaceId, handle.workspaceId)
		&& !cmuxIdsEqual(handle.surfaceId, handle.paneId)
		&& (options.sourceSurfaceId === undefined || !cmuxIdsEqual(handle.surfaceId, options.sourceSurfaceId));
	// An exact response remains durable-publication and cleanup authority even
	// when cmux reports interrupted delivery or a nonzero status. Publish it
	// before handling that status so the parent can reconcile the allocation.
	if (exact) {
		try {
			await options.onAllocated?.(handle);
		} catch (error) {
			await rollbackCanonicalCreatedCmuxSurface(run, handle, options.workspaceId, options.paneId, options.sourceSurfaceId);
			throw error;
		}
	}
	if (created.aborted || options.signal?.aborted) {
		if (exact) await rollbackCanonicalCreatedCmuxSurface(run, handle, options.workspaceId, options.paneId, options.sourceSurfaceId);
		throw new Error("cmux surface creation was aborted.");
	}
	if (created.exitCode !== 0) {
		if (exact) await rollbackCanonicalCreatedCmuxSurface(run, handle, options.workspaceId, options.paneId, options.sourceSurfaceId);
		throw new Error(created.stderr.trim() || created.stdout.trim() || "Failed to create cmux surface.");
	}
	if (!exact) {
		throw new Error(`Failed to parse an exact canonical cmux surface response: ${created.stdout.trim() || "(empty)"}`);
	}
	const respawned = await run(buildCmuxRespawnPaneArgs(handle.workspaceId, handle.surfaceId, options.wrapperPath), { signal: options.signal });
	if (respawned.aborted || options.signal?.aborted || respawned.exitCode !== 0) {
		await rollbackCanonicalCreatedCmuxSurface(run, handle, options.workspaceId, options.paneId, options.sourceSurfaceId);
		if (respawned.aborted || options.signal?.aborted) throw new Error("cmux command delivery was aborted.");
		throw new Error(respawned.stderr.trim() || respawned.stdout.trim() || "Failed to start subagent in cmux surface.");
	}
	return handle;
}

/**
 * Resolves a source surface only when the entire supplied cmux tree has a
 * canonical, globally unique identity graph. This deliberately treats a stale
 * source, an ambiguous duplicate, and malformed unrelated topology alike:
 * none is allocation authority.
 */
/** Proves a canonical pane exists in the requested workspace's complete tree. */
export function canonicalCmuxPaneExists(
	stdout: string,
	workspaceId: string,
	paneId: string,
): boolean {
	const tree = parseJsonObject(stdout);
	if (!tree || !isCanonicalCmuxId(workspaceId) || !isCanonicalCmuxId(paneId) || !Array.isArray(tree.windows)) return false;
	const identities = new Set<string>();
	let found = false;
	for (const window of tree.windows) {
		if (!window || typeof window !== "object" || Array.isArray(window) || !Array.isArray((window as Record<string, unknown>).workspaces)) return false;
		for (const workspace of (window as Record<string, unknown>).workspaces as unknown[]) {
			if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return false;
			const workspaceRecord = workspace as Record<string, unknown>;
			if (!isCanonicalCmuxId(workspaceRecord.id) || !Array.isArray(workspaceRecord.panes)) return false;
			const workspaceKey = workspaceRecord.id.toLowerCase();
			if (identities.has(workspaceKey)) return false;
			identities.add(workspaceKey);
			for (const pane of workspaceRecord.panes) {
				if (!pane || typeof pane !== "object" || Array.isArray(pane)) return false;
				const paneRecord = pane as Record<string, unknown>;
				if (!isCanonicalCmuxId(paneRecord.id) || !Array.isArray(paneRecord.surfaces)) return false;
				const paneKey = paneRecord.id.toLowerCase();
				if (identities.has(paneKey)) return false;
				identities.add(paneKey);
				if (cmuxIdsEqual(workspaceRecord.id, workspaceId) && cmuxIdsEqual(paneRecord.id, paneId)) found = true;
				for (const surface of paneRecord.surfaces) {
					if (!surface || typeof surface !== "object" || Array.isArray(surface)) return false;
					const surfaceRecord = surface as Record<string, unknown>;
					if (!isCanonicalCmuxId(surfaceRecord.id) || !cmuxIdsEqual(surfaceRecord.pane_id, paneRecord.id)) return false;
					const surfaceKey = surfaceRecord.id.toLowerCase();
					if (identities.has(surfaceKey)) return false;
					identities.add(surfaceKey);
				}
			}
		}
	}
	return found;
}

export function resolveCanonicalCmuxSurfacePane(
	stdout: string,
	workspaceId: string,
	surfaceId: string,
): CmuxSurfaceIdentity | undefined {
	const tree = parseJsonObject(stdout);
	if (!tree || !isCanonicalCmuxId(workspaceId) || !isCanonicalCmuxId(surfaceId)
		|| cmuxIdsEqual(workspaceId, surfaceId) || !Array.isArray(tree.windows)) return undefined;
	const identities = new Set<string>();
	let resolved: CmuxSurfaceIdentity | undefined;
	for (const window of tree.windows) {
		if (!window || typeof window !== "object" || Array.isArray(window)) return undefined;
		const workspaces = (window as Record<string, unknown>).workspaces;
		if (!Array.isArray(workspaces)) return undefined;
		for (const workspace of workspaces) {
			if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return undefined;
			const workspaceRecord = workspace as Record<string, unknown>;
			const canonicalWorkspaceId = workspaceRecord.id;
			if (!isCanonicalCmuxId(canonicalWorkspaceId) || !Array.isArray(workspaceRecord.panes)) return undefined;
			const workspaceKey = canonicalWorkspaceId.toLowerCase();
			if (identities.has(workspaceKey)) return undefined;
			identities.add(workspaceKey);
			for (const pane of workspaceRecord.panes) {
				if (!pane || typeof pane !== "object" || Array.isArray(pane)) return undefined;
				const paneRecord = pane as Record<string, unknown>;
				const canonicalPaneId = paneRecord.id;
				if (!isCanonicalCmuxId(canonicalPaneId) || !Array.isArray(paneRecord.surfaces)) return undefined;
				const paneKey = canonicalPaneId.toLowerCase();
				if (identities.has(paneKey)) return undefined;
				identities.add(paneKey);
				for (const surface of paneRecord.surfaces) {
					if (!surface || typeof surface !== "object" || Array.isArray(surface)) return undefined;
					const surfaceRecord = surface as Record<string, unknown>;
					const canonicalSurfaceId = surfaceRecord.id;
					if (!isCanonicalCmuxId(canonicalSurfaceId) || !cmuxIdsEqual(surfaceRecord.pane_id, canonicalPaneId)) return undefined;
					const surfaceKey = canonicalSurfaceId.toLowerCase();
					if (identities.has(surfaceKey)) return undefined;
					identities.add(surfaceKey);
					if (cmuxIdsEqual(canonicalWorkspaceId, workspaceId) && cmuxIdsEqual(canonicalSurfaceId, surfaceId)) {
						if (resolved) return undefined;
						resolved = { workspaceId: canonicalWorkspaceId, paneId: canonicalPaneId, surfaceId: canonicalSurfaceId };
					}
				}
			}
		}
	}
	return resolved;
}

function canonicalTopologySurface(
	tree: Record<string, unknown>,
	workspaceId: string,
	surfaceId: string,
): CmuxSurfaceSnapshot | undefined {
	// cmux 0.64.20's tree contract is deliberately narrow. Do not recursively
	// search arbitrary JSON: an id under an error payload or unrelated object is
	// not proof that the requested surface is gone. A lifecycle handle's stored
	// workspace validates its provenance, but does not constrain this lookup:
	// cmux can move a surface between workspaces.
	if (!isCanonicalCmuxId(workspaceId) || !isCanonicalCmuxId(surfaceId)
		|| cmuxIdsEqual(workspaceId, surfaceId) || !Array.isArray(tree.windows)) return undefined;
	const identities = new Set<string>();
	let target: { workspaceId: string; paneId: string; surfaceId: string; record: Record<string, unknown> } | undefined;
	let targetAppearsAsContainer = false;
	const addIdentity = (id: string): boolean => {
		const key = id.toLowerCase();
		if (identities.has(key)) return false;
		identities.add(key);
		return true;
	};
	for (const window of tree.windows) {
		if (!window || typeof window !== "object" || Array.isArray(window)) return undefined;
		const workspaces = (window as Record<string, unknown>).workspaces;
		if (!Array.isArray(workspaces)) return undefined;
		for (const workspace of workspaces) {
			if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return undefined;
			const workspaceRecord = workspace as Record<string, unknown>;
			const canonicalWorkspaceId = workspaceRecord.id;
			if (!isCanonicalCmuxId(canonicalWorkspaceId) || !Array.isArray(workspaceRecord.panes)
				|| !addIdentity(canonicalWorkspaceId)) return undefined;
			if (cmuxIdsEqual(canonicalWorkspaceId, surfaceId)) targetAppearsAsContainer = true;
			for (const pane of workspaceRecord.panes) {
				if (!pane || typeof pane !== "object" || Array.isArray(pane)) return undefined;
				const paneRecord = pane as Record<string, unknown>;
				const canonicalPaneId = paneRecord.id;
				if (!isCanonicalCmuxId(canonicalPaneId) || !Array.isArray(paneRecord.surfaces)
					|| !addIdentity(canonicalPaneId)) return undefined;
				if (cmuxIdsEqual(canonicalPaneId, surfaceId)) targetAppearsAsContainer = true;
				for (const surface of paneRecord.surfaces) {
					if (!surface || typeof surface !== "object" || Array.isArray(surface)) return undefined;
					const surfaceRecord = surface as Record<string, unknown>;
					const canonicalSurfaceId = surfaceRecord.id;
					if (!isCanonicalCmuxId(canonicalSurfaceId) || !cmuxIdsEqual(surfaceRecord.pane_id, canonicalPaneId)
						|| !addIdentity(canonicalSurfaceId)) return undefined;
					if (cmuxIdsEqual(canonicalSurfaceId, surfaceId)) {
						target = {
							workspaceId: canonicalWorkspaceId,
							paneId: canonicalPaneId,
							surfaceId: canonicalSurfaceId,
							record: surfaceRecord,
						};
					}
				}
			}
		}
	}
	// A requested surface UUID presented as a workspace or pane is a cross-type
	// identity conflict, not evidence that the surface was removed.
	if (targetAppearsAsContainer) return undefined;
	if (!target) return { exists: false };
	return {
		exists: true,
		workspaceId: target.workspaceId,
		paneId: target.paneId,
		surfaceId: target.surfaceId,
		title: stringField(target.record, "title"),
		type: stringField(target.record, "type", "surface_type"),
	};
}

/**
 * Resolves one exact surface from a complete, globally unique canonical tree.
 * The workspace argument validates the handle but does not filter the result.
 */
export function inspectCanonicalCmuxSurfaceTree(stdout: string, workspaceId: string, surfaceId: string): CmuxSurfaceSnapshot | undefined {
	const tree = parseJsonObject(stdout);
	return tree ? canonicalTopologySurface(tree, workspaceId, surfaceId) : undefined;
}

export async function inspectCmuxSurface(
	handle: CmuxSurfaceHandle,
	run: CmuxCommandRunner = runCmuxCommand,
): Promise<CmuxSurfaceSnapshot | undefined> {
	if (!isCanonicalCmuxId(handle.workspaceId) || !isCanonicalCmuxId(handle.surfaceId)
		|| cmuxIdsEqual(handle.workspaceId, handle.surfaceId)) return undefined;
	const response = await run(buildCmuxFullTreeArgs(handle.workspaceId));
	if (response.exitCode !== 0) return undefined;
	return inspectCanonicalCmuxSurfaceTree(response.stdout, handle.workspaceId, handle.surfaceId);
}

async function resolveCmuxSurfaceForMutation(
	handle: CmuxSurfaceHandle,
	run: CmuxCommandRunner,
): Promise<CmuxSurfaceSnapshot | undefined> {
	const snapshot = await inspectCmuxSurface(handle, run);
	return snapshot?.exists && isCanonicalCmuxId(snapshot.workspaceId)
		&& isCanonicalCmuxId(snapshot.paneId) && isCanonicalCmuxId(snapshot.surfaceId)
		? snapshot
		: undefined;
}

export async function interruptCmuxSurface(
	handle: CmuxSurfaceHandle,
	run: CmuxCommandRunner = runCmuxCommand,
): Promise<boolean> {
	const resolved = await resolveCmuxSurfaceForMutation(handle, run);
	if (!resolved) return false;
	const response = await run(["send-key", "--workspace", resolved.workspaceId!, "--surface", resolved.surfaceId!, "escape"]);
	return response.exitCode === 0;
}

export async function closeCmuxSurface(
	handle: CmuxSurfaceHandle,
	run: CmuxCommandRunner = runCmuxCommand,
): Promise<boolean> {
	const resolved = await resolveCmuxSurfaceForMutation(handle, run);
	if (!resolved) return false;
	const response = await run(["close-surface", "--workspace", resolved.workspaceId!, "--surface", resolved.surfaceId!]);
	return response.exitCode === 0;
}
