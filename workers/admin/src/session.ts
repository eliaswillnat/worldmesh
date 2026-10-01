/**
 * Who may see the dashboard, and how they get in.
 *
 * The WorldMesh session cookie is host-only on worldmesh.net on purpose (it
 * is never sent to worlds on subdomains), so admin.worldmesh.net cannot read
 * it. Instead this Worker also answers one path on the hub's own hostname:
 *
 *   1. admin.worldmesh.net, no dashboard cookie
 *        → https://worldmesh.net/api/dashboard/handoff
 *   2. handoff reads the hub session from the shared D1 `session` table. Not
 *      signed in → the hub's sign-in dialog, which comes back here. Signed in
 *      with a verified email in ADMIN_EMAILS → a ticket, HMAC-signed and good
 *      for 60 seconds, naming the session row.
 *        → https://admin.worldmesh.net/auth/callback?ticket=…
 *   3. callback checks the ticket and sets its own host-only cookie on
 *      admin.worldmesh.net, signed the same way, for at most 12 hours and
 *      never longer than the hub session.
 *
 * Every dashboard request re-reads the session row: signing out on the hub,
 * the session expiring, or an email leaving ADMIN_EMAILS ends access at once.
 */
import { adminEmails, adminOrigin, hubOrigin, now, type Env } from './env';

/** workers/auth's session cookie: __Secure- on https, bare on http://localhost. */
const HUB_COOKIES = ['__Secure-worldmesh.session_token', 'worldmesh.session_token'];
export const HANDOFF_PATH = '/api/dashboard/handoff';
const TICKET_TTL = 60_000;
const COOKIE_TTL = 12 * 60 * 60_000;

export interface AdminSession {
  email: string;
  sessionId: string;
}

interface SessionRow {
  id: string;
  email: string;
  verified: unknown;
  expires: unknown;
}

interface Signed {
  k: 'ticket' | 'cookie';
  sid: string;
  email: string;
  exp: number;
}

// ── Cookies ────────────────────────────────────────────────────────────────

function readCookie(request: Request, names: string[]): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!names.includes(name)) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      continue;
    }
  }
  return null;
}

function secure(env: Env): boolean {
  return adminOrigin(env).startsWith('https://');
}

export function dashboardCookieName(env: Env): string {
  return secure(env) ? '__Host-wm_admin' : 'wm_admin';
}

function setCookie(env: Env, value: string, maxAgeSeconds: number): string {
  const parts = [`${dashboardCookieName(env)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (secure(env)) parts.push('Secure');
  return parts.join('; ');
}

// ── Signing ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function key(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(env.ADMIN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function sign(env: Env, payload: Signed): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await key(env), encoder.encode(body)));
  return `${body}.${base64url(mac)}`;
}

export async function verify(env: Env, value: string | null, kind: Signed['k']): Promise<Signed | null> {
  if (!value || value.length > 2048) return null;
  const [body, mac, extra] = value.split('.');
  if (!body || !mac || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await key(env), fromBase64url(mac), encoder.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as Signed;
    if (payload.k !== kind || typeof payload.sid !== 'string' || typeof payload.email !== 'string') return null;
    if (!(typeof payload.exp === 'number' && payload.exp > now(env))) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Sessions ───────────────────────────────────────────────────────────────

function toMillis(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string') return /^\d+$/.test(value) ? toMillis(Number(value)) : Date.parse(value);
  return NaN;
}

function isTrue(value: unknown): boolean {
  return value === 1 || value === true || value === '1' || value === 'true';
}

const SESSION_SQL = `select s.id as id, u.email as email, u."emailVerified" as verified, s."expiresAt" as expires
  from "session" s join "user" u on u.id = s."userId"`;

type Check = { admin: AdminSession; expires: number } | { signedIn: false } | { signedIn: true; email: string };

function judge(env: Env, row: SessionRow | null): Check {
  if (!row) return { signedIn: false };
  const expires = toMillis(row.expires);
  if (!(expires > now(env))) return { signedIn: false };
  const email = String(row.email).toLowerCase();
  if (!isTrue(row.verified) || !adminEmails(env).has(email)) return { signedIn: true, email };
  return { admin: { email, sessionId: row.id }, expires };
}

/** The hub session, from the hub's own cookie (handoff only). */
async function hubSession(request: Request, env: Env): Promise<Check> {
  const value = readCookie(request, HUB_COOKIES);
  // "<token>.<signature>": the token alone identifies the session row.
  const token = value?.split('.')[0] ?? '';
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return { signedIn: false };
  const row = await env.DB.prepare(`${SESSION_SQL} where s.token = ?`).bind(token).first<SessionRow>();
  return judge(env, row);
}

async function sessionById(env: Env, id: string): Promise<Check> {
  const row = await env.DB.prepare(`${SESSION_SQL} where s.id = ?`).bind(id).first<SessionRow>();
  return judge(env, row);
}

/** The signed-in admin on admin.worldmesh.net, or null. */
export async function currentAdmin(request: Request, env: Env): Promise<AdminSession | null> {
  const cookie = await verify(env, readCookie(request, [dashboardCookieName(env)]), 'cookie');
  if (!cookie) return null;
  const check = await sessionById(env, cookie.sid);
  if (!('admin' in check) || check.admin.email !== cookie.email) return null;
  return check.admin;
}

// ── Routes ─────────────────────────────────────────────────────────────────

export function startLogin(env: Env): Response {
  return redirect(`${hubOrigin(env)}${HANDOFF_PATH}`);
}

/** GET worldmesh.net/api/dashboard/handoff */
export async function handoff(request: Request, env: Env, deny: (email: string) => Response): Promise<Response> {
  const check = await hubSession(request, env);
  if ('admin' in check) {
    const ticket = await sign(env, { k: 'ticket', sid: check.admin.sessionId, email: check.admin.email, exp: now(env) + TICKET_TTL });
    return redirect(`${adminOrigin(env)}/auth/callback?ticket=${encodeURIComponent(ticket)}`);
  }
  if (!check.signedIn) return redirect(`${hubOrigin(env)}/?login=1&next=${encodeURIComponent(HANDOFF_PATH)}`);
  return deny(check.email);
}

/** GET admin.worldmesh.net/auth/callback?ticket=… */
export async function callback(request: Request, env: Env): Promise<Response> {
  const ticket = await verify(env, new URL(request.url).searchParams.get('ticket'), 'ticket');
  if (!ticket) return startLogin(env);
  const check = await sessionById(env, ticket.sid);
  if (!('admin' in check) || check.admin.email !== ticket.email) return startLogin(env);
  const exp = Math.min(now(env) + COOKIE_TTL, check.expires);
  const value = await sign(env, { k: 'cookie', sid: ticket.sid, email: ticket.email, exp });
  return redirect('/', setCookie(env, value, Math.max(1, Math.floor((exp - now(env)) / 1000))));
}

/** POST admin.worldmesh.net/auth/logout — forgets the dashboard cookie only. */
export function logout(env: Env): Response {
  return redirect(`${hubOrigin(env)}/`, setCookie(env, '', 0));
}

/** CSRF guard for the dashboard's few POSTs. */
export function isSameOrigin(request: Request, env: Env): boolean {
  const site = request.headers.get('Sec-Fetch-Site');
  if (site && site !== 'same-origin') return false;
  return request.headers.get('Origin') === adminOrigin(env);
}

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (cookie) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}
