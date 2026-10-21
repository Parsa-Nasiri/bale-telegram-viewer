"""Chooses which Telegram thumbnail to keep, and checks that the bytes are an image the Mini App can show.

Telegram sends several sizes of each thumbnail. The smallest one (index 0) is blurry when it is shown at phone
width, so the largest size that still fits the limits is kept instead. Telethon is not imported here, so the
choice can be tested without it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

# Telegram's 800 px size is sharp at phone width and small enough to store and send.
MAX_THUMB_SIDE = 800
MAX_THUMB_BYTES = 150_000

_JPEG_MAGIC = b"\xff\xd8\xff"
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
CONTENT_TYPES = {"jpg": "image/jpeg", "png": "image/png"}


@dataclass(frozen=True)
class ThumbOption:
    index: int  # position in Telegram's list of sizes, as Telethon's download_media(thumb=...) expects
    width: int
    height: int
    size: int | None  # bytes, when Telegram tells us in advance


def choose_thumb(options: Sequence[ThumbOption]) -> int | None:
    """The index of the largest size that fits the limits. If none fits, the smallest size. None if there is none."""
    fitting = [
        option
        for option in options
        if max(option.width, option.height) <= MAX_THUMB_SIDE and (option.size is None or option.size <= MAX_THUMB_BYTES)
    ]
    if fitting:
        best = max(fitting, key=lambda option: (max(option.width, option.height), -(option.size or 0)))
        return best.index
    if options:
        return min(options, key=lambda option: max(option.width, option.height)).index
    return None


def image_extension(data: bytes | None) -> str | None:
    """'jpg' or 'png' for JPEG and PNG bytes, otherwise None (WebP stickers and anything else are not kept)."""
    if not data:
        return None
    if data.startswith(_JPEG_MAGIC):
        return "jpg"
    if data.startswith(_PNG_MAGIC):
        return "png"
    return None
