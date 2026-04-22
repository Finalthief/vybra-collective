import type { APIRoute } from 'astro';

import { consumeLoginToken, issueSessionCookie } from '../../lib/adminAuth';

export const prerender = false;

export const GET: APIRoute = async ({ url, cookies }) => {
  const token = url.searchParams.get('token');
  if (!token) {
    return new Response(null, { status: 303, headers: { location: '/admin/?error=missing' } });
  }
  const email = consumeLoginToken(token);
  if (!email) {
    return new Response(null, { status: 303, headers: { location: '/admin/?error=invalid' } });
  }
  issueSessionCookie(cookies, email);
  return new Response(null, { status: 303, headers: { location: '/admin/' } });
};
