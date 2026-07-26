import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  SubagentParams,
  formatSubagentInvocationValidationError,
  formatSubagentOperationalError,
  validateSubagentInvocation,
  type SubagentInvocationValidationError,
} from "../../src/core/subagent-config";
import { getStageLabel } from "../../src/core/chain-helpers";

function expectValidationError(raw: unknown, category: SubagentInvocationValidationError["category"], location?: string): string {
  const error = validateSubagentInvocation(raw);
  assert.ok(error, "expected invocation validation to fail");
  assert.equal(error.category, category);
  const message = formatSubagentInvocationValidationError(error);
  if (location) assert.match(message, new RegExp(location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  return message;
}

describe("raw subagent invocation validation", () => {
  test("rejects non-object and coercible primitive fields", () => {
    expectValidationError("not-an-object", "input-type");
    expectValidationError({ agent: 1, task: "inspect" }, "input-type", "agent");
    expectValidationError({ agent: "worker", task: false }, "input-type", "task");
    expectValidationError({ action: "stop" }, "input-type", "action");
    expectValidationError({ background: "false", agent: "worker", task: "inspect" }, "input-type", "background");
    expectValidationError({ tasks: "not-an-array" }, "input-type", "tasks");
    expectValidationError({ tasks: [null] }, "input-type", "tasks[0]");
    expectValidationError({ chain: {} }, "input-type", "chain");
    expectValidationError({ chain: [null] }, "input-type", "chain[0]");
  });

  test("requires non-blank single agent and task without trimming valid text", () => {
    for (const raw of [
      { agent: "", task: "inspect" },
      { agent: " \t", task: "inspect" },
      { agent: "worker", task: "" },
      { agent: "worker", task: " \n" },
    ]) {
      expectValidationError(raw, "input-type");
    }
    const raw = { agent: " worker ", task: " inspect ", model: " model ", cwd: " /tmp/project " };
    assert.equal(validateSubagentInvocation(raw), null);
    assert.deepEqual(raw, { agent: " worker ", task: " inspect ", model: " model ", cwd: " /tmp/project " });
  });

  test("rejects unsupported own enumerable fields at every public object layer without exposing them", () => {
    const secretKey = "unsupported-secret-key";
    const secretValue = "unsupported-secret-value";
    const cases: Array<[unknown, string]> = [
      [{ agent: "worker", task: "inspect", [secretKey]: secretValue }, "Subagent parameters"],
      [{ tasks: [{ agent: "worker", task: "inspect", [secretKey]: secretValue }] }, "tasks[0]"],
      [{ chain: [{ agent: "worker", task: "inspect", [secretKey]: secretValue }] }, "chain[0]"],
      [{ chain: [{ type: "parallel", tasks: [{ agent: "worker", task: "inspect" }], [secretKey]: secretValue }] }, "chain[0]"],
      [{ chain: [{ type: "parallel", tasks: [{ agent: "worker", task: "inspect", [secretKey]: secretValue }] }] }, "chain[0].tasks[0]"],
    ];

    for (const [raw, location] of cases) {
      const message = expectValidationError(raw, "input-type", location);
      assert.equal(message.includes(secretKey), false);
      assert.equal(message.includes(secretValue), false);
    }
  });

  test("requires non-blank id, model, and cwd at every applicable location", () => {
    const cases: Array<[unknown, string]> = [
      [{ action: "status", id: "" }, "id"],
      [{ action: "status", id: " \t" }, "id"],
      [{ agent: "worker", task: "inspect", model: " " }, "model"],
      [{ agent: "worker", task: "inspect", cwd: "\n" }, "cwd"],
      [{ tasks: [{ agent: "worker", task: "inspect", model: " " }] }, "tasks[0].model"],
      [{ tasks: [{ agent: "worker", task: "inspect", cwd: " " }] }, "tasks[0].cwd"],
      [{ chain: [{ agent: "worker", task: "inspect", model: " " }] }, "chain[0].model"],
      [{ chain: [{ agent: "worker", task: "inspect", cwd: " " }] }, "chain[0].cwd"],
      [{ chain: [{ type: "parallel", tasks: [{ agent: "worker", task: "inspect", model: " " }] }] }, "chain[0].tasks[0].model"],
      [{ chain: [{ type: "parallel", tasks: [{ agent: "worker", task: "inspect", cwd: " " }] }] }, "chain[0].tasks[0].cwd"],
    ];
    for (const [raw, location] of cases) expectValidationError(raw, "input-type", location);

    const action = { action: "status", id: " job-id " };
    assert.equal(validateSubagentInvocation(action), null);
    assert.equal(action.id, " job-id ");
  });

  test("requires non-empty parallel tasks with non-blank raw task positions", () => {
    expectValidationError({ tasks: [] }, "input-type", "tasks");
    expectValidationError({ tasks: [{ agent: "", task: "inspect" }] }, "input-type", "tasks[0].agent");
    expectValidationError({ tasks: [{ agent: "worker", task: " " }] }, "input-type", "tasks[0].task");
    expectValidationError({ tasks: [{ agent: 1, task: "inspect" }] }, "input-type", "tasks[0].agent");
    expectValidationError({ tasks: [{ agent: "worker", task: null }] }, "input-type", "tasks[0].task");
    assert.equal(validateSubagentInvocation({ tasks: [{ agent: "worker", task: "inspect" }] }), null);
  });

  test("requires non-empty chain and valid sequential and nested parallel task positions", () => {
    expectValidationError({ chain: [] }, "input-type", "chain");
    expectValidationError({ chain: [{ type: "parallel", tasks: [] }] }, "input-type", "chain[0].tasks");
    expectValidationError({ chain: [{ agent: "", task: "inspect" }] }, "input-type", "chain[0].agent");
    expectValidationError({ chain: [{ agent: "worker", task: 0 }] }, "input-type", "chain[0].task");
    expectValidationError(
      { chain: [{ type: "parallel", tasks: [{ agent: " ", task: "inspect" }] }] },
      "input-type",
      "chain[0].tasks[0].agent",
    );
    expectValidationError(
      { chain: [{ type: "parallel", tasks: [{ agent: "worker", task: false }] }] },
      "input-type",
      "chain[0].tasks[0].task",
    );
    assert.equal(validateSubagentInvocation({
      chain: [
        { label: "stage1", agent: "worker", task: "inspect" },
        { type: "parallel", tasks: [{ agent: "reviewer", task: "review" }] },
      ],
    }), null);
  });

  test("preserves blank chain labels because execution falls back to numbered steps", () => {
    const stage = { label: " \t", agent: "worker", task: "inspect" };
    assert.equal(validateSubagentInvocation({ chain: [stage] }), null);
    assert.equal(getStageLabel(stage, 1), "step-2");
  });

  test("accepts valid action forms", () => {
    assert.equal(validateSubagentInvocation({ action: "status" }), null);
    assert.equal(validateSubagentInvocation({ action: "status", id: "job-id" }), null);
    assert.equal(validateSubagentInvocation({ action: "cancel" }), null);
    assert.equal(validateSubagentInvocation({ action: "cancel", id: "job-id" }), null);
  });

  test("categorizes invocation-shape and option-combination failures", () => {
    expectValidationError({}, "invocation-shape");
    expectValidationError({ agent: "worker" }, "invocation-shape");
    expectValidationError({ task: "inspect" }, "invocation-shape");
    expectValidationError({ agent: "worker", task: "inspect", tasks: [{ agent: "reviewer", task: "review" }] }, "invocation-shape");
    expectValidationError({ action: "status", agent: "worker", task: "inspect" }, "option-combination");
    expectValidationError({ action: "status", tasks: [{ agent: "worker", task: "inspect" }] }, "option-combination");
    expectValidationError({ action: "cancel", background: false }, "option-combination");
    expectValidationError({ id: "job-id" }, "option-combination", "id");
    expectValidationError({ tasks: [{ agent: "worker", task: "inspect" }], model: "model" }, "option-combination", "model");
  });

  test("formats failures without exposing raw task contents and distinguishes operational failures", () => {
    const secret = "raw-secret-must-not-appear";
    const message = expectValidationError({ agent: 1, task: secret }, "input-type");
    assert.equal(message.includes(secret), false);
    assert.equal(message.includes(JSON.stringify({ agent: 1, task: secret })), false);
    assert.match(formatSubagentOperationalError("runtime-policy", "capacity reached"), /\(runtime-policy\)/);
    assert.match(formatSubagentOperationalError("child-execution", "agent failed"), /\(child-execution\)/);
    assert.match(formatSubagentOperationalError("cancellation", "aborted"), /\(cancellation\)/);
  });

  test("publishes portable non-empty schema constraints", () => {
    const schema = JSON.parse(JSON.stringify(SubagentParams));
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.id.minLength, 1);
    assert.equal(schema.properties.agent.minLength, 1);
    assert.equal(schema.properties.task.minLength, 1);
    assert.equal(schema.properties.model.minLength, 1);
    assert.equal(schema.properties.cwd.minLength, 1);
    assert.equal(schema.properties.tasks.minItems, 1);
    assert.equal(schema.properties.chain.minItems, 1);
    assert.equal(schema.properties.chain.items.anyOf[1].properties.tasks.minItems, 1);
    assert.equal(schema.properties.tasks.items.properties.agent.minLength, 1);
    assert.equal(schema.properties.tasks.items.properties.task.minLength, 1);
    assert.equal(schema.properties.tasks.items.properties.model.minLength, 1);
    assert.equal(schema.properties.tasks.items.properties.cwd.minLength, 1);
    assert.equal(schema.properties.tasks.items.additionalProperties, false);
    assert.equal(schema.properties.chain.items.anyOf[0].properties.model.minLength, 1);
    assert.equal(schema.properties.chain.items.anyOf[0].properties.cwd.minLength, 1);
    assert.equal(schema.properties.chain.items.anyOf[0].additionalProperties, false);
    assert.equal(schema.properties.chain.items.anyOf[1].additionalProperties, false);
  });
});
