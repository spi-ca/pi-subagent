import * as path from "node:path";
import type { RunArtifactPaths } from "../../src/runtime/run-protocol";

const ACCEPTANCE_ALLOCATION_CHECKPOINT_BASENAME = "acceptance-allocation-checkpoint.json";

/** Test-only checkpoint path; not part of the production run artifact contract. */
export function acceptanceAllocationCheckpointPath(pathsOrRunDir: Pick<RunArtifactPaths, "runDir"> | string): string {
  return path.join(typeof pathsOrRunDir === "string" ? pathsOrRunDir : pathsOrRunDir.runDir, ACCEPTANCE_ALLOCATION_CHECKPOINT_BASENAME);
}
