import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';

import { env } from './env';

/**
 * Passwordless admin auth, fully self-contained (no Supabase Auth).
 * Flow:
 *   1. POST /admin/login with { email }. If it matches ADMIN_EMAIL we
 *      email a magic link containing a short-lived HMAC token.
 *   2. GET /admin/verify?token=… sets a signed session cookie.
 *   3. Protected routes (anything under /admin and /api/admin/*) call
 *      requireAdmin() which reads and verifies that cookie.
 *
 * Tokens and cookies are HMAC-signed with ADMIN_SESSION_SECRET. No data
 * ever leaves the server unverified.
 */

const ADMIN_COOKIE = 'vc_admin_session';
const LOGIN_TOKEN_TTL_MIN = 15;
const SESSION_TTL_DAYS = 7;

export interface AdminSession {
  email: string;
  issuedAt: number;
  expiresAt: number;
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

function sign(payload: string): string {
  return base64urlEncode(
    createHmac('sha256', env.adminSessionSecret).update(payload).digest()
  );
}

function signedPayload(payloadObj: Record<string, unknown>): string {
  const payload = base64urlEncode(Buffer.from(JSON.stringify(payloadObj), 'utf8'));
  const sig = sign(payload);
  return `${payload}.${sig}`;
}

function verifySignedPayload<T = Record<string, unknown>>(signed: string): T | null {
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = sign(payload);
  const a = base64urlDecode(sig);
  const b = base64urlDecode(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(base64urlDecode(payload).toString('utf8')) as T;
  } catch {
    return null;
  }
}

// -----------------------------
// Magic link tokens (login step)
// -----------------------------

interface LoginToken {
  email: string;
  iat: number;
  exp: number;
  nonce: string;
}

export function issueLoginToken(email: string): string {
  const nowMs = Date.now();
  const payload: LoginToken = {
    email,
    iat: nowMs,
    exp: nowMs + LOGIN_TOKEN_TTL_MIN * 60 * 1000,
    nonce: base64urlEncode(Buffer.from(Math.random().toString(36).slice(2))),
  };
  return signedPayload(payload as unknown as Record<string, unknown>);
}

export function consumeLoginToken(token: string): string | null {
  const decoded = verifySignedPayload<LoginToken>(token);
  if (!decoded) return null;
  if (Date.now() > decoded.exp) return null;
  if (decoded.email.toLowerCase() !== env.adminEmail.toLowerCase()) return null;
  return decoded.email;
}

// -----------------------------
// Session cookies
// -----------------------------

export function issueSessionCookie(cookies: AstroCookies, email: string) {
  const nowMs = Date.now();
  const session: AdminSession = {
    email,
    issuedAt: nowMs,
    expiresAt: nowMs + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
  const cookieValue = signedPayload(session as unknown as Record<string, unknown>);
  cookies.set(ADMIN_COOKIE, cookieValue, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(cookies: AstroCookies) {
  cookies.delete(ADMIN_COOKIE, { path: '/' });
}

export function readSession(cookies: AstroCookies): AdminSession | null {
  const c = cookies.get(ADMIN_COOKIE);
  if (!c?.value) return null;
  const decoded = verifySignedPayload<AdminSession>(c.value);
  if (!decoded) return null;
  if (Date.now() > decoded.expiresAt) return null;
  if (decoded.email.toLowerCase() !== env.adminEmail.toLowerCase()) return null;
  return decoded;
}

/**
 * Throws a Response redirect when not authenticated. Use at the top of
 * protected Astro pages or API routes: `const session = requireAdmin(ctx)`.
 */
export function requireAdmin(ctx: { cookies: AstroCookies }): AdminSession {
  const s = readSession(ctx.cookies);
  if (!s) {
    throw new Response('Unauthorized', {
      status: 302,
      headers: { location: '/admin/' },
    });
  }
  return s;
}

export function requireAdminApi(ctx: { cookies: AstroCookies }): AdminSession {
  const s = readSession(ctx.cookies);
  if (!s) {
    throw new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  return s;
}

