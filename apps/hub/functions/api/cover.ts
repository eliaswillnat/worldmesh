interface Env {
  /** Extra comma-separated hostnames allowed through, besides the covers bucket. */
  COVER_HOSTS?: string;
}

/**
 * Same-origin passthrough for world cover images, so walk mode can draw them
 * inside WebGL (which needs CORS the R2 public bucket does not send).
 * Only images from known cover hosts are relayed.
 */
const ALLOWED_HOSTS = ['pub-b622cf770b414a1c9869157e73dab3c1.r2.dev'];

export async function onRequestGet(context: { request: Request; env: Env }): Promise<Response> {
  const target = new URL(context.request.url).searchParams.get('url');
  let url: URL;
  try {
    url = new URL(target ?? '');
  } catch {
    return new Response('Bad url', { status: 400 });
  }

  const allowed = [
    ...ALLOWED_HOSTS,
    ...(context.env.COVER_HOSTS?.split(',').map((host) => host.trim()).filter(Boolean) ?? []),
  ];
  if (url.protocol !== 'https:' || !allowed.includes(url.hostname)) {
    return new Response('Host not allowed', { status: 403 });
  }

  const upstream = await fetch(url.toString(), {
    cf: { cacheEverything: true, cacheTtl: 86400 },
  } as RequestInit);
  const type = upstream.headers.get('Content-Type') ?? '';
  if (!upstream.ok || !type.startsWith('image/')) {
    return new Response('Cover unavailable', { status: 404 });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': type,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
