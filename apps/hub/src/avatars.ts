/**
 * Avatar Wallet: "Choose your character" inside the account dialog.
 *
 * The visitor connects avatar platforms (Sketchfab, VRoid Hub, at3d), picks one avatar,
 * or continues without a character. WorldMesh stores only which avatar was
 * picked; the model stays on the platform. Talks to workers/auth under
 * /api/account/avatar over same-origin fetch.
 *
 * When a character is picked, the hub mints a short-lived handoff ticket and
 * adds it to world links as a URL fragment (#wm-avatar=…), which never reaches
 * any server. The world's runtime exchanges it for a descriptor of the model.
 */

interface WalletConnection {
  id: string;
  provider: string;
  label: string;
  displayName: string | null;
  status: 'active' | 'reconnect';
}

interface WalletAvatar {
  id: string;
  name: string | null;
  thumbnail: string | null;
  format: string;
}

interface Wallet {
  enabled: boolean;
  providers: { id: string; label: string }[];
  connections: WalletConnection[];
  selected: (WalletAvatar & { connectionId: string; provider: string; avatarId: string }) | null;
}

/** Not a credential: only a hint that minting a handoff ticket is worthwhile. */
const HINT_KEY = 'worldmesh.avatar';
/** Same key as AVATAR_TICKET_STORAGE_KEY in @worldmesh/runtime, so walk-mode portals carry it too. */
const TICKET_KEY = 'worldmesh.avatarTicket';
const TICKET_PARAM = 'wm-avatar';
const EMPTY_LISTING: Record<string, string> = {
  vroid: 'No models on your VRoid Hub account yet.',
  atproto: 'No at3d avatars on this account yet.',
  sketchfab: 'No models on your Sketchfab account yet. Upload a rigged GLB, for example one made with Meshy or Tripo.',
};

let wallet: Wallet | null = null;
let loadingWallet = false;
const listings = new Map<string, WalletAvatar[] | 'loading' | { error: string }>();
let busy = false;
let message: { text: string; error: boolean } | null = null;
let ticket: string | null = null;
let rerender: () => void = () => {};

/**
 * Wire up the wallet. Returns the outcome of a provider connection the
 * browser just came back from, so the account dialog can open on it.
 */
export function initAvatarWallet(onChange: () => void): 'connected' | 'error' | null {
  rerender = onChange;
  document.addEventListener('click', addTicketToWorldLink, true);
  document.addEventListener('auxclick', addTicketToWorldLink, true);

  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('avatar');
  if (outcome !== 'connected' && outcome !== 'error') return null;
  params.delete('avatar');
  params.delete('reason');
  const query = params.toString();
  history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  message =
    outcome === 'connected'
      ? { text: 'Connected. Pick your character below.', error: false }
      : { text: 'Connecting did not complete. Please try again.', error: true };
  return outcome;
}

/** Call whenever the account state changes. */
export function setSignedIn(signedIn: boolean): void {
  if (!signedIn) {
    wallet = null;
    listings.clear();
    setTicket(null);
    return;
  }
  if (hasHint() && !ticket) void mintTicket();
}

/** Account view: the current character and a way into the wallet. */
export function characterSummary(onChoose: () => void): HTMLElement {
  if (!wallet && !loadingWallet) void loadWallet();
  const section = document.createElement('div');
  if (wallet && !wallet.enabled) return section;
  section.className = 'wallet-summary';
  const selected = wallet?.selected ?? null;
  section.append(thumb(selected?.thumbnail ?? null, 'wallet-summary-thumb'));
  const text = document.createElement('div');
  text.className = 'wallet-summary-text';
  const label = document.createElement('p');
  label.className = 'wallet-summary-label';
  label.textContent = 'Character';
  const name = document.createElement('p');
  name.className = 'wallet-summary-name';
  name.textContent = selected ? selected.name || 'Unnamed avatar' : 'Default WorldMesh body';
  text.append(label, name);
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.textContent = 'Choose';
  choose.addEventListener('click', onChoose);
  section.append(text, choose);
  return section;
}

/** Wallet view: connected platforms, their avatars, and "Continue without character". */
export function walletView(onBack: () => void): HTMLElement[] {
  if (!wallet && !loadingWallet) void loadWallet();
  const nodes: HTMLElement[] = [heading('Choose your character')];
  const intro = document.createElement('p');
  intro.className = 'account-hint';
  intro.textContent =
    'Your character stays on the platform it comes from. WorldMesh only remembers which one you picked, and worlds only receive what they need to show it.';
  nodes.push(intro);

  if (!wallet) {
    nodes.push(note(loadingWallet ? 'Loading…' : 'The Avatar Wallet is unavailable right now.'));
  } else if (!wallet.enabled || !wallet.providers.length) {
    nodes.push(note('Characters are not available yet.'));
  } else {
    for (const provider of wallet.providers) {
      const connection = wallet.connections.find((c) => c.provider === provider.id);
      nodes.push(providerSection(provider, connection));
    }
    const none = document.createElement('button');
    none.type = 'button';
    none.className = 'wallet-none';
    none.dataset.selected = String(!wallet.selected);
    none.textContent = 'Continue without character';
    none.disabled = busy;
    none.addEventListener('click', () => void select(null, null));
    nodes.push(none);
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

function providerSection(provider: { id: string; label: string }, connection: WalletConnection | undefined): HTMLElement {
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
  const disconnect = document.createElement('button');
  disconnect.type = 'button';
  disconnect.className = 'wallet-link';
  disconnect.textContent = 'Disconnect';
  disconnect.disabled = busy;
  disconnect.addEventListener('click', () => void disconnectProvider(connection));
  header.append(disconnect);

  if (connection.status === 'reconnect') {
    section.append(note(`${provider.label} needs you to connect again.`), connectControls(provider, 'Reconnect'));
    return section;
  }

  const listing = listings.get(connection.id);
  if (!listing) void loadAvatars(connection);
  if (!listing || listing === 'loading') {
    section.append(note('Loading avatars…'));
  } else if ('error' in listing) {
    section.append(note(listing.error));
  } else if (!listing.length) {
    section.append(note(EMPTY_LISTING[provider.id] ?? 'No avatars on this account yet.'));
  } else {
    const grid = document.createElement('div');
    grid.className = 'wallet-grid';
    for (const avatar of listing) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'wallet-tile';
      const selected = wallet?.selected?.connectionId === connection.id && wallet.selected.avatarId === avatar.id;
      tile.dataset.selected = String(selected);
      tile.setAttribute('aria-pressed', String(selected));
      tile.disabled = busy;
      const name = document.createElement('span');
      name.textContent = avatar.name || 'Unnamed';
      tile.append(thumb(avatar.thumbnail, 'wallet-tile-thumb'), name);
      tile.title = `${avatar.name || 'Unnamed'} (${avatar.format.toUpperCase()})`;
      tile.addEventListener('click', () => void select(connection.id, avatar.id));
      grid.append(tile);
    }
    section.append(grid);
  }
  return section;
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
  const response = await fetch(`/api/account/avatar${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

async function loadWallet(): Promise<void> {
  loadingWallet = true;
  try {
    applyWallet(await api<Wallet>('/wallet'));
  } catch {
    wallet = null;
  } finally {
    loadingWallet = false;
    rerender();
  }
}

function applyWallet(next: Wallet): void {
  wallet = next;
  setHint(!!next.selected);
  if (next.selected) {
    if (!ticket) void mintTicket();
  } else {
    setTicket(null);
  }
  for (const id of [...listings.keys()]) {
    if (!next.connections.some((c) => c.id === id && c.status === 'active')) listings.delete(id);
  }
}

async function loadAvatars(connection: WalletConnection): Promise<void> {
  listings.set(connection.id, 'loading');
  try {
    const { avatars } = await api<{ avatars: WalletAvatar[] }>(`/connections/${encodeURIComponent(connection.id)}/avatars`);
    listings.set(connection.id, avatars);
  } catch (error) {
    listings.set(connection.id, { error: error instanceof Error ? error.message : 'Could not load avatars.' });
    // A refused token flips the connection to "reconnect"; show that.
    void loadWallet();
  }
  rerender();
}

async function connect(provider: string, handle?: string): Promise<void> {
  await run(async () => {
    const { url } = await api<{ url: string }>(`/connect/${provider}`, handle ? { handle } : {});
    window.location.assign(url);
  });
}

async function disconnectProvider(connection: WalletConnection): Promise<void> {
  if (!confirm(`Disconnect ${connection.label}? Your avatars stay on ${connection.label}.`)) return;
  await run(async () => {
    applyWallet(await api<Wallet>('/disconnect', { connectionId: connection.id }));
    listings.delete(connection.id);
  });
}

async function select(connectionId: string | null, avatarId: string | null): Promise<void> {
  await run(async () => {
    applyWallet(await api<Wallet>('/select', connectionId ? { connectionId, avatarId } : { avatarId: null }));
    message = wallet?.selected
      ? { text: `${wallet.selected.name || 'Your avatar'} will join you in compatible worlds.`, error: false }
      : { text: 'Worlds will show the default WorldMesh body.', error: false };
    announceCharacter();
  });
}

async function mintTicket(): Promise<void> {
  try {
    setTicket((await api<{ ticket: string }>('/handoff', {})).ticket);
  } catch {
    setTicket(null);
  }
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

// ── Handoff to worlds ────────────────────────────────────────────────────────

function setTicket(next: string | null): void {
  const changed = next !== ticket;
  ticket = next;
  try {
    if (next) sessionStorage.setItem(TICKET_KEY, next);
    else sessionStorage.removeItem(TICKET_KEY);
  } catch {
    // Storage blocked: world cards still get the ticket in memory.
  }
  if (changed) announceCharacter();
}

/** The handoff ticket for the visitor's character, if they picked one (walk mode loads it into the lobby). */
export function characterTicket(): string | null {
  if (ticket) return ticket;
  try {
    return sessionStorage.getItem(TICKET_KEY);
  } catch {
    return null;
  }
}

/** Walk mode listens for this to show the character just picked (or the default body again). */
export const CHARACTER_CHANGE_EVENT = 'worldmesh:character-change';

function announceCharacter(): void {
  window.dispatchEvent(new Event(CHARACTER_CHANGE_EVENT));
}

/**
 * Adds the ticket to a world card's link at the moment it is followed, then
 * puts the link back, so copying a link never copies a ticket.
 */
function addTicketToWorldLink(event: MouseEvent): void {
  if (!ticket || !(event.target instanceof Element)) return;
  const link = event.target.closest<HTMLAnchorElement>('.card > a[href]');
  if (!link) return;
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return;
  }
  if (!/^https?:$/.test(url.protocol) || url.origin === window.location.origin || url.hash) return;
  const original = link.href;
  url.hash = `${TICKET_PARAM}=${ticket}`;
  link.href = url.toString();
  setTimeout(() => {
    link.href = original;
  }, 0);
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

function hasHint(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
}

function setHint(on: boolean): void {
  try {
    if (on) localStorage.setItem(HINT_KEY, '1');
    else localStorage.removeItem(HINT_KEY);
  } catch {
    // Storage blocked: tickets are minted when the wallet is opened instead.
  }
}
