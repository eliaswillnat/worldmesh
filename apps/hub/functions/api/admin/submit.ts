interface Env {
  APPROVE_SECRET?: string;
  WORLDS: KVNamespace;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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

  if (!body.url || !body.name) {
    return jsonResponse({ error: 'Missing name or url.' }, 400);
  }

  const id = body.id || `world-${Date.now().toString(36)}`;

  const existing = await env.WORLDS.get(`approved:${id}`);
  if (existing) {
    return jsonResponse({ error: 'A world with this ID already exists.' }, 409);
  }

  const entry = {
    id,
    name: body.name,
    url: body.url,
    description: body.description || undefined,
    cover: body.cover || undefined,
    creator: body.creator || undefined,
    portfolio: body.portfolio || undefined,
    approvedAt: new Date().toISOString(),
    curatedBy: 'admin',
  };

  await env.WORLDS.put(`approved:${id}`, JSON.stringify(entry));

  return jsonResponse({ success: true, id, entry });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
