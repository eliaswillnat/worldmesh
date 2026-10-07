import puppeteer from '@cloudflare/puppeteer';

/**
 * Door views: a 360° colour + depth snapshot of a world from its spawn point,
 * for the doors in the hub. Taking one means loading the world and rendering
 * twelve cube faces in a software renderer, so it runs from a queue rather
 * than inside the request that asks for it.
 *
 * R2 layout, per world:
 *   door-views/<slug>/status.json        what the hub reads: queued, capturing, ready, unsupported or failed
 *   door-views/<slug>/<stamp>/color.webp
 *   door-views/<slug>/<stamp>/depth.png
 */

export interface DoorViewEnv {
  BROWSER: Fetcher;
  SCREENSHOTS: R2Bucket;
  DOOR_VIEWS: Queue<DoorViewJob>;
  R2_PUBLIC_URL?: string;
}

export interface DoorViewJob {
  url: string;
  slug: string;
  requestedAt: number;
}

type State = 'queued' | 'capturing' | 'ready' | 'unsupported' | 'failed';

/** Matches CAPTURE_PARAM in @worldmesh/runtime. */
const CAPTURE_PARAM = 'worldmesh-capture';
const LOAD_TIMEOUT = 30_000;
/** How long a world gets to call createWorldMesh after its page loads. */
const RUNTIME_TIMEOUT = 30_000;
/** Lets textures and models that load after the runtime starts arrive before the shot. */
const SETTLE_TIME = 4_000;

export function doorViewSlug(url: URL): string {
  return `${url.hostname}${url.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

/** POST /door-views {url}: queue a capture and answer straight away. */
export async function requestDoorView(rawUrl: string | undefined, env: DoorViewEnv): Promise<{ status: number; body: Record<string, unknown> }> {
  let url: URL;
  try {
    url = new URL(rawUrl ?? '');
  } catch {
    return { status: 400, body: { error: 'Invalid url' } };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { status: 400, body: { error: 'Only http and https worlds can be captured' } };
  }
  const slug = doorViewSlug(url);
  const job: DoorViewJob = { url: url.toString(), slug, requestedAt: Date.now() };
  const previous = await readStatus(env, slug);
  await writeStatus(env, slug, { ...keepReady(previous), state: 'queued', url: job.url, requestedAt: job.requestedAt });
  await env.DOOR_VIEWS.send(job);
  return { status: 202, body: { success: true, slug, state: 'queued', status: `/door-views/${slug}` } };
}

/** GET /door-views/<slug>: the world's latest status, including the current door view once ready. */
export async function getDoorViewStatus(slug: string, env: DoorViewEnv): Promise<Record<string, unknown> | null> {
  return readStatus(env, slug);
}

export async function consumeDoorViews(batch: MessageBatch<DoorViewJob>, env: DoorViewEnv): Promise<void> {
  for (const message of batch.messages) {
    await captureOne(message.body, env);
    // Failures are recorded in status.json; a retry would only repeat the same broken page.
    message.ack();
  }
}

async function captureOne(job: DoorViewJob, env: DoorViewEnv): Promise<void> {
  const previous = await readStatus(env, job.slug);
  const base = { ...keepReady(previous), url: job.url, requestedAt: job.requestedAt };
  await writeStatus(env, job.slug, { ...base, state: 'capturing', startedAt: Date.now() });

  const target = new URL(job.url);
  target.searchParams.set(CAPTURE_PARAM, '1');

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 1024 });
    await page.goto(target.toString(), { waitUntil: 'load', timeout: LOAD_TIMEOUT });

    try {
      await page.waitForFunction(() => typeof (globalThis as any).__worldmeshCaptureDoorView === 'function', {
        timeout: RUNTIME_TIMEOUT,
      });
    } catch {
      await writeStatus(env, job.slug, {
        ...base,
        state: 'unsupported',
        finishedAt: Date.now(),
        error: 'This world does not use a version of @worldmesh/runtime that can take door views.',
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, SETTLE_TIME));

    const view = (await page.evaluate(() => (globalThis as any).__worldmeshCaptureDoorView())) as {
      color: string;
      depth: string;
      [key: string]: unknown;
    };

    const stamp = Date.now();
    const prefix = `door-views/${job.slug}/${stamp}`;
    await Promise.all([
      env.SCREENSHOTS.put(`${prefix}/color.webp`, decodeDataUrl(view.color), { httpMetadata: { contentType: 'image/webp' } }),
      env.SCREENSHOTS.put(`${prefix}/depth.png`, decodeDataUrl(view.depth), { httpMetadata: { contentType: 'image/png' } }),
    ]);

    const { color: _color, depth: _depth, ...meta } = view;
    await writeStatus(env, job.slug, {
      ...base,
      state: 'ready',
      finishedAt: Date.now(),
      view: { ...meta, capturedAt: stamp, color: publicUrl(env, `${prefix}/color.webp`), depth: publicUrl(env, `${prefix}/depth.png`) },
    });

    // The previous snapshot is no longer referenced by anything.
    const old = previous?.view as { capturedAt?: number } | undefined;
    if (old?.capturedAt && old.capturedAt !== stamp) {
      await env.SCREENSHOTS.delete([`door-views/${job.slug}/${old.capturedAt}/color.webp`, `door-views/${job.slug}/${old.capturedAt}/depth.png`]);
    }
  } catch (err: any) {
    await writeStatus(env, job.slug, { ...base, state: 'failed', finishedAt: Date.now(), error: String(err?.message ?? err) });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

/** A failed or repeated capture keeps showing the last good door view. */
function keepReady(previous: Record<string, unknown> | null): Record<string, unknown> {
  return previous?.view ? { view: previous.view } : {};
}

async function readStatus(env: DoorViewEnv, slug: string): Promise<Record<string, unknown> | null> {
  const object = await env.SCREENSHOTS.get(`door-views/${slug}/status.json`);
  return object ? ((await object.json()) as Record<string, unknown>) : null;
}

async function writeStatus(env: DoorViewEnv, slug: string, status: Record<string, unknown> & { state: State }): Promise<void> {
  await env.SCREENSHOTS.put(`door-views/${slug}/status.json`, JSON.stringify(status, null, 2), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-cache' },
  });
}

function publicUrl(env: DoorViewEnv, key: string): string {
  const base = env.R2_PUBLIC_URL?.replace(/\/$/, '');
  return base ? `${base}/${key}` : key;
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
