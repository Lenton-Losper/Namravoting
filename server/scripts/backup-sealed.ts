import path from 'node:path';
import pg from 'pg';
import { dbClientConfig } from '../src/db.js';
import { loadDotEnv } from '../src/env.js';
import { buildSealedBackup } from '../src/services/backup.js';
import { createDiskStorage, createR2Storage, type PhotoStorage } from '../src/services/storage.js';

/**
 * Writes the sealed-result copy (counters and the seal fingerprint, no personal data) for every closed campaign that has none yet.
 * Campaigns closed after this feature shipped are copied automatically at close; this catches the earlier ones.
 *   npm run backup:sealed            (owner connection MIGRATE_DATABASE_URL; STORAGE=r2 with the R2_* settings, otherwise local disk)
 */
loadDotEnv();
const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('MIGRATE_DATABASE_URL is required'); process.exit(1); }
let storage: PhotoStorage;
if (process.env.STORAGE === 'r2') {
  const { R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!endpoint || !accessKeyId || !secretAccessKey) { console.error('STORAGE=r2 needs R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY'); process.exit(1); }
  storage = createR2Storage({ endpoint, bucket: process.env.R2_BUCKET ?? 'namra-voting-photos', accessKeyId, secretAccessKey });
} else storage = createDiskStorage(path.resolve(process.env.UPLOAD_DIR ?? './uploads'));

const pool = new pg.Pool({ ...dbClientConfig(url), max: 1 });
try {
  const ids = (await pool.query("SELECT id FROM campaigns WHERE status = 'closed' ORDER BY created_at")).rows.map((r) => r.id as string);
  let written = 0; let present = 0;
  for (const id of ids) {
    const b = await buildSealedBackup(pool, id);
    if (!b) continue;
    if (await storage.get(b.key)) { present++; continue; }
    await storage.put(b.key, b.body, 'application/json');
    await pool.query("INSERT INTO audit_log (actor_oid, action, campaign_id, details) VALUES (NULL, 'result.backed_up', $1, $2)", [id, JSON.stringify({ key: b.key, sha256: b.sha256, backfill: true })]);
    written++; console.log(`  wrote ${b.key}`);
  }
  console.log(`${ids.length} closed campaign(s): ${written} copied now, ${present} already had a copy.`);
} finally { await pool.end(); }
