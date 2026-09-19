import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export const DEFAULT_TOOL_DISPLAY_PREVIEW_LINES = 8;
export const MIN_TOOL_DISPLAY_PREVIEW_LINES = 1;
export const MAX_TOOL_DISPLAY_PREVIEW_LINES = 80;
/** A tool-display config only needs one number; cap its untrusted JSON input. */
export const MAX_TOOL_DISPLAY_CONFIG_BYTES = 16 * 1024;

export function getToolDisplayConfigPath(options: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  const configuredAgentDir = (options.env ?? process.env).PI_CODING_AGENT_DIR;
  const home = options.home ?? homedir();
  // Mirror pi-tool-display: only a falsy value selects the default. Whitespace
  // remains a literal configured path, while ~, ~/…, and ~\… expand from home.
  const agentDir = !configuredAgentDir
    ? path.join(home, ".pi", "agent")
    : configuredAgentDir === "~"
      ? home
      : configuredAgentDir.startsWith("~/") || configuredAgentDir.startsWith("~\\")
        ? path.join(home, configuredAgentDir.slice(2))
        : configuredAgentDir;
  return path.join(agentDir, "extensions", "pi-tool-display", "config.json");
}

/** Matches pi-tool-display's finite-number, integer-floor, and 1–80 clamp semantics. */
export function normalizeToolDisplayPreviewLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TOOL_DISPLAY_PREVIEW_LINES;
  return Math.min(MAX_TOOL_DISPLAY_PREVIEW_LINES, Math.max(MIN_TOOL_DISPLAY_PREVIEW_LINES, Math.floor(value)));
}

async function readBoundedRegularFile(filePath: string): Promise<string | null> {
  let initialStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    initialStat = await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!initialStat.isFile() || initialStat.isSymbolicLink() || initialStat.size > MAX_TOOL_DISPLAY_CONFIG_BYTES) {
    throw new Error("must be a bounded regular non-symlink file");
  }

  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.dev !== initialStat.dev || openedStat.ino !== initialStat.ino) {
      throw new Error("changed while being opened or is not a regular file");
    }
    const buffer = Buffer.alloc(MAX_TOOL_DISPLAY_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TOOL_DISPLAY_CONFIG_BYTES) throw new Error("exceeds byte limit");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Reads only the global pi-tool-display preview budget; malformed or unsafe files retain the default. */
export async function loadToolDisplayPreviewLines(options: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}): Promise<number> {
  const configPath = options.configPath ?? getToolDisplayConfigPath(options);
  try {
    const text = await readBoundedRegularFile(configPath);
    if (text === null) return DEFAULT_TOOL_DISPLAY_PREVIEW_LINES;
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return DEFAULT_TOOL_DISPLAY_PREVIEW_LINES;
    return normalizeToolDisplayPreviewLines((parsed as { previewLines?: unknown }).previewLines);
  } catch {
    return DEFAULT_TOOL_DISPLAY_PREVIEW_LINES;
  }
}
