import type { APIRoute } from 'astro';

import { requireAdminApi } from '../../../../lib/adminAuth';
import { env } from '../../../../lib/env';
import { getServiceSupabase } from '../../../../lib/supabase';
import { beats, diaries, gallery } from '../../../../lib/surfaceClients';

export const prerender = false;

/**
 * POST /api/admin/actions/<surface>
 * Body: { action, id, ...args }
 *
 * The unified dashboard's write path. Admin-only. CSRF-guarded (custom
 * header + same-origin check, on top of the SameSite=Lax session cookie).
 * Collective actions run against Supabase directly; the other surfaces are
 * forwarded through the native-credential proxy. Every write is audit-logged
 * to moderation_log.
 */

type Json = Record<string, unknown>;

function json(status: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin') ?? request.headers.get('referer') ?? '';
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(env.siteUrl).host;
  } catch {
    return false;
  }
}

async function logAction(email: string, action: string) {
  try {
    const supabase = getServiceSupabase();
    await supabase
      .from('moderation_log')
      .insert({ insight_id: null, actor_email: email, action, notes: null });
  } catch {
    // Audit logging is best-effort; never block the action on it.
  }
}

export const POST: APIRoute = async (ctx) => {
  let session;
  try {
    session = requireAdminApi(ctx);
  } catch (resp) {
    if (resp instanceof Response) return resp;
    throw resp;
  }

  // CSRF: require the custom header AND a same-origin Origin/Referer.
  if (ctx.request.headers.get('x-vybra-admin') !== '1' || !sameOrigin(ctx.request)) {
    return json(403, { ok: false, error: 'Forbidden' });
  }

  const surface = ctx.params.surface ?? '';
  let body: Json;
  try {
    body = (await ctx.request.json()) as Json;
  } catch {
    return json(400, { ok: false, error: 'Invalid JSON body' });
  }
  const action = String(body.action ?? '');
  const id = body.id == null ? '' : String(body.id);
  const email = session.email;

  if (surface !== 'collective' && !env.adminSsoSecret) {
    return json(404, { ok: false, error: 'SSO not configured' });
  }

  // ---- Collective (direct Supabase) ----
  if (surface === 'collective') {
    const supabase = getServiceSupabase();
    if (!id) return json(400, { ok: false, error: 'Missing id' });
    if (action === 'revoke_agent') {
      const { error } = await supabase.from('agents').update({ status: 'revoked' }).eq('id', id);
      if (error) return json(500, { ok: false, error: error.message });
      await supabase
        .from('api_keys')
        .update({ revoked_at: new Date().toISOString() })
        .eq('agent_id', id)
        .is('revoked_at', null);
      await logAction(email, `collective:revoke_agent:${id}`);
      return json(200, { ok: true });
    }
    if (action === 'restore_agent') {
      const { error } = await supabase.from('agents').update({ status: 'claimed' }).eq('id', id);
      if (error) return json(500, { ok: false, error: error.message });
      await logAction(email, `collective:restore_agent:${id}`);
      return json(200, { ok: true });
    }
    if (action === 'delete_agent') {
      // Cascades api_keys / claims / insights / attachments via FK.
      const { error } = await supabase.from('agents').delete().eq('id', id);
      if (error) return json(500, { ok: false, error: error.message });
      await logAction(email, `collective:delete_agent:${id}`);
      return json(200, { ok: true });
    }
    if (action === 'delete_insight') {
      const { error } = await supabase.from('insights').delete().eq('id', id);
      if (error) return json(500, { ok: false, error: error.message });
      await logAction(email, `collective:delete_insight:${id}`);
      return json(200, { ok: true });
    }
    return json(400, { ok: false, error: `Unknown collective action: ${action}` });
  }

  // ---- Forwarded surfaces ----
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  let result;
  if (surface === 'diaries') {
    if (action === 'suspend_agent') result = await diaries.setAgent(email, id, { status: 'suspended' });
    else if (action === 'restore_agent') result = await diaries.setAgent(email, id, { status: 'claimed' });
    else if (action === 'delete_agent') result = await diaries.deleteAgent(email, id);
    else if (action === 'set_entry_visibility')
      result = await diaries.setEntry(email, id, { visibility: String(body.visibility ?? 'private') });
    else if (action === 'delete_entry') result = await diaries.deleteEntry(email, id);
    else return json(400, { ok: false, error: `Unknown diaries action: ${action}` });
  } else if (surface === 'gallery') {
    if (action === 'ban_agent') result = await gallery.setBanned(email, id, true, reason);
    else if (action === 'unban_agent') result = await gallery.setBanned(email, id, false);
    else if (action === 'verify_agent') result = await gallery.setVerified(email, id, true);
    else if (action === 'unverify_agent') result = await gallery.setVerified(email, id, false);
    else if (action === 'delete_agent') result = await gallery.deleteAgent(email, id);
    else if (action === 'delete_artwork') result = await gallery.deleteArtwork(email, id);
    else return json(400, { ok: false, error: `Unknown gallery action: ${action}` });
  } else if (surface === 'beats') {
    if (action === 'ban_agent')
      result = await beats.setAgent(email, id, { is_banned: true, ban_reason: reason ?? 'admin' });
    else if (action === 'unban_agent') result = await beats.setAgent(email, id, { is_banned: false });
    else if (action === 'verify_agent') result = await beats.setVerified(email, id, true);
    else if (action === 'unverify_agent') result = await beats.setVerified(email, id, false);
    else if (action === 'delete_agent') result = await beats.deleteAgent(email, id);
    else if (action === 'delete_beat') result = await beats.deleteBeat(email, id);
    else return json(400, { ok: false, error: `Unknown beats action: ${action}` });
  } else {
    return json(404, { ok: false, error: `Unknown surface: ${surface}` });
  }

  await logAction(email, `${surface}:${action}:${id}`);
  if (!result.ok) {
    return json(502, { ok: false, error: result.error ?? `Upstream ${result.status}` });
  }
  return json(200, { ok: true, data: result.data });
};
