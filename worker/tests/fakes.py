"""In-memory doubles used by the test suite. No network, no Telethon."""

from __future__ import annotations

import asyncio
import os
from typing import Any

from bale_viewer_worker.errors import AppError
from bale_viewer_worker.message_mapper import RawMessage
from bale_viewer_worker.policy import JOB_TRANSITIONS, PAGE_TRANSITIONS, can_transition
from bale_viewer_worker.store import JOB_TABLE, PAGE_TABLE
from bale_viewer_worker.transport import HttpResponse, TransportError


class FakeTransport:
    """Records calls and replies with whatever `responder` returns or raises."""

    def __init__(self, responder) -> None:  # type: ignore[no-untyped-def]
        self.responder = responder
        self.calls: list[dict[str, Any]] = []

    def request(self, method, url, *, headers=None, body=None, timeout=30.0):  # type: ignore[no-untyped-def]
        self.calls.append({"method": method, "url": url, "headers": dict(headers or {}), "body": body})
        result = self.responder(method, url, headers or {}, body)
        if isinstance(result, BaseException):
            raise result
        return result


def ok_json(payload: dict, status: int = 200) -> HttpResponse:
    import json

    return HttpResponse(status, json.dumps(payload).encode("utf-8"))


class FakeStore:
    def __init__(self) -> None:
        self.tables: dict[str, dict[str, dict[str, Any]]] = {JOB_TABLE: {}, PAGE_TABLE: {}}
        self.users: dict[str, dict[str, Any]] = {}
        self.channels: dict[str, dict[str, Any]] = {}
        self.messages: list[dict[str, Any]] = []
        self.sync: dict[str, dict[str, Any]] = {}
        self.kv: dict[str, Any] = {}
        self.heartbeats: list[tuple[str, str, str]] = []

    # --- helpers used by tests
    def add_page(self, row: dict[str, Any]) -> dict[str, Any]:
        row = {"status": "queued", "attempts": 0, "error_code": None, "before_message_id": None, **row}
        self.tables[PAGE_TABLE][row["id"]] = row
        return row

    def add_job(self, row: dict[str, Any]) -> dict[str, Any]:
        row = {"status": "queued", "attempts": 0, "error_code": None, "bale_message_id": None, **row}
        self.tables[JOB_TABLE][row["id"]] = row
        return row

    # --- store interface
    def get_page_request(self, request_id: str) -> dict | None:
        row = self.tables[PAGE_TABLE].get(request_id)
        return dict(row) if row else None

    def get_job(self, job_id: str) -> dict | None:
        row = self.tables[JOB_TABLE].get(job_id)
        return dict(row) if row else None

    def cas(self, table: str, row: dict, to_status: str, **fields: Any) -> bool:
        transitions = JOB_TRANSITIONS if table == JOB_TABLE else PAGE_TRANSITIONS
        stored = self.tables[table][row["id"]]
        if stored["status"] != row["status"]:
            return False
        if not can_transition(transitions, stored["status"], to_status):
            raise ValueError(f"illegal transition {stored['status']} -> {to_status}")
        stored.update({"status": to_status, **fields})
        row.update(stored)
        return True

    def get_user(self, user_id: str) -> dict | None:
        return self.users.get(user_id)

    def get_channel(self, channel_id: str) -> dict | None:
        return self.channels.get(channel_id)

    def upsert_channel(self, peer_id: str, username: str | None, title: str | None) -> dict:
        for channel in self.channels.values():
            if channel["telegram_peer_id"] == peer_id:
                channel.update({"username": username, "title": title})
                return channel
        channel = {"id": f"ch-{peer_id}", "telegram_peer_id": peer_id, "username": username, "title": title}
        self.channels[channel["id"]] = channel
        return channel

    def upsert_messages(self, rows: list[dict]) -> None:
        self.messages.extend(rows)

    def get_sync(self, channel_id: str) -> dict | None:
        return self.sync.get(channel_id)

    def save_sync(self, channel_id: str, *, newest: int | None, oldest: int | None, exhausted: bool) -> None:
        self.sync[channel_id] = {
            "newest_message_id": newest,
            "oldest_message_id": oldest,
            "history_exhausted": exhausted,
        }

    def get_kv(self, key: str) -> Any | None:
        return self.kv.get(key)

    def set_kv(self, key: str, value: Any) -> None:
        self.kv[key] = value

    def heartbeat(self, name: str, run_id: str, status: str) -> None:
        self.heartbeats.append((name, run_id, status))

    def get_heartbeat(self, name: str) -> dict | None:
        return None


class FakeQueue:
    def __init__(self, messages: list[dict] | None = None) -> None:
        self.pending = list(messages or [])
        self.deleted: list[int] = []
        self.visibility: dict[int, int] = {}
        self.read_calls = 0

    def send(self, queue: str, payload: dict) -> int:
        raise NotImplementedError

    def read_one(self, queue: str, visibility_seconds: int) -> dict | None:
        self.read_calls += 1
        return self.pending.pop(0) if self.pending else None

    def delete(self, queue: str, msg_id: int) -> None:
        self.deleted.append(msg_id)

    def set_visibility(self, queue: str, msg_id: int, seconds: int) -> None:
        self.visibility[msg_id] = seconds


class FakeSource:
    def __init__(self) -> None:
        self.resolve_result: dict | Exception = {
            "telegram_peer_id": "1001",
            "username": "chan",
            "title": "Chan",
        }
        self.pages: list[RawMessage] | Exception = []
        self.message: RawMessage | None = None
        self.download_payload = b"data"
        self.download_delay = 0.0
        self.download_error: Exception | None = None
        self.fetch_calls: list[tuple[int | None, int]] = []
        self.download_calls = 0

    async def resolve(self, username: str) -> dict:
        if isinstance(self.resolve_result, Exception):
            raise self.resolve_result
        return dict(self.resolve_result)

    async def fetch_page(self, channel: dict, before_id: int | None, limit: int) -> list[RawMessage]:
        self.fetch_calls.append((before_id, limit))
        if isinstance(self.pages, Exception):
            raise self.pages
        return list(self.pages)

    async def fetch_message(self, channel: dict, message_id: int) -> RawMessage | None:
        return self.message

    async def download(self, channel: dict, message_id: int, dest_path: str) -> str:
        self.download_calls += 1
        if self.download_delay:
            await asyncio.sleep(self.download_delay)
        if self.download_error is not None:
            raise self.download_error
        with open(dest_path, "wb") as handle:
            handle.write(self.download_payload)
        return dest_path

    def session_string(self) -> str:
        return "session-v1"


class FakeBale:
    def __init__(self, result: str | Exception = "555") -> None:
        self.result = result
        self.sent: list[dict[str, Any]] = []

    def send_document(self, chat_id: str, path: str, filename: str, mime_type: str, caption: str) -> str:
        self.sent.append(
            {"chat_id": chat_id, "filename": filename, "mime": mime_type, "caption": caption,
             "exists": os.path.exists(path)}
        )
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def photo(message_id: int = 10, size: int | None = 1000) -> RawMessage:
    from datetime import datetime, timezone

    return RawMessage(
        id=message_id,
        date=datetime(2026, 10, 17, 7, 0, tzinfo=timezone.utc),
        text="caption text",
        grouped_id=None,
        sender_name=None,
        media_kind="photo",
        file_name=None,
        mime_type="image/jpeg",
        size_bytes=size,
    )


__all__ = ["AppError", "FakeBale", "FakeQueue", "FakeSource", "FakeStore", "FakeTransport", "TransportError", "ok_json", "photo"]
