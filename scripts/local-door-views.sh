#!/usr/bin/env bash
# Doorway scenes for the five demo worlds on localhost: the same capture a
# preview deploy runs (scripts/preview-door-views), written into each world's
# public/ folder the way any Doorway destination publishes them
# (docs/specs/doorway.md §2): /.well-known/doorway.json, which names
# /doorway/scene.glb (its backdrop.webp beside it). The hub finds them there
# itself; run the worlds (npm run dev:forest, …) and walk straight in.
# Run again after changing a world.
#
#   npm run door-views:local
set -euo pipefail
cd "$(dirname "$0")/.."

WORLDS=(forest mars city medieval space)

npm run build:runtime
for world in "${WORLDS[@]}"; do npm run build --workspace="apps/$world"; done
[[ -d scripts/preview-door-views/node_modules ]] || npm ci --prefix scripts/preview-door-views

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
args=()
for world in "${WORLDS[@]}"; do args+=("$world=apps/$world/dist"); done
node scripts/preview-door-views/capture.mjs "$out" "${args[@]}"

for world in "${WORLDS[@]}"; do
  public="apps/$world/public"
  rm -rf "$public/doorway" "$public/.well-known/doorway.json"
  [[ -f $out/$world/portal.glb ]] || { echo "  $world: no doorway scene"; continue; }
  mkdir -p "$public/doorway" "$public/.well-known"
  cp "$out/$world/portal.glb" "$public/doorway/scene.glb"
  cp "$out/$world/backdrop.webp" "$public/doorway/backdrop.webp"
  printf '{ "doorway": 1, "scene": "/doorway/scene.glb", "view": true, "embed": true, "characters": ["vrm", "glb"] }\n' >"$public/.well-known/doorway.json"
  echo "  $world: /.well-known/doorway.json"
done
