/**
 * Vybra embed-SSO assertion — minting helpers for /api/passport/embed-sso.
 *
 * A Vybra surface that embeds the Vybra Social slide-out panel needs to log the
 * embedded iframe in as the host's current member WITHOUT a sign-in click and
 * WITHOUT third-party cookies. To do that the host's backend asks Collective to
 * mint a short-lived, origin-bound, single-use "user-passport" assertion for the
 * authenticated identity; the host hands it to the iframe, which redeems it at
 * Vybra Social's /api/v1/auth/embed-session.
 *
 * The wire shape + signing are byte-compatible with @vybra/passport and the
 * Vybra Social verifier: HMAC-SHA256 over canonicalJson(payload-without-signature),
 * signature/signatureAlg appended. See vybra-social apps/web/src/lib/embedAssertion.ts.
 */
import { createHmac } from 'node:crypto';

import { canonicalJson, type PassportIdentity } from './passport';
import { env } from './env';

export const EMBED_PURPOSE = 'vybra-embed-sso';
/** Default assertion lifetime. Kept well under the Social verifier's 120s cap. */
export const EMBED_DEFAULT_TTL_SECONDS = 90;
export const EMBED_MAX_TTL_SECONDS = 120;
/** Audiences (consuming surfaces) this server will mint embed assertions for. */
export const EMBED_ALLOWED_AUDIENCES = ['social'] as const;
export type EmbedAudience = (typeof EMBED_ALLOWED_AUDIENCES)[number];

export interface EmbedAssertionIdentity {
  id: string;
  globalHandle: string;
  email: string;
  displayName: string;
  bio: string | null;
}

export interface EmbedAssertion {
  v: number;
  purpose: typeof EMBED_PURPOSE;
  jti: string;
  identity: EmbedAssertionIdentity;
  audience: string;
  boundParentOrigin: string;
  issuedAt: string;
  expiresAt: string;
  signature?: string | null;
  signatureAlg?: 'hmac-sha256' | null;
}

/** Parse the configured allow-list of host origins permitted to bind an assertion. */
export function embedAllowedOrigins(): string[] {
  return env.embedAllowedOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildEmbedAssertion(
  identity: PassportIdentity,
  opts: { audience: string; boundParentOrigin: string; jti: string; ttlSeconds?: number; now?: Date }
): EmbedAssertion {
  const now = opts.now ?? new Date();
  const ttl = Math.min(opts.ttlSeconds ?? EMBED_DEFAULT_TTL_SECONDS, EMBED_MAX_TTL_SECONDS);
  return {
    v: 1,
    purpose: EMBED_PURPOSE,
    jti: opts.jti,
    identity: {
      id: identity.id,
      globalHandle: identity.globalHandle,
      email: identity.email,
      displayName: identity.displayName,
      bio: identity.bio ?? null,
    },
    audience: opts.audience,
    boundParentOrigin: opts.boundParentOrigin,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  };
}

/**
 * Sign the assertion over the payload WITHOUT signature/signatureAlg — exactly
 * what the Social verifier strips and re-canonicalizes — so the bytes match.
 */
export function signEmbedAssertion(payload: EmbedAssertion, secret: string): EmbedAssertion {
  const { signature: _sig, signatureAlg: _alg, ...bare } = payload;
  const canonical = canonicalJson(bare);
  const signature = createHmac('sha256', secret).update(canonical).digest('hex');
  return { ...bare, signature, signatureAlg: 'hmac-sha256' };
}
