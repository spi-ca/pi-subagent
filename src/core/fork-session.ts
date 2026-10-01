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

export function isPersistedUsage(value: unknown): boolean {
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

/** Pi 0.99 prompt/tool deltas survive raw branch snapshots unchanged. */
export function isPersistedSystemMessage(value: unknown): boolean {
  const message = record(value);
  const tool = (value: unknown, added: boolean) => {
    const item = record(value);
    return Boolean(item && typeof item.name === "string" && item.name.length > 0
      && (!added || typeof item.description === "string" && record(item.parameters) !== null));
  };
  return Boolean(message && message.role === "system" && finite(message.timestamp)
    && (typeof message.content === "string" || Array.isArray(message.content) && message.content.every((item) => record(item)?.type === "text" && textOrImageContent(item)))
    && (message.sections === undefined || record(message.sections) !== null && Object.values(message.sections as Record<string, unknown>).every((value) => value === null || typeof value === "string"))
    && (message.toolsAdded === undefined || Array.isArray(message.toolsAdded) && message.toolsAdded.every((item) => tool(item, true)))
    && (message.toolsRemoved === undefined || Array.isArray(message.toolsRemoved) && message.toolsRemoved.every((item) => tool(item, false)))
    && optionalBoolean(message.replace));
}

/** Shape validation only; callers additionally bind targetId to earlier history. */
export function isPersistedContextEdit(entry: Record<string, unknown>, role?: string): boolean {
  if (typeof entry.targetId !== "string" || !entry.targetId) return false;
  if (entry.replacement === null) return true;
  const replacement = record(entry.replacement);
  if (!replacement || Object.keys(replacement).some((key) => key !== "content")) return false;
  const content = replacement.content;
  return typeof content === "string" || Array.isArray(content) && content.every(role === "assistant" ? assistantContent : role ? textOrImageContent : (item) => assistantContent(item) || textOrImageContent(item));
}

export function isPersistedMessage(value: unknown): boolean {
  const message = record(value);
  if (!message || !finite(message.timestamp) || typeof message.role !== "string") return false;
  if (message.role === "system") return isPersistedSystemMessage(message);
  if (message.role === "user") {
    return typeof message.content === "string" || Array.isArray(message.content) && message.content.every(textOrImageContent);
  }
  if (message.role === "assistant") {
    return Array.isArray(message.content) && message.content.every(assistantContent)
      && typeof message.api === "string" && typeof message.provider === "string" && typeof message.model === "string"
      && isPersistedUsage(message.usage) && ["stop", "length", "toolUse", "error", "aborted"].includes(String(message.stopReason));
  }
  if (message.role === "toolResult") {
    return typeof message.toolCallId === "string" && typeof message.toolName === "string"
      && Array.isArray(message.content) && message.content.every(textOrImageContent) && typeof message.isError === "boolean"
      && (message.usage === undefined || isPersistedUsage(message.usage));
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

export function isCustomMessageContent(value: unknown): boolean {
  return typeof value === "string" || Array.isArray(value) && value.every(textOrImageContent);
}

export function isPersistedCompactionEntry(entry: Record<string, unknown>): boolean {
  const hasFirstKeptEntryId = entry.firstKeptEntryId !== undefined;
  const hasRetainedTail = entry.retainedTail !== undefined;
  const validFirstKeptEntryId = !hasFirstKeptEntryId || (typeof entry.firstKeptEntryId === "string" && entry.firstKeptEntryId.length > 0);
  const validRetainedTail = !hasRetainedTail || (Array.isArray(entry.retainedTail) && entry.retainedTail.every(isPersistedMessage));
  return typeof entry.summary === "string" && finite(entry.tokensBefore)
    && (hasFirstKeptEntryId || hasRetainedTail) && validFirstKeptEntryId && validRetainedTail
    && (entry.systemMessage === undefined || isPersistedSystemMessage(entry.systemMessage))
    && (entry.usage === undefined || isPersistedUsage(entry.usage)) && optionalBoolean(entry.fromHook);
}

function isBranchSummaryEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.fromId === "string" && typeof entry.summary === "string"
    && (entry.usage === undefined || isPersistedUsage(entry.usage)) && optionalBoolean(entry.fromHook);
}

/** Strict structural subset of Pi's supported persisted SessionEntry union. */
function isSupportedForkEntry(value: unknown, previousIds: Map<string, string>): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || !entry.id || previousIds.has(entry.id)
    || !(entry.parentId === null || (typeof entry.parentId === "string" && previousIds.has(entry.parentId)))
    || !isIsoTimestamp(entry.timestamp) || typeof entry.type !== "string") return false;
  switch (entry.type) {
    case "message": return isPersistedMessage(entry.message);
    case "thinking_level_change": return typeof entry.thinkingLevel === "string";
    case "model_change": return typeof entry.provider === "string" && typeof entry.modelId === "string";
    case "compaction": return isPersistedCompactionEntry(entry)
      && (entry.firstKeptEntryId === undefined || entry.firstKeptEntryId === entry.id || previousIds.has(entry.firstKeptEntryId as string));
    case "usage": return typeof entry.kind === "string" && typeof entry.provider === "string" && typeof entry.model === "string"
      && isPersistedUsage(entry.usage) && (entry.note === undefined || typeof entry.note === "string");
    case "context_edit": return typeof entry.targetId === "string" && ["user", "assistant", "toolResult", "custom"].includes(previousIds.get(entry.targetId) ?? "")
      && isPersistedContextEdit(entry, previousIds.get(entry.targetId));
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
  const previousIds = new Map<string, string>();
  for (const rawEntry of sessionManager.getBranch()) {
    if (!isSupportedForkEntry(rawEntry, previousIds)) return null;
    const entry = rawEntry;
    let line: string;
    try {
      // Preserve raw prompt deltas, edits and checkpoints; never serialize a
      // flattened projection. Legacy Pi 0.81 retainedTail remains supported,
      // while Pi 0.99 uses firstKeptEntryId plus a complete systemMessage.
      line = JSON.stringify(entry);
      const parsed = record(JSON.parse(line));
      if (!parsed || !isSupportedForkEntry(parsed, new Map(previousIds)) || parsed.id !== entry.id) return null;
    } catch {
      return null;
    }
    let editableRole = "";
    if (entry.type === "message") editableRole = String(record(entry.message)?.role ?? "");
    else if (entry.type === "custom_message") editableRole = "custom";
    // State-only IDs remain linked, but never acquire editable content from
    // their type name or an unrelated extra message property.
    previousIds.set(entry.id as string, editableRole);
    lines.push(line);
  }
  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}
