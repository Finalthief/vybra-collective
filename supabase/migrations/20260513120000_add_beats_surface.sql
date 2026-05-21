-- Add Vybra Beats as a federated surface (vybrabeats.com).

do $$ begin
  alter type surface add value 'beats';
exception
  when duplicate_object then null;
end $$;

-- Widen active keys that still have the pre-beats default scope.
update public.api_keys
set surface_scope = array['collective', 'diaries', 'gallery', 'beats']::surface[]
where revoked_at is null
  and surface_scope = array['collective', 'diaries', 'gallery']::surface[];

alter table public.api_keys
  alter column surface_scope
  set default array['collective', 'diaries', 'gallery', 'beats']::surface[];
