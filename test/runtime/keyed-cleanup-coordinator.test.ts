import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { MAX_CLEANUP_TIMER_DELAY_MS, KeyedCleanupCoordinator, getProcessGlobalCleanupCoordinator } from "../../src/runtime/keyed-cleanup-coordinator";

type ManualTimer = { callback: () => void; delay: number; unrefs: number };

function manualCoordinator(options: { capacity?: number; concurrency?: number } = {}) {
	let now = 0;
	const timers = new Set<ManualTimer>();
	const coordinator = new KeyedCleanupCoordinator({
		...options,
		now: () => now,
		setTimer: (callback, delay) => {
			const timer: ManualTimer = { callback, delay, unrefs: 0 };
			timers.add(timer);
			return { unref: () => { timer.unrefs += 1; } };
		},
		clearTimer: () => { for (const timer of timers) timers.delete(timer); },
	});
	const fire = (timer = [...timers][0]) => {
		assert.ok(timer, "expected a single wake timer");
		timers.delete(timer);
		timer.callback();
	};
	return { coordinator, timers, fire, setNow: (value: number) => { now = value; } };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("keyed cleanup coordinator", () => {
	test("keeps the original callback and earlier deadline when a duplicate is later", async () => {
		const { coordinator, timers, fire, setNow } = manualCoordinator();
		const cleaned: string[] = [];
		assert.equal(coordinator.schedule("a", 20, async () => { cleaned.push("original"); }), true);
		assert.equal(coordinator.schedule("a", 30, async () => { cleaned.push("late"); }), true);
		assert.equal(timers.size, 1);
		const timer = [...timers][0]!;
		assert.equal(timer.delay, 20, "later duplicates must retain the earlier absolute deadline");
		assert.equal(timer.unrefs, 1);
		setNow(20); fire(timer); await flush();
		assert.deepEqual(cleaned, ["original"]);
	});

	test("adopts the callback and deadline from an earlier duplicate", async () => {
		const { coordinator, timers, fire, setNow } = manualCoordinator();
		const cleaned: string[] = [];
		assert.equal(coordinator.schedule("a", 30, async () => { cleaned.push("late"); }), true);
		assert.equal(coordinator.schedule("a", 20, async () => { cleaned.push("early"); }), true);
		assert.equal(timers.size, 1);
		const timer = [...timers][0]!;
		assert.equal(timer.delay, 20);
		setNow(20); fire(timer); await flush();
		assert.deepEqual(cleaned, ["early"]);
	});

	test("may refresh the callback for an equal duplicate deadline", async () => {
		const { coordinator, fire, setNow } = manualCoordinator();
		const cleaned: string[] = [];
		assert.equal(coordinator.schedule("a", 20, async () => { cleaned.push("original"); }), true);
		assert.equal(coordinator.schedule("a", 20, async () => { cleaned.push("refreshed"); }), true);
		setNow(20); fire(); await flush();
		assert.deepEqual(cleaned, ["refreshed"]);
	});

	test("uses a heap without re-arming or scanning all tasks for 10k later registrations", () => {
		let nowCalls = 0, timerCreates = 0;
		const coordinator = new KeyedCleanupCoordinator({
			now: () => { nowCalls += 1; return 0; },
			setTimer: () => { timerCreates += 1; return {}; },
			clearTimer: () => assert.fail("later deadlines must not replace the earliest wake"),
		});
		for (let index = 0; index < 10_000; index += 1) {
			assert.equal(coordinator.schedule(`run-${index}`, index + 1, async () => undefined), true);
		}
		assert.equal(timerCreates, 1);
		assert.equal(nowCalls, 1);
	});

	test("does not repeatedly wake while due work is blocked by cleanup concurrency", async () => {
		const { coordinator, timers, fire } = manualCoordinator({ capacity: 5, concurrency: 2 });
		let active = 0, maxActive = 0;
		const releases: Array<() => void> = [];
		for (let index = 0; index < 3; index += 1) assert.equal(coordinator.schedule(`run-${index}`, 0, async () => {
			active += 1; maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => releases.push(resolve));
			active -= 1;
		}), true);
		fire(); await flush();
		assert.equal(maxActive, 2);
		assert.equal(timers.size, 0, "completion, not a zero-delay timer, must resume due work");
		await flush();
		assert.equal(timers.size, 0, "blocked work must not create repeated busy wake timers");
		releases.splice(0).forEach((release) => release()); await flush();
		assert.equal(maxActive, 2);
		assert.equal(timers.size, 0);
		releases.splice(0).forEach((release) => release()); await flush();

		const capped = manualCoordinator({ capacity: 1 });
		assert.equal(capped.coordinator.schedule("kept", 0, async () => undefined), true);
		assert.equal(capped.coordinator.schedule("retained", 0, async () => { throw new Error("must not run"); }), false);
	});

	test("clamps far-future wake delays and re-arms until the absolute deadline", async () => {
		const { coordinator, timers, fire, setNow } = manualCoordinator();
		let calls = 0;
		const deadline = MAX_CLEANUP_TIMER_DELAY_MS + 10;
		assert.equal(coordinator.schedule("far", deadline, async () => { calls += 1; }), true);
		assert.equal([...timers][0]!.delay, MAX_CLEANUP_TIMER_DELAY_MS);
		fire(); await flush();
		assert.equal(calls, 0);
		assert.equal([...timers][0]!.delay, MAX_CLEANUP_TIMER_DELAY_MS);
		setNow(MAX_CLEANUP_TIMER_DELAY_MS);
		fire(); await flush();
		assert.equal(calls, 0);
		assert.equal([...timers][0]!.delay, 10);
		setNow(deadline);
		fire(); await flush();
		assert.equal(calls, 1);
	});

	test("retains unsafe or failed work one-shot without retrying it", async () => {
		const { coordinator, fire, timers } = manualCoordinator();
		let attempts = 0;
		assert.equal(coordinator.schedule("unsafe", 0, async () => { attempts += 1; throw new Error("unsafe path"); }), true);
		fire(); await flush();
		assert.equal(attempts, 1);
		assert.equal(timers.size, 0, "failure must retain artifacts rather than enqueue an unsafe retry");
	});

	test("handles a new schedule while the same key is draining", async () => {
		const { coordinator, fire, timers } = manualCoordinator();
		let release!: () => void;
		let calls = 0;
		assert.equal(coordinator.schedule("run", 0, async () => {
			calls += 1;
			if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
		}), true);
		fire(); await flush();
		assert.equal(calls, 1);
		assert.equal(coordinator.schedule("run", 0, async () => { calls += 1; }), true);
		release(); await flush();
		assert.equal(calls, 2, "a schedule arriving during drain must be processed after the first generation");
		assert.equal(timers.size, 0);
	});

	test("fails closed for a proxy-poisoned process-global ABI without invoking cleanup", () => {
		const modulePath = path.resolve("src/runtime/keyed-cleanup-coordinator.ts");
		const script = `
			const symbol = Symbol.for("@mjakl/pi-subagent.keyed-cleanup-coordinator.v2");
			let schedules = 0, callbacks = 0;
			const schedule = Object.freeze((key, deadline, cleanup) => { schedules += 1; void cleanup(); return true; });
			const record = Object.freeze(Object.create(null, {
				abi: { value: 2, writable: false, enumerable: true, configurable: false },
				schedule: { value: schedule, writable: false, enumerable: true, configurable: false },
			}));
			Object.defineProperty(globalThis, symbol, { value: new Proxy(record, {}), writable: false, enumerable: false, configurable: false });
			const { getProcessGlobalCleanupCoordinator } = await import(${JSON.stringify(modulePath)});
			const accepted = getProcessGlobalCleanupCoordinator().schedule("poisoned", 0, async () => { callbacks += 1; });
			await Promise.resolve();
			console.log(JSON.stringify({ accepted, schedules, callbacks }));
		`;
		const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout.trim(), '{"accepted":false,"schedules":0,"callbacks":0}');
	});

	test("reuses one process-global coordinator across module callers", () => {
		assert.equal(getProcessGlobalCleanupCoordinator(), getProcessGlobalCleanupCoordinator());
	});
});
