/**
 * Frozen, consumer-owned compatibility models. These are copied test fixtures,
 * not pi-subagent parsers: update them from the named consumer repositories and
 * revisions in presence-v1-consumer-profiles.json. They must never import a
 * sibling checkout or production parser at runtime.
 *
 * Scope: deterministic V1 ready/update/remove/summary acceptance only. This is
 * not a live consumer, Pi loader, socket, or UI E2E substitute.
 */
import { isProxy } from "node:util/types";

export type PresenceChannel = "pi-presence:update:v1" | "pi-presence:remove:v1" | "pi-presence:ready:v1" | "pi-presence:summary:v1";
export type ConsumerAdvertisement = { readonly id: string; readonly capabilities: readonly string[] };

export interface FrozenConsumerContract {
  readonly name: string;
  readonly readyAdvertisement: ConsumerAdvertisement;
  readonly acceptsSummary: boolean;
  accept(channel: PresenceChannel, payload: unknown, sessionId: string): boolean;
}

type Fence = { readonly generation: number; readonly sequence: number };
type AcceptedUpdate = Fence & { readonly sourceId: string };
type SummaryFence = Fence & { readonly kind: "update" | "remove" };

const MAX_TEXT = 96;
const MAX_COUNT = 1_000_000;
const MAX_METRIC = 1_000_000_000_000;
const MAX_ACTIVE = 8;
const STATES = new Set(["idle", "waiting", "running", "success", "error", "cancelled"]);
const ATTENTION = new Set(["none", "info", "success", "error"]);
const UPDATE_KEYS = ["version", "sessionId", "generation", "sequence", "source", "state", "counts", "progress", "usage", "attention"];
const REMOVE_KEYS = ["version", "sessionId", "generation", "sequence", "source"];
const SOURCE_KEYS = ["id", "label", "kind"];
const COUNT_KEYS = ["active", "completed", "failed", "queued", "cancelled", "total"];
const PROGRESS_KEYS = ["value", "label"];
const USAGE_KEYS = ["tokens", "cost", "contextPercent"];
const SUMMARY_KEYS = ["version", "sessionId", "generation", "sequence", "source", "active", "waiting", "terminal", "omitted"];
const SUMMARY_ACTIVE_KEYS = ["id", "agent", "status", "category", "startedAt"];
const SUMMARY_WAITING_KEYS = ["category", "count"];
const SUMMARY_TERMINAL_KEYS = ["id", "agent", "status", "completedAt"];

function plainObject(value: unknown): value is Record<string, unknown> {
  return !isProxy(value) && typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Copy own data fields before reading them, as the frozen consumers do. */
function snapshotOwnDataFields(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> | null {
  if (!plainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key) => typeof key === "string" && allowed.includes(key)) || !required.every((key) => keys.includes(key))) return null;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    snapshot[key as string] = descriptor.value;
  }
  return snapshot;
}

function snapshotDenseArray(value: unknown, maximum: number): unknown[] | null {
  if (isProxy(value) || !Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) return null;
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1 || !keys.every((key) => key === "length" || (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length))) return null;
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    values.push(descriptor.value);
  }
  return values;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT * 2 && [...value].length <= MAX_TEXT
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value);
}
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT; }
function generation(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function sequence(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function metric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_METRIC; }
function percent(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100; }
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }
function advances(next: Fence, previous: Fence): boolean { return next.generation > previous.generation || (next.generation === previous.generation && next.sequence > previous.sequence); }

function parseReadyRequest(payload: unknown, sessionId: string): boolean {
  const root = snapshotOwnDataFields(payload, ["version", "sessionId"], ["version", "sessionId"]);
  return root !== null && root.version === 1 && text(root.sessionId) && root.sessionId === sessionId;
}

/** Frozen from both current V1 consumers, including all optional update DTO fields. */
function parseUpdate(payload: unknown, sessionId: string): AcceptedUpdate | null {
  const root = snapshotOwnDataFields(payload, UPDATE_KEYS, ["version", "sessionId", "generation", "sequence", "source", "state", "counts"]);
  if (!root || root.version !== 1 || !text(root.sessionId) || root.sessionId !== sessionId || !generation(root.generation) || !sequence(root.sequence)
    || !text(root.state) || !STATES.has(root.state)) return null;
  const source = snapshotOwnDataFields(root.source, SOURCE_KEYS, SOURCE_KEYS);
  const counts = snapshotOwnDataFields(root.counts, COUNT_KEYS, ["active", "completed", "failed"]);
  if (!source || !text(source.id) || !text(source.label) || !text(source.kind) || !counts
    || !count(counts.active) || !count(counts.completed) || !count(counts.failed)
    || (counts.queued !== undefined && !count(counts.queued))
    || (counts.cancelled !== undefined && !count(counts.cancelled))
    || (counts.total !== undefined && !count(counts.total))) return null;

  if (root.progress !== undefined) {
    const progress = snapshotOwnDataFields(root.progress, PROGRESS_KEYS, ["value"]);
    if (!progress || !metric(progress.value) || progress.value > 1 || (progress.label !== undefined && !text(progress.label))) return null;
  }
  if (root.usage !== undefined) {
    const usage = snapshotOwnDataFields(root.usage, USAGE_KEYS, []);
    if (!usage || (usage.tokens !== undefined && !metric(usage.tokens))
      || (usage.cost !== undefined && !metric(usage.cost))
      || (usage.contextPercent !== undefined && !percent(usage.contextPercent))) return null;
  }
  if (root.attention !== undefined && (!text(root.attention) || !ATTENTION.has(root.attention))) return null;
  return { generation: root.generation, sequence: root.sequence, sourceId: source.id };
}

function parseRemove(payload: unknown, sessionId: string): AcceptedUpdate | null {
  const root = snapshotOwnDataFields(payload, REMOVE_KEYS, REMOVE_KEYS);
  if (!root || root.version !== 1 || !text(root.sessionId) || root.sessionId !== sessionId || !generation(root.generation) || !sequence(root.sequence)) return null;
  const source = snapshotOwnDataFields(root.source, ["id"], ["id"]);
  return source && text(source.id) ? { generation: root.generation, sequence: root.sequence, sourceId: source.id } : null;
}

/** Frozen from pi-herdr-presence @ 0918827's strict companion summary DTO. */
function parsePiSubagentSummary(payload: unknown, sessionId: string): Fence | null {
  const root = snapshotOwnDataFields(payload, SUMMARY_KEYS, ["version", "sessionId", "generation", "sequence", "source", "active", "omitted"]);
  if (!root || root.version !== 1 || !text(root.sessionId) || root.sessionId !== sessionId || !generation(root.generation) || !sequence(root.sequence) || !count(root.omitted)) return null;
  const source = snapshotOwnDataFields(root.source, ["id"], ["id"]);
  const active = snapshotDenseArray(root.active, MAX_ACTIVE);
  if (!source || source.id !== "pi-subagent" || !active) return null;
  for (const rawItem of active) {
    const item = snapshotOwnDataFields(rawItem, SUMMARY_ACTIVE_KEYS, SUMMARY_ACTIVE_KEYS);
    if (!item || !text(item.id) || !text(item.agent) || (item.status !== "running" && item.status !== "cancelling")
      || (item.category !== "active" && item.category !== "cancelling") || !timestamp(item.startedAt)
      || (item.status === "cancelling") !== (item.category === "cancelling")) return null;
  }
  if (Object.hasOwn(root, "waiting")) {
    const waiting = snapshotOwnDataFields(root.waiting, SUMMARY_WAITING_KEYS, SUMMARY_WAITING_KEYS);
    if (!waiting || (waiting.category !== "queued" && waiting.category !== "cancelling") || !count(waiting.count)) return null;
  }
  if (Object.hasOwn(root, "terminal")) {
    const terminal = snapshotOwnDataFields(root.terminal, SUMMARY_TERMINAL_KEYS, SUMMARY_TERMINAL_KEYS);
    if (!terminal || !text(terminal.id) || !text(terminal.agent)
      || (terminal.status !== "completed" && terminal.status !== "failed" && terminal.status !== "cancelled") || !timestamp(terminal.completedAt)) return null;
  }
  return { generation: root.generation, sequence: root.sequence };
}

class ConsumerModel implements FrozenConsumerContract {
  readonly readyAdvertisement: ConsumerAdvertisement;
  private readonly fences = new Map<string, Fence>();
  private summaryFence: SummaryFence | null = null;
  private summaryCompanionAccepted = false;

  constructor(readonly name: string, id: string, capabilities: readonly string[], readonly acceptsSummary: boolean) {
    this.readyAdvertisement = Object.freeze({ id, capabilities: Object.freeze([...capabilities]) });
  }

  accept(channel: PresenceChannel, payload: unknown, sessionId: string): boolean {
    try {
      if (channel === "pi-presence:ready:v1") return parseReadyRequest(payload, sessionId);
      if (channel === "pi-presence:update:v1") {
        const update = parseUpdate(payload, sessionId);
        if (!update || !this.acceptFence(update)) return false;
        if (update.sourceId === "pi-subagent") {
          this.summaryFence = { generation: update.generation, sequence: update.sequence, kind: "update" };
          this.summaryCompanionAccepted = false;
        }
        return true;
      }
      if (channel === "pi-presence:remove:v1") {
        const remove = parseRemove(payload, sessionId);
        if (!remove || !this.fences.has(remove.sourceId) || !this.acceptFence(remove)) return false;
        if (remove.sourceId === "pi-subagent") {
          this.summaryFence = { generation: remove.generation, sequence: remove.sequence, kind: "remove" };
          this.summaryCompanionAccepted = false;
        }
        return true;
      }
      if (!this.acceptsSummary) return false;
      const summary = parsePiSubagentSummary(payload, sessionId);
      const fence = this.summaryFence;
      if (!summary || !fence || this.summaryCompanionAccepted || fence.kind !== "update"
        || fence.generation !== summary.generation || fence.sequence !== summary.sequence) return false;
      this.summaryCompanionAccepted = true;
      return true;
    } catch {
      return false;
    }
  }

  private acceptFence(next: AcceptedUpdate): boolean {
    const previous = this.fences.get(next.sourceId);
    if (previous && !advances(next, previous)) return false;
    this.fences.set(next.sourceId, { generation: next.generation, sequence: next.sequence });
    return true;
  }
}

export function createFrozenConsumerContract(name: string): FrozenConsumerContract {
  switch (name) {
    // Frozen from pi-cmux-presence @ 2ef26ac: its current ready advertisement
    // and strict V1 update/remove consumer path deliberately omit summary:v1.
    case "pi-cmux-presence-ready-v1":
      return new ConsumerModel("pi-cmux-presence-ready-v1", "pi-cmux-presence", ["cmux-status", "cmux-progress", "cmux-attention", "presence-remove-v1"], false);
    // Frozen from pi-herdr-presence @ 0918827. Its summary is a strict,
    // one-shot companion to one already accepted pi-subagent update fence.
    case "pi-herdr-presence-ready-v1":
      return new ConsumerModel("pi-herdr-presence-ready-v1", "pi-herdr-presence", ["presence-remove-v1", "presence-summary-v1", "herdr-pane-report-agent-v1", "herdr-pane-report-metadata-v1"], true);
    default:
      throw new Error(`Unknown frozen consumer contract: ${name}`);
  }
}
