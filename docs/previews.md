# Private previews

A private, separate copy of WorldMesh for trying a branch before it goes live:
rooms, doors, portals, multiplayer, the admin dashboard. Only you can open it,
and it never touches production users, rooms or data.

Production is unchanged: merging to `main` still deploys straight to
worldmesh.net through the Git-connected Pages projects. A preview is never
required.

## Using it

Tell Claude:

| You say | What happens |
| :--- | :--- |
| **"Deploy to preview"** | Builds the current branch with preview settings, deploys it to the addresses below, and reports the URL and the exact commit. |
| **"Deploy to production"** | Merges exactly the previewed commit into `main`, which Pages deploys as usual. Claude refuses if the branch has moved since the preview, or if `main` has moved (then: update the branch, preview again). Changed Workers are listed; deploying those stays manual. |
| **"Remove the preview"** | Replaces the preview sites with a "Preview removed" page and wipes the preview database, world directory and view counts. Screenshots expire within a day. The setup stays, so the next deploy is quick. |
| **"Tear down the preview completely"** | Deletes every preview project, Worker, database, namespace, bucket and DNS record. The next deploy recreates them. |
| **"Verify me on the preview"** | Marks your preview account's email as verified, which the admin dashboard requires (see [Admin dashboard](#admin-dashboard)). |

Behind each phrase is the **Preview** GitHub Actions workflow
(`.github/workflows/preview.yml`), which runs `scripts/preview.sh`. You can
also start it from GitHub → Actions → Preview → Run workflow, picking the branch
and an action.

### Addresses

| What | Address |
| :--- | :--- |
| Hub | https://preview.worldmesh.net |
| Worlds | https://preview-forest.worldmesh.net, `preview-mars`, `preview-city`, `preview-medieval`, `preview-space` |
| Admin dashboard | https://preview-admin.worldmesh.net |
| Multiplayer relay | `wss://preview-relay.worldmesh.net` |

The first visit asks for your email and sends a one-time code (Cloudflare
Access). The login lasts 24 hours across all the preview addresses.

## What is separate

| Production | Preview |
| :--- | :--- |
| Pages `worldmesh-hub`, `worldmesh-<world>` (Git builds) | Pages `worldmesh-hub-preview`, `worldmesh-<world>-preview` (uploaded by the workflow, never Git-built) |
| D1 `worldmesh` | D1 `worldmesh-preview` |
| KV `WORLDS`, `VIEWS` | KV `worldmesh-preview-WORLDS`, `worldmesh-preview-VIEWS` |
| R2 `worldmesh-screenshots` | R2 `worldmesh-screenshots-preview` |
| Queue `worldmesh-door-views` | Queue `worldmesh-door-views-preview` |
| `SCREENSHOT_SECRET`, `APPROVE_SECRET` | Separate random values, made by the workflow |
| Workers `worldmesh-presence`, `-auth`, `-admin`, `-views`, `-screenshot` | The same names with `-preview`, from the `[env.preview]` block in each `workers/*/wrangler.toml` |
| Presence rooms (Durable Objects of `worldmesh-presence`) | Rooms of `worldmesh-presence-preview`, so preview visitors never meet production ones |

Left out of the preview:

- **Federation.** It would announce a second worldmesh.net identity to the fediverse.
- **Ads.** The hub is built with `VITE_ADS_ENABLED=false` and the ads Worker isn't deployed.
- **Sign-in with Google, Apple, GitHub and Discord.** The preview's auth Worker has no
  OAuth secrets, so the login dialog offers email + password only. No redirect URIs
  change at any provider.
- **Emails, unless you add a Resend key.** The hub's `/api/notify` refuses a
  submission without `RESEND_API_KEY`, so by default the preview can't record world
  submissions, and there's nothing to approve. To test submissions and approvals, add
  a GitHub secret `PREVIEW_RESEND_API_KEY` (a Resend key; a separate one named
  `worldmesh-preview` is easiest to revoke). The next deploy gives it to the preview
  hub. Submission emails then come to you with an approve link on
  preview.worldmesh.net. Approving emails the creator address on the submission, so
  submit test worlds with your own address.

Every name the script creates, changes or deletes ends in `-preview` or is a
`preview(-*).worldmesh.net` hostname, and destructive steps check this before acting.
The only changes to production files are the additive `[env.preview]` blocks and a
`VITE_PRESENCE_ENDPOINT` override in the five world apps that does nothing unless the
variable is set (production builds don't set it).

## One-time setup

About 15 minutes. Do the steps in order: step 3 has to exist before the first
deploy, and the workflow refuses to deploy until it does.

### 1. Check the production Pages projects

In Cloudflare → Workers & Pages → `worldmesh-hub` → Settings → Builds → Branch
control, check that **Preview branch** is **None**, and the same for the five
world projects. Previews from this setup don't use Pages branch builds. With
anything other than **None**, every branch pushed to GitHub is published,
publicly, at `<branch>.worldmesh-<world>.pages.dev`, where its worlds join the
production multiplayer rooms.

### 2. API token and GitHub secrets

Cloudflare → My Profile → API Tokens → Create Token → **Create Custom Token**.
Name it `worldmesh-preview` and give it:

| Scope | Permission |
| :--- | :--- |
| Account | Cloudflare Pages: Edit |
| Account | Workers Scripts: Edit |
| Account | Workers KV Storage: Edit |
| Account | Workers R2 Storage: Edit |
| Account | D1: Edit |
| Account | Queues: Edit |
| Account | Access: Apps and Policies: Read |
| Account | Account Settings: Read |
| Zone (`worldmesh.net` only) | Zone: Read |
| Zone (`worldmesh.net` only) | DNS: Edit |
| Zone (`worldmesh.net` only) | Workers Routes: Edit |

Account resources: your account. Zone resources: Specific zone → worldmesh.net.
Create it and copy the token.

Your account ID is on the right-hand side of any zone's Overview page. Then, in
the repository on GitHub → Settings → Secrets and variables → Actions → New
repository secret, add:

- `CLOUDFLARE_API_TOKEN`: the token
- `CLOUDFLARE_ACCOUNT_ID`: the account ID
- `PREVIEW_RESEND_API_KEY` (optional): see "Emails" above

Or from a terminal (each command asks for the value):

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

```bash
gh secret set CLOUDFLARE_ACCOUNT_ID
```

### 3. Cloudflare Access (who can open the preview)

1. Cloudflare dashboard → **Zero Trust**. If asked, pick a team name and the
   **Free** plan (up to 50 users).
2. Zero Trust → Settings → Authentication → Login methods: **One-time PIN** is
   there by default. Nothing to add.
3. Access → Applications → **Add an application** → **Self-hosted**.
   - Application name: `WorldMesh preview`
   - Session duration: `24 hours`
   - Add these **public hostnames**, one per line (subdomain + domain):

     | Subdomain | Domain |
     | :--- | :--- |
     | `preview` | `worldmesh.net` |
     | `preview-forest` | `worldmesh.net` |
     | `preview-mars` | `worldmesh.net` |
     | `preview-city` | `worldmesh.net` |
     | `preview-medieval` | `worldmesh.net` |
     | `preview-space` | `worldmesh.net` |
     | `preview-admin` | `worldmesh.net` |
     | _(empty)_ | `worldmesh-hub-preview.pages.dev` |
     | `*` | `worldmesh-hub-preview.pages.dev` |
     | _(empty)_ | `worldmesh-forest-preview.pages.dev` |
     | `*` | `worldmesh-forest-preview.pages.dev` |
     | _(empty)_ | `worldmesh-mars-preview.pages.dev` |
     | `*` | `worldmesh-mars-preview.pages.dev` |
     | _(empty)_ | `worldmesh-city-preview.pages.dev` |
     | `*` | `worldmesh-city-preview.pages.dev` |
     | _(empty)_ | `worldmesh-medieval-preview.pages.dev` |
     | `*` | `worldmesh-medieval-preview.pages.dev` |
     | _(empty)_ | `worldmesh-space-preview.pages.dev` |
     | `*` | `worldmesh-space-preview.pages.dev` |

     The `pages.dev` lines matter: every Pages project also answers on its own
     `pages.dev` address, and each deployment on a `<hash>.` address under it.
     Without them, those would be public copies of the preview.

     **Do not** add `preview-relay`. Browsers can't send the Access login over a
     WebSocket, so multiplayer would break; the relay stores nothing.
   - Policy: name `Only Elias`, action **Allow**, Include → **Emails** →
     `elias.willnat@gmail.com`.
   - Save.

If a `pages.dev` name above is already taken by someone else, Cloudflare gives
the project a name with a suffix. The first deploy then stops before putting
anything online and prints the exact hostnames missing from the Access
application; add those and deploy again.

### 4. First deploy

Say **"Deploy to preview"** (or run the workflow with `deploy`). The first run
also creates everything: the D1 database, KV namespaces, R2 bucket, the six
Pages projects, their custom domains and DNS records, the Workers, and random
`BETTER_AUTH_SECRET` and `ADMIN_SECRET` values for the preview Workers. Later
runs reuse all of it. New custom domains can take a few minutes to get their
certificate.

### Admin dashboard

The dashboard lets in only a signed-in account whose email is verified, and the
preview sends no emails. So, once per fresh preview database:

1. Open https://preview.worldmesh.net, sign up with email + password using
   `elias.willnat@gmail.com`.
2. Say **"Verify me on the preview"**. It marks that one account verified, in the
   preview database only.
3. Open https://preview-admin.worldmesh.net.

"Remove the preview" wipes the preview database, so after it, sign up again.

## Known limitations

- **Cross-origin calls between preview addresses are blocked by Access.** A
  world asking the hub to resolve an Avatar Wallet handoff, or the hub reading a
  preview world's `worldmesh.json`, gets the Access login page instead. The
  Avatar Wallet is off in the preview anyway (no `AVATAR_SECRET`). If it's needed
  later: add a second Access application for just the path
  `preview.worldmesh.net/api/account/avatar/resolve` with a **Bypass** policy
  (Include: Everyone).
- **The screenshot Worker can't see preview worlds.** It loads pages in
  Cloudflare's browser, which has no Access login. Screenshots and door views of
  external world URLs work. So each deploy takes the door views of the five
  preview worlds itself (`scripts/preview-door-views`: the fresh builds, served
  locally to headless Chrome on the runner) and puts them in the preview bucket,
  with each world's portal scene (`portal.glb` and a backdrop), which doors
  draw live.
- **Demo doors compare door styles.** The preview hub is built with
  `VITE_DOOR_COMPARE=on`, so each demo world's door shows its world a different
  way: City the flat cover, Medieval a flat 360° view, Space the 360° view with
  depth, Mars the live portal, and Forest the live portal you can walk straight
  through: the real Forest world waits loaded behind the hall, and takes over
  from the exact same view as the camera comes through the doorway, with no
  reload (Back returns to the door). That needs an Access login for
  `preview-forest.worldmesh.net` itself, so open it once first: the login
  can't be shown in a frame. Without one, walking in travels the usual way.
  Production doors are unaffected.
  Community worlds get door views only if they use a runtime that can take
  them, the same as in production.
- **The views and screenshot Workers are public on `workers.dev`.** They hold only
  preview view counts and preview screenshots.
- **Production builds the same commit with production settings.** Endpoints are
  baked in at build time, so production isn't the byte-identical bundle, but it is
  the identical source.

## For Claude: handling the phrases

Run from the repository; the branch is the one being worked on. The workflow
runs from the branch's own copy of `.github/workflows/preview.yml`, so a branch
made before it existed needs `main` merged in first.

**Deploy to preview.** Push the branch, then:

```bash
gh workflow run preview.yml --ref <branch> -f action=deploy
```

Watch it with `gh run watch <run-id> --exit-status`. Report the hub URL and the
commit SHA from the run summary.

**Deploy to production.** Never without a successful preview of the same commit:

1. `git fetch origin`
2. The previewed commit is the head SHA of the most recent successful `deploy` run:
   `gh run list --workflow preview.yml --status success --json headSha,displayTitle,createdAt --limit 20`,
   first entry whose title starts with `Preview: deploy`.
3. Refuse if `origin/<branch>` is not that SHA (the branch moved since the preview).
4. Refuse if `git merge-base --is-ancestor origin/main <sha>` fails (`main` moved;
   merge `main` into the branch and preview again). This guarantees the merge
   result has exactly the previewed tree.
5. Note the Workers whose code changes: `git diff --name-only origin/main <sha> -- workers/`.
6. `gh pr merge <pr> --merge --match-head-commit <sha>`
7. Report the merge, and list the changed Workers from step 5: their production
   `wrangler deploy` stays manual.

**Remove the preview:** `gh workflow run preview.yml --ref main -f action=remove`

**Tear down completely:** confirm with Elias first, then the same with `-f action=teardown`.

**Verify me on the preview:** the same with `-f action=verify-admin`.

**What's on the preview?** the same with `-f action=status`, then read the run log.
