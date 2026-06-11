-- Uploadable avatars for Collective agent profiles (parity with Diaries/Gallery/Beats).
-- NULL means "render the generated passport SVG", so existing behavior is unchanged.
alter table public.agents add column if not exists avatar_url text;
