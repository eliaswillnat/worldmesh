# Accounts and federation

Two separate Workers on the hub's own hostname, sharing one D1 database.
Neither is on the path of a 3D world, and `@worldmesh/runtime` knows about
neither.

```
hub (Cloudflare Pages, worldmesh.net)
 │  /api/auth/*, /api/account/*        ──►  workers/auth        Better Auth: Google, Apple, GitHub, Discord
 │  /.well-known/webfinger, /ap/*, /@* ──►  workers/federation  WebFinger + ActivityPub
 │  /api/ads/*                         ──►  workers/ads         billboard ads (see advertising.md)
 │  everything else                    ──►  Pages (static + existing /api Functions, KV)
 ▼
D1 "worldmesh"  (db/migrations)  — canonical WorldMesh data
 ▲
 └── workers/federation ──► Mastodon, Pixelfed, … (signed HTTP, SSRF-guarded)
```

Worker routes take precedence over the Pages project on the same hostname, so
nothing about the hub's deployment changes.

## Accounts (`workers/auth`)

- **Better Auth 1.7** with its native D1 dialect. Google, Apple, GitHub and
  Discord; no passwords, no email flows. The dialog shows only providers whose
  secrets are set (`GET /api/account/providers`).
- **Apple specifics**: the client secret is an ES256 JWT that Apple limits to
  six months, so the Worker mints a 2-day one from the `.p8` key itself
  (`src/apple.ts`); nothing to rotate. Apple posts the callback cross-site
  (`form_post`), so `https://appleid.apple.com` is a trusted origin and Better
  Auth bounces the POST to a same-site GET before the state cookie is checked.
  Apple sends the user's name only on the first sign-in and may hide the email
  behind a relay address; a missing name falls back to the username.
- **Sessions**: `__Secure-worldmesh.session_token`, HttpOnly, Secure,
  SameSite=Lax, host-only (never sent to worlds on subdomains). 30 days,
  sliding once a day. A signed 5-minute cookie cache means most
  `/api/account/me` calls never touch D1. A revoked session can stay valid for
  up to those 5 minutes.
- **OAuth**: state + PKCE verifier live in an encrypted, browser-bound cookie
  (no D1 row per attempt). Callback and redirect URLs are checked against the
  hub origin. Origin/CSRF checks are pinned on (Better Auth turns them off
  under `NODE_ENV=test`).
- **Account linking**: identities with the same email become one user only
  when both providers say the email is verified. Apple relay addresses and
  unverified Discord emails therefore stay separate accounts.
- **No provider tokens stored**: a database hook blanks access/refresh/id
  tokens before they reach D1.
- **Usernames**: `^[a-z][a-z0-9_]{2,29}$`, reserved words refused, unique,
  **set once** (it becomes a fediverse identity; renames would strand remote
  followers). `POST /api/account/username` requires a same-origin request.
- **Rate limits**: a Cloudflare rate-limit binding per IP on sign-in,
  callbacks, sign-out and username changes, plus Better Auth's own limiter.
- **Cost of anonymous visitors: zero.** The hub only asks `/api/account/me`
  when this browser has signed in before (a `localStorage` hint, not a
  credential).

Endpoints: Better Auth's under `/api/auth/*` (the hub uses
`POST /sign-in/social`, `GET /callback/:provider`, `POST /sign-out`), plus
`GET /api/account/me` and `POST /api/account/username`.

### OAuth provider setup (production)

Callbacks live on the hub origin (`BETTER_AUTH_URL`). For
`https://worldmesh.net` that is:

```
https://worldmesh.net/api/auth/callback/<provider>
```

Set each provider's secrets on the `worldmesh-auth` Worker
(`npx wrangler secret put <NAME> --config workers/auth/wrangler.toml`). A
provider only appears in `GET /api/account/providers` (and on the login
dialog) once all of its secrets are set. Local development copies the same
names into `workers/auth/.dev.vars` (see `.dev.vars.example`); callbacks
then use `http://localhost:5170/api/auth/callback/<provider>`.

| Provider | Redirect URL | Secrets |
| --- | --- | --- |
| Google | `…/callback/google` | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Apple | `…/callback/apple` | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` |
| GitHub | `…/callback/github` | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` |
| Discord | `…/callback/discord` | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |

Also set `BETTER_AUTH_SECRET` (random, ≥32 bytes). Never commit secret
values; `.dev.vars` is gitignored.

**Google** — [Google Cloud Console](https://console.cloud.google.com/) → APIs
& Services → Credentials → OAuth 2.0 Client ID (Web application). Add the
production redirect above (and a separate localhost redirect for local
dev if you use the same client).

**GitHub** — [GitHub Developer Settings](https://github.com/settings/developers)
→ OAuth Apps → New. Authorization callback URL is the production redirect.
GitHub allows only one callback URL per app, so use a separate OAuth App
for local development (`http://localhost:5170/api/auth/callback/github`).

**Discord** — [Discord Developer Portal](https://discord.com/developers/applications)
→ New Application → OAuth2. Under Redirects, add:

```
https://worldmesh.net/api/auth/callback/discord
```

Copy the Client ID and Client Secret into `DISCORD_CLIENT_ID` and
`DISCORD_CLIENT_SECRET` on `worldmesh-auth`. For local development, either
add `http://localhost:5170/api/auth/callback/discord` as a second redirect
on the same app, or use a separate Discord application.

**Apple** — Apple Developer → Identifiers → Services ID (this is
`APPLE_CLIENT_ID`, e.g. `net.worldmesh.signin`) with Sign in with Apple
enabled and the production return URL registered. Create a Sign in with
Apple key (`.p8`); put its id in `APPLE_KEY_ID`, the team id in
`APPLE_TEAM_ID`, and the `.p8` contents in `APPLE_PRIVATE_KEY`. The Worker
mints Apple's short-lived client secret from that key (`src/apple.ts`).
Apple refuses localhost return URLs — test Apple on the deployed site or
an https tunnel.

## Data model (`db/migrations`)

| Table | Owner | Holds |
| --- | --- | --- |
| `user`, `session`, `account`, `verification` | Better Auth | identity, sessions, one `account` row per linked Google/Apple/GitHub/Discord identity; `user.username` is WorldMesh's handle |
| `profile` | WorldMesh | optional bio, website, avatar override |
| `world` | WorldMesh | worlds owned by a user (`draft` → `pending` → `published`) |
| `ap_actor` | federation | local actors and their keys (private key AES-GCM encrypted) |
| `ap_remote_actor` | federation | cache of remote actors/keys |
| `ap_follower` | federation | who follows whom |
| `ap_object`, `ap_activity` | federation | what we published (the world Note, Create, Accept) |
| `ap_delivery` | federation | outgoing delivery queue with retries |
| `ap_inbox_seen` | federation | received activity ids (dedup/replay), pruned after 14 days |
| `ap_interaction` | federation | likes, boosts, replies (references only) |
| `avatar_connection` | Avatar Wallet | a connected VRoid Hub / AT Protocol / Sketchfab account (VRoid and Sketchfab tokens AES-GCM encrypted; none for AT Protocol) |
| `avatar` | Avatar Wallet | the one avatar a user picked: provider id, name, thumbnail URL. Never the model |

The public directory still comes from KV (`/api/worlds`). The `world` table is
empty until worlds are linked to accounts; nothing is copied automatically.
Worlds could become actors later (`ap_actor.kind = 'world'` is reserved) without
changing creator actors.

## Federation (`workers/federation`)

What exists, and is covered by tests against a real D1 and a simulated remote
server:

- **WebFinger** (`acct:user@worldmesh.net`, also the profile URL), host-meta,
  NodeInfo 2.1.
- **Person actors** for creators with a username, with `publicKey`, inbox,
  outbox, followers, following, shared inbox, icon, `discoverable`,
  FEP-2c59 `webfinger`. An **instance actor** (Application) signs our GETs, so
  servers in Mastodon's secure mode answer.
- **Inbox** (per actor and shared): size cap (256 KiB), content type,
  plain-JSON parsing with a depth cap (no JSON-LD expansion or remote
  contexts), draft-cavage **HTTP signature verification** (rsa-sha256/hs2019,
  Digest required on POST, 12-hour window, host bound, key refetch on
  rotation), signer must be the actor, activity id on the actor's host,
  de-duplication by id.
- **Follow → Accept** (signed, delivered to the follower's inbox),
  **Undo Follow**, Like/Announce/reply recording and their Undo, account
  Delete cleanup, Update (key refresh).
- **Announcing a world**: `Create(Note)` "Elias published Example World" with
  description, cover image attachment, canonical page
  (`/@elias/worlds/<id>`) and the world link, delivered to every follower's
  shared inbox. **Only on explicit request** (below); never automatic.
- **Outbox** (paged), follower count (list not published), empty following.
- **Delivery**: rows in `ap_delivery`, sent immediately via `waitUntil`, retried
  by a 5-minute cron with backoff for ~2 days. Swapping in Cloudflare Queues
  later means sending `{ deliveryId }` messages and calling `deliverOne` in
  the consumer.
- **SSRF guard** on every remote URL and every redirect hop: https only, port
  443, no IP literals, no private/test TLDs, not ourselves, 8 s timeout,
  512 KiB cap.
- **Edge caching** (Cloudflare Cache API) of WebFinger, actors, objects,
  outbox and profile pages, so repeated fediverse fetches cost no D1 reads.

Not done yet — needed before calling this complete interoperability:

- **RFC 9421 HTTP Message Signatures.** Only draft-cavage is implemented.
  Mastodon signs with draft-cavage and verifies both; the unreleased 4.7 only
  retries with RFC 9421 after a cavage signature is refused. Not blocking
  today, but other servers may move first.
- **Forwarded activities / LD signatures.** Activities relayed by a third
  server are refused (signer must be the actor).
- **Update/Delete of our own objects** (editing or removing a world
  announcement) and **Update of the actor** when a creator changes name or
  avatar. Remote servers refresh actors on their own schedule meanwhile.
- **Account deletion** for WorldMesh users should send `Delete(actor)`; the
  schema cascades locally but nothing is broadcast yet.
- **A self-service publish flow.** Linking worlds to accounts in the hub, and
  calling the announce step when a world is approved, is the next piece.
- **Moderation**: blocking domains/actors, handling `Flag` reports.
- **Scale**: the free plan's 10 ms CPU and 50 subrequests per invocation cap a
  delivery run at ~8 inboxes; followers spread over many servers take several
  cron runs to reach. Workers Paid ($5/month) removes that limit.

Generating an RSA key takes 50–200 ms of CPU, which exceeds the free plan's
10 ms per request; Workers tolerate occasional overruns. It happens once per
creator (and once for the instance actor).

## Announcing a world (for now)

1. The world row must exist in D1, be `published` and owned by a user with a
   username:
   ```bash
   npx wrangler d1 execute worldmesh --remote --config workers/auth/wrangler.toml --command "insert into world (id, owner_user_id, name, url, description, cover_url, status, created_at, updated_at, published_at) values ('example-world-abc123', (select id from \"user\" where username = 'elias'), 'Example World', 'https://example.com/', 'A short description', 'https://…/cover.webp', 'published', unixepoch()*1000, unixepoch()*1000, unixepoch()*1000)"
   ```
2. Announce it (idempotent):
   ```bash
   curl -X POST https://worldmesh.net/ap/admin/announce -H "Authorization: Bearer $FEDERATION_ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"worldId":"example-world-abc123"}'
   ```

## Avatar Wallet setup

How it works: [avatar-wallet.md](avatar-wallet.md). Separate from federation.

1. Migrate: `npx wrangler d1 migrations apply worldmesh --remote --config workers/auth/wrangler.toml` (adds `0004_avatar_wallet.sql` and `0006_avatar_sketchfab.sql`).
2. `npx wrangler secret put AVATAR_SECRET --config workers/auth/wrangler.toml` (`openssl rand -base64 32`). The wallet stays hidden until it is set.
3. Sketchfab: ask Sketchfab support for OAuth credentials (sketchfab.com/developers/oauth) with the authorization code grant and redirect URI `https://worldmesh.net/api/account/avatar/callback/sketchfab`, then `wrangler secret put SKETCHFAB_CLIENT_ID` and `SKETCHFAB_CLIENT_SECRET`.
4. VRoid Hub: register as a developer at hub.vroid.com/en/developer/registration, create an application at hub.vroid.com/oauth/applications with redirect URI `https://worldmesh.net/api/account/avatar/callback/vroid` and scope `default` (set `VROID_SCOPE` if you choose another), then `wrangler secret put VROID_CLIENT_ID` and `VROID_CLIENT_SECRET`.
5. at3d / AT Protocol: nothing to register. The client id is `https://worldmesh.net/api/account/avatar/atproto/client-metadata.json`, served by the Worker. Authorization servers cache that document, so after its `scope` changes (as when "Upload from device" was added), uploads can be refused with `invalid_scope` until their cache refreshes.
6. No new Worker routes: everything lives under the existing `worldmesh.net/api/account/*` route.

## Local development

```bash
npm run db:migrate:local
```

```bash
npm run dev:auth
```

```bash
npm run dev:federation
```

```bash
npm run dev:hub
```

Copy `workers/*/.dev.vars.example` to `.dev.vars` first. The hub dev server
proxies `/api/auth`, `/api/account`, WebFinger, `/ap` and `/@name` to the local
Workers, so cookies and OAuth callbacks use `http://localhost:5170`.

Tests: `npm run test:workers` (real local D1 via wrangler; no network).
