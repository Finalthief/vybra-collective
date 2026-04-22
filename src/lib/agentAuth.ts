import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';

import { env } from './env';

/**
 * Agent-side session cookie for the self-service dashboard.
 *
 * An agent proves ownership once by pasting their API key into the
 * login form. We verify the key against api_keys + agents just like
 * the Bearer auth path, then issue an HMAC-signed cookie containing
 * { agentId, keyId }. Every subsequent dashboard request:
 *
 *   1. verifies the cookie signature,
 *   2. re-checks that the keyId is still active (not revoked), and
 *   3. re-loads the agent row.
 *
 * Revoking the key in the admin UI (or from the dashboard itself)
 * instantly logs the agent out on the next request. No new tables
 * needed — the cookie is bound to the same api_keys row that auths
 * the JSON API.
 *
 * Shares ADMIN_SESSION_SECRET for HMAC material but uses a distinct
 * cookie name + payload shape so admin and agent cookies can't be
 * confused even in principle.
 */

const AGENT_COOKIE = 'vc_agent_session';
const SESSION_TTL_DAYS = 7;

export interface AgentSession {
  kind: 'agent';
  agentId: string;
  keyId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface DashboardAgent {
  id: string;
  handle: string;
  display_name: string;
  email: string;
  bio: string | null;
  status: string;
  founding: boolean;
  identity_id: string | null;
  keyId: string;
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
function signedPayload(obj: Record<string, unknown>): string {
  const payload = base64urlEncode(Buffer.from(JSON.stringify(obj), 'utf8'));
  return `${payload}.${sign(payload)}`;
}
function verifySignedPayload<T>(signed: string): T | null {
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const a = base64urlDecode(sig);
  const b = base64urlDecode(sign(payload));
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(base64urlDecode(payload).toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function issueAgentSession(cookies: AstroCookies, agentId: string, keyId: string) {
  const now = Date.now();
  const session: AgentSession = {
    kind: 'agent',
    agentId,
    keyId,
    issuedAt: now,
    expiresAt: now + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
  cookies.set(AGENT_COOKIE, signedPayload(session as unknown as Record<string, unknown>), {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearAgentSession(cookies: AstroCookies) {
  cookies.delete(AGENT_COOKIE, { path: '/' });
}

export function readAgentSession(cookies: AstroCookies): AgentSession | null {
  const c = cookies.get(AGENT_COOKIE);
  if (!c?.value) return null;
  const decoded = verifySignedPayload<AgentSession>(c.value);
  if (!decoded || decoded.kind !== 'agent') return null;
  if (Date.now() > decoded.expiresAt) return null;
  return decoded;
}

/**
 * Load the agent + key for an active session, re-validating against
 * the DB so a revoked key effectively logs the agent out on the very
 * next request.
 */
export async function loadDashboardAgent(
  supabase: SupabaseClient,
  session: AgentSession
): Promise<DashboardAgent | null> {
  const { data: key } = await supabase
    .from('api_keys')
    .select('id, agent_id, revoked_at')
    .eq('id', session.keyId)
    .maybeSingle();
  if (!key || key.revoked_at) return null;
  if (key.agent_id !== session.agentId) return null;

  const { data: agent } = await supabase
    .from('agents')
    .select('id, handle, display_name, email, bio, status, founding, identity_id')
    .eq('id', session.agentId)
    .maybeSingle();
  if (!agent || agent.status !== 'claimed') return null;

  return { ...agent, keyId: key.id } as DashboardAgent;
}

/** Use at the top of /dashboard/* pages to bounce unauthenticated visitors. */
export async function requireDashboardAgent(
  supabase: SupabaseClient,
  cookies: AstroCookies
): Promise<DashboardAgent> {
  const session = readAgentSession(cookies);
  if (!session) {
    throw new Response(null, { status: 302, headers: { location: '/dashboard/login/' } });
  }
  const agent = await loadDashboardAgent(supabase, session);
  if (!agent) {
    // Invalidate the cookie silently so the login page doesn't trip on a stale one.
    clearAgentSession(cookies);
    throw new Response(null, { status: 302, headers: { location: '/dashboard/login/?expired=1' } });
  }
  return agent;
}
