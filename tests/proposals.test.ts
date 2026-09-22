// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import * as proposalsModule from "../src/proposals.js";

test("proposeSelection returns a candidate only above threshold and margin", () => {
  assert.equal(typeof proposalsModule.proposeSelection, "function");
  const { proposeSelection } = proposalsModule;
  assert.deepEqual(proposeSelection([
    { id: "browser", confidence: 0.91 },
    { id: "computer", confidence: 0.70 }
  ], { threshold: 0.8, margin: 0.15, budget: 1 }), { id: "browser", confidence: 0.91 });
});

test("proposeSelection abstains for an ambiguous or exhausted decision", () => {
  assert.equal(typeof proposalsModule.proposeSelection, "function");
  const { proposeSelection } = proposalsModule;
  assert.equal(proposeSelection([{ id: "a", confidence: 0.9 }, { id: "b", confidence: 0.84 }], { threshold: 0.8, margin: 0.1, budget: 1 }), undefined);
  assert.equal(proposeSelection([{ id: "a", confidence: 0.99 }], { threshold: 0.8, margin: 0.1, budget: 0 }), undefined);
});

test("proposeSelection abstains for a non-finite policy budget", () => {
  assert.equal(typeof proposalsModule.proposeSelection, "function");
  const { proposeSelection } = proposalsModule;
  assert.equal(proposeSelection([{ id: "a", confidence: 0.99 }], { threshold: 0.8, margin: 0.1, budget: Number.NaN }), undefined);
});

const request = {
  placement: "browser", coverage: "unchecked", state: { buttons: ["next", "cancel"] },
  questions: { action: { type: "choice", instructions: "Choose next step", criteria: { next: "Continue", cancel: "Cancel" } } },
  policy: { threshold: 0.9, margin: 0.2, budget: 1 },
};
const result = { answers: { action: { type: "choice", choice: "next", probabilities: { next: 0.96, cancel: 0.04 } } } };

test("advisory policy exposes seven placements and never an executable action", () => {
  assert.equal(proposalsModule.DECISION_PLACEMENTS.length, 7);
  for (const placement of proposalsModule.DECISION_PLACEMENTS) {
    const proposal = proposalsModule.makeDecisionProposal({ ...request, placement, coverage: "profile_checked" }, result);
    assert.equal(proposal.executable, false);
    assert.equal(proposal.coverage, "profile_checked");
    assert.equal(proposal.decisions.action.status, "proposed");
    assert.equal(proposal.decisions.action.value, "next");
  }
});

test("retention and review abstain without profile checked coverage", () => {
  for (const placement of ["retention", "review"]) {
    const proposal = proposalsModule.makeDecisionProposal({ ...request, placement }, result);
    assert.equal(proposal.decisions.action.status, "abstained");
    assert.equal(proposal.decisions.action.reason, "coverage_unchecked");
  }
});

test("choice policy refuses missing, incomplete, contradictory and ambiguous probabilities", () => {
  for (const probabilities of [undefined, { next: 0.96 }, { next: 0.96, cancel: 0.96 }, { next: 0.04, cancel: 0.96 }, { next: 0.51, cancel: 0.49 }]) {
    const proposal = proposalsModule.makeDecisionProposal(request, { answers: { action: { type: "choice", choice: "next", probabilities } } });
    assert.equal(proposal.decisions.action.status, "abstained");
  }
});

test("noul uses probability margin and scores remain observations", () => {
  const proposal = proposalsModule.makeDecisionProposal({ ...request, policy: { ...request.policy, budget: 2 }, questions: {
    retry: { type: "noul", instructions: "Retry?" }, risk: { type: "score", instructions: "Risk score", criteria: ["low", "high"] },
  } }, { answers: { retry: { type: "noul", noul: 0.02 }, risk: { type: "score", score: 0.82 } } });
  assert.equal(proposal.decisions.retry.value, false);
  assert.equal(proposal.decisions.retry.probability, 0.98);
  assert.equal(proposal.decisions.risk.status, "observed");
  assert.equal(proposal.decisions.risk.probability, undefined);
});

test("invalid placement and nonfinite policy reject before evaluation", () => {
  assert.throws(() => proposalsModule.validateDecisionRequest({ ...request, placement: "shell" }));
  assert.throws(() => proposalsModule.validateDecisionRequest({ ...request, coverage: "all_good" }));
  assert.throws(() => proposalsModule.validateDecisionRequest({ ...request, policy: { ...request.policy, budget: NaN } }));
  const proposal = proposalsModule.makeDecisionProposal({ ...request, policy: { ...request.policy, budget: 0 } }, result);
  assert.equal(proposal.decisions.action.reason, "budget_exhausted");
});
