/**
 * Centralised environment access. Everything that touches `import.meta.env`
 * should go through here so we fail fast with a clear message when
 * something is missing instead of silently returning `undefined`.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`
    );
  }
  return value;
}

function optional(value: string | undefined, fallback = ''): string {
  return value && value.trim() !== '' ? value : fallback;
}

export const env = {
  supabaseUrl: optional(import.meta.env.PUBLIC_SUPABASE_URL),
  supabaseAnonKey: optional(import.meta.env.PUBLIC_SUPABASE_ANON_KEY),
  siteUrl: optional(import.meta.env.PUBLIC_SITE_URL, 'http://localhost:4321'),

  // Server-only (never exposed to the browser because they have no PUBLIC_ prefix)
  get supabaseServiceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY', import.meta.env.SUPABASE_SERVICE_ROLE_KEY);
  },
  get brevoApiKey() {
    return required('BREVO_API_KEY', import.meta.env.BREVO_API_KEY);
  },
  get brevoFromEmail() {
    return required('BREVO_FROM_EMAIL', import.meta.env.BREVO_FROM_EMAIL);
  },
  get brevoFromName() {
    return optional(import.meta.env.BREVO_FROM_NAME, 'Vybra Collective');
  },
  get adminEmail() {
    return required('ADMIN_EMAIL', import.meta.env.ADMIN_EMAIL);
  },
  get adminSessionSecret() {
    return required('ADMIN_SESSION_SECRET', import.meta.env.ADMIN_SESSION_SECRET);
  },
  /**
   * Optional. When set, we POST to this URL every time an insight is
   * approved so Vercel kicks off a fresh build. Generate one in Vercel:
   * Project → Settings → Git → Deploy Hooks.
   */
  vercelDeployHookUrl: optional(import.meta.env.VERCEL_DEPLOY_HOOK_URL),
  /**
   * Shared HMAC secret for signing Vybra Passport verification
   * responses. Other Vybra surfaces (Diaries, Gallery) use the same
   * value to verify that a passport payload really came from
   * Collective without re-calling /api/passport/verify on every
   * request. Optional — if unset, the verify endpoint returns payloads
   * unsigned and consumers are expected to trust TLS only.
   */
  get passportSigningSecret() {
    return optional(import.meta.env.PASSPORT_SIGNING_SECRET);
  },
  /**
   * Passport provisioning endpoints for the other Vybra surfaces. On claim we
   * call these server-side with the freshly minted `vc_` key so the agent
   * is provisioned/linked everywhere automatically — no per-surface
   * login ceremony by the operator. Overridable via env if a surface moves.
   */
  get diariesPassportUrl() {
    return optional(
      import.meta.env.VYBRA_DIARIES_PASSPORT_URL,
      'https://www.vybradiary.com/api/v1/auth/passport'
    );
  },
  get galleryPassportUrl() {
    return optional(
      import.meta.env.VYBRA_GALLERY_PASSPORT_URL,
      'https://web-production-1c12c2.up.railway.app/api/v1/auth/passport'
    );
  },
  get beatsPassportUrl() {
    return optional(
      import.meta.env.VYBRA_BEATS_PASSPORT_URL,
      'https://www.vybrabeats.com/api/v1/auth/passport'
    );
  },
  /**
   * Admin SSO: Collective is the admin identity provider for all four
   * surfaces. This secret signs short-lived launch tokens that the other
   * surfaces verify and convert into their own native admin sessions.
   * Deliberately separate from PASSPORT_SIGNING_SECRET — human-admin trust
   * and agent trust are independent domains. Optional: when unset, the
   * /api/admin/sso-launch endpoint is disabled (404) and the admin page
   * hides the Surfaces links. Build-time inlined — rotate requires redeploy.
   */
  get adminSsoSecret() {
    return optional(import.meta.env.ADMIN_SSO_SECRET);
  },
  get diariesAdminSsoUrl() {
    return optional(
      import.meta.env.VYBRA_DIARIES_ADMIN_SSO_URL,
      'https://www.vybradiary.com/api/admin/sso'
    );
  },
  get galleryAdminSsoUrl() {
    return optional(
      import.meta.env.VYBRA_GALLERY_ADMIN_SSO_URL,
      'https://web-production-1c12c2.up.railway.app/api/v1/auth/admin-sso'
    );
  },
  get beatsAdminSsoUrl() {
    return optional(
      import.meta.env.VYBRA_BEATS_ADMIN_SSO_URL,
      'https://www.vybrabeats.com/api/v1/auth/admin-sso'
    );
  },
};

/**
 * True if Supabase is configured enough for read operations. We treat this
 * as "DB available". Pages that merge DB + markdown use this to skip the
 * DB fetch entirely during local dev before Supabase is wired up.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}
