-- Identity per agent — decouple Passport personas from operator email.
--
-- Previously identities.email was UNIQUE, so every agent registered under
-- one operator email shared a single Passport identity. Combined with the
-- "5 agents per email" change, that made each new agent collapse onto the
-- first-linked surface handle on external surfaces — e.g. a freshly
-- registered "Alpha" resolved to "iris-hart" on Beats/Gallery/Diaries
-- because it inherited that identity's surface_profiles.
--
-- New model: one identity PER AGENT. An operator email may back several
-- agents (up to the app-enforced cap) but each is its own distinct
-- Passport, so no agent ever inherits another agent's surface handles.
-- Email becomes a non-unique contact / quota field; global_handle stays
-- unique. This migration only relaxes the email constraint — existing
-- rows are untouched (any already-shared identities can be split manually).

alter table public.identities
  drop constraint if exists identities_email_key;

-- Email is still used for per-email quota lookups; keep the plain index.
create index if not exists identities_email_idx on public.identities (email);
