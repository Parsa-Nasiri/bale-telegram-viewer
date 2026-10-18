"""Reads the local .env file (repository root). Only keys that are missing or empty in the environment are
filled in, so real environment variables and CI secrets always win. CI never has a .env file."""

from __future__ import annotations

import os
from collections.abc import MutableMapping
from pathlib import Path


def default_dotenv_path() -> Path:
    # bale_viewer_worker/dotenv.py -> bale_viewer_worker -> worker -> repository root
    return Path(__file__).resolve().parents[2] / ".env"


def parse_dotenv(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].lstrip()
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value[: value.index(" #")].rstrip()
        if key:
            values[key] = value
    return values


def load_dotenv(path: Path | None = None, env: MutableMapping[str, str] | None = None) -> bool:
    target = os.environ if env is None else env
    file_path = default_dotenv_path() if path is None else path
    if not file_path.is_file():
        return False
    for key, value in parse_dotenv(file_path.read_text(encoding="utf-8")).items():
        if not target.get(key):
            target[key] = value
    return True
