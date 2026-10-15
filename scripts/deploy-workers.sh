#!/usr/bin/env bash
# Production Worker deploys (docs/cloudflare-deployment.md → "Deploying Workers").
# Run by .github/workflows/workers.yml on every push to main, so a merge never
# leaves a Worker behind the sites Pages has already deployed.
#
#   scripts/deploy-workers.sh changed <base-sha>   Workers whose code changed since <base-sha>
#   scripts/deploy-workers.sh all                  every Worker in WORKERS
#   scripts/deploy-workers.sh auth presence ...    just these
#   DRY_RUN=1 scripts/deploy-workers.sh ...        pick, build and test, deploy nothing
#
# A Worker counts as changed when anything in workers/<w>/ changed, or any
# file its bundle is built from (esbuild's metafile), or the lockfile of the
# packages it bundles. Each one is type-checked and tested before it ships;
# one that fails is not deployed, the others still are, and the run fails.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

# The Workers running in production, in deploy order: admin binds presence's
# Durable Object; auth and admin read the database the migrations change.
# federation and ads are not live and are never deployed from here.
WORKERS=(presence views notify screenshot auth admin)

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"
export CI=true WRANGLER_SEND_METRICS=false

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }
summary() { [[ -n ${GITHUB_STEP_SUMMARY:-} ]] && printf '%s\n' "$*" >>"$GITHUB_STEP_SUMMARY" || true; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# wrangler from the Worker's own dependencies, or the repository's.
wrangler_in() {
  local dir=$1 bin
  shift
  bin="$ROOT/$dir/node_modules/.bin/wrangler"
  [[ -x $bin ]] || bin="$ROOT/node_modules/.bin/wrangler"
  (cd "$ROOT/$dir" && "$bin" "$@")
}

installed=()
install_deps() {
  local dir=workers/$1
  [[ -f $dir/package-lock.json ]] || return 0
  [[ " ${installed[*]} " == *" $1 "* ]] && return 0
  npm ci --prefix "$dir" --no-audit --no-fund >/dev/null || return 1
  installed+=("$1")
}

# What the Worker is built from, relative to the repository: every file in
# its bundle, plus the lockfile of any packages it bundles.
watched_files() {
  local w=$1 meta="$TMP/$1.meta.json" inputs lock=package-lock.json
  wrangler_in "workers/$w" deploy --dry-run --env="" --outdir "$TMP/$w" --metafile "$meta" >"$TMP/$w.build.log" 2>&1 ||
    { cat "$TMP/$w.build.log" >&2; return 1; }
  inputs=$(jq -r '.inputs | keys[]' "$meta") || return 1
  [[ -f workers/$w/package-lock.json ]] && lock=workers/$w/package-lock.json
  grep -q 'node_modules/' <<<"$inputs" && echo "$lock"
  grep -v 'node_modules/' <<<"$inputs" | while read -r input; do
    realpath -m --relative-to="$ROOT" "$ROOT/workers/$w/$input"
  done
}

uses_database() { grep -q '^\[\[d1_databases\]\]' "workers/$1/wrangler.toml"; }

failed=()
deployed=()

# Called in an `if`, where set -e does not apply: every step returns on failure.
verify() {
  local w=$1 dir=workers/$1
  [[ -f $dir/package.json ]] || return 0
  install_deps "$w" || return 1
  if jq -e '.scripts.typecheck' "$dir/package.json" >/dev/null; then
    npm run --prefix "$dir" --silent typecheck || return 1
  fi
  # Only Workers with a test folder (screenshot's "test" script is npm's placeholder).
  if [[ -d $dir/test ]]; then
    npm test --prefix "$dir" --silent || return 1
  fi
}

deploy() {
  local w=$1 sha out version
  sha=$(git rev-parse --short HEAD)
  log "Checking worldmesh-$w"
  if ! verify "$w"; then
    failed+=("$w (typecheck or tests failed)")
    return 0
  fi
  if [[ ${DRY_RUN:-} == 1 ]]; then
    log "DRY_RUN: would deploy worldmesh-$w"
    deployed+=("$w (dry run)")
    return 0
  fi
  if [[ $w == screenshot ]]; then
    # The old door-view queue still lists this Worker as its consumer, and
    # Cloudflare refuses a consumer without a queue handler. A no-op once unhooked.
    wrangler_in workers/screenshot queues consumer remove worldmesh-door-views worldmesh-screenshot >/dev/null 2>&1 || true
  fi
  log "Deploying worldmesh-$w"
  if ! out=$(wrangler_in "workers/$w" deploy --env="" --message "main $sha" 2>&1); then
    printf '%s\n' "$out" >&2
    failed+=("$w (deploy failed)")
    return 0
  fi
  printf '%s\n' "$out" | tail -n 8
  version=$(sed -n 's/.*Current Version ID: *//p' <<<"$out" | tail -n 1)
  deployed+=("$w${version:+ → $version}")
}

# ── Which Workers ──────────────────────────────────────────────────────────

selected=()
held=()
migration=false
if [[ ${1:-} == changed ]]; then
  base=${2:-}
  if [[ -z $base || $base =~ ^0+$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
    log "No usable base commit ('$base'): deploying every Worker"
    selected=("${WORKERS[@]}")
  else
    changes=$(git diff --name-only "$base" HEAD)
    log "Changed since ${base:0:7}:"
    sed 's/^/  /' <<<"$changes"
    for w in "${WORKERS[@]}"; do
      if grep -q "^workers/$w/" <<<"$changes"; then selected+=("$w"); continue; fi
      install_deps "$w" || { failed+=("$w (npm ci failed)"); continue; }
      watched=$(watched_files "$w") || { failed+=("$w (does not build)"); continue; }
      if grep -qxFf <(sed '/^$/d' <<<"$watched") <<<"$changes"; then selected+=("$w"); fi
    done
  fi
  # A new migration has to reach the database before code that expects it.
  # That stays a person's call: the Workers that use the database wait.
  if grep -q '^db/migrations/' <<<"${changes:-}"; then
    migration=true
    kept=()
    for w in "${selected[@]}"; do
      if uses_database "$w"; then held+=("$w"); else kept+=("$w"); fi
    done
    selected=("${kept[@]}")
  fi
elif [[ ${1:-} == all ]]; then
  selected=("${WORKERS[@]}")
elif [[ $# -gt 0 ]]; then
  for w in "$@"; do
    [[ " ${WORKERS[*]} " == *" $w "* ]] || die "unknown Worker '$w' (one of: ${WORKERS[*]})"
  done
  # Keep the deploy order whatever order they were named in.
  for w in "${WORKERS[@]}"; do
    [[ " $* " == *" $w "* ]] && selected+=("$w")
  done
else
  die "usage: $0 changed <base-sha> | all | <worker>..."
fi

# ── Deploy ─────────────────────────────────────────────────────────────────

summary "### Production Workers at \`$(git rev-parse --short HEAD)\`"
if [[ ${#selected[@]} -eq 0 ]]; then
  log "No Worker code changed: nothing to deploy"
  summary "No Worker code changed."
fi
for w in "${selected[@]}"; do deploy "$w"; done

for line in "${deployed[@]}"; do summary "- deployed $line"; done
for line in "${failed[@]}"; do summary "- **not deployed: $line**"; done
if $migration; then
  message="This push changes db/migrations: apply it to the production database by hand (docs/cloudflare-deployment.md → Deploying Workers)."
  [[ ${#held[@]} -gt 0 ]] && message+=" Then deploy what waited for it: gh workflow run workers.yml -f workers=\"${held[*]}\""
  summary "- **migration not applied.** $message"
  printf '\n✗ %s\n' "$message" >&2
fi

[[ ${#failed[@]} -eq 0 ]] && ! $migration || exit 1
log "Done: ${deployed[*]:-nothing deployed}"
