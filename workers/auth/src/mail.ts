/**
 * Account emails (verify address, reset password) through Resend. Optional:
 * without RESEND_API_KEY and AUTH_FROM_EMAIL, email + password still works,
 * just without verification or "Forgot password?".
 */
export interface MailEnv {
  RESEND_API_KEY?: string;
  /** A sender on a domain verified in Resend, e.g. "WorldMesh <accounts@worldmesh.net>". */
  AUTH_FROM_EMAIL?: string;
}

export function mailConfigured(env: MailEnv): boolean {
  return !!(env.RESEND_API_KEY && env.AUTH_FROM_EMAIL);
}

/** One email with a single button. `footer` is the small print, or null for none. */
export async function sendMail(
  env: MailEnv,
  to: string,
  subject: string,
  intro: string,
  action: string,
  url: string,
  footer: string | null = "If this wasn't you, you can ignore this email.",
) {
  const safeUrl = escapeHtml(url);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to,
      subject,
      text: `${intro}\n\n${action}: ${url}${footer ? `\n\n${footer}` : ''}`,
      html: `<p>${escapeHtml(intro)}</p><p><a href="${safeUrl}">${escapeHtml(action)}</a></p>${footer ? `<p style="color:#777">${escapeHtml(footer)}</p>` : ''}`,
    }),
  });
  if (!response.ok) console.error('resend error', response.status, await response.text());
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
