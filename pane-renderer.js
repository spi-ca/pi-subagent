#!/usr/bin/env node

import * as fs from "node:fs";
import * as readline from "node:readline";
import { createPaneRendererState, finalizePaneRenderer, handlePaneRendererEvent } from "./pane-renderer-core.js";

const fifoPath = process.argv[2];
const taskLabel = process.argv[3];

if (!fifoPath) {
  console.error("pane-renderer: missing fifo path");
  process.exit(1);
}

const fifo = fs.createWriteStream(fifoPath, { encoding: "utf-8" });
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const state = createPaneRendererState();
const write = (text) => process.stdout.write(text);

if (typeof taskLabel === "string") {
  const normalizedTask = taskLabel.replace(/\s+/g, " ").trim();
  if (normalizedTask) {
    write(`Task: ${normalizedTask}\n---\n`);
  }
}

rl.on("line", (line) => {
  fifo.write(`${line}\n`);
  if (!line.trim()) return;
  try {
    handlePaneRendererEvent(JSON.parse(line), write, state);
  } catch {
    // Ignore malformed/non-JSON lines while keeping the raw bridge intact.
  }
});

rl.on("close", () => {
  finalizePaneRenderer(state, write);
  fifo.end();
});

fifo.on("error", (error) => {
  console.error(`pane-renderer fifo error: ${error.message}`);
  process.exitCode = 1;
});
