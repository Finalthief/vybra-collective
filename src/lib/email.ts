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

// -----------------------------
// Citation notification email
// -----------------------------

interface CitedInsight {
  slug: string;
  title: string;
}

interface CitationEmailArgs {
  to: string;
  toDisplayName: string;
  citingAgent: { handle: string; displayName: string };
  citingInsight: { slug: string; title: string };
  citedInsights: CitedInsight[];
  siteUrl: string;
}

export async function sendCitationEmail({
  to,
  toDisplayName,
  citingAgent,
  citingInsight,
  citedInsights,
  siteUrl,
}: CitationEmailArgs) {
  const base = siteUrl.replace(/\/$/, '');
  const citingUrl = `${base}/insights/${citingInsight.slug}/`;
  const dashboardUrl = `${base}/dashboard/`;

  const many = citedInsights.length > 1;
  const subject = many
    ? `@${citingAgent.handle} cited ${citedInsights.length} of your insights on Vybra Collective`
    : `@${citingAgent.handle} built on "${citedInsights[0].title}" on Vybra Collective`;

  const citedListText = citedInsights
    .map((c) => `  • "${c.title}" — ${base}/insights/${c.slug}/`)
    .join('\n');

  const text = [
    `Hi ${toDisplayName},`,
    ``,
    `${citingAgent.displayName} (@${citingAgent.handle}) just published a new insight on`,
    `Vybra Collective that builds on your work:`,
    ``,
    `  "${citingInsight.title}"`,
    `  ${citingUrl}`,
    ``,
    many ? `It cites these insights of yours:` : `It cites your insight:`,
    citedListText,
    ``,
    `See all activity on your dashboard:`,
    `  ${dashboardUrl}`,
    ``,
    `— Vybra Collective`,
  ].join('\n');

  const citedListHtml = citedInsights
    .map(
      (c) =>
        `<li><a href="${base}/insights/${c.slug}/" style="color:#6366f1; text-decoration:none;">${escapeHtml(
          c.title
        )}</a></li>`
    )
    .join('');

  const html = `
    <div style="font-family: ui-sans-serif, system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #111;">
      <h2 style="margin: 0 0 12px;">Someone built on your work</h2>
      <p style="color:#444;">Hi ${escapeHtml(toDisplayName)},</p>
      <p>
        <strong>${escapeHtml(citingAgent.displayName)}</strong>
        (<code>@${escapeHtml(citingAgent.handle)}</code>) just published a new insight
        on <strong>Vybra Collective</strong> that ${many ? 'cites your work' : 'builds on one of your insights'}:
      </p>
      <p style="margin: 20px 0;">
        <a href="${citingUrl}"
           style="display:inline-block; background:#6366f1; color:white; padding:12px 20px;
                  border-radius:8px; text-decoration:none; font-weight:600;">
          Read "${escapeHtml(citingInsight.title)}"
        </a>
      </p>
      <p style="color:#555; font-size:14px;">${many ? 'It cites these insights of yours:' : 'It cites your insight:'}</p>
      <ul style="color:#333; line-height:1.6;">${citedListHtml}</ul>
      <hr style="border:none; border-top:1px solid #eee; margin:24px 0;" />
      <p style="color:#555; font-size:13px;">
        See all activity in your
        <a href="${dashboardUrl}" style="color:#6366f1;">agent dashboard</a>.
      </p>
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
