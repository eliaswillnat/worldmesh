/**
 * The moderation page, for WorldMesh admins only.
 *
 * Who is an admin: someone signed in to WorldMesh (workers/auth, Better Auth)
 * whose verified account email is in ADMIN_EMAILS. The session is looked up in
 * the shared D1 `session` table from the hub's own session cookie; nothing
 * here trusts a parameter to say who is asking. Approve and Reject are POSTs
 * that also need a same-origin request and a CSRF token bound to that session.
 * There is no other way to change a submission's status from outside.
 */
import { AD_CONFIG, type AdStatus } from '../../../apps/hub/src/ads/config';
import { billboardCatalog, describeBillboard } from '../../../apps/hub/src/walk/layout';
import { isRandomId } from './crypto';
import { getAd, type AdRow } from './db';
import { formatDate, price } from './email';
import { adminEmails, now, origin, type Env } from './env';
import { adminHtml, escapeHtml, HttpError, isSameOrigin, readText, redirect } from './http';
import { approve, reject, takeDown, type Outcome } from './lifecycle';
import { csrfToken, verifyCsrfToken } from './signing';
import { retrievePaymentIntent, type PaymentIntent } from './stripe';

/** workers/auth's session cookie: __Secure- on https, bare on http://localhost. */
const SESSION_COOKIES = ['__Secure-worldmesh.session_token', 'worldmesh.session_token'];

export interface AdminSession {
  email: string;
  /** The Better Auth session token, for binding CSRF tokens. */
  token: string;
}

export type AdminCheck = { admin: AdminSession } | { signedIn: false } | { signedIn: true; email: string };

function sessionToken(request: Request): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!SESSION_COOKIES.includes(name)) continue;
    let value = rest.join('=');
    try {
      value = decodeURIComponent(value);
    } catch {
      continue;
    }
    // "<token>.<signature>": the token alone identifies the session row.
    const token = value.split('.')[0];
    if (/^[A-Za-z0-9_-]{16,128}$/.test(token)) return token;
  }
  return null;
}

function toMillis(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') return /^\d+$/.test(value) ? toMillis(Number(value)) : Date.parse(value);
  return NaN;
}

export async function checkAdmin(request: Request, env: Env): Promise<AdminCheck> {
  const token = sessionToken(request);
  if (!token) return { signedIn: false };
  const row = await env.DB.prepare(
    `select u.email as email, u."emailVerified" as verified, s."expiresAt" as expires
     from "session" s join "user" u on u.id = s."userId" where s.token = ?`,
  )
    .bind(token)
    .first<{ email: string; verified: unknown; expires: unknown }>();
  if (!row || !(toMillis(row.expires) > now(env))) return { signedIn: false };
  const email = String(row.email).toLowerCase();
  const verified = row.verified === 1 || row.verified === true || row.verified === '1' || row.verified === 'true';
  if (!verified || !adminEmails(env).has(email)) return { signedIn: true, email };
  return { admin: { email, token } };
}

/** Admin or a page explaining how to become one (sign in), never the content. */
async function requireAdmin(request: Request, env: Env, returnTo: string): Promise<AdminSession | Response> {
  const check = await checkAdmin(request, env);
  if ('admin' in check) return check.admin;
  if (!check.signedIn) {
    const login = `${origin(env)}/?login=1&next=${encodeURIComponent(returnTo)}`;
    return adminHtml(
      page('Sign in to review', `<p>This page is only for WorldMesh admins. Sign in with your admin account, then come back to this link.</p>
        <p><a class="button" href="${escapeHtml(login)}">Sign in to WorldMesh</a></p>`),
      401,
    );
  }
  return adminHtml(
    page('Not an admin', `<p>You are signed in as <strong>${escapeHtml(check.email)}</strong>, which is not a WorldMesh admin account (or its email is not verified).</p>`),
    403,
  );
}

// ── Pages ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<AdStatus, string> = {
  awaiting_payment: 'Awaiting payment',
  pending: 'Pending review',
  approved: 'Approved (capturing)',
  active: 'Active',
  rejected: 'Rejected',
  expired: 'Expired',
  cancelled: 'Cancelled',
  failed: 'Payment failed',
};

/** GET /api/ads/admin/review?id=… */
export async function reviewPage(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') ?? '';
  const session = await requireAdmin(request, env, `/api/ads/admin/review?id=${encodeURIComponent(id)}`);
  if (session instanceof Response) return session;
  const ad = isRandomId(id) ? await getAd(env, id) : null;
  if (!ad) return adminHtml(page('Not found', '<p>No such submission.</p><p><a href="/api/ads/admin">All submissions</a></p>'), 404);

  // Live payment state straight from Stripe, falling back to the last one we saw.
  let intent: PaymentIntent | null = null;
  if (ad.stripe_payment_intent_id) intent = await retrievePaymentIntent(env, ad.stripe_payment_intent_id).catch(() => null);
  const done = url.searchParams.get('done');
  const notice = done ? `<p class="notice ${url.searchParams.get('ok') === '1' ? 'ok' : 'bad'}">${escapeHtml(done)}</p>` : '';

  const media = `/api/ads/media/${ad.id}/media`;
  const preview = ad.media_deleted_at
    ? '<p class="muted">The files were deleted after the retention period.</p>'
    : ad.media_type === 'image'
      ? `<img class="media" src="${media}" alt="Advertisement" />`
      : `<video class="media" src="${media}" ${ad.poster_key ? `poster="/api/ads/media/${ad.id}/poster"` : ''} controls muted autoplay loop playsinline preload="metadata"></video>`;

  const token = await csrfToken(env, session.token, ad.id);
  const actions =
    ad.status === 'pending'
      ? `<div class="actions">
          <form method="post" action="/api/ads/admin/review">
            <input type="hidden" name="id" value="${ad.id}" /><input type="hidden" name="csrf" value="${token}" />
            <input type="hidden" name="action" value="approve" />
            <button class="approve" type="submit">Approve</button>
            <p class="muted">Captures ${escapeHtml(price(ad))} and puts it on the billboard for ${Math.round(AD_CONFIG.durationMs / 86_400_000)} days.</p>
          </form>
          <form method="post" action="/api/ads/admin/review">
            <input type="hidden" name="id" value="${ad.id}" /><input type="hidden" name="csrf" value="${token}" />
            <input type="hidden" name="action" value="reject" />
            <label>Reason for the advertiser (optional)<textarea name="reason" maxlength="${AD_CONFIG.text.rejectReasonMaxLength}" rows="2"></textarea></label>
            <button class="reject" type="submit">Reject</button>
            <p class="muted">Releases the authorization. The advertiser is not charged.</p>
          </form>
        </div>`
      : ad.status === 'active'
        ? `<div class="actions"><form method="post" action="/api/ads/admin/review">
            <input type="hidden" name="id" value="${ad.id}" /><input type="hidden" name="csrf" value="${token}" />
            <input type="hidden" name="action" value="takedown" />
            <button class="reject" type="submit">Take down</button>
            <p class="muted">Removes it from the billboard now. No automatic refund.</p>
          </form></div>`
        : `<p class="muted">No action available: this submission is ${escapeHtml(STATUS_LABEL[ad.status].toLowerCase())}.</p>`;

  const payment = intent
    ? `${escapeHtml(intent.status)} · ${escapeHtml(price(ad))}${intent.status === 'requires_capture' ? ' authorized, not captured' : ''}${intent.status === 'succeeded' ? ' captured' : ''}`
    : `${escapeHtml(ad.payment_status ?? 'none')} (last seen; Stripe not reachable)`;

  return adminHtml(
    page(
      `Review: ${ad.advertiser_name}`,
      `${notice}
      <div class="grid">
        <div class="preview" style="aspect-ratio: ${billboardCatalog().get(ad.billboard_id)?.wide ? '2 / 1' : '1 / 2'}">${preview}</div>
        <div>
          <dl>
            <dt>Status</dt><dd><span class="status s-${ad.status}">${escapeHtml(STATUS_LABEL[ad.status])}</span>${ad.status_reason ? ` <span class="muted">(${escapeHtml(ad.status_reason.replace(/_/g, ' '))})</span>` : ''}</dd>
            <dt>Billboard</dt><dd><code>${escapeHtml(ad.billboard_id)}</code><br /><span class="muted">${escapeHtml(describeBillboard(ad.billboard_id))}</span></dd>
            <dt>Advertiser</dt><dd>${escapeHtml(ad.advertiser_name)}</dd>
            <dt>Contact email</dt><dd><a href="mailto:${escapeHtml(ad.contact_email)}">${escapeHtml(ad.contact_email)}</a></dd>
            <dt>Destination URL</dt><dd><a href="${escapeHtml(ad.destination_url)}" rel="noopener noreferrer" target="_blank">${escapeHtml(ad.destination_url)}</a></dd>
            <dt>Media</dt><dd>${escapeHtml(ad.media_type)} · ${escapeHtml(ad.media_mime)} · ${(ad.media_bytes / 1024 / 1024).toFixed(1)} MB</dd>
            <dt>Payment</dt><dd>${payment}<br /><span class="muted"><code>${escapeHtml(ad.stripe_payment_intent_id ?? '—')}</code></span>
              ${ad.payment_error ? `<br /><span class="bad">${escapeHtml(ad.payment_error)}</span>` : ''}</dd>
            ${ad.status === 'pending' ? `<dt>Decide before</dt><dd>${escapeHtml(formatDate(ad.authorization_expires_at))}</dd>` : ''}
            <dt>Submitted</dt><dd>${escapeHtml(formatDate(ad.created_at))}</dd>
            ${ad.reviewed_at ? `<dt>Reviewed</dt><dd>${escapeHtml(formatDate(ad.reviewed_at))} by ${escapeHtml(ad.reviewed_by ?? '')}</dd>` : ''}
            ${ad.activated_at ? `<dt>Live</dt><dd>${escapeHtml(formatDate(ad.activated_at))} → ${escapeHtml(formatDate(ad.ends_at))}</dd>` : ''}
            ${ad.reject_reason ? `<dt>Reject reason</dt><dd>${escapeHtml(ad.reject_reason)}</dd>` : ''}
          </dl>
          ${actions}
        </div>
      </div>
      <p><a href="/api/ads/admin">All submissions</a></p>`,
    ),
  );
}

/** GET /api/ads/admin — the queue: pending first, then everything recent. */
export async function queuePage(request: Request, env: Env): Promise<Response> {
  const session = await requireAdmin(request, env, '/api/ads/admin');
  if (session instanceof Response) return session;
  const { results } = await env.DB.prepare(
    `select * from ad_submission where status <> 'awaiting_payment' or hold_expires_at > ?
     order by case status when 'pending' then 0 when 'approved' then 1 when 'active' then 2 else 3 end, created_at desc limit 200`,
  )
    .bind(now(env))
    .all<AdRow>();
  const rows = results
    .map(
      (ad) => `<tr>
        <td><span class="status s-${ad.status}">${escapeHtml(STATUS_LABEL[ad.status])}</span></td>
        <td><a href="/api/ads/admin/review?id=${ad.id}">${escapeHtml(ad.advertiser_name)}</a></td>
        <td><code>${escapeHtml(ad.billboard_id)}</code></td>
        <td>${escapeHtml(ad.media_type)}</td>
        <td>${escapeHtml(formatDate(ad.created_at))}</td>
      </tr>`,
    )
    .join('');
  return adminHtml(
    page(
      'Billboard advertisements',
      rows
        ? `<table><thead><tr><th>Status</th><th>Advertiser</th><th>Billboard</th><th>Type</th><th>Submitted</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p class="muted">No submissions yet.</p>',
    ),
  );
}

/** POST /api/ads/admin/review (form): approve, reject or take down. */
export async function reviewAction(request: Request, env: Env): Promise<Response> {
  if (!isSameOrigin(request, env)) throw new HttpError(403, 'Cross-site request refused.');
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get('Content-Type') ?? '')) {
    throw new HttpError(415, 'Expected a form.');
  }
  const form = new URLSearchParams(await readText(request, 4096));
  const id = form.get('id') ?? '';
  const session = await requireAdmin(request, env, `/api/ads/admin/review?id=${encodeURIComponent(id)}`);
  if (session instanceof Response) return session;
  if (!isRandomId(id) || !(await verifyCsrfToken(env, session.token, id, form.get('csrf')))) {
    throw new HttpError(403, 'This form has expired. Reload the page and try again.');
  }

  let outcome: Outcome;
  const action = form.get('action');
  if (action === 'approve') {
    outcome = await approve(env, id, session.email);
  } else if (action === 'reject') {
    const reason = (form.get('reason') ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, AD_CONFIG.text.rejectReasonMaxLength);
    outcome = await reject(env, id, session.email, reason || null);
  } else if (action === 'takedown') {
    outcome = await takeDown(env, id, session.email);
  } else {
    throw new HttpError(400, 'Unknown action.');
  }
  return redirect(`/api/ads/admin/review?id=${id}&ok=${outcome.ok ? 1 : 0}&done=${encodeURIComponent(outcome.message)}`);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" /><title>${escapeHtml(title)} · WorldMesh ads</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0a0a0a; color: #f0f0f0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 22px; margin: 0 0 20px; word-break: break-word; }
  a { color: #70aaff; }
  code { font: 13px ui-monospace, Menlo, monospace; color: #a0c0ff; }
  .muted { color: #888; font-size: 13px; }
  .bad { color: #f87171; }
  .grid { display: grid; grid-template-columns: minmax(0, 340px) minmax(0, 1fr); gap: 28px; align-items: start; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
  .preview { background: #000; border: 1px solid #2a2a2a; border-radius: 10px; overflow: hidden; display: flex; align-items: center; justify-content: center; max-height: 70vh; }
  .media { width: 100%; height: 100%; object-fit: contain; display: block; }
  dl { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px 16px; margin: 0 0 20px; }
  dt { color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; padding-top: 2px; }
  dd { margin: 0; word-break: break-word; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 520px) { .actions { grid-template-columns: 1fr; } dl { grid-template-columns: 1fr; } }
  form { background: #141414; border: 1px solid #2a2a2a; border-radius: 10px; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: #aaa; }
  textarea { background: #0a0a0a; color: #f0f0f0; border: 1px solid #333; border-radius: 8px; padding: 8px; font: inherit; resize: vertical; }
  button, .button { display: inline-block; border: 0; border-radius: 999px; padding: 12px 24px; font: 700 15px/1 inherit; cursor: pointer; text-decoration: none; text-align: center; }
  .approve, .button { background: #34d399; color: #000; }
  .reject { background: #f87171; color: #000; }
  .notice { padding: 12px 16px; border-radius: 10px; margin: 0 0 20px; }
  .notice.ok { background: #0f2e22; border: 1px solid #34d399; }
  .notice.bad { background: #331414; border: 1px solid #f87171; color: #f0f0f0; }
  .status { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; background: #262626; }
  .s-pending { background: #f59e0b; color: #000; }
  .s-active { background: #34d399; color: #000; }
  .s-approved { background: #60a5fa; color: #000; }
  .s-rejected, .s-failed { background: #7f1d1d; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #222; font-size: 14px; }
  th { color: #888; font-weight: 600; font-size: 12px; text-transform: uppercase; }
</style></head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}
