/**
 * Avatar Wallet endpoints, under /api/account/avatar (already routed to this
 * Worker on the hub's origin, so no extra Worker route is needed).
 *
 * Hub-only, same-origin and session-bound:
 *   GET  /wallet                     connected providers and the selected avatar (D1 only)
 *   GET  /connections/:id/avatars    live listing from the provider
 *   POST /connect/:provider          { handle?, upload? } → { url } to the provider's authorization page
 *   GET  /callback/:provider         provider redirect target
 *   POST /upload/session             → where the browser sends a model file (after authorizing an upload)
 *   POST /upload/finish              { name, format, vrmVersion, file } or { cancel: true } → { connectionId, avatar }
 *   POST /disconnect                 { connectionId }
 *   POST /select                     { connectionId, avatarId } or { avatarId: null }
 *   POST /handoff                    → { ticket, expiresAt } for worlds (see handoff.ts)
 *
 * For worlds on any origin, cookie-less:
 *   POST /resolve                    { ticket } → { avatar: AvatarDescriptor | null }
 *
 * For AT Protocol authorization servers:
 *   GET  /atproto/client-metadata.json
 */
import type { Auth, Env } from '../auth';
import { HttpError, isSameOrigin, json, readJson } from '../http';
import { atprotoClientMetadata, atprotoProvider } from './atproto';
import { open, seal } from './crypto';
import { mintTicket, readTicket } from './handoff';
import { UnsafeUrlError } from './net';
import { sketchfabProvider } from './sketchfab';
import * as store from './store';
import {
  AvatarError,
  type AvatarProvider,
  type AvatarProviderId,
  type ConnectionRow,
  type OAuthFlow,
  type ProviderContext,
  type UploadedModel,
} from './types';
import { vroidProvider } from './vroid';

export const AVATAR_BASE_PATH = '/api/account/avatar';

/** Display order in the wallet. Add a provider here and nowhere else. */
export const PROVIDERS: Record<AvatarProviderId, AvatarProvider> = {
  sketchfab: sketchfabProvider,
  vroid: vroidProvider,
  atproto: atprotoProvider,
};

export function avatarWalletEnabled(env: Env): boolean {
  return !!env.AVATAR_SECRET && env.AVATAR_SECRET.length >= 32;
}

function configuredProviders(env: Env): AvatarProvider[] {
  return avatarWalletEnabled(env) ? Object.values(PROVIDERS).filter((p) => p.isConfigured(env)) : [];
}

function providerFor(env: Env, id: string | undefined): AvatarProvider {
  const provider = configuredProviders(env).find((p) => p.id === id);
  if (!provider) throw new HttpError(404, 'Unknown avatar provider.');
  return provider;
}

export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export async function handleAvatarRequest(
  request: Request,
  env: Env,
  getAuth: () => Promise<Auth>,
  exec: WaitUntil,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice(AVATAR_BASE_PATH.length);
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  const method = request.method;

  if (path === '/resolve') return resolve(request, env, exec, origin);
  if (path === '/atproto/client-metadata.json' && method === 'GET') {
    return json(atprotoClientMetadata(origin, redirectUri(origin, 'atproto')));
  }
  if (!avatarWalletEnabled(env)) {
    if (path === '/wallet' && method === 'GET') return json({ enabled: false, providers: [], connections: [], selected: null });
    throw new HttpError(404, 'The Avatar Wallet is not set up.');
  }

  const callback = /^\/callback\/([a-z]+)$/.exec(path);
  if (callback && method === 'GET') return finishConnect(request, env, await getAuth(), exec, origin, callback[1]);

  if (method === 'POST' && !isSameOrigin(request, origin)) throw new HttpError(403, 'Cross-site request refused.');
  const session = await (await getAuth()).api.getSession({ headers: request.headers });
  if (!session) throw new HttpError(401, 'Sign in first.');
  const userId = session.user.id;
  // The connection being used, so a refused token can flag it for reconnecting.
  let using: ConnectionRow | null = null;

  try {
    if (path === '/wallet' && method === 'GET') return json(await wallet(env, userId));

    const listing = /^\/connections\/([A-Za-z0-9-]{1,64})\/avatars$/.exec(path);
    if (listing && method === 'GET') {
      const connection = (using = await store.connection(env.DB, userId, listing[1]));
      if (!connection) throw new HttpError(404, 'Not connected.');
      const provider = providerFor(env, connection.provider);
      return json({ avatars: await provider.listAvatars(context(env, exec, origin, provider.id), connection) });
    }

    const connect = /^\/connect\/([a-z]+)$/.exec(path);
    if (connect && method === 'POST') {
      const provider = providerFor(env, connect[1]);
      const body = (await readJson(request, 1024)) as { handle?: unknown; upload?: unknown } | null;
      let handle = typeof body?.handle === 'string' && body.handle.trim() ? body.handle.slice(0, 256) : undefined;
      const upload = body?.upload === true;
      if (upload) {
        if (!provider.uploads) throw new HttpError(400, 'Uploads are not available for this platform.');
        // Already connected: authorize the same account again, without asking who it is.
        handle ??= (await store.connectionsOf(env.DB, userId)).find((c) => c.provider === provider.id)?.provider_account_id;
        if (!handle) throw new HttpError(400, 'Enter your handle first.');
      }
      const { url: authorizeUrl, flow } = await provider.connect(context(env, exec, origin, provider.id), { userId, handle, upload });
      const sealed = await seal(env.AVATAR_SECRET, 'oauth-flow-v1', 'flow', flow);
      return json({ url: authorizeUrl }, 200, { 'Set-Cookie': flowCookie(origin, sealed, 600) });
    }

    if (path === '/disconnect' && method === 'POST') {
      const body = (await readJson(request, 1024)) as { connectionId?: unknown } | null;
      const connection = await store.connection(env.DB, userId, body?.connectionId);
      if (!connection) throw new HttpError(404, 'Not connected.');
      const provider = PROVIDERS[connection.provider];
      await provider.disconnect(context(env, exec, origin, provider.id), connection).catch(() => undefined);
      await store.deleteConnection(env.DB, userId, connection.id);
      return json(await wallet(env, userId));
    }

    if (path === '/select' && method === 'POST') {
      const body = (await readJson(request, 4096)) as { connectionId?: unknown; avatarId?: unknown } | null;
      if (body?.avatarId === null) {
        await store.clearSelection(env.DB, userId);
        return json(await wallet(env, userId));
      }
      const connection = (using = await store.connection(env.DB, userId, body?.connectionId));
      if (!connection) throw new HttpError(404, 'Not connected.');
      if (typeof body?.avatarId !== 'string' || body.avatarId.length > 1024) throw new HttpError(400, 'Choose an avatar.');
      const provider = providerFor(env, connection.provider);
      // Details come from the provider, never from the request.
      const avatar = await provider.getAvatar(context(env, exec, origin, provider.id), connection, body.avatarId);
      if (!avatar) throw new HttpError(404, 'That avatar is not available from this account.');
      await store.selectAvatar(env.DB, userId, connection, avatar);
      return json(await wallet(env, userId));
    }

    if (path === '/handoff' && method === 'POST') return json(await mintTicket(env.AVATAR_SECRET, userId));

    if (path === '/upload/session' && method === 'POST') {
      const pending = await readUploadGrant(request, env, origin, userId);
      const target = pending && PROVIDERS[pending.provider].uploads?.target(pending.grant);
      if (!target) throw new HttpError(409, 'Your upload permission ran out. Please choose the file again.');
      return json(target);
    }

    if (path === '/upload/finish' && method === 'POST') return await finishUpload(request, env, exec, origin, userId);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof UnsafeUrlError) throw new HttpError(400, 'That account points at a server WorldMesh will not contact.');
    if (!(error instanceof AvatarError)) {
      console.error('avatar provider request failed', error);
      throw new HttpError(502, 'The avatar platform could not be reached. Try again later.');
    }
    if (error.reconnect && using) await store.markReconnect(env.DB, using.id);
    throw new HttpError(error.status, error.message);
  }
  throw new HttpError(404, 'Not found.');
}

async function wallet(env: Env, userId: string) {
  const [connections, selected] = await Promise.all([store.connectionsOf(env.DB, userId), store.selectedAvatar(env.DB, userId)]);
  return {
    enabled: true,
    providers: configuredProviders(env).map((p) => ({ id: p.id, label: p.label, uploads: !!p.uploads })),
    connections: connections.map((c) => ({
      id: c.id,
      provider: c.provider,
      label: PROVIDERS[c.provider]?.label ?? c.provider,
      displayName: c.display_name,
      status: c.status,
    })),
    selected: selected
      ? {
          connectionId: selected.connection_id,
          provider: selected.provider,
          avatarId: selected.external_avatar_id,
          name: selected.display_name,
          thumbnail: selected.thumbnail_url,
          format: selected.format,
        }
      : null,
  };
}

async function finishConnect(request: Request, env: Env, auth: Auth, exec: WaitUntil, origin: string, providerId: string): Promise<Response> {
  const done = (outcome: 'connected' | 'upload' | 'error', reason?: string) => {
    const target = new URL('/', origin);
    target.searchParams.set('avatar', outcome);
    if (reason) target.searchParams.set('reason', reason);
    // The gallery, not the 3D lobby: the lobby hides <main>, and the wallet dialog with it.
    target.hash = 'list';
    const headers = new Headers({ Location: target.toString() });
    headers.append('Set-Cookie', flowCookie(origin, '', 0));
    return new Response(null, { status: 302, headers });
  };

  const params = new URL(request.url).searchParams;
  const sealed = readCookie(request, flowCookieName(origin));
  const flow = sealed ? await open<OAuthFlow>(env.AVATAR_SECRET, 'oauth-flow-v1', 'flow', sealed) : null;
  const session = await auth.api.getSession({ headers: request.headers });
  if (
    !flow ||
    flow.provider !== providerId ||
    flow.expiresAt < Date.now() ||
    !params.get('state') ||
    params.get('state') !== flow.state ||
    !session ||
    session.user.id !== flow.userId
  ) {
    return done('error');
  }
  if (params.get('error')) return done('error', params.get('error') === 'access_denied' ? 'denied' : undefined);

  try {
    const provider = providerFor(env, providerId);
    const ctx = context(env, exec, origin, provider.id);
    const account = await provider.completeConnect(ctx, params, flow);
    try {
      await store.saveConnection(env.DB, env.AVATAR_SECRET, flow.userId, provider.id, account);
    } catch (error) {
      if (account.uploadGrant) ctx.waitUntil(provider.uploads!.end(ctx, account.uploadGrant));
      throw error;
    }
    if (!account.uploadGrant) return done('connected');
    const sealed = await seal(env.AVATAR_SECRET, 'upload-grant-v1', flow.userId, {
      provider: provider.id,
      grant: account.uploadGrant,
    } satisfies PendingUpload);
    // Browsers drop cookies over 4 KB without a word; fail here rather than later.
    if (sealed.length > 3800) {
      ctx.waitUntil(provider.uploads!.end(ctx, account.uploadGrant));
      return done('error');
    }
    const response = done('upload');
    response.headers.append('Set-Cookie', uploadCookie(origin, sealed, UPLOAD_COOKIE_SECONDS));
    return response;
  } catch (error) {
    if (!(error instanceof AvatarError)) console.error('avatar connect failed', error);
    return done('error');
  }
}

// ── Upload from device ───────────────────────────────────────────────────────
// The browser sends the file straight to the provider with the grant's token;
// WorldMesh only creates the avatar record that points at it, then revokes the
// grant. The grant lives in a sealed, HttpOnly cookie bound to the user, never
// in D1.

interface PendingUpload {
  provider: AvatarProviderId;
  grant: unknown;
}

const UPLOAD_COOKIE_SECONDS = 15 * 60;

async function readUploadGrant(request: Request, env: Env, origin: string, userId: string): Promise<PendingUpload | null> {
  const sealed = readCookie(request, uploadCookieName(origin));
  const pending = sealed ? await open<PendingUpload>(env.AVATAR_SECRET, 'upload-grant-v1', userId, sealed) : null;
  return pending && PROVIDERS[pending.provider]?.uploads ? pending : null;
}

async function finishUpload(request: Request, env: Env, exec: WaitUntil, origin: string, userId: string): Promise<Response> {
  const body = (await readJson(request, 8192)) as Record<string, unknown> | null;
  const pending = await readUploadGrant(request, env, origin, userId);
  const clear = { 'Set-Cookie': uploadCookie(origin, '', 0) };
  if (!pending) {
    if (body?.cancel === true) return json({ cancelled: true }, 200, clear);
    throw new HttpError(409, 'Your upload permission ran out. Please choose the file again.');
  }
  const provider = PROVIDERS[pending.provider];
  const uploads = provider.uploads!;
  const ctx = context(env, exec, origin, provider.id);
  if (body?.cancel === true) {
    ctx.waitUntil(uploads.end(ctx, pending.grant));
    return json({ cancelled: true }, 200, clear);
  }

  try {
    const connection = (await store.connectionsOf(env.DB, userId)).find(
      (c) => c.provider === provider.id && c.provider_account_id === uploads.account(pending.grant),
    );
    if (!connection) throw new HttpError(409, 'Your upload permission ran out. Please choose the file again.');
    const format = body?.format;
    if (format !== 'vrm' && format !== 'glb') throw new HttpError(400, 'Choose a .vrm or .glb file.');
    const model: UploadedModel = {
      name: typeof body?.name === 'string' ? body.name.slice(0, 256) : null,
      format,
      vrmVersion: format === 'vrm' && (body?.vrmVersion === '0.x' || body?.vrmVersion === '1.0') ? body.vrmVersion : null,
      file: body?.file,
    };
    const avatar = await uploads.createAvatar(ctx, connection, pending.grant, model);
    return json({ connectionId: connection.id, avatar }, 200, clear);
  } catch (error) {
    if (error instanceof HttpError || error instanceof AvatarError) {
      return json({ error: error.message }, error.status, clear);
    }
    if (error instanceof UnsafeUrlError) return json({ error: 'That account points at a server WorldMesh will not contact.' }, 400, clear);
    console.error('avatar upload failed', error);
    return json({ error: 'Your account could not be reached. Try again later.' }, 502, clear);
  } finally {
    // One upload per grant, whatever happened. Only now: revoking ends the access token too.
    ctx.waitUntil(uploads.end(ctx, pending.grant));
  }
}

function uploadCookieName(origin: string): string {
  return origin.startsWith('https:') ? '__Secure-worldmesh.avatar_upload' : 'worldmesh.avatar_upload';
}

function uploadCookie(origin: string, value: string, maxAge: number): string {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `${uploadCookieName(origin)}=${value}; Path=${AVATAR_BASE_PATH}/upload; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

/** The world-facing endpoint: a ticket in, a descriptor out. No cookies, any origin. */
async function resolve(request: Request, env: Env, exec: WaitUntil, origin: string): Promise<Response> {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const reply = (data: unknown, status = 200) => json(data, status, cors);
  if (!avatarWalletEnabled(env)) return reply({ avatar: null });

  let userId: string | null;
  try {
    const body = (await readJson(request, 2048)) as { ticket?: unknown } | null;
    userId = await readTicket(env.AVATAR_SECRET, body?.ticket);
  } catch (error) {
    if (error instanceof HttpError) return reply({ error: error.message }, error.status);
    throw error;
  }
  if (!userId) return reply({ error: 'This avatar ticket is invalid or has expired.' }, 401);

  const avatar = await store.selectedAvatar(env.DB, userId);
  if (!avatar || avatar.connection_status !== 'active') return reply({ avatar: null });
  const connection = await store.connection(env.DB, userId, avatar.connection_id);
  const provider = connection && PROVIDERS[connection.provider];
  if (!connection || !provider?.isConfigured(env)) return reply({ avatar: null });
  try {
    return reply({ avatar: await provider.resolveAvatar(context(env, exec, origin, provider.id), connection, avatar) });
  } catch (error) {
    if (error instanceof AvatarError) {
      if (error.reconnect) await store.markReconnect(env.DB, connection.id);
      // The world falls back to its default body; it learns nothing more.
      return reply({ avatar: null });
    }
    console.error('avatar resolve failed', error);
    return reply({ avatar: null });
  }
}

function context(env: Env, exec: WaitUntil, origin: string, provider: AvatarProviderId): ProviderContext {
  return {
    env,
    origin,
    redirectUri: redirectUri(origin, provider),
    saveCredentials: (connection, credentials) => store.saveCredentials(env.DB, env.AVATAR_SECRET, connection, credentials),
    credentials: <T>(connection: ConnectionRow) =>
      connection.token_enc
        ? open<T>(env.AVATAR_SECRET, 'provider-token-v1', connection.id, connection.token_enc)
        : Promise.resolve(null),
    waitUntil: (promise) => exec.waitUntil(promise.catch(() => undefined)),
  };
}

function redirectUri(origin: string, provider: AvatarProviderId): string {
  return `${origin}${AVATAR_BASE_PATH}/callback/${provider}`;
}

// ── The OAuth flow cookie ────────────────────────────────────────────────────
// State, PKCE verifier (and for AT Protocol the DPoP key) ride in an encrypted,
// HttpOnly cookie scoped to the callback path: no D1 row per attempt, and the
// callback only succeeds in the browser that started it.

function flowCookieName(origin: string): string {
  return origin.startsWith('https:') ? '__Secure-worldmesh.avatar_flow' : 'worldmesh.avatar_flow';
}

function flowCookie(origin: string, value: string, maxAge: number): string {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `${flowCookieName(origin)}=${value}; Path=${AVATAR_BASE_PATH}/callback; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}
