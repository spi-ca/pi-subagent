import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ToolDefinition, ToolRendererResolver, ToolRenderers } from "@earendil-works/pi-coding-agent";
import registerPiSubagent from "../../index";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];

for (const maxDepth of ["0", "1"]) {
  test(`tool renderer remains independent of execution registration at max depth ${maxDepth}`, () => {
    const previousDepth = process.env.PI_SUBAGENT_DEPTH;
    process.env.PI_SUBAGENT_DEPTH = "0";
    try {
      let resolver: ToolRendererResolver | undefined;
      const tools: ToolDefinition[] = [];
      registerPiSubagent({
        registerToolRenderer: (value: ToolRendererResolver) => { resolver = value; },
        registerMessageRenderer: () => undefined,
        registerFlag: () => undefined,
        getFlag: (name: string) => name === "subagent-max-depth" ? maxDepth : undefined,
        registerCommand: () => undefined,
        registerTool: (tool: ToolDefinition) => { tools.push(tool); },
        on: () => undefined,
        events: { emit: () => undefined },
        getAllTools: () => [],
        getCommands: () => [],
      } as never);
      assert.equal(tools.length, Number(maxDepth));
      for (const tool of tools) {
        assert.equal(tool.renderCall, undefined);
        assert.equal(tool.renderResult, undefined);
        assert.equal(typeof tool.execute, "function");
        assert.ok(tool.outputSchema);
      }
      assert.ok(resolver);
      let nextCalls = 0;
      const downstream: ToolRenderers = {};
      const next = () => { nextCalls += 1; return downstream; };
      assert.equal(resolver("other_tool", next), downstream);
      assert.equal(nextCalls, 1);
      assert.equal(resolver("other_tool", () => undefined), undefined);
      const renderers = resolver("subagent", next);
      assert.ok(renderers?.renderCall);
      assert.ok(renderers.renderResult);
      assert.equal(nextCalls, 1, "subagent rendering does not delegate or enable a tool");
      const call = renderers.renderCall({ agent: "historical", task: "Saved task" }, theme, {} as never);
      assert.match(call.render(100).join("\n"), /historical/);
      const result = renderers.renderResult(
        { content: [{ type: "text", text: "Saved result" }], details: undefined },
        { expanded: false, isPartial: false }, theme, {} as never,
      );
      assert.match(result.render(100).join("\n"), /Saved result/);
    } finally {
      if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = previousDepth;
    }
  });
}
