import { Type } from "typebox";
import { validateRequest, type LayaQuestion, type LayaRequest } from "./protocol.js";

const DESIGN_TOOL = "submit_laya_questions";

// Flat, required fields keep this within Pi's provider-side strict JSON-schema
// subset. Type-specific constraints are checked again by validateRequest.
export const designTool = {
  name: DESIGN_TOOL,
  description: "Submit typed questions for a System-One evaluation of the user's prompt.",
  parameters: Type.Object({
    questions: Type.Array(Type.Object({
      id: Type.String({ minLength: 1 }),
      type: Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")]),
      instructions: Type.String({ minLength: 1 }),
      options: Type.Array(Type.Object({ key: Type.String({ minLength: 1 }), description: Type.String({ minLength: 1 }) })),
      levels: Type.Array(Type.String({ minLength: 1 })),
    }), { minItems: 1, maxItems: 6 }),
  }),
  constrainedSampling: { type: "json_schema", strict: "prefer" },
};

interface ModelResponse {
  stopReason?: string;
  content: Array<{ type: string; text?: string; name?: string; arguments?: unknown }>;
}

export interface DesignerContext {
  model?: { provider: string; id: string };
  modelRegistry?: {
    hasConfiguredAuth?: (model: { provider: string; id: string }) => boolean;
    complete?: (model: { provider: string; id: string }, context: unknown, options: unknown) => Promise<ModelResponse>;
  };
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseText(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed) throw new Error("Active model returned no evaluation design.");
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid design JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error("Invalid question design: expected an object");
  return value;
}

function validateDesign(raw: unknown, prompt: string): LayaRequest {
  if (!isRecord(raw)) throw new Error("Invalid question design: expected an object");
  // Older providers may return the existing {state, questions} format as text.
  // Never trust their state: the caller's original prompt is the source of truth.
  if (!Array.isArray(raw.questions)) {
    if (!isRecord(raw.questions)) throw new Error("Invalid question design: questions must be an array or object");
    const request = validateRequest({ state: { prompt }, questions: raw.questions });
    if (Object.keys(request.questions).length > 6) throw new Error("Invalid question design: at most 6 questions are allowed");
    return request;
  }
  if (raw.questions.length < 1 || raw.questions.length > 6) throw new Error("Invalid question design: expected 1 to 6 questions");
  const questions: Record<string, LayaQuestion> = Object.create(null);
  for (const [index, value] of raw.questions.entries()) {
    if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim()) throw new Error(`Invalid question design: questions.${index}.id must be non-empty`);
    if (Object.hasOwn(questions, value.id)) throw new Error(`Invalid question design: duplicate question ${value.id}`);
    const instructions = value.instructions;
    if (typeof instructions !== "string" || !instructions.trim()) throw new Error(`Invalid question design: questions.${index}.instructions must be non-empty`);
    if (value.type === "noul") {
      questions[value.id] = { type: "noul", instructions };
    } else if (value.type === "choice") {
      if (!Array.isArray(value.options) || value.options.length < 2) throw new Error(`Invalid question design: questions.${index}.options must contain at least two choices`);
      const criteria: Record<string, string> = Object.create(null);
      for (const [optionIndex, option] of value.options.entries()) {
        if (!isRecord(option) || typeof option.key !== "string" || !option.key.trim() || typeof option.description !== "string" || !option.description.trim()) throw new Error(`Invalid question design: questions.${index}.options.${optionIndex} requires key and description`);
        if (Object.hasOwn(criteria, option.key)) throw new Error(`Invalid question design: duplicate option ${option.key}`);
        criteria[option.key] = option.description;
      }
      questions[value.id] = { type: "choice", instructions, criteria };
    } else if (value.type === "score") {
      if (!Array.isArray(value.levels) || value.levels.length < 2) throw new Error(`Invalid question design: questions.${index}.levels must contain at least two levels`);
      questions[value.id] = { type: "score", instructions, criteria: value.levels };
    } else throw new Error(`Invalid question design: questions.${index}.type must be noul, choice, or score`);
  }
  return validateRequest({ state: { prompt }, questions });
}

export async function designEvaluation(ctx: DesignerContext, prompt: string): Promise<LayaRequest> {
  if (!ctx.model || !ctx.modelRegistry?.complete || (ctx.modelRegistry.hasConfiguredAuth && !ctx.modelRegistry.hasConfiguredAuth(ctx.model))) throw new Error("Active model with configured authentication required to design evaluation.");
  let validationError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const systemPrompt = [
      "Design 1 to 6 typed System-One questions from the user's prompt. Call submit_laya_questions with questions; do not answer the questions.",
      "For noul set options and levels to empty arrays. For choice use at least two key/description options and empty levels. For score use at least two ordered levels and empty options.",
      "Each question must be answerable using only the user's prompt. Do not invent missing choices.",
      ...(validationError ? [`Your previous question design failed validation: ${validationError}. Correct that exact error and submit again.`] : []),
    ].join("\n");
    const response = await ctx.modelRegistry.complete(ctx.model, {
      systemPrompt,
      tools: [designTool],
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
    }, { signal: ctx.signal, cacheRetention: "none" });
    if (response.stopReason === "error") throw new Error("Active model request failed. Check provider credits and credentials.");
    try {
      const toolCall = response.content.find((part) => part.type === "toolCall" && part.name === DESIGN_TOOL);
      const raw = toolCall ? toolCall.arguments : parseText(response.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n"));
      return validateDesign(raw, prompt);
    } catch (error) {
      validationError = error instanceof Error ? error.message : "Invalid question design";
    }
  }
  throw new Error(`Active model could not design valid Laya questions after one retry: ${validationError}`);
}
