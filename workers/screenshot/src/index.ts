import puppeteer from '@cloudflare/puppeteer';
import { MAX_BROWSER_BODY, allowedOrigin, identify, takeBrowserScreenshotSlot, type AccessEnv } from './access';
import { consumeDoorViews, getDoorViewStatus, requestDoorView, type DoorViewEnv, type DoorViewJob } from './doorViews';

interface Env extends DoorViewEnv, AccessEnv {}

/** Largest screenshot a server caller may ask for, in CSS pixels per side. */
const MAX_SCREENSHOT_SIDE = 2000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handle(request, env);
    // Only the hub's own pages may read responses from a browser.
    const origin = allowedOrigin(request, env);
    if (!origin) return response;
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
    headers.append('Vary', 'Origin');
    return new Response(response.body, { status: response.status, headers });
  },

  async queue(batch: MessageBatch<DoorViewJob>, env: Env): Promise<void> {
    await consumeDoorViews(batch, env);
  },
};

async function handle(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  const url = new URL(request.url);

  if (request.method === 'GET') {
    const doorView = url.pathname.match(/^\/door-views\/([a-z0-9-]+)$/);
    if (doorView) {
      const status = await getDoorViewStatus(doorView[1], env);
      return status ? json(status) : json({ error: 'No door view requested for this world' }, 404);
    }
    return json({ error: 'Not found' }, 404);
  }

  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const caller = await identify(request, env);
  if (!caller) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (url.pathname === '/door-views') {
    if (caller !== 'server') return json({ error: 'Door views can only be requested by WorldMesh servers' }, 403);
    let doorViewBody: { url?: string };
    try {
      doorViewBody = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const result = await requestDoorView(doorViewBody.url, env);
    return json(result.body, result.status);
  }

  let body: {
    url?: string;
    width?: number;
    height?: number;
    image?: string;
  };
  const raw = await request.text();
  if (caller === 'browser' && raw.length > MAX_BROWSER_BODY) {
    return json({ error: 'Request too large' }, 413);
  }
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (body.image) {
    if (caller !== 'server') return json({ error: 'Cover uploads can only come from WorldMesh servers' }, 403);
    try {
      let mime = 'image/webp';
      let base64Data = body.image;
      const match = body.image.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        mime = match[1];
        base64Data = match[2];
      }

      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const ext = mime.includes('webp') ? 'webp' : mime.includes('png') ? 'png' : 'jpg';
      let hostname = 'cover';
      if (body.url) {
        try {
          hostname = new URL(body.url).hostname;
        } catch {
          // keep fallback
        }
      }
      const key = `${slugify(hostname)}-${Date.now()}.${ext}`;

      await env.SCREENSHOTS.put(key, bytes, {
        httpMetadata: { contentType: mime },
      });

      const publicBase = env.R2_PUBLIC_URL?.replace(/\/$/, '');
      const imageUrl = publicBase ? `${publicBase}/${key}` : key;

      return json({ success: true, key, url: imageUrl });
    } catch (err: any) {
      return json({ error: 'Image upload failed', details: err?.message }, 500);
    }
  }

  if (!body.url) {
    return json({ error: 'Missing url' }, 400);
  }

  let targetUrl: URL;
  try {
    targetUrl = new URL(body.url);
  } catch {
    return json({ error: 'Invalid url' }, 400);
  }

  if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
    return json({ error: 'Only http and https worlds can be screenshotted' }, 400);
  }

  // Browsers get the default size only, and share a rate limit.
  const width = caller === 'server' ? clampSide(body.width, 1200) : 1200;
  const height = caller === 'server' ? clampSide(body.height, 1600) : 1600;
  if (caller === 'browser') {
    const refused = await takeBrowserScreenshotSlot(env, targetUrl);
    if (refused) return json({ error: refused }, 429);
  }

  try {
    const browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width, height });

    // Worlds keep connections open (presence sockets, streamed assets), so the
    // network never goes idle; wait for the load event instead.
    await page.goto(targetUrl.toString(), {
      waitUntil: 'load',
      timeout: 15000,
    });

    // Give WebGL/Three.js a moment to render
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const webgl = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      if (!gl) return { supported: false };
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        supported: true,
        renderer: String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)),
        halfFloatRenderTargets: !!gl.getExtension('EXT_color_buffer_float'),
      };
    });

    const screenshot = await page.screenshot({ type: 'jpeg', quality: 85 });
    await browser.close();

    const key = `${slugify(targetUrl.hostname)}-${Date.now()}.jpg`;
    await env.SCREENSHOTS.put(key, screenshot, {
      httpMetadata: { contentType: 'image/jpeg' },
    });

    const publicBase = env.R2_PUBLIC_URL?.replace(/\/$/, '');
    const screenshotUrl = publicBase ? `${publicBase}/${key}` : key;

    return json({ success: true, key, url: screenshotUrl, webgl });
  } catch (err: any) {
    return json({ error: 'Screenshot failed', details: err?.message }, 500);
  }
}

function clampSide(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(Math.max(n, 100), MAX_SCREENSHOT_SIDE);
}

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function slugify(str: string): string {
  return str.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}
