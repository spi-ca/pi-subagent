/**
 * Helpers for parsing Pi JSON mode events and summarizing subagent results.
 */

import { addAccountingUsage, emptyAccountingUsage } from "./accounting-usage.js";

function getProcessedAssistantCount(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__processedAssistantCount")) {
    Object.defineProperty(result, "__processedAssistantCount", {
      value: 0,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return result.__processedAssistantCount;
}

function setProcessedAssistantCount(result, count) {
  result.__processedAssistantCount = count;
}

function getCurrentTurnHandled(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__currentTurnHandled")) {
    Object.defineProperty(result, "__currentTurnHandled", {
      value: false,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return result.__currentTurnHandled;
}

function setCurrentTurnHandled(result, handled) {
  result.__currentTurnHandled = handled;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

export function canonicalAssistantMessage(message) {
  return stableStringify(message);
}

function toolCallIdentity(message) {
  return typeof message?.toolCallId === "string"
    ? message.toolCallId
    : typeof message?.toolCall?.id === "string"
      ? message.toolCall.id
      : undefined;
}

function toolResultSemanticKey(message) {
  const toolCallId = toolCallIdentity(message);
  // A call ID identifies the same execution across lifecycle representations.
  // Without one, retain the whole message identity so same-cost but distinct
  // results do not get merged.
  return toolCallId ? `tool-call:${toolCallId}` : `message:${stableStringify(message)}`;
}

function getToolResultOccurrenceState(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__toolResultOccurrenceState")) {
    Object.defineProperty(result, "__toolResultOccurrenceState", {
      value: { persistedKeys: new Set(), sourceCounts: new Map() },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return result.__toolResultOccurrenceState;
}

function sourceOccurrenceCount(state, source, semanticKey) {
  return state.sourceCounts.get(source)?.get(semanticKey) ?? 0;
}

function setSourceOccurrenceCount(state, source, semanticKey, count) {
  let counts = state.sourceCounts.get(source);
  if (!counts) {
    counts = new Map();
    state.sourceCounts.set(source, counts);
  }
  counts.set(semanticKey, count);
}

function maxSourceOccurrenceCount(state, semanticKey) {
  let max = 0;
  for (const counts of state.sourceCounts.values()) {
    max = Math.max(max, counts.get(semanticKey) ?? 0);
  }
  return max;
}

/**
 * Each lifecycle source contributes an occurrence multiset. A tool execution
 * is accounted only as the largest source count for its semantic identity
 * grows, pairing tool_execution_end, per-turn events, cumulative agent_end
 * snapshots, and persisted entries one-for-one. Persisted session entry IDs
 * are authoritative only for replay de-duplication; they never globally
 * suppress another execution that reused the same toolCallId.
 */
function addToolResultUsage(result, message, { source = "message_end", authoritativeIdentity } = {}) {
  if (!message || message.role !== "toolResult" || !message.usage || typeof message.usage !== "object") return false;
  const state = getToolResultOccurrenceState(result);
  if (typeof authoritativeIdentity === "string") {
    const persistedKey = `persisted:${authoritativeIdentity}`;
    if (state.persistedKeys.has(persistedKey)) return false;
    state.persistedKeys.add(persistedKey);
  }

  const semanticKey = toolResultSemanticKey(message);
  const previousMax = maxSourceOccurrenceCount(state, semanticKey);
  const nextCount = sourceOccurrenceCount(state, source, semanticKey) + 1;
  setSourceOccurrenceCount(state, source, semanticKey, nextCount);
  if (nextCount <= previousMax) return false;

  addAccountingUsage(result.accountingUsage ??= emptyAccountingUsage(), message.usage);
  return true;
}

export function collectPiToolResultUsage(result, messages, source = "tool_results", cumulative = false) {
  if (!Array.isArray(messages)) return;
  const incomingCounts = new Map();
  for (const message of messages) {
    if (!message || message.role !== "toolResult" || !message.usage || typeof message.usage !== "object") continue;
    const semanticKey = toolResultSemanticKey(message);
    const occurrence = (incomingCounts.get(semanticKey) ?? 0) + 1;
    incomingCounts.set(semanticKey, occurrence);
    // agent_end contains a cumulative snapshot. Repeated snapshots must not
    // create new occurrences, while a longer snapshot contributes its suffix.
    if (!cumulative || occurrence > sourceOccurrenceCount(getToolResultOccurrenceState(result), source, semanticKey)) {
      addToolResultUsage(result, message, { source });
    }
  }
}

function getProcessedSummaryUsageKeys(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__processedSummaryUsageKeys")) {
    Object.defineProperty(result, "__processedSummaryUsageKeys", {
      value: new Set(),
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return result.__processedSummaryUsageKeys;
}

function getSummaryUsageSemanticCounts(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__summaryUsageSemanticCounts")) {
    Object.defineProperty(result, "__summaryUsageSemanticCounts", {
      value: { identified: new Map(), unidentified: new Map() },
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return result.__summaryUsageSemanticCounts;
}

function incrementSemanticCount(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function consumeSemanticCount(counts, key) {
  const count = counts.get(key) ?? 0;
  if (count === 0) return false;
  if (count === 1) counts.delete(key);
  else counts.set(key, count - 1);
  return true;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Session-entry IDs are the authoritative identity across Pi's lifecycle
 * notifications. When an entry has not been persisted yet, retain the complete
 * event representation as a stable fallback rather than deduplicating by usage
 * (which would merge distinct, equal-cost summaries).
 */
function summaryEntryKey(kind, entry) {
  return entry && typeof entry === "object" && nonEmptyString(entry.id) ? `${kind}:entry:${entry.id}` : undefined;
}

function summarySemanticKey(kind, entry) {
  // Deliberately exclude entry ID, parent/timestamp, and extension details so
  // compaction_end.result can pair with its later/earlier persisted entry.
  // Entry IDs still take precedence and are never compared to each other.
  const identity = kind === "compaction"
    ? { summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId, tokensBefore: entry.tokensBefore, usage: entry.usage }
    : { fromId: entry.fromId, summary: entry.summary, usage: entry.usage };
  return `${kind}:semantic:${stableStringify(identity)}`;
}

function addSummaryUsage(result, kind, entry) {
  if (!entry || typeof entry !== "object" || !entry.usage || typeof entry.usage !== "object") return false;
  const processed = getProcessedSummaryUsageKeys(result);
  const semanticCounts = getSummaryUsageSemanticCounts(result);
  const entryKey = summaryEntryKey(kind, entry);
  const semanticKey = summarySemanticKey(kind, entry);
  if (entryKey) {
    if (processed.has(entryKey)) return false;
    processed.add(entryKey);
    // A no-ID lifecycle result may arrive before its persisted entry. Pair one
    // representation at a time, leaving distinct same-cost summaries intact.
    if (consumeSemanticCount(semanticCounts.unidentified, semanticKey)) return false;
    incrementSemanticCount(semanticCounts.identified, semanticKey);
  } else {
    // A lifecycle summary without a persisted entry ID has no authoritative
    // identity. Do not collapse equal-looking occurrences: each may be a
    // separate compaction. Semantic counts only pair it with one identified
    // persisted/lifecycle copy when that copy becomes available.
    if (consumeSemanticCount(semanticCounts.identified, semanticKey)) return false;
    incrementSemanticCount(semanticCounts.unidentified, semanticKey);
  }
  addAccountingUsage(result.accountingUsage ??= emptyAccountingUsage(), entry.usage);
  return true;
}

function collectLifecycleSummaryUsage(result, event) {
  switch (event?.type) {
    case "compaction_end":
      return addSummaryUsage(result, "compaction", event.result);
    case "session_compact":
      return addSummaryUsage(result, "compaction", event.compactionEntry);
    case "session_tree":
      return addSummaryUsage(result, "branch_summary", event.summaryEntry);
    case "extension": {
      // JSON adapters may wrap extension lifecycle events; only inspect the
      // documented summary-bearing shapes and never expose them as messages.
      const nested = event.event ?? event.data ?? event.payload;
      return nested && typeof nested === "object" ? collectLifecycleSummaryUsage(result, nested) : false;
    }
    default:
      return false;
  }
}

function updateAssistantMetadata(result, message) {
  if (!message || message.role !== "assistant") return;
  if (!result.model && message.model) result.model = message.model;
  if (message.stopReason) result.stopReason = message.stopReason;
  if (message.errorMessage) result.errorMessage = message.errorMessage;
}

function addAssistantMessage(result, message) {
  if (!message || message.role !== "assistant") return false;

  updateAssistantMetadata(result, message);
  result.messages.push(message);

  result.usage.turns++;
  const usage = message.usage;
  if (usage) {
    // Preserve the legacy UI summary exactly as before.
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }
  addAccountingUsage(result.accountingUsage ??= emptyAccountingUsage(), usage);

  return true;
}

function findExactAssistantOverlap(result, assistantMessages) {
  const processedMessages = result.messages.filter((message) => message?.role === "assistant");
  const maxOverlap = Math.min(processedMessages.length, assistantMessages.length);
  for (let candidate = maxOverlap; candidate > 0; candidate--) {
    let matches = true;
    for (let index = 0; index < candidate; index++) {
      if (canonicalAssistantMessage(processedMessages[processedMessages.length - candidate + index]) !== canonicalAssistantMessage(assistantMessages[index])) {
        matches = false;
        break;
      }
    }
    if (matches) return candidate;
  }
  return 0;
}

function addAssistantMessages(result, messages, knownOverlap) {
  if (!Array.isArray(messages)) return false;
  const assistantMessages = messages.filter((message) => message?.role === "assistant");
  const processedMessages = result.messages.filter((message) => message?.role === "assistant");
  const overlap = Number.isSafeInteger(knownOverlap)
    && knownOverlap >= 0
    && knownOverlap <= Math.min(processedMessages.length, assistantMessages.length)
    ? knownOverlap
    : findExactAssistantOverlap(result, assistantMessages);

  let changed = false;
  for (let index = overlap; index < assistantMessages.length; index++) {
    if (addAssistantMessage(result, assistantMessages[index])) changed = true;
  }
  setProcessedAssistantCount(result, processedMessages.length + (assistantMessages.length - overlap));
  return changed;
}

function candidateHasExactPublicOverlap(result, assistantMessages, candidate) {
  const processedMessages = result.messages.filter((message) => message?.role === "assistant");
  if (!Number.isSafeInteger(candidate) || candidate < 0 || candidate > processedMessages.length || candidate > assistantMessages.length) {
    return false;
  }
  for (let index = 0; index < candidate; index++) {
    if (canonicalAssistantMessage(processedMessages[processedMessages.length - candidate + index]) !== canonicalAssistantMessage(assistantMessages[index])) {
      return false;
    }
  }
  return true;
}

async function appendNewAssistantMessages(index, result, previousMessageLength) {
  for (let messageIndex = previousMessageLength; messageIndex < result.messages.length; messageIndex++) {
    const message = result.messages[messageIndex];
    if (message?.role === "assistant") {
      await index.append(canonicalAssistantMessage(message), messageIndex);
    }
  }
}

export function processPiEvent(event, result, options = {}) {
  if (!event || typeof event !== "object") return false;

  // Summary-generation usage has no public assistant message or callback.
  // Account it before handling the normal lifecycle event, but preserve the
  // historical return value so caller update ordering remains unchanged.
  collectLifecycleSummaryUsage(result, event);

  switch (event.type) {
    case "message_start":
      if (event.message?.role === "assistant") {
        setCurrentTurnHandled(result, false);
      }
      return false;

    case "message_end": {
      const changed = addAssistantMessage(result, event.message);
      // Tool accounting deliberately does not make a public result message or
      // change callback truth/order; assistant acceptance remains the signal.
      addToolResultUsage(result, event.message, {
        source: options.toolResultIdentity ? "persisted" : "message_end",
        authoritativeIdentity: options.toolResultIdentity,
      });
      if (changed) {
        setProcessedAssistantCount(result, getProcessedAssistantCount(result) + 1);
        setCurrentTurnHandled(result, true);
      }
      return changed;
    }

    case "turn_end": {
      const handled = getCurrentTurnHandled(result);
      const changed = handled ? false : addAssistantMessage(result, event.message);
      addToolResultUsage(result, event.message, { source: "turn_end_message" });
      collectPiToolResultUsage(result, event.toolResults, "turn_end_tool_results");
      if (changed) {
        setProcessedAssistantCount(result, getProcessedAssistantCount(result) + 1);
      }
      setCurrentTurnHandled(result, false);
      return changed;
    }

    case "agent_end": {
      result.sawAgentEnd = true;
      const changed = addAssistantMessages(result, event.messages);
      collectPiToolResultUsage(result, event.messages, "agent_end", true);
      return changed;
    }

    case "tool_execution_end":
      // Pi exposes AgentToolResult.usage here before it emits the corresponding
      // ToolResultMessage. Reuse the tool-call identity so the later message is
      // a duplicate, while preserving usage if the child stops between events.
      if (typeof event.toolCallId === "string" && event.result?.usage && typeof event.result.usage === "object") {
        addToolResultUsage(result, {
          role: "toolResult",
          toolCallId: event.toolCallId,
          usage: event.result.usage,
        }, { source: "tool_execution_end" });
      }
      return false;

    default:
      return false;
  }
}

export function processPiJsonLine(line, result) {
  if (!line.trim()) return false;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  return processPiEvent(event, result);
}

/**
 * Async inline-runner variant. The optional index only proposes an overlap;
 * public result.messages always performs the final canonical equality check.
 */
export async function processPiJsonLineWithAssistantSignatureIndex(line, result, index) {
  if (!line.trim()) return false;

  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }

  const previousMessageLength = result.messages.length;
  if (event?.type === "agent_end" && index) {
    result.sawAgentEnd = true;
    const assistantMessages = Array.isArray(event.messages)
      ? event.messages.filter((message) => message?.role === "assistant")
      : [];
    const canonicalMessages = assistantMessages.map((message) => canonicalAssistantMessage(message));
    const candidate = await index.findCandidateOverlap(canonicalMessages);
    // A zero candidate provides no optimization. Retain the exact fallback so
    // externally prepopulated public results preserve legacy de-duplication.
    const overlap = candidate !== null && candidate > 0 && candidateHasExactPublicOverlap(result, assistantMessages, candidate)
      ? candidate
      : undefined;
    const changed = addAssistantMessages(result, event.messages, overlap);
    collectPiToolResultUsage(result, event.messages, "agent_end", true);
    await appendNewAssistantMessages(index, result, previousMessageLength);
    return changed;
  }

  const changed = processPiEvent(event, result);
  if (index) await appendNewAssistantMessages(index, result, previousMessageLength);
  return changed;
}

export function getFinalAssistantText(messages) {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    const textParts = message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.length > 0)
      .map((part) => part.text);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return "";
}

export function getResultSummaryText(result) {
  const isError =
    (typeof result?.exitCode === "number" && result.exitCode > 0) ||
    result?.stopReason === "error" ||
    result?.stopReason === "aborted";

  if (isError) {
    if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
      return result.errorMessage.trim();
    }
    if (typeof result?.stderr === "string" && result.stderr.trim()) {
      return result.stderr.trim();
    }
  }

  const finalText = getFinalAssistantText(result?.messages);
  if (finalText) return finalText;

  if (typeof result?.errorMessage === "string" && result.errorMessage.trim()) {
    return result.errorMessage.trim();
  }

  return "(no output)";
}
