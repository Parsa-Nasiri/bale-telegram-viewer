"""Application errors carry a stable machine code and a retry decision."""

from __future__ import annotations


class AppError(Exception):
    """A failure that the pipeline can classify.

    `detail` is for logs only. It must never contain tokens, session strings,
    full URLs, or message text. Use `code` for anything shown to users.
    """

    def __init__(
        self,
        code: str,
        detail: str = "",
        *,
        retryable: bool = False,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail
        self.retryable = retryable
        self.retry_after = retry_after
