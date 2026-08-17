import {
  parseCancellationFence,
  parseCompletionFence,
  parseCompletionFenceAck,
  publishImmutableJson,
  readBoundedPrivateJson,
  readBrokerArtifact,
  type CancellationFenceV1,
  type CompletionFenceAckV1,
  type CompletionFenceV1,
} from "./run-protocol.js";

export interface CompletionFencePaths {
  completionFencePath: string;
  completionFenceAckPath: string;
}

/** Malformed/replaced immutable authority, distinct from recoverable I/O errors. */
export class CompletionFenceAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionFenceAuthorityError";
  }
}

/** The child completion lost the shared immutable winner race to cancellation. */
export class CancellationFenceAuthorityError extends CompletionFenceAuthorityError {
  constructor(readonly fence: CancellationFenceV1) {
    super("cancellation fence authority won");
    this.name = "CancellationFenceAuthorityError";
  }
}

type CompletionFenceWinner =
  | { kind: "completion"; fence: CompletionFenceV1 }
  | { kind: "cancellation"; fence: CancellationFenceV1 };

/** Construct the immutable child-to-parent callback fence record. */
export function createCompletionFence(runId: string, nonce: string, publishedAt = Date.now()): CompletionFenceV1 {
  return { version: 1, kind: "completion-fence", runId, nonce, publishedAt };
}

/** Construct the immutable parent cancellation winner for one exact child identity. */
export function createCancellationFence(runId: string, childPid: number, childStartedAt: number, claimedAt = Date.now()): CancellationFenceV1 {
  return { version: 1, kind: "cancellation-fence", runId, childPid, childStartedAt, claimedAt };
}

/** Construct the immutable parent acknowledgement for an exact callback fence. */
export function createCompletionFenceAck(runId: string, nonce: string, acknowledgedAt = Date.now()): CompletionFenceAckV1 {
  return { version: 1, kind: "completion-fence-ack", runId, nonce, acknowledgedAt };
}

/** Read the shared immutable winner; any non-winner shape is fail-closed authority. */
async function readCompletionFenceWinner(
  paths: Pick<CompletionFencePaths, "completionFencePath">,
  runId: string,
  nonce?: string,
): Promise<CompletionFenceWinner | null> {
  const artifact = await readBrokerArtifact(paths.completionFencePath);
  if (artifact.outcome === "missing") return null;
  if (artifact.outcome !== "valid") throw new CompletionFenceAuthorityError("completion fence authority is malformed");
  const completion = parseCompletionFence(artifact.value, runId, nonce);
  if (completion) return { kind: "completion", fence: completion };
  const cancellation = parseCancellationFence(artifact.value, runId);
  if (cancellation) return { kind: "cancellation", fence: cancellation };
  throw new CompletionFenceAuthorityError("completion fence authority is malformed");
}

/** Read and validate an already published child fence; absence is distinct from malformed authority. */
export async function readVerifiedCompletionFence(
  paths: Pick<CompletionFencePaths, "completionFencePath">,
  runId: string,
  nonce: string,
): Promise<CompletionFenceV1 | null> {
  const winner = await readCompletionFenceWinner(paths, runId, nonce);
  if (!winner) return null;
  if (winner.kind === "cancellation") throw new CancellationFenceAuthorityError(winner.fence);
  return winner.fence;
}

/** Publish (if absent) then reread and validate the exact immutable child fence. */
export async function publishAndVerifyCompletionFence(
  paths: Pick<CompletionFencePaths, "completionFencePath">,
  runId: string,
  nonce: string,
): Promise<CompletionFenceV1> {
  const existing = await readVerifiedCompletionFence(paths, runId, nonce);
  if (existing) return existing;
  await publishImmutableJson(paths.completionFencePath, createCompletionFence(runId, nonce));
  const fence = await readVerifiedCompletionFence(paths, runId, nonce);
  if (!fence) throw new CompletionFenceAuthorityError("completion fence was not durably verified");
  return fence;
}

/**
 * Atomically elect cancellation at the same pathname as child completion.
 * Only an exact reread of this claim grants process-signal authority.
 */
export async function claimCancellationFence(
  paths: Pick<CompletionFencePaths, "completionFencePath">,
  runId: string,
  childPid: number,
  childStartedAt: number,
): Promise<"claimed" | "completion-won" | "revoked"> {
  const exact = createCancellationFence(runId, childPid, childStartedAt);
  const classifyWinner = async (): Promise<"claimed" | "completion-won" | "revoked" | "missing"> => {
    try {
      const winner = await readCompletionFenceWinner(paths, runId);
      if (!winner) return "missing";
      if (winner.kind === "completion") return "completion-won";
      return winner.fence.childPid === exact.childPid && winner.fence.childStartedAt === exact.childStartedAt
        && winner.fence.claimedAt === exact.claimedAt ? "claimed" : "revoked";
    } catch { return "revoked"; }
  };
  const before = await classifyWinner();
  if (before !== "missing") return before;
  try { await publishImmutableJson(paths.completionFencePath, exact); } catch { return "revoked"; }
  const after = await classifyWinner();
  return after === "missing" ? "revoked" : after;
}

/** Publish and reread the acknowledgement bound to an already verified child fence. */
export async function publishAndVerifyCompletionFenceAck(
  paths: Pick<CompletionFencePaths, "completionFenceAckPath">,
  fence: Pick<CompletionFenceV1, "runId" | "nonce">,
): Promise<CompletionFenceAckV1> {
  await publishImmutableJson(paths.completionFenceAckPath, createCompletionFenceAck(fence.runId, fence.nonce));
  const acknowledged = parseCompletionFenceAck(
    await readBoundedPrivateJson(paths.completionFenceAckPath, { requireSingleLineTerminated: true }),
    fence.runId,
    fence.nonce,
  );
  if (!acknowledged) throw new CompletionFenceAuthorityError("completion fence acknowledgement is malformed");
  return acknowledged;
}
