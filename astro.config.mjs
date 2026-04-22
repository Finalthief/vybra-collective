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
});
