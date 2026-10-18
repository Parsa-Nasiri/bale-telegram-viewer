import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../_shared/config.ts";

const KEYS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "BALE_BOT_TOKEN", "ALLOWED_ORIGINS", "MAX_DOWNLOAD_BYTES"];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.SUPABASE_URL = "https://abc.supabase.co/";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  process.env.BALE_BOT_TOKEN = "123456:TEST-BOT-TOKEN";
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("loadConfig", () => {
  it("needs only the bot token, plus the Supabase values that Supabase provides", async () => {
    const config = await loadConfig();
    assert.equal(config.supabaseUrl, "https://abc.supabase.co");
    assert.equal(config.tokenSecret.length, 64);
    assert.equal(config.webhookSecret.length, 64);
    assert.notEqual(config.tokenSecret, config.webhookSecret);
  });

  it("accepts any origin unless ALLOWED_ORIGINS restricts it", async () => {
    assert.deepEqual([...(await loadConfig()).allowedOrigins], ["*"]);
    process.env.ALLOWED_ORIGINS = "https://a.example, https://b.example";
    assert.deepEqual([...(await loadConfig()).allowedOrigins], ["https://a.example", "https://b.example"]);
  });

  it("fails clearly when the bot token is missing", async () => {
    delete process.env.BALE_BOT_TOKEN;
    await assert.rejects(loadConfig(), /BALE_BOT_TOKEN/);
  });
});
