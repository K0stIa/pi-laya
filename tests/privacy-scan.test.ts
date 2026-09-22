// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as privacyModule from "../src/privacy-scan.js";

test("privacy scan rejects private endpoint literals without echoing them", async () => {
  assert.equal(typeof privacyModule.scanPrivacy, "function");
  const directory = await mkdtemp(join(tmpdir(), "pi-laya-scan-"));
  const endpoint = ["10", "8", "0", "4"].join(".");
  try {
    await writeFile(join(directory, "fixture.txt"), `http://${endpoint}/service`);
    await assert.rejects(() => privacyModule.scanPrivacy(directory), (error) => {
      assert.match(error.message, /private deployment data/i);
      assert.doesNotMatch(error.message, new RegExp(endpoint.replaceAll(".", "\\.")));
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("privacy scan rejects common internal hostnames, paths, and token assignments", async () => {
  assert.equal(typeof privacyModule.scanPrivacy, "function");
  const directory = await mkdtemp(join(tmpdir(), "pi-laya-scan-"));
  const hostname = ["service", "internal"].join(".");
  const deploymentPath = ["/home", "deploy-user", "service"].join("/");
  const token = "a".repeat(24);
  try {
    await writeFile(join(directory, "fixture.txt"), `${hostname}\n${deploymentPath}\nPI_LAYA_API_TOKEN=${token}`);
    await assert.rejects(() => privacyModule.scanPrivacy(directory), /private deployment data/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
