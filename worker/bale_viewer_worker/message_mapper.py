"""Converts a raw Telegram message into the internal, stable message contract."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

# Every media kind is delivered to Bale with sendDocument, so anything except
# "unknown" is deliverable. Text-only messages have no media kind at all.
SUPPORTED_KINDS = frozenset({"photo", "video", "audio", "voice", "animation", "sticker", "document"})


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


def to_row(raw: RawMessage, channel_id: str) -> dict:
    """Build the `messages` row. File references are deliberately not stored (they expire)."""
    when = raw.date if raw.date.tzinfo else raw.date.replace(tzinfo=timezone.utc)
    kind = raw.media_kind
    return {
        "channel_id": channel_id,
        "message_id": raw.id,
        "date": when.astimezone(timezone.utc).isoformat(),
        "text": raw.text or None,
        "media_type": kind,
        "group_id": str(raw.grouped_id) if raw.grouped_id else None,
        "metadata": {
            "sender_name": raw.sender_name,
            "file_name": raw.file_name,
            "mime_type": raw.mime_type,
            "size_bytes": raw.size_bytes,
            "available": kind in SUPPORTED_KINDS,
        },
    }
