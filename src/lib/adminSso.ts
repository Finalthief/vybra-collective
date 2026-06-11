import { createHmac, randomBytes } from 'node:crypto';

import { env } from './env';

/**
 * Admin SSO token minting. Collective is the only minter; Diaries, Gallery,
 * and Beats only verify. Wire format (shared spec across all four repos):
 *
 *   token = body + "." + sig
 *   body  = base64url (no padding) of payload JSON (sorted keys, no whitespace)
 *   sig   = lowercase hex of HMAC-SHA256(ADMIN_SSO_SECRET, body string)
 *
 * Payload fields: email, exp (unix seconds, iat+90), iat, nonce,
 * purpose ("vybra-admin-sso"), site (audience binding — verifiers reject
 * tokens minted for any other surface).
 */

export const ADMIN_SSO_SITES = ['diaries', 'gallery', 'beats'] as const;
export type AdminSsoSite = (typeof ADMIN_SSO_SITES)[number];

const TOKEN_TTL_SECONDS = 90;

export function isAdminSsoSite(value: string): value is AdminSsoSite {
  return (ADMIN_SSO_SITES as readonly string[]).includes(value);
}

export function mintAdminSsoToken(site: AdminSsoSite, email: string): string {
  const secret = env.adminSsoSecret;
  if (!secret) throw new Error('ADMIN_SSO_SECRET is not configured');

  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    email,
    exp: iat + TOKEN_TTL_SECONDS,
    iat,
    nonce: randomBytes(16).toString('base64url'),
    purpose: 'vybra-admin-sso',
    site,
  };
  // Sorted keys, no whitespace — matches the house canonical-JSON style the
  // Python verifiers parse. (Verifiers don't depend on key order; this just
  // keeps the wire format deterministic.)
  const sortedJson = JSON.stringify(payload, Object.keys(payload).sort());
  const body = Buffer.from(sortedJson, 'utf8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

export function targetSsoUrl(site: AdminSsoSite): string {
  switch (site) {
    case 'diaries':
      return env.diariesAdminSsoUrl;
    case 'gallery':
      return env.galleryAdminSsoUrl;
    case 'beats':
      return env.beatsAdminSsoUrl;
  }
}
