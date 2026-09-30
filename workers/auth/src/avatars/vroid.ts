/**
 * VRoid Hub (https://developer.vroid.com/en/api/). OAuth 2.0 with PKCE; the
 * user's own character models are listed from /api/account/character_models.
 *
 * Loading a model: POST /api/download_licenses issues a license bound to the
 * user, and GET /api/download_licenses/{id}/download answers with a redirect
 * to a short-lived S3 presigned URL. WorldMesh reads only that Location
 * header and hands the URL to the world, whose browser downloads the VRM from
 * VRoid's storage. The file never passes through WorldMesh.
 *
 * Licenses are for the issuing user. Showing someone's VRoid avatar to other
 * players (multiplayer) needs VRoid's separate Multiplay approval
 * (POST /api/download_licenses/multiplay); nothing here does that.
 */
import type { Env } from '../auth';
import { pkceChallenge, randomToken } from './crypto';
import { jsonObject, providerFetch } from './net';
import { AvatarError, type AvatarProvider, type ConnectionRow, type ProviderAvatar, type ProviderContext } from './types';

export const VROID_HUB = 'https://hub.vroid.com';
const API_VERSION = '11';
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 60_000;

interface VroidTokens {
  access: string;
  refresh: string | null;
  /** Unix ms. */
  expiresAt: number;
}

type Json = Record<string, unknown>;

export const vroidProvider: AvatarProvider = {
  id: 'vroid',
  label: 'VRoid Hub',

  isConfigured: (env) => !!(env.VROID_CLIENT_ID && env.VROID_CLIENT_SECRET),

  async connect(ctx, { userId }) {
    const state = randomToken();
    const verifier = randomToken(48);
    const url = new URL('/oauth/authorize', VROID_HUB);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: ctx.env.VROID_CLIENT_ID!,
      redirect_uri: ctx.redirectUri,
      scope: ctx.env.VROID_SCOPE || 'default',
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return { url: url.toString(), flow: { provider: 'vroid', userId, state, verifier, expiresAt: Date.now() + 10 * 60_000 } };
  },

  async completeConnect(ctx, params, flow) {
    const code = params.get('code');
    if (!code) throw new AvatarError('VRoid Hub did not authorize WorldMesh.');
    const tokens = await tokenRequest(ctx, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: ctx.redirectUri,
      code_verifier: flow.verifier,
    });
    if (!tokens) throw new AvatarError('VRoid Hub refused the sign-in. Please try again.');
    const account = await api(ctx, tokens.access, '/api/account');
    const user = (dig(account, 'data', 'user_detail', 'user') ?? {}) as Json;
    if (typeof user.id !== 'string' || !user.id) throw new AvatarError('VRoid Hub did not say who you are.');
    return {
      providerAccountId: user.id,
      displayName: typeof user.name === 'string' ? user.name : null,
      credentials: tokens,
    };
  },

  async disconnect(ctx, connection) {
    const tokens = await ctx.credentials<VroidTokens>(connection);
    if (!tokens) return;
    ctx.waitUntil(
      providerFetch(`${VROID_HUB}/oauth/revoke`, {
        ownHost: new URL(ctx.origin).host,
        method: 'POST',
        headers: { 'X-Api-Version': API_VERSION, 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${tokens.access}` },
        body: new URLSearchParams({
          client_id: ctx.env.VROID_CLIENT_ID ?? '',
          client_secret: ctx.env.VROID_CLIENT_SECRET ?? '',
          token: tokens.access,
        }),
      }).catch(() => undefined),
    );
  },

  async listAvatars(ctx, connection) {
    const token = await accessToken(ctx, connection);
    const body = await api(ctx, token, '/api/account/character_models?publication=all&count=100');
    const models = Array.isArray(body.data) ? (body.data as Json[]) : [];
    return models.map(toAvatar).filter((a): a is ProviderAvatar => !!a);
  },

  async getAvatar(ctx, connection, avatarId) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(avatarId)) return null;
    const token = await accessToken(ctx, connection);
    const body = await api(ctx, token, `/api/character_models/${avatarId}`, { allowNotFound: true });
    const model = dig(body, 'data', 'character_model') as Json | undefined;
    // Only the user's own models: those are the ones an unapproved app may load,
    // and the ones whose license the user can speak for.
    if (!model || dig(model, 'character', 'user', 'id') !== connection.provider_account_id) return null;
    return toAvatar(model);
  },

  async resolveAvatar(ctx, connection, avatar) {
    const token = await accessToken(ctx, connection);
    const license = await api(ctx, token, '/api/download_licenses', {
      method: 'POST',
      body: { character_model_id: avatar.external_avatar_id },
    });
    const licenseId = dig(license, 'data', 'id');
    if (typeof licenseId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(licenseId)) {
      throw new AvatarError('VRoid Hub would not license this model.', 502);
    }
    const download = await providerFetch(`${VROID_HUB}/api/download_licenses/${licenseId}/download`, {
      ownHost: new URL(ctx.origin).host,
      headers: { 'X-Api-Version': API_VERSION, Authorization: `Bearer ${token}` },
      redirect: 'manual',
    });
    checkAuth(download.status);
    const location = download.headers.get('Location');
    let modelUrl: URL | null = null;
    try {
      modelUrl = location ? new URL(location) : null;
    } catch {
      modelUrl = null;
    }
    if (download.status < 300 || download.status >= 400 || !modelUrl || modelUrl.protocol !== 'https:') {
      throw new AvatarError('VRoid Hub did not provide the model.', 502);
    }
    const expires = dig(license, 'data', 'expires_at');
    const metadata = parseMetadata(avatar.metadata_json);
    return {
      provider: 'vroid',
      avatarId: avatar.external_avatar_id,
      name: avatar.display_name,
      thumbnail: avatar.thumbnail_url,
      format: 'vrm',
      modelUrl: modelUrl.toString(),
      expiresAt: typeof expires === 'string' ? expires : null,
      sourceUrl:
        typeof metadata.characterId === 'string'
          ? `${VROID_HUB}/characters/${metadata.characterId}/models/${avatar.external_avatar_id}`
          : null,
    };
  },

  async refreshAuth(ctx, connection) {
    const tokens = await ctx.credentials<VroidTokens>(connection);
    if (!tokens) throw new AvatarError('Connect VRoid Hub again.', 409, true);
    if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens;
    if (!tokens.refresh) {
      await ctx.saveCredentials(connection, null);
      throw new AvatarError('Your VRoid Hub connection expired. Connect it again.', 409, true);
    }
    const renewed = await tokenRequest(ctx, { grant_type: 'refresh_token', refresh_token: tokens.refresh });
    if (!renewed) {
      await ctx.saveCredentials(connection, null);
      throw new AvatarError('Your VRoid Hub connection expired. Connect it again.', 409, true);
    }
    // VRoid may rotate the refresh token; keep the old one if it did not.
    const next: VroidTokens = { ...renewed, refresh: renewed.refresh ?? tokens.refresh };
    await ctx.saveCredentials(connection, next);
    return next;
  },
};

async function accessToken(ctx: ProviderContext, connection: ConnectionRow): Promise<string> {
  const tokens = (await vroidProvider.refreshAuth(ctx, connection)) as VroidTokens;
  return tokens.access;
}

async function tokenRequest(ctx: ProviderContext, params: Record<string, string>): Promise<VroidTokens | null> {
  const env: Env = ctx.env;
  const response = await providerFetch(`${VROID_HUB}/oauth/token`, {
    ownHost: new URL(ctx.origin).host,
    method: 'POST',
    headers: { 'X-Api-Version': API_VERSION, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: env.VROID_CLIENT_ID ?? '', client_secret: env.VROID_CLIENT_SECRET ?? '', ...params }),
  });
  if (response.status >= 500) throw new AvatarError('VRoid Hub is not answering. Try again later.', 502);
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

async function api(
  ctx: ProviderContext,
  token: string,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: unknown; allowNotFound?: boolean } = {},
): Promise<Json> {
  const response = await providerFetch(`${VROID_HUB}${path}`, {
    ownHost: new URL(ctx.origin).host,
    method: options.method ?? 'GET',
    headers: {
      'X-Api-Version': API_VERSION,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    maxBytes: 2 * 1024 * 1024,
  });
  checkAuth(response.status);
  if (response.status === 404 && options.allowNotFound) return {};
  if (response.status === 429) throw new AvatarError('VRoid Hub is rate limiting WorldMesh. Try again in a few minutes.', 503);
  if (response.status !== 200) throw new AvatarError('VRoid Hub could not be reached.', 502);
  return jsonObject(response) ?? {};
}

function checkAuth(status: number): void {
  if (status === 401) throw new AvatarError('Your VRoid Hub connection expired. Connect it again.', 409, true);
  if (status === 403) throw new AvatarError('VRoid Hub does not allow WorldMesh to use this model.', 403);
}

function toAvatar(model: Json): ProviderAvatar | null {
  if (typeof model.id !== 'string') return null;
  const character = (model.character ?? {}) as Json;
  const name = typeof model.name === 'string' && model.name ? model.name : typeof character.name === 'string' ? character.name : null;
  const thumbnail = dig(model, 'portrait_image', 'sq300', 'url') ?? dig(model, 'portrait_image', 'original', 'url');
  const version = dig(model, 'latest_character_model_version', 'spec_version');
  return {
    id: model.id,
    name,
    thumbnail: typeof thumbnail === 'string' && thumbnail.startsWith('https://') ? thumbnail : null,
    format: 'vrm',
    metadata: {
      characterId: typeof character.id === 'string' ? character.id : null,
      vrmVersion: typeof version === 'string' ? version : null,
      private: model.is_private === true,
    },
  };
}

function parseMetadata(json: string | null): Json {
  try {
    return (json ? JSON.parse(json) : {}) as Json;
  } catch {
    return {};
  }
}

function dig(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Json)[key];
  }
  return current;
}
