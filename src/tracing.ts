import { createHash, randomUUID } from "node:crypto";

export type DecisionKind = "compaction" | "skill_tool" | "model" | "supervision" | "review";
export type DecisionStatus = "proposed" | "abstained" | "observed";
export type OutcomeStatus = "accepted" | "rejected" | "succeeded" | "failed";

export interface TraceDecision {
  status: DecisionStatus;
  probability?: number;
  reason?: string;
}

export interface TracePolicy {
  threshold: number;
  margin: number;
  budget: number;
}

export interface DecisionTraceInput {
  kind: DecisionKind;
  state: unknown;
  decision: Record<string, TraceDecision>;
  policy?: TracePolicy;
  latencyMs?: number;
}

export interface DecisionTrace {
  id: string;
  kind: DecisionKind;
  timestamp: string;
  inputDigest: string;
  decision: Record<string, TraceDecision>;
  policy?: TracePolicy;
  latencyMs?: number;
  outcome?: OutcomeStatus;
}

export interface DecisionOutcome {
  decisionId: string;
  inputDigest: string;
  status: OutcomeStatus;
}

const DECISION_KINDS = new Set<DecisionKind>(["compaction", "skill_tool", "model", "supervision", "review"]);
const DECISION_STATUSES = new Set<DecisionStatus>(["proposed", "abstained", "observed"]);
const OUTCOME_STATUSES = new Set<OutcomeStatus>(["accepted", "rejected", "succeeded", "failed"]);
const SAFE_REASONS = new Set([
  "protected",
  "coverage_unchecked",
  "invalid_policy",
  "protected_over_budget",
  "budget_exhausted",
  "threshold_or_margin",
  "invalid_answer",
  "missing_or_invalid_probabilities",
  "score_requires_host_interpretation",
]);
const DECISION_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;

function isTraceId(value: string): boolean {
  return UUID.test(value) || DIGEST.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Trace digest requires finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) {
      throw new TypeError("Trace digest requires a dense JSON array");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) throw new TypeError("Trace digest requires a dense JSON array");
    }
    if (seen.has(value)) throw new TypeError("Trace digest requires acyclic JSON data");
    seen.add(value);
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (isPlainRecord(value)) {
    if (seen.has(value)) throw new TypeError("Trace digest requires acyclic JSON data");
    seen.add(value);
    const names = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== Object.keys(value).length || names.some((key) => Object.getOwnPropertyDescriptor(value, key)?.get || Object.getOwnPropertyDescriptor(value, key)?.set)) {
      throw new TypeError("Trace digest requires a plain JSON object");
    }
    const result = `{${names.sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
    seen.delete(value);
    return result;
  }
  throw new TypeError("Trace digest requires JSON data in plain objects");
}

export function traceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sanitizeDecisions(value: unknown): Record<string, TraceDecision> {
  if (!isPlainRecord(value)) throw new TypeError("Trace decision must be a plain record");
  const decisions: Record<string, TraceDecision> = Object.create(null);
  for (const [key, candidate] of Object.entries(value)) {
    if (!DECISION_KEY.test(key)) throw new TypeError("Trace decision key must be a bounded identifier");
    if (!isPlainRecord(candidate) || !DECISION_STATUSES.has(candidate.status as DecisionStatus)) throw new TypeError("Trace decision status is invalid");
    if (candidate.probability !== undefined && (typeof candidate.probability !== "number" || !Number.isFinite(candidate.probability) || candidate.probability < 0 || candidate.probability > 1)) throw new TypeError("Trace decision probability is invalid");
    if (candidate.reason !== undefined && (typeof candidate.reason !== "string" || !SAFE_REASONS.has(candidate.reason))) throw new TypeError("Trace decision reason must be a safe reason code");
    const decision: TraceDecision = { status: candidate.status as DecisionStatus };
    if (candidate.probability !== undefined) decision.probability = candidate.probability as number;
    if (candidate.reason !== undefined) decision.reason = candidate.reason as string;
    decisions[key] = decision;
  }
  return decisions;
}

function sanitizePolicy(value: unknown): TracePolicy {
  if (!isPlainRecord(value) || typeof value.threshold !== "number" || typeof value.margin !== "number" || typeof value.budget !== "number" || !Number.isFinite(value.threshold) || !Number.isFinite(value.margin) || !Number.isInteger(value.budget)) {
    throw new TypeError("Trace policy is invalid");
  }
  return { threshold: value.threshold, margin: value.margin, budget: value.budget };
}

function sanitizeLatency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError("Trace latency is invalid");
  return value;
}

function sanitizeTimestamp(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError("Trace timestamp is invalid");
  return value;
}

function sanitizeTrace(value: unknown): DecisionTrace {
  if (!isPlainRecord(value) || typeof value.id !== "string" || !isTraceId(value.id)) throw new TypeError("Trace ID is invalid");
  if (typeof value.kind !== "string" || !DECISION_KINDS.has(value.kind as DecisionKind)) throw new TypeError("Trace kind is invalid");
  if (typeof value.inputDigest !== "string" || !DIGEST.test(value.inputDigest)) throw new TypeError("Trace input digest is invalid");
  const trace: DecisionTrace = {
    id: value.id,
    kind: value.kind as DecisionKind,
    timestamp: sanitizeTimestamp(value.timestamp),
    inputDigest: value.inputDigest,
    decision: sanitizeDecisions(value.decision),
  };
  if (value.policy !== undefined) trace.policy = sanitizePolicy(value.policy);
  if (value.latencyMs !== undefined) trace.latencyMs = sanitizeLatency(value.latencyMs);
  if (value.outcome !== undefined) {
    if (typeof value.outcome !== "string" || !OUTCOME_STATUSES.has(value.outcome as OutcomeStatus)) throw new TypeError("Trace outcome is invalid");
    trace.outcome = value.outcome as OutcomeStatus;
  }
  return trace;
}

export function createDecisionTrace(input: DecisionTraceInput): DecisionTrace {
  if (!DECISION_KINDS.has(input.kind)) throw new TypeError("Trace kind is invalid");
  const trace: DecisionTrace = {
    id: randomUUID(),
    kind: input.kind,
    timestamp: new Date().toISOString(),
    inputDigest: traceDigest(input.state),
    decision: sanitizeDecisions(input.decision)
  };
  if (input.policy) trace.policy = sanitizePolicy(input.policy);
  if (input.latencyMs !== undefined) trace.latencyMs = sanitizeLatency(input.latencyMs);
  return trace;
}

export function recordOutcome(trace: DecisionTrace, outcome: DecisionOutcome): DecisionTrace {
  const safeTrace = sanitizeTrace(trace);
  if (!isPlainRecord(outcome) || typeof outcome.decisionId !== "string" || !isTraceId(outcome.decisionId)) throw new TypeError("Outcome decision ID is invalid");
  if (typeof outcome.inputDigest !== "string" || !DIGEST.test(outcome.inputDigest)) throw new TypeError("Outcome input digest is invalid");
  if (!OUTCOME_STATUSES.has(outcome.status as OutcomeStatus)) throw new TypeError("Outcome status is invalid");
  if (outcome.decisionId !== safeTrace.id) throw new Error("Outcome decision ID does not match trace");
  if (outcome.inputDigest !== safeTrace.inputDigest) throw new Error("Outcome input digest does not match trace");
  return { ...safeTrace, outcome: outcome.status as OutcomeStatus };
}
