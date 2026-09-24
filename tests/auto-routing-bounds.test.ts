import assert from "node:assert/strict";
import test from "node:test";
import extension from "../src/index.js";

test("automatic routing stays within Minis CPU question budget", async () => {
  const originalFetch = globalThis.fetch;
  let request: { questions: Record<string, { instructions: string }>; state: { candidates: Array<{ description: string }> } } | undefined;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(request!.questions).map((key) => [key, { type: "noul", noul: 0.1 }])) }));
  };
  try {
    let hook: ((event: unknown, ctx: unknown) => unknown) | undefined;
    const active = ["read"];
    const pi = {
      registerTool() {}, registerCommand() {},
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { if (event === "before_agent_start") hook = handler; },
      getActiveTools: () => active,
      getAllTools: () => ["read", "tool_a", "tool_b", "tool_c"].map((name) => ({ name, description: "description ".repeat(100) })),
      getCommands: () => ["skill:a", "skill:b", "skill:c"].map((name) => ({ name, source: "skill", description: "skill description ".repeat(100) })),
      setActiveTools(names: string[]) { active.splice(0, active.length, ...names); },
    };
    extension(pi, { env: { PI_LAYA_AUTO: "on", PI_LAYA_BASE_URL: "https://laya.example.com", PI_LAYA_API_TOKEN: "test-token" } });
    assert.ok(hook);
    await hook({ prompt: "Review code." }, {});
    assert.ok(request);
    assert.equal(Object.keys(request.questions).length, 4);
    assert.ok(request.state.candidates.every((candidate) => candidate.description.length <= 180));
    assert.deepEqual(active, ["read"]);
  } finally { globalThis.fetch = originalFetch; }
});
