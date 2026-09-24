import assert from "node:assert/strict";
import test from "node:test";
import { designEvaluation, designTool } from "../src/designer.js";

const model = { provider: "local-llamacpp", id: "test" };
const validToolCall = { type: "toolCall", name: "submit_laya_questions", arguments: { questions: [
  { id: "category", type: "choice", instructions: "Which category?", options: [
    { key: "billing", description: "Billing issue" }, { key: "bug", description: "Software bug" },
  ], levels: [] },
] } };

test("requests schema-constrained tool output and validates each Laya question", async () => {
  let submittedContext: unknown;
  const context = { model, modelRegistry: { complete: async (_model: typeof model, input: unknown) => {
    submittedContext = input;
    return { content: [validToolCall] };
  } } };
  const request = await designEvaluation(context, "Is this a billing issue or bug?");
  assert.deepEqual(request.state, { prompt: "Is this a billing issue or bug?" });
  const category = request.questions.category;
  assert.equal(category.type, "choice");
  if (category.type === "choice") {
    assert.equal(category.instructions, "Which category?");
    assert.deepEqual(Object.fromEntries(Object.entries(category.criteria)), { billing: "Billing issue", bug: "Software bug" });
  }
  assert.equal(designTool.constrainedSampling.strict, "prefer");
  assert.equal((submittedContext as { tools: Array<{ name: string }> }).tools[0].name, "submit_laya_questions");
});

test("invalid JSON gets exactly one validation-guided retry", async () => {
  const inputs: Array<{ systemPrompt: string }> = [];
  const context = { model, modelRegistry: { complete: async (_model: typeof model, input: unknown) => {
    inputs.push(input as { systemPrompt: string });
    return inputs.length === 1 ? { content: [{ type: "text", text: "**not JSON**" }] } : { content: [validToolCall] };
  } } };
  await designEvaluation(context, "Classify payment card failure");
  assert.equal(inputs.length, 2);
  assert.match(inputs[1].systemPrompt, /Your previous question design failed validation: Invalid design JSON:/);
});

test("invalid choice options get exact error in retry prompt", async () => {
  const inputs: Array<{ systemPrompt: string }> = [];
  const invalid = { type: "toolCall", name: "submit_laya_questions", arguments: { questions: [
    { id: "ok", type: "noul", instructions: "Is this clear?", options: [], levels: [] },
    { id: "bad", type: "choice", instructions: "Pick", options: [], levels: [] },
  ] } };
  const context = { model, modelRegistry: { complete: async (_model: typeof model, input: unknown) => {
    inputs.push(input as { systemPrompt: string });
    return { content: [inputs.length === 1 ? invalid : validToolCall] };
  } } };
  await designEvaluation(context, "Classify payment card failure");
  assert.equal(inputs.length, 2);
  assert.ok(inputs[1].systemPrompt.includes("Invalid question design: questions.1.options must contain at least two choices"));
});

test("two invalid designs fail closed without sending malformed Laya request", async () => {
  let attempts = 0;
  const context = { model, modelRegistry: { complete: async () => { attempts++; return { content: [{ type: "text", text: "not json" }] }; } } };
  await assert.rejects(designEvaluation(context, "Classify payment"), /after one retry: Invalid design JSON:/);
  assert.equal(attempts, 2);
});

test("provider errors do not trigger a validation retry", async () => {
  let attempts = 0;
  const context = { model, modelRegistry: { complete: async () => { attempts++; return { stopReason: "error", content: [] }; } } };
  await assert.rejects(designEvaluation(context, "Classify payment"), /Check provider credits and credentials/);
  assert.equal(attempts, 1);
});
