-- Step 2 of 2: widen keys and column default (run after 20260513120000 commits).

update public.api_keys
set surface_scope = array['collective', 'diaries', 'gallery', 'beats']::surface[]
where revoked_at is null
  and surface_scope = array['collective', 'diaries', 'gallery']::surface[];

alter table public.api_keys
  alter column surface_scope
  set default array['collective', 'diaries', 'gallery', 'beats']::surface[];
