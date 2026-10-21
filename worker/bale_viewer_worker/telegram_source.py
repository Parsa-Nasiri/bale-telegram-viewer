"""Telegram adapter built on Telethon.

Why Telethon directly instead of the `tlgr` CLI: the session has to be stored
as a string in Supabase and reloaded by whichever runner holds the chain.
Telethon's StringSession supports exactly that. A CLI with a session file
would need extra plumbing to persist and restore state between runners.

Telethon is imported here only, so the rest of the package stays testable
without it.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from .errors import AppError
from .message_mapper import RawMessage
from .thumbs import ThumbOption, choose_thumb, image_extension


def _detect_kind(message: Any) -> str | None:
    if message.photo:
        return "photo"
    if message.sticker:
        return "sticker"
    if message.voice:
        return "voice"
    if message.audio:
        return "audio"
    if message.gif:
        return "animation"
    if message.video:
        return "video"
    if message.document:
        return "document"
    if message.media is not None:
        return "unknown"
    return None


def _thumb_options(message: Any) -> list[ThumbOption]:
    """The thumbnail sizes Telegram offers for a message, with the index Telethon uses to download each one."""
    if message.photo:
        sizes = getattr(message.photo, "sizes", None) or []
    elif message.document:
        sizes = getattr(message.document, "thumbs", None) or []
    else:
        sizes = []
    options: list[ThumbOption] = []
    for index, size in enumerate(sizes):
        width = getattr(size, "w", None)
        height = getattr(size, "h", None)
        if not width or not height:
            continue  # stripped and empty sizes have no dimensions, so they are never the best choice
        nbytes = getattr(size, "size", None)
        if nbytes is None and getattr(size, "bytes", None):
            nbytes = len(size.bytes)
        if nbytes is None and getattr(size, "sizes", None):  # progressive sizes list their byte counts
            nbytes = max(size.sizes)
        options.append(ThumbOption(index, int(width), int(height), int(nbytes) if nbytes is not None else None))
    return options


def to_raw(message: Any) -> RawMessage:
    file = message.file
    return RawMessage(
        id=int(message.id),
        date=message.date,
        text=message.message or "",
        grouped_id=message.grouped_id,
        sender_name=message.post_author or None,
        media_kind=_detect_kind(message),
        file_name=getattr(file, "name", None),
        mime_type=getattr(file, "mime_type", None),
        size_bytes=getattr(file, "size", None),
    )


class TelegramSource:
    def __init__(self, api_id: int, api_hash: str, session: str = "") -> None:
        from telethon import TelegramClient
        from telethon.sessions import StringSession

        self._client = TelegramClient(StringSession(session), api_id, api_hash, receive_updates=False)

    async def connect(self) -> None:
        await self._client.connect()
        if not await self._client.is_user_authorized():
            raise AppError("TELEGRAM_SESSION_INVALID", "session is not authorized; run the login command")

    async def interactive_login(self) -> None:
        await self._client.start()  # prompts for phone, code and 2FA password in the terminal

    def session_string(self) -> str:
        return self._client.session.save()

    async def disconnect(self) -> None:
        await self._client.disconnect()

    async def _entity(self, channel: dict) -> Any:
        from telethon.errors import ChannelPrivateError
        from telethon.tl.types import PeerChannel

        try:
            if channel.get("username"):
                return await self._client.get_entity(channel["username"])
            return await self._client.get_entity(PeerChannel(int(channel["telegram_peer_id"])))
        except ValueError as exc:
            raise AppError("CHANNEL_NOT_FOUND", "entity not resolvable") from exc
        except ChannelPrivateError as exc:
            raise AppError("CHANNEL_ACCESS_DENIED") from exc

    async def _with_thumb(self, message: Any, raw: RawMessage) -> RawMessage:
        """Attaches the best thumbnail of a media message. Best effort: the thumbnail is optional."""
        if raw.media_kind in (None, "unknown"):
            return raw
        index = choose_thumb(_thumb_options(message))
        if index is None:
            return raw
        try:
            data = await self._client.download_media(message, file=bytes, thumb=index)
        except Exception:  # noqa: BLE001 - a missing thumbnail must never stop the message itself
            return raw
        if not isinstance(data, bytes) or image_extension(data) is None:
            return raw
        return replace(raw, thumb=data)

    async def resolve(self, username: str) -> dict:
        """Return {telegram_peer_id, username, title} for a public channel username."""
        from telethon.errors import (
            ChannelPrivateError,
            FloodWaitError,
            UsernameInvalidError,
            UsernameNotOccupiedError,
        )
        from telethon.tl.types import Channel

        try:
            entity = await self._client.get_entity(username)
        except (UsernameNotOccupiedError, UsernameInvalidError, ValueError) as exc:
            raise AppError("CHANNEL_NOT_FOUND") from exc
        except ChannelPrivateError as exc:
            raise AppError("CHANNEL_ACCESS_DENIED") from exc
        except FloodWaitError as exc:
            raise AppError("TELEGRAM_RATE_LIMIT", retryable=True, retry_after=int(exc.seconds)) from exc
        if not isinstance(entity, Channel):
            raise AppError("CHANNEL_NOT_FOUND", "target is not a channel")
        return {
            "telegram_peer_id": str(entity.id),
            "username": (entity.username or "").lower() or None,
            "title": entity.title,
        }

    async def fetch_page(self, channel: dict, before_id: int | None, limit: int) -> list[RawMessage]:
        entity = await self._entity(channel)
        messages = await self._client.get_messages(entity, limit=limit, offset_id=before_id or 0)
        return [
            await self._with_thumb(m, to_raw(m))
            for m in messages
            if m is not None and getattr(m, "id", None)
        ]

    async def fetch_message(self, channel: dict, message_id: int) -> RawMessage | None:
        entity = await self._entity(channel)
        message = await self._client.get_messages(entity, ids=message_id)
        if message is None:
            return None
        return await self._with_thumb(message, to_raw(message))

    async def download(self, channel: dict, message_id: int, dest_path: str) -> str:
        from telethon.errors import FloodWaitError

        entity = await self._entity(channel)
        message = await self._client.get_messages(entity, ids=message_id)
        if message is None or message.media is None:
            raise AppError("MESSAGE_NOT_FOUND")
        try:
            path = await self._client.download_media(message, file=dest_path)
        except FloodWaitError as exc:
            raise AppError("TELEGRAM_RATE_LIMIT", retryable=True, retry_after=int(exc.seconds)) from exc
        if not path:
            raise AppError("DOWNLOAD_FAILED", "telegram returned no file", retryable=True)
        return str(path)
