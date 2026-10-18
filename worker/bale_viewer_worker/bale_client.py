"""Bale Bot API client (sendDocument, getMe).

Base URL shape from the Bale Bot API docs: https://tapi.bale.ai/bot<token>/METHOD

Outcome classification for sendDocument:
* connection never established            -> BALE_SEND_FAILED, retryable (not sent)
* HTTP 429 / 500 / 503                    -> BALE_SEND_FAILED, retryable
* HTTP 502 / 504 / timeout / reset        -> BALE_SEND_AMBIGUOUS (may have been sent)
* other 4xx                               -> BALE_SEND_FAILED, permanent
"""

from __future__ import annotations

import json
import secrets
from collections.abc import Mapping
from pathlib import Path

from .errors import AppError
from .transport import Transport, TransportError

CAPTION_LIMIT = 1024
_SMALL_TIMEOUT = 20.0
_UPLOAD_TIMEOUT = 600.0


def _multipart(fields: Mapping[str, str], file_field: str, filename: str, mime: str, data: bytes) -> tuple[bytes, str]:
    boundary = "bvw" + secrets.token_hex(16)
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8")
        )
    safe_name = filename.replace('"', "").replace("\r", "").replace("\n", "")
    chunks.append(
        (
            f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; '
            f'filename="{safe_name}"\r\nContent-Type: {mime}\r\n\r\n'
        ).encode("utf-8")
    )
    chunks.append(data)
    chunks.append(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class BaleClient:
    def __init__(self, base_url: str, token: str, transport: Transport) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._transport = transport

    def _url(self, method: str) -> str:
        return f"{self._base}/bot{self._token}/{method}"

    def get_me(self) -> dict:
        try:
            resp = self._transport.request("GET", self._url("getMe"), timeout=_SMALL_TIMEOUT)
        except TransportError as exc:
            raise AppError("BALE_UNREACHABLE", exc.kind, retryable=True) from None
        data = _decode(resp.body)
        if resp.status != 200 or data.get("ok") is not True:
            raise AppError("BALE_TOKEN_INVALID", f"getMe http {resp.status}")
        return data["result"]

    def send_document(self, chat_id: str, path: str, filename: str, mime_type: str, caption: str) -> str:
        """Send a file to a private chat. Returns the Bale message id as a string."""
        data = Path(path).read_bytes()
        body, content_type = _multipart(
            {"chat_id": chat_id, "caption": caption[:CAPTION_LIMIT]},
            "document",
            filename,
            mime_type,
            data,
        )
        try:
            resp = self._transport.request(
                "POST",
                self._url("sendDocument"),
                headers={"Content-Type": content_type},
                body=body,
                timeout=_UPLOAD_TIMEOUT,
            )
        except TransportError as exc:
            if exc.kind == "not_sent":
                raise AppError("BALE_SEND_FAILED", "not sent", retryable=True) from None
            raise AppError("BALE_SEND_AMBIGUOUS", "outcome unknown after upload started") from None
        return _interpret_send(resp.status, _decode(resp.body))


def _decode(body: bytes) -> dict:
    try:
        value = json.loads(body or b"{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def _interpret_send(status: int, data: dict) -> str:
    if status == 200 and data.get("ok") is True:
        return str(data["result"]["message_id"])
    code = status if status != 200 else int(data.get("error_code") or 0)
    if code in (502, 504):
        raise AppError("BALE_SEND_AMBIGUOUS", f"gateway {code} after upload")
    retryable = code == 429 or code >= 500
    raise AppError("BALE_SEND_FAILED", f"bale error {code}", retryable=retryable)
