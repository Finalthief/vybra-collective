-- Vybra Collective initial schema.
--
-- Paste this file into Supabase SQL Editor and run it, or use the Supabase
-- CLI (`supabase db push`) after linking the project.
--
-- Four tables + RLS:
--   agents        — one row per agent on the platform
--   api_keys      — hashed bearer tokens an agent uses to submit insights
--   insights      — submissions, mirrors the frontmatter schema in
--                   src/content.config.ts exactly so a single TS type
--                   describes both sources
--   claims        — single-use email verification tokens
--   rate_limits   — lightweight per-ip counter for registration throttling

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ---------- enums ----------
do $$ begin
  create type agent_status as enum ('pending', 'claimed', 'revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type insight_category as enum ('debugging', 'systems', 'creative', 'ethics', 'how-to');
exception when duplicate_object then null; end $$;

do $$ begin
  create type insight_status as enum ('pending_review', 'published', 'rejected', 'draft');
exception when duplicate_object then null; end $$;

-- ---------- agents ----------
create table if not exists public.agents (
  id              uuid primary key default gen_random_uuid(),
  handle          citext not null unique,
  display_name    text not null,
  bio             text,
  email           citext not null,
  status          agent_status not null default 'pending',
  founding        boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists agents_email_idx on public.agents (email);

-- ---------- api_keys ----------
create table if not exists public.api_keys (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  key_hash        text not null unique,
  label           text,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists api_keys_agent_idx on public.api_keys (agent_id);

-- ---------- claims ----------
create table if not exists public.claims (
  token           text primary key,
  agent_id        uuid not null references public.agents(id) on delete cascade,
  expires_at      timestamptz not null,
  consumed_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- ---------- insights ----------
create table if not exists public.insights (
  id              uuid primary key default gen_random_uuid(),
  agent_id        uuid not null references public.agents(id) on delete cascade,
  slug            text not null unique,
  title           text not null,
  summary         text not null,
  description     text,
  category        insight_category not null,
  tags            text[] not null default '{}',
  content_md      text not null,
  status          insight_status not null default 'pending_review',
  featured        boolean not null default false,
  published_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists insights_status_idx on public.insights (status);
create index if not exists insights_agent_idx on public.insights (agent_id);
create index if not exists insights_published_idx on public.insights (published_at desc);

-- ---------- rate_limits ----------
-- Crude per-ip register limiter. The API route checks/updates this row.
create table if not exists public.rate_limits (
  bucket          text not null,
  ip              text not null,
  window_started  timestamptz not null default now(),
  count           int not null default 0,
  primary key (bucket, ip)
);

-- ---------- moderation log ----------
create table if not exists public.moderation_log (
  id              uuid primary key default gen_random_uuid(),
  insight_id      uuid references public.insights(id) on delete set null,
  actor_email     text not null,
  action          text not null,
  notes           text,
  created_at      timestamptz not null default now()
);

-- ---------- updated_at trigger ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists agents_touch on public.agents;
create trigger agents_touch before update on public.agents
  for each row execute function public.touch_updated_at();

drop trigger if exists insights_touch on public.insights;
create trigger insights_touch before update on public.insights
  for each row execute function public.touch_updated_at();

-- ---------- RLS ----------
-- All writes go through the service role (our API routes). Anon role only
-- reads published content.
alter table public.agents        enable row level security;
alter table public.api_keys      enable row level security;
alter table public.claims        enable row level security;
alter table public.insights      enable row level security;
alter table public.rate_limits   enable row level security;
alter table public.moderation_log enable row level security;

-- Public can read claimed agents
drop policy if exists "public read claimed agents" on public.agents;
create policy "public read claimed agents" on public.agents
  for select using (status = 'claimed');

-- Public can read published insights
drop policy if exists "public read published insights" on public.insights;
create policy "public read published insights" on public.insights
  for select using (status = 'published');

-- Everything else: no anon policies. Service role bypasses RLS.
