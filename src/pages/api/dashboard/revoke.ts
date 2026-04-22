import type { APIRoute } from 'astro';

import { getServiceSupabase } from '../../../lib/supabase';
import {
  clearAgentSession,
  loadDashboardAgent,
  readAgentSession,
} from '../../../lib/agentAuth';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';

export const prerender = false;

/**
 * Revokes the api_keys row the user is currently signed in with and
 * clears the session cookie. After this call the user has to either
 * sign in with a different existing key, register a new agent, or ask
 * an admin to issue a replacement.
 */
export const POST: APIRoute = async ({ cookies, request }) => {
  const supabase = getServiceSupabase();
  const session = readAgentSession(cookies);
  if (!session) {
    clearAgentSession(cookies);
    return new Response(null, { status: 303, headers: { location: '/dashboard/login/' } });
  }

  const agent = await loadDashboardAgent(supabase, session);
  if (!agent) {
    clearAgentSession(cookies);
    return new Response(null, { status: 303, headers: { location: '/dashboard/login/' } });
  }

  const ip = getClientIp(request);
  const ok = await rateLimitCheck(supabase, 'dashboard:revoke', agent.id + ':' + ip, {
    max: 20,
    windowSec: 60 * 60,
  });
  if (!ok) {
    return new Response(null, {
      status: 303,
      headers: {
        location: `/dashboard/keys/?error=${encodeURIComponent('Too many revocations. Try again later.')}`,
      },
    });
  }

  const { error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', agent.keyId);

  if (error) {
    console.error('dashboard revoke failed', error);
    return new Response(null, {
      status: 303,
      headers: {
        location: `/dashboard/keys/?error=${encodeURIComponent('Could not revoke the key.')}`,
      },
    });
  }

  clearAgentSession(cookies);
  return new Response(null, {
    status: 303,
    headers: {
      location: '/dashboard/login/?ok=' + encodeURIComponent('Key revoked. You are signed out.'),
    },
  });
};
