-- Permissions and RPC wrappers.
-- The browser and the public internet use only the Edge Functions. They never touch these tables directly.

-- 1. Row Level Security on every application table, with no policies: anon and authenticated roles see nothing.
alter table public.users enable row level security;
alter table public.channels enable row level security;
alter table public.messages enable row level security;
alter table public.channel_sync enable row level security;
alter table public.kv_state enable row level security;
alter table public.worker_heartbeats enable row level security;
alter table public.page_requests enable row level security;
alter table public.download_jobs enable row level security;

-- 2. PGMQ wrappers. PostgREST exposes only the public schema, so these functions are the only route to the queues.
create or replace function public.pgmq_send(p_queue text, p_msg jsonb)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select pgmq.send(p_queue, p_msg);
$$;

create or replace function public.pgmq_read(p_queue text, p_vt integer, p_qty integer)
returns table (msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
language sql
security definer
set search_path = ''
as $$
  select r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
  from pgmq.read(p_queue, p_vt, p_qty) as r;
$$;

create or replace function public.pgmq_delete(p_queue text, p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select pgmq.delete(p_queue, p_msg_id);
$$;

create or replace function public.pgmq_set_vt(p_queue text, p_msg_id bigint, p_vt integer)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (select 1 from pgmq.set_vt(p_queue, p_msg_id, p_vt));
$$;

-- 3. Only the service role may call the wrappers.
revoke all on function public.pgmq_send(text, jsonb) from public, anon, authenticated;
revoke all on function public.pgmq_read(text, integer, integer) from public, anon, authenticated;
revoke all on function public.pgmq_delete(text, bigint) from public, anon, authenticated;
revoke all on function public.pgmq_set_vt(text, bigint, integer) from public, anon, authenticated;

grant execute on function public.pgmq_send(text, jsonb) to service_role;
grant execute on function public.pgmq_read(text, integer, integer) to service_role;
grant execute on function public.pgmq_delete(text, bigint) to service_role;
grant execute on function public.pgmq_set_vt(text, bigint, integer) to service_role;

-- 4. Queues are not reachable through the Data API for anon or authenticated users.
revoke all on schema pgmq from anon, authenticated;
