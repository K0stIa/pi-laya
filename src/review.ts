import type { LayaQuestion, LayaRequest, LayaResult } from "./protocol.js";
import {
  createDecisionTrace,
  recordOutcome,
  traceDigest,
  type DecisionOutcome,
  type DecisionTrace,
  type OutcomeStatus,
  type TraceDecision,
} from "./tracing.js";

export const REVIEW_STAGES = [
  "secrets",
  "auth",
  "safety_removal",
  "deleted_tests",
  "destructive_data",
  "payment",
  "human_review",
] as const;

export type ReviewStageName = typeof REVIEW_STAGES[number];
export type ReviewStatus = "pass_advice" | "needs_human" | "abstain";
export type ReviewReason = "oversized" | "binary" | "incomplete" | "invalid_input" | "invalid_policy" | "budget_exhausted" | "invalid_answer" | "threshold_or_margin";

export interface ReviewDiff {
  text: string;
  complete?: boolean;
  binary?: boolean;
}

export interface ReviewPolicy {
  threshold: number;
  margin: number;
  budget: number;
  maxBytes: number;
}

export interface ReviewStageRequest {
  name: ReviewStageName;
  state: { diff: string };
  question: LayaQuestion;
}

export interface ReviewRequest {
  route: "laya" | "human";
  inputDigest: string;
  humanReviewRequired: boolean;
  reason?: Extract<ReviewReason, "oversized" | "binary" | "incomplete" | "invalid_input" | "invalid_policy">;
  state?: LayaRequest["state"];
  questions?: LayaRequest["questions"];
  stages: ReviewStageRequest[];
}

export interface ReviewPlan {
  status: ReviewStatus;
  humanReviewRequired: boolean;
  executable: false;
  riskSignals: ReviewStageName[];
  inputDigest: string;
  trace: DecisionTrace;
  reason?: ReviewReason;
}

export interface ReviewOutcome {
  inputDigest: string;
  status: OutcomeStatus;
}

const STAGE_INSTRUCTIONS: Record<ReviewStageName, string> = {
  secrets: "Does this diff expose a secret, credential, token, or private key?",
  auth: "Does this diff change authentication or authorization behavior in a risky way?",
  safety_removal: "Does this diff remove or weaken a safety check, validation, or guardrail?",
  deleted_tests: "Does this diff delete or disable a test that protects important behavior?",
  destructive_data: "Does this diff introduce a destructive data operation or weaken its safeguards?",
  payment: "Does this diff change payment, billing, pricing, or financial-transfer logic?",
  human_review: "Does this diff require human review before it is relied upon?",
};

type NormalizedDiff = Required<ReviewDiff>;

/**
 * Builds independent, advisory-only review stages. Preflight failures omit all
 * Laya questions, so callers can route directly to a human without sending the
 * diff to Laya.
 */
export function buildReviewRequest(diff: string | ReviewDiff, policy: ReviewPolicy): ReviewRequest {
  const normalized = normalizeDiff(diff);
  const inputDigest = digest(normalized);
  const preflight = preflightReason(normalized, policy);
  if (preflight) {
    return { route: "human", inputDigest, humanReviewRequired: true, reason: preflight, stages: [] };
  }

  const stages = REVIEW_STAGES.map((name) => ({
    name,
    state: { diff: normalized.text },
    question: stageQuestion(name),
  }));
  const questions = Object.create(null) as LayaRequest["questions"];
  for (const stage of stages) questions[stage.name] = stage.question;
  return {
    route: "laya",
    inputDigest,
    humanReviewRequired: false,
    state: { diff: normalized.text },
    questions,
    stages,
  };
}

/**
 * Interprets bounded review signals as advice. A clean result is explicitly
 * only pass advice: this adapter has no approval state or executable action.
 */
export function makeReviewPlan(diff: string | ReviewDiff, result: Pick<LayaResult, "answers">, policy: ReviewPolicy): ReviewPlan {
  const normalized = normalizeDiff(diff);
  const inputDigest = digest(normalized);
  const preflight = preflightReason(normalized, policy);
  if (preflight) return finalPlan("needs_human", true, [], inputDigest, policy, preflight, { human_review: { status: "observed" } });
  if (!validPolicy(policy)) return finalPlan("abstain", true, [], inputDigest, policy, "invalid_policy", { review: { status: "abstained", reason: "invalid_policy" } });
  if (policy.budget < REVIEW_STAGES.length) return finalPlan("abstain", true, [], inputDigest, policy, "budget_exhausted", { review: { status: "abstained", reason: "budget_exhausted" } });

  const decisions: Record<string, TraceDecision> = Object.create(null);
  const riskSignals: ReviewStageName[] = [];
  for (const stage of REVIEW_STAGES) {
    const probability = riskProbability(result?.answers?.[stage]);
    if (probability === undefined) {
      decisions[stage] = { status: "abstained", reason: "invalid_answer" };
      return finalPlan("abstain", true, [], inputDigest, policy, "invalid_answer", decisions);
    }
    if (isDecisive(probability, policy)) {
      decisions[stage] = { status: "proposed", probability };
      riskSignals.push(stage);
      continue;
    }
    if (isDecisive(1 - probability, policy)) {
      decisions[stage] = { status: "observed", probability };
      continue;
    }
    decisions[stage] = { status: "abstained", reason: "threshold_or_margin" };
    return finalPlan("abstain", true, [], inputDigest, policy, "threshold_or_margin", decisions);
  }

  if (riskSignals.length > 0) return finalPlan("needs_human", true, riskSignals, inputDigest, policy, undefined, decisions);
  return finalPlan("pass_advice", false, [], inputDigest, policy, undefined, decisions);
}

/** Records a host-supplied outcome only when it is bound to this exact diff digest. */
export function recordReviewOutcome(plan: ReviewPlan, outcome: ReviewOutcome): ReviewPlan {
  const trace = recordOutcome(plan.trace, {
    decisionId: plan.trace.id,
    inputDigest: outcome.inputDigest,
    status: outcome.status,
  } satisfies DecisionOutcome);
  return { ...plan, trace };
}

function stageQuestion(name: ReviewStageName): LayaQuestion {
  return {
    type: "noul",
    instructions: STAGE_INSTRUCTIONS[name],
    criteria: { true: "Risk is present.", false: "Risk is not present." },
  };
}

function normalizeDiff(value: string | ReviewDiff): NormalizedDiff {
  if (typeof value === "string") return { text: value, complete: true, binary: false };
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string"
    || (value.complete !== undefined && typeof value.complete !== "boolean")
    || (value.binary !== undefined && typeof value.binary !== "boolean")) {
    return { text: "", complete: false, binary: false };
  }
  return { text: value.text, complete: value.complete !== false, binary: value.binary === true };
}

function digest(diff: NormalizedDiff): string {
  return traceDigest({ text: diff.text, complete: diff.complete, binary: diff.binary });
}

function preflightReason(diff: NormalizedDiff, policy: ReviewPolicy): ReviewRequest["reason"] | undefined {
  if (!validPolicy(policy)) return "invalid_policy";
  if (!diff.complete || diff.text.trim().length === 0) return "incomplete";
  if (diff.binary || containsBinaryMarker(diff.text)) return "binary";
  if (new TextEncoder().encode(diff.text).byteLength > policy.maxBytes) return "oversized";
  return undefined;
}

function containsBinaryMarker(text: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

function validPolicy(policy: ReviewPolicy): boolean {
  return !!policy
    && Number.isFinite(policy.threshold) && policy.threshold >= 0 && policy.threshold <= 1
    && Number.isFinite(policy.margin) && policy.margin >= 0 && policy.margin <= 1
    && Number.isInteger(policy.budget) && policy.budget >= 0
    && Number.isInteger(policy.maxBytes) && policy.maxBytes > 0 && policy.maxBytes <= 64 * 1024;
}

function riskProbability(answer: LayaResult["answers"][string] | undefined): number | undefined {
  if (!answer || answer.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return undefined;
  return answer.noul;
}

function isDecisive(probability: number, policy: ReviewPolicy): boolean {
  return probability >= policy.threshold && probability - (1 - probability) >= policy.margin;
}

function finalPlan(
  status: ReviewStatus,
  humanReviewRequired: boolean,
  riskSignals: ReviewStageName[],
  inputDigest: string,
  policy: ReviewPolicy,
  reason: ReviewReason | undefined,
  decisions: Record<string, TraceDecision>,
): ReviewPlan {
  const trace = createDecisionTrace({
    kind: "review",
    state: { inputDigest },
    decision: decisions,
    policy: safeTracePolicy(policy),
    latencyMs: 0,
  });
  // Bind trace identity to the raw normalized diff instead of exposing it.
  const boundTrace: DecisionTrace = { ...trace, inputDigest };
  const plan: ReviewPlan = { status, humanReviewRequired, executable: false, riskSignals: [...riskSignals], inputDigest, trace: boundTrace };
  if (reason !== undefined) plan.reason = reason;
  return plan;
}

function safeTracePolicy(policy: ReviewPolicy): { threshold: number; margin: number; budget: number } {
  if (Number.isFinite(policy?.threshold) && Number.isFinite(policy?.margin) && Number.isInteger(policy?.budget)) {
    return { threshold: policy.threshold, margin: policy.margin, budget: policy.budget };
  }
  return { threshold: 0, margin: 0, budget: 0 };
}
