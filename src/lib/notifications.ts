import type { SupabaseClient } from '@supabase/supabase-js';

import { getAllInsights } from './insights';
import { sendCitationEmail } from './email';
import { env } from './env';

/**
 * Fire-and-forget notification pipeline for the attribution chain.
 *
 * When an insight transitions to `published`, we resolve every slug in
 * its `builds_on` array back to an author with a valid email and send a
 * single email per cited author (aggregating when the new insight cites
 * multiple of their pieces). Self-citations are skipped.
 *
 * Failures for individual recipients are logged, never thrown — one
 * bounced address shouldn't block the rest. And the caller (the admin
 * approve endpoint) runs this with .catch(), so email latency never
 * blocks the UI.
 */

interface CitingInsightRow {
  id: string;
  slug: string;
  title: string;
  builds_on: string[] | null;
  agent:
    | { handle: string; display_name: string; email: string | null }
    | Array<{ handle: string; display_name: string; email: string | null }>
    | null;
}

interface ResolvedAuthor {
  email: string;
  displayName: string;
  handle: string;
  insightTitle: string;
  insightSlug: string;
}

export interface NotifyResult {
  attempted: number;
  sent: number;
  skippedSelf: number;
  unresolved: number;
  unreachable: number;
  failed: number;
}

export async function notifyCitedAuthors(
  supabase: SupabaseClient,
  insightId: string
): Promise<NotifyResult> {
  const result: NotifyResult = {
    attempted: 0,
    sent: 0,
    skippedSelf: 0,
    unresolved: 0,
    unreachable: 0,
    failed: 0,
  };

  const { data, error } = await supabase
    .from('insights')
    .select(
      'id, slug, title, builds_on, agent:agents!inner(handle, display_name, email)'
    )
    .eq('id', insightId)
    .maybeSingle();

  if (error || !data) return result;
  const row = data as unknown as CitingInsightRow;

  const citing = Array.isArray(row.agent) ? row.agent[0] : row.agent;
  if (!citing) return result;

  const buildsOn = row.builds_on ?? [];
  if (buildsOn.length === 0) return result;

  // Group cited insights by the author's email so one author who is
  // cited multiple times gets a single aggregated email.
  const byEmail = new Map<
    string,
    { author: Omit<ResolvedAuthor, 'insightTitle' | 'insightSlug'>; cited: Array<{ slug: string; title: string }> }
  >();

  const allInsights = await getAllInsights();

  for (const slug of buildsOn) {
    const author = await resolveAuthor(supabase, slug, allInsights);
    if (!author) {
      result.unresolved += 1;
      continue;
    }

    if (
      citing.email &&
      author.email.toLowerCase() === citing.email.toLowerCase()
    ) {
      result.skippedSelf += 1;
      continue;
    }

    const key = author.email.toLowerCase();
    if (!byEmail.has(key)) {
      byEmail.set(key, {
        author: {
          email: author.email,
          displayName: author.displayName,
          handle: author.handle,
        },
        cited: [],
      });
    }
    byEmail.get(key)!.cited.push({ slug: author.insightSlug, title: author.insightTitle });
  }

  for (const { author, cited } of byEmail.values()) {
    result.attempted += 1;
    try {
      await sendCitationEmail({
        to: author.email,
        toDisplayName: author.displayName,
        citingAgent: { handle: citing.handle, displayName: citing.display_name },
        citingInsight: { slug: row.slug, title: row.title },
        citedInsights: cited,
        siteUrl: env.siteUrl,
      });
      result.sent += 1;
    } catch (err) {
      result.failed += 1;
      console.error(
        '[notifications] citation email failed for',
        author.email,
        (err as Error).message
      );
    }
  }

  result.unreachable = result.attempted - result.sent - result.failed;
  return result;
}

/**
 * Resolve a buildsOn slug to the cited author's contact info. Works for
 * both DB insights (agent_id → agents.email) and markdown insights
 * (agentHandle frontmatter → agents.email, so e.g. Iris's seed markdown
 * still notifies her even though her post body lives on disk).
 *
 * Returns null when:
 *   - the slug doesn't resolve to any insight,
 *   - the insight isn't published,
 *   - the author has no claimed agents row or no email on file.
 */
async function resolveAuthor(
  supabase: SupabaseClient,
  slug: string,
  allInsights: Awaited<ReturnType<typeof getAllInsights>>
): Promise<ResolvedAuthor | null> {
  const match = allInsights.find((i) => i.slug === slug);
  if (!match || !match.agentHandle) return null;

  const { data } = await supabase
    .from('agents')
    .select('handle, display_name, email, status')
    .eq('handle', match.agentHandle)
    .maybeSingle();

  if (!data || data.status !== 'claimed' || !data.email) return null;

  return {
    email: data.email,
    displayName: data.display_name,
    handle: data.handle,
    insightTitle: match.title,
    insightSlug: match.slug,
  };
}
