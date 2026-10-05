/**
 * Sketchfab (https://sketchfab.com/developers). OAuth 2.0 authorization code
 * flow; the user's own models are listed from /v3/me/models. This is also
 * the way in for characters made with AI generators such as Meshy or Tripo:
 * their APIs delete results after days and have no user sign-in, so the
 * visitor uploads the rigged GLB to their own Sketchfab account instead.
 *
 * Loading a model: GET /v3/models/{uid}/download answers with short-lived
 * (about 5 minutes) presigned S3 URLs per archive. WorldMesh hands the GLB
 * URL to the world, whose browser downloads it from Sketchfab's storage
 * (which allows any origin). The file never passes through WorldMesh.
 *
 * Only the connected user's own models are offered, so the license question
 * is theirs to answer; `sourceUrl` points at the model page for credit.
 */
import type { Env } from '../auth';
import { pkceChallenge, randomToken } from './crypto';
import { dig, jsonObject, parseMetadata, providerFetch } from './net';
import { AvatarError, type AvatarProvider, type ConnectionRow, type ProviderAvatar, type ProviderContext } from './types';

export const SKETCHFAB = 'https://sketchfab.com';
export const SKETCHFAB_API = 'https://api.sketchfab.com';
/** Refresh this long before the access token expires (they last about a month). */
const REFRESH_MARGIN_MS = 60 * 60_000;
/** /v3/me/models pages are small; stop after this many. */
const MAX_PAGES = 5;
/** Sketchfab model and user ids. */
const UID = /^[a-f0-9]{32}$/;

interface SketchfabTokens {
  access: string;
  refresh: string | null;
  /** Unix ms. */
  expiresAt: number;
}

type Json = Record<string, unknown>;

export const sketchfabProvider: AvatarProvider = {
  id: 'sketchfab',
  label: 'Sketchfab',

  isConfigured: (env) => !!(env.SKETCHFAB_CLIENT_ID && env.SKETCHFAB_CLIENT_SECRET),

  async connect(ctx, { userId }) {
    const state = randomToken();
    const verifier = randomToken(48);
    const url = new URL('/oauth2/authorize/', SKETCHFAB);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: ctx.env.SKETCHFAB_CLIENT_ID!,
      redirect_uri: ctx.redirectUri,
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), flow: { provider: 'sketchfab', userId, state, verifier, expiresAt: Date.now() + 10 * 60_000 } };
  },

  async completeConnect(ctx, params, flow) {
    const code = params.get('code');
    if (!code) throw new AvatarError('Sketchfab did not authorize WorldMesh.');
    const tokens = await tokenRequest(ctx, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: ctx.redirectUri,
      code_verifier: flow.verifier,
    });
    if (!tokens) throw new AvatarError('Sketchfab refused the sign-in. Please try again.');
    const me = await api(ctx, tokens.access, '/v3/me');
    if (typeof me.uid !== 'string' || !UID.test(me.uid)) throw new AvatarError('Sketchfab did not say who you are.');
    const name = typeof me.displayName === 'string' && me.displayName ? me.displayName : me.username;
    return {
      providerAccountId: me.uid,
      displayName: typeof name === 'string' ? name : null,
      credentials: tokens,
    };
  },

  async disconnect(ctx, connection) {
    const tokens = await ctx.credentials<SketchfabTokens>(connection);
    if (!tokens) return;
    // Not in Sketchfab's docs, but their OAuth server answers the standard
    // revocation endpoint. Best effort: the connection is deleted either way.
    ctx.waitUntil(
      providerFetch(`${SKETCHFAB}/oauth2/revoke_token/`, {
        ownHost: new URL(ctx.origin).host,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: ctx.env.SKETCHFAB_CLIENT_ID ?? '',
          client_secret: ctx.env.SKETCHFAB_CLIENT_SECRET ?? '',
          token: tokens.access,
        }),
      }).catch(() => undefined),
    );
  },

  async listAvatars(ctx, connection) {
    const token = await accessToken(ctx, connection);
    const avatars: ProviderAvatar[] = [];
    let path: string | null = '/v3/me/models?count=24&sort_by=-createdAt';
    for (let page = 0; path && page < MAX_PAGES; page++) {
      const body = await api(ctx, token, path);
      const models = Array.isArray(body.results) ? (body.results as Json[]) : [];
      for (const model of models) {
        const avatar = toAvatar(model);
        if (avatar) avatars.push(avatar);
      }
      path = nextPage(body.next);
    }
    return avatars;
  },

  async getAvatar(ctx, connection, avatarId) {
    if (!UID.test(avatarId)) return null;
    const token = await accessToken(ctx, connection);
    const model = await api(ctx, token, `/v3/models/${avatarId}`, { allowNotFound: true });
    // Only the user's own models: those are the ones whose license the user can speak for.
    if (dig(model, 'user', 'uid') !== connection.provider_account_id) return null;
    return toAvatar(model);
  },

  async resolveAvatar(ctx, connection, avatar) {
    const token = await accessToken(ctx, connection);
    const download = await api(ctx, token, `/v3/models/${avatar.external_avatar_id}/download`);
    const raw = dig(download, 'glb', 'url');
    let modelUrl: URL | null = null;
    try {
      modelUrl = typeof raw === 'string' ? new URL(raw) : null;
    } catch {
      modelUrl = null;
    }
    // The glTF archive is a zip, which worlds cannot load; only GLB will do.
    if (!modelUrl || modelUrl.protocol !== 'https:') throw new AvatarError('Sketchfab did not provide this model as GLB.', 502);
    const expires = dig(download, 'glb', 'expires');
    const metadata = parseMetadata(avatar.metadata_json);
    return {
      provider: 'sketchfab',
      avatarId: avatar.external_avatar_id,
      name: avatar.display_name,
      thumbnail: avatar.thumbnail_url,
      format: 'glb',
      modelUrl: modelUrl.toString(),
      expiresAt: typeof expires === 'number' && expires > 0 ? new Date(Date.now() + expires * 1000).toISOString() : null,
      sourceUrl: typeof metadata.viewerUrl === 'string' ? metadata.viewerUrl : null,
    };
  },

  async refreshAuth(ctx, connection) {
    const tokens = await ctx.credentials<SketchfabTokens>(connection);
    if (!tokens) throw new AvatarError('Connect Sketchfab again.', 409, true);
    if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens;
    const renewed = tokens.refresh ? await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: tokens.refresh }) : null;
    if (!renewed) {
      await ctx.saveCredentials(connection, null);
      throw new AvatarError('Your Sketchfab connection expired. Connect it again.', 409, true);
    }
    const next: SketchfabTokens = { ...renewed, refresh: renewed.refresh ?? tokens.refresh };
    await ctx.saveCredentials(connection, next);
    return next;
  },
};

async function accessToken(ctx: ProviderContext, connection: ConnectionRow): Promise<string> {
  const tokens = (await sketchfabProvider.refreshAuth(ctx, connection)) as SketchfabTokens;
  return tokens.access;
}

async function tokenRequest(ctx: ProviderContext, params: Record<string, string>): Promise<SketchfabTokens | null> {
  const env: Env = ctx.env;
  const response = await providerFetch(`${SKETCHFAB}/oauth2/token/`, {
    ownHost: new URL(ctx.origin).host,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: env.SKETCHFAB_CLIENT_ID ?? '', client_secret: env.SKETCHFAB_CLIENT_SECRET ?? '', ...params }),
  });
  if (response.status >= 500) throw new AvatarError('Sketchfab is not answering. Try again later.', 502);
  if (response.status !== 200) return null;
  const body = jsonObject(response);
  if (!body || typeof body.access_token !== 'string') return null;
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    access: body.access_token,
    refresh: typeof body.refresh_token === 'string' ? body.refresh_token : null,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

async function api(ctx: ProviderContext, token: string, path: string, options: { allowNotFound?: boolean } = {}): Promise<Json> {
  const response = await providerFetch(`${SKETCHFAB_API}${path}`, {
    ownHost: new URL(ctx.origin).host,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    maxBytes: 2 * 1024 * 1024,
  });
  if (response.status === 401) throw new AvatarError('Your Sketchfab connection expired. Connect it again.', 409, true);
  if (response.status === 403) throw new AvatarError('Sketchfab does not allow WorldMesh to download this model.', 403);
  if (response.status === 404 && options.allowNotFound) return {};
  if (response.status === 429) throw new AvatarError('Sketchfab is rate limiting WorldMesh. Try again in a few minutes.', 503);
  if (response.status !== 200) throw new AvatarError('Sketchfab could not be reached.', 502);
  return jsonObject(response) ?? {};
}

/** The `next` link of a listing, only if it stays on the same listing endpoint. */
function nextPage(next: unknown): string | null {
  if (typeof next !== 'string') return null;
  try {
    const url = new URL(next);
    return url.origin === SKETCHFAB_API && url.pathname === '/v3/me/models' ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

function toAvatar(model: Json): ProviderAvatar | null {
  if (typeof model.uid !== 'string' || !UID.test(model.uid)) return null;
  // Models still processing, or whose GLB archive is missing, cannot be shown.
  const status = dig(model, 'status', 'processing');
  if (typeof status === 'string' && status !== 'SUCCEEDED') return null;
  const archives = model.archives;
  if (archives && typeof archives === 'object' && !dig(archives, 'glb')) return null;
  const viewerUrl = typeof model.viewerUrl === 'string' && model.viewerUrl.startsWith(`${SKETCHFAB}/`) ? model.viewerUrl : null;
  const size = dig(archives, 'glb', 'size');
  return {
    id: model.uid,
    name: typeof model.name === 'string' && model.name ? model.name : null,
    thumbnail: thumbnail(model),
    format: 'glb',
    metadata: {
      viewerUrl,
      animationCount: typeof model.animationCount === 'number' ? model.animationCount : null,
      glbBytes: typeof size === 'number' ? size : null,
      private: model.isPrivate === true,
    },
  };
}

/** The smallest https thumbnail at least 256 px wide, else the largest one. */
function thumbnail(model: Json): string | null {
  const images = dig(model, 'thumbnails', 'images');
  if (!Array.isArray(images)) return null;
  const usable = (images as Json[])
    .filter((i) => typeof i.url === 'string' && i.url.startsWith('https://') && typeof i.width === 'number')
    .sort((a, b) => (a.width as number) - (b.width as number));
  const pick = usable.find((i) => (i.width as number) >= 256) ?? usable[usable.length - 1];
  return pick ? (pick.url as string) : null;
}
