# WorldMesh relay

Your own presence relay for [WorldMesh](https://worldmesh.net) multiplayer:
visitors of the same world see each other walk, turn and chat. It is the same
code as WorldMesh's free shared relay, on your Cloudflare account, so the
limits are yours to set and the traffic is yours to pay for. It stores no
positions or chat.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/eliaswillnat/worldmesh/tree/main/templates/relay)

## Deploy

1. Click the button. Cloudflare copies this folder into a new repository on
   your GitHub or GitLab account and deploys it as a Worker. The Workers free
   plan is enough: SQLite-backed Durable Objects and rate limits are on it.
2. Point your world at it:
   ```js
   createWorldMesh({
     scene, camera, renderer,
     multiplayer: { server: 'wss://worldmesh-relay.<your-subdomain>.workers.dev' },
   });
   ```
   A custom domain works too (Worker → Settings → Domains & Routes).

Each push to your new repository deploys again.

Without the button:

```bash
npm create cloudflare@latest my-relay -- --template eliaswillnat/worldmesh/templates/relay
```

then `npx wrangler deploy` in `my-relay`.

## Settings

Vars in `wrangler.toml`. Change them there and deploy: a deploy replaces vars
edited in the dashboard.

| Var | Default | |
| :--- | :--- | :--- |
| `WORLD_ROOMS` | `on` | A room per world, picked from the page's `Origin`. `off`: named rooms only. |
| `MAX_WORLD_PEERS` | `16` | People at once in one world's room. Past it, visitors see “World is full”. |
| `WORLD_DAILY_MINUTES` | `0` | Minutes each world's room may be active per UTC day (only while someone moves). `0`: no limit. |
| `OWN_ORIGINS` | | Worlds exempt from that limit: origins, or `*.example.net` for every https subdomain. |
| `NAMED_ROOMS` | | Named rooms (`/room/<name>`), e.g. `lobby` for a city's own lobby. |
| `MAX_ROOM_PEERS` | `64` | People at once in one named room. |

`JOIN_LIMIT` and `READ_LIMIT` limit joins and occupancy reads per IP address.

## Who can use it

Anyone who knows the address can point a world at your relay. Each world gets
its own room, and a page cannot join another site's room from a browser, but
the traffic counts against your account. To keep other worlds small, set
`WORLD_DAILY_MINUTES` (e.g. `"240"`) and list your own worlds in
`OWN_ORIGINS`. To refuse a world outright, set the secret `BLOCKED_ORIGINS`
(comma-separated origins):

```bash
npx wrangler secret put BLOCKED_ORIGINS
```

On the Workers free plan nothing is billed: past the daily free usage, joins
fail and worlds stay single-player until it resets. On a paid plan, add a
Usage Based Billing notification (Cloudflare → Notifications).

The relay sees visitors' IP addresses to connect them, as any server does. It
is yours, so your privacy policy covers it.

## More

- Local: `npm install`, `npm run dev`, then `ws://localhost:8787/world`.
- Protocol and limits: the comment at the top of `src/index.ts` and
  [docs/compatibility.md](https://github.com/eliaswillnat/worldmesh/blob/main/docs/compatibility.md#multiplayer).
- Updates: your copy does not follow WorldMesh's. To take a newer relay, copy
  [`src/`](https://github.com/eliaswillnat/worldmesh/tree/main/templates/relay/src)
  over yours.
