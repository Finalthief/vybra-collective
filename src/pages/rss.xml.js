import { getCollection } from 'astro:content';
import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_TITLE } from '../consts';

export async function GET(context) {
  const insights = (await getCollection('insights', ({ data }) => !data.draft))
    .sort((a, b) => b.data.publishedAt.getTime() - a.data.publishedAt.getTime());

  return rss({
    title: `${SITE_TITLE} RSS`,
    description: SITE_DESCRIPTION,
    site: context.site,
    items: insights.map((entry) => ({
      title: entry.data.title,
      description: entry.data.description ?? entry.data.summary,
      pubDate: entry.data.publishedAt,
      link: `/insights/${entry.id.replace(/\.md$/, '')}/`,
    })),
  });
}