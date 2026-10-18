# Bale Telegram Viewer

A Bale Mini App that shows posts from public Telegram channels in chronological order (oldest at the top,
newest at the bottom), loads older posts when you scroll up, and lets a user ask for a channel file to be
delivered to their private chat with the Bale bot.

## Quick start

1. **Create three things** (about 10 minutes, once):
   - a **Supabase project** at supabase.com. Note its project ref, the database password you chose, the
     `service_role` key (Project Settings → API Keys), and an access token (Account → Access Tokens);
   - a **Bale bot** through BotFather, and its token;
   - a **Telegram app** at my.telegram.org, and its `api_id` and `api_hash`.
2. **Run the setup** from this folder. You need Python 3.9+ and the GitHub CLI (`gh auth login` once):

   ```sh
   python3 scripts/setup.py
   ```

   It asks for the seven values above once and offers to save them to a git-ignored `.env`. Then it creates
   the GitHub repository if this folder is not one yet, stores the values as GitHub secrets, runs the
   `bootstrap` workflow, asks for the Telegram login code (only if no session is stored yet), and starts the worker.
3. **Point the Mini App at the web page.** The page is at `https://<your-user>.github.io/<repo>/`. Set it as the
   Mini App address in the bot's settings in Bale. This one step is manual because the Bale API for it was not verified.

Running `scripts/setup.py` again is safe. Use `--no-start` to stop before the worker is started.

## What the setup does for you

Every value below is generated, derived or defaulted. You do not set any of them by hand.

| Item | How it is handled |
| --- | --- |
| Database schema and queues | `bootstrap` runs `supabase db push` |
| Bale token for the functions | `bootstrap` runs `supabase secrets set` |
| Edge Functions | `bootstrap` deploys `api` and `bale-webhook` with JWT checks off (they use their own auth) |
| Bale webhook URL and its secret path | Derived from the bot token: `HMAC(bot_token, "webhook:v1")`. Registered by `bootstrap` |
| App token signing key | Derived from the bot token: `HMAC(bot_token, "app-token:v1")` |
| CORS | Open by default. The API takes a bearer token in a header, not cookies, so this is safe |
| Supabase URL for the worker | Derived from the project ref |
| GitHub Pages | Enabled by the deploy workflow on its first run. The project URL is written into the page at build time |
| Worker chain | Starts itself after the first run; the watchdog restarts it if it stops |

Only the Telegram login (a phone code) and the Mini App address in Bale stay manual.

## Architecture

```
Bale Mini App (static files on GitHub Pages)
        │  HTTPS, Bearer app token
        ▼
Supabase Edge Function `api` ───────►  Postgres: cache, requests, jobs, state
        ▲                                   │
        │                                   │ PGMQ queues (message = row id only)
Bale ──► Edge Function `bale-webhook`       ▼
         (stores the private chat id)   Worker chain (GitHub Actions, Python + Telethon)
                                            │ reads Telegram, uploads to Bale
                                            ▼
                                       Bale chat with the user
```

- The API never talks to Telegram. It returns cached posts or queues a request for the worker.
- Only the worker talks to Telegram, and only the worker uploads files to Bale.
- Queue messages carry ids only. Status lives in tables and changes by compare-and-set, so a message
  delivered twice does not send a file twice.
- A file upload that may have reached Bale but has no confirmed result is marked `ambiguous`. It is never
  re-sent automatically.

### The worker chain

Each run lasts at most 5h30m. It stops taking new jobs at 5h15m and exits by 5h30m. At its start it queues its
successor. The successor waits in a concurrency group (one running, one pending) and starts as soon as the
current run ends. The chain itself needs no secrets: the built-in `GITHUB_TOKEN` queues the next run. The worker
needs its credentials to read the queue, reach Telegram, and upload to Bale. The Telegram session is stored
in Supabase, not in GitHub.

The watchdog runs every 15 minutes. It restarts a stalled or missing chain, but only after the Telegram login has
been stored, so it never starts a run that would fail.

## Deviations from the original design

These were needed because there is no always-on server. Review each one before go-live.

| Original | Here | Why |
| --- | --- | --- |
| FastAPI API | Supabase Edge Functions (TypeScript, Web APIs only) | Nothing needs to run 24/7 |
| Bale `getUpdates` polling | Webhook Edge Function on a derived secret path | Polling needs a process that always runs |
| Long-running worker on a host | Chain of GitHub Actions runs, each queuing its successor | Free compute with no host to maintain |
| Telegram session file | Telethon `StringSession` stored in Supabase `kv_state` | A session file cannot persist across runs; a string can |

## Repository layout

```
scripts/setup.py           The one command you run (values, secrets, bootstrap, login, start)
frontend/                  Static Mini App (vanilla JS modules, no build step)
supabase/migrations/       Schema, PGMQ queues, queue wrappers and permissions
supabase/functions/
  api/                     HTTP routes for the Mini App
  bale-webhook/            Bale updates → stores the private chat id
  _shared/                 Routes, auth, derived secrets, PostgREST client, pure rules
  tests/                   Node tests (in-memory database fake)
worker/                    Python worker: Telegram → cache, queue → Bale
.github/workflows/         bootstrap, worker chain, watchdog, Pages deploy, tests
```

## Operations

- **Stop the chain:** disable `telegram-bale-worker` and cancel the pending run in Actions, and disable the
  watchdog too, or it will restart the chain.
- **Logs are public** in a public repository. The worker does not log message content, tokens or the webhook
  path. Review logs before you share them.
- **Scheduled workflows** in public repositories are disabled after 60 days without repository activity. If the
  watchdog stops, re-enable it under Actions.
- **Telegram login again:** delete the `telegram_session` row in `kv_state`, then run `scripts/setup.py`.
- **Bale token rotation:** update `BALE_BOT_TOKEN` in GitHub secrets and run `scripts/setup.py` again. The
  webhook path and the app token key are both derived from the token, so they change with it.

## Security notes

- The browser only knows the API URL. It sends a short-lived app token that the API signs and checks. The
  Supabase service role key exists only in function environments and GitHub secrets.
- The webhook path is a secret: anyone who knows it can post fake updates. It is never printed.
- RLS is enabled on every table with no policies, so only the service role can access data.
- The Telegram session is an account credential. It is stored unencrypted in `kv_state`, which only the service
  role can read. If it leaks, revoke the session in Telegram's settings and run the login again.
- Mini App identity uses the signed `initData` that Bale provides. It is checked against the bot token, its
  freshness is checked, and the signature is compared in constant time. See the unverified items below.

## Verification status

Checked during the build:

- Python worker: 73 unit tests. `cd worker && python -m unittest discover -s tests -t .`
- Edge Function logic: 64 tests against an in-memory database fake. `node --test "supabase/functions/tests/*.test.ts"`
  (Node 22.18 or newer, which strips types without a build step)
- Frontend: 20 tests. `cd frontend && node --test "tests/*.test.js"`
- The webhook path is computed the same way in Python and TypeScript (checked against one shared test vector).

Not verified (these need a live run before go-live):

- The setup script against real GitHub and Supabase. Its steps were written, but not run.
- Supabase CLI commands in `bootstrap.yml` (`link`, `db push`, `secrets set`, `functions deploy`) and whether
  `db push` needs the confirmation answer the workflow supplies.
- Automatic GitHub Pages enablement through `configure-pages` with `enablement: true`.
- The Bale `setWebhook` parameter names. The docs.bale.ai Bot API page was read for limits, but not for this call.
- Live Telegram behavior through Telethon, live Bale API calls, and live Supabase and PGMQ. The `pgmq.*` functions
  used by migration 003 were not run against a database.
- The Bale Mini App `initData` algorithm and SDK. The code uses the Telegram Mini App scheme with the bot token as
  the key. `docs.bale.ai/miniapp` disallows automated access, so it was not read, and it was not bypassed.
- The Deno runtime for the Edge Functions. Tests run under Node; the code uses only Web-standard APIs, and it assumes
  Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to functions.
- TypeScript type-checking. The build environment could not reach the npm registry.

Known limitations:

- If a message is missing from the middle of the channel cache, it is not refetched. Only the older-history
  edge is fetched.
- A hand-off gap of about a minute happens each cycle, about every 5.5 hours.
- A channel's first view can take as long as the chain takes to pick up the request.
- Before `scripts/setup.py` has run, the watchdog and the first pushes may show failed runs. They are expected
  and stop once the setup is complete.
