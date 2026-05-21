-- Step 1 of 2: add enum value only.
-- PostgreSQL requires this to COMMIT before 'beats' can appear in casts/arrays.
-- Supabase runs each migration file in its own transaction (safe).
-- In the SQL editor: run this script alone, wait for success, then run
-- 20260513120001_beats_surface_scope_default.sql.

do $$ begin
  alter type surface add value 'beats';
exception
  when duplicate_object then null;
end $$;
