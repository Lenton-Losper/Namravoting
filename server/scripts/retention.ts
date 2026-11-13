import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { dbClientConfig } from '../src/db.js';
import { loadDotEnv } from '../src/env.js';
import { anonymiseUsers, findPurgeable, purgeCampaign } from '../src/services/retention.js';
import { createDiskStorage, createR2Storage, type PhotoStorage } from '../src/services/storage.js';

/**
 * Retention job (business-logic item 5). Uses the OWNER database role (MIGRATE_DATABASE_URL) like the migrations.
 *
 *   npm run retention -- [--months 24] [--apply] [--leavers <file>]
 *
 * Without --apply it only REPORTS what it would do (dry run). With --apply it
 *   1. removes receipts, the voter list, the Umoja snapshot and candidate photos of campaigns that are closed AND archived for more than
 *      --months months (default 24), keeping the sealed result and the audit trail;
 *   2. with --leavers <file> (one email per line, kept on your machine, never committed), replaces name, email and employee code of
 *      people who have left; the account id stays.
 */
loadDotEnv();
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const months = Number(opt('--months') ?? 24);
if (!Number.isInteger(months) || months < 1) { console.error('--months must be a whole number of at least 1'); process.exit(1); }
const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('MIGRATE_DATABASE_URL (the owner connection) is required'); process.exit(1); }

function storage(): PhotoStorage {
  if (process.env.STORAGE === 'r2') {
    const { R2_ENDPOINT: endpoint, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
    if (!endpoint || !accessKeyId || !secretAccessKey) { console.error('STORAGE=r2 needs R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY'); process.exit(1); }
    return createR2Storage({ endpoint, bucket: process.env.R2_BUCKET ?? 'namra-voting-photos', accessKeyId, secretAccessKey });
  }
  return createDiskStorage(path.resolve(process.env.UPLOAD_DIR ?? './uploads'));
}

const lines: string[] = [];
const say = (s: string) => { console.log(s); lines.push(s); };

const pool = new pg.Pool({ ...dbClientConfig(url), max: 2 });
try {
  say(`Retention ${apply ? 'APPLY' : 'dry run (nothing is changed)'}: campaigns closed and archived more than ${months} months ago`);
  const due = await findPurgeable(pool, months);
  if (!due.length) say('  none');
  const store = apply && due.length ? storage() : null;
  for (const c of due) {
    if (!apply) { say(`  would purge "${c.title}" (${c.id.slice(0, 8)}): ${c.receipts} receipts, closed ${c.closed_at.toISOString().slice(0, 10)}`); continue; }
    const r = await purgeCampaign(pool, c.id, (n) => store!.delete(n));
    say(r ? `  purged "${r.title}" (${r.id.slice(0, 8)}): ${r.receipts} receipts, ${r.eligible_voters} listed voters, ${r.snapshot_rows} snapshot rows, ${r.photos} photos` : `  skipped ${c.id.slice(0, 8)} (no longer eligible)`);
  }
  const lf = opt('--leavers');
  if (lf) {
    const emails = readFileSync(path.resolve(process.env.INIT_CWD ?? process.cwd(), lf), 'utf8').split(/\r?\n/);
    say(`Leavers: ${emails.filter((e) => e.trim()).length} entries ${apply ? '' : '(dry run)'}`);
    for (const r of await anonymiseUsers(pool, emails, apply)) say(`  ${r.email_hash}: ${apply || r.outcome !== 'anonymised' ? r.outcome : 'would be anonymised'}`);
  }
} finally { await pool.end(); }
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Retention\n```\n' + lines.join('\n') + '\n```\n');
