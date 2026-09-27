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

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    if (env.SCREENSHOT_SECRET) {
      const auth = request.headers.get('Authorization');
      if (auth !== `Bearer ${env.SCREENSHOT_SECRET}`) {
        return json({ error: 'Unauthorized' }, 401);
      }
    }

    let body: { url?: string; width?: number; height?: number };
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400);
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
