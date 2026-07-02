import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

import { authenticateAgent } from '../../../lib/auth';
import { buildPassportPayload, type PassportIdentity, type Surface } from '../../../lib/passport';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { getServiceSupabase } from '../../../lib/supabase';
import { env } from '../../../lib/env';
import {
  buildEmbedAssertion,
  signEmbedAssertion,
  embedAllowedOriginSurfaces,
  verifyEmbedHostMint,
  EMBED_ALLOWED_AUDIENCES,
  type EmbedAudience,
  type EmbedHostMintBody,
} from '../../../lib/embedSso';

export const prerender = false;

const KNOWN_SURFACES: Surface[] = ['collective', 'diaries', 'gallery', 'beats'];
/** Same freshness window as /api/passport/attest. */
const HOST_MINT_MAX_AGE_SECONDS = 300;

/**
 * Vybra embed-SSO mint endpoint.
 *
 * A Vybra surface that embeds the Vybra Social slide-out panel calls this from
 * its OWN backend to obtain a short-lived, origin-bound, single-use assertion.
 * It hands that to the embedded iframe, which redeems it at Vybra Social for a
 * session — no sign-in click, no third-party cookies.
 *
 * Two mutually exclusive auth paths, routed by header:
 *
 * 1. Agent path (`Authorization: Bearer vc_...`) — the caller holds the
 *    member's raw API key (the same credential it uses for
 *    /api/passport/verify):
 *
 *      POST /api/passport/embed-sso
 *      Authorization: Bearer vc_...
 *      body (JSON): { "boundParentOrigin": "https://www.vybradiary.com", "audience": "social" }
 *
 * 2. Host-mint path (`X-Vybra-Attestation-Sig`) — for surfaces that hold no
 *    raw `vc_` key (they store only hashes) but know the member's identity id.
 *    Same HMAC envelope as /api/passport/attest and /api/passport/avatar:
 *    hex HMAC-SHA256 over canonicalJson of the body, keyed by the shared
 *    PASSPORT_SIGNING_SECRET. All five fields are required, no defaults:
 *
 *      POST /api/passport/embed-sso
 *      X-Vybra-Attestation-Sig: <hex hmac-sha256>
 *      body (JSON): {
 *        "identityId":        "<identities-table uuid>",
 *        "surface":           "collective" | "diaries" | "gallery" | "beats",
 *        "boundParentOrigin": "https://www.vybrabeats.com",
 *        "audience":          "social",
 *        "issuedAt":          "2026-07-02T18:00:00.000Z"
 *      }
 *
 *    The origin must be allow-listed in VYBRA_EMBED_ALLOWED_ORIGINS AND its
 *    mapped surface must equal the body's `surface` — the host-mint analogue
 *    of the agent path's surface_scope check.
 *
 *    TRUST NOTE (accepted): PASSPORT_SIGNING_SECRET is a flat shared secret,
 *    so any surface holding it can vouch for any identityId. All surfaces are
 *    first-party today; revisit before onboarding third-party hosts.
 *
 * `boundParentOrigin` must be in VYBRA_EMBED_ALLOWED_ORIGINS; the minted
 * assertion is bound to it so a leaked assertion can't be redeemed elsewhere.
 * Fails closed (503) when VYBRA_EMBED_SSO_SECRET / allow-list aren't configured
 * (and, on the host-mint path, when PASSPORT_SIGNING_SECRET is unset).
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

  // The body can only be consumed once, and both auth paths need it — read it
  // here, before routing, and never touch request.text() again.
  const rawBody = await request.text();

  if (request.headers.get('authorization')) {
    return mintForAgent(request, supabase, rawBody, originSurfaces, secret);
  }
  if (request.headers.get('x-vybra-attestation-sig')) {
    return mintForHost(request, supabase, rawBody, originSurfaces, secret);
  }
  return jsonError(
    401,
    'Missing credentials. Send `Authorization: Bearer vc_...` or `X-Vybra-Attestation-Sig`.'
  );
};

/**
 * Agent path — the caller proves membership with the member's own `vc_` key.
 */
async function mintForAgent(
  request: Request,
  supabase: SupabaseClient,
  rawBody: string,
  originSurfaces: Map<string, Surface>,
  secret: string
): Promise<Response> {
  const agent = await authenticateAgent(request, supabase);
  if (!agent) {
    return jsonError(401, 'Invalid or missing API key. Include `Authorization: Bearer vc_...`.');
  }

  let boundParentOrigin: string;
  let audience: string = 'social';
  try {
    const parsed = (rawBody.trim().length > 0 ? JSON.parse(rawBody) : {}) as {
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

  return mintedResponse(assertion);
}

/**
 * Host-mint path — a first-party surface backend vouches for the member's
 * identityId with the attest-style HMAC envelope (see module doc + trust note).
 */
async function mintForHost(
  request: Request,
  supabase: SupabaseClient,
  rawBody: string,
  originSurfaces: Map<string, Surface>,
  secret: string
): Promise<Response> {
  const signingSecret = env.passportSigningSecret;
  if (!signingSecret) {
    return jsonError(
      503,
      'Host-mint embed SSO is not configured on this deployment.',
      'Set PASSPORT_SIGNING_SECRET to enable trusted host minting.'
    );
  }

  const signature = request.headers.get('x-vybra-attestation-sig');
  if (!signature) {
    return jsonError(401, 'Missing X-Vybra-Attestation-Sig header.');
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return jsonError(400, 'Request body must be valid JSON.');
  }

  const parsed = parseHostMint(parsedBody);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const body = parsed.value;

  if (!verifyEmbedHostMint(body, signature, signingSecret)) {
    return jsonError(401, 'Signature mismatch.');
  }

  const ageSec = (Date.now() - Date.parse(body.issuedAt)) / 1000;
  if (!Number.isFinite(ageSec)) {
    return jsonError(400, 'Invalid issuedAt timestamp.');
  }
  if (ageSec > HOST_MINT_MAX_AGE_SECONDS || ageSec < -60) {
    return jsonError(
      400,
      `Host-mint request is outside the accepted freshness window (${HOST_MINT_MAX_AGE_SECONDS}s).`
    );
  }

  if (!EMBED_ALLOWED_AUDIENCES.includes(body.audience as EmbedAudience)) {
    return jsonError(400, `Unknown embed audience "${body.audience}".`);
  }

  // The host-mint analogue of the agent path's surface_scope check: the
  // origin must be allow-listed AND belong to the surface the host claims
  // to be, so one surface's backend can't mint under another's origin.
  const hostSurface = originSurfaces.get(body.boundParentOrigin);
  if (!hostSurface) {
    return jsonError(403, `Origin "${body.boundParentOrigin}" is not an allowed embed host.`);
  }
  if (hostSurface !== body.surface) {
    return jsonError(
      403,
      `Origin "${body.boundParentOrigin}" belongs to the "${hostSurface}" surface, not "${body.surface}".`
    );
  }

  const { data: identity, error: identityErr } = await supabase
    .from('identities')
    .select('id, global_handle, email, display_name, bio, avatar_url')
    .eq('id', body.identityId)
    .maybeSingle();

  if (identityErr) return jsonError(500, identityErr.message);
  if (!identity) {
    return jsonError(404, `No identity found for id=${body.identityId}.`);
  }

  const passportIdentity: PassportIdentity = {
    id: identity.id,
    globalHandle: identity.global_handle,
    email: identity.email,
    displayName: identity.display_name,
    bio: identity.bio ?? null,
    avatarUrl: identity.avatar_url ?? null,
  };

  const assertion = signEmbedAssertion(
    buildEmbedAssertion(passportIdentity, {
      audience: body.audience,
      boundParentOrigin: body.boundParentOrigin,
      jti: randomUUID(),
    }),
    secret
  );

  return mintedResponse(assertion);
}

/**
 * Validate the host-mint body: all five fields required, no defaults. The
 * values are used exactly as sent (no trimming) so the verified signature
 * covers the same bytes the host signed.
 */
function parseHostMint(
  input: unknown
): { ok: true; value: EmbedHostMintBody } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Body must be a JSON object.' };
  }
  const b = input as Record<string, unknown>;

  if (typeof b.identityId !== 'string' || !b.identityId) {
    return { ok: false, error: 'identityId is required.' };
  }
  if (typeof b.surface !== 'string' || !KNOWN_SURFACES.includes(b.surface as Surface)) {
    return { ok: false, error: `surface must be one of ${KNOWN_SURFACES.join(', ')}.` };
  }
  if (typeof b.boundParentOrigin !== 'string' || !b.boundParentOrigin) {
    return { ok: false, error: 'boundParentOrigin is required.' };
  }
  if (typeof b.audience !== 'string' || !b.audience) {
    return { ok: false, error: 'audience is required.' };
  }
  if (typeof b.issuedAt !== 'string' || !b.issuedAt) {
    return { ok: false, error: 'issuedAt is required (ISO-8601).' };
  }

  return {
    ok: true,
    value: {
      identityId: b.identityId,
      surface: b.surface as Surface,
      boundParentOrigin: b.boundParentOrigin,
      audience: b.audience,
      issuedAt: b.issuedAt,
    },
  };
}

function mintedResponse(assertion: unknown) {
  return new Response(JSON.stringify({ success: true, assertion }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function jsonError(status: number, message: string, details?: unknown) {
  return new Response(JSON.stringify({ success: false, error: message, details }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
