import type { APIRoute } from 'astro';

import { requireAdmin } from '../../../../lib/adminAuth';
import { getServiceSupabase } from '../../../../lib/supabase';
import { CATEGORIES } from '../../../../lib/schema';

export const prerender = false;

/**
 * Handles moderation actions on a single insight. Uses form POSTs (not
 * JSON) so the admin UI can submit via a plain <form>. The `action`
 * field chooses between save / approve / reject; all three also carry
 * the edited fields so an approve-with-edits is a single round trip.
 */
export const POST: APIRoute = async (ctx) => {
  const session = requireAdmin(ctx);
  const { request, params } = ctx;
  const id = params.id!;

  const form = await request.formData();
  const action = String(form.get('action') ?? 'save');
  const title = String(form.get('title') ?? '').trim();
  const summary = String(form.get('summary') ?? '').trim();
  const description = String(form.get('description') ?? '').trim();
  const category = String(form.get('category') ?? '').trim();
  const tagsRaw = String(form.get('tags') ?? '');
  const buildsOnRaw = String(form.get('builds_on') ?? '');
  const contentMd = String(form.get('content_md') ?? '').trim();

  if (!title || !summary || !contentMd) {
    return redirectWithError(id, 'Title, summary, and content are required.');
  }
  if (!CATEGORIES.includes(category as (typeof CATEGORIES)[number])) {
    return redirectWithError(id, 'Invalid category.');
  }

  const tags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12);

  const buildsOn = buildsOnRaw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9][a-z0-9-]*$/.test(s))
    .slice(0, 10);

  const supabase = getServiceSupabase();

  const updatePayload: Record<string, unknown> = {
    title,
    summary,
    description: description || null,
    category,
    tags,
    builds_on: buildsOn,
    content_md: contentMd,
  };

  if (action === 'approve') {
    updatePayload.status = 'published';
    updatePayload.published_at = new Date().toISOString();
  } else if (action === 'reject') {
    updatePayload.status = 'rejected';
  }

  const { error } = await supabase.from('insights').update(updatePayload).eq('id', id);
  if (error) {
    console.error('admin update failed', error);
    return redirectWithError(id, 'Database update failed: ' + error.message);
  }

  await supabase.from('moderation_log').insert({
    insight_id: id,
    actor_email: session.email,
    action,
    notes: null,
  });

  if (action === 'approve') {
    // After publish, bounce to the live article.
    const { data } = await supabase.from('insights').select('slug').eq('id', id).maybeSingle();
    return new Response(null, {
      status: 303,
      headers: { location: data ? `/insights/${data.slug}/` : '/admin/' },
    });
  }
  if (action === 'reject') {
    return new Response(null, { status: 303, headers: { location: '/admin/' } });
  }
  return new Response(null, {
    status: 303,
    headers: { location: `/admin/insight/${id}/?saved=1` },
  });
};

function redirectWithError(id: string, msg: string) {
  return new Response(null, {
    status: 303,
    headers: {
      location: `/admin/insight/${id}/?error=${encodeURIComponent(msg)}`,
    },
  });
}
