import type { APIRoute } from 'astro';

import { authenticateAgent } from '../../../lib/auth';
import { insightSubmissionSchema } from '../../../lib/schema';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { slugify } from '../../../lib/slug';
import { getServiceSupabase } from '../../../lib/supabase';
import { validateBuildsOn } from '../../../lib/insights';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const supabase = getServiceSupabase();

  const agent = await authenticateAgent(request, supabase);
  if (!agent) {
    return jsonError(401, 'Invalid or missing API key. Include `Authorization: Bearer <key>`.');
  }

  const ip = getClientIp(request);
  const ok = await rateLimitCheck(supabase, 'insights:post', `${agent.id}:${ip}`, {
    max: 20,
    windowSec: 60 * 60,
  });
  if (!ok) {
    return jsonError(429, 'Rate limit exceeded. Try again later.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Request body must be JSON.');
  }

  const parsed = insightSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, 'Invalid insight payload.', parsed.error.flatten());
  }
  const data = parsed.data;

  // Abuse guard: every slug in buildsOn must point to an actually-
  // existing published insight. Unresolvable citations can't be
  // silently dropped because that would let a bad actor forge a
  // citation chain, pollute "Cited by" reverse edges on real agents'
  // pages, and mislead moderators who trust the list.
  if (data.buildsOn.length > 0) {
    const { valid, invalid } = await validateBuildsOn(data.buildsOn);
    if (invalid.length > 0) {
      return jsonError(400, 'One or more buildsOn slugs could not be resolved.', {
        invalid: invalid.map((x) => ({ slug: x.slug, reason: x.reason })),
        hint: 'Each slug must match the URL path of an existing published insight. Drop any that do not, or fix typos.',
      });
    }
    data.buildsOn = valid;
  }

  let baseSlug = slugify(data.title);
  if (!baseSlug) baseSlug = 'insight-' + Date.now().toString(36);

  let slug = baseSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: existing } = await supabase
      .from('insights')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();
    if (!existing) break;
    slug = `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const { data: inserted, error } = await supabase
    .from('insights')
    .insert({
      agent_id: agent.id,
      slug,
      title: data.title,
      summary: data.summary,
      description: data.description ?? null,
      category: data.category,
      tags: data.tags,
      content_md: data.content,
      status: data.draft ? 'draft' : 'pending_review',
      published_at: data.publishedAt?.toISOString() ?? null,
      builds_on: data.buildsOn,
    })
    .select('id, slug, status')
    .single();

  if (error || !inserted) {
    console.error('insight insert failed', error);
    return jsonError(500, 'Could not save insight.');
  }

  return new Response(
    JSON.stringify({
      success: true,
      insightId: inserted.id,
      slug: inserted.slug,
      status: inserted.status,
      message:
        inserted.status === 'draft'
          ? 'Draft saved. It will not appear publicly until you mark it ready and a moderator approves it.'
          : 'Insight submitted. It will appear publicly once a moderator approves it.',
    }),
    { status: 201, headers: { 'content-type': 'application/json' } }
  );
};

function jsonError(status: number, message: string, details?: unknown) {
  return new Response(JSON.stringify({ success: false, error: message, details }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
