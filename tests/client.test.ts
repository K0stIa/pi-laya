// @ts-nocheck
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import * as clientModule from "../src/client.js";

const request = { state: { subject: "test" }, questions: { urgent: { type: "noul", instructions: "Urgent?" } } };

test("LayaClient posts to the configured endpoint with bearer authentication", async () => {
  assert.equal(typeof clientModule.LayaClient, "function");
  const { LayaClient } = clientModule;
  const server = createServer((incoming, outgoing) => {
    assert.equal(incoming.url, "/v1/system-one");
    assert.equal(incoming.headers.authorization, "Bearer test-token");
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ answers: { urgent: { type: "noul", noul: 0.8 } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const result = await new LayaClient({ baseUrl: `http://127.0.0.1:${port}`, apiToken: "test-token" }).evaluate(request);
    assert.equal(result.answers.urgent.noul, 0.8);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("LayaClient sanitizes HTTP failures", async () => {
  assert.equal(typeof clientModule.LayaClient, "function");
  const { LayaClient } = clientModule;
  const client = new LayaClient({
    baseUrl: "https://laya.example.com",
    apiToken: "secret-token",
    fetch: async () => new Response('{"error":{"message":"private server detail"}}', { status: 401 })
  });
  await assert.rejects(() => client.evaluate(request), { message: "Laya request failed (HTTP 401)" });
});

test("LayaClient cancels an HTTP error body", async () => {
  let cancelled = false;
  const client = new clientModule.LayaClient({
    baseUrl: "https://laya.example.com",
    apiToken: "test-token",
    fetch: async () => ({
      ok: false,
      status: 503,
      body: { cancel: async () => { cancelled = true; } },
    }),
  });
  await assert.rejects(() => client.evaluate(request), { message: "Laya request failed (HTTP 503)" });
  assert.equal(cancelled, true);
});

test("LayaClient rejects an oversized response model before parsing JSON", async () => {
  let jsonCalls = 0;
  const client = new clientModule.LayaClient({
    baseUrl: "https://laya.example.com",
    apiToken: "test-token",
    fetch: async () => {
      const response = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            answers: { urgent: { type: "noul", noul: 0.8 } },
            model: "x".repeat(64 * 1024),
          })));
          controller.close();
        },
      }));
      response.json = async () => {
        jsonCalls += 1;
        return { answers: { urgent: { type: "noul", noul: 0.8 } } };
      };
      return response;
    },
  });
  await assert.rejects(() => client.evaluate(request), { message: "Laya response was invalid" });
  assert.equal(jsonCalls, 0);
});

test("LayaClient permits cleartext only for loopback endpoints and prevents redirects", async () => {
  assert.equal(typeof clientModule.LayaClient, "function");
  assert.throws(() => new clientModule.LayaClient({ baseUrl: "http://laya.example.com", apiToken: "test-token" }), /configuration is invalid/);
  for (const endpoint of ["https://token@laya.example.com", "https://laya.example.com?mode=test", "https://laya.example.com#fragment"]) {
    assert.throws(() => new clientModule.LayaClient({ baseUrl: endpoint, apiToken: "test-token" }), /configuration is invalid/);
  }
  assert.doesNotThrow(() => new clientModule.LayaClient({ baseUrl: "http://[::1]:9130", apiToken: "test-token" }));
  let redirect;
  const client = new clientModule.LayaClient({
    baseUrl: "http://127.0.0.1:9130",
    apiToken: "test-token",
    fetch: async (_url, init) => {
      redirect = init.redirect;
      return new Response(JSON.stringify({ answers: { urgent: { type: "noul", noul: 0.8 } } }));
    }
  });
  await client.evaluate(request);
  assert.equal(redirect, "error");
});

test("LayaClient rejects pre-aborted calls before fetch", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const client = new clientModule.LayaClient({
    baseUrl: "https://laya.example.com",
    apiToken: "test-token",
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ answers: { urgent: { type: "noul", noul: 0.8 } } }));
    }
  });
  await assert.rejects(() => client.evaluate(request, controller.signal), { message: "Laya request failed" });
  assert.equal(calls, 0);
});

test("LayaClient applies a deadline to an unresponsive fetch", async () => {
  const client = new clientModule.LayaClient({
    baseUrl: "https://laya.example.com",
    apiToken: "test-token",
    timeoutMs: 1,
    fetch: async () => new Promise((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ answers: { urgent: { type: "noul", noul: 0.8 } } }))), 20))
  });
  await assert.rejects(() => client.evaluate(request), { message: "Laya request failed" });
});

test("LayaClient applies its deadline while reading the response body", async () => {
  const client = new clientModule.LayaClient({
    baseUrl: "https://laya.example.com",
    apiToken: "test-token",
    timeoutMs: 1,
    fetch: async () => {
      let timeout;
      return new Response(new ReadableStream({
        start(controller) {
          timeout = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ answers: { urgent: { type: "noul", noul: 0.8 } } })));
            controller.close();
          }, 20);
        },
        cancel() { clearTimeout(timeout); },
      }));
    }
  });
  await assert.rejects(() => client.evaluate(request), { message: "Laya request failed" });
});

test("LayaClient serializes evaluations from the same client", async () => {
  let starts = 0;
  let releaseFirst;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const client = new clientModule.LayaClient({
    baseUrl: "https://laya.example.com",
    apiToken: "test-token",
    fetch: async () => {
      starts += 1;
      if (starts === 1) await firstResponse;
      return new Response(JSON.stringify({ answers: { urgent: { type: "noul", noul: 0.8 } } }));
    }
  });
  const first = client.evaluate(request);
  const second = client.evaluate(request);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 1);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(starts, 2);
});

test("LayaClient bounds its queue", async () => {
  let releaseFirst;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const client = new clientModule.LayaClient({
    baseUrl: "https://laya.example.com",
    apiToken: "test-token",
    maxQueue: 1,
    fetch: async () => {
      await firstResponse;
      return new Response(JSON.stringify({ answers: { urgent: { type: "noul", noul: 0.8 } } }));
    }
  });
  const first = client.evaluate(request);
  try {
    await assert.rejects(() => client.evaluate(request), { message: "Laya request queue is full" });
  } finally {
    releaseFirst();
  }
  await first;
});
