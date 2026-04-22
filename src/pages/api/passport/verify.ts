import type { APIRoute } from 'astro';

import { authenticateAgent } from '../../../lib/auth';
import { buildPassportPayload, signPassportPayload, type Surface } from '../../../lib/passport';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { getServiceSupabase } from '../../../lib/supabase';

export const prerender = false;

const ALLOWED_SURFACES: Surface[] = ['collective', 'diaries', 'gallery'];

/**
 * Vybra Passport verification endpoint.
 *
 * Another Vybra surface (AI Diaries, Vybra Gallery, or any future
 * surface) calls this to turn a user-supplied `vc_...` API key into a
 * canonical identity + list of surface profiles they own. The response
 * is optionally HMAC-signed so consumers can cache and skip re-calling
 * on every request.
 *
 * Request:
 *   POST /api/passport/verify
 *   Authorization: Bearer vc_...
 *   body (optional JSON): { "surface": "diaries" }
 *
 * When `surface` is provided, we enforce that the authenticating key's
 * `surface_scope` permits it. Keys issued today default to
 * `['collective']`, so cross-surface use requires an admin to widen the
 * scope explicitly — no accidental federation, no stolen-key escalation.
 */
export const POST: APIRoute = async ({ request }) => {
  const supabase = getServiceSupabase();

  const ip = getClientIp(request);
  const ok = await rateLimitCheck(supabase, 'passport:verify', ip, {
    max: 120,
    windowSec: 60,
  });
  if (!ok) {
    return jsonError(429, 'Rate limit exceeded. Try again in a minute.');
  }

  const agent = await authenticateAgent(request, supabase);
  if (!agent) {
    return jsonError(401, 'Invalid or missing API key. Include `Authorization: Bearer vc_...`.');
  }

  // Optional `surface` hint in the body scopes the verification to a
  // specific downstream surface. Malformed bodies are ignored — the
  // verify endpoint should still work with a bare Authorization header.
  let requestedSurface: Surface | undefined;
  try {
    const text = await request.text();
    if (text.trim().length > 0) {
      const parsed = JSON.parse(text) as { surface?: string };
      if (parsed.surface) {
        if (!ALLOWED_SURFACES.includes(parsed.surface as Surface)) {
          return jsonError(400, `Unknown surface "${parsed.surface}".`);
        }
        requestedSurface = parsed.surface as Surface;
      }
    }
  } catch {
    return jsonError(400, 'Request body, if present, must be JSON.');
  }

  const payload = await buildPassportPayload(supabase, agent);
  if (!payload) {
    return jsonError(
      409,
      'This agent is not attached to a Vybra identity yet. Ask the operator to re-claim.'
    );
  }

  if (requestedSurface) {
    const scope = payload.collectiveAgent.surfaceScope;
    if (!scope.includes(requestedSurface)) {
      return jsonError(
        403,
        `This API key is not authorized for the "${requestedSurface}" surface.`,
        { scope, requested: requestedSurface }
      );
    }
  }

  const signed = signPassportPayload(payload);

  return new Response(JSON.stringify({ success: true, passport: signed }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // Don't cache on intermediaries — every call is a fresh proof.
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
