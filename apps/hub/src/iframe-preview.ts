/**
 * Experiment: embedded live-world previews via iframe.
 * Remove the single import line in main.ts to disable entirely.
 */

const OBSERVER_MARGIN = '200px';
const LOAD_TIMEOUT_MS = 8000;
const processed = new WeakSet<HTMLElement>();

let io: IntersectionObserver;

function getObserver(): IntersectionObserver {
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            activatePreview(entry.target as HTMLElement);
            io.unobserve(entry.target);
          }
        }
      },
      { rootMargin: OBSERVER_MARGIN },
    );
  }
  return io;
}

function scan(): void {
  const observer = getObserver();
  for (const card of document.querySelectorAll<HTMLElement>('.card')) {
    if (processed.has(card)) continue;
    processed.add(card);
    const link = card.querySelector<HTMLAnchorElement>(':scope > a');
    if (!link?.href) continue;
    card.dataset.worldUrl = link.href;
    observer.observe(card);
  }
}

function activatePreview(card: HTMLElement): void {
  const url = card.dataset.worldUrl;
  if (!url) return;
  const link = card.querySelector<HTMLAnchorElement>(':scope > a')!;

  const wrapper = document.createElement('div');
  wrapper.className = 'iframe-preview';

  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.setAttribute('loading', 'lazy');
  iframe.style.pointerEvents = 'none';

  const overlay = document.createElement('div');
  overlay.className = 'iframe-preview-overlay';
  overlay.textContent = 'Click to interact';

  overlay.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    iframe.style.pointerEvents = '';
    overlay.remove();
  });

  iframe.addEventListener('error', () => fallback(wrapper));

  let loaded = false;
  iframe.addEventListener('load', () => { loaded = true; });
  setTimeout(() => { if (!loaded) fallback(wrapper); }, LOAD_TIMEOUT_MS);

  wrapper.appendChild(iframe);
  wrapper.appendChild(overlay);

  const cover = link.querySelector<HTMLElement>('.card-cover, .card-cover-gradient');
  if (cover) cover.style.display = 'none';
  link.insertBefore(wrapper, link.firstChild);
}

function fallback(wrapper: HTMLElement): void {
  const link = wrapper.parentElement;
  if (!link) return;
  const cover = link.querySelector<HTMLElement>('.card-cover, .card-cover-gradient');
  if (cover) cover.style.display = '';
  wrapper.remove();
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
.iframe-preview {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  border-radius: inherit;
}
.iframe-preview iframe {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
.iframe-preview-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: transparent;
  transition: background 0.2s, color 0.2s;
}
.iframe-preview-overlay:hover {
  background: rgba(0,0,0,0.45);
  color: #fff;
  font: 600 0.85rem/1 system-ui, sans-serif;
  letter-spacing: 0.02em;
}
`;
  document.head.appendChild(style);
}

// Self-initializing: watch for cards added to the DOM
export function enableIframePreviews(): void {
  injectStyles();
  scan();
  const grid = document.getElementById('demo-worlds');
  if (grid) {
    new MutationObserver(scan).observe(grid, { childList: true });
  }
}
