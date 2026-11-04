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
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 21, totalFromProvider: false },
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
		assert.deepEqual(overflow, { ...emptyAccountingUsage(), cost: { ...emptyAccountingUsage().cost, totalFromProvider: false } });
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
			cost: { input: 8, output: 7, cacheRead: 1, cacheWrite: 6, total: 22, totalFromProvider: false },
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

test("untouched empty child usage is neutral before and after provider usage, including reported zero", () => {
	for (const billedTotal of [7, 0]) {
		const reported = emptyAccountingUsage();
		reported.cost.total = billedTotal;
		reported.cost.totalFromProvider = true;
		for (const usages of [[emptyAccountingUsage(), reported], [reported, emptyAccountingUsage()]]) {
			const before = structuredClone(usages);
			const sequential = emptyAccountingUsage();
			for (const usage of usages) addAccountingUsage(sequential, usage);
			assert.deepEqual(sequential, reported);
			assert.deepEqual(aggregateAccountingUsage(usages.map(accountingUsage => ({ accountingUsage }))), reported);
			assert.deepEqual(usages, before);
		}
	}
});

test("empty foreground usage remains neutral through nested and serialized aggregation", () => {
	const emptyForeground = finalizeForegroundUsage({ details: { results: [
		{}, { accountingUsage: emptyAccountingUsage() }, { accountingUsage: aggregateAccountingUsage([]) },
	] } });
	assert.deepEqual(emptyForeground.usage, emptyAccountingUsage());
	const nestedEmpty = finalizeForegroundUsage({ details: { results: [{ accountingUsage: emptyForeground.usage }] } });
	assert.deepEqual(nestedEmpty.usage, emptyAccountingUsage());

	const reported = emptyAccountingUsage();
	addAccountingUsage(reported, { input: 2, cost: { total: 7, totalFromProvider: true } });
	const serializedEmpty = JSON.parse(JSON.stringify(nestedEmpty.usage));
	for (const usages of [[serializedEmpty, reported], [reported, serializedEmpty]]) {
		const final = finalizeForegroundUsage({ details: { results: usages.map(accountingUsage => ({ accountingUsage })) } });
		assert.deepEqual(final.usage, reported);
		assert.deepEqual(aggregateAccountingUsage([{ accountingUsage: final.usage }, { accountingUsage: nestedEmpty.usage }]), reported);
	}
});

test("zero-cost legacy and estimated usage with tokens is not neutral and stays estimated when nested", () => {
	const reported = emptyAccountingUsage();
	addAccountingUsage(reported, { input: 2, cost: { total: 7, totalFromProvider: true } });
	for (const flag of [undefined, false]) {
		const estimated = emptyAccountingUsage();
		estimated.output = estimated.totalTokens = 3;
		if (flag !== undefined) estimated.cost.totalFromProvider = flag;
		for (const usages of [[estimated, reported], [reported, estimated]]) {
			const final = finalizeForegroundUsage({ details: { results: usages.map(accountingUsage => ({ accountingUsage })) } });
			assert.equal(final.usage.totalTokens, 5);
			assert.equal(final.usage.cost.total, 7);
			assert.equal(final.usage.cost.totalFromProvider, false);
			const nested = aggregateAccountingUsage([
				{ accountingUsage: emptyAccountingUsage() }, { accountingUsage: final.usage }, { accountingUsage: reported },
			]);
			assert.equal(nested.cost.totalFromProvider, false);
			assert.equal(nested.totalTokens, 7);
			assert.equal(nested.cost.total, 14);
		}
	}
	const explicitlyEstimatedZero = emptyAccountingUsage();
	explicitlyEstimatedZero.cost.totalFromProvider = false;
	assert.equal(aggregateAccountingUsage([
		{ accountingUsage: reported }, { accountingUsage: explicitlyEstimatedZero },
	]).cost.totalFromProvider, false, "an explicit false is sticky even without tokens or cost");
});

test("provider totals survive child/final aggregation only when every contribution is reported", () => {
  const contribution = (flag: boolean | undefined, total = 7) => {
    const usage = emptyAccountingUsage();
    usage.input = 2;
    usage.totalTokens = 2;
    usage.cost = { ...usage.cost, input: 1, total, ...(flag === undefined ? {} : { totalFromProvider: flag }) };
    return usage;
  };
  for (const flags of [[true], [true, true], [true, false], [false, true], [true, undefined], [undefined, true], [true, false, true], [undefined, true, true]] as const) {
    const children = flags.map(flag => {
      const usage = emptyAccountingUsage();
      addAccountingUsage(usage, contribution(flag));
      return { accountingUsage: usage };
    });
    const before = structuredClone(children);
    const final = finalizeForegroundUsage({ details: { results: children } });
    assert.equal(final.usage.cost.totalFromProvider, flags.every(flag => flag === true), String(flags));
    assert.equal(final.usage.cost.total, flags.length * 7, "billed totals are not recomputed from catalog components");
    assert.equal(final.usage.totalTokens, flags.length * 2);
    assert.deepEqual(children, before);
    const sequential = emptyAccountingUsage();
    for (const flag of flags) addAccountingUsage(sequential, contribution(flag));
    assert.deepEqual(sequential, final.usage);
  }
  assert.equal(emptyAccountingUsage().cost.totalFromProvider, undefined, "no contributions is not provider reporting");
  assert.equal(aggregateAccountingUsage([{}]).cost.totalFromProvider, undefined);
  const free = aggregateAccountingUsage([{ accountingUsage: contribution(true, 0) }]);
  assert.equal(free.cost.total, 0);
  assert.equal(free.cost.totalFromProvider, true, "reported zero is valid");
  const invalid = emptyAccountingUsage();
  addAccountingUsage(invalid, { cost: { total: Infinity, totalFromProvider: true } });
  assert.equal(invalid.cost.totalFromProvider, false, "invalid reported totals cannot confer provenance");
});
