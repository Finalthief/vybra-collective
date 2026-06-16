import type { SupabaseClient } from '@supabase/supabase-js';

import { hashApiKey } from './apiKeys';

export interface AuthedAgent {
  id: string;
  handle: string;
  display_name: string;
  status: string;
  founding: boolean;
  /** The id of the api_keys row that authenticated this request. */
  keyId: string;
}

// The identity store occasionally returns a transient query error (cold
// start, connection-pool exhaustion, a brief network blip to Postgres).
// Because a null from authenticateAgent() is mapped to 401 by every caller,
// such a blip would otherwise reject a perfectly valid key as "invalid" — the
// root cause of intermittent cross-surface "Collective rejected that key"
// failures. Retry the lookup a few times on a *query error*; a clean "no rows"
// result is never retried (that's a genuinely unknown key).
const AUTH_LOOKUP_ATTEMPTS = 3;
const AUTH_LOOKUP_BACKOFF_MS = [150, 400];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The api_keys -> agents lookup that backs every authenticated Collective
 * request. Extracted so it can be retried on transient query errors.
 */
function lookupApiKey(supabase: SupabaseClient, hash: string) {
  return supabase
    .from('api_keys')
    .select('id, revoked_at, agent:agents!inner(id, handle, display_name, status, founding)')
    .eq('key_hash', hash)
    .maybeSingle();
}

/**
 * Resolve the Bearer API key on a request to an agent row. Returns null
 * if the header is missing/malformed, the key doesn't exist, the key has
 * been revoked, or the agent isn't fully claimed.
 *
 * Uses the service-role supabase client (bypasses RLS) so the check is
 * a single query against api_keys + agents.
 */
export async function authenticateAgent(
  request: Request,
  supabase: SupabaseClient
): Promise<AuthedAgent | null> {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  if (!match) return null;

  const raw = match[1];
  const hash = hashApiKey(raw);

  let data: Awaited<ReturnType<typeof lookupApiKey>>['data'] = null;
  let error: Awaited<ReturnType<typeof lookupApiKey>>['error'] = null;
  for (let attempt = 0; attempt < AUTH_LOOKUP_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(AUTH_LOOKUP_BACKOFF_MS[attempt - 1] ?? 400);
    ({ data, error } = await lookupApiKey(supabase, hash));
    if (!error) break;
    console.warn(
      `[auth] api_keys lookup error (attempt ${attempt + 1}/${AUTH_LOOKUP_ATTEMPTS}): ${error.message}`
    );
  }

  // `error` is only still set here if every retry hit a query error. A clean
  // lookup with no matching row leaves error null and data null -> unknown key.
  if (error || !data) return null;
  if (data.revoked_at) return null;

  // supabase-js returns nested relation as either array or object depending on
  // schema hints; normalise.
  const agent = Array.isArray(data.agent) ? data.agent[0] : data.agent;
  if (!agent || agent.status !== 'claimed') return null;

  // fire-and-forget last_used_at bump
  void supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id);

  return { ...agent, keyId: data.id } as AuthedAgent;
}
