# pi-laya

`pi-laya` is a deployment-neutral Pi extension for typed System-One decisions.
It sends structured `choice`, `score`, and `noul` requests to a Laya-compatible
service; it does not generate prose, operate browsers or computers, or execute
the selected action.

## Decision-layer approach

This extension follows the small, typed-decision pattern outlined in
[the Jev skills overview](https://x.com/k2sbhai/status/2101657436696547773):
**state → Laya decision → host-owned action**. `pi-laya` implements the Pi-side
adapters for context retention, installed skill/tool and model selection,
agent supervision, and staged diff-review routing. It also exposes generic
browser and computer decision placements through `laya_decide`. Every result
is probability- and policy-gated advice; Pi or the calling workflow remains
responsible for executing, rejecting, or escalating it.

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

For a persistent local endpoint, write this deployment-specific file outside
the package repository:

```json
// ~/.pi/agent/laya.json
{ "baseUrl": "https://laya.example.com" }
```

If the endpoint is an intentionally unencrypted private-network service, set
`"allowInsecureHttp": true` in that same local file (or set
`PI_LAYA_ALLOW_INSECURE_HTTP=true`). HTTPS is otherwise required except for
loopback endpoints. If `PI_LAYA_API_TOKEN` is absent, the extension reads the token from
`~/.pi/agent/secrets/laya_api_token`. There is no default endpoint or token.

For example, keep the endpoint and token in local Pi files rather than in the
extension checkout:

```json
// ~/.pi/agent/laya.json
{ "baseUrl": "https://laya.example.com" }
```

```sh
# ~/.pi/agent/secrets/laya_api_token
your-token
```

The extension registers `laya_evaluate` and `laya_decide`. The latter covers
browser, computer, context-retention, skill/tool-selection, model-routing,
supervision, and review placements, but returns advisory, non-executable
proposals only. Retention and review abstain unless the caller explicitly marks
the evidence as `profile_checked`; this is a caller assertion, not a model
guarantee. Set
`PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS=true` to additionally register the
compatibility alias `laya_system_one`.

Additional advisory adapters are explicit tools: `laya_compact` produces a
reversible context plan and preserves protected/pair items; `laya_inventory_route`
reads the active Pi session's available skills, tools, and models; `laya_supervise`
returns bounded `continue`/`retry`/`steer`/`stop`/`human` advice; and
`laya_review` performs staged diff risk checks. They return plans and traces
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

The command displays a reversible plan; it never applies `DROP` or `TRUNCATE`
to Pi's session automatically. Use `/laya_compact --help` for the in-Pi usage
reminder.

Each plan is stored in the current Pi session as privacy-preserving metadata:
entry labels, token estimates, plan IDs, decisions, policy, and digest-based
traces—never raw context text. Use `/laya_compact history` to display all
recorded plans and outcomes. After reviewing a plan, record what happened with
`/laya_compact outcome <plan-id> accepted|rejected|succeeded|failed`.

### Slash commands for advisory adapters

All Pi-facing adapters can be invoked without asking the main agent to choose a
tool:

```text
/laya_compact [snapshot.json]
/laya_compact history
/laya_compact outcome <plan-id> <accepted|rejected|succeeded|failed>
/laya_inventory_route <skill|tool|model> <task>
/laya_decide <request.json>
/laya_review <request.json>
/laya_supervise <request.json>
```

The JSON-file commands accept the same payload as their corresponding tool.
They display advisory results only; none changes context, changes a model,
executes an action, or controls an agent.

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
- Choice answers require normalized probabilities for exactly the submitted
  options. Noul questions may optionally describe explicit `true` and `false`
  criteria.
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
