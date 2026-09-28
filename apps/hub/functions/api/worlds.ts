interface Env {
  WORLDS: KVNamespace;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

export async function onRequestGet(context: {
  request: Request;
  env: Env;
}): Promise<Response> {
  if (!context.env.WORLDS) {
    return new Response(JSON.stringify([]), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const worlds: Record<string, unknown>[] = [];
  let cursor: string | undefined;

  do {
    const list = await context.env.WORLDS.list({ prefix: 'approved:', cursor, limit: 100 });
    for (const key of list.keys) {
      const raw = await context.env.WORLDS.get(key.name);
      if (raw) {
        const entry = JSON.parse(raw);
        delete entry.approveToken;
        delete entry.email;
        worlds.push(entry);
      }
    }
    cursor = list.list_complete ? undefined : (list as any).cursor;
  } while (cursor);

  worlds.sort((a, b) => {
    const ta = (b as any).approvedAt || '';
    const tb = (a as any).approvedAt || '';
    return ta > tb ? 1 : ta < tb ? -1 : 0;
  });

  return new Response(JSON.stringify(worlds), {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
  });
}
