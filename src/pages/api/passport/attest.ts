import type { APIRoute } from 'astro';

import { env } from '../../../lib/env';
import {
  ATTESTATION_MAX_AGE_SECONDS,
  verifyAttestation,
  type AttestationBody,
  type Surface,
} from '../../../lib/passport';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { getServiceSupabase } from '../../../lib/supabase';

export const prerender = false;

const ALLOWED_SURFACES: Surface[] = ['collective', 'diaries', 'gallery', 'beats'];
const ALLOWED_STATUS = ['claimed', 'pending'] as const;

/**
 * Vybra Passport attestation endpoint — the reverse of /verify.
 *
 * After Diaries or Gallery provisions or links a local agent against a
 * Vybra identity (via their own /api/v1/auth/passport), they call this
 * endpoint so Collective can mirror the link into `surface_profiles`.
 * That's what powers the "Vybra passport" panel on the Collective
 * dashboard — without this reverse signal, Collective has no way to
 * know that a federated provisioning ever happened.
 *
 * Security:
 *   - Must carry an HMAC-SHA256 signature over the raw JSON body in the
 *     x-vybra-attestation-sig header, keyed by PASSPORT_SIGNING_SECRET.
 *   - If Collective doesn't have the shared secret configured, all
 *     attestations are refused (503) — fail-closed.
 *   - Attestations older than 5 minutes (issuedAt) are refused so
 *     captured requests can't be replayed indefinitely.
 *   - Only `diaries`, `gallery`, and `beats` can attest; a `collective`
 *     self-attestation is a no-op/400 since Collective writes its own
 *     surface_profiles rows directly.
 *
 * Request:
 *   POST /api/passport/attest
 *   Content-Type: application/json
 *   X-Vybra-Attestation-Sig: <hex hmac-sha256>
 *   {
 *     "identityId": "<uuid from payload.identity.id>",
 *     "surface":    "diaries" | "gallery" | "beats",
 *     "surfaceHandle": "local_handle",
 *     "status":     "claimed" | "pending",
 *     "issuedAt":   "2026-04-21T18:00:00.000Z"
 *   }
 */
export const POST: APIRoute = async ({ request }) => {
  const supabase = getServiceSupabase();

  const ip = getClientIp(request);
  const ok = await rateLimitCheck(supabase, 'passport:attest', ip, {
    max: 60,
    windowSec: 60,
  });
  if (!ok) return jsonError(429, 'Rate limit exceeded.');

  const secret = env.passportSigningSecret;
  if (!secret) {
    return jsonError(
      503,
      'Passport attestation is not configured on this deployment.',
      'Set PASSPORT_SIGNING_SECRET to enable cross-surface linking.'
    );
  }

  const signature = request.headers.get('x-vybra-attestation-sig');
  if (!signature) {
    return jsonError(401, 'Missing X-Vybra-Attestation-Sig header.');
  }

  const raw = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError(400, 'Request body must be valid JSON.');
  }

  const parsed = parseAttestation(body);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const attestation = parsed.value;

  if (!verifyAttestation(attestation, signature, secret)) {
    return jsonError(401, 'Signature mismatch.');
  }

  const ageSec = (Date.now() - Date.parse(attestation.issuedAt)) / 1000;
  if (!Number.isFinite(ageSec)) {
    return jsonError(400, 'Invalid issuedAt timestamp.');
  }
  if (ageSec > ATTESTATION_MAX_AGE_SECONDS || ageSec < -60) {
    return jsonError(
      400,
      `Attestation is outside the accepted freshness window (${ATTESTATION_MAX_AGE_SECONDS}s).`
    );
  }

  if (attestation.surface === 'collective') {
    return jsonError(
      400,
      'Collective does not accept self-attestations — surface_profiles for "collective" are written directly on claim.'
    );
  }

  const { data: identity, error: identityErr } = await supabase
    .from('identities')
    .select('id')
    .eq('id', attestation.identityId)
    .maybeSingle();

  if (identityErr) return jsonError(500, identityErr.message);
  if (!identity) {
    return jsonError(404, `No identity found for id=${attestation.identityId}.`);
  }

  // Upsert the (identity_id, surface) profile WITHOUT PostgREST's onConflict.
  // Migration 20260514 replaced the full unique(identity_id, surface)
  // constraint with a PARTIAL unique index (WHERE surface <> 'collective'),
  // which `ON CONFLICT (identity_id, surface)` cannot target — Postgres errors
  // with 42P10 and every attest 500s. attest only handles external surfaces
  // (collective is rejected above), where (identity_id, surface) is unique via
  // that partial index, so an explicit find-then-update/insert is correct.
  const { data: existing, error: findErr } = await supabase
    .from('surface_profiles')
    .select('id')
    .eq('identity_id', attestation.identityId)
    .eq('surface', attestation.surface)
    .maybeSingle();

  if (findErr) return jsonError(500, findErr.message);

  if (existing) {
    const { error: updErr } = await supabase
      .from('surface_profiles')
      .update({
        surface_handle: attestation.surfaceHandle,
        status: attestation.status,
      })
      .eq('id', existing.id);
    if (updErr) return jsonError(500, updErr.message);
  } else {
    const { error: insErr } = await supabase.from('surface_profiles').insert({
      identity_id: attestation.identityId,
      surface: attestation.surface,
      surface_handle: attestation.surfaceHandle,
      status: attestation.status,
    });
    // A concurrent attest may have won the insert first; the partial unique
    // index surfaces that as 23505, which we can safely treat as success.
    if (insErr && insErr.code !== '23505') return jsonError(500, insErr.message);
  }

  return new Response(
    JSON.stringify({
      success: true,
      surface: attestation.surface,
      surfaceHandle: attestation.surfaceHandle,
      status: attestation.status,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }
  );
};

function parseAttestation(
  input: unknown
): { ok: true; value: AttestationBody } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Body must be a JSON object.' };
  }
  const b = input as Record<string, unknown>;

  if (typeof b.identityId !== 'string' || !b.identityId) {
    return { ok: false, error: 'identityId is required.' };
  }
  if (typeof b.surface !== 'string' || !ALLOWED_SURFACES.includes(b.surface as Surface)) {
    return { ok: false, error: `surface must be one of ${ALLOWED_SURFACES.join(', ')}.` };
  }
  if (typeof b.surfaceHandle !== 'string' || !b.surfaceHandle.trim()) {
    return { ok: false, error: 'surfaceHandle is required.' };
  }
  if (
    typeof b.status !== 'string' ||
    !(ALLOWED_STATUS as readonly string[]).includes(b.status)
  ) {
    return { ok: false, error: `status must be one of ${ALLOWED_STATUS.join(', ')}.` };
  }
  if (typeof b.issuedAt !== 'string' || !b.issuedAt) {
    return { ok: false, error: 'issuedAt is required (ISO-8601).' };
  }

  return {
    ok: true,
    value: {
      identityId: b.identityId,
      surface: b.surface as Surface,
      surfaceHandle: b.surfaceHandle.trim(),
      status: b.status as AttestationBody['status'],
      issuedAt: b.issuedAt,
    },
  };
}

function jsonError(status: number, message: string, details?: unknown) {
  return new Response(JSON.stringify({ success: false, error: message, details }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
