import assert from "node:assert/strict";
import test from "node:test";
import * as configModule from "../src/config.js";
import type { LayaClientOptions } from "../src/client.js";

const minimalClientOptions: LayaClientOptions = {
  baseUrl: "https://laya.example.com",
  apiToken: "test-token",
};

test("LayaClient options require only an endpoint and token", () => {
  assert.equal(minimalClientOptions.allowInsecureHttp, undefined);
});

test("resolveConfig uses generic environment values", () => {
  assert.equal(typeof configModule.resolveConfig, "function");
  const { resolveConfig } = configModule;
  const config = resolveConfig({
    env: { PI_LAYA_BASE_URL: "https://laya.example.com/", PI_LAYA_API_TOKEN: " token " },
    readLocalConfig: () => undefined,
    readSecret: () => { throw new Error("not called"); },
  });

  assert.deepEqual(config, { baseUrl: "https://laya.example.com", apiToken: "token", allowInsecureHttp: false });
});

test("resolveConfig reads the generic Pi secret fallback", () => {
  assert.equal(typeof configModule.resolveConfig, "function");
  const { resolveConfig } = configModule;
  const config = resolveConfig({ env: {}, readLocalConfig: () => undefined, readSecret: () => "fallback-token\n" });

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
  assert.equal(resolveConfig({ env: { PI_LAYA_ALLOW_INSECURE_HTTP: "true" }, readLocalConfig: () => undefined, readSecret: () => "token" }).allowInsecureHttp, true);
});

test("resolveConfig uses supplied missing-config readers instead of filesystem defaults", () => {
  const { resolveConfig } = configModule;
  let localReads = 0;
  let secretReads = 0;
  const config = resolveConfig({
    env: {},
    readLocalConfig: () => {
      localReads += 1;
      return undefined;
    },
    readSecret: () => {
      secretReads += 1;
      throw new Error("missing test secret");
    },
  });

  assert.deepEqual(config, { baseUrl: undefined, apiToken: undefined, allowInsecureHttp: false });
  assert.equal(localReads, 1);
  assert.equal(secretReads, 1);
});
