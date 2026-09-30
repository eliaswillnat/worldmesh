/**
 * Test helper shared by workers/auth, workers/federation and workers/ads: a
 * real, empty, in-memory D1 (via wrangler's local runtime) with db/migrations
 * applied. Pass another wrangler config to get more bindings (e.g. R2) too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', 'migrations');
const CONFIG = join(here, 'wrangler.test.toml');

export interface TestDatabase {
  db: D1Database;
  /** Every binding the config declares, DB included. */
  env: Record<string, unknown>;
  dispose: () => Promise<void>;
}

export async function createTestDatabase(
  getPlatformProxy: (options: { configPath: string; persist: false }) => Promise<{
    env: Record<string, unknown>;
    dispose: () => Promise<void>;
  }>,
  configPath: string = CONFIG,
): Promise<TestDatabase> {
  const proxy = await getPlatformProxy({ configPath, persist: false });
  const db = proxy.env.DB as D1Database;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const statements = splitStatements(readFileSync(join(MIGRATIONS, file), 'utf8'));
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  return { db, env: proxy.env, dispose: proxy.dispose };
}

/** Split on `;`, keeping a trigger's `begin … end` body in one statement. */
function splitStatements(sql: string): string[] {
  const parts = sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  const statements: string[] = [];
  let trigger: string[] | null = null;
  for (const part of parts) {
    if (trigger) {
      trigger.push(part);
      if (/^end$/i.test(part)) {
        statements.push(trigger.join(';\n'));
        trigger = null;
      }
    } else if (/^create\s+trigger\b/i.test(part)) {
      trigger = [part];
    } else {
      statements.push(part);
    }
  }
  return statements;
}
