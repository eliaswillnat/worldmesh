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
