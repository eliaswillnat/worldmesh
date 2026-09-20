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
}

const STORAGE_KEY = 'worldmesh.worlds';

/** The five demo worlds, each served from its own origin. */
const DEMO_WORLDS: WorldEntry[] = [
  {
    name: 'Forest',
    url: 'http://localhost:5171/',
    description: 'Pine clearing. Double jump enabled.',
    color: '#8cff9e',
  },
  {
    name: 'Mars',
    url: 'http://localhost:5172/',
    description: 'Low gravity, long jumps, dash enabled.',
    color: '#ff8a5c',
  },
  {
    name: 'Neon City',
    url: 'http://localhost:5173/',
    description: 'Night streets. Dash, double jump, crouch.',
    color: '#ff4fd8',
  },
  {
    name: 'Medieval Village',
    url: 'http://localhost:5174/',
    description: 'Baseline movement only. Starts in third person.',
    color: '#ffd36b',
  },
  {
    name: 'Space Station',
    url: 'http://localhost:5175/',
    description: 'Open deck in orbit. Flying enabled.',
    color: '#b08cff',
  },
];

const form = document.querySelector<HTMLFormElement>('#add-form')!;
const input = document.querySelector<HTMLInputElement>('#url')!;
const statusEl = document.querySelector<HTMLDivElement>('#status')!;
const demoList = document.querySelector<HTMLUListElement>('#demo-worlds')!;
const yourList = document.querySelector<HTMLUListElement>('#your-worlds')!;

render();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
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

  save([
    ...saved,
    {
      name: manifest?.name ?? url.hostname,
      url: url.toString(),
      description: manifest?.description,
    },
  ]);

  input.value = '';
  setStatus(
    manifest
      ? `Added ${manifest.name ?? url.hostname} from its worldmesh.json.`
      : `Added ${url.hostname}. No manifest found, which is fine — it just means no description.`,
  );
  render();
});

/**
 * Best-effort read of the world's own manifest. A world that does not serve
 * one, or does not allow cross-origin reads, still works — the manifest is a
 * convenience, never a requirement.
 */
async function readManifest(url: URL): Promise<{ name?: string; description?: string } | null> {
  for (const path of ['/.well-known/worldmesh.json', '/worldmesh.json']) {
    try {
      const response = await fetch(new URL(path, url), { mode: 'cors' });
      if (!response.ok) continue;
      const data = (await response.json()) as { name?: string; description?: string };
      if (data && typeof data === 'object') return data;
    } catch {
      // CORS, offline, or no manifest. Not an error worth showing.
    }
  }
  return null;
}

function render(): void {
  demoList.replaceChildren(...DEMO_WORLDS.map((world) => renderWorld(world, false)));

  const saved = load();
  if (saved.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'Nothing yet. Paste a world URL above.';
    yourList.replaceChildren(empty);
    return;
  }
  yourList.replaceChildren(...saved.map((world) => renderWorld(world, true)));
}

function renderWorld(world: WorldEntry, removable: boolean): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'row';

  const link = document.createElement('a');
  link.href = world.url;

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = world.color ?? '#6cf0ff';
  link.appendChild(dot);

  const meta = document.createElement('span');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = world.name;
  meta.appendChild(name);
  if (world.description) {
    const description = document.createElement('span');
    description.className = 'desc';
    description.textContent = world.description;
    meta.appendChild(document.createElement('br'));
    meta.appendChild(description);
  }
  link.appendChild(meta);

  const host = document.createElement('span');
  host.className = 'host';
  host.textContent = hostOf(world.url);
  link.appendChild(host);

  item.appendChild(link);

  if (removable) {
    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      save(load().filter((entry) => entry.url !== world.url));
      setStatus(`Removed ${world.name}.`);
      render();
    });
    item.appendChild(remove);
  }

  return item;
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
