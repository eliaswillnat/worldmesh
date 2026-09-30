/**
 * World submissions and the public directory, on D1's world table.
 *
 *   GET  /api/worlds                  published worlds, the hub's directory
 *   POST /api/worlds                  submit a world; owned by the signed-in user, if any
 *   GET  /api/worlds/approve?id&token confirmation page from the admin email
 *   POST /api/worlds/approve          publishes it
 *   GET  /api/account/worlds          the signed-in user's own worlds, any status
 *
 * Replaces the KV version in apps/hub/functions (pending:/approved: keys),
 * which the hub's Pages project never routed. scripts/backfill-worlds.mjs
 * copies KV and community.json worlds in.
 */
import type { Auth, Env } from './auth';
import { HttpError, isSameOrigin, json, readJson } from './http';
import type { MailEnv } from './mail';

export const WORLDS_PATH = '/api/worlds';

export interface WorldsEnv extends MailEnv {
  /** Who is told about new submissions. */
  NOTIFICATION_EMAIL?: string;
  /** Sender for world emails; falls back to AUTH_FROM_EMAIL. */
  FROM_EMAIL?: string;
}

interface Exec {
  waitUntil(promise: Promise<unknown>): void;
}

interface SessionUser {
  id: string;
  email: string;
  username?: string | null;
}

interface WorldRow {
  id: string;
  legacy_id: string | null;
  name: string;
  url: string;
  description: string | null;
  cover_url: string | null;
  creator_name: string | null;
  portfolio_url: string | null;
  status: string;
  created_at: number;
  published_at: number | null;
  username: string | null;
}

/** The shape the hub has always read from /api/worlds (and community.json). */
export interface DirectoryEntry {
  id: string;
  name: string;
  url: string;
  description?: string;
  cover?: string;
  creator?: string;
  portfolio?: string;
  /** The owner's username, for a link to their profile. */
  owner?: string;
  addedAt?: string;
  approvedAt?: string;
}

const DIRECTORY_SQL = `
  select w.id, w.legacy_id, w.name, w.url, w.description, w.cover_url, w.creator_name,
         w.portfolio_url, w.status, w.created_at, w.published_at, u.username
  from world w left join "user" u on u.id = w.owner_user_id`;

const DIRECTORY_MAX_AGE = 60;

export async function handleWorldsRequest(
  request: Request,
  env: Env & WorldsEnv,
  auth: () => Promise<Auth>,
  exec: Exec,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === WORLDS_PATH && request.method === 'GET') return directory(request, env, exec);
  if (pathname === WORLDS_PATH && request.method === 'POST') return submit(request, env, await auth(), exec);
  if (pathname === `${WORLDS_PATH}/approve` && request.method === 'GET') return approvePage(request, env);
  if (pathname === `${WORLDS_PATH}/approve` && request.method === 'POST') return approve(request, env, exec);
  if (pathname === '/api/account/worlds' && request.method === 'GET') return myWorlds(request, env, await auth());
  throw new HttpError(404, 'Not found.');
}

async function directory(request: Request, env: Env, exec: Exec): Promise<Response> {
  const cache = edgeCache();
  const key = new Request(new URL(WORLDS_PATH, request.url).toString());
  const hit = await cache?.match(key);
  if (hit) return hit;

  const { results } = await env.DB.prepare(
    `${DIRECTORY_SQL} where w.status = 'published' order by w.published_at desc`,
  ).all<WorldRow>();
  const response = new Response(JSON.stringify(results.map(toDirectoryEntry)), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${DIRECTORY_MAX_AGE}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
  if (cache) exec.waitUntil(cache.put(key, response.clone()));
  return response;
}

export function toDirectoryEntry(row: WorldRow): DirectoryEntry {
  const entry: DirectoryEntry = { id: row.legacy_id ?? row.id, name: row.name, url: row.url };
  if (row.description) entry.description = row.description;
  if (row.cover_url) entry.cover = row.cover_url;
  const creator = row.creator_name ?? (row.username ? `@${row.username}` : null);
  if (creator) entry.creator = creator;
  if (row.portfolio_url) entry.portfolio = row.portfolio_url;
  if (row.username) entry.owner = row.username;
  if (row.published_at) entry.addedAt = entry.approvedAt = new Date(row.published_at).toISOString();
  return entry;
}

interface Submission {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  description?: unknown;
  cover?: unknown;
  creator?: unknown;
  portfolio?: unknown;
  email?: unknown;
  botTrap?: unknown;
}

async function submit(request: Request, env: Env & WorldsEnv, auth: Auth, exec: Exec): Promise<Response> {
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  if (!isSameOrigin(request, origin)) throw new HttpError(403, 'Cross-site request refused.');

  // Covers normally arrive as an R2 URL; the hub only falls back to a data URL
  // when that upload failed, and those are dropped below, so 64 KiB is plenty.
  const body = (await readJson(request, 64 * 1024)) as Submission | null;
  if (!body || typeof body !== 'object') throw new HttpError(400, 'Invalid submission.');
  // Bots fill the hidden field; tell them it worked and store nothing.
  if (typeof body.botTrap === 'string' && body.botTrap.trim()) return json({ world: { status: 'pending' } }, 201);

  const url = httpUrl(body.url, 'World URL', true)!;
  const name = text(body.name, 'Name', 120) ?? new URL(url).hostname;
  const description = text(body.description, 'Description', 500);
  const creator = text(body.creator, 'Creator name', 80);
  const portfolio = httpUrl(body.portfolio, 'Portfolio link');
  // A data: URL fallback is not worth storing in D1; the screenshot worker makes a cover instead.
  const cover = typeof body.cover === 'string' && body.cover.startsWith('data:') ? undefined : httpUrl(body.cover, 'Cover', false, true);

  const session = await auth.api.getSession({ headers: request.headers });
  const user = (session?.user as SessionUser | undefined) ?? null;
  const email = text(body.email, 'Email', 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That email does not look right.');
  if (!user && !email) throw new HttpError(400, 'Sign in, or give an email so we can reach you about your world.');

  const token = randomHex(32);
  const now = Date.now();
  let id = typeof body.id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(body.id) ? body.id : newId(name);
  for (let attempt = 0; ; attempt++) {
    try {
      await env.DB.prepare(
        `insert into world (id, owner_user_id, name, url, description, cover_url, creator_name, portfolio_url,
                            contact_email, review_token_hash, status, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'pending', ?11, ?11)`,
      )
        .bind(id, user?.id ?? null, name, url, description, cover ?? null, creator, portfolio, email, await sha256Hex(token), now)
        .run();
      break;
    } catch (error) {
      const message = String(error);
      if (message.includes('world.url')) throw new HttpError(409, 'That world is already listed or waiting for review.');
      if (message.includes('world.id') && attempt === 0) {
        id = newId(name);
        continue;
      }
      throw error;
    }
  }

  const approveUrl = `${origin}${WORLDS_PATH}/approve?id=${encodeURIComponent(id)}&token=${token}`;
  if (worldMailReady(env)) {
    const who = user ? `${user.username ? `@${user.username}` : 'Signed-in user'} <${user.email}>` : `Guest <${email}>`;
    exec.waitUntil(
      sendWorldMail(env, env.NOTIFICATION_EMAIL || 'elias.willnat@gmail.com', `[WorldMesh] New world: ${name} (${id})`, [
        ['World', name],
        ['URL', url],
        ['Submitted by', who],
        ['Creator', creator],
        ['Portfolio', portfolio],
        ['Description', description],
        ['Cover', cover],
      ], { label: 'Review and approve', url: approveUrl }, email ?? undefined).catch((e) => console.error('world mail', e)),
    );
  } else {
    console.warn('world submitted but mail is not configured, so no approval link was sent:', id);
  }

  return json({ world: { id, status: 'pending', owned: !!user } }, 201);
}

async function approvePage(request: Request, env: Env): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const world = await reviewable(env, params.get('id'), params.get('token'));
  if (world.status === 'published') return page(`<strong>${escapeHtml(world.name)}</strong> is already live.`, true);
  // Link scanners in mail clients follow GET links; only the button's POST publishes.
  return page(
    `Publish <strong>${escapeHtml(world.name)}</strong>?<br><a href="${escapeHtml(world.url)}" target="_blank" rel="noopener">${escapeHtml(world.url)}</a>` +
      `<form method="post" action="${WORLDS_PATH}/approve"><input type="hidden" name="id" value="${escapeHtml(world.id)}">` +
      `<input type="hidden" name="token" value="${escapeHtml(params.get('token') ?? '')}"><button type="submit">Approve world</button></form>`,
    true,
  );
}

async function approve(request: Request, env: Env & WorldsEnv, exec: Exec): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const id = form?.get('id');
  const token = form?.get('token');
  const world = await reviewable(env, typeof id === 'string' ? id : null, typeof token === 'string' ? token : null);
  if (world.status === 'published') return page(`<strong>${escapeHtml(world.name)}</strong> is already live.`, true);

  const now = Date.now();
  const update = await env.DB.prepare(
    `update world set status = 'published', published_at = ?1, updated_at = ?1, review_token_hash = null
     where id = ?2 and status = 'pending'`,
  )
    .bind(now, world.id)
    .run();
  if (!update.meta.changes) return page(`<strong>${escapeHtml(world.name)}</strong> is already live.`, true);

  const cache = edgeCache();
  if (cache) exec.waitUntil(cache.delete(new Request(new URL(WORLDS_PATH, env.BETTER_AUTH_URL).toString())));

  const to = world.contact_email ?? world.owner_email;
  if (to && worldMailReady(env)) {
    const origin = new URL(env.BETTER_AUTH_URL).origin;
    exec.waitUntil(
      sendWorldMail(env, to, `Your world "${world.name}" is now live on WorldMesh!`, [
        ['World', world.name],
        ['URL', world.url],
      ], { label: 'View on WorldMesh', url: origin }).catch((e) => console.error('world mail', e)),
    );
  }
  return page(`<strong>${escapeHtml(world.name)}</strong> is approved and live.${to ? ' The creator has been emailed.' : ''}`, true);
}

interface ReviewRow {
  id: string;
  name: string;
  url: string;
  status: string;
  review_token_hash: string | null;
  contact_email: string | null;
  owner_email: string | null;
}

async function reviewable(env: Env, id: string | null, token: string | null): Promise<ReviewRow> {
  if (!id || !token) throw new PageError('Missing id or token.');
  const world = await env.DB.prepare(
    `select w.id, w.name, w.url, w.status, w.review_token_hash, w.contact_email, u.email as owner_email
     from world w left join "user" u on u.id = w.owner_user_id where w.id = ?1`,
  )
    .bind(id)
    .first<ReviewRow>();
  if (!world) throw new PageError('Submission not found.');
  if (world.status === 'published') return world;
  if (world.status !== 'pending' || !world.review_token_hash || !timingSafeEqual(world.review_token_hash, await sha256Hex(token))) {
    throw new PageError('Invalid approval link.');
  }
  return world;
}

async function myWorlds(request: Request, env: Env, auth: Auth): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new HttpError(401, 'Sign in first.');
  const { results } = await env.DB.prepare(
    `${DIRECTORY_SQL} where w.owner_user_id = ?1 and w.status != 'removed' order by w.created_at desc`,
  )
    .bind(session.user.id)
    .all<WorldRow>();
  return json({
    worlds: results.map((row) => ({
      ...toDirectoryEntry(row),
      status: row.status,
      submittedAt: new Date(row.created_at).toISOString(),
    })),
  });
}

/** Errors on the approval pages are shown as a page, not JSON. */
export class PageError extends Error {}

export function page(message: string, success: boolean, status = 200): Response {
  const color = success ? '#34d399' : '#f87171';
  const icon = success ? '&#10003;' : '&#10007;';
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorldMesh</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#f0f0f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.card{max-width:420px;padding:32px;background:#141414;border:1px solid #2a2a2a;border-radius:12px;text-align:center}
.icon{font-size:48px;color:${color};margin-bottom:16px}.msg{color:#ccc;line-height:1.6;word-break:break-word}a{color:#70aaff}
button{margin-top:20px;padding:12px 28px;background:#34d399;color:#000;font-weight:700;border:0;border-radius:25px;font-size:16px;cursor:pointer}</style></head>
<body><div class="card"><div class="icon">${icon}</div><div class="msg">${message}</div><p style="margin-top:20px"><a href="/">Back to WorldMesh</a></p></div></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

async function sendWorldMail(
  env: WorldsEnv,
  to: string,
  subject: string,
  rows: [string, string | null | undefined][],
  action: { label: string; url: string },
  replyTo?: string,
): Promise<void> {
  const shown = rows.filter((row): row is [string, string] => !!row[1]);
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px">` +
    `<p><a href="${escapeHtml(action.url)}" style="display:inline-block;padding:12px 28px;background:#34d399;color:#000;font-weight:700;text-decoration:none;border-radius:25px">${escapeHtml(action.label)}</a></p>` +
    shown.map(([label, value]) => `<p><span style="color:#888;font-size:12px;text-transform:uppercase">${escapeHtml(label)}</span><br>${escapeHtml(value)}</p>`).join('') +
    `</div>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.FROM_EMAIL || env.AUTH_FROM_EMAIL,
      to,
      subject,
      ...(replyTo && { reply_to: replyTo }),
      text: `${shown.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${action.label}: ${action.url}`,
      html,
    }),
  });
  if (!response.ok) console.error('resend error', response.status, await response.text());
}

function worldMailReady(env: WorldsEnv): boolean {
  return !!(env.RESEND_API_KEY && (env.FROM_EMAIL || env.AUTH_FROM_EMAIL));
}

function text(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new HttpError(400, `${label} is too long (${max} characters at most).`);
  return trimmed || null;
}

function httpUrl(value: unknown, label: string, required = false, httpsOnly = false): string | null {
  const raw = text(value, label, 2048);
  if (!raw) {
    if (required) throw new HttpError(400, `${label} is missing.`);
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `${label} is not a valid link.`);
  }
  if (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:')) {
    throw new HttpError(400, `${label} must be an ${httpsOnly ? 'https' : 'http(s)'} link.`);
  }
  return url.toString();
}

function newId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'world';
  return `${slug}-${randomHex(3)}`;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function edgeCache(): Cache | undefined {
  return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
