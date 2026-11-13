import path from 'node:path';
import pg from 'pg';
import { dbClientConfig } from '../src/db.js';
import { loadDotEnv } from '../src/env.js';
import { checkDatabase, formatReport } from '../src/services/restoreCheck.js';
import { createDiskStorage, createR2Storage, type PhotoStorage } from '../src/services/storage.js';

/**
 * Is a (restored) database a faithful copy? Read-only.
 *   npm run restore:check                 checks MIGRATE_DATABASE_URL (the owner connection in .env)
 * Set RESTORE_CHECK_URL to check another database (for example a Neon branch) without touching .env.
 * With STORAGE=r2 (R2_* set) it also checks that each closed campaign has its sealed-result copy in the bucket.
 */
loadDotEnv();
const url = process.env.RESTORE_CHECK_URL ?? process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('RESTORE_CHECK_URL or MIGRATE_DATABASE_URL is required'); process.exit(1); }

let storage: PhotoStorage | undefined;
if (process.env.STORAGE === 'r2' && process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
  storage = createR2Storage({ endpoint: process.env.R2_ENDPOINT, bucket: process.env.R2_BUCKET ?? 'namra-voting-photos', accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY });
} else if (process.env.STORAGE === 'disk') storage = createDiskStorage(path.resolve(process.env.UPLOAD_DIR ?? './uploads'));

const pool = new pg.Pool({ ...dbClientConfig(url), max: 1 });
try {
  const report = await checkDatabase(pool, storage);
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} finally { await pool.end(); }
