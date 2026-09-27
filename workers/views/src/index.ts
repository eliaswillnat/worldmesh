interface Env {
  VIEWS: KVNamespace;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // GET /views?urls=url1,url2 — batch fetch view counts
    if (request.method === 'GET' && url.pathname === '/views') {
      const urls = url.searchParams.get('urls')?.split(',').filter(Boolean) ?? [];
      if (urls.length === 0) return json({});

      const counts: Record<string, number> = {};
      await Promise.all(
        urls.slice(0, 50).map(async (worldUrl) => {
          const val = await env.VIEWS.get(`count:${worldUrl}`);
          counts[worldUrl] = val ? parseInt(val, 10) : 0;
        }),
      );
      return json(counts);
    }

    // POST /view { url } — record a view (deduped by IP per day)
    if (request.method === 'POST' && url.pathname === '/view') {
      let body: { url?: string };
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      if (!body.url) {
        return json({ error: 'Missing url' }, 400);
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const day = new Date().toISOString().slice(0, 10);
      const dedupKey = `dedup:${ip}:${body.url}:${day}`;
      const countKey = `count:${body.url}`;

      const [already, currentVal] = await Promise.all([
        env.VIEWS.get(dedupKey),
        env.VIEWS.get(countKey),
      ]);
      const current = currentVal ? parseInt(currentVal, 10) : 0;

      if (already && current > 0) {
        return json({ counted: false, views: current });
      }

      const newCount = current + 1;
      await Promise.all([
        env.VIEWS.put(countKey, String(newCount)),
        env.VIEWS.put(dedupKey, '1', { expirationTtl: 86400 }),
      ]);

      return json({ counted: true, views: newCount });
    }

    return json({ error: 'Not found' }, 404);
  },
};

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
