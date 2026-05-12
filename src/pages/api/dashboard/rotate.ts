import type { APIRoute } from 'astro';

import { getServiceSupabase } from '../../../lib/supabase';
import { generateApiKey } from '../../../lib/apiKeys';
import { DEFAULT_API_KEY_SURFACE_SCOPE } from '../../../lib/surfaces';
import {
  clearAgentSession,
  issueAgentSession,
  readAgentSession,
  loadDashboardAgent,
} from '../../../lib/agentAuth';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';

export const prerender = false;

/**
 * Dashboard-side key rotation: reuses the same logic as the JSON API
 * but (a) reads the session cookie instead of a Bearer header, and
 * (b) returns a redirect with a one-time flash param so the new raw
 * key can be shown in the UI exactly once.
 */
export const POST: APIRoute = async ({ cookies, request }) => {
  const supabase = getServiceSupabase();
  const session = readAgentSession(cookies);
  if (!session) {
    return redirectToLogin('Session expired. Sign in again.');
  }

  const agent = await loadDashboardAgent(supabase, session);
  if (!agent) {
    clearAgentSession(cookies);
    return redirectToLogin('Session is no longer valid.');
  }

  const ip = getClientIp(request);
  const ok = await rateLimitCheck(supabase, 'dashboard:rotate', agent.id + ':' + ip, {
    max: 10,
    windowSec: 60 * 60,
  });
  if (!ok) {
    return redirectWithError('Too many rotations. Try again later.');
  }

  const { raw, hash } = generateApiKey();

  const { data: prevKey } = await supabase
    .from('api_keys')
    .select('surface_scope')
    .eq('id', agent.keyId)
    .maybeSingle();

  const prevScope = prevKey?.surface_scope as string[] | null | undefined;
  const surface_scope =
    Array.isArray(prevScope) && prevScope.length > 0 ? prevScope : DEFAULT_API_KEY_SURFACE_SCOPE;

  const { data: newKey, error: insertErr } = await supabase
    .from('api_keys')
    .insert({
      agent_id: agent.id,
      key_hash: hash,
      label: 'dashboard-rotation',
      surface_scope,
    })
    .select('id')
    .single();

  if (insertErr || !newKey) {
    console.error('dashboard rotate insert failed', insertErr);
    return redirectWithError('Could not issue a replacement key.');
  }

  const { error: revokeErr } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', agent.keyId);
  if (revokeErr) {
    console.error('dashboard rotate revoke failed', revokeErr);
    // We already issued the new key; don't 500 the UX. Log and continue.
  }

  // Rebind the session cookie to the new key so the user stays signed in.
  issueAgentSession(cookies, agent.id, newKey.id);

  return new Response(null, {
    status: 303,
    headers: {
      location: `/dashboard/keys/?issued=${encodeURIComponent(raw)}`,
    },
  });
};

function redirectToLogin(msg: string) {
  return new Response(null, {
    status: 303,
    headers: { location: `/dashboard/login/?expired=1&reason=${encodeURIComponent(msg)}` },
  });
}

function redirectWithError(msg: string) {
  return new Response(null, {
    status: 303,
    headers: { location: `/dashboard/keys/?error=${encodeURIComponent(msg)}` },
  });
}
