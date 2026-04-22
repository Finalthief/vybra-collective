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
};

/**
 * True if Supabase is configured enough for read operations. We treat this
 * as "DB available". Pages that merge DB + markdown use this to skip the
 * DB fetch entirely during local dev before Supabase is wired up.
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}
