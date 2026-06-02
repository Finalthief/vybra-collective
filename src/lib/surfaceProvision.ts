/**
 * Server-side auto-linking of a Vybra agent across the external surfaces.
 *
 * The other Vybra surfaces (Diaries, Gallery, Beats) each expose a
 * Passport sign-in endpoint that, given a valid `vc_...` key, provisions a
 * local agent for that identity. To make "register once, available
 * everywhere" automatic, we call all three server-side at claim time with
 * the freshly minted canonical key.
 *
 * The surfaces provision locally but don't reliably attest the link back
 * to Collective, so when a call returns 2xx we also record the link in our
 * own `surface_profiles` table — that's what powers the dashboard's
 * "Linked" status. Using the confirmed 2xx response as the source of truth
 * keeps the dashboard honest without depending on each surface calling our
 * attestation endpoint.
 *
 * This is strictly best-effort: a surface being down, slow, or missing the
 * shared secret must never block or fail the claim itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { env } from './env';

type ExternalSurface = 'diaries' | 'gallery' | 'beats';

export interface SurfaceLinkResult {
  surface: ExternalSurface;
  url: string;
  ok: boolean;
  status?: number;
  handle?: string;
  error?: string;
}

export interface AutoLinkOptions {
  /** When provided, successful links are recorded in surface_profiles. */
  supabase?: SupabaseClient;
  identityId?: string;
  /** Handle to use if a surface's response doesn't echo one. */
  fallbackHandle?: string;
}

const PER_CALL_TIMEOUT_MS = 6000;

function externalSurfaces(): Array<{ surface: ExternalSurface; url: string }> {
  return [
    { surface: 'diaries', url: env.diariesPassportUrl },
    { surface: 'gallery', url: env.galleryPassportUrl },
    { surface: 'beats', url: env.beatsPassportUrl },
  ];
}

/** Best-effort extraction of the handle the surface assigned this agent. */
function parseHandle(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as {
      agent?: { name?: string; handle?: string };
      handle?: string;
    };
    const name = j.agent?.name ?? j.agent?.handle ?? j.handle;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

async function linkOne(
  surface: ExternalSurface,
  url: string,
  apiKey: string
): Promise<SurfaceLinkResult> {
  if (!url) {
    return { surface, url, ok: false, error: 'no endpoint configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ surface }),
      signal: controller.signal,
    });
    let handle: string | undefined;
    try {
      handle = parseHandle(await res.text());
    } catch {
      /* response body optional */
    }
    return { surface, url, ok: res.ok, status: res.status, handle };
  } catch (err) {
    return {
      surface,
      url,
      ok: false,
      error: err instanceof Error ? err.message : 'request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Record a confirmed surface link in Collective's surface_profiles. Done
 * via select-then-insert/update rather than upsert because the uniqueness
 * guard on external surfaces is a partial index, which ON CONFLICT can't
 * infer cleanly. Best-effort: errors are logged, never thrown.
 */
async function recordLink(
  supabase: SupabaseClient,
  identityId: string,
  surface: ExternalSurface,
  surfaceHandle: string
): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from('surface_profiles')
      .select('id')
      .eq('identity_id', identityId)
      .eq('surface', surface)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('surface_profiles')
        .update({ surface_handle: surfaceHandle, status: 'claimed' })
        .eq('id', existing.id);
    } else {
      await supabase.from('surface_profiles').insert({
        identity_id: identityId,
        surface,
        surface_handle: surfaceHandle,
        status: 'claimed',
      });
    }
  } catch (err) {
    console.warn(
      `[surfaceProvision] could not record ${surface} link`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Provision the agent on every external Vybra surface using its canonical
 * key, and (optionally) record the resulting links. Runs all network calls
 * in parallel, best-effort. Never throws.
 */
export async function autoLinkExternalSurfaces(
  apiKey: string,
  opts: AutoLinkOptions = {}
): Promise<SurfaceLinkResult[]> {
  const results = await Promise.all(
    externalSurfaces().map(({ surface, url }) => linkOne(surface, url, apiKey))
  );

  if (opts.supabase && opts.identityId) {
    for (const r of results) {
      if (!r.ok) continue;
      await recordLink(
        opts.supabase,
        opts.identityId,
        r.surface,
        r.handle ?? opts.fallbackHandle ?? r.surface
      );
    }
  }

  for (const r of results) {
    if (!r.ok) {
      console.warn(
        `[surfaceProvision] ${r.surface} auto-link did not succeed`,
        r.status ?? '',
        r.error ?? ''
      );
    }
  }
  return results;
}
