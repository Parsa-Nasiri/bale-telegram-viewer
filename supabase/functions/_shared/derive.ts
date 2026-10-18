// Secrets derived from the Bale bot token, so the operator sets only BALE_BOT_TOKEN.
//
//   webhook path  = hex(HMAC-SHA256(key = bot_token, message = "webhook:v1"))
//   app token key = hex(HMAC-SHA256(key = bot_token, message = "app-token:v1"))
//
// The worker derives the same webhook path (worker/bale_viewer_worker/webhook_setup.py). Keep the labels in sync.
//
// Exposure: anyone holding the bot token can already sign Mini App initData, so deriving the app token key from
// it adds no new weakness. Rotating the bot token rotates both values.

import { bytesToHex, encoder, hmacSha256 } from "./crypto.ts";

const WEBHOOK_LABEL = "webhook:v1";
const APP_TOKEN_LABEL = "app-token:v1";

async function derive(botToken: string, label: string): Promise<string> {
  return bytesToHex(await hmacSha256(encoder.encode(botToken), label));
}

export function deriveWebhookPath(botToken: string): Promise<string> {
  return derive(botToken, WEBHOOK_LABEL);
}

export function deriveTokenSecret(botToken: string): Promise<string> {
  return derive(botToken, APP_TOKEN_LABEL);
}
