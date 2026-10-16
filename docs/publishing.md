# Publishing `@worldmesh/runtime`

`packages/runtime` is the only publishable package in this repo. Everything
else (`apps/*`, `workers/*`) is private and deploys on its own.

## What ships

`npm run build:runtime` compiles `src/` with `tsc -p tsconfig.build.json` into
`packages/runtime/dist`:

```
dist/index.js        ESM, one file per source module, three left external
dist/index.d.ts      declarations
dist/**/*.map        source maps and declaration maps
```

The tarball carries `dist/`, `src/`, `README.md` and `LICENSE`. `src/` is there
so the maps resolve — step into the runtime in devtools and you land on
TypeScript.

The package is ESM only and lists `three` as a peer dependency, so consumers
keep exactly one copy of Three.js. `sideEffects: false` lets bundlers drop the
parts of the runtime a world never imports.

Relative imports inside `src/` carry explicit `.js` extensions. `tsc` never
rewrites specifiers, so this is what makes the emitted ESM resolvable by plain
Node, by bundlers, and by TypeScript under `node16`/`nodenext` alike.

## Working on the runtime inside the monorepo

Apps resolve `@worldmesh/runtime` through the workspace symlink and read
`dist/`, exactly like an npm consumer would. Two consequences:

- `npm install` builds the runtime (the package's `prepare` script), so a fresh
  clone works with no extra step.
- `npm run dev:hub` and friends build the runtime first, then start Vite.

While editing runtime source, run the compiler in watch mode next to the dev
server:

```bash
npm run dev:runtime
```

## Versions

Two numbers, on purpose.

**`version` in package.json** is ordinary semver for the npm package, and
`WORLDMESH_VERSION` (in `src/version.ts`) must equal it. `npm run build:runtime` refuses to build if
the two drift (`scripts/check-version.mjs`).

**`WORLDMESH_PROTOCOL`** is an integer, currently `1`, and it describes the
world-facing contract rather than the package. It is the same number a world
declares as `"worldmesh": 1` in its manifest, so the two move together.

Bump the protocol only when an existing, correct world would have to change to
keep behaving as its creator intended:

- an option in `createWorldMesh` is removed, renamed, or changes meaning
- a method or event on the handle is removed or renamed
- the control convention moves a key in the core row
- the portal URL contract (`?from=`) changes shape

Do not bump it for anything additive: new options with defaults, new abilities,
new events, new exports, bug fixes, tuning changes. Those are minor or patch
releases of the package with the protocol left alone.

A protocol bump is a major release of the package, and it is a real cost: every
published world is on someone else's hosting and nobody can redeploy them for
their creators. That asymmetry is the whole reason the number exists.

While the package is `0.x`, the patch number is what reaches existing worlds:
`^0.2.1` in a world's package.json and `@0.2` in the esm.sh import map
(`apps/hub/public/connect.md`) both take any `0.2.*`, and neither takes `0.3.0`.
Additive releases go out as the next patch.

## The hosted runtime

Worlds that call `loadWorldMesh` (0.2.3 and later) don't run the copy in their
own bundle. They run the one worldmesh.net serves at
`/runtime/<protocol>/index.js`, handing it their Three.js, and fall back to
their bundled copy only if it can't be loaded or doesn't start
([compatibility.md](compatibility.md#staying-current-loadworldmesh-and-createworldmesh)).
So a change to `packages/runtime` reaches those worlds without npm and without
anyone rebuilding them: **it goes live in every one of them when `main`
deploys the hub.**

How it is built and served:

- The hub's `npm run build` runs `scripts/build-hosted.mjs` after Vite. It
  bundles `src/hosted.ts` (`createWorldMesh` and the version constants) from
  `dist/`, with the glTF and VRM loaders as lazy chunks, into
  `apps/hub/dist/runtime/<protocol>/`. Every `three` import reads the world's
  copy, which `loadWorldMesh` leaves at `globalThis[Symbol.for('worldmesh.three')]`.
- `apps/hub/public/_headers` serves `index.js` with CORS and a 5-minute cache,
  and the content-hashed chunks under `c/` with CORS, cached for good.
  `_routes.json` keeps `/runtime/*` away from Pages Functions, so worlds
  loading it cost no function requests.
- For up to 5 minutes after a deploy, a browser can hold the old `index.js`,
  whose chunks are gone. The shared chunk fails and the world uses its bundled
  copy; a glTF or VRM avatar fails and the visitor keeps the default body.

Before merging a runtime change:

1. Say **"Deploy to preview"** ([previews.md](previews.md)).
2. Open https://preview.worldmesh.net/runtime/check: a small world on the
   preview's hosted runtime, with Three.js from a CDN like an outside world.
   It names the version it runs and, unlike `loadWorldMesh`, shows the error
   instead of falling back. Walk, jump, climb the steps, switch views.
3. Check the preview worlds and walk mode as usual, then **"Deploy to production"**.

If a release turns out broken, roll the hub back: Cloudflare → Workers &
Pages → `worldmesh-hub` → Deployments → the previous one → **Rollback to this
deployment** (instant), or revert the merge on `main`. Worlds pick it up
within 5 minutes. A release that throws while starting needs no rollback to
keep worlds working: they fall back to their bundled copy by themselves.

Protocol bumps: the build writes only the current protocol's directory, and
`_headers` names `/runtime/1/`. Before bumping `WORLDMESH_PROTOCOL`, add the
new directory's rules to `_headers` and arrange for `/runtime/<old protocol>/`
to keep being served (for example a build of the last release before the
bump), or worlds on the old protocol drop to their bundled copies. They keep
working either way.

## Release checklist

Nothing here runs automatically; publishing is a deliberate act.

1. `npm install && npm run typecheck && npm run build` from the repo root.
2. Bump `version` in `packages/runtime/package.json` and `WORLDMESH_VERSION` in
   `packages/runtime/src/version.ts` together (and the `packages/runtime` entry in
   `package-lock.json`, which `npm install` does). Decide whether
   `WORLDMESH_PROTOCOL` moves, by the rules above.
3. Inspect the tarball without publishing: `npm run pack:runtime`.
4. Optional but cheap: `npx publint packages/runtime` and
   `npx @arethetypeswrong/cli --pack packages/runtime`. The one expected
   warning is that CommonJS `require` gets ESM: the package is ESM only.
5. Publish, either from GitHub (below; nothing needed but a browser) or from a
   laptop: commit, tag (`runtime-v0.1.0`), push, then
   `npm publish --workspace=packages/runtime` — `prepare` rebuilds `dist`
   first, and `publishConfig.access: public` covers the scoped name.

## Publishing from GitHub

`.github/workflows/publish-runtime.yml` ("Publish runtime" under Actions) runs
only when started by hand, and only on `main`. It installs with `npm ci`, runs
`npm run typecheck` and `npm run build`, refuses if npm already has the version
in `packages/runtime/package.json` (or its tag exists), then runs
`npm publish --workspace=packages/runtime --provenance --access public` and
pushes the tag `runtime-v<version>` on the published commit. Provenance links
the version on npmjs.com to the workflow run and commit that built it.

Once: create an npm granular access token (npmjs.com → avatar → Access Tokens →
Generate New Token → Granular Access Token) with read and write permission on
`@worldmesh/runtime` only, "Bypass two-factor authentication" ticked (CI cannot
answer an OTP prompt) and a short expiry; npm caps write tokens at 90 days. Add
it as the repository secret `NPM_TOKEN` (GitHub → Settings → Secrets and
variables → Actions). It never goes in this repo, a commit or a chat.

Each release:

1. Open a PR with the version bump (checklist steps 1–4), and merge it.
2. GitHub → Actions → "Publish runtime" → Run workflow, on `main`.
3. Check `npm view @worldmesh/runtime version`, and that the tag arrived.

npm is ending direct publishing with tokens around January 2027 (a token will
only be able to stage a release for a human to approve). Before then, move to
trusted publishing, which needs no token at all: on npmjs.com, add this
repository and `publish-runtime.yml` as the package's trusted publisher, run
npm 11.5.1 or later in the workflow, and drop `NODE_AUTH_TOKEN` and the
`NPM_TOKEN` secret. The workflow already has the `id-token: write` permission
trusted publishing relies on.

### Still needed before the first publish

- The `@worldmesh` scope has to exist on npm and the publishing account has to
  be a member of it. Nothing in this repo can create that.
- That account needs 2FA; `npm publish` will ask for an OTP, or pass
  `--otp=<code>`.
- Publishing from CI uses a token in repository secrets and `--provenance`;
  see "Publishing from GitHub". No token belongs in this repo.
- `three` peer range (`>=0.160.0`) is deliberately wide. Widen or narrow it
  before the first publish rather than after, since consumers install against
  whatever the first version claims.
