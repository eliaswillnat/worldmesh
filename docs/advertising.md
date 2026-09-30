# Billboard advertising

The towers around the citadel in the hub's walk mode carry screens. Each one is
a billboard anyone can book: €2, reviewed by hand, then shown for 30 days.

```
see an empty billboard → click + → upload → preview → authorize €2 → pending review
                                                         admin: Approve → €2 captured → on the billboard
                                                                Reject  → authorization released, nothing charged
```

## Pieces

| Where | What |
| --- | --- |
| `apps/hub/src/walk/layout.ts` | Where towers and screens are, as pure numbers. Gives every screen a permanent ID (`f07-main`: ring, tower, slot). Shared with the Worker. |
| `apps/hub/src/walk/city.ts` | Builds the towers from the layout; screens are handed out as billboard slots. |
| `apps/hub/src/ads/billboards.ts` | Three.js: blank screens with a dashed outline and "+", reserved screens, image and muted video ads with an "Ad" label, picking, video budget. |
| `apps/hub/src/ads/modal.ts` | The form: upload, preview, details, consent, Stripe Payment Element, "submitted for review". |
| `apps/hub/src/ads/config.ts` | **Every tunable**: price, currency, run length, reservation timeout, file types and size limits, text limits, URL rules. Shared with the Worker. |
| `workers/ads` | The backend on `worldmesh.net/api/ads/*`: uploads, Stripe, webhook, cron, emails, admin moderation page. |
| `db/migrations/0005_ads.sql` | `ad_submission` and `ad_stripe_event` in the shared D1 database. |
| R2 bucket `worldmesh-ads` | The uploaded files. Private. |

Nothing new was added where WorldMesh already had something: D1, R2, Resend,
the Workers-on-the-hub-origin pattern and the WorldMesh accounts are all reused.
Stripe is new; it is called over its REST API with plain `fetch` (no SDK).

## Defaults

All in `apps/hub/src/ads/config.ts`; the hub and the Worker both read it.

| Setting | Default |
| --- | --- |
| **Hub ads UI** (`enabled`) | **Off** — billboards are not mounted until deliberately enabled (see below) |
| Price | €2 (`priceCents: 200`, `currency: 'eur'`) |
| Run length after approval | 30 days |
| Unpaid reservation | 15 minutes |
| Released before the card authorization lapses | 2 hours (Stripe's `capture_before`; ~7 days, fallback 7 days) |
| Images | PNG, JPG/JPEG, WebP · ≤ 5 MB · ≤ 4096 px longest side · ≥ 64 px |
| Videos | MP4, WebM · ≤ 25 MB · ≤ 60 s · ≤ 1920 px longest side (length and size checked in the browser) |
| Video still frame | JPEG · ≤ 600 KB · ≤ 1280 px |
| Advertiser name / email / URL | ≤ 80 / 254 / 2048 characters |
| Unpaid reservations per client | 2 |
| Files kept after a submission ends | 30 days (1 day if abandoned before payment) |

### Turning the hub ads UI on

Walk mode hides bookable billboards (no +, no “Click to advertise”, no ad
modal, no live-ad rendering) until this flag is on. Flip it when the ads Worker
is deployed and ready to take submissions:

1. **Build env (preferred for production):** set `VITE_ADS_ENABLED=true` on the
   hub Pages project, then redeploy the hub.
2. **Config constant:** set `enabled: true` in `AD_CONFIG` in
   `apps/hub/src/ads/config.ts`, then rebuild the hub.

`VITE_ADS_ENABLED=false` forces the UI off even if the config constant is true.
Leave the env unset to follow `AD_CONFIG.enabled` (default off).

## How a submission moves

| Status | Meaning | Billboard |
| --- | --- | --- |
| `awaiting_payment` | Uploaded; the advertiser has `reservationMs` (15 min) to authorize. | held |
| `pending` | €2 authorized, not captured. Waiting for review. | held |
| `approved` | Approved; capture in progress (seconds). | held |
| `active` | Captured and on the billboard until `ends_at`. | shows the ad |
| `rejected` | Rejected; authorization released. | free |
| `expired` | The authorization lapsed before review, the run ended, or an admin took it down. | free |
| `cancelled` | Abandoned before payment (window closed, reservation ran out, upload or Stripe failure). | free |
| `failed` | Approved, but the capture was refused (e.g. the authorization had lapsed). Nothing charged. | free |

- **Reservation.** A partial unique index allows one live submission
  (`awaiting_payment`, `pending`, `approved`, `active`) per billboard. Two
  people racing for the same screen cannot both get one, whatever the timing.
  An unpaid hold that has run out is released (after asking Stripe) the moment
  someone else wants the billboard, or by the cron.
- **Only these moves exist.** A trigger in the migration aborts any other
  status change, from any code path.
- **Money only moves on Stripe's word.** The browser never reports a payment
  status. After Stripe.js confirms the card, the hub asks the Worker, which
  fetches the PaymentIntent from Stripe. Webhooks are verified with the
  endpoint secret and de-duplicated by event id; every handler is a
  conditional update, so repeats and out-of-order events are harmless.
- **Authorization window.** Cards hold an uncaptured authorization for about 7
  days; Stripe gives the exact deadline (`capture_before`). The cron releases
  pending authorizations 2 hours before it and emails the advertiser. The
  moderation email and page show the deadline.
- **Closing the payment window** releases the billboard at once (fetch with
  `keepalive`, or a beacon on page unload); if the card was authorized a
  moment earlier, it goes to review instead. If nothing reaches the server,
  the reservation simply times out.
- **Failed captures** move the submission to `failed` (nothing charged, the
  billboard is freed, the advertiser is emailed), or back to `pending` if the
  authorization is still valid so the admin can retry. If Stripe cannot be
  reached at all, the capture (idempotent) is settled by the webhook or the cron.
- **Emails** (moderation email to the admin; approved, rejected, expired and
  failed emails to the advertiser) are sent once each; the cron retries any
  that did not go out.
- **Files** of submissions that ended are deleted from R2 after 30 days (1 day
  if abandoned before payment).

## Moderation

The moderation email has the image (or the video's still frame and a link to
watch it), the advertiser, their email, the destination URL, the billboard,
the submission date and the price, plus a **Review Advertisement** button.
Media links in the email are HMAC-signed and expire; nothing is attached.

The button opens `/api/ads/admin/review?id=…`. It is only shown to someone
**signed in to WorldMesh whose verified account email is in `ADMIN_EMAILS`**
(checked against the shared D1 `session` table from the hub's own session
cookie). Anyone else gets a sign-in page or a 403, never the content.
Approve, Reject (with an optional reason sent to the advertiser) and Take down
are form posts that also require a same-origin request and a CSRF token bound
to the admin's session. There is no API an advertiser could call to approve
their own advertisement. `GET /api/ads/admin` lists every submission.

Taking a live advertisement down does not refund automatically; refund it in
the Stripe dashboard if appropriate.

## Security summary

- Files: extension, declared MIME type and the file's leading bytes must all
  agree (PNG, JPEG, WebP, MP4, WebM only; no SVG, GIF or QuickTime), within the
  size limit; image pixel sizes are read from the header and capped. Stored
  under random names in a private bucket, served with `nosniff`, a restrictive
  CSP and the validated type.
- Destination URLs: `https://` only, a public hostname, no credentials, no
  whitespace or control characters. Rechecked in the browser before opening,
  always with `noopener,noreferrer`.
- Text: advertiser names lose control, formatting and markup characters; all
  output is HTML-escaped; emails are normalised.
- Uploads must come from the hub's origin, are rate-limited per IP, and one
  client can hold at most two unpaid reservations.
- Secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `ADS_SIGNING_SECRET`,
  `RESEND_API_KEY`) live only in the Worker. The browser only ever sees the
  publishable key and a PaymentIntent client secret.

## In the 3D city

- Empty screens are blank with a subtle dashed outline floating just in front
  and a "+". The one under the crosshair (desktop) or in the middle of the
  screen (phones) lights up, and a prompt says "Click/Tap to advertise here · €2".
- Clicking or tapping works with pointer lock (the crosshair picks), with a
  free cursor, and with touch (a quick tap, not a drag, so looking around and
  the joystick never trigger it). Walls and towers in front block the pick.
  Opening the form releases the mouse, and the form swallows keyboard and
  pointer input so the player never moves behind it.
- Live ads: images as textures (downscaled to 1024 px on phones, 2048 px on
  desktop), videos as `VideoTexture`s. Always shown whole (letterboxed), with
  an "Ad" label. Clicking or tapping opens the destination in a new tab.
- Videos are always muted and inline. A video only decodes while it is on
  screen, facing you and within 70 m, at most 2 at a time on phones (4 on
  desktop). Otherwise it pauses and shows its still frame, and after 8 s off
  screen (or beyond 110 m) its decoder and texture are released. Everything
  pauses while the tab is hidden. Textures, materials and videos are disposed
  when an ad changes and when walk mode closes.
- Billboard state is refreshed every minute.

## Setup (production)

1. **R2**: `npx wrangler r2 bucket create worldmesh-ads` (private; no public access).
2. **D1**: apply the migration: `cd workers/auth && npx wrangler d1 migrations apply worldmesh --remote`.
3. **Stripe**: Dashboard → Developers → Webhooks → Add endpoint
   `https://worldmesh.net/api/ads/stripe/webhook` with these events:
   `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`,
   `payment_intent.succeeded`, `payment_intent.canceled`, `charge.expired`.
   Card payments must be enabled (Apple Pay / Google Pay work through them).
4. **Worker config**: set `STRIPE_PUBLISHABLE_KEY` and `ADMIN_EMAILS` in
   `workers/ads/wrangler.toml`, then the secrets:
   ```bash
   npx wrangler secret put STRIPE_SECRET_KEY --config workers/ads/wrangler.toml
   npx wrangler secret put STRIPE_WEBHOOK_SECRET --config workers/ads/wrangler.toml
   npx wrangler secret put RESEND_API_KEY --config workers/ads/wrangler.toml
   npx wrangler secret put ADS_SIGNING_SECRET --config workers/ads/wrangler.toml   # openssl rand -base64 32
   ```
   Emails go out from `FROM_EMAIL` (default `WorldMesh <accounts@worldmesh.net>`),
   so `worldmesh.net` must be verified in Resend first
   ([cloudflare-deployment.md](cloudflare-deployment.md#4-email-notifications-via-resend)).
5. **Deploy**: `cd workers/ads && npx wrangler deploy`. The route
   `worldmesh.net/api/ads/*` sits in front of the Pages project like the auth
   and federation routes.
6. **Turn on the hub ads UI**: set `VITE_ADS_ENABLED=true` on the hub Pages
   project (or `AD_CONFIG.enabled = true`) and redeploy the hub. Until then,
   walk mode does not mount bookable billboards.
7. **Admin account**: sign in on worldmesh.net with the account whose verified
   email is in `ADMIN_EMAILS` (Google works well).

## Local development

```bash
cp workers/ads/.dev.vars.example workers/ads/.dev.vars   # Stripe test keys etc.
npm run db:migrate:local
npm run dev:ads                                          # port 8790
stripe listen --forward-to localhost:8790/api/ads/stripe/webhook   # prints the whsec_ for .dev.vars
VITE_ADS_ENABLED=true npm run dev:hub                    # proxies /api/ads to 8790; ads UI on
```

Without `VITE_ADS_ENABLED=true`, the hub builds with ads off (tower screens are
not bookable). To moderate locally, also run `npm run dev:auth` and sign in on
localhost.
Tests: `npm test --prefix workers/ads` (in-memory D1 and R2, a fake Stripe).
