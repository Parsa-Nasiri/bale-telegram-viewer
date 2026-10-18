import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from bale_viewer_worker.config import Settings
from bale_viewer_worker.errors import AppError
from bale_viewer_worker.github_chain import RunInfo
from bale_viewer_worker.pipeline import Pipeline
from bale_viewer_worker.queue_ops import JOB_QUEUE, PAGE_QUEUE
from bale_viewer_worker.runner import SESSION_KEY, Runner
from bale_viewer_worker.watchdog import decide

from tests.fakes import FakeBale, FakeQueue, FakeSource, FakeStore, photo


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


class PageRequestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = FakeStore()
        self.queue = FakeQueue()
        self.source = FakeSource()
        self.settings = _settings(self.tmp.name)
        self.pipeline = Pipeline(
            settings=self.settings, store=self.store, queue=self.queue, source=self.source, bale=FakeBale()
        )

    def tearDown(self):
        self.tmp.cleanup()

    def _run(self, request_id, msg_id=1):
        asyncio.run(self.pipeline.handle_page({"msg_id": msg_id, "message": {"request_id": request_id}}))

    def test_open_request_resolves_channel_caches_messages_and_succeeds(self):
        req = self.store.add_page({"id": "r1", "kind": "open", "username": "chan"})
        self.source.pages = [photo(30), photo(29), photo(28)]
        self._run("r1")
        self.assertEqual(req["status"], "succeeded")
        self.assertEqual(req["channel_id"], "ch-1001")
        self.assertEqual(len(self.store.messages), 3)
        self.assertTrue(self.store.get_sync("ch-1001")["history_exhausted"])
        self.assertEqual(self.store.get_sync("ch-1001")["newest_message_id"], 30)
        self.assertEqual(self.queue.deleted, [1])

    def test_unknown_channel_fails_permanently(self):
        req = self.store.add_page({"id": "r2", "kind": "open", "username": "nope"})
        self.source.resolve_result = AppError("CHANNEL_NOT_FOUND")
        self._run("r2")
        self.assertEqual(req["status"], "failed")
        self.assertEqual(req["error_code"], "CHANNEL_NOT_FOUND")
        self.assertEqual(self.queue.deleted, [1])

    def test_older_request_uses_cursor_and_marks_exhausted_when_short(self):
        self.store.channels["ch-9"] = {"id": "ch-9", "telegram_peer_id": "9", "username": "x", "title": "x"}
        req = self.store.add_page({"id": "r3", "kind": "older", "channel_id": "ch-9", "before_message_id": 100})
        self.source.pages = [photo(99), photo(98)]
        self._run("r3")
        self.assertEqual(self.source.fetch_calls, [(100, 25)])
        self.assertEqual(req["status"], "succeeded")
        self.assertTrue(self.store.get_sync("ch-9")["history_exhausted"])
        self.assertEqual(self.store.get_sync("ch-9")["oldest_message_id"], 98)

    def test_full_page_leaves_history_open(self):
        self.store.channels["ch-9"] = {"id": "ch-9", "telegram_peer_id": "9", "username": "x", "title": "x"}
        self.store.add_page({"id": "r4", "kind": "older", "channel_id": "ch-9", "before_message_id": 500})
        self.source.pages = [photo(i) for i in range(499, 474, -1)]
        self._run("r4")
        self.assertFalse(self.store.get_sync("ch-9")["history_exhausted"])

    def test_rate_limit_requeues_with_telegram_retry_after(self):
        req = self.store.add_page({"id": "r5", "kind": "older", "channel_id": "ch-9", "before_message_id": 5})
        self.store.channels["ch-9"] = {"id": "ch-9", "telegram_peer_id": "9", "username": "x", "title": "x"}
        self.source.pages = AppError("TELEGRAM_RATE_LIMIT", retryable=True, retry_after=120)
        self._run("r5")
        self.assertEqual(req["status"], "queued")
        self.assertEqual(self.queue.visibility, {1: 120})
        self.assertEqual(self.queue.deleted, [])

    def test_retry_budget_exhaustion_fails_the_request(self):
        self.store.channels["ch-9"] = {"id": "ch-9", "telegram_peer_id": "9", "username": "x", "title": "x"}
        req = self.store.add_page({"id": "r6", "kind": "older", "channel_id": "ch-9", "attempts": 2})
        self.source.pages = AppError("INTERNAL_ERROR", retryable=True)
        self._run("r6")
        self.assertEqual(req["status"], "failed")
        self.assertEqual(self.queue.deleted, [1])

    def test_already_finished_request_is_acknowledged_without_work(self):
        self.store.add_page({"id": "r7", "kind": "open", "username": "chan", "status": "succeeded"})
        self._run("r7")
        self.assertEqual(self.source.fetch_calls, [])
        self.assertEqual(self.queue.deleted, [1])


class DownloadJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = FakeStore()
        self.queue = FakeQueue()
        self.source = FakeSource()
        self.bale = FakeBale("777")
        self.settings = _settings(os.path.join(self.tmp.name, "work"))
        self.store.users["u1"] = {"id": "u1", "bale_chat_id": "5001", "display_name": "A"}
        self.store.channels["ch-1"] = {"id": "ch-1", "telegram_peer_id": "1001", "username": "chan", "title": "Chan"}
        self.source.message = photo(10)

    def tearDown(self):
        self.tmp.cleanup()

    def _job(self, **overrides):
        base = {"id": "j1", "user_id": "u1", "channel_id": "ch-1", "message_id": 10}
        base.update(overrides)
        return self.store.add_job(base)

    def _run(self, job_id="j1", msg_id=7):
        pipeline = Pipeline(
            settings=self.settings, store=self.store, queue=self.queue, source=self.source, bale=self.bale
        )
        asyncio.run(pipeline.handle_job({"msg_id": msg_id, "message": {"job_id": job_id}}))

    def test_successful_delivery_stores_bale_id_and_cleans_temp_files(self):
        job = self._job()
        self._run()
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(job["bale_message_id"], "777")
        self.assertEqual(self.bale.sent[0]["chat_id"], "5001")
        self.assertTrue(self.bale.sent[0]["exists"])
        self.assertEqual(os.listdir(self.settings.temp_dir), [])
        self.assertEqual(self.queue.deleted, [7])

    def test_user_without_bale_chat_fails_without_downloading(self):
        self.store.users["u1"]["bale_chat_id"] = None
        job = self._job()
        self._run()
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["error_code"], "BALE_CHAT_REQUIRED")
        self.assertEqual(self.source.download_calls, 0)

    def test_file_over_limit_is_rejected_before_download(self):
        self.source.message = photo(10, size=60 * 1024 * 1024)
        job = self._job()
        self._run()
        self.assertEqual(job["error_code"], "FILE_TOO_LARGE")
        self.assertEqual(self.source.download_calls, 0)

    def test_retryable_bale_error_requeues_with_backoff_and_keeps_message(self):
        self.bale.result = AppError("BALE_SEND_FAILED", "bale error 503", retryable=True)
        job = self._job()
        self._run()
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["attempts"], 1)
        self.assertEqual(self.queue.visibility, {7: 30})
        self.assertEqual(self.queue.deleted, [])

    def test_ambiguous_send_is_never_retried(self):
        self.bale.result = AppError("BALE_SEND_AMBIGUOUS", "gateway 504")
        job = self._job()
        self._run()
        self.assertEqual(job["status"], "ambiguous")
        self.assertEqual(self.queue.visibility, {})
        self.assertEqual(self.queue.deleted, [7])

    def test_job_left_in_uploading_by_a_dead_run_becomes_ambiguous_without_sending(self):
        job = self._job(status="uploading", attempts=1)
        self._run()
        self.assertEqual(job["status"], "ambiguous")
        self.assertEqual(self.bale.sent, [])

    def test_job_left_in_downloading_is_safely_retried(self):
        job = self._job(status="downloading", attempts=1)
        self._run()
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual(len(self.bale.sent), 1)

    def test_duplicate_delivery_of_a_finished_job_does_not_resend(self):
        job = self._job(status="succeeded", bale_message_id="1")
        self._run()
        self.assertEqual(self.bale.sent, [])
        self.assertEqual(job["status"], "succeeded")

    def test_retry_budget_is_enforced(self):
        self.bale.result = AppError("BALE_SEND_FAILED", "bale error 500", retryable=True)
        job = self._job(attempts=2)
        self._run()
        self.assertEqual(job["status"], "failed")
        self.assertEqual(self.queue.deleted, [7])

    def test_download_timeout_is_retryable(self):
        self.settings = _settings(os.path.join(self.tmp.name, "work"), download_timeout_seconds=0)
        self.source.download_delay = 0.2
        job = self._job()
        self._run()
        self.assertEqual(job["error_code"], "DOWNLOAD_TIMEOUT")
        self.assertEqual(job["status"], "queued")


class _FakeRunnerPipeline:
    def __init__(self):
        self.pages = []
        self.jobs = []

    async def handle_page(self, msg):
        self.pages.append(msg)

    async def handle_job(self, msg):
        self.jobs.append(msg)


class RunnerTests(unittest.TestCase):
    def _runner(self, queue, pipeline, store=None, source=None, stored=""):
        clock = {"now": 0.0}
        sleeps = []

        async def fake_sleep(seconds):
            sleeps.append(seconds)
            clock["now"] += seconds

        settings = _settings(tempfile.gettempdir(), poll_interval_seconds=5.0, heartbeat_interval_seconds=60)
        runner = Runner(
            settings=settings,
            store=store or FakeStore(),
            queue=queue,
            source=source or FakeSource(),
            pipeline=pipeline,
            stored_session=stored,
            clock=lambda: clock["now"],
            sleep=fake_sleep,
        )
        return runner, clock, sleeps

    def test_loop_stops_claiming_at_drain_deadline(self):
        queue = FakeQueue()
        pipeline = _FakeRunnerPipeline()
        store = FakeStore()
        runner, clock, _ = self._runner(queue, pipeline, store)
        asyncio.run(runner.run(drain_after=100, hard_stop=200))
        self.assertGreaterEqual(clock["now"], 100)
        self.assertLess(clock["now"], 110)
        self.assertEqual(store.heartbeats[0][2], "running")
        self.assertEqual(store.heartbeats[-1][2], "stopped")

    def test_page_requests_are_served_before_jobs(self):
        order = []

        class Q(FakeQueue):
            def read_one(self, queue_name, visibility_seconds):
                if queue_name == PAGE_QUEUE and "page" not in order:
                    order.append("page")
                    return {"msg_id": 1, "message": {"request_id": "r"}}
                if queue_name == JOB_QUEUE and "job" not in order:
                    order.append("job")
                    return {"msg_id": 2, "message": {"job_id": "j"}}
                return None

        class Pipe(_FakeRunnerPipeline):
            async def handle_page(self, msg):
                order.append(("handled-page", msg["msg_id"]))

            async def handle_job(self, msg):
                order.append(("handled-job", msg["msg_id"]))

        runner, _, _ = self._runner(Q(), Pipe())
        asyncio.run(runner.run(drain_after=6, hard_stop=100))
        self.assertEqual(order[:2], ["page", ("handled-page", 1)])
        self.assertIn(("handled-job", 2), order)
        self.assertLess(order.index(("handled-page", 1)), order.index(("handled-job", 2)))

    def test_session_is_saved_only_when_it_changes(self):
        store = FakeStore()
        source = FakeSource()  # returns "session-v1"
        runner, clock, _ = self._runner(FakeQueue(), _FakeRunnerPipeline(), store, source, stored="session-v1")
        asyncio.run(runner.run(drain_after=10, hard_stop=100))
        self.assertNotIn(SESSION_KEY, store.kv)

    def test_new_session_string_is_persisted_on_exit(self):
        store = FakeStore()
        source = FakeSource()
        runner, clock, _ = self._runner(FakeQueue(), _FakeRunnerPipeline(), store, source, stored="old")
        asyncio.run(runner.run(drain_after=10, hard_stop=100))
        self.assertEqual(store.kv[SESSION_KEY], {"session": "session-v1"})


class WatchdogDecisionTests(unittest.TestCase):
    NOW = datetime(2026, 10, 17, 12, 0, tzinfo=timezone.utc)

    def _run(self, run_id, minutes_ago, status="in_progress", conclusion=None):
        started = self.NOW - timedelta(minutes=minutes_ago)
        return RunInfo(run_id, status, conclusion, started, started)

    def _hb(self, run_id, minutes_ago):
        return {"run_id": str(run_id), "updated_at": (self.NOW - timedelta(minutes=minutes_ago)).isoformat()}

    def test_no_runs_means_dispatch(self):
        decision = decide(self.NOW, [], None, [])
        self.assertTrue(decision.dispatch)

    def test_young_run_is_left_alone(self):
        decision = decide(self.NOW, [self._run(1, 3)], None, [])
        self.assertEqual(decision.cancel_run_ids, [])
        self.assertFalse(decision.dispatch)

    def test_old_run_with_fresh_heartbeat_is_healthy(self):
        decision = decide(self.NOW, [self._run(1, 90)], self._hb(1, 2), [])
        self.assertEqual(decision.cancel_run_ids, [])
        self.assertFalse(decision.dispatch)

    def test_old_run_with_stale_heartbeat_is_cancelled_and_replaced(self):
        decision = decide(self.NOW, [self._run(1, 90)], self._hb(1, 30), [])
        self.assertEqual(decision.cancel_run_ids, [1])
        self.assertTrue(decision.dispatch)

    def test_waiting_successor_prevents_duplicate_dispatch(self):
        runs = [self._run(1, 90), self._run(2, 0, status="queued")]
        decision = decide(self.NOW, runs, self._hb(1, 30), [])
        self.assertEqual(decision.cancel_run_ids, [1])
        self.assertFalse(decision.dispatch)

    def test_three_failed_runs_block_automatic_restart(self):
        recent = [self._run(i, 5 * i, status="completed", conclusion="failure") for i in (1, 2, 3)]
        decision = decide(self.NOW, [], None, recent)
        self.assertFalse(decision.dispatch)
        self.assertIn("blocked", decision.reason)


if __name__ == "__main__":
    unittest.main()
