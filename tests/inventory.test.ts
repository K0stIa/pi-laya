// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import * as inventoryModule from "../src/inventory.js";

const fakePi = {
  getCommands: () => [
    { name: "skill:deploy", description: "Deploy a service", source: "skill", sourceInfo: { path: "/private/skills/deploy/SKILL.md" } },
    { name: "help", description: "Built in help", source: "extension", sourceInfo: { path: "/private/help.ts" } },
    { name: "skill:diagnose", description: "Diagnose an issue", source: "skill", sourceInfo: { path: "/private/skills/diagnose/SKILL.md" } },
  ],
  getAllTools: () => [
    { name: "bash", description: "Run a command", sourceInfo: { path: "/private/bash.ts", source: "builtin" } },
    { name: "browser", description: "Open a browser", sourceInfo: { path: "/private/browser.ts", source: "extension" } },
    { name: "disabled", description: "Not active", sourceInfo: { path: "/private/disabled.ts", source: "extension" } },
  ],
  getActiveTools: () => ["browser", "bash", "not-configured"],
};

const fakeContext = {
  modelRegistry: {
    getAvailable: () => [
      { provider: "provider", id: "allowed", name: "Allowed model", baseUrl: "https://private.example" },
      { provider: "provider", id: "outside-scope", name: "Outside scope" },
    ],
  },
  scopedModels: [{ model: { provider: "provider", id: "allowed", name: "Allowed model" } }],
};

test("inventory includes only actual skills, active tools, and scoped models", () => {
  assert.equal(typeof inventoryModule.snapshotInventory, "function");
  const snapshot = inventoryModule.snapshotInventory(fakePi, fakeContext);

  assert.deepEqual(snapshot.skills.map(({ id }) => id), ["skill:deploy", "skill:diagnose"]);
  assert.deepEqual(snapshot.tools.map(({ id }) => id), ["bash", "browser"]);
  assert.deepEqual(snapshot.models.map(({ id }) => id), ["provider/allowed"]);
});

test("inventory candidates are canonical, deterministic, and omit source paths", () => {
  const snapshot = inventoryModule.snapshotInventory(fakePi, fakeContext);

  assert.deepEqual(snapshot.models[0], {
    id: "provider/allowed",
    label: "Allowed model",
    description: "",
    source: "model",
  });
  assert.equal(JSON.stringify(snapshot).includes("/private/"), false);
  assert.equal(JSON.stringify(snapshot).includes("private.example"), false);
});

test("an unscoped context exposes every currently available registry model", () => {
  const snapshot = inventoryModule.snapshotInventory({}, {
    modelRegistry: {
      getAvailable: () => [
        { provider: "b", id: "two", name: "Two" },
        { provider: "a", id: "one", name: "One" },
      ],
    },
    scopedModels: [],
  });

  assert.deepEqual(snapshot.models.map(({ id }) => id), ["a/one", "b/two"]);
});

test("inventory falls back to registered tools when active-tool state is unavailable", () => {
  const snapshot = inventoryModule.snapshotInventory({
    getAllTools: () => [{ name: "read", description: "Read a file" }],
  }, {});

  assert.deepEqual(snapshot.tools.map(({ id }) => id), ["read"]);
});

test("selection validation accepts only IDs present in the current snapshot", () => {
  assert.equal(typeof inventoryModule.validateSelectedCandidate, "function");
  const snapshot = inventoryModule.snapshotInventory(fakePi, fakeContext);

  assert.deepEqual(inventoryModule.validateSelectedCandidate(snapshot, "tool", "bash"), snapshot.tools[0]);
  assert.equal(inventoryModule.validateSelectedCandidate(snapshot, "tool", "disabled"), undefined);
  assert.equal(inventoryModule.validateSelectedCandidate(snapshot, "model", "provider/outside-scope"), undefined);
  assert.equal(inventoryModule.validateSelectedCandidate(snapshot, "unknown", "bash"), undefined);
});
