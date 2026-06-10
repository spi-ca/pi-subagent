#!/usr/bin/env node

import * as fs from "node:fs";
import * as readline from "node:readline";

const fifoPath = process.argv[2];

if (!fifoPath) {
  console.error("pane-renderer: missing fifo path");
  process.exit(1);
}

const fifo = fs.createWriteStream(fifoPath, { encoding: "utf-8" });
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

const seenAssistantMessages = new Set();
const seenToolExecutionIds = new Set();
let currentAssistantStreamed = false;
let lineOpen = false;

function stableStringify(value) {
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

function signatureForMessage(message) {
  try {
    return stableStringify(message);
  } catch {
    return String(message);
  }
}

function ensureTrailingNewline() {
  if (lineOpen) {
    process.stdout.write("\n");
    lineOpen = false;
  }
}

function writeText(text) {
  process.stdout.write(text);
  lineOpen = !text.endsWith("\n");
}

function renderToolSummary(name, args) {
  const pathArg = args.file_path || args.path || args.pattern;
  const command = args.command;
  if (typeof command === "string") {
    writeText(`→ ${name} ${command}\n`);
    return;
  }
  if (typeof pathArg === "string") {
    writeText(`→ ${name} ${pathArg}\n`);
    return;
  }
  writeText(`→ ${name}\n`);
}

function renderAssistantMessage(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return;
  const signature = signatureForMessage(message);
  if (seenAssistantMessages.has(signature)) return;
  seenAssistantMessages.add(signature);

  for (const part of message.content) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      writeText(`${part.text.trimEnd()}\n`);
    }
  }
}

function handleEvent(event) {
  if (!event || typeof event !== "object") return;
  switch (event.type) {
    case "message_start":
      if (event.message?.role === "assistant") {
        currentAssistantStreamed = false;
      }
      break;
    case "message_update":
      if (event.assistantMessageEvent?.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string") {
        writeText(event.assistantMessageEvent.delta);
        currentAssistantStreamed = true;
      }
      break;
    case "message_end":
    case "turn_end":
      if (currentAssistantStreamed) {
        ensureTrailingNewline();
        const signature = signatureForMessage(event.message);
        seenAssistantMessages.add(signature);
        currentAssistantStreamed = false;
      } else {
        renderAssistantMessage(event.message);
      }
      break;
    case "tool_execution_start": {
      ensureTrailingNewline();
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      if (toolCallId && seenToolExecutionIds.has(toolCallId)) break;
      if (toolCallId) seenToolExecutionIds.add(toolCallId);
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const args = event.args && typeof event.args === "object" ? event.args : {};
      renderToolSummary(name, args);
      break;
    }
    case "agent_end":
      if (Array.isArray(event.messages)) {
        for (const message of event.messages) renderAssistantMessage(message);
      }
      break;
    default:
      break;
  }
}

rl.on("line", (line) => {
  fifo.write(`${line}\n`);
  if (!line.trim()) return;
  try {
    handleEvent(JSON.parse(line));
  } catch {
    // Ignore malformed/non-JSON lines while keeping the raw bridge intact.
  }
});

rl.on("close", () => {
  ensureTrailingNewline();
  fifo.end();
});

fifo.on("error", (error) => {
  console.error(`pane-renderer fifo error: ${error.message}`);
  process.exitCode = 1;
});
