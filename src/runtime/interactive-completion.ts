import * as fs from "node:fs/promises";
import { emptyAccountingUsage } from "../core/accounting-usage.js";
import { emptyUsage, getFinalOutput, type SingleResult } from "../core/types.js";
import {
  parseAllocationRecordV2,
  parseCommittedLaunchRecordV2,
  parseRunState,
  publishCompletionRecordV3,
  readBoundedPrivateJson,
  readBrokerJson,
  type CompletionEvidenceRefV3,
  type CompletionRecord,
  type ObserverCompletionErrorCodeV3,
  type RunArtifactPaths,
} from "./run-protocol.js";
import {
  computeSessionFailureBoundary,
  MAX_COMPLETION_SESSION_ENTRY_BYTES,
  readVerifiedSessionCompletionSuffix,
  readVerifiedSessionFailureSuffix,
  type SessionFileIdentity,
} from "./completion-v3.js";
import { createSessionTailState, drainSessionJsonl } from "./session-tail.js";

export type ParentCompletionStatus = "failed" | "aborted";
export type ParentCompletionErrorCode = "parent-aborted" | "wrapper-exited" | "pane-missing" | "inspect-exhausted" | "launch-failed";

/** Immutable completion authority values must match exactly before target mutation. */
export function sameCompletionWinner(left: CompletionRecord, right: CompletionRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Apply only terminal presentation/status state; transcript replay remains separate. */
export function applyInteractiveCompletionStatus(
  result: SingleResult,
  completion: Pick<CompletionRecord, "status">,
): void {
  switch (completion.status) {
    case "completed":
      result.exitCode = 0;
      result.sawAgentEnd = true;
      if (!getFinalOutput(result.messages).trim()) {
        result.exitCode = 1;
        result.stopReason = "error";
        result.errorMessage = "Subagent settled without a final assistant response.";
      }
      break;
    case "failed":
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage ||= result.stderr.trim() || "Subagent failed.";
      break;
    case "aborted":
      result.exitCode = 130;
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted.";
      break;
    case "orphaned":
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = "Subagent stopped after its parent lease expired.";
      break;
  }
}

/** Collect parent-observed evidence and publish a single immutable terminal authority record. */
export async function publishParentObserverCompletion(
  paths: RunArtifactPaths,
  runId: string,
  status: ParentCompletionStatus,
  errorCode: ParentCompletionErrorCode,
  expectedSessionIdentity?: SessionFileIdentity,
  fileExists: (filePath: string) => Promise<boolean> = async (filePath) => {
    try { await fs.access(filePath); return true; } catch { return false; }
  },
): Promise<{ completion: CompletionRecord; won: boolean }> {
  const mapped: ObserverCompletionErrorCodeV3 = errorCode === "parent-aborted" ? "parent-aborted"
    : errorCode === "wrapper-exited" ? "child-exited"
      : errorCode === "pane-missing" ? "surface-closed" : "transport-lost";
  const [allocation, launch, state, wrapperPresent] = await Promise.all([
    readBrokerJson(paths.allocationPath).then((value) => parseAllocationRecordV2(value, runId)),
    readBrokerJson(paths.launchPath).then((value) => parseCommittedLaunchRecordV2(value, runId, paths.runDir)),
    readBoundedPrivateJson(paths.statePath).then((value) => parseRunState(value, runId)).catch(() => null),
    fileExists(paths.wrapperStatusPath),
  ]);
  const evidenceRefs: CompletionEvidenceRefV3[] = [];
  if (allocation) evidenceRefs.push("allocation");
  if (launch) evidenceRefs.push("launch");
  if (state) evidenceRefs.push("state");
  if (errorCode === "wrapper-exited" && wrapperPresent) evidenceRefs.push("wrapper-status");
  if (errorCode === "pane-missing") evidenceRefs.push("target-snapshot");
  evidenceRefs.sort();
  if (evidenceRefs.length === 0) throw new Error("Parent completion has no verified evidence reference.");
  const session = await computeSessionFailureBoundary(paths.childSessionPath, { expectedSessionIdentity }).catch(() => null);
  const record = { version: 3 as const, runId, producer: "parent" as const, status, completedAt: Date.now(), errorCode: mapped, evidenceRefs, ...(session ? { session } : {}) };
  const completion = await publishCompletionRecordV3(paths.completionPath, record);
  return { completion, won: completion.version === 3 && completion.producer === "parent" && completion.status === record.status && completion.completedAt === record.completedAt && completion.errorCode === record.errorCode };
}

/** Verify a descriptor-bound terminal suffix and replay it into a fresh result. */
export async function applyVerifiedInteractiveCompletion(options: {
  result: SingleResult;
  completion: CompletionRecord;
  childSessionPath: string;
  sessionResultStartOffset: number;
  configuredModel?: string;
  onUpdate: () => void;
  expectedSessionIdentity?: SessionFileIdentity;
}): Promise<boolean> {
  const { result, completion } = options;
  const session = completion.version === 3 && "session" in completion ? completion.session : undefined;
  if (completion.version === 3 && !session) {
    applyInteractiveCompletionStatus(result, completion);
    return false;
  }
  if (session) {
    const verified = completion.version === 3 && completion.producer === "child" && completion.status === "completed"
      ? await readVerifiedSessionCompletionSuffix(options.childSessionPath, session, options.sessionResultStartOffset, { expectedSessionIdentity: options.expectedSessionIdentity })
      : await readVerifiedSessionFailureSuffix(options.childSessionPath, session, options.sessionResultStartOffset, { expectedSessionIdentity: options.expectedSessionIdentity });
    if (!verified) return false;
    try {
      const finalResult: SingleResult = {
        ...result,
        exitCode: -1,
        messages: [],
        usage: emptyUsage(),
        accountingUsage: emptyAccountingUsage(),
        model: options.configuredModel,
        stopReason: undefined,
        errorMessage: undefined,
        sawAgentEnd: undefined,
      };
      const finalState = { ...createSessionTailState(), offset: options.sessionResultStartOffset };
      try {
        const finalDrain = await drainSessionJsonl({
          filePath: options.childSessionPath,
          state: finalState,
          result: finalResult,
          final: true,
          maxOffset: session.byteOffset,
          verifiedBytes: verified.bytes,
          maxCompleteEntryBytes: MAX_COMPLETION_SESSION_ENTRY_BYTES,
        });
        Object.assign(result, finalResult);
        if (finalDrain.resultChanged) options.onUpdate();
      } catch {
        return false;
      }
    } finally {
      verified.release();
    }
  }
  applyInteractiveCompletionStatus(result, completion);
  return true;
}
