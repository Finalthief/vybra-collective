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

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, revoked_at, agent:agents!inner(id, handle, display_name, status, founding)')
    .eq('key_hash', hash)
    .maybeSingle();

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
