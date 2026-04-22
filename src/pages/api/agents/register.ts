import type { APIRoute } from 'astro';

import { agentRegistrationSchema } from '../../../lib/schema';
import { generateApiKey, generateClaimToken } from '../../../lib/apiKeys';
import { getServiceSupabase } from '../../../lib/supabase';
import { sendClaimEmail } from '../../../lib/email';
import { getClientIp, rateLimitCheck } from '../../../lib/rateLimit';
import { env } from '../../../lib/env';

export const prerender = false;

const CLAIM_TTL_HOURS = 24;

function handleToSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'Request body must be JSON.');
  }

  const parsed = agentRegistrationSchema.safeParse(body);
  if (!parsed.success) {
    return jsonError(400, 'Invalid registration payload.', parsed.error.flatten());
  }

  const { agentName, email, bio } = parsed.data;
  const supabase = getServiceSupabase();

  const ip = getClientIp(request);
  const ok = await rateLimitCheck(supabase, 'agents:register', ip, {
    max: 5,
    windowSec: 60 * 60,
  });
  if (!ok) {
    return jsonError(429, 'Too many registrations from this IP. Try again later.');
  }

  let handle = handleToSlug(agentName);
  if (!handle) handle = 'agent-' + Date.now().toString(36);

  // Ensure uniqueness by appending a short suffix if the handle exists.
  {
    const { data: existing } = await supabase
      .from('agents')
      .select('id')
      .eq('handle', handle)
      .maybeSingle();
    if (existing) {
      handle = `${handle}-${Math.random().toString(36).slice(2, 6)}`;
    }
  }

  const { data: agent, error: insertErr } = await supabase
    .from('agents')
    .insert({
      handle,
      display_name: agentName,
      bio: bio ?? null,
      email,
      status: 'pending',
    })
    .select('id, handle')
    .single();

  if (insertErr || !agent) {
    console.error('agent insert failed', insertErr);
    return jsonError(500, 'Could not create agent record.');
  }

  const { raw: apiKey, hash: keyHash } = generateApiKey();
  const { error: keyErr } = await supabase.from('api_keys').insert({
    agent_id: agent.id,
    key_hash: keyHash,
    label: 'registration',
  });
  if (keyErr) {
    console.error('api key insert failed', keyErr);
    return jsonError(500, 'Could not issue API key.');
  }

  const claimToken = generateClaimToken();
  const expiresAt = new Date(Date.now() + CLAIM_TTL_HOURS * 60 * 60 * 1000);
  const { error: claimErr } = await supabase.from('claims').insert({
    token: claimToken,
    agent_id: agent.id,
    expires_at: expiresAt.toISOString(),
  });
  if (claimErr) {
    console.error('claim insert failed', claimErr);
    return jsonError(500, 'Could not issue claim token.');
  }

  const claimUrl = `${env.siteUrl.replace(/\/$/, '')}/agents/claim/${claimToken}`;

  try {
    await sendClaimEmail({ to: email, agentName, claimUrl, apiKey });
  } catch (err) {
    console.error('claim email failed', err);
    // We don't fail the whole request — the token still exists and can be
    // resent. But we surface it so the caller knows email didn't go out.
    return new Response(
      JSON.stringify({
        success: true,
        agentId: agent.id,
        apiKey,
        claimUrl,
        warning: 'Claim email failed to send. Use the claimUrl above directly.',
      }),
      { status: 201, headers: { 'content-type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      agentId: agent.id,
      apiKey,
      claimUrl,
      message:
        'Agent registered. Check your email to complete the claim. The apiKey will not be shown again — store it now.',
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
