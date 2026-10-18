"""Command-line entry point.

Usage (from the worker/ directory):
    python -m bale_viewer_worker healthcheck
    python -m bale_viewer_worker dispatch-successor
    python -m bale_viewer_worker run --drain-after 5h15m --hard-stop 5h30m
    python -m bale_viewer_worker watchdog
    python -m bale_viewer_worker login            # run once, locally
    python -m bale_viewer_worker register-webhook
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from .config import ConfigError, Settings, parse_duration
from . import ops
from .dotenv import default_dotenv_path, load_dotenv


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bale_viewer_worker")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("healthcheck", help="verify Supabase, Telegram session and Bale token")
    sub.add_parser("dispatch-successor", help="queue the next workflow run (pending until this one ends)")
    run = sub.add_parser("run", help="process queued jobs until the drain deadline")
    run.add_argument("--drain-after", required=True, help="stop claiming new jobs after this duration, e.g. 5h15m")
    run.add_argument("--hard-stop", required=True, help="exit no later than this duration, e.g. 5h30m")
    sub.add_parser("watchdog", help="restart a stalled or missing worker chain")
    sub.add_parser("login", help="interactive Telegram login; stores the session in Supabase")
    sub.add_parser("register-webhook", help="point the Bale webhook at the Edge Function (safe to repeat)")
    return parser


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = _build_parser().parse_args(argv)
    load_dotenv(default_dotenv_path())
    try:
        settings = Settings.from_env()
        if args.command == "healthcheck":
            return ops.healthcheck(settings)
        if args.command == "dispatch-successor":
            return ops.dispatch_successor(settings)
        if args.command == "run":
            return asyncio.run(
                ops.run_worker(
                    settings,
                    drain_after=parse_duration(args.drain_after),
                    hard_stop=parse_duration(args.hard_stop),
                )
            )
        if args.command == "watchdog":
            return ops.watchdog(settings)
        if args.command == "login":
            return asyncio.run(ops.login(settings))
        if args.command == "register-webhook":
            return ops.register_webhook(settings)
    except ConfigError as exc:
        print(f"::error::configuration: {exc}", file=sys.stderr)
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
