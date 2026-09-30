/**
 * GET/HEAD /api/ads/media/:id/(media|poster). A live advertisement's files
 * are public (the city shows them to everyone). Anything else, such as a
 * submission still in review, needs a signed link from the moderation email
 * or a signed-in admin. Byte ranges are supported, which Safari needs to play video.
 */
import { checkAdmin } from './admin';
import { isRandomId } from './crypto';
import { getAd } from './db';
import { now, type Env } from './env';
import { HttpError } from './http';
import { verifyMediaSignature, type MediaVariant } from './signing';

export async function serveMedia(request: Request, env: Env, id: string, variant: MediaVariant): Promise<Response> {
  const ad = isRandomId(id) ? await getAd(env, id) : null;
  const key = ad && !ad.media_deleted_at ? (variant === 'poster' ? ad.poster_key : ad.media_key) : null;
  if (!ad || !key) throw new HttpError(404, 'Not found.');

  const t = now(env);
  const isPublic = ad.status === 'active' && (ad.ends_at ?? 0) > t;
  let signed = false;
  if (!isPublic) {
    signed = await verifyMediaSignature(env, id, variant, new URL(request.url), t);
    if (!signed && !('admin' in (await checkAdmin(request, env)))) throw new HttpError(404, 'Not found.');
  }

  const object = await env.ADS_MEDIA.get(key, { range: request.headers, onlyIf: request.headers });
  if (!object) throw new HttpError(404, 'Not found.');
  const mime = variant === 'poster' ? 'image/jpeg' : ad.media_mime;
  const headers = new Headers({
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    ETag: object.httpEtag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    // Signed links are opened from email clients, which load them cross-origin.
    'Cross-Origin-Resource-Policy': signed ? 'cross-origin' : 'same-origin',
    // Live ads are fetched by every visitor; anything else is private.
    'Cache-Control': isPublic ? 'public, max-age=3600' : 'private, no-store',
  });
  if (!('body' in object) || !object.body) {
    // Conditional request matched (If-None-Match): nothing to send.
    return new Response(null, { status: 304, headers });
  }
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && request.headers.has('Range')) {
    const size = object.size;
    const offset = range.suffix !== undefined ? size - range.suffix : (range.offset ?? 0);
    const length = range.suffix !== undefined ? range.suffix : (range.length ?? size - offset);
    headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${size}`);
    headers.set('Content-Length', String(length));
    return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}
