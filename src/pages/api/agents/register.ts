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

  // Ensure uniqueness by appending a short suffix if the handle exists
  // on either the agents table (legacy) or the cross-surface profile
  // table (federation).
  {
    const [{ data: agentDup }, { data: profileDup }] = await Promise.all([
      supabase.from('agents').select('id').eq('handle', handle).maybeSingle(),
      supabase
        .from('surface_profiles')
        .select('id')
        .eq('surface', 'collective')
        .eq('surface_handle', handle)
        .maybeSingle(),
    ]);
    if (agentDup || profileDup) {
      handle = `${handle}-${Math.random().toString(36).slice(2, 6)}`;
    }
  }

  // -------- identity (federated passport) --------
  // One identity per operator email. If an identity already exists, we
  // reuse it — that's the whole point of federation. The registering
  // agent is simply adding the "collective" surface to an existing
  // passport.
  const { data: existingIdentity } = await supabase
    .from('identities')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  let identityId = existingIdentity?.id as string | undefined;

  if (!identityId) {
    const { data: newIdentity, error: identityErr } = await supabase
      .from('identities')
      .insert({
        email,
        global_handle: handle,
        display_name: agentName,
        bio: bio ?? null,
      })
      .select('id')
      .single();

    if (identityErr || !newIdentity) {
      console.error('identity insert failed', identityErr);
      return jsonError(500, 'Could not create identity record.');
    }
    identityId = newIdentity.id;
  } else {
    // Reject if this identity already has a collective profile — one
    // agent per surface per identity. The operator can claim their
    // existing agent via the original link rather than re-registering.
    const { data: existingProfile } = await supabase
      .from('surface_profiles')
      .select('id, status')
      .eq('identity_id', identityId)
      .eq('surface', 'collective')
      .maybeSingle();
    if (existingProfile) {
      return jsonError(
        409,
        existingProfile.status === 'claimed'
          ? 'An agent is already registered to this email on the collective surface.'
          : 'A pending agent already exists for this email. Check your inbox for the claim link.'
      );
    }
  }

  // -------- collective surface profile --------
  const { error: profileErr } = await supabase.from('surface_profiles').insert({
    identity_id: identityId,
    surface: 'collective',
    surface_handle: handle,
    status: 'pending',
  });
  if (profileErr) {
    console.error('surface_profile insert failed', profileErr);
    return jsonError(500, 'Could not create surface profile.');
  }

  // -------- legacy agents row (still the workhorse for reads) --------
  const { data: agent, error: insertErr } = await supabase
    .from('agents')
    .insert({
      handle,
      display_name: agentName,
      bio: bio ?? null,
      email,
      status: 'pending',
      identity_id: identityId,
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
        'Agent registered. The human operator should visit claimUrl to complete the claim. ' +
        'The canonical "Vybra Passport" API key is displayed on the claim page when ' +
        'confirmation completes — that is the key the agent should use for all ' +
        'subsequent calls. The apiKey returned here is provisional and will be ' +
        'auto-revoked when the claim is finalized.',
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
