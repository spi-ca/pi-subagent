import type { ReaperDiagnostic } from "../runtime/runner.js";

const MAX_LOG_IDENTIFIERS = 20;
const MAX_LOG_ERROR_CHARS = 2_000;

export interface ReaperDiagnosticOutput {
  hasUI: boolean;
  notify: (message: string, type: "warning" | "error") => void;
  warn: (message: string, details?: unknown) => void;
}

interface StoredDiagnostic {
  diagnostic: ReaperDiagnostic;
  occurrences: number;
  invalidIds: Set<string>;
}

function diagnosticKey(diagnostic: ReaperDiagnostic): string {
  return `${diagnostic.severity}:${diagnostic.code}`;
}

function invalidIdentifiers(diagnostic: ReaperDiagnostic): string[] {
  if (diagnostic.code !== "fork-source-invalid" || typeof diagnostic.details !== "object" || diagnostic.details === null) return [];
  const invalid = (diagnostic.details as { invalid?: unknown }).invalid;
  return Array.isArray(invalid) ? invalid.filter((value): value is string => typeof value === "string") : [];
}

function boundedLogDetails(diagnostic: ReaperDiagnostic): unknown {
  if (typeof diagnostic.details !== "object" || diagnostic.details === null) return diagnostic.details;
  if (diagnostic.code === "fork-source-invalid") {
    const outcome = diagnostic.details as Record<string, unknown>;
    return Object.fromEntries(["scanned", "resolved", "retained", "removed", "invalid"].map((key) => {
      const values = Array.isArray(outcome[key]) ? outcome[key]!.filter((value): value is string => typeof value === "string") : [];
      return [key, { count: values.length, values: values.slice(0, MAX_LOG_IDENTIFIERS) }];
    }));
  }
  const error = (diagnostic.details as { error?: unknown }).error;
  if (typeof error === "string") {
    return { error: error.length <= MAX_LOG_ERROR_CHARS ? error : `${error.slice(0, MAX_LOG_ERROR_CHARS)}…` };
  }
  return diagnostic.details;
}

/** Session-local, deduplicated routing for background reaper diagnostics. */
export class ReaperDiagnosticUx {
  readonly #diagnostics = new Map<string, StoredDiagnostic>();
  readonly #notified = new Set<string>();
  #generation = 0;

  startSession(): number {
    this.#generation += 1;
    this.#diagnostics.clear();
    this.#notified.clear();
    return this.#generation;
  }

  /**
   * Fence late producers without clearing the closing session's summary or
   * dedupe state. The next startSession performs that reset.
   */
  invalidateSession(): number {
    this.#generation += 1;
    return this.#generation;
  }

  report(expectedGeneration: number, diagnostic: ReaperDiagnostic, output: ReaperDiagnosticOutput): void {
    if (expectedGeneration !== this.#generation) return;
    const key = diagnosticKey(diagnostic);
    const existing = this.#diagnostics.get(key);
    if (existing) {
      existing.diagnostic = diagnostic;
      existing.occurrences += 1;
      for (const id of invalidIdentifiers(diagnostic)) existing.invalidIds.add(id);
    } else {
      this.#diagnostics.set(key, {
        diagnostic,
        occurrences: 1,
        invalidIds: new Set(invalidIdentifiers(diagnostic)),
      });
    }
    if (diagnostic.severity === "debug" || this.#notified.has(key)) return;
    this.#notified.add(key);

    const warn = (): void => {
      try { output.warn(`[pi-subagent] ${diagnostic.message}`, boundedLogDetails(diagnostic)); }
      catch { /* Diagnostics cannot change cleanup authority or completion. */ }
    };
    if (!output.hasUI) { warn(); return; }
    try {
      output.notify(diagnostic.message, diagnostic.severity);
    } catch {
      // A failed Pi notification must not erase the only observable evidence.
      warn();
    }
  }

  snapshot(): ReaperDiagnostic[] {
    return Array.from(this.#diagnostics.values(), ({ diagnostic }) => diagnostic);
  }

  formatDoctorStatus(): string[] {
    if (this.#diagnostics.size === 0) return ["reaper diagnostics: none"];
    return [
      `reaper diagnostics: ${this.#diagnostics.size} retained`,
      ...Array.from(this.#diagnostics.values(), ({ diagnostic, occurrences, invalidIds }) => {
        const repeated = occurrences === 1 ? "" : `, ${occurrences} occurrences`;
        const invalid = invalidIds.size === 0 ? "" : `, ${invalidIds.size} unique invalid record${invalidIds.size === 1 ? "" : "s"}`;
        return `reaper ${diagnostic.severity}: ${diagnostic.code}${repeated}${invalid}; durable state retained for inspection`;
      }),
    ];
  }
}
