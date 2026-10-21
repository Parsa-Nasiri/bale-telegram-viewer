// Runtime configuration for the Edge Functions.
//
// The operator sets one secret: BALE_BOT_TOKEN (the bootstrap workflow runs `supabase secrets set` for it).
// Supabase provides SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to every function. Everything else is derived
// from the bot token or has a default.

import { deriveTokenSecret, deriveWebhookPath } from "./derive.ts";
import { readEnv, requireEnv } from "./env.ts";

export interface ApiConfig {
  supabaseUrl: string;
  botToken: string;
  tokenSecret: string;
  allowedOrigins: readonly string[];
  initDataMaxAgeSeconds: number;
  tokenTtlSeconds: number;
  maxDownloadBytes: number;
}

export interface FunctionConfig extends ApiConfig {
  serviceKey: string;
  webhookSecret: string;
}

const DEFAULT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // Bale multipart upload limit for documents

function intEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function listEnv(name: string): string[] {
  return (readEnv(name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export async function loadConfig(): Promise<FunctionConfig> {
  const botToken = requireEnv("BALE_BOT_TOKEN");
  const configuredOrigins = listEnv("ALLOWED_ORIGINS");
  return {
    supabaseUrl: requireEnv("SUPABASE_URL").replace(/\/$/, ""),
    serviceKey: requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    botToken,
    tokenSecret: await deriveTokenSecret(botToken),
    webhookSecret: await deriveWebhookPath(botToken),
    // Open by default. That is safe: the API takes a bearer token in a header, never cookies, so a foreign
    // page cannot make the browser send credentials. Set ALLOWED_ORIGINS to restrict it anyway.
    allowedOrigins: configuredOrigins.length > 0 ? configuredOrigins : ["*"],
    initDataMaxAgeSeconds: intEnv("INIT_DATA_MAX_AGE_SECONDS", 3600),
    tokenTtlSeconds: intEnv("APP_TOKEN_TTL_SECONDS", 3600),
    maxDownloadBytes: intEnv("MAX_DOWNLOAD_BYTES", DEFAULT_MAX_DOWNLOAD_BYTES),
  };
}
