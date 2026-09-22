// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import * as reviewModule from "../src/review.js";

const policy = { threshold: 0.8, margin: 0.1, budget: 7, maxBytes: 1024 };

const noRiskResult = {
  answers: {
    secrets: { type: "noul", noul: 0.01 },
    auth: { type: "noul", noul: 0.01 },
    safety_removal: { type: "noul", noul: 0.01 },
    deleted_tests: { type: "noul", noul: 0.01 },
    destructive_data: { type: "noul", noul: 0.01 },
    payment: { type: "noul", noul: 0.01 },
    human_review: { type: "noul", noul: 0.01 },
  },
};

test("buildReviewRequest produces all independent staged risk questions", () => {
  assert.equal(typeof reviewModule.buildReviewRequest, "function");
  const request = reviewModule.buildReviewRequest("diff --git a/a.ts b/a.ts\n+const value = 1;", policy);

  assert.equal(request.route, "laya");
  assert.deepEqual(Object.keys(request.questions), [
    "secrets", "auth", "safety_removal", "deleted_tests", "destructive_data", "payment", "human_review",
  ]);
  assert.equal(request.stages.length, 7);
  assert.equal(request.stages.every((stage) => stage.question.type === "noul"), true);
  assert.equal(request.stages.every((stage) => stage.state.diff === "diff --git a/a.ts b/a.ts\n+const value = 1;"), true);
  assert.match(request.inputDigest, /^[a-f0-9]{64}$/);
});

test("review produces pass advice without ever approving a diff", () => {
  assert.equal(typeof reviewModule.makeReviewPlan, "function");
  const plan = reviewModule.makeReviewPlan("diff --git a/a.ts b/a.ts\n+const value = 1;", noRiskResult, policy);

  assert.equal(plan.status, "pass_advice");
  assert.equal(plan.humanReviewRequired, false);
  assert.equal(plan.executable, false);
  assert.equal(Object.hasOwn(plan, "approved"), false);
  assert.deepEqual(plan.riskSignals, []);
  assert.equal(plan.trace.kind, "review");
});

test("each high-confidence risk signal requires human review", () => {
  const plan = reviewModule.makeReviewPlan("diff --git a/a.ts b/a.ts\n+const secret = env.TOKEN;", {
    answers: { ...noRiskResult.answers, secrets: { type: "noul", noul: 0.99 } },
  }, policy);

  assert.equal(plan.status, "needs_human");
  assert.equal(plan.humanReviewRequired, true);
  assert.deepEqual(plan.riskSignals, ["secrets"]);
  assert.equal(plan.trace.decision.secrets.status, "proposed");
});

test("oversized, binary, and incomplete diffs route to a human before Laya", () => {
  const { buildReviewRequest, makeReviewPlan } = reviewModule;
  const oversized = "x".repeat(1025);

  for (const diff of [oversized, "diff --git a/a b/a\u0000binary", { text: "diff --git a/a b/a", complete: false }]) {
    const request = buildReviewRequest(diff, policy);
    const plan = makeReviewPlan(diff, noRiskResult, policy);
    assert.equal(request.route, "human");
    assert.equal(Object.hasOwn(request, "questions"), false);
    assert.equal(plan.status, "needs_human");
    assert.equal(plan.humanReviewRequired, true);
    assert.equal(plan.executable, false);
  }
});

test("uncertain and malformed staged results abstain without a pass signal", () => {
  const ambiguous = reviewModule.makeReviewPlan("diff --git a/a.ts b/a.ts", {
    answers: { ...noRiskResult.answers, payment: { type: "noul", noul: 0.5 } },
  }, policy);
  const malformed = reviewModule.makeReviewPlan("diff --git a/a.ts b/a.ts", { answers: {} }, policy);

  assert.equal(ambiguous.status, "abstain");
  assert.equal(ambiguous.humanReviewRequired, true);
  assert.equal(malformed.status, "abstain");
  assert.equal(malformed.humanReviewRequired, true);
});

test("a stale human response cannot resolve a review plan", () => {
  assert.equal(typeof reviewModule.recordReviewOutcome, "function");
  const plan = reviewModule.makeReviewPlan("diff --git a/a.ts b/a.ts", noRiskResult, policy);

  assert.throws(
    () => reviewModule.recordReviewOutcome(plan, { inputDigest: "0".repeat(64), status: "accepted" }),
    /digest/i,
  );
  assert.equal(
    reviewModule.recordReviewOutcome(plan, { inputDigest: plan.inputDigest, status: "accepted" }).trace.outcome,
    "accepted",
  );
});
