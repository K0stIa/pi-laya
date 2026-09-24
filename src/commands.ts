import type { PiLike } from "./index.js";
import type { ResolveConfigOptions } from "./config.js";
import { resolveConfig } from "./config.js";
import { snapshotInventory } from "./inventory.js";
import { designEvaluation } from "./designer.js";
import type { LayaResult, LayaRequest, LayaQuestion } from "./protocol.js";

const threshold = 0.65;
const layaTools = ["laya_evaluate", "laya_compact", "laya_review", "laya_inventory_route", "laya_supervise", "laya_decide"];
const isLaya = (name: string) => name.startsWith("laya_");

type Context = { ui: { notify(message: string, level?: "info" | "warning" | "error"): void; setStatus?(key: string, status: string): void }; signal?: AbortSignal; model?: Model; modelRegistry?: { getAvailable(): Model[]; hasConfiguredAuth?: (model: Model) => boolean; complete?: (model: Model, input: unknown, options: unknown) => Promise<{ content: { type: string; text?: string }[]; stopReason?: string }> }; scopedModels?: { model: Model }[]; getSystemPrompt?: () => string };
type Model = { provider: string; id: string; reasoning?: boolean; contextWindow?: number; input?: string[]; cost?: { input?: number } };
type EventBus = { on(name: string, handler: (event: unknown) => void): () => void; emit(name: string, payload: unknown): void };
type CommandPi = PiLike & { getActiveTools?: () => string[]; getAllTools?: () => { name: string; description?: string }[]; getCommands?: () => { name: string; description?: string; source?: string }[]; setActiveTools?: (names: string[]) => void; setModel?: (model: Model) => Promise<void>; events?: EventBus };
type Evaluation = (request: LayaRequest, signal?: AbortSignal) => Promise<LayaResult>;

function toggle(input: string, current: boolean): boolean | undefined {
  if (!input) return !current;
  if (input === "on") return true;
  if (input === "off") return false;
  return undefined;
}
function shortlist<T extends { name: string; description: string }>(items: T[], prompt: string, max: number): T[] {
  const terms = prompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return items.map((item) => ({ item, score: terms.filter((term) => `${item.name} ${item.description}`.toLowerCase().includes(term)).length }))
    .sort((a, b) => b.score - a.score).slice(0, max).map(({ item }) => item);
}
function skills(pi: CommandPi, ctx: unknown) {
  const snapshot = snapshotInventory(pi, ctx);
  return snapshot.skills.map((skill) => ({ name: skill.id.startsWith("skill:") ? skill.id.slice(6) : skill.id, description: skill.description }));
}
function probability(answer: LayaResult["answers"][string] | undefined): number {
  return answer?.type === "noul" ? answer.noul : 0;
}
function configured(options: ResolveConfigOptions): boolean {
  const config = resolveConfig(options);
  return Boolean(config.baseUrl && config.apiToken);
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export function registerLayaCommands(pi: CommandPi, options: ResolveConfigOptions, evaluate: Evaluation, stats: { requests: number; tokens: number; lastError: string }): void {
  const env = options.env ?? process.env;
  const initial = (name: string) => ["1", "true", "yes", "on"].includes(env[name]?.toLowerCase() ?? "");
  const state = { auto: initial("PI_LAYA_AUTO"), autoModel: initial("PI_LAYA_AUTO_MODEL"), guard: initial("PI_LAYA_TOOL_GUARD"), compact: initial("PI_LAYA_COMPACT"), agents: initial("PI_LAYA_AGENTS") };
  const ask = evaluate;
  const listSkills = (ctx: unknown) => skills(pi, ctx);
  const findSkills = async (prompt: string, ctx: Context) => {
    // Bound ONNX CPU work: each candidate is an independent inference question.
    const candidates = shortlist(listSkills(ctx), prompt, 4);
    if (!candidates.length) return { matches: [] as { name: string; description: string; probability: number }[], fallback: false };
    if (configured(options)) {
      try {
        const questions = Object.fromEntries(candidates.map((item, i) => [`skill_${i}`, { type: "noul", instructions: `Does skill '${item.name}' (${item.description}) directly help task: ${prompt}?` }])) satisfies Record<string, LayaQuestion>;
        const result = await ask({ state: { task: prompt, candidates }, questions }, ctx.signal);
        return { matches: candidates.map((item, i) => ({ ...item, probability: probability(result.answers[`skill_${i}`]) })).filter((item) => item.probability >= threshold).sort((a, b) => b.probability - a.probability), fallback: false };
      } catch { /* local shortlist when offline */ }
    }
    const terms = prompt.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return { matches: candidates.filter((item) => terms.some((term) => `${item.name} ${item.description}`.toLowerCase().includes(term))).map((item) => ({ ...item, probability: 0 })), fallback: true };
  };
  const dispatch = async (task: string, ctx: Context) => {
    if (!pi.events) { ctx.ui.notify("pi-subagents unavailable.", "warning"); return; }
    const requestId = crypto.randomUUID();
    let topology = /\b(review|audit|security|verify)\b/i.test(task) ? "review" : /\b(research|investigate|explore|architecture)\b/i.test(task) ? "research" : "implementation";
    if (configured(options)) {
      try {
        const result = await ask({ state: { task }, questions: { topology: { type: "choice", instructions: "Choose workflow best suited to task.", criteria: { implementation: "Code change or bug fix", research: "Investigation or exploration", review: "Code review or audit" } } } }, ctx.signal);
        const answer = result.answers.topology;
        if (answer?.type === "choice" && (answer.probabilities[answer.choice] ?? 0) >= threshold && ["implementation", "research", "review"].includes(answer.choice)) topology = answer.choice;
      } catch { /* fall back to task classification */ }
    }
    const taskJson = JSON.stringify(task);
    const script = topology === "review"
      ? `const [review, audit] = await runs.all([{key:"review",agent:"reviewer",task:${taskJson}},{key:"audit",agent:"evidence-auditor",task:${taskJson}}]); return {review:review.output,audit:audit.output};`
      : topology === "research"
        ? `const scout = await runs.run("scout",{agent:"scout",task:${taskJson}}); return scout.output;`
        : `const scout = await runs.run("scout",{agent:"scout",task:${taskJson}}); const worker = await runs.run("worker",{agent:"worker",task:${taskJson}+"\nScout: "+scout.output}); const review = await runs.run("review",{agent:"reviewer",task:${taskJson}+"\nWork: "+worker.output}); return {worker:worker.output,review:review.output};`;
    const response = await new Promise<unknown>((resolve) => {
      const unsubscribe = pi.events!.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => { clearTimeout(timer); unsubscribe(); resolve(reply); });
      const timer = setTimeout(() => { unsubscribe(); resolve({ success: false, error: { message: "pi-subagents RPC timeout" } }); }, 10_000);
      pi.events!.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "spawn", source: { extension: "pi-laya" }, params: { async: true, workflowScript: script } });
    });
    const reply = response && typeof response === "object" ? response as { success?: boolean; error?: { message?: string }; data?: { runId?: string } } : {};
    ctx.ui.notify(reply.success ? `Agent orchestration started (${topology})${reply.data?.runId ? ` [${reply.data.runId}]` : ""}.` : `Agent orchestration unavailable: ${reply.error?.message ?? "unknown error"}`, reply.success ? "info" : "warning");
  };
  pi.registerCommand?.("laya", {
    description: "Laya status, skills, test, routing, guard, compaction, and agents",
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as Context;
      const [sub = "status", ...parts] = args.trim().split(/\s+/).filter(Boolean);
      const rest = parts.join(" ");
      const usage = "Usage: /laya status|help|skills [query]|test [prompt]|enable|disable|auto [on|off]|auto-model [on|off]|tool-guard [on|off]|compact [on|off]|agents <task>|auto-agents [on|off]";
      if (sub === "help") { ctx.ui.notify(usage); return; }
      if (sub === "status") {
        const config = resolveConfig(options);
        const origin = env.PI_LAYA_API_TOKEN?.trim() ? "PI_LAYA_API_TOKEN" : config.apiToken ? "~/.pi/agent/secrets/laya_api_token" : "none";
        const active = pi.getActiveTools?.() ?? [];
        const all = pi.getAllTools?.() ?? [];
        ctx.ui.notify(`Laya Status:\n• Configured: ${configured(options) ? "Yes" : "No"} (token: ${origin})\n• Endpoint: ${config.baseUrl ?? "none"}\n• Requests in session: ${stats.requests}\n• Total tokens used: ${stats.tokens}\n• Auto mode: ${state.auto ? "on" : "off"}${state.auto && !configured(options) ? " (inactive: unconfigured)" : ""}\n• Auto-model: ${state.autoModel ? "on" : "off"}\n• Tool guard: ${state.guard ? "on" : "off"}\n• Laya compaction: ${state.compact ? "on" : "off"}\n• Agent orchestration: ${state.agents ? "on" : "off"}\n• Active tools: ${active.length} / Available: ${all.length} (${all.filter((tool) => !active.includes(tool.name) && !isLaya(tool.name)).length} routable)${stats.lastError ? `\n• Last error: ${stats.lastError}` : ""}`); return;
      }
      if (sub === "enable" || sub === "disable") {
        if (!pi.getActiveTools || !pi.setActiveTools) { ctx.ui.notify("Pi tool activation unavailable.", "warning"); return; }
        const active = pi.getActiveTools();
        pi.setActiveTools(sub === "enable" ? [...new Set([...active, ...layaTools])] : active.filter((name) => !isLaya(name)));
        ctx.ui.notify(`Laya tools ${sub === "enable" ? "enabled" : "disabled"} for this session.`); return;
      }
      const switches = { auto: "auto", "auto-model": "autoModel", "tool-guard": "guard", compact: "compact", "auto-agents": "agents" } as const;
      if (sub in switches) {
        const key = switches[sub as keyof typeof switches];
        const next = toggle(rest.toLowerCase(), state[key]);
        if (next === undefined) { ctx.ui.notify(`Invalid /laya ${sub} argument. ${usage}`, "warning"); return; }
        state[key] = next;
        ctx.ui.notify(`Laya ${sub} ${next ? "enabled" : "disabled"}.${key === "compact" && next ? " Run /compact to use it." : ""}`); return;
      }
      if (sub === "skills" || sub === "skill") {
        if (!rest) { const available = listSkills(ctx); ctx.ui.notify(`Available skills (${available.length}):\n${available.map((skill) => `• ${skill.name}: ${skill.description}`).join("\n")}`); return; }
        const result = await findSkills(rest, ctx);
        ctx.ui.notify(result.matches.length ? `Matching skills for "${rest}":\n${result.matches.map((skill) => `• /skill:${skill.name} (P=${skill.probability.toFixed(2)}) - ${skill.description}`).join("\n")}${result.fallback ? "\n(Local keyword shortlist; probabilities are not Laya judgments)" : ""}` : `No skills matched "${rest}".`, result.fallback ? "warning" : "info"); return;
      }
      if (sub === "agents" || sub === "orchestrate") { if (!rest) { ctx.ui.notify("Usage: /laya agents <task>", "warning"); return; } await dispatch(rest, ctx); return; }
      if (sub === "test" || sub === "eval" || sub === "evaluate") {
        if (!configured(options)) { ctx.ui.notify("Laya unconfigured. Set PI_LAYA_BASE_URL and PI_LAYA_API_TOKEN (or secrets/laya_api_token).", "error"); return; }
        const smoke: LayaRequest = { state: { message: "Payment processing failed due to credit card expiration." }, questions: { is_billing: { type: "noul", instructions: "Is this message related to billing?" }, category: { type: "choice", instructions: "Which category applies?", criteria: { billing: "Billing or card issues", bug: "Software bug", other: "General questions" } } } };
        try {
          let request = smoke;
          if (rest) request = await designEvaluation(ctx, rest);
          const result = await ask(request, ctx.signal); ctx.ui.notify(`Laya ${rest ? "Evaluation" : "Test Successful"}:\n${Object.entries(result.answers).map(([name, answer]) => `• ${name}: ${answer.type === "choice" ? `${answer.choice} (P=${answer.probabilities[answer.choice]?.toFixed(2) ?? "?"})` : answer.type === "noul" ? answer.noul : answer.score}`).join("\n")}`); }
        catch (error) { ctx.ui.notify(`Laya Evaluation Failed: ${errorText(error)}`, "error"); } return;
      }
      ctx.ui.notify(`Unknown command /laya ${sub}. ${usage}`, "warning");
    },
  });

  pi.on?.("before_agent_start", async (event, rawCtx) => {
    const ctx = rawCtx as Context;
    const input = event as { prompt?: string; images?: unknown[]; urls?: unknown[] };
    const prompt = input.prompt?.trim() ?? "";
    if (!prompt || prompt.startsWith("/")) return;
    if (state.agents && /\b(architecture|refactor|security review|entire repo|parallel|multiple agents|complex migration)\b/i.test(prompt)) await dispatch(prompt, ctx);
    if (state.autoModel && pi.setModel && ctx.modelRegistry) {
      try {
        const models = ctx.scopedModels?.length ? ctx.scopedModels.map((item) => item.model) : ctx.modelRegistry.getAvailable();
        const needsVision = Boolean(input.images?.length);
        const needsUrl = Boolean(input.urls?.length);
        const needsReasoning = /\b(plan|architect|debug|review|security|complex|refactor)\b/i.test(prompt);
        const long = (ctx.getSystemPrompt?.().length ?? 0) > 120_000 || /\b(entire repo|large diff|many files|migration)\b/i.test(prompt);
        const fast = /^(hi|hello|list|rename|format|small|simple|quick)\b/i.test(prompt) && prompt.length < 240;
        if (needsVision || needsUrl || needsReasoning || long || fast) {
          const compatible = models.filter((model) => (!needsVision || model.input?.includes("image")) && (!needsUrl || model.input?.includes("url")));
          const score = (model: Model) => long ? (model.contextWindow ?? 0) : needsVision || needsUrl ? (model.reasoning ? 1 : 0) : needsReasoning ? (model.reasoning ? 10 : 0) + (model.contextWindow ?? 0) / 100_000 : (model.reasoning ? 0 : 10) - (model.cost?.input ?? 0);
          const target = compatible.sort((a, b) => score(b) - score(a))[0];
          if (target && (target.provider !== ctx.model?.provider || target.id !== ctx.model?.id)) await pi.setModel(target);
        }
      } catch { /* model routing never breaks prompt */ }
    }
    if (!state.auto || !configured(options) || !pi.getActiveTools || !pi.getAllTools || !pi.setActiveTools) return;
    try {
      const active = pi.getActiveTools();
      // One CPU inference per candidate: bound automatic routing to four
      // short descriptions so Minis can answer before its request deadline.
      const candidates = shortlist(pi.getAllTools().filter((tool) => !isLaya(tool.name) && !active.includes(tool.name)).map((tool) => ({ name: tool.name, description: (tool.description ?? "").slice(0, 180) })), prompt, 2);
      const skillCandidates = shortlist(listSkills(ctx), prompt, 2).map((skill) => ({ ...skill, description: skill.description.slice(0, 180) }));
      const combined = [...candidates.map((item) => ({ ...item, kind: "tool" })), ...skillCandidates.map((item) => ({ ...item, kind: "skill" }))];
      if (!combined.length) return;
      const questions = Object.fromEntries(combined.map((item, i) => [`match_${i}`, { type: "noul", instructions: `Does ${item.kind} '${item.name}' (${item.description}) directly help task: ${prompt}?` }])) satisfies Record<string, LayaQuestion>;
      const result = await ask({ state: { task: prompt, candidates: combined }, questions }, ctx.signal);
      const matched = combined.filter((_, i) => probability(result.answers[`match_${i}`]) >= threshold);
      const activated = matched.filter((item) => item.kind === "tool").map((item) => item.name);
      if (activated.length) pi.setActiveTools([...new Set([...active, ...activated])]);
      const suggested = matched.filter((item) => item.kind === "skill");
      if (suggested.length) return { message: { customType: "laya-auto", display: true, content: `Laya matched skills. Load SKILL.md before proceeding:\n${suggested.map((item) => `• /skill:${item.name}`).join("\n")}` } };
    } catch { /* offline routing must not break prompt */ }
  });
  pi.on?.("tool_call", async (event, rawCtx) => {
    if (!state.guard || !configured(options)) return;
    const input = event as { toolName?: string; input?: unknown };
    if (!input.toolName || isLaya(input.toolName)) return;
    try {
      const result = await ask({ state: { tool: input.toolName, parameters: JSON.stringify(input.input ?? null).slice(0, 3000) }, questions: { hallucinated: { type: "noul", instructions: `Are parameters for tool '${input.toolName}' fabricated or nonsensical?` } } }, (rawCtx as Context).signal);
      const p = probability(result.answers.hallucinated);
      if (p >= 0.85) return { block: true, reason: `Laya tool-guard flagged hallucinated parameters for ${input.toolName} (P=${p.toFixed(2)}). Check arguments against workspace.` };
    } catch { /* fail open */ }
  });
  pi.on?.("tool_result", async (event, rawCtx) => {
    if (!state.guard || !configured(options)) return;
    const input = event as { toolName?: string; input?: unknown; isError?: boolean; content?: { type: string; text?: string }[] };
    if (!input.isError || !input.toolName || isLaya(input.toolName)) return;
    try {
      const result = await ask({ state: { tool: input.toolName, input: JSON.stringify(input.input ?? null).slice(0, 3000), error: JSON.stringify(input.content ?? []).slice(0, 3000) }, questions: { cause: { type: "choice", instructions: "What is likely cause of tool failure?", criteria: { missing_file: "Path does not exist", syntax_flag: "Invalid syntax or flag", permission_env: "Permission or environment", runtime_other: "Runtime logic failure" } } } }, (rawCtx as Context).signal);
      const answer = result.answers.cause;
      if (answer?.type !== "choice" || (answer.probabilities[answer.choice] ?? 0) < 0.85) return;
      const guidance = answer.choice === "missing_file" ? "Check actual workspace paths before retrying." : answer.choice === "syntax_flag" ? "Check command and tool specification before retrying." : "";
      if (guidance) return { content: [...(input.content ?? []), { type: "text", text: `[Laya tool-guard guidance] ${guidance}` }] };
    } catch { /* original error unchanged */ }
  });
  // Only override compaction with a complete branch and an active summarizer.
  // Otherwise leave Pi native compaction untouched. /laya_compact stays advisory.
  pi.on?.("session_before_compact", async (event, rawCtx) => {
    if (!state.compact || !configured(options)) return;
    const input = event as { branchEntries?: unknown[]; preparation?: { firstKeptEntryId?: string; tokensBefore?: number }; customInstructions?: string };
    const ctx = rawCtx as Context;
    if (!input.branchEntries?.length || input.branchEntries.length > 20 || !ctx.model || !ctx.modelRegistry?.complete) return;
    const full = JSON.stringify(input.branchEntries);
    if (full.length > 60_000) return;
    const entries = input.branchEntries.map((entry) => JSON.stringify(entry).slice(0, 500));
    const candidates = entries.map((text, index) => ({ index, text })).filter((item) => /tool|assistant/i.test(item.text));
    if (!candidates.length) return;
    try {
      const questions = Object.fromEntries(candidates.map((item) => [`keep_${item.index}`, { type: "noul", instructions: `Does this historical tool/assistant entry contain facts needed for ongoing task? ${item.text}` }])) satisfies Record<string, LayaQuestion>;
      const result = await ask({ state: { entries: candidates }, questions }, (rawCtx as Context).signal);
      const kept = candidates.filter((item) => probability(result.answers[`keep_${item.index}`]) >= 0.55);
      if (!kept.length) return;
      const response = await ctx.modelRegistry.complete(ctx.model as Model, { systemPrompt: "Summarize complete conversation for continuation. Preserve user goals, decisions, constraints, file paths, errors, and outstanding tasks. Do not invent facts. Return plain text.", messages: [{ role: "user", content: [{ type: "text", text: `Instructions: ${input.customInstructions ?? "Continue task"}\nKeep entries: ${kept.map((item) => item.index).join(", ")}\nBranch: ${full}` }], timestamp: Date.now() }] }, { signal: ctx.signal, cacheRetention: "none" });
      if (response.stopReason === "error") return;
      const summary = response.content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim();
      if (!summary || !input.preparation?.firstKeptEntryId || typeof input.preparation.tokensBefore !== "number") return;
      return { compaction: { summary, firstKeptEntryId: input.preparation.firstKeptEntryId, tokensBefore: input.preparation.tokensBefore } };
    } catch { /* Pi default compaction */ }
  });
}
