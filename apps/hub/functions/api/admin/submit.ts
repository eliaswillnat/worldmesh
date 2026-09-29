interface Env {
  APPROVE_SECRET?: string;
  SCREENSHOT_ENDPOINT?: string;
  WORLDS: KVNamespace;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DEFAULT_SCREENSHOT_ENDPOINT =
  'https://worldmesh-screenshot.elias-willnat.workers.dev';

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;

  const authHeader = request.headers.get('Authorization');
  const secret = env.APPROVE_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return jsonResponse({ error: 'Unauthorized.' }, 401);
  }

  if (!env.WORLDS) {
    return jsonResponse({ error: 'KV binding not configured.' }, 500);
  }

  let body: {
    id?: string;
    name?: string;
    url?: string;
    description?: string;
    cover?: string;
    creator?: string;
    portfolio?: string;
  };

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON.' }, 400);
  }

  if (!body.url) {
    return jsonResponse({ error: 'Missing url.' }, 400);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(body.url);
  } catch {
    return jsonResponse({ error: 'Invalid url.' }, 400);
  }

  const manifest = await fetchManifest(parsedUrl);

  const name = body.name || manifest?.name || parsedUrl.hostname;
  const description = body.description || manifest?.description || undefined;
  const cover = body.cover || manifest?.cover || undefined;
  const creator = body.creator || manifest?.creator || undefined;

  const id =
    body.id ||
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') ||
    `world-${Date.now().toString(36)}`;

  const existing = await env.WORLDS.get(`approved:${id}`);
  if (existing) {
    return jsonResponse({ error: 'A world with this ID already exists.' }, 409);
  }

  const entry = {
    id,
    name,
    url: body.url,
    description,
    cover,
    creator,
    portfolio: body.portfolio || undefined,
    approvedAt: new Date().toISOString(),
    addedAt: new Date().toISOString(),
    curatedBy: 'admin',
  };

  await env.WORLDS.put(`approved:${id}`, JSON.stringify(entry));

  if (!cover) {
    const screenshotEndpoint =
      env.SCREENSHOT_ENDPOINT || DEFAULT_SCREENSHOT_ENDPOINT;
    try {
      await fetch(screenshotEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: body.url }),
      });
    } catch {
      // Screenshot is best-effort.
    }
  }

  return jsonResponse({
    success: true,
    id,
    entry,
    manifestFound: !!manifest,
  });
}

export async function onRequestPut(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;

  const authHeader = request.headers.get('Authorization');
  const secret = env.APPROVE_SECRET;
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return jsonResponse({ error: 'Unauthorized.' }, 401);
  }

  if (!env.WORLDS) {
    return jsonResponse({ error: 'KV binding not configured.' }, 500);
  }

  let body: {
    id: string;
    name?: string;
    description?: string;
    cover?: string;
    creator?: string;
    portfolio?: string;
  };

  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON.' }, 400);
  }

  if (!body.id) {
    return jsonResponse({ error: 'Missing id.' }, 400);
  }

  const raw = await env.WORLDS.get(`approved:${body.id}`);
  if (!raw) {
    return jsonResponse({ error: 'World not found.' }, 404);
  }

  const existing = JSON.parse(raw);
  const updated = {
    ...existing,
    ...(body.name !== undefined && { name: body.name }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.cover !== undefined && { cover: body.cover }),
    ...(body.creator !== undefined && { creator: body.creator }),
    ...(body.portfolio !== undefined && { portfolio: body.portfolio }),
    updatedAt: new Date().toISOString(),
  };

  await env.WORLDS.put(`approved:${body.id}`, JSON.stringify(updated));

  return jsonResponse({ success: true, entry: updated });
}

async function fetchManifest(
  url: URL,
): Promise<{
  name?: string;
  description?: string;
  cover?: string;
  creator?: string;
} | null> {
  for (const path of ['/.well-known/worldmesh.json', '/worldmesh.json']) {
    try {
      const response = await fetch(new URL(path, url), {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) continue;
      const data = (await response.json()) as Record<string, unknown>;
      if (data && typeof data === 'object')
        return data as {
          name?: string;
          description?: string;
          cover?: string;
          creator?: string;
        };
    } catch {
      // No manifest at this path.
    }
  }
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
