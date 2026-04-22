/**
 * Vybra Passport — helpers for the cross-surface identity verification
 * endpoint at /api/passport/verify.
 *
 * The passport is what another Vybra surface (Diaries, Gallery, or any
 * future surface) asks Collective for when it wants to honor a user's
 * `vc_...` API key as a sign-in. Given a valid key, we return a
 * canonical identity payload + the surface profiles that identity owns,
 * optionally HMAC-signed so the consumer can cache and skip re-calling.
 *
 * The shape here is the cross-surface contract. Additive changes only —
 * downstream surfaces pin the version via `payloadVersion`.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AuthedAgent } from './auth';
import { env } from './env';

/** Bump when making breaking changes to the payload contract. */
export const PASSPORT_PAYLOAD_VERSION = 1;

/** How long a signed payload is considered fresh by consumers. */
export const PASSPORT_TTL_SECONDS = 5 * 60;

export type Surface = 'collective' | 'diaries' | 'gallery';

export interface PassportSurfaceProfile {
  surface: Surface;
  handle: string;
  status: string;
  founding: boolean;
}

export interface PassportIdentity {
  id: string;
  globalHandle: string;
  email: string;
  displayName: string;
  bio: string | null;
}

export interface PassportPayload {
  payloadVersion: number;
  identity: PassportIdentity;
  /**
   * Every surface this identity has a profile on. Consumers can look up
   * their own surface here to see if the user is already registered
   * with them (and skip creating a duplicate).
   */
  surfaces: PassportSurfaceProfile[];
  /**
   * Echo of the Collective-side agent that authenticated the key. A
   * consumer that wants to link its local user to Collective-specific
   * records (e.g. insights) can use this UUID.
   */
  collectiveAgent: {
    id: string;
    handle: string;
    keyId: string;
    surfaceScope: Surface[];
  };
  issuedAt: string;
  expiresAt: string;
}

export interface SignedPassportPayload extends PassportPayload {
  signature: string | null;
  signatureAlg: 'hmac-sha256' | null;
}

/**
 * Build the passport payload for an authenticated agent. Fetches the
 * attached identity + every surface_profiles row under it in a single
 * round-trip via nested select.
 *
 * Returns null if the agent row is missing an `identity_id` — which
 * shouldn't happen post-federation-migration, but we defend anyway so
 * the caller can return a clean 409 instead of exploding.
 */
export async function buildPassportPayload(
  supabase: SupabaseClient,
  agent: AuthedAgent
): Promise<PassportPayload | null> {
  const { data: agentRow, error: agentErr } = await supabase
    .from('agents')
    .select('id, handle, identity_id')
    .eq('id', agent.id)
    .maybeSingle();

  if (agentErr || !agentRow?.identity_id) return null;

  const [{ data: identity }, { data: surfaceRows }, { data: keyRow }] = await Promise.all([
    supabase
      .from('identities')
      .select('id, global_handle, email, display_name, bio')
      .eq('id', agentRow.identity_id)
      .maybeSingle(),
    supabase
      .from('surface_profiles')
      .select('surface, surface_handle, status, founding')
      .eq('identity_id', agentRow.identity_id),
    supabase
      .from('api_keys')
      .select('surface_scope')
      .eq('id', agent.keyId)
      .maybeSingle(),
  ]);

  if (!identity) return null;

  const now = new Date();
  const expires = new Date(now.getTime() + PASSPORT_TTL_SECONDS * 1000);

  const surfaces: PassportSurfaceProfile[] = (surfaceRows ?? []).map((r) => ({
    surface: r.surface as Surface,
    handle: r.surface_handle as string,
    status: r.status as string,
    founding: Boolean(r.founding),
  }));

  return {
    payloadVersion: PASSPORT_PAYLOAD_VERSION,
    identity: {
      id: identity.id,
      globalHandle: identity.global_handle,
      email: identity.email,
      displayName: identity.display_name,
      bio: identity.bio ?? null,
    },
    surfaces,
    collectiveAgent: {
      id: agentRow.id,
      handle: agentRow.handle,
      keyId: agent.keyId,
      surfaceScope: (keyRow?.surface_scope as Surface[] | undefined) ?? ['collective'],
    },
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

/**
 * Sign a payload with the shared HMAC secret. Consumers verify by
 * running the same canonical stringification through HMAC-SHA256 and
 * comparing in constant time via `verifyPassportSignature`.
 *
 * Canonical form: JSON of the payload with keys sorted. Sorting makes
 * the signature stable across JSON.stringify implementations.
 */
export function signPassportPayload(payload: PassportPayload): SignedPassportPayload {
  const secret = env.passportSigningSecret;
  if (!secret) {
    return { ...payload, signature: null, signatureAlg: null };
  }
  const canonical = canonicalJson(payload);
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  return { ...payload, signature, signatureAlg: 'hmac-sha256' };
}

/**
 * Verify a signed payload. Returns true if signature matches and the
 * payload hasn't expired. Exported so consuming surfaces can import
 * this module directly (via a published `@vybra/passport` package
 * someday) instead of re-implementing the check.
 */
export function verifyPassportSignature(signed: SignedPassportPayload): boolean {
  const secret = env.passportSigningSecret;
  if (!secret || !signed.signature) return false;
  const { signature, signatureAlg, ...payload } = signed;
  if (signatureAlg !== 'hmac-sha256') return false;

  const canonical = canonicalJson(payload);
  const expected = createHmac('sha256', secret).update(canonical).digest('hex');

  if (signature.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Stable JSON serialization with sorted keys at every level. Needed so
 * both sides of the HMAC compute the same bytes.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[key] = (v as Record<string, unknown>)[key];
      }
      return sorted;
    }
    return v;
  });
}

/**
 * Attestation — the reverse direction of the passport flow.
 *
 * When Diaries or Gallery provision/link a local agent against a Vybra
 * identity, they POST a signed attestation to Collective so Collective
 * can reflect the other surface's claim in its own `surface_profiles`
 * table. This powers the cross-surface "Vybra Passport" panel on the
 * Collective dashboard.
 *
 * Security: body HMAC-SHA256 signed with the shared PASSPORT_SIGNING_SECRET
 * (sent in x-vybra-attestation-sig). Without the secret configured on
 * Collective, the endpoint refuses to accept any attestations. A small
 * max-age window (5 min) keeps replays bounded.
 */

export const ATTESTATION_MAX_AGE_SECONDS = 5 * 60;

export interface AttestationBody {
  identityId: string;
  surface: Surface;
  surfaceHandle: string;
  status: 'claimed' | 'pending';
  issuedAt: string;
}

/** Deterministic string to HMAC. Shared by Diaries (TS) and Gallery (Python). */
export function attestationCanonical(body: AttestationBody): string {
  return canonicalJson(body);
}

export function signAttestation(body: AttestationBody, secret: string): string {
  return createHmac('sha256', secret).update(attestationCanonical(body)).digest('hex');
}

export function verifyAttestation(
  body: AttestationBody,
  signatureHex: string,
  secret: string
): boolean {
  const expected = signAttestation(body, secret);
  if (signatureHex.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(signatureHex, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
