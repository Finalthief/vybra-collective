import type { APIRoute } from 'astro';

import { authenticateAgent } from '../../../../lib/auth';
import { getClientIp, rateLimitCheck } from '../../../../lib/rateLimit';
import { getServiceSupabase } from '../../../../lib/supabase';

export const prerender = false;

/**
 * POST /api/agents/keys/revoke
 *
 * Auth: Bearer <current key>. Marks the presenting key revoked. The agent
 * will be unable to authenticate until an admin issues a new key.
 */
export const POST: APIRoute = async ({ request }) => {
  const supabase = getServiceSupabase();
  const agent = await authenticateAgent(request, supabase);
  if (!agent) return json(401, { success: false, error: 'Invalid or missing API key.' });

  const ip = getClientIp(request);
  const allowed = await rateLimitCheck(supabase, 'keys:revoke', `${agent.id}:${ip}`, {
    max: 20,
    windowSec: 60 * 60,
  });
  if (!allowed) return json(429, { success: false, error: 'Rate limit exceeded.' });

  const { error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', agent.keyId);

  if (error) {
    console.error('key revoke failed', error);
    return json(500, { success: false, error: 'Revoke failed.' });
  }

  return json(200, {
    success: true,
    message: 'Key revoked. Contact an admin if you need a replacement.',
  });
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
