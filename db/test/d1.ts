/**
 * Test helper shared by workers/auth and workers/federation: a real, empty,
 * in-memory D1 (via wrangler's local runtime) with db/migrations applied.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '..', 'migrations');
const CONFIG = join(here, 'wrangler.test.toml');

export interface TestDatabase {
  db: D1Database;
  dispose: () => Promise<void>;
}

export async function createTestDatabase(
  getPlatformProxy: (options: { configPath: string; persist: false }) => Promise<{
    env: Record<string, unknown>;
    dispose: () => Promise<void>;
  }>,
): Promise<TestDatabase> {
  const proxy = await getPlatformProxy({ configPath: CONFIG, persist: false });
  const db = proxy.env.DB as D1Database;
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    const statements = splitStatements(readFileSync(join(MIGRATIONS, file), 'utf8'));
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
  return { db, dispose: proxy.dispose };
}

function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}
