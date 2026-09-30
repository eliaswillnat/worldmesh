/**
 * at3d on the AT Protocol (https://at3d.app/docs). Avatars are
 * `app.at3d.avatar` records in the user's own PDS, with the VRM or glTF
 * model stored there as a blob. Records and blobs are public: any world can
 * read them straight from the PDS (it answers with
 * Access-Control-Allow-Origin: *), so WorldMesh needs no token to list or
 * load them.
 *
 * AT Protocol OAuth (https://atproto.com/specs/oauth: PAR, PKCE, DPoP) is used
 * only to prove the user controls the DID. The tokens are revoked and
 * discarded right after the callback; what is stored is the DID, the handle
 * and the PDS URL.
 *
 * Every host here (the handle's domain, did:web hosts, the PDS, the
 * authorization server) is user-controlled, so each request goes through the
 * public-https-only fetch in ./net.
 */
import { base64url, pkceChallenge, randomToken, utf8 } from './crypto';
import { assertPublicUrl, jsonObject, providerFetch, type FetchResult } from './net';
import {
  AvatarError,
  type AvatarFormat,
  type AvatarProvider,
  type ConnectionRow,
  type ProviderAvatar,
} from './types';

export const AVATAR_COLLECTION = 'app.at3d.avatar';
const PLC_DIRECTORY = 'https://plc.directory';
const DOH = 'https://cloudflare-dns.com/dns-query';

const HANDLE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const DID = /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]{1,253})$/;
const RKEY = /^[a-zA-Z0-9._~:-]{1,512}$/;
const CID = /^[a-zA-Z0-9]{8,128}$/;

type Json = Record<string, unknown>;

interface AtprotoFlowExtra {
  did: string;
  handle: string;
  pds: string;
  issuer: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  dpopKey: JsonWebKey;
  dpopNonce: string | null;
  [key: string]: unknown;
}

export const atprotoProvider: AvatarProvider = {
  id: 'atproto',
  label: 'at3d',

  // Needs no client secret: WorldMesh is a public client that keeps no tokens.
  isConfigured: () => true,

  async connect(ctx, { userId, handle: input }) {
    const clientId = atprotoClientId(ctx.origin, ctx.redirectUri);
    const ownHost = new URL(ctx.origin).host;
    const identity = await resolveIdentity((input ?? '').trim().replace(/^@/, ''), ownHost);
    const server = await authorizationServer(identity.pds, ownHost);

    const state = randomToken();
    const verifier = randomToken(48);
    const key = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])) as CryptoKeyPair;
    const dpopKey = (await crypto.subtle.exportKey('jwk', key.privateKey)) as JsonWebKey;

    const par = await dpopPost(server.parEndpoint, dpopKey, null, ownHost, {
      client_id: clientId,
      response_type: 'code',
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: 'S256',
      state,
      redirect_uri: ctx.redirectUri,
      scope: 'atproto',
      login_hint: identity.handle ?? identity.did,
    });
    const requestUri = par.body?.request_uri;
    if ((par.response.status !== 201 && par.response.status !== 200) || typeof requestUri !== 'string') {
      throw new AvatarError('Your AT Protocol server refused the sign-in request.', 502);
    }

    const url = new URL(server.authorizationEndpoint);
    url.search = new URLSearchParams({ client_id: clientId, request_uri: requestUri }).toString();
    const extra: AtprotoFlowExtra = {
      did: identity.did,
      handle: identity.handle ?? identity.did,
      pds: identity.pds,
      issuer: server.issuer,
      tokenEndpoint: server.tokenEndpoint,
      revocationEndpoint: server.revocationEndpoint,
      dpopKey,
      dpopNonce: par.nonce,
    };
    return { url: url.toString(), flow: { provider: 'atproto', userId, state, verifier, expiresAt: Date.now() + 10 * 60_000, extra } };
  },

  async completeConnect(ctx, params, flow) {
    const extra = flow.extra as AtprotoFlowExtra | undefined;
    if (!extra) throw new AvatarError('Sign-in did not complete. Please try again.');
    // RFC 9207: the response must come from the server we sent the user to.
    if (params.get('iss') !== extra.issuer) throw new AvatarError('Sign-in came back from the wrong server.');
    const code = params.get('code');
    if (!code) throw new AvatarError('Your AT Protocol server did not authorize WorldMesh.');

    const ownHost = new URL(ctx.origin).host;
    const token = await dpopPost(extra.tokenEndpoint, extra.dpopKey, extra.dpopNonce, ownHost, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: ctx.redirectUri,
      code_verifier: flow.verifier,
      client_id: atprotoClientId(ctx.origin, ctx.redirectUri),
    });
    const body = token.body;
    if (token.response.status !== 200 || !body) throw new AvatarError('Your AT Protocol server refused the sign-in.', 502);

    // The account that signed in must be the one the handle resolved to, whose
    // PDS names this authorization server (checked before sending the user there).
    const scopes = typeof body.scope === 'string' ? body.scope.split(' ') : [];
    if (body.sub !== extra.did || !scopes.includes('atproto') || String(body.token_type).toLowerCase() !== 'dpop') {
      throw new AvatarError('Signed in as a different account than the handle you entered.');
    }

    // WorldMesh only needed to know who this is. Give the tokens back.
    const revoke = extra.revocationEndpoint;
    const secret = typeof body.refresh_token === 'string' ? body.refresh_token : body.access_token;
    if (revoke && typeof secret === 'string') {
      ctx.waitUntil(
        dpopPost(revoke, extra.dpopKey, token.nonce, ownHost, {
          token: secret,
          client_id: atprotoClientId(ctx.origin, ctx.redirectUri),
        }).catch(() => undefined),
      );
    }
    return { providerAccountId: extra.did, displayName: extra.handle, serviceEndpoint: extra.pds, credentials: null };
  },

  async disconnect() {
    // Nothing to revoke: no tokens were kept.
  },

  async listAvatars(ctx, connection) {
    const ownHost = new URL(ctx.origin).host;
    const pds = requirePds(connection);
    const url = new URL('/xrpc/com.atproto.repo.listRecords', pds);
    url.search = new URLSearchParams({ repo: connection.provider_account_id, collection: AVATAR_COLLECTION, limit: '100' }).toString();
    const result = await providerFetch(url.toString(), { ownHost, maxBytes: 1024 * 1024, headers: { Accept: 'application/json' } });
    if (result.status !== 200) throw new AvatarError('Your AT Protocol server could not be reached.', 502);
    const records = Array.isArray(jsonObject(result)?.records) ? (jsonObject(result)!.records as Json[]) : [];
    return records
      .map((record) => toAvatar(record, pds, connection.provider_account_id))
      .filter((a): a is ProviderAvatar => !!a);
  },

  async getAvatar(ctx, connection, avatarId) {
    const parsed = parseAvatarUri(avatarId);
    if (!parsed || parsed.did !== connection.provider_account_id) return null;
    const ownHost = new URL(ctx.origin).host;
    const pds = requirePds(connection);
    const url = new URL('/xrpc/com.atproto.repo.getRecord', pds);
    url.search = new URLSearchParams({ repo: parsed.did, collection: AVATAR_COLLECTION, rkey: parsed.rkey }).toString();
    const result = await providerFetch(url.toString(), { ownHost, maxBytes: 256 * 1024, headers: { Accept: 'application/json' } });
    if (result.status === 400 || result.status === 404) return null;
    if (result.status !== 200) throw new AvatarError('Your AT Protocol server could not be reached.', 502);
    const record = jsonObject(result);
    return record ? toAvatar(record, pds, parsed.did) : null;
  },

  async resolveAvatar(ctx, connection, avatar) {
    // Read the record again: the model may have been replaced since it was picked.
    const current = await atprotoProvider.getAvatar(ctx, connection, avatar.external_avatar_id);
    const model = current?.metadata?.modelCid;
    if (!current || typeof model !== 'string') throw new AvatarError('This avatar no longer exists.', 404);
    return {
      provider: 'atproto',
      avatarId: avatar.external_avatar_id,
      name: current.name ?? avatar.display_name,
      thumbnail: current.thumbnail,
      format: current.format,
      modelUrl: blobUrl(requirePds(connection), connection.provider_account_id, model),
      expiresAt: null,
      sourceUrl: null,
    };
  },

  async refreshAuth() {
    return null;
  },
};

// ── OAuth client ─────────────────────────────────────────────────────────────

export const CLIENT_METADATA_PATH = '/api/account/avatar/atproto/client-metadata.json';

function isLoopback(origin: string): boolean {
  const { protocol, hostname } = new URL(origin);
  return protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}

/**
 * The client_id is the URL of our metadata document. For local development
 * the spec's loopback client ("http://localhost" plus redirect_uri and scope)
 * is used instead, which requires the hub to run on http://127.0.0.1.
 */
export function atprotoClientId(origin: string, redirectUri: string): string {
  if (!isLoopback(origin)) return `${origin}${CLIENT_METADATA_PATH}`;
  if (new URL(origin).hostname === 'localhost') {
    throw new AvatarError('AT Protocol sign-in needs a loopback IP: open the hub at http://127.0.0.1:5170 (and set BETTER_AUTH_URL to it).');
  }
  return `http://localhost?${new URLSearchParams({ redirect_uri: redirectUri, scope: 'atproto' })}`;
}

export function atprotoClientMetadata(origin: string, redirectUri: string): Json {
  return {
    client_id: `${origin}${CLIENT_METADATA_PATH}`,
    client_name: 'WorldMesh',
    client_uri: origin,
    application_type: 'web',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    redirect_uris: [redirectUri],
    scope: 'atproto',
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
  };
}

interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  parEndpoint: string;
  revocationEndpoint: string | null;
}

async function authorizationServer(pds: string, ownHost: string): Promise<AuthorizationServer> {
  const resource = await getJson(new URL('/.well-known/oauth-protected-resource', pds).toString(), ownHost);
  const servers = resource?.authorization_servers;
  const issuerUrl = Array.isArray(servers) && typeof servers[0] === 'string' ? servers[0] : null;
  if (!issuerUrl) throw new AvatarError('Your AT Protocol server does not support OAuth sign-in yet.', 502);
  const origin = assertPublicUrl(issuerUrl, ownHost).origin;
  const meta = await getJson(`${origin}/.well-known/oauth-authorization-server`, ownHost);
  const endpoint = (name: string) => {
    const value = meta?.[name];
    return typeof value === 'string' ? assertPublicUrl(value, ownHost).toString() : null;
  };
  const authorizationEndpoint = endpoint('authorization_endpoint');
  const tokenEndpoint = endpoint('token_endpoint');
  const parEndpoint = endpoint('pushed_authorization_request_endpoint');
  const listed = (name: string, value: string) => !Array.isArray(meta?.[name]) || (meta![name] as unknown[]).includes(value);
  if (
    !meta ||
    meta.issuer !== origin ||
    !authorizationEndpoint ||
    !tokenEndpoint ||
    !parEndpoint ||
    meta.authorization_response_iss_parameter_supported !== true ||
    !listed('scopes_supported', 'atproto') ||
    !listed('dpop_signing_alg_values_supported', 'ES256')
  ) {
    throw new AvatarError('Your AT Protocol server does not support OAuth sign-in yet.', 502);
  }
  return { issuer: origin, authorizationEndpoint, tokenEndpoint, parEndpoint, revocationEndpoint: endpoint('revocation_endpoint') };
}

/**
 * A form POST with a DPoP proof. Authorization servers require a server
 * nonce: the first attempt usually fails with use_dpop_nonce and names it.
 */
async function dpopPost(
  endpoint: string,
  privateJwk: JsonWebKey,
  nonce: string | null,
  ownHost: string,
  form: Record<string, string>,
): Promise<{ response: FetchResult; body: Json | null; nonce: string | null }> {
  let current = nonce;
  for (let attempt = 0; ; attempt++) {
    const response = await providerFetch(endpoint, {
      ownHost,
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        DPoP: await dpopProof(privateJwk, 'POST', endpoint, current),
      },
      body: new URLSearchParams(form),
    });
    const body = jsonObject(response);
    current = response.headers.get('DPoP-Nonce') ?? current;
    if (attempt === 0 && response.status >= 400 && body?.error === 'use_dpop_nonce' && current) continue;
    return { response, body, nonce: current };
  }
}

async function dpopProof(privateJwk: JsonWebKey, method: string, url: string, nonce: string | null): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const target = new URL(url);
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: { kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y } };
  const payload: Json = {
    jti: randomToken(16),
    htm: method,
    htu: `${target.origin}${target.pathname}`,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;
  const input = `${base64url(utf8(JSON.stringify(header)))}.${base64url(utf8(JSON.stringify(payload)))}`;
  // WebCrypto's ECDSA signature is already the JWS (r || s) form.
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

// ── Identity ─────────────────────────────────────────────────────────────────

interface Identity {
  did: string;
  /** Present only when it verifies both ways (handle → DID and DID → handle). */
  handle: string | null;
  pds: string;
}

export async function resolveIdentity(input: string, ownHost: string): Promise<Identity> {
  if (DID.test(input)) {
    const doc = await resolveDid(input, ownHost);
    const claimed = doc.handles[0];
    const handle = claimed && (await resolveHandle(claimed, ownHost).catch(() => null)) === input ? claimed : null;
    return { did: input, handle, pds: doc.pds };
  }
  const handle = input.toLowerCase();
  if (!HANDLE.test(handle)) throw new AvatarError('Enter your handle, like alice.bsky.social.');
  const did = await resolveHandle(handle, ownHost);
  if (!did) throw new AvatarError(`Could not find ${handle}.`);
  const doc = await resolveDid(did, ownHost);
  if (!doc.handles.includes(handle)) throw new AvatarError(`${handle} does not verify. Check the handle and try again.`);
  return { did, handle, pds: doc.pds };
}

async function resolveHandle(handle: string, ownHost: string): Promise<string | null> {
  // DNS first: a TXT record at _atproto.<handle> saying did=<did>.
  try {
    const dns = await getJson(`${DOH}?${new URLSearchParams({ name: `_atproto.${handle}`, type: 'TXT' })}`, ownHost, {
      Accept: 'application/dns-json',
    });
    const answers = Array.isArray(dns?.Answer) ? (dns!.Answer as Json[]) : [];
    const dids = answers
      .map((answer) => (typeof answer.data === 'string' ? answer.data.replace(/^"|"$/g, '') : ''))
      .filter((data) => data.startsWith('did='))
      .map((data) => data.slice(4));
    if (dids.length === 1 && DID.test(dids[0])) return dids[0];
  } catch {
    // Fall through to the HTTPS method.
  }
  try {
    const result = await providerFetch(`https://${handle}/.well-known/atproto-did`, { ownHost, maxBytes: 2048 });
    const did = new TextDecoder().decode(result.body).trim();
    return result.status === 200 && DID.test(did) ? did : null;
  } catch {
    return null;
  }
}

async function resolveDid(did: string, ownHost: string): Promise<{ pds: string; handles: string[] }> {
  const url = did.startsWith('did:plc:')
    ? `${PLC_DIRECTORY}/${did}`
    : `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
  const doc = await getJson(url, ownHost);
  if (!doc || doc.id !== did) throw new AvatarError('Could not resolve your AT Protocol identity.', 502);
  const services = Array.isArray(doc.service) ? (doc.service as Json[]) : [];
  const pds = services.find(
    (s) => typeof s.id === 'string' && s.id.endsWith('#atproto_pds') && s.type === 'AtprotoPersonalDataServer',
  )?.serviceEndpoint;
  if (typeof pds !== 'string') throw new AvatarError('Your AT Protocol identity names no data server.', 502);
  const handles = (Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : [])
    .filter((aka): aka is string => typeof aka === 'string' && aka.startsWith('at://'))
    .map((aka) => aka.slice(5).toLowerCase());
  return { pds: assertPublicUrl(pds, ownHost).origin, handles };
}

async function getJson(url: string, ownHost: string, headers: Record<string, string> = { Accept: 'application/json' }): Promise<Json | null> {
  const result = await providerFetch(url, { ownHost, headers });
  return result.status === 200 ? jsonObject(result) : null;
}

// ── Records ──────────────────────────────────────────────────────────────────

function requirePds(connection: ConnectionRow): string {
  if (!connection.service_endpoint) throw new AvatarError('Connect at3d again.', 409, true);
  return connection.service_endpoint;
}

function parseAvatarUri(uri: string): { did: string; rkey: string } | null {
  const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
  if (!match || !DID.test(match[1]) || match[2] !== AVATAR_COLLECTION || !RKEY.test(match[3])) return null;
  return { did: match[1], rkey: match[3] };
}

function blobUrl(pds: string, did: string, cid: string): string {
  const url = new URL('/xrpc/com.atproto.sync.getBlob', pds);
  url.search = new URLSearchParams({ did, cid }).toString();
  return url.toString();
}

/** A blob reference's CID and MIME type, in the current or the legacy encoding. */
function blobRef(value: unknown): { cid: string; mimeType: string } | null {
  if (!value || typeof value !== 'object') return null;
  const blob = value as Json;
  const link = (blob.ref as Json | undefined)?.$link ?? blob.cid;
  if (typeof link !== 'string' || !CID.test(link)) return null;
  return { cid: link, mimeType: typeof blob.mimeType === 'string' ? blob.mimeType : '' };
}

/** Records the runtime can render: VRM and glTF avatars. Parametric ones are left out. */
function toAvatar(record: Json, pds: string, did: string): ProviderAvatar | null {
  const uri = record.uri;
  const value = record.value as Json | undefined;
  if (typeof uri !== 'string' || !value || parseAvatarUri(uri)?.did !== did) return null;
  const model = blobRef((value.appearance as Json | undefined)?.model);
  if (!model) return null;
  let format: AvatarFormat;
  if (value.format === 'vrm') format = 'vrm';
  else if (value.format === 'gltf') format = model.mimeType === 'model/gltf+json' ? 'gltf' : 'glb';
  else return null;
  const thumbnail = blobRef(value.thumbnail);
  const vrmVersion = (value.appearance as Json).vrmVersion;
  return {
    id: uri,
    name: typeof value.name === 'string' && value.name ? value.name.slice(0, 64) : null,
    thumbnail: thumbnail ? blobUrl(pds, did, thumbnail.cid) : null,
    format,
    metadata: { modelCid: model.cid, vrmVersion: typeof vrmVersion === 'string' ? vrmVersion : null },
  };
}
