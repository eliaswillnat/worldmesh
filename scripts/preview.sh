#!/usr/bin/env bash
# Private preview deployments. Run by .github/workflows/preview.yml; see
# docs/previews.md. Nothing here touches a production project, Worker or
# resource: every name it creates, changes or deletes ends in "-preview"
# (or is a preview-*.worldmesh.net hostname), and destructive steps check that.
#
#   scripts/preview.sh deploy        create anything missing, build, deploy
#   scripts/preview.sh remove        take the preview offline, wipe its data
#   scripts/preview.sh teardown      delete every preview resource
#   scripts/preview.sh verify-admin  mark the admin's preview account verified
#   scripts/preview.sh status        print the commit the preview is serving
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, plus curl, jq, openssl.
# Optional PREVIEW_RESEND_API_KEY: without it, the preview hub can't record
# world submissions (its /api/notify needs Resend), so approvals can't be tested.
set -euo pipefail

cd "$(dirname "$0")/.."

ZONE_NAME="worldmesh.net"
APPS=(hub forest mars city medieval space)
D1_NAME="worldmesh-preview"
KV_WORLDS="worldmesh-preview-WORLDS"
KV_VIEWS="worldmesh-preview-VIEWS"
R2_BUCKET="worldmesh-screenshots-preview"
QUEUE="worldmesh-door-views-preview"
# Order matters: admin binds presence's Durable Object; auth owns the migrations.
WORKERS=(presence views screenshot auth admin)
# Secrets each preview Worker gets, generated at random on first deploy.
SECRETS_auth="BETTER_AUTH_SECRET"
SECRETS_admin="ADMIN_SECRET"
# The preview admin (must match ADMIN_EMAILS in workers/admin [env.preview]).
ADMIN_EMAIL="elias.willnat@gmail.com"
COMPAT_DATE="2026-09-01"

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not set}"
ACCOUNT="$CLOUDFLARE_ACCOUNT_ID"
export CI=true WRANGLER_SEND_METRICS=false

wrangler() { npx --no-install wrangler "$@"; }
log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

project_of() { echo "worldmesh-$1-preview"; }
host_of() { if [[ $1 == hub ]]; then echo "preview.$ZONE_NAME"; else echo "preview-$1.$ZONE_NAME"; fi; }

# Refuse to touch anything that is not plainly a preview resource.
assert_preview() {
  [[ $1 == *-preview || $1 == *-preview-* || $1 == preview.$ZONE_NAME || $1 == preview-*.$ZONE_NAME ]] \
    || die "refusing to touch '$1': not a preview resource"
}

# cf METHOD PATH [JSON] → the response's .result; fails on success:false.
cf() {
  local method=$1 path=$2 body=${3:-} response
  response=$(curl -sS -X "$method" "https://api.cloudflare.com/client/v4$path" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
    ${body:+--data "$body"})
  if [[ $(jq -r '.success' <<<"$response") != true ]]; then
    echo "$response" | jq -c '.errors' >&2
    return 1
  fi
  jq -c '.result' <<<"$response"
}

# ── Lookups ────────────────────────────────────────────────────────────────

d1_id() { wrangler d1 list --json | jq -r --arg n "$D1_NAME" '.[] | select(.name == $n) | .uuid'; }
kv_id() { cf GET "/accounts/$ACCOUNT/storage/kv/namespaces?per_page=100" | jq -r --arg t "$1" '.[] | select(.title == $t) | .id'; }
zone_id() { cf GET "/zones?name=$ZONE_NAME" | jq -r '.[0].id'; }
project_json() { cf GET "/accounts/$ACCOUNT/pages/projects/$1" 2>/dev/null || true; }
r2_dev_host() { cf GET "/accounts/$ACCOUNT/r2/buckets/$R2_BUCKET/domains/managed" | jq -r '.domain'; }
workers_subdomain() { cf GET "/accounts/$ACCOUNT/workers/subdomain" | jq -r '.subdomain'; }
queue_id() { cf GET "/accounts/$ACCOUNT/queues?per_page=100" | jq -r --arg n "$QUEUE" '.[] | select(.queue_name == $n) | .queue_id'; }
r2_exists() { cf GET "/accounts/$ACCOUNT/r2/buckets/$R2_BUCKET" >/dev/null 2>&1; }

# ── Resources ──────────────────────────────────────────────────────────────

ensure_d1() {
  [[ -n $(d1_id) ]] || { log "Creating D1 $D1_NAME"; wrangler d1 create "$D1_NAME" >/dev/null; }
}

ensure_kv() {
  [[ -n $(kv_id "$1") ]] || { log "Creating KV $1"; cf POST "/accounts/$ACCOUNT/storage/kv/namespaces" "{\"title\":\"$1\"}" >/dev/null; }
}

# Screenshot files expire on their own: 7 days normally, 1 day once removed.
set_r2_expiry() {
  local days=$1 rules
  rules=$(jq -nc --argjson d "$days" '{rules: [{id: "preview-expiry", enabled: true, conditions: {prefix: ""},
    deleteObjectsTransition: {condition: {type: "Age", maxAge: ($d * 86400)}}}]}')
  cf PUT "/accounts/$ACCOUNT/r2/buckets/$R2_BUCKET/lifecycle" "$rules" >/dev/null
}

ensure_r2() {
  if ! r2_exists; then
    log "Creating R2 $R2_BUCKET"
    wrangler r2 bucket create "$R2_BUCKET" >/dev/null
  fi
  cf PUT "/accounts/$ACCOUNT/r2/buckets/$R2_BUCKET/domains/managed" '{"enabled":true}' >/dev/null
  set_r2_expiry 7
}

ensure_queue() {
  [[ -n $(queue_id) ]] || { log "Creating queue $QUEUE"; cf POST "/accounts/$ACCOUNT/queues" "{\"queue_name\":\"$QUEUE\"}" >/dev/null; }
}

ensure_pages_project() {
  local app=$1 project; project=$(project_of "$app")
  [[ -n $(project_json "$project") ]] && return
  log "Creating Pages project $project"
  wrangler pages project create "$project" --production-branch main --compatibility-date "$COMPAT_DATE" >/dev/null
}

# Attach preview(-<app>).worldmesh.net to the project, with a proxied CNAME
# to its pages.dev address. Never edits a DNS record it did not make.
ensure_pages_domain() {
  local app=$1 project host target zone existing
  project=$(project_of "$app"); host=$(host_of "$app")
  target=$(project_json "$project" | jq -r '.subdomain')
  zone=$(zone_id)
  existing=$(cf GET "/zones/$zone/dns_records?name=$host" | jq -r '.[0].content // empty')
  if [[ -z $existing ]]; then
    log "Adding DNS $host → $target"
    cf POST "/zones/$zone/dns_records" \
      "$(jq -nc --arg n "$host" --arg c "$target" '{type: "CNAME", name: $n, content: $c, proxied: true, comment: "WorldMesh preview (scripts/preview.sh)"}')" >/dev/null
  elif [[ $existing != "$target" ]]; then
    die "DNS $host already points at $existing, not $target. Fix it by hand."
  fi
  if ! cf GET "/accounts/$ACCOUNT/pages/projects/$project/domains/$host" >/dev/null 2>&1; then
    log "Attaching $host to $project"
    cf POST "/accounts/$ACCOUNT/pages/projects/$project/domains" "{\"name\":\"$host\"}" >/dev/null
  fi
}

# The hub's Pages Functions get the preview directory, cover bucket and
# screenshot Worker. APPROVE_SECRET is made once; SCREENSHOT_SECRET is the
# value deploy_workers just gave the screenshot and admin Workers.
configure_hub_project() {
  local project body has_approve
  project=$(project_of hub)
  has_approve=$(project_json "$project" | jq -r '.deployment_configs.production.env_vars.APPROVE_SECRET != null')
  body=$(jq -nc --arg kv "$(kv_id "$KV_WORLDS")" --arg covers "$(r2_dev_host)" --arg date "$COMPAT_DATE" \
    --arg shot "$SCREENSHOT_URL" --arg shotSecret "$SCREENSHOT_SECRET" --arg email "$ADMIN_EMAIL" \
    --arg approve "$([[ $has_approve == true ]] || openssl rand -hex 32)" --arg resend "${PREVIEW_RESEND_API_KEY:-}" '
    {deployment_configs: {production: {
      compatibility_date: $date,
      kv_namespaces: {WORLDS: {namespace_id: $kv}},
      env_vars: ({
        COVER_HOSTS: {type: "plain_text", value: $covers},
        SCREENSHOT_ENDPOINT: {type: "plain_text", value: $shot},
        SCREENSHOT_SECRET: {type: "secret_text", value: $shotSecret},
        NOTIFICATION_EMAIL: {type: "plain_text", value: $email}}
        + (if $approve != "" then {APPROVE_SECRET: {type: "secret_text", value: $approve}} else {} end)
        + (if $resend != "" then {RESEND_API_KEY: {type: "secret_text", value: $resend}} else {} end))}}}')
  cf PATCH "/accounts/$ACCOUNT/pages/projects/$project" "$body" >/dev/null
}

# Every hostname that serves preview pages. The pages.dev ones count too:
# without Access they would be a public back door to the same deployment.
private_hosts() {
  local app sub
  for app in "${APPS[@]}"; do
    host_of "$app"
    sub=$(project_json "$(project_of "$app")" | jq -r '.subdomain')
    echo "$sub"; echo "*.$sub"
  done
  echo "preview-admin.$ZONE_NAME"
}

# Refuse to put anything online until Cloudflare Access covers all of it.
require_access() {
  local covered missing=()
  covered=$(cf GET "/accounts/$ACCOUNT/access/apps?per_page=200" \
    | jq -r '.[] | select(.type == "self_hosted") | (.domain, (.self_hosted_domains // [])[], ((.destinations // [])[] | .uri)) | select(. != null)')
  while read -r host; do
    grep -qxF "$host" <<<"$covered" || missing+=("$host")
  done < <(private_hosts)
  if (( ${#missing[@]} )); then
    printf '  %s\n' "${missing[@]}" >&2
    die "Cloudflare Access does not cover the hostnames above. Add them to the preview Access application (docs/previews.md), then run again. Nothing was deployed."
  fi
}

ensure_all() {
  ensure_d1
  ensure_kv "$KV_WORLDS"
  ensure_kv "$KV_VIEWS"
  ensure_r2
  ensure_queue
  for app in "${APPS[@]}"; do ensure_pages_project "$app"; ensure_pages_domain "$app"; done
}

# ── Workers ────────────────────────────────────────────────────────────────

# workers/<w>/wrangler.toml with the preview ids filled in, next to the
# original so relative paths still resolve. Git-ignored; deleted on exit.
trap 'rm -f workers/*/.preview-wrangler.toml' EXIT

preview_config() {
  local worker=$1 out="workers/$1/.preview-wrangler.toml"
  sed -e "s/__PREVIEW_D1_ID__/$D1_ID/g" \
      -e "s/__PREVIEW_WORLDS_KV_ID__/$WORLDS_KV_ID/g" \
      -e "s/__PREVIEW_VIEWS_KV_ID__/$VIEWS_KV_ID/g" \
      "workers/$worker/wrangler.toml" >"$out"
  echo "$out"
}

ensure_secrets() {
  local worker=$1 config=$2 var="SECRETS_$1" have
  [[ -n ${!var:-} ]] || return 0
  have=$(wrangler secret list --env preview --config "$config" --format json 2>/dev/null | jq -r '.[].name' || true)
  for secret in ${!var}; do
    grep -qx "$secret" <<<"$have" && continue
    log "Setting $secret on $worker (random, preview only)"
    openssl rand -base64 32 | wrangler secret put "$secret" --env preview --config "$config" >/dev/null
  done
}

# Each pending db/migrations file as one whole file. `d1 migrations apply
# --remote` splits statements itself and cuts 0005_ads.sql's trigger in half.
# Applied files are recorded in d1_migrations, the table wrangler itself uses.
D1_TARGET=${D1_TARGET:---remote}
apply_migrations() {
  local applied file name
  log "Applying D1 migrations to $D1_NAME"
  wrangler d1 execute "$D1_NAME" "$D1_TARGET" -y --command \
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)" >/dev/null
  applied=$(wrangler d1 execute "$D1_NAME" "$D1_TARGET" -y --json --command "SELECT name FROM d1_migrations" | jq -r '.[0].results[].name')
  for file in db/migrations/*.sql; do
    name=$(basename "$file")
    grep -qxF "$name" <<<"$applied" && continue
    echo "  $name"
    wrangler d1 execute "$D1_NAME" "$D1_TARGET" -y --file "$file" >/dev/null
    wrangler d1 execute "$D1_NAME" "$D1_TARGET" -y --command "INSERT INTO d1_migrations (name) VALUES ('$name')" >/dev/null
  done
}

deploy_workers() {
  D1_ID=$(d1_id); WORLDS_KV_ID=$(kv_id "$KV_WORLDS"); VIEWS_KV_ID=$(kv_id "$KV_VIEWS")
  [[ -n $D1_ID && -n $WORLDS_KV_ID && -n $VIEWS_KV_ID ]] || die "preview resources missing"

  apply_migrations

  for worker in "${WORKERS[@]}"; do
    local config; config=$(preview_config "$worker")
    log "Deploying worldmesh-$worker-preview"
    if [[ $worker == screenshot ]]; then
      wrangler deploy --env preview --config "$config" --var "R2_PUBLIC_URL:https://$(r2_dev_host)"
    else
      wrangler deploy --env preview --config "$config"
    fi
    ensure_secrets "$worker" "$config"
    # Shared by the screenshot Worker, the admin Worker and the hub's Functions.
    # A fresh value each deploy, so it never has to be read back.
    if [[ $worker == screenshot || $worker == admin ]]; then
      printf '%s' "$SCREENSHOT_SECRET" | wrangler secret put SCREENSHOT_SECRET --env preview --config "$config" >/dev/null
    fi
  done
}

# ── Apps ───────────────────────────────────────────────────────────────────

build_apps() {
  local views="https://worldmesh-views-preview.$(workers_subdomain).workers.dev"
  local screenshot="$SCREENSHOT_URL"
  local relay="wss://preview-relay.$ZONE_NAME"

  log "Building runtime"
  npm run build:runtime

  log "Building hub (preview settings)"
  env VITE_PRESENCE_ENDPOINT="$relay" \
      VITE_SCREENSHOT_ENDPOINT="$screenshot" \
      VITE_VIEWS_ENDPOINT="$views" \
      VITE_ADS_ENABLED=false \
      VITE_WORLD_FOREST_URL="https://$(host_of forest)/" \
      VITE_WORLD_MARS_URL="https://$(host_of mars)/" \
      VITE_WORLD_CITY_URL="https://$(host_of city)/" \
      VITE_WORLD_MEDIEVAL_URL="https://$(host_of medieval)/" \
      VITE_WORLD_SPACE_URL="https://$(host_of space)/" \
      npm run build --workspace=apps/hub

  for app in "${APPS[@]:1}"; do
    log "Building $app (preview settings)"
    env VITE_WORLDMESH_HUB="https://$(host_of hub)/" \
        VITE_PRESENCE_ENDPOINT="$relay" \
        npm run build --workspace="apps/$app"
  done
}

upload_apps() {
  local sha=$1
  for app in "${APPS[@]}"; do
    log "Uploading $app → $(project_of "$app")"
    # From the repo root, so the root functions/ ship exactly as in production.
    wrangler pages deploy "apps/$app/dist" --project-name "$(project_of "$app")" --branch main \
      --commit-hash "$sha" --commit-message "preview $sha" --commit-dirty=true
  done
}

# Door views (the world seen through a walk-mode door up close) for the five
# preview worlds. workers/screenshot can't take them: its browser can't get
# past Access. So take them here from the fresh builds and put them in the
# preview bucket exactly where the worker would, status.json last.
# Best effort: a world without one just shows its cover.
seed_door_views() {
  local out stamp app slug host prefix worlds=()
  log "Taking door views of the preview worlds"
  out=$(mktemp -d)
  for app in "${APPS[@]:1}"; do worlds+=("$app=apps/$app/dist"); done
  node scripts/preview-door-views/capture.mjs "$out" "${worlds[@]}" || { echo "  (skipped: capture failed)"; return 0; }

  local covers; covers="https://$(r2_dev_host)"
  for app in "${APPS[@]:1}"; do
    [[ -f $out/$app/meta.json ]] || continue
    host=$(host_of "$app")
    # doorViewSlug() of https://<host>/
    slug=$(tr -c 'a-zA-Z0-9\n' '-' <<<"$host" | tr 'A-Z' 'a-z')
    stamp=$(date +%s%3N); prefix="door-views/$slug/$stamp"
    jq -n --arg url "https://$host/" --arg base "$covers/$prefix" --argjson stamp "$stamp" --argjson now "$(date +%s%3N)" \
      --slurpfile meta "$out/$app/meta.json" '
      {url: $url, requestedAt: $stamp, state: "ready", finishedAt: $now,
       view: ($meta[0] + {capturedAt: $stamp, color: "\($base)/color.webp", depth: "\($base)/depth.png"})}' \
      >"$out/$app/status.json"
    if wrangler r2 object put "$R2_BUCKET/$prefix/color.webp" --remote --file "$out/$app/color.webp" --content-type image/webp >/dev/null \
      && wrangler r2 object put "$R2_BUCKET/$prefix/depth.png" --remote --file "$out/$app/depth.png" --content-type image/png >/dev/null \
      && wrangler r2 object put "$R2_BUCKET/door-views/$slug/status.json" --remote --file "$out/$app/status.json" \
        --content-type application/json --cache-control no-cache >/dev/null; then
      echo "  $slug ready"
    else
      echo "  $slug: upload failed"
    fi
  done
  rm -rf "$out"
}

# ── Commands ───────────────────────────────────────────────────────────────

summary() {
  {
    echo "$1"
    echo
    for app in "${APPS[@]}"; do echo "- $app: https://$(host_of "$app")/"; done
    echo "- admin: https://preview-admin.$ZONE_NAME/"
  } | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

cmd_deploy() {
  local sha; sha=$(git rev-parse HEAD)
  ensure_all
  require_access
  SCREENSHOT_URL="https://worldmesh-screenshot-preview.$(workers_subdomain).workers.dev"
  SCREENSHOT_SECRET=$(openssl rand -hex 32)
  deploy_workers
  configure_hub_project
  build_apps
  upload_apps "$sha"
  seed_door_views
  summary "### Preview deployed: \`$sha\`"
}

cmd_remove() {
  log "Replacing the preview sites with a placeholder"
  local placeholder; placeholder=$(mktemp -d)
  cat >"$placeholder/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Preview removed</title>
<body style="font:16px system-ui;background:#0a0a0a;color:#ddd;display:grid;place-items:center;height:100vh;margin:0">
<p>This WorldMesh preview has been removed.</p></body>
HTML
  for app in "${APPS[@]}"; do
    local project; project=$(project_of "$app"); assert_preview "$project"
    [[ -n $(project_json "$project") ]] || continue
    # From an empty directory, so no Functions ship with it.
    wrangler pages deploy . --cwd "$placeholder" --project-name "$project" \
      --branch main --commit-message "removed" --commit-dirty=true
  done

  log "Wiping preview data"
  if [[ -n $(d1_id) ]]; then
    assert_preview "$D1_NAME"
    wrangler d1 delete "$D1_NAME" -y && wrangler d1 create "$D1_NAME" >/dev/null
  fi
  for title in "$KV_WORLDS" "$KV_VIEWS"; do
    local id; id=$(kv_id "$title"); [[ -n $id ]] || continue
    assert_preview "$title"
    cf DELETE "/accounts/$ACCOUNT/storage/kv/namespaces/$id" >/dev/null
    ensure_kv "$title"
  done
  if r2_exists; then set_r2_expiry 1; fi
  summary "### Preview removed. Data wiped; screenshots expire within a day. Infrastructure kept."
}

cmd_teardown() {
  local zone; zone=$(zone_id)
  for app in "${APPS[@]}"; do
    local project host target record; project=$(project_of "$app"); host=$(host_of "$app")
    assert_preview "$project"; assert_preview "$host"
    if [[ -n $(project_json "$project") ]]; then
      target=$(project_json "$project" | jq -r '.subdomain')
      cf DELETE "/accounts/$ACCOUNT/pages/projects/$project/domains/$host" >/dev/null 2>&1 || true
      record=$(cf GET "/zones/$zone/dns_records?name=$host" | jq -r --arg c "$target" '.[] | select(.content == $c) | .id')
      [[ -z $record ]] || cf DELETE "/zones/$zone/dns_records/$record" >/dev/null
      log "Deleting Pages project $project"
      cf DELETE "/accounts/$ACCOUNT/pages/projects/$project" >/dev/null
    fi
  done

  for ((i = ${#WORKERS[@]} - 1; i >= 0; i--)); do
    local name="worldmesh-${WORKERS[i]}-preview"; assert_preview "$name"
    log "Deleting Worker $name"
    wrangler delete --name "$name" --force 2>/dev/null || echo "  (not deployed)"
  done

  local queue; queue=$(queue_id)
  if [[ -n $queue ]]; then assert_preview "$QUEUE"; cf DELETE "/accounts/$ACCOUNT/queues/$queue" >/dev/null; fi
  if [[ -n $(d1_id) ]]; then assert_preview "$D1_NAME"; wrangler d1 delete "$D1_NAME" -y; fi
  for title in "$KV_WORLDS" "$KV_VIEWS"; do
    local id; id=$(kv_id "$title"); [[ -n $id ]] || continue
    assert_preview "$title"
    cf DELETE "/accounts/$ACCOUNT/storage/kv/namespaces/$id" >/dev/null
  done
  local note=""
  if r2_exists; then
    assert_preview "$R2_BUCKET"
    if ! wrangler r2 bucket delete "$R2_BUCKET" 2>/dev/null; then
      set_r2_expiry 1
      note=" R2 bucket $R2_BUCKET still holds files; they expire within a day, then run teardown again to delete it."
    fi
  fi
  echo "### Preview torn down.$note" | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
}

cmd_verify_admin() {
  assert_preview "$D1_NAME"
  wrangler d1 execute "$D1_NAME" --remote --json -y \
    --command "UPDATE \"user\" SET \"emailVerified\" = 1 WHERE lower(email) = '$ADMIN_EMAIL'; SELECT changes() AS updated;"
}

cmd_status() {
  local deployment
  deployment=$(cf GET "/accounts/$ACCOUNT/pages/projects/$(project_of hub)/deployments?env=production&per_page=1" | jq -c '.[0]')
  jq -r '"commit: \(.deployment_trigger.metadata.commit_hash // "none")\nmessage: \(.deployment_trigger.metadata.commit_message)\ncreated: \(.created_on)"' <<<"$deployment"
}

case "${1:-}" in
  deploy) cmd_deploy ;;
  remove) cmd_remove ;;
  teardown) cmd_teardown ;;
  verify-admin) cmd_verify_admin ;;
  status) cmd_status ;;
  *) die "usage: $0 deploy|remove|teardown|verify-admin|status" ;;
esac
