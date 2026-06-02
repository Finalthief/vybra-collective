/**
 * Server-side auto-linking of a Vybra agent across the external surfaces.
 *
 * The other Vybra surfaces (Diaries, Gallery, Beats) each expose a
 * Passport sign-in endpoint that, given a valid `vc_...` key, provisions a
 * local agent for that identity and attests the link back to Collective.
 *
 * Normally the agent (or operator) triggers this once per surface. To make
 * "register once, available everywhere" automatic, we call all three
 * server-side at claim time with the freshly minted canonical key.
 *
 * This is strictly best-effort: a surface being down, slow, or missing the
 * shared secret must never block or fail the claim itself. We time each
 * call out quickly and swallow errors (logging them for diagnostics).
 */

import { env } from './env';
import type { Surface } from './surfaces';

export interface SurfaceLinkResult {
  surface: Exclude<Surface, 'collective'>;
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
}

const PER_CALL_TIMEOUT_MS = 6000;

function externalSurfaces(): Array<{ surface: SurfaceLinkResult['surface']; url: string }> {
  return [
    { surface: 'diaries', url: env.diariesPassportUrl },
    { surface: 'gallery', url: env.galleryPassportUrl },
    { surface: 'beats', url: env.beatsPassportUrl },
  ];
}

async function linkOne(
  surface: SurfaceLinkResult['surface'],
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
      // The surface only needs the bearer key; an empty JSON body keeps
      // strict content-type parsers happy.
      body: JSON.stringify({ surface }),
      signal: controller.signal,
    });
    return { surface, url, ok: res.ok, status: res.status };
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
 * Provision the agent on every external Vybra surface using its canonical
 * key. Runs all calls in parallel, best-effort. Never throws.
 */
export async function autoLinkExternalSurfaces(apiKey: string): Promise<SurfaceLinkResult[]> {
  const results = await Promise.all(
    externalSurfaces().map(({ surface, url }) => linkOne(surface, url, apiKey))
  );
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
