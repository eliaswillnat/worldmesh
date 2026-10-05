/**
 * Edit a world before (or after) it is listed: cover, description, labels.
 *
 *   GET  /worlds/edit?id=…   the form, for a pending:* or approved:* entry
 *   POST /worlds/edit        save; "approve" also runs the hub's approve link,
 *                            which lists the world and emails its creator;
 *                            "reject" drops a pending submission
 *
 * The one place the dashboard writes, and only to the WORLDS directory.
 */
import categoryData from '../../../apps/hub/src/worlds/categories.json';
import { approveLink, type DirectoryEntry } from './data';
import { http, hubOrigin, type Env } from './env';
import { esc, htmlResponse, layout, link, panel } from './render';
import type { AdminSession } from './session';

const CATEGORIES = categoryData.categories as { id: string; name: string; tagline?: string }[];
const MAX_COVER_BYTES = 5 * 1024 * 1024;

export interface EditableEntry extends DirectoryEntry {
  categories?: string[];
  tags?: string[];
  color?: string;
  featured?: boolean;
}

type Found = { key: string; state: 'pending' | 'approved'; entry: EditableEntry };

async function find(env: Env, id: string): Promise<Found | null> {
  if (!env.WORLDS || !id) return null;
  for (const state of ['pending', 'approved'] as const) {
    const raw = await env.WORLDS.get(`${state}:${id}`);
    if (raw) return { key: `${state}:${id}`, state, entry: { ...(JSON.parse(raw) as EditableEntry), id } };
  }
  return null;
}

function notFound(env: Env, admin: AdminSession): Response {
  return htmlResponse(
    layout({ title: 'World not found', path: '/worlds', email: admin.email, hub: hubOrigin(env), body: '<p><a href="/worlds">Back to worlds</a></p>' }),
    404,
  );
}

export async function editPage(request: Request, env: Env, admin: AdminSession): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const found = await find(env, params.get('id') ?? '');
  if (!found) return notFound(env, admin);
  const { entry, state } = found;
  const message = params.get('saved') ? '<p class="notice">Saved.</p>' : params.get('error') ? `<p class="notice bad">${esc(params.get('error'))}</p>` : '';
  const chosen = new Set(entry.categories ?? []);
  const cover = entry.cover && /^https:\/\//.test(entry.cover) ? `<img class="edit-cover" src="${esc(entry.cover)}" alt="" referrerpolicy="no-referrer" />` : '<div class="edit-cover"></div>';

  const field = (label: string, name: keyof EditableEntry, hint = '') =>
    `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" value="${esc(entry[name] ?? '')}" />${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;

  const form = `<form class="edit" method="post" action="/worlds/edit" enctype="multipart/form-data">
  <input type="hidden" name="id" value="${esc(entry.id)}" />
  <p class="muted">${state === 'pending' ? 'Waiting for review' : 'Listed'} · ${link(entry.url)}${entry.email ? ` · ${esc(entry.email)}` : ''}</p>
  ${field('Name', 'name')}
  <label class="field"><span>Description</span><textarea name="description" rows="3">${esc(entry.description ?? '')}</textarea></label>
  <div class="field"><span>Cover (portrait 3:4)</span>
    <div class="cover-row">${cover}<div>
      <input name="cover" value="${esc(entry.cover ?? '')}" placeholder="https://…" />
      <input type="file" name="coverFile" accept="image/*" />
      <small class="muted">Upload a picture or paste an image URL. An upload replaces the URL.</small>
    </div></div>
  </div>
  <fieldset class="field"><legend>Towers</legend>${CATEGORIES.map(
    (c) => `<label class="check"><input type="checkbox" name="categories" value="${esc(c.id)}"${chosen.has(c.id) ? ' checked' : ''} /> ${esc(c.name)}</label>`,
  ).join('')}<small class="muted">None ticked: guessed from the name and description.</small></fieldset>
  ${field('Tags', 'tags', 'Comma-separated, e.g. multiplayer, racing')}
  ${field('Creator', 'creator')}
  ${field('Portfolio', 'portfolio')}
  ${field('Door colour', 'color', 'Optional, e.g. #8fd3c7')}
  <label class="check"><input type="checkbox" name="featured" value="1"${entry.featured ? ' checked' : ''} /> Featured</label>
  <div class="edit-actions">
    <button type="submit" name="action" value="save">Save</button>
    ${state === 'pending' ? '<button type="submit" name="action" value="approve" class="primary">Save and approve</button><button type="submit" name="action" value="reject" class="danger">Reject</button>' : ''}
  </div>
</form>`;

  return htmlResponse(
    layout({ title: entry.name ?? entry.id, path: '/worlds', email: admin.email, hub: hubOrigin(env), body: `<p><a href="/worlds">← Worlds</a></p>${message}${panel('Edit world', form)}` }),
  );
}

export async function saveEdit(request: Request, env: Env, admin: AdminSession): Promise<Response> {
  const form = await request.formData();
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const found = await find(env, text('id'));
  if (!found) return notFound(env, admin);
  const { entry, key, state } = found;
  const back = (query: string) => redirect(`/worlds/edit?id=${encodeURIComponent(entry.id)}&${query}`);
  const action = text('action');

  if (action === 'reject') {
    if (state !== 'pending') return back('error=Only+waiting+worlds+can+be+rejected');
    await env.WORLDS!.delete(key);
    return redirect('/worlds');
  }

  let cover = text('cover') || undefined;
  const file = form.get('coverFile');
  if (file && typeof file !== 'string' && file.size > 0) {
    if (!file.type.startsWith('image/')) return back('error=The+cover+must+be+an+image');
    if (file.size > MAX_COVER_BYTES) return back('error=The+cover+is+over+5+MB');
    const uploaded = await uploadCover(env, file, entry.url ?? '');
    if (!uploaded) return back('error=Could+not+upload+the+cover');
    cover = uploaded;
  }
  if (cover && !/^https:\/\//.test(cover)) return back('error=The+cover+URL+must+start+with+https%3A%2F%2F');

  const known = new Set(CATEGORIES.map((c) => c.id));
  const categories = form.getAll('categories').filter((v): v is string => typeof v === 'string' && known.has(v));
  const tags = text('tags')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const portfolio = text('portfolio');

  const next: EditableEntry = {
    ...entry,
    name: text('name') || entry.name,
    description: text('description') || undefined,
    cover,
    creator: text('creator') || undefined,
    portfolio: portfolio ? (/^https?:\/\//i.test(portfolio) ? portfolio : `https://${portfolio}`) : undefined,
    color: /^#[0-9a-f]{3,8}$/i.test(text('color')) ? text('color') : undefined,
    categories: categories.length ? categories : undefined,
    tags: tags.length ? tags : undefined,
    featured: form.get('featured') ? true : undefined,
  };
  const { id: _id, ...stored } = next;
  await env.WORLDS!.put(key, JSON.stringify(stored));

  if (action === 'approve' && state === 'pending') {
    // The hub's own approve link lists the world and emails its creator.
    const approve = approveLink(env, next);
    if (!approve) return back('error=This+submission+has+no+approve+token');
    const response = await http(env)(approve).catch(() => null);
    if (!response?.ok) return back('error=Saved%2C+but+approving+failed.+Try+again.');
    return redirect('/worlds');
  }
  return back('saved=1');
}

/** Same R2 bucket the hub's covers go to, through workers/screenshot. */
async function uploadCover(env: Env, file: File, worldUrl: string): Promise<string | null> {
  if (!env.SCREENSHOT_URL) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.SCREENSHOT_SECRET) headers.Authorization = `Bearer ${env.SCREENSHOT_SECRET}`;
  try {
    const response = await http(env)(env.SCREENSHOT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ image: `data:${file.type};base64,${btoa(binary)}`, url: worldUrl }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { url?: string };
    return data.url && /^https:\/\//.test(data.url) ? data.url : null;
  } catch {
    return null;
  }
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}
