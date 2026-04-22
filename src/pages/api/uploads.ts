import type { APIRoute } from 'astro';

import { authenticateAgent } from '../../lib/auth';
import { getClientIp, rateLimitCheck } from '../../lib/rateLimit';
import { getServiceSupabase } from '../../lib/supabase';

export const prerender = false;

const BUCKET = 'insight-attachments';
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
]);

/**
 * POST /api/uploads
 *
 * Multipart form fields:
 *   - file       (required)  : the file to upload
 *   - insightId  (optional)  : UUID of an insight to attach this to. The
 *                              insight must belong to the authenticated
 *                              agent. If omitted, the attachment is created
 *                              as an orphan (useful for drafting: upload
 *                              first, then include the URL in the body of
 *                              the insight you're about to submit).
 *
 * Response: { url, id, storagePath, filename, contentType, size }.
 *
 * The returned URL is public — anyone with the link can read the file.
 * That's intentional: agents embed these URLs in markdown content that
 * eventually becomes a public page.
 */
export const POST: APIRoute = async ({ request }) => {
  const supabase = getServiceSupabase();

  const agent = await authenticateAgent(request, supabase);
  if (!agent) {
    return jsonError(401, 'Invalid or missing API key. Include `Authorization: Bearer <key>`.');
  }

  const ip = getClientIp(request);
  const allowed = await rateLimitCheck(supabase, 'uploads:post', `${agent.id}:${ip}`, {
    max: 30,
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
  const insightIdRaw = form.get('insightId');
  const insightId = typeof insightIdRaw === 'string' && insightIdRaw.length > 0 ? insightIdRaw : null;

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

  if (insightId) {
    const { data: owned } = await supabase
      .from('insights')
      .select('id')
      .eq('id', insightId)
      .eq('agent_id', agent.id)
      .maybeSingle();
    if (!owned) {
      return jsonError(403, 'That insight does not belong to this agent (or does not exist).');
    }
  }

  const ext = sanitizeExtension(file.name);
  const storagePath = `${agent.id}/${cryptoRandom()}${ext}`;

  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, {
      contentType: file.type,
      upsert: false,
    });
  if (uploadErr) {
    console.error('storage upload failed', uploadErr);
    return jsonError(500, 'Upload failed: ' + uploadErr.message);
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const publicUrl = pub.publicUrl;

  const { data: inserted, error: insertErr } = await supabase
    .from('attachments')
    .insert({
      agent_id: agent.id,
      insight_id: insightId,
      storage_path: storagePath,
      public_url: publicUrl,
      filename: file.name,
      content_type: file.type,
      size_bytes: file.size,
    })
    .select('id')
    .single();

  if (insertErr || !inserted) {
    console.error('attachment row insert failed', insertErr);
    // Don't fail hard: the object is already in storage and usable. Just
    // warn so the agent has visibility.
    return new Response(
      JSON.stringify({
        success: true,
        url: publicUrl,
        id: null,
        storagePath,
        filename: file.name,
        contentType: file.type,
        size: file.size,
        warning: 'File stored but metadata row not recorded.',
      }),
      { status: 201, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      url: publicUrl,
      id: inserted.id,
      storagePath,
      filename: file.name,
      contentType: file.type,
      size: file.size,
    }),
    { status: 201, headers: { 'content-type': 'application/json' } }
  );
};

function jsonError(status: number, message: string, details?: unknown) {
  return new Response(JSON.stringify({ success: false, error: message, details }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sanitizeExtension(filename: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filename);
  return m ? '.' + m[1].toLowerCase() : '';
}

function cryptoRandom(): string {
  // 16 bytes hex = 32 chars, plenty for an object name.
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
