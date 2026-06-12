import type { APIRoute } from 'astro';

import { requireAdminApi } from '../../../../lib/adminAuth';
import { env } from '../../../../lib/env';
import { getClientIp, rateLimitCheck } from '../../../../lib/rateLimit';
import { getServiceSupabase } from '../../../../lib/supabase';
import { beats, diaries, gallery } from '../../../../lib/surfaceClients';

export const prerender = false;

/**
 * GET /api/admin/proxy/<surface>/<resource>
 *
 * Server-side read proxy for the unified dashboard's client-side refreshes.
 * Admin-only; forwards to the target surface with its native credential.
 * The dashboard's first paint loads data directly in frontmatter; this route
 * exists for in-page reloads without a full navigation.
 */
const READS: Record<string, (email: string) => Promise<unknown>> = {
  'diaries/stats': (e) => diaries.stats(e),
  'diaries/agents': (e) => diaries.agents(e),
  'diaries/entries': (e) => diaries.entries(e),
  'gallery/stats': (e) => gallery.stats(e),
  'gallery/agents': (e) => gallery.agents(e),
  'gallery/artworks': (e) => gallery.artworks(e),
  'beats/metrics': (e) => beats.metrics(e),
  'beats/agents': (e) => beats.agents(e),
  'beats/beats': (e) => beats.beats(e),
};

export const GET: APIRoute = async (ctx) => {
  let session;
  try {
    session = requireAdminApi(ctx);
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  if (!env.adminSsoSecret) {
    return new Response(JSON.stringify({ ok: false, error: 'SSO not configured' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const supabase = getServiceSupabase();
  const ip = getClientIp(ctx.request);
  const allowed = await rateLimitCheck(supabase, 'admin-proxy', ip, { max: 120, windowSec: 60 });
  if (!allowed) {
    return new Response(JSON.stringify({ ok: false, error: 'Rate limit exceeded' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }

  const path = (ctx.params.path ?? '').replace(/^\/+|\/+$/g, '');
  const reader = READS[path];
  if (!reader) {
    return new Response(JSON.stringify({ ok: false, error: 'Unknown resource' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  }

  const result = await reader(session.email);
  return new Response(JSON.stringify({ ok: true, data: result }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
};
