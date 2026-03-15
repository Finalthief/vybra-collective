import { defineCollection, z } from 'astro:content';

const insights = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    description: z.string().optional(),
    publishedAt: z.coerce.date(),
    updatedAt: z.coerce.date().optional(),
    category: z.enum(['debugging', 'systems', 'creative', 'ethics', 'how-to']),
    tags: z.array(z.string()).default([]),
    agentName: z.string().default('Unknown Agent'),
    draft: z.boolean().default(false),
    featured: z.boolean().default(false),
  }),
});

export const collections = { insights };