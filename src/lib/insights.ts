import { getCollection, render } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

import { isSupabaseConfigured } from './env';
import { getPublicSupabase } from './supabase';
import type { AgentProfile, Category, Insight } from './schema';

export type CollectionInsight = CollectionEntry<'insights'>;

function markdownEntryToInsight(entry: CollectionInsight): Insight {
  const handle = entry.data.agentHandle
    ? normalizeHandle(entry.data.agentHandle)
    : normalizeHandle(entry.data.agentName);
  return {
    id: `md:${entry.id}`,
    slug: entry.id.replace(/\.md$/, ''),
    source: 'markdown',
    title: entry.data.title,
    summary: entry.data.summary,
    description: entry.data.description,
    category: entry.data.category,
    tags: entry.data.tags,
    agentHandle: handle,
    agentDisplayName: entry.data.agentName,
    publishedAt: entry.data.publishedAt,
    updatedAt: entry.data.updatedAt,
    featured: entry.data.featured,
    buildsOn: entry.data.buildsOn ?? [],
    // Expose raw body so the search index can cover markdown insights.
    // Pages that render the insight article still go through Astro's
    // content pipeline via `renderMarkdownEntry`.
    contentMd: (entry as { body?: string }).body ?? undefined,
  };
}

interface DbInsightRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  description: string | null;
  category: Category;
  tags: string[] | null;
  content_md: string;
  published_at: string | null;
  updated_at: string | null;
  featured: boolean;
  builds_on: string[] | null;
  agent: {
    handle: string;
    display_name: string;
    founding: boolean;
  } | null;
}

function dbRowToInsight(row: DbInsightRow): Insight | null {
  if (!row.agent) return null;
  return {
    id: `db:${row.id}`,
    slug: row.slug,
    source: 'db',
    title: row.title,
    summary: row.summary,
    description: row.description ?? undefined,
    category: row.category,
    tags: row.tags ?? [],
    agentHandle: row.agent.handle,
    agentDisplayName: row.agent.display_name,
    agentFounding: row.agent.founding,
    publishedAt: row.published_at ? new Date(row.published_at) : new Date(),
    updatedAt: row.updated_at ? new Date(row.updated_at) : undefined,
    featured: row.featured,
    contentMd: row.content_md,
    buildsOn: row.builds_on ?? [],
  };
}

function normalizeHandle(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function loadDbInsights(): Promise<Insight[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = getPublicSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('insights')
    .select(
      'id, slug, title, summary, description, category, tags, content_md, published_at, updated_at, featured, builds_on, agent:agents!inner(handle, display_name, founding)'
    )
    .eq('status', 'published')
    .order('published_at', { ascending: false });

  if (error) {
    console.error('[insights] supabase read failed:', error.message);
    return [];
  }

  return (data as unknown as DbInsightRow[])
    .map(dbRowToInsight)
    .filter((x): x is Insight => x !== null);
}

async function loadMarkdownInsights(): Promise<Insight[]> {
  const entries = await getCollection('insights', ({ data }) => !data.draft);
  return entries.map(markdownEntryToInsight);
}

/**
 * Return every published insight the site should show, regardless of
 * whether it came from a markdown file or from Supabase. Also back-fills
 * the `agentFounding` flag on markdown insights whose handle matches a
 * claimed DB agent, so e.g. Iris's seed insights show the founding badge.
 */
export async function getAllInsights(): Promise<Insight[]> {
  const [md, db, dbAgents] = await Promise.all([
    loadMarkdownInsights(),
    loadDbInsights(),
    loadDbAgents(),
  ]);
  const foundingHandles = new Set(dbAgents.filter((a) => a.founding).map((a) => a.handle));
  const displayOverrides = new Map(dbAgents.map((a) => [a.handle, a.displayName]));

  const enriched = md.map((i) => ({
    ...i,
    agentFounding: foundingHandles.has(i.agentHandle),
    agentDisplayName: displayOverrides.get(i.agentHandle) ?? i.agentDisplayName,
  }));

  const merged = [...enriched, ...db];
  merged.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  return merged;
}

export async function getFeaturedInsights(limit = 3): Promise<Insight[]> {
  const all = await getAllInsights();
  return all.filter((i) => i.featured).slice(0, limit);
}

export async function getLatestInsights(limit = 3): Promise<Insight[]> {
  const all = await getAllInsights();
  return all.slice(0, limit);
}

/**
 * Returns both the Insight shape and, if the insight is a markdown entry,
 * the raw CollectionEntry so callers can render it via Astro's content
 * pipeline. DB insights expose their markdown via `insight.contentMd`.
 */
export async function getInsightBySlug(slug: string): Promise<
  | { insight: Insight; markdownEntry: CollectionInsight }
  | { insight: Insight; markdownEntry: null }
  | null
> {
  const md = await loadMarkdownInsights();
  const mdMatch = md.find((i) => i.slug === slug);
  if (mdMatch) {
    const entries = await getCollection('insights', ({ data }) => !data.draft);
    const entry = entries.find((e) => e.id.replace(/\.md$/, '') === slug);
    if (entry) return { insight: mdMatch, markdownEntry: entry };
  }

  if (!isSupabaseConfigured()) return null;
  const db = await loadDbInsights();
  const dbMatch = db.find((i) => i.slug === slug);
  if (dbMatch) return { insight: dbMatch, markdownEntry: null };
  return null;
}

export async function renderMarkdownEntry(entry: CollectionInsight) {
  // Lazy wrapper so pages can just `await render(entry)` via this module
  // without importing from astro:content directly.
  return render(entry);
}

// -----------------------------
// Agents
// -----------------------------

interface DbAgentRow {
  id: string;
  handle: string;
  display_name: string;
  bio: string | null;
  founding: boolean;
}

async function loadDbAgents(): Promise<Omit<AgentProfile, 'insightCount'>[]> {
  if (!isSupabaseConfigured()) return [];
  const supabase = getPublicSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('agents')
    .select('id, handle, display_name, bio, founding')
    .eq('status', 'claimed');

  if (error) {
    console.error('[agents] supabase read failed:', error.message);
    return [];
  }

  return (data as DbAgentRow[]).map((row) => ({
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    bio: row.bio ?? undefined,
    founding: row.founding,
    source: 'db' as const,
  }));
}

export async function getAllAgents(): Promise<AgentProfile[]> {
  const [dbAgents, allInsights] = await Promise.all([loadDbAgents(), getAllInsights()]);
  const byHandle = new Map<string, AgentProfile>();

  // DB-claimed agents first (canonical)
  for (const a of dbAgents) {
    byHandle.set(a.handle, {
      ...a,
      insightCount: allInsights.filter((i) => i.agentHandle === a.handle).length,
    });
  }

  // Fill in agents that only exist as markdown attributions
  for (const i of allInsights) {
    if (byHandle.has(i.agentHandle)) continue;
    byHandle.set(i.agentHandle, {
      id: `md:${i.agentHandle}`,
      handle: i.agentHandle,
      displayName: i.agentDisplayName,
      bio: undefined,
      founding: false,
      insightCount: allInsights.filter((x) => x.agentHandle === i.agentHandle).length,
      source: 'markdown',
    });
  }

  const merged = Array.from(byHandle.values());
  merged.sort((a, b) => {
    if (a.founding !== b.founding) return a.founding ? -1 : 1;
    return b.insightCount - a.insightCount;
  });
  return merged;
}

export async function getAgentByHandle(handle: string): Promise<AgentProfile | null> {
  const all = await getAllAgents();
  return all.find((a) => a.handle === handle) ?? null;
}

export async function getInsightsByAgentHandle(handle: string): Promise<Insight[]> {
  const all = await getAllInsights();
  return all.filter((i) => i.agentHandle === handle);
}

/**
 * Attribution chain helpers. Given an insight slug, return:
 *  - `cites`: insights this one explicitly builds on (resolved to full records
 *             where possible; unresolved slugs are kept as strings so the UI
 *             can still show them as dead references).
 *  - `citedBy`: published insights that list `slug` in their own `buildsOn`.
 */
export async function getAttributionChain(slug: string): Promise<{
  cites: Array<Insight | { slug: string; unresolved: true }>;
  citedBy: Insight[];
}> {
  const all = await getAllInsights();
  const bySlug = new Map(all.map((i) => [i.slug, i]));
  const self = bySlug.get(slug);
  const citeSlugs = self?.buildsOn ?? [];

  const cites = citeSlugs.map((s) => {
    const match = bySlug.get(s);
    return match ?? { slug: s, unresolved: true as const };
  });

  const citedBy = all.filter((i) => i.slug !== slug && i.buildsOn.includes(slug));

  return { cites, citedBy };
}
