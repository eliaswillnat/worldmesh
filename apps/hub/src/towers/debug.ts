import type { WorldRecordInput } from '../worlds/listing';
import type { TowerCity } from './towerCity';

/**
 * Development overlay: where you are, what is streamed in, what the
 * rotation is doing and what it costs to draw. Loaded only by `vite dev`;
 * production builds never include it.
 */
export class CityDebug {
  private root = document.createElement('div');
  private text = document.createElement('pre');
  private since = 0;
  private frames = 0;
  private fps = 0;
  private drawCalls = 0;
  private triangles = 0;
  private previewUrl: string | null = null;

  constructor(
    private city: TowerCity,
    container: HTMLElement,
  ) {
    this.root.className = 'city-debug';
    const buttons = document.createElement('div');
    const button = (label: string, action: () => void) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        action();
      });
      buttons.append(element);
      return element;
    };
    button('Rotate now', () => city.clock.skip());
    button('500 test worlds', () => void this.synthetic(500));
    button('Lifts', () => city.openLifts());
    const hide = button('Hide', () => {
      const hidden = this.root.classList.toggle('collapsed');
      hide.textContent = hidden ? 'Debug' : 'Hide';
    });
    this.root.append(buttons, this.text);
    // On the page itself, above the runtime's pause screen, so the buttons can be clicked while paused.
    (container.ownerDocument?.body ?? document.body).append(this.root);

    const renderer = (window as { lobby?: { renderer?: { info: { autoReset: boolean } } } }).lobby?.renderer;
    if (renderer) renderer.info.autoReset = false;
  }

  update(dt: number): void {
    const renderer = (window as { lobby?: { renderer?: { info: { autoReset: boolean; render: { calls: number; triangles: number }; reset(): void } } } }).lobby?.renderer;
    if (renderer) {
      // Counted since the last reset: everything drawn last frame, the floor mirror included.
      this.drawCalls = renderer.info.render.calls;
      this.triangles = renderer.info.render.triangles;
      renderer.info.autoReset = false;
      renderer.info.reset();
    }
    this.frames++;
    this.since += dt;
    if (this.since < 0.25) return;
    this.fps = Math.round(this.frames / this.since);
    this.frames = 0;
    this.since = 0;

    const city = this.city;
    const { tower, floor, bridge } = city.currentLocation;
    const doors = city.loadedDoors;
    const visible = doors.filter((door) => door.mesh.visible).length;
    const chunks = [...city.towers.values()]
      .filter((state) => state.detail)
      .map((state) => {
        const floors = [...state.detail!.floors.keys()];
        return `${state.plan.id} ${Math.min(...floors)}–${Math.max(...floors)}`;
      });
    const next = city.clock.msUntilNext();
    const focus = city.focusedDoor;
    const stats = city.previews.stats;
    this.text.textContent = [
      `${this.fps} fps · ${this.drawCalls} draws · ${(this.triangles / 1000).toFixed(0)}k tris`,
      `at   ${tower ? `${tower.plan.id} floor ${floor}` : bridge ? `bridge ${bridge.bridge.id} ${(bridge.t * 100).toFixed(0)}%` : 'plaza'}`,
      `load ${chunks.join(' · ') || 'none'}`,
      `doors ${doors.length} loaded · ${visible} drawn`,
      `previews ${stats.animated} moving · ${stats.active} active · ${stats.playing}/${city.previews.maxActiveVideos} video`,
      `window ${city.rotation.currentWindow} · next in ${formatMs(next)} · ${city.rotation.pending} rotating`,
      `worlds ${city.repository.all().length}`,
      focus ? `focus ${focus.slotId} → ${focus.assignment?.listingId ?? 'empty'} (${focus.assignment?.strategy ?? '—'}${focus.assignment?.badge ? `, ${focus.assignment.badge}` : ''})` : 'focus —',
    ].join('\n');
  }

  dispose(): void {
    this.root.remove();
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
  }

  /** Fill the city with made-up worlds, a few of them with a preview loop. */
  private async synthetic(count: number): Promise<void> {
    this.previewUrl ??= await recordPreview().catch(() => null);
    const covers = ['/covers/forest.webp', '/covers/mars.webp', '/covers/city.webp', '/covers/medieval.webp', '/covers/space.webp', '/covers/sumbasurf-wave.webp', '/covers/skydex-3x4.webp'];
    const categories = ['explore', 'games', 'space'];
    const creators = ['Ada', 'Bo', 'Chen', 'Dani', 'Eli', 'Fen', 'Gus', 'Hana', 'Ines', 'Jo', 'Kai', 'Lu'];
    const records: WorldRecordInput[] = [...this.city.repository.all()].map((listing) => ({
      id: listing.id,
      name: listing.name,
      url: listing.url,
      cover: listing.cover,
      creator: listing.creator.name,
      categories: listing.categories,
      addedAt: new Date(listing.listedAt).toISOString(),
    }));
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      records.push({
        id: `test-${i}`,
        name: `Test World ${i + 1}`,
        url: `https://example.com/worlds/${i + 1}`,
        cover: covers[i % covers.length],
        creator: creators[(i * 7) % creators.length],
        categories: [categories[(i * 5) % categories.length]],
        addedAt: new Date(now - ((i * 37) % 120) * 86_400_000).toISOString(),
        preview: this.previewUrl && i % 4 === 0 ? this.previewUrl : undefined,
        featured: i % 23 === 0,
        tags: [i % 2 ? 'multiplayer' : 'solo'],
      });
    }
    this.city.replaceWorlds(records);
  }
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

/** Record a two-second looping animation to a WebM blob, to test door previews without hosting video. */
async function recordPreview(): Promise<string | null> {
  if (typeof MediaRecorder === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 180;
  canvas.height = 320;
  const ctx = canvas.getContext('2d')!;
  const stream = canvas.captureStream(24);
  const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const done = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();
  const start = performance.now();
  await new Promise<void>((resolve) => {
    const draw = () => {
      const t = (performance.now() - start) / 2000;
      ctx.fillStyle = '#101418';
      ctx.fillRect(0, 0, 180, 320);
      for (let i = 0; i < 6; i++) {
        const y = ((t + i / 6) % 1) * 360 - 20;
        ctx.fillStyle = i % 2 ? '#8fd3c7' : '#f0b45c';
        ctx.fillRect(20, y, 140, 14);
      }
      ctx.beginPath();
      ctx.arc(90 + Math.sin(t * Math.PI * 2) * 50, 160, 22, 0, Math.PI * 2);
      ctx.fillStyle = '#a3adff';
      ctx.fill();
      if (t < 1) requestAnimationFrame(draw);
      else resolve();
    };
    draw();
  });
  recorder.stop();
  await done;
  return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
}
