import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { dbClientConfig } from './db.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Applies numbered .sql files in order, each in its own transaction, tracked in schema_migrations. */
export async function migrate(ownerUrl: string, appDbPassword: string, log = console.log): Promise<void> {
  const client = new pg.Client(dbClientConfig(ownerUrl));
  await client.connect();
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())',
    );
    const dbName = (await client.query('SELECT current_database() AS db')).rows[0].db as string;
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(path.join(dir, f), 'utf8')
        .replaceAll('{{APP_DB_PASSWORD}}', appDbPassword.replaceAll("'", "''"))
        .replaceAll('{{DB_NAME}}', '"' + dbName.replaceAll('"', '""') + '"');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        log(`applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}
