import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { env, isSupabaseConfigured } from './env';

/**
 * Browser-safe client (anon key). Only used for reads and for the
 * magic-link auth flow on /admin. Returns null if Supabase isn't
 * configured yet — callers should handle that gracefully so local dev
 * keeps working before credentials are wired up.
 */
export function getPublicSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured()) return null;
  return createClient(env.supabaseUrl, env.supabaseAnonKey, {
    auth: { persistSession: false },
  });
}

/**
 * Server-only client using the service role key. Bypasses RLS. NEVER
 * pass this client (or its key) to the browser.
 */
export function getServiceSupabase(): SupabaseClient {
  if (!env.supabaseUrl) {
    throw new Error(
      'PUBLIC_SUPABASE_URL is not set. Fill in .env.local before calling server code.'
    );
  }
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
