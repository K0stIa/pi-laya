// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import * as protocolModule from "../src/protocol.js";

const request = {
  state: { subject: "refund", signals: ["late"] },
  questions: {
    route: { type: "choice", instructions: "Choose a team", criteria: { billing: "refunds", support: "other" } },
    risk: { type: "score", instructions: "Score risk", criteria: ["low", "medium", "high"] },
    urgent: { type: "noul", instructions: "Is this urgent?" }
  }
};

test("validateRequest accepts bounded typed questions", () => {
  assert.equal(typeof protocolModule.validateRequest, "function");
  const { validateRequest } = protocolModule;
  assert.deepEqual(JSON.parse(JSON.stringify(validateRequest(request))), request);
});

test("validateRequest rejects more than twenty questions before transport", () => {
  assert.equal(typeof protocolModule.validateRequest, "function");
  const { validateRequest } = protocolModule;
  const questions = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [
    `q${index}`, { type: "noul", instructions: "Decide" }
  ]));
  assert.throws(() => validateRequest({ state: {}, questions }), /1 to 20/);
});

test("validateRequest rejects payloads beyond the depth limit", () => {
  assert.equal(typeof protocolModule.validateRequest, "function");
  const { validateRequest } = protocolModule;
  let state = {};
  for (let index = 0; index < 17; index += 1) state = { state };
  assert.throws(() => validateRequest({ state, questions: request.questions }), /depth/);
});

test("validateRequest rejects serialized payloads larger than 64 KiB", () => {
  assert.equal(typeof protocolModule.validateRequest, "function");
  const { validateRequest } = protocolModule;
  assert.throws(() => validateRequest({ state: { body: "x".repeat(64 * 1024) }, questions: request.questions }), /65536 bytes/);
});

test("validateResult requires answer types to match the submitted questions", () => {
  assert.equal(typeof protocolModule.validateResult, "function");
  const { validateResult } = protocolModule;
  assert.throws(() => validateResult(request.questions, {
    answers: { route: { type: "score", score: 1 }, risk: { type: "score", score: 0.5 }, urgent: { type: "noul", noul: 0.3 } }
  }), /route/);
});

test("validateRequest requires ordered criteria for score questions", () => {
  assert.equal(typeof protocolModule.validateRequest, "function");
  const { validateRequest } = protocolModule;
  assert.throws(() => validateRequest({
    state: {},
    questions: { risk: { type: "score", instructions: "Score risk" } }
  }), /risk\.criteria/);
});

test("validateRequest accepts optional explicit true and false noul criteria", () => {
  assert.equal(typeof protocolModule.validateRequest, "function");
  const { validateRequest } = protocolModule;
  const validated = validateRequest({
    state: {},
    questions: { urgent: { type: "noul", instructions: "Is this urgent?", criteria: { true: "requires immediate attention", false: "can wait" } } }
  });
  assert.deepEqual(validated.questions.urgent.criteria, { true: "requires immediate attention", false: "can wait" });
  assert.throws(() => validateRequest({
    state: {},
    questions: { urgent: { type: "noul", instructions: "Is this urgent?", criteria: { true: "requires immediate attention" } } }
  }), /true and false/);
});

test("validateResult retains a bounded score legend and distribution", () => {
  assert.equal(typeof protocolModule.validateResult, "function");
  const { validateResult } = protocolModule;
  const result = validateResult(request.questions, {
    answers: {
      route: { type: "choice", choice: "billing", probabilities: { billing: 0.8, support: 0.2 } },
      risk: { type: "score", score: 1.2, legend: ["low", "medium", "high"], probabilities: [0.2, 0.4, 0.4] },
      urgent: { type: "noul", noul: 0.3 }
    }
  });
  assert.deepEqual(result.answers.risk, { type: "score", score: 1.2, legend: ["low", "medium", "high"], probabilities: [0.2, 0.4, 0.4] });
});

test("validateResult rejects missing or non-normalized choice probabilities", () => {
  assert.equal(typeof protocolModule.validateResult, "function");
  const { validateResult } = protocolModule;
  const answers = {
    route: { type: "choice", choice: "billing" },
    risk: { type: "score", score: 1, probabilities: [0.2, 0.4, 0.4] },
    urgent: { type: "noul", noul: 0.3 }
  };
  assert.throws(() => validateResult(request.questions, { answers }), /route\.probabilities/);
  answers.route.probabilities = { billing: 0.8, support: 0.1 };
  assert.throws(() => validateResult(request.questions, { answers }), /normalized/);
});

test("validateResult rejects scores outside the submitted ordinal criteria", () => {
  assert.equal(typeof protocolModule.validateResult, "function");
  const { validateResult } = protocolModule;
  assert.throws(() => validateResult(request.questions, {
    answers: {
      route: { type: "choice", choice: "billing", probabilities: { billing: 0.8, support: 0.2 } },
      risk: { type: "score", score: 3, probabilities: [0.2, 0.4, 0.4] },
      urgent: { type: "noul", noul: 0.3 }
    }
  }), /risk\.score/);
});

test("validateResult rejects inherited choice names", () => {
  assert.equal(typeof protocolModule.validateResult, "function");
  const { validateResult } = protocolModule;
  assert.throws(() => validateResult(request.questions, {
    answers: {
      route: { type: "choice", choice: "constructor" },
      risk: { type: "score", score: 0.5 },
      urgent: { type: "noul", noul: 0.3 }
    }
  }), /route\.choice/);
});

test("validateRequest preserves a JSON question named __proto__", () => {
  assert.equal(typeof protocolModule.validateRequest, "function");
  const { validateRequest } = protocolModule;
  const parsed = JSON.parse('{"state":{},"questions":{"__proto__":{"type":"noul","instructions":"Decide"}}}');
  assert.deepEqual(Object.keys(validateRequest(parsed).questions), ["__proto__"]);
});
