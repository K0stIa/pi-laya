// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import * as tracingModule from "../src/tracing.js";

test("trace stores a digest but never raw state or token-like strings", () => {
  assert.equal(typeof tracingModule.createDecisionTrace, "function");
  const { createDecisionTrace } = tracingModule;
  const trace = createDecisionTrace({ kind: "review", state: { diff: "secret-value" }, decision: {} });

  assert.equal(JSON.stringify(trace).includes("secret-value"), false);
  assert.match(trace.inputDigest, /^[a-f0-9]{64}$/);
});

test("outcome rejects a stale decision digest", () => {
  assert.equal(typeof tracingModule.createDecisionTrace, "function");
  assert.equal(typeof tracingModule.recordOutcome, "function");
  const { createDecisionTrace, recordOutcome } = tracingModule;
  const trace = createDecisionTrace({ kind: "review", state: {}, decision: {} });

  assert.throws(
    () => recordOutcome(trace, { decisionId: trace.id, inputDigest: "0".repeat(64), status: "accepted" }),
    /digest/i
  );
});

test("trace digest binds only the raw decision state", () => {
  const { createDecisionTrace, traceDigest } = tracingModule;
  const state = { snapshot: ["bounded", "state"] };
  const trace = createDecisionTrace({
    kind: "review",
    state,
    decision: { review: { status: "observed", reason: "protected" } },
    policy: { threshold: 0.9, margin: 0.1, budget: 1 },
    latencyMs: 25,
  });

  assert.equal(trace.inputDigest, traceDigest(state));
});

test("traceDigest rejects sparse and non-JSON structures", () => {
  const { traceDigest } = tracingModule;
  const sparse = ["present", , "present"];
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);

  assert.throws(() => traceDigest(sparse), /dense JSON array/);
  assert.throws(() => traceDigest(cyclic), /acyclic JSON data/);
  assert.throws(() => traceDigest(new Date()), /JSON data/);
  assert.throws(() => traceDigest({ value: undefined }), /JSON data/);
});

test("trace rejects raw decision keys and reasons", () => {
  const { createDecisionTrace } = tracingModule;

  assert.throws(
    () => createDecisionTrace({ kind: "review", state: {}, decision: { "raw decision": { status: "observed" } } }),
    /decision key/
  );
  assert.throws(
    () => createDecisionTrace({ kind: "review", state: {}, decision: { review: { status: "observed", reason: "user supplied text" } } }),
    /decision reason/
  );
});

test("outcome validates its runtime envelope before recording", () => {
  const { createDecisionTrace, recordOutcome } = tracingModule;
  const trace = createDecisionTrace({ kind: "review", state: {}, decision: {} });

  assert.throws(() => recordOutcome(trace, { decisionId: trace.id, inputDigest: trace.inputDigest, status: "unknown" }), /outcome status/i);
  assert.throws(() => recordOutcome({ ...trace, id: "not-a-uuid" }, { decisionId: "not-a-uuid", inputDigest: trace.inputDigest, status: "accepted" }), /trace ID/i);
  assert.throws(() => recordOutcome({ ...trace, inputDigest: "x".repeat(64) }, { decisionId: trace.id, inputDigest: "x".repeat(64), status: "accepted" }), /trace input digest/i);
});

test("outcome accepts a valid digest-based trace ID", () => {
  const { createDecisionTrace, recordOutcome } = tracingModule;
  const trace = createDecisionTrace({ kind: "review", state: {}, decision: {} });
  const digestId = "a".repeat(64);

  const recorded = recordOutcome({ ...trace, id: digestId }, { decisionId: digestId, inputDigest: trace.inputDigest, status: "accepted" });
  assert.equal(recorded.outcome, "accepted");
});

test("recordOutcome rebuilds a validated trace without caller fields", () => {
  const { createDecisionTrace, recordOutcome } = tracingModule;
  const trace = createDecisionTrace({ kind: "review", state: {}, decision: {} });
  const recorded = recordOutcome(
    { ...trace, decision: { review: { status: "observed", reason: "protected" } }, untrusted: "secret-value" },
    { decisionId: trace.id, inputDigest: trace.inputDigest, status: "accepted" }
  );

  assert.equal(JSON.stringify(recorded).includes("secret-value"), false);
  assert.equal(Object.hasOwn(recorded, "untrusted"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(recorded.decision)), { review: { status: "observed", reason: "protected" } });
  assert.throws(
    () => recordOutcome({ ...trace, decision: { review: { status: "observed", reason: "raw secret" } } }, { decisionId: trace.id, inputDigest: trace.inputDigest, status: "accepted" }),
    /decision reason/
  );
});
