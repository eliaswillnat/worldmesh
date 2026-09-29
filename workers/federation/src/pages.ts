/**
 * The human side of the URLs fediverse apps link to: a creator's profile
 * (https://worldmesh.net/@elias) and a world's canonical WorldMesh page
 * (https://worldmesh.net/@elias/worlds/<id>). The same URLs answer with
 * ActivityStreams when asked, so pasting them into Mastodon's search works.
 */
import { ensurePersonActor, escapeHtml, findCreatorByUsername, linkHtml, personDocument, type Creator } from './actors';
import { origin, type Env } from './env';
import { activityJson, errorResponse, htmlResponse, wantsActivityJson } from './http';

interface WorldRow {
  id: string;
  name: string;
  url: string;
  description: string | null;
  cover_url: string | null;
}

export async function profilePage(request: Request, env: Env, username: string): Promise<Response> {
  const creator = await findCreatorByUsername(env.DB, username.toLowerCase());
  if (!creator) return wantsActivityJson(request) ? errorResponse(404, 'Not found.') : notFoundPage(env);
  if (wantsActivityJson(request)) {
    const actor = await ensurePersonActor(env, creator.user_id);
    return activityJson(personDocument(env, actor, creator), 300);
  }
  const { results: worlds } = await env.DB.prepare(
    `select id, name, url, description, cover_url from world
     where owner_user_id = ? and status = 'published' order by published_at desc limit 50`,
  )
    .bind(creator.user_id)
    .all<WorldRow>();

  const items = worlds
    .map(
      (world) => `<li><a class="world" href="${escapeHtml(worldPath(creator, world))}">
        ${cover(world)}<span class="name">${escapeHtml(world.name)}</span>
        ${world.description ? `<span class="desc">${escapeHtml(world.description)}</span>` : ''}</a></li>`,
    )
    .join('');
  return htmlResponse(
    page(
      env,
      `${creator.name} (@${creator.username})`,
      `${header(env, creator)}
      ${creator.bio ? `<p class="bio">${escapeHtml(creator.bio)}</p>` : ''}
      ${creator.website_url ? `<p class="bio">${linkHtml(creator.website_url)}</p>` : ''}
      <p class="hint">Follow from Mastodon or any fediverse app: search for <code>@${escapeHtml(creator.username)}@${escapeHtml(env.FEDERATION_DOMAIN)}</code></p>
      ${items ? `<h2>Worlds</h2><ul class="worlds">${items}</ul>` : ''}`,
    ),
    200,
    300,
  );
}

export async function worldPage(request: Request, env: Env, username: string, worldId: string): Promise<Response> {
  const creator = await findCreatorByUsername(env.DB, username.toLowerCase());
  const world = creator
    ? await env.DB.prepare(
        "select id, name, url, description, cover_url from world where id = ? and owner_user_id = ? and status = 'published'",
      )
        .bind(worldId, creator.user_id)
        .first<WorldRow>()
    : null;

  if (wantsActivityJson(request)) {
    const note = world
      ? await env.DB.prepare('select json from ap_object where world_id = ?').bind(world.id).first<{ json: string }>()
      : null;
    return note ? activityJson(JSON.parse(note.json), 3600) : errorResponse(404, 'Not found.');
  }
  if (!creator || !world) return notFoundPage(env);
  return htmlResponse(
    page(
      env,
      world.name,
      `${cover(world, 'hero')}
      <h1>${escapeHtml(world.name)}</h1>
      <p class="by">by <a href="/@${escapeHtml(creator.username)}">${escapeHtml(creator.name)}</a></p>
      ${world.description ? `<p class="bio">${escapeHtml(world.description)}</p>` : ''}
      <p><a class="enter" href="${escapeHtml(safeHref(world.url))}" rel="noopener">Enter world</a></p>`,
    ),
    200,
    300,
  );
}

function header(env: Env, creator: Creator): string {
  const avatar = creator.avatar_url || creator.image;
  return `<div class="head">
    ${avatar && /^https:\/\//.test(avatar) ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="" referrerpolicy="no-referrer">` : ''}
    <div><h1>${escapeHtml(creator.name)}</h1><p class="handle">@${escapeHtml(creator.username)}@${escapeHtml(env.FEDERATION_DOMAIN)}</p></div>
  </div>`;
}

function cover(world: WorldRow, className = 'cover'): string {
  return world.cover_url && /^https:\/\//.test(world.cover_url)
    ? `<img class="${className}" src="${escapeHtml(world.cover_url)}" alt="" loading="lazy">`
    : '';
}

function worldPath(creator: Creator, world: WorldRow): string {
  return `/@${creator.username}/worlds/${encodeURIComponent(world.id)}`;
}

function safeHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : '#';
}

function notFoundPage(env: Env): Response {
  return htmlResponse(page(env, 'Not found', '<h1>Not found</h1><p class="bio">There is no one here by that name.</p>'), 404);
}

function page(env: Env, title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · WorldMesh</title>
<link href="https://fonts.googleapis.com/css2?family=Urbanist:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#fff;--text:oklch(.13 0 0);--muted:oklch(.55 0 0);--border:oklch(.92 0 0);--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#000;--text:oklch(.985 0 0);--muted:oklch(.65 0 0);--border:oklch(1 0 0/10%);--card:oklch(.16 0 0)}}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--text);font-family:Urbanist,ui-sans-serif,system-ui,sans-serif;padding:4vh 16px 80px;display:flex;justify-content:center;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:680px}.top{font-size:14px;letter-spacing:.26em;font-weight:600;color:var(--text);text-decoration:none;display:inline-block;margin-bottom:32px}
.head{display:flex;gap:16px;align-items:center;margin-bottom:16px}.avatar{width:64px;height:64px;border-radius:50%;object-fit:cover;border:1px solid var(--border)}
h1{font-size:26px;font-weight:600}.handle,.by,.hint{color:var(--muted);font-size:14px;margin-top:4px}.bio{color:var(--muted);line-height:1.5;margin:12px 0}
.hint{margin:20px 0}code{font-size:13px}a{color:inherit}h2{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--muted);margin:30px 0 16px}
.worlds{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}
.world{display:flex;flex-direction:column;gap:4px;text-decoration:none;background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;padding-bottom:12px}
.world .cover{width:100%;aspect-ratio:3/4;object-fit:cover}.world .name{font-weight:600;padding:0 12px}.world .desc{color:var(--muted);font-size:12px;padding:0 12px}
.hero{width:100%;max-width:360px;aspect-ratio:3/4;object-fit:cover;border-radius:16px;margin-bottom:16px}
.enter{display:inline-block;margin-top:12px;padding:12px 22px;border-radius:25px;border:1px solid var(--border);text-decoration:none}
</style></head><body><main><a class="top" href="${escapeHtml(origin(env))}/">WORLDMESH</a>${body}</main></body></html>`;
}
