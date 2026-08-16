import * as crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_PARENT_LEASE_RENEW_MS,
	DEFAULT_PARENT_LEASE_STALE_MS,
	RUN_PROTOCOL_VERSION,
	SUBAGENT_CHILD_SESSION_PATH_ENV,
	SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV,
	SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV,
	SUBAGENT_LEASE_CHECK_MS_ENV,
	SUBAGENT_LEASE_STALE_MS_ENV,
	SUBAGENT_EXPECTED_PARENT_PID_ENV,
	SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
	SUBAGENT_FORK_BOOTSTRAP_PATH_ENV,
	SUBAGENT_PARENT_LEASE_PATH_ENV,
	SUBAGENT_RUN_COMPLETION_PATH_ENV,
	SUBAGENT_COMPLETION_FENCE_PATH_ENV,
	SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV,
	SUBAGENT_COMPLETION_FENCE_NONCE_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_RUN_OWNERSHIP_ENV,
	SUBAGENT_PROMOTION_REQUEST_PATH_ENV,
	SUBAGENT_PROMOTION_ACK_PATH_ENV,
	SUBAGENT_RUN_STATE_PATH_ENV,
	atomicWriteJson,
	getCurrentProcessStartedAt,
	isUsableParentLease,
	isParentProcessIdentityAlive,
	classifyParentProcessIdentity,
	parseCompletionFence,
	parseCompletionFenceAck,
	hasV3FailureBoundaryCapability,
	hasV3MetadataTailSuccessBoundaryCapability,
	parseParentLease,
	parseOwnershipTransferRequest,
	parseOwnershipTransferAck,
	sameOwnershipTransfer,
	publishImmutableJson,
	readBoundedPrivateJson,
	readBrokerArtifact,
	type BrokerArtifactRead,
	type ParentProcessIdentityChecker,
	type ProcessIdentityProbeOptions,
	type ProcessIdentityStatus,
	publishCompletionRecordV3,
	readJsonFile,
	type ChildCompletionErrorCodeV3,
	type CompletionRecord,
	type RunOwnership,
	type RunPhase,
	type RunStateV1,
} from "./run-protocol.js";
import { verifyAndAcknowledgeForkBootstrap } from "./fork-source-ownership.js";
import { adoptTreePermitAuthority, TREE_PERMIT_LEASE_ID_ENV, TREE_PERMIT_LEASE_TOKEN_ENV, TREE_PERMIT_ROOT_ENV } from "./tree-permit-authority.js";
import { computeLegacySessionCompletionBoundary, computeSessionCompletionBoundary, computeSessionFailureBoundary } from "./completion-v3.js";
import { LifecycleEventClient } from "./lifecycle-socket.js";
import { capturePhase0LiveProofClientEnv, MAX_PHASE0_LIVE_PROOF_RELEASE_WINDOW_MS, parsePhase0LiveProofReleaseDeadline, PHASE0_LIVE_PROOF_BARRIER_PATH_ENV, PHASE0_LIVE_PROOF_BEHAVIOR_ENV, PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV, PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV, Phase0LiveProofClient } from "./phase0-live-proof.js";

interface BridgeConfig {
	runId: string;
	statePath: string;
	completionPath: string;
	/** All three are absent only for a legacy parent launch. */
	completionFencePath?: string;
	completionFenceAckPath?: string;
	completionFenceNonce?: string;
	parentLeasePath: string;
	promotionRequestPath: string;
	promotionAckPath: string;
	allocationPath: string;
	childSessionPath: string;
	ownership: RunOwnership;
	/** Only a newer parent explicitly opts this child into boundary-bearing V3 failures. */
	failureBoundaryCapability: boolean;
	/** Only a newer parent accepts success boundaries ending in linked Pi metadata. */
	metadataTailSuccessBoundaryCapability: boolean;
	expectedParentPid?: number;
	expectedParentStartedAt?: number;
	leaseStaleMs: number;
	leaseCheckMs: number;
}

interface LastAssistantStatus {
	stopReason?: string;
	hasText: boolean;
}

const SUBAGENT_MANAGED_TITLE_ENV = "PI_SUBAGENT_MANAGED_TITLE";
const RUNTIME_TITLE_LIFECYCLE_STATES = ["queued", "ready", "running", "waiting", "returning", "failed"] as const;
type RuntimeTitleLifecycleState = typeof RUNTIME_TITLE_LIFECYCLE_STATES[number];
const RUNTIME_TITLE_MAX_LENGTH = 96;
const RUNTIME_TITLE_MAX_BASE_LENGTH = RUNTIME_TITLE_MAX_LENGTH
	- Math.max(...RUNTIME_TITLE_LIFECYCLE_STATES.map((state) => ` · ${state}`.length));
function resolveRuntimeTitle(env: NodeJS.ProcessEnv): string | null {
	const title = env[SUBAGENT_MANAGED_TITLE_ENV];
	// The wrapper and bridge must retain one exact base rather than independently
	// truncating it for lifecycle suffixes.
	return title && new RegExp(`^[\\x20-\\x7e]{1,${RUNTIME_TITLE_MAX_BASE_LENGTH}}$`).test(title) ? title : null;
}

type MessageEndRegistrar = (
  event: "message_end",
  handler: (event: { message?: unknown }) => void | Promise<void>,
) => void;

type AgentSettledRegistrar = (
	event: "agent_settled",
	handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
) => void;

function parsePositiveInt(raw: string | undefined, fallback: number, minimum: number): number {
	if (!raw || !/^\d+$/.test(raw.trim())) return fallback;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function parsePositiveNumber(raw: string | undefined): number | null {
	if (!raw || !/^\d+$/.test(raw)) return null;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveBridgeConfig(env: NodeJS.ProcessEnv): BridgeConfig | null {
	const runId = env[SUBAGENT_RUN_ID_ENV]?.trim();
	const statePath = env[SUBAGENT_RUN_STATE_PATH_ENV]?.trim();
	const completionPath = env[SUBAGENT_RUN_COMPLETION_PATH_ENV]?.trim();
	const parentLeasePath = env[SUBAGENT_PARENT_LEASE_PATH_ENV]?.trim();
	const childSessionPath = env[SUBAGENT_CHILD_SESSION_PATH_ENV]?.trim();
	if (!runId || !statePath || !completionPath || !parentLeasePath || !childSessionPath) return null;
	const allPaths = [statePath, completionPath, parentLeasePath, childSessionPath];
	if (allPaths.some((candidate) => !path.isAbsolute(candidate))) return null;
	const runDir = path.dirname(statePath);
	if (allPaths.some((candidate) => path.dirname(candidate) !== runDir)) return null;
	if (path.basename(runDir) !== runId) return null;
	if (path.basename(statePath) !== "state.json" || path.basename(completionPath) !== "complete.json") return null;
	if (path.basename(parentLeasePath) !== "parent-lease.json" || path.basename(childSessionPath) !== "child-session.jsonl") return null;
	const ownership = env[SUBAGENT_RUN_OWNERSHIP_ENV] === "detached" ? "detached" : "parent-owned";
	const completionFencePath = env[SUBAGENT_COMPLETION_FENCE_PATH_ENV]?.trim();
	const completionFenceAckPath = env[SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV]?.trim();
	const completionFenceNonce = env[SUBAGENT_COMPLETION_FENCE_NONCE_ENV]?.trim();
	// Compatibility accepts the old all-absent shape only. Partial fence
	// configuration could otherwise silently reopen post-boundary callbacks.
	if ((completionFencePath === undefined) !== (completionFenceAckPath === undefined)
		|| (completionFencePath === undefined) !== (completionFenceNonce === undefined)) return null;
	if (completionFencePath !== undefined && (!path.isAbsolute(completionFencePath) || !path.isAbsolute(completionFenceAckPath!)
		|| path.dirname(completionFencePath) !== runDir || path.dirname(completionFenceAckPath!) !== runDir
		|| path.basename(completionFencePath) !== "completion-fence.json" || path.basename(completionFenceAckPath!) !== "completion-fence-ack.json"
		|| !/^[a-f0-9]{64}$/.test(completionFenceNonce!))) return null;
	const requestEnv = env[SUBAGENT_PROMOTION_REQUEST_PATH_ENV]?.trim();
	const ackEnv = env[SUBAGENT_PROMOTION_ACK_PATH_ENV]?.trim();
	// Older parent launches did not export these names. Their only accepted
	// compatibility shape is both absent and the exact run-local defaults.
	if ((requestEnv === undefined) !== (ackEnv === undefined)) return null;
	const promotionRequestPath = requestEnv ?? path.join(runDir, "promotion-request.json");
	const promotionAckPath = ackEnv ?? path.join(runDir, "promotion-ack.json");
	const allocationPath = path.join(runDir, "allocation.json");
	if (!path.isAbsolute(promotionRequestPath) || !path.isAbsolute(promotionAckPath)
		|| path.dirname(promotionRequestPath) !== runDir || path.dirname(promotionAckPath) !== runDir
		|| path.basename(promotionRequestPath) !== "promotion-request.json" || path.basename(promotionAckPath) !== "promotion-ack.json") return null;
	const failureBoundaryCapability = hasV3FailureBoundaryCapability(env[SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV]);
	const metadataTailSuccessBoundaryCapability = hasV3MetadataTailSuccessBoundaryCapability(env[SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV]);
	const expectedParentPid = parsePositiveNumber(env[SUBAGENT_EXPECTED_PARENT_PID_ENV]);
	const expectedParentStartedAt = parsePositiveNumber(env[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV]);
	// Parent-owned bridges must bind the renewable lease to the immutable intent
	// identity provided by the parent bootstrap, before any OS PID probe.
	if (ownership === "parent-owned" && (expectedParentPid === null || expectedParentStartedAt === null)) return null;
	return {
		runId,
		statePath,
		completionPath,
		...(completionFencePath === undefined ? {} : { completionFencePath, completionFenceAckPath: completionFenceAckPath!, completionFenceNonce: completionFenceNonce! }),
		parentLeasePath,
		promotionRequestPath,
		promotionAckPath,
		allocationPath,
		childSessionPath,
		ownership,
		failureBoundaryCapability,
		metadataTailSuccessBoundaryCapability,
		...(ownership === "parent-owned" ? { expectedParentPid: expectedParentPid!, expectedParentStartedAt: expectedParentStartedAt! } : {}),
		leaseStaleMs: parsePositiveInt(env[SUBAGENT_LEASE_STALE_MS_ENV], DEFAULT_PARENT_LEASE_STALE_MS, 100),
		leaseCheckMs: parsePositiveInt(env[SUBAGENT_LEASE_CHECK_MS_ENV], DEFAULT_PARENT_LEASE_RENEW_MS, 20),
	};
}

function getLastAssistantStatus(messages: unknown): LastAssistantStatus {
	if (!Array.isArray(messages)) return { hasText: false };
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
		const assistant = message as { content?: unknown; stopReason?: unknown };
		const hasText = Array.isArray(assistant.content) && assistant.content.some(
			(part) => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string" && Boolean((part as { text: string }).text.trim()),
		);
		return {
			hasText,
			stopReason: typeof assistant.stopReason === "string" ? assistant.stopReason : undefined,
		};
	}
	return { hasText: false };
}

const PHASE0_READ_MAX_BYTES = 4096;
/** This remains a short bounded post-frame inspection, never a second release deadline. */
const PHASE0_EXTRA_PAYLOAD_GRACE_MS = 25;

type Phase0FileIdentity = { dev: string; ino: string; uid: string; mode: number };

type Phase0Stat = { dev: number | bigint; ino: number | bigint; uid: number | bigint; mode: number | bigint; isFIFO(): boolean; isSymbolicLink(): boolean };
function phase0FileIdentity(stat: Phase0Stat): Phase0FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), uid: String(stat.uid), mode: Number(stat.mode) };
}

function samePhase0FileIdentity(left: Phase0FileIdentity, right: Phase0FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
}

function assertPrivatePhase0Fifo(stat: Phase0Stat, expectedOwner: number | undefined): Phase0FileIdentity {
  if (!stat.isFIFO() || stat.isSymbolicLink() || (Number(stat.mode) & 0o777) !== 0o600 || (expectedOwner !== undefined && Number(stat.uid) !== expectedOwner)) {
    throw new Error("Phase 0 benchmark read target is not an owned private FIFO.");
  }
  return phase0FileIdentity(stat);
}

/**
 * Reads exactly the assigned FIFO while proving pathname/descriptor identity on both sides of I/O.
 * O_RDWR avoids blocking before the descriptor can be validated and the authenticated read-start
 * can be emitted; ordinary reads do not write through this descriptor, so they block for harness release.
 */
export async function readAssignedPhase0Barrier(barrierPath: string, requestedPath: string, releaseToken: string, releaseDeadline: number, signal?: AbortSignal, onReadStart?: () => void): Promise<number> {
  if (signal?.aborted) throw new Error("Operation aborted.");
  if (!Number.isSafeInteger(releaseDeadline) || releaseDeadline <= Date.now() || releaseDeadline - Date.now() > MAX_PHASE0_LIVE_PROOF_RELEASE_WINDOW_MS) throw new Error("Phase 0 benchmark release deadline expired.");
  if (!/^[0-9a-f]{64}$/.test(releaseToken)) throw new Error("Phase 0 benchmark release token is invalid.");
  if (!path.isAbsolute(requestedPath) || requestedPath !== barrierPath) throw new Error("Phase 0 benchmark read accepts only its assigned absolute barrier path.");
  const parent = path.dirname(barrierPath);
  const canonicalParent = await fs.realpath(parent);
  if (canonicalParent !== parent || path.join(canonicalParent, path.basename(barrierPath)) !== barrierPath) {
    throw new Error("Phase 0 benchmark barrier parent is not canonical.");
  }
  const expectedOwner = typeof process.getuid === "function" ? process.getuid() : undefined;
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0 || (expectedOwner !== undefined && parentStat.uid !== expectedOwner)) {
    throw new Error("Phase 0 benchmark barrier parent is not private.");
  }
  const before = assertPrivatePhase0Fifo(await fs.lstat(barrierPath), expectedOwner);
  const noFollow = fsConstants.O_NOFOLLOW;
  if (typeof noFollow !== "number") throw new Error("Phase 0 benchmark requires O_NOFOLLOW support.");
  // O_RDWR retains the self-writer hold semantics: no harness writer means no
  // EOF. O_NONBLOCK lets the bounded reader distinguish a fragmented frame from
  // a truncated one without an unabortable second read.
  const handle = await fs.open(barrierPath, fsConstants.O_RDWR | fsConstants.O_NONBLOCK | noFollow);
  let abortWake: Promise<void> | undefined;
  const wakeBlockedRead = () => {
    abortWake ??= handle.write(Buffer.from([0]), 0, 1, null).then(() => undefined, () => undefined);
    return abortWake;
  };
  const abort = () => { void wakeBlockedRead(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const opened = assertPrivatePhase0Fifo(await handle.stat(), expectedOwner);
    if (!samePhase0FileIdentity(before, opened)) throw new Error("Phase 0 benchmark barrier changed before open.");
    if (signal?.aborted) throw new Error("Operation aborted.");
    onReadStart?.();
    const expected = Buffer.from(`${releaseToken}\n`, "ascii");
    const received: Buffer[] = [];
    let receivedBytes = 0, completeAt: number | null = null;
    while (true) {
      if (signal?.aborted) throw new Error("Operation aborted.");
      const now = Date.now();
      const inspectionDeadline = completeAt === null ? releaseDeadline : Math.min(releaseDeadline, completeAt + PHASE0_EXTRA_PAYLOAD_GRACE_MS);
      if (now >= inspectionDeadline) break;
      const buffer = Buffer.alloc(PHASE0_READ_MAX_BYTES);
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead > 0) {
          received.push(buffer.subarray(0, bytesRead)); receivedBytes += bytesRead;
          if (receivedBytes > expected.length) throw new Error("Phase 0 benchmark barrier payload has extra bytes.");
          if (receivedBytes === expected.length) completeAt ??= Date.now();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
      }
      const nextInspectionDeadline = completeAt === null ? releaseDeadline : Math.min(releaseDeadline, completeAt + PHASE0_EXTRA_PAYLOAD_GRACE_MS);
      if (Date.now() >= nextInspectionDeadline) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(5, Math.max(1, nextInspectionDeadline - Date.now())));
        const wake = () => { clearTimeout(timer); done(); };
        function done() { signal?.removeEventListener("abort", wake); resolve(); }
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
    if (signal?.aborted) throw new Error("Operation aborted.");
    if (receivedBytes !== expected.length) throw new Error("Phase 0 benchmark barrier payload is truncated before its release deadline.");
    if (!Buffer.concat(received, receivedBytes).equals(expected)) throw new Error("Phase 0 benchmark barrier payload does not match its assigned release token.");
    const after = assertPrivatePhase0Fifo(await fs.lstat(barrierPath), expectedOwner);
    const final = assertPrivatePhase0Fifo(await handle.stat(), expectedOwner);
    if (!samePhase0FileIdentity(before, after) || !samePhase0FileIdentity(opened, final) || !samePhase0FileIdentity(after, final)) throw new Error("Phase 0 benchmark barrier changed during read.");
    return receivedBytes;
  } finally {
    signal?.removeEventListener("abort", abort);
    await abortWake;
    await handle.close();
  }
}

function isBoundPhase0Provider(ctx: ExtensionContext | undefined): boolean | undefined {
  const model = ctx?.model;
  if (!model || model.provider === undefined) return undefined;
  return model.provider === "openai-codex" && (model.id === "gpt-5.4-mini" || model.name === "gpt-5.4-mini");
}

/** Capture/delete proof and barrier capabilities, then replace read for this child only. */
export function registerPhase0LiveProviderProof(pi: ExtensionAPI, env: NodeJS.ProcessEnv): Phase0LiveProofClient | null {
  const config = capturePhase0LiveProofClientEnv(env);
  if (!config) return null;
  const client = new Phase0LiveProofClient(config);
  const barrierPath = config[PHASE0_LIVE_PROOF_BARRIER_PATH_ENV];
  const releaseToken = config[PHASE0_LIVE_PROOF_RELEASE_TOKEN_ENV];
  const releaseDeadline = parsePhase0LiveProofReleaseDeadline(config[PHASE0_LIVE_PROOF_RELEASE_DEADLINE_ENV]);
  if (releaseDeadline === null) throw new Error("Phase 0 live proof release deadline is invalid.");
  const behavior = config[PHASE0_LIVE_PROOF_BEHAVIOR_ENV];
  const barrierIndexMatch = /^barrier-(0|[1-9][0-9]?)$/.exec(path.basename(barrierPath));
  const barrierIndex = barrierIndexMatch ? Number(barrierIndexMatch[1]) : null;
  if ((behavior === "short" || behavior === "long") && (barrierIndex === null || barrierIndex > 15)) {
    throw new Error("Phase 0 response barrier index is invalid.");
  }
  let published = false;
  // Some Pi tool execution contexts do not carry a model. Bind that execution
  // to the immediately preceding provider-authenticated assistant tool call.
  let lifecycleBoundReadPending = false;
  (pi.on as unknown as MessageEndRegistrar)("message_end", (event) => {
    const message = event.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const assistant = message as { role?: unknown; provider?: unknown; model?: unknown; content?: unknown };
    const hasReadCall = Array.isArray(assistant.content) && assistant.content.some((part) => Boolean(part) && typeof part === "object"
      && (part as { type?: unknown }).type === "toolCall" && (part as { name?: unknown }).name === "read");
    lifecycleBoundReadPending = assistant.role === "assistant" && assistant.provider === "openai-codex" && assistant.model === "gpt-5.4-mini" && hasReadCall;
  });
  pi.registerTool({
    name: "read",
    label: "read",
    description: "Read the assigned private Phase 0 benchmark FIFO.",
    parameters: Type.Object({ path: Type.String({ description: "Exact assigned absolute barrier FIFO path" }) }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const bytesRead = await readAssignedPhase0Barrier(barrierPath, params.path, releaseToken, releaseDeadline, signal, () => client.announceReadStart());
      const providerBound = isBoundPhase0Provider(ctx);
      if (!published && (providerBound === true || (providerBound === undefined && lifecycleBoundReadPending))) {
        published = true;
        lifecycleBoundReadPending = false;
        client.proveProviderRead();
      }
      if (behavior === "hold") {
        if (!signal) throw new Error("Phase 0 hold-after-proof requires an abort signal.");
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("Operation aborted."));
          if (signal.aborted) { abort(); return; }
          signal.addEventListener("abort", abort, { once: true });
        });
      }
      const continuation = behavior === "short"
        ? `Now return exactly SHORT_RESPONSE_${barrierIndex}.`
        : `Now return exactly one line beginning LONG_${barrierIndex}, followed by the 200 space-separated tokens word1 through word200 in order.`;
      return { content: [{ type: "text", text: `Read ${bytesRead} byte(s) from the assigned Phase 0 barrier. ${continuation}` }], details: { bytesRead } };
    },
  });
  return client;
}

export function registerChildBridge(
	pi: ExtensionAPI,
	options: {
		isProcessIdentityAlive?: ParentProcessIdentityChecker;
		/** Test seam for the bounded exact-parent probe used by completion fencing. */
		classifyParentProcessIdentity?: (parentPid: number, parentStartedAt: number, probeOptions?: ProcessIdentityProbeOptions) => ProcessIdentityStatus;
		/** Test-only seams; wall time remains the durable record clock. */
		monotonicNow?: () => number;
		readLease?: (filePath: string) => Promise<unknown | null>;
		/** Test seam: bypass filesystem verification only after a test supplied a verified bootstrap. */
		forkBootstrapPreverified?: boolean;
		verifyForkBootstrap?: (bootstrapPath: string) => Promise<unknown>;
		/** Test seam for proving recovery after ACK publication failure. */
		publishPromotionAck?: (filePath: string, value: unknown) => Promise<"published" | "exists">;
		/** Test seam for delayed ACK readback after an ambiguous publisher failure. */
		readPromotionAck?: (filePath: string) => Promise<unknown | null>;
		/** Test seam for fencing publication verification. */
		readCompletionFence?: (filePath: string) => Promise<unknown | null>;
		/** Test seam for completion-fence ACK artifact reads. */
		readCompletionFenceAck?: (filePath: string) => Promise<BrokerArtifactRead>;
		/** Test seam executed after fencing and immediately before the final completion check. */
		beforePromotionAckPublication?: () => Promise<void>;
		/** Test seam for transient exact inherited tree-permit release failures. */
		releaseInheritedTreePermit?: () => Promise<boolean>;
	} = {},
): void {
	const forkBootstrapPath = process.env[SUBAGENT_FORK_BOOTSTRAP_PATH_ENV];
	delete process.env[SUBAGENT_FORK_BOOTSTRAP_PATH_ENV];
	const verifyForkBootstrap = async (): Promise<boolean> => {
		if (!forkBootstrapPath || options.forkBootstrapPreverified) return true;
		try {
			await (options.verifyForkBootstrap ?? verifyAndAcknowledgeForkBootstrap)(forkBootstrapPath);
			return true;
		} catch {
			return false;
		}
	};
	const bootstrapGate = verifyForkBootstrap();
	const rejectUnverifiedBootstrap = async (ctx: ExtensionContext): Promise<boolean> => {
		if (await bootstrapGate) return true;
		ctx.abort();
		ctx.shutdown();
		return false;
	};
	const phase0ProofClient = registerPhase0LiveProviderProof(pi, process.env);
	const config = resolveBridgeConfig(process.env);
	// These are one-shot bridge capabilities. Keep their validated values in
	// config closures, but do not let arbitrary tools or nested subprocesses
	// inherit the paths or nonce after bridge initialization.
	delete process.env[SUBAGENT_COMPLETION_FENCE_PATH_ENV];
	delete process.env[SUBAGENT_COMPLETION_FENCE_ACK_PATH_ENV];
	delete process.env[SUBAGENT_COMPLETION_FENCE_NONCE_ENV];
	delete process.env[SUBAGENT_V3_FAILURE_BOUNDARY_CAPABILITY_ENV];
	delete process.env[SUBAGENT_V3_METADATA_TAIL_SUCCESS_BOUNDARY_CAPABILITY_ENV];
	const runtimeTitle = resolveRuntimeTitle(process.env);
	if (!config && !forkBootstrapPath && !phase0ProofClient) return;
	// Pi input is the hard launch boundary. A failed bootstrap consumes the
	// initial input and never permits an agent_start event.
	pi.on("input", async (_event, ctx) => await rejectUnverifiedBootstrap(ctx) ? undefined : { action: "handled" });
	if (!config) {
		pi.on("session_start", async (_event, ctx) => { if (await rejectUnverifiedBootstrap(ctx)) await phase0ProofClient?.start(); });
		pi.on("agent_start", async (_event, ctx) => { await rejectUnverifiedBootstrap(ctx); });
		pi.on("session_shutdown", async () => { phase0ProofClient?.close(); });
		return;
	}

	const setRuntimeTitle = (ctx: ExtensionContext, state: Exclude<RuntimeTitleLifecycleState, "queued">) => {
		if (!runtimeTitle || !ctx.hasUI) return;
		ctx.ui.setTitle(`${runtimeTitle} · ${state}`);
	};

	let sequence = 0;
	let agentStarted = false;
	let terminal = false;
	let checkerStopped = false;
	let checkerGeneration = 0;
	let checkerTimer: NodeJS.Timeout | undefined;
	let checkerInFlight: Promise<void> | null = null;
	let checkerPending = false;
	let pendingCheckerDue = 0;
	let missingLeaseSinceDue: number | null = null;
	let lastAssistant: LastAssistantStatus = { hasText: false };
	let writeChain = Promise.resolve();
	let lifecycleClient: LifecycleEventClient | null = null;
	let acknowledgementReconciliationTimer: NodeJS.Timeout | undefined;
	let ownership: RunOwnership = config.ownership;
	const monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
	const checkerEpoch = monotonicNow();
	let nextCheckerDue = checkerEpoch + config.leaseCheckMs;
	const checkerIdleWaiters: Array<() => void> = [];

	const queueWrite = (operation: () => Promise<void>) => {
		writeChain = writeChain.then(operation, operation);
		return writeChain;
	};
	const childStartedAt = getCurrentProcessStartedAt();
	if (childStartedAt === null) throw new Error("Unable to establish child process start identity.");
	const writeState = (phase: RunPhase, lastEvent: string) => queueWrite(async () => {
		sequence += 1;
		await atomicWriteJson(config.statePath, {
			version: RUN_PROTOCOL_VERSION, runId: config.runId, sequence, phase,
			updatedAt: Date.now(), childPid: process.pid, childStartedAt, lastEvent,
		} satisfies RunStateV1);
	});
	const publishCompletionFenceAndWaitForAck = async (fromChecker: boolean): Promise<void> => {
		if (!config.completionFencePath || !config.completionFenceAckPath || !config.completionFenceNonce) return;
		const fence = { version: 1 as const, kind: "completion-fence" as const, runId: config.runId, nonce: config.completionFenceNonce, publishedAt: Date.now() };
		await publishImmutableJson(config.completionFencePath, fence);
		// The deadline starts at the durable publication, not after any later
		// verification or parent-liveness observation.
		const ackDeadline = Date.now() + config.leaseStaleMs;
		const parentIsExactlyDead = () => {
			const remaining = ackDeadline - Date.now();
			if (remaining <= 0 || config.expectedParentPid === undefined || config.expectedParentStartedAt === undefined) return false;
			return (options.classifyParentProcessIdentity ?? classifyParentProcessIdentity)(
				config.expectedParentPid,
				config.expectedParentStartedAt,
				{ timeoutMs: remaining },
			) === "dead";
		};
		const deadlineFailure = () => new Error("completion fence acknowledgement deadline expired");
		// Filesystem promises cannot be cancelled. Attach a rejection observer before
		// racing so a read/open/lstat that finishes after the deadline is both ignored
		// and unable to become an unhandled rejection.
		const beforeAckDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
			const remaining = ackDeadline - Date.now();
			if (remaining <= 0) throw deadlineFailure();
			const pending = Promise.resolve().then(operation);
			void pending.catch(() => undefined);
			let timer: NodeJS.Timeout | undefined;
			const expired = Symbol("completion-fence-ack-deadline");
			try {
				const result = await Promise.race<T | typeof expired>([
					pending,
					new Promise<typeof expired>((resolve) => { timer = setTimeout(() => resolve(expired), remaining); }),
				]);
				if (result === expired || Date.now() >= ackDeadline) throw deadlineFailure();
				return result;
			} finally {
				if (timer) clearTimeout(timer);
			}
		};
		let published: ReturnType<typeof parseCompletionFence>;
		try {
			published = parseCompletionFence(await beforeAckDeadline(async () => await (options.readCompletionFence
				?? ((filePath: string) => readBoundedPrivateJson(filePath, { requireSingleLineTerminated: true })))(config.completionFencePath!)), config.runId, config.completionFenceNonce);
		} catch (error) {
			if (parentIsExactlyDead() && error instanceof Error && error.message === "completion fence acknowledgement deadline expired") return;
			throw error;
		}
		if (!published) throw new Error("completion fence was not durably verified");
		// Only an exact dead parent identity permits bypassing the ACK. A checker
		// failure can be caused by malformed or stalled lease I/O while the parent
		// monitor is still alive and capable of emitting callbacks.
		if (parentIsExactlyDead()) return;
		const cadenceMs = Math.max(20, Math.min(250, config.leaseCheckMs));
		// The durable fence starts one absolute ACK deadline. Lease reads are not
		// part of this wait: an indefinitely blocked filesystem read must not keep
		// a live parent PID from holding the child forever after callback fencing.
		while (true) {
			if (parentIsExactlyDead()) return;
			if (Date.now() >= ackDeadline) throw deadlineFailure();
			let ackArtifact: BrokerArtifactRead;
			try {
				ackArtifact = await beforeAckDeadline(async () => await (options.readCompletionFenceAck ?? readBrokerArtifact)(config.completionFenceAckPath!));
			} catch (error) {
				if (parentIsExactlyDead() && error instanceof Error && error.message === "completion fence acknowledgement deadline expired") return;
				throw error;
			}
			if (ackArtifact.outcome === "valid") {
				if (parseCompletionFenceAck(ackArtifact.value, config.runId, config.completionFenceNonce)) return;
				throw new Error("completion fence acknowledgement conflicts");
			}
			if (ackArtifact.outcome !== "missing") throw new Error("completion fence acknowledgement is malformed");
			if (parentIsExactlyDead()) return;
			const remaining = ackDeadline - Date.now();
			if (remaining <= 0) throw deadlineFailure();
			// This awaited handshake is terminal authority, so its regular timer must
			// keep the child alive until ACK, exact parent death, or its fixed fence
			// deadline. It intentionally never awaits the renewable lease file.
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(cadenceMs, remaining)));
		}
	};
	const writeCompletion = async (
		status: CompletionRecord["status"],
		errorCode?: ChildCompletionErrorCodeV3,
		stopReason?: string,
		fromChecker = false,
	): Promise<CompletionRecord> => {
		const publishFailure = async (
			failureStatus: Extract<CompletionRecord["status"], "failed" | "aborted" | "orphaned">,
			failureCode: ChildCompletionErrorCodeV3,
			failureStopReason: string | undefined,
			withBoundary = true,
		) => {
			const session = withBoundary && config.failureBoundaryCapability
				? await computeSessionFailureBoundary(config.childSessionPath).catch(() => null)
				: null;
			return await publishCompletionRecordV3(config.completionPath, {
				version: 3, runId: config.runId, producer: "child", status: failureStatus, completedAt: Date.now(),
				errorCode: failureCode, stopReason: failureStopReason?.slice(0, 256) ?? null, ...(session ? { session } : {}),
			});
		};
		try {
			await publishCompletionFenceAndWaitForAck(fromChecker);
		} catch {
			// A failed handshake is deliberately boundary-less: no live callback may
			// be treated as included when the parent could not prove its ACK.
			return await publishFailure("failed", "bridge-error", "completion-fence-unverified", false);
		}
		if (status === "completed") {
			const session = await (config.metadataTailSuccessBoundaryCapability
				? computeSessionCompletionBoundary(config.childSessionPath)
				: computeLegacySessionCompletionBoundary(config.childSessionPath)).catch(() => null);
			if (session) return await publishCompletionRecordV3(config.completionPath, {
				version: 3, runId: config.runId, producer: "child", status: "completed", completedAt: Date.now(), session,
			});
			return await publishFailure("failed", "bridge-error", "completion-boundary-unproven");
		}
		return await publishFailure(status, errorCode ?? "bridge-error", stopReason);
	};
	const reportBridgeError = (error: unknown) => {
		console.error(`[pi-subagent bridge] lifecycle write failed: ${error instanceof Error ? error.message : String(error)}`);
	};
	const resolveCheckerIdle = () => {
		if (checkerInFlight || checkerPending) return;
		while (checkerIdleWaiters.length) checkerIdleWaiters.pop()!();
	};
	const drainChecker = () => !checkerInFlight && !checkerPending
		? Promise.resolve() : new Promise<void>((resolve) => checkerIdleWaiters.push(resolve));
	const stopChecker = () => {
		checkerStopped = true;
		checkerGeneration += 1; // fences a raw read that completes after terminal.
		checkerPending = false;
		pendingCheckerDue = 0;
		if (checkerTimer) { clearTimeout(checkerTimer); checkerTimer = undefined; }
		resolveCheckerIdle();
	};
	const stopAndDrainChecker = async () => { stopChecker(); await drainChecker(); };

	const finish = async (
		ctx: ExtensionContext,
		status: CompletionRecord["status"],
		stopReason?: string,
		errorCode?: ChildCompletionErrorCodeV3,
		fromChecker = false,
	) => {
		if (terminal) return;
		setRuntimeTitle(ctx, status === "completed" ? "returning" : status === "failed" ? "failed" : "waiting");
		terminal = true;
		stopChecker();
		// The checker cannot await itself. Its raw I/O has already completed and
		// stopChecker fenced scheduling before this publication.
		if (!fromChecker) await drainChecker();
		// ACK durability elects detached ownership locally. A simultaneous finish
		// waits for the fenced checker above so an exact ACK wins without ever
		// creating the parent completion artifact.
		if (ownership === "detached") {
			await writeState("settled", `detached:${status}`).catch(reportBridgeError);
			ctx.shutdown();
			return;
		}
		const completion = await writeCompletion(status, errorCode, stopReason, fromChecker).catch((error) => { reportBridgeError(error); return null; });
		if (completion) lifecycleClient?.send("completion-ready");
		const terminalStatus = completion?.status ?? status;
		await writeState(terminalStatus === "orphaned" ? "orphaned" : terminalStatus === "failed" ? "failed" : "settled", `complete:${terminalStatus}`).catch(reportBridgeError);
		ctx.shutdown();
	};


	const readPromotionAck = async () => await (options.readPromotionAck
		?? ((filePath: string) => readBoundedPrivateJson(filePath, { requireSingleLineTerminated: true })))(config.promotionAckPath);
	const ackPathExists = async (): Promise<boolean> => {
		try { await fs.lstat(config.promotionAckPath); return true; }
		catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
	};
	// A detached child must not retain the inherited tree slot after it has
	// durably fenced its parent lease checker. This is deliberately independent
	// of the parent marker: either side may win the exact-token removal race.
	const releaseInheritedTreePermitAfterAcknowledgement = async (): Promise<boolean> => {
		if (options.releaseInheritedTreePermit) return await options.releaseInheritedTreePermit();
		// A root inherited by this process without the exact child lease is not
		// this bridge's capacity. Preserve the legacy no-tree behavior unless the
		// launcher supplied the complete inherited capability.
		if (!process.env[TREE_PERMIT_ROOT_ENV] || !process.env[TREE_PERMIT_LEASE_ID_ENV] || !process.env[TREE_PERMIT_LEASE_TOKEN_ENV]) return true;
		try {
			const authority = await adoptTreePermitAuthority();
			const lease = authority.inheritedLease;
			return Boolean(lease && await lease.release());
		} catch { return false; }
	};
	let acknowledgementReleaseDelayMs = 1;
	let acknowledgementReleaseInFlight = false;
	const scheduleInheritedTreePermitRelease = () => {
		if (acknowledgementReconciliationTimer || acknowledgementReleaseInFlight) return;
		const retry = () => {
			acknowledgementReconciliationTimer = undefined;
			acknowledgementReleaseInFlight = true;
			void releaseInheritedTreePermitAfterAcknowledgement().then((released) => {
				acknowledgementReleaseInFlight = false;
				if (released) return;
				// One unref'd timer and bounded backoff keep this retry state constant
				// for the remainder of the child process lifetime.
				acknowledgementReconciliationTimer = setTimeout(retry, acknowledgementReleaseDelayMs);
				acknowledgementReleaseDelayMs = Math.min(25, acknowledgementReleaseDelayMs * 2);
				acknowledgementReconciliationTimer.unref?.();
			}).catch(() => {
				acknowledgementReleaseInFlight = false;
				acknowledgementReconciliationTimer = setTimeout(retry, acknowledgementReleaseDelayMs);
				acknowledgementReleaseDelayMs = Math.min(25, acknowledgementReleaseDelayMs * 2);
				acknowledgementReconciliationTimer.unref?.();
			});
		};
		retry();
	};
	const acceptDetachedOwnership = () => {
		ownership = "detached";
		stopChecker();
		lifecycleClient?.close();
		lifecycleClient = null;
		scheduleInheritedTreePermitRelease();
	};
	const scheduleAcknowledgementReconciliation = (request: NonNullable<ReturnType<typeof parseOwnershipTransferRequest>>) => {
		if (acknowledgementReconciliationTimer || ownership === "detached") return;
		const retry = () => {
			acknowledgementReconciliationTimer = undefined;
			void (async () => {
				const winner = parseOwnershipTransferAck(await readPromotionAck().catch(() => null), config.runId);
				if (winner && sameOwnershipTransfer(request, winner)) {
					acceptDetachedOwnership();
					return;
				}
				acknowledgementReconciliationTimer = setTimeout(retry, 25);
				acknowledgementReconciliationTimer.unref?.();
			})();
		};
		acknowledgementReconciliationTimer = setTimeout(retry, 1);
		acknowledgementReconciliationTimer.unref?.();
	};

	const completionArtifactExists = async (): Promise<boolean> => {
		try { return (await readBrokerArtifact(config.completionPath)).outcome !== "missing"; }
		// Inability to inspect terminal authority is itself terminal for transfer.
		catch { return true; }
	};
	const acknowledgeOwnershipTransfer = async (ctx: ExtensionContext): Promise<boolean> => {
		if (ownership === "detached") return true;
		let request: ReturnType<typeof parseOwnershipTransferRequest>;
		let allocation: unknown | null;
		try {
			request = parseOwnershipTransferRequest(
				await readBoundedPrivateJson(config.promotionRequestPath, { requireSingleLineTerminated: true }), config.runId,
			);
			allocation = await readBoundedPrivateJson(config.allocationPath, { requireSingleLineTerminated: true });
		} catch { return false; }
		if (!request || request.parent.pid !== config.expectedParentPid || request.parent.startedAt !== config.expectedParentStartedAt
			|| request.child.pid !== process.pid || request.child.startedAt !== childStartedAt) return false;
		if (!allocation || crypto.createHash("sha256").update(JSON.stringify(allocation)).digest("hex") !== request.allocation.digest
			// A valid, malformed, or unreadable completion pathname is terminal
			// authority. Never begin a promotion fence after any such winner.
			|| await completionArtifactExists()) return false;

		// A null parser result alone is not evidence of absence: a malformed or
		// unreadable immutable ACK must fail closed without withdrawing the lease
		// checker. Only ENOENT is a missing ACK eligible for publication.
		let existingRaw: unknown | null;
		try { existingRaw = await readPromotionAck(); }
		catch { return false; }
		const existingAck = parseOwnershipTransferAck(existingRaw, config.runId);
		if (!existingAck) {
			const missing = await fs.lstat(config.promotionAckPath).then(() => false, (error: NodeJS.ErrnoException) => error.code === "ENOENT");
			if (!missing) return false;
		} else if (!sameOwnershipTransfer(request, existingAck)) return false;

		// Fence future lease reads before ACK publication/readback. This is the
		// current checker, so waiting for it would deadlock; its new generation
		// prevents post-fence work from becoming terminal authority.
		stopChecker();
		const resumeChecker = () => {
			ownership = config.ownership;
			checkerStopped = false;
			nextCheckerDue = monotonicNow();
			scheduleChecker(ctx);
		};
		const ack = { contract: "pi-subagent.detached-transfer" as const, version: 1 as const, kind: "ack" as const,
			transferId: request.transferId, runId: request.runId, allocation: request.allocation,
			parent: request.parent, child: request.child, acknowledgedAt: Date.now() };
		let publicationMayHaveSucceeded = Boolean(existingAck);
		try {
			if (!existingAck) {
				await options.beforePromotionAckPublication?.();
				// A terminal finish that began while the checker was fenced wins
				// before ACK publication, even before its completion write starts.
				if (terminal || await completionArtifactExists()) {
					if (!terminal) resumeChecker();
					return false;
				}
				// Treat the publisher call itself as ambiguous: it can durably link
				// the immutable ACK and still report an I/O failure to this process.
				publicationMayHaveSucceeded = true;
				await (options.publishPromotionAck ?? publishImmutableJson)(config.promotionAckPath, ack);
			}
			const winner = parseOwnershipTransferAck(await readPromotionAck(), config.runId);
			if (!winner || !sameOwnershipTransfer(request, winner)) throw new Error("promotion acknowledgement was not durably verified");
			// Exact durable ACK authority immediately elects detached ownership.
			// Capacity release retries independently and cannot reopen completion.
			acceptDetachedOwnership();
			return true;
		} catch {
			if (publicationMayHaveSucceeded) {
				const winner = parseOwnershipTransferAck(await readPromotionAck().catch(() => null), config.runId);
				if (winner && sameOwnershipTransfer(request, winner)) {
					acceptDetachedOwnership();
					return true;
				}
			}
			// Only an unambiguous pre-publication ENOENT failure may restore the
			// checker. A publisher can write its immutable ACK then report failure;
			// resuming here could abort a child that was already promoted.
			if (!await ackPathExists()) {
				resumeChecker();
				return false;
			}
			scheduleAcknowledgementReconciliation(request);
			return false;
		}
	};

	const checkLease = async (ctx: ExtensionContext, due: number) => {
		if (terminal || checkerStopped || (ownership as string) === "detached") return;
		if (await acknowledgeOwnershipTransfer(ctx)) return;
		if (terminal || checkerStopped) return;
		const generation = checkerGeneration;
		const readTimedOut = Symbol("lease-read-timeout");
		// One raw descriptor read cannot outlive its absolute stale window. Keep
		// the underlying promise observed so a late rejection is suppressed; only
		// this race continuation has authority to finish the child.
		const rawRead = Promise.resolve().then(async () => {
			try { return { failed: false as const, value: await (options.readLease ?? readJsonFile)(config.parentLeasePath) }; }
			catch { return { failed: true as const, value: null }; }
		});
		const rawLeaseOutcome = await new Promise<Awaited<typeof rawRead> | typeof readTimedOut>((resolve) => {
			const timer = setTimeout(() => resolve(readTimedOut), config.leaseStaleMs);
			timer.unref?.();
			void rawRead.then((value) => { clearTimeout(timer); resolve(value); });
		});
		// A late result belongs to the prior checker generation and must never
		// reopen scheduling or alter the single orphan transition below.
		if (terminal || checkerStopped || generation !== checkerGeneration) return;
		if (rawLeaseOutcome === readTimedOut) {
			checkerGeneration += 1;
			ctx.abort();
			await finish(ctx, "orphaned", "aborted", "lease-expired", true);
			return;
		}
		// Parse and stale checks use a fresh wall-clock sample taken after the
		// bounded raw read completes.
		const now = Date.now();
		const rawLease = rawLeaseOutcome.value;
		const leaseReadFailed = rawLeaseOutcome.failed;
		const leaseArtifactPresent = rawLease !== null;
		const lease = leaseReadFailed ? null : parseParentLease(rawLease, config.runId, now);
		if (lease && lease.parentPid === config.expectedParentPid
			&& lease.parentStartedAt === config.expectedParentStartedAt
			&& isUsableParentLease({
				lease, now, staleAfterMs: config.leaseStaleMs,
				parentPid: config.expectedParentPid, parentStartedAt: config.expectedParentStartedAt,
				isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive,
			})) {
			missingLeaseSinceDue = null;
			return;
		}
		// Malformed/future/dead/reused identity is positive failure; only absent
		// lease artifacts receive grace, measured from their absolute due slot.
		if (leaseReadFailed || leaseArtifactPresent || lease) {
			ctx.abort();
			await finish(ctx, "orphaned", "aborted", "lease-expired", true);
			return;
		}
		// A genuinely absent artifact receives bounded grace only while the
		// immutable expected parent process identity is still alive.
		if (config.expectedParentPid === undefined || config.expectedParentStartedAt === undefined
			|| !(options.isProcessIdentityAlive ?? isParentProcessIdentityAlive)(config.expectedParentPid, config.expectedParentStartedAt)) {
			ctx.abort();
			await finish(ctx, "orphaned", "aborted", "lease-expired", true);
			return;
		}
		missingLeaseSinceDue ??= due;
		if (monotonicNow() - missingLeaseSinceDue <= config.leaseStaleMs) return;
		ctx.abort();
		await finish(ctx, "orphaned", "aborted", "lease-expired", true);
	};

	const startChecker = (ctx: ExtensionContext, due: number): Promise<void> => {
		const current = checkLease(ctx, due);
		checkerInFlight = current;
		void current.catch(reportBridgeError).finally(() => {
			if (checkerInFlight !== current) return;
			checkerInFlight = null;
			if (!checkerStopped && !terminal && checkerPending) {
				const due = pendingCheckerDue;
				checkerPending = false;
				pendingCheckerDue = 0;
				startChecker(ctx, due);
			} else {
				checkerPending = false;
				resolveCheckerIdle();
			}
		});
		return current;
	};
	const scheduleChecker = (ctx: ExtensionContext) => {
		if (checkerStopped || terminal || ownership === "detached" || checkerTimer) return;
		const current = monotonicNow();
		if (nextCheckerDue <= current) nextCheckerDue = checkerEpoch + (Math.floor((current - checkerEpoch) / config.leaseCheckMs) + 1) * config.leaseCheckMs;
		checkerTimer = setTimeout(() => {
			checkerTimer = undefined;
			const due = nextCheckerDue;
			if (checkerInFlight) {
				checkerPending = true;
				pendingCheckerDue = due; // latest absolute due only; missed ticks never replay.
			} else void startChecker(ctx, due).catch(reportBridgeError);
			nextCheckerDue += config.leaseCheckMs;
			scheduleChecker(ctx);
		}, Math.max(0, nextCheckerDue - monotonicNow()));
		checkerTimer.unref?.();
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!await rejectUnverifiedBootstrap(ctx)) return;
		setRuntimeTitle(ctx, "ready");
		await phase0ProofClient?.start();
		lifecycleClient = await LifecycleEventClient.connectFromEnvironment(process.env, config.statePath).catch(() => null);
		lifecycleClient?.setControlHandler(async (command) => {
			if (command !== "abort" || terminal) return;
			// Authenticated parent control is cooperative: the bridge owns the
			// child abort, durable completion, and session shutdown in that order.
			ctx.abort();
			await finish(ctx, "aborted", "parent-control", "surface-closed");
		});
		await writeState("idle", "session_start").catch(reportBridgeError);
		await startChecker(ctx, monotonicNow()).catch(reportBridgeError); // initial check is a hard gate
		if (!terminal) scheduleChecker(ctx); // an initial orphan must not create a timer
	});
	pi.on("agent_start", async (_event, ctx) => {
		if (!await rejectUnverifiedBootstrap(ctx)) return;
		setRuntimeTitle(ctx, "running");
		agentStarted = true;
		lifecycleClient?.send("agent-started");
		await writeState("running", "agent_start").catch(reportBridgeError);
	});
	pi.on("agent_end", async (event, ctx) => {
		setRuntimeTitle(ctx, "waiting");
		lastAssistant = getLastAssistantStatus(event.messages);
		// This is diagnostics only: it has no bearing on FIFO release, provider
		// proof acceptance, or normal child completion. The client refuses this
		// after read-start, so a blocked descriptor read is never called terminal.
		phase0ProofClient?.reportTerminal(lastAssistant.stopReason === "error" ? "provider-error" : "settled-before-read");
		lifecycleClient?.send("agent-ended");
		await writeState("idle", "agent_end").catch(reportBridgeError);
	});
	(pi.on as unknown as AgentSettledRegistrar)("agent_settled", async (_event, ctx) => {
		if (!agentStarted || terminal) return;
		lifecycleClient?.send("agent-settled");
		if (lastAssistant.stopReason === "aborted") {
			setRuntimeTitle(ctx, "waiting");
			await writeState("idle", "agent_settled:aborted").catch(reportBridgeError);
			return;
		}
		if (lastAssistant.stopReason === "error") await finish(ctx, "failed", "error", "child-error");
		else if (!lastAssistant.hasText) await finish(ctx, "failed", lastAssistant.stopReason, "child-error");
		else await finish(ctx, "completed", lastAssistant.stopReason);
	});
	pi.on("session_shutdown", async () => {
		// If neither agent_end nor read-start won, retain only the fixed shutdown
		// category. reportTerminal is one-shot and intentionally no-ops post-read.
		phase0ProofClient?.reportTerminal("shutdown-before-read");
		// A durable detached ACK owns release retry for the child process lifetime;
		// its unref'd timer must not be cancelled merely because this session settled.
		await stopAndDrainChecker();
		lifecycleClient?.send("shutdown");
		lifecycleClient?.close();
		lifecycleClient = null;
		phase0ProofClient?.close();
		await writeState("shutdown", "session_shutdown").catch(reportBridgeError);
	});
}

export default function childBridge(pi: ExtensionAPI): void {
	registerChildBridge(pi);
}
