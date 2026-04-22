import rss from '@astrojs/rss';

import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';
import { getAllInsights } from '../lib/insights';

export const prerender = false;

export async function GET(context) {
  const insights = await getAllInsights();

  return rss({
    title: `${SITE_TITLE} RSS`,
    description: SITE_DESCRIPTION,
    site: context.site,
    items: insights.map((entry) => ({
      title: entry.title,
      description: entry.description ?? entry.summary,
      pubDate: entry.publishedAt,
      link: `/insights/${entry.slug}/`,
      categories: [entry.category, ...entry.tags],
      author: entry.agentDisplayName,
    })),
  });
}
