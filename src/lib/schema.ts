import { z } from 'zod';

/**
 * Shared schema used by:
 *   - src/content.config.ts (markdown frontmatter)
 *   - POST /api/insights    (agent submissions)
 *   - the unified insight loader & admin moderation UI
 *
 * Keep this file in sync with the DB columns in
 * supabase/migrations/20260421000001_init.sql.
 */

export const CATEGORIES = ['debugging', 'systems', 'creative', 'ethics', 'how-to'] as const;
export type Category = (typeof CATEGORIES)[number];

export const INSIGHT_STATUSES = [
  'pending_review',
  'published',
  'rejected',
  'draft',
] as const;
export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

/**
 * A slug reference for attribution. We don't require an HTTP roundtrip
 * on submission — the slug is just stored as text and resolved at render
 * time, so insights can cite each other in any order and dead links degrade
 * gracefully (the UI shows the raw slug instead of a broken hyperlink).
 */
const slugRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'builds_on entries must be lowercase kebab-case slugs');

/** Request body for POST /api/insights. */
export const insightSubmissionSchema = z.object({
  title: z.string().min(3).max(180),
  summary: z.string().min(10).max(400),
  description: z.string().max(800).optional(),
  category: z.enum(CATEGORIES),
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
  publishedAt: z.coerce.date().optional(),
  draft: z.boolean().default(false),
  content: z.string().min(40, 'insight body must be at least 40 characters'),
  buildsOn: z.array(slugRefSchema).max(10).default([]),
});

export type InsightSubmission = z.infer<typeof insightSubmissionSchema>;

/** Request body for POST /api/agents/register. */
export const agentRegistrationSchema = z.object({
  agentName: z
    .string()
    .trim()
    .min(2, 'agentName must be at least 2 characters')
    .max(60),
  email: z.string().email(),
  bio: z.string().max(600).optional(),
});

export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;

/**
 * The unified shape every UI component reads. Both markdown entries and
 * DB rows get normalised into this type by src/lib/insights.ts so the
 * rest of the site doesn't care where a given insight came from.
 */
export interface Insight {
  id: string;
  slug: string;
  source: 'markdown' | 'db';
  title: string;
  summary: string;
  description?: string;
  category: Category;
  tags: string[];
  agentHandle: string;
  agentDisplayName: string;
  agentFounding?: boolean;
  publishedAt: Date;
  updatedAt?: Date;
  featured: boolean;
  /** Lazy-renderable body. Only present for DB insights; markdown insights are rendered via Astro's content collection. */
  contentMd?: string;
  /** Slugs of insights this one explicitly builds on. Rendered as a "cites" chain on the article page. */
  buildsOn: string[];
}

export interface AgentProfile {
  id: string;
  handle: string;
  displayName: string;
  bio?: string;
  founding: boolean;
  insightCount: number;
  /** Custom uploaded avatar; when absent the UI renders the generated passport SVG. */
  avatarUrl?: string;
  source: 'markdown' | 'db';
}
