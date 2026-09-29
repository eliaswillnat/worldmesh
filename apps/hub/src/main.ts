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
}

import communityWorldsStatic from './community.json';

const VIEWS_ENDPOINT = import.meta.env.VITE_VIEWS_ENDPOINT as string | undefined;
const viewCounts: Record<string, number> = {};
const sessionViewed = new Map<string, number>();
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const DEMO_ADDED_AT = '2026-09-27T21:03:21Z';
const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_BADGE_DAYS = 7;

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
const SCREENSHOT_ENDPOINT =
  (import.meta.env.VITE_SCREENSHOT_ENDPOINT as string | undefined) ||
  'https://worldmesh-screenshot.elias-willnat.workers.dev';

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
    name: 'Forest',
    url: getDemoWorldUrl('VITE_WORLD_FOREST_URL', 5171, 'forest'),
    description: 'Demo world. Pine clearing. Double jump enabled.',
    color: '#8cff9e',
    cover: '/covers/forest.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
  },
  {
    name: 'Mars',
    url: getDemoWorldUrl('VITE_WORLD_MARS_URL', 5172, 'mars'),
    description: 'Demo world. Low gravity, long jumps, dash enabled.',
    color: '#ff8a5c',
    cover: '/covers/mars.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
  },
  {
    name: 'Neon City',
    url: getDemoWorldUrl('VITE_WORLD_CITY_URL', 5173, 'city'),
    description: 'Demo world. Night streets. Dash, double jump, crouch.',
    color: '#ff4fd8',
    cover: '/covers/city.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
  },
  {
    name: 'Medieval Village',
    url: getDemoWorldUrl('VITE_WORLD_MEDIEVAL_URL', 5174, 'medieval'),
    description: 'Demo world. Baseline movement only. Starts in third person.',
    color: '#ffd36b',
    cover: '/covers/medieval.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
  },
  {
    name: 'Space Station',
    url: getDemoWorldUrl('VITE_WORLD_SPACE_URL', 5175, 'space'),
    description: 'Demo world. Open deck in orbit. Flying enabled.',
    color: '#b08cff',
    cover: '/covers/space.webp',
    creator: 'Elias Willnat',
    portfolio: 'https://x.com/eliaswillnat',
  },
];

let communityWorlds: WorldEntry[] = communityWorldsStatic as WorldEntry[];
const ALL_WORLDS: WorldEntry[] = [...communityWorlds, ...DEMO_WORLDS];

import { ImageCropper } from './cropper';

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
const navConfirmCheckbox = document.querySelector<HTMLInputElement>('#nav-confirm')!;
const demoList = document.querySelector<HTMLUListElement>('#demo-worlds')!;

// Cover upload & cropper elements
const coverFileInput = document.querySelector<HTMLInputElement>('#cover-file-input')!;
const coverUploadTrigger = document.querySelector<HTMLButtonElement>('#cover-upload-trigger')!;
const cropperContainer = document.querySelector<HTMLDivElement>('#cropper-container')!;
const cropperCanvas = document.querySelector<HTMLCanvasElement>('#cropper-canvas')!;
const zoomSlider = document.querySelector<HTMLInputElement>('#zoom-slider')!;
const zoomInBtn = document.querySelector<HTMLButtonElement>('#zoom-in-btn')!;
const zoomOutBtn = document.querySelector<HTMLButtonElement>('#zoom-out-btn')!;
const cropperResetBtn = document.querySelector<HTMLButtonElement>('#cropper-reset-btn')!;
const cropperChangeBtn = document.querySelector<HTMLButtonElement>('#cropper-change-btn')!;
const cropperRemoveBtn = document.querySelector<HTMLButtonElement>('#cropper-remove-btn')!;

const cropper = new ImageCropper(cropperCanvas, {
  onZoomChange: (z) => {
    zoomSlider.value = z.toString();
  },
  onImageLoaded: () => {
    cropperContainer.style.display = 'flex';
    coverUploadTrigger.style.display = 'none';
    zoomSlider.value = '1';
  },
  onClear: () => {
    cropperContainer.style.display = 'none';
    coverUploadTrigger.style.display = '';
    coverFileInput.value = '';
  },
});

coverUploadTrigger.addEventListener('click', () => coverFileInput.click());
cropperChangeBtn.addEventListener('click', () => coverFileInput.click());

coverFileInput.addEventListener('change', async () => {
  const file = coverFileInput.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    setStatus('Please select an image file.', true);
    return;
  }
  try {
    await cropper.loadFile(file);
    setStatus('Drag the image to adjust position, use slider or mouse wheel to zoom.');
  } catch {
    setStatus('Failed to load image. Please try another one.', true);
  }
});

for (const dropTarget of [coverUploadTrigger, cropperContainer]) {
  dropTarget.addEventListener('dragover', (e: Event) => {
    e.preventDefault();
    coverUploadTrigger.classList.add('drag-over');
  });
  dropTarget.addEventListener('dragleave', () => {
    coverUploadTrigger.classList.remove('drag-over');
  });
  dropTarget.addEventListener('drop', async (e: Event) => {
    e.preventDefault();
    coverUploadTrigger.classList.remove('drag-over');
    const dragEvent = e as DragEvent;
    const file = dragEvent.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) {
      try {
        await cropper.loadFile(file);
        setStatus('Drag the image to adjust position, use slider or mouse wheel to zoom.');
      } catch {
        setStatus('Failed to load image. Please try another one.', true);
      }
    }
  });
}

zoomSlider.addEventListener('input', () => {
  cropper.setZoom(parseFloat(zoomSlider.value));
});

zoomInBtn.addEventListener('click', () => {
  cropper.setZoom(cropper.getZoom() + 0.25);
});

zoomOutBtn.addEventListener('click', () => {
  cropper.setZoom(cropper.getZoom() - 0.25);
});

cropperResetBtn.addEventListener('click', () => {
  cropper.resetTransform();
});

cropperRemoveBtn.addEventListener('click', () => {
  cropper.clear();
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
    cropper.clear();
    navConfirmCheckbox.checked = false;
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

render();

fetchCommunityWorlds();

async function fetchCommunityWorlds(): Promise<void> {
  try {
    const res = await fetch('/api/worlds');
    if (!res.ok) return;
    communityWorlds = (await res.json()) as WorldEntry[];
    ALL_WORLDS.length = 0;
    ALL_WORLDS.push(...communityWorlds, ...DEMO_WORLDS);
    render();
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
  if (manifest?.cover) {
    cropper.loadUrl(manifest.cover).catch(() => {
      // CORS might block canvas read; manifest.cover remains as fallback.
    });
  }
  setAddingMode(true);
  creatorNameInput.focus();
  setStatus('Almost there — add your details below.');
});

async function uploadCoverImage(webpData: string, worldUrl: string): Promise<string | null> {
  const endpoint = SCREENSHOT_ENDPOINT || '/api/screenshot';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: webpData, url: worldUrl }),
    });
    if (res.ok) {
      const data = (await res.json()) as { url?: string };
      if (data.url) return data.url;
    }
  } catch {
    // Best-effort upload fallback to webpData
  }
  return null;
}

function slugify(str: string): string {
  return str.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

submitWorldBtn.addEventListener('click', async () => {
  if (!pendingUrl) return;

  if (!navConfirmCheckbox.checked) {
    setStatus('Please confirm that your world uses familiar PC game navigation controls.', true);
    navConfirmCheckbox.focus();
    return;
  }

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

  let coverToUse = pendingManifest?.cover;

  if (cropper.hasImage()) {
    submitWorldBtn.disabled = true;
    submitWorldBtn.textContent = 'Processing…';
    setStatus('Converting cover image to WebP…');

    try {
      const webpData = cropper.exportWebP(0.85);
      const uploadedUrl = await uploadCoverImage(webpData, pendingUrl.toString());
      coverToUse = uploadedUrl || webpData;
    } catch {
      // Best-effort fallback
    } finally {
      submitWorldBtn.disabled = false;
      submitWorldBtn.textContent = 'Submit world';
    }
  }

  const entry: WorldEntry = {
    id,
    name: baseName,
    url: pendingUrl.toString(),
    description: creatorDescriptionInput.value.trim() || pendingManifest?.description,
    cover: coverToUse,
    creator: creatorName,
    portfolio,
    email,
    submittedAt: new Date().toISOString(),
  };

  setAddingMode(false);
  setStatus('Submitted! Your world will appear once approved.');

  saveSubmissionRecord(entry);
  requestScreenshot(entry);
  notifySubmission(entry);
});

async function saveSubmissionRecord(entry: WorldEntry): Promise<void> {
  const endpoint = SCREENSHOT_ENDPOINT || '/api/screenshot';
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ submission: entry }),
    });
  } catch {
    // Best-effort storage in R2
  }
}

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

async function requestScreenshot(entry: WorldEntry): Promise<void> {
  if (entry.cover) return; // Custom cover already provided
  const endpoint = SCREENSHOT_ENDPOINT || '/api/screenshot';
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: entry.url }),
    });
  } catch {
    // Screenshot is best-effort.
  }
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
  const sorted = [
    ...ALL_WORLDS.filter((w) => !demos.has(w)).sort(byScore),
    ...DEMO_WORLDS.slice().sort(byScore),
  ];
  demoList.replaceChildren(...sorted.map((world) => renderCard(world)));
}

function renderCard(world: WorldEntry): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'card';

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
  if (listedAt && Date.now() - new Date(listedAt).getTime() < NEW_BADGE_DAYS * DAY_MS) {
    const badge = document.createElement('span');
    badge.className = 'card-new';
    badge.textContent = 'NEW';
    link.appendChild(badge);
  }

  const body = document.createElement('div');
  body.className = 'card-body';

  const name = document.createElement('h3');
  name.className = 'card-name';
  name.textContent = world.name;
  body.appendChild(name);

  if (world.creator) {
    const creatorEl = document.createElement('p');
    creatorEl.className = 'card-creator';
    if (world.portfolio) {
      creatorEl.textContent = 'by ';
      const creatorLink = document.createElement('a');
      creatorLink.href = world.portfolio;
      creatorLink.target = '_blank';
      creatorLink.rel = 'noopener';
      creatorLink.className = 'card-creator-link';
      creatorLink.textContent = world.creator;
      creatorLink.addEventListener('click', (e) => e.stopPropagation());
      creatorEl.appendChild(creatorLink);
    } else {
      creatorEl.textContent = `by ${world.creator}`;
    }
    body.appendChild(creatorEl);
  }

  if (world.description) {
    const desc = document.createElement('p');
    desc.className = 'card-desc';
    desc.textContent = world.description;
    body.appendChild(desc);
  }

  const footer = document.createElement('div');
  footer.className = 'card-footer';

  const host = document.createElement('span');
  host.className = 'card-host';
  host.textContent = hostOf(world.url);
  footer.appendChild(host);

  const clicks = viewCounts[world.url] ?? 0;
  if (clicks > 0) {
    const clickBadge = document.createElement('span');
    clickBadge.className = 'card-clicks';
    clickBadge.innerHTML =
      `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 3C4.5 3 2 8 2 8s2.5 5 6 5 6-5 6-5-2.5-5-6-5Z" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.4"/></svg>` +
      `${clicks}`;
    footer.appendChild(clickBadge);
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

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.dataset.error = String(isError);
}

function trackClick(url: string): void {
  // Client-side debounce (30-minute session cooldown)
  const last = sessionViewed.get(url);
  if (last && Date.now() - last < COOLDOWN_MS) return;
  sessionViewed.set(url, Date.now());

  const endpoint = VIEWS_ENDPOINT || '/api/views';
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
      }
    })
    .catch(() => {});
}

async function fetchViewCounts(urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  const endpoint = VIEWS_ENDPOINT || '/api/views';
  try {
    const res = await fetch(`${endpoint}/views?urls=${encodeURIComponent(urls.join(','))}`);
    const counts = (await res.json()) as Record<string, number>;
    for (const [url, count] of Object.entries(counts)) {
      viewCounts[url] = count;
    }
    render();
  } catch {
    // Network or server error — keep existing counts.
  }
}
