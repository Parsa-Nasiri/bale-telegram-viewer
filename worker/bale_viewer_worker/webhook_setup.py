"""Bale webhook registration. The secret path is derived from the bot token, so no extra secret is needed.

The Edge Function derives the same path (supabase/functions/_shared/derive.ts). Keep the label in sync:
    path = hex(HMAC-SHA256(key=bot_token, message="webhook:v1"))

Never print the URL. The path is what stops strangers from posting fake updates to the function.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from urllib.parse import urlencode

from .errors import AppError
from .transport import Transport

WEBHOOK_LABEL = b"webhook:v1"


def webhook_path(bot_token: str) -> str:
    return hmac.new(bot_token.encode("utf-8"), WEBHOOK_LABEL, hashlib.sha256).hexdigest()


def webhook_url(supabase_url: str, bot_token: str) -> str:
    return f"{supabase_url.rstrip('/')}/functions/v1/bale-webhook/{webhook_path(bot_token)}"


def register_webhook(api_base_url: str, bot_token: str, url: str, transport: Transport) -> None:
    """Calls setWebhook. Repeating the call with the same URL is harmless."""
    endpoint = f"{api_base_url.rstrip('/')}/bot{bot_token}/setWebhook"
    response = transport.request(
        "POST",
        endpoint,
        headers={"content-type": "application/x-www-form-urlencoded"},
        body=urlencode({"url": url}).encode("utf-8"),
        timeout=30.0,
    )
    if response.status != 200:
        raise AppError("BALE_WEBHOOK_FAILED", f"setWebhook http {response.status}")
    try:
        payload = json.loads(response.body.decode("utf-8"))
    except ValueError:
        raise AppError("BALE_WEBHOOK_FAILED", "setWebhook returned no JSON") from None
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        # The response body is not echoed: it may repeat request details.
        raise AppError("BALE_WEBHOOK_FAILED", "setWebhook was rejected")
