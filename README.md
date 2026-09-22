# pi-laya

`pi-laya` is a deployment-neutral Pi extension for typed System-One decisions.
It sends structured `choice`, `score`, and `noul` requests to a Laya-compatible
service; it does not generate prose, operate browsers or computers, or execute
the selected action.

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
