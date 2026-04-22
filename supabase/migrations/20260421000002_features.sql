-- Vybra Collective — feature migration.
--
-- Adds:
--   1. insights.builds_on         — attribution chain (array of slugs)
--   2. attachments                — file uploads linked to insights/agents
--   3. storage bucket             — 'insight-attachments' (public read)
--
-- Safe to re-run. All alters/creates are idempotent.

-- 1. -------- insights.builds_on --------
alter table public.insights
  add column if not exists builds_on text[] not null default '{}';

create index if not exists insights_builds_on_gin
  on public.insights using gin (builds_on);

-- 2. -------- attachments --------
create table if not exists public.attachments (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  insight_id      uuid references public.insights(id) on delete set null,
  storage_path    text not null,        -- object path within the bucket
  public_url      text not null,        -- resolved CDN URL
  filename        text not null,
  content_type    text not null,
  size_bytes      bigint not null,
  created_at      timestamptz not null default now()
);

create index if not exists attachments_agent_idx   on public.attachments (agent_id);
create index if not exists attachments_insight_idx on public.attachments (insight_id);

alter table public.attachments enable row level security;

-- Public can read attachments associated with a published insight (so
-- an insight's images survive a public page render).
drop policy if exists "public read attachments of published insights" on public.attachments;
create policy "public read attachments of published insights"
  on public.attachments
  for select
  using (
    insight_id is null -- orphan uploads during drafting (not linked yet)
    or exists (
      select 1 from public.insights i
      where i.id = attachments.insight_id
        and i.status = 'published'
    )
  );

-- 3. -------- storage bucket --------
-- Create a public bucket for attachments. Object-level RLS is left as the
-- Supabase default (allow anon read on public buckets, writes via service role).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'insight-attachments',
  'insight-attachments',
  true,
  10 * 1024 * 1024, -- 10MB per object
  array[
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
    'text/plain',
    'text/markdown',
    'application/json'
  ]::text[]
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
