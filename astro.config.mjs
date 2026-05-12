// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://vybra-collective.vercel.app',
  // Static by default; individual pages/endpoints opt into SSR with
  // `export const prerender = false;`. This is the Astro 5 equivalent of
  // the old "hybrid" mode and lets us keep the content archive fully
  // prerendered while agent API routes + moderation run on the server.
  output: 'static',
  adapter: vercel(),
  integrations: [mdx(), sitemap()],
  // Astro 5 enables `security.checkOrigin` by default. It rejects any
  // POST whose `Origin` header doesn't exactly match the request host,
  // which false-positives when claim links are clicked through email
  // tracker redirects (Brevo, etc.) that strip or rewrite Origin on
  // the way through.
  //
  // We do CSRF defense properly at each surface instead:
  //  - claim form: one-time unguessable 32-byte URL token; possession
  //                of the token already implies authority to claim, so
  //                an Origin check adds nothing.
  //  - admin + dashboard cookies: SameSite=Lax + HMAC-signed, so
  //                browsers refuse to send them on cross-site POSTs.
  //  - /api/insights and other agent APIs: Authorization: Bearer
  //                header (not cookie-based) → not reachable via CSRF.
  security: { checkOrigin: false },
});
