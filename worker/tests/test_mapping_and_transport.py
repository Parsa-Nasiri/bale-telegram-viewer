import http.server
import socket
import threading
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace

from bale_viewer_worker.message_mapper import RawMessage, to_row
from bale_viewer_worker.telegram_source import to_raw
from bale_viewer_worker.transport import TransportError, UrllibTransport


def _tg(**overrides):
    base = dict(
        id=42,
        date=datetime(2026, 10, 17, 7, 0, tzinfo=timezone.utc),
        message="hello",
        grouped_id=None,
        post_author=None,
        photo=None,
        sticker=None,
        voice=None,
        audio=None,
        gif=None,
        video=None,
        document=None,
        media=None,
        file=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


class MessageMappingTests(unittest.TestCase):
    def test_text_message_has_no_media_and_is_not_available(self):
        raw = to_raw(_tg())
        self.assertIsNone(raw.media_kind)
        row = to_row(raw, "ch-1")
        self.assertIsNone(row["media_type"])
        self.assertFalse(row["metadata"]["available"])
        self.assertEqual(row["text"], "hello")

    def test_document_is_detected_with_file_metadata(self):
        file = SimpleNamespace(name="report.pdf", mime_type="application/pdf", size=2_400_000)
        raw = to_raw(_tg(document=object(), media=object(), file=file, message=""))
        self.assertEqual(raw.media_kind, "document")
        row = to_row(raw, "ch-1")
        self.assertTrue(row["metadata"]["available"])
        self.assertEqual(row["metadata"]["file_name"], "report.pdf")
        self.assertIsNone(row["text"])

    def test_gif_is_animation_even_though_it_is_also_a_video(self):
        raw = to_raw(_tg(gif=True, video=True, media=object()))
        self.assertEqual(raw.media_kind, "animation")

    def test_unsupported_media_is_unknown_and_not_available(self):
        raw = to_raw(_tg(media=object()))
        self.assertEqual(raw.media_kind, "unknown")
        self.assertFalse(to_row(raw, "ch-1")["metadata"]["available"])

    def test_naive_datetime_is_treated_as_utc(self):
        raw = RawMessage(1, datetime(2026, 1, 1, 12, 0), "", None, None, None, None, None, None)
        self.assertEqual(to_row(raw, "c")["date"], "2026-01-01T12:00:00+00:00")


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        status = 500 if self.path.endswith("/fail") else 200
        body = b'{"ok": true}'
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # silence test output
        pass


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_success_returns_status_and_body(self):
        resp = UrllibTransport().request("GET", f"http://127.0.0.1:{self.port}/ok", timeout=5)
        self.assertEqual(resp.status, 200)
        self.assertIn(b"ok", resp.body)

    def test_http_error_status_is_returned_not_raised(self):
        resp = UrllibTransport().request("GET", f"http://127.0.0.1:{self.port}/fail", timeout=5)
        self.assertEqual(resp.status, 500)

    def test_refused_connection_is_classified_as_not_sent(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        with self.assertRaises(TransportError) as ctx:
            UrllibTransport().request("GET", f"http://127.0.0.1:{port}/", timeout=2)
        self.assertEqual(ctx.exception.kind, "not_sent")
        self.assertNotIn("127.0.0.1", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
