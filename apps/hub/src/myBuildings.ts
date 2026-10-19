/**
 * "My buildings" inside the account dialog (docs/specs/buildings.md §4): models
 * a visitor saves to stand in the hub city in place of their world's block.
 *
 * They come from the same platforms as characters, through the same
 * connections (Sketchfab, and AT Protocol for net.worldmesh.building
 * records), and only pointers are kept: the models stay on the platform.
 * Talks to workers/auth under /api/account/building, and to the Avatar
 * Wallet's endpoints to connect a platform or get permission to upload.
 *
 * A file is checked in the browser before it is uploaded, the way the city
 * checks it before showing it (./walk/buildingModel.ts), so its maker learns
 * straight away whether it will stand, and what door it will have.
 */

import { uploadBuildingToPds, type UploadGrant } from './at3dUpload';
import { uploadToSketchfab } from './sketchfabUpload';
import type { BuildingCheck } from './walk/buildingModel';

interface Connection {
  id: string;
  provider: string;
  label: string;
  displayName: string | null;
  status: 'active' | 'reconnect';
}

interface Model {
  id: string;
  name: string | null;
  thumbnail: string | null;
  bytes: number | null;
  sourceUrl: string | null;
}

/** A world a saved building stands on, or waits to (docs/specs/buildings.md §5). */
interface BuildingWorld {
  url: string;
  status: 'pending' | 'approved' | 'rejected' | 'hidden';
  reason: string | null;
}

interface SavedBuilding {
  id: string;
  connectionId: string;
  provider: string;
  modelId: string;
  name: string | null;
  thumbnail: string | null;
  bytes: number | null;
  sourceUrl: string | null;
  reachable: boolean;
  worlds: BuildingWorld[];
}

interface BuildingList {
  enabled: boolean;
  providers: { id: string; label: string }[];
  connections: Connection[];
  buildings: SavedBuilding[];
}

/** Same limit the city loads buildings with. */
const MAX_BYTES = 10 * 1024 * 1024;
/** Set while a platform's page is open for this view, so coming back lands here, not in characters. */
const RETURN_KEY = 'worldmesh.buildingsReturn';
const EMPTY_LISTING: Record<string, string> = {
  sketchfab: 'No models on your Sketchfab account yet. Upload a GLB below.',
  atproto: 'No buildings on this account yet. Upload a GLB below.',
};

let list: BuildingList | null = null;
let loadingList = false;
const listings = new Map<string, Model[] | 'loading' | { error: string }>();
let busy = false;
let message: { text: string; error: boolean } | null = null;
/** Back from approving an upload: the platform whose upload form is showing. */
let uploadReady: string | null = null;
let uploadFile: File | null = null;
let uploadName = '';
let uploading = false;
/** The chosen file, checked: null while checking or before one is chosen. */
let check: BuildingCheck | null = null;
let checking = false;
/** The saved building being put on a world, and the address typed so far. */
let linking: string | null = null;
let linkWorld = '';
let rerender: () => void = () => {};

/**
 * Wire it up. Returns the outcome of a platform trip begun from this view
 * (connecting, or approving an upload), so the account dialog can open on it.
 */
export function initBuildings(onChange: () => void): 'connected' | 'upload' | 'error' | null {
  rerender = onChange;
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('avatar');
  if (outcome !== 'connected' && outcome !== 'upload' && outcome !== 'error') return null;
  let ours = params.get('kind') === 'building';
  try {
    ours ||= sessionStorage.getItem(RETURN_KEY) === '1';
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // Storage blocked: only an upload approval finds its way back here.
  }
  if (!ours) return null;
  const provider = params.get('provider');
  const reason = params.get('reason');
  for (const key of ['avatar', 'provider', 'reason', 'kind']) params.delete(key);
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  uploadReady = outcome === 'upload' && provider ? provider : null;
  message =
    outcome === 'connected'
      ? { text: 'Connected. Save a model below, or upload one.', error: false }
      : outcome === 'upload'
        ? { text: 'Approved. Choose the GLB to upload.', error: false }
        : reason === 'other-account'
          ? { text: 'That approval was for a different account than the one connected here.', error: true }
          : { text: 'That did not complete. Please try again.', error: true };
  return outcome;
}

/** Call whenever the account state changes. */
export function setBuildingsSignedIn(signedIn: boolean): void {
  if (signedIn) return;
  list = null;
  listings.clear();
}

/** Account view: how many buildings are saved, and a way in. */
export function buildingsSummary(onManage: () => void): HTMLElement {
  if (!list && !loadingList) void loadList();
  const section = document.createElement('div');
  if (!list?.enabled || !list.providers.length) return section;
  section.className = 'wallet-summary';
  section.append(thumb(list.buildings[0]?.thumbnail ?? null, 'wallet-summary-thumb'));
  const text = document.createElement('div');
  text.className = 'wallet-summary-text';
  const label = document.createElement('p');
  label.className = 'wallet-summary-label';
  label.textContent = 'Buildings';
  const count = document.createElement('p');
  count.className = 'wallet-summary-name';
  const standing = list.buildings.reduce((n, b) => n + b.worlds.filter((w) => w.status === 'approved').length, 0);
  count.textContent = !list.buildings.length
    ? 'Your world as a building in the city'
    : standing
      ? `${list.buildings.length} saved · ${standing} in the city`
      : `${list.buildings.length} saved`;
  text.append(label, count);
  const manage = document.createElement('button');
  manage.type = 'button';
  manage.textContent = 'Manage';
  manage.addEventListener('click', onManage);
  section.append(text, manage);
  return section;
}

/** "My buildings": the saved ones, and each platform's models to save or upload. */
export function buildingsView(onBack: () => void): HTMLElement[] {
  if (!list && !loadingList) void loadList();
  const nodes: HTMLElement[] = [heading('My buildings')];
  nodes.push(
    note(
      "A building of your own can stand in the hub city in place of your world's block. Give the face visitors walk through a material named portal, and export it as a GLB of up to 10 MB.",
    ),
    note('Buildings stay on the platforms they come from. WorldMesh only remembers which ones you saved, and which worlds they stand on.'),
  );

  if (!list) {
    nodes.push(note(loadingList ? 'Loading…' : 'My buildings is unavailable right now.'));
  } else if (!list.enabled || !list.providers.length) {
    nodes.push(note('Buildings are not available yet.'));
  } else {
    nodes.push(savedSection(list));
    for (const provider of list.providers) {
      nodes.push(providerSection(provider, list.connections.find((c) => c.provider === provider.id)));
    }
  }

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'account-logout';
  back.textContent = 'Back';
  back.addEventListener('click', () => {
    message = null;
    onBack();
  });
  nodes.push(back);
  if (message) {
    const status = note(message.text);
    status.className = 'account-message';
    status.dataset.error = String(message.error);
    nodes.push(status);
  }
  return nodes;
}

function savedSection(current: BuildingList): HTMLElement {
  const section = document.createElement('section');
  section.className = 'wallet-provider';
  const header = document.createElement('div');
  header.className = 'wallet-provider-header';
  const title = document.createElement('h3');
  title.textContent = 'Saved';
  const count = document.createElement('span');
  count.className = 'wallet-provider-account';
  count.textContent = String(current.buildings.length);
  header.append(title, count);
  section.append(header);
  if (!current.buildings.length) {
    section.append(note('Save models from your platforms below to keep them here.'));
    return section;
  }
  const grid = document.createElement('div');
  grid.className = 'wallet-grid';
  for (const building of current.buildings) {
    grid.append(
      modelItem(
        building,
        building.reachable ? null : 'Connect this platform again',
        [
          {
            label: 'Use',
            title: 'Put it on one of your worlds',
            onClick: () => {
              linking = linking === building.id ? null : building.id;
              linkWorld = '';
              message = null;
              rerender();
            },
          },
          { label: 'Rename', onClick: () => void rename(building) },
          { label: 'Remove', onClick: () => void remove(building) },
        ],
      ),
    );
  }
  section.append(grid);
  const choosing = current.buildings.find((b) => b.id === linking);
  if (choosing) section.append(linkForm(choosing));
  const linked = current.buildings.flatMap((building) => building.worlds.map((world) => ({ building, world })));
  if (linked.length) section.append(worldsList(linked));
  return section;
}

const STATUS_TEXT: Record<BuildingWorld['status'], string> = {
  pending: 'In review',
  approved: 'In the city',
  rejected: 'Not approved',
  hidden: 'Taken down',
};

/** Which buildings stand on which worlds, and how their review went. */
function worldsList(linked: { building: SavedBuilding; world: BuildingWorld }[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'building-worlds';
  const title = document.createElement('h3');
  title.textContent = 'On your worlds';
  box.append(title);
  for (const { building, world } of linked) {
    const row = document.createElement('div');
    row.className = 'building-world';
    const where = document.createElement('a');
    where.className = 'building-world-url';
    where.href = world.url;
    where.target = '_blank';
    where.rel = 'noopener';
    where.textContent = `${building.name || 'Unnamed'} → ${world.url.replace(/^https:\/\//, '')}`;
    where.title = world.url;
    const status = document.createElement('span');
    status.className = 'building-world-status';
    status.dataset.status = world.status;
    status.textContent = STATUS_TEXT[world.status];
    const off = document.createElement('button');
    off.type = 'button';
    off.className = 'wallet-link';
    off.textContent = 'Take off';
    off.disabled = busy;
    off.setAttribute('aria-label', `Take ${building.name || 'the building'} off ${world.url}`);
    off.addEventListener('click', () => void unlink(building, world));
    row.append(where, status, off);
    box.append(row);
    if (world.reason && (world.status === 'rejected' || world.status === 'hidden' || world.status === 'pending')) {
      const reason = note(world.reason);
      reason.className = 'account-message';
      reason.dataset.error = String(world.status !== 'pending');
      box.append(reason);
    }
  }
  if (linked.some(({ world }) => world.status === 'pending')) {
    box.append(note('A person looks at each building before it stands in the city. That usually takes a day or two.'));
  }
  return box;
}

/**
 * Putting a building on a world: the world's own worldmesh.json names it,
 * which shows the world is yours wherever it is hosted, then WorldMesh
 * reads that file and the building goes to review.
 */
function linkForm(building: SavedBuilding): HTMLElement {
  const form = document.createElement('form');
  form.className = 'wallet-upload';
  const title = document.createElement('h3');
  title.textContent = `Put ${building.name || 'this building'} on a world`;
  const line = `"building": "${building.id}"`;
  const lineRow = document.createElement('div');
  lineRow.className = 'building-line';
  const code = document.createElement('code');
  code.textContent = line;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'wallet-link';
  copy.textContent = 'Copy';
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(line).then(
      () => {
        copy.textContent = 'Copied';
      },
      () => undefined,
    );
  });
  lineRow.append(code, copy);

  const input = document.createElement('input');
  input.type = 'url';
  input.placeholder = 'https://your-world.example';
  input.required = true;
  input.maxLength = 2048;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = linkWorld;
  input.setAttribute('aria-label', "Your world's address");
  input.disabled = busy;
  input.addEventListener('input', () => {
    linkWorld = input.value;
  });
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Link';
  submit.disabled = busy;
  const row = document.createElement('div');
  row.className = 'account-username-row';
  row.append(input, submit);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'wallet-link';
  cancel.textContent = 'Cancel';
  cancel.disabled = busy;
  cancel.addEventListener('click', () => {
    linking = null;
    linkWorld = '';
    rerender();
  });
  form.append(
    title,
    note("1. Add this line to your world's worldmesh.json (at /worldmesh.json or /.well-known/worldmesh.json):"),
    lineRow,
    note("2. Enter your world's address. WorldMesh reads that file to check, and a person reviews the building before it stands in the city."),
    row,
    cancel,
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void link(building, input.value);
  });
  return form;
}

function providerSection(provider: { id: string; label: string }, connection: Connection | undefined): HTMLElement {
  const section = document.createElement('section');
  section.className = 'wallet-provider';
  const header = document.createElement('div');
  header.className = 'wallet-provider-header';
  const title = document.createElement('h3');
  title.textContent = provider.label;
  header.append(title);
  section.append(header);

  if (!connection) {
    section.append(connectControls(provider));
    return section;
  }
  if (connection.displayName) {
    const who = document.createElement('span');
    who.className = 'wallet-provider-account';
    who.textContent = connection.displayName;
    header.append(who);
  }
  if (connection.status === 'reconnect') {
    section.append(note(`${provider.label} needs you to connect again.`), connectControls(provider, 'Reconnect'));
    return section;
  }

  section.append(uploadControls(connection));
  const listing = listings.get(connection.id);
  if (!listing) void loadModels(connection);
  if (!listing || listing === 'loading') {
    section.append(note('Loading models…'));
  } else if ('error' in listing) {
    section.append(note(listing.error));
  } else if (!listing.length) {
    section.append(note(EMPTY_LISTING[provider.id] ?? 'No models on this account yet.'));
  } else {
    const grid = document.createElement('div');
    grid.className = 'wallet-grid';
    for (const model of listing) {
      const saved = !!list?.buildings.some((b) => b.connectionId === connection.id && b.modelId === model.id);
      const tooLarge = model.bytes !== null && model.bytes > MAX_BYTES;
      grid.append(
        modelItem(model, tooLarge ? 'Over 10 MB' : null, [
          saved
            ? { label: 'Saved', disabled: true }
            : { label: 'Save', disabled: tooLarge, onClick: () => void collect(connection, model) },
        ]),
      );
    }
    section.append(grid);
  }
  return section;
}

/** A model's tile (opening its page on the platform, where it has one), with a note and actions under it. */
function modelItem(
  model: { name: string | null; thumbnail: string | null; bytes: number | null; sourceUrl: string | null },
  warning: string | null,
  actions: { label: string; title?: string; onClick?: () => void; disabled?: boolean }[],
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'wallet-item';
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'wallet-tile';
  const name = document.createElement('span');
  name.textContent = model.name || 'Unnamed';
  const size = document.createElement('span');
  size.textContent = warning ?? (model.bytes !== null ? fileSize(model.bytes) : 'GLB');
  tile.append(thumb(model.thumbnail, 'wallet-tile-thumb'), name, size);
  tile.disabled = !model.sourceUrl;
  tile.title = model.sourceUrl ? 'Open its page' : model.name || 'Unnamed';
  if (model.sourceUrl) tile.addEventListener('click', () => window.open(model.sourceUrl!, '_blank', 'noopener'));
  const row = document.createElement('div');
  row.className = 'wallet-item-actions';
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wallet-link wallet-item-action';
    button.textContent = action.label;
    button.disabled = busy || !!action.disabled;
    if (action.title) button.title = action.title;
    button.setAttribute('aria-label', `${action.title ?? action.label} ${model.name || 'unnamed building'}`);
    if (action.onClick) button.addEventListener('click', action.onClick);
    row.append(button);
  }
  item.append(tile, row);
  return item;
}

/** "Upload a building", or, once approved, the form that checks a GLB and sends it to the platform. */
function uploadControls(connection: Connection): HTMLElement {
  if (uploadReady !== connection.provider) {
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'account-provider';
    start.textContent = `Upload a building to ${connection.label}`;
    start.disabled = busy || !!uploadReady;
    start.addEventListener('click', () => void startUpload(connection));
    return start;
  }
  const form = document.createElement('form');
  form.className = 'wallet-upload';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.glb,model/gltf-binary';
  file.setAttribute('aria-label', 'Building model (GLB)');
  file.hidden = true;
  file.addEventListener('change', () => void chooseFile(file.files?.[0] ?? null));
  // The input is redrawn on every render and would forget the file: show our own button and label.
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'account-provider';
  pick.textContent = uploadFile ? 'Choose another file' : 'Choose GLB file';
  pick.disabled = busy || checking;
  pick.addEventListener('click', () => file.click());
  const chosen = note(
    uploadFile
      ? `${uploadFile.name} (${fileSize(uploadFile.size)})`
      : connection.provider === 'sketchfab'
        ? 'GLB, up to 10 MB. Uploaded as a draft that only you can see.'
        : 'GLB, up to 10 MB.',
  );
  form.append(file, pick, chosen);
  if (uploadFile) form.append(checkNote());

  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Building name';
  name.maxLength = 64;
  name.value = uploadName;
  name.setAttribute('aria-label', 'Building name');
  name.disabled = busy;
  name.addEventListener('input', () => {
    uploadName = name.value;
  });
  const row = document.createElement('div');
  row.className = 'account-username-row';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = uploading ? 'Uploading…' : 'Upload';
  submit.disabled = busy || !uploadFile || checking || !check || !!check.problem;
  row.append(name, submit);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'wallet-link';
  cancel.textContent = 'Cancel upload';
  cancel.disabled = busy;
  cancel.addEventListener('click', () => void cancelUpload());
  form.append(row, cancel);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void upload(connection);
  });
  return form;
}

/** What the check found: why it can't stand, or the door it will have. */
function checkNote(): HTMLElement {
  if (checking || !check) return note('Checking the model…');
  const status = note(
    check.problem
      ? `This model can't be a building: ${check.problem}`
      : check.door
        ? `Its portal face makes a ${check.door.width.toFixed(1)} × ${check.door.height.toFixed(1)} m door on a block. ${check.triangles.toLocaleString()} triangles.`
        : `No face has a material named portal, so a standard door will stand at its front. ${check.triangles.toLocaleString()} triangles.`,
  );
  status.className = 'account-message';
  status.dataset.error = String(!!check.problem);
  return status;
}

function connectControls(provider: { id: string; label: string }, verb = 'Connect'): HTMLElement {
  if (provider.id !== 'atproto') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account-provider';
    button.textContent = `${verb} ${provider.label}`;
    button.disabled = busy;
    button.addEventListener('click', () => void connect(provider.id));
    return button;
  }
  // AT Protocol accounts live on many servers: the handle says which one.
  const form = document.createElement('form');
  form.className = 'account-username-row';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'your.handle (e.g. alice.bsky.social)';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.required = true;
  input.maxLength = 253;
  input.setAttribute('aria-label', 'AT Protocol handle');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = verb;
  submit.disabled = busy;
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void connect(provider.id, input.value);
  });
  return form;
}

// ── Server calls ─────────────────────────────────────────────────────────────

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

const building = <T>(path: string, body?: unknown) => api<T>(`/api/account/building${path}`, body);
const wallet = <T>(path: string, body?: unknown) => api<T>(`/api/account/avatar${path}`, body);

async function loadList(): Promise<void> {
  loadingList = true;
  try {
    applyList(await building<BuildingList>('/list'));
  } catch {
    list = null;
  } finally {
    loadingList = false;
    rerender();
  }
}

function applyList(next: BuildingList): void {
  // A Worker deployed before links existed sends no worlds: none, then.
  for (const saved of next.buildings) saved.worlds ??= [];
  list = next;
  for (const id of [...listings.keys()]) {
    if (!next.connections.some((c) => c.id === id && c.status === 'active')) listings.delete(id);
  }
}

async function loadModels(connection: Connection): Promise<void> {
  listings.set(connection.id, 'loading');
  try {
    const { models } = await building<{ models: Model[] }>(`/connections/${encodeURIComponent(connection.id)}/models`);
    listings.set(connection.id, models);
  } catch (error) {
    listings.set(connection.id, { error: error instanceof Error ? error.message : 'Could not load models.' });
    // A refused token flips the connection to "reconnect"; show that.
    void loadList();
  }
  rerender();
}

/** Off to the platform's page; coming back opens this view again. */
function leaveFor(url: string): void {
  try {
    sessionStorage.setItem(RETURN_KEY, '1');
  } catch {
    // Coming back opens characters instead.
  }
  window.location.assign(url);
}

async function connect(provider: string, handle?: string): Promise<void> {
  await run(async () => {
    const { url } = await wallet<{ url: string }>(`/connect/${provider}`, handle ? { handle } : {});
    leaveFor(url);
  });
}

async function collect(connection: Connection, model: Model): Promise<void> {
  await run(async () => {
    applyList(await building<BuildingList>('/collect', { connectionId: connection.id, modelId: model.id }));
    message = { text: `${model.name || 'Building'} saved.`, error: false };
  });
}

async function rename(saved: SavedBuilding): Promise<void> {
  const input = prompt('Name this building (leave empty to use its name on the platform):', saved.name ?? '');
  if (input === null) return;
  const name = input.trim().slice(0, 64);
  await run(async () => {
    applyList(await building<BuildingList>('/rename', { buildingId: saved.id, name: name || null }));
    message = { text: name ? `Renamed to ${name}.` : 'Name reset to the one on its platform.', error: false };
  });
}

async function link(saved: SavedBuilding, world: string): Promise<void> {
  await run(async () => {
    applyList(await building<BuildingList>('/link', { buildingId: saved.id, world: world.trim() }));
    linking = null;
    linkWorld = '';
    message = { text: `${saved.name || 'Your building'} is linked. It stands in the city once it has been reviewed.`, error: false };
  });
}

async function unlink(saved: SavedBuilding, world: BuildingWorld): Promise<void> {
  if (!confirm(`Take ${saved.name || 'this building'} off ${world.url}? The world goes back to its plain block.`)) return;
  await run(async () => {
    applyList(await building<BuildingList>('/unlink', { buildingId: saved.id, world: world.url }));
    message = { text: 'Taken off. You can remove the "building" line from its worldmesh.json too.', error: false };
  });
}

async function remove(saved: SavedBuilding): Promise<void> {
  const where = saved.worlds.length ? ` It comes off ${saved.worlds.length === 1 ? 'its world' : `its ${saved.worlds.length} worlds`} too.` : '';
  if (!confirm(`Remove ${saved.name || 'this building'} from My buildings? It stays on its platform.${where}`)) return;
  await run(async () => {
    applyList(await building<BuildingList>('/remove', { buildingId: saved.id }));
    message = { text: `${saved.name || 'Building'} removed.`, error: false };
  });
}

async function startUpload(connection: Connection): Promise<void> {
  await run(async () => {
    const { url } = await wallet<{ url: string }>(`/connect/${connection.provider}`, { upload: 'building' });
    leaveFor(url);
  });
}

async function chooseFile(file: File | null): Promise<void> {
  uploadFile = file;
  check = null;
  if (!file) return rerender();
  if (!uploadName) uploadName = file.name.replace(/\.glb$/i, '').slice(0, 64);
  checking = true;
  rerender();
  try {
    // The checks bring three.js's loader along: only fetched once a file is chosen.
    const { inspectBuilding } = await import('./walk/buildingModel');
    const result = file.size > MAX_BYTES ? { problem: 'It is over 10 MB.', door: null, triangles: 0 } : await inspectBuilding(await file.arrayBuffer());
    if (uploadFile === file) check = result;
  } catch {
    if (uploadFile === file) check = { problem: 'It could not be read.', door: null, triangles: 0 };
  } finally {
    checking = false;
    rerender();
  }
}

async function upload(connection: Connection): Promise<void> {
  const file = uploadFile;
  if (!file || !check || check.problem) return;
  uploading = true;
  await run(async () => {
    const name = uploadName.trim() || 'My building';
    const grant = await wallet<UploadGrant>('/upload/grant', {});
    if (grant.provider !== connection.provider || grant.kind !== 'building') throw new Error('Start the upload again.');
    let id: string;
    try {
      id = grant.provider === 'sketchfab' ? await uploadToSketchfab(grant, file, name) : await uploadBuildingToPds(grant, file, name);
    } catch (error) {
      if (error instanceof TypeError) throw new Error(`${connection.label} could not be reached from this browser.`);
      throw error;
    }
    // The model is on the user's account now; give the permission back.
    await wallet('/upload/done', {}).catch(() => undefined);
    uploadReady = null;
    uploadFile = null;
    uploadName = '';
    check = null;
    listings.delete(connection.id);
    if (grant.provider === 'sketchfab') {
      // Sketchfab converts the model first; it shows up in the list once ready.
      message = { text: `${name} is uploaded to Sketchfab. It appears below in a few minutes, once Sketchfab has processed it.`, error: false };
      return;
    }
    applyList(await building<BuildingList>('/collect', { connectionId: connection.id, modelId: id }));
    message = { text: `${name} is uploaded to ${connection.label} and saved.`, error: false };
  });
  uploading = false;
  rerender();
}

async function cancelUpload(): Promise<void> {
  await run(async () => {
    await wallet('/upload/done', {});
    uploadReady = null;
    uploadFile = null;
    uploadName = '';
    check = null;
  });
}

async function run(task: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  message = null;
  rerender();
  try {
    await task();
  } catch (error) {
    message = { text: error instanceof Error ? error.message : 'Something went wrong.', error: true };
  } finally {
    busy = false;
    rerender();
  }
}

// ── Bits ─────────────────────────────────────────────────────────────────────

function heading(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.className = 'account-title';
  h.textContent = text;
  return h;
}

function note(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'account-hint';
  p.textContent = text;
  return p;
}

function fileSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function thumb(src: string | null, className: string): HTMLElement {
  if (src && src.startsWith('https://')) {
    const img = document.createElement('img');
    img.className = className;
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    return img;
  }
  const blank = document.createElement('span');
  blank.className = `${className} wallet-thumb-blank`;
  blank.setAttribute('aria-hidden', 'true');
  return blank;
}
