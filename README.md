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
3. **Turn on GitHub Pages once, then point the Mini App at it.** In your repo, go to Settings → Pages and set
   Source to **GitHub Actions**. Run the `deploy-pages` workflow under Actions. The page is at
   `https://<your-user>.github.io/<repo>/`. In Bale, open @BotFather and set this address as the bot's main Mini App.
   These steps stay manual.

Running `scripts/setup.py` again is safe. Use `--no-start` to stop before the worker is started. After a later code
change, use `python3 scripts/update.py` instead (see "Updating after a code change" below).

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
| GitHub Pages | The deploy workflow builds the page and writes the project URL into it. Turning Pages on is a one-time switch you make (Settings → Pages → Source: GitHub Actions), because the built-in token cannot do it |
| Worker chain | Starts itself after the first run; the watchdog restarts it if it stops |

Only the Telegram login (a phone code), the one-time GitHub Pages switch, and the Mini App address in Bale stay manual.

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

## Updating after a code change

Once setup has run, do not run `setup.py` again for code changes. Run this instead, from the repository folder:

```sh
python3 scripts/update.py
```

It uploads the files that changed to your GitHub repository as one commit, runs the `bootstrap` workflow again
(migrations, Edge Functions, webhook, web page), and checks that the API and the web page answer. It does not need git,
and it never uploads `.env`. It does not ask for the Telegram login again. The running worker uses the new code from
its next hand-off.

If your repository is not named `bale-telegram-viewer` under your GitHub account, give its name:

```sh
python scripts\update.py --repo YOUR-USERNAME/YOUR-REPO-NAME
```

- `--no-push`: skip the upload, for example when the files are already on GitHub.
- `--secrets`: also re-send the values from `.env` to GitHub secrets. Use it after changing a value such as the
  Bale token.
- `--restart-worker`: cancel the active worker run and start a new one now, so changes to the worker and to the
  bot's replies take effect at once. Without it they take effect at the next hand-off (about every 5 hours).
  If no worker run is active, nothing is started.

## Downloads, lookups and thumbnails

**Download with confirmation.** Tapping *دریافت فایل* in the Mini App does not start the download. The bot sends
the user a card in their private chat: the thumbnail (when the message has one), the channel, message id, date,
file name, size, sender and the start of the text, with two buttons, *تأیید دانلود* (accept) and *لغو* (decline).
Only Accept queues the file for the worker. Decline cancels it. A card expires after 30 minutes, and a tap after
that is refused. Tapping Accept twice queues the file once. The job's status is `awaiting_confirmation` until the
user answers, then `queued` (accepted) or `declined`.

**Lookup in the bot chat.** Send the bot a Telegram message link (`https://t.me/channel/123`) or an identifier
(`@channel/123`). The worker fetches that message and sends the same card. If the file can be delivered, the card
has the two buttons. The lookup also caches the message, so it appears in the Mini App. Each user can make 30
lookups per hour.

**Thumbnails.** The smallest Telegram thumbnail of a media message is stored with the message, as a JPEG or PNG
data URL of about 29 KB at most. Messages without a usable thumbnail show the file box only.

Where the code lives: the `api` function builds and sends the download card (`_shared/card.ts`, `_shared/bale.ts`);
`bale-webhook` handles lookups and the Accept and Decline taps (`_shared/webhook.ts`); the worker builds the lookup
card (`worker/bale_viewer_worker/card.py`). The two card builders follow the same rules, and both test suites check
the same expected text.

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

- Python worker: 98 unit tests. `cd worker && python -m unittest discover -s tests -t .`
- Edge Function logic: 98 tests against an in-memory database fake. `node --test "supabase/functions/tests/*.test.ts"`
  (Node 22.18 or newer, which strips types without a build step)
- Frontend: 35 tests. `cd frontend && node --test "tests/*.test.js"`
- The webhook path is computed the same way in Python and TypeScript (checked against one shared test vector).

Not verified (these need a live run before go-live):

- The setup script against real GitHub and Supabase. Its steps were written, but not run.
- Supabase CLI commands in `bootstrap.yml` (`link`, `db push`, `secrets set`, `functions deploy`) and whether
  `db push` needs the confirmation answer the workflow supplies.
- Automatic GitHub Pages enablement. In a live run the built-in token failed with "Resource not accessible by
  integration", so Pages is turned on by hand (Quick start, step 3).
- The Bale `setWebhook` parameter names. The docs.bale.ai Bot API page was read for limits, but not for this call.
- Live Telegram behavior through Telethon, live Bale API calls, and live Supabase and PGMQ. The `pgmq.*` functions
  used by migration 003 were not run against a database.
- The `/start` button reply (`sendMessage` with a `web_app` inline button) has not run against Bale yet. The button's
  format follows Bale's Mini App docs.
- Live Bale Mini App login. The SDK script (`https://tapi.bale.ai/miniapp.js`), the `window.Bale.WebApp` object and
  the `initData` check match Bale's Mini App documentation, but none of it has run live yet.
- The Deno runtime for the Edge Functions. Tests run under Node; the code uses only Web-standard APIs, and it assumes
  Supabase provides `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to functions.
- Bale's Bot API calls used by the confirmation flow: `sendPhoto` (multipart upload), `sendMessage` with an inline
  keyboard, `answerCallbackQuery`, `editMessageReplyMarkup`, and the `callback_query` update that a button tap sends
  (its `from`, `message` and `data` fields are read the way Telegram sends them). Bale's docs read so far do not
  describe these. A card whose photo is refused is sent as text, but if the Accept and Decline buttons do nothing,
  check these calls first.
- Telethon's thumbnail download (`download_media(..., thumb=0)`) on live messages.
- Bale's theme key names (`bg_color`, `text_color`, `hint_color`, `link_color`, and so on). The page uses them only
  when the SDK provides them, and it keeps its own colors otherwise.
- The Vazirmatn font from Google Fonts. Without it the page uses Tahoma or the system font.
- TypeScript type-checking. The build environment could not reach the npm registry.

Known limitations:

- If a message is missing from the middle of the channel cache, it is not refetched. Only the older-history
  edge is fetched.
- A hand-off gap of about a minute happens each cycle, about every 5.5 hours.
- A channel's first view can take as long as the chain takes to pick up the request.
- Bale's web client shows Mini Apps in a frame, and Bale's docs require the page's headers to allow that. GitHub
  Pages sets its own headers and they cannot be changed here. If the Mini App opens in the Bale app but not in
  Bale web, check this first.
- Before `scripts/setup.py` has run, the watchdog and the first pushes may show failed runs. They are expected
  and stop once the setup is complete.

## Troubleshooting

- **Testing the bot's button:** run `python scripts\bot_check.py` after you send `/start` to the bot. It checks the
  API and the web page, finds your chat, and sends the button. If Bale refuses the button, it prints Bale's reason.

- **The page address shows a 404 ("There isn't a GitHub Pages site here"):** Pages is not turned on yet. Go to
  Settings → Pages, set Source to GitHub Actions, then run `deploy-pages` under Actions.

- **The page shows a Persian message saying it was not opened inside Bale, or that Bale sent no login data:** the
  page was opened outside Bale, or the SDK script in `frontend/index.html` did not load. Open the Mini App from the
  bot inside Bale (the app or Bale web), not by pasting the link into a plain browser tab.
- **Opening a channel does nothing:** in Supabase, check `page_requests`. A new row means the API got the request,
  and the worker should pick it up. No row means the page never reached the API, so look at the page first.
- **Worker run shows only Telegram update lines:** that is normal when nothing is queued. The worker logs only
  failures and warnings for requests and jobs, so a healthy run looks quiet. Check `page_requests` and
  `download_jobs` in Supabase to see what it handled.
- **Downloads fail with `BALE_CHAT_REQUIRED`:** the user has not written to the Bale bot yet, so no private chat id
  is stored. Send any message to the bot once.
- **Accept or Decline does nothing:** check the `bale-webhook` function logs in Supabase. If no request arrives after
  a tap, Bale does not send button taps to the webhook in this form (see the unverified list). The card's buttons
  then show nothing useful, and the job expires after 30 minutes.
- **A link sent to the bot gets no answer:** check `lookup_requests` in Supabase. `failed` rows carry an
  `error_code`, and the bot also tells the user why for missing channels and messages. A row that stays `queued`
  means the worker has not picked it up yet. If it stays that way for a while, run
  `python3 scripts/update.py --restart-worker`.
- **The worker still runs old code after an update:** run `python3 scripts/update.py --restart-worker`. Without the
  flag, the new code starts at the next hand-off, about every 5 hours.
