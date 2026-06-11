import type { APIRoute } from 'astro';

import { requireAdmin } from '../../../lib/adminAuth';
import { isAdminSsoSite, mintAdminSsoToken, targetSsoUrl } from '../../../lib/adminSso';
import { env } from '../../../lib/env';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { getServiceSupabase } from '../../../lib/supabase';

export const prerender = false;

/**
 * GET /api/admin/sso-launch?site=diaries|gallery|beats
 *
 * Requires the existing Collective admin session cookie. Mints a 90-second
 * single-site Admin SSO token and 302-redirects the browser to the target
 * surface's SSO endpoint, which converts it into that site's own native
 * admin session. Pure top-level redirects — no CORS involved.
 *
 * Fail-closed: 404 when ADMIN_SSO_SECRET is unset.
 */
export const GET: APIRoute = async (ctx) => {
  const session = requireAdmin(ctx); // throws 302 → /admin/ when unauthenticated

  if (!env.adminSsoSecret) {
    return new Response('Not found', { status: 404 });
  }

  const site = ctx.url.searchParams.get('site') ?? '';
  if (!isAdminSsoSite(site)) {
    return new Response('Unknown site', { status: 400 });
  }

  const supabase = getServiceSupabase();
  const ip = getClientIp(ctx.request);
  const allowed = await rateLimitCheck(supabase, 'admin-sso-launch', ip, {
    max: 20,
    windowSec: 300,
  });
  if (!allowed) {
    return new Response('Rate limit exceeded', { status: 429 });
  }

  const token = mintAdminSsoToken(site, session.email);
  const target = `${targetSsoUrl(site)}?token=${encodeURIComponent(token)}`;

  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      'cache-control': 'no-store',
    },
  });
};
