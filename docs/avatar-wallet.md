# Avatar Wallet

Visitors can bring a character from an avatar platform into compatible worlds.
**WorldMesh stores the pointer, never the character**: no VRM, GLB, glTF,
texture or other avatar file is ever uploaded to, proxied through, mirrored by
or cached on WorldMesh (Workers, D1, KV, R2). Models download in the visitor's
browser, straight from the platform that hosts them.

Independent of ActivityPub. Neither system reads the other's tables.

```
hub (worldmesh.net)                       workers/auth  (/api/account/avatar/*)          platform
 Choose your character ── connect ──────►  OAuth (PKCE; AT Proto: PAR + DPoP) ────────►  VRoid Hub / user's PDS
                       ── pick ─────────►  D1: avatar_connection, avatar (refs only)
 world link #wm-avatar=<ticket> ─┐
                                 ▼
world (any host) @worldmesh/runtime ── POST /resolve {ticket} ──► descriptor { format, modelUrl, … }
                 └────────────────────── GET modelUrl ─────────────────────────────►  VRoid S3 / PDS blob
```

## Providers

| | VRoid Hub | at3d (AT Protocol) |
| --- | --- | --- |
| Where avatars live | VRoid Hub (pixiv) | `app.at3d.avatar` records + blobs in the user's own PDS |
| Sign-in | OAuth 2.0 + PKCE, `X-Api-Version: 11` | AT Protocol OAuth: PAR, PKCE, DPoP (ES256), public client |
| Listing | `GET /api/account/character_models` (the user's own models) | `com.atproto.repo.listRecords` (public) |
| Loading | `POST /api/download_licenses` → `GET …/{id}/download` → 302 to an S3 presigned URL | `com.atproto.sync.getBlob` on the PDS (public, `Access-Control-Allow-Origin: *`) |
| Formats | VRM (0.x, 1.0) | VRM, GLB, glTF (parametric avatars are skipped) |
| Stored | VRoid user id + name, access/refresh tokens **AES-GCM encrypted** | DID, handle, PDS URL. **No tokens**: revoked right after the DID is verified |
| Refresh | refresh token, on demand before each use | none needed |

**Why not Avaturn or MetaPerson?** Both keep avatars under the *integrating
developer's* project (API-created anonymous users, paid API tiers), not in an
account the visitor owns and reconnects to. WorldMesh would become the account
holder of everyone's avatars on those platforms, which is the opposite of this
design. They can be added later if they offer user-owned OAuth accounts.

### Limits to know about

- **VRoid Hub, other players.** A download license is for the user who issued
  it. Showing someone's VRoid avatar to *other* players (multiplayer) requires
  VRoid's "Multiplay" approval and `POST /api/download_licenses/multiplay`.
  Worlds today render only the local player, so this is not needed yet.
- **VRoid Hub, unapproved apps** may load only the user's own models (and
  models their authors allow downloading), are rate-limited per app, and show
  users an "unapproved application" warning. Approval (hub.vroid.com/apps) also
  requires showing each model's "Model Data Conditions of Use".
- **VRoid Hub, CORS.** The presigned S3 URL is fetched cross-origin by the
  world. pixiv's own web sample loads it the same way; if a world cannot, the
  runtime keeps the default body.
- **at3d** is a draft spec with little adoption so far. Records are public by
  nature of AT Protocol: anyone could already fetch them, and the blob URL
  contains the user's DID.
- **at3d locally** needs the hub on `http://127.0.0.1:5170` (AT Protocol's
  development client only accepts loopback IPs) with `BETTER_AUTH_URL` set to it.

## Adding a provider

Implement `AvatarProvider` (`workers/auth/src/avatars/types.ts`: `connect`,
`completeConnect`, `disconnect`, `listAvatars`, `getAvatar`, `resolveAvatar`,
`refreshAuth`) and list it in `PROVIDERS` (`routes.ts`), plus the
`provider` check in the migration. Routes, storage, the hub UI and the runtime
stay unchanged: the runtime only ever sees an `AvatarDescriptor`.

## Handoff to worlds

1. On the hub, once a character is picked, `POST /api/account/avatar/handoff`
   returns a **ticket**: the user id and a 12-hour expiry, sealed with AES-GCM.
   Opaque to everyone but the Worker.
2. Clicking a world card appends `#wm-avatar=<ticket>` to its URL. Fragments are
   never sent to servers or in `Referer`; the link is restored right after, so
   copied links carry no ticket.
3. The runtime removes the fragment from the address bar, keeps the ticket in
   `sessionStorage`, and calls `POST /api/account/avatar/resolve` (CORS `*`, no
   cookies). The answer is `{ avatar: AvatarDescriptor | null }`.
4. Portals add the ticket to the next world's URL, so the avatar follows.

A ticket resolves to *whatever is selected now*: picking "Continue without
character" or disconnecting a platform stops every outstanding ticket at once.
It can reveal the chosen avatar's descriptor to whoever holds it, and nothing
else: no session, no account details, no platform tokens, no WorldMesh user id.

## Endpoints (`/api/account/avatar`, routed with `/api/account/*`)

| | |
| --- | --- |
| `GET /wallet` | providers, connections, selected avatar (D1 only) |
| `GET /connections/:id/avatars` | live listing from the platform |
| `POST /connect/:provider` `{ handle? }` | → `{ url }` of the platform's authorization page |
| `GET /callback/:provider` | platform redirect target → `/?avatar=connected\|error` |
| `POST /select` `{ connectionId, avatarId }` or `{ avatarId: null }` | pick, or continue without character |
| `POST /disconnect` `{ connectionId }` | revoke (VRoid) and forget |
| `POST /handoff` | → `{ ticket, expiresAt }` |
| `POST /resolve` `{ ticket }` | for worlds; CORS, cookie-less |
| `GET /atproto/client-metadata.json` | AT Protocol OAuth client metadata |

State-changing calls require a same-origin request and a session. OAuth state,
the PKCE verifier and (AT Protocol) the DPoP key ride in an encrypted, HttpOnly,
callback-path cookie, bound to the signed-in user. Every AT Protocol host (handle
domain, did:web host, PDS, authorization server) passes a public-https-only
guard, including redirects. Connect, callback, listing, select, handoff and
resolve are rate-limited per IP.

## Cost

One small D1 row per connection and at most one per user for the selection.
Listing and resolving cost a couple of subrequests to the platform. The model
bytes never touch Cloudflare, so avatar bandwidth and storage cost WorldMesh
nothing.

## Setup

See the checklist in [accounts-and-federation.md](accounts-and-federation.md#avatar-wallet-setup).
