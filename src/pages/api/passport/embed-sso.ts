import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';

import { authenticateAgent } from '../../../lib/auth';
import { buildPassportPayload } from '../../../lib/passport';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { getServiceSupabase } from '../../../lib/supabase';
import { env } from '../../../lib/env';
import {
  buildEmbedAssertion,
  signEmbedAssertion,
  embedAllowedOriginSurfaces,
  EMBED_ALLOWED_AUDIENCES,
  type EmbedAudience,
} from '../../../lib/embedSso';

export const prerender = false;

/**
 * Vybra embed-SSO mint endpoint.
 *
 * A Vybra surface that embeds the Vybra Social slide-out panel calls this from
 * its OWN backend (with the member's `vc_...` key, the same credential it uses
 * for /api/passport/verify) to obtain a short-lived, origin-bound, single-use
 * assertion. It hands that to the embedded iframe, which redeems it at Vybra
 * Social for a session — no sign-in click, no third-party cookies.
 *
 * Request:
 *   POST /api/passport/embed-sso
 *   Authorization: Bearer vc_...
 *   body (JSON): { "boundParentOrigin": "https://www.vybradiary.com", "audience": "social" }
 *
 * `boundParentOrigin` must be in VYBRA_EMBED_ALLOWED_ORIGINS; the minted
 * assertion is bound to it so a leaked assertion can't be redeemed elsewhere.
 * Fails closed (503) when VYBRA_EMBED_SSO_SECRET / allow-list aren't configured.
 */
export const POST: APIRoute = async ({ request }) => {
  const secret = env.embedSsoSecret;
  if (!secret) {
    return jsonError(503, 'Embed SSO is not configured on this server.');
  }
  const originSurfaces = embedAllowedOriginSurfaces();
  if (originSurfaces.size === 0) {
    return jsonError(503, 'Embed SSO has no allowed host origins configured.');
  }

  const supabase = getServiceSupabase();

  const ip = getClientIp(request);
  const ok = await rateLimitCheck(supabase, 'passport:embed-sso', ip, { max: 60, windowSec: 60 });
  if (!ok) {
    return jsonError(429, 'Rate limit exceeded. Try again in a minute.');
  }

  const agent = await authenticateAgent(request, supabase);
  if (!agent) {
    return jsonError(401, 'Invalid or missing API key. Include `Authorization: Bearer vc_...`.');
  }

  let boundParentOrigin: string;
  let audience: string = 'social';
  try {
    const text = await request.text();
    const parsed = (text.trim().length > 0 ? JSON.parse(text) : {}) as {
      boundParentOrigin?: unknown;
      audience?: unknown;
    };
    if (typeof parsed.boundParentOrigin !== 'string' || parsed.boundParentOrigin.trim() === '') {
      return jsonError(400, '`boundParentOrigin` (string) is required.');
    }
    boundParentOrigin = parsed.boundParentOrigin;
    if (parsed.audience !== undefined) {
      if (typeof parsed.audience !== 'string') return jsonError(400, '`audience` must be a string.');
      audience = parsed.audience;
    }
  } catch {
    return jsonError(400, 'Request body must be JSON.');
  }

  const hostSurface = originSurfaces.get(boundParentOrigin);
  if (!hostSurface) {
    return jsonError(403, `Origin "${boundParentOrigin}" is not an allowed embed host.`);
  }
  if (!EMBED_ALLOWED_AUDIENCES.includes(audience as EmbedAudience)) {
    return jsonError(400, `Unknown embed audience "${audience}".`);
  }

  const payload = await buildPassportPayload(supabase, agent);
  if (!payload) {
    return jsonError(
      409,
      'This agent is not attached to a Vybra identity yet. Ask the operator to re-claim.'
    );
  }

  // Honor the admin's per-key surface restriction (parity with /api/passport/verify): the key
  // must be authorized for the surface the embedding host belongs to. Without this, a key
  // narrowed to exclude that surface could still be turned into a Vybra Social session.
  if (!payload.collectiveAgent.surfaceScope.includes(hostSurface)) {
    return jsonError(403, `This API key is not authorized for the "${hostSurface}" surface.`, {
      scope: payload.collectiveAgent.surfaceScope,
      host: hostSurface,
    });
  }

  const assertion = signEmbedAssertion(
    buildEmbedAssertion(payload.identity, { audience, boundParentOrigin, jti: randomUUID() }),
    secret
  );

  return new Response(JSON.stringify({ success: true, assertion }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
};

function jsonError(status: number, message: string, details?: unknown) {
  return new Response(JSON.stringify({ success: false, error: message, details }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
