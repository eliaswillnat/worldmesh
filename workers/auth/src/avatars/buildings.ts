/**
 * "My buildings" endpoints, under /api/account/building (docs/specs/buildings.md
 * §4): models a user saves to stand in the hub city in place of their world's
 * block. They come through the Avatar Wallet's connections (Sketchfab, AT
 * Protocol) and, like characters, only pointers are kept: the model stays on
 * the platform. Uploading one goes through the wallet's upload grant, with
 * `{ upload: 'building' }` (./routes.ts).
 *
 * Hub-only, same-origin and session-bound:
 *   GET  /list                       platforms that hold buildings, their connections, and the saved buildings
 *   GET  /connections/:id/models     live listing from the platform
 *   POST /collect                    { connectionId, modelId } saves one (checked with the platform)
 *   POST /rename                     { buildingId, name } names it here; null goes back to the platform's name
 *   POST /remove                     { buildingId }
 */
import type { Auth, Env } from '../auth';
import { HttpError, isSameOrigin, json, readJson } from '../http';
import { UnsafeUrlError, parseMetadata } from './net';
import { avatarWalletEnabled, configuredProviders, context, PROVIDERS, providerFor, type WaitUntil } from './routes';
import * as store from './store';
import { AvatarError, type AvatarProvider, type ConnectionRow } from './types';

export const BUILDING_BASE_PATH = '/api/account/building';

/** Saved buildings per user. A world shows one; a few to try between is plenty. */
export const MAX_BUILDINGS = 20;
/** Longest name a saved building can be given. */
const MAX_NAME = 64;

/** The platforms that can hold buildings, as configured. */
function buildingProviders(env: Env): AvatarProvider[] {
  return configuredProviders(env).filter((provider) => provider.listBuildings && provider.getBuilding);
}

export async function handleBuildingRequest(request: Request, env: Env, getAuth: () => Promise<Auth>, exec: WaitUntil): Promise<Response> {
  const path = new URL(request.url).pathname.slice(BUILDING_BASE_PATH.length);
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  const method = request.method;

  if (!avatarWalletEnabled(env)) {
    if (path === '/list' && method === 'GET') return json({ enabled: false, providers: [], connections: [], buildings: [] });
    throw new HttpError(404, 'My buildings is not set up.');
  }
  if (method === 'POST' && !isSameOrigin(request, origin)) throw new HttpError(403, 'Cross-site request refused.');
  const session = await (await getAuth()).api.getSession({ headers: request.headers });
  if (!session) throw new HttpError(401, 'Sign in first.');
  const userId = session.user.id;
  // The connection being used, so a refused token can flag it for reconnecting.
  let using: ConnectionRow | null = null;

  try {
    if (path === '/list' && method === 'GET') return json(await buildings(env, userId));

    const listing = /^\/connections\/([A-Za-z0-9-]{1,64})\/models$/.exec(path);
    if (listing && method === 'GET') {
      const connection = (using = await store.connection(env.DB, userId, listing[1]));
      if (!connection) throw new HttpError(404, 'Not connected.');
      const provider = buildingProvider(env, connection);
      return json({ models: await provider.listBuildings!(context(env, exec, origin, provider.id), connection) });
    }

    if (path === '/collect' && method === 'POST') {
      const body = (await readJson(request, 4096)) as { connectionId?: unknown; modelId?: unknown } | null;
      const connection = (using = await store.connection(env.DB, userId, body?.connectionId));
      if (!connection) throw new HttpError(404, 'Not connected.');
      if (typeof body?.modelId !== 'string' || body.modelId.length > 1024) throw new HttpError(400, 'Choose a model.');
      if (!(await store.isBuildingSaved(env.DB, connection.id, body.modelId)) && (await store.buildingCount(env.DB, userId)) >= MAX_BUILDINGS) {
        throw new HttpError(409, `My buildings is full (${MAX_BUILDINGS}). Remove one first.`);
      }
      const provider = buildingProvider(env, connection);
      // Details come from the platform, never from the request.
      const model = await provider.getBuilding!(context(env, exec, origin, provider.id), connection, body.modelId);
      if (!model) throw new HttpError(404, 'That model is not available from this account.');
      await store.saveBuilding(env.DB, userId, connection, model);
      return json(await buildings(env, userId));
    }

    if (path === '/rename' && method === 'POST') {
      const body = (await readJson(request, 4096)) as { buildingId?: unknown; name?: unknown } | null;
      if (typeof body?.buildingId !== 'string') throw new HttpError(400, 'Choose a building.');
      if (body.name !== null && typeof body.name !== 'string') throw new HttpError(400, 'Enter a name.');
      const name = body.name?.replace(/\s+/g, ' ').trim() || null;
      if (name && name.length > MAX_NAME) throw new HttpError(400, `Names can be at most ${MAX_NAME} characters.`);
      const { meta } = await store.renameBuilding(env.DB, userId, body.buildingId, name);
      if (!meta.changes) throw new HttpError(404, 'That building is not in My buildings.');
      return json(await buildings(env, userId));
    }

    if (path === '/remove' && method === 'POST') {
      const body = (await readJson(request, 4096)) as { buildingId?: unknown } | null;
      if (typeof body?.buildingId !== 'string') throw new HttpError(400, 'Choose a building.');
      // No platform call: a building can be removed even after it disappeared there.
      await store.removeBuilding(env.DB, userId, body.buildingId);
      return json(await buildings(env, userId));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof UnsafeUrlError) throw new HttpError(400, 'That account points at a server WorldMesh will not contact.');
    if (!(error instanceof AvatarError)) {
      console.error('building provider request failed', error);
      throw new HttpError(502, 'The platform could not be reached. Try again later.');
    }
    if (error.reconnect && using) await store.markReconnect(env.DB, using.id);
    throw new HttpError(error.status, error.message);
  }
  throw new HttpError(404, 'Not found.');
}

function buildingProvider(env: Env, connection: ConnectionRow): AvatarProvider {
  const provider = providerFor(env, connection.provider);
  if (!provider.listBuildings || !provider.getBuilding) throw new HttpError(400, `${provider.label} does not hold buildings.`);
  return provider;
}

async function buildings(env: Env, userId: string) {
  const providers = buildingProviders(env);
  const [connections, saved] = await Promise.all([store.connectionsOf(env.DB, userId), store.buildingsOf(env.DB, userId)]);
  const label = (id: string) => PROVIDERS[id as keyof typeof PROVIDERS]?.buildingLabel ?? id;
  return {
    enabled: true,
    providers: providers.map((p) => ({ id: p.id, label: label(p.id) })),
    connections: connections
      .filter((c) => providers.some((p) => p.id === c.provider))
      .map((c) => ({ id: c.id, provider: c.provider, label: label(c.provider), displayName: c.display_name, status: c.status })),
    buildings: saved.map((b) => {
      const metadata = parseMetadata(b.metadata_json);
      return {
        id: b.id,
        connectionId: b.connection_id,
        provider: b.provider,
        modelId: b.external_id,
        name: b.custom_name ?? b.display_name,
        thumbnail: b.thumbnail_url,
        bytes: typeof metadata.bytes === 'number' ? metadata.bytes : null,
        sourceUrl: typeof metadata.sourceUrl === 'string' ? metadata.sourceUrl : null,
        reachable: b.connection_status === 'active',
      };
    }),
  };
}
