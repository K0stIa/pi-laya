// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import * as supervisionModule from "../src/supervision.js";

const limits = { maxSteps: 3, maxRetries: 2, maxFailures: 3 };
const policy = { threshold: 0.8, margin: 0.1, budget: 1 };

test("duplicate call IDs do not refund or double-count a budget", () => {
  const { emptySupervisionState, reduceSupervision } = supervisionModule;
  const empty = emptySupervisionState();
  const once = reduceSupervision(empty, { type: "tool", callId: "a" }, limits);

  assert.deepEqual(reduceSupervision(once, { type: "tool", callId: "a" }, limits), once);
  assert.deepEqual(empty, {
    version: 1,
    stepCount: 0,
    retryCount: 0,
    failureCount: 0,
    callIds: [],
    requiredAction: "continue",
  });
  assert.equal(once.stepCount, 1);
});

test("step, retry, and failure budgets route deterministically without model advice", () => {
  const { emptySupervisionState, reduceSupervision } = supervisionModule;
  const atStepLimit = reduceSupervision(
    reduceSupervision(emptySupervisionState(), { type: "tool", callId: "a" }, { ...limits, maxSteps: 2 }),
    { type: "tool", callId: "b" },
    { ...limits, maxSteps: 2 },
  );
  const atRetryLimit = reduceSupervision(
    reduceSupervision(emptySupervisionState(), { type: "tool", callId: "a", result: "failure" }, limits),
    { type: "tool", callId: "b", result: "failure" },
    limits,
  );
  const atFailureLimit = reduceSupervision(
    emptySupervisionState(),
    { type: "tool", callId: "a", result: "failure" },
    { ...limits, maxRetries: 4, maxFailures: 1 },
  );

  assert.equal(atStepLimit.requiredAction, "stop");
  assert.equal(atRetryLimit.requiredAction, "human");
  assert.equal(atFailureLimit.requiredAction, "human");
});

test("a terminal supervision state overrides a model result", () => {
  const { emptySupervisionState, reduceSupervision, supervisionDecision } = supervisionModule;
  const stopped = reduceSupervision(emptySupervisionState(), { type: "tool", callId: "a" }, { ...limits, maxSteps: 1 });
  const decision = supervisionDecision(stopped, {
    answers: {
      action: {
        type: "choice",
        choice: "continue",
        probabilities: { continue: 0.99, retry: 0.0025, steer: 0.0025, stop: 0.0025, human: 0.0025 },
      },
    },
  }, policy);

  assert.deepEqual(decision, { status: "deterministic", action: "stop", executable: false, reason: "step_limit" });
});

test("a persisted failure limit retains its deterministic reason", () => {
  const { emptySupervisionState, reduceSupervision, supervisionDecision } = supervisionModule;
  const exhausted = reduceSupervision(emptySupervisionState(), { type: "tool", callId: "a", result: "failure" }, {
    maxSteps: 3,
    maxRetries: 4,
    maxFailures: 1,
  });

  assert.deepEqual(supervisionDecision(exhausted, { answers: {} }, policy), {
    status: "deterministic",
    action: "human",
    executable: false,
    reason: "failure_limit",
  });
});

test("model advice selects only the declared action vocabulary when confidence is decisive", () => {
  const { emptySupervisionState, supervisionDecision } = supervisionModule;
  const decision = supervisionDecision(emptySupervisionState(), {
    answers: {
      action: {
        type: "choice",
        choice: "steer",
        probabilities: { continue: 0.03, retry: 0.02, steer: 0.9, stop: 0.03, human: 0.02 },
      },
    },
  }, policy);

  assert.deepEqual(decision, { status: "advisory", action: "steer", executable: false, probability: 0.9 });
});

test("ambiguous or malformed advice fails closed to human", () => {
  const { emptySupervisionState, supervisionDecision } = supervisionModule;
  const ambiguous = supervisionDecision(emptySupervisionState(), {
    answers: {
      action: {
        type: "choice",
        choice: "continue",
        probabilities: { continue: 0.51, retry: 0.49, steer: 0, stop: 0, human: 0 },
      },
    },
  }, policy);
  const malformed = supervisionDecision(emptySupervisionState(), { answers: {} }, policy);
  const malformedProbabilities = supervisionDecision(emptySupervisionState(), {
    answers: { action: { type: "choice", choice: "continue", probabilities: null } },
  }, policy);

  assert.deepEqual(ambiguous, { status: "advisory", action: "human", executable: false, reason: "threshold_or_margin" });
  assert.deepEqual(malformed, { status: "advisory", action: "human", executable: false, reason: "invalid_answer" });
  assert.deepEqual(malformedProbabilities, { status: "advisory", action: "human", executable: false, reason: "invalid_answer" });
});

test("current limits are enforced before advice after a resume or configuration change", () => {
  const { emptySupervisionState, supervisionDecision } = supervisionModule;
  assert.deepEqual(supervisionDecision(emptySupervisionState(), { answers: {} }, policy, {
    maxSteps: 0, maxRetries: 1, maxFailures: 1,
  }), { status: "deterministic", action: "stop", executable: false, reason: "step_limit" });
});

test("invalid caller action candidates fail closed without throwing", () => {
  const { emptySupervisionState, supervisionDecision } = supervisionModule;

  assert.deepEqual(supervisionDecision(emptySupervisionState(), { answers: {} }, { ...policy, actions: null }), {
    status: "advisory",
    action: "human",
    executable: false,
    reason: "invalid_policy",
  });
});
