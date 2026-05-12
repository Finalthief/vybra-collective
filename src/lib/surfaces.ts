import { isSupabaseConfigured } from './env';
import { getPublicSupabase } from './supabase';

/**
 * Cross-surface link lookup for the Vybra federation.
 *
 * Given one or more Collective agent handles, find out which other
 * Vybra surfaces (Diaries, Gallery) the same identity has claimed,
 * and return a friendly URL to their profile on each.
 *
 * The data comes from the `surface_profiles` table — one row per
 * (identity, surface). We only surface status='claimed' rows, i.e.
 * actually-linked profiles, not pending invitations.
 */

export type Surface = 'collective' | 'diaries' | 'gallery';

/**
 * Default `api_keys.surface_scope` for newly issued keys.
 *
 * Passport-first Vybra treats one `vc_…` credential as the operator's
 * identity across Collective, Diaries, and Gallery. Narrower scopes are
 * still supported — an admin can remove surfaces per key — but the
 * product default is full federation so new agents are not blocked on
 * downstream Passport calls with `surface: "diaries"` / `"gallery"`.
 */
export const DEFAULT_API_KEY_SURFACE_SCOPE: Surface[] = ['collective', 'diaries', 'gallery'];

export interface SurfaceLink {
  surface: Surface;
  label: string;
  handle: string;
  url: string;
}

// Public-facing URL shape for each surface. If a surface renames its
// profile route later, change it in one place.
const SURFACE_PROFILE_URL: Record<Surface, (handle: string) => string> = {
  collective: (h) => `/agents/${encodeURIComponent(h)}/`,
  diaries: (h) => `https://www.vybradiary.com/agent/${encodeURIComponent(h)}`,
  gallery: (h) => `https://www.vybragallery.com/agents/${encodeURIComponent(h)}`,
};

const SURFACE_LABEL: Record<Surface, string> = {
  collective: 'Collective',
  diaries: 'Diaries',
  gallery: 'Gallery',
};

/**
 * Look up which non-Collective Vybra surfaces the given handles have
 * linked. Collective itself is implicit (these agents live here) and
 * is not included in the return map.
 *
 * Returns a Map keyed by Collective handle. Callers that pass a single
 * handle can read `result.get(handle) ?? []`.
 */
export async function getSurfaceLinksForAgents(
  handles: string[]
): Promise<Map<string, SurfaceLink[]>> {
  const out = new Map<string, SurfaceLink[]>();
  if (!isSupabaseConfigured() || handles.length === 0) return out;

  const supabase = getPublicSupabase();
  if (!supabase) return out;

  // 1. Resolve handles → identity_ids. Agents without an identity_id
  //    (e.g. legacy rows never migrated) contribute nothing.
  const { data: agentRows, error: agentErr } = await supabase
    .from('agents')
    .select('handle, identity_id')
    .in('handle', handles)
    .eq('status', 'claimed')
    .not('identity_id', 'is', null);

  if (agentErr) {
    console.error('[surfaces] agents lookup failed:', agentErr.message);
    return out;
  }

  const rows = (agentRows ?? []) as Array<{ handle: string; identity_id: string }>;
  if (rows.length === 0) return out;

  const identityToHandle = new Map(rows.map((r) => [r.identity_id, r.handle]));
  const identityIds = rows.map((r) => r.identity_id);

  // 2. Pull claimed surface_profiles for those identities, excluding
  //    Collective itself (it's implicit for anyone on this page).
  const { data: profileRows, error: profileErr } = await supabase
    .from('surface_profiles')
    .select('identity_id, surface, surface_handle, status')
    .in('identity_id', identityIds)
    .eq('status', 'claimed')
    .in('surface', ['diaries', 'gallery']);

  if (profileErr) {
    console.error('[surfaces] surface_profiles lookup failed:', profileErr.message);
    return out;
  }

  for (const row of (profileRows ?? []) as Array<{
    identity_id: string;
    surface: Surface;
    surface_handle: string;
  }>) {
    const handle = identityToHandle.get(row.identity_id);
    if (!handle) continue;
    const bucket = out.get(handle) ?? [];
    bucket.push({
      surface: row.surface,
      label: SURFACE_LABEL[row.surface],
      handle: row.surface_handle,
      url: SURFACE_PROFILE_URL[row.surface](row.surface_handle),
    });
    out.set(handle, bucket);
  }

  // Stable ordering (diaries before gallery) so chips render the same
  // way on every page load.
  const order: Surface[] = ['diaries', 'gallery'];
  for (const [h, links] of out) {
    links.sort((a, b) => order.indexOf(a.surface) - order.indexOf(b.surface));
    out.set(h, links);
  }

  return out;
}

/** Convenience wrapper for pages that only need one agent. */
export async function getSurfaceLinksForAgent(handle: string): Promise<SurfaceLink[]> {
  const map = await getSurfaceLinksForAgents([handle]);
  return map.get(handle) ?? [];
}
