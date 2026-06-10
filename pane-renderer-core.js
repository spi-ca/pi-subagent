export function createPaneRendererState() {
  return {
    seenAssistantMessages: new Set(),
    seenToolExecutionIds: new Set(),
    currentAssistantStreamed: false,
    lineOpen: false,
  };
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`;
}

export function signatureForMessage(message) {
  try {
    return stableStringify(message);
  } catch {
    return String(message);
  }
}

function ensureTrailingNewline(state, write) {
  if (state.lineOpen) {
    write("\n");
    state.lineOpen = false;
  }
}

function writeText(state, text, write) {
  write(text);
  state.lineOpen = !text.endsWith("\n");
}

export function renderToolSummary(name, args, write, state = createPaneRendererState()) {
  const pathArg = args.file_path || args.path || args.pattern;
  const command = args.command;
  if (typeof command === "string") {
    writeText(state, `→ ${name} ${command}\n`, write);
    return;
  }
  if (typeof pathArg === "string") {
    writeText(state, `→ ${name} ${pathArg}\n`, write);
    return;
  }
  writeText(state, `→ ${name}\n`, write);
}

export function renderAssistantMessage(message, write, state) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
  const signature = signatureForMessage(message);
  if (state.seenAssistantMessages.has(signature)) return;
  state.seenAssistantMessages.add(signature);

  for (const part of message.content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      writeText(state, `${part.text.trimEnd()}\n`, write);
    }
  }
}

export function handlePaneRendererEvent(event, write, state) {
  if (!event || typeof event !== "object") return;
  switch (event.type) {
    case "message_start":
      if (event.message?.role === "assistant") {
        state.currentAssistantStreamed = false;
      }
      break;
    case "message_update":
      if (event.assistantMessageEvent?.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string") {
        writeText(state, event.assistantMessageEvent.delta, write);
        state.currentAssistantStreamed = true;
      }
      break;
    case "message_end":
    case "turn_end":
      if (state.currentAssistantStreamed) {
        ensureTrailingNewline(state, write);
        state.seenAssistantMessages.add(signatureForMessage(event.message));
        state.currentAssistantStreamed = false;
      } else {
        renderAssistantMessage(event.message, write, state);
      }
      break;
    case "tool_execution_start": {
      ensureTrailingNewline(state, write);
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (toolCallId && state.seenToolExecutionIds.has(toolCallId)) break;
      if (toolCallId) state.seenToolExecutionIds.add(toolCallId);
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const args = event.args && typeof event.args === "object" ? event.args : {};
      renderToolSummary(name, args, write, state);
      break;
    }
    case "agent_end":
      if (Array.isArray(event.messages)) {
        for (const message of event.messages) renderAssistantMessage(message, write, state);
      }
      break;
    default:
      break;
  }
}

export function finalizePaneRenderer(state, write) {
  ensureTrailingNewline(state, write);
}
