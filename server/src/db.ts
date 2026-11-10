import pg from 'pg';
import { getConfig } from './config.js';

export type Queryable = Pick<pg.PoolClient, 'query'>;

let pool: pg.Pool | undefined;
export function getPool(): pg.Pool {
  if (!pool) pool = new pg.Pool({ connectionString: getConfig().databaseUrl, max: 20 });
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
