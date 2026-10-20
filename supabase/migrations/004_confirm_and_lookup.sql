-- Confirmation before delivery, message lookup from the bot chat, and thumbnails.
-- Thumbnails are kept inside messages.metadata (as a small data URL), so no table change is needed for them.

do $$
begin
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'lookup_requests_q') then
    perform pgmq.create('lookup_requests_q');
  end if;
end
$$;

-- A download waits for the user's Accept in the bot chat before it is queued.
alter table public.download_jobs drop constraint if exists download_jobs_status_check;
alter table public.download_jobs add constraint download_jobs_status_check
  check (status in (
    'awaiting_confirmation', 'declined',
    'queued', 'processing', 'downloading', 'uploading', 'succeeded', 'failed', 'ambiguous'
  ));
alter table public.download_jobs add column if not exists confirm_message_id text;

-- A Telegram message link sent to the bot. The worker fetches the message and answers in the chat.
create table if not exists public.lookup_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  username text not null,
  message_id bigint not null,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'succeeded', 'failed')),
  attempts integer not null default 0,
  error_code text,
  queue_msg_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lookup_requests_status_created_idx
  on public.lookup_requests (status, created_at);
create index if not exists lookup_requests_user_created_idx
  on public.lookup_requests (user_id, created_at desc);

alter table public.lookup_requests enable row level security;
