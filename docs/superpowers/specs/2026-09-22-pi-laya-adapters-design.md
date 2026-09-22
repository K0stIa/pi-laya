# Pi Laya Adapters Design

## Goal

Add opt-in Pi adapters that turn Laya's typed decisions into bounded, auditable
advice for context compaction, installed skill/tool and model selection, coding
agent supervision, and staged diff review. The extension must remain
deployment-neutral and must never execute a browser, computer action, command,
model change, compaction mutation, or review action without host-owned policy.

## Constraints

- The published repository must contain no deployment addresses, machine names,
  paths, credentials, or private inventories.
- `choice`, `score`, and `noul` remain the only decision primitives.
- All new behavior is opt-in. Default behavior is to expose advisory tools and
  plans; the extension does not mutate Pi state automatically.
- Every automated-looking recommendation has a threshold, ambiguity margin,
  bounded budget, explicit abstention reason, and `executable: false`.
- Persisted traces are session-local Pi custom entries. They omit tokens,
  request bodies, full diffs, and unredacted tool arguments.
- Public adapters must capability-gate Pi APIs which are not available on an
  older Pi runtime.

## Shared Adapter Contract

Each adapter constructs a bounded JSON state plus one to twenty typed Laya
questions, invokes the existing `LayaClient`, and converts the result into an
`AdvisoryDecision` or abstention. It reports a privacy-safe trace record:

```ts
interface DecisionTrace {
  kind: "compaction" | "skill_tool" | "model" | "supervision" | "review";
  timestamp: string;
  decision: Record<string, { status: "proposed" | "abstained" | "observed"; probability?: number; reason?: string }>;
  policy: { threshold: number; margin: number; budget: number };
  latencyMs: number;
  outcome?: "accepted" | "rejected" | "succeeded" | "failed";
}
```

The caller may append an outcome later. The extension never infers outcome from
an LLM response. Decisions bind to an input digest, and outcomes or review
responses with a stale digest are rejected.

## Context Compaction

The adapter accepts a caller-provided, normalized list of context items:

```ts
interface ContextItem {
  id: string;
  text: string;
  tokenEstimate: number;
  protected?: boolean;
}
```

Protected items are always retained and are not submitted as removal candidates.
The Pi adapter marks user entries, the latest exchanges, unknown/custom entry
types, error evidence, and paired tool call/result entries as protected unless
the host provides a stronger policy.
For every other item, Laya receives a `choice` question with `KEEP`, `DROP`, and
`TRUNCATE` criteria. The result is a non-mutating plan. `TRUNCATE` asks the
host to keep only a caller-defined prefix limit; this package does not generate
a replacement summary. The plan abstains if protected items alone exceed the
target budget, supplied coverage is not `profile_checked`, or confidence/margin
gates fail. Pi integration uses the normal `context` hook rather than the
system-inclusive hook, so Pi continues to own system/tool context. Context
filtering is disabled by default and, when explicitly enabled, is reversible
for the active model context rather than persistent session deletion.

## Inventory Adapters

The adapter normalizes installed Pi skills and tools into candidate records with
IDs, labels, descriptions, and source provenance. It normalizes models from the
currently available Pi model registry, intersected with the current model scope
where exposed by Pi. Laya selects from supplied candidates only; the output is
an advisory selected ID or abstention. It never enables a tool/skill or changes
a model by itself. A host may use the returned ID only after availability and
authorization are rechecked.

## Supervision

Supervision accepts a compact host snapshot: task status, last bounded tool
result category, retry count, step count, and caller-defined candidate actions.
The supported action vocabulary is `continue`, `retry`, `steer`, `stop`, and
`human`. A session-local state record enforces maximum retries and steps before
Laya is called; exceeding either produces deterministic `human` or `stop`.
Any optional Pi continuation hook is capability-gated and remains off unless
the host config explicitly enables it.

## Diff Review

The adapter receives a caller-provided diff summary, with full input limited by
the existing request byte cap. It evaluates small staged questions: secrets,
authentication/authorization, safety-check removal, deleted tests, destructive
data operations, payment changes, and human-review need. The output is a list
of risk signals plus `human_review_required`; it cannot label a diff approved.
Stages are independent inputs, making each decision traceable and allowing a
host to skip irrelevant checks.

## Pi Extension Surface

The extension adds advisory tools for explicit invocation and optional hooks
only where the relevant Pi capability exists. Explicit tools accept normalized
inputs; hooks only gather public Pi inventories or append an advisory trace.
No hook changes session messages, calls `setModel`, blocks a tool, or requests
an agent continuation by default.

## Testing and Verification

- Unit-test each adapter with deterministic Laya results: protected context,
  over-budget context, ambiguous selection, unavailable candidates, exhausted
  supervision budgets, every review risk, and trace redaction.
- Unit-test capability gating with minimal fake Pi APIs.
- Verify that hooks and tools do not mutate Pi state without an explicit host
  callback.
- Retain existing protocol, client, privacy, typecheck, package, and Pi-loader
checks.
