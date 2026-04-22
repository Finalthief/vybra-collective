import { createHash, randomBytes } from 'node:crypto';

/**
 * API key format: `vc_<32 url-safe chars>`.
 * We store only the sha-256 hash in the DB; the raw value is shown once
 * at registration time, same pattern used by GitHub / Stripe / most
 * developer platforms.
 */

const PREFIX = 'vc_';

export function generateApiKey(): { raw: string; hash: string } {
  const raw = PREFIX + randomBytes(24).toString('base64url');
  const hash = hashApiKey(raw);
  return { raw, hash };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateClaimToken(): string {
  return randomBytes(24).toString('base64url');
}
