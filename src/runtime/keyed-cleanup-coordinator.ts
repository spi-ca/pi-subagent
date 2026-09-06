import { types } from "node:util";

export const MAX_KEYED_CLEANUP_TASKS = 10_000;
export const DEFAULT_KEYED_CLEANUP_CONCURRENCY = 4;
/** Node and Bun truncate larger delays, which would otherwise fire early. */
export const MAX_CLEANUP_TIMER_DELAY_MS = 2_147_483_647;

export type TimerHandle = { unref?: () => unknown };

export interface KeyedCleanupCoordinatorOptions {
	capacity?: number;
	concurrency?: number;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	clearTimer?: (timer: TimerHandle) => void;
}

export interface CleanupScheduler {
	schedule(key: string, deadline: number, cleanup: () => Promise<void>): boolean;
}

type CleanupTask = {
	key: string;
	deadline: number;
	cleanup: () => Promise<void>;
	generation: number;
	running: boolean;
	heapIndex: number;
};

/**
 * A bounded, one-shot process-local cleanup queue. Failed work is deliberately
 * forgotten rather than retried: retention is safer than a later unsafe delete.
 */
export class KeyedCleanupCoordinator implements CleanupScheduler {
	private readonly capacity: number;
	private readonly concurrency: number;
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
	private readonly clearTimer: (timer: TimerHandle) => void;
	private readonly tasks = new Map<string, CleanupTask>();
	private readonly heap: CleanupTask[] = [];
	private timer: TimerHandle | undefined;
	private timerDeadline: number | undefined;
	private active = 0;

	constructor(options: KeyedCleanupCoordinatorOptions = {}) {
		this.capacity = boundedPositive(options.capacity, MAX_KEYED_CLEANUP_TASKS);
		this.concurrency = boundedPositive(options.concurrency, DEFAULT_KEYED_CLEANUP_CONCURRENCY);
		this.now = options.now ?? Date.now;
		this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	}

	/** Returns false when accepting work would exceed the retained-task cap. */
	schedule(key: string, deadline: number, cleanup: () => Promise<void>): boolean {
		if (typeof key !== "string" || key.length === 0 || !Number.isFinite(deadline) || typeof cleanup !== "function") return false;
		const existing = this.tasks.get(key);
		if (existing) {
			// Keep the deadline and callback from the same winning registration:
			// a later duplicate must not make an earlier callback run too late.
			if (deadline < existing.deadline) {
				existing.deadline = deadline;
				existing.cleanup = cleanup;
				existing.generation += 1;
				if (!existing.running) this.siftUp(existing.heapIndex);
				this.arm();
			} else if (deadline === existing.deadline) {
				existing.cleanup = cleanup;
				existing.generation += 1;
			}
			return true;
		}
		if (this.tasks.size >= this.capacity) return false;
		const task: CleanupTask = { key, deadline, cleanup, generation: 1, running: false, heapIndex: -1 };
		this.tasks.set(key, task);
		this.push(task);
		this.arm();
		return true;
	}

	private arm(): void {
		const earliest = this.heap[0]?.deadline;
		if (this.active >= this.concurrency || earliest === undefined) {
			this.clearWakeTimer();
			return;
		}
		if (this.timer && this.timerDeadline === earliest) return;
		this.clearWakeTimer();
		const delay = Math.min(MAX_CLEANUP_TIMER_DELAY_MS, Math.max(0, earliest - this.now()));
		let timer!: TimerHandle;
		timer = this.setTimer(() => {
			if (this.timer !== timer) return;
			this.timer = undefined;
			this.timerDeadline = undefined;
			this.drain();
		}, delay);
		this.timer = timer;
		this.timerDeadline = earliest;
		timer.unref?.();
	}

	private clearWakeTimer(): void {
		if (this.timer) this.clearTimer(this.timer);
		this.timer = undefined;
		this.timerDeadline = undefined;
	}

	private drain(): void {
		const now = this.now();
		while (this.active < this.concurrency && this.heap[0]?.deadline !== undefined && this.heap[0].deadline <= now) {
			const task = this.pop()!;
			task.running = true;
			const generation = task.generation;
			this.active += 1;
			void Promise.resolve().then(task.cleanup).then(
				() => this.finish(task, generation),
				() => this.finish(task, generation),
			);
		}
		// At capacity, completion calls drain itself. Never spin on a due task.
		this.arm();
	}

	private finish(task: CleanupTask, generation: number): void {
		this.active -= 1;
		if (this.tasks.get(task.key) === task) {
			task.running = false;
			if (task.generation === generation) this.tasks.delete(task.key);
			else this.push(task);
		}
		this.drain();
	}

	private push(task: CleanupTask): void {
		task.heapIndex = this.heap.length;
		this.heap.push(task);
		this.siftUp(task.heapIndex);
	}

	private pop(): CleanupTask | undefined {
		const first = this.heap[0];
		if (!first) return undefined;
		const last = this.heap.pop()!;
		first.heapIndex = -1;
		if (this.heap.length > 0) {
			this.heap[0] = last;
			last.heapIndex = 0;
			this.siftDown(0);
		}
		return first;
	}

	private siftUp(index: number): void {
		for (let child = index; child > 0;) {
			const parent = (child - 1) >> 1;
			if (!this.less(this.heap[child]!, this.heap[parent]!)) return;
			this.swap(child, parent);
			child = parent;
		}
	}

	private siftDown(index: number): void {
		for (let parent = index;;) {
			const left = parent * 2 + 1;
			const right = left + 1;
			let smallest = parent;
			if (left < this.heap.length && this.less(this.heap[left]!, this.heap[smallest]!)) smallest = left;
			if (right < this.heap.length && this.less(this.heap[right]!, this.heap[smallest]!)) smallest = right;
			if (smallest === parent) return;
			this.swap(parent, smallest);
			parent = smallest;
		}
	}

	private less(left: CleanupTask, right: CleanupTask): boolean {
		return left.deadline < right.deadline || left.deadline === right.deadline && left.key < right.key;
	}

	private swap(left: number, right: number): void {
		const value = this.heap[left]!;
		this.heap[left] = this.heap[right]!;
		this.heap[right] = value;
		this.heap[left]!.heapIndex = left;
		this.heap[right]!.heapIndex = right;
	}
}

function boundedPositive(value: number | undefined, fallback: number): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result < 1) throw new Error("Cleanup coordinator bounds must be positive safe integers.");
	return result;
}

const GLOBAL_CLEANUP_COORDINATOR = Symbol.for("@mjakl/pi-subagent.keyed-cleanup-coordinator.v2");
const GLOBAL_CLEANUP_COORDINATOR_ABI = 2 as const;
type CleanupGlobalRecord = CleanupScheduler & { abi: typeof GLOBAL_CLEANUP_COORDINATOR_ABI };
const REJECTED_SCHEDULER: CleanupScheduler = Object.freeze({ schedule: () => false });

function isExactGlobalRecord(value: unknown): value is CleanupGlobalRecord {
	try {
		if (!value || typeof value !== "object" || types.isProxy(value) || Object.getPrototypeOf(value) !== null || !Object.isFrozen(value)) return false;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(value).length !== 2 || Object.keys(descriptors).length !== 2) return false;
		const abi = descriptors.abi;
		const schedule = descriptors.schedule;
		return Boolean(abi && schedule && abi.value === GLOBAL_CLEANUP_COORDINATOR_ABI && typeof schedule.value === "function"
			&& schedule.value.length === 3 && Object.isFrozen(schedule.value) && !types.isProxy(schedule.value) && abi.writable === false && abi.enumerable === true && abi.configurable === false
			&& schedule.writable === false && schedule.enumerable === true && schedule.configurable === false
			&& !Object.hasOwn(abi, "get") && !Object.hasOwn(abi, "set") && !Object.hasOwn(schedule, "get") && !Object.hasOwn(schedule, "set"));
	} catch {
		return false;
	}
}

function createGlobalRecord(): CleanupGlobalRecord {
	const coordinator = new KeyedCleanupCoordinator();
	const schedule = Object.freeze((key: string, deadline: number, cleanup: () => Promise<void>): boolean => coordinator.schedule(key, deadline, cleanup));
	return Object.freeze(Object.create(null, {
		abi: { value: GLOBAL_CLEANUP_COORDINATOR_ABI, writable: false, enumerable: true, configurable: false },
		schedule: { value: schedule, writable: false, enumerable: true, configurable: false },
	})) as CleanupGlobalRecord;
}

/** Shared across extension reloads that evaluate separate module instances. */
export function getProcessGlobalCleanupCoordinator(): CleanupScheduler {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, GLOBAL_CLEANUP_COORDINATOR);
		if (descriptor) {
			return descriptor.writable === false && descriptor.enumerable === false && descriptor.configurable === false
				&& !Object.hasOwn(descriptor, "get") && !Object.hasOwn(descriptor, "set") && isExactGlobalRecord(descriptor.value)
				? descriptor.value : REJECTED_SCHEDULER;
		}
		const record = createGlobalRecord();
		Object.defineProperty(globalThis, GLOBAL_CLEANUP_COORDINATOR, {
			value: record, writable: false, enumerable: false, configurable: false,
		});
		return record;
	} catch {
		return REJECTED_SCHEDULER;
	}
}
