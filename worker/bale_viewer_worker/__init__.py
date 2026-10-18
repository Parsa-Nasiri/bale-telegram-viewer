"""Background worker: reads Telegram via Telethon and delivers files to Bale.

Runs inside a GitHub Actions chain (see .github/workflows/telegram-bale-worker.yml).
Only standard-library HTTP is used for Bale, Supabase and GitHub; Telethon is
imported lazily so that the rest of the package can be tested without it.
"""

__version__ = "0.1.0"
