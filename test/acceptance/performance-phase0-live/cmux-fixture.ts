import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { buildCmuxNewSplitArgs, parseCreatedCmuxSurface } from "../../../src/runtime/cmux.js";
import { cleanupAcceptanceCmuxTarget, closeAcceptanceCmuxWorkspaceAfterSingletonProof, createAcceptanceCmuxWorkspace, createCmuxCommandGate, findCanonicalCmuxIdentity, hasOverlappingCmuxIdentity, requireVerifiedAcceptanceCmuxSentinel, verifyCmuxCallerPreserved, type CmuxIdentity, type CmuxWorkspaceIdentity } from "../live-harness.js";
import { type CellDeadline, type LiveEvidence, type LivePiExecutable, type Workload, record, runBoundedCommand as run } from "./evidence.js";
import { ROOT, finalizePhase0CellFailure, type ActionBarrier, runParentCell } from "./cell.js";
import { createCellDeadline, remainingDeadlineMs } from "./evidence.js";
import { revalidateManagedChildPiExecutableGeneration } from "../managed-child-pi-executable.js";

export const CMUX_CLEANUP_DEADLINE_MS = 20_000;
/** Cleanup gets its own bounded budget; it must never inherit an expired cell deadline. */
export function createCmuxCleanupDeadline(now = Date.now()): CellDeadline { return { expiresAt: now + CMUX_CLEANUP_DEADLINE_MS }; }
/** Use a fresh bounded cleanup budget, then restore the caller's cell deadline. */
export async function withCmuxCleanupDeadline<T>(commandDeadline: { current: CellDeadline }, cleanup: () => Promise<T>): Promise<T> {
  const priorDeadline = commandDeadline.current;
  commandDeadline.current = createCmuxCleanupDeadline();
  try { return await cleanup(); }
  finally { commandDeadline.current = priorDeadline; }
}

export type CmuxCleanupAttempts = {
  closeSentinel: () => Promise<boolean>;
  closeWorkspace: () => Promise<boolean>;
  verifyCallerPreserved: () => Promise<boolean>;
};
/** Preserve mutation/proof dependencies while attempting every final cleanup step. */
export async function aggregateCmuxCleanupAttempts(attempts: CmuxCleanupAttempts): Promise<boolean> {
  let sentinel = false, workspace = false, caller = false;
  // The sentinel must be closed before its workspace can be reconciled; caller
  // preservation is meaningful only after that reconciliation. Do not let any
  // failed step prevent the following proof attempt.
  try { sentinel = await attempts.closeSentinel(); }
  catch { sentinel = false; }
  try { workspace = await attempts.closeWorkspace(); }
  catch { workspace = false; }
  try { caller = await attempts.verifyCallerPreserved(); }
  catch { caller = false; }
  return sentinel && workspace && caller;
}

export async function runCmuxCell(root: string, agentDir: string, extension: string, pi: LivePiExecutable, activeRuns: number, workload: Workload, env: NodeJS.ProcessEnv): Promise<Omit<LiveEvidence["matrix"][number], "mode" | "sourceAndSentinelPreserved">> {
  const deadline = createCellDeadline(activeRuns), commandDeadline = { current: deadline }, cmux = pi.cmux.executable;
  let gated: ReturnType<typeof createCmuxCommandGate> | null = null, caller: CmuxIdentity | null = null, acceptance: CmuxWorkspaceIdentity | null = null, sentinel: CmuxIdentity | null = null, primaryFailure: unknown = null;
  let parentCompleted = false, cleanupOk = true, creationAttempted = false, result: Omit<LiveEvidence["matrix"][number], "mode" | "sourceAndSentinelPreserved"> | null = null;
  try {
    const callerWorkspaceId = env.CMUX_WORKSPACE_ID?.trim(), callerSurfaceId = env.CMUX_SURFACE_ID?.trim();
    if (!callerWorkspaceId || !callerSurfaceId || !env.CMUX_SOCKET_PATH) throw new Error("cmux benchmark must be run from a cmux source");
    gated = createCmuxCommandGate((args) => { revalidateManagedChildPiExecutableGeneration(pi.cmux); return run(cmux, args, { deadline: commandDeadline.current, env }); });
    const callerTree = await gated.run(["--json", "--id-format", "both", "tree", "--workspace", callerWorkspaceId]);
    caller = callerTree.code === 0 ? findCanonicalCmuxIdentity(callerTree.stdout, callerWorkspaceId, callerSurfaceId) : null;
    if (!caller) throw new Error("cmux caller identity is not canonical");
    creationAttempted = true;
    const created = await createAcceptanceCmuxWorkspace(gated.run, `phase0-live-${crypto.randomUUID()}`, ROOT);
    if (created.state !== "created" || hasOverlappingCmuxIdentity(created.workspace, caller)) { cleanupOk = false; gated.hardStop(); throw new Error("could not establish disjoint isolated cmux workspace"); }
    acceptance = created.workspace;
    const listSurfaces = async (): Promise<CmuxIdentity[]> => {
      const listed = await gated!.run(["--json", "--id-format", "both", "tree", "--workspace", acceptance!.workspaceId]);
      if (listed.code !== 0) throw new Error("cmux topology inspection failed");
      let parsed: unknown;
      try { parsed = JSON.parse(listed.stdout); } catch { throw new Error("cmux topology JSON was malformed"); }
      const body = record(parsed) && record(parsed.result) ? parsed.result : parsed;
      if (!record(body) || !Array.isArray(body.windows)) throw new Error("cmux topology envelope was malformed");
      const surfaces: CmuxIdentity[] = [];
      for (const window of body.windows) {
        if (!record(window) || !Array.isArray(window.workspaces)) throw new Error("cmux window topology was malformed");
        for (const workspace of window.workspaces) {
          if (!record(workspace) || !Array.isArray(workspace.panes) || typeof workspace.id !== "string") throw new Error("cmux workspace topology was malformed");
          if (workspace.id.toLowerCase() !== acceptance!.workspaceId.toLowerCase()) continue;
          for (const pane of workspace.panes) {
            if (!record(pane) || typeof pane.id !== "string" || !Array.isArray(pane.surfaces)) throw new Error("cmux pane topology was malformed");
            for (const surface of pane.surfaces) {
              if (!record(surface) || typeof surface.id !== "string" || surface.pane_id !== pane.id) throw new Error("cmux surface topology was malformed");
              surfaces.push({ workspaceId: workspace.id, paneId: pane.id, surfaceId: surface.id });
            }
          }
        }
      }
      if (new Set(surfaces.map((surface) => surface.surfaceId.toLowerCase())).size !== surfaces.length) throw new Error("cmux topology contained duplicate surfaces");
      return surfaces;
    };
    const split = await gated.run(buildCmuxNewSplitArgs({ workspaceId: acceptance.workspaceId, sourceSurfaceId: acceptance.surfaceId }));
    const splitBody = split.code === 0 ? parseCreatedCmuxSurface(split.stdout, acceptance.workspaceId) : null;
    if (!splitBody?.paneId) throw new Error("cmux sentinel create failed");
    sentinel = { workspaceId: splitBody.workspaceId, surfaceId: splitBody.surfaceId, paneId: splitBody.paneId };
    await requireVerifiedAcceptanceCmuxSentinel(cmux, sentinel, acceptance, caller, gated.run, () => gated!.hardStop());
    const baseline = new Set([acceptance.surfaceId.toLowerCase(), sentinel.surfaceId.toLowerCase()]);
    const barrier: ActionBarrier = async (_child, expected, barrierDeadline, signal) => {
      let targets: CmuxIdentity[] = [];
      while (remainingDeadlineMs(barrierDeadline) > 0) {
        if (signal?.aborted) throw new Error("Phase 0 action barrier aborted");
        targets = (await listSurfaces()).filter((surface) => !baseline.has(surface.surfaceId.toLowerCase())).sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
        if (targets.length === expected) break;
        if (targets.length > expected) throw new Error("cmux allocation exceeded the expected target count");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (signal?.aborted) throw new Error("Phase 0 action barrier aborted");
      if (targets.length !== expected) throw new Error(`cmux observed ${targets.length}/${expected} target surfaces`);
      return { observedProcesses: targets.length, closeAll: async () => await withCmuxCleanupDeadline(commandDeadline, async () => {
        for (const target of targets) if (!await cleanupAcceptanceCmuxTarget(cmux, target, acceptance!, caller!, gated!.run)) throw new Error("cmux exact target close failed");
      }) };
    };
    let sampling = true, maxBackendTargets = 0;
    const topologySampler = (async () => { while (sampling) { try { maxBackendTargets = Math.max(maxBackendTargets, (await listSurfaces()).filter((surface) => !baseline.has(surface.surfaceId.toLowerCase())).length); } catch { /* final checks fail closed */ } await new Promise((resolve) => setTimeout(resolve, 25)); } })();
    let cell: Awaited<ReturnType<typeof runParentCell>>;
    try { cell = await runParentCell(root, agentDir, extension, pi, activeRuns, workload, env, { CMUX_BIN: cmux, CMUX_SOCKET_PATH: env.CMUX_SOCKET_PATH, CMUX_WORKSPACE_ID: acceptance.workspaceId, CMUX_SURFACE_ID: acceptance.surfaceId, ...(env.CMUX_BUNDLED_CLI_PATH ? { CMUX_BUNDLED_CLI_PATH: env.CMUX_BUNDLED_CLI_PATH } : {}) }, barrier, false, deadline); parentCompleted = true; }
    finally { sampling = false; await topologySampler; }
    if (maxBackendTargets < activeRuns) throw new Error(`cmux topology observed only ${maxBackendTargets}/${activeRuns} concurrent targets`);
    cell.backend.topologyProbeCount = maxBackendTargets;
    const cleanupDeadline = Date.now() + 20_000; let finalSurfaces = await listSurfaces();
    while (Date.now() < cleanupDeadline && (finalSurfaces.length !== 2 || !finalSurfaces.every((surface) => baseline.has(surface.surfaceId.toLowerCase())))) { await new Promise((resolve) => setTimeout(resolve, 100)); finalSurfaces = await listSurfaces(); }
    if (finalSurfaces.length !== 2 || !finalSurfaces.every((surface) => baseline.has(surface.surfaceId.toLowerCase()))) throw new Error("cmux source/sentinel preservation or child cleanup failed");
    if (!await verifyCmuxCallerPreserved(cmux, caller, gated.run)) throw new Error("cmux caller was not preserved");
    cell.cleanup.residualBackendTargetCount = finalSurfaces.filter((surface) => !baseline.has(surface.surfaceId.toLowerCase())).length;
    result = cell;
  } catch (error) {
    primaryFailure = error;
  } finally {
    // Final sentinel→workspace→caller cleanup always has a fresh bounded
    // budget and remains behind the same identity-gated command path.
    if (acceptance && caller && gated && !gated.stopped) {
      cleanupOk = await withCmuxCleanupDeadline(commandDeadline, async () => await aggregateCmuxCleanupAttempts({
        closeSentinel: () => sentinel ? cleanupAcceptanceCmuxTarget(cmux, sentinel, acceptance!, caller!, gated!.run) : Promise.resolve(true),
        closeWorkspace: () => closeAcceptanceCmuxWorkspaceAfterSingletonProof(cmux, acceptance!, caller!, gated!.run),
        verifyCallerPreserved: () => verifyCmuxCallerPreserved(cmux, caller!, gated!.run),
      }));
    } else if (acceptance || creationAttempted) cleanupOk = false;
    const finalized = await finalizePhase0CellFailure(root, primaryFailure, cleanupOk, { mode: "cmux", workload, activeRuns }, parentCompleted);
    if (finalized) throw finalized;
  }
  if (result === null) throw new Error("unreachable cmux cell completion");
  return result;
}
