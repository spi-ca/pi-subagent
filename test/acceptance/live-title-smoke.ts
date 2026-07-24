import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildCmuxRespawnPaneArgs,
  inspectCanonicalCmuxSurfaceTree,
  isCanonicalCmuxId,
  parseCreatedCmuxSurface,
} from "../../src/runtime/cmux.js";
import { buildInteractivePaneWrapperScript } from "../../src/runtime/runner.js";

export const LIVE_TITLE_GATE = "PI_SUBAGENT_LIVE_TITLE_SMOKE";
export type LiveTitleMode = "tmux" | "cmux";
export interface LiveTitleOptions { mode: LiveTitleMode; dryRun: boolean; }
interface CommandResult { code: number; stdout: string; stderr: string; }

export function parseLiveTitleArgs(argv: string[]): LiveTitleOptions {
  if (argv.length < 1 || argv.length > 2 || (argv[0] !== "tmux" && argv[0] !== "cmux")
    || (argv.length === 2 && argv[1] !== "--dry-run")) {
    throw new Error("usage: live-title-smoke.ts <tmux|cmux> [--dry-run]");
  }
  return { mode: argv[0], dryRun: argv[1] === "--dry-run" };
}

export function requireLiveTitleGate(env: NodeJS.ProcessEnv = process.env): void {
  if (env[LIVE_TITLE_GATE] !== "1") throw new Error(`${LIVE_TITLE_GATE}=1 is required for live title mutation.`);
}

async function run(bin: string, args: string[], timeoutMs = 10_000): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill("SIGKILL"); reject(new Error(`command timed out: ${bin}`)); } }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.once("close", (code) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); } });
  });
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function privateRoot(prefix: string): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.promises.chmod(root, 0o700);
  return root;
}

async function writeWrapper(root: string, initialTitle: string, dynamicTitle: string): Promise<string> {
  const wrapper = path.join(root, "title-wrapper.sh");
  const script = buildInteractivePaneWrapperScript({
    effectiveCwd: root,
    childCommand: ["/bin/bash", "-c", `printf '\\033]2;%s\\007' ${JSON.stringify(dynamicTitle)}; /bin/sleep 8`],
    exportedEnv: { PATH: "/usr/bin:/bin" },
    wrapperStatusPath: path.join(root, "wrapper-status"),
    surfaceTitle: initialTitle,
  });
  await fs.promises.writeFile(wrapper, script, { mode: 0o700 });
  await fs.promises.chmod(wrapper, 0o700);
  return wrapper;
}

async function tmuxTitleSmoke(): Promise<Record<string, unknown>> {
  const tmux = process.env.TMUX_BIN?.trim() || "tmux";
  const root = await privateRoot("pi-subagent-title-tmux-");
  const socket = path.join(root, "tmux.sock");
  const session = `pi-subagent-title-${crypto.randomUUID()}`;
  const initialTitle = "subagent:title-smoke:initial";
  const dynamicTitle = "subagent:title-smoke:running";
  let targetPane: string | null = null;
  try {
    const wrapper = await writeWrapper(root, initialTitle, dynamicTitle);
    const created = await run(tmux, ["-S", socket, "new-session", "-d", "-s", session, "-P", "-F", "#{pane_id}", "/bin/sleep", "30"]);
    if (created.code !== 0 || !/^%\d+$/.test(created.stdout.trim())) throw new Error(created.stderr || "tmux source creation failed");
    const sourcePane = created.stdout.trim();
    const sentinel = await run(tmux, ["-S", socket, "split-window", "-d", "-t", sourcePane, "-P", "-F", "#{pane_id}", "/bin/sleep", "30"]);
    const sentinelPane = sentinel.stdout.trim();
    if (sentinel.code !== 0 || !/^%\d+$/.test(sentinelPane) || sentinelPane === sourcePane) throw new Error("tmux sentinel creation failed");
    const target = await run(tmux, ["-S", socket, "split-window", "-d", "-t", sourcePane, "-P", "-F", "#{pane_id}", wrapper]);
    targetPane = target.stdout.trim();
    if (target.code !== 0 || !/^%\d+$/.test(targetPane) || [sourcePane, sentinelPane].includes(targetPane)) throw new Error("tmux title target creation failed");
    const title = async () => (await run(tmux, ["-S", socket, "display-message", "-p", "-t", targetPane!, "#{pane_title}"])).stdout.trim();
    await waitFor(async () => [initialTitle, dynamicTitle].includes(await title()), "tmux managed title");
    await waitFor(async () => await title() === dynamicTitle, "tmux lifecycle title");
    const survivors = await run(tmux, ["-S", socket, "list-panes", "-a", "-F", "#{pane_id}"]);
    if (!survivors.stdout.split(/\s+/).includes(sourcePane) || !survivors.stdout.split(/\s+/).includes(sentinelPane)) throw new Error("tmux source/sentinel changed during title smoke");
    await run(tmux, ["-S", socket, "kill-pane", "-t", targetPane]); targetPane = null;
    return { mode: "tmux", initialTitle, dynamicTitle, sourcePane, sentinelPane, result: "pass" };
  } finally {
    if (targetPane) await run(tmux, ["-S", socket, "kill-pane", "-t", targetPane]).catch(() => undefined);
    await run(tmux, ["-S", socket, "kill-server"]).catch(() => undefined);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

function cmuxWorkspaceCreateIdentity(stdout: string): { workspaceId: string; paneId: string; surfaceId: string } | null {
  try {
    const value = JSON.parse(stdout) as Record<string, unknown>;
    const record = value.result && typeof value.result === "object" && !Array.isArray(value.result) ? value.result as Record<string, unknown> : value;
    const workspaceId = typeof record.workspace_id === "string" ? record.workspace_id : null;
    const paneId = typeof record.pane_id === "string" ? record.pane_id : null;
    const surfaceId = typeof record.surface_id === "string" ? record.surface_id : null;
    return workspaceId && paneId && surfaceId && [workspaceId, paneId, surfaceId].every(isCanonicalCmuxId) ? { workspaceId, paneId, surfaceId } : null;
  } catch { return null; }
}

function cmuxWorkspaceFromTree(stdout: string, name: string): { workspaceId: string; paneId: string; surfaceId: string } | null {
  try {
    const tree = JSON.parse(stdout) as { windows?: unknown[] };
    if (!Array.isArray(tree.windows)) return null;
    const matches: Array<{ workspaceId: string; paneId: string; surfaceId: string }> = [];
    for (const rawWindow of tree.windows) {
      const workspaces = rawWindow && typeof rawWindow === "object" && Array.isArray((rawWindow as { workspaces?: unknown }).workspaces) ? (rawWindow as { workspaces: unknown[] }).workspaces : [];
      for (const rawWorkspace of workspaces) {
        if (!rawWorkspace || typeof rawWorkspace !== "object") continue;
        const workspace = rawWorkspace as { id?: unknown; name?: unknown; title?: unknown; panes?: unknown };
        if ((workspace.name ?? workspace.title) !== name || typeof workspace.id !== "string" || !isCanonicalCmuxId(workspace.id) || !Array.isArray(workspace.panes) || workspace.panes.length !== 1) continue;
        const pane = workspace.panes[0] as { id?: unknown; surfaces?: unknown };
        if (!pane || typeof pane.id !== "string" || !isCanonicalCmuxId(pane.id) || !Array.isArray(pane.surfaces) || pane.surfaces.length !== 1) continue;
        const surface = pane.surfaces[0] as { id?: unknown; pane_id?: unknown };
        if (!surface || typeof surface.id !== "string" || !isCanonicalCmuxId(surface.id) || String(surface.pane_id).toLowerCase() !== pane.id.toLowerCase()) continue;
        matches.push({ workspaceId: workspace.id, paneId: pane.id, surfaceId: surface.id });
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  } catch { return null; }
}

async function cmuxTitleSmoke(): Promise<Record<string, unknown>> {
  const cmux = process.env.CMUX_BIN?.trim() || "cmux";
  const callerWorkspace = process.env.CMUX_WORKSPACE_ID?.trim();
  const callerSurface = process.env.CMUX_SURFACE_ID?.trim();
  if (!callerWorkspace || !callerSurface || !isCanonicalCmuxId(callerWorkspace) || !isCanonicalCmuxId(callerSurface)) {
    throw new Error("cmux title smoke must run inside a canonical cmux terminal");
  }
  const root = await privateRoot("pi-subagent-title-cmux-");
  const workspaceName = `pi-subagent-title-${crypto.randomUUID()}`;
  const initialTitle = "subagent:title-smoke:initial";
  const dynamicTitle = "subagent:title-smoke:running";
  let workspaceId: string | null = null;
  let targetSurface: string | null = null;
  try {
    const wrapper = await writeWrapper(root, initialTitle, dynamicTitle);
    const created = await run(cmux, ["--json", "--id-format", "both", "new-workspace", "--name", workspaceName, "--cwd", root, "--focus", "false"]);
    let source = created.code === 0 ? cmuxWorkspaceCreateIdentity(created.stdout) : null;
    if (!source) {
      for (let attempt = 0; attempt < 3 && !source; attempt += 1) {
        const tree = await run(cmux, ["--json", "--id-format", "both", "tree", "--all"]);
        source = tree.code === 0 ? cmuxWorkspaceFromTree(tree.stdout, workspaceName) : null;
        if (!source) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!source) throw new Error("cmux workspace identity is not uniquely recoverable; no cleanup target was guessed");
    workspaceId = source.workspaceId;
    if (workspaceId.toLowerCase() === callerWorkspace.toLowerCase() || source.surfaceId.toLowerCase() === callerSurface.toLowerCase()) throw new Error("cmux acceptance workspace overlaps caller");
    const sentinelResult = await run(cmux, ["--json", "--id-format", "both", "new-surface", "--workspace", workspaceId, "--pane", source.paneId, "--working-directory", root, "--focus", "false"]);
    const sentinel = sentinelResult.code === 0 ? parseCreatedCmuxSurface(sentinelResult.stdout) : null;
    if (!sentinel?.surfaceId || sentinel.surfaceId === source.surfaceId) throw new Error("cmux sentinel creation failed");
    const targetResult = await run(cmux, ["--json", "--id-format", "both", "new-split", "right", "--workspace", workspaceId, "--surface", source.surfaceId, "--focus", "false"]);
    const target = targetResult.code === 0 ? parseCreatedCmuxSurface(targetResult.stdout) : null;
    if (!target?.surfaceId || [source.surfaceId, sentinel.surfaceId].includes(target.surfaceId)) throw new Error("cmux target creation failed");
    targetSurface = target.surfaceId;
    const respawn = await run(cmux, buildCmuxRespawnPaneArgs(workspaceId, targetSurface, wrapper));
    if (respawn.code !== 0) throw new Error(respawn.stderr || "cmux target respawn failed");
    const snapshot = async () => {
      const tree = await run(cmux, ["--json", "--id-format", "both", "tree", "--all"]);
      return tree.code === 0 ? inspectCanonicalCmuxSurfaceTree(tree.stdout, workspaceId!, targetSurface!) : undefined;
    };
    await waitFor(async () => [initialTitle, dynamicTitle].includes((await snapshot())?.title ?? ""), "cmux managed title");
    await waitFor(async () => (await snapshot())?.title === dynamicTitle, "cmux lifecycle title");
    const finalTree = await run(cmux, ["--json", "--id-format", "both", "tree", "--all"]);
    if (!inspectCanonicalCmuxSurfaceTree(finalTree.stdout, workspaceId, source.surfaceId)?.exists
      || !inspectCanonicalCmuxSurfaceTree(finalTree.stdout, workspaceId, sentinel.surfaceId)?.exists) throw new Error("cmux source/sentinel changed during title smoke");
    await run(cmux, ["close-surface", "--workspace", workspaceId, "--surface", targetSurface]); targetSurface = null;
    return { mode: "cmux", initialTitle, dynamicTitle, workspaceId, result: "pass" };
  } finally {
    if (targetSurface && workspaceId) await run(cmux, ["close-surface", "--workspace", workspaceId, "--surface", targetSurface]).catch(() => undefined);
    if (workspaceId) await run(cmux, ["close-workspace", "--workspace", workspaceId]).catch(() => undefined);
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

export async function runLiveTitleSmoke(options: LiveTitleOptions, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  if (options.dryRun) return { mode: options.mode, dryRun: true, mutation: "none", requiredGate: `${LIVE_TITLE_GATE}=1` };
  requireLiveTitleGate(env);
  return options.mode === "tmux" ? await tmuxTitleSmoke() : await cmuxTitleSmoke();
}

if (import.meta.main) {
  const result = await runLiveTitleSmoke(parseLiveTitleArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
