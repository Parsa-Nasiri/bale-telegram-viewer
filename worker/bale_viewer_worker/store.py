"""Repository layer over Supabase tables. Every state change is a compare-and-set."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from typing import Any

from .policy import (
    ACTIVE_JOB_STATES,
    AWAITING_STATE,
    JOB_TRANSITIONS,
    LOOKUP_TRANSITIONS,
    PAGE_TRANSITIONS,
    can_transition,
    is_live_job,
)
from .supabase_rest import SupabaseRest

JOB_TABLE = "download_jobs"
PAGE_TABLE = "page_requests"
LOOKUP_TABLE = "lookup_requests"
_MESSAGE_BATCH = 200
_TRANSITIONS = {JOB_TABLE: JOB_TRANSITIONS, PAGE_TABLE: PAGE_TRANSITIONS, LOOKUP_TABLE: LOOKUP_TRANSITIONS}
_LIVE_STATES = ",".join([AWAITING_STATE, *sorted(ACTIVE_JOB_STATES)])


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _batches(rows: list[dict], size: int) -> Iterator[list[dict]]:
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


class Store:
    def __init__(self, rest: SupabaseRest) -> None:
        self._rest = rest

    # --- key/value (Telegram session lives here) ---------------------------------
    def get_kv(self, key: str) -> Any | None:
        rows = self._rest.select("kv_state", {"select": "value", "key": f"eq.{key}"})
        return rows[0]["value"] if rows else None

    def set_kv(self, key: str, value: Any) -> None:
        self._rest.upsert("kv_state", [{"key": key, "value": value, "updated_at": utc_now_iso()}], "key")

    # --- users ----------------------------------------------------------------------
    def get_user(self, user_id: str) -> dict | None:
        rows = self._rest.select("users", {"select": "id,bale_chat_id,display_name", "id": f"eq.{user_id}"})
        return rows[0] if rows else None

    # --- channels and cached messages -------------------------------------------------
    def get_channel(self, channel_id: str) -> dict | None:
        rows = self._rest.select(
            "channels", {"select": "id,telegram_peer_id,username,title", "id": f"eq.{channel_id}"}
        )
        return rows[0] if rows else None

    def upsert_channel(self, peer_id: str, username: str | None, title: str | None) -> dict:
        rows = self._rest.upsert(
            "channels",
            [{"telegram_peer_id": peer_id, "username": username, "title": title}],
            "telegram_peer_id",
        )
        return rows[0]

    def upsert_messages(self, rows: list[dict]) -> None:
        for batch in _batches(rows, _MESSAGE_BATCH):
            self._rest.upsert("messages", batch, "channel_id,message_id")

    def get_sync(self, channel_id: str) -> dict | None:
        rows = self._rest.select(
            "channel_sync",
            {
                "select": "newest_message_id,oldest_message_id,history_exhausted",
                "channel_id": f"eq.{channel_id}",
            },
        )
        return rows[0] if rows else None

    def save_sync(self, channel_id: str, *, newest: int | None, oldest: int | None, exhausted: bool) -> None:
        self._rest.upsert(
            "channel_sync",
            [
                {
                    "channel_id": channel_id,
                    "newest_message_id": newest,
                    "oldest_message_id": oldest,
                    "history_exhausted": exhausted,
                    "updated_at": utc_now_iso(),
                }
            ],
            "channel_id",
        )

    # --- page requests, lookups and download jobs ----------------------------------------
    def get_page_request(self, request_id: str) -> dict | None:
        rows = self._rest.select(PAGE_TABLE, {"select": "*", "id": f"eq.{request_id}"})
        return rows[0] if rows else None

    def get_lookup(self, lookup_id: str) -> dict | None:
        rows = self._rest.select(LOOKUP_TABLE, {"select": "*", "id": f"eq.{lookup_id}"})
        return rows[0] if rows else None

    def get_job(self, job_id: str) -> dict | None:
        rows = self._rest.select(JOB_TABLE, {"select": "*", "id": f"eq.{job_id}"})
        return rows[0] if rows else None

    def insert_job(self, row: dict) -> dict:
        return self._rest.insert(JOB_TABLE, row)

    def set_job_confirm_message(self, job_id: str, message_id: str) -> None:
        self._rest.update(
            JOB_TABLE,
            {"id": f"eq.{job_id}"},
            {"confirm_message_id": message_id, "updated_at": utc_now_iso()},
        )

    def live_jobs(self, user_id: str, now: datetime) -> list[dict]:
        """The user's jobs that still hold a download slot (awaiting cards that have not expired included)."""
        rows = self._rest.select(
            JOB_TABLE,
            {
                "select": "id,channel_id,message_id,status,created_at",
                "user_id": f"eq.{user_id}",
                "status": f"in.({_LIVE_STATES})",
                "limit": "50",
            },
        )
        return [row for row in rows if is_live_job(row["status"], row.get("created_at"), now)]

    def cas(self, table: str, row: dict, to_status: str, **fields: Any) -> bool:
        """Move `row` to `to_status` only if its stored status is still the one we last read.

        Returns False when another writer changed it first. The row dict is refreshed on success.
        """
        transitions = _TRANSITIONS.get(table, PAGE_TRANSITIONS)
        if not can_transition(transitions, row["status"], to_status):
            raise ValueError(f"illegal {table} transition {row['status']} -> {to_status}")
        rows = self._rest.update(
            table,
            {"id": f"eq.{row['id']}", "status": f"eq.{row['status']}"},
            {"status": to_status, "updated_at": utc_now_iso(), **fields},
        )
        if not rows:
            return False
        row.update(rows[0])
        return True

    # --- worker heartbeats (used by the watchdog) ---------------------------------------
    def heartbeat(self, name: str, run_id: str, status: str) -> None:
        self._rest.upsert(
            "worker_heartbeats",
            [{"name": name, "run_id": run_id, "status": status, "updated_at": utc_now_iso()}],
            "name",
        )

    def get_heartbeat(self, name: str) -> dict | None:
        rows = self._rest.select("worker_heartbeats", {"select": "*", "name": f"eq.{name}"})
        return rows[0] if rows else None
