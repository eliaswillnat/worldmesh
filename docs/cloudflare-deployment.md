# Deploying WorldMesh to Cloudflare Pages

Every app in WorldMesh is an independent Vite static application. Following WorldMesh's core principle—that the hub holds URLs and each world is independently hosted—each app can be deployed as an independent Cloudflare Pages project pointing to this repository.

---

## 1. Project Configuration Summary

When creating your Cloudflare Pages projects in the [Cloudflare Dashboard](https://dash.cloudflare.com/) (**Workers & Pages** > **Create application** > **Pages** > **Connect to Git**), create one project for each app using the following settings:

| Cloudflare Pages Project | Root Directory | Framework Preset | Build Command | Build Output Directory | Default URL |
| :--- | :---: | :---: | :--- | :--- | :--- |
| **`worldmesh-hub`** (or `worldmesh`) | `/` | Vite | `npm run build:hub` | `apps/hub/dist` | `https://worldmesh-hub.pages.dev` |
| **`worldmesh-forest`** | `/` | Vite | `npm run build:forest` | `apps/forest/dist` | `https://worldmesh-forest.pages.dev` |
| **`worldmesh-mars`** | `/` | Vite | `npm run build:mars` | `apps/mars/dist` | `https://worldmesh-mars.pages.dev` |
| **`worldmesh-city`** | `/` | Vite | `npm run build:city` | `apps/city/dist` | `https://worldmesh-city.pages.dev` |
| **`worldmesh-medieval`** | `/` | Vite | `npm run build:medieval` | `apps/medieval/dist` | `https://worldmesh-medieval.pages.dev` |
| **`worldmesh-space`** | `/` | Vite | `npm run build:space` | `apps/space/dist` | `https://worldmesh-space.pages.dev` |

> **Note on Root Directory:** Keep the root directory as `/` so npm workspaces and monorepo dependencies are properly resolved during installation.

---

## 2. Environment Variables & URL Wiring

The repository is pre-configured with smart fallbacks:
- **In Local Development (`npm run dev:all`)**: All links default to `http://localhost:5170` (Hub) and `5171`–`5175` (Worlds).
- **In Production Builds**: Defaults automatically to `https://worldmesh-<subdomain>.pages.dev/`.

### Custom Domain Configuration (Optional)

If you own a custom domain (e.g. `worldmesh.net`):

#### Option A: Base Domain (Simplest)
Set this single environment variable on the **`worldmesh-hub`** project:
```env
VITE_WORLDS_BASE_DOMAIN=worldmesh.net
```
The Hub will automatically point to `https://forest.worldmesh.net/`, `https://mars.worldmesh.net/`, etc.

And on each **World** project, set:
```env
VITE_WORLDMESH_HUB=https://worldmesh.net/
```
The world's overlay badge will link directly back to the custom domain Hub.

#### Option B: Explicit Individual URLs
You can configure explicit URLs in the **`worldmesh-hub`** project settings:
```env
VITE_WORLD_FOREST_URL=https://forest.yourdomain.com/
VITE_WORLD_MARS_URL=https://mars.yourdomain.com/
VITE_WORLD_CITY_URL=https://city.yourdomain.com/
VITE_WORLD_MEDIEVAL_URL=https://medieval.yourdomain.com/
VITE_WORLD_SPACE_URL=https://space.yourdomain.com/
```

### Webhook for Submissions (Optional)
In `worldmesh-hub`, set:
```env
VITE_NOTIFY_WEBHOOK=https://your-webhook-endpoint
```
To receive notifications for new world submissions via Discord, Slack, Zapier, Make, n8n, or a Cloudflare Worker.

---

## 3. Cross-Origin Manifests & Headers

Cloudflare Pages automatically reads the `_headers` and `_redirects` files in `apps/*/public`:
- **`_headers`**: Sets `Access-Control-Allow-Origin: *` so the Hub can fetch manifests (`worldmesh.json`) from any world cross-origin.
- **`_redirects`**: Automatically rewrites requests from `/.well-known/worldmesh.json` to `/worldmesh.json`.

---

## 4. Email Notifications via Resend

The Hub automatically routes world submission alerts to `/api/notify`, which is handled by a Cloudflare Pages Function at `functions/api/notify.ts`.

### Approving submissions

Pages deploys only the repo-root `functions/`; each route there re-exports its
implementation from `apps/hub/functions/`. The approval flow:

1. `/api/notify` stores the submission as `pending:<id>` in the `WORLDS` KV and
   emails you, with an **Approve World** link.
2. The link (`/api/approve`) opens a confirmation page; its button approves.
   Opening the link alone changes nothing, because mail link scanners open links on
   their own. The admin dashboard's "Save and approve" posts to the same link.
3. Approving moves the entry to `approved:<id>`, emails the creator, and queues
   the world's door view in `workers/screenshot`.
4. The hub lists approved worlds from `/api/worlds`, next to
   `apps/hub/src/community.json` (whose entries win for the same URL).

The `worldmesh-hub` Pages project needs the `WORLDS` KV binding, `RESEND_API_KEY`,
`SCREENSHOT_SECRET` (to queue door views) and, for `/api/admin/submit`,
`APPROVE_SECRET`. Without the KV binding, submissions are only emailed.

### Setup in 2 Minutes:

1. **Get your API Key from [Resend](https://resend.com/)**:
   - Sign up / log in at [resend.com](https://resend.com/).
   - Go to **API Keys** > **Create API Key** (e.g. `worldmesh-notifications`).
   - Copy the key (`re_...`).

2. **Add Environment Variables to `worldmesh-hub` in Cloudflare Pages**:
   - In Cloudflare Pages, open your **`worldmesh-hub`** project.
   - Go to **Settings** > **Environment variables**.
   - Add:
     - `RESEND_API_KEY`: your `re_...` key (encrypt as Secret).
     - `NOTIFICATION_EMAIL`: `elias.willnat@gmail.com` (or your chosen notification email).
     - `FROM_EMAIL` (optional): defaults to `WorldMesh <accounts@worldmesh.net>`.

3. **Verify `worldmesh.net` in Resend (required for the default sender)**:
   - In Resend, go to **Domains** > **Add Domain** > enter `worldmesh.net`.
   - Resend will show you 3 DNS records (DKIM TXT, SPF TXT, MX).
   - Because your DNS is on Cloudflare, you can add those 3 records into Cloudflare DNS in 30 seconds.
   - Resend refuses to send from a domain it has not verified, so until this is
     done, emails from the hub, `workers/notify` and `workers/ads` fail. To test
     before then, set `FROM_EMAIL` to `WorldMesh <onboarding@resend.dev>`
     (Resend's sandbox sender, which only delivers to your own Resend account's email).

---

## 5. Presence relay (multiplayer)

The hub's walk mode shows everyone else who is in the lobby, and any world
created with `multiplayer: true` shows everyone else in that world. Positions
are relayed by a small Worker with one Durable Object per room, in
`workers/presence`. It stores nothing and carries only positions. The runtime's
default server (`DEFAULT_PRESENCE_SERVER`) points at this Worker.

1. Deploy it (SQLite-backed Durable Objects work on the Workers free plan):
   ```bash
   cd workers/presence
   npx wrangler deploy
   ```
2. Give the Worker the custom domain `relay.worldmesh.net` (Worker →
   Settings → Domains & Routes). The hub and the runtime's
   `DEFAULT_PRESENCE_SERVER` both connect to `wss://relay.worldmesh.net`. To
   point the hub somewhere else, set on **`worldmesh-hub`**:
   ```env
   VITE_PRESENCE_ENDPOINT=wss://relay.example.com
   ```
3. Keep the Worker's `workers.dev` address switched on.
   `@worldmesh/runtime@0.2.0` has `wss://worldmesh-presence.elias-willnat.workers.dev`
   built in, so worlds still on that version lose multiplayer without it.

If the presence Worker is unreachable, walk mode still works single-player.

Walk-mode doors show each world's cover image inside WebGL, which needs CORS. The
R2 bucket does not send CORS headers, so the hub relays covers through the
same-origin Pages Function `/api/cover` (allow-listed to the covers bucket;
add more hosts with a comma-separated `COVER_HOSTS` variable). Worlds whose
cover cannot be loaded show a procedural tunnel instead.

---

## 6. Accounts and federation

`workers/auth` and `workers/federation` are Workers routed onto the hub's own
hostname, sharing one D1 database. Setup, secrets and routes are in
[accounts-and-federation.md](accounts-and-federation.md), including OAuth
provider setup (Google, Apple, GitHub, Discord redirect URLs and Worker
secret names).

---

## 7. Billboard advertising

`workers/ads` is a Worker routed onto the hub's hostname (`/api/ads/*`), using
the same D1 database, a private R2 bucket (`worldmesh-ads`), Stripe and
Resend. Bucket, migration, Stripe webhook, secrets and admin accounts are in
[advertising.md](advertising.md#setup-production).

---

## 8. Admin dashboard

`workers/admin` serves `admin.worldmesh.net` (a Custom Domain) and one hand-off
path on the hub's hostname (`/api/dashboard/*`). It reads D1, the hub's `WORLDS`
KV, the `VIEWS` KV and the presence rooms. Setup in [admin.md](admin.md#deploy).

---

## 9. Private previews

To try a branch on a private copy before it reaches worldmesh.net, see
[previews.md](previews.md). It uses separate projects, Workers and data, and
doesn't change anything above.
