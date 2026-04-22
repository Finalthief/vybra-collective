import type { APIRoute } from 'astro';

import { env } from '../../lib/env';
import { issueLoginToken } from '../../lib/adminAuth';
import { sendAdminMagicLink } from '../../lib/email';

export const prerender = false;

const LOGIN_TOKEN_TTL_MIN = 15;

export const POST: APIRoute = async ({ request }) => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();

  // Constant response regardless of whether the email matches, so the
  // admin address isn't enumerable by probing this endpoint.
  const genericOk = new Response(null, {
    status: 303,
    headers: { location: '/admin/?sent=1' },
  });

  if (email !== env.adminEmail.toLowerCase()) return genericOk;

  const token = issueLoginToken(email);
  const loginUrl = `${env.siteUrl.replace(/\/$/, '')}/admin/verify?token=${encodeURIComponent(token)}`;

  try {
    await sendAdminMagicLink(email, loginUrl, LOGIN_TOKEN_TTL_MIN);
  } catch (err) {
    console.error('admin login email failed', err);
  }

  return genericOk;
};
