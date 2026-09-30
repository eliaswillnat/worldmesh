/**
 * Emails, through Resend like the rest of the hub. Media is never attached:
 * the moderation email links to it (signed, expiring URLs) and shows a
 * preview image or a video's still frame.
 */
import { AD_CONFIG } from '../../../apps/hub/src/ads/config';
import { describeBillboard } from '../../../apps/hub/src/walk/layout';
import type { AdRow } from './db';
import { adminInbox, origin, type Env } from './env';
import { escapeHtml } from './http';
import { signedMediaUrl } from './signing';

/** Signed media links in the moderation email outlive the longest possible review. */
const EMAIL_LINK_TTL = AD_CONFIG.authorizationFallbackMs + 3 * 24 * 60 * 60 * 1000;

async function send(env: Env, message: { to: string; subject: string; html: string; replyTo?: string }): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn('ads: RESEND_API_KEY not set; email not sent:', message.subject);
    return false;
  }
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'WorldMesh <accounts@worldmesh.net>',
        to: [message.to],
        subject: message.subject,
        html: message.html,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
    });
    if (!response.ok) console.error('ads: Resend error', response.status, await response.text().catch(() => ''));
    return response.ok;
  } catch (error) {
    console.error('ads: Resend unreachable', error);
    return false;
  }
}

export function price(ad: Pick<AdRow, 'amount_cents' | 'currency'>): string {
  return new Intl.NumberFormat('en-IE', { style: 'currency', currency: ad.currency.toUpperCase() }).format(ad.amount_cents / 100);
}

export function formatDate(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toUTCString().replace(' GMT', ' UTC');
}

function layout(title: string, content: string): string {
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #f0f0f0; border-radius: 8px;">
    <h2 style="margin-top: 0; color: #ffffff; font-size: 20px; border-bottom: 1px solid #222; padding-bottom: 12px;">${escapeHtml(title)}</h2>
    ${content}
  </div>`;
}

function row(label: string, valueHtml: string): string {
  return `<div style="margin: 14px 0;">
    <span style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em;">${escapeHtml(label)}</span>
    <div style="color: #eee; margin-top: 4px; word-break: break-word;">${valueHtml}</div>
  </div>`;
}

function button(href: string, text: string, color = '#34d399'): string {
  return `<div style="margin: 24px 0; text-align: center;">
    <a href="${escapeHtml(href)}" style="display: inline-block; padding: 14px 32px; background: ${color}; color: #000; font-weight: 700; text-decoration: none; border-radius: 25px; font-size: 16px;">${escapeHtml(text)}</a>
  </div>`;
}

export function reviewUrl(env: Env, id: string): string {
  return `${origin(env)}/api/ads/admin/review?id=${encodeURIComponent(id)}`;
}

/** To the admin, once the €2 is authorized: everything needed to decide. */
export async function sendModerationEmail(env: Env, ad: AdRow, nowMs: number): Promise<boolean> {
  const expires = nowMs + EMAIL_LINK_TTL;
  const review = reviewUrl(env, ad.id);
  let preview: string;
  if (ad.media_type === 'image') {
    const src = await signedMediaUrl(env, ad.id, 'media', expires);
    preview = row('Image', `<img src="${escapeHtml(src)}" alt="Advertisement" style="max-width: 100%; max-height: 420px; border-radius: 6px; border: 1px solid #333;" />`);
  } else {
    const watch = await signedMediaUrl(env, ad.id, 'media', expires);
    const still = ad.poster_key ? await signedMediaUrl(env, ad.id, 'poster', expires) : null;
    preview = row(
      'Video',
      `${still ? `<a href="${escapeHtml(watch)}"><img src="${escapeHtml(still)}" alt="Video still" style="max-width: 100%; max-height: 420px; border-radius: 6px; border: 1px solid #333;" /></a><br />` : ''}
       <a href="${escapeHtml(watch)}" style="color: #70aaff;">Watch the video</a>
       <span style="color: #888;"> (${Math.round(ad.media_bytes / 1024 / 1024 * 10) / 10} MB, ${escapeHtml(ad.media_mime)}; secure link, expires ${escapeHtml(formatDate(expires))})</span>`,
    );
  }
  const html = layout(
    'New billboard advertisement to review',
    `${button(review, 'Review Advertisement')}
    ${preview}
    ${row('Advertiser', escapeHtml(ad.advertiser_name))}
    ${row('Destination URL', `<a href="${escapeHtml(ad.destination_url)}" style="color: #70aaff; word-break: break-all;">${escapeHtml(ad.destination_url)}</a>`)}
    ${row('Advertiser email', `<a href="mailto:${escapeHtml(ad.contact_email)}" style="color: #70aaff;">${escapeHtml(ad.contact_email)}</a>`)}
    ${row('Billboard', `<code>${escapeHtml(ad.billboard_id)}</code> · ${escapeHtml(describeBillboard(ad.billboard_id))}`)}
    ${row('Submitted', escapeHtml(formatDate(ad.created_at)))}
    ${row('Price', `${escapeHtml(price(ad))} authorized, not yet captured. Approve before ${escapeHtml(formatDate(ad.authorization_expires_at))} or it is released automatically.`)}
    ${row('Submission ID', `<code>${escapeHtml(ad.id)}</code>`)}
    <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #222; font-size: 12px; color: #666;">
      Approving captures the payment and puts the advertisement on the billboard. Rejecting releases the authorization; the advertiser is not charged.
    </div>`,
  );
  return send(env, {
    to: adminInbox(env),
    subject: `[WorldMesh] Billboard ad to review: ${ad.advertiser_name} (${ad.billboard_id})`,
    html,
    replyTo: ad.contact_email,
  });
}

export type AdvertiserNotice = 'approved' | 'rejected' | 'authorization_expired' | 'payment_failed' | 'released';

/** Which email the advertiser is owed for this row's current state, if any. */
export function advertiserNoticeFor(ad: AdRow): AdvertiserNotice | null {
  if (ad.status === 'active') return 'approved';
  if (ad.status === 'rejected') return 'rejected';
  if (ad.status === 'failed') return 'payment_failed';
  if (ad.status === 'expired' && ad.status_reason === 'authorization_expired') return 'authorization_expired';
  if (ad.status === 'cancelled' && ad.status_reason === 'authorized_after_release') return 'released';
  return null;
}

export async function sendAdvertiserEmail(env: Env, ad: AdRow, notice: AdvertiserNotice): Promise<boolean> {
  const amount = escapeHtml(price(ad));
  const name = escapeHtml(ad.advertiser_name);
  const where = `billboard <code>${escapeHtml(ad.billboard_id)}</code> in the WorldMesh city`;
  const footer = `<div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #222; font-size: 12px; color: #666;">
    You are receiving this because an advertisement was submitted for ${where} with this email address. Reference: ${escapeHtml(ad.id)}
  </div>`;
  const messages: Record<AdvertiserNotice, { subject: string; title: string; body: string }> = {
    approved: {
      subject: 'Your WorldMesh billboard advertisement is live',
      title: 'Your advertisement is live',
      body: `<p style="color: #ccc; line-height: 1.6;">Hi ${name}, your advertisement has been approved and is now showing on ${where}.</p>
        ${row('Runs until', escapeHtml(formatDate(ad.ends_at)))}
        ${row('Links to', escapeHtml(ad.destination_url))}
        ${row('Charged', `${amount}`)}
        ${button(origin(env), 'Visit WorldMesh', '#70aaff')}`,
    },
    rejected: {
      subject: 'Your WorldMesh billboard advertisement was not approved',
      title: 'Your advertisement was not approved',
      body: `<p style="color: #ccc; line-height: 1.6;">Hi ${name}, after review your advertisement for ${where} was not approved.</p>
        ${ad.reject_reason ? row('Reason', escapeHtml(ad.reject_reason)) : ''}
        <p style="color: #ccc; line-height: 1.6;">You have <strong>not</strong> been charged: the ${amount} authorization on your card has been released. Depending on your bank it can take a few days to disappear from your statement.</p>`,
    },
    authorization_expired: {
      subject: 'Your WorldMesh billboard advertisement could not be reviewed in time',
      title: 'Not reviewed in time',
      body: `<p style="color: #ccc; line-height: 1.6;">Hi ${name}, we could not review your advertisement for ${where} before the card authorization ran out, so it was withdrawn.</p>
        <p style="color: #ccc; line-height: 1.6;">You have <strong>not</strong> been charged: the ${amount} authorization has been released. You are welcome to submit it again.</p>`,
    },
    payment_failed: {
      subject: 'Your WorldMesh billboard advertisement could not be published',
      title: 'Payment could not be completed',
      body: `<p style="color: #ccc; line-height: 1.6;">Hi ${name}, your advertisement for ${where} was approved, but the ${amount} payment could not be completed, so it has not been published.</p>
        <p style="color: #ccc; line-height: 1.6;">You have <strong>not</strong> been charged. You are welcome to submit it again.</p>`,
    },
    released: {
      subject: 'Your WorldMesh billboard reservation ran out',
      title: 'Reservation ran out',
      body: `<p style="color: #ccc; line-height: 1.6;">Hi ${name}, your payment for ${where} was authorized after the billboard's reservation had already run out, so the advertisement was not submitted.</p>
        <p style="color: #ccc; line-height: 1.6;">You have <strong>not</strong> been charged: the ${amount} authorization has been released. You are welcome to try again.</p>`,
    },
  };
  const message = messages[notice];
  return send(env, { to: ad.contact_email, subject: message.subject, html: layout(message.title, message.body + footer) });
}
