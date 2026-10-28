/**
 * The hub is deliberately the least interesting part of WorldMesh.
 * It stores URLs. The worlds themselves live on their creators' own hosting,
 * and nothing here proxies, mirrors or re-hosts any of them.
 */

interface WorldEntry {
  id?: string;
  name: string;
  url: string;
  description?: string;
  color?: string;
  cover?: string;
  creator?: string;
  portfolio?: string;
  email?: string;
  submittedAt?: string;
  addedAt?: string;
  approvedAt?: string;
  /** Category ids (towers in walk mode). Guessed from the name and description when missing. */
  categories?: string[];
  tags?: string[];
  /** Short muted loop(s) shown on the world's door in walk mode. */
  preview?: string | string[];
  featured?: boolean;
  source?: 'admin' | 'submitted' | 'demo' | 'discovered';
}

import communityWorldsJson from './community.json';
import { createLobbyMusic } from './music/player';

/**
 * Dev only: VITE_DEV_WORLD_ORIGINS="https://leniverse.com=http://localhost:3000,…"
 * points listed worlds at local servers (same path and query), to try a
 * world's changes in the lobby.
 */
function devWorldUrls(worlds: WorldEntry[]): WorldEntry[] {
  const spec = import.meta.env.DEV ? (import.meta.env.VITE_DEV_WORLD_ORIGINS as string | undefined) : undefined;
  if (!spec) return worlds;
  const origins = new Map(spec.split(',').map((pair) => pair.split('=').map((origin) => origin.trim()) as [string, string]));
  return worlds.map((w) => {
    try {
      const url = new URL(w.url);
      const local = origins.get(url.origin);
      return local ? { ...w, url: local + url.pathname + url.search } : w;
    } catch {
      return w;
    }
  });
}
const communityWorldsStatic = devWorldUrls(communityWorldsJson as WorldEntry[]);
import { AD_CONFIG } from './ads/config';
import { entryIconSvg, formatEntries, hasEntries } from './entries';
import { HUB_VISIT_KEY, shouldCountHubVisit } from './hubVisit';
import { claimStaleBuildReload } from './staleBuild';

/**
 * Drawn live in a world's lobby portal (Doorway §3.1, docs/specs/doorway.md):
 * only the lobby, seen from that world's door. No gallery, no music, no
 * visit counted, and nothing taken from this tab's storage.
 */
const DOORWAY_VIEW = window.parent !== window && new URLSearchParams(window.location.search).has('doorway-view');
if (DOORWAY_VIEW) document.documentElement.classList.add('doorway-view');
/** The world a visitor came from through its lobby portal (`from`, which every portal adds), if any. */
const FROM_WORLD = ((from) => (from && /^https?:\/\//.test(from) ? from : null))(new URLSearchParams(window.location.search).get('from'));

const VIEWS_ENDPOINT = (import.meta.env.VITE_VIEWS_ENDPOINT as string | undefined)
  || (import.meta.env.DEV ? 'https://worldmesh-views.elias-willnat.workers.dev' : '/api/views');
const viewCounts: Record<string, number> = {};
const sessionViewed = new Map<string, number>();
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const DEMO_ADDED_AT = '2026-09-27T21:03:21Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_BADGE_DAYS = 7;
const SPOTLIGHT_MS = 48 * 60 * 60 * 1000;

// Clean up legacy local click counter and saved worlds from prototype
try {
  localStorage.removeItem('worldmesh.clicks');
  localStorage.removeItem('worldmesh.worlds');
} catch {
  // Ignore
}

/**
 * Set VITE_NOTIFY_WEBHOOK to a URL that accepts POST { name, url, description }
 * and delivers an email/notification. Works with Zapier, Make.com, n8n, or any
 * serverless function. Leave unset to skip notifications.
 */
const NOTIFY_WEBHOOK = import.meta.env.VITE_NOTIFY_WEBHOOK as string | undefined;
function getDemoWorldUrl(envKey: string, localPort: number, defaultSubdomain: string): string {
  const envVal = import.meta.env[envKey] as string | undefined;
  if (envVal) return envVal;
  if (import.meta.env.DEV) {
    return `http://localhost:${localPort}/`;
  }
  const baseDomain = import.meta.env.VITE_WORLDS_BASE_DOMAIN as string | undefined;
  if (baseDomain) {
    return `https://${defaultSubdomain}.${baseDomain}/`;
  }
  return `https://worldmesh-${defaultSubdomain}.pages.dev/`;
}

const DEMO_WORLDS: WorldEntry[] = [
  {
    name: 'Forest - Demo',
    url: getDemoWorldUrl('VITE_WORLD_FOREST_URL', 5171, 'forest'),
    description: 'Demo world. Pine clearing. Double jump enabled.',
    color: '#8cff9e',
    cover: '/covers/forest.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
    categories: ['explore'],
    tags: ['vr'],
    source: 'demo',
  },
  {
    name: 'Mars - Demo',
    url: getDemoWorldUrl('VITE_WORLD_MARS_URL', 5172, 'mars'),
    description: 'Demo world. Low gravity, long jumps, dash enabled.',
    color: '#ff8a5c',
    cover: '/covers/mars.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
    categories: ['space'],
    tags: ['vr'],
    source: 'demo',
  },
  {
    name: 'Neon City - Demo',
    url: getDemoWorldUrl('VITE_WORLD_CITY_URL', 5173, 'city'),
    description: 'Demo world. Night streets. Dash, double jump, crouch.',
    color: '#ff4fd8',
    cover: '/covers/city.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
    categories: ['explore'],
    tags: ['vr'],
    source: 'demo',
  },
  {
    name: 'Medieval Village - Demo',
    url: getDemoWorldUrl('VITE_WORLD_MEDIEVAL_URL', 5174, 'medieval'),
    description: 'Demo world. Baseline movement only. Starts in third person.',
    color: '#ffd36b',
    cover: '/covers/medieval.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
    categories: ['explore'],
    tags: ['vr'],
    source: 'demo',
  },
  {
    name: 'Space Station - Demo',
    url: getDemoWorldUrl('VITE_WORLD_SPACE_URL', 5175, 'space'),
    description: 'Demo world. Open deck in orbit. Flying enabled.',
    color: '#b08cff',
    cover: '/covers/space.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
    categories: ['space'],
    tags: ['vr'],
    source: 'demo',
  },
];

let communityWorlds: WorldEntry[] = communityWorldsStatic as WorldEntry[];
const ALL_WORLDS: WorldEntry[] = [...communityWorlds, ...DEMO_WORLDS];

/** Lobby doors: the five demos first, at the top of the street, then the community worlds (demos stay in the gallery too). */
function lobbyWorlds(): WorldEntry[] {
  return [...DEMO_WORLDS, ...communityWorlds];
}

import { accountDialogPending, beforeAccountDialogOpens, getAccountId, initAccount, onAccountChange } from './account';

initAccount();

/**
 * Whether walk-mode billboard ads are mounted. Defaults to `AD_CONFIG.enabled`
 * (off). Set `VITE_ADS_ENABLED=true` in the hub build env to turn them on
 * without editing source, or `=false` to force them off.
 */
function adsEnabled(): boolean {
  const env = import.meta.env.VITE_ADS_ENABLED as string | undefined;
  if (env === 'true') return true;
  if (env === 'false') return false;
  return AD_CONFIG.enabled;
}

// Back from a bank redirect in the middle of paying for a billboard ad (rare:
// card checks normally happen inside the payment form). Confirm with the server.
if (adsEnabled() && new URLSearchParams(window.location.search).has('ad_return')) {
  void import('./ads/modal')
    .then(({ resumeReturnedSubmission }) => resumeReturnedSubmission())
    .then((message) => {
      if (message) window.alert(message);
    });
}

const form = document.querySelector<HTMLFormElement>('#add-form')!;
const input = document.querySelector<HTMLInputElement>('#url')!;
const addBtn = document.querySelector<HTMLButtonElement>('#add-btn')!;
const botTrap = document.querySelector<HTMLInputElement>('#bot-trap');
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const creatorFields = document.querySelector<HTMLDivElement>('#creator-fields')!;
const creatorNameInput = document.querySelector<HTMLInputElement>('#creator-name')!;
const creatorEmailInput = document.querySelector<HTMLInputElement>('#creator-email')!;
const creatorPortfolioInput = document.querySelector<HTMLInputElement>('#creator-portfolio')!;
const creatorDescriptionInput = document.querySelector<HTMLInputElement>('#creator-description')!;
const submitWorldBtn = document.querySelector<HTMLButtonElement>('#submit-world')!;
const demoList = document.querySelector<HTMLUListElement>('#demo-worlds')!;
const multiplayerFilter = document.querySelector<HTMLButtonElement>('#filter-multiplayer')!;
let multiplayerOnly = false;
const isMultiplayer = (w: WorldEntry) => w.tags?.includes('multiplayer') ?? false;
multiplayerFilter.addEventListener('click', () => {
  multiplayerOnly = !multiplayerOnly;
  multiplayerFilter.setAttribute('aria-pressed', String(multiplayerOnly));
  render();
});

let pendingUrl: URL | null = null;
let pendingManifest: { name?: string; description?: string; cover?: string; creator?: string } | null = null;

function setAddingMode(active: boolean): void {
  if (active) {
    creatorFields.style.display = '';
    addBtn.textContent = 'Cancel';
    addBtn.type = 'button';
    addBtn.classList.add('btn-cancel');
  } else {
    creatorFields.style.display = 'none';
    addBtn.textContent = 'Add world';
    addBtn.type = 'submit';
    addBtn.classList.remove('btn-cancel');
    input.value = '';
    creatorNameInput.value = '';
    creatorEmailInput.value = '';
    creatorPortfolioInput.value = '';
    creatorDescriptionInput.value = '';
    pendingUrl = null;
    pendingManifest = null;
  }
}

addBtn.addEventListener('click', () => {
  if (addBtn.type === 'button') {
    setAddingMode(false);
    setStatus('');
    input.focus();
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && creatorFields.style.display !== 'none') {
    setAddingMode(false);
    setStatus('');
    input.focus();
  }
});

// ── Mobile: a top-right menu with Add world, account and appearance ──────────
const mobileQuery = window.matchMedia('(max-width: 600px)');
const menuToggle = document.querySelector<HTMLButtonElement>('#mobile-menu-toggle')!;
const menu = document.querySelector<HTMLDivElement>('#mobile-menu')!;
const accountButton = document.querySelector<HTMLButtonElement>('#account-button')!;
const menuAccount = document.querySelector<HTMLButtonElement>('#menu-account')!;
let userScrolled = false;
for (const ev of ['touchstart', 'wheel', 'keydown'] as const) {
  window.addEventListener(ev, () => { userScrolled = true; }, { once: true, passive: true });
}

function setMenuOpen(open: boolean): void {
  document.documentElement.classList.toggle('menu-open', open);
  menuToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    // Mirror the account button's current state (Log in, or the signed-in name).
    menuAccount.textContent = accountButton.getAttribute('aria-label')?.startsWith('Account') ? 'Account & settings' : 'Log in';
  }
}

menuToggle.addEventListener('click', () => {
  if (document.documentElement.classList.contains('mobile-adding')) setMobileAdding(false);
  else setMenuOpen(!document.documentElement.classList.contains('menu-open'));
});
document.addEventListener('click', (e) => {
  const t = e.target as Node;
  if (!menu.contains(t) && !menuToggle.contains(t)) setMenuOpen(false);
});
document.querySelector('#menu-add')!.addEventListener('click', () => {
  setMenuOpen(false);
  setMobileAdding(true);
});
menuAccount.addEventListener('click', () => {
  setMenuOpen(false);
  accountButton.click();
});

// Appearance: System follows the device; Light/Dark are remembered per browser.
const THEME_KEY = 'worldmesh.theme';
type ThemeChoice = 'system' | 'light' | 'dark';

function themeButtons(): NodeListOf<HTMLButtonElement> {
  return document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]');
}

function applyThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.dataset.default ??= meta.content;
    const color = choice === 'system' ? meta.dataset.default : choice === 'light' ? '#ffffff' : '#000000';
    meta.dataset.original = color;
    if (!walkRoot) meta.content = color;
  }
  for (const b of themeButtons()) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice));
  applyWalkTheme();
}

document.addEventListener('click', (event) => {
  const b = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-theme-choice]') : null;
  if (!b?.dataset.themeChoice) return;
  const choice = b.dataset.themeChoice as ThemeChoice;
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch { /* Storage blocked: the choice lasts this visit. */ }
  applyThemeChoice(choice);
});

function setMobileAdding(open: boolean): void {
  userScrolled = true;
  document.documentElement.classList.toggle('mobile-adding', open);
  menuToggle.setAttribute('aria-label', open ? 'Close' : 'Account and menu');
  if (open) {
    document.querySelector('main')!.scrollTo({ top: 0, behavior: 'smooth' });
    input.focus({ preventScroll: true });
  } else {
    setAddingMode(false);
    setStatus('');
    snapFirstCard();
  }
}

// Cards fill the space below the pinned header.
const siteHeader = document.querySelector<HTMLElement>('#site-header')!;
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--header-h', `${siteHeader.offsetHeight}px`);
}).observe(siteHeader);

// The header slides away while scrolling down and comes back on any scroll up.
// Desktop scrolls the window; phones scroll <main>.
let lastScrollY = 0;
function onScroll(y: number): void {
  const hide = y > lastScrollY && y > siteHeader.offsetHeight;
  if (Math.abs(y - lastScrollY) > 4 || y <= 0) {
    document.documentElement.classList.toggle('header-hidden', hide);
    lastScrollY = y;
  }
}
window.addEventListener('scroll', () => onScroll(window.scrollY), { passive: true });
document.querySelector('main')!.addEventListener('scroll', (e) => onScroll((e.target as HTMLElement).scrollTop), { passive: true });

// On mobile the page opens with the first card already snapped into view.
function snapFirstCard(): void {
  if (!mobileQuery.matches || document.documentElement.classList.contains('mobile-adding')) return;
  demoList.firstElementChild?.scrollIntoView({ block: 'start' });
}

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
render();

const communityLoaded = fetchCommunityWorlds();
// Count this visit to the hub (production only; QA can opt out). Display still loads the public total.
if (!DOORWAY_VIEW) recordHubVisit();

// ── Walk mode ────────────────────────────────────────────────────────────────
// The same directory as a place: one street with a door per world. Three.js
// and the runtime load only when someone asks for it.

const walkToggle = document.querySelector<HTMLButtonElement>('#walk-toggle')!;
const walkColors = document.querySelector<HTMLDivElement>('#walk-colors')!;
/** How long walk mode waits for the full world list before bringing someone out of a world's door. */
const COMMUNITY_WAIT_MS = 2000;
/** Where someone left the lobby into a world, so coming back puts them there. This tab only. */
const WALK_RETURN_KEY = 'worldmesh.walkReturn';
/** Default-character tints. White is the ordinary body; the rest are a short visit-only palette. */
const WALK_COLORS = ['#f4f4f4', '#8ec8ff', '#9ee6b0', '#ffc48a', '#f0a8cc', '#c4b0ff'];
let walkColor = WALK_COLORS[0];
let walkRoot: HTMLDivElement | null = null;
/** Music in the lobby: the playlist and credits come from music/tracks.ts. */
const lobbyMusic = createLobbyMusic();
lobbyMusic.onChange(showLobbyMusic);
let lobby: import('./walk/lobby').Lobby | null = null;
let walkLoading = false;
/** The centered Gallery mode button was pressed while the lobby was still loading. */
let walkAbandoned = false;
const lightScheme = window.matchMedia('(prefers-color-scheme: light)');

/**
 * Each visitor's lobby follows their own device's appearance setting. It only
 * changes how this browser draws the scene, so other visitors are unaffected.
 */
function walkIsLight(): boolean {
  const forced = document.documentElement.dataset.theme;
  return forced ? forced === 'light' : lightScheme.matches;
}

function applyWalkTheme(): void {
  if (!walkRoot) return;
  const light = walkIsLight();
  document.documentElement.dataset.walkTheme = light ? 'light' : 'dark';
  setThemeColor(light ? '#f2f2f2' : '#000000');
  lobby?.setTheme(light);
}

lightScheme.addEventListener('change', applyWalkTheme);

applyThemeChoice((document.documentElement.dataset.theme as ThemeChoice | undefined) ?? 'system');

walkToggle.addEventListener('pointerenter', () => {
  void import('./walk/lobby');
}, { once: true });

walkToggle.addEventListener('click', () => {
  if (walkRoot) void confirmLeaveWalk();
  else enterWalkMode();
});
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.walk-gallery')) void confirmLeaveWalk();
  // Shown only while the lobby is slow to appear, so no need to ask: drop it, loaded or not.
  if (target?.closest('.walk-stalled-gallery')) {
    walkAbandoned = walkLoading;
    exitWalkMode();
  }
});

// The account dialog lives in the gallery, which walk mode covers: whenever
// it opens (back from a platform's page, a new account choosing its
// username), the gallery comes back first, even mid-load.
beforeAccountDialogOpens(() => {
  if (!walkRoot && !walkLoading) return;
  walkAbandoned = walkLoading;
  exitWalkMode();
});

// Walk mode is the front door. The gallery is there when someone asks for
// the list, or comes back to the account dialog. Back from a world entered
// through a door: into the lobby, outside that door, however they came back.
const walkReturn = DOORWAY_VIEW ? null : takeWalkReturn();
if (DOORWAY_VIEW) enterWalkMode();
else if (accountDialogPending()) {
  // index.html may already have dressed the page for walking.
  document.documentElement.classList.remove('walking', 'walk-stalled');
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}#list`);
} else if (window.location.hash !== '#list' || walkReturn) enterWalkMode(walkReturn?.spot ?? null, walkReturn?.color ?? null);

// A back-button return can restore the page with the lobby still running; it
// puts the visitor back itself, so the stored spot is no longer needed.
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !DOORWAY_VIEW) takeWalkReturn();
});

async function enterWalkMode(start: import('./walk/lobby').WalkSpot | null = null, color: string | null = null): Promise<void> {
  if (walkRoot || walkLoading) return;
  walkLoading = true;
  walkAbandoned = false;
  walkToggle.disabled = true;
  let imported = false;
  try {
    const [{ createLobby }] = await Promise.all([
      import('./walk/lobby'),
      // Back through a world's lobby portal: its door is looked up once, so let the full list in first.
      FROM_WORLD && !start && !DOORWAY_VIEW ? Promise.race([communityLoaded, new Promise((resolve) => setTimeout(resolve, COMMUNITY_WAIT_MS))]) : null,
    ]);
    imported = true;
    if (walkAbandoned) return;
    walkRoot = document.createElement('div');
    walkRoot.className = 'walk-root';
    document.body.appendChild(walkRoot);
    document.documentElement.classList.add('walking');
    lobby = createLobby(walkRoot, {
      worlds: lobbyWorlds(),
      start,
      from: FROM_WORLD,
      doorwayView: DOORWAY_VIEW,
      light: walkIsLight(),
      onListener: (x, y, z, radius) => lobbyMusic.setListener(x, y, z, radius),
      onEnterWorld: (world, returnTo) => {
        trackClick(world.url);
        saveWalkReturn(returnTo, walkColor);
      },
      // The same counter, shown beside each door as "entries".
      entries: (url) => {
        const count = viewCounts[url];
        return typeof count === 'number' ? count : undefined;
      },
    });
    applyWalkTheme();
    mountPauseActions();
    if (!DOORWAY_VIEW) lobbyMusic.setActive(true);
    walkColor = color && WALK_COLORS.includes(color) ? color : savedWalkColor() ?? randomWalkColor();
    lobby.setColor(walkColor);
    showWalkColor(walkColor);
    // `from` has been used: a reload starts at the top of the street, as any other.
    history.replaceState(null, '', `${window.location.pathname}${searchWithout('from')}#walk`);
    setWalkToggleLabel('Gallery mode');
    // Its first frame is on screen: the slow-load Gallery mode button is no longer needed.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!walkRoot) return;
      document.documentElement.classList.add('walk-ready');
      document.documentElement.classList.remove('walk-stalled');
    }));
  } catch (error) {
    console.error('Walk mode failed to start', error);
    // The lobby's code would not load: most likely a deploy since this tab
    // opened took the old chunks away. Reload once into the new build.
    if (!imported && !walkAbandoned && reloadIntoWalk()) return;
    // Walk mode is unlisted for now: fail quietly back to the list.
    exitWalkMode();
  } finally {
    walkLoading = false;
    walkToggle.disabled = false;
  }
}

/** This page's query without `name`, with its `?` (or empty). */
function searchWithout(name: string): string {
  const params = new URLSearchParams(window.location.search);
  params.delete(name);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Reloads straight back into walk mode, unless this tab already did so a
 * moment ago (the chunk is failing for some other reason) or it is offline,
 * where a reload would only swap the list for the browser's offline page.
 */
function reloadIntoWalk(): boolean {
  if (!navigator.onLine) return false;
  try {
    if (!claimStaleBuildReload(sessionStorage, Date.now())) return false;
  } catch {
    // Storage blocked: without the guard, no reload.
    return false;
  }
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}#walk`);
  window.location.reload();
  return true;
}

function exitWalkMode(): void {
  lobbyMusic.setActive(false);
  lobby?.dispose();
  lobby = null;
  walkRoot?.remove();
  walkRoot = null;
  document.documentElement.classList.remove('walking', 'walk-ready', 'walk-stalled');
  delete document.documentElement.dataset.walkTheme;
  setThemeColor(null);
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}#list`);
  setWalkToggleLabel('Walk between worlds');
}

function saveWalkReturn(spot: import('./walk/lobby').WalkSpot, color: string): void {
  try {
    sessionStorage.setItem(WALK_RETURN_KEY, JSON.stringify({ ...spot, color }));
  } catch {
    // Storage blocked: coming back starts in the middle of the hall.
  }
}

/** The spot saved by saveWalkReturn, if any, clearing it so it is used once. */
function takeWalkReturn(): { spot: import('./walk/lobby').WalkSpot; color: string | null } | null {
  try {
    const raw = sessionStorage.getItem(WALK_RETURN_KEY);
    sessionStorage.removeItem(WALK_RETURN_KEY);
    if (!raw) return null;
    const { position, yaw, color } = JSON.parse(raw);
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    if (!Array.isArray(position) || position.length !== 3 || !position.every(finite) || !finite(yaw)) return null;
    return {
      spot: { position: [position[0], position[1], position[2]], yaw },
      color: typeof color === 'string' && WALK_COLORS.includes(color) ? color : null,
    };
  } catch {
    return null;
  }
}

function showWalkColor(color: string): void {
  for (const swatch of document.querySelectorAll<HTMLButtonElement>('.walk-colors button')) {
    swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color));
  }
}

document.addEventListener('click', (event) => {
  const swatch = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-color]') : null;
  if (!swatch || !lobby) return;
  const color = swatch.dataset.color;
  if (!color || !WALK_COLORS.includes(color)) return;
  walkColor = color;
  lobby.setColor(color);
  showWalkColor(color);
  saveWalkColor(color);
});

// Guests get a random colour on every arrival; signed-in visitors keep the
// last one they picked (per account, on this device).
const WALK_COLOR_KEY = 'worldmesh-walk-color:';

function randomWalkColor(): string {
  return WALK_COLORS[Math.floor(Math.random() * WALK_COLORS.length)];
}

function savedWalkColor(): string | null {
  const id = getAccountId();
  if (!id) return null;
  try {
    const color = localStorage.getItem(WALK_COLOR_KEY + id);
    return color && WALK_COLORS.includes(color) ? color : null;
  } catch {
    return null;
  }
}

function saveWalkColor(color: string): void {
  const id = getAccountId();
  if (!id) return;
  try {
    localStorage.setItem(WALK_COLOR_KEY + id, color);
  } catch {
    // Storage blocked: the colour just isn't remembered.
  }
}

// The account check finishes after the lobby may already be up: switch to the
// saved colour then, or remember the current one as this account's first.
onAccountChange(() => {
  if (!lobby) return;
  const saved = savedWalkColor();
  if (saved) {
    walkColor = saved;
    lobby.setColor(saved);
    showWalkColor(saved);
  } else {
    saveWalkColor(walkColor);
  }
});

/** The pause screen's music switch, and the song playing with a link to its credit. */
function showLobbyMusic(): void {
  const on = lobbyMusic.enabled;
  for (const button of document.querySelectorAll<HTMLButtonElement>('.walk-music')) {
    button.setAttribute('aria-pressed', String(on));
    button.textContent = on ? 'Music on' : 'Music off';
  }
  const track = lobbyMusic.current;
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.walk-now-playing')) {
    link.textContent = on && track ? `♪ ${track.title} · ${track.artist}` : 'Music credits';
    link.setAttribute('aria-label', on && track ? `Now playing ${track.title} by ${track.artist}. Music credits` : 'Music credits');
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.walk-music')) lobbyMusic.setEnabled(!lobbyMusic.enabled);
});

const walkConfirm = document.querySelector<HTMLDialogElement>('#walk-confirm')!;
const walkConfirmTitle = document.querySelector<HTMLHeadingElement>('#walk-confirm-title')!;
const walkConfirmBody = document.querySelector<HTMLParagraphElement>('#walk-confirm-body')!;
const walkConfirmOk = document.querySelector<HTMLButtonElement>('#walk-confirm-ok')!;
let walkAsking = false;

/** A yes/no over the lobby. Releases the cursor so the buttons can be used. */
function askWalk(title: string, body: string, okLabel: string): Promise<boolean> {
  if (walkAsking || walkConfirm.open) return Promise.resolve(false);
  walkAsking = true;
  walkConfirmTitle.textContent = title;
  walkConfirmBody.textContent = body;
  walkConfirmOk.textContent = okLabel;
  document.exitPointerLock?.();
  return new Promise((resolve) => {
    const finish = () => {
      walkConfirm.removeEventListener('close', onClose);
      walkAsking = false;
      resolve(walkConfirm.returnValue === 'ok');
    };
    const onClose = () => finish();
    walkConfirm.addEventListener('close', onClose);
    walkConfirm.showModal();
    (document.activeElement as HTMLElement | null)?.blur();
  });
}

async function confirmLeaveWalk(): Promise<void> {
  if (!walkRoot) return;
  const yes = await askWalk(
    'Switch to Gallery mode?',
    'You will leave the lobby and return to the list of worlds.',
    'Gallery mode',
  );
  if (yes) exitWalkMode();
}

/** Copies of the corner controls, so the pause screen can use them too. */
function mountPauseActions(): void {
  const content = document.querySelector('.wm-lock-content');
  if (!content || content.querySelector('.walk-pause-actions')) return;
  const bar = document.createElement('div');
  bar.className = 'walk-pause-actions';

  const gallery = document.createElement('button');
  gallery.type = 'button';
  gallery.className = 'walk-gallery';
  gallery.textContent = 'Gallery mode';

  const discord = document.createElement('a');
  discord.className = 'walk-discord';
  discord.href = 'https://discord.gg/cJYFfyVheP';
  discord.target = '_blank';
  discord.rel = 'noopener noreferrer';
  discord.textContent = 'Feedback on Discord';

  const theme = document.createElement('div');
  theme.className = 'walk-theme';
  theme.setAttribute('role', 'group');
  theme.setAttribute('aria-label', 'Light, dark, or this device');
  for (const [choice, label, title] of [
    ['light', 'Light', ''],
    ['dark', 'Dark', ''],
    ['system', 'Device', 'Follow this device'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.themeChoice = choice;
    button.textContent = label;
    if (title) button.title = title;
    theme.appendChild(button);
  }

  const colors = walkColors.cloneNode(true) as HTMLDivElement;
  colors.removeAttribute('id');
  bar.append(gallery, discord);
  if (lobbyMusic.supported) {
    const music = document.createElement('button');
    music.type = 'button';
    music.className = 'walk-music';
    // In a new tab, so the lobby keeps its place.
    const credits = document.createElement('a');
    credits.className = 'walk-now-playing';
    credits.href = '/music-credits';
    credits.target = '_blank';
    credits.rel = 'noopener';
    bar.append(music, credits);
  }
  bar.append(theme, colors);
  const keys = content.querySelector('.wm-keys');
  if (keys) content.insertBefore(bar, keys);
  else content.appendChild(bar);
  const choice = (document.documentElement.dataset.theme as ThemeChoice | undefined) ?? 'system';
  applyThemeChoice(choice);
  showWalkColor(walkColor);
  showLobbyMusic();
}

/** Darken the mobile browser's toolbar while walking; null restores the page's own colours. */
function setThemeColor(color: string | null): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.dataset.original ??= meta.content;
    meta.content = color ?? meta.dataset.original;
  }
}

function setWalkToggleLabel(label: string): void {
  walkToggle.title = label;
  walkToggle.setAttribute('aria-label', label);
}

async function fetchCommunityWorlds(): Promise<void> {
  try {
    const res = await fetch('/api/worlds');
    if (!res.ok) return;
    // Curated entries in community.json win over the server's copy of the
    // same world, so a cover swapped here is the one people see.
    const curated = new Map((communityWorldsStatic as WorldEntry[]).map((w) => [w.url, w]));
    const remote = ((await res.json()) as WorldEntry[]).map((w) => curated.get(w.url) ?? w);
    const remoteUrls = new Set(remote.map((w) => w.url));
    communityWorlds = [...remote, ...[...curated.values()].filter((w) => !remoteUrls.has(w.url))];
    ALL_WORLDS.length = 0;
    ALL_WORLDS.push(...communityWorlds, ...DEMO_WORLDS);
    render();
    lobby?.setWorlds(lobbyWorlds());
    fetchViewCounts(ALL_WORLDS.map((w) => w.url));
  } catch {
    // Fall back to demo worlds only
  }
}

// Fetch server-side view counts for all known worlds
const allWorldUrls = ALL_WORLDS.map((w) => w.url);
fetchViewCounts(allWorldUrls);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (botTrap?.value?.trim()) {
    input.value = '';
    setStatus('Submitted! Your world will appear once approved.');
    return;
  }

  const raw = input.value.trim();
  if (!raw) return;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    setStatus('That does not look like a URL.', true);
    return;
  }

  if (ALL_WORLDS.some((world) => world.url === url.toString())) {
    setStatus('That world is already listed.', true);
    return;
  }

  setStatus('Looking for a world manifest…');
  const manifest = await readManifest(url);

  pendingUrl = url;
  pendingManifest = manifest;

  if (manifest?.creator) creatorNameInput.value = manifest.creator;
  if (manifest?.description) creatorDescriptionInput.value = manifest.description;
  setAddingMode(true);
  // Name is hidden on touch screens (see index.html), so start at email there.
  (creatorNameInput.offsetParent ? creatorNameInput : creatorEmailInput).focus();
  setStatus('Almost there — add your details below.');
});

function slugify(str: string): string {
  return str.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

submitWorldBtn.addEventListener('click', async () => {
  if (!pendingUrl) return;

  const email = creatorEmailInput.value.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setStatus('Please enter a valid email address (required to manage or remove your world).', true);
    creatorEmailInput.focus();
    return;
  }

  const creatorName = creatorNameInput.value.trim() || undefined;
  const portfolioRaw = creatorPortfolioInput.value.trim();
  let portfolio: string | undefined;
  if (portfolioRaw) {
    portfolio = /^https?:\/\//i.test(portfolioRaw) ? portfolioRaw : `https://${portfolioRaw}`;
  }

  const baseName = pendingManifest?.name ?? pendingUrl.hostname;
  const slug = slugify(baseName) || 'world';
  const id = `${slug}-${Math.random().toString(36).substring(2, 8)}`;

  const entry: WorldEntry = {
    id,
    name: baseName,
    url: pendingUrl.toString(),
    description: creatorDescriptionInput.value.trim() || pendingManifest?.description,
    cover: pendingManifest?.cover,
    creator: creatorName,
    portfolio,
    email,
    submittedAt: new Date().toISOString(),
  };

  setAddingMode(false);
  setStatus('Submitted! Your world will appear once approved.');

  notifySubmission(entry);
});

async function readManifest(
  url: URL,
): Promise<{ name?: string; description?: string; cover?: string; creator?: string } | null> {
  for (const path of ['/.well-known/worldmesh.json', '/worldmesh.json']) {
    try {
      const response = await fetch(new URL(path, url), { mode: 'cors' });
      if (!response.ok) continue;
      const data = (await response.json()) as Record<string, unknown>;
      if (data && typeof data === 'object')
        return data as { name?: string; description?: string; cover?: string; creator?: string };
    } catch {
      // CORS, offline, or no manifest.
    }
  }
  return null;
}

async function notifySubmission(entry: WorldEntry): Promise<void> {
  const endpoint = NOTIFY_WEBHOOK || '/api/notify';
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: entry.id,
        name: entry.name,
        url: entry.url,
        description: entry.description ?? null,
        cover: entry.cover ?? null,
        creator: entry.creator ?? null,
        portfolio: entry.portfolio ?? null,
        email: entry.email ?? null,
        submittedAt: entry.submittedAt,
      }),
    });
  } catch {
    // Notification is best-effort — don't block the user.
  }
}


// Views per day since listing; age floored at 1 day so a single early click can't dominate.
function worldScore(world: WorldEntry): number {
  const views = viewCounts[world.url] ?? 0;
  const added = new Date(world.addedAt ?? world.approvedAt ?? DEMO_ADDED_AT).getTime();
  const ageDays = Math.max(1, (Date.now() - added) / DAY_MS);
  return views / ageDays;
}

function render(): void {
  const byScore = (a: WorldEntry, b: WorldEntry) => worldScore(b) - worldScore(a);
  const demos = new Set(DEMO_WORLDS);
  const listedAt = (w: WorldEntry) => new Date(w.addedAt ?? w.approvedAt ?? 0).getTime();
  const community = ALL_WORLDS.filter((w) => !demos.has(w));
  const spotlight = community.filter((w) => Date.now() - listedAt(w) < SPOTLIGHT_MS);
  const sorted = [
    ...spotlight.sort((a, b) => listedAt(b) - listedAt(a)),
    ...community.filter((w) => !spotlight.includes(w)).sort(byScore),
    ...DEMO_WORLDS.slice().sort(byScore),
  ];
  const visible = multiplayerOnly ? sorted.filter(isMultiplayer) : sorted;
  if (visible.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'gallery-empty';
    empty.textContent = 'No multiplayer worlds yet.';
    demoList.replaceChildren(empty);
    return;
  }
  demoList.replaceChildren(...visible.map((world) => renderCard(world)));
  if (!userScrolled) requestAnimationFrame(snapFirstCard);
}

function renderCard(world: WorldEntry): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'card';

  const title = document.createElement('h2');
  title.className = 'card-title';
  title.textContent = world.name;
  item.appendChild(title);

  const link = document.createElement('a');
  link.href = world.url;
  link.addEventListener('click', () => trackClick(world.url));

  if (world.cover) {
    const img = document.createElement('img');
    img.className = 'card-cover';
    img.src = world.cover;
    img.alt = world.name;
    img.loading = 'lazy';
    img.onerror = () => {
      img.replaceWith(buildGradientCover(world));
    };
    link.appendChild(img);
  } else {
    link.appendChild(buildGradientCover(world));
  }

  const listedAt = world.addedAt ?? world.approvedAt;
  const badgeText = DEMO_WORLDS.includes(world)
    ? 'DEMO'
    : listedAt && Date.now() - new Date(listedAt).getTime() < NEW_BADGE_DAYS * DAY_MS
      ? 'NEW'
      : null;
  if (badgeText) {
    const badge = document.createElement('span');
    badge.className = 'card-new';
    badge.textContent = badgeText;
    link.appendChild(badge);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const name = document.createElement('h3');
  name.className = 'card-name';
  name.textContent = world.name;
  body.appendChild(name);

  if (world.description) {
    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = world.description;
    body.appendChild(desc);
  }

  const footer = document.createElement('div');
  footer.className = 'card-footer';


  if (world.creator) {
    const creatorEl = document.createElement('p');
    creatorEl.className = 'card-creator';
    if (world.portfolio) {
      creatorEl.textContent = 'By ';
      const creatorLink = document.createElement('a');
      creatorLink.href = world.portfolio;
      creatorLink.target = '_blank';
      creatorLink.rel = 'noopener';
      creatorLink.className = 'card-creator-link';
      creatorLink.textContent = world.creator;
      creatorLink.addEventListener('click', (e) => e.stopPropagation());
      creatorEl.appendChild(creatorLink);
    } else {
      creatorEl.textContent = `By ${world.creator}`;
    }
    footer.appendChild(creatorEl);
  }

  const entries = viewCounts[world.url] ?? 0;
  if (hasEntries(entries)) {
    const entriesBadge = document.createElement('span');
    entriesBadge.className = 'card-clicks';
    entriesBadge.title = `${entries.toLocaleString('en')} ${entries === 1 ? 'entry' : 'entries'}`;
    entriesBadge.innerHTML = `${entryIconSvg(12)}${formatEntries(entries)}`;
    footer.appendChild(entriesBadge);
  }

  body.appendChild(footer);
  link.appendChild(body);
  item.appendChild(link);

  return item;
}

function buildGradientCover(world: WorldEntry): HTMLDivElement {
  const div = document.createElement('div');
  div.className = 'card-cover-gradient';
  const base = world.color ?? '#6cf0ff';
  div.style.background = `linear-gradient(135deg, ${base}55 0%, ${base}22 100%)`;
  div.textContent = world.name.charAt(0);
  return div;
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.dataset.error = String(isError);
}

/**
 * Only the public production hub should bump the visit counter. Localhost,
 * Vite, Pages previews, and other hosts still load the total for display.
 * World click ranking via trackClick(world.url) is unchanged.
 */
function recordHubVisit(): void {
  if (shouldCountHubVisit(window.location.hostname, window.location.search, localStorage)) {
    trackClick(HUB_VISIT_KEY);
    return;
  }
  void fetchViewCounts([HUB_VISIT_KEY]);
}

function trackClick(url: string): void {
  // Client-side debounce (30-minute session cooldown)
  const last = sessionViewed.get(url);
  if (last && Date.now() - last < COOLDOWN_MS) return;
  sessionViewed.set(url, Date.now());

  const endpoint = VIEWS_ENDPOINT;
  fetch(`${endpoint}/view`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
    keepalive: true,
  })
    .then((res) => res.json() as Promise<{ views?: number }>)
    .then((data) => {
      if (data.views != null) {
        viewCounts[url] = data.views;
        render();
        lobby?.refreshEntries();
      }
    })
    .catch(() => {});
}

async function fetchViewCounts(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const endpoint = VIEWS_ENDPOINT;
  try {
    const res = await fetch(`${endpoint}/views?urls=${encodeURIComponent(urls.join(','))}`);
    const counts = (await res.json()) as Record<string, number>;
    for (const [url, count] of Object.entries(counts)) {
      viewCounts[url] = count;
    }
    render();
    lobby?.refreshEntries();
  } catch {
    // Network or server error — keep existing counts.
  }
}
