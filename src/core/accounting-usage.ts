import type { Usage } from "@earendil-works/pi-ai";

/**
 * Preserve provider-specific optional fields that may appear in compatible
 * usage payloads without expanding the installed public Usage declaration.
 */
export type AccountingUsage = Usage & {
	cacheWrite1h?: number;
	reasoning?: number;
};

type UsageRecord = Record<string, unknown>;

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
const OPTIONAL_FIELDS = ["cacheWrite1h", "reasoning"] as const;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

function nonNegativeFinite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function add(target: Record<string, number | undefined>, field: string, value: unknown, integer: boolean): void {
	const normalized = nonNegativeFinite(value);
	if (normalized === undefined || (integer && !Number.isSafeInteger(normalized))) return;
	const next = (target[field] ?? 0) + normalized;
	if (!Number.isFinite(next) || (integer && !Number.isSafeInteger(next))) return;
	target[field] = next;
}

/** Create a complete zero-valued base usage record without optional fields. */
export function emptyAccountingUsage(): AccountingUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Add a compatible usage payload. Only finite non-negative values are
 * accounted, and totalTokens is always derived from the four base components.
 * Optional passthrough fields never contribute to totalTokens.
 */
export function addAccountingUsage(target: AccountingUsage, usage: unknown): AccountingUsage {
	if (!usage || typeof usage !== "object") return target;
	const source = usage as UsageRecord;
	const totals = target as unknown as Record<string, number | undefined>;
	const nextTokens = TOKEN_FIELDS.map((field) => {
		const value = nonNegativeFinite(source[field]);
		if (value === undefined || !Number.isSafeInteger(value)) return target[field];
		const next = target[field] + value;
		return Number.isSafeInteger(next) ? next : target[field];
	});
	const nextTotalTokens = nextTokens.reduce((total, value) => total + value, 0);
	if (Number.isSafeInteger(nextTotalTokens)) {
		for (let index = 0; index < TOKEN_FIELDS.length; index++) target[TOKEN_FIELDS[index]] = nextTokens[index];
		target.totalTokens = nextTotalTokens;
	}
	for (const field of OPTIONAL_FIELDS) add(totals, field, source[field], true);

	const sourceCost = source.cost;
	if (sourceCost && typeof sourceCost === "object") {
		const costs = target.cost as unknown as Record<string, number | undefined>;
		const costRecord = sourceCost as UsageRecord;
		for (const field of COST_FIELDS) add(costs, field, costRecord[field], false);
	}

	return target;
}

/** Aggregate complete accounting across all completed/partial child results. */
export function aggregateAccountingUsage(results: readonly { accountingUsage?: AccountingUsage }[]): AccountingUsage {
	const total = emptyAccountingUsage();
	for (const result of results) addAccountingUsage(total, result.accountingUsage);
	return total;
}

/** Attach usage only to the final foreground AgentToolResult shape. */
export function finalizeForegroundUsage<
	T extends { details: { results: readonly { accountingUsage?: AccountingUsage }[] } },
>(result: T): T & { usage: AccountingUsage } {
	return { ...result, usage: aggregateAccountingUsage(result.details.results) };
}
