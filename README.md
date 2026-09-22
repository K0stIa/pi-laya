# pi-laya

`pi-laya` is a deployment-neutral Pi extension for typed System-One decisions.
It sends structured `choice`, `score`, and `noul` requests to a Laya-compatible
service; it does not generate prose, operate browsers or computers, or execute
the selected action.

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

The extension registers `laya_evaluate` and `laya_decide`. The latter covers
browser, computer, context-retention, skill/tool-selection, model-routing,
supervision, and review placements, but returns advisory, non-executable
proposals only. Retention and review abstain unless the caller explicitly marks
the evidence as `profile_checked`; this is a caller assertion, not a model
guarantee. Set
`PI_LAYA_ENABLE_SYSTEM_ONE_ALIAS=true` to additionally register the
compatibility alias `laya_system_one`.

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
