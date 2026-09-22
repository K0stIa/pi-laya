import { proposeSelection, type SelectionPolicy } from "./proposals.js";
import type { LayaRequest, LayaResult } from "./protocol.js";
import { createDecisionTrace, recordOutcome, traceDigest, type DecisionOutcome, type DecisionTrace, type TraceDecision } from "./tracing.js";

export interface ContextItem {
  id: string;
  text: string;
  tokenEstimate: number;
  protected?: boolean;
  pairId?: string;
}

export interface CompactionPolicy extends SelectionPolicy {
  coverage: "unchecked" | "profile_checked";
  targetTokens: number;
  truncateTokenLimit: number;
}

export interface CompactionRequest {
  state: {
    currentTokenTotal: number;
    targetTokens: number;
    items: ContextItem[];
  };
  questions: LayaRequest["questions"];
}

export type CompactionTrace = DecisionTrace;

export interface CompactionPlan {
  status: "proposed" | "abstained";
  reason?: string;
  executable: false;
  keepIds: string[];
  dropIds: string[];
  truncateIds: string[];
  truncationTokenLimit: number;
  totalTokens: number;
  projectedTokens: number;
  snapshotDigest: string;
  trace: CompactionTrace;
}

type Choice = "KEEP" | "DROP" | "TRUNCATE";

const choices: readonly Choice[] = ["KEEP", "DROP", "TRUNCATE"];

/** Returns a new snapshot whose protected and paired entries cannot be candidates for removal. */
export function protectContextItems(items: readonly ContextItem[]): ContextItem[] {
  return items.map((item) => ({ ...item, protected: item.protected === true || item.pairId !== undefined }));
}

export function buildCompactionRequest(items: readonly ContextItem[], policy: CompactionPolicy): CompactionRequest {
  const snapshot = protectContextItems(items);
  const removable = snapshot.filter((item) => !item.protected);
  if (removable.length > 20) throw new RangeError("Compaction supports at most 20 removable context items");
  const questions: CompactionRequest["questions"] = Object.create(null);
  for (const item of removable) {
    questions[`item:${item.id}`] = {
      type: "choice",
      instructions: `Choose how to retain context item ${item.id}.`,
      criteria: {
        KEEP: "Keep the complete item in context.",
        DROP: "Remove the item from active context; the host can restore it from the snapshot.",
        TRUNCATE: `Keep only the caller-defined ${policy.truncateTokenLimit}-token prefix; do not summarize or rewrite text.`,
      },
    };
  }
  return {
    state: {
      currentTokenTotal: totalTokens(snapshot),
      targetTokens: policy.targetTokens,
      items: snapshot.map((item) => ({ ...item })),
    },
    questions,
  };
}

/**
 * Produces advice only. It never edits context text or applies a plan to Pi.
 * Safety failures are atomic: the original snapshot remains wholly retained.
 */
export function makeCompactionPlan(items: readonly ContextItem[], result: Pick<LayaResult, "answers">, policy: CompactionPolicy): CompactionPlan {
  const snapshot = protectContextItems(items);
  const total = totalTokens(snapshot);
  const snapshotDigest = traceDigest(traceState(snapshot));
  const protectedTotal = totalTokens(snapshot.filter((item) => item.protected));
  const removable = snapshot.filter((item) => !item.protected);
  const decisions: Record<string, TraceDecision> = Object.create(null);
  for (const [index, item] of snapshot.entries()) {
    if (item.protected) decisions[`protected_${index}`] = { status: "observed", reason: "protected" };
  }

  const abstain = (reason: string): CompactionPlan => {
    const traceDecision: TraceDecision = { status: "abstained" };
    if (reason !== "target_unmet") traceDecision.reason = reason;
    return plan("abstained", reason, snapshot, total, total, snapshotDigest, policy, { compaction: traceDecision }, [], []);
  };

  if (policy.coverage !== "profile_checked") return abstain("coverage_unchecked");
  if (!validPolicy(policy)) return abstain("invalid_policy");
  if (protectedTotal > policy.targetTokens) return abstain("protected_over_budget");

  let remainingBudget = policy.budget;
  const keepIds = snapshot.filter((item) => item.protected).map((item) => item.id);
  const dropIds: string[] = [];
  const truncateIds: string[] = [];
  let projectedTokens = protectedTotal;
  for (const [index, item] of removable.entries()) {
    if (remainingBudget <= 0) return abstain("budget_exhausted");
    const answer = result.answers[`item:${item.id}`];
    const selected = selectedChoice(answer, { threshold: policy.threshold, margin: policy.margin, budget: remainingBudget });
    if (!selected) return abstain("threshold_or_margin");
    decisions[`item_${index}`] = { status: "proposed", probability: selected.probability };
    if (selected.choice === "KEEP") {
      keepIds.push(item.id);
      projectedTokens += item.tokenEstimate;
    }
    if (selected.choice === "DROP") dropIds.push(item.id);
    if (selected.choice === "TRUNCATE") {
      truncateIds.push(item.id);
      projectedTokens += Math.min(item.tokenEstimate, policy.truncateTokenLimit);
    }
    remainingBudget -= 1;
  }
  if (projectedTokens > policy.targetTokens) return abstain("target_unmet");
  return plan("proposed", undefined, snapshot, total, projectedTokens, snapshotDigest, policy, decisions, dropIds, truncateIds, keepIds);
}

export function recordCompactionOutcome(plan: CompactionPlan, outcome: DecisionOutcome): CompactionPlan {
  return { ...plan, trace: recordOutcome(plan.trace, outcome) };
}

function totalTokens(items: readonly ContextItem[]): number {
  return items.reduce((total, item) => total + item.tokenEstimate, 0);
}

function validPolicy(policy: CompactionPolicy): boolean {
  return Number.isFinite(policy.targetTokens) && policy.targetTokens >= 0
    && Number.isInteger(policy.truncateTokenLimit) && policy.truncateTokenLimit >= 0
    && Number.isFinite(policy.threshold) && policy.threshold >= 0 && policy.threshold <= 1
    && Number.isFinite(policy.margin) && policy.margin >= 0 && policy.margin <= 1
    && Number.isInteger(policy.budget) && policy.budget >= 0;
}

function selectedChoice(answer: LayaResult["answers"][string] | undefined, policy: SelectionPolicy): { choice: Choice; probability: number } | undefined {
  if (!answer || answer.type !== "choice" || !answer.probabilities || !choices.every((choice) => Object.hasOwn(answer.probabilities, choice)) || Object.keys(answer.probabilities).length !== choices.length) return undefined;
  const probabilities = choices.map((choice) => answer.probabilities[choice]);
  if (probabilities.some((probability) => !Number.isFinite(probability) || probability < 0 || probability > 1) || Math.abs(probabilities.reduce((sum, probability) => sum + probability, 0) - 1) > 0.01) return undefined;
  const selected = proposeSelection(choices.map((id) => ({ id, confidence: answer.probabilities[id] })), policy);
  if (!selected || selected.id !== answer.choice) return undefined;
  return { choice: selected.id as Choice, probability: selected.confidence };
}

function plan(
  status: CompactionPlan["status"],
  reason: string | undefined,
  snapshot: readonly ContextItem[],
  total: number,
  projectedTokens: number,
  snapshotDigest: string,
  policy: CompactionPolicy,
  decisions: Record<string, TraceDecision>,
  dropIds: string[],
  truncateIds: string[],
  keepIds = snapshot.map((item) => item.id),
): CompactionPlan {
  const trace = createDecisionTrace({
    kind: "compaction",
    state: traceState(snapshot),
    decision: decisions,
    policy: tracePolicy(policy),
    latencyMs: 0,
  });
  const result: CompactionPlan = {
    status,
    executable: false,
    keepIds: [...keepIds],
    dropIds: [...dropIds],
    truncateIds: [...truncateIds],
    truncationTokenLimit: policy.truncateTokenLimit,
    totalTokens: total,
    projectedTokens,
    snapshotDigest,
    trace,
  };
  if (reason !== undefined) result.reason = reason;
  return result;
}

function traceState(snapshot: readonly ContextItem[]): Array<Record<string, string | number | boolean>> {
  return snapshot.map((item) => {
    const state: Record<string, string | number | boolean> = {
      id: item.id,
      text: item.text,
      tokenEstimate: item.tokenEstimate,
      protected: item.protected === true,
    };
    if (item.pairId !== undefined) state.pairId = item.pairId;
    return state;
  });
}

function tracePolicy(policy: CompactionPolicy): SelectionPolicy {
  if (Number.isFinite(policy.threshold) && Number.isFinite(policy.margin) && Number.isInteger(policy.budget)) {
    return { threshold: policy.threshold, margin: policy.margin, budget: policy.budget };
  }
  return { threshold: 0, margin: 0, budget: 0 };
}
