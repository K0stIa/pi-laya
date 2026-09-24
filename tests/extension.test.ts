// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as extensionModule from "../src/index.js";

test("extension registers advisory tools by default and makes no request at load", () => {
  assert.equal(typeof extensionModule.default, "function");
  const extension = extensionModule.default;
  const tools = [];
  extension({ registerTool: (tool) => tools.push(tool) }, { env: {} });
  assert.deepEqual(tools.map((tool) => tool.name), ["laya_evaluate", "laya_compact", "laya_review", "laya_inventory_route", "laya_supervise", "laya_decide"]);
});

test("extension registers /laya_compact and returns an advisory plan from a snapshot file", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    answers: { "item:old": { type: "choice", choice: "DROP", probabilities: { KEEP: 0.02, DROP: 0.96, TRUNCATE: 0.02 } } },
  }));
  try {
    const commands = [];
    const messages = [];
    extensionModule.default({ registerTool: () => {}, registerCommand: (name, command) => commands.push({ name, command }), sendMessage: (message) => messages.push(message) }, { env: { PI_LAYA_BASE_URL: "https://laya.example.com", PI_LAYA_API_TOKEN: "test-token" } });
    assert.equal(commands[0].name, "laya_compact");
    const directory = await mkdtemp(join(tmpdir(), "pi-laya-command-"));
    await writeFile(join(directory, "snapshot.json"), JSON.stringify({
      items: [{ id: "old", text: "stale output", tokenEstimate: 100 }],
      policy: { coverage: "profile_checked", targetTokens: 0, truncateTokenLimit: 10, threshold: 0.9, margin: 0.2, budget: 1 },
    }));
    const notices = [];
    await commands[0].command.handler("snapshot.json", { cwd: directory, ui: { notify: (...args) => notices.push(args) } });
    assert.equal(notices.length, 0);
    const plan = JSON.parse(messages[0].content);
    assert.deepEqual(plan.dropIds, ["old"]);
    assert.equal(plan.executable, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/laya_compact snapshots active Pi context when called without arguments", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    answers: { "item:old": { type: "choice", choice: "DROP", probabilities: { KEEP: 0.02, DROP: 0.96, TRUNCATE: 0.02 } } },
  }));
  try {
    const commands = [];
    const messages = [];
    extensionModule.default({ registerTool: () => {}, registerCommand: (name, command) => commands.push({ name, command }), sendMessage: (message) => messages.push(message) }, { env: { PI_LAYA_BASE_URL: "https://laya.example.com", PI_LAYA_API_TOKEN: "test-token" } });
    const notices = [];
    await commands[0].command.handler("", {
      sessionManager: { buildContextEntries: () => [
        { id: "old", type: "message", message: { role: "assistant", content: [{ type: "text", text: "obsolete tool analysis" }] } },
        { id: "goal", type: "message", message: { role: "user", content: [{ type: "text", text: "keep current goal" }] } },
        { id: "current", type: "message", message: { role: "assistant", content: [{ type: "text", text: "current result" }] } },
      ] },
      ui: { notify: (...args) => notices.push(args) },
    });
    assert.equal(notices.length, 0);
    assert.deepEqual(JSON.parse(messages[0].content).dropIds, ["old"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extension enables compatibility alias only when opted in", () => {
  assert.equal(typeof extensionModule.default, "function");
  const extension = extensionModule.default;
  const tools = [];
  extension({ registerTool: (tool) => tools.push(tool) }, { env: { PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS: "true" } });
  assert.deepEqual(tools.map((tool) => tool.name), ["laya_evaluate", "laya_compact", "laya_review", "laya_inventory_route", "laya_supervise", "laya_decide", "laya_system_one"]);
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
    assert.deepEqual(tools.map((tool) => tool.name), ["laya_evaluate", "laya_compact", "laya_review", "laya_inventory_route", "laya_supervise", "laya_decide", "laya_system_one"]);
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
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not be used for missing configuration");
  };
  try {
    extensionModule.default({ registerTool: (tool) => tools.push(tool) }, {
      env: {},
      readLocalConfig: () => undefined,
      readSecret: () => { throw new Error("missing test secret"); },
    });
    await assert.rejects(() => tools[0].execute("call", { state: {}, questions: { decide: { type: "noul", instructions: "Decide" } } }), { message: "Laya error: Laya configuration is incomplete" });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
