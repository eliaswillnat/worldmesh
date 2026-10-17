import { chatRejection } from '../../../../templates/relay/src/chatFilter';

/**
 * POST /api/translate  { text, from, to }  →  { text }
 *
 * Translates one lobby chat line for a visitor whose browser cannot do it on
 * the device (apps/hub/src/walk/translate.ts tries that first). Runs on
 * Cloudflare Workers AI through the `AI` binding of the Pages project; without
 * the binding it answers 503 and the lobby says it could not translate.
 *
 * Only for the hub's own pages (same Origin), only chat-sized lines, cached at
 * the edge so the same line asked by a hall full of people is translated
 * once, and run through the chat filter on the way out like any other line.
 */

interface Env {
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
}

/** Built for translation between 100 languages, and cheap per line. */
const MODEL = '@cf/meta/m2m100-1.2b';
/** Chat lines are 80 characters; a little room for one typed elsewhere. */
const MAX_TEXT = 120;
/** A translation longer than this is not a translation of a chat line. */
const MAX_OUT = 200;
const LANGUAGE = /^[a-z]{2,3}$/;
const CACHE_S = 7 * 24 * 3600;

/** Per IP, per Pages instance: a person reading the lobby asks far less. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;
const asked = new Map<string, number[]>();

function limited(ip: string): boolean {
  const now = Date.now();
  const recent = (asked.get(ip) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  const over = recent.length >= RATE_LIMIT;
  if (!over) recent.push(now);
  asked.set(ip, recent);
  if (asked.size > 5000) asked.clear();
  return over;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost({ request, env, waitUntil }: { request: Request; env: Env; waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
  const url = new URL(request.url);
  // Browsers always send Origin on a POST from script: the hub's pages only.
  if (request.headers.get('Origin') !== url.origin) return json({ error: 'Not allowed' }, 403);

  let body: { text?: unknown; from?: unknown; to?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected JSON' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text.replace(/[\u0000-\u001f]/g, '').trim() : '';
  const from = typeof body.from === 'string' ? body.from : '';
  const to = typeof body.to === 'string' ? body.to : '';
  if (!text || text.length > MAX_TEXT || !LANGUAGE.test(from) || !LANGUAGE.test(to)) {
    return json({ error: 'Expected { text, from, to }' }, 400);
  }
  if (from === to) return json({ text });

  const key = new URL(`/api/translate/cache/${to}/${from}/${await digest(text)}`, url).toString();
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = await cache.match(key).catch(() => undefined);
  if (cached) return json(await cached.json());

  if (!env.AI) return json({ error: 'Translation is not set up' }, 503);
  if (limited(request.headers.get('CF-Connecting-IP') ?? 'unknown')) return json({ error: 'Too many requests' }, 429);

  let translated = '';
  try {
    const result = (await env.AI.run(MODEL, { text, source_lang: from, target_lang: to })) as { translated_text?: unknown };
    translated = typeof result?.translated_text === 'string' ? result.translated_text : '';
  } catch {
    return json({ error: 'Could not translate' }, 502);
  }
  translated = translated.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_OUT);
  if (!translated) return json({ error: 'Could not translate' }, 502);
  // Whatever the model makes of a line, it does not get to say what chat may not.
  if (chatRejection(translated)) return json({ error: 'Could not translate' }, 422);

  const answer = { text: translated };
  waitUntil(
    cache
      .put(key, new Response(JSON.stringify(answer), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${CACHE_S}` } }))
      .catch(() => undefined),
  );
  return json(answer);
}

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
