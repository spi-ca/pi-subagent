import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { planUnifiedReaperGraph } from "../../src/runtime/reaper-coordinator";

describe("reaper coordinator heavy workload", () => {
	test("handles a 100k-node graph in linear descendants-first order", () => {
		const nodes = Array.from({ length: 100_000 }, (_, index) => ({
			runId: `run-${index}`,
			...(index === 0 ? {} : { parentRunId: `run-${index - 1}` }),
		}));
		const plan = planUnifiedReaperGraph(nodes);
		assert.equal(plan.unresolved.size, 0);
		assert.equal(plan.descendantsFirst.length, nodes.length);
		assert.equal(plan.descendantsFirst[0], "run-99999");
		assert.equal(plan.descendantsFirst.at(-1), "run-0");
	});
});
