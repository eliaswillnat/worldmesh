interface Env {
  WORLDS: KVNamespace;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestGet(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const idsParam = url.searchParams.get('ids');

  if (!idsParam) {
    return new Response(JSON.stringify({ approved: [] }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  if (!env.WORLDS) {
    return new Response(JSON.stringify({ error: 'KV not configured.' }), {
      status: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const ids = idsParam.split(',').map((id) => decodeURIComponent(id.trim())).filter(Boolean).slice(0, 20);
  const approved: string[] = [];

  for (const id of ids) {
    const entry = await env.WORLDS.get(`approved:${id}`);
    if (entry) approved.push(id);
  }

  return new Response(JSON.stringify({ approved }), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
