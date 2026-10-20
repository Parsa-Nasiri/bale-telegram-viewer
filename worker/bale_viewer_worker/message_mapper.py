"""Converts a raw Telegram message into the internal, stable message contract."""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timezone

# Every media kind is delivered to Bale with sendDocument, so anything except
# "unknown" is deliverable. Text-only messages have no media kind at all.
SUPPORTED_KINDS = frozenset({"photo", "video", "audio", "voice", "animation", "sticker", "document"})

# A thumbnail is stored in messages.metadata as a data URL. The limit matches MAX_THUMB_CHARS in logic.ts,
# and it is counted on the whole data URL, not on the image bytes.
MAX_THUMB_CHARS = 40_000
_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


@dataclass(frozen=True)
class RawMessage:
    id: int
    date: datetime
    text: str
    grouped_id: int | None
    sender_name: str | None
    media_kind: str | None  # None for text-only; "unknown" for unsupported media
    file_name: str | None
    mime_type: str | None
    size_bytes: int | None
    thumb: bytes | None = None  # the smallest Telegram thumbnail, when there is one


def thumb_data_url(data: bytes | None) -> str | None:
    """A JPEG or PNG thumbnail as a data URL, when it is small enough to store. Anything else is dropped."""
    if not data:
        return None
    if data.startswith(_JPEG_MAGIC):
        mime = "image/jpeg"
    elif data.startswith(_PNG_MAGIC):
        mime = "image/png"
    else:
        return None
    url = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
    return url if len(url) <= MAX_THUMB_CHARS else None


def to_row(raw: RawMessage, channel_id: str) -> dict:
    """Build the `messages` row. File references are deliberately not stored (they expire)."""
    when = raw.date if raw.date.tzinfo else raw.date.replace(tzinfo=timezone.utc)
    kind = raw.media_kind
    metadata = {
        "sender_name": raw.sender_name,
        "file_name": raw.file_name,
        "mime_type": raw.mime_type,
        "size_bytes": raw.size_bytes,
        "available": kind in SUPPORTED_KINDS,
    }
    thumb = thumb_data_url(raw.thumb)
    if thumb:
        metadata["thumb"] = thumb
    return {
        "channel_id": channel_id,
        "message_id": raw.id,
        "date": when.astimezone(timezone.utc).isoformat(),
        "text": raw.text or None,
        "media_type": kind,
        "group_id": str(raw.grouped_id) if raw.grouped_id else None,
        "metadata": metadata,
    }
