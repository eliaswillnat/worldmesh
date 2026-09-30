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

export async function sendMail(env: MailEnv, to: string, subject: string, intro: string, action: string, url: string) {
  const safeUrl = escapeHtml(url);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.AUTH_FROM_EMAIL,
      to,
      subject,
      text: `${intro}\n\n${action}: ${url}\n\nIf this wasn't you, you can ignore this email.`,
      html: `<p>${escapeHtml(intro)}</p><p><a href="${safeUrl}">${escapeHtml(action)}</a></p><p style="color:#777">If this wasn't you, you can ignore this email.</p>`,
    }),
  });
  if (!response.ok) console.error('resend error', response.status, await response.text());
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
