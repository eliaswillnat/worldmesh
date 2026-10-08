# Avatar Wallet

Visitors can bring a character from an avatar platform into compatible worlds,
or upload one from their device into their own account (see
[Upload from device](#upload-from-device)).
**WorldMesh stores the pointer, never the character**: no VRM, GLB, glTF,
texture or other avatar file is ever uploaded to, proxied through, mirrored by
or cached on WorldMesh (Workers, D1, KV, R2). Models download in the visitor's
browser, straight from the platform that hosts them, and uploads go from the
visitor's browser straight to their own account.

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

## Providers

| | Sketchfab | VRoid Hub | at3d (AT Protocol) |
| --- | --- | --- | --- |
| Where avatars live | The user's Sketchfab account | VRoid Hub (pixiv) | `app.at3d.avatar` records + blobs in the user's own PDS |
| Sign-in | OAuth 2.0 authorization code (+ PKCE), confidential client | OAuth 2.0 + PKCE, `X-Api-Version: 11` | AT Protocol OAuth: PAR, PKCE, DPoP (ES256), public client |
| Listing | `GET /v3/me/models` (the user's own models, up to 5 pages) | `GET /api/account/character_models` (the user's own models) | `com.atproto.repo.listRecords` (public) |
| Loading | `GET /v3/models/{uid}/download` → `glb.url`, an S3 presigned URL valid ~5 minutes (`Access-Control-Allow-Origin: *`) | `POST /api/download_licenses` → `GET …/{id}/download` → 302 to an S3 presigned URL | `com.atproto.sync.getBlob` on the PDS (public, `Access-Control-Allow-Origin: *`) |
| Formats | GLB (the glTF archive is a zip, which worlds cannot load) | VRM (0.x, 1.0) | VRM, GLB, glTF (parametric avatars are skipped) |
| Upload from device | no | no | yes: VRM up to 15 MB, GLB up to 10 MB (at3d's limits) |
| Stored | Sketchfab uid + name, access/refresh tokens **AES-GCM encrypted** | VRoid user id + name, access/refresh tokens **AES-GCM encrypted** | DID, handle, PDS URL. **No tokens**: revoked right after the DID is verified, or right after an upload |
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
  Worlds today render only the local player, so this is not needed yet.
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
- **at3d uploads** need an account server that supports AT Protocol's granular
  permissions (Bluesky's does). One that does not refuses the authorization
  request (`invalid_scope`), and the visitor is told their account cannot save
  characters from WorldMesh yet. Servers may also cap blob sizes below at3d's
  limits (the reference PDS defaults to 5 MB unless its operator raises it;
  its installer sets 300 MB); the visitor then sees "larger than your account
  accepts". Uploaded avatars have no thumbnail yet.
- **at3d locally** needs the hub on `http://127.0.0.1:5170` (AT Protocol's
  development client only accepts loopback IPs) with `BETTER_AUTH_URL` set to it.

## Upload from device

A visitor picks a `.vrm` or `.glb`; it becomes an `app.at3d.avatar` record in
their own AT Protocol account (for most people, their Bluesky account), shows
up in their at3d list, and is selected. From there it is an ordinary at3d
avatar: listing, selection, handoff and the runtime are unchanged. The hub
says "Upload from device" and "your Bluesky account", never PDS or blob.

```
hub (browser)                        workers/auth                         visitor's PDS / auth server
 pick file → check it (GLB magic,
   VRM extension, size), keep it in
   IndexedDB ── POST /connect/atproto {upload:true} ─► PAR with upload scopes ──► consent screen
 ◄──────────── /?avatar=upload ◄── callback: verify DID, keep tokens in a
                                   sealed cookie (15 min, Path=/upload) ◄─── code → tokens
 POST /upload/session ───────────► { url, accessToken, dpopKey }
 uploadBlob (DPoP) ──────────────────────────────────────────────────────────► blob ref
 POST /upload/finish {blob ref…} ► createRecord app.at3d.avatar (DPoP) ──────► at:// uri
                                   revoke, clear cookie ──────────────────────► session ended
 POST /select (as usual)
```

**What WorldMesh may do, and for how long.** Identity-only sign-in still asks
for `atproto` alone. An upload asks, at that moment, for exactly
`repo:app.at3d.avatar?action=create` and
`blob?accept=model/gltf-binary&accept=application/octet-stream`
([permission spec](https://atproto.com/specs/permission)): create avatar
records and upload model files, nothing else (no edits, no deletes, no posts).
The grant is used once: the tokens are never written to D1, they live in an
AES-GCM sealed, HttpOnly cookie bound to the WorldMesh user for at most 15
minutes, and they are revoked as soon as the record is created, the upload
fails or the visitor cancels. Each upload shows the account's consent screen.

**The bytes never touch WorldMesh.** The Worker gives the hub the upload-only
access token and its DPoP key; the browser sends the file to
`com.atproto.repo.uploadBlob` itself (the PDS answers browsers with CORS and
exposes `DPoP-Nonce`). A bodiless first request fetches the PDS's DPoP nonce
so the file is sent once. The Worker then calls `com.atproto.repo.createRecord`
with the returned blob reference, rebuilt from checked fields:

```json
{
  "$type": "app.at3d.avatar",
  "name": "<file name, ≤ 64 bytes>",
  "format": "vrm",
  "appearance": {
    "$type": "app.at3d.avatar#vrmAppearance",
    "model": { "$type": "blob", "ref": { "$link": "<cid>" }, "mimeType": "…", "size": 123 },
    "vrmVersion": "1.0"
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

GLB files use `"format": "gltf"` and `app.at3d.avatar#gltfAppearance`. The
format comes from the file's contents (a `VRMC_vrm` or `VRM` glTF extension
means VRM), not its name. VRM is uploaded as `application/octet-stream`, as the
lexicon says; the PDS may sniff and store it as `model/gltf-binary`, and the
record keeps whatever MIME type the PDS answered with (the PDS refuses a
record whose blob reference disagrees with what it stored).

## Adding a provider

Implement `AvatarProvider` (`workers/auth/src/avatars/types.ts`: `connect`,
`completeConnect`, `disconnect`, `listAvatars`, `getAvatar`, `resolveAvatar`,
`refreshAuth`, and optionally `uploads`) and list it in `PROVIDERS`
(`routes.ts`), plus the `provider` check in the migration. Routes, storage,
the hub UI and the runtime stay unchanged: the runtime only ever sees an
`AvatarDescriptor`, and the hub offers "Upload from device" for the provider
that has `uploads`.

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

While a character loads, the runtime shows "Loading your character…" over the
default body. An at3d model is addressed by its content hash (the blob CID), so
each site keeps the last few in the visitor's own Cache Storage and skips the
download next time; expiring links (VRoid Hub, Sketchfab) are always fetched.
The model and the VRM loader code download side by side.

The hub's own walk-mode lobby wears the character too: it resolves the same
ticket, same-origin, and loads the model into the local player (not in private
mode, where the visitor is a ghost in the default figure). Other visitors in
the lobby still see the default figure.

A ticket resolves to *whatever is selected now*: picking "Continue without
character" or disconnecting a platform stops every outstanding ticket at once.
It can reveal the chosen avatar's descriptor to whoever holds it, and nothing
else: no session, no account details, no platform tokens, no WorldMesh user id.

## Endpoints (`/api/account/avatar`, routed with `/api/account/*`)

| | |
| --- | --- |
| `GET /wallet` | providers, connections, selected avatar (D1 only) |
| `GET /connections/:id/avatars` | live listing from the platform |
| `POST /connect/:provider` `{ handle?, upload? }` | → `{ url }` of the platform's authorization page; `upload` asks for upload permission (handle optional when already connected) |
| `GET /callback/:provider` | platform redirect target → `/?avatar=connected\|upload\|error` |
| `POST /upload/session` | → `{ url, accessToken, dpopKey }` for the browser's upload, from the upload cookie |
| `POST /upload/finish` `{ name, format, vrmVersion, file }` or `{ cancel: true }` | creates the avatar record, then revokes → `{ connectionId, avatar }` |
| `POST /select` `{ connectionId, avatarId }` or `{ avatarId: null }` | pick, or continue without character |
| `POST /disconnect` `{ connectionId }` | revoke (VRoid, Sketchfab) and forget |
| `POST /handoff` | → `{ ticket, expiresAt }` |
| `POST /resolve` `{ ticket }` | for worlds; CORS, cookie-less |
| `GET /atproto/client-metadata.json` | AT Protocol OAuth client metadata |

State-changing calls require a same-origin request and a session. OAuth state,
the PKCE verifier and (AT Protocol) the DPoP key ride in an encrypted, HttpOnly,
callback-path cookie, bound to the signed-in user. Every AT Protocol host (handle
domain, did:web host, PDS, authorization server) passes a public-https-only
guard, including redirects. Connect, callback, listing, select, handoff,
upload and resolve are rate-limited per IP.

## Cost

One small D1 row per connection and at most one per user for the selection.
Listing and resolving cost a couple of subrequests to the platform; an upload
costs a few more (authorization, createRecord, revocation). The model bytes
never touch Cloudflare, uploads included, so avatar bandwidth and storage cost
WorldMesh nothing.

## Setup

See the checklist in [accounts-and-federation.md](accounts-and-federation.md#avatar-wallet-setup).
