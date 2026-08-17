/**
 * Frozen, consumer-owned compatibility models. These are copied test fixtures,
 * not pi-subagent parsers: update them from the named consumer repositories and
 * revisions in presence-v1-consumer-profiles.json. They must never import a
 * sibling checkout or production parser at runtime.
 *
 * Scope: deterministic V1 ready/update/remove/summary acceptance only. This is
 * not a live consumer, Pi loader, socket, or UI E2E substitute.
 */
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

const TEXT = (value: unknown): value is string => typeof value === "string" && value.length > 0 && [...value].length <= 96 && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value);
const COUNT = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
const FENCE = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const SEQUENCE = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key)) && keys.every((key) => key in value);
const optionalKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean => Object.keys(value).every((key) => required.includes(key) || optional.includes(key)) && required.every((key) => key in value);
const advances = (next: Fence, previous: Fence): boolean => next.generation > previous.generation || (next.generation === previous.generation && next.sequence > previous.sequence);

function parseReadyRequest(payload: unknown, sessionId: string): boolean {
  return object(payload) && exactKeys(payload, ["version", "sessionId"])
    && payload.version === 1 && payload.sessionId === sessionId;
}

function parseUpdate(payload: unknown, sessionId: string): AcceptedUpdate | null {
  if (!object(payload) || !optionalKeys(payload,
    ["version", "sessionId", "generation", "sequence", "source", "state", "counts"],
    ["progress", "usage", "attention"])
    || payload.version !== 1 || payload.sessionId !== sessionId || !FENCE(payload.generation) || !SEQUENCE(payload.sequence)
    || !object(payload.source) || !exactKeys(payload.source, ["id", "label", "kind"])
    || !TEXT(payload.source.id) || !TEXT(payload.source.label) || !TEXT(payload.source.kind)
    || !object(payload.counts) || !optionalKeys(payload.counts, ["active", "completed", "failed"], ["queued", "cancelled", "total"])
    || !COUNT(payload.counts.active) || !COUNT(payload.counts.completed) || !COUNT(payload.counts.failed)
    || (payload.counts.queued !== undefined && !COUNT(payload.counts.queued))
    || (payload.counts.cancelled !== undefined && !COUNT(payload.counts.cancelled))
    || (payload.counts.total !== undefined && !COUNT(payload.counts.total))
    || !["idle", "waiting", "running", "success", "error", "cancelled"].includes(payload.state as string)) return null;
  return { generation: payload.generation, sequence: payload.sequence, sourceId: payload.source.id };
}

function parseRemove(payload: unknown, sessionId: string): AcceptedUpdate | null {
  if (!object(payload) || !exactKeys(payload, ["version", "sessionId", "generation", "sequence", "source"])
    || payload.version !== 1 || payload.sessionId !== sessionId || !FENCE(payload.generation) || !SEQUENCE(payload.sequence)
    || !object(payload.source) || !exactKeys(payload.source, ["id"]) || !TEXT(payload.source.id)) return null;
  return { generation: payload.generation, sequence: payload.sequence, sourceId: payload.source.id };
}

function parsePiSubagentSummary(payload: unknown, sessionId: string): Fence | null {
  if (!object(payload) || !optionalKeys(payload,
    ["version", "sessionId", "generation", "sequence", "source", "active", "omitted"],
    ["waiting", "terminal"])
    || payload.version !== 1 || payload.sessionId !== sessionId || !FENCE(payload.generation) || !SEQUENCE(payload.sequence)
    || !object(payload.source) || !exactKeys(payload.source, ["id"]) || payload.source.id !== "pi-subagent"
    || !Array.isArray(payload.active) || payload.active.length > 8 || !COUNT(payload.omitted)) return null;
  for (const item of payload.active) {
    if (!object(item) || !exactKeys(item, ["id", "agent", "status", "category", "startedAt"])
      || !TEXT(item.id) || !TEXT(item.agent) || !["running", "cancelling"].includes(item.status as string)
      || !["active", "cancelling"].includes(item.category as string) || !FENCE(item.startedAt)
      || (item.status === "cancelling") !== (item.category === "cancelling")) return null;
  }
  return { generation: payload.generation, sequence: payload.sequence };
}

class ConsumerModel implements FrozenConsumerContract {
  readonly readyAdvertisement: ConsumerAdvertisement;
  private readonly fences = new Map<string, Fence>();
  private readonly acceptedUpdates = new Map<string, AcceptedUpdate>();

  constructor(readonly name: string, id: string, capabilities: readonly string[], readonly acceptsSummary: boolean) {
    this.readyAdvertisement = Object.freeze({ id, capabilities: Object.freeze([...capabilities]) });
  }

  accept(channel: PresenceChannel, payload: unknown, sessionId: string): boolean {
    if (channel === "pi-presence:ready:v1") return parseReadyRequest(payload, sessionId);
    if (channel === "pi-presence:update:v1") {
      const update = parseUpdate(payload, sessionId);
      if (!update || !this.acceptFence(update)) return false;
      this.acceptedUpdates.set(update.sourceId, update);
      return true;
    }
    if (channel === "pi-presence:remove:v1") {
      const remove = parseRemove(payload, sessionId);
      if (!remove || !this.fences.has(remove.sourceId) || !this.acceptFence(remove)) return false;
      this.acceptedUpdates.delete(remove.sourceId);
      return true;
    }
    if (!this.acceptsSummary) return false;
    const summary = parsePiSubagentSummary(payload, sessionId);
    const update = this.acceptedUpdates.get("pi-subagent");
    return summary !== null && update !== undefined && update.generation === summary.generation && update.sequence === summary.sequence;
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
    // Frozen from pi-herdr-presence @ 0918827: summary is only accepted as a
    // same-fence companion to an accepted pi-subagent update.
    case "pi-herdr-presence-ready-v1":
      return new ConsumerModel("pi-herdr-presence-ready-v1", "pi-herdr-presence", ["presence-remove-v1", "presence-summary-v1", "herdr-pane-report-agent-v1", "herdr-pane-report-metadata-v1"], true);
    default:
      throw new Error(`Unknown frozen consumer contract: ${name}`);
  }
}
