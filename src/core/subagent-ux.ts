export type SubagentUxStatus = "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type SubagentUxKind = "foreground" | "background";

const TERMINAL_STATUSES = new Set<SubagentUxStatus>(["completed", "failed", "cancelled"]);
const ANSI_ESCAPE_SEQUENCE = /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[PX^_][^\x1b]*\x1b\\|[@-_])/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_ID_CHARACTERS = /[\s\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface SubagentUxSnapshot {
  readonly id: string;
  readonly agent: string;
  readonly kind: SubagentUxKind;
  readonly status: SubagentUxStatus;
  readonly generation: number;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly preview?: string;
  /** Aggregate-only progress; task and output text are never retained here. */
  readonly progress?: { readonly completed: number; readonly total: number };
}

export interface SubagentUxRegistrySnapshot {
  readonly generation: number;
  readonly active: readonly SubagentUxSnapshot[];
  readonly recent: readonly SubagentUxSnapshot[];
}

export interface SubagentUxRegistration {
  /** An opaque full identifier. It must be supplied unchanged to cancel(). */
  id?: string;
  agent: string;
  kind: SubagentUxKind;
  startedAt?: number;
  // Accepted only so callers can pass their internal job record directly. They
  // are intentionally never retained in UI snapshots.
  task?: unknown;
  path?: unknown;
  cwd?: unknown;
  secret?: unknown;
  /** Private cancellation authority; never exposed through snapshots. */
  cancel?: () => void;
  /** Positive known aggregate work count for determinate UI progress. */
  progressTotal?: number;
}

export interface SubagentUxRegistryOptions {
  recentLimit?: number;
  now?: () => number;
  createId?: () => string;
}

export interface SubagentUxCancelResult {
  readonly found: boolean;
  readonly changed: boolean;
  readonly snapshot?: SubagentUxSnapshot;
}

export type SubagentsCommand =
  | { readonly kind: "list" }
  | { readonly kind: "doctor" }
  | { readonly kind: "cancel" | "details" | "focus" | "keep" | "promote"; readonly id: string };

interface MutableSubagentUxRecord {
  id: string;
  agent: string;
  kind: SubagentUxKind;
  status: SubagentUxStatus;
  generation: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  preview?: string;
  progress?: { completed: number; total: number };
}

function validTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error("Subagent UX timestamps must be non-negative finite numbers.");
  return value;
}

function validId(value: string): string {
  if (!value || UNSAFE_ID_CHARACTERS.test(value)) throw new Error("Subagent UX ids must be non-empty safe single tokens.");
  return value;
}

/** Removes terminal control sequences before an agent label reaches a terminal. */
export function sanitizeSubagentAgentLabel(value: unknown, maxLength = 96): string {
  const safeMaxLength = Number.isSafeInteger(maxLength) && maxLength >= 1 ? maxLength : 96;
  const normalized = String(value ?? "")
    .replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "unknown";
  return normalized.length <= safeMaxLength ? normalized : `${normalized.slice(0, Math.max(0, safeMaxLength - 1)).trimEnd()}…`;
}

export function sanitizeSubagentPreview(value: unknown, maxLength = 256): string | undefined {
  const normalized = String(value ?? "").replace(ANSI_ESCAPE_SEQUENCE, "")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function displayId(id: string): string {
  return id.replace(ANSI_ESCAPE_SEQUENCE, "").replace(CONTROL_CHARACTERS, "").replace(/\s+/g, " ").trim() || "unknown";
}

function freezeSnapshot(record: MutableSubagentUxRecord): SubagentUxSnapshot {
  const snapshot: SubagentUxSnapshot = {
    id: record.id,
    agent: record.agent,
    kind: record.kind,
    status: record.status,
    generation: record.generation,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.preview === undefined ? {} : { preview: record.preview }),
    ...(record.progress === undefined ? {} : { progress: Object.freeze({ ...record.progress }) }),
  };
  return Object.freeze(snapshot);
}

const STATUS_PRESENTATION: Readonly<Record<SubagentUxStatus, { readonly icon: string; readonly label: string; readonly attention: number }>> = Object.freeze({
  failed: { icon: "✕", label: "failed", attention: 0 },
  cancelling: { icon: "◌", label: "cancelling", attention: 1 },
  running: { icon: "●", label: "running", attention: 2 },
  completed: { icon: "✓", label: "completed", attention: 3 },
  cancelled: { icon: "–", label: "cancelled", attention: 4 },
});

/** Presentation-only attention order; lifecycle state remains authoritative elsewhere. */
function compareAttentionFirst(left: Pick<SubagentUxSnapshot, "id" | "status" | "startedAt">, right: Pick<SubagentUxSnapshot, "id" | "status" | "startedAt">): number {
  return STATUS_PRESENTATION[left.status].attention - STATUS_PRESENTATION[right.status].attention
    || left.startedAt - right.startedAt
    || left.id.localeCompare(right.id);
}

function compareOldestFirst(left: MutableSubagentUxRecord, right: MutableSubagentUxRecord): number {
  return left.startedAt - right.startedAt || left.id.localeCompare(right.id);
}

function compareNewestFirst(left: MutableSubagentUxRecord, right: MutableSubagentUxRecord): number {
  return (right.completedAt ?? right.updatedAt) - (left.completedAt ?? left.updatedAt) || right.id.localeCompare(left.id);
}

function compareTerminalOldestFirst(left: MutableSubagentUxRecord, right: MutableSubagentUxRecord): number {
  return (left.completedAt ?? left.updatedAt) - (right.completedAt ?? right.updatedAt) || left.id.localeCompare(right.id);
}

/**
 * Session-local, presentation-only state. It deliberately contains no task,
 * working-directory, output, error, or credential material.
 */
export class SubagentUxRegistry {
  private readonly active = new Map<string, MutableSubagentUxRecord>();
  private readonly recent = new Map<string, MutableSubagentUxRecord>();
  private readonly observers = new Set<(snapshot: SubagentUxRegistrySnapshot) => void>();
  private readonly cancelAuthorities = new Map<string, () => void>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly recentLimit: number;
  private nextId = 0;
  private currentGeneration = 0;

  constructor(options: SubagentUxRegistryOptions = {}) {
    if (options.recentLimit !== undefined && (!Number.isSafeInteger(options.recentLimit) || options.recentLimit < 0)) {
      throw new Error("Subagent UX recentLimit must be a non-negative safe integer.");
    }
    this.recentLimit = options.recentLimit ?? 20;
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => `subagent-${++this.nextId}`);
  }

  get generation(): number {
    return this.currentGeneration;
  }

  captureGeneration(): number {
    return this.currentGeneration;
  }

  isCurrentGeneration(generation: number): boolean {
    return generation === this.currentGeneration;
  }

  start(input: SubagentUxRegistration): SubagentUxSnapshot {
    const id = validId(input.id ?? this.createId());
    if (this.active.has(id) || this.recent.has(id)) throw new Error(`Subagent UX id already exists: ${id}`);
    const startedAt = validTimestamp(input.startedAt ?? this.now());
    if (input.progressTotal !== undefined && (!Number.isSafeInteger(input.progressTotal) || input.progressTotal <= 0)) {
      throw new Error("Subagent UX progressTotal must be a positive safe integer.");
    }
    const record: MutableSubagentUxRecord = {
      id,
      agent: sanitizeSubagentAgentLabel(input.agent),
      kind: input.kind,
      status: "running",
      generation: this.currentGeneration,
      startedAt,
      updatedAt: startedAt,
      ...(input.progressTotal === undefined ? {} : { progress: { completed: 0, total: input.progressTotal } }),
    };
    this.active.set(id, record);
    if (input.cancel) this.cancelAuthorities.set(id, input.cancel);
    const snapshot = freezeSnapshot(record);
    this.emit();
    return snapshot;
  }

  /** Alias for callers that describe launch registration rather than start. */
  register(input: SubagentUxRegistration): SubagentUxSnapshot {
    return this.start(input);
  }

  get(id: string): SubagentUxSnapshot | undefined {
    const record = this.active.get(id) ?? this.recent.get(id);
    return record ? freezeSnapshot(record) : undefined;
  }

  list(): readonly SubagentUxSnapshot[] {
    return Object.freeze([
      ...Array.from(this.active.values()),
      ...Array.from(this.recent.values()),
    ].sort(compareAttentionFirst).map(freezeSnapshot));
  }

  snapshot(): SubagentUxRegistrySnapshot {
    const active = Object.freeze(Array.from(this.active.values()).sort(compareOldestFirst).map(freezeSnapshot));
    const recent = Object.freeze(Array.from(this.recent.values()).sort(compareNewestFirst).map(freezeSnapshot));
    return Object.freeze({ generation: this.currentGeneration, active, recent });
  }

  subscribe(observer: (snapshot: SubagentUxRegistrySnapshot) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  cancel(id: string, generation = this.currentGeneration): SubagentUxCancelResult {
    if (!this.isCurrentGeneration(generation)) return Object.freeze({ found: false, changed: false });
    const record = this.active.get(id) ?? this.recent.get(id);
    if (!record) return Object.freeze({ found: false, changed: false });
    if (record.status !== "running") return Object.freeze({ found: true, changed: false, snapshot: freezeSnapshot(record) });

    record.status = "cancelling";
    record.updatedAt = validTimestamp(this.now());
    try { this.cancelAuthorities.get(id)?.(); } catch { /* state remains cancelling; caller lifecycle reports failure. */ }
    const snapshot = freezeSnapshot(record);
    this.emit();
    return Object.freeze({ found: true, changed: true, snapshot });
  }

  updatePreview(id: string, value: unknown, generation = this.currentGeneration): SubagentUxSnapshot | undefined {
    if (!this.isCurrentGeneration(generation)) return undefined;
    const record = this.active.get(id) ?? this.recent.get(id);
    if (!record) return undefined;
    const preview = sanitizeSubagentPreview(value, 256);
    if (!preview) return freezeSnapshot(record);
    record.preview = preview;
    record.updatedAt = validTimestamp(this.now());
    const snapshot = freezeSnapshot(record);
    this.emit();
    return snapshot;
  }

  updateProgress(id: string, completed: number, total: number, generation = this.currentGeneration): SubagentUxSnapshot | undefined {
    if (!this.isCurrentGeneration(generation) || !Number.isSafeInteger(completed) || !Number.isSafeInteger(total)
      || total <= 0 || completed < 0 || completed > total) return undefined;
    const record = this.active.get(id);
    if (!record) return undefined;
    record.progress = { completed, total };
    record.updatedAt = validTimestamp(this.now());
    const snapshot = freezeSnapshot(record);
    this.emit();
    return snapshot;
  }

  complete(id: string, generation = this.currentGeneration): SubagentUxSnapshot | undefined {
    return this.finish(id, "completed", generation);
  }

  fail(id: string, generation = this.currentGeneration): SubagentUxSnapshot | undefined {
    return this.finish(id, "failed", generation);
  }

  cancelled(id: string, generation = this.currentGeneration): SubagentUxSnapshot | undefined {
    return this.finish(id, "cancelled", generation);
  }

  finish(id: string, status: Extract<SubagentUxStatus, "completed" | "failed" | "cancelled">, generation = this.currentGeneration): SubagentUxSnapshot | undefined {
    if (!TERMINAL_STATUSES.has(status) || !this.isCurrentGeneration(generation)) return undefined;
    const record = this.active.get(id);
    if (!record) return this.recent.has(id) ? freezeSnapshot(this.recent.get(id)!) : undefined;

    const completedAt = validTimestamp(this.now());
    record.status = status;
    record.updatedAt = completedAt;
    record.completedAt = completedAt;
    if (record.progress) record.progress = { completed: record.progress.total, total: record.progress.total };
    this.active.delete(id);
    this.cancelAuthorities.delete(id);
    this.recent.set(id, record);
    this.pruneRecent();
    const snapshot = freezeSnapshot(record);
    this.emit();
    return snapshot;
  }

  /** Starts a new session and makes stale callback tokens unable to mutate it. */
  reset(): number {
    this.currentGeneration += 1;
    this.active.clear();
    this.recent.clear();
    this.cancelAuthorities.clear();
    this.emit();
    return this.currentGeneration;
  }

  private pruneRecent(): void {
    const overflow = this.recent.size - this.recentLimit;
    if (overflow <= 0) return;
    for (const record of Array.from(this.recent.values()).sort(compareTerminalOldestFirst).slice(0, overflow)) this.recent.delete(record.id);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const observer of this.observers) {
      try { observer(snapshot); } catch { /* UI observers must not break job tracking. */ }
    }
  }
}

/** Parses only the complete supported command forms; prefixes and extra tokens are rejected. */
export function parseSubagentsCommand(raw: unknown): SubagentsCommand | null {
  if (typeof raw !== "string") return null;
  const input = raw.trim();
  if (input === "" || input === "list") return { kind: "list" };
  if (input === "doctor") return { kind: "doctor" };
  const match = /^(cancel|details|focus|keep|promote) ([^\s]+)$/u.exec(input);
  return match && validCommandId(match[2]) ? { kind: match[1] as "cancel" | "details" | "focus" | "keep" | "promote", id: match[2] } : null;
}

function validCommandId(id: string): boolean {
  return !UNSAFE_ID_CHARACTERS.test(id);
}

export function formatSubagentUxStatus(status: SubagentUxStatus): string {
  const presentation = STATUS_PRESENTATION[status];
  return `${presentation.icon} ${presentation.label}`;
}

/** Success/cancellation are already visible through tool results, steer, and status. */
export function subagentUxTerminalNotification(status: SubagentUxStatus): "warning" | null {
  return status === "failed" ? "warning" : null;
}

export function formatSubagentUxCompactStatus(job: SubagentUxSnapshot): string {
  return `${displayId(job.id)} [${formatSubagentUxStatus(job.status)}] ${job.kind} ${sanitizeSubagentAgentLabel(job.agent)}`;
}

/**
 * `schedulerQueued` is the scheduler's aggregate queue count, not an
 * invocation-specific position. It is deliberately passed at render time so
 * the presentation registry never becomes lifecycle or scheduler authority.
 */
export function formatSubagentUxFooter(snapshot: SubagentUxRegistrySnapshot, schedulerQueued = 0): string | undefined {
  if (!Number.isSafeInteger(schedulerQueued) || schedulerQueued < 0) throw new Error("Subagent UX schedulerQueued must be a non-negative safe integer.");
  const jobs = [...snapshot.active, ...snapshot.recent];
  const counts = (status: SubagentUxStatus) => jobs.filter((job) => job.status === status).length;
  if (jobs.length === 0 && schedulerQueued === 0) return undefined;
  return `subagents: ●${counts("running")} ◷${schedulerQueued} ◌${counts("cancelling")} ✓${counts("completed")} ✕${counts("failed")} –${counts("cancelled")}`;
}

export function formatSubagentUxList(jobs: Iterable<SubagentUxSnapshot>): string {
  const entries = Array.from(jobs).sort(compareAttentionFirst).map((job) => {
    const completed = job.completedAt === undefined ? "" : `, completed ${job.completedAt}`;
    return `- ${formatSubagentUxCompactStatus(job)}, started ${job.startedAt}${completed}`;
  });
  return entries.length ? entries.join("\n") : "No subagents.";
}

export function formatSubagentUxDetail(job: SubagentUxSnapshot): string {
  const lines = [
    `Subagent ${displayId(job.id)}`,
    `- status: ${formatSubagentUxStatus(job.status)}`,
    `- kind: ${job.kind}`,
    `- agent: ${sanitizeSubagentAgentLabel(job.agent)}`,
    `- startedAt: ${job.startedAt}`,
    `- elapsedMs: ${Math.max(0, (job.completedAt ?? Date.now()) - job.startedAt)}`,
  ];
  if (job.completedAt !== undefined) lines.push(`- completedAt: ${job.completedAt}`);
  if (job.preview !== undefined) lines.push(`- preview: ${sanitizeSubagentPreview(job.preview, 256) ?? "unavailable"}`);
  return lines.join("\n");
}
