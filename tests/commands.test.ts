// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/index.js";

function setup(env = {}) {
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const tools = ["bash", "read", "laya_evaluate"];
  const pi = {
    registerTool() {},
    registerCommand(name, command) { commands.set(name, command.handler); },
    on(event, handler) { handlers.set(event, handler); },
    getAllTools() { return [{ name: "bash", description: "Run shell commands" }, { name: "read", description: "Read files" }, { name: "laya_evaluate", description: "Evaluate" }]; },
    getActiveTools() { return [...tools]; },
    setActiveTools(names) { tools.splice(0, tools.length, ...names); },
    getCommands() { return [{ source: "skill", name: "shell", description: "Shell troubleshooting" }]; },
  };
  extension(pi, { env, readLocalConfig: () => undefined, readSecret: () => { throw new Error("offline test"); } });
  const ctx = { ui: { notify(message, level) { notifications.push({ message, level }); } } };
  return { run: async (input, context = ctx) => commands.get("laya")(input, context), handlers, tools, notifications, ctx };
}

test("/laya status and help work without credentials", async () => {
  const app = setup();
  await app.run("status");
  assert.match(app.notifications.at(-1).message, /Configured: No/);
  assert.match(app.notifications.at(-1).message, /Requests in session: 0/);
  await app.run("help");
  assert.match(app.notifications.at(-1).message, /auto-agents/);
});

test("/laya enable and disable preserve unrelated active tools", async () => {
  const app = setup();
  await app.run("disable");
  assert.deepEqual(app.tools, ["bash", "read"]);
  await app.run("enable");
  assert.equal(new Set(app.tools).size, app.tools.length);
  assert.ok(app.tools.includes("laya_decide"));
  await app.run("enable");
  assert.equal(new Set(app.tools).size, app.tools.length);
});

test("/laya switches toggle, reject invalid values, and stay inactive unless enabled", async () => {
  const app = setup();
  await app.run("auto");
  await app.run("status");
  assert.match(app.notifications.at(-1).message, /Auto mode: on \(inactive: unconfigured\)/);
  await app.run("auto bogus");
  assert.equal(app.notifications.at(-1).level, "warning");
  await app.run("auto off");
  await app.run("auto-model on");
  await app.run("tool-guard on");
  await app.run("compact on");
  await app.run("auto-agents on");
  await app.run("status");
  assert.match(app.notifications.at(-1).message, /Auto mode: off/);
  assert.match(app.notifications.at(-1).message, /Auto-model: on/);
  assert.match(app.notifications.at(-1).message, /Tool guard: on/);
  assert.match(app.notifications.at(-1).message, /Laya compaction: on/);
  assert.match(app.notifications.at(-1).message, /Agent orchestration: on/);
});

test("/laya skills lists offline matches without pretending to have Laya probabilities", async () => {
  const app = setup();
  await app.run("skills shell");
  assert.match(app.notifications.at(-1).message, /\/skill:shell \(P=0.00\)/);
  assert.match(app.notifications.at(-1).message, /Local keyword shortlist/);
});

test("/laya agents reports missing subagents without dispatching", async () => {
  const app = setup();
  await app.run("agents review the change");
  assert.match(app.notifications.at(-1).message, /pi-subagents unavailable/);
});

test("disabled automatic hooks leave tools unchanged", async () => {
  const app = setup();
  const before = [...app.tools];
  await app.handlers.get("before_agent_start")({ prompt: "review shell commands" }, app.ctx);
  assert.deepEqual(app.tools, before);
  assert.equal(await app.handlers.get("tool_call")({ toolName: "bash", input: { command: "pwd" } }, app.ctx), undefined);
});

test("/laya test uses fixed smoke test and prompt uses active model design", async () => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    const answers = Object.fromEntries(Object.entries(request.questions).map(([name, question]) => [name, question.type === "choice" ? { type: "choice", choice: Object.keys(question.criteria)[0], probabilities: Object.fromEntries(Object.keys(question.criteria).map((key, i) => [key, i ? 0 : 1])) } : { type: "noul", noul: 0.9 }]));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 3, output_tokens: 2 } }));
  };
  try {
    const app = setup({ PI_LAYA_BASE_URL: "https://example.com", PI_LAYA_API_TOKEN: "secret" });
    await app.run("test");
    assert.equal(requests[0].state.message, "Payment processing failed due to credit card expiration.");
    const context = { ...app.ctx, model: { provider: "mock", id: "mock" }, modelRegistry: { complete: async () => ({ content: [{ type: "text", text: JSON.stringify({ state: { task: "classify" }, questions: { yes: { type: "noul", instructions: "Is task clear?" } } }) }] }) } };
    await app.run("eval classify", context);
    assert.deepEqual(Object.keys(requests[1].questions), ["yes"]);
    await app.run("status");
    assert.match(app.notifications.at(-1).message, /Requests in session: 2/);
    assert.match(app.notifications.at(-1).message, /Total tokens used: 10/);
  } finally { globalThis.fetch = original; }
});
