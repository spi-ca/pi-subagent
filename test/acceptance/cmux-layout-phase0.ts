import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CMUX_LAYOUT_CONTRACT_ID, cmuxIdsEqual, isCanonicalCmuxId, parseCreatedCmuxSurface, sanitizeCreatedCmuxSurfaceResponse } from "../../src/runtime/cmux.js";
import { MINIMUM_CMUX_VERSION, isStableSemverAtLeast, parseCmuxVersionOutput } from "../../src/runtime/version-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_PATH = path.join(ROOT, "test/fixtures/cmux-layout-contract-v1.json");
const LIVE_GATE = "PI_SUBAGENT_CMUX_LAYOUT_PHASE0";
const STABILIZATION_READS = 3;
const STABILIZATION_DELAY_MS = 50;

type CommandResult = { code: number; stdout: string; stderr: string };
type Command = { args: string[]; code: number; stdout: string; stderr: string };
type Identity = { workspaceId: string; paneId: string; surfaceId: string };
type Workspace = Identity & { name: string; panes: Array<{ paneId: string; surfaceIds: string[] }> };
type Evidence = { commands: Command[]; [key: string]: unknown };

function usage(): never {
  throw new Error("usage: cmux-layout-phase0.ts [--dry-run]");
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  if (argv.length === 0) return { dryRun: false };
  if (argv.length === 1 && argv[0] === "--dry-run") return { dryRun: true };
  return usage();
}

function supportedVersion(stdout: string): string | null {
  const detected = parseCmuxVersionOutput(stdout.trim());
  return detected && isStableSemverAtLeast(detected, MINIMUM_CMUX_VERSION) ? detected : null;
}

function hasRequiredCapabilities(stdout: string): boolean {
  const methods = jsonObject(stdout)?.methods;
  const required = ["surface.create", "surface.close", "surface.send_key", "surface.respawn"];
  return Array.isArray(methods) && methods.every((method) => typeof method === "string")
    && required.every((method) => methods.includes(method));
}

function runCommand(bin: string, args: string[], evidence: Evidence): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (status) => {
      const result = { code: status ?? 1, stdout, stderr };
      // The private evidence file intentionally keeps exact commands and their
      // outputs for a failed probe. It never records the ambient environment.
      evidence.commands.push({ args: [...args], ...result });
      resolve(result);
    });
  });
}

async function privateRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-cmux-layout-phase0-"));
  await fs.promises.chmod(root, 0o700);
  return root;
}

async function writeEvidence(root: string, evidence: Evidence): Promise<void> {
  await fs.promises.writeFile(path.join(root, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
}

function jsonObject(stdout: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stdout);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function stringValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Reject incomplete, duplicate, and cross-type-duplicate identities. */
function parseCanonicalTopology(stdout: string): Workspace[] | null {
  const tree = jsonObject(stdout);
  if (!tree || !Array.isArray(tree.windows)) return null;
  const ids = new Set<string>();
  const workspaces: Workspace[] = [];
  for (const window of tree.windows) {
    if (!window || typeof window !== "object" || Array.isArray(window)) return null;
    const rawWorkspaces = (window as Record<string, unknown>).workspaces;
    if (!Array.isArray(rawWorkspaces)) return null;
    for (const rawWorkspace of rawWorkspaces) {
      if (!rawWorkspace || typeof rawWorkspace !== "object" || Array.isArray(rawWorkspace)) return null;
      const workspace = rawWorkspace as Record<string, unknown>;
      const workspaceId = stringValue(workspace, "id");
      const name = stringValue(workspace, "name") ?? stringValue(workspace, "title");
      const rawPanes = workspace.panes;
      if (!workspaceId || !isCanonicalCmuxId(workspaceId) || !name || !Array.isArray(rawPanes)) return null;
      if (ids.has(workspaceId.toLowerCase())) return null;
      ids.add(workspaceId.toLowerCase());
      const panes: Workspace["panes"] = [];
      for (const rawPane of rawPanes) {
        if (!rawPane || typeof rawPane !== "object" || Array.isArray(rawPane)) return null;
        const pane = rawPane as Record<string, unknown>;
        const paneId = stringValue(pane, "id");
        const rawSurfaces = pane.surfaces;
        if (!paneId || !isCanonicalCmuxId(paneId) || !Array.isArray(rawSurfaces) || ids.has(paneId.toLowerCase())) return null;
        ids.add(paneId.toLowerCase());
        const surfaceIds: string[] = [];
        for (const rawSurface of rawSurfaces) {
          if (!rawSurface || typeof rawSurface !== "object" || Array.isArray(rawSurface)) return null;
          const surface = rawSurface as Record<string, unknown>;
          const surfaceId = stringValue(surface, "id");
          if (!surfaceId || !isCanonicalCmuxId(surfaceId) || !cmuxIdsEqual(surface.pane_id, paneId) || ids.has(surfaceId.toLowerCase())) return null;
          ids.add(surfaceId.toLowerCase());
          surfaceIds.push(surfaceId);
        }
        panes.push({ paneId, surfaceIds });
      }
      workspaces.push({ workspaceId, name, paneId: "", surfaceId: "", panes });
    }
  }
  return workspaces;
}

function findIdentity(workspaces: Workspace[], workspaceId: string, surfaceId: string): Identity | null {
  let found: Identity | null = null;
  for (const workspace of workspaces) {
    if (!cmuxIdsEqual(workspace.workspaceId, workspaceId)) continue;
    for (const pane of workspace.panes) {
      if (!pane.surfaceIds.some((id) => cmuxIdsEqual(id, surfaceId))) continue;
      if (found) return null;
      found = { workspaceId: workspace.workspaceId, paneId: pane.paneId, surfaceId };
    }
  }
  return found;
}

function disjoint(left: Identity, right: Identity): boolean {
  return [left.workspaceId, left.paneId, left.surfaceId].every((candidate) =>
    [right.workspaceId, right.paneId, right.surfaceId].every((other) => !cmuxIdsEqual(candidate, other)));
}

function workspaceFromCreateResponse(stdout: string, name: string): Identity | null {
  const record = jsonObject(stdout);
  const result = record?.result && typeof record.result === "object" && !Array.isArray(record.result)
    ? record.result as Record<string, unknown> : record;
  if (!result) return null;
  const workspaceId = stringValue(result, "workspace_id");
  const paneId = stringValue(result, "pane_id");
  const surfaceId = stringValue(result, "surface_id");
  return workspaceId && paneId && surfaceId && [workspaceId, paneId, surfaceId].every(isCanonicalCmuxId)
    ? { workspaceId, paneId, surfaceId } : null;
}

async function readTopology(cmux: string, evidence: Evidence): Promise<Workspace[]> {
  const result = await runCommand(cmux, ["--json", "--id-format", "both", "tree", "--all"], evidence);
  const topology = result.code === 0 ? parseCanonicalTopology(result.stdout) : null;
  if (!topology) throw new Error("cmux did not return complete canonical topology");
  return topology;
}

async function recoverWorkspace(cmux: string, name: string, direct: Identity | null, evidence: Evidence): Promise<Identity> {
  for (let attempt = 0; attempt < STABILIZATION_READS; attempt += 1) {
    const topology = await readTopology(cmux, evidence);
    const matches = topology.filter((workspace) => workspace.name === name);
    if (matches.length === 1) {
      const workspace = matches[0]!;
      if (workspace.panes.length !== 1 || workspace.panes[0]?.surfaceIds.length !== 1) throw new Error("recovered workspace is not a singleton canonical topology");
      const recovered = { workspaceId: workspace.workspaceId, paneId: workspace.panes[0]!.paneId, surfaceId: workspace.panes[0]!.surfaceIds[0]! };
      if (direct && (!cmuxIdsEqual(direct.workspaceId, recovered.workspaceId) || !cmuxIdsEqual(direct.paneId, recovered.paneId) || !cmuxIdsEqual(direct.surfaceId, recovered.surfaceId))) {
        throw new Error("workspace create response disagrees with canonical recovery");
      }
      return recovered;
    }
    if (matches.length > 1) throw new Error("workspace recovery found multiple exact-name workspaces");
    if (attempt + 1 < STABILIZATION_READS) await new Promise((resolve) => setTimeout(resolve, STABILIZATION_DELAY_MS));
  }
  throw new Error("workspace recovery found no exact-name workspace");
}

function directHandle(result: CommandResult, label: string): Identity {
  const handle = result.code === 0 ? parseCreatedCmuxSurface(result.stdout) : null;
  if (!handle) throw new Error(`${label} did not return direct canonical workspace, pane, and surface IDs`);
  return { workspaceId: handle.workspaceId, paneId: handle.paneId!, surfaceId: handle.surfaceId };
}

function assertSameWorkspacePane(first: Identity, second: Identity): void {
  if (!cmuxIdsEqual(first.workspaceId, second.workspaceId) || !cmuxIdsEqual(first.paneId, second.paneId) || cmuxIdsEqual(first.surfaceId, second.surfaceId)) {
    throw new Error("new-split and new-surface did not return distinct surfaces in the exact same canonical workspace and pane");
  }
}

function assertKnownFinalTopology(topology: Workspace[], workspaceName: string, caller: Identity, initial: Identity, split: Identity, lastSurfacePane: "removed" | "empty"): void {
  const byName = topology.filter((workspace) => workspace.name === workspaceName);
  const byId = topology.filter((workspace) => cmuxIdsEqual(workspace.workspaceId, initial.workspaceId));
  if (byName.length !== 1 || byId.length !== 1 || byName[0] !== byId[0] || !disjoint(initial, caller)) throw new Error("final workspace identity is not uniquely caller-disjoint");
  const workspace = byId[0]!;
  const originalPane = workspace.panes.find((pane) => cmuxIdsEqual(pane.paneId, initial.paneId));
  const splitPane = workspace.panes.find((pane) => cmuxIdsEqual(pane.paneId, split.paneId));
  const originalIsSingleton = originalPane?.surfaceIds.length === 1 && cmuxIdsEqual(originalPane.surfaceIds[0], initial.surfaceId);
  if (!originalIsSingleton) throw new Error("final workspace does not retain the original singleton source");
  if (lastSurfacePane === "removed") {
    if (workspace.panes.length !== 1 || splitPane) throw new Error("removed last-surface pane left extra or unknown topology");
    return;
  }
  if (workspace.panes.length !== 2 || !splitPane || splitPane.surfaceIds.length !== 0) {
    throw new Error("empty last-surface pane topology is not exactly the original and known split panes");
  }
}

async function cleanupKnownFailedWorkspace(
  cmux: string,
  evidence: Evidence,
  workspaceName: string,
  caller: Identity,
  initial: Identity,
  known: Identity[],
): Promise<boolean> {
  const topology = await readTopology(cmux, evidence);
  const callerNow = findIdentity(topology, caller.workspaceId, caller.surfaceId);
  if (!callerNow || !cmuxIdsEqual(callerNow.paneId, caller.paneId)) return false;
  const byName = topology.filter((workspace) => workspace.name === workspaceName);
  const byId = topology.filter((workspace) => cmuxIdsEqual(workspace.workspaceId, initial.workspaceId));
  if (byName.length === 0 && byId.length === 0) return true;
  if (byName.length !== 1 || byId.length !== 1 || byName[0] !== byId[0] || !disjoint(initial, caller)) return false;
  const allowed = new Set(known.flatMap((identity) => [identity.workspaceId, identity.paneId, identity.surfaceId]).map((id) => id.toLowerCase()));
  const workspace = byId[0]!;
  const actual = [workspace.workspaceId, ...workspace.panes.flatMap((pane) => [pane.paneId, ...pane.surfaceIds])];
  if (!actual.every((id) => allowed.has(id.toLowerCase()))) return false;
  if ((await runCommand(cmux, ["close-workspace", "--workspace", initial.workspaceId], evidence)).code !== 0) return false;
  const after = await readTopology(cmux, evidence);
  return !after.some((candidate) => cmuxIdsEqual(candidate.workspaceId, initial.workspaceId) || candidate.name === workspaceName)
    && Boolean(findIdentity(after, caller.workspaceId, caller.surfaceId));
}

async function atomicallyWriteFixture(cmuxVersion: string, splitResponse: unknown, surfaceResponse: unknown, lastSurfacePane: "removed" | "empty"): Promise<void> {
  const fixture = {
    schema_version: 1,
    contract_id: CMUX_LAYOUT_CONTRACT_ID,
    cmux_version: cmuxVersion,
    new_split_response: splitResponse,
    new_surface_response: surfaceResponse,
    last_surface_pane: lastSurfacePane,
    capabilities: { "surface.create": true, "surface.close": true, "surface.send_key": true, "surface.respawn": true },
  };
  const temporary = path.join(path.dirname(FIXTURE_PATH), `.${path.basename(FIXTURE_PATH)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(temporary, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(temporary, FIXTURE_PATH);
}

async function live(): Promise<void> {
  if (process.env[LIVE_GATE] !== "1") throw new Error(`${LIVE_GATE}=1 is required; use --dry-run to inspect without mutation.`);
  const callerWorkspaceId = process.env.CMUX_WORKSPACE_ID?.trim();
  const callerSurfaceId = process.env.CMUX_SURFACE_ID?.trim();
  if (!callerWorkspaceId || !callerSurfaceId || !isCanonicalCmuxId(callerWorkspaceId) || !isCanonicalCmuxId(callerSurfaceId)) {
    throw new Error("run from a cmux terminal with canonical CMUX_WORKSPACE_ID and CMUX_SURFACE_ID");
  }

  const cmux = process.env.CMUX_BIN?.trim() || "cmux";
  const root = await privateRoot();
  const workspaceName = `pi-subagent-cmux-layout-phase0-${crypto.randomUUID()}`;
  const evidence: Evidence = { mode: "cmux-layout-phase0", minimumCmuxVersion: MINIMUM_CMUX_VERSION, workspaceName, commands: [], outcome: "failed" };
  let passed = false;
  let detectedCmuxVersion: string | null = null;
  let caller: Identity | null = null;
  let initial: Identity | null = null;
  let split: Identity | null = null;
  let second: Identity | null = null;
  try {
    const version = await runCommand(cmux, ["--version"], evidence);
    detectedCmuxVersion = supportedVersion(version.stdout);
    if (version.code !== 0 || !detectedCmuxVersion) throw new Error(`cmux layout Phase 0 requires stable cmux >= ${MINIMUM_CMUX_VERSION}`);
    evidence.cmuxVersion = detectedCmuxVersion;
    const capabilities = await runCommand(cmux, ["--json", "capabilities"], evidence);
    if (capabilities.code !== 0 || !hasRequiredCapabilities(capabilities.stdout)) throw new Error("cmux capabilities did not advertise required surface methods");
    evidence.capabilities = "required-surface-methods";

    const callerTopology = await readTopology(cmux, evidence);
    caller = findIdentity(callerTopology, callerWorkspaceId, callerSurfaceId);
    if (!caller) throw new Error("caller does not resolve to one canonical workspace/pane/surface identity");
    evidence.callerBefore = "present";

    const created = await runCommand(cmux, ["--json", "--id-format", "both", "new-workspace", "--name", workspaceName, "--cwd", root, "--focus", "false"], evidence);
    initial = await recoverWorkspace(cmux, workspaceName, created.code === 0 ? workspaceFromCreateResponse(created.stdout, workspaceName) : null, evidence);
    if (!disjoint(initial, caller)) throw new Error("recovered private workspace overlaps caller identity");
    evidence.workspaceRecovery = "canonical-name-tree";

    const splitResult = await runCommand(cmux, ["--json", "--id-format", "both", "new-split", "right", "--workspace", initial.workspaceId, "--surface", initial.surfaceId, "--focus", "false"], evidence);
    split = directHandle(splitResult, "new-split");
    const splitResponse = sanitizeCreatedCmuxSurfaceResponse(splitResult.stdout);
    if (!splitResponse) throw new Error("new-split response could not be sanitized without changing its envelope");
    if (!cmuxIdsEqual(split.workspaceId, initial.workspaceId) || !disjoint(split, caller)) throw new Error("new-split left private workspace or overlaps caller identity");

    const secondResult = await runCommand(cmux, ["--json", "--id-format", "both", "new-surface", "--workspace", split.workspaceId, "--pane", split.paneId, "--working-directory", root, "--focus", "false"], evidence);
    second = directHandle(secondResult, "new-surface");
    const surfaceResponse = sanitizeCreatedCmuxSurfaceResponse(secondResult.stdout);
    if (!surfaceResponse) throw new Error("new-surface response could not be sanitized without changing its envelope");
    assertSameWorkspacePane(split, second);
    if (!disjoint(second, caller)) throw new Error("new-surface overlaps caller identity");

    if ((await runCommand(cmux, ["send-key", "--workspace", second.workspaceId, "--surface", second.surfaceId, "escape"], evidence)).code !== 0) throw new Error("send-key capability probe failed");
    if ((await runCommand(cmux, ["respawn-pane", "--workspace", second.workspaceId, "--surface", second.surfaceId, "--command", "exec sleep 600"], evidence)).code !== 0) throw new Error("harmless second-surface respawn failed");

    if ((await runCommand(cmux, ["close-surface", "--workspace", second.workspaceId, "--surface", second.surfaceId], evidence)).code !== 0) throw new Error("second surface close failed");
    const afterSecond = await readTopology(cmux, evidence);
    const splitWorkspace = afterSecond.find((workspace) => cmuxIdsEqual(workspace.workspaceId, split!.workspaceId));
    const splitPane = splitWorkspace?.panes.find((pane) => cmuxIdsEqual(pane.paneId, split!.paneId));
    if (!splitPane || splitPane.surfaceIds.length !== 1 || !cmuxIdsEqual(splitPane.surfaceIds[0], split.surfaceId)) throw new Error("second surface close did not leave the recorded first surface alone in its pane");

    if ((await runCommand(cmux, ["close-surface", "--workspace", split.workspaceId, "--surface", split.surfaceId], evidence)).code !== 0) throw new Error("first surface close failed");
    const afterFirst = await readTopology(cmux, evidence);
    const afterFirstWorkspace = afterFirst.find((workspace) => cmuxIdsEqual(workspace.workspaceId, split!.workspaceId));
    const afterFirstPane = afterFirstWorkspace?.panes.find((pane) => cmuxIdsEqual(pane.paneId, split!.paneId));
    const lastSurfacePane = afterFirstPane === undefined ? "removed" : afterFirstPane.surfaceIds.length === 0 ? "empty" : null;
    if (!lastSurfacePane) throw new Error("last-surface pane was neither removed nor empty");
    evidence.lastSurfacePane = lastSurfacePane;

    assertKnownFinalTopology(afterFirst, workspaceName, caller, initial, split, lastSurfacePane);
    const callerAtFinalProof = findIdentity(afterFirst, caller.workspaceId, caller.surfaceId);
    if (!callerAtFinalProof || !cmuxIdsEqual(callerAtFinalProof.paneId, caller.paneId)) throw new Error("caller is not preserved at final workspace-close proof");
    if ((await runCommand(cmux, ["close-workspace", "--workspace", initial.workspaceId], evidence)).code !== 0) throw new Error("exact private workspace close failed");
    const finalTopology = await readTopology(cmux, evidence);
    if (finalTopology.some((workspace) => cmuxIdsEqual(workspace.workspaceId, initial!.workspaceId) || workspace.name === workspaceName)) throw new Error("private workspace remains after exact close");
    if (!findIdentity(finalTopology, caller.workspaceId, caller.surfaceId)) throw new Error("caller was not preserved after private workspace close");

    await atomicallyWriteFixture(detectedCmuxVersion, splitResponse, surfaceResponse, lastSurfacePane);
    evidence.outcome = "passed";
    evidence.fixture = path.basename(FIXTURE_PATH);
    passed = true;
  } catch (error) {
    evidence.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    if (!passed && caller && initial) {
      const known = [initial, ...(split ? [split] : []), ...(second ? [second] : [])];
      evidence.failureCleanup = await cleanupKnownFailedWorkspace(cmux, evidence, workspaceName, caller, initial, known).catch(() => false);
    }
    await writeEvidence(root, evidence).catch(() => undefined);
    if (passed) {
      await fs.promises.rm(root, { recursive: true, force: true });
      console.log(JSON.stringify({ outcome: "passed", fixture: path.relative(ROOT, FIXTURE_PATH) }));
    } else {
      console.error(`cmux layout Phase 0 evidence retained: ${path.join(root, "evidence.json")}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  if (options.dryRun) {
    console.log(JSON.stringify({ mode: "cmux-layout-phase0", dryRun: true, mutation: "none", requiredGate: LIVE_GATE, fixture: path.relative(ROOT, FIXTURE_PATH) }));
    return;
  }
  await live();
}

if (import.meta.main) main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
