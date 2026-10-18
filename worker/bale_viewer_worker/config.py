"""Runtime settings, read from environment variables only (never from committed files)."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

_DURATION_PART = re.compile(r"(\d+)([hms])")
_FACTORS = {"h": 3600, "m": 60, "s": 1}
_DEFAULT_MAX_BYTES = 50 * 1024 * 1024  # Bale multipart upload limit for documents


class ConfigError(RuntimeError):
    """Required configuration is missing or malformed."""


def parse_duration(value: str) -> int:
    """Parse '5h15m', '90m', '30s' or a plain number of seconds into seconds."""
    compact = re.sub(r"\s+", "", value).lower()
    if compact.isdigit():
        return int(compact)
    parts = _DURATION_PART.findall(compact)
    if not parts or "".join(n + u for n, u in parts) != compact:
        raise ConfigError(f"invalid duration: {value!r}")
    return sum(int(number) * _FACTORS[unit] for number, unit in parts)


def _get(env: Mapping[str, str], key: str, default: str = "") -> str:
    return env.get(key, default).strip() or default


def _supabase_url(env: Mapping[str, str]) -> str:
    """SUPABASE_URL, or the URL derived from SUPABASE_PROJECT_REF (the only value the workflows need to pass)."""
    explicit = _get(env, "SUPABASE_URL")
    if explicit:
        return explicit.rstrip("/")
    ref = _get(env, "SUPABASE_PROJECT_REF")
    if ref:
        return f"https://{ref}.supabase.co"
    raise ConfigError("missing required environment variable SUPABASE_URL (or SUPABASE_PROJECT_REF)")


def _require(env: Mapping[str, str], key: str) -> str:
    value = _get(env, key)
    if not value:
        raise ConfigError(f"missing required environment variable {key}")
    return value


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    supabase_service_role_key: str
    bale_bot_token: str = ""
    bale_api_base_url: str = "https://tapi.bale.ai"
    telegram_api_id: int = 0
    telegram_api_hash: str = ""
    github_repository: str = ""
    github_token: str = ""
    github_ref: str = "main"
    workflow_file: str = "telegram-bale-worker.yml"
    max_download_size_bytes: int = _DEFAULT_MAX_BYTES
    download_timeout_seconds: int = 900
    max_attempts: int = 3
    temp_dir: str = "/tmp/bale-telegram-viewer"
    page_size: int = 25
    queue_visibility_seconds: int = 900
    poll_interval_seconds: float = 5.0
    heartbeat_interval_seconds: int = 60
    session_save_interval_seconds: int = 900
    worker_name: str = "telegram-worker"
    run_id: str = "local"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        return cls(
            supabase_url=_supabase_url(env),
            supabase_service_role_key=_require(env, "SUPABASE_SERVICE_ROLE_KEY"),
            bale_bot_token=_get(env, "BALE_BOT_TOKEN"),
            bale_api_base_url=_get(env, "BALE_API_BASE_URL", "https://tapi.bale.ai").rstrip("/"),
            telegram_api_id=int(_get(env, "TELEGRAM_API_ID", "0")),
            telegram_api_hash=_get(env, "TELEGRAM_API_HASH"),
            github_repository=_get(env, "GITHUB_REPOSITORY"),
            github_token=_get(env, "GITHUB_TOKEN"),
            github_ref=_get(env, "GITHUB_REF_NAME", "main"),
            workflow_file=_get(env, "WORKFLOW_FILE", "telegram-bale-worker.yml"),
            max_download_size_bytes=int(_get(env, "MAX_DOWNLOAD_SIZE_BYTES", str(_DEFAULT_MAX_BYTES))),
            download_timeout_seconds=int(_get(env, "DOWNLOAD_TIMEOUT_SECONDS", "900")),
            max_attempts=int(_get(env, "MAX_DOWNLOAD_ATTEMPTS", "3")),
            temp_dir=_get(env, "TEMP_DOWNLOAD_DIR", "/tmp/bale-telegram-viewer"),
            run_id=_get(env, "GITHUB_RUN_ID", "local"),
        )

    def require_bale(self) -> None:
        if not self.bale_bot_token:
            raise ConfigError("BALE_BOT_TOKEN is required for this command")

    def require_telegram(self) -> None:
        if not self.telegram_api_id or not self.telegram_api_hash:
            raise ConfigError("TELEGRAM_API_ID and TELEGRAM_API_HASH are required for this command")

    def require_github(self) -> None:
        if not self.github_repository or not self.github_token:
            raise ConfigError("GITHUB_REPOSITORY and GITHUB_TOKEN are required for this command")
