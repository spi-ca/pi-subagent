import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { buildCmuxNewSplitArgs, parseCreatedCmuxSurface } from "../../../src/runtime/cmux.js";
import { cleanupAcceptanceCmuxTarget, closeAcceptanceCmuxWorkspaceAfterSingletonProof, createAcceptanceCmuxWorkspace, createCmuxCommandGate, findCanonicalCmuxIdentity, hasOverlappingCmuxIdentity, requireVerifiedAcceptanceCmuxSentinel, verifyCmuxCallerPreserved, type CmuxIdentity } from "../live-harness.js";
import { type LiveEvidence, type Workload, record, runBoundedCommand as run } from "./evidence.js";
import { ROOT, type ActionBarrier, runParentCell } from "./cell.js";
import { createCellDeadline, remainingDeadlineMs } from "./evidence.js";

export async function runCmuxCell(root: string, agentDir: string, extension: string, piBin: string, activeRuns: number, workload: Workload): Promise<Omit<LiveEvidence["matrix"][number], "mode" | "sourceAndSentinelPreserved">> {
  const deadline = createCellDeadline(activeRuns);
  const cmux = process.env.CMUX_BIN || "cmux"; const callerWorkspaceId = process.env.CMUX_WORKSPACE_ID?.trim(), callerSurfaceId = process.env.CMUX_SURFACE_ID?.trim();
  if (!callerWorkspaceId || !callerSurfaceId || !process.env.CMUX_SOCKET_PATH) throw new Error("cmux benchmark must be run from a cmux source");
  const gated = createCmuxCommandGate((args) => run(cmux, args, { deadline }));
  const callerTree = await gated.run(["--json", "--id-format", "both", "tree", "--workspace", callerWorkspaceId]);
  const caller = callerTree.code === 0 ? findCanonicalCmuxIdentity(callerTree.stdout, callerWorkspaceId, callerSurfaceId) : null;
  if (!caller) throw new Error("cmux caller identity is not canonical");
  const name = `phase0-live-${crypto.randomUUID()}`; const created = await createAcceptanceCmuxWorkspace(gated.run, name, ROOT);
  if (created.state !== "created" || hasOverlappingCmuxIdentity(created.workspace, caller)) { gated.hardStop(); throw new Error("could not establish disjoint isolated cmux workspace"); }
  const acceptance = created.workspace; let sentinel: CmuxIdentity | null = null;
  const listSurfaces = async (): Promise<CmuxIdentity[]> => {
    const result = await gated.run(["--json", "--id-format", "both", "tree", "--workspace", acceptance.workspaceId]);
    if (result.code !== 0) throw new Error("cmux topology inspection failed");
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("cmux topology JSON was malformed"); }
    const body = record(parsed) && record(parsed.result) ? parsed.result : parsed;
    if (!record(body) || !Array.isArray(body.windows)) throw new Error("cmux topology envelope was malformed");
    const surfaces: CmuxIdentity[] = [];
    for (const window of body.windows) {
      if (!record(window) || !Array.isArray(window.workspaces)) throw new Error("cmux window topology was malformed");
      for (const workspace of window.workspaces) {
        if (!record(workspace) || !Array.isArray(workspace.panes) || typeof workspace.id !== "string") throw new Error("cmux workspace topology was malformed");
        if (workspace.id.toLowerCase() !== acceptance.workspaceId.toLowerCase()) continue;
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
  try {
    const split = await gated.run(buildCmuxNewSplitArgs({ workspaceId: acceptance.workspaceId, sourceSurfaceId: acceptance.surfaceId }));
    const splitBody = split.code === 0 ? parseCreatedCmuxSurface(split.stdout, acceptance.workspaceId) : null;
    if (!splitBody?.paneId) throw new Error("cmux sentinel create failed");
    sentinel = { workspaceId: splitBody.workspaceId, surfaceId: splitBody.surfaceId, paneId: splitBody.paneId };
    await requireVerifiedAcceptanceCmuxSentinel(cmux, sentinel, acceptance, caller, gated.run, () => gated.hardStop());
    const baseline = new Set([acceptance.surfaceId.toLowerCase(), sentinel.surfaceId.toLowerCase()]);
    const barrier: ActionBarrier = async (_child, expected, deadline, signal) => {
      let targets: CmuxIdentity[] = [];
      while (remainingDeadlineMs(deadline) > 0) {
        if (signal?.aborted) throw new Error("Phase 0 action barrier aborted");
        targets = (await listSurfaces()).filter((surface) => !baseline.has(surface.surfaceId.toLowerCase())).sort((left, right) => left.surfaceId.localeCompare(right.surfaceId));
        if (targets.length === expected) break;
        if (targets.length > expected) throw new Error("cmux allocation exceeded the expected target count");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (signal?.aborted) throw new Error("Phase 0 action barrier aborted");
      if (targets.length !== expected) throw new Error(`cmux observed ${targets.length}/${expected} target surfaces`);
      return { observedProcesses: targets.length, closeAll: async () => {
        for (const target of targets) if (!await cleanupAcceptanceCmuxTarget(cmux, target, acceptance, caller, gated.run)) throw new Error("cmux exact target close failed");
      } };
    };
    let sampling = true, maxBackendTargets = 0;
    const topologySampler = (async () => { while (sampling) { try { maxBackendTargets = Math.max(maxBackendTargets, (await listSurfaces()).filter((surface) => !baseline.has(surface.surfaceId.toLowerCase())).length); } catch { /* final checks fail closed */ } await new Promise((resolve) => setTimeout(resolve, 25)); } })();
    let cell: Awaited<ReturnType<typeof runParentCell>>;
    try { cell = await runParentCell(root, agentDir, extension, piBin, activeRuns, workload, {
      CMUX_SOCKET_PATH: process.env.CMUX_SOCKET_PATH,
      CMUX_WORKSPACE_ID: acceptance.workspaceId,
      CMUX_SURFACE_ID: acceptance.surfaceId,
      ...(process.env.CMUX_BUNDLED_CLI_PATH ? { CMUX_BUNDLED_CLI_PATH: process.env.CMUX_BUNDLED_CLI_PATH } : {}),
    }, barrier, false, deadline); }
    finally { sampling = false; await topologySampler; }
    if (maxBackendTargets < activeRuns) throw new Error(`cmux topology observed only ${maxBackendTargets}/${activeRuns} concurrent targets`);
    cell.backend.topologyProbeCount = maxBackendTargets;
    const cleanupDeadline = Date.now() + 20_000; let finalSurfaces = await listSurfaces();
    while (Date.now() < cleanupDeadline && (finalSurfaces.length !== 2 || !finalSurfaces.every((surface) => baseline.has(surface.surfaceId.toLowerCase())))) { await new Promise((resolve) => setTimeout(resolve, 100)); finalSurfaces = await listSurfaces(); }
    if (finalSurfaces.length !== 2 || !finalSurfaces.every((surface) => baseline.has(surface.surfaceId.toLowerCase()))) throw new Error("cmux source/sentinel preservation or child cleanup failed");
    if (!await verifyCmuxCallerPreserved(cmux, caller, gated.run)) throw new Error("cmux caller was not preserved");
    cell.cleanup.residualBackendTargetCount = finalSurfaces.filter((surface) => !baseline.has(surface.surfaceId.toLowerCase())).length;
    return cell;
  } finally {
    let cleanupOk = false;
    if (!gated.stopped) {
      const sentinelClosed = sentinel ? await cleanupAcceptanceCmuxTarget(cmux, sentinel, acceptance, caller, gated.run).catch(() => false) : true;
      cleanupOk = sentinelClosed && await closeAcceptanceCmuxWorkspaceAfterSingletonProof(cmux, acceptance, caller, gated.run).catch(() => false)
        && await verifyCmuxCallerPreserved(cmux, caller, gated.run).catch(() => false);
    }
    // Unknown cleanup/mutation outcomes are terminal: never permit the caller to retry a potentially live cmux target.
    if (!cleanupOk) throw new Error("cmux cleanup was not proven; terminal private evidence is retained");
  }
}

