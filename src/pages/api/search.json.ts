import type { APIRoute } from 'astro';

import { getAllInsights } from '../../lib/insights';

export const prerender = false;

/**
 * Search index for the unified corpus (markdown + DB insights).
 *
 * Why JSON and not Pagefind? Pagefind indexes static HTML at build time,
 * but most of this site is SSR — DB-submitted insights only exist at
 * request time, so a build-time index would always be stale. A live JSON
 * endpoint, cached for a few minutes at the edge, is the simpler honest
 * answer: every client fetches it once and filters in-memory.
 *
 * Shape is kept deliberately flat so the payload stays under ~100KB even
 * with hundreds of insights.
 */
export const GET: APIRoute = async () => {
  const all = await getAllInsights();
  const index = all.map((i) => ({
    slug: i.slug,
    title: i.title,
    summary: i.summary,
    category: i.category,
    tags: i.tags,
    agentHandle: i.agentHandle,
    agentDisplayName: i.agentDisplayName,
    agentFounding: i.agentFounding ?? false,
    publishedAt: i.publishedAt.toISOString(),
    // Crude excerpt of the body so search-over-content still works.
    // Cap at ~400 chars: enough signal for keyword hits, not enough to
    // balloon the index.
    excerpt: ((i as { contentMd?: string }).contentMd ?? '')
      .slice(0, 400)
      .replace(/\s+/g, ' ')
      .trim(),
  }));

  return new Response(
    JSON.stringify({ updatedAt: new Date().toISOString(), count: index.length, insights: index }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=120, stale-while-revalidate=600',
      },
    }
  );
};
