import {
  parseCompletionFence,
  parseCompletionFenceAck,
  publishImmutableJson,
  readBoundedPrivateJson,
  readBrokerArtifact,
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

/** Construct the immutable child-to-parent callback fence record. */
export function createCompletionFence(runId: string, nonce: string, publishedAt = Date.now()): CompletionFenceV1 {
  return { version: 1, kind: "completion-fence", runId, nonce, publishedAt };
}

/** Construct the immutable parent acknowledgement for an exact callback fence. */
export function createCompletionFenceAck(runId: string, nonce: string, acknowledgedAt = Date.now()): CompletionFenceAckV1 {
  return { version: 1, kind: "completion-fence-ack", runId, nonce, acknowledgedAt };
}

/** Read and validate an already published fence; absence is distinct from malformed authority. */
export async function readVerifiedCompletionFence(
  paths: Pick<CompletionFencePaths, "completionFencePath">,
  runId: string,
  nonce: string,
): Promise<CompletionFenceV1 | null> {
  const artifact = await readBrokerArtifact(paths.completionFencePath);
  if (artifact.outcome === "missing") return null;
  const fence = artifact.outcome === "valid" ? parseCompletionFence(artifact.value, runId, nonce) : null;
  if (!fence) throw new CompletionFenceAuthorityError("completion fence authority is malformed");
  return fence;
}

/** Publish (if absent) then reread and validate the exact immutable fence. */
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

/** Publish and reread the acknowledgement bound to an already verified fence. */
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
