export interface SessionSnapshotSource {
  getBranch: () => unknown[];
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeFinite(value: unknown): value is number {
  return finite(value) && value >= 0;
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function textOrImageContent(value: unknown): boolean {
  const item = record(value);
  return Boolean(item && (
    item.type === "text" && typeof item.text === "string"
    || item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string"
  ));
}

function assistantContent(value: unknown): boolean {
  const item = record(value);
  return Boolean(item && (
    item.type === "text" && typeof item.text === "string"
    || item.type === "thinking" && typeof item.thinking === "string"
    || item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string" && record(item.arguments) !== null
  ));
}

function isUsage(value: unknown): boolean {
  const usage = record(value);
  const cost = usage && record(usage.cost);
  if (!usage || !cost
    || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every(nonNegativeFinite)
    || ![cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(nonNegativeFinite)) return false;
  // These are provider-specific passthrough fields, not part of this fork
  // format's claimed schema. If present, they must still be safe numbers.
  return (usage.cacheWrite1h === undefined || nonNegativeFinite(usage.cacheWrite1h))
    && (usage.reasoning === undefined || nonNegativeFinite(usage.reasoning));
}

function isPersistedMessage(value: unknown): boolean {
  const message = record(value);
  if (!message || !finite(message.timestamp) || typeof message.role !== "string") return false;
  if (message.role === "user") {
    return typeof message.content === "string" || Array.isArray(message.content) && message.content.every(textOrImageContent);
  }
  if (message.role === "assistant") {
    return Array.isArray(message.content) && message.content.every(assistantContent)
      && typeof message.api === "string" && typeof message.provider === "string" && typeof message.model === "string"
      && isUsage(message.usage) && ["stop", "length", "toolUse", "error", "aborted"].includes(String(message.stopReason));
  }
  if (message.role === "toolResult") {
    return typeof message.toolCallId === "string" && typeof message.toolName === "string"
      && Array.isArray(message.content) && message.content.every(textOrImageContent) && typeof message.isError === "boolean"
      && (message.usage === undefined || isUsage(message.usage));
  }
  if (message.role === "bashExecution") {
    return typeof message.command === "string" && typeof message.output === "string"
      && (message.exitCode === undefined || finite(message.exitCode)) && typeof message.cancelled === "boolean" && typeof message.truncated === "boolean";
  }
  if (message.role === "custom") {
    return typeof message.customType === "string" && typeof message.display === "boolean"
      && (typeof message.content === "string" || Array.isArray(message.content) && message.content.every(textOrImageContent));
  }
  if (message.role === "branchSummary") return typeof message.summary === "string" && typeof message.fromId === "string";
  if (message.role === "compactionSummary") return typeof message.summary === "string" && finite(message.tokensBefore);
  return false;
}

function isCustomMessageContent(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value) && value.every(textOrImageContent);
}

function isCompactionEntry(entry: Record<string, unknown>): boolean {
  const hasFirstKeptEntryId = entry.firstKeptEntryId !== undefined;
  const hasRetainedTail = entry.retainedTail !== undefined;
  const validFirstKeptEntryId = !hasFirstKeptEntryId || (typeof entry.firstKeptEntryId === "string" && entry.firstKeptEntryId.length > 0);
  const validRetainedTail = !hasRetainedTail || (Array.isArray(entry.retainedTail) && entry.retainedTail.every(isPersistedMessage));
  return typeof entry.summary === "string" && finite(entry.tokensBefore)
    && (hasFirstKeptEntryId || hasRetainedTail) && validFirstKeptEntryId && validRetainedTail
    && (entry.usage === undefined || isUsage(entry.usage)) && optionalBoolean(entry.fromHook);
}

function isBranchSummaryEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.fromId === "string" && typeof entry.summary === "string"
    && (entry.usage === undefined || isUsage(entry.usage)) && optionalBoolean(entry.fromHook);
}

/** Strict structural subset of Pi's supported persisted SessionEntry union. */
function isSupportedForkEntry(value: unknown, previousIds: Set<string>): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id || previousIds.has(entry.id)
    || !(entry.parentId === null || (typeof entry.parentId === "string" && previousIds.has(entry.parentId)))
    || !isIsoTimestamp(entry.timestamp) || typeof entry.type !== "string") return false;
  switch (entry.type) {
    case "message": return isPersistedMessage(entry.message);
    case "thinking_level_change": return typeof entry.thinkingLevel === "string";
    case "model_change": return typeof entry.provider === "string" && typeof entry.modelId === "string";
    case "compaction": return isCompactionEntry(entry);
    case "branch_summary": return isBranchSummaryEntry(entry);
    case "custom": return typeof entry.customType === "string" && entry.customType.length > 0;
    case "custom_message": return typeof entry.customType === "string" && entry.customType.length > 0 && isCustomMessageContent(entry.content) && typeof entry.display === "boolean";
    case "label": return typeof entry.targetId === "string" && (entry.label === undefined || typeof entry.label === "string");
    case "session_info": return entry.name === undefined || typeof entry.name === "string";
    default: return false;
  }
}

/** Serialize only strict, linked supported entries; session headers are excluded. */
export function buildForkBranchSourceJsonl(sessionManager: SessionSnapshotSource): string | null {
  const lines: string[] = [];
  const previousIds = new Set<string>();
  for (const rawEntry of sessionManager.getBranch()) {
    if (!isSupportedForkEntry(rawEntry, previousIds)) return null;
    const entry = rawEntry;
    let line: string;
    try {
      // `retainedTail` is Pi 0.81's self-contained compaction checkpoint, not
      // fresh child output. Preserve it exactly so a modern entry without the
      // legacy firstKeptEntryId remains valid and rebuilds the same context.
      line = JSON.stringify(entry);
      const parsed = record(JSON.parse(line));
      if (!parsed || !isSupportedForkEntry(parsed, new Set(previousIds)) || parsed.id !== entry.id) return null;
    } catch {
      return null;
    }
    previousIds.add(entry.id as string);
    lines.push(line);
  }
  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}
