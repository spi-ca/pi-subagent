import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createPaneRendererState, finalizePaneRenderer, handlePaneRendererEvent } from "./pane-renderer-core";

describe("pane renderer core", () => {
  test("renders text deltas and tool execution summaries without duplicating final assistant messages", () => {
    const state = createPaneRendererState();
    let output = "";
    const write = (text: string) => {
      output += text;
    };

    handlePaneRendererEvent({
      type: "message_start",
      message: { role: "assistant", content: [] },
    }, write, state);
    handlePaneRendererEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Hel" },
    }, write, state);
    handlePaneRendererEvent({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "lo" },
    }, write, state);
    handlePaneRendererEvent({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "README.md" },
    }, write, state);

    const finalMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
    };
    handlePaneRendererEvent({ type: "turn_end", message: finalMessage }, write, state);
    handlePaneRendererEvent({ type: "agent_end", messages: [finalMessage] }, write, state);
    finalizePaneRenderer(state, write);

    assert.equal(output, "Hello\n→ read README.md\n");
  });

  test("does not duplicate streamed text when agent_end arrives without turn_end", () => {
    const state = createPaneRendererState();
    let output = "";
    const write = (text: string) => {
      output += text;
    };

    handlePaneRendererEvent({ type: "message_start", message: { role: "assistant", content: [] } }, write, state);
    handlePaneRendererEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "DONE" } }, write, state);
    const message = { role: "assistant", content: [{ type: "text", text: "DONE" }] };
    handlePaneRendererEvent({ type: "message_end", message }, write, state);
    handlePaneRendererEvent({ type: "agent_end", messages: [message] }, write, state);
    finalizePaneRenderer(state, write);

    assert.equal(output, "DONE\n");
  });

  test("renders finalized assistant messages when no streaming deltas were seen", () => {
    const state = createPaneRendererState();
    let output = "";
    const write = (text: string) => {
      output += text;
    };

    const message = {
      role: "assistant",
      content: [{ type: "text", text: "DONE" }],
    };

    handlePaneRendererEvent({ type: "message_end", message }, write, state);
    handlePaneRendererEvent({ type: "agent_end", messages: [message] }, write, state);
    finalizePaneRenderer(state, write);

    assert.equal(output, "DONE\n");
  });
});
