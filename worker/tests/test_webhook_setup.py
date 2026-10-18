import unittest

from bale_viewer_worker.errors import AppError
from bale_viewer_worker.transport import HttpResponse
from bale_viewer_worker.webhook_setup import register_webhook, webhook_path, webhook_url

from .fakes import FakeTransport, ok_json

TOKEN = "123456:TEST-BOT-TOKEN"
# Same value the Edge Function test asserts (supabase/functions/tests/derive.test.ts).
VECTOR = "680102ddfeaf20ef1ddc9b7d24eb304b2a9d9eb3699f72b2873f99e8f384e14c"


class WebhookSetupTests(unittest.TestCase):
    def test_path_matches_the_vector_shared_with_the_edge_function(self) -> None:
        self.assertEqual(webhook_path(TOKEN), VECTOR)

    def test_url_joins_the_project_and_the_path(self) -> None:
        self.assertEqual(
            webhook_url("https://abc.supabase.co/", TOKEN),
            f"https://abc.supabase.co/functions/v1/bale-webhook/{VECTOR}",
        )

    def test_registration_posts_the_url_to_setwebhook(self) -> None:
        transport = FakeTransport(lambda method, url, headers, body: ok_json({"ok": True}))
        register_webhook("https://tapi.bale.ai", TOKEN, "https://x.example/hook", transport)
        call = transport.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], f"https://tapi.bale.ai/bot{TOKEN}/setWebhook")
        self.assertIn(b"url=https%3A%2F%2Fx.example%2Fhook", call["body"])

    def test_rejected_registration_raises_without_echoing_the_response(self) -> None:
        transport = FakeTransport(lambda method, url, headers, body: ok_json({"ok": False, "description": "nope"}))
        with self.assertRaises(AppError) as ctx:
            register_webhook("https://tapi.bale.ai", TOKEN, "https://x.example/hook", transport)
        self.assertEqual(ctx.exception.code, "BALE_WEBHOOK_FAILED")

    def test_http_error_status_is_a_failure(self) -> None:
        transport = FakeTransport(lambda method, url, headers, body: HttpResponse(500, b""))
        with self.assertRaises(AppError):
            register_webhook("https://tapi.bale.ai", TOKEN, "https://x.example/hook", transport)


if __name__ == "__main__":
    unittest.main()
