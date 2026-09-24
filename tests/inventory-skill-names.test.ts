import assert from "node:assert/strict";
import test from "node:test";
import { snapshotInventory } from "../src/inventory.js";

test("Pi inventory retains prefixed skill command IDs", () => {
  const pi = { getCommands: () => [{ name: "skill:code-reviewer", source: "skill", description: "Review code" }] };
  const snapshot = snapshotInventory(pi, undefined);
  assert.deepEqual(snapshot.skills, [{ id: "skill:code-reviewer", label: "skill:code-reviewer", description: "Review code", source: "skill" }]);
});
