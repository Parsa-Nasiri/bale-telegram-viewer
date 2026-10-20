// Entry point for the Bale webhook (deployed as the Supabase Edge Function `bale-webhook`).
// The secret path is derived from BALE_BOT_TOKEN, so the worker's registration step produces the same URL.
// MINI_APP_URL is saved by the bootstrap workflow. If it is missing, the bot stores chats and sends no button.
import { BaleBot } from "../_shared/bale.ts";
import { deriveWebhookPath } from "../_shared/derive.ts";
import { requireEnv } from "../_shared/env.ts";
import { Rest } from "../_shared/rest.ts";
import { handleWebhook } from "../_shared/webhook.ts";

const db = new Rest(requireEnv("SUPABASE_URL").replace(/\/$/, ""), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
const botToken = requireEnv("BALE_BOT_TOKEN");
const secret = await deriveWebhookPath(botToken);
const miniAppUrl = Deno.env.get("MINI_APP_URL") || undefined;
const bale = new BaleBot(botToken);

Deno.serve((req) =>
  handleWebhook(req, { db, secret, bale, miniAppUrl, now: () => Math.floor(Date.now() / 1000) }),
);
