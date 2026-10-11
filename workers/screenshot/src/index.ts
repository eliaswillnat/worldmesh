import { MAX_UPLOAD_BODY, allowedOrigin, identify, type AccessEnv } from './access';
import { consumeDoorViews, getDoorViewStatus, requestDoorView, type DoorViewEnv, type DoorViewJob } from './doorViews';

interface Env extends DoorViewEnv, AccessEnv {}

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

  // Every POST is for WorldMesh's own servers: door views and cover uploads.
  if (!(await identify(request, env))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (url.pathname === '/door-views') {
    let doorViewBody: { url?: string };
    try {
      doorViewBody = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }
    const result = await requestDoorView(doorViewBody.url, env);
    return json(result.body, result.status);
  }

  // A cover upload: { url, image } with the image as a data URL or base64.
  let body: { url?: string; image?: string };
  const raw = await request.text();
  if (raw.length > MAX_UPLOAD_BODY) {
    return json({ error: 'Request too large' }, 413);
  }
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  if (!body.image) {
    return json({ error: 'Missing image' }, 400);
  }

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

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function slugify(str: string): string {
  return str.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}
