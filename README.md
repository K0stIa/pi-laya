# pi-laya

`pi-laya` is a Pi extension for typed System-One decisions. It sends structured
`choice`, `score`, and `noul` requests to a Laya-compatible service.
Decision tools return advice, not actions. Optional `/laya` session controls
can activate tools, select a Pi model, summarize context, or dispatch agents.

## Decision-layer approach

This extension follows the small, typed-decision pattern outlined in
[the Jev skills overview](https://x.com/k2sbhai/status/2101657436696547773):
**state → Laya decision → host-owned action**. `pi-laya` implements the Pi-side
adapters for context retention, installed skill/tool and model selection,
agent supervision, and staged diff-review routing. It also exposes generic
browser and computer decision placements through `laya_decide`. These
adapters return advice. Optional `/laya` modes perform separate Pi session
actions. No browser or desktop driver is included.

### Capability coverage

| Post capability | `pi-laya` status |
| --- | --- |
| Browser agent | Generic `laya_decide` placement for next-action decisions. No browser driver or automation. |
| Context compaction | `/laya_compact` provides reversible plans and history. Opt-in `/laya compact on` supplies a Laya-guided summary to Pi's `/compact` when inputs fit its limits. |
| Skill selection | `laya_inventory_route` returns advice. `/laya skills` ranks installed skills. Opt-in `/laya auto` suggests matching skills. |
| Tool routing | `laya_inventory_route` returns advice. `/laya enable` activates Laya tools. Opt-in `/laya auto` can activate other matching Pi tools. |
| Model routing | `laya_inventory_route` returns advice. Opt-in `/laya auto-model` can switch among compatible Pi models using local heuristics, not Laya scores. |
| Computer use | Generic `laya_decide` placement. No desktop, OCR, or action driver. |
| Agent supervision | `laya_supervise` returns bounded `continue`/`retry`/`steer`/`stop`/`human` advice. `/laya agents` dispatches work through pi-subagents when installed. |
| Code review | `laya_review` runs staged diff-risk checks and routes risky or uncertain changes to human review. |
| Tool guard | Opt-in `/laya tool-guard on` checks call arguments and adds guidance for some tool errors. It is not a security boundary. |

## Install

Build the local checkout, then install that directory into Pi:

```sh
npm install
npm run build
pi install ./local/path/to/pi-laya
```

## Configuration

Set both values before invoking the tool:

```sh
export PI_LAYA_BASE_URL=https://laya.example.com
export PI_LAYA_API_TOKEN=your-token
```

Alternatively, store the endpoint in `~/.pi/agent/laya.json`:

```json
{ "baseUrl": "https://laya.example.com" }
```

Store the token in `~/.pi/agent/secrets/laya_api_token` as plain text if you
do not set `PI_LAYA_API_TOKEN`. Keep both files outside the repository. There
is no default endpoint or token.

For an intentionally unencrypted private-network endpoint, set
`"allowInsecureHttp": true` in `laya.json` or set
`PI_LAYA_ALLOW_INSECURE_HTTP=true`. HTTPS is required for other remote
endpoints. Loopback HTTP does not require this option.

The extension registers `laya_evaluate` and `laya_decide`. The latter covers
browser, computer, context-retention, skill/tool-selection, model-routing,
supervision, and review placements, but returns advisory, non-executable
proposals only. Retention and review abstain unless the caller explicitly marks
the evidence as `profile_checked`. This is a caller assertion, not a model
guarantee. Set
`PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS=true` to additionally register the
compatibility alias `laya_system_one`.

Additional advisory adapters are explicit tools: `laya_compact` produces a
reversible context plan and preserves protected/pair items. `laya_inventory_route`
reads the active Pi session's available skills, tools, and models.
`laya_supervise` returns bounded `continue`/`retry`/`steer`/`stop`/`human`
advice. `laya_review` performs staged diff risk checks. They return plans and traces
only—none changes Pi context, enables a skill, switches a model, blocks a tool,
retries an agent, or approves a change. Traces retain digests and decision
summaries rather than raw context, diffs, prompts, or credentials.

### Slash command: context-compaction plan

`/laya_compact` invokes the compaction adapter from Pi's slash menu and builds a
bounded snapshot from Pi's active, compaction-aware context. User messages,
existing compaction summaries, custom messages, and the two newest entries are
protected. If it has more than 20 removable entries, it refuses rather than
silently grouping or omitting context.

`/laya_compact <snapshot.json>` remains available for an explicitly grouped or
curated snapshot. The file must contain `items` and `policy` matching the
`laya_compact` tool input, for example:

```json
{
  "items": [
    { "id": "goal", "text": "Current task and constraints", "tokenEstimate": 120, "protected": true },
    { "id": "old-output", "text": "Superseded command output", "tokenEstimate": 900 }
  ],
  "policy": {
    "coverage": "profile_checked",
    "targetTokens": 500,
    "truncateTokenLimit": 200,
    "threshold": 0.9,
    "margin": 0.2,
    "budget": 1
  }
}
```

The command displays a reversible plan. It never applies `DROP` or `TRUNCATE`
to Pi's session automatically. Use `/laya_compact --help` for the in-Pi usage
reminder.

Each plan is stored in the current Pi session as privacy-preserving metadata:
entry labels, token estimates, plan IDs, decisions, policy, and digest-based
traces—never raw context text. Use `/laya_compact history` to display all
recorded plans and outcomes. After reviewing a plan, record what happened with
`/laya_compact outcome <plan-id> accepted|rejected|succeeded|failed`.

### `/laya` session controls

`/laya status` shows configuration source, endpoint, request/token counts, mode
switches, and tool counts. `/laya help` lists subcommands.

| Command | Effect |
| --- | --- |
| `/laya skills [query]` | List workspace skills or rank matches with Laya. Offline fallback uses keyword matches, marked as such. |
| `/laya test [prompt]` | Run fixed connectivity test. With prompt, active Pi model designs typed questions, then Laya evaluates them. Aliases: `eval`, `evaluate`. |
| `/laya enable` / `/laya disable` | Activate or deactivate Laya tools for current session. |
| `/laya auto [on\|off]` | Toggle per-prompt Laya tool activation and skill suggestions. |
| `/laya auto-model [on\|off]` | Toggle heuristic selection among Pi's available, compatible models. |
| `/laya tool-guard [on\|off]` | Toggle Laya call checks and failure guidance. On Laya errors, checks fail open. |
| `/laya compact [on\|off]` | Toggle Laya-guided `/compact`. Falls back to Pi compaction if branch is too large, no active summarizer exists, or evaluation fails. |
| `/laya agents <task>` | Explicitly dispatch via pi-subagents RPC when installed. |
| `/laya auto-agents [on\|off]` | Toggle prompt-based agent orchestration for complex tasks. |

Run `/laya status` to inspect this session. Run `/laya test` to check the Laya
connection. With a prompt, Pi asks its active model for schema-constrained
question data where supported. Pi validates every question and retries once
with the validation error. If both designs fail, Pi reports an error and does
not send an invalid request to Minis. Run `/laya enable` to activate registered
Laya tools.

Switches without `on` or `off` flip their current state. All automatic modes
start disabled unless their matching environment variable is set:
`PI_LAYA_AUTO`, `PI_LAYA_AUTO_MODEL`, `PI_LAYA_TOOL_GUARD`,
`PI_LAYA_COMPACT`, or `PI_LAYA_AGENTS`. Use `1`, `true`, `yes`, or `on`.
Explicit `/laya agents <task>` works without `/laya auto-agents on`, but
needs pi-subagents installed. `/laya auto-model` uses Pi model metadata,
not a Laya request. `/laya compact on` applies only to `/compact`.
It does not apply the plans from `/laya_compact`.

### Slash commands for advisory adapters

These commands make the adapters available directly from Pi's slash menu.
Restart Pi or run `/reload` after you install or update the extension.

| Command | What it does | How to use it |
| --- | --- | --- |
| `/laya_compact` | Builds an active-context compaction plan. It protects user messages, existing summaries, custom messages, and the two newest entries. | Run `/laya_compact`. Review the displayed `KEEP`, `DROP`, and `TRUNCATE` plan. It does not modify session context. |
| `/laya_compact <snapshot.json>` | Plans compaction for a curated or grouped snapshot. | Supply a JSON payload matching the `laya_compact` tool input. Use this when active context has more than 20 removable items. |
| `/laya_compact history` | Shows recorded compaction plans and their outcomes for the current Pi session. | Run it after one or more plans. Metadata is stored without raw context text. |
| `/laya_compact outcome <plan-id> <status>` | Records what happened after reviewing a plan. | Copy the short ID from the plan heading and choose `accepted`, `rejected`, `succeeded`, or `failed`. |
| `/laya_inventory_route <skill\|tool\|model> <task>` | Ranks one currently installed skill, active tool, or available model for a task. | Example: `/laya_inventory_route model review a complex multi-file change`. The result does not enable a skill or switch models. |
| `/laya_decide <request.json>` | Evaluates typed `choice`, `score`, or `noul` questions for any supported placement, including browser and computer decisions. | Supply a JSON request matching `laya_decide`. Inspect the probability-gated proposal before you take action. |
| `/laya_review <request.json>` | Performs staged diff-risk checks. | Supply `{ diff, complete, binary, policy }`. Complete textual diffs can receive pass advice. Other diffs route to human review. |
| `/laya_supervise <request.json>` | Provides bounded advice for an agent’s next supervision action. | Supply `{ summary, state?, limits, policy }`. Persist the returned state and enforce the budgets in your workflow. |

The JSON-file commands accept the same payload as their corresponding tools.
These JSON-file adapter results remain advisory. Unlike `/laya` session controls,
they do not change context, switch models, dispatch agents, retry work, or
approve a change.

## Tool payloads

`laya_evaluate` accepts a structured state and one or more typed questions:

```json
{
  "state": { "page": "checkout", "cartTotal": 49 },
  "questions": {
    "continue": {
      "type": "choice",
      "instructions": "Choose the safest next step.",
      "criteria": { "continue": "Continue checkout", "wait": "Wait for review" }
    }
  }
}
```

`laya_decide` accepts the same state and questions plus a placement, with
optional coverage and proposal policy. Its result remains advisory and
non-executable:

```json
{
  "placement": "browser",
  "coverage": "profile_checked",
  "policy": { "threshold": 0.9, "margin": 0.1, "budget": 1 },
  "state": { "button": "next" },
  "questions": {
    "action": {
      "type": "choice",
      "instructions": "Choose the next browser action.",
      "criteria": { "click": "Click next", "wait": "Wait" }
    }
  }
}
```

## Safety boundaries

- Requests have 1–20 named questions, are limited to 64 KiB, and have a
  maximum JSON depth of 16.
- Requests and responses are validated locally before use.
- Score questions require an ordered, non-empty string `criteria` array. Score
  answers are constrained to its ordinal bounds and preserve a matching
  `legend` and normalized `probabilities` array when the service provides them.
- Choice answers require probabilities for exactly the submitted options.
  Choice and score sums allow at most four-decimal rounding error per option.
  Noul questions can describe explicit `true` and `false` criteria.
- Transport errors are sanitized and never include response bodies or tokens.
- `proposeSelection` provides only a pure confidence/margin/budget policy for
  advisory decisions. It has no drivers or action execution.

## Development

```sh
npm install
npm test
npm run typecheck
npm run privacy:check
```

## CI and releases

GitHub Actions runs the build, tests, typecheck, privacy check, and package
contents check for pull requests and pushes to `main`, using Node 22.

Pushing an annotated tag matching the package version, such as `v0.2.0`, runs
the same verification and creates a GitHub Release with the packed `.tgz`
artifact and generated release notes. The package is intentionally private, so
the release workflow does not publish to npm or require an npm token.
