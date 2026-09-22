import type { LayaConfig } from "./config.js";
import { validateRequest, validateResult, type LayaRequest, type LayaResult } from "./protocol.js";

const MAX_RESPONSE_BYTES = 64 * 1024;

export class LayaRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayaRequestError";
  }
}

export interface LayaClientOptions extends Omit<LayaConfig, "baseUrl" | "apiToken"> {
  baseUrl: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxQueue?: number;
}

async function readResponseJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("response exceeds byte limit");
  }
  if (!response.body) throw new Error("response has no body");

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const read = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (!signal) return reader.read();
    if (signal.aborted) return Promise.reject(new Error("request aborted"));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        cancel();
        reject(new Error("request aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void reader.read().then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await read();
      if (done) break;
      if (value.byteLength > MAX_RESPONSE_BYTES - size) throw new Error("response exceeds byte limit");
      size += value.byteLength;
      chunks.push(value);
    }
  } catch (error) {
    cancel();
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export class LayaClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly requestFetch: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxQueue: number;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(options: LayaClientOptions) {
    if (!options.baseUrl?.trim() || !options.apiToken?.trim()) throw new LayaRequestError("Laya configuration is incomplete");
    let baseUrl: URL;
    try {
      baseUrl = new URL(options.baseUrl);
    } catch {
      throw new LayaRequestError("Laya configuration is invalid");
    }
    const loopback = baseUrl.hostname === "localhost" || baseUrl.hostname === "::1" || baseUrl.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(baseUrl.hostname);
    if ((baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") || (baseUrl.protocol === "http:" && !loopback && !options.allowInsecureHttp) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) throw new LayaRequestError("Laya configuration is invalid");
    this.baseUrl = baseUrl.toString().replace(/\/+$/, "");
    this.apiToken = options.apiToken.trim();
    this.requestFetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new LayaRequestError("Laya configuration is invalid");
    this.maxQueue = options.maxQueue ?? 8;
    if (!Number.isInteger(this.maxQueue) || this.maxQueue < 1) throw new LayaRequestError("Laya configuration is invalid");
  }

  async evaluate(input: unknown, signal?: AbortSignal): Promise<LayaResult> {
    if (signal?.aborted) throw new LayaRequestError("Laya request failed");
    const request = validateRequest(input);
    if (this.queued >= this.maxQueue) throw new LayaRequestError("Laya request queue is full");
    this.queued += 1;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const evaluation = this.queue.then(() => this.send(request, controller.signal));
    this.queue = evaluation.then(() => undefined, () => undefined);
    return evaluation.finally(() => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
      this.queued -= 1;
    });
  }

  private async send(request: LayaRequest, signal?: AbortSignal): Promise<LayaResult> {
    if (signal?.aborted) throw new LayaRequestError("Laya request failed");
    let response: Response;
    try {
      response = await this.requestFetch(`${this.baseUrl}/v1/system-one`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiToken}` },
        body: JSON.stringify(request),
        signal,
        redirect: "error",
      });
    } catch {
      throw new LayaRequestError("Laya request failed");
    }
    if (signal?.aborted) throw new LayaRequestError("Laya request failed");
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new LayaRequestError(`Laya request failed (HTTP ${response.status})`);
    }
    let body: unknown;
    try {
      body = await readResponseJson(response, signal);
    } catch {
      if (signal?.aborted) throw new LayaRequestError("Laya request failed");
      throw new LayaRequestError("Laya response was invalid");
    }
    if (signal?.aborted) throw new LayaRequestError("Laya request failed");
    try {
      return validateResult(request.questions, body);
    } catch {
      throw new LayaRequestError("Laya response was invalid");
    }
  }
}
