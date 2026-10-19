/**
 * "My buildings" endpoints, under /api/account/building (docs/specs/buildings.md
 * §4, §5, §7.2): models a user saves to stand in the hub city in place of their
 * world's block. They come through the Avatar Wallet's connections (Sketchfab, AT
 * Protocol) and, like characters, only pointers are kept: the model stays on
 * the platform. Uploading one goes through the wallet's upload grant, with
 * `{ upload: 'building' }` (./routes.ts).
 *
 * Hub-only, same-origin and session-bound:
 *   GET  /list                       platforms that hold buildings, their connections, and the saved buildings with their worlds
 *   GET  /connections/:id/models     live listing from the platform
 *   POST /collect                    { connectionId, modelId } saves one (checked with the platform)
 *   POST /rename                     { buildingId, name } names it here; null goes back to the platform's name
 *   POST /remove                     { buildingId }
 *   POST /link                       { buildingId, world } puts it on a world whose worldmesh.json names it, for review
 *   POST /unlink                     { buildingId, world }
 *   POST /report                     { world, reason, note } flags a building standing in the city (§8)
 *
 * Reviewers only (ADMIN_EMAILS), same-origin, used by the hub's review page:
 *   GET  /review/queue               links, waiting and reported ones first
 *   GET  /review?world=              one link, its building, owner and open reports, and where its file is now
 *   POST /review                     { world, buildingId, action: approve | reject | hide | dismiss, sha256, version, portal, reason }
 *
 * Public, cookie-less, any origin (the city, and other hubs):
 *   GET  /worlds                     worlds with an approved building, and the hash it must have
 *   POST /resolve                    { worlds: [url, …] } where to download each one's building now
 */
import type { Auth, Env } from '../auth';
import { isPlaceholderEmail } from '../atprotoSignIn';
import { HttpError, isSameOrigin, json, readJson } from '../http';
import { mailConfigured, sendMail } from '../mail';
import { canonicalWorldUrl, manifestBuilding, recheckStale, resolveWorlds } from './buildingLinks';
import { UnsafeUrlError, parseMetadata } from './net';
import { avatarWalletEnabled, configuredProviders, context, PROVIDERS, providerFor, type WaitUntil } from './routes';
import * as store from './store';
import { AvatarError, type AvatarProvider, type ConnectionRow } from './types';

export const BUILDING_BASE_PATH = '/api/account/building';

/** Saved buildings per user. A world shows one; a few to try between is plenty. */
export const MAX_BUILDINGS = 20;
/** Worlds a user's buildings can be linked to, all together. */
export const MAX_LINKS = 20;
/** Worlds per /resolve call. */
export const MAX_RESOLVE = 16;
/** Longest name a saved building can be given. */
const MAX_NAME = 64;
/** Same limit the city loads buildings with (§3.1). */
const MAX_BYTES = 10 * 1024 * 1024;
/** Longest reason a reviewer can give, or note a reporter can add. */
const MAX_REASON = 500;
/** How each report reason reads to reviewers. */
const REPORT_LABELS: Record<store.ReportReason, string> = {
  offensive: 'offensive or hateful',
  sexual: 'sexual content',
  violent: 'violent or graphic',
  copyright: "someone else's work",
  broken: 'broken or in the way',
  other: 'something else',
};

/** The platforms that can hold buildings, as configured. */
function buildingProviders(env: Env): AvatarProvider[] {
  return configuredProviders(env).filter((provider) => provider.listBuildings && provider.getBuilding);
}

export async function handleBuildingRequest(request: Request, env: Env, getAuth: () => Promise<Auth>, exec: WaitUntil): Promise<Response> {
  const path = new URL(request.url).pathname.slice(BUILDING_BASE_PATH.length);
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  const method = request.method;

  if (path === '/worlds' || path === '/resolve') return publicRequest(request, env, exec, origin, path);

  if (!avatarWalletEnabled(env)) {
    if (path === '/list' && method === 'GET') return json({ enabled: false, providers: [], connections: [], buildings: [] });
    throw new HttpError(404, 'My buildings is not set up.');
  }
  if (method === 'POST' && !isSameOrigin(request, origin)) throw new HttpError(403, 'Cross-site request refused.');
  const session = await (await getAuth()).api.getSession({ headers: request.headers });
  if (!session) throw new HttpError(401, 'Sign in first.');
  const userId = session.user.id;
  if (path === '/review' || path === '/review/queue') {
    if (!isReviewer(env, session.user)) throw new HttpError(403, 'Only reviewers can do that.');
    return review(request, env, exec, origin, path, session.user.email.toLowerCase());
  }
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
      // No platform call: a building can be removed even after it disappeared there. Its links go with it.
      await store.removeBuilding(env.DB, userId, body.buildingId);
      return json(await buildings(env, userId));
    }

    if (path === '/link' && method === 'POST') {
      const body = (await readJson(request, 4096)) as { buildingId?: unknown; world?: unknown } | null;
      await link(env, origin, userId, body?.buildingId, body?.world);
      return json(await buildings(env, userId));
    }

    if (path === '/report' && method === 'POST') {
      const body = (await readJson(request, 4096)) as { world?: unknown; reason?: unknown; note?: unknown } | null;
      const world = canonicalWorldUrl(body?.world);
      const reason = store.REPORT_REASONS.find((r) => r === body?.reason);
      if (!world || !reason) throw new HttpError(400, 'Choose what is wrong with it.');
      const note = typeof body?.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON) || null : null;
      const standing = await store.linkOf(env.DB, world);
      if (!standing || standing.status !== 'approved') throw new HttpError(404, 'That building is not standing in the city.');
      const { created, open } = await store.saveReport(env.DB, standing, userId, reason, note);
      // The first open report on it tells the reviewers; more pile up on the dashboard.
      if (created && open === 1) exec.waitUntil(tellReviewers(env, origin, standing.building_id, world, reason).catch((error) => console.error('report email failed', error)));
      return json({ ok: true, alreadyReported: !created });
    }

    if (path === '/unlink' && method === 'POST') {
      const body = (await readJson(request, 4096)) as { buildingId?: unknown; world?: unknown } | null;
      const world = canonicalWorldUrl(body?.world);
      if (typeof body?.buildingId !== 'string' || !world) throw new HttpError(400, 'Choose a world.');
      await store.unlink(env.DB, userId, body.buildingId, world);
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

/**
 * Puts a saved building on a world, waiting for review (§5.1). The world's
 * own manifest has to name the building first: that proves whoever links it
 * controls the world, wherever it is hosted.
 */
async function link(env: Env, origin: string, userId: string, buildingId: unknown, rawWorld: unknown): Promise<void> {
  const building = typeof buildingId === 'string' ? (await store.buildingsOf(env.DB, userId)).find((b) => b.id === buildingId) : undefined;
  if (!building) throw new HttpError(404, 'That building is not in My buildings.');
  const world = canonicalWorldUrl(rawWorld);
  if (!world) throw new HttpError(400, "Enter your world's address, starting with https://.");
  const bytes = parseMetadata(building.metadata_json).bytes;
  if (typeof bytes === 'number' && bytes > MAX_BYTES) throw new HttpError(400, 'This building is over 10 MB, so the city cannot show it.');

  const existing = await store.linkOf(env.DB, world);
  const same = existing?.building_id === building.id;
  if (same && existing.status === 'hidden') {
    throw new HttpError(409, `This building was taken down from that world${existing.reason ? `: ${existing.reason}` : '.'}`);
  }
  if (!same && (await store.linkCount(env.DB, userId)) >= MAX_LINKS) {
    throw new HttpError(409, `Your buildings stand on ${MAX_LINKS} worlds already. Take one off first.`);
  }

  let manifest: { read: boolean; building: string | null };
  try {
    manifest = await manifestBuilding(world, new URL(origin).host);
  } catch (error) {
    if (error instanceof UnsafeUrlError) throw new HttpError(400, 'WorldMesh cannot read that address. A world needs a public https address.');
    throw error;
  }
  const line = `"building": "${building.id}"`;
  if (!manifest.read) throw new HttpError(409, `No worldmesh.json found for ${world}. Add one with ${line}, then try again.`);
  if (manifest.building !== building.id) throw new HttpError(409, `The world's worldmesh.json does not name this building yet. Add ${line} to it, then try again.`);

  // Already on its way or standing: nothing to review again.
  if (same && (existing.status === 'pending' || existing.status === 'approved')) await store.touchLink(env.DB, world);
  else await store.saveLink(env.DB, world, building.id);
}

/** The city's endpoints: no cookies, any origin. */
async function publicRequest(request: Request, env: Env, exec: WaitUntil, origin: string, path: string): Promise<Response> {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const reply = (data: unknown, status = 200) => json(data, status, cors);

  if (path === '/worlds') {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    if (!avatarWalletEnabled(env)) return reply({ worlds: [] });
    // Visitors keep the list fresh: a day after a manifest was read, the next look reads it again.
    exec.waitUntil(recheckStale(env, origin).catch((error) => console.error('building re-check failed', error)));
    const worlds = await store.approvedLinks(env.DB);
    return reply({ worlds: worlds.map((link) => ({ url: link.world_url, sha256: link.sha256 })) });
  }

  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  if (!avatarWalletEnabled(env)) return reply({ buildings: {} });
  let worlds: string[];
  try {
    const body = (await readJson(request, 32 * 1024)) as { worlds?: unknown } | null;
    if (!Array.isArray(body?.worlds) || body.worlds.length > MAX_RESOLVE) throw new HttpError(400, `Send up to ${MAX_RESOLVE} world URLs.`);
    worlds = [...new Set(body.worlds.map(canonicalWorldUrl).filter((url): url is string => !!url))];
  } catch (error) {
    if (error instanceof HttpError) return reply({ error: error.message }, error.status);
    throw error;
  }
  return reply({ buildings: worlds.length ? await resolveWorlds(env, exec, origin, worlds) : {} });
}

/** The accounts that review buildings: ADMIN_EMAILS, lower-cased. */
function reviewerEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

/** Whether this account reviews buildings: a verified email in ADMIN_EMAILS. */
function isReviewer(env: Env, user: { email: string; emailVerified: boolean }): boolean {
  return user.emailVerified && reviewerEmails(env).includes(user.email.toLowerCase());
}

/**
 * Review (§5.2). The reviewer's own browser downloads the model, checks it
 * the way the city does, shows it on its block and hashes it; approving pins
 * that hash. The file never passes through here.
 */
async function review(request: Request, env: Env, exec: WaitUntil, origin: string, path: string, reviewer: string): Promise<Response> {
  if (path === '/review/queue') {
    if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    const links = await store.reviewQueue(env.DB);
    return json({
      links: links.map((link) => ({
        world: link.world_url,
        status: link.status,
        reason: link.reason,
        buildingId: link.building_id,
        buildingName: link.building_name,
        provider: link.provider,
        createdAt: link.created_at,
        updatedAt: link.updated_at,
        reviewedAt: link.reviewed_at,
        reports: Number(link.reports),
      })),
    });
  }

  if (request.method === 'GET') {
    const world = canonicalWorldUrl(new URL(request.url).searchParams.get('world'));
    const row = world && (await store.reviewLink(env.DB, world));
    if (!row) throw new HttpError(404, 'No building is linked to that world.');
    const metadata = parseMetadata(row.metadata_json);
    let file = null;
    let fileError: string | null = null;
    const provider = PROVIDERS[row.provider];
    if (row.c_status !== 'active') fileError = `The owner's ${provider?.buildingLabel ?? row.provider} connection needs reconnecting.`;
    else if (!provider?.isConfigured(env) || !provider.resolveBuilding) fileError = `${row.provider} is not set up here.`;
    else {
      try {
        file = await provider.resolveBuilding(context(env, exec, origin, provider.id), store.connectionFrom(row), row);
        if (!file) fileError = 'The model is no longer on its platform.';
      } catch (error) {
        if (error instanceof AvatarError) {
          if (error.reconnect) await store.markReconnect(env.DB, row.connection_id);
          fileError = error.message;
        } else {
          console.error('building review resolve failed', error);
          fileError = 'The platform could not be reached.';
        }
      }
    }
    return json({
      link: {
        world: row.world_url,
        status: row.status,
        reason: row.reason,
        sha256: row.sha256,
        version: row.version,
        createdAt: row.link_created_at,
        reviewedAt: row.reviewed_at,
        reviewedBy: row.reviewed_by,
      },
      building: {
        id: row.id,
        name: row.custom_name ?? row.display_name,
        provider: row.provider,
        providerLabel: provider?.buildingLabel ?? row.provider,
        modelId: row.external_id,
        thumbnail: row.thumbnail_url,
        bytes: typeof metadata.bytes === 'number' ? metadata.bytes : null,
        sourceUrl: typeof metadata.sourceUrl === 'string' ? metadata.sourceUrl : null,
      },
      owner: { name: row.owner_name, email: row.owner_email, username: row.owner_username },
      reports: (await store.openReports(env.DB, row.world_url, row.id)).map((report) => ({
        id: report.id,
        reason: report.reason,
        note: report.note,
        // Whether it was about the file standing now, or one approved before it.
        sameFile: !!report.sha256 && report.sha256 === row.sha256,
        createdAt: report.created_at,
        reporter: report.reporter_username ? `@${report.reporter_username}` : report.reporter_email && !isPlaceholderEmail(report.reporter_email) ? report.reporter_email : 'an account',
      })),
      file: file && { modelUrl: file.modelUrl, expiresAt: file.expiresAt ? new Date(file.expiresAt).toISOString() : null, version: file.version },
      fileError,
    });
  }

  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const body = (await readJson(request, 16 * 1024)) as {
    world?: unknown;
    buildingId?: unknown;
    action?: unknown;
    sha256?: unknown;
    version?: unknown;
    portal?: unknown;
    reason?: unknown;
  } | null;
  const world = canonicalWorldUrl(body?.world);
  if (!world || typeof body?.buildingId !== 'string') throw new HttpError(400, 'Choose a link.');
  const reason = typeof body.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON) : '';
  let decision: Parameters<typeof store.decideLink>[3];
  if (body.action === 'approve') {
    if (typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256)) throw new HttpError(400, 'Approving needs the hash of the file you checked.');
    if (body.version !== null && body.version !== undefined && (typeof body.version !== 'string' || body.version.length > 256)) {
      throw new HttpError(400, 'Unexpected file version.');
    }
    const portal = body.portal === undefined ? null : JSON.stringify(body.portal);
    if (portal && portal.length > 4096) throw new HttpError(400, 'Portal details too large.');
    decision = { status: 'approved', sha256: body.sha256, version: (body.version as string | null | undefined) ?? null, portalJson: portal, reason: null, by: reviewer };
  } else if (body.action === 'reject' || body.action === 'hide') {
    if (!reason) throw new HttpError(400, 'Give the owner a reason.');
    decision = { status: body.action === 'reject' ? 'rejected' : 'hidden', sha256: null, version: null, portalJson: null, reason, by: reviewer };
  } else if (body.action === 'dismiss') {
    // The reports were looked at and the building stays as it is.
    const { meta } = await store.resolveReports(env.DB, world, body.buildingId, 'dismissed', reviewer).run();
    return json({ ok: true, dismissed: meta.changes });
  } else {
    throw new HttpError(400, 'Approve, reject, hide or dismiss.');
  }
  const [{ meta }] = await env.DB.batch([
    store.decideLink(env.DB, world, body.buildingId, decision),
    // Taken down, its reports were acted on; approved again, they were looked at and set aside.
    store.resolveReports(env.DB, world, body.buildingId, decision.status === 'approved' ? 'dismissed' : 'actioned', reviewer),
  ]);
  if (!meta.changes) throw new HttpError(409, 'That world links a different building now. Load it again.');
  if (decision.status !== 'approved') {
    exec.waitUntil(tellOwner(env, origin, world, decision.status, decision.reason!).catch((error) => console.error('owner email failed', error)));
  }
  return json({ ok: true, status: decision.status });
}

/** Emails the reviewers about a building's first open report, where email is set up. */
async function tellReviewers(env: Env, origin: string, buildingId: string, world: string, reason: store.ReportReason): Promise<void> {
  if (!mailConfigured(env)) return;
  const row = await store.reviewLink(env.DB, world);
  const name = row?.id === buildingId ? (row.custom_name ?? row.display_name ?? 'A building') : 'A building';
  const intro = `${name}, standing on ${world} in the hub city, was reported as ${REPORT_LABELS[reason]}.`;
  const url = `${origin}/review-building?world=${encodeURIComponent(world)}`;
  for (const to of reviewerEmails(env)) await sendMail(env, to, 'A building in the city was reported', intro, 'Review it', url, null);
}

/** Tells a building's owner it was not approved, or was taken down, and why, where email is set up. */
async function tellOwner(env: Env, origin: string, world: string, status: 'rejected' | 'hidden', reason: string): Promise<void> {
  if (!mailConfigured(env)) return;
  const row = await store.reviewLink(env.DB, world);
  const verified = row?.owner_email_verified === 1 || row?.owner_email_verified === true;
  if (!row?.owner_email || !verified || isPlaceholderEmail(row.owner_email)) return;
  const name = row.custom_name ?? row.display_name ?? 'Your building';
  const intro =
    status === 'rejected'
      ? `${name} was not approved for ${world}: ${reason} You can fix it and link it again from My buildings.`
      : `${name} was taken down from ${world} in the hub city: ${reason}`;
  const subject = status === 'rejected' ? 'Your building was not approved' : 'Your building was taken down';
  await sendMail(env, row.owner_email, subject, intro, 'Open WorldMesh', `${origin}/`, null);
}

function buildingProvider(env: Env, connection: ConnectionRow): AvatarProvider {
  const provider = providerFor(env, connection.provider);
  if (!provider.listBuildings || !provider.getBuilding) throw new HttpError(400, `${provider.label} does not hold buildings.`);
  return provider;
}

async function buildings(env: Env, userId: string) {
  const providers = buildingProviders(env);
  const [connections, saved, links] = await Promise.all([
    store.connectionsOf(env.DB, userId),
    store.buildingsOf(env.DB, userId),
    store.linksOf(env.DB, userId),
  ]);
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
        worlds: links
          .filter((l) => l.building_id === b.id)
          .map((l) => ({ url: l.world_url, status: l.status, reason: l.reason })),
      };
    }),
  };
}
