export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  criteria: string[];
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
}

export type LayaQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type LayaQuestions = Record<string, LayaQuestion>;

export interface LayaRequest {
  state: JsonValue;
  questions: LayaQuestions;
}

export interface ChoiceAnswer { type: "choice"; choice: string; probabilities: Record<string, number>; }
export interface ScoreAnswer { type: "score"; score: number; legend?: string[]; probabilities?: number[]; }
export interface NoulAnswer { type: "noul"; noul: number; }
export type LayaAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export interface LayaResult { answers: Record<string, LayaAnswer>; model?: string; usage?: Record<string, number>; }

const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 16;

function fail(message: string): never {
  throw new Error(`Invalid Laya request: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must be a non-empty string array`);
  return value.map((item, index) => requireString(item, `${field}.${index}`));
}

function validateJson(value: unknown, depth: number): asserts value is JsonValue {
  if (depth > MAX_DEPTH) fail(`payload exceeds maximum depth of ${MAX_DEPTH}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("payload must contain only finite JSON numbers");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) validateJson(item, depth + 1);
    return;
  }
  fail("payload must be JSON data");
}

function validateQuestion(name: string, value: unknown): LayaQuestion {
  if (!isRecord(value)) fail(`question ${name} must be an object`);
  const type = value.type;
  const instructions = requireString(value.instructions, `question ${name}.instructions`);
  if (type === "choice") {
    if (!isRecord(value.criteria) || Object.keys(value.criteria).length === 0) fail(`question ${name}.criteria must have at least one option`);
    const criteria = dictionary<string>();
    for (const [option, description] of Object.entries(value.criteria)) {
      if (option.trim().length === 0) fail(`question ${name}.criteria option must be non-empty`);
      criteria[option] = requireString(description, `question ${name}.criteria.${option}`);
    }
    return { type, instructions, criteria };
  }
  if (type === "score") return { type, instructions, criteria: requireStringArray(value.criteria, `question ${name}.criteria`) };
  if (type === "noul") {
    if (value.criteria === undefined) return { type, instructions };
    if (!isRecord(value.criteria) || !Object.hasOwn(value.criteria, "true") || !Object.hasOwn(value.criteria, "false") || Object.keys(value.criteria).length !== 2) fail(`question ${name}.criteria must contain true and false strings`);
    return { type, instructions, criteria: { true: requireString(value.criteria.true, `question ${name}.criteria.true`), false: requireString(value.criteria.false, `question ${name}.criteria.false`) } };
  }
  fail(`question ${name}.type must be choice, score, or noul`);
}

export function validateRequest(value: unknown): LayaRequest {
  if (!isRecord(value) || !("state" in value) || !isRecord(value.questions)) fail("payload requires state and questions");
  validateJson(value.state, 0);
  const questionEntries = Object.entries(value.questions);
  if (questionEntries.length < 1 || questionEntries.length > 20) fail("questions must contain 1 to 20 entries");
  const questions = dictionary<LayaQuestion>();
  for (const [name, question] of questionEntries) {
    if (name.trim().length === 0) fail("question names must be non-empty");
    questions[name] = validateQuestion(name, question);
  }
  const request = { state: value.state, questions } as LayaRequest;
  let serialized: string;
  try {
    serialized = JSON.stringify(request);
  } catch {
    fail("payload must be JSON serializable");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_BYTES) fail(`payload exceeds ${MAX_BYTES} bytes`);
  return request;
}

function responseFail(message: string): never {
  throw new Error(`Invalid Laya response: ${message}`);
}

function responseNumber(value: unknown, field: string, probability = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (probability && (value < 0 || value > 1))) responseFail(`${field} must be a${probability ? " probability" : " finite number"}`);
  return value;
}

// Minis rounds each ONNX probability to four decimals. Permit only the
// maximum aggregate rounding error; still reject materially unnormalized data.
function normalizedWithinRounding(values: readonly number[]): boolean {
  return Math.abs(values.reduce((sum, probability) => sum + probability, 0) - 1) <= values.length * 0.00005 + 1e-6;
}

// Minis serializes score arrays as numeric-keyed objects. Accept only dense,
// zero-based indices; never fill gaps or guess an order for other objects.
function responseSequence(value: unknown, length: number, field: string): unknown[] {
  if (Array.isArray(value) && value.length === length) return value;
  if (isRecord(value) && Object.keys(value).length === length && Array.from({ length }, (_, index) => String(index)).every((key) => Object.hasOwn(value, key))) {
    return Array.from({ length }, (_, index) => value[String(index)]);
  }
  responseFail(`${field} must contain ${length} indexed entries`);
}

function responseProbabilities(value: unknown, criteria: readonly string[], field: string): number[] {
  const probabilities = responseSequence(value, criteria.length, field).map((item, index) => responseNumber(item, `${field}.${index}`, true));
  if (!normalizedWithinRounding(probabilities)) responseFail(`${field} must be normalized`);
  return probabilities;
}

function responseChoiceProbabilities(value: unknown, criteria: Record<string, string>, field: string): Record<string, number> {
  if (!isRecord(value)) responseFail(`${field} must be an object`);
  const options = Object.keys(criteria);
  const names = Object.keys(value);
  if (names.length !== options.length || options.some((option) => !Object.hasOwn(value, option))) responseFail(`${field} must match submitted options`);
  const probabilities = dictionary<number>();
  for (const option of options) probabilities[option] = responseNumber(value[option], `${field}.${option}`, true);
  if (!normalizedWithinRounding(Object.values(probabilities))) responseFail(`${field} must be normalized`);
  return probabilities;
}

export function validateResult(questions: LayaQuestions, value: unknown): LayaResult {
  if (!isRecord(value)) responseFail("response must be an object");
  const rawAnswers = value.answers;
  if (!isRecord(rawAnswers)) responseFail("answers must be an object");
  const names = Object.keys(questions);
  const answerNames = Object.keys(rawAnswers);
  if (names.length !== answerNames.length || names.some((name) => !Object.hasOwn(rawAnswers, name))) responseFail("answers must match submitted questions");
  const answers = dictionary<LayaAnswer>();
  for (const name of names) {
    const expected = questions[name];
    const answer = rawAnswers[name];
    if (!isRecord(answer) || answer.type !== expected.type) responseFail(`answer ${name} does not match question type`);
    if (expected.type === "choice") {
      if (typeof answer.choice !== "string" || !Object.hasOwn(expected.criteria, answer.choice)) responseFail(`answer ${name}.choice is not a submitted option`);
      answers[name] = { type: "choice", choice: answer.choice, probabilities: responseChoiceProbabilities(answer.probabilities, expected.criteria, `answer ${name}.probabilities`) };
    } else if (expected.type === "score") {
      const score = responseNumber(answer.score, `answer ${name}.score`);
      if (score < 0 || score > expected.criteria.length - 1) responseFail(`answer ${name}.score must be within submitted criteria bounds`);
      const result: ScoreAnswer = { type: "score", score };
      if (answer.legend !== undefined) {
        const legend = responseSequence(answer.legend, expected.criteria.length, `answer ${name}.legend`).map((item, index) => {
          if (typeof item !== "string" || !item.trim()) responseFail(`answer ${name}.legend.${index} must be a non-empty string`);
          return item;
        });
        if (legend.some((item, index) => item !== expected.criteria[index])) responseFail(`answer ${name}.legend must match submitted criteria`);
        result.legend = legend;
      }
      if (answer.probabilities !== undefined) result.probabilities = responseProbabilities(answer.probabilities, expected.criteria, `answer ${name}.probabilities`);
      answers[name] = result;
    } else {
      answers[name] = { type: "noul", noul: responseNumber(answer.noul, `answer ${name}.noul`, true) };
    }
  }
  const result: LayaResult = { answers };
  if (typeof value.model === "string") result.model = value.model;
  if (isRecord(value.usage)) {
    result.usage = dictionary<number>();
    for (const [name, amount] of Object.entries(value.usage)) result.usage[name] = responseNumber(amount, `usage.${name}`);
  }
  return result;
}
