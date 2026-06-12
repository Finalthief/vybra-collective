import { mintAdminSsoToken, type AdminSsoSite } from './adminSso';
import { env } from './env';

/**
 * Server-side proxy for cross-surface admin calls. Collective mints a 90s
 * Admin SSO token, exchanges it (via each surface's `?format=json` SSO mode)
 * for that surface's NATIVE admin credential, caches it briefly, and forwards
 * admin API calls. Native credentials never reach the browser.
 */

interface NativeCred {
  token: string;
  auth: 'bearer' | 'cookie';
  cookieName: string | null;
}

interface CacheEntry {
  cred: NativeCred;
  expiresAt: number;
}

// Module-level cache. Survives only within a warm serverless instance; a cold
// start simply re-exchanges (cheap). 401 also evicts + re-exchanges.
const credCache = new Map<AdminSsoSite, CacheEntry>();
const CRED_TTL_MS = 5 * 60 * 1000;

const SSO_EXCHANGE_URL: Record<AdminSsoSite, () => string> = {
  diaries: () => env.diariesAdminSsoUrl,
  gallery: () => env.galleryAdminSsoUrl,
  beats: () => env.beatsAdminSsoUrl,
};

const ADMIN_API_BASE: Record<AdminSsoSite, () => string> = {
  diaries: () => env.diariesAdminApiBase,
  gallery: () => env.galleryAdminApiBase,
  beats: () => env.beatsAdminApiBase,
};

export interface ProxyResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  ms = 8000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function exchange(site: AdminSsoSite, email: string): Promise<NativeCred> {
  if (!env.adminSsoSecret) {
    throw new Error('ADMIN_SSO_SECRET not configured');
  }
  const token = mintAdminSsoToken(site, email);
  const sep = SSO_EXCHANGE_URL[site]().includes('?') ? '&' : '?';
  const url = `${SSO_EXCHANGE_URL[site]()}${sep}format=json&token=${encodeURIComponent(token)}`;
  const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`SSO exchange failed for ${site}: ${res.status}`);
  }
  const body = (await res.json()) as NativeCred;
  if (!body?.token) throw new Error(`SSO exchange returned no token for ${site}`);
  return { token: body.token, auth: body.auth ?? 'bearer', cookieName: body.cookieName ?? null };
}

async function getNativeCred(
  site: AdminSsoSite,
  email: string,
  forceRefresh = false
): Promise<NativeCred> {
  const now = Date.now();
  const cached = credCache.get(site);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.cred;
  }
  const cred = await exchange(site, email);
  credCache.set(site, { cred, expiresAt: now + CRED_TTL_MS });
  return cred;
}

function applyAuth(cred: NativeCred, init: RequestInit): RequestInit {
  const headers = new Headers(init.headers);
  if (cred.auth === 'cookie' && cred.cookieName) {
    headers.set('cookie', `${cred.cookieName}=${cred.token}`);
  } else {
    headers.set('authorization', `Bearer ${cred.token}`);
  }
  return { ...init, headers };
}

/**
 * Forward an admin API call to a target surface with its native credential.
 * Never throws — any failure/timeout/non-2xx is returned as { ok:false }.
 * Evicts the cache and retries once on a 401.
 */
export async function proxyAdminFetch<T = unknown>(
  site: AdminSsoSite,
  email: string,
  path: string,
  init: RequestInit = {}
): Promise<ProxyResult<T>> {
  const url = `${ADMIN_API_BASE[site]()}${path}`;
  try {
    let cred = await getNativeCred(site, email);
    let res = await fetchWithTimeout(url, applyAuth(cred, init));
    if (res.status === 401) {
      credCache.delete(site);
      cred = await getNativeCred(site, email, true);
      res = await fetchWithTimeout(url, applyAuth(cred, init));
    }
    let data: T | null = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = text as unknown as T;
      }
    }
    if (!res.ok) {
      return { ok: false, status: res.status, data, error: `HTTP ${res.status}` };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 0, data: null, error: msg };
  }
}
