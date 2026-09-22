# pi-laya Design

## Goal

`pi-laya` is a deployment-neutral Pi package that sends typed System-One
decision requests to a user-configured Laya HTTP service. It provides choice,
score, and noul decisions; it never generates prose, invents action arguments,
or directly executes an action selected by a model.

## Privacy and configuration

The package has no default endpoint or credential. It reads `PI_LAYA_BASE_URL`
and `PI_LAYA_API_TOKEN`, with an optional generic secret file at
`~/.pi/agent/secrets/laya_api_token`. Examples use `https://laya.example.com`.
Published files must contain no private deployment identifiers; release checks
scan tracked and packed files without echoing matching values.

## Core interface

`laya_evaluate` submits `{ state, questions }` to `<baseUrl>/v1/system-one`.
It validates the Laya subset locally: 1–20 questions, choice/score/noul only,
bounded JSON, and matching typed responses. HTTP failures are sanitized.

`laya_system_one` is an optional compatibility alias, disabled by default to
avoid collisions with other extensions.

## Seven decision placements

The initial package exposes advisory policies for skill/tool selection, model
profile selection, context retention, browser/computer action candidates,
agent supervision, and code-review risks. Browser/computer/subagent execution
is proposal-only unless a separately tested adapter is registered. All
automation is opt-in, confidence/margin/budget constrained, and deterministic
host code validates actions before execution.

## Safety

No automatic request or host mutation occurs at load time. Laya selections are
not authorization. Low confidence, incomplete evidence, stale state, missing
configuration, transport failure, or unsupported adapters abstain safely.
Context retention keeps protected messages and complete tool-call/result
groups. Review gates cannot pass with partial evidence.
