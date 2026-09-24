import assert from "node:assert/strict";
import test from "node:test";
import { validateResult, type LayaQuestions } from "../src/protocol.js";

const questions: LayaQuestions = {
  category: { type: "choice", instructions: "Category?", criteria: { billing: "Billing", bug: "Bug", other: "Other" } },
  risk: { type: "score", instructions: "Risk?", criteria: ["high", "medium", "low"] },
};

test("accepts four-decimal ONNX probabilities with aggregate rounding loss", () => {
  const answers = {
    category: { type: "choice", choice: "billing", probabilities: { billing: 0.773, bug: 0.1803, other: 0.0466 } },
    risk: { type: "score", score: 1, probabilities: [0.3333, 0.3333, 0.3333] },
  };
  const result = validateResult(questions, { answers });
  const category = result.answers.category;
  assert.equal(category?.type, "choice");
  if (category?.type === "choice") {
    assert.equal(category.choice, "billing");
    assert.deepEqual(Object.fromEntries(Object.entries(category.probabilities)), answers.category.probabilities);
  }
  assert.deepEqual(result.answers.risk, answers.risk);
});

test("rejects probability mass outside four-decimal rounding tolerance", () => {
  const answer = { type: "choice", choice: "billing", probabilities: { billing: 0.773, bug: 0.1803, other: 0.0463 } };
  assert.throws(() => validateResult({ category: questions.category }, { answers: { category: answer } }), /must be normalized/);
  const risk = { type: "score", score: 1, probabilities: [0.333, 0.333, 0.333] };
  assert.throws(() => validateResult({ risk: questions.risk }, { answers: { risk } }), /must be normalized/);
});
