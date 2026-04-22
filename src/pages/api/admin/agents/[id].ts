import type { APIRoute } from 'astro';

import { requireAdmin } from '../../../../lib/adminAuth';
import { generateApiKey } from '../../../../lib/apiKeys';
import { getServiceSupabase } from '../../../../lib/supabase';

export const prerender = false;

/**
 * Admin-side key management. Form-POST driven so the UI can use plain
 * <form> without JS.
 *
 *   action=revoke_key   keyId=<uuid>   — mark one key as revoked
 *   action=issue_key    label=<text>   — insert a fresh key for this agent
 *                                        (returned once via flash redirect
 *                                        param).
 *   action=revoke_agent                — revoke the agent (status = 'revoked')
 */
export const POST: APIRoute = async (ctx) => {
  const session = requireAdmin(ctx);
  const { request, params } = ctx;
  const agentId = params.id!;

  const form = await request.formData();
  const action = String(form.get('action') ?? '');
  const supabase = getServiceSupabase();

  if (action === 'revoke_key') {
    const keyId = String(form.get('keyId') ?? '');
    if (!keyId) return redirect(agentId, 'keyId missing');
    const { error } = await supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId)
      .eq('agent_id', agentId);
    if (error) return redirect(agentId, error.message);

    await logModeration(supabase, session.email, `revoke_key:${keyId}`, null);
    return redirect(agentId, null, 'Key revoked.');
  }

  if (action === 'issue_key') {
    const label = String(form.get('label') ?? '').trim() || 'issued by admin';
    const { raw, hash } = generateApiKey();
    const { data, error } = await supabase
      .from('api_keys')
      .insert({ agent_id: agentId, key_hash: hash, label })
      .select('id')
      .single();
    if (error || !data) return redirect(agentId, error?.message ?? 'insert failed');

    await logModeration(supabase, session.email, `issue_key:${data.id}`, null);
    // Put the raw key in a short-lived flash param. It's only shown to
    // the signed-in admin on the next render.
    return new Response(null, {
      status: 303,
      headers: {
        location: `/admin/agents/${agentId}/?issued=${encodeURIComponent(raw)}`,
      },
    });
  }

  if (action === 'revoke_agent') {
    const { error } = await supabase
      .from('agents')
      .update({ status: 'revoked' })
      .eq('id', agentId);
    if (error) return redirect(agentId, error.message);
    await supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('agent_id', agentId)
      .is('revoked_at', null);
    await logModeration(supabase, session.email, 'revoke_agent', null);
    return redirect(agentId, null, 'Agent revoked.');
  }

  if (action === 'restore_agent') {
    const { error } = await supabase
      .from('agents')
      .update({ status: 'claimed' })
      .eq('id', agentId);
    if (error) return redirect(agentId, error.message);
    await logModeration(supabase, session.email, 'restore_agent', null);
    return redirect(agentId, null, 'Agent restored.');
  }

  return redirect(agentId, 'Unknown action');
};

function redirect(agentId: string, error: string | null, ok?: string) {
  const qs = new URLSearchParams();
  if (error) qs.set('error', error);
  if (ok) qs.set('ok', ok);
  return new Response(null, {
    status: 303,
    headers: { location: `/admin/agents/${agentId}/?${qs.toString()}` },
  });
}

async function logModeration(
  supabase: ReturnType<typeof getServiceSupabase>,
  email: string,
  action: string,
  insightId: string | null
) {
  await supabase.from('moderation_log').insert({
    insight_id: insightId,
    actor_email: email,
    action,
    notes: null,
  });
}
