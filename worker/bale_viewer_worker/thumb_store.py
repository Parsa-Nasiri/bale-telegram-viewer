"""Uploads thumbnails to the public `thumbs` bucket of Supabase Storage.

Thumbnails live in Storage, not in the message rows, so a full-size thumbnail does not make every page of the
Mini App heavier. The bucket is public, so the Mini App loads each image from its URL, and the browser caches it.
Only the worker writes to it, with the service role key.
"""

from __future__ import annotations

from urllib.parse import quote

from .supabase_rest import StoreError
from .transport import Transport, TransportError

BUCKET = "thumbs"


class ThumbStore:
    def __init__(self, base_url: str, service_key: str, transport: Transport, timeout: float = 30.0) -> None:
        self._base = base_url.rstrip("/") + "/storage/v1/object"
        self._key = service_key
        self._transport = transport
        self._timeout = timeout

    def put(self, path: str, data: bytes, content_type: str) -> None:
        """Stores the bytes at `path` in the thumbs bucket, replacing an earlier thumbnail of the same message."""
        url = f"{self._base}/{BUCKET}/{quote(path)}"
        headers = {
            "apikey": self._key,
            "Authorization": f"Bearer {self._key}",
            "Content-Type": content_type,
            "x-upsert": "true",
        }
        try:
            resp = self._transport.request("POST", url, headers=headers, body=data, timeout=self._timeout)
        except TransportError as exc:
            raise StoreError(0, f"transport {exc.kind}") from None
        if resp.status >= 400:
            raise StoreError(resp.status, resp.body[:300].decode("utf-8", "replace"))


def thumb_path(channel_id: str, message_id: int, extension: str) -> str:
    """The storage path of one message's thumbnail. The Edge Functions build the public URL from it."""
    return f"{channel_id}/{message_id}.{extension}"
