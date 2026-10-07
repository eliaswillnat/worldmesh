/**
 * Hub Pages middleware (repo-root `functions/` — the hub Pages project builds
 * from `/`).
 *
 * 1. www.worldmesh.net → https://worldmesh.net (301), preserving path + query.
 *    `_redirects` cannot match on hostname; this is the deployable equivalent.
 * 2. Unknown extensionless paths → real HTTP 404 (not the gallery SPA at 200).
 *    Hash routes (`/#walk`, `/#list`) never hit the server; `/` and static
 *    pages still pass through.
 */

const APEX_HOST = 'worldmesh.net';
const WWW_HOST = 'www.worldmesh.net';

/** Paths that must keep serving (after optional trailing-slash normalize). */
const EXACT = new Set([
  '/',
  '/index.html',
  '/about',
  '/about.html',
  '/creators',
  '/creators.html',
  '/privacy',
  '/privacy.html',
  '/terms',
  '/terms.html',
  '/connect.md',
  '/llms.txt',
  '/robots.txt',
  '/sitemap.xml',
  '/manifest.webmanifest',
  '/favicon.webp',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/404.html',
]);

/** Prefixes handled by Pages Functions, Workers, or static asset trees. */
const PREFIXES = [
  '/api/',
  '/assets/',
  '/covers/',
  '/banners/',
  '/.well-known/',
  '/ap/',
  '/nodeinfo/',
  '/@',
];

function normalizePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname || '/';
}

function isPassThrough(pathname: string): boolean {
  const path = normalizePath(pathname);
  if (EXACT.has(path) || EXACT.has(pathname)) return true;
  if (PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  // Real files (JS/CSS/images/maps): let the asset layer answer or 404.
  if (/\.[a-zA-Z0-9]{1,12}$/.test(pathname)) return true;
  return false;
}

const NOT_FOUND_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Not found — WorldMesh</title>
    <meta name="robots" content="noindex" />
    <link rel="canonical" href="https://worldmesh.net/" />
    <style>
      :root { color-scheme: light dark; }
      body {
        margin: 0; min-height: 100vh; display: grid; place-items: center;
        font-family: "Urbanist", system-ui, sans-serif; background: #000; color: #ccc;
        text-align: center; padding: 24px;
      }
      @media (prefers-color-scheme: light) {
        body { background: #fff; color: #222; }
        a { color: #444; }
        h1 { color: #111; }
      }
      h1 { font-size: 22px; font-weight: 600; color: #fff; margin: 0 0 8px; }
      p { margin: 0 0 20px; font-size: 14px; }
      a { color: #999; }
    </style>
  </head>
  <body>
    <main>
      <h1>Page not found</h1>
      <p>That path is not part of WorldMesh.</p>
      <p><a href="/">← Back to WorldMesh</a></p>
    </main>
  </body>
</html>`;

function notFound(): Response {
  return new Response(NOT_FOUND_HTML, {
    status: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export async function onRequest(context: {
  request: Request;
  next: () => Promise<Response>;
}): Promise<Response> {
  const url = new URL(context.request.url);

  if (url.hostname === WWW_HOST) {
    url.hostname = APEX_HOST;
    return Response.redirect(url.toString(), 301);
  }

  if (!isPassThrough(url.pathname)) {
    return notFound();
  }

  return context.next();
}
