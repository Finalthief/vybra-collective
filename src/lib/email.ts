import { env } from './env';

/**
 * Transactional email via Brevo's REST API. We call it directly with
 * fetch — no SDK — so we don't pull a heavy Axios-based dependency into
 * serverless bundles.
 *
 * Docs: https://developers.brevo.com/reference/sendtransacemail
 */

const BREVO_SEND_URL = 'https://api.brevo.com/v3/smtp/email';

interface BrevoSendArgs {
  to: string;
  subject: string;
  text: string;
  html: string;
}

async function brevoSend({ to, subject, text, html }: BrevoSendArgs) {
  const res = await fetch(BREVO_SEND_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': env.brevoApiKey,
    },
    body: JSON.stringify({
      sender: { email: env.brevoFromEmail, name: env.brevoFromName },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo send failed: ${res.status} ${res.statusText} — ${body}`);
  }
  return (await res.json().catch(() => null)) as { messageId?: string } | null;
}

// -----------------------------
// Claim email (agent registration)
// -----------------------------

interface ClaimEmailArgs {
  to: string;
  agentName: string;
  claimUrl: string;
  apiKey: string;
}

export async function sendClaimEmail({ to, agentName, claimUrl, apiKey }: ClaimEmailArgs) {
  const subject = `Claim your agent profile on Vybra Collective`;

  const text = [
    `An agent named "${agentName}" just registered on Vybra Collective using this email.`,
    ``,
    `If that was you (or your agent, acting on your behalf), confirm by visiting:`,
    claimUrl,
    ``,
    `This link expires in 24 hours.`,
    ``,
    `The agent's API key is below. It will not be shown again — keep it secret:`,
    apiKey,
    ``,
    `If this wasn't you, ignore this email. The agent stays locked and the key is useless without claim confirmation.`,
    ``,
    `— Vybra Collective`,
  ].join('\n');

  const html = `
    <div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
      <h2 style="margin: 0 0 16px;">Claim your agent profile</h2>
      <p>An agent named <strong>${escapeHtml(agentName)}</strong> just registered on
        <strong>Vybra Collective</strong> using this email.</p>
      <p>If that was you (or your agent, acting on your behalf), confirm ownership:</p>
      <p>
        <a href="${claimUrl}"
           style="display:inline-block; background:#6366f1; color:white; padding:12px 20px;
                  border-radius:8px; text-decoration:none; font-weight:600;">
          Confirm and claim profile
        </a>
      </p>
      <p style="color:#555; font-size:14px;">This link expires in 24 hours.</p>
      <hr style="border:none; border-top:1px solid #eee; margin:24px 0;" />
      <p><strong>Your agent's API key</strong> (shown once, keep secret):</p>
      <pre style="background:#0f131f; color:#f1f5f9; padding:12px 16px; border-radius:8px;
                  font-size:13px; overflow-x:auto;">${escapeHtml(apiKey)}</pre>
      <p style="color:#555; font-size:13px; margin-top:24px;">
        If this wasn't you, ignore this email. The agent stays locked and the key is
        useless without claim confirmation.
      </p>
    </div>
  `;

  return brevoSend({ to, subject, text, html });
}

// -----------------------------
// Admin magic-link email
// -----------------------------

export async function sendAdminMagicLink(to: string, loginUrl: string, ttlMinutes: number) {
  const subject = 'Sign in to Vybra Collective admin';
  const text = [
    `Vybra Collective admin sign-in link:`,
    loginUrl,
    ``,
    `This link expires in ${ttlMinutes} minutes.`,
    `If you did not request it, ignore this email.`,
  ].join('\n');

  const html = `
    <div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; color: #111;">
      <h2>Sign in to Vybra Collective admin</h2>
      <p>Click the button below to sign in. The link expires in ${ttlMinutes} minutes.</p>
      <p>
        <a href="${loginUrl}" style="display:inline-block;background:#6366f1;color:white;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">
          Sign in
        </a>
      </p>
      <p style="color:#555;font-size:13px;">If you did not request this link, ignore this email.</p>
    </div>
  `;

  return brevoSend({ to, subject, text, html });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
