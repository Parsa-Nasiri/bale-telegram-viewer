import asyncio
import tempfile
import unittest
from datetime import datetime, timezone

from bale_viewer_worker.config import Settings
from bale_viewer_worker.message_mapper import RawMessage
from bale_viewer_worker.pipeline import MAX_REFRESH_PAGES, Pipeline
from bale_viewer_worker.supabase_rest import StoreError
from bale_viewer_worker.thumb_store import BUCKET, ThumbStore, thumb_path
from bale_viewer_worker.thumbs import MAX_THUMB_BYTES, MAX_THUMB_SIDE, ThumbOption, choose_thumb, image_extension
from bale_viewer_worker.transport import HttpResponse, TransportError

from tests.fakes import FakeBale, FakeQueue, FakeSource, FakeStore, FakeThumbs, FakeTransport, photo

JPEG = b"\xff\xd8\xff" + b"0" * 20


def _settings(temp_dir: str, page_size: int = 25) -> Settings:
    return Settings(
        supabase_url="https://x",
        supabase_service_role_key="k",
        temp_dir=temp_dir,
        page_size=page_size,
        max_attempts=3,
    )


def _option(index, side, size=None):
    return ThumbOption(index=index, width=side, height=side, size=size)


class ChooseThumbTests(unittest.TestCase):
    def test_picks_the_largest_size_that_fits(self):
        options = [_option(0, 90, 1_000), _option(1, 320, 20_000), _option(2, 800, 90_000), _option(3, 1280, 300_000)]
        self.assertEqual(choose_thumb(options), 2)

    def test_a_size_over_the_side_limit_is_not_chosen(self):
        options = [_option(0, 90), _option(1, MAX_THUMB_SIDE + 1)]
        self.assertEqual(choose_thumb(options), 0)

    def test_a_size_over_the_byte_limit_is_not_chosen(self):
        options = [_option(0, 320, 20_000), _option(1, 800, MAX_THUMB_BYTES + 1)]
        self.assertEqual(choose_thumb(options), 0)

    def test_when_nothing_fits_the_smallest_size_is_used(self):
        options = [_option(0, 1280, 300_000), _option(1, 2560, 900_000)]
        self.assertEqual(choose_thumb(options), 0)

    def test_no_sizes_means_no_thumbnail(self):
        self.assertIsNone(choose_thumb([]))

    def test_unknown_byte_count_still_counts_as_fitting(self):
        self.assertEqual(choose_thumb([_option(0, 90), _option(1, 320, None)]), 1)


class ImageExtensionTests(unittest.TestCase):
    def test_jpeg_and_png_are_kept(self):
        self.assertEqual(image_extension(JPEG), "jpg")
        self.assertEqual(image_extension(b"\x89PNG\r\n\x1a\n" + b"0" * 10), "png")

    def test_other_formats_and_empty_data_are_not_kept(self):
        self.assertIsNone(image_extension(b"RIFF0000WEBPVP8 0000"))
        self.assertIsNone(image_extension(b""))
        self.assertIsNone(image_extension(None))


class ThumbStoreTests(unittest.TestCase):
    def _store(self, responder):
        transport = FakeTransport(responder)
        return ThumbStore("https://abc.supabase.co", "SERVICE", transport), transport

    def test_put_uploads_the_bytes_with_upsert_to_the_thumbs_bucket(self):
        store, transport = self._store(lambda *a: HttpResponse(200, b"{}"))
        store.put("ch-1/10.jpg", JPEG, "image/jpeg")
        call = transport.calls[0]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["url"], f"https://abc.supabase.co/storage/v1/object/{BUCKET}/ch-1/10.jpg")
        self.assertEqual(call["body"], JPEG)
        self.assertEqual(call["headers"]["x-upsert"], "true")
        self.assertEqual(call["headers"]["Content-Type"], "image/jpeg")
        self.assertEqual(call["headers"]["Authorization"], "Bearer SERVICE")

    def test_a_refused_upload_raises(self):
        store, _ = self._store(lambda *a: HttpResponse(403, b'{"message":"denied"}'))
        with self.assertRaises(StoreError):
            store.put("ch-1/10.jpg", JPEG, "image/jpeg")

    def test_a_connection_failure_raises_without_the_key(self):
        store, _ = self._store(lambda *a: TransportError("unknown", "reset"))
        with self.assertRaises(StoreError) as ctx:
            store.put("ch-1/10.jpg", JPEG, "image/jpeg")
        self.assertNotIn("SERVICE", str(ctx.exception))

    def test_thumb_path_is_channel_and_message(self):
        self.assertEqual(thumb_path("ch-1", 10, "jpg"), "ch-1/10.jpg")


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = FakeStore()
        self.queue = FakeQueue()
        self.source = FakeSource()
        self.thumbs = FakeThumbs()
        self.settings = _settings(self.tmp.name, page_size=3)

    def tearDown(self):
        self.tmp.cleanup()

    def _pipeline(self) -> Pipeline:
        return Pipeline(
            settings=self.settings,
            store=self.store,
            queue=self.queue,
            source=self.source,
            bale=FakeBale(),
            thumbs=self.thumbs,
        )

    def _run(self, request_id: str) -> None:
        asyncio.run(self._pipeline().handle_page({"msg_id": 1, "message": {"request_id": request_id}}))

    def _open_request(self, request_id: str = "r1") -> dict:
        return self.store.add_page({"id": request_id, "kind": "open", "username": "chan"})

    def test_a_refresh_reads_back_until_it_reaches_cached_messages(self):
        # Cache knows messages up to 10. The channel now has 17 new messages (page size 3).
        self.store.save_sync("ch-1001", newest=10, oldest=8, exhausted=False)
        self.source.page_queue = [
            [photo(20), photo(19), photo(18)],
            [photo(17), photo(16), photo(15)],
            [photo(14), photo(13), photo(12)],
            [photo(11), photo(10), photo(9)],
        ]
        self._open_request()
        self._run("r1")
        stored_ids = sorted(row["message_id"] for row in self.store.messages)
        self.assertEqual(stored_ids, [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
        self.assertEqual(self.source.fetch_calls, [(None, 3), (18, 3), (15, 3), (12, 3)])
        self.assertEqual(self.store.tables["page_requests"]["r1"]["status"], "succeeded")

    def test_a_refresh_stops_after_the_page_limit_when_the_gap_is_huge(self):
        self.store.save_sync("ch-1001", newest=1, oldest=1, exhausted=False)
        self.source.page_queue = [[photo(100 - i * 3), photo(99 - i * 3), photo(98 - i * 3)] for i in range(10)]
        self._open_request()
        self._run("r1")
        self.assertEqual(len(self.source.fetch_calls), MAX_REFRESH_PAGES)

    def test_a_refresh_without_cached_messages_reads_only_the_newest_page(self):
        self.source.pages = [photo(30), photo(29), photo(28)]
        self._open_request()
        self._run("r1")
        self.assertEqual(self.source.fetch_calls, [(None, 3)])

    def test_a_refresh_that_already_overlaps_the_cache_reads_one_page(self):
        self.store.save_sync("ch-1001", newest=29, oldest=20, exhausted=False)
        self.source.pages = [photo(30), photo(29), photo(28)]
        self._open_request()
        self._run("r1")
        self.assertEqual(self.source.fetch_calls, [(None, 3)])

    def test_a_failed_thumbnail_upload_keeps_the_message_without_a_thumbnail(self):
        self.thumbs.error = OSError("storage down")
        self.source.pages = [photo(30, thumb=JPEG)]
        self._open_request()
        self._run("r1")
        row = self.store.messages[0]
        self.assertEqual(row["message_id"], 30)
        self.assertNotIn("thumb_path", row["metadata"])
        self.assertEqual(self.store.tables["page_requests"]["r1"]["status"], "succeeded")

    def test_thumbnails_are_stored_under_the_channel_and_message(self):
        self.source.pages = [photo(30, thumb=JPEG), photo(29)]
        self._open_request()
        self._run("r1")
        self.assertEqual(self.thumbs.puts, [("ch-1001/30.jpg", JPEG, "image/jpeg")])
        self.assertEqual(self.store.messages[0]["metadata"]["thumb_path"], "ch-1001/30.jpg")


class ThumbOptionsTests(unittest.TestCase):
    """Telegram's size objects, copied as plain namespaces: telegram_source reads only these attributes."""

    def _size(self, **fields):
        from types import SimpleNamespace

        return SimpleNamespace(**fields)

    def test_photo_sizes_keep_their_index_and_skip_stripped_and_empty_sizes(self):
        from types import SimpleNamespace

        from bale_viewer_worker.telegram_source import _thumb_options

        sizes = [
            self._size(bytes=b"x" * 40),  # stripped: no dimensions
            self._size(type="s", w=90, h=90, size=1_200),
            self._size(type="m", w=320, h=240, size=18_000),
            self._size(type="x", w=800, h=600, size=95_000),
            self._size(type="y", w=1280, h=960, sizes=[300_000, 310_000]),  # progressive: byte counts in a list
        ]
        message = SimpleNamespace(photo=SimpleNamespace(sizes=sizes), document=None)
        options = _thumb_options(message)
        self.assertEqual([option.index for option in options], [1, 2, 3, 4])
        self.assertEqual(options[2], ThumbOption(index=3, width=800, height=600, size=95_000))
        self.assertEqual(choose_thumb(options), 3)  # the 1280 px size is over the side limit

    def test_a_video_uses_the_document_thumbnails(self):
        from types import SimpleNamespace

        from bale_viewer_worker.telegram_source import _thumb_options

        thumbs = [self._size(type="m", w=320, h=180, size=24_000)]
        message = SimpleNamespace(photo=None, document=SimpleNamespace(thumbs=thumbs))
        self.assertEqual(choose_thumb(_thumb_options(message)), 0)

    def test_a_message_without_thumbnails_has_none(self):
        from types import SimpleNamespace

        from bale_viewer_worker.telegram_source import _thumb_options

        message = SimpleNamespace(photo=None, document=SimpleNamespace(thumbs=None))
        self.assertIsNone(choose_thumb(_thumb_options(message)))
