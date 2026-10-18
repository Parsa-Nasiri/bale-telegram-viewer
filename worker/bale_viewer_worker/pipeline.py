"""Handles one queue message at a time: channel pages and file deliveries.

Safety rules enforced here:
* every state change is a compare-and-set in the database;
* a job whose previous attempt reached "uploading" is marked ambiguous and is never resent automatically;
* retries only happen for failures where the file was provably not delivered.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from typing import Any

from .bale_client import BaleClient
from .config import Settings
from .errors import AppError
from .message_mapper import RawMessage, to_row
from .policy import backoff_seconds, sanitize_filename
from .queue_ops import JOB_QUEUE, PAGE_QUEUE, QueueOps
from .store import JOB_TABLE, PAGE_TABLE, Store

log = logging.getLogger(__name__)
_CAPTION_LIMIT = 1024


class _Conflict(Exception):
    """Another writer changed the row first. Stop without touching it."""


def _caption(raw: RawMessage, channel: dict[str, Any]) -> str:
    text = (raw.text or "").strip()
    return (text or channel.get("title") or "")[:_CAPTION_LIMIT]


class Pipeline:
    def __init__(
        self,
        *,
        settings: Settings,
        store: Store,
        queue: QueueOps,
        source: Any,
        bale: BaleClient,
    ) -> None:
        self.settings = settings
        self.store = store
        self.queue = queue
        self.source = source
        self.bale = bale

    # ----------------------------------------------------------------- channel pages
    async def handle_page(self, msg: dict[str, Any]) -> None:
        msg_id = msg["msg_id"]
        request_id = (msg.get("message") or {}).get("request_id")
        req = self.store.get_page_request(request_id) if request_id else None
        if req is None or req["status"] in ("succeeded", "failed"):
            self.queue.delete(PAGE_QUEUE, msg_id)
            return
        if not self.store.cas(PAGE_TABLE, req, "processing", attempts=req["attempts"] + 1):
            return
        try:
            channel = await self._channel_for_request(req)
            before = req.get("before_message_id") if req["kind"] == "older" else None
            raws = await self.source.fetch_page(channel, before, self.settings.page_size)
            self._store_page(req, channel, raws)
            self.store.cas(PAGE_TABLE, req, "succeeded", channel_id=channel["id"], error_code=None)
            self.queue.delete(PAGE_QUEUE, msg_id)
        except AppError as exc:
            self._fail_page(req, msg_id, exc)
        except Exception as exc:  # noqa: BLE001 - unknown failures use the retry budget
            log.error("page request failed unexpectedly (%s)", type(exc).__name__)
            self._fail_page(req, msg_id, AppError("INTERNAL_ERROR", retryable=True))

    async def _channel_for_request(self, req: dict[str, Any]) -> dict[str, Any]:
        if req["kind"] == "open":
            info = await self.source.resolve(req["username"])
            return self.store.upsert_channel(info["telegram_peer_id"], info["username"], info["title"])
        channel = self.store.get_channel(req["channel_id"]) if req.get("channel_id") else None
        if channel is None:
            raise AppError("CHANNEL_NOT_FOUND", "older request without a known channel")
        return channel

    def _store_page(self, req: dict[str, Any], channel: dict[str, Any], raws: list[RawMessage]) -> None:
        channel_id = channel["id"]
        self.store.upsert_messages([to_row(raw, channel_id) for raw in raws])
        ids = [raw.id for raw in raws]
        sync = self.store.get_sync(channel_id) or {}
        exhausted = bool(sync.get("history_exhausted")) or len(raws) < self.settings.page_size
        newest = max(ids + [sync.get("newest_message_id") or 0]) if ids else sync.get("newest_message_id")
        if req["kind"] == "older":
            oldest = min(ids) if ids else sync.get("oldest_message_id")
        else:
            oldest = sync.get("oldest_message_id")
            if oldest is None and ids:
                oldest = min(ids)
        self.store.save_sync(channel_id, newest=newest, oldest=oldest, exhausted=exhausted)

    def _fail_page(self, req: dict[str, Any], msg_id: int, exc: AppError) -> None:
        if exc.retryable and req["attempts"] < self.settings.max_attempts:
            if self.store.cas(PAGE_TABLE, req, "queued", error_code=exc.code):
                delay = exc.retry_after or backoff_seconds(req["attempts"])
                self.queue.set_visibility(PAGE_QUEUE, msg_id, delay)
            return
        if self.store.cas(PAGE_TABLE, req, "failed", error_code=exc.code):
            self.queue.delete(PAGE_QUEUE, msg_id)

    # --------------------------------------------------------------- file delivery
    async def handle_job(self, msg: dict[str, Any]) -> None:
        msg_id = msg["msg_id"]
        job_id = (msg.get("message") or {}).get("job_id")
        job = self.store.get_job(job_id) if job_id else None
        if job is None or job["status"] in ("succeeded", "failed", "ambiguous"):
            self.queue.delete(JOB_QUEUE, msg_id)
            return
        if job["status"] == "uploading":
            # A previous run stopped after the upload started. Whether Bale got the file is unknown,
            # so it must not be sent again automatically.
            self.store.cas(
                JOB_TABLE,
                job,
                "ambiguous",
                error_code="BALE_SEND_AMBIGUOUS",
                error_detail="interrupted during upload",
            )
            self.queue.delete(JOB_QUEUE, msg_id)
            return
        if not self.store.cas(JOB_TABLE, job, "processing", attempts=job["attempts"] + 1):
            return
        try:
            await self._deliver(job)
            self.queue.delete(JOB_QUEUE, msg_id)
        except _Conflict:
            return
        except AppError as exc:
            self._fail_job(job, msg_id, exc)
        except Exception as exc:  # noqa: BLE001
            log.error("job failed unexpectedly (%s)", type(exc).__name__)
            self._fail_job(job, msg_id, AppError("INTERNAL_ERROR", retryable=True))

    def _set(self, job: dict[str, Any], status: str, **fields: Any) -> None:
        if not self.store.cas(JOB_TABLE, job, status, **fields):
            raise _Conflict()

    async def _deliver(self, job: dict[str, Any]) -> None:
        user = self.store.get_user(job["user_id"])
        chat_id = user.get("bale_chat_id") if user else None
        if not chat_id:
            raise AppError("BALE_CHAT_REQUIRED", "user has not started the bot")
        channel = self.store.get_channel(job["channel_id"])
        if channel is None:
            raise AppError("CHANNEL_NOT_FOUND")
        raw = await self.source.fetch_message(channel, job["message_id"])
        if raw is None:
            raise AppError("MESSAGE_NOT_FOUND")
        if raw.media_kind in (None, "unknown"):
            raise AppError("UNSUPPORTED_MEDIA")
        limit = self.settings.max_download_size_bytes
        if raw.size_bytes and raw.size_bytes > limit:
            raise AppError("FILE_TOO_LARGE", f"{raw.size_bytes} bytes")

        self._set(job, "downloading")
        os.makedirs(self.settings.temp_dir, exist_ok=True)
        workdir = tempfile.mkdtemp(prefix="job-", dir=self.settings.temp_dir)
        try:
            filename = sanitize_filename(raw.file_name, raw.mime_type, raw.media_kind)
            try:
                path = await asyncio.wait_for(
                    self.source.download(channel, job["message_id"], os.path.join(workdir, filename)),
                    timeout=self.settings.download_timeout_seconds,
                )
            except asyncio.TimeoutError as exc:
                raise AppError("DOWNLOAD_TIMEOUT", retryable=True) from exc
            if os.path.getsize(path) > limit:
                raise AppError("FILE_TOO_LARGE", "larger than the configured limit")

            self._set(job, "uploading")  # from here on, a crash means "ambiguous"
            bale_message_id = await asyncio.to_thread(
                self.bale.send_document,
                chat_id,
                path,
                filename,
                raw.mime_type or "application/octet-stream",
                _caption(raw, channel),
            )
            self._set(job, "succeeded", bale_message_id=bale_message_id, error_code=None, error_detail=None)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def _fail_job(self, job: dict[str, Any], msg_id: int, exc: AppError) -> None:
        detail = exc.detail[:200] or None
        if exc.code == "BALE_SEND_AMBIGUOUS":
            self.store.cas(JOB_TABLE, job, "ambiguous", error_code=exc.code, error_detail=detail)
            self.queue.delete(JOB_QUEUE, msg_id)
            return
        if exc.retryable and job["attempts"] < self.settings.max_attempts:
            if self.store.cas(JOB_TABLE, job, "queued", error_code=exc.code, error_detail=detail):
                delay = exc.retry_after or backoff_seconds(job["attempts"])
                self.queue.set_visibility(JOB_QUEUE, msg_id, delay)
            return
        if self.store.cas(JOB_TABLE, job, "failed", error_code=exc.code, error_detail=detail):
            self.queue.delete(JOB_QUEUE, msg_id)
