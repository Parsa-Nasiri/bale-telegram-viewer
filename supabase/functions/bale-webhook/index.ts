// Entry point for the Bale webhook (deployed as the Supabase Edge Function `bale-webhook`).
// The secret path is derived from BALE_BOT_TOKEN, so the worker's registration step produces the same URL.
import { deriveWebhookPath } from "../_shared/derive.ts";
import { requireEnv } from "../_shared/env.ts";
import { Rest } from "../_shared/rest.ts";
import { handleWebhook } from "../_shared/webhook.ts";

const db = new Rest(requireEnv("SUPABASE_URL").replace(/\/$/, ""), requireEnv("SUPABASE_SERVICE_ROLE_KEY"));
const secret = await deriveWebhookPath(requireEnv("BALE_BOT_TOKEN"));

Deno.serve((req) => handleWebhook(req, { db, secret }));
