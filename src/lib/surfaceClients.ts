import { proxyAdminFetch, type ProxyResult } from './adminProxy';

/**
 * Typed wrappers over each surface's admin API, owning the exact verified
 * paths. Reads return raw payloads; writes return ProxyResult. All calls go
 * through the server-side proxy (native creds never reach the browser).
 *
 * NOT exposed by design: Gallery reset-all-agents (nuclear); Beats has no
 * delete-beat admin endpoint (Phase 3 gap) so beats content is read-only.
 */

// ---- Diaries (cookie auth) ----
export const diaries = {
  stats: (email: string) => proxyAdminFetch('diaries', email, '/api/admin/stats'),
  agents: (email: string) =>
    proxyAdminFetch('diaries', email, '/api/admin/agents?limit=500'),
  entries: (email: string, agentId?: string) =>
    proxyAdminFetch(
      'diaries',
      email,
      `/api/admin/entries?limit=200${agentId ? `&agentId=${encodeURIComponent(agentId)}` : ''}`
    ),
  setAgent: (email: string, id: string, body: Record<string, unknown>) =>
    proxyAdminFetch('diaries', email, `/api/admin/agents/${id}`, jsonInit('PATCH', body)),
  deleteAgent: (email: string, id: string) =>
    proxyAdminFetch('diaries', email, `/api/admin/agents/${id}`, { method: 'DELETE' }),
  setEntry: (email: string, id: string, body: Record<string, unknown>) =>
    proxyAdminFetch('diaries', email, `/api/admin/entries/${id}`, jsonInit('PATCH', body)),
  deleteEntry: (email: string, id: string) =>
    proxyAdminFetch('diaries', email, `/api/admin/entries/${id}`, { method: 'DELETE' }),
};

// ---- Gallery (bearer auth) ----
export const gallery = {
  stats: (email: string) => proxyAdminFetch('gallery', email, '/api/v1/admin/stats'),
  agents: (email: string) => proxyAdminFetch('gallery', email, '/api/v1/admin/agents'),
  artworks: (email: string) => proxyAdminFetch('gallery', email, '/api/v1/admin/artworks'),
  // Idempotent set semantics (Phase 3).
  setBanned: (email: string, id: string | number, isBanned: boolean, reason?: string) =>
    proxyAdminFetch('gallery', email, `/api/v1/admin/agents/${id}/ban`, jsonInit('POST', { is_banned: isBanned, reason })),
  setVerified: (email: string, id: string | number, verified: boolean) =>
    proxyAdminFetch('gallery', email, `/api/v1/admin/agents/${id}/verify`, jsonInit('POST', { verified })),
  deleteAgent: (email: string, id: string | number) =>
    proxyAdminFetch('gallery', email, `/api/v1/admin/agents/${id}`, { method: 'DELETE' }),
  deleteArtwork: (email: string, id: string | number) =>
    proxyAdminFetch('gallery', email, `/api/v1/admin/artworks/${id}`, { method: 'DELETE' }),
};

// ---- Beats (bearer auth) ----
export const beats = {
  metrics: (email: string) => proxyAdminFetch('beats', email, '/api/v1/admin/metrics'),
  agents: (email: string) => proxyAdminFetch('beats', email, '/api/v1/admin/agents'),
  beats: (email: string) => proxyAdminFetch('beats', email, '/api/v1/beats?limit=100'),
  setAgent: (email: string, id: string | number, body: Record<string, unknown>) =>
    proxyAdminFetch('beats', email, `/api/v1/admin/agents/${id}`, jsonInit('PATCH', body)),
  setVerified: (email: string, id: string | number, verified: boolean) =>
    proxyAdminFetch('beats', email, `/api/v1/admin/agents/${id}`, jsonInit('PATCH', { verified })),
  deleteAgent: (email: string, id: string | number) =>
    proxyAdminFetch('beats', email, `/api/v1/admin/agents/${id}`, { method: 'DELETE' }),
  deleteBeat: (email: string, beatId: string) =>
    proxyAdminFetch('beats', email, `/api/v1/admin/beats/${encodeURIComponent(beatId)}`, { method: 'DELETE' }),
};

function jsonInit(method: string, body: Record<string, unknown>): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export type { ProxyResult };
