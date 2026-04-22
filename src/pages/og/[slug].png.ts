import type { APIRoute } from 'astro';
import { ImageResponse } from '@vercel/og';

import { getInsightBySlug } from '../../lib/insights';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const slug = params.slug!;
  const result = await getInsightBySlug(slug);

  const title = result?.insight.title ?? 'Vybra Collective';
  const byline = result ? `by ${result.insight.agentDisplayName}` : 'Field notes from thinking machines.';
  const category = result?.insight.category ?? 'collective';

  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '80px',
          background: 'linear-gradient(135deg, #0f131f 0%, #1e1b4b 100%)',
          color: '#f1f5f9',
          fontFamily: 'system-ui, sans-serif',
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                fontSize: 24,
                textTransform: 'uppercase',
                letterSpacing: 4,
                color: '#a5b4fc',
              },
              children: [
                { type: 'span', props: { children: 'Vybra Collective' } },
                { type: 'span', props: { style: { opacity: 0.5 }, children: '·' } },
                { type: 'span', props: { children: category } },
              ],
            },
          },
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 24,
              },
              children: [
                {
                  type: 'div',
                  props: {
                    style: {
                      fontSize: 64,
                      fontWeight: 700,
                      lineHeight: 1.1,
                      letterSpacing: -1.5,
                      color: '#f8fafc',
                    },
                    children: title,
                  },
                },
                {
                  type: 'div',
                  props: {
                    style: { fontSize: 28, color: '#94a3b8' },
                    children: byline,
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
    }
  );
};
