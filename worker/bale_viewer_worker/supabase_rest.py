"""Thin PostgREST client for Supabase, using the service role key.

Only the worker and the Edge Functions hold the service role key. It must never
reach the browser.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlencode

from .transport import Transport, TransportError


class StoreError(RuntimeError):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(f"supabase request failed ({status}): {detail}")
        self.status = status


class SupabaseRest:
    def __init__(self, base_url: str, service_key: str, transport: Transport, timeout: float = 30.0) -> None:
        self._base = base_url.rstrip("/") + "/rest/v1"
        self._key = service_key
        self._transport = transport
        self._timeout = timeout

    def _call(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, str] | None = None,
        body: Any = None,
        prefer: str | None = None,
    ) -> Any:
        url = f"{self._base}/{path}"
        if params:
            url += "?" + urlencode(dict(params))
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Accept": "application/json",
        }
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        if prefer:
            headers["Prefer"] = prefer
        try:
            resp = self._transport.request(method, url, headers=headers, body=data, timeout=self._timeout)
        except TransportError as exc:
            raise StoreError(0, f"transport {exc.kind}") from None
        if resp.status >= 400:
            raise StoreError(resp.status, resp.body[:300].decode("utf-8", "replace"))
        return json.loads(resp.body) if resp.body else None

    def select(self, table: str, params: Mapping[str, str]) -> list[dict]:
        return self._call("GET", table, params=params) or []

    def upsert(self, table: str, rows: list[dict], on_conflict: str) -> list[dict]:
        return (
            self._call(
                "POST",
                table,
                params={"on_conflict": on_conflict},
                body=rows,
                prefer="resolution=merge-duplicates,return=representation",
            )
            or []
        )

    def insert(self, table: str, row: dict) -> dict:
        rows = self._call("POST", table, body=[row], prefer="return=representation") or []
        if not rows:
            raise StoreError(0, f"insert into {table} returned no row")
        return rows[0]

    def update(self, table: str, filters: Mapping[str, str], values: Mapping[str, Any]) -> list[dict]:
        return (
            self._call("PATCH", table, params=filters, body=dict(values), prefer="return=representation") or []
        )

    def rpc(self, name: str, args: Mapping[str, Any]) -> Any:
        return self._call("POST", f"rpc/{name}", body=dict(args))
