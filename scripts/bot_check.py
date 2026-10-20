#!/usr/bin/env python3
"""Check the bot's welcome button and send it to your private chat. Run it from the project folder:

    python scripts\\bot_check.py         (Windows)
    python3 scripts/bot_check.py        (macOS, Linux)

It checks, in order:
  1. the three values it needs (asks for any that are missing, and can save them to .env),
  2. that the API and the web page answer,
  3. that the bot has your private chat stored (send /start to the bot in Bale first),
  4. sends the button message to that chat, and prints Bale's answer.

Use --check-only to run steps 1-3 without sending anything. Needs the GitHub CLI logged in (to find your page
address). Standard library only. Running it again is safe.
"""

from __future__ import annotations

import argparse
import getpass
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# setup.py and update.py sit next to this file and hold the helpers shared by the commands.
from setup import die, read_env_file, require_gh, say, save_env_file  # noqa: E402
from update import resolve_repo  # noqa: E402

BALE_API = "https://tapi.bale.ai"
WELCOME_TEXT = "برای دیدن پیام‌های کانال‌ها، دکمهٔ زیر را بزنید. برای دیدن اطلاعات یک پیام، لینک آن را همین‌جا بفرستید."
OPEN_BUTTON_TEXT = "باز کردن نمایشگر کانال"

# (name, prompt, is_secret)
REQUIRED = [
    ("SUPABASE_PROJECT_REF", "Supabase project ref (the part before .supabase.co)", False),
    ("SUPABASE_SERVICE_ROLE_KEY", "Supabase service_role key (Project Settings -> API Keys)", True),
    ("BALE_BOT_TOKEN", "Bale bot token (from BotFather)", True),
]


def fetch(url: str, *, headers: dict[str, str] | None = None, body: bytes | None = None) -> tuple[int, str]:
    """Returns (HTTP status, body text). Status 0 means no answer. Errors never echo the URL, so the token stays out."""
    request = urllib.request.Request(url, data=body, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as exc:
        # The reason names the problem (DNS, certificate, timeout). It never contains the URL or the token.
        reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
        return 0, f"{type(exc).__name__}: {reason}"


def describe(status: int) -> str:
    if status == 200:
        return "ok"
    return f"HTTP {status}" if status else "no answer"


def collect_missing(saved: dict[str, str]) -> dict[str, str]:
    """Uses the values in .env, and asks for any that are missing. GitHub secrets cannot be read back, so this is where
    they come from on this computer."""
    values: dict[str, str] = {}
    asked = False
    for name, prompt, secret in REQUIRED:
        value = (saved.get(name) or "").strip()
        while not value:
            asked = True
            value = (getpass.getpass(f"{prompt}: ") if secret else input(f"{prompt}: ")).strip()
        if name == "SUPABASE_PROJECT_REF":
            # Accept the pasted full address too: https://abc.supabase.co -> abc
            value = value.replace("https://", "").split(".supabase.co")[0].strip("/ ")
        values[name] = value
    if asked:
        answer = input("\nSave these values to .env (git-ignored) so you are not asked again? [Y/n] ")
        if answer.strip().lower() not in ("n", "no"):
            save_env_file(values)
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description="Check the Bale bot's welcome button and send it to your chat.")
    parser.add_argument("--repo", help="your repository as OWNER/NAME (default: your account + bale-telegram-viewer)")
    parser.add_argument("--chat-id", help="send to this chat id instead of the one stored for you")
    parser.add_argument("--check-only", action="store_true", help="run the checks but do not send the button")
    args = parser.parse_args()

    say("1/4", "Values")
    values = collect_missing(read_env_file())
    ref = values["SUPABASE_PROJECT_REF"]
    key = values["SUPABASE_SERVICE_ROLE_KEY"]
    token = values["BALE_BOT_TOKEN"]
    print("  values ready")

    say("2/4", "The API and the web page")
    gh = require_gh()
    repo = resolve_repo(gh, args.repo)
    owner, _, name = repo.partition("/")
    page = f"https://{owner}.github.io/{name}/"
    api_status, _ = fetch(f"https://{ref}.supabase.co/functions/v1/api/health")
    page_status, _ = fetch(page)
    print(f"  API: {describe(api_status)}")
    print(f"  web page: {describe(page_status)}  ({page})")
    if page_status != 200:
        print("  The button opens the web page, so it will not work until the page is live "
              "(Settings -> Pages -> Source: GitHub Actions).")

    say("3/4", "Your private chat with the bot")
    if args.chat_id:
        chat_id = args.chat_id
    else:
        query = urllib.parse.urlencode({"select": "bale_chat_id", "bale_chat_id": "not.is.null", "limit": "1"})
        status, text = fetch(
            f"https://{ref}.supabase.co/rest/v1/users?{query}",
            headers={"apikey": key, "authorization": f"Bearer {key}"},
        )
        if status != 200:
            die(f"could not read the users table ({describe(status)}). Check the project ref and the service_role key.")
        rows = json.loads(text)
        if not rows:
            die("no chat is stored yet. Open the bot in Bale, send /start, then run this again.")
        chat_id = str(rows[0]["bale_chat_id"])
    print(f"  chat found: {chat_id}")

    say("4/4", "The button message")
    body = {
        "chat_id": int(chat_id),
        "text": WELCOME_TEXT,
        "reply_markup": {"inline_keyboard": [[{"text": OPEN_BUTTON_TEXT, "web_app": {"url": page}}]]},
    }
    if args.check_only:
        print("  --check-only: nothing was sent")
        return 0
    status, text = fetch(
        f"{BALE_API}/bot{token}/sendMessage",
        headers={"content-type": "application/json"},
        body=json.dumps(body).encode("utf-8"),
    )
    try:
        answer = json.loads(text)
    except ValueError:
        answer = {}
    if status == 200 and answer.get("ok") is True:
        print("  Bale accepted the message. Look at your private chat with the bot.")
        return 0
    if status == 0:
        print(f"  Could not reach Bale from this computer ({text}).")
        print("  This does not show whether the bot works: Bale's replies are sent from the cloud, not from this")
        print("  computer. Send /start to the bot in Bale and see whether the button appears.")
        return 1
    detail = answer.get("description") or text[:200] or describe(status)
    print(f"  Bale refused the message ({describe(status)}): {detail}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
