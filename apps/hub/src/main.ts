/**
 * The hub is deliberately the least interesting part of WorldMesh.
 * It stores URLs. The worlds themselves live on their creators' own hosting,
 * and nothing here proxies, mirrors or re-hosts any of them.
 */

interface WorldEntry {
  name: string;
  url: string;
  description?: string;
  color?: string;
  cover?: string;
  creator?: string;
  pending?: boolean;
  submittedAt?: string;
}

const STORAGE_KEY = 'worldmesh.worlds';
const CLICKS_KEY = 'worldmesh.clicks';

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
    name: 'Forest',
    url: getDemoWorldUrl('VITE_WORLD_FOREST_URL', 5171, 'forest'),
    description: 'Pine clearing. Double jump enabled.',
    color: '#8cff9e',
  },
  {
    name: 'Mars',
    url: getDemoWorldUrl('VITE_WORLD_MARS_URL', 5172, 'mars'),
    description: 'Low gravity, long jumps, dash enabled.',
    color: '#ff8a5c',
  },
  {
    name: 'Neon City',
    url: getDemoWorldUrl('VITE_WORLD_CITY_URL', 5173, 'city'),
    description: 'Night streets. Dash, double jump, crouch.',
    color: '#ff4fd8',
  },
  {
    name: 'Medieval Village',
    url: getDemoWorldUrl('VITE_WORLD_MEDIEVAL_URL', 5174, 'medieval'),
    description: 'Baseline movement only. Starts in third person.',
    color: '#ffd36b',
  },
  {
    name: 'Space Station',
    url: getDemoWorldUrl('VITE_WORLD_SPACE_URL', 5175, 'space'),
    description: 'Open deck in orbit. Flying enabled.',
    color: '#b08cff',
  },
];

const form = document.querySelector<HTMLFormElement>('#add-form')!;
const input = document.querySelector<HTMLInputElement>('#url')!;
const botTrap = document.querySelector<HTMLInputElement>('#bot-trap');
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const demoList = document.querySelector<HTMLUListElement>('#demo-worlds')!;
const yourList = document.querySelector<HTMLUListElement>('#your-worlds')!;
const yourHeading = document.querySelector<HTMLHeadingElement>('#your-worlds-heading')!;

render();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  // Honeypot check: If the hidden bot field is filled, discard silently.
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

  const saved = load();
  if (saved.some((world) => world.url === url.toString())) {
    setStatus('That world is already on your list.', true);
    return;
  }

  setStatus('Looking for a world manifest…');
  const manifest = await readManifest(url);

  const entry: WorldEntry = {
    name: manifest?.name ?? url.hostname,
    url: url.toString(),
    description: manifest?.description,
    cover: manifest?.cover,
    creator: manifest?.creator,
    pending: true,
    submittedAt: new Date().toISOString(),
  };

  save([...saved, entry]);

  input.value = '';
  setStatus('Submitted! Your world will appear once approved.');
  render();

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
        name: entry.name,
        url: entry.url,
        description: entry.description ?? null,
        cover: entry.cover ?? null,
        creator: entry.creator ?? null,
        submittedAt: entry.submittedAt,
      }),
    });
  } catch {
    // Notification is best-effort — don't block the user.
  }
}

function render(): void {
  demoList.replaceChildren(...DEMO_WORLDS.map((world) => renderCard(world, false)));

  const saved = load();
  const approved = saved.filter((w) => !w.pending);

  const items: HTMLLIElement[] = [];
  for (const world of approved) items.push(renderCard(world, true));

  if (items.length === 0) {
    yourHeading.style.display = 'none';
    yourList.replaceChildren();
    return;
  }
  yourHeading.style.display = '';
  yourList.replaceChildren(...items);
}

function renderCard(world: WorldEntry, removable: boolean): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'card';
  if (world.pending) item.classList.add('card-pending');

  const link = document.createElement('a');
  link.href = world.pending ? '#' : world.url;
  if (world.pending) {
    link.addEventListener('click', (e) => e.preventDefault());
    link.style.cursor = 'default';
  } else {
    link.addEventListener('click', () => trackClick(world.url));
  }

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

  const body = document.createElement('div');
  body.className = 'card-body';

  const name = document.createElement('h3');
  name.className = 'card-name';
  name.textContent = world.name;
  body.appendChild(name);

  if (world.creator) {
    const creator = document.createElement('p');
    creator.className = 'card-creator';
    creator.textContent = `by ${world.creator}`;
    body.appendChild(creator);
  }

  if (world.pending) {
    const badge = document.createElement('span');
    badge.className = 'card-pending-badge';
    badge.textContent = 'Pending approval';
    body.appendChild(badge);
  } else if (world.description) {
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

  if (!world.pending) {
    const clicks = getClicks(world.url);
    if (clicks > 0) {
      const clickBadge = document.createElement('span');
      clickBadge.className = 'card-clicks';
      clickBadge.innerHTML =
        `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 3C4.5 3 2 8 2 8s2.5 5 6 5 6-5 6-5-2.5-5-6-5Z" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.4"/></svg>` +
        `${clicks}`;
      footer.appendChild(clickBadge);
    }
  }

  body.appendChild(footer);
  link.appendChild(body);
  item.appendChild(link);

  if (removable) {
    const remove = document.createElement('button');
    remove.className = 'card-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      save(load().filter((entry) => entry.url !== world.url));
      setStatus(`Removed ${world.name}.`);
      render();
    });
    item.appendChild(remove);
  }

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

function load(): WorldEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WorldEntry[]) : [];
  } catch {
    return [];
  }
}

function save(worlds: WorldEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(worlds));
  } catch {
    setStatus('Could not save to this browser, but the link still works.', true);
  }
}

function getClicks(url: string): number {
  try {
    const all = JSON.parse(localStorage.getItem(CLICKS_KEY) ?? '{}') as Record<string, number>;
    return all[url] ?? 0;
  } catch {
    return 0;
  }
}

function trackClick(url: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(CLICKS_KEY) ?? '{}') as Record<string, number>;
    all[url] = (all[url] ?? 0) + 1;
    localStorage.setItem(CLICKS_KEY, JSON.stringify(all));
  } catch {
    // Best effort.
  }
}
