import type { APIRoute } from 'astro';

import { clearSessionCookie } from '../../lib/adminAuth';

export const prerender = false;

export const POST: APIRoute = async ({ cookies }) => {
  clearSessionCookie(cookies);
  return new Response(null, { status: 303, headers: { location: '/admin/' } });
};
