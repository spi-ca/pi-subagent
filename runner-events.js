/**
 * Helpers for parsing Pi JSON mode events and summarizing subagent results.
 */

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

function getMessageSignature(message) {
  return stableStringify(message);
}

function getProcessedAssistantSignatures(result) {
  if (!Object.prototype.hasOwnProperty.call(result, "__processedAssistantSignatures")) {
    Object.defineProperty(result, "__processedAssistantSignatures", {
      value: [],
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return result.__processedAssistantSignatures;
}

function pushProcessedAssistantSignature(result, signature) {
  getProcessedAssistantSignatures(result).push(signature);
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
    result.usage.input += usage.input || 0;
    result.usage.output += usage.output || 0;
    result.usage.cacheRead += usage.cacheRead || 0;
    result.usage.cacheWrite += usage.cacheWrite || 0;
    result.usage.cost += usage.cost?.total || 0;
    result.usage.contextTokens = usage.totalTokens || 0;
  }

  pushProcessedAssistantSignature(result, getMessageSignature(message));
  return true;
}

function addAssistantMessages(result, messages) {
  if (!Array.isArray(messages)) return false;
  const assistantMessages = messages.filter((message) => message?.role === "assistant");
  const processedSignatures = getProcessedAssistantSignatures(result);
  const incomingSignatures = assistantMessages.map((message) => getMessageSignature(message));
  const maxOverlap = Math.min(processedSignatures.length, incomingSignatures.length);
  let overlap = 0;
  for (let candidate = maxOverlap; candidate > 0; candidate--) {
    let matches = true;
    for (let index = 0; index < candidate; index++) {
      if (processedSignatures[processedSignatures.length - candidate + index] !== incomingSignatures[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      overlap = candidate;
      break;
    }
  }

  let changed = false;
  for (let index = overlap; index < assistantMessages.length; index++) {
    if (addAssistantMessage(result, assistantMessages[index])) changed = true;
  }
  setProcessedAssistantCount(result, processedSignatures.length + (assistantMessages.length - overlap));
  return changed;
}

export function processPiEvent(event, result) {
  if (!event || typeof event !== "object") return false;

  switch (event.type) {
    case "message_start":
      if (event.message?.role === "assistant") {
        setCurrentTurnHandled(result, false);
      }
      return false;

    case "message_end": {
      const changed = addAssistantMessage(result, event.message);
      if (changed) {
        setProcessedAssistantCount(result, getProcessedAssistantCount(result) + 1);
        setCurrentTurnHandled(result, true);
      }
      return changed;
    }

    case "turn_end": {
      if (getCurrentTurnHandled(result)) {
        setCurrentTurnHandled(result, false);
        return false;
      }
      const changed = addAssistantMessage(result, event.message);
      if (changed) {
        setProcessedAssistantCount(result, getProcessedAssistantCount(result) + 1);
      }
      setCurrentTurnHandled(result, false);
      return changed;
    }

    case "agent_end":
      result.sawAgentEnd = true;
      return addAssistantMessages(result, event.messages);

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
