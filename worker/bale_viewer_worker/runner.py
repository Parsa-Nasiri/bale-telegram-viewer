"""Drain-aware processing loop.

The loop stops claiming new work at `drain_after` and exits by `hard_stop`.
GitHub Actions kills any job at 6 hours, so `hard_stop` must stay below that.
A message that is still in flight when the process exits becomes visible again
after its visibility timeout, and the job state machine handles the retry.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from .config import Settings
from .pipeline import Pipeline
from .queue_ops import JOB_QUEUE, PAGE_QUEUE, QueueOps
from .store import Store
from .supabase_rest import StoreError

log = logging.getLogger(__name__)

SESSION_KEY = "telegram_session"


class Runner:
    def __init__(
        self,
        *,
        settings: Settings,
        store: Store,
        queue: QueueOps,
        source: Any,
        pipeline: Pipeline,
        stored_session: str = "",
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    ) -> None:
        self.settings = settings
        self.store = store
        self.queue = queue
        self.source = source
        self.pipeline = pipeline
        self._last_saved = stored_session
        self._clock = clock
        self._sleep = sleep

    def _beat(self, status: str) -> None:
        try:
            self.store.heartbeat(self.settings.worker_name, self.settings.run_id, status)
        except StoreError as exc:
            log.warning("heartbeat skipped: %s", exc)

    def _save_session(self) -> None:
        try:
            current = self.source.session_string()
        except Exception:  # noqa: BLE001 - never let a save problem stop processing
            log.warning("could not read the Telegram session string")
            return
        if current and current != self._last_saved:
            self.store.set_kv(SESSION_KEY, {"session": current})
            self._last_saved = current

    def _next_message(self) -> tuple[str, dict[str, Any]] | tuple[None, None]:
        vis = self.settings.queue_visibility_seconds
        page = self.queue.read_one(PAGE_QUEUE, vis)
        if page is not None:
            return "page", page
        job = self.queue.read_one(JOB_QUEUE, vis)
        if job is not None:
            return "job", job
        return None, None

    async def run(self, drain_after: int, hard_stop: int) -> None:
        start = self._clock()
        last_beat = -1e9
        last_save = start
        self._beat("running")
        try:
            while True:
                elapsed = self._clock() - start
                if elapsed >= drain_after or elapsed >= hard_stop:
                    log.info("drain deadline reached after %.0fs; stopping", elapsed)
                    break
                if elapsed - last_beat >= self.settings.heartbeat_interval_seconds:
                    self._beat("running")
                    last_beat = elapsed
                if elapsed - last_save >= self.settings.session_save_interval_seconds:
                    self._save_session()
                    last_save = elapsed
                try:
                    kind, item = self._next_message()
                    if item is None:
                        await self._sleep(self.settings.poll_interval_seconds)
                        continue
                    if kind == "page":
                        await self.pipeline.handle_page(item)
                    else:
                        await self.pipeline.handle_job(item)
                except StoreError as exc:
                    log.warning("store unavailable, backing off: %s", exc)
                    await self._sleep(self.settings.poll_interval_seconds)
        finally:
            self._save_session()
            self._beat("stopped")
