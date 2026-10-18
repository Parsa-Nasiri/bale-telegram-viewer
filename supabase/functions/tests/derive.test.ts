import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { deriveTokenSecret, deriveWebhookPath } from "../_shared/derive.ts";

const TOKEN = "123456:TEST-BOT-TOKEN";
// Same value the Python worker test asserts (worker/tests/test_webhook_setup.py).
const VECTOR = "680102ddfeaf20ef1ddc9b7d24eb304b2a9d9eb3699f72b2873f99e8f384e14c";

describe("derived secrets", () => {
  it("webhook path matches the worker's computation", async () => {
    assert.equal(await deriveWebhookPath(TOKEN), VECTOR);
    assert.equal(await deriveWebhookPath(TOKEN), createHmac("sha256", TOKEN).update("webhook:v1").digest("hex"));
  });

  it("the token key and the webhook path are different values", async () => {
    assert.notEqual(await deriveTokenSecret(TOKEN), await deriveWebhookPath(TOKEN));
  });

  it("change when the bot token changes", async () => {
    assert.notEqual(await deriveWebhookPath("999:OTHER"), await deriveWebhookPath(TOKEN));
  });
});
