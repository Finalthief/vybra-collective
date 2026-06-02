-- Allow multiple Collective agents per operator email (up to 5, enforced in app).
--
-- Previously: unique (identity_id, surface) blocked a second collective agent
-- for the same identity. External surfaces (diaries, gallery, beats) stay
-- one linked profile per identity via a partial unique index.

alter table public.surface_profiles
  drop constraint if exists surface_profiles_identity_id_surface_key;

create unique index if not exists surface_profiles_identity_surface_external_unique
  on public.surface_profiles (identity_id, surface)
  where surface <> 'collective'::surface;
