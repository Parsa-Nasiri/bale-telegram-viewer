-- Core tables. Only the service role (worker and Edge Functions) reads or writes them.
-- Row Level Security is enabled in 003_queue_permissions.sql with no policies.

create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  bale_user_id text not null unique,
  bale_chat_id text,                       -- private chat id, set when the user starts the bot
  display_name text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  telegram_peer_id text not null unique,
  username text unique,                    -- stored lowercase, without @
  title text,
  created_at timestamptz not null default now()
);

-- Cache of channel posts. File references are never stored: they expire, so the worker re-fetches a message before downloading it.
create table if not exists public.messages (
  channel_id uuid not null references public.channels(id) on delete cascade,
  message_id bigint not null,
  date timestamptz not null,
  text text,
  media_type text,
  group_id text,
  metadata jsonb not null default '{}'::jsonb,
  cached_at timestamptz not null default now(),
  primary key (channel_id, message_id)
);

create index if not exists messages_channel_message_desc_idx
  on public.messages (channel_id, message_id desc);

-- How far the cache reaches in each direction, and whether the channel's history is fully cached.
create table if not exists public.channel_sync (
  channel_id uuid primary key references public.channels(id) on delete cascade,
  newest_message_id bigint,
  oldest_message_id bigint,
  history_exhausted boolean not null default false,
  updated_at timestamptz not null default now()
);

-- Small service state: the Telegram session string lives under key 'telegram_session'.
create table if not exists public.kv_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Written by the worker, read by the watchdog to detect hung runs.
create table if not exists public.worker_heartbeats (
  name text primary key,
  run_id text not null,
  status text not null,
  updated_at timestamptz not null default now()
);
