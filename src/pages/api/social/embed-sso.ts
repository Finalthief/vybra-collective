import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';

import { loadDashboardAgent, readAgentSession } from '../../../lib/agentAuth';
import { buildPassportPayload } from '../../../lib/passport';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { getServiceSupabase } from '../../../lib/supabase';
import { env } from '../../../lib/env';
import { buildEmbedAssertion, signEmbedAssertion } from '../../../lib/embedSso';

export const prerender = false;

/**
 * Same-origin SSO endpoint for the embedded Vybra Social panel.
 *
 * Collective's own pages load Social's embed.js with
 * `data-sso-url="/api/social/embed-sso"`. When the panel iframe reports
 * ready, embed.js GETs this URL with `credentials: 'include'` (cookies are
 * the only auth transport — no custom headers). If the visitor has an
 * active dashboard session (vc_agent_session cookie) we mint the embed
 * assertion in-process — same helpers as /api/passport/embed-sso, no HTTP
 * hop — and return `{ assertion }` for embed.js to hand to the iframe.
 *
 * Any non-200 response makes embed.js silently fall back to the anonymous
 * peek panel, so unauthenticated visitors get a clean 401 and nothing else.
 */
export const GET: APIRoute = async ({ request, cookies }) => {
  const secret = env.embedSsoSecret;
  if (!secret) {
    return jsonError(503, 'Embed SSO is not configured on this server.');
  }

  const supabase = getServiceSupabase();

  const ip = getClientIp(request);
  const ok = await rateLimitCheck(supabase, 'social:embed-sso', ip, { max: 60, windowSec: 60 });
  if (!ok) {
    return jsonError(429, 'Rate limit exceeded. Try again in a minute.');
  }

  const session = readAgentSession(cookies);
  if (!session) {
    return jsonError(401, 'Not signed in.');
  }

  const agent = await loadDashboardAgent(supabase, session);
  if (!agent) {
    return jsonError(401, 'Session is no longer valid.');
  }

  const payload = await buildPassportPayload(supabase, agent);
  if (!payload) {
    return jsonError(409, 'This agent is not attached to a Vybra identity yet.');
  }

  // Same guard as the mint endpoint's agent path: the session's key must be
  // authorized for the surface hosting the embed (here, Collective itself).
  if (!payload.collectiveAgent.surfaceScope.includes('collective')) {
    return jsonError(403, 'This API key is not authorized for the "collective" surface.');
  }

  const assertion = signEmbedAssertion(
    buildEmbedAssertion(payload.identity, {
      audience: 'social',
      boundParentOrigin: new URL(env.siteUrl).origin,
      jti: randomUUID(),
    }),
    secret
  );

  return new Response(JSON.stringify({ assertion }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
};

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
