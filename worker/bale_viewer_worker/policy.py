"""State machines, retry policy and filename rules. Pure functions, no I/O."""

from __future__ import annotations

import mimetypes
import os
import re
from collections.abc import Mapping
from datetime import datetime, timezone

# Download job states. "uploading" means the file was (or may have been) sent to Bale.
JOB_TRANSITIONS: Mapping[str, frozenset[str]] = {
    # Waiting for the user's Accept or Decline in the bot chat. The Edge Function moves it to "queued" or "declined".
    "awaiting_confirmation": frozenset({"queued", "declined"}),
    "declined": frozenset(),
    "queued": frozenset({"processing", "failed"}),
    "processing": frozenset({"processing", "downloading", "queued", "failed"}),
    "downloading": frozenset({"downloading", "processing", "uploading", "queued", "failed"}),
    "uploading": frozenset({"succeeded", "queued", "failed", "ambiguous"}),
    "succeeded": frozenset(),
    "failed": frozenset(),
    "ambiguous": frozenset(),
}

PAGE_TRANSITIONS: Mapping[str, frozenset[str]] = {
    "queued": frozenset({"processing", "failed"}),
    "processing": frozenset({"processing", "queued", "succeeded", "failed"}),
    "succeeded": frozenset(),
    "failed": frozenset(),
}

LOOKUP_TRANSITIONS: Mapping[str, frozenset[str]] = {
    "queued": frozenset({"processing", "failed"}),
    "processing": frozenset({"processing", "queued", "succeeded", "failed"}),
    "succeeded": frozenset(),
    "failed": frozenset(),
}

JOB_FINAL = frozenset({"succeeded", "failed", "ambiguous", "declined"})
PAGE_FINAL = frozenset({"succeeded", "failed"})

# A job the worker may run. Anything else in the queue is stale and is acknowledged without work.
RUNNABLE_JOB_STATES = frozenset({"queued", "processing", "downloading", "uploading"})
ACTIVE_JOB_STATES = RUNNABLE_JOB_STATES
AWAITING_STATE = "awaiting_confirmation"
# A download card the user has not answered expires after this long. Matches supabase/functions/_shared/logic.ts.
CONFIRM_TTL_SECONDS = 30 * 60
MAX_ACTIVE_JOBS = 5  # matches MAX_ACTIVE_JOBS in logic.ts


def parse_timestamp(value: str | None) -> datetime | None:
    """Reads a timestamp from PostgREST. Naive values are taken as UTC."""
    if not value:
        return None
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def is_live_job(status: str, created_at: str | None, now: datetime) -> bool:
    """True when the job still holds one of the user's download slots. Mirrors isLiveJob in logic.ts."""
    if status == AWAITING_STATE:
        created = parse_timestamp(created_at)
        return created is not None and (now - created).total_seconds() <= CONFIRM_TTL_SECONDS
    return status in ACTIVE_JOB_STATES


def can_transition(transitions: Mapping[str, frozenset[str]], current: str, target: str) -> bool:
    return target in transitions.get(current, frozenset())


def backoff_seconds(attempt: int, *, base: int = 30, cap: int = 900) -> int:
    """Exponential backoff: 30s, 60s, 120s, ... capped."""
    attempt = max(1, attempt)
    return min(cap, base * (2 ** (attempt - 1)))


_UNSAFE_CHARS = re.compile(r'[\x00-\x1f/\\:*?"<>|]')
_FALLBACK_EXTENSIONS = {
    "photo": ".jpg",
    "video": ".mp4",
    "audio": ".mp3",
    "voice": ".ogg",
    "animation": ".gif",
    "sticker": ".webp",
}


def sanitize_filename(name: str | None, mime_type: str | None, kind: str | None) -> str:
    """Return a safe file name that keeps the original extension when possible."""
    base = _UNSAFE_CHARS.sub("_", (name or "").strip()).strip(" .")
    stem, ext = os.path.splitext(base)
    if not ext:
        ext = mimetypes.guess_extension(mime_type or "") or _FALLBACK_EXTENSIONS.get(kind or "", ".bin")
    stem = stem[:100] or (kind or "file")
    return f"{stem}{ext[:12]}"
