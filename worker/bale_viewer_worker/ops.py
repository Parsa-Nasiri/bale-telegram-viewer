"""Command implementations used by the CLI and the GitHub Actions workflows."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

from .config import ConfigError, Settings
from .context import build_context
from .github_chain import GitHubError
from .pipeline import Pipeline
from .runner import SESSION_KEY, Runner
from .store import Store
from .transport import UrllibTransport
from .watchdog import decide
from .webhook_setup import register_webhook as register_bale_webhook
from .webhook_setup import webhook_url

log = logging.getLogger(__name__)


def _age_seconds(iso_value: str) -> float:
    when = datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - when).total_seconds()


async def open_telegram(settings: Settings, store: Store) -> tuple[Any, str]:
    """Load the stored session and connect. Raises if the session is missing or unauthorized."""
    from .telegram_source import TelegramSource

    settings.require_telegram()
    stored = store.get_kv(SESSION_KEY)
    if not stored or not stored.get("session"):
        raise ConfigError("no Telegram session stored; run `python -m bale_viewer_worker login` locally")
    source = TelegramSource(settings.telegram_api_id, settings.telegram_api_hash, stored["session"])
    await source.connect()
    return source, stored["session"]


async def _healthcheck(settings: Settings) -> int:
    settings.require_bale()
    ctx = build_context(settings)
    other = ctx.store.get_heartbeat(settings.worker_name)
    if (
        other
        and other.get("run_id") != settings.run_id
        and other.get("status") == "running"
        and _age_seconds(other["updated_at"]) < 180
    ):
        print("::error::another worker is still active; refusing to hold the Telegram session twice")
        return 3
    assert ctx.bale is not None
    ctx.bale.get_me()
    source, _ = await open_telegram(settings, ctx.store)
    await source.disconnect()
    ctx.store.heartbeat(settings.worker_name, settings.run_id, "ready")
    print("healthcheck ok")
    return 0


def healthcheck(settings: Settings) -> int:
    return asyncio.run(_healthcheck(settings))


def dispatch_successor(settings: Settings) -> int:
    """Queue the next run. It stays pending (no minutes used) until this run finishes.

    A failure here only prints a warning. The worker still runs, and the watchdog
    will restart the chain later.
    """
    try:
        settings.require_github()
    except ConfigError as exc:
        print(f"::warning::successor not queued: {exc}")
        return 0
    ctx = build_context(settings)
    assert ctx.github is not None
    try:
        ctx.github.dispatch()
    except GitHubError as exc:
        print(f"::warning::successor not queued ({exc}); the watchdog will recover the chain")
        return 0
    print("successor queued")
    return 0


async def run_worker(settings: Settings, *, drain_after: int, hard_stop: int) -> int:
    settings.require_bale()
    ctx = build_context(settings)
    assert ctx.bale is not None
    source, stored_session = await open_telegram(settings, ctx.store)
    try:
        pipeline = Pipeline(
            settings=settings,
            store=ctx.store,
            queue=ctx.queue,
            source=source,
            bale=ctx.bale,
            thumbs=ctx.thumbs,
        )
        runner = Runner(
            settings=settings,
            store=ctx.store,
            queue=ctx.queue,
            source=source,
            pipeline=pipeline,
            stored_session=stored_session,
        )
        await runner.run(drain_after=drain_after, hard_stop=hard_stop)
    finally:
        await source.disconnect()
    return 0


def watchdog(settings: Settings) -> int:
    settings.require_github()
    ctx = build_context(settings)
    assert ctx.github is not None
    now = datetime.now(timezone.utc)
    active = ctx.github.list_runs(["in_progress", "queued", "waiting", "pending"])
    recent = ctx.github.list_completed(5)
    heartbeat = ctx.store.get_heartbeat(settings.worker_name)
    decision = decide(now, active, heartbeat, recent)
    for run_id in decision.cancel_run_ids:
        try:
            ctx.github.cancel(run_id)
            print(f"cancelled stalled run {run_id}")
        except GitHubError as exc:
            print(f"::warning::could not cancel stalled run {run_id} ({exc})")
    if decision.dispatch:
        # Nothing starts before the one-time Telegram login; the worker would only fail its healthcheck.
        if ctx.store.get_kv(SESSION_KEY) is None:
            print("watchdog: no Telegram session stored yet; the chain starts after the login step")
            return 0
        ctx.github.dispatch()
    print(f"watchdog: {decision.reason}")
    return 0


async def login(settings: Settings) -> int:
    """Run once on a trusted machine. Telethon asks for the phone code and 2FA password."""
    from .telegram_source import TelegramSource

    settings.require_telegram()
    store = build_context(settings).store
    source = TelegramSource(settings.telegram_api_id, settings.telegram_api_hash, "")
    await source.interactive_login()
    store.set_kv(SESSION_KEY, {"session": source.session_string()})
    await source.disconnect()
    print("Telegram session stored in Supabase.")
    return 0


def register_webhook(settings: Settings) -> int:
    """Points Bale at the webhook Edge Function. Idempotent: the path depends only on the bot token."""
    settings.require_bale()
    url = webhook_url(settings.supabase_url, settings.bale_bot_token)
    register_bale_webhook(settings.bale_api_base_url, settings.bale_bot_token, url, UrllibTransport())
    print("bale webhook registered")
    return 0
