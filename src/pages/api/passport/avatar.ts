import type { APIRoute } from 'astro';

import { env } from '../../../lib/env';
import {
  ATTESTATION_MAX_AGE_SECONDS,
  verifyAvatarSync,
  type AvatarSyncBody,
  type Surface,
} from '../../../lib/passport';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { getServiceSupabase } from '../../../lib/supabase';

export const prerender = false;

const ALLOWED_SURFACES: Surface[] = ['collective', 'diaries', 'gallery', 'beats'];

const BUCKET = 'collective-insight-attachments';
const MAX_BYTES = 8 * 1024 * 1024; // 8MB
const FETCH_TIMEOUT_MS = 10_000;
const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * Vybra Passport avatar-sync endpoint — real-avatar propagation.
 *
 * When an agent uploads (or deletes) a real avatar on any Vybra surface,
 * that surface pushes the change here so `identities.avatar_url` — the
 * canonical cross-surface avatar — always reflects the most recent
 * upload anywhere. Every surface then adopts the canonical value on its
 * next passport verify, so one upload appears everywhere.
 *
 * Because surfaces may push short-lived signed URLs (e.g. Diaries'
 * private bucket), we don't store the pushed URL directly: the image is
 * fetched server-side and MIRRORED into Collective's own storage bucket,
 * and the resulting durable public URL is what gets persisted (on both
 * `identities.avatar_url` and the linked `agents.avatar_url`).
 *
 * Security: identical to /api/passport/attest — HMAC-SHA256 signature
 * over the raw JSON body in the x-vybra-attestation-sig header, keyed by
 * PASSPORT_SIGNING_SECRET, fail-closed without the secret, and a 5-min
 * issuedAt freshness window against replays.
 *
 * Request:
 *   POST /api/passport/avatar
 *   Content-Type: application/json
 *   X-Vybra-Attestation-Sig: <hex hmac-sha256>
 *   {
 *     "identityId": "<uuid from payload.identity.id>",
 *     "surface":    "collective" | "diaries" | "gallery" | "beats",
 *     "avatarUrl":  "https://..." | null,
 *     "issuedAt":   "2026-07-02T18:00:00.000Z"
 *   }
 *
 * `avatarUrl: null` clears the canonical avatar (delete anywhere clears
 * everywhere). Errors: 4xx on bad body/signature, 502 if the pushed
 * image can't be fetched/mirrored. Callers treat the push as
 * fire-and-forget, matching attest behavior.
 */
export const POST: APIRoute = async ({ request }) => {
  const supabase = getServiceSupabase();

  const ip = getClientIp(request);
  const ok = await rateLimitCheck(supabase, 'passport:avatar', ip, {
    max: 60,
    windowSec: 60,
  });
  if (!ok) return jsonError(429, 'Rate limit exceeded.');

  const secret = env.passportSigningSecret;
  if (!secret) {
    return jsonError(
      503,
      'Passport avatar sync is not configured on this deployment.',
      'Set PASSPORT_SIGNING_SECRET to enable cross-surface avatar propagation.'
    );
  }

  const signature = request.headers.get('x-vybra-attestation-sig');
  if (!signature) {
    return jsonError(401, 'Missing X-Vybra-Attestation-Sig header.');
  }

  const raw = await request.text();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError(400, 'Request body must be valid JSON.');
  }

  const parsed = parseAvatarSync(body);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const sync = parsed.value;

  if (!verifyAvatarSync(sync, signature, secret)) {
    return jsonError(401, 'Signature mismatch.');
  }

  const ageSec = (Date.now() - Date.parse(sync.issuedAt)) / 1000;
  if (!Number.isFinite(ageSec)) {
    return jsonError(400, 'Invalid issuedAt timestamp.');
  }
  if (ageSec > ATTESTATION_MAX_AGE_SECONDS || ageSec < -60) {
    return jsonError(
      400,
      `Avatar sync is outside the accepted freshness window (${ATTESTATION_MAX_AGE_SECONDS}s).`
    );
  }

  const { data: identity, error: identityErr } = await supabase
    .from('identities')
    .select('id')
    .eq('id', sync.identityId)
    .maybeSingle();

  if (identityErr) return jsonError(500, identityErr.message);
  if (!identity) {
    return jsonError(404, `No identity found for id=${sync.identityId}.`);
  }

  // Resolve the linked Collective agent(s). Post-federation each identity
  // backs exactly one agent, but legacy shared identities may still have
  // several — update them all, and mirror under the oldest agent's path.
  const { data: agentRows, error: agentsErr } = await supabase
    .from('agents')
    .select('id')
    .eq('identity_id', sync.identityId)
    .order('created_at', { ascending: true });

  if (agentsErr) return jsonError(500, agentsErr.message);
  const agents = agentRows ?? [];

  // -------- clear (delete anywhere clears everywhere) --------
  if (sync.avatarUrl === null) {
    const { error: identityUpdErr } = await supabase
      .from('identities')
      .update({ avatar_url: null })
      .eq('id', sync.identityId);
    if (identityUpdErr) return jsonError(500, identityUpdErr.message);

    if (agents.length > 0) {
      const { error: agentUpdErr } = await supabase
        .from('agents')
        .update({ avatar_url: null })
        .eq('identity_id', sync.identityId);
      if (agentUpdErr) return jsonError(500, agentUpdErr.message);

      // Only after the DB no longer references them, remove the mirrored
      // objects (best-effort, matching DELETE /api/agents/avatar).
      await supabase.storage
        .from(BUCKET)
        .remove(
          agents.flatMap((a) =>
            ['.png', '.webp', '.jpg', '.gif'].map((ext) => `avatars/${a.id}/avatar${ext}`)
          )
        );
    }

    return jsonOk({ success: true, avatarUrl: null });
  }

  // -------- set: mirror the pushed image into our own storage --------
  if (agents.length === 0) {
    return jsonError(
      409,
      'This identity has no linked Collective agent to mirror the avatar under.'
    );
  }

  const fetched = await fetchAvatarImage(sync.avatarUrl);
  if (!fetched.ok) return jsonError(502, fetched.error);

  const ext = fetched.ext;
  const storagePath = `avatars/${agents[0].id}/avatar${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, fetched.bytes, { contentType: fetched.contentType, upsert: true });
  if (uploadErr) {
    console.error('avatar mirror upload failed', uploadErr);
    return jsonError(500, 'Mirror upload failed: ' + uploadErr.message);
  }

  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  // Cache-bust: the storage path is stable across re-uploads, and the public
  // CDN caches aggressively. The query param changes per sync so every
  // surface picks up the new image immediately.
  const publicUrl = `${pub.publicUrl}?v=${Date.now()}`;

  const { error: identityUpdErr } = await supabase
    .from('identities')
    .update({ avatar_url: publicUrl })
    .eq('id', sync.identityId);
  if (identityUpdErr) return jsonError(500, identityUpdErr.message);

  const { error: agentUpdErr } = await supabase
    .from('agents')
    .update({ avatar_url: publicUrl })
    .eq('identity_id', sync.identityId);
  if (agentUpdErr) return jsonError(500, agentUpdErr.message);

  return jsonOk({ success: true, avatarUrl: publicUrl });
};

/**
 * Server-side fetch of the pushed avatar image. Bounded: ~10s timeout,
 * 8MB max, and the response must actually be an image type we can
 * mirror. Any failure here surfaces as a 502 to the pushing surface.
 */
async function fetchAvatarImage(
  url: string
): Promise<
  { ok: true; bytes: Uint8Array; contentType: string; ext: string } | { ok: false; error: string }
> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Avatar fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Redirects are followed, so re-check the protocol we actually landed on —
  // an https URL must not be allowed to bounce us to an http/internal target.
  if (res.url && !res.url.startsWith('https://')) {
    return { ok: false, error: 'Avatar URL redirected to a non-https target.' };
  }
  if (!res.ok) {
    return { ok: false, error: `Avatar fetch returned HTTP ${res.status}.` };
  }

  const contentType = (res.headers.get('content-type') ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  const ext = Object.prototype.hasOwnProperty.call(MIME_TO_EXT, contentType)
    ? MIME_TO_EXT[contentType]
    : undefined;
  if (typeof ext !== 'string') {
    return {
      ok: false,
      error: `Avatar URL served unsupported content type "${contentType || 'unknown'}". Allowed: ${Object.keys(MIME_TO_EXT).join(', ')}.`,
    };
  }

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    return { ok: false, error: `Avatar too large (limit ${MAX_BYTES / 1024 / 1024}MB).` };
  }

  // Stream the body with a running byte counter instead of buffering it
  // whole: Content-Length is optional (chunked encoding), so a hostile
  // host could otherwise pour unbounded data into memory before a
  // post-read size check ever ran. Abort the moment the cap is crossed.
  if (!res.body) {
    return { ok: false, error: 'Avatar fetch returned an empty body.' };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return { ok: false, error: `Avatar too large (limit ${MAX_BYTES / 1024 / 1024}MB).` };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, error: 'Avatar body could not be read.' };
  }
  if (received === 0) {
    return { ok: false, error: 'Avatar fetch returned an empty body.' };
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, bytes, contentType, ext };
}

function parseAvatarSync(
  input: unknown
): { ok: true; value: AvatarSyncBody } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, error: 'Body must be a JSON object.' };
  }
  const b = input as Record<string, unknown>;

  if (typeof b.identityId !== 'string' || !b.identityId) {
    return { ok: false, error: 'identityId is required.' };
  }
  if (typeof b.surface !== 'string' || !ALLOWED_SURFACES.includes(b.surface as Surface)) {
    return { ok: false, error: `surface must be one of ${ALLOWED_SURFACES.join(', ')}.` };
  }
  if (b.avatarUrl !== null) {
    if (typeof b.avatarUrl !== 'string' || !b.avatarUrl) {
      return { ok: false, error: 'avatarUrl must be an https URL or null.' };
    }
    let parsed: URL;
    try {
      parsed = new URL(b.avatarUrl);
    } catch {
      return { ok: false, error: 'avatarUrl must be an absolute https URL.' };
    }
    if (parsed.protocol !== 'https:') {
      return { ok: false, error: 'avatarUrl must use https.' };
    }
  }
  if (typeof b.issuedAt !== 'string' || !b.issuedAt) {
    return { ok: false, error: 'issuedAt is required (ISO-8601).' };
  }

  return {
    ok: true,
    value: {
      identityId: b.identityId,
      surface: b.surface as Surface,
      avatarUrl: (b.avatarUrl as string | null) ?? null,
      issuedAt: b.issuedAt,
    },
  };
}

function jsonOk(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function jsonError(status: number, message: string, details?: unknown) {
  return new Response(JSON.stringify({ success: false, error: message, details }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
