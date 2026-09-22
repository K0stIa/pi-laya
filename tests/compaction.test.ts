// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import * as compactionModule from "../src/compaction.js";

const items = [
  { id: "user", text: "Keep this user request", tokenEstimate: 30, protected: true },
  { id: "tool-call", text: "Call the tool", tokenEstimate: 20, pairId: "tool-1" },
  { id: "tool-result", text: "Tool result", tokenEstimate: 20, pairId: "tool-1" },
  { id: "assistant", text: "Replaceable assistant context", tokenEstimate: 30, protected: false },
];

const policy = {
  coverage: "profile_checked",
  targetTokens: 80,
  threshold: 0.8,
  margin: 0.1,
  budget: 4,
  truncateTokenLimit: 10,
};

const dropAssistantResult = {
  answers: {
    "item:assistant": {
      type: "choice",
      choice: "DROP",
      probabilities: { KEEP: 0.02, DROP: 0.96, TRUNCATE: 0.02 },
    },
  },
};

test("protectContextItems marks paired items without mutating the snapshot", () => {
  assert.equal(typeof compactionModule.protectContextItems, "function");
  const { protectContextItems } = compactionModule;
  const protectedItems = protectContextItems(items);

  assert.deepEqual(protectedItems.filter((item) => item.protected).map((item) => item.id), ["user", "tool-call", "tool-result"]);
  assert.equal(items[1].protected, undefined);
  assert.notEqual(protectedItems, items);
});

test("buildCompactionRequest asks KEEP DROP and TRUNCATE only for removable items", () => {
  assert.equal(typeof compactionModule.buildCompactionRequest, "function");
  const { buildCompactionRequest } = compactionModule;
  const request = buildCompactionRequest(items, policy);

  assert.deepEqual(Object.keys(request.questions), ["item:assistant"]);
  assert.deepEqual(Object.keys(request.questions["item:assistant"].criteria), ["KEEP", "DROP", "TRUNCATE"]);
  assert.equal(request.state.currentTokenTotal, 100);
  assert.equal(request.state.items[3].text, "Replaceable assistant context");
  assert.deepEqual(items.map((item) => item.text), ["Keep this user request", "Call the tool", "Tool result", "Replaceable assistant context"]);
});

test("protected and paired items are always kept", () => {
  assert.equal(typeof compactionModule.makeCompactionPlan, "function");
  const { makeCompactionPlan } = compactionModule;
  const plan = makeCompactionPlan(items, dropAssistantResult, policy);

  assert.equal(plan.status, "proposed");
  assert.deepEqual(plan.keepIds.slice().sort(), ["tool-call", "tool-result", "user"]);
  assert.deepEqual(plan.dropIds, ["assistant"]);
  assert.equal(plan.executable, false);
  assert.match(plan.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.equal(plan.trace.kind, "compaction");
  assert.equal(plan.trace.inputDigest, plan.snapshotDigest);
  assert.equal(JSON.stringify(plan.trace).includes("Replaceable assistant context"), false);
});

test("partial coverage and protected-over-budget contexts abstain", () => {
  const { makeCompactionPlan } = compactionModule;

  const uncovered = makeCompactionPlan(items, dropAssistantResult, { ...policy, coverage: "unchecked" });
  assert.equal(uncovered.status, "abstained");
  assert.equal(uncovered.reason, "coverage_unchecked");
  assert.deepEqual(uncovered.keepIds, items.map((item) => item.id));

  const protectedOverBudget = makeCompactionPlan(items, dropAssistantResult, { ...policy, targetTokens: 60 });
  assert.equal(protectedOverBudget.status, "abstained");
  assert.equal(protectedOverBudget.reason, "protected_over_budget");
  assert.deepEqual(protectedOverBudget.keepIds, items.map((item) => item.id));
});

test("ambiguous model choices abstain without removing context", () => {
  const { makeCompactionPlan } = compactionModule;
  const plan = makeCompactionPlan(items, {
    answers: {
      "item:assistant": {
        type: "choice",
        choice: "DROP",
        probabilities: { KEEP: 0.45, DROP: 0.5, TRUNCATE: 0.05 },
      },
    },
  }, policy);

  assert.equal(plan.status, "abstained");
  assert.equal(plan.reason, "threshold_or_margin");
  assert.deepEqual(plan.keepIds, items.map((item) => item.id));
  assert.deepEqual(plan.dropIds, []);
});

test("late uncertainty atomically replaces earlier proposed trace decisions", () => {
  const { makeCompactionPlan } = compactionModule;
  const plan = makeCompactionPlan([
    { id: "first", text: "First removable item", tokenEstimate: 10 },
    { id: "second", text: "Second removable item", tokenEstimate: 10 },
  ], {
    answers: {
      "item:first": { type: "choice", choice: "DROP", probabilities: { KEEP: 0.01, DROP: 0.98, TRUNCATE: 0.01 } },
      "item:second": { type: "choice", choice: "DROP", probabilities: { KEEP: 0.45, DROP: 0.5, TRUNCATE: 0.05 } },
    },
  }, { ...policy, targetTokens: 10 });

  assert.equal(plan.status, "abstained");
  assert.equal(plan.reason, "threshold_or_margin");
  assert.equal(Object.values(plan.trace.decision).some((decision) => decision.status === "proposed"), false);
  assert.deepEqual(plan.keepIds, ["first", "second"]);
});

test("KEEP and TRUNCATE plans abstain when their projected tokens cannot meet the target", () => {
  const { makeCompactionPlan } = compactionModule;
  const targetItems = [
    { id: "protected", text: "Must keep", tokenEstimate: 10, protected: true },
    { id: "keep", text: "Keep this", tokenEstimate: 20 },
    { id: "truncate", text: "Truncate this", tokenEstimate: 20 },
  ];
  const plan = makeCompactionPlan(targetItems, {
    answers: {
      "item:keep": { type: "choice", choice: "KEEP", probabilities: { KEEP: 0.98, DROP: 0.01, TRUNCATE: 0.01 } },
      "item:truncate": { type: "choice", choice: "TRUNCATE", probabilities: { KEEP: 0.01, DROP: 0.01, TRUNCATE: 0.98 } },
    },
  }, { ...policy, targetTokens: 15, truncateTokenLimit: 10 });

  assert.equal(plan.status, "abstained");
  assert.equal(plan.reason, "target_unmet");
  assert.equal(plan.projectedTokens, 50);
  assert.deepEqual(plan.keepIds, targetItems.map((item) => item.id));
});

test("trace uses safe decision keys and carries the shared outcome contract", () => {
  assert.equal(typeof compactionModule.recordCompactionOutcome, "function");
  const { makeCompactionPlan, recordCompactionOutcome } = compactionModule;
  const plan = makeCompactionPlan([
    { id: "tool-call:private-id", text: "Private context", tokenEstimate: 20 },
  ], {
    answers: {
      "item:tool-call:private-id": { type: "choice", choice: "DROP", probabilities: { KEEP: 0.01, DROP: 0.98, TRUNCATE: 0.01 } },
    },
  }, { ...policy, targetTokens: 0 });

  assert.match(plan.trace.id, /^[a-f0-9-]{36}$/i);
  assert.equal(plan.trace.inputDigest, plan.snapshotDigest);
  assert.equal(Object.keys(plan.trace.decision).every((key) => /^[a-z][a-z0-9_]{0,63}$/.test(key)), true);
  assert.equal(JSON.stringify(plan.trace).includes("tool-call:private-id"), false);
  assert.equal(recordCompactionOutcome(plan, {
    decisionId: plan.trace.id,
    inputDigest: plan.snapshotDigest,
    status: "accepted",
  }).trace.outcome, "accepted");
  assert.throws(() => recordCompactionOutcome(plan, {
    decisionId: plan.trace.id,
    inputDigest: "0".repeat(64),
    status: "accepted",
  }), /digest/i);
});
