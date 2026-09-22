import { proposeSelection, type SelectionPolicy } from "./proposals.js";
import type { LayaResult } from "./protocol.js";

/** The complete, closed action vocabulary a host may interpret as supervision advice. */
export const SUPERVISION_ACTIONS = ["continue", "retry", "steer", "stop", "human"] as const;
export type SupervisionAction = typeof SUPERVISION_ACTIONS[number];

export interface SupervisionLimits {
  maxSteps: number;
  maxRetries: number;
  maxFailures: number;
}

/** A JSON-serializable session record. Keep this record when resuming a session. */
export interface SupervisionState {
  version: 1;
  stepCount: number;
  retryCount: number;
  failureCount: number;
  callIds: string[];
  requiredAction: SupervisionAction;
  limitReason?: SupervisionLimitReason;
}

export type SupervisionLimitReason = "step_limit" | "retry_limit" | "failure_limit";

export interface ToolSupervisionEvent {
  type: "tool";
  callId: string;
  result?: "success" | "failure";
}

export type SupervisionEvent = ToolSupervisionEvent;

export interface SupervisionPolicy extends SelectionPolicy {
  /** Actions the caller is willing to receive from the advisory model. Defaults to all actions. */
  actions?: readonly SupervisionAction[];
}

export interface SupervisionDecision {
  status: "deterministic" | "advisory";
  action: SupervisionAction;
  executable: false;
  probability?: number;
  reason?: "step_limit" | "retry_limit" | "failure_limit" | "invalid_policy" | "budget_exhausted" | "invalid_answer" | "threshold_or_margin";
}

const ACTION_SET = new Set<string>(SUPERVISION_ACTIONS);

export function emptySupervisionState(): SupervisionState {
  return {
    version: 1,
    stepCount: 0,
    retryCount: 0,
    failureCount: 0,
    callIds: [],
    requiredAction: "continue",
  };
}

/**
 * Records one completed tool lifecycle. The same call ID is deliberately a no-op
 * on replay, so persisted/resumed records cannot restore a spent budget.
 */
export function reduceSupervision(state: SupervisionState, event: SupervisionEvent, limits: SupervisionLimits): SupervisionState {
  const current = validateState(state);
  validateEvent(event);
  validateLimits(limits);

  if (current.callIds.includes(event.callId)) return current;
  if (current.requiredAction !== "continue") return current;

  const next: SupervisionState = {
    ...current,
    stepCount: current.stepCount + 1,
    callIds: [...current.callIds, event.callId],
  };
  if (event.result === "failure") {
    next.retryCount += 1;
    next.failureCount += 1;
  }

  const limit = requiredAction(next, limits);
  next.requiredAction = limit.action;
  if (limit.reason) next.limitReason = limit.reason;
  return next;
}

/**
 * Returns advisory-only model advice. Budget stops in the persisted state always
 * win, and malformed or uncertain results route to a human rather than acting.
 */
export function supervisionDecision(state: SupervisionState, result: Pick<LayaResult, "answers"> | unknown, policy: SupervisionPolicy, limits?: SupervisionLimits): SupervisionDecision {
  const current = validateState(state);
  if (limits !== undefined) {
    validateLimits(limits);
    const limited = requiredAction(current, limits);
    if (limited.action !== "continue") return { status: "deterministic", action: limited.action, executable: false, reason: limited.reason };
  }
  if (current.requiredAction !== "continue") return deterministicDecision(current);
  if (!validPolicy(policy)) return humanDecision("invalid_policy");
  if (policy.budget === 0) return humanDecision("budget_exhausted");
  if (policy.actions !== undefined && !Array.isArray(policy.actions)) return humanDecision("invalid_policy");

  const actions = policy.actions === undefined ? [...SUPERVISION_ACTIONS] : [...policy.actions];
  if (actions.length === 0 || new Set(actions).size !== actions.length || actions.some((action) => !ACTION_SET.has(action))) return humanDecision("invalid_policy");

  const answer = typeof result === "object" && result !== null && "answers" in result
    ? (result as { answers?: Record<string, unknown> }).answers?.action
    : undefined;
  if (!answer || typeof answer !== "object" || (answer as { type?: unknown }).type !== "choice" || !validChoice(answer, actions)) return humanDecision("invalid_answer");
  const choiceAnswer = answer as { choice: string; probabilities: Record<string, number> };
  const selected = proposeSelection(actions.map((id) => ({ id, confidence: choiceAnswer.probabilities[id] })), policy);
  if (!selected || selected.id !== choiceAnswer.choice) return humanDecision("threshold_or_margin");

  return { status: "advisory", action: selected.id as SupervisionAction, executable: false, probability: selected.confidence };
}

function requiredAction(state: SupervisionState, limits: SupervisionLimits): { action: SupervisionAction; reason?: SupervisionLimitReason } {
  if (state.stepCount >= limits.maxSteps) return { action: "stop", reason: "step_limit" };
  if (state.retryCount >= limits.maxRetries) return { action: "human", reason: "retry_limit" };
  if (state.failureCount >= limits.maxFailures) return { action: "human", reason: "failure_limit" };
  return { action: "continue" };
}

function deterministicDecision(state: SupervisionState): SupervisionDecision {
  if (state.limitReason) return { status: "deterministic", action: state.requiredAction, executable: false, reason: state.limitReason };
  return { status: "deterministic", action: state.requiredAction, executable: false };
}

function humanDecision(reason: Extract<SupervisionDecision["reason"], string>): SupervisionDecision {
  return { status: "advisory", action: "human", executable: false, reason };
}

function validChoice(answer: unknown, actions: readonly SupervisionAction[]): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const record = answer as Record<string, unknown>;
  if (typeof record.choice !== "string" || typeof record.probabilities !== "object" || record.probabilities === null || Array.isArray(record.probabilities)) return false;
  const probabilitiesRecord = record.probabilities as Record<string, unknown>;
  if (!actions.includes(record.choice as SupervisionAction)) return false;
  const keys = Object.keys(probabilitiesRecord);
  if (keys.length !== actions.length || actions.some((action) => !Object.hasOwn(probabilitiesRecord, action))) return false;
  const probabilities = actions.map((action) => probabilitiesRecord[action]);
  if (!probabilities.every((probability): probability is number => typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1)) return false;
  return Math.abs(probabilities.reduce((total, probability) => total + probability, 0) - 1) <= 0.000001;
}

function validateState(value: SupervisionState): SupervisionState {
  if (!value || value.version !== 1 || !isCount(value.stepCount) || !isCount(value.retryCount) || !isCount(value.failureCount)
    || !Array.isArray(value.callIds) || value.callIds.some((callId) => typeof callId !== "string" || callId.length === 0)
    || new Set(value.callIds).size !== value.callIds.length || !ACTION_SET.has(value.requiredAction)
    || (value.limitReason !== undefined && value.limitReason !== "step_limit" && value.limitReason !== "retry_limit" && value.limitReason !== "failure_limit")) {
    throw new TypeError("Supervision state is invalid");
  }
  const state: SupervisionState = {
    version: 1,
    stepCount: value.stepCount,
    retryCount: value.retryCount,
    failureCount: value.failureCount,
    callIds: [...value.callIds],
    requiredAction: value.requiredAction,
  };
  if (value.limitReason !== undefined) state.limitReason = value.limitReason;
  return state;
}

function validateEvent(event: SupervisionEvent): void {
  if (!event || event.type !== "tool" || typeof event.callId !== "string" || event.callId.length === 0
    || (event.result !== undefined && event.result !== "success" && event.result !== "failure")) {
    throw new TypeError("Supervision event is invalid");
  }
}

function validateLimits(limits: SupervisionLimits): void {
  if (!limits || !isCount(limits.maxSteps) || !isCount(limits.maxRetries) || !isCount(limits.maxFailures)) {
    throw new TypeError("Supervision limits are invalid");
  }
}

function validPolicy(policy: SupervisionPolicy): boolean {
  return !!policy && Number.isFinite(policy.threshold) && policy.threshold >= 0 && policy.threshold <= 1
    && Number.isFinite(policy.margin) && policy.margin >= 0 && policy.margin <= 1
    && Number.isInteger(policy.budget) && policy.budget >= 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
