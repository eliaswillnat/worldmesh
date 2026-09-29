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
`WORLDMESH_VERSION` must equal it. `npm run build:runtime` refuses to build if
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

## Release checklist

Nothing here runs automatically; publishing is a deliberate act.

1. `npm install && npm run typecheck && npm run build` from the repo root.
2. Bump `version` in `packages/runtime/package.json` and `WORLDMESH_VERSION` in
   `packages/runtime/src/index.ts` together. Decide whether
   `WORLDMESH_PROTOCOL` moves, by the rules above.
3. Inspect the tarball without publishing: `npm run pack:runtime`.
4. Optional but cheap: `npx publint packages/runtime` and
   `npx @arethetypeswrong/cli packages/runtime`.
5. Commit, tag (`runtime-v0.1.0`), push.
6. `npm publish --workspace=packages/runtime` — `prepare` rebuilds `dist`
   first, and `publishConfig.access: public` covers the scoped name.

### Still needed before the first publish

- The `@worldmesh` scope has to exist on npm and the publishing account has to
  be a member of it. Nothing in this repo can create that.
- That account needs 2FA; `npm publish` will ask for an OTP, or pass
  `--otp=<code>`.
- Publishing from CI instead would need an automation token in repository
  secrets and `--provenance`. No token belongs in this repo.
- `three` peer range (`>=0.160.0`) is deliberately wide. Widen or narrow it
  before the first publish rather than after, since consumers install against
  whatever the first version claims.
