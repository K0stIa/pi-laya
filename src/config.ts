import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface LayaConfig {
  baseUrl?: string;
  apiToken?: string;
  allowInsecureHttp?: boolean;
}

export interface ResolveConfigOptions {
  env?: Record<string, string | undefined>;
  readSecret?: () => string;
  readLocalConfig?: () => LayaConfig | undefined;
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

export function resolveConfig(options: ResolveConfigOptions = {}): LayaConfig {
  const env = options.env ?? process.env;
  const readLocalConfig = options.readLocalConfig ?? (() => {
    try {
      const value: unknown = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "laya.json"), "utf8"));
      if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
      const baseUrl = (value as Record<string, unknown>).baseUrl;
      const allowInsecureHttp = (value as Record<string, unknown>).allowInsecureHttp;
      return typeof baseUrl === "string" && (allowInsecureHttp === undefined || typeof allowInsecureHttp === "boolean") ? { baseUrl, allowInsecureHttp } : undefined;
    } catch {
      return undefined;
    }
  });
  const localConfig = readLocalConfig();
  const baseUrl = (clean(env.PI_LAYA_BASE_URL) ?? clean(localConfig?.baseUrl))?.replace(/\/+$/, "");
  const allowInsecureHttp = env.PI_LAYA_ALLOW_INSECURE_HTTP === "true" || localConfig?.allowInsecureHttp === true;
  const fromEnvironment = clean(env.PI_LAYA_API_TOKEN);
  if (fromEnvironment) return { baseUrl, apiToken: fromEnvironment, allowInsecureHttp };

  const readSecret = options.readSecret ?? (() => readFileSync(join(homedir(), ".pi", "agent", "secrets", "laya_api_token"), "utf8"));
  try {
    return { baseUrl, apiToken: clean(readSecret()), allowInsecureHttp };
  } catch {
    return { baseUrl, apiToken: undefined, allowInsecureHttp };
  }
}
