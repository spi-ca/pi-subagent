import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
	addAccountingUsage,
	aggregateAccountingUsage,
	emptyAccountingUsage,
	finalizeForegroundUsage,
} from "../../src/core/accounting-usage";

describe("foreground accounting usage", () => {
	test("normalizes base, optional, and all cost fields while deriving total tokens", () => {
		const usage = emptyAccountingUsage();
		addAccountingUsage(usage, {
			input: 2,
			output: 3,
			cacheRead: 4,
			cacheWrite: 5,
			totalTokens: 999,
			cacheWrite1h: 6,
			reasoning: 7,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 21 },
		});
		addAccountingUsage(usage, {
			input: -1,
			output: Number.NaN,
			cacheRead: Infinity,
			cacheWrite: "bad",
			cacheWrite1h: -1,
			reasoning: Number.NEGATIVE_INFINITY,
			cost: { input: -1, output: Number.NaN, cacheRead: Infinity, cacheWrite: "bad", total: -1 },
		});

		assert.deepEqual(usage, {
			input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14,
			cacheWrite1h: 6, reasoning: 7,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 21 },
		});

		const reportedZeros = emptyAccountingUsage();
		addAccountingUsage(reportedZeros, {
			input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		assert.equal(reportedZeros.cacheWrite1h, 0);
		assert.equal(reportedZeros.reasoning, 0);

		const overflow = emptyAccountingUsage();
		addAccountingUsage(overflow, {
			input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 0, cacheWrite: 0,
			cost: { input: Infinity, output: Infinity, cacheRead: 0, cacheWrite: 0, total: Infinity },
		});
		assert.deepEqual(overflow, emptyAccountingUsage());
	});

	test("aggregates completed, failed, and partial results without mutating inputs", () => {
		const completed = emptyAccountingUsage();
		const failed = emptyAccountingUsage();
		const partial = emptyAccountingUsage();
		addAccountingUsage(completed, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 } });
		addAccountingUsage(failed, { input: 3, output: 0, cacheRead: 1, cacheWrite: 0, cost: { input: 3, output: 0, cacheRead: 1, cacheWrite: 0, total: 4 } });
		addAccountingUsage(partial, { input: 4, output: 5, cacheRead: 0, cacheWrite: 6, cost: { input: 4, output: 5, cacheRead: 0, cacheWrite: 6, total: 15 } });
		const before = structuredClone(partial);

		const total = aggregateAccountingUsage([{ accountingUsage: completed }, { accountingUsage: failed }, { accountingUsage: partial }]);
		assert.deepEqual(total, {
			input: 8, output: 7, cacheRead: 1, cacheWrite: 6, totalTokens: 22,
			cost: { input: 8, output: 7, cacheRead: 1, cacheWrite: 6, total: 22 },
		});
		assert.deepEqual(partial, before);
	});

	test("attaches one top-level aggregate to final foreground results without mutating partials", () => {
		const childUsage = emptyAccountingUsage();
		addAccountingUsage(childUsage, {
			input: 3, output: 2, cacheRead: 1, cacheWrite: 4,
			cost: { input: 0.3, output: 0.2, cacheRead: 0.1, cacheWrite: 0.4, total: 1 },
		});
		const partial = { content: [], details: { results: [{ accountingUsage: childUsage }] }, isError: true };
		const final = finalizeForegroundUsage(partial);

		assert.equal(Object.hasOwn(partial, "usage"), false);
		assert.equal(final.usage.totalTokens, 10);
		assert.equal(final.usage.cost.total, 1);
		assert.equal((final.details as any).usage, undefined);
		assert.deepEqual(finalizeForegroundUsage({ content: [], details: { results: [] } }).usage, emptyAccountingUsage());
	});
});
