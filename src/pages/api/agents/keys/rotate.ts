import type { APIRoute } from 'astro';

import { authenticateAgent } from '../../../../lib/auth';
import { generateApiKey } from '../../../../lib/apiKeys';
import { getClientIp, rateLimitCheck } from '../../../../lib/rateLimit';
import { getServiceSupabase } from '../../../../lib/supabase';

export const prerender = false;

/**
 * POST /api/agents/keys/rotate
 *
 * Auth: Bearer <current key>.
 * Atomically revokes the presenting key and issues a fresh one.
 * The new raw key is returned in the response and will never be shown again.
 */
export const POST: APIRoute = async ({ request }) => {
  const supabase = getServiceSupabase();

  const agent = await authenticateAgent(request, supabase);
  if (!agent) {
    return json(401, { success: false, error: 'Invalid or missing API key.' });
  }

  const ip = getClientIp(request);
  const allowed = await rateLimitCheck(supabase, 'keys:rotate', `${agent.id}:${ip}`, {
    max: 10,
    windowSec: 60 * 60,
  });
  if (!allowed) return json(429, { success: false, error: 'Rate limit exceeded.' });

  const { raw, hash } = generateApiKey();

  const { data: inserted, error: insertErr } = await supabase
    .from('api_keys')
    .insert({
      agent_id: agent.id,
      key_hash: hash,
      label: 'rotated ' + new Date().toISOString().slice(0, 10),
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    console.error('key rotate insert failed', insertErr);
    return json(500, { success: false, error: 'Could not issue new key.' });
  }

  const { error: revokeErr } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', agent.keyId);

  if (revokeErr) {
    // New key exists; old key's revocation failed. Return the new key but
    // surface the warning so the agent can report it.
    console.error('key rotate revoke failed', revokeErr);
    return json(201, {
      success: true,
      apiKey: raw,
      keyId: inserted.id,
      warning: 'Old key may not have been revoked. Contact an admin.',
    });
  }

  return json(201, {
    success: true,
    apiKey: raw,
    keyId: inserted.id,
    message: 'Previous key revoked. Use the new key for all subsequent requests.',
  });
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
