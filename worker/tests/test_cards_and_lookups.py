import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timezone

from bale_viewer_worker.bale_client import BaleClient
from bale_viewer_worker.card import (
    DOWNLOAD_QUESTION,
    CardInput,
    build_caption,
    confirm_keyboard,
    excerpt,
    format_size,
    format_tehran,
)
from bale_viewer_worker.config import Settings
from bale_viewer_worker.errors import AppError
from bale_viewer_worker.message_mapper import RawMessage, thumb_data_url, to_row
from bale_viewer_worker.pipeline import _LOOKUP_REPLIES, Pipeline
from bale_viewer_worker.queue_ops import JOB_QUEUE, LOOKUP_QUEUE, PAGE_QUEUE
from bale_viewer_worker.runner import Runner
from bale_viewer_worker.store import JOB_TABLE, LOOKUP_TABLE
from bale_viewer_worker.transport import HttpResponse

from tests.fakes import FakeBale, FakeQueue, FakeSource, FakeStore, FakeTransport, ok_json, photo

JOB_ID = "44444444-4444-4444-8444-444444444444"
JPEG = b"\xff\xd8\xff" + b"0" * 20
TOKEN = "123456:SECRET-TOKEN"


def _settings(temp_dir: str, **overrides) -> Settings:
    base = dict(
        supabase_url="https://x",
        supabase_service_role_key="k",
        bale_bot_token="t",
        page_size=25,
        max_attempts=3,
        download_timeout_seconds=5,
        max_download_size_bytes=50 * 1024 * 1024,
        temp_dir=temp_dir,
        poll_interval_seconds=1.0,
        heartbeat_interval_seconds=60,
        session_save_interval_seconds=900,
    )
    base.update(overrides)
    return Settings(**base)


def _text_message(message_id: int) -> RawMessage:
    return RawMessage(
        id=message_id,
        date=datetime(2026, 10, 17, 7, 0, tzinfo=timezone.utc),
        text="hello",
        grouped_id=None,
        sender_name=None,
        media_kind=None,
        file_name=None,
        mime_type=None,
        size_bytes=None,
    )


class CardTextTests(unittest.TestCase):
    def test_sizes_round_the_way_javascript_does(self):
        self.assertEqual(format_size(512), "512 بایت")
        self.assertEqual(format_size(2048), "2.0 کیلوبایت")
        self.assertEqual(format_size(2304), "2.3 کیلوبایت")  # 2.25 rounds up, as toFixed does
        self.assertEqual(format_size(5 * 1024 * 1024), "5.0 مگابایت")
        self.assertIsNone(format_size(None))

    def test_dates_are_shown_in_tehran_time(self):
        self.assertEqual(format_tehran(datetime(2026, 10, 19, 0, 0, tzinfo=timezone.utc)), "2026-10-19 03:30")
        self.assertEqual(format_tehran(datetime(2026, 10, 19, 21, 0, tzinfo=timezone.utc)), "2026-10-20 00:30")

    def test_excerpt_collapses_whitespace_and_cuts_long_text(self):
        self.assertEqual(excerpt("  سلام\n\n دنیا  "), "سلام دنیا")
        self.assertIsNone(excerpt(""))
        cut = excerpt("a" * 400)
        self.assertEqual(len(cut), 301)
        self.assertTrue(cut.endswith("…"))

    def test_caption_text_is_the_same_as_the_edge_function_builds(self):
        card = CardInput(
            channel_title="News",
            channel_username="news_channel",
            message_id=10,
            date=datetime(2026, 10, 19, tzinfo=timezone.utc),
            media_kind="document",
            file_name="a.pdf",
            size_bytes=2048,
            sender_name="Ali",
            text="hello   world",
        )
        self.assertEqual(
            build_caption(card, DOWNLOAD_QUESTION),
            "\n".join(
                [
                    "کانال: News",
                    "شناسه پیام: 10",
                    "تاریخ: 2026-10-19 03:30",
                    "نوع: فایل",
                    "نام فایل: a.pdf",
                    "حجم: 2.0 کیلوبایت",
                    "فرستنده: Ali",
                    "متن: hello world",
                    "",
                    "آیا این فایل برای شما ارسال شود؟",
                ]
            ),
        )

    def test_long_caption_fits_the_limit_and_keeps_the_question(self):
        card = CardInput(None, "news_channel", 10, None, "document", "x" * 2000, None, None, None)
        caption = build_caption(card, DOWNLOAD_QUESTION)
        self.assertLessEqual(len(caption), 1024)
        self.assertTrue(caption.startswith("کانال: @news_channel"))
        self.assertTrue(caption.endswith(DOWNLOAD_QUESTION))

    def test_keyboard_carries_the_job_id_in_both_buttons(self):
        self.assertEqual(
            confirm_keyboard(JOB_ID),
            {
                "inline_keyboard": [
                    [
                        {"text": "تأیید دانلود", "callback_data": f"dl:y:{JOB_ID}"},
                        {"text": "لغو", "callback_data": f"dl:n:{JOB_ID}"},
                    ]
                ]
            },
        )


class ThumbnailTests(unittest.TestCase):
    def test_jpeg_and_png_thumbnails_become_data_urls(self):
        self.assertTrue(thumb_data_url(JPEG).startswith("data:image/jpeg;base64,"))
        self.assertTrue(thumb_data_url(b"\x89PNG\r\n\x1a\n" + b"0" * 10).startswith("data:image/png;base64,"))

    def test_other_formats_and_oversized_images_are_dropped(self):
        self.assertIsNone(thumb_data_url(b"RIFF0000WEBPVP8 0000"))
        self.assertIsNone(thumb_data_url(None))
        self.assertIsNone(thumb_data_url(b"\xff\xd8\xff" + b"x" * 40_000))

    def test_thumbnail_is_stored_in_message_metadata_only_when_present(self):
        with_thumb = to_row(photo(10, thumb=JPEG), "ch")
        self.assertTrue(with_thumb["metadata"]["thumb"].startswith("data:image/jpeg"))
        self.assertNotIn("thumb", to_row(photo(10), "ch")["metadata"])


class BaleCardClientTests(unittest.TestCase):
    def _client(self, responder):
        transport = FakeTransport(responder)
        return BaleClient("https://tapi.bale.ai", TOKEN, transport), transport

    def test_send_photo_is_multipart_with_the_buttons(self):
        client, transport = self._client(lambda *a: ok_json({"ok": True, "result": {"message_id": 12}}))
        message_id = client.send_photo("5001", JPEG, "caption", confirm_keyboard(JOB_ID))
        self.assertEqual(message_id, "12")
        call = transport.calls[0]
        self.assertTrue(call["url"].endswith("/sendPhoto"))
        self.assertIn(b'name="photo"', call["body"])
        self.assertIn(b'name="reply_markup"', call["body"])
        self.assertIn(f"dl:y:{JOB_ID}".encode("utf-8"), call["body"])

    def test_send_message_posts_json_with_the_buttons(self):
        client, transport = self._client(lambda *a: ok_json({"ok": True, "result": {"message_id": 13}}))
        self.assertEqual(client.send_message("5001", "text", confirm_keyboard(JOB_ID)), "13")
        payload = json.loads(transport.calls[0]["body"])
        self.assertEqual(payload["chat_id"], "5001")
        self.assertEqual(payload["text"], "text")
        self.assertEqual(payload["reply_markup"], confirm_keyboard(JOB_ID))

    def test_a_refused_card_is_a_permanent_failure(self):
        client, _ = self._client(lambda *a: HttpResponse(400, b'{"ok": false}'))
        with self.assertRaises(AppError) as ctx:
            client.send_photo("5001", JPEG, "caption")
        self.assertEqual(ctx.exception.code, "BALE_SEND_FAILED")
        self.assertFalse(ctx.exception.retryable)

    def test_a_connection_failure_on_a_card_is_retryable(self):
        from bale_viewer_worker.transport import TransportError

        client, _ = self._client(lambda *a: TransportError("unknown", "reset"))
        with self.assertRaises(AppError) as ctx:
            client.send_message("5001", "text")
        self.assertTrue(ctx.exception.retryable)


class LookupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = FakeStore()
        self.queue = FakeQueue()
        self.source = FakeSource()
        self.bale = FakeBale()
        self.settings = _settings(self.tmp.name)
        self.store.users["u1"] = {"id": "u1", "bale_chat_id": "5001", "display_name": "A"}
        self.store.add_lookup({"id": "L1", "user_id": "u1", "username": "chan", "message_id": 10})
        self.source.message = photo(10, thumb=JPEG)

    def tearDown(self):
        self.tmp.cleanup()

    def _pipeline(self) -> Pipeline:
        return Pipeline(settings=self.settings, store=self.store, queue=self.queue, source=self.source, bale=self.bale)

    def _run(self, lookup_id: str = "L1", msg_id: int = 3) -> None:
        asyncio.run(self._pipeline().handle_lookup({"msg_id": msg_id, "message": {"lookup_id": lookup_id}}))

    def test_lookup_sends_a_thumbnail_card_with_buttons_and_queues_nothing(self):
        self._run()
        self.assertEqual(self.store.tables[LOOKUP_TABLE]["L1"]["status"], "succeeded")
        job = self.store.inserted_jobs[0]
        self.assertEqual(job["status"], "awaiting_confirmation")
        self.assertEqual(job["message_id"], 10)

        card = self.bale.cards[0]
        self.assertEqual(card["kind"], "photo")
        self.assertEqual(card["chat_id"], "5001")
        self.assertEqual(card["reply_markup"], confirm_keyboard(job["id"]))
        self.assertIn("شناسه پیام: 10", card["caption"])
        self.assertTrue(card["caption"].endswith(DOWNLOAD_QUESTION))
        self.assertEqual(self.store.confirm_messages[job["id"]], "901")
        self.assertEqual(self.source.download_calls, 0)
        self.assertTrue(self.store.messages[-1]["metadata"]["thumb"].startswith("data:image/jpeg"))
        self.assertEqual(self.queue.deleted, [3])

    def test_text_message_gets_a_card_without_buttons(self):
        self.source.message = _text_message(11)
        self.store.add_lookup({"id": "L2", "user_id": "u1", "username": "chan", "message_id": 11})
        self._run("L2")
        self.assertEqual(self.store.inserted_jobs, [])
        self.assertEqual(self.bale.cards[0]["kind"], "message")
        self.assertIsNone(self.bale.cards[0]["reply_markup"])
        self.assertFalse(self.bale.cards[0]["text"].endswith(DOWNLOAD_QUESTION))

    def test_file_over_the_limit_is_shown_without_buttons(self):
        self.source.message = photo(10, size=60 * 1024 * 1024)
        self._run()
        self.assertEqual(self.store.inserted_jobs, [])
        self.assertIsNone(self.bale.cards[0]["reply_markup"])

    def test_refused_photo_falls_back_to_the_text_card(self):
        self.bale.photo_error = AppError("BALE_SEND_FAILED", "bale error 400")
        self._run()
        job = self.store.inserted_jobs[0]
        self.assertEqual(self.bale.cards[0]["kind"], "message")
        self.assertEqual(self.bale.cards[0]["reply_markup"], confirm_keyboard(job["id"]))
        self.assertEqual(self.store.tables[LOOKUP_TABLE]["L1"]["status"], "succeeded")

    def test_a_second_lookup_of_the_same_message_reuses_the_awaiting_job(self):
        self.store.add_lookup({"id": "L2", "user_id": "u1", "username": "chan", "message_id": 10})
        self._run("L1", 3)
        self._run("L2", 4)
        self.assertEqual(len(self.store.inserted_jobs), 1)
        first, second = self.bale.cards
        self.assertEqual(first["reply_markup"], second["reply_markup"])

    def test_missing_message_fails_and_tells_the_user(self):
        self.source.message = None
        self._run()
        row = self.store.tables[LOOKUP_TABLE]["L1"]
        self.assertEqual((row["status"], row["error_code"]), ("failed", "MESSAGE_NOT_FOUND"))
        self.assertEqual(self.bale.cards[0]["text"], _LOOKUP_REPLIES["MESSAGE_NOT_FOUND"])
        self.assertEqual(self.store.inserted_jobs, [])
        self.assertEqual(self.queue.deleted, [3])

    def test_unknown_channel_fails_and_tells_the_user(self):
        self.source.resolve_result = AppError("CHANNEL_NOT_FOUND")
        self._run()
        self.assertEqual(self.store.tables[LOOKUP_TABLE]["L1"]["error_code"], "CHANNEL_NOT_FOUND")
        self.assertEqual(self.bale.cards[0]["text"], _LOOKUP_REPLIES["CHANNEL_NOT_FOUND"])

    def test_rate_limit_requeues_the_lookup_quietly(self):
        self.source.resolve_result = AppError("TELEGRAM_RATE_LIMIT", retryable=True, retry_after=60)
        self._run()
        self.assertEqual(self.store.tables[LOOKUP_TABLE]["L1"]["status"], "queued")
        self.assertEqual(self.queue.visibility, {3: 60})
        self.assertEqual(self.queue.deleted, [])
        self.assertEqual(self.bale.cards, [])

    def test_user_without_a_bale_chat_fails_without_a_reply(self):
        self.store.users["u1"]["bale_chat_id"] = None
        self._run()
        row = self.store.tables[LOOKUP_TABLE]["L1"]
        self.assertEqual((row["status"], row["error_code"]), ("failed", "BALE_CHAT_REQUIRED"))
        self.assertEqual(self.bale.cards, [])

    def test_finished_lookup_is_acknowledged_without_work(self):
        self.store.add_lookup({"id": "L3", "user_id": "u1", "username": "chan", "message_id": 10, "status": "succeeded"})
        self._run("L3")
        self.assertEqual(self.source.resolve_calls, [])
        self.assertEqual(self.queue.deleted, [3])

    def test_an_awaiting_or_declined_job_is_never_run_from_the_queue(self):
        for status in ("awaiting_confirmation", "declined"):
            with self.subTest(status=status):
                self.store.add_job(
                    {"id": f"J-{status}", "user_id": "u1", "channel_id": "ch-1001", "message_id": 10, "status": status}
                )
                asyncio.run(
                    self._pipeline().handle_job({"msg_id": 9, "message": {"job_id": f"J-{status}"}})
                )
                self.assertEqual(self.source.download_calls, 0)
                self.assertEqual(self.store.tables[JOB_TABLE][f"J-{status}"]["status"], status)
                self.assertEqual(self.queue.deleted[-1], 9)


class RunnerLookupOrderTests(unittest.TestCase):
    def test_pages_then_lookups_then_jobs(self):
        order: list = []
        read_names: list[str] = []

        class Q(FakeQueue):
            def read_one(self, queue_name, visibility_seconds):
                name = {PAGE_QUEUE: "page", LOOKUP_QUEUE: "lookup", JOB_QUEUE: "job"}[queue_name]
                if name in read_names:
                    return None
                read_names.append(name)
                return {"msg_id": len(read_names), "message": {}}

        class Pipe:
            async def handle_page(self, msg):
                order.append(("page", msg["msg_id"]))

            async def handle_lookup(self, msg):
                order.append(("lookup", msg["msg_id"]))

            async def handle_job(self, msg):
                order.append(("job", msg["msg_id"]))

        clock = {"now": 0.0}

        async def fake_sleep(seconds):
            clock["now"] += seconds

        with tempfile.TemporaryDirectory() as tmp:
            runner = Runner(
                settings=_settings(tmp, poll_interval_seconds=5.0),
                store=FakeStore(),
                queue=Q(),
                source=FakeSource(),
                pipeline=Pipe(),
                clock=lambda: clock["now"],
                sleep=fake_sleep,
            )
            asyncio.run(runner.run(drain_after=2, hard_stop=100))
        self.assertEqual(order[:3], [("page", 1), ("lookup", 2), ("job", 3)])


if __name__ == "__main__":
    unittest.main()
