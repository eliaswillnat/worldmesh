# Admin dashboard

`https://admin.worldmesh.net` — one place to see everything WorldMesh runs.
It lives in `workers/admin` and is **read-only**: approving worlds and
reviewing ads keep using their existing, already-guarded flows, which the
dashboard links to.

| Page | What it shows | Source |
| --- | --- | --- |
| Overview | headline numbers, what needs you (worlds and ads waiting, services down, failing deliveries), sign-ups, sign-in providers, most viewed worlds, service health | everything below |
| Users | every account, searchable: sign-in providers, username, joined, last seen, avatars, followers | D1 |
| Worlds | submissions waiting (with the approve link), the directory with views and who is in each world now, account-owned worlds | KV `WORLDS`, KV `VIEWS`, D1, presence |
| Live | every presence room (hub lobby and each listed world): who is walking around, refreshes every 15 s | `workers/presence` |
| Ads | billboard submissions by status, captured revenue, links to the review page | D1 |
| Fediverse | followers, most-followed creators, deliveries and their errors, likes/boosts/replies, Avatar Wallet | D1 |
| Traffic | visitors, page views, requests, bandwidth, threats, countries, per-Worker requests and errors | Cloudflare GraphQL API (optional token) |
| System | health of every service and every listed world, which data sources are connected, who the admins are | HTTP checks |

## Who gets in

A WorldMesh account whose **verified** email is in `ADMIN_EMAILS` — the same
rule as the ad moderation page.

The hub's session cookie is host-only on `worldmesh.net` (it is never sent to
subdomains, on purpose), so the Worker also answers one path on the hub's
hostname, `/api/dashboard/handoff`:

1. Opening `admin.worldmesh.net` without a dashboard cookie sends you to
   `worldmesh.net/api/dashboard/handoff`.
2. That reads your hub session from D1. Not signed in: the hub's sign-in
   dialog, which comes back. An admin: a ticket signed with `ADMIN_SECRET`,
   valid for 60 seconds, naming the session.
3. `admin.worldmesh.net/auth/callback` checks it and sets its own
   `__Host-wm_admin` cookie (HttpOnly, Secure), for at most 12 hours and never
   longer than the hub session.

Every page load re-reads the session row, so signing out on the hub, the
session expiring, or an email leaving `ADMIN_EMAILS` ends access immediately.
Pages carry a CSP with no scripts at all, are never cached, framed or indexed.

For a second lock, put Cloudflare Access (Zero Trust → Access → Applications,
self-hosted, `admin.worldmesh.net`, allow your email) in front. It is free for
small teams and needs no code change.

## Deploy

```bash
# 1. Presence gains Room.stats(), which the dashboard calls. Deploy it first.
cd workers/presence && npx wrangler deploy && cd ../..

# 2. The secret that signs tickets and cookies.
openssl rand -base64 32 | npx wrangler secret put ADMIN_SECRET --config workers/admin/wrangler.toml

# 3. In workers/admin/wrangler.toml, un-comment the WORLDS KV binding and paste
#    the id of the KV namespace bound as WORLDS on the worldmesh-hub Pages project
#    (Workers & Pages → worldmesh-hub → Settings → Bindings).

# 4. Deploy. admin.worldmesh.net is a Custom Domain: Cloudflare creates the DNS
#    record and certificate itself.
cd workers/admin && npm ci && npx wrangler deploy
```

### Traffic (optional)

Create an API token (My Profile → API Tokens → Create custom token) with
**Zone › Analytics › Read** for worldmesh.net, plus **Account › Account
Analytics › Read** for per-Worker numbers. Then:

```bash
npx wrangler secret put CF_API_TOKEN --config workers/admin/wrangler.toml
```

and set `CF_ZONE_ID` and `CF_ACCOUNT_ID` in `workers/admin/wrangler.toml`
(both on the worldmesh.net zone's Overview page, right-hand column).

## Local development

```bash
cp workers/admin/.dev.vars.example workers/admin/.dev.vars   # set ADMIN_EMAILS
npm run dev:auth      # sign in at http://localhost:5170
npm run dev:hub       # proxies /api/dashboard to the admin Worker
npm run dev:admin     # http://localhost:8791
```

## Not shown (yet)

- The hub's spatial analytics events (`apps/hub/src/analytics`) have no sink,
  so nothing records them. Once they are stored, they belong on Overview.
- Stripe balance and payouts: revenue here is what D1 records as captured.
- Demo worlds on `*.pages.dev` hosts are outside the worldmesh.net zone, so
  Traffic does not count them.
