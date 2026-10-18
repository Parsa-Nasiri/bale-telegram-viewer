"""Supabase Queues (PGMQ) operations, called through the public.pgmq_* RPC wrappers.

The queue carries only identifiers. Authoritative state lives in the
`download_jobs` and `page_requests` tables.
"""

from __future__ import annotations

from typing import Any

from .supabase_rest import SupabaseRest

PAGE_QUEUE = "page_requests_q"
JOB_QUEUE = "download_jobs_q"


class QueueOps:
    def __init__(self, rest: SupabaseRest) -> None:
        self._rest = rest

    def send(self, queue: str, payload: dict[str, Any]) -> int:
        return int(self._rest.rpc("pgmq_send", {"p_queue": queue, "p_msg": payload}))

    def read_one(self, queue: str, visibility_seconds: int) -> dict[str, Any] | None:
        rows = self._rest.rpc("pgmq_read", {"p_queue": queue, "p_vt": visibility_seconds, "p_qty": 1})
        return rows[0] if rows else None

    def delete(self, queue: str, msg_id: int) -> None:
        self._rest.rpc("pgmq_delete", {"p_queue": queue, "p_msg_id": msg_id})

    def set_visibility(self, queue: str, msg_id: int, seconds: int) -> None:
        """Hide a message for `seconds` before it becomes readable again (retry backoff)."""
        self._rest.rpc("pgmq_set_vt", {"p_queue": queue, "p_msg_id": msg_id, "p_vt": seconds})
