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

test("extension registers slash commands for every advisory adapter", () => {
  const commands = [];
  extensionModule.default({ registerTool: () => {}, registerCommand: (name, command) => commands.push({ name, command }) }, { env: {} });
  assert.deepEqual(commands.map((command) => command.name), ["laya_compact", "laya_decide", "laya_review", "laya_inventory_route", "laya_supervise"]);
});

test("every /laya command runs through its registered Pi handler", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const questions = request.questions;
    if (questions["item:old"]) {
      return new Response(JSON.stringify({ answers: { "item:old": { type: "choice", choice: "DROP", probabilities: { KEEP: 0.01, DROP: 0.98, TRUNCATE: 0.01 } } } }));
    }
    if (questions.secrets) {
      return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "noul", noul: 0.01 }])) }));
    }
    if (questions.select) {
      const [selected] = Object.keys(questions.select.criteria);
      return new Response(JSON.stringify({ answers: { select: { type: "choice", choice: selected, probabilities: { [selected]: 1 } } } }));
    }
    if (questions.action?.criteria?.click) {
      return new Response(JSON.stringify({ answers: { action: { type: "choice", choice: "click", probabilities: { click: 0.97, wait: 0.03 } } } }));
    }
    return new Response(JSON.stringify({ answers: { action: { type: "choice", choice: "continue", probabilities: { continue: 0.97, retry: 0.01, steer: 0.01, stop: 0.005, human: 0.005 } } } }));
  };
  try {
    const commands = [];
    const messages = [];
    let sessionStart;
    const pi = {
      registerTool: () => {},
      registerCommand: (name, command) => commands.push({ name, command }),
      sendMessage: (message) => messages.push(message),
      on: (event, handler) => { if (event === "session_start") sessionStart = handler; },
    };
    extensionModule.default(pi, { env: { PI_LAYA_BASE_URL: "https://laya.example.com", PI_LAYA_API_TOKEN: "test-token" } });
    sessionStart({}, {
      getCommands: () => [{ name: "test-skill", description: "A test skill", source: "skill" }],
      getAllTools: () => [],
      getActiveTools: () => [],
    });
    const command = Object.fromEntries(commands.map((entry) => [entry.name, entry.command]));
    const directory = await mkdtemp(join(tmpdir(), "pi-laya-slash-"));
    await Promise.all([
      writeFile(join(directory, "decide.json"), JSON.stringify({ placement: "browser", state: { button: "next" }, questions: { action: { type: "choice", instructions: "Choose", criteria: { click: "Click", wait: "Wait" } } }, policy: { threshold: 0.9, margin: 0.2, budget: 1 } })),
      writeFile(join(directory, "review.json"), JSON.stringify({ diff: "diff --git a/a b/a", complete: true, binary: false, policy: { threshold: 0.9, margin: 0.2, budget: 7, maxBytes: 1024 } })),
      writeFile(join(directory, "supervise.json"), JSON.stringify({ summary: "A safe task is progressing", limits: { maxSteps: 5, maxRetries: 2, maxFailures: 2 }, policy: { threshold: 0.9, margin: 0.2, budget: 1 } })),
    ]);
    const context = {
      cwd: directory,
      sessionManager: { buildContextEntries: () => [{ id: "old", type: "message", message: { role: "assistant", content: [{ type: "text", text: "obsolete" }] } }, { id: "goal", type: "message", message: { role: "user", content: [{ type: "text", text: "goal" }] } }, { id: "current", type: "message", message: { role: "assistant", content: [{ type: "text", text: "current" }] } }] },
      ui: { notify: () => {} },
    };
    await command.laya_compact.handler("", context);
    await command.laya_decide.handler("decide.json", context);
    await command.laya_review.handler("review.json", context);
    await command.laya_inventory_route.handler("skill select a relevant skill", context);
    await command.laya_supervise.handler("supervise.json", context);
    assert.deepEqual(messages.map((message) => message.customType), ["laya_compaction_plan", "laya_decision", "laya_review", "laya_inventory_route", "laya_supervision"]);
    assert.match(messages[0].content, /PROPOSED/);
    assert.match(messages[1].content, /\"click\"/);
    assert.match(messages[2].content, /pass_advice/);
    assert.match(messages[3].content, /test-skill/);
    assert.match(messages[4].content, /\"continue\"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    assert.match(messages[0].content, /Laya compaction .* — PROPOSED/);
    assert.match(messages[0].content, /DROP \(1\): item 1 \(old\)/);
    assert.match(messages[0].content, /no Pi session entries were changed/);
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
    assert.match(messages[0].content, /DROP \(1\): assistant 1 \(old\)/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/laya_compact returns a local abstention without transport when every entry is protected", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("transport must not run"); };
  try {
    const commands = [];
    const messages = [];
    extensionModule.default({ registerTool: () => {}, registerCommand: (name, command) => commands.push({ name, command }), sendMessage: (message) => messages.push(message) }, { env: { PI_LAYA_BASE_URL: "https://laya.example.com", PI_LAYA_API_TOKEN: "test-token" } });
    await commands[0].command.handler("", {
      sessionManager: { buildContextEntries: () => [{ id: "goal", type: "message", message: { role: "user", content: [{ type: "text", text: "keep me" }] } }] },
      ui: { notify: () => {} },
    });
    assert.equal(calls, 0);
    assert.match(messages[0].content, /ABSTAINED/);
    assert.match(messages[0].content, /protected_over_budget/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/laya_compact persists plan and outcome metadata and shows it in history", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    answers: { "item:old": { type: "choice", choice: "DROP", probabilities: { KEEP: 0.02, DROP: 0.96, TRUNCATE: 0.02 } } },
  }));
  try {
    const commands = [];
    const messages = [];
    const entries = [];
    const sessionManager = {
      buildContextEntries: () => [
        { id: "old", type: "message", message: { role: "assistant", content: [{ type: "text", text: "obsolete" }] } },
        { id: "goal", type: "message", message: { role: "user", content: [{ type: "text", text: "goal" }] } },
        { id: "current", type: "message", message: { role: "assistant", content: [{ type: "text", text: "current" }] } },
      ],
      getBranch: () => entries,
      appendCustomEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    };
    extensionModule.default({ registerTool: () => {}, registerCommand: (name, command) => commands.push({ name, command }), sendMessage: (message) => messages.push(message) }, { env: { PI_LAYA_BASE_URL: "https://laya.example.com", PI_LAYA_API_TOKEN: "test-token" } });
    const context = { sessionManager, ui: { notify: () => {} } };
    await commands[0].command.handler("", context);
    assert.equal(entries[0].customType, "laya_compaction_plan");
    const planId = entries[0].data.plan.trace.id;
    await commands[0].command.handler(`outcome ${planId.slice(0, 8)} accepted`, context);
    assert.equal(entries[1].customType, "laya_compaction_outcome");
    await commands[0].command.handler("history", context);
    assert.match(messages.at(-1).content, /Outcome: accepted/);
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
