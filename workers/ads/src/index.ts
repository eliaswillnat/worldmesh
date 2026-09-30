/**
 * WorldMesh billboard advertising. Served on the hub's own origin under
 * /api/ads/*, beside workers/auth and workers/federation, sharing their D1.
 *
 *   GET  /api/ads/billboards                 public: what every billboard shows
 *   POST /api/ads/submissions                upload + reserve + €2 PaymentIntent
 *   POST /api/ads/submissions/:id/confirm    re-check the payment with Stripe
 *   POST /api/ads/submissions/:id/cancel     payment window closed: release
 *   GET  /api/ads/media/:id/(media|poster)   live ads public; others signed/admin
 *   POST /api/ads/stripe/webhook             Stripe, signature-verified
 *   GET  /api/ads/admin                      admin: all submissions
 *   GET  /api/ads/admin/review?id=           admin: one submission
 *   POST /api/ads/admin/review               admin: approve / reject / take down
 */
import { queuePage, reviewAction, reviewPage } from './admin';
import { assertConfigured, type Env } from './env';
import { errorJson, HttpError } from './http';
import { sweep } from './lifecycle';
import { serveMedia } from './serve';
import { cancelSubmission, confirmSubmission, createSubmission, listBillboards } from './submissions';
import { handleWebhook } from './webhook';

export type { Env };

const SUBMISSION = /^\/api\/ads\/submissions\/([a-z2-7]{26})\/(confirm|cancel)$/;
const MEDIA = /^\/api\/ads\/media\/([a-z2-7]{26})\/(media|poster)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return errorJson(error.status, error.message);
      console.error('ads worker error', error);
      return errorJson(500, 'Something went wrong. Nothing was charged.');
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweep(env).catch((error) => console.error('ads sweep failed', error)));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  let match: RegExpMatchArray | null;

  if (pathname === '/api/ads/billboards' && method === 'GET') return listBillboards(env);
  if ((match = pathname.match(MEDIA)) && (method === 'GET' || method === 'HEAD')) {
    return serveMedia(request, env, match[1], match[2] as 'media' | 'poster');
  }

  assertConfigured(env);
  if (pathname === '/api/ads/stripe/webhook' && method === 'POST') return handleWebhook(request, env);
  if (pathname === '/api/ads/submissions' && method === 'POST') return createSubmission(request, env);
  if ((match = pathname.match(SUBMISSION)) && method === 'POST') {
    return match[2] === 'confirm' ? confirmSubmission(request, env, match[1]) : cancelSubmission(request, env, match[1]);
  }
  if (pathname === '/api/ads/admin' && method === 'GET') return queuePage(request, env);
  if (pathname === '/api/ads/admin/review' && method === 'GET') return reviewPage(request, env);
  if (pathname === '/api/ads/admin/review' && method === 'POST') return reviewAction(request, env);
  throw new HttpError(404, 'Not found.');
}
