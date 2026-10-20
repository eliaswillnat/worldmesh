# Avatar Wallet

Visitors can bring a character from an avatar platform into compatible worlds.
**WorldMesh stores the pointer, never the character**: no VRM, GLB, glTF,
texture or other avatar file is ever uploaded to, proxied through, mirrored by
or cached on WorldMesh (Workers, D1, KV, R2). Models download in the visitor's
browser, straight from the platform that hosts them.

Independent of ActivityPub. Neither system reads the other's tables.

```
hub (worldmesh.net)                       workers/auth  (/api/account/avatar/*)          platform
 Choose your character ── connect ──────►  OAuth (PKCE; AT Proto: PAR + DPoP) ────────►  VRoid Hub / PDS / Sketchfab
                       ── pick ─────────►  D1: avatar_connection, avatar (refs only)
 world link #wm-avatar=<ticket> ─┐
                                 ▼
world (any host) @worldmesh/runtime ── POST /resolve {ticket} ──► descriptor { format, modelUrl, … }
                 └────────────────────── GET modelUrl ─────────────────────────────►  VRoid S3 / PDS blob / Sketchfab S3
```

## My characters

Visitors can save any number of avatars (up to 100) from any of their connected
platforms to **My characters**, then switch between them or remove them. Each
saved avatar is one row in `avatar` (a pointer, never the model); at most one is
`selected`, and that one is what worlds receive.

| Endpoint | Body | Effect |
| --- | --- | --- |
| `POST /collect` | `{ connectionId, avatarId }` | Saves it (checked with the provider). What is worn does not change. |
| `POST /select` | `{ connectionId, avatarId }` | Saves it if needed and wears it. |
| `POST /select` | `{ avatarId: null }` | "Continue without character". The collection stays. |
| `POST /rename` | `{ connectionId, avatarId, name }` | Names a saved character (up to 64 characters) for this user only; the platform's name is untouched. Worlds get this name too. `null` or `""` goes back to the platform's name. |
| `POST /remove` | `{ connectionId, avatarId }` | Removes it. If it was worn, worlds get the default body. |

`GET /wallet` returns `collection` alongside `selected`. Disconnecting a
platform, or reconnecting it as a different account, removes that platform's
saved avatars.

## Uploading characters

Visitors with a connected at3d or Sketchfab account can upload a VRM or GLB
(up to 40 MB) from the wallet. The model goes **from their browser straight to
their own account**; WorldMesh never receives it. Each upload is a separate,
short authorization that is revoked as soon as the upload is done, and it is
only accepted for the account already connected (otherwise it is revoked at
once and the wallet says so).

### at3d

1. "Upload a character" asks the connected account, through AT Protocol OAuth,
   for `atproto repo:app.at3d.avatar?action=create blob:model/gltf-binary`:
   create at3d avatars and upload models, nothing else.
2. The callback does not revoke this grant. It seals it (access and refresh
   token, DPoP key) into an HttpOnly cookie scoped to `/api/account/avatar/upload`,
   bound to the user, valid at most 15 minutes. Nothing is written to D1.
3. `POST /upload/grant` gives the browser the access token and DPoP key (never
   the refresh token). The browser calls `com.atproto.repo.uploadBlob` and
   `createRecord` on the PDS with DPoP proofs (`apps/hub/src/at3dUpload.ts`),
   writing the same record shape at3d itself writes.
4. `POST /upload/done` revokes both tokens and clears the cookie; the new
   avatar is added to My characters.

The PDS must support granular OAuth scopes (bsky.social does); otherwise the
wallet says uploading is not available. The at3d lexicon is a draft: GLB
uploads use `app.at3d.avatar#gltfAppearance`, VRM uploads `#vrmAppearance`.

### Sketchfab

1. "Upload a character" runs the normal Sketchfab authorization again. The new
   tokens are **not** stored: the connection keeps its own tokens.
2. As with at3d, the grant waits in the sealed upload cookie; the browser gets
   only the access token and posts the file to `POST /v3/models` itself
   (`apps/hub/src/sketchfabUpload.ts`; `api.sketchfab.com` answers CORS), as a
   draft (`isPublished=false`) that only the owner can see.
3. `POST /upload/done` revokes both tokens (best effort: Sketchfab's revocation
   endpoint is undocumented).
4. Sketchfab processes the model for a few minutes; it then appears in the
   Sketchfab listing, where it can be saved like any other.

## My buildings

The same connections hold buildings for the hub city: Sketchfab models and
`net.worldmesh.building` records in the user's AT Protocol repository, saved
to **My buildings** the way characters are saved to My characters, as
pointers only. Uploading one uses this page's upload grant with
`{ upload: 'building' }`. See [specs/buildings.md](specs/buildings.md) §4.

A saved building goes on one of the worlds WorldMesh lists once its owner
links it there and a reviewer approves it (§5). The city then asks
`POST /api/account/building/resolve` where to download it, much as worlds ask
`/api/account/avatar/resolve` for a character: for Sketchfab the Worker gets
the presigned GLB link with the owner's stored tokens and shares it with
visitors for a few minutes; for AT Protocol it is the blob's `getBlob` URL.
The file goes from the platform to each visitor's browser, which shows it
only if it hashes to the approved SHA-256.

## Providers

| | Sketchfab | VRoid Hub | at3d (AT Protocol) |
| --- | --- | --- | --- |
| Where avatars live | The user's Sketchfab account | VRoid Hub (pixiv) | `app.at3d.avatar` records + blobs in the user's own PDS |
| Sign-in | OAuth 2.0 authorization code (+ PKCE), confidential client | OAuth 2.0 + PKCE, `X-Api-Version: 11` | AT Protocol OAuth: PAR, PKCE, DPoP (ES256), public client |
| Listing | `GET /v3/me/models` (the user's own models, up to 5 pages) | `GET /api/account/character_models` (the user's own models) | `com.atproto.repo.listRecords` (public) |
| Loading | `GET /v3/models/{uid}/download` → `glb.url`, an S3 presigned URL valid ~5 minutes (`Access-Control-Allow-Origin: *`) | `POST /api/download_licenses` → `GET …/{id}/download` → 302 to an S3 presigned URL | `com.atproto.sync.getBlob` on the PDS (public, `Access-Control-Allow-Origin: *`) |
| Formats | GLB (the glTF archive is a zip, which worlds cannot load) | VRM (0.x, 1.0) | VRM, GLB, glTF (parametric avatars are skipped) |
| Stored | Sketchfab uid + name, access/refresh tokens **AES-GCM encrypted** | VRoid user id + name, access/refresh tokens **AES-GCM encrypted** | DID, handle, PDS URL. **No tokens**: revoked right after the DID is verified |
| Refresh | refresh token, on demand (access tokens last about a month) | refresh token, on demand before each use | none needed |

**Why not Avaturn or MetaPerson?** Both keep avatars under the *integrating
developer's* project (API-created anonymous users, paid API tiers), not in an
account the visitor owns and reconnects to. WorldMesh would become the account
holder of everyone's avatars on those platforms, which is the opposite of this
design. They can be added later if they offer user-owned OAuth accounts.

**Why not Meshy or Tripo directly?** Their APIs take developer API keys only
(no user sign-in), and they do not keep what they make: Meshy deletes API
results after 3 days (rigged characters after 2 months), Tripo's download
links last 5 minutes and it has no "list my models" endpoint. A pointer to
those models would stop working, and the only alternative is storing the
files ourselves. Instead, visitors export the rigged GLB from Meshy or Tripo
and upload it to their own Sketchfab account, which WorldMesh then connects
to like any other provider. For a character that walks, export it with its
animations: the runtime plays clips named like `idle` and `walk`/`run`.

### Limits to know about

- **VRoid Hub, other players.** A download license is for the user who issued
  it. Showing someone's VRoid avatar to *other* players (multiplayer) requires
  VRoid's "Multiplay" approval and `POST /api/download_licenses/multiplay`.
  Until WorldMesh has it, VRoid avatars are shown to their owner only; other
  players see the default body (`packages/runtime/src/avatar/share.ts`).
- **VRoid Hub, unapproved apps** may load only the user's own models (and
  models their authors allow downloading), are rate-limited per app, and show
  users an "unapproved application" warning. Approval (hub.vroid.com/apps) also
  requires showing each model's "Model Data Conditions of Use".
- **VRoid Hub, CORS.** The presigned S3 URL is fetched cross-origin by the
  world. pixiv's own web sample loads it the same way; if a world cannot, the
  runtime keeps the default body.
- **Sketchfab, app registration.** Client credentials are issued by Sketchfab
  support on request (sketchfab.com/developers/oauth): send the app name, the
  authorization code grant and the redirect URI. Token revocation on
  disconnect uses `/oauth2/revoke_token/`, which Sketchfab does not document;
  it is best effort.
- **Sketchfab, own models only.** A model from someone else cannot be picked,
  even if it is downloadable. Large uploads may exceed the runtime's 40 MB
  default (`maxBytes`); the GLB size is kept in the selection's metadata.
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

## Other players

Everyone else in the room sees the visitor's character too. Each player's
browser downloads the model from the platform itself, one at a time, and keeps
the default body if that fails. The presence relay carries only a **link the
hub signed**: `{ t: 'v', u, f, i, x, s }` (URL, format, hashed id, expiry,
Ed25519 signature). The relay remembers it for whoever joins later and forgets
it when the visitor leaves.

**Why signed.** A model link is fetched by everyone in the room, so a made-up
link to a server of one's own would collect their IP addresses. `POST /resolve`
therefore returns `share` alongside the descriptor, signed with a key derived
from `AVATAR_SECRET` (`workers/auth/src/avatars/share.ts`), and the runtime
downloads someone else's model only if the signature checks out against the
hub's public key (`GET /resolve` → `{ key }`, cached for an hour). Forged,
altered or expired links are never fetched.

What the hub signs:

| | Shown to others | Why |
| --- | --- | --- |
| Sketchfab | Yes | The presigned link comes straight from Sketchfab's API. |
| at3d on Bluesky's hosts (`bsky.social`, `*.host.bsky.network`) | Yes | Bluesky's own servers. |
| at3d on any other PDS | No, owner only | A self-hosted PDS could be the owner's own logging server. |
| VRoid Hub | No, owner only | See "Limits" below. |

- Signatures last at most two hours, and no longer than the link (Sketchfab's
  ~5 minutes). The owner's page asks `/resolve` again shortly before, so late
  joiners get a working link. Players who already loaded the model keep it.
- Private mode sends no character, like no colour.
- Downloads are https only, at most 40 MB, 60 s each.
- A brief outage does not stick. If a player's page cannot fetch the hub's key
  (offline for a moment, the hub mid-deploy), it checks that link again a
  minute later instead of dropping it, and the owner's page retries a failed
  link renewal after 30 seconds.

## Endpoints (`/api/account/avatar`, routed with `/api/account/*`)

| | |
| --- | --- |
| `GET /wallet` | providers, connections, selected avatar (D1 only) |
| `GET /connections/:id/avatars` | live listing from the platform |
| `POST /connect/:provider` `{ handle? }` | → `{ url }` of the platform's authorization page |
| `GET /callback/:provider` | platform redirect target → `/?avatar=connected\|error` |
| `POST /select` `{ connectionId, avatarId }` or `{ avatarId: null }` | pick, or continue without character |
| `POST /disconnect` `{ connectionId }` | revoke (VRoid, Sketchfab) and forget |
| `POST /handoff` | → `{ ticket, expiresAt }` |
| `POST /resolve` `{ ticket }` | for worlds; CORS, cookie-less; also returns `share` (see Other players) |
| `GET /resolve` | the public key share links are signed with; CORS, not rate-limited |
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
