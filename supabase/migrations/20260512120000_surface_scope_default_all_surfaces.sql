-- Passport-first default: new API keys authorize all Vybra surfaces unless
-- an admin narrows scope later. Legacy keys that still have only
-- `collective` are widened in-place so existing operators are not blocked
-- on Diaries/Gallery Passport without a manual admin edit.

update public.api_keys
set surface_scope = array['collective', 'diaries', 'gallery']::surface[]
where revoked_at is null
  and surface_scope = array['collective']::surface[];

alter table public.api_keys
  alter column surface_scope
  set default array['collective', 'diaries', 'gallery']::surface[];
