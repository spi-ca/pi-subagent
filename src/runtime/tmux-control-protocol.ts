import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	parseAllocationRecordV2,
	parseBrokerClaimV2,
	parseBrokerStatusV2,
	parseCommittedLaunchRecordV2,
	parseDecisionV2,
	parseLaunchGateV2,
	parseLaunchIntentV2,
	parseResidualRiskV2,
	type AllocationRecordV2,
	type BrokerClaimV2,
	type BrokerStatusV2,
	type CommittedLaunchRecordV2,
	type DecisionV2,
	type LaunchGateV2,
	type LaunchIntentV2,
	type ResidualRiskV2,
} from "./run-protocol.js";

export const TMUX_CONTROL_TRANSPORT = "tmux-control-v1" as const;
const DIGEST = /^[a-f0-9]{64}$/;
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
function transformV2(value: Record<string, unknown>, omitted: string[]): Record<string, unknown> {
	return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.includes(key)).map(([key, item]) => [key, key === "version" ? 2 : item]));
}
function contained(filePath: unknown, runDir: string, name: string): filePath is string { return typeof filePath === "string" && path.resolve(filePath) === path.join(runDir, name); }

type PromoteLaunchIntentV3<T> = T extends unknown ? Omit<T, "version"> & { version: 3; transport: typeof TMUX_CONTROL_TRANSPORT; transportGatePath: string; transportGateDigest: string } : never;
type PromoteAllocationV3<T> = T extends unknown ? Omit<T, "version"> & { version: 3; transport: typeof TMUX_CONTROL_TRANSPORT; intentDigest: string } : never;
export type LaunchIntentV3 = PromoteLaunchIntentV3<Extract<LaunchIntentV2, { terminalMode: "tmux-pane"; layout: "split" | "auto" }>>;
export type AllocationRecordV3 = PromoteAllocationV3<Extract<AllocationRecordV2, { terminalMode: "tmux-pane"; layout: "split" | "auto" }>>;
export interface CommittedLaunchRecordV3 { version: 3; runId: string; terminalMode: "tmux-pane"; transport: typeof TMUX_CONTROL_TRANSPORT; allocationPath: string; allocationDigest: string; childSessionFile: string; committedAt: number; ownership: "parent-owned" }
export type DecisionV3 = Omit<DecisionV2, "version"> & { version: 3 };
export type BrokerClaimV3 = Omit<BrokerClaimV2, "version"> & { version: 3 };
export type ResidualRiskV3 = Omit<ResidualRiskV2, "version"> & { version: 3 };
export type BrokerStatusV3 = Omit<BrokerStatusV2, "version"> & { version: 3 };
export type LaunchGateV3 = Omit<LaunchGateV2, "version"> & { version: 3 };

export function parseLaunchIntentV3(value: unknown, expectedRunId: string, runDir: string): LaunchIntentV3 | null {
	if (!object(value) || value.version !== 3 || value.transport !== TMUX_CONTROL_TRANSPORT || !contained(value.transportGatePath, runDir, "transport-gate.json") || typeof value.transportGateDigest !== "string" || !DIGEST.test(value.transportGateDigest)) return null;
	const v2 = parseLaunchIntentV2(transformV2(value, ["transport", "transportGatePath", "transportGateDigest"]), expectedRunId, runDir);
	return v2?.terminalMode === "tmux-pane" && "layout" in v2 ? value as unknown as LaunchIntentV3 : null;
}
export function parseAllocationRecordV3(value: unknown, expectedRunId: string): AllocationRecordV3 | null {
	if (!object(value) || value.version !== 3 || value.transport !== TMUX_CONTROL_TRANSPORT || typeof value.intentDigest !== "string" || !DIGEST.test(value.intentDigest)) return null;
	const v2 = parseAllocationRecordV2(transformV2(value, ["transport", "intentDigest"]), expectedRunId);
	return v2?.terminalMode === "tmux-pane" && "layout" in v2 ? value as unknown as AllocationRecordV3 : null;
}
export function parseCommittedLaunchRecordV3(value: unknown, expectedRunId: string, runDir: string): CommittedLaunchRecordV3 | null {
	if (!object(value) || !exactKeys(value, ["version", "runId", "terminalMode", "transport", "allocationPath", "allocationDigest", "childSessionFile", "committedAt", "ownership"])
		|| value.version !== 3 || value.runId !== expectedRunId || value.terminalMode !== "tmux-pane" || value.transport !== TMUX_CONTROL_TRANSPORT || value.ownership !== "parent-owned"
		|| !contained(value.allocationPath, runDir, "allocation.json") || !contained(value.childSessionFile, runDir, "child-session.jsonl") || typeof value.allocationDigest !== "string" || !DIGEST.test(value.allocationDigest)
		|| typeof value.committedAt !== "number" || !Number.isFinite(value.committedAt) || value.committedAt <= 0) return null;
	return value as unknown as CommittedLaunchRecordV3;
}
function parseVersioned<T>(value: unknown, expectedRunId: string, runDir: string | undefined, parser: (value: unknown, runId: string, runDir?: string) => unknown): T | null {
	if (!object(value) || value.version !== 3) return null;
	return parser({ ...value, version: 2 }, expectedRunId, runDir) ? value as T : null;
}
export const parseDecisionV3 = (value: unknown, runId: string, runDir: string): DecisionV3 | null => parseVersioned(value, runId, runDir, parseDecisionV2);
export const parseBrokerClaimV3 = (value: unknown, runId: string): BrokerClaimV3 | null => parseVersioned(value, runId, undefined, parseBrokerClaimV2 as any);
export const parseResidualRiskV3 = (value: unknown, runId: string): ResidualRiskV3 | null => parseVersioned(value, runId, undefined, parseResidualRiskV2 as any);
export const parseBrokerStatusV3 = (value: unknown, runId: string): BrokerStatusV3 | null => parseVersioned(value, runId, undefined, parseBrokerStatusV2 as any);
export const parseLaunchGateV3 = (value: unknown, runId: string, runDir: string): LaunchGateV3 | null => parseVersioned(value, runId, runDir, parseLaunchGateV2);

async function readBoundArtifact(filePath: string): Promise<{ bytes: Buffer; value: unknown; digest: string } | null> {
	let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
	try {
		handle = await fs.open(filePath, fsSync.constants.O_RDONLY | (fsSync.constants.O_NOFOLLOW ?? 0));
		const before = await handle.stat({ bigint: true });
		if (!before.isFile() || before.size <= 0n || before.size > 1024n * 1024n) return null;
		const bytes = await handle.readFile();
		const after = await handle.stat({ bigint: true });
		const pathname = await fs.lstat(filePath, { bigint: true });
		if (bytes.length !== Number(before.size) || bytes.at(-1) !== 0x0a || bytes.subarray(0, -1).includes(0x0a)
			|| before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
			|| pathname.isSymbolicLink() || pathname.dev !== after.dev || pathname.ino !== after.ino || pathname.size !== after.size || pathname.mtimeNs !== after.mtimeNs) return null;
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1));
		const value = JSON.parse(text);
		if (!object(value)) return null;
		return { bytes, value, digest: crypto.createHash("sha256").update(bytes).digest("hex") };
	} catch { return null; }
	finally { await handle?.close().catch(() => undefined); }
}

export async function exactArtifactDigest(filePath: string): Promise<string | null> {
	return (await readBoundArtifact(filePath))?.digest ?? null;
}

export async function hasValidTmuxControlChain(options: { runDir: string; intent: LaunchIntentV3; allocation?: AllocationRecordV3 | null; launch?: CommittedLaunchRecordV3 | null }): Promise<boolean> {
	const gateArtifact = await readBoundArtifact(options.intent.transportGatePath);
	const intentArtifact = await readBoundArtifact(path.join(options.runDir, "launch-intent.json"));
	if (!gateArtifact || gateArtifact.digest !== options.intent.transportGateDigest || !intentArtifact) return false;
	const boundIntent = parseLaunchIntentV3(intentArtifact.value, options.intent.runId, options.runDir);
	if (!boundIntent || !isDeepStrictEqual(boundIntent, options.intent)) return false;
	if (options.allocation) {
		if (intentArtifact.digest !== options.allocation.intentDigest) return false;
		const allocationArtifact = await readBoundArtifact(path.join(options.runDir, "allocation.json"));
		const boundAllocation = allocationArtifact && parseAllocationRecordV3(allocationArtifact.value, options.intent.runId);
		if (!allocationArtifact || !boundAllocation || !isDeepStrictEqual(boundAllocation, options.allocation)) return false;
		if (options.launch) {
			if (allocationArtifact.digest !== options.launch.allocationDigest) return false;
			const launchArtifact = await readBoundArtifact(path.join(options.runDir, "launch.json"));
			const boundLaunch = launchArtifact && parseCommittedLaunchRecordV3(launchArtifact.value, options.intent.runId, options.runDir);
			if (!boundLaunch || !isDeepStrictEqual(boundLaunch, options.launch)) return false;
		}
	}
	return !options.launch || Boolean(options.allocation);
}
