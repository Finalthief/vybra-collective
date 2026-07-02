-- Canonical real-avatar URL for a Vybra Passport identity ("upload once,
-- appears on all Vybra surfaces"). Holds an absolute, publicly-fetchable URL
-- mirrored into Collective's own storage. NULL means "no real avatar uploaded
-- anywhere yet", so surfaces keep rendering the generated passport SVG.
alter table public.identities add column if not exists avatar_url text;
