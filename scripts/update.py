#!/usr/bin/env python3
"""Update an existing installation after a code change. Run it from the project folder:

    python scripts\\update.py        (Windows)
    python3 scripts/update.py       (macOS, Linux)

It does only what changes after the first setup:
  1. uploads the files that changed to your GitHub repository as one commit, through the GitHub CLI (no git needed),
  2. re-sends the values from .env to GitHub secrets, only with --secrets,
  3. runs the `bootstrap` workflow again: database migrations, Edge Functions, Bale webhook, web page,
  4. checks that the API and the web page answer.

It does not ask for the Telegram login again and does not start another worker chain. The running worker reads the
code when each run starts, so it uses the new code from its next hand-off.

Needs: Python 3.9+ and the GitHub CLI logged in (the same as setup.py). Standard library only. Running it again is
safe. If your repository is not named bale-telegram-viewer under your account, pass it: --repo OWNER/NAME
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# setup.py sits next to this file and holds the GitHub helpers shared by both commands.
from setup import (  # noqa: E402
    DEFAULT_REPO_NAME,
    NAMES,
    ROOT,
    die,
    read_env_file,
    require_gh,
    run,
    say,
    set_secrets,
    start_workflow,
    wait_for_run,
)

SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", "node_modules", ".venv"}
SKIP_FILES = {".env", ".DS_Store", "update-log.txt"}  # .env holds secrets: never upload it
SKIP_SUFFIXES = (".session", ".pyc")


def gh_api(gh: str, method: str, path: str, body: dict | None = None) -> dict:
    args = [gh, "api", "-X", method, path]
    if body is None:
        result = run(args, check=False)
    else:
        args += ["--input", "-"]
        result = run(args, check=False, input_text=json.dumps(body))
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        die(f"GitHub refused {method} {path}: {detail}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def resolve_repo(gh: str, requested: str | None) -> str:
    candidates = [requested] if requested else []
    if not requested:
        login = run([gh, "api", "user", "--jq", ".login"], check=False).stdout.strip()
        if login:
            candidates.append(f"{login}/{DEFAULT_REPO_NAME}")
    for candidate in candidates:
        found = run([gh, "repo", "view", candidate, "--json", "nameWithOwner", "--jq", ".nameWithOwner"], check=False)
        if found.returncode == 0 and found.stdout.strip():
            return found.stdout.strip()
    die("could not find your repository. Run the command again with its name, for example: "
        "python scripts\\update.py --repo YOUR-USERNAME/bale-telegram-viewer")
    return ""


def local_files() -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for filename in filenames:
            if filename in SKIP_FILES or filename.endswith(SKIP_SUFFIXES):
                continue
            path = Path(dirpath) / filename
            files[path.relative_to(ROOT).as_posix()] = path.read_bytes()
    return files


def git_blob_sha(data: bytes) -> str:
    # The same id git gives a file: lets us compare local files with GitHub without downloading them.
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def upload_changes(gh: str, repo: str) -> None:
    base = f"repos/{repo}"
    branch = run(
        [gh, "repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], check=False
    ).stdout.strip() or "main"
    head_sha = gh_api(gh, "GET", f"{base}/git/ref/heads/{branch}")["object"]["sha"]
    base_tree = gh_api(gh, "GET", f"{base}/git/commits/{head_sha}")["tree"]["sha"]
    remote = gh_api(gh, "GET", f"{base}/git/trees/{base_tree}?recursive=1")
    remote_blobs = {item["path"]: item["sha"] for item in remote.get("tree", []) if item.get("type") == "blob"}

    changed = {
        rel: data for rel, data in local_files().items() if remote_blobs.get(rel) != git_blob_sha(data)
    }
    if not changed:
        print("  no changed files")
        return
    names = sorted(changed)
    shown = ", ".join(names[:8]) + (" ..." if len(names) > 8 else "")
    print(f"  {len(changed)} changed file(s): {shown}")

    entries = []
    for rel in names:
        blob = gh_api(
            gh,
            "POST",
            f"{base}/git/blobs",
            {"content": base64.b64encode(changed[rel]).decode("ascii"), "encoding": "base64"},
        )
        entries.append({"path": rel, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    tree = gh_api(gh, "POST", f"{base}/git/trees", {"base_tree": base_tree, "tree": entries})
    message = f"Update {datetime.now():%Y-%m-%d %H:%M}"
    commit = gh_api(gh, "POST", f"{base}/git/commits", {"message": message, "tree": tree["sha"], "parents": [head_sha]})
    gh_api(gh, "PATCH", f"{base}/git/refs/heads/{branch}", {"sha": commit["sha"]})
    print(f"  uploaded as one commit: {message}")


def values_from_env() -> dict[str, str]:
    saved = read_env_file()
    missing = [name for name in NAMES if not saved.get(name)]
    if missing:
        die("these values are missing from .env: " + ", ".join(missing) + ". Add them, then run this script again.")
    return {name: saved[name] for name in NAMES}


def check(label: str, url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            print(f"  {label}: ok ({response.status})")
            return True
    except urllib.error.HTTPError as exc:
        print(f"  {label}: HTTP {exc.code}  ({url})")
    except (urllib.error.URLError, OSError) as exc:
        print(f"  {label}: no answer ({type(exc).__name__})  ({url})")
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Update the Bale Telegram Viewer after a code change.")
    parser.add_argument("--repo", help="your repository as OWNER/NAME (default: your account + bale-telegram-viewer)")
    parser.add_argument("--no-push", action="store_true", help="do not upload changed files to GitHub")
    parser.add_argument("--secrets", action="store_true", help="re-send the values from .env to GitHub secrets")
    args = parser.parse_args()
    if sys.version_info < (3, 9):
        die("Python 3.9 or newer is required")

    say("1/4", "Uploading your changed files")
    gh = require_gh()
    repo = resolve_repo(gh, args.repo)
    print(f"  repository: {repo}")
    if args.no_push:
        print("  --no-push: nothing was uploaded")
    else:
        upload_changes(gh, repo)

    say("2/4", "Secrets")
    if args.secrets:
        set_secrets(gh, repo, values_from_env())
    else:
        print("  unchanged (run with --secrets after changing a value in .env)")

    say("3/4", "Bootstrap: database, Edge Functions, webhook, web page")
    run_id = start_workflow(gh, repo, "bootstrap.yml")
    if not wait_for_run(gh, repo, run_id):
        die("bootstrap failed. Open the link above, read the failing step, fix it, then run this script again.")

    say("4/4", "Checking")
    owner, _, name = repo.partition("/")
    results = []
    project_ref = read_env_file().get("SUPABASE_PROJECT_REF", "")
    if project_ref:
        results.append(check("API", f"https://{project_ref}.supabase.co/functions/v1/api/health"))
    else:
        print("  API: skipped (SUPABASE_PROJECT_REF is not in .env)")
    results.append(check("Web page", f"https://{owner}.github.io/{name}/"))
    if not all(results):
        print("\nSome checks failed. If the web page failed, turn Pages on once: repo Settings -> Pages -> "
              "Source: GitHub Actions, then run the deploy-pages workflow again.")
        return 1
    print(f"\nDone. Web page: https://{owner}.github.io/{name}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
