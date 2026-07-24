import { isResultError, isResultSuccess, type SingleResult } from "./types.js";

/** Usage fields that can be summed across independently running agents. */
export interface AdditiveUsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface IncrementalResultSnapshot {
  /** A new outer array for each public callback; result entries retain their existing identity. */
  results: SingleResult[];
  runningCount: number;
  doneCount: number;
  successCount: number;
  failureCount: number;
  usage: AdditiveUsageStats;
}

function emptyAdditiveUsage(): AdditiveUsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

interface ResultAccounting {
  running: boolean;
  success: boolean;
  failure: boolean;
  usage: AdditiveUsageStats;
}

function captureAccounting(result: SingleResult): ResultAccounting {
  return {
    running: result.exitCode === -1,
    success: isResultSuccess(result),
    failure: isResultError(result),
    usage: {
      input: result.usage.input,
      output: result.usage.output,
      cacheRead: result.usage.cacheRead,
      cacheWrite: result.usage.cacheWrite,
      cost: result.usage.cost,
      turns: result.usage.turns,
    },
  };
}

function addUsage(total: AdditiveUsageStats, usage: AdditiveUsageStats, direction: 1 | -1): void {
  total.input += direction * usage.input;
  total.output += direction * usage.output;
  total.cacheRead += direction * usage.cacheRead;
  total.cacheWrite += direction * usage.cacheWrite;
  total.cost += direction * usage.cost;
  total.turns += direction * usage.turns;
}

/**
 * Invocation-local result storage for aggregate progress updates.
 *
 * Replacing a child result adjusts only that slot's exit-state counters and
 * cumulative usage. Context-window size and model are intentionally retained
 * per result rather than aggregated.
 */
export class IncrementalResultSlots {
  private readonly slots: SingleResult[];
  /** Immutable accounting survives in-place mutation of public result objects. */
  private readonly accounting: ResultAccounting[];
  private readonly totalUsage = emptyAdditiveUsage();
  private runningCount = 0;
  private doneCount = 0;
  private successCount = 0;
  private failureCount = 0;

  constructor(initialResults: SingleResult[]) {
    this.slots = [...initialResults];
    this.accounting = initialResults.map(captureAccounting);
    for (const entry of this.accounting) this.add(entry, 1);
  }

  get hasRunning(): boolean {
    return this.runningCount > 0;
  }

  /** Replace one ordered result slot in O(1). */
  replace(index: number, result: SingleResult): void {
    const previous = this.slots[index];
    if (previous === undefined) {
      throw new RangeError(`Unknown result slot ${index}.`);
    }
    this.add(this.accounting[index]!, -1);
    this.slots[index] = result;
    const nextAccounting = captureAccounting(result);
    this.accounting[index] = nextAccounting;
    this.add(nextAccounting, 1);
  }

  /** Return callback-safe outer-array copy plus the incrementally maintained aggregate state. */
  snapshot(): IncrementalResultSnapshot {
    return {
      results: [...this.slots],
      runningCount: this.runningCount,
      doneCount: this.doneCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      usage: { ...this.totalUsage },
    };
  }

  private add(accounting: ResultAccounting, direction: 1 | -1): void {
    if (accounting.running) {
      this.runningCount += direction;
    } else {
      this.doneCount += direction;
      if (accounting.success) this.successCount += direction;
      if (accounting.failure) this.failureCount += direction;
    }
    addUsage(this.totalUsage, accounting.usage, direction);
  }
}
