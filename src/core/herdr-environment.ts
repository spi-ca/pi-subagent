import * as path from "node:path";

/** macOS has a 104-byte Unix-domain socket pathname buffer, including NUL. */
export const HERDR_MAX_SOCKET_PATH_BYTES = 103;
export const HERDR_MAX_PUBLIC_ID_BYTES = 256;

export interface HerdrEnvironmentIdentity {
	socketPath: string;
	workspaceId: string;
	tabId: string;
	paneId: string;
}

function isHerdrUnixPlatform(platform: NodeJS.Platform): boolean {
	return platform === "linux" || platform === "darwin";
}

/** IDs remain opaque, but must be bounded printable protocol values. */
export function isHerdrPublicId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0
		&& Buffer.byteLength(value, "utf8") <= HERDR_MAX_PUBLIC_ID_BYTES
		&& !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/** A portable Linux/macOS Unix-domain socket pathname. */
export function isHerdrSocketPath(value: unknown): value is string {
	return typeof value === "string" && !value.includes("\0")
		&& Buffer.byteLength(value, "utf8") <= HERDR_MAX_SOCKET_PATH_BYTES
		&& path.posix.isAbsolute(value) && path.posix.normalize(value) === value;
}

/** Shared Herdr environment authority parser for selection and runtime validation. */
export function parseHerdrEnvironment(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): HerdrEnvironmentIdentity | null {
	if (!isHerdrUnixPlatform(platform) || env.HERDR_ENV !== "1") return null;
	const { HERDR_SOCKET_PATH: socketPath, HERDR_WORKSPACE_ID: workspaceId, HERDR_TAB_ID: tabId, HERDR_PANE_ID: paneId } = env;
	return isHerdrSocketPath(socketPath) && isHerdrPublicId(workspaceId) && isHerdrPublicId(tabId) && isHerdrPublicId(paneId)
		? { socketPath, workspaceId, tabId, paneId } : null;
}
