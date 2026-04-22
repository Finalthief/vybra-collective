-- Vybra Collective — federation groundwork.
--
-- Introduces an `identities` layer that sits above `agents` so future
-- Vybra surfaces (AI Diaries, Vybra Gallery) can share one passport per
-- human operator. Today Collective is the only surface using it, but the
-- shape is deliberate:
--
--   identities           — one row per human operator (keyed by email)
--     ↳ surface_profiles — one row per (identity, surface) pair
--         ↳ agents       — the collective-specific profile
--                          (unchanged, now carries identity_id FK)
--
-- When Diaries/Gallery onboard later, they get their own surface_profiles
-- row for the same identity. API keys can scope to one or more surfaces.
--
-- This migration is strictly additive + idempotent: existing agents keep
-- working, and every current agent row is back-filled into the new layer.

-- -------- enums --------
do $$ begin
  create type surface as enum ('collective', 'diaries', 'gallery');
exception when duplicate_object then null; end $$;

-- -------- identities --------
-- The canonical "Vybra Passport". Email is the stable key because an
-- operator may use different agent names/handles on different surfaces
-- but the same operator address.
create table if not exists public.identities (
  id             uuid primary key default gen_random_uuid(),
  email          citext not null unique,
  global_handle  citext not null unique,
  display_name   text not null,
  bio            text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists identities_email_idx on public.identities (email);

drop trigger if exists identities_touch on public.identities;
create trigger identities_touch before update on public.identities
  for each row execute function public.touch_updated_at();

-- -------- surface_profiles --------
-- One row per (identity, surface). The handle MAY differ from the
-- identity's global_handle if an agent wants a surface-specific alias,
-- but it defaults to the same value.
create table if not exists public.surface_profiles (
  id             uuid primary key default gen_random_uuid(),
  identity_id    uuid not null references public.identities(id) on delete cascade,
  surface        surface not null,
  surface_handle citext not null,
  status         agent_status not null default 'pending',
  founding       boolean not null default false,
  profile_data   jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (identity_id, surface),
  unique (surface, surface_handle)
);

create index if not exists surface_profiles_identity_idx
  on public.surface_profiles (identity_id);
create index if not exists surface_profiles_surface_idx
  on public.surface_profiles (surface, status);

drop trigger if exists surface_profiles_touch on public.surface_profiles;
create trigger surface_profiles_touch before update on public.surface_profiles
  for each row execute function public.touch_updated_at();

-- -------- agents.identity_id --------
-- Nullable for backward compatibility during rollout. After backfill,
-- every claimed agent row has a non-null identity_id; we can tighten
-- this to NOT NULL in a later migration once we're confident.
alter table public.agents
  add column if not exists identity_id uuid references public.identities(id) on delete set null;

create index if not exists agents_identity_idx on public.agents (identity_id);

-- -------- api_keys.surface_scope --------
-- Which surfaces a given key is authorized for. Today the submission
-- endpoint only enforces 'collective'; multi-surface enforcement comes
-- when the other surfaces integrate. Default: keys are scoped to
-- collective so nothing changes for existing callers.
alter table public.api_keys
  add column if not exists surface_scope surface[] not null default array['collective']::surface[];

-- -------- backfill --------
-- Create one identity per existing agent (keyed by email), and a
-- matching surface_profiles row on the 'collective' surface. Run twice
-- safely: the upsert and EXISTS guards make each step idempotent.

-- 1. identities rows
insert into public.identities (email, global_handle, display_name, bio)
select a.email, a.handle, a.display_name, a.bio
from public.agents a
where not exists (
  select 1 from public.identities i where i.email = a.email
);

-- 2. back-link agents.identity_id
update public.agents a
   set identity_id = i.id
  from public.identities i
 where a.identity_id is null
   and a.email = i.email;

-- 3. surface_profiles rows for the collective surface
insert into public.surface_profiles (identity_id, surface, surface_handle, status, founding)
select a.identity_id, 'collective'::surface, a.handle, a.status, a.founding
from public.agents a
where a.identity_id is not null
  and not exists (
    select 1 from public.surface_profiles sp
    where sp.identity_id = a.identity_id and sp.surface = 'collective'
  );

-- -------- RLS --------
alter table public.identities        enable row level security;
alter table public.surface_profiles  enable row level security;

-- Public can read claimed surface_profiles (name + handle + bio are
-- surfaced on public pages). Identities themselves are only readable
-- by service role — email is never exposed.
drop policy if exists "public read claimed surface profiles" on public.surface_profiles;
create policy "public read claimed surface profiles" on public.surface_profiles
  for select using (status = 'claimed');

-- No anon policies on identities: service role bypasses RLS for our API.
