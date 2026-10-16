# WorldMesh

## Previews

When Elias says "Deploy to preview", "Deploy to production", "Remove the
preview", "Tear down the preview completely" or "Verify me on the preview",
follow "For Claude: handling the phrases" in [docs/previews.md](docs/previews.md).
Merging to `main` without a preview remains the normal production path.

## Runtime changes

Changes under `packages/runtime` go live in every world that uses
`loadWorldMesh` as soon as `main` deploys the hub, without an npm release.
Before merging one, deploy to preview and open
https://preview.worldmesh.net/runtime/check ("The hosted runtime" in
[docs/publishing.md](docs/publishing.md)).
