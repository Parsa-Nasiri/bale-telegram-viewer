"""The info card the bot sends for a Telegram message after a lookup.

Mirrors supabase/functions/_shared/card.ts, which builds the card for a download request. Keep the two in step:
both test suites pin the same output. Rounding is ROUND_HALF_UP because JavaScript's toFixed rounds ties upward.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal

from .message_mapper import RawMessage

CAPTION_LIMIT = 1024
EXCERPT_LIMIT = 300
DOWNLOAD_QUESTION = "آیا این فایل برای شما ارسال شود؟"
ACCEPT_LABEL = "تأیید دانلود"
DECLINE_LABEL = "لغو"

# Iran has had no daylight saving time since 2022, so a fixed offset is exact.
_TEHRAN = timezone(timedelta(hours=3, minutes=30))
_TENTH = Decimal("0.1")

MEDIA_LABELS = {
    "photo": "تصویر",
    "video": "ویدیو",
    "audio": "فایل صوتی",
    "voice": "پیام صوتی",
    "animation": "گیف",
    "sticker": "استیکر",
    "document": "فایل",
}


@dataclass(frozen=True)
class CardInput:
    channel_title: str | None
    channel_username: str | None
    message_id: int
    date: datetime | None
    media_kind: str | None
    file_name: str | None
    size_bytes: int | None
    sender_name: str | None
    text: str | None


def card_input(channel: dict, raw: RawMessage) -> CardInput:
    return CardInput(
        channel_title=channel.get("title"),
        channel_username=channel.get("username"),
        message_id=raw.id,
        date=raw.date,
        media_kind=raw.media_kind,
        file_name=raw.file_name,
        size_bytes=raw.size_bytes,
        sender_name=raw.sender_name,
        text=raw.text or None,
    )


def _one_decimal(value: Decimal) -> str:
    return str(value.quantize(_TENTH, rounding=ROUND_HALF_UP))


def format_size(size: int | None) -> str | None:
    if size is None or size < 0:
        return None
    if size < 1024:
        return f"{size} بایت"
    if size < 1024 * 1024:
        return f"{_one_decimal(Decimal(size) / Decimal(1024))} کیلوبایت"
    return f"{_one_decimal(Decimal(size) / Decimal(1024 * 1024))} مگابایت"


def format_tehran(when: datetime | None) -> str | None:
    """Formats the time as YYYY-MM-DD HH:MM in Tehran time."""
    if when is None:
        return None
    aware = when if when.tzinfo else when.replace(tzinfo=timezone.utc)
    return aware.astimezone(_TEHRAN).strftime("%Y-%m-%d %H:%M")


def excerpt(text: str | None, limit: int = EXCERPT_LIMIT) -> str | None:
    collapsed = " ".join((text or "").split())
    if not collapsed:
        return None
    return collapsed if len(collapsed) <= limit else collapsed[:limit] + "…"


def truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: max(0, limit - 1)] + "…"


def build_caption(card: CardInput, question: str | None) -> str:
    """The card text. The question, when given, stays at the end even when the rest must be cut."""
    if card.channel_title is not None:
        channel = card.channel_title
    elif card.channel_username:
        channel = f"@{card.channel_username}"
    else:
        channel = "کانال"
    lines = [f"کانال: {channel}", f"شناسه پیام: {card.message_id}"]
    date = format_tehran(card.date)
    if date:
        lines.append(f"تاریخ: {date}")
    kind = MEDIA_LABELS.get(card.media_kind, "فایل") if card.media_kind else None
    if kind:
        lines.append(f"نوع: {kind}")
    if card.file_name:
        lines.append(f"نام فایل: {card.file_name}")
    size = format_size(card.size_bytes)
    if size:
        lines.append(f"حجم: {size}")
    if card.sender_name:
        lines.append(f"فرستنده: {card.sender_name}")
    body = excerpt(card.text)
    if body:
        lines.append(f"متن: {body}")
    tail = f"\n\n{question}" if question else ""
    return truncate("\n".join(lines), CAPTION_LIMIT - len(tail)) + tail


def confirm_keyboard(job_id: str) -> dict:
    """Accept and Decline under a card. The job id travels in the callback data (41 bytes, under Bale's 64)."""
    return {
        "inline_keyboard": [
            [
                {"text": ACCEPT_LABEL, "callback_data": f"dl:y:{job_id}"},
                {"text": DECLINE_LABEL, "callback_data": f"dl:n:{job_id}"},
            ]
        ]
    }
