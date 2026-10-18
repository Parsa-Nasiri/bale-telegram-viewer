#!/usr/bin/env python3
"""One-command setup. Run it from the repository root:

    python3 scripts/setup.py

It asks for seven values once (or reads them from a git-ignored .env file), then:
  1. creates the GitHub repository if this folder is not one yet (asks first),
  2. stores the values as GitHub Actions secrets (through the GitHub CLI),
  3. runs the `bootstrap` workflow: database migrations, Bale token, Edge Functions, Bale webhook, web page,
  4. asks for the Telegram login code, only if no Telegram session is stored yet,
  5. starts the worker chain.

Needs: Python 3.9+, the GitHub CLI (`gh auth login` once). Standard library only, plus Telethon for step 4,
which is installed automatically. Running it again is safe.
"""

from __future__ import annotations

import argparse
import getpass
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / "worker"
sys.path.insert(0, str(WORKER))

from bale_viewer_worker.dotenv import parse_dotenv  # noqa: E402

DEFAULT_REPO_NAME = "bale-telegram-viewer"

# (name, prompt, is_secret, validation regex or None)
VALUES = [
    ("SUPABASE_PROJECT_REF", "Supabase project ref (the part before .supabase.co)", False, r"^[a-z0-9]{8,40}$"),
    ("SUPABASE_ACCESS_TOKEN", "Supabase access token (supabase.com → Account → Access Tokens)", True, None),
    ("SUPABASE_DB_PASSWORD", "Supabase database password (chosen when the project was created)", True, None),
    ("SUPABASE_SERVICE_ROLE_KEY", "Supabase service_role key (Project Settings → API Keys)", True, None),
    ("BALE_BOT_TOKEN", "Bale bot token (from BotFather)", True, None),
    ("TELEGRAM_API_ID", "Telegram api_id (my.telegram.org)", False, r"^\d+$"),
    ("TELEGRAM_API_HASH", "Telegram api_hash (my.telegram.org)", True, r"^[0-9a-f]{32}$"),
]
NAMES = [name for name, *_ in VALUES]


def die(message: str) -> None:
    print(f"\nerror: {message}", file=sys.stderr)
    raise SystemExit(1)


def say(step: str, message: str) -> None:
    print(f"\n== {step} {message}", flush=True)


def run(
    args: list[str],
    *,
    check: bool = True,
    input_text: str | None = None,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    capture: bool = True,
) -> subprocess.CompletedProcess:
    return subprocess.run(
        args,
        check=check,
        input=input_text,
        text=True,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )


# --- values -----------------------------------------------------------------

def read_env_file() -> dict[str, str]:
    path = ROOT / ".env"
    return parse_dotenv(path.read_text(encoding="utf-8")) if path.is_file() else {}


def save_env_file(values: dict[str, str]) -> None:
    path = ROOT / ".env"
    merged = {**read_env_file(), **values}
    lines = ["# Written by scripts/setup.py. Git-ignored: never commit this file."]
    lines += [f"{key}={value}" for key, value in merged.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    print(f"  saved to {path} (git-ignored)")


def collect_values() -> dict[str, str]:
    saved = read_env_file()
    values: dict[str, str] = {}
    prompted = False
    for name, label, secret, pattern in VALUES:
        candidate = (saved.get(name) or os.environ.get(name) or "").strip()
        while not candidate or (pattern is not None and not re.match(pattern, candidate)):
            if candidate:
                print(f"  {name} does not look right; please enter it again.")
            prompted = True
            candidate = (getpass.getpass(f"{label}: ") if secret else input(f"{label}: ")).strip()
        values[name] = candidate
    if prompted:
        answer = input("\nSave these values to .env (git-ignored) so you do not need to type them again? [Y/n] ")
        if answer.strip().lower() not in ("n", "no"):
            save_env_file(values)
    return values


def supabase_url(values: dict[str, str]) -> str:
    return f"https://{values['SUPABASE_PROJECT_REF']}.supabase.co"


# --- GitHub -------------------------------------------------------------------

def require_gh() -> str:
    gh = shutil.which("gh")
    if gh is None:
        die("the GitHub CLI (gh) is not installed. Get it from https://cli.github.com, run `gh auth login`, "
            "then run this script again.")
    if run([gh, "auth", "status"], check=False).returncode != 0:
        die("the GitHub CLI is not logged in. Run `gh auth login`, then run this script again.")
    return gh


def current_repo() -> str | None:
    result = run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], check=False, cwd=ROOT)
    value = result.stdout.strip() if result.stdout else ""
    return value if result.returncode == 0 and value else None


def ensure_repo() -> str:
    repo = current_repo()
    if repo:
        return repo
    name = input(f"\nNo GitHub repository is linked to this folder.\n"
                 f"Name for a new PUBLIC repository [{DEFAULT_REPO_NAME}]: ").strip() or DEFAULT_REPO_NAME
    answer = input(f"Create '{name}' from this folder and push it? [Y/n] ")
    if answer.strip().lower() in ("n", "no"):
        die("create the repository first, then run this script again: "
            f"gh repo create {name} --public --source . --push")
    if not (ROOT / ".git").exists():
        run(["git", "init", "-q", "-b", "main"], cwd=ROOT)
    run(["git", "add", "-A"], cwd=ROOT)
    run(["git", "commit", "-q", "-m", "Initial commit"], check=False, cwd=ROOT)
    created = run(
        ["gh", "repo", "create", name, "--public", "--source", ".", "--remote", "origin", "--push"],
        check=False,
        cwd=ROOT,
    )
    if created.returncode != 0:
        die(f"could not create the repository: {(created.stderr or '').strip()}")
    repo = current_repo()
    if not repo:
        die("the repository was created, but its name could not be read")
    return repo


def set_secrets(gh: str, repo: str, values: dict[str, str]) -> None:
    for name in NAMES:
        # The value goes through stdin, so it never appears in the process list or in the output.
        result = run([gh, "secret", "set", name, "--repo", repo], check=False, input_text=values[name])
        if result.returncode != 0:
            die(f"could not set the secret {name}: {(result.stderr or '').strip()}")
        print(f"  secret {name} set")


def latest_run_id(gh: str, repo: str, workflow: str) -> str:
    result = run(
        [gh, "run", "list", "--repo", repo, "--workflow", workflow, "--limit", "1", "--json", "databaseId"],
        check=False,
    )
    if result.returncode != 0 or not result.stdout:
        return ""
    rows = json.loads(result.stdout)
    return str(rows[0]["databaseId"]) if rows else ""


def start_workflow(gh: str, repo: str, workflow: str) -> str:
    previous = latest_run_id(gh, repo, workflow)
    run([gh, "workflow", "run", workflow, "--repo", repo])
    for _ in range(40):
        time.sleep(3)
        current = latest_run_id(gh, repo, workflow)
        if current and current != previous:
            return current
    die(f"started {workflow}, but could not find the run. Check the Actions tab of the repository.")
    return ""


def wait_for_run(gh: str, repo: str, run_id: str) -> bool:
    print(f"  follow it at https://github.com/{repo}/actions/runs/{run_id}")
    return run([gh, "run", "watch", run_id, "--repo", repo, "--exit-status"], check=False, capture=False).returncode == 0


# --- Telegram login -----------------------------------------------------------

def session_stored(values: dict[str, str]) -> bool:
    key = values["SUPABASE_SERVICE_ROLE_KEY"]
    url = f"{supabase_url(values)}/rest/v1/kv_state?select=key&key=eq.telegram_session"
    request = urllib.request.Request(url, headers={"apikey": key, "authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return bool(json.loads(response.read().decode("utf-8")))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"  could not check for a stored session ({type(exc).__name__}); the login step will run")
        return False


def telegram_login(values: dict[str, str]) -> None:
    if importlib.util.find_spec("telethon") is None:
        print("  installing Telethon (one time)...", flush=True)
        run([sys.executable, "-m", "pip", "install", "-q", "-r", str(WORKER / "requirements.txt")], capture=False)
    env = {
        **os.environ,
        "SUPABASE_PROJECT_REF": values["SUPABASE_PROJECT_REF"],
        "SUPABASE_SERVICE_ROLE_KEY": values["SUPABASE_SERVICE_ROLE_KEY"],
        "TELEGRAM_API_ID": values["TELEGRAM_API_ID"],
        "TELEGRAM_API_HASH": values["TELEGRAM_API_HASH"],
    }
    print("  Telegram will send a login code to your app. Enter your phone number and the code below.", flush=True)
    result = run(
        [sys.executable, "-m", "bale_viewer_worker", "login"],
        check=False,
        cwd=WORKER,
        env=env,
        capture=False,
    )
    if result.returncode != 0:
        die("the Telegram login did not finish. Run this script again to retry.")


# --- main ----------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description="Set up the Bale Telegram Viewer.")
    parser.add_argument("--no-start", action="store_true", help="stop before starting the worker chain")
    args = parser.parse_args()
    if sys.version_info < (3, 9):
        die("Python 3.9 or newer is required")

    say("1/5", "Values")
    values = collect_values()

    say("2/5", "GitHub repository and secrets")
    gh = require_gh()
    repo = ensure_repo()
    print(f"  repository: {repo}")
    set_secrets(gh, repo, values)

    say("3/5", "Bootstrap: database, Bale token, Edge Functions, webhook, web page")
    run_id = start_workflow(gh, repo, "bootstrap.yml")
    if not wait_for_run(gh, repo, run_id):
        die("bootstrap failed. Open the link above, read the failing step, fix it, and run this script again.")

    say("4/5", "Telegram login")
    if session_stored(values):
        print("  a Telegram session is already stored; skipping the login")
    else:
        telegram_login(values)

    owner, _, name = repo.partition("/")
    if args.no_start:
        print("\n  --no-start: the worker chain was not started.")
    else:
        say("5/5", "Starting the worker chain")
        run_id = start_workflow(gh, repo, "telegram-bale-worker.yml")
        print(f"  started: https://github.com/{repo}/actions/runs/{run_id}")

    print(f"\nDone. Web page: https://{owner}.github.io/{name}/")
    print("If the page is not there yet, turn Pages on once: repo Settings -> Pages -> Source: GitHub Actions,")
    print("then run the deploy-pages workflow again.")
    print("Point your Bale bot's Mini App at that address (see README, step 3).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
