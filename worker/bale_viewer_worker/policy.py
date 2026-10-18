"""State machines, retry policy and filename rules. Pure functions, no I/O."""

from __future__ import annotations

import mimetypes
import os
import re
from collections.abc import Mapping

# Download job states. "uploading" means the file was (or may have been) sent to Bale.
JOB_TRANSITIONS: Mapping[str, frozenset[str]] = {
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

JOB_FINAL = frozenset({"succeeded", "failed", "ambiguous"})
PAGE_FINAL = frozenset({"succeeded", "failed"})


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
