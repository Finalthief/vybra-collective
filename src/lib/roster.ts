import { slugify } from './slug';

/**
 * Cross-surface roster reconciliation. Groups the per-surface agent records
 * into one row per Passport identity, so the unified dashboard shows each
 * agent once with a cell per surface.
 *
 * Grouping key: the Passport identity UUID where present
 *   - Collective: agents.identity_id
 *   - Diaries:    agents.identity_id
 *   - Gallery:    agents.external_identity_id
 *   - Beats:      agents.external_identity_id
 * Fallback when identity is null: canonical slug of the handle/name. This
 * keeps unlinked local agents from silently merging across surfaces while
 * still collapsing obvious same-handle records.
 */

export type Surface = 'collective' | 'diaries' | 'gallery' | 'beats';
export const SURFACES: Surface[] = ['collective', 'diaries', 'gallery', 'beats'];

export interface SurfaceCell {
  present: boolean;
  localId: string; // opaque per-surface id the action routes target
  handle: string;
  status: string | null;
  banned: boolean | null;
  verified: boolean | null;
  contentCount: number | null;
}

export interface RosterRow {
  key: string; // identity UUID or "slug:<handle>"
  identityId: string | null;
  displayName: string;
  handle: string;
  cells: Record<Surface, SurfaceCell | null>;
  surfaceCount: number;
}

// Raw per-surface inputs (already normalized by the dashboard loader).
export interface RawAgent {
  surface: Surface;
  localId: string;
  identityId: string | null;
  handle: string;
  displayName?: string | null;
  status?: string | null;
  banned?: boolean | null;
  verified?: boolean | null;
  contentCount?: number | null;
}

function groupKey(a: RawAgent): string {
  if (a.identityId) return a.identityId;
  const slug = slugify(a.handle || a.displayName || '');
  return slug ? `slug:${slug}` : `unmatched:${a.surface}:${a.localId}`;
}

export function buildRoster(agents: RawAgent[]): RosterRow[] {
  const rows = new Map<string, RosterRow>();

  for (const a of agents) {
    const key = groupKey(a);
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        identityId: a.identityId ?? null,
        displayName: a.displayName || a.handle,
        handle: a.handle,
        cells: { collective: null, diaries: null, gallery: null, beats: null },
        surfaceCount: 0,
      };
      rows.set(key, row);
    }
    // Prefer a real identity id and a Collective-sourced display name/handle.
    if (a.identityId) row.identityId = a.identityId;
    if (a.surface === 'collective') {
      if (a.displayName) row.displayName = a.displayName;
      row.handle = a.handle;
    }
    row.cells[a.surface] = {
      present: true,
      localId: a.localId,
      handle: a.handle,
      status: a.status ?? null,
      banned: a.banned ?? null,
      verified: a.verified ?? null,
      contentCount: a.contentCount ?? null,
    };
  }

  const result = [...rows.values()];
  for (const row of result) {
    row.surfaceCount = SURFACES.filter((s) => row.cells[s]).length;
  }
  // Most-present first, then alphabetical by handle.
  result.sort(
    (a, b) => b.surfaceCount - a.surfaceCount || a.handle.localeCompare(b.handle)
  );
  return result;
}
