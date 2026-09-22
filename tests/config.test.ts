// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import * as configModule from "../src/config.js";

test("resolveConfig uses generic environment values", () => {
  assert.equal(typeof configModule.resolveConfig, "function");
  const { resolveConfig } = configModule;
  const config = resolveConfig({
    env: { PI_LAYA_BASE_URL: "https://laya.example.com/", PI_LAYA_API_TOKEN: " token " },
    readSecret: () => { throw new Error("not called"); },
  });

  assert.deepEqual(config, { baseUrl: "https://laya.example.com", apiToken: "token", allowInsecureHttp: false });
});

test("resolveConfig reads the generic Pi secret fallback", () => {
  assert.equal(typeof configModule.resolveConfig, "function");
  const { resolveConfig } = configModule;
  const config = resolveConfig({ env: {}, readSecret: () => "fallback-token\n" });

  assert.deepEqual(config, { baseUrl: undefined, apiToken: "fallback-token", allowInsecureHttp: false });
});

test("resolveConfig reads a local generic endpoint file when the environment omits it", () => {
  assert.equal(typeof configModule.resolveConfig, "function");
  const { resolveConfig } = configModule;
  const config = resolveConfig({
    env: {},
    readLocalConfig: () => ({ baseUrl: "https://laya.example.com/" }),
    readSecret: () => "fallback-token",
  });

  assert.deepEqual(config, { baseUrl: "https://laya.example.com", apiToken: "fallback-token", allowInsecureHttp: false });
});

test("resolveConfig requires an explicit insecure HTTP opt-in", () => {
  const { resolveConfig } = configModule;
  assert.equal(resolveConfig({ env: { PI_LAYA_ALLOW_INSECURE_HTTP: "true" }, readSecret: () => "token" }).allowInsecureHttp, true);
});
