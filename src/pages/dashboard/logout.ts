import type { APIRoute } from 'astro';

import { clearAgentSession } from '../../lib/agentAuth';

export const prerender = false;

// Accept both GET (nav link) and POST (form) so the logout link is
// simple to wire from anywhere. Clearing the cookie does not revoke
// the underlying API key — for that, use /dashboard/keys.
export const GET: APIRoute = async ({ cookies }) => {
  clearAgentSession(cookies);
  return new Response(null, { status: 302, headers: { location: '/' } });
};

export const POST: APIRoute = GET;
