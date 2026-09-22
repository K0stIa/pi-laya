import { Type } from "typebox";
import { LayaClient } from "./client.js";
import { resolveConfig, type ResolveConfigOptions } from "./config.js";
import { DECISION_PLACEMENTS, makeDecisionProposal, validateDecisionRequest } from "./proposals.js";
import { buildCompactionRequest, makeCompactionPlan } from "./compaction.js";
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
  on?: (event: string, handler: (event: unknown, context: unknown) => void | Promise<void>) => void;
}

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
  const evaluate = evaluator(configOptions);
  const present = (result: unknown) => ({ content: [{ type: "text", text: JSON.stringify(result) }], details: result });
  const execute = async (callId: string, params: unknown, signal?: AbortSignal) => present(await evaluate(callId, params, signal));
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
    execute: async (callId, params, signal) => {
      const input = params as { items: unknown[]; policy: Record<string, unknown> };
      const request = buildCompactionRequest(input.items as never[], input.policy as never);
      const result = await evaluate(callId, request, signal);
      return present(makeCompactionPlan(input.items as never[], result, input.policy as never));
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
  if ((configOptions.env ?? process.env).PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS === "true") pi.registerTool({ name: "laya_system_one", ...tool });
}
