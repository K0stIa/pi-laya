# Pi Laya Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in, non-executing Pi adapters for compaction, live inventory selection, supervision, staged review, and decision tracing.

**Architecture:** Add pure, independently testable modules for each adapter and keep Pi integration as a thin capability-gated layer in the extension. Every module returns advisory plans or deterministic budget stops; only an explicitly configured host callback may apply a plan.

**Tech Stack:** TypeScript, Node built-in tests, TypeBox, Pi extension API 0.87-compatible structural types.

**Spec:** `docs/superpowers/specs/2026-09-22-pi-laya-adapters-design.md`

## Global Constraints

- Do not embed deployment identifiers, credentials, private inventories, or local paths.
- Preserve existing `laya_evaluate` and `laya_decide` behavior.
- Use only `choice`, `score`, and `noul` Laya questions.
- Default behavior is advisory and does not mutate Pi state, session context, tools, skills, or model choice.
- Every proposal has threshold, margin, budget, abstention reason, and `executable: false`.
- Trace records contain digests and summaries only; never raw state, diffs, prompts, tokens, or tool arguments.

## Review Focus

- Protected and paired context items must survive every compaction plan, including low-confidence model output.
- Live candidates must be revalidated before any host-owned apply callback receives them.
- Duplicate lifecycle events and resumed sessions must not refund supervision budgets.
- An oversized, binary, or stale diff must require human review rather than create a pass signal.
- Trace records must redact raw content and reject outcomes for stale decision IDs/digests.

### Task 1: Trace records and decision envelopes

**Files:**
- Create: `src/tracing.ts`
- Create: `tests/tracing.test.ts`

**Interfaces:**
- Produces `createDecisionTrace(input)`, `recordOutcome(trace, outcome)`, and `traceDigest(value)`.
- Consumed by compaction, inventory, supervision, and review modules.

- [ ] **Step 1: Write failing tests**

```ts
test("trace stores a digest but never raw state or token-like strings", () => {
  const trace = createDecisionTrace({ kind: "review", state: { diff: "secret-value" }, decision: {} });
  assert.equal(JSON.stringify(trace).includes("secret-value"), false);
  assert.match(trace.inputDigest, /^[a-f0-9]{64}$/);
});

test("outcome rejects a stale decision digest", () => {
  assert.throws(() => recordOutcome(trace, { decisionId: trace.id, inputDigest: "0".repeat(64), status: "accepted" }));
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --test-name-pattern='trace'`

- [ ] **Step 3: Implement minimal trace records**

Use `node:crypto` SHA-256 over canonical JSON. Generate a non-secret UUID or digest-based ID; retain only feature, timestamp, digest, policy, decisions, latency, and outcome status.

- [ ] **Step 4: Run GREEN**

Run: `npm test && npm run typecheck`

### Task 2: Context compaction plans

**Files:**
- Create: `src/compaction.ts`
- Create: `tests/compaction.test.ts`

**Interfaces:**
- Produces `protectContextItems(items)`, `buildCompactionRequest(items, policy)`, and `makeCompactionPlan(items, result, policy)`.
- `ContextItem` has `id`, `text`, `tokenEstimate`, `protected`, and optional `pairId`.

- [ ] **Step 1: Write failing tests**

```ts
test("protected and paired items are always kept", () => {
  const plan = makeCompactionPlan(items, lowConfidenceDropResult, policy);
  assert.deepEqual(plan.keepIds.sort(), ["user", "tool-call", "tool-result"]);
});

test("partial coverage and protected-over-budget contexts abstain", () => {
  assert.equal(makeCompactionPlan(items, result, { ...policy, coverage: "unchecked" }).status, "abstained");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --test-name-pattern='compaction'`

- [ ] **Step 3: Implement pure compaction planning**

Build one `choice` question per removable item using `KEEP`, `DROP`, and `TRUNCATE`. Apply existing probability gates; never alter text. Return a reversible plan with current snapshot digest, token total, and trace metadata.

- [ ] **Step 4: Run GREEN**

Run: `npm test && npm run typecheck`

### Task 3: Actual Pi inventory snapshots and advisory routing

**Files:**
- Create: `src/inventory.ts`
- Create: `tests/inventory.test.ts`
- Modify: `src/index.ts`
- Modify: `tests/extension.test.ts`

**Interfaces:**
- Produces `snapshotInventory(pi, ctx)` and `validateSelectedCandidate(snapshot, kind, id)`.
- Adds `laya_inventory_route` tool that returns advisory skill/tool/model candidates and a trace.

- [ ] **Step 1: Write failing tests**

```ts
test("inventory includes only actual skills, active tools, and scoped models", () => {
  const snapshot = snapshotInventory(fakePi, fakeContext);
  assert.deepEqual(snapshot.models.map(({ id }) => id), ["provider/allowed"]);
});

test("inventory route never calls setModel or enables a tool", async () => {
  await routeTool.execute("call", params);
  assert.equal(fakePi.setModelCalls, 0);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --test-name-pattern='inventory'`

- [ ] **Step 3: Implement snapshot and tool**

Use optional Pi APIs only after feature detection. Read skills from `getCommands()` entries whose source is `skill`, tools from `getAllTools()`/active tools when available, and models from the available registry intersected with scoped models. Return selected IDs only; do not call `setModel`.

- [ ] **Step 4: Run GREEN**

Run: `npm test && npm run typecheck`

### Task 4: Persistent supervision reducer

**Files:**
- Create: `src/supervision.ts`
- Create: `tests/supervision.test.ts`
- Modify: `src/index.ts`
- Modify: `tests/extension.test.ts`

**Interfaces:**
- Produces `reduceSupervision(state, event, limits)` and `supervisionDecision(state, result, policy)`.
- Adds `laya_supervise` advisory tool; Pi hooks are registered only with explicit options and capability checks.

- [ ] **Step 1: Write failing tests**

```ts
test("duplicate call IDs do not refund or double-count a budget", () => {
  const once = reduceSupervision(empty, { type: "tool", callId: "a" }, limits);
  assert.deepEqual(reduceSupervision(once, { type: "tool", callId: "a" }, limits), once);
});

test("exhausted retries routes deterministically to human", () => {
  assert.equal(reduceSupervision(stateAtRetryLimit, failure, limits).requiredAction, "human");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --test-name-pattern='supervision'`

- [ ] **Step 3: Implement reducer and advisory tool**

Persist versioned, session-local records through an injected append/read interface. Enforce step/retry budgets before Laya; use `continue`, `retry`, `steer`, `stop`, and `human` as the only actions. Do not request continuation or block a Pi tool by default.

- [ ] **Step 4: Run GREEN**

Run: `npm test && npm run typecheck`

### Task 5: Staged diff review plans

**Files:**
- Create: `src/review.ts`
- Create: `tests/review.test.ts`
- Modify: `src/index.ts`
- Modify: `tests/extension.test.ts`

**Interfaces:**
- Produces `buildReviewRequest(diff, policy)`, `makeReviewPlan(diff, result, policy)`, and `recordReviewOutcome(plan, outcome)`.
- Adds `laya_review` advisory tool accepting supplied diff text; no Git command is run by the extension.

- [ ] **Step 1: Write failing tests**

```ts
test("review produces staged risk questions and always routes an oversized diff to human", () => {
  assert.equal(makeReviewPlan(oversizedDiff, result, policy).humanReviewRequired, true);
});

test("a stale human response cannot resolve a review plan", () => {
  assert.throws(() => recordReviewOutcome(plan, { inputDigest: otherDigest, status: "accepted" }));
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --test-name-pattern='review'`

- [ ] **Step 3: Implement review stages**

Ask independent noul/choice questions for secret exposure, auth change, safety-check removal, test deletion, destructive data operations, payment logic, and human-review requirement. Binary markers, incomplete state, or input over the limit return human routing before Laya.

- [ ] **Step 4: Run GREEN**

Run: `npm test && npm run typecheck`

### Task 6: Opt-in Pi integration and documentation

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `tests/extension.test.ts`
- Modify: `tests/privacy-scan.test.ts`

**Interfaces:**
- Adds optional `PiLayaOptions.adapters` configuration and structural optional Pi APIs.
- Preserves existing extension default exports and tools.

- [ ] **Step 1: Write failing tests**

```ts
test("default installation registers no lifecycle hooks or host mutators", () => {
  piLaya(fakePi);
  assert.equal(fakePi.hooks.length, 0);
  assert.equal(fakePi.setModelCalls, 0);
});

test("enabled context adapter registers only normal context hook when supported", () => {
  piLaya(fakePi, { adapters: { compaction: { enabled: true, mode: "preview" } } });
  assert.deepEqual(fakePi.hooks.map(({ event }) => event), ["context"]);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --test-name-pattern='adapter|hook'`

- [ ] **Step 3: Integrate capability-gated adapters and docs**

Register explicit tools unconditionally only when their input contract is standalone. Register context/session hooks only when both adapter config and Pi capability are present. Document opt-in configuration, trace privacy, and host-owned application callbacks.

- [ ] **Step 4: Run GREEN and package verification**

Run: `npm test && npm run typecheck && npm run privacy:check && npm pack --dry-run --json && git diff --check`

### Task 7: Whole-package review and local Pi smoke check

**Files:**
- Modify: `README.md` only if review exposes an interface/documentation gap.

- [ ] **Step 1: Run an independent review against the specification**

Dispatch a read-only reviewer to check all adapter modules, privacy guarantees, Pi capability gates, and test adequacy.

- [ ] **Step 2: Correct any Critical or Important finding using a new failing regression test**

Run the focused RED test, implement the smallest correction, then rerun the full suite.

- [ ] **Step 3: Verify a local Pi package load**

Run: `pi install /tmp/pi-laya --no-approve` and load the extension with Pi's loader. Confirm the legacy tools and new advisory tools register without error; do not perform a live model, compaction, or review action.

- [ ] **Step 4: Final verification**

Run: `npm test && npm run typecheck && npm run privacy:check && npm pack --dry-run --json && git status --short`
