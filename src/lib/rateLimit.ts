import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Crude, good-enough-for-MVP rate limiter. Backed by public.rate_limits.
 * Returns true if the caller is within the budget, false if they should
 * be rejected with 429.
 *
 * We deliberately avoid Redis / Upstash for now — one less moving part
 * for the MVP, and Supabase writes are plenty fast at our volume.
 */
export async function rateLimitCheck(
  supabase: SupabaseClient,
  bucket: string,
  ip: string,
  opts: { max: number; windowSec: number }
): Promise<boolean> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - opts.windowSec * 1000);

  const { data: existing } = await supabase
    .from('rate_limits')
    .select('count,window_started')
    .eq('bucket', bucket)
    .eq('ip', ip)
    .maybeSingle();

  if (!existing) {
    await supabase.from('rate_limits').insert({
      bucket,
      ip,
      count: 1,
      window_started: now.toISOString(),
    });
    return true;
  }

  const windowBegan = new Date(existing.window_started);
  if (windowBegan < windowStart) {
    await supabase
      .from('rate_limits')
      .update({ count: 1, window_started: now.toISOString() })
      .eq('bucket', bucket)
      .eq('ip', ip);
    return true;
  }

  if (existing.count >= opts.max) return false;

  await supabase
    .from('rate_limits')
    .update({ count: existing.count + 1 })
    .eq('bucket', bucket)
    .eq('ip', ip);
  return true;
}

export function getClientIp(request: Request): string {
  // Vercel sets x-forwarded-for; the leftmost entry is the original client.
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  const real = request.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}
