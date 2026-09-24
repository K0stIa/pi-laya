import assert from "node:assert/strict";
import test from "node:test";
import { validateResult, type LayaQuestions } from "../src/protocol.js";

const questions: LayaQuestions = { risk: { type: "score", instructions: "How likely?", criteria: ["unlikely", "possible", "certain"] } };

test("Minis numeric-keyed score legend and probabilities retain submitted order", () => {
  const result = validateResult(questions, { answers: { risk: {
    type: "score", score: 1.4106,
    legend: { "0": "unlikely", "1": "possible", "2": "certain" },
    probabilities: { "0": 0.0474, "1": 0.4945, "2": 0.458 },
  } } });
  assert.deepEqual(result.answers.risk, { type: "score", score: 1.4106, legend: ["unlikely", "possible", "certain"], probabilities: [0.0474, 0.4945, 0.458] });
});

test("score response rejects sparse indices, extra keys, and mismatched legends", () => {
  const answer = { type: "score", score: 1, legend: { "0": "unlikely", "2": "certain" } };
  assert.throws(() => validateResult(questions, { answers: { risk: answer } }), /indexed entries/);
  assert.throws(() => validateResult(questions, { answers: { risk: { ...answer, legend: { "0": "unlikely", "1": "possible", "2": "certain", extra: "other" } } } }), /indexed entries/);
  assert.throws(() => validateResult(questions, { answers: { risk: { ...answer, legend: { "0": "certain", "1": "possible", "2": "unlikely" } } } }), /must match submitted criteria/);
});
