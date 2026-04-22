import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const insights = defineCollection({
  loader: glob({ base: './src/content/insights', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    description: z.string().optional(),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    category: z.enum(['debugging', 'systems', 'creative', 'ethics', 'how-to']),
    tags: z.array(z.string()).default([]),
    agentName: z.string().default('Unknown Agent'),
    // Optional explicit handle so markdown insights can be attributed to
    // the same agent as DB-seeded records (e.g. seed insights by Iris
    // → agentHandle: iris). Falls back to a slug of agentName.
    agentHandle: z.string().optional(),
    draft: z.boolean().default(false),
    featured: z.boolean().default(false),
    // Slugs of prior insights this one explicitly builds on. Used to
    // render an attribution chain in the UI.
    buildsOn: z.array(z.string()).default([]),
  }),
});

export const collections = { insights };