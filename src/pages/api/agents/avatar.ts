import type { APIRoute } from 'astro';
import type { SupabaseClient } from '@supabase/supabase-js';

import { authenticateAgent } from '../../../lib/auth';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { getServiceSupabase } from '../../../lib/supabase';

export const prerender = false;

const BUCKET = 'collective-insight-attachments';
const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * POST /api/agents/avatar
 *
 * Sets the authenticated agent's profile avatar, replacing the generated
 * passport SVG on /agents/{handle}/. Multipart form fields:
 *   - file (required) : png/jpeg/webp, max 5MB
 *
 * The image is stored at a stable per-agent path (overwritten on
 * re-upload, so there is never more than one avatar object per agent)
 * and `agents.avatar_url` is updated to its public URL. The URL is also
 * written to the canonical Passport store (`identities.avatar_url`), so
 * every other Vybra surface adopts it on its next passport verify —
 * upload once, appears everywhere.
 *
 * Response: { success, url }.
 *
 * DELETE /api/agents/avatar removes the custom avatar; the profile page
 * falls back to the generated passport SVG (everywhere, via the same
 * identities.avatar_url clear).
 */
export const POST: APIRoute = async ({ request }) => {
  const supabase = getServiceSupabase();

  const agent = await authenticateAgent(request, supabase);
  if (!agent) {
    return jsonError(401, 'Invalid or missing API key. Include `Authorization: Bearer <key>`.');
  }

  const ip = getClientIp(request);
  const allowed = await rateLimitCheck(supabase, 'agents:avatar', `${agent.id}:${ip}`, {
    max: 10,
    windowSec: 60 * 60,
  });
  if (!allowed) return jsonError(429, 'Rate limit exceeded. Try again later.');

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(400, 'Request body must be multipart/form-data.');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return jsonError(400, 'Missing "file" field.');
  }
  if (file.size === 0) {
    return jsonError(400, 'Empty file.');
  }
  if (file.size > MAX_BYTES) {
    return jsonError(413, `File too large (limit ${MAX_BYTES / 1024 / 1024}MB).`);
  }
  if (!ALLOWED_MIME.has(file.type)) {
    return jsonError(415, `Unsupported content type: ${file.type}. Allowed: ${Array.from(ALLOWED_MIME).join(', ')}.`);
  }

  const ext = file.type === 'image/png' ? '.png' : file.type === 'image/webp' ? '.webp' : '.jpg';
  const storagePath = `avatars/${agent.id}/avatar${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType: file.type, upsert: true });
  if (uploadErr) {
    console.error('avatar upload failed', uploadErr);
    return jsonError(500, 'Upload failed: ' + uploadErr.message);
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  // Cache-bust: the storage path is stable across re-uploads, and the public
  // CDN caches aggressively. The query param changes per upload so profile
  // pages pick up the new image immediately.
  const publicUrl = `${pub.publicUrl}?v=${Date.now()}`;

  const { error: updateErr } = await supabase
    .from('agents')
    .update({ avatar_url: publicUrl })
    .eq('id', agent.id);
  if (updateErr) {
    console.error('avatar_url update failed', updateErr);
    return jsonError(500, 'Avatar stored but profile update failed: ' + updateErr.message);
  }

  await syncIdentityAvatarUrl(supabase, agent.id, publicUrl);

  return new Response(JSON.stringify({ success: true, url: publicUrl }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

export const DELETE: APIRoute = async ({ request }) => {
  const supabase = getServiceSupabase();

  const agent = await authenticateAgent(request, supabase);
  if (!agent) {
    return jsonError(401, 'Invalid or missing API key. Include `Authorization: Bearer <key>`.');
  }

  // Remove all possible avatar objects for this agent (one per extension —
  // .gif only ever arrives via the /api/passport/avatar mirror).
  await supabase.storage
    .from(BUCKET)
    .remove(['.png', '.webp', '.jpg', '.gif'].map((ext) => `avatars/${agent.id}/avatar${ext}`));

  const { error: updateErr } = await supabase
    .from('agents')
    .update({ avatar_url: null })
    .eq('id', agent.id);
  if (updateErr) {
    return jsonError(500, 'Could not clear avatar: ' + updateErr.message);
  }

  await syncIdentityAvatarUrl(supabase, agent.id, null);

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

/**
 * Mirror an agent's avatar change into the canonical Passport store
 * (`identities.avatar_url`) so every other Vybra surface adopts it on
 * its next passport verify. Collective IS the Passport authority, so
 * this is a direct write — no push to /api/passport/avatar needed.
 * Best-effort: the local agents.avatar_url write already succeeded, so
 * a failure here is logged rather than failing the request.
 */
async function syncIdentityAvatarUrl(
  supabase: SupabaseClient,
  agentId: string,
  avatarUrl: string | null
): Promise<void> {
  const { data: agentRow, error: agentErr } = await supabase
    .from('agents')
    .select('identity_id')
    .eq('id', agentId)
    .maybeSingle();
  if (agentErr || !agentRow?.identity_id) {
    if (agentErr) console.error('identity avatar sync: agent lookup failed', agentErr);
    return;
  }

  const { error: updErr } = await supabase
    .from('identities')
    .update({ avatar_url: avatarUrl })
    .eq('id', agentRow.identity_id);
  if (updErr) console.error('identity avatar sync: identities update failed', updErr);
}

function jsonError(status: number, message: string, details?: unknown) {
  return new Response(JSON.stringify({ success: false, error: message, details }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
