import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LayaClient } from "./client.js";
import { registerLayaCommands } from "./commands.js";
import { resolveConfig, type ResolveConfigOptions } from "./config.js";
import { DECISION_PLACEMENTS, makeDecisionProposal, validateDecisionRequest } from "./proposals.js";
import { buildCompactionRequest, makeCompactionPlan, recordCompactionOutcome, type CompactionPlan } from "./compaction.js";
import type { OutcomeStatus } from "./tracing.js";
import { snapshotInventory } from "./inventory.js";
import { buildReviewRequest, makeReviewPlan } from "./review.js";
import { emptySupervisionState, supervisionDecision, SUPERVISION_ACTIONS } from "./supervision.js";

interface PiTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: unknown;
  execute: (callId: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
}

export interface PiLike {
  registerTool(tool: PiTool): void;
  registerCommand?: (name: string, options: { description?: string; handler: (args: string, context: SlashCommandContext) => Promise<void> }) => void;
  sendMessage?: (message: { customType: string; content: string; display: boolean }) => void;
  on?: (event: string, handler: (event: unknown, context: unknown) => unknown | Promise<unknown>) => void;
}

interface SlashCommandContext {
  cwd?: string;
  sessionManager?: {
    buildContextEntries(): unknown[];
    getBranch?(): unknown[];
    appendCustomEntry?(customType: string, data?: unknown): string;
  };
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

interface SnapshotItem {
  id: string;
  text: string;
  tokenEstimate: number;
  protected?: boolean;
}

interface PersistedCompactionPlan {
  version: 1;
  plan: CompactionPlan;
  labels: Record<string, string>;
}

interface PersistedCompactionOutcome {
  version: 1;
  decisionId: string;
  inputDigest: string;
  status: OutcomeStatus;
  timestamp: string;
}

const PLAN_ENTRY_TYPE = "laya_compaction_plan";
const OUTCOME_ENTRY_TYPE = "laya_compaction_outcome";
const OUTCOME_STATUSES: readonly OutcomeStatus[] = ["accepted", "rejected", "succeeded", "failed"];
// Minis CPU inference times out on larger automatic choice batches.
const ACTIVE_COMPACTION_GROUPS = 4;

const question = Type.Union([
  Type.Object({
    type: Type.Literal("choice"),
    instructions: Type.String({ minLength: 1 }),
    criteria: Type.Record(Type.String(), Type.String({ minLength: 1 }), { minProperties: 1 }),
  }),
  Type.Object({ type: Type.Literal("score"), instructions: Type.String({ minLength: 1 }), criteria: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }) }),
  Type.Object({ type: Type.Literal("noul"), instructions: Type.String({ minLength: 1 }), criteria: Type.Optional(Type.Object({ true: Type.String({ minLength: 1 }), false: Type.String({ minLength: 1 }) })) }),
]);

const parameters = Type.Object({
  state: Type.Unknown({ description: "Structured JSON state to evaluate." }),
  questions: Type.Record(Type.String(), question, { minProperties: 1, maxProperties: 20, description: "Named choice, score, or noul questions." }),
});

const decisionParameters = Type.Object({
  ...parameters.properties,
  placement: Type.Union(DECISION_PLACEMENTS.map((placement) => Type.Literal(placement))),
  coverage: Type.Optional(Type.Union([Type.Literal("unchecked"), Type.Literal("profile_checked")], { description: "Caller assertion that the complete relevant state fits the deployed model profile. Defaults to unchecked; never inferred from confidence." })),
  policy: Type.Optional(Type.Object({
    threshold: Type.Number({ minimum: 0, maximum: 1 }),
    margin: Type.Number({ minimum: 0, maximum: 1 }),
    budget: Type.Integer({ minimum: 0, description: "Maximum proposals returned from this call, in question order; not a session action budget." }),
  })),
});

function evaluator(configOptions: ResolveConfigOptions) {
  let client: LayaClient | undefined;
  return async (_callId: string, params: unknown, signal?: AbortSignal) => {
    try {
      const config = resolveConfig(configOptions);
      client ??= new LayaClient({ baseUrl: config.baseUrl ?? "", apiToken: config.apiToken ?? "", allowInsecureHttp: config.allowInsecureHttp ?? false });
      return await client.evaluate(params, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Laya request failed";
      throw new Error(`Laya error: ${message}`);
    }
  };
}

export default function piLaya(pi: PiLike, configOptions: ResolveConfigOptions = {}): void {
  let currentContext: unknown;
  pi.on?.("session_start", (_event, context) => { currentContext = context; });
  const evaluateRaw = evaluator(configOptions);
  const stats = { requests: 0, tokens: 0, lastError: "" };
  const evaluate = async (callId: string, params: unknown, signal?: AbortSignal) => {
    stats.requests++;
    try {
      const result = await evaluateRaw(callId, params, signal);
      stats.tokens += Object.values(result.usage ?? {}).filter((value) => typeof value === "number" && Number.isFinite(value)).reduce((total, value) => total + value, 0);
      return result;
    } catch (error) {
      stats.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };
  const present = (result: unknown) => ({ content: [{ type: "text", text: JSON.stringify(result) }], details: result });
  const execute = async (callId: string, params: unknown, signal?: AbortSignal) => present(await evaluate(callId, params, signal));
  const compact = async (callId: string, params: unknown, signal?: AbortSignal) => {
    const input = params as { items: unknown[]; policy: Record<string, unknown> };
    const request = buildCompactionRequest(input.items as never[], input.policy as never);
    // No removable entries is a valid, safe no-op. Laya's protocol requires at
    // least one question, so produce the same guarded local abstention plan.
    if (Object.keys(request.questions).length === 0) return present(makeCompactionPlan(input.items as never[], { answers: {} }, input.policy as never));
    const result = await evaluate(callId, request, signal);
    return present(makeCompactionPlan(input.items as never[], result, input.policy as never));
  };
  const tool = {
    label: "Laya Evaluate",
    description: "Request typed choice, score, or noul decisions over structured state. It does not generate prose or execute actions.",
    promptSnippet: "Use for bounded, typed decision questions only.",
    parameters,
    execute,
  };
  pi.registerTool({ name: "laya_evaluate", ...tool });
  pi.registerTool({
    name: "laya_compact",
    label: "Laya Context Compaction Plan",
    description: "Return a reversible, non-executable KEEP/DROP/TRUNCATE plan. It never edits Pi session history or context.",
    promptSnippet: "Use only with a complete, normalized context snapshot and preserve protected evidence.",
    parameters: Type.Object({ items: Type.Array(Type.Object({ id: Type.String(), text: Type.String(), tokenEstimate: Type.Integer({ minimum: 0 }), protected: Type.Optional(Type.Boolean()), pairId: Type.Optional(Type.String()) })), policy: Type.Object({ coverage: Type.Union([Type.Literal("unchecked"), Type.Literal("profile_checked")]), targetTokens: Type.Integer({ minimum: 0 }), truncateTokenLimit: Type.Integer({ minimum: 0 }), threshold: Type.Number({ minimum: 0, maximum: 1 }), margin: Type.Number({ minimum: 0, maximum: 1 }), budget: Type.Integer({ minimum: 0, maximum: 20 }) }) }),
    execute: compact,
  });
  pi.registerCommand?.("laya_compact", {
    description: "Create an advisory Laya KEEP/DROP/TRUNCATE plan for the active Pi context",
    handler: async (args, context) => {
      const inputPath = args.trim();
      if (inputPath === "--help") {
        context.ui.notify("Usage: /laya_compact [snapshot.json] | history | outcome <plan-id> <accepted|rejected|succeeded|failed>. Plans are advisory and reversible.", "info");
        return;
      }
      if (inputPath === "history") {
        displayCompactionHistory(pi, context);
        return;
      }
      if (inputPath.startsWith("outcome ")) {
        recordSlashOutcome(pi, context, inputPath.slice("outcome ".length));
        return;
      }
      try {
        const snapshot = inputPath ? undefined : activeContextCompactionInput(context);
        const input = snapshot ?? JSON.parse(await readFile(resolve(context.cwd ?? process.cwd(), inputPath), "utf8"));
        const result = await compact(`slash:${Date.now()}`, input);
        const plan = result.details as CompactionPlan;
        const labels = snapshot ? snapshot.labels : labelsForItems(input.items);
        persistPlan(context, plan, labels);
        displayPlan(pi, context, plan, labels);
      } catch (error) {
        context.ui.notify(error instanceof Error ? `Laya compaction failed: ${error.message}` : "Laya compaction failed", "error");
      }
    },
  });
  pi.registerTool({
    name: "laya_review",
    label: "Laya Staged Diff Review",
    description: "Return staged, non-executable risk advice for a supplied diff. It never approves, commits, or sends a review.",
    promptSnippet: "Use compact textual diffs only; incomplete or binary evidence routes to human review.",
    parameters: Type.Object({ diff: Type.String(), complete: Type.Optional(Type.Boolean()), binary: Type.Optional(Type.Boolean()), policy: Type.Object({ threshold: Type.Number({ minimum: 0, maximum: 1 }), margin: Type.Number({ minimum: 0, maximum: 1 }), budget: Type.Integer({ minimum: 0, maximum: 20 }), maxBytes: Type.Integer({ minimum: 1, maximum: 65536 }) }) }),
    execute: async (callId, params, signal) => {
      const input = params as { diff: string; complete?: boolean; binary?: boolean; policy: Record<string, unknown> };
      const diff = { text: input.diff, complete: input.complete, binary: input.binary };
      const request = buildReviewRequest(diff, input.policy as never);
      if (request.route === "human") return present(makeReviewPlan(diff, { answers: {} }, input.policy as never));
      const result = await evaluate(callId, { state: request.state!, questions: request.questions! }, signal);
      return present(makeReviewPlan(diff, result, input.policy as never));
    },
  });
  pi.registerTool({
    name: "laya_inventory_route",
    label: "Laya Inventory Route",
    description: "Select from this Pi session's current skill, tool, or model inventory. It never enables a capability or changes models.",
    promptSnippet: "Use for advisory routing among currently available Pi capabilities only.",
    parameters: Type.Object({ kind: Type.Union([Type.Literal("skill"), Type.Literal("tool"), Type.Literal("model")]), task: Type.String({ minLength: 1 }), threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), margin: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) }),
    execute: async (callId, params, signal) => {
      const input = params as { kind: "skill" | "tool" | "model"; task: string; threshold?: number; margin?: number };
      const snapshot = snapshotInventory(pi, currentContext);
      const candidates = input.kind === "skill" ? snapshot.skills : input.kind === "tool" ? snapshot.tools : snapshot.models;
      if (candidates.length === 0 || candidates.length > 20) return present({ executable: false, status: "abstained", reason: "inventory_unavailable", snapshot });
      const criteria = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.description || candidate.label]));
      const result = await evaluate(callId, { state: { task: input.task, kind: input.kind, candidates }, questions: { select: { type: "choice", instructions: "Choose the most relevant available candidate, or let the host abstain when uncertain.", criteria } } }, signal);
      const answer = result.answers.select;
      const probabilities = answer?.type === "choice" ? answer.probabilities : undefined;
      const winner = answer?.type === "choice" && probabilities ? candidates.find((candidate) => candidate.id === answer.choice) : undefined;
      const probability = winner && probabilities ? probabilities[winner.id] : undefined;
      const runnerUp = probabilities ? Object.values(probabilities).sort((a, b) => b - a)[1] ?? 0 : 0;
      const threshold = input.threshold ?? 0.9;
      const margin = input.margin ?? 0.2;
      return present({ executable: false, status: winner && probability !== undefined && probability >= threshold && probability - runnerUp >= margin ? "proposed" : "abstained", selected: winner ? { id: winner.id, source: winner.source } : undefined, probability, snapshot });
    },
  });
  pi.registerTool({
    name: "laya_supervise",
    label: "Laya Agent Supervision",
    description: "Return bounded continue/retry/steer/stop/human advice. It never blocks tools or requests agent continuation.",
    promptSnippet: "Use for advisory supervision; host code owns retries, stopping, and escalation.",
    parameters: Type.Object({ state: Type.Optional(Type.Unknown()), limits: Type.Object({ maxSteps: Type.Integer({ minimum: 0 }), maxRetries: Type.Integer({ minimum: 0 }), maxFailures: Type.Integer({ minimum: 0 }) }), policy: Type.Object({ threshold: Type.Number({ minimum: 0, maximum: 1 }), margin: Type.Number({ minimum: 0, maximum: 1 }), budget: Type.Integer({ minimum: 0, maximum: 1 }) }), summary: Type.String() }),
    execute: async (callId, params, signal) => {
      const input = params as { state?: unknown; limits: Record<string, unknown>; policy: Record<string, unknown>; summary: string };
      const state = input.state ?? emptySupervisionState();
      const result = await evaluate(callId, { state: { summary: input.summary, state, limits: input.limits }, questions: { action: { type: "choice", instructions: "Choose the safest next supervision action.", criteria: Object.fromEntries(SUPERVISION_ACTIONS.map((action) => [action, `Host-owned ${action} action.`])) } } }, signal);
      return present(supervisionDecision(state as never, result, input.policy as never, input.limits as never));
    },
  });
  pi.registerTool({
    name: "laya_decide",
    label: "Laya Advisory Decision",
    description: "Return non-executable proposals for browser/computer actions, context retention, skill/tool selection, model routing, supervision, or review. Host code owns execution and authorization. Retention/review abstain without caller-checked complete coverage; scores are observations only.",
    promptSnippet: "Use for probability/margin-gated advice over explicit candidates. Never treat a proposal as authorization to act.",
    parameters: decisionParameters,
    execute: async (callId, params, signal) => {
      const request = validateDecisionRequest(params);
      const result = await evaluate(callId, { state: request.state, questions: request.questions }, signal);
      return present(makeDecisionProposal(request, result));
    },
  });
  pi.registerCommand?.("laya_decide", {
    description: "Run an advisory typed Laya decision from a JSON request file",
    handler: async (args, context) => {
      try {
        const input = await readSlashJson(args, context, "/laya_decide <request.json>");
        const request = validateDecisionRequest(input);
        const result = await evaluate(`slash:${Date.now()}`, { state: request.state, questions: request.questions });
        displayDetails(pi, context, "laya_decision", makeDecisionProposal(request, result));
      } catch (error) { notifySlashError(context, "Laya decision", error); }
    },
  });
  pi.registerCommand?.("laya_review", {
    description: "Run staged advisory diff review from a JSON request file",
    handler: async (args, context) => {
      try {
        const input = await readSlashJson(args, context, "/laya_review <request.json>") as { diff: string; complete?: boolean; binary?: boolean; policy: Record<string, unknown> };
        const diff = { text: input.diff, complete: input.complete, binary: input.binary };
        const request = buildReviewRequest(diff, input.policy as never);
        const plan = request.route === "human"
          ? makeReviewPlan(diff, { answers: {} }, input.policy as never)
          : makeReviewPlan(diff, await evaluate(`slash:${Date.now()}`, { state: request.state!, questions: request.questions! }), input.policy as never);
        displayDetails(pi, context, "laya_review", plan);
      } catch (error) { notifySlashError(context, "Laya review", error); }
    },
  });
  pi.registerCommand?.("laya_inventory_route", {
    description: "Choose an installed Pi skill, tool, or model for a task",
    handler: async (args, context) => {
      const [kind, ...taskParts] = args.trim().split(/\s+/);
      const task = taskParts.join(" ").trim();
      if ((kind !== "skill" && kind !== "tool" && kind !== "model") || !task) {
        context.ui.notify("Usage: /laya_inventory_route <skill|tool|model> <task>", "info");
        return;
      }
      try {
        const snapshot = snapshotInventory(pi, currentContext);
        const candidates = kind === "skill" ? snapshot.skills : kind === "tool" ? snapshot.tools : snapshot.models;
        if (candidates.length === 0 || candidates.length > 20) {
          displayDetails(pi, context, "laya_inventory_route", { executable: false, status: "abstained", reason: "inventory_unavailable", snapshot });
          return;
        }
        const criteria = Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.description || candidate.label]));
        const result = await evaluate(`slash:${Date.now()}`, { state: { task, kind, candidates }, questions: { select: { type: "choice", instructions: "Choose the most relevant available candidate, or let the host abstain when uncertain.", criteria } } });
        const answer = result.answers.select;
        const probabilities = answer?.type === "choice" ? answer.probabilities : undefined;
        const selected = answer?.type === "choice" && probabilities ? candidates.find((candidate) => candidate.id === answer.choice) : undefined;
        const probability = selected && probabilities ? probabilities[selected.id] : undefined;
        const runnerUp = probabilities ? Object.values(probabilities).sort((a, b) => b - a)[1] ?? 0 : 0;
        displayDetails(pi, context, "laya_inventory_route", { executable: false, status: selected && probability !== undefined && probability >= 0.9 && probability - runnerUp >= 0.2 ? "proposed" : "abstained", selected: selected ? { id: selected.id, source: selected.source } : undefined, probability, snapshot });
      } catch (error) { notifySlashError(context, "Laya inventory route", error); }
    },
  });
  pi.registerCommand?.("laya_supervise", {
    description: "Run advisory agent supervision from a JSON request file",
    handler: async (args, context) => {
      try {
        const input = await readSlashJson(args, context, "/laya_supervise <request.json>") as { state?: unknown; limits: Record<string, unknown>; policy: Record<string, unknown>; summary: string };
        const state = input.state ?? emptySupervisionState();
        const result = await evaluate(`slash:${Date.now()}`, { state: { summary: input.summary, state, limits: input.limits }, questions: { action: { type: "choice", instructions: "Choose the safest next supervision action.", criteria: Object.fromEntries(SUPERVISION_ACTIONS.map((action) => [action, `Host-owned ${action} action.`])) } } });
        displayDetails(pi, context, "laya_supervision", supervisionDecision(state as never, result, input.policy as never, input.limits as never));
      } catch (error) { notifySlashError(context, "Laya supervision", error); }
    },
  });
  if ((configOptions.env ?? process.env).PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS === "true") pi.registerTool({ name: "laya_system_one", ...tool });
  registerLayaCommands(pi, configOptions, async (request, signal) => await evaluate(`command:${Date.now()}`, request, signal), stats);
}

async function readSlashJson(args: string, context: SlashCommandContext, usage: string): Promise<unknown> {
  const path = args.trim();
  if (!path || path === "--help") throw new Error(`Usage: ${usage}`);
  try {
    return JSON.parse(await readFile(resolve(context.cwd ?? process.cwd(), path), "utf8"));
  } catch (error) {
    throw new Error(`Cannot read valid JSON from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function displayDetails(pi: PiLike, context: SlashCommandContext, customType: string, details: unknown): void {
  const text = JSON.stringify(details, null, 2);
  if (pi.sendMessage) pi.sendMessage({ customType, content: text, display: true });
  else context.ui.notify(text, "info");
}

function notifySlashError(context: SlashCommandContext, label: string, error: unknown): void {
  context.ui.notify(error instanceof Error ? `${label} failed: ${error.message}` : `${label} failed`, "error");
}

function persistPlan(context: SlashCommandContext, plan: CompactionPlan, labels: Record<string, string>): void {
  context.sessionManager?.appendCustomEntry?.(PLAN_ENTRY_TYPE, { version: 1, plan, labels } satisfies PersistedCompactionPlan);
}

function displayPlan(pi: PiLike, context: SlashCommandContext, plan: CompactionPlan, labels: Record<string, string>): void {
  const text = formatPlan(plan, labels);
  if (pi.sendMessage) pi.sendMessage({ customType: PLAN_ENTRY_TYPE, content: text, display: true });
  else context.ui.notify(text, "info");
}

function formatPlan(plan: CompactionPlan, labels: Record<string, string>): string {
  const title = `Laya compaction ${shortId(plan.trace.id)} — ${plan.status.toUpperCase()}`;
  const budget = `Estimated context: ${plan.totalTokens} → ${plan.projectedTokens} tokens`;
  if (plan.status === "abstained") return [title, budget, `Reason: ${plan.reason ?? "unspecified"}`, "No session context was changed."].join("\n");
  return [
    title,
    budget,
    `KEEP (${plan.keepIds.length}): ${formatItems(plan.keepIds, labels)}`,
    `DROP (${plan.dropIds.length}): ${formatItems(plan.dropIds, labels)}`,
    `TRUNCATE (${plan.truncateIds.length} at ${plan.truncationTokenLimit} tokens): ${formatItems(plan.truncateIds, labels)}`,
    "Advisory only: no Pi session entries were changed. Record an outcome with /laya_compact outcome <plan-id> <status>.",
  ].join("\n");
}

function formatItems(ids: readonly string[], labels: Record<string, string>): string {
  if (ids.length === 0) return "none";
  return ids.map((id) => `${labels[id] ?? "item"} (${shortId(id)})`).join(", ");
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function labelsForItems(items: unknown): Record<string, string> {
  if (!Array.isArray(items)) return {};
  return Object.fromEntries(items.flatMap((item, index) => item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, unknown>).id === "string"
    ? [[(item as Record<string, string>).id, `item ${index + 1}`]]
    : []));
}

function labelsForActiveContext(entries: readonly unknown[]): Record<string, string> {
  const labels: Record<string, string> = {};
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const value = entry as Record<string, unknown>;
    if (typeof value.id !== "string") return;
    const message = value.message && typeof value.message === "object" && !Array.isArray(value.message) ? value.message as Record<string, unknown> : undefined;
    const role = typeof message?.role === "string" ? message.role : typeof value.type === "string" ? value.type : "context";
    labels[value.id] = `${role} ${index + 1}`;
  });
  return labels;
}

function displayCompactionHistory(pi: PiLike, context: SlashCommandContext): void {
  const plans = readPersistedPlans(context);
  const outcomes = readPersistedOutcomes(context);
  const text = plans.length === 0
    ? "No Laya compaction plans are recorded in this Pi session."
    : plans.map(({ plan, labels }) => `${formatPlan(plan, labels)}\nOutcome: ${outcomes.get(plan.trace.id) ?? plan.trace.outcome ?? "not recorded"}`).join("\n\n");
  if (pi.sendMessage) pi.sendMessage({ customType: "laya_compaction_history", content: text, display: true });
  else context.ui.notify(text, "info");
}

function recordSlashOutcome(pi: PiLike, context: SlashCommandContext, args: string): void {
  const [planPrefix, status] = args.trim().split(/\s+/, 2);
  if (!planPrefix || !status || !OUTCOME_STATUSES.includes(status as OutcomeStatus)) {
    context.ui.notify("Usage: /laya_compact outcome <plan-id> <accepted|rejected|succeeded|failed>", "error");
    return;
  }
  const matches = readPersistedPlans(context).filter(({ plan }) => plan.trace.id.startsWith(planPrefix));
  if (matches.length !== 1) {
    context.ui.notify(matches.length === 0 ? "No matching recorded compaction plan." : "Plan ID prefix is ambiguous; provide more characters.", "error");
    return;
  }
  try {
    const record = matches[0]!;
    const updated = recordCompactionOutcome(record.plan, { decisionId: record.plan.trace.id, inputDigest: record.plan.snapshotDigest, status: status as OutcomeStatus });
    const outcome: PersistedCompactionOutcome = { version: 1, decisionId: updated.trace.id, inputDigest: updated.snapshotDigest, status: status as OutcomeStatus, timestamp: new Date().toISOString() };
    context.sessionManager?.appendCustomEntry?.(OUTCOME_ENTRY_TYPE, outcome);
    const text = `Recorded Laya compaction ${shortId(updated.trace.id)} outcome: ${status}.`;
    if (pi.sendMessage) pi.sendMessage({ customType: OUTCOME_ENTRY_TYPE, content: text, display: true });
    else context.ui.notify(text, "info");
  } catch (error) {
    context.ui.notify(error instanceof Error ? `Could not record outcome: ${error.message}` : "Could not record outcome", "error");
  }
}

function readPersistedPlans(context: SlashCommandContext): PersistedCompactionPlan[] {
  return (context.sessionManager?.getBranch?.() ?? []).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const value = entry as Record<string, unknown>;
    const data = value.type === "custom" && value.customType === PLAN_ENTRY_TYPE ? value.data : undefined;
    return isPersistedPlan(data) ? [data] : [];
  });
}

function readPersistedOutcomes(context: SlashCommandContext): Map<string, OutcomeStatus> {
  const outcomes = new Map<string, OutcomeStatus>();
  for (const entry of context.sessionManager?.getBranch?.() ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const value = entry as Record<string, unknown>;
    const data = value.type === "custom" && value.customType === OUTCOME_ENTRY_TYPE ? value.data : undefined;
    if (isPersistedOutcome(data)) outcomes.set(data.decisionId, data.status);
  }
  return outcomes;
}

function isPersistedPlan(value: unknown): value is PersistedCompactionPlan {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).version === 1
    && !!(value as Record<string, unknown>).plan && typeof (value as Record<string, unknown>).plan === "object"
    && !!(value as Record<string, unknown>).labels && typeof (value as Record<string, unknown>).labels === "object";
}

function isPersistedOutcome(value: unknown): value is PersistedCompactionOutcome {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).version === 1 && typeof (value as Record<string, unknown>).decisionId === "string"
    && typeof (value as Record<string, unknown>).inputDigest === "string" && OUTCOME_STATUSES.includes((value as Record<string, unknown>).status as OutcomeStatus);
}

function activeContextCompactionInput(context: SlashCommandContext): { items: SnapshotItem[]; policy: Record<string, unknown>; labels: Record<string, string> } {
  const entries = context.sessionManager?.buildContextEntries();
  if (!entries) throw new Error("Active Pi session context is unavailable; use /compact instead");
  const items = entries.flatMap((entry, index) => contextEntryToItem(entry, index));
  if (items.length === 0) throw new Error("Active Pi session has no textual context to compact");
  // Keep user intent, earlier summaries, and the newest two entries intact.
  const protectedStart = Math.max(0, items.length - 2);
  for (let index = protectedStart; index < items.length; index += 1) items[index]!.protected = true;
  const labels = labelsForActiveContext(entries);
  const grouped = groupRemovableItems(items, labels);
  const totalTokens = items.reduce((total, item) => total + item.tokenEstimate, 0);
  return {
    items: grouped,
    labels: Object.fromEntries(grouped.map((item) => [item.id, labels[item.id] ?? "item"])),
    policy: {
      coverage: "profile_checked",
      targetTokens: Math.floor(totalTokens * 0.7),
      truncateTokenLimit: 512,
      threshold: 0.9,
      margin: 0.2,
      budget: grouped.filter((item) => !item.protected).length,
    },
  };
}

function groupRemovableItems(items: SnapshotItem[], labels: Record<string, string>): SnapshotItem[] {
  const removable = items.filter((item) => !item.protected);
  if (removable.length <= ACTIVE_COMPACTION_GROUPS) return items;
  const groups = new Map<SnapshotItem, SnapshotItem>();
  const positions = new Map(items.map((item, index) => [item, index]));
  const existingIds = new Set(items.map((item) => item.id));
  for (let index = 0; index < ACTIVE_COMPACTION_GROUPS; index += 1) {
    const start = Math.floor(index * removable.length / ACTIVE_COMPACTION_GROUPS);
    const end = Math.floor((index + 1) * removable.length / ACTIVE_COMPACTION_GROUPS);
    const members = removable.slice(start, end);
    let id = `group-${index + 1}`;
    while (existingIds.has(id)) id = `laya-${id}`;
    existingIds.add(id);
    // JSON retains text, IDs, and original chronology across protected entries.
    const group: SnapshotItem = {
      id,
      text: JSON.stringify(members.map((item) => ({ position: positions.get(item), id: item.id, text: item.text }))),
      tokenEstimate: members.reduce((sum, item) => sum + item.tokenEstimate, 0),
    };
    labels[id] = `group ${index + 1} (${members.length} entries, ${labels[members[0]!.id] ?? "first"} to ${labels[members[members.length - 1]!.id] ?? "last"})`;
    for (const member of members) groups.set(member, group);
  }
  const seen = new Set<SnapshotItem>();
  return items.flatMap((item) => {
    if (item.protected) return [item];
    const group = groups.get(item)!;
    if (seen.has(group)) return [];
    seen.add(group);
    return [group];
  });
}

function contextEntryToItem(entry: unknown, index: number): SnapshotItem[] {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
  const value = entry as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : `context-${index}`;
  const type = value.type;
  if (type === "compaction" || type === "branch_summary") {
    const text = typeof value.summary === "string" ? value.summary.trim() : "";
    return text ? [{ id, text, tokenEstimate: estimateTokens(text), protected: true }] : [];
  }
  if (type === "custom_message") {
    const text = textFromContent(value.content);
    return text ? [{ id, text, tokenEstimate: estimateTokens(text), protected: true }] : [];
  }
  if (type !== "message" || !value.message || typeof value.message !== "object" || Array.isArray(value.message)) return [];
  const message = value.message as Record<string, unknown>;
  const text = textFromContent(message.content);
  if (!text) return [];
  return [{ id, text, tokenEstimate: estimateTokens(text), protected: message.role === "user" || message.role === "system" }];
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (content === undefined || content === null) return "";
  if (!Array.isArray(content)) throw new Error("Active Pi session contains non-text content; use /compact instead");
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new Error("Active Pi session contains non-text content; use /compact instead");
    const value = part as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") texts.push(value.text);
    else if (value.type === "toolCall") texts.push(JSON.stringify(value));
    else throw new Error("Active Pi session contains non-text content; use /compact instead");
  }
  return texts.join("\n").trim();
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
