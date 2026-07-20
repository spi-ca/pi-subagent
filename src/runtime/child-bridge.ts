import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_PARENT_LEASE_RENEW_MS,
	DEFAULT_PARENT_LEASE_STALE_MS,
	RUN_PROTOCOL_VERSION,
	BROKER_PROTOCOL_VERSION,
	SUBAGENT_CHILD_SESSION_PATH_ENV,
	SUBAGENT_LEASE_CHECK_MS_ENV,
	SUBAGENT_LEASE_STALE_MS_ENV,
	SUBAGENT_EXPECTED_PARENT_PID_ENV,
	SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV,
	SUBAGENT_PARENT_LEASE_PATH_ENV,
	SUBAGENT_RUN_COMPLETION_PATH_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_RUN_OWNERSHIP_ENV,
	SUBAGENT_RUN_STATE_PATH_ENV,
	atomicWriteJson,
	isUsableParentLease,
	isParentProcessIdentityAlive,
	parseParentLease,
	type ParentProcessIdentityChecker,
	publishCompletionRecordV2,
	readJsonFile,
	type CompletionRecordV2,
	type RunOwnership,
	type RunPhase,
	type RunStateV1,
} from "./run-protocol.js";

interface BridgeConfig {
	runId: string;
	statePath: string;
	completionPath: string;
	parentLeasePath: string;
	childSessionPath: string;
	ownership: RunOwnership;
	expectedParentPid?: number;
	expectedParentStartedAt?: number;
	leaseStaleMs: number;
	leaseCheckMs: number;
}

interface LastAssistantStatus {
	stopReason?: string;
	hasText: boolean;
}

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
	const expectedParentPid = parsePositiveNumber(env[SUBAGENT_EXPECTED_PARENT_PID_ENV]);
	const expectedParentStartedAt = parsePositiveNumber(env[SUBAGENT_EXPECTED_PARENT_STARTED_AT_ENV]);
	// Parent-owned bridges must bind the renewable lease to the immutable intent
	// identity provided by the parent bootstrap, before any OS PID probe.
	if (ownership === "parent-owned" && (expectedParentPid === null || expectedParentStartedAt === null)) return null;
	return {
		runId,
		statePath,
		completionPath,
		parentLeasePath,
		childSessionPath,
		ownership,
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

export function registerChildBridge(
	pi: ExtensionAPI,
	options: { isProcessIdentityAlive?: ParentProcessIdentityChecker } = {},
): void {
	const config = resolveBridgeConfig(process.env);
	if (!config) return;

	let sequence = 0;
	let agentStarted = false;
	let terminal = false;
	let leaseTimer: NodeJS.Timeout | undefined;
	let missingLeaseSince: number | null = null;
	let lastAssistant: LastAssistantStatus = { hasText: false };
	let writeChain = Promise.resolve();

	const queueWrite = (operation: () => Promise<void>) => {
		writeChain = writeChain.then(operation, operation);
		return writeChain;
	};
	const writeState = (phase: RunPhase, lastEvent: string) => queueWrite(async () => {
		sequence += 1;
		await atomicWriteJson(config.statePath, {
			version: RUN_PROTOCOL_VERSION,
			runId: config.runId,
			sequence,
			phase,
			updatedAt: Date.now(),
			childPid: process.pid,
			lastEvent,
		} satisfies RunStateV1);
	});
	const writeCompletion = async (
		status: CompletionRecordV2["status"],
		errorCode?: CompletionRecordV2["errorCode"],
	) => {
		// Completion is terminal immutable authority. It deliberately bypasses the
		// mutable state queue, whose I/O failure must not suppress completion.
		await publishCompletionRecordV2(config.completionPath, {
			version: BROKER_PROTOCOL_VERSION,
			runId: config.runId,
			status,
			completedAt: Date.now(),
			...(errorCode ? { errorCode } : {}),
		});
	};
	const reportBridgeError = (error: unknown) => {
		console.error(`[pi-subagent bridge] lifecycle write failed: ${error instanceof Error ? error.message : String(error)}`);
	};
	const finish = async (
		ctx: ExtensionContext,
		status: CompletionRecordV2["status"],
		stopReason?: string,
		errorCode?: CompletionRecordV2["errorCode"],
	) => {
		if (terminal) return;
		terminal = true;
		if (leaseTimer) clearInterval(leaseTimer);
		// Publish immutable terminal authority first and independently. A failed
		// mutable state update is diagnostic only, never a reason to lose completion.
		await writeCompletion(status, errorCode).catch(reportBridgeError);
		await writeState(status === "orphaned" ? "orphaned" : status === "failed" ? "failed" : "settled", `complete:${status}`).catch(reportBridgeError);
		ctx.shutdown();
	};

	const checkLease = async (ctx: ExtensionContext) => {
		if (terminal || config.ownership === "detached") return;
		const now = Date.now();
		let lease;
		let leaseArtifactPresent = false;
		try {
			const rawLease = await readJsonFile(config.parentLeasePath);
			leaseArtifactPresent = rawLease !== null;
			lease = parseParentLease(rawLease, config.runId, now);
		} catch {
			lease = null;
		}
		if (lease) {
			// Compare against the process-private bootstrap identity before OS
			// liveness. A tool/shell cannot authorize the child by substituting a
			// different currently-live PID into the renewable lease.
			if (lease.parentPid === config.expectedParentPid
				&& lease.parentStartedAt === config.expectedParentStartedAt
				&& isUsableParentLease({
					lease,
					now,
					staleAfterMs: config.leaseStaleMs,
					parentPid: config.expectedParentPid,
					parentStartedAt: config.expectedParentStartedAt,
					isProcessIdentityAlive: options.isProcessIdentityAlive ?? isParentProcessIdentityAlive,
				})) {
				missingLeaseSince = null;
				return;
			}
			// A parsed lease with a dead/reused identity or forged clock is a
			// positive ownership failure, unlike a transient missing file.
			missingLeaseSince = now - config.leaseStaleMs - 1;
		} else {
			// A malformed/future lease is not a transient missing-file race.
			if (leaseArtifactPresent) missingLeaseSince = now - config.leaseStaleMs - 1;
			else missingLeaseSince ??= now;
			if (now - missingLeaseSince <= config.leaseStaleMs) return;
		}
		ctx.abort();
		await finish(ctx, "orphaned", "aborted", "lease-expired");
	};

	pi.on("session_start", async (_event, ctx) => {
		await writeState("idle", "session_start").catch(reportBridgeError);
		await checkLease(ctx);
		leaseTimer = setInterval(() => void checkLease(ctx).catch(reportBridgeError), config.leaseCheckMs);
		leaseTimer.unref?.();
	});

	pi.on("agent_start", async () => {
		agentStarted = true;
		await writeState("running", "agent_start").catch(reportBridgeError);
	});

	pi.on("agent_end", async (event) => {
		lastAssistant = getLastAssistantStatus(event.messages);
		await writeState("idle", "agent_end").catch(reportBridgeError);
	});

	(pi.on as unknown as AgentSettledRegistrar)("agent_settled", async (_event, ctx) => {
		if (!agentStarted || terminal) return;
		if (lastAssistant.stopReason === "aborted") {
			await writeState("idle", "agent_settled:aborted").catch(reportBridgeError);
			return;
		}
		if (lastAssistant.stopReason === "error") {
			await finish(ctx, "failed", "error", "child-error");
			return;
		}
		if (!lastAssistant.hasText) {
			await finish(ctx, "failed", lastAssistant.stopReason, "child-error");
			return;
		}
		await finish(ctx, "completed", lastAssistant.stopReason);
	});

	pi.on("session_shutdown", async () => {
		if (leaseTimer) clearInterval(leaseTimer);
		await writeState("shutdown", "session_shutdown").catch(reportBridgeError);
	});
}

export default function childBridge(pi: ExtensionAPI): void {
	registerChildBridge(pi);
}
