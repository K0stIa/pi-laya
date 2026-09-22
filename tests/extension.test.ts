// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import * as extensionModule from "../src/index.js";

test("extension registers advisory tools by default and makes no request at load", () => {
  assert.equal(typeof extensionModule.default, "function");
  const extension = extensionModule.default;
  const tools = [];
  extension({ registerTool: (tool) => tools.push(tool) }, { env: {} });
  assert.deepEqual(tools.map((tool) => tool.name), ["laya_evaluate", "laya_decide"]);
});

test("extension enables compatibility alias only when opted in", () => {
  assert.equal(typeof extensionModule.default, "function");
  const extension = extensionModule.default;
  const tools = [];
  extension({ registerTool: (tool) => tools.push(tool) }, { env: { PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS: "true" } });
  assert.deepEqual(tools.map((tool) => tool.name), ["laya_evaluate", "laya_decide", "laya_system_one"]);
});

test("extension publishes schemas for all typed question variants", () => {
  const tools = [];
  extensionModule.default({ registerTool: (tool) => tools.push(tool) });
  const question = Object.values(tools[0].parameters.properties.questions.patternProperties)[0];
  assert.deepEqual(question.anyOf.map((variant) => variant.properties.type.const), ["choice", "score", "noul"]);
  assert.equal(question.anyOf[1].properties.criteria.type, "array");
  assert.ok(question.anyOf[1].required.includes("criteria"));
});

test("extension reads alias opt-in from the real environment", () => {
  const previous = process.env.PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS;
  process.env.PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS = "true";
  const tools = [];
  try {
    extensionModule.default({ registerTool: (tool) => tools.push(tool) });
    assert.deepEqual(tools.map((tool) => tool.name), ["laya_evaluate", "laya_decide", "laya_system_one"]);
  } finally {
    if (previous === undefined) delete process.env.PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS;
    else process.env.PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS = previous;
  }
});

test("decision tool declares seven placements and rejects invalid policy before configuration", async () => {
  const tools = [];
  extensionModule.default({ registerTool: (tool) => tools.push(tool) }, { env: {} });
  const tool = tools.find((candidate) => candidate.name === "laya_decide");
  assert.equal(tool.parameters.properties.placement.anyOf.length, 7);
  await assert.rejects(() => tool.execute("call", { placement: "execute", state: {}, questions: { q: { type: "noul", instructions: "Proceed?" } } }), /Invalid Laya decision placement/);
});

test("Pi decision tool evaluates typed state then returns gated non-executable advice", async () => {
  const originalFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ answers: { action: { type: "choice", choice: "click", probabilities: { click: 0.97, wait: 0.03 } } } }));
  };
  try {
    const tools = [];
    extensionModule.default({ registerTool: (tool) => tools.push(tool) }, { env: { PI_LAYA_BASE_URL: "https://laya.example.com", PI_LAYA_API_TOKEN: "test-token" } });
    const tool = tools.find((candidate) => candidate.name === "laya_decide");
    const result = await tool.execute("call", {
      placement: "browser", state: { button: "next" },
      questions: { action: { type: "choice", instructions: "Choose next action", criteria: { click: "Click next", wait: "Wait" } } },
    });
    assert.equal(result.details.executable, false);
    assert.equal(result.details.decisions.action.value, "click");
    assert.equal(result.details.coverage, "unchecked");
    assert.deepEqual(Object.keys(sent).sort(), ["questions", "state"]);
    assert.deepEqual(sent.state, { button: "next" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extension throws a safe configuration error without an endpoint", async () => {
  const tools = [];
  extensionModule.default({ registerTool: (tool) => tools.push(tool) }, { env: {} });
  await assert.rejects(() => tools[0].execute("call", { state: {}, questions: { decide: { type: "noul", instructions: "Decide" } } }), { message: "Laya error: Laya configuration is incomplete" });
});
