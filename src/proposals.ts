import { validateRequest, type LayaRequest, type LayaResult } from "./protocol.js";

export const DECISION_PLACEMENTS = ["skill_tool", "model", "retention", "browser", "computer", "supervision", "review"] as const;
export type DecisionPlacement = typeof DECISION_PLACEMENTS[number];

export interface SelectionCandidate {
  id: string;
  confidence: number;
}

export interface SelectionPolicy {
  threshold: number;
  margin: number;
  budget: number;
}

export function proposeSelection<T extends SelectionCandidate>(candidates: readonly T[], policy: SelectionPolicy): T | undefined {
  if (policy.budget <= 0 || !Number.isFinite(policy.budget) || !Number.isFinite(policy.threshold) || policy.threshold < 0 || policy.threshold > 1 || !Number.isFinite(policy.margin) || policy.margin < 0) return undefined;
  const sorted = [...candidates].filter((candidate) => Number.isFinite(candidate.confidence) && candidate.confidence >= 0 && candidate.confidence <= 1).sort((left, right) => right.confidence - left.confidence);
  const choice = sorted[0];
  if (!choice || choice.confidence < policy.threshold) return undefined;
  const runnerUp = sorted[1];
  if (runnerUp && choice.confidence - runnerUp.confidence < policy.margin) return undefined;
  return choice;
}

export interface DecisionRequest extends LayaRequest {
  placement: DecisionPlacement;
  coverage: "unchecked" | "profile_checked";
  policy: SelectionPolicy;
}

export interface AdvisoryDecision {
  status: "proposed" | "abstained" | "observed";
  value?: string | boolean | number;
  probability?: number;
  reason?: string;
}

export function validateDecisionRequest(value: unknown): DecisionRequest {
  const request = validateRequest(value);
  const extra = value as Record<string, unknown>;
  if (!DECISION_PLACEMENTS.includes(extra.placement as DecisionPlacement)) throw new Error("Invalid Laya decision placement");
  const coverage = extra.coverage ?? "unchecked";
  if (coverage !== "unchecked" && coverage !== "profile_checked") throw new Error("Invalid Laya decision coverage");
  const policy = extra.policy ?? { threshold: 0.9, margin: 0.2, budget: 1 };
  if (typeof policy !== "object" || policy === null) throw new Error("Invalid Laya decision policy");
  const { threshold, margin, budget } = policy as SelectionPolicy;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1 || !Number.isFinite(margin) || margin < 0 || margin > 1 || !Number.isInteger(budget) || budget < 0) throw new Error("Invalid Laya decision policy");
  return { ...request, placement: extra.placement as DecisionPlacement, coverage, policy: { threshold, margin, budget } };
}

/** Advice only. Coverage is the caller's assertion, never a model guarantee. */
export function makeDecisionProposal(request: DecisionRequest, result: LayaResult) {
  const decisions: Record<string, AdvisoryDecision> = Object.create(null);
  let remainingBudget = request.policy.budget;
  for (const [name, question] of Object.entries(request.questions)) {
    const abstain = (reason: string) => { decisions[name] = { status: "abstained", reason }; };
    if ((request.placement === "retention" || request.placement === "review") && request.coverage !== "profile_checked") {
      abstain("coverage_unchecked");
      continue;
    }
    if (remainingBudget <= 0) { abstain("budget_exhausted"); continue; }
    const answer = result.answers[name];
    if (!answer || answer.type !== question.type) { abstain("invalid_answer"); continue; }
    if (answer.type === "score") {
      // An arbitrary scale is not a probability or an authorization to act.
      decisions[name] = { status: "observed", value: answer.score, reason: "score_requires_host_interpretation" };
      continue;
    }
    let candidates: SelectionCandidate[];
    if (answer.type === "choice" && question.type === "choice") {
      const probabilities = answer.probabilities;
      const options = Object.keys(question.criteria);
      if (!probabilities || Object.keys(probabilities).length !== options.length || options.some((option) => !Object.hasOwn(probabilities, option)) || Math.abs(Object.values(probabilities).reduce((sum, probability) => sum + probability, 0) - 1) > 0.01) {
        abstain("missing_or_invalid_probabilities"); continue;
      }
      candidates = options.map((id) => ({ id, confidence: probabilities[id] }));
    } else if (answer.type === "noul") {
      candidates = [{ id: "yes", confidence: answer.noul }, { id: "no", confidence: 1 - answer.noul }];
    } else { abstain("invalid_answer"); continue; }
    const selected = proposeSelection(candidates, { ...request.policy, budget: remainingBudget });
    if (!selected || (answer.type === "choice" && selected.id !== answer.choice)) { abstain("threshold_or_margin"); continue; }
    decisions[name] = { status: "proposed", value: answer.type === "noul" ? selected.id === "yes" : selected.id, probability: selected.confidence };
    remainingBudget -= 1;
  }
  return { placement: request.placement, coverage: request.coverage, coverageSource: "caller_assertion", executable: false as const, decisions, evaluation: result };
}
