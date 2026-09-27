import puppeteer from '@cloudflare/puppeteer';

interface Env {
  BROWSER: Fetcher;
  SCREENSHOTS: R2Bucket;
  SCREENSHOT_SECRET?: string;
  R2_PUBLIC_URL?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const match = url.pathname.match(/^\/submissions\/([^/]+?)(?:\.json)?$/);
      if (match) {
        const id = match[1];
        const obj = await env.SCREENSHOTS.get(`submissions/${id}.json`);
        if (!obj) {
          return json({ error: 'Submission not found' }, 404);
        }
        return new Response(obj.body, {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
          },
        });
      }
      return json({ error: 'Not found' }, 404);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    if (env.SCREENSHOT_SECRET) {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${env.SCREENSHOT_SECRET}`) {
        return json({ error: 'Unauthorized' }, 401);
      }
    }

    let body: {
      url?: string;
      width?: number;
      height?: number;
      image?: string;
      submission?: Record<string, unknown>;
    };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
    }

    if (body.submission) {
      try {
        const id = (body.submission.id as string) || `world-${Date.now()}`;
        const key = `submissions/${id}.json`;
        await env.SCREENSHOTS.put(key, JSON.stringify(body.submission, null, 2), {
          httpMetadata: { contentType: 'application/json' },
        });

        const publicBase = env.R2_PUBLIC_URL?.replace(/\/$/, '');
        const jsonUrl = publicBase ? `${publicBase}/${key}` : key;

        return json({ success: true, key, url: jsonUrl });
      } catch (err: any) {
        return json({ error: 'Failed to save submission', details: err?.message }, 500);
      }
    }

    if (body.image) {
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

    const width = body.width ?? 1200;
    const height = body.height ?? 1600;

    try {
      const browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();
      await page.setViewport({ width, height });

      await page.goto(targetUrl.toString(), {
        waitUntil: 'networkidle0',
        timeout: 15000,
      });

      // Give WebGL/Three.js a moment to render
      await page.waitForTimeout(3000);

      const screenshot = await page.screenshot({ type: 'jpeg', quality: 85 });
      await browser.close();

      const key = `${slugify(targetUrl.hostname)}-${Date.now()}.jpg`;
      await env.SCREENSHOTS.put(key, screenshot, {
        httpMetadata: { contentType: 'image/jpeg' },
      });

      const publicBase = env.R2_PUBLIC_URL?.replace(/\/$/, '');
      const screenshotUrl = publicBase ? `${publicBase}/${key}` : key;

      return json({ success: true, key, url: screenshotUrl });
    } catch (err: any) {
      return json({ error: 'Screenshot failed', details: err?.message }, 500);
    }
  },
};

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function slugify(str: string): string {
  return str.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}
