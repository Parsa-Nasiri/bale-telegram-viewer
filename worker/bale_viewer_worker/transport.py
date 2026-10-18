"""Minimal HTTP transport built on urllib (no third-party HTTP client).

Errors are classified so that callers can decide whether a request may have
reached the server:

* ``not_sent``: the connection was never established (DNS failure, refused).
  It is safe to retry.
* ``unknown``: anything after the connection may have been used (timeouts,
  resets). For non-idempotent calls such as sending a file this means the
  outcome is ambiguous and must not be retried automatically.

Exception messages never include the URL, because URLs for Bale contain the bot token.
"""

from __future__ import annotations

import socket
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes


class TransportError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind  # "not_sent" | "unknown"


class Transport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        timeout: float = 30.0,
    ) -> HttpResponse: ...


class UrllibTransport:
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        body: bytes | None = None,
        timeout: float = 30.0,
    ) -> HttpResponse:
        req = urllib.request.Request(url, data=body, method=method, headers=dict(headers or {}))
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 - fixed https hosts
                return HttpResponse(resp.status, resp.read())
        except urllib.error.HTTPError as exc:
            try:
                payload = exc.read()
            except OSError:
                payload = b""
            return HttpResponse(exc.code, payload)
        except (TimeoutError, socket.timeout) as exc:
            raise TransportError("unknown", "timeout") from exc
        except urllib.error.URLError as exc:
            reason = exc.reason
            if isinstance(reason, (socket.gaierror, ConnectionRefusedError)):
                raise TransportError("not_sent", "connection not established") from None
            if isinstance(reason, (TimeoutError, socket.timeout)):
                raise TransportError("unknown", "timeout") from None
            raise TransportError("unknown", "network error") from None
        except OSError as exc:
            raise TransportError("unknown", "network error") from exc
