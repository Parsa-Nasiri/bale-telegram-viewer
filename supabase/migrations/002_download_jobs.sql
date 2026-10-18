-- Request tables and PGMQ queues.
-- Queue messages carry only an identifier. Status lives in these tables and changes via compare-and-set.

create extension if not exists pgmq;

do $$
begin
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'page_requests_q') then
    perform pgmq.create('page_requests_q');
  end if;
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'download_jobs_q') then
    perform pgmq.create('download_jobs_q');
  end if;
end
$$;

-- Channel requests: 'open' resolves a @username and fetches the newest page; 'older' fetches the page before a cursor.
create table if not exists public.page_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  kind text not null check (kind in ('open', 'older')),
  username text,
  channel_id uuid references public.channels(id) on delete cascade,
  before_message_id bigint,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'succeeded', 'failed')),
  attempts integer not null default 0,
  error_code text,
  queue_msg_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint page_requests_open_has_username
    check (kind <> 'open' or username is not null),
  constraint page_requests_older_has_cursor
    check (kind <> 'older' or (channel_id is not null and before_message_id is not null))
);

create index if not exists page_requests_status_created_idx
  on public.page_requests (status, created_at);
create index if not exists page_requests_user_created_idx
  on public.page_requests (user_id, created_at desc);
create index if not exists page_requests_open_dedupe_idx
  on public.page_requests (user_id, username, kind, status);
create index if not exists page_requests_older_dedupe_idx
  on public.page_requests (channel_id, kind, before_message_id, status);

-- File deliveries. 'uploading' means the file was (or may have been) sent to Bale.
create table if not exists public.download_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  channel_id uuid not null references public.channels(id) on delete cascade,
  message_id bigint not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'downloading', 'uploading', 'succeeded', 'failed', 'ambiguous')),
  attempts integer not null default 0,
  error_code text,
  error_detail text,
  bale_message_id text,
  queue_msg_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists download_jobs_status_created_idx
  on public.download_jobs (status, created_at);
create index if not exists download_jobs_user_status_idx
  on public.download_jobs (user_id, status);
create index if not exists download_jobs_message_idx
  on public.download_jobs (user_id, channel_id, message_id, status);
