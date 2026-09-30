#!/usr/bin/env node
/**
 * Copies worlds from the old stores into D1's world table (migration 0006):
 *
 *   - KV `approved:<id>` entries  → status 'published', source 'kv'
 *   - KV `pending:<id>` entries   → status 'pending' with a fresh approval link
 *   - apps/hub/src/community.json → status 'published', source 'community'
 *
 * Prints SQL to stdout; nothing is written until you run it. Safe to run
 * twice: every insert is `insert or ignore`, so a world already in D1 (same
 * id, legacy id or URL) is left as it is. The KV id is kept as both the row id
 * and legacy_id. A world whose contact email matches a verified account is
 * owned by that account.
 *
 *   node scripts/backfill-worlds.mjs [--kv-namespace-id <id>] [--kv-dump <file.json>] > backfill.sql
 *   npx wrangler d1 execute worldmesh --remote --config workers/auth/wrangler.toml --file backfill.sql
 *
 * --kv-namespace-id reads the WORLDS namespace through wrangler; --kv-dump
 * reads a saved [{ "name": "approved:x", "value": "{…}" }] list instead.
 * Approval links for pending worlds are printed to stderr.
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{ id?: string, name?: string, url?: string, description?: string, cover?: string,
 *   creator?: string, portfolio?: string, email?: string, submittedAt?: string,
 *   addedAt?: string, approvedAt?: string }} LegacyWorld
 * @typedef {{ source: 'kv' | 'community', status: 'published' | 'pending', world: LegacyWorld }} LegacyEntry
 */

/**
 * @param {{ name: string, value: string }[]} kvEntries
 * @param {LegacyWorld[]} community
 * @returns {LegacyEntry[]}
 */
export function collectLegacyWorlds(kvEntries, community) {
  /** @type {LegacyEntry[]} */
  const out = [];
  // KV first: it carries the contact email, and insert-or-ignore keeps the first row per URL.
  for (const { name, value } of kvEntries) {
    const status = name.startsWith('approved:') ? 'published' : name.startsWith('pending:') ? 'pending' : null;
    if (!status) continue;
    let world;
    try {
      world = JSON.parse(value);
    } catch {
      console.warn(`skipping ${name}: not JSON`);
      continue;
    }
    out.push({ source: 'kv', status, world: { id: name.slice(name.indexOf(':') + 1), ...world } });
  }
  for (const world of community) out.push({ source: 'community', status: 'published', world });
  return out;
}

/**
 * @param {LegacyEntry[]} entries
 * @param {{ now?: number, origin?: string, token?: () => string }} [options]
 * @returns {{ sql: string, approveLinks: string[], skipped: string[] }}
 */
export function backfillSql(entries, options = {}) {
  const now = options.now ?? Date.now();
  const origin = options.origin ?? 'https://worldmesh.net';
  const token = options.token ?? (() => randomBytes(32).toString('hex'));
  const statements = [];
  const approveLinks = [];
  const skipped = [];

  for (const { source, status, world } of entries) {
    if (!world.url || !world.name) {
      skipped.push(`${world.id ?? '(no id)'}: missing name or url`);
      continue;
    }
    const id = world.id || `${slug(world.name)}-${randomBytes(3).toString('hex')}`;
    const created = time(world.submittedAt ?? world.addedAt ?? world.approvedAt) ?? now;
    const published = status === 'published' ? time(world.approvedAt ?? world.addedAt) ?? created : null;
    // Data URLs were only a fallback when the cover upload failed; D1 is no place for them.
    const cover = world.cover && !world.cover.startsWith('data:') ? world.cover : null;
    const email = world.email?.trim() || null;
    let reviewHash = null;
    if (status === 'pending') {
      const secret = token();
      reviewHash = createHash('sha256').update(secret).digest('hex');
      approveLinks.push(`${world.name}: ${origin}/api/worlds/approve?id=${encodeURIComponent(id)}&token=${secret}`);
    }
    const owner = email
      ? `(select "id" from "user" where lower("email") = lower(${q(email)}) and "emailVerified" = 1)`
      : 'null';
    statements.push(
      `insert or ignore into world (id, owner_user_id, name, url, description, cover_url, creator_name, portfolio_url, ` +
        `contact_email, source, review_token_hash, status, legacy_id, created_at, updated_at, published_at) values (` +
        [q(id), owner, q(world.name), q(world.url), q(world.description), q(cover), q(world.creator), q(world.portfolio),
          q(email), q(source), q(reviewHash), q(status), q(id), created, now, published ?? 'null'].join(', ') +
        `);`,
    );
  }
  return { sql: statements.join('\n') + '\n', approveLinks, skipped };
}

/** @param {unknown} value */
function q(value) {
  if (value === undefined || value === null || value === '') return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** @param {string | undefined} iso */
function time(iso) {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** @param {string} name */
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'world';
}

/** @param {string} namespaceId */
function readKv(namespaceId) {
  const wrangler = (/** @type {string[]} */ ...args) =>
    execFileSync('npx', ['wrangler', 'kv', ...args, '--namespace-id', namespaceId, '--remote'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
  /** @type {{ name: string }[]} */
  const keys = JSON.parse(wrangler('key', 'list'));
  return keys
    .filter((key) => /^(approved|pending):/.test(key.name))
    .map((key) => ({ name: key.name, value: wrangler('key', 'get', key.name, '--text') }));
}

function main(argv) {
  const arg = (/** @type {string} */ flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const namespaceId = arg('--kv-namespace-id');
  const dump = arg('--kv-dump');
  const kv = dump ? JSON.parse(readFileSync(dump, 'utf8')) : namespaceId ? readKv(namespaceId) : [];
  const community = JSON.parse(readFileSync(join(ROOT, 'apps/hub/src/community.json'), 'utf8'));
  const entries = collectLegacyWorlds(kv, community);
  const { sql, approveLinks, skipped } = backfillSql(entries, { origin: arg('--origin') });
  process.stdout.write(sql);
  console.error(`${entries.length - skipped.length} worlds (${kv.length} from KV, ${community.length} from community.json).`);
  for (const line of skipped) console.error(`skipped ${line}`);
  if (approveLinks.length) console.error(`Pending worlds, new approval links:\n${approveLinks.join('\n')}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
