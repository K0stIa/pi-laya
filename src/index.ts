import { Type } from "typebox";
import { LayaClient } from "./client.js";
import { resolveConfig, type ResolveConfigOptions } from "./config.js";
import { DECISION_PLACEMENTS, makeDecisionProposal, validateDecisionRequest } from "./proposals.js";

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
