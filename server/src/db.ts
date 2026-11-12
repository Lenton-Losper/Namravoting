import fs from 'node:fs';
import pg from 'pg';
import { getConfig } from './config.js';

export type Queryable = Pick<pg.PoolClient, 'query'>;

let pool: pg.Pool | undefined;
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SSL_PARAMS = ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert', 'sslcrl', 'uselibpqcompat'];

/**
 * Connection settings for a database URL (SEC-26). For anything but this machine, TLS is ALWAYS on and the server certificate is
 * ALWAYS verified (`rejectUnauthorized: true`, host name checked), whatever the URL says: a `sslmode=disable` / `no-verify` in a
 * pasted URL cannot weaken it, and the `pg` version can no longer change what `sslmode=require` means. The ssl parameters are
 * stripped from the URL so they cannot override this. Trust: Node's public root store (Neon's certificates chain to a public root),
 * or the PEM in DB_SSL_CA (the text, or a path to the file) if you want to pin the authority.
 */
export function dbClientConfig(url: string, env: NodeJS.ProcessEnv = process.env): pg.ClientConfig {
  let u: URL;
  try { u = new URL(url); } catch { return { connectionString: url }; }
  if (LOCAL_DB_HOSTS.has(u.hostname.toLowerCase())) return { connectionString: url };
  for (const p of SSL_PARAMS) u.searchParams.delete(p);
  const raw = env.DB_SSL_CA?.trim();
  const ca = raw ? (raw.includes('BEGIN CERTIFICATE') ? raw : fs.readFileSync(raw, 'utf8')) : undefined;
  return { connectionString: u.toString(), ssl: { rejectUnauthorized: true, servername: u.hostname, ...(ca ? { ca } : {}) } };
}

export function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ ...dbClientConfig(getConfig().databaseUrl), max: 20 });
  return pool;
}
export async function closePool(): Promise<void> { await pool?.end(); pool = undefined; }

export const SERIALIZATION_FAILURE = '40001';
export const DEADLOCK = '40P01';
export const UNIQUE_VIOLATION = '23505';

/** Runs fn in a transaction at the given isolation level. Always rolls back on error. */
export async function withTx<T>(
  fn: (c: pg.PoolClient) => Promise<T>,
  isolation: 'READ COMMITTED' | 'SERIALIZABLE' = 'READ COMMITTED',
): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw e;
  } finally {
    c.release();
  }
}

/** Retries on serialization failure / deadlock (max `tries` attempts). */
export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      const code = (e as { code?: string }).code;
      if ((code === SERIALIZATION_FAILURE || code === DEADLOCK) && attempt < tries) continue;
      throw e;
    }
  }
}
