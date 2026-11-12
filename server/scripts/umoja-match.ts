import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadDotEnv } from '../src/env.js';
import { dbClientConfig } from '../src/db.js';
import { assertImportAllowed } from '../src/umoja/guard.js';
import { deviceCodeToken, DeviceFlowError, PublicClientDisabled } from '../src/umoja/graphAuth.js';
import { applyConfirmedReport } from '../src/umoja/match.js';
import { runMatchJob } from '../src/umoja/matchJob.js';
import { UmojaParseError } from '../src/umoja/parse.js';

// Two steps, because a name is not an identity (SEC-22):
//   1. npm run umoja:match -- <path-to-HR-export>
//        Looks the members up in Microsoft Graph (device-code sign-in as YOU) and writes data/umoja-match-report.csv. It never writes to
//        a database. Names are used in memory only; the report (gitignored) is the only place they are written.
//   2. Open the report, check every row, put "yes" in the confirm column of the rows that are right (ambiguous / not-found rows can never
//      be applied), then:  npm run umoja:match -- --apply-confirmed data/umoja-match-report.csv [--allow-remote]
//        Writes entra_oid + email for the confirmed rows only (owner role). No Graph sign-in, no HR file, no names involved.
loadDotEnv();
const args = process.argv.slice(2);
const allowRemote = args.includes('--allow-remote');
const applyIdx = args.indexOf('--apply-confirmed');
const root = process.env.INIT_CWD ?? process.cwd();

if (applyIdx >= 0) {
  const reportFile = args[applyIdx + 1];
  if (!reportFile || reportFile.startsWith('--')) { console.error('Usage: npm run umoja:match -- --apply-confirmed <reviewed report> [--allow-remote]'); process.exit(1); }
  try { assertImportAllowed(process.env.MIGRATE_DATABASE_URL ?? '', allowRemote); } catch (e) { console.error((e as Error).message); process.exit(1); }
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) { console.error('MIGRATE_DATABASE_URL (owner role) is required, see .env.example'); process.exit(1); }
  try {
    const csv = readFileSync(path.resolve(root, reportFile), 'utf8');
    const c = new pg.Client(dbClientConfig(url)); await c.connect();
    try {
      const s = await applyConfirmedReport(c, csv);
      console.log(`Updated ${s.updated} confirmed members (${s.not_in_db} confirmed codes were not in the table; ${s.ignored} rows not confirmed; ${s.rejected} rejected). Audit entry "umoja.match" written (counts only).`);
    } finally { await c.end(); }
  } catch (e) { console.error(`Apply failed: ${(e as Error).message}`); process.exit(1); }
  process.exit(0);
}

const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('Usage: npm run umoja:match -- <path-to-HR-export>   |   npm run umoja:match -- --apply-confirmed <reviewed report> [--allow-remote]'); process.exit(1); }
const full = path.resolve(root, file);
const reportPath = path.resolve(root, 'data', 'umoja-match-report.csv');
const { ENTRA_TENANT_ID: tenantId, ENTRA_CLIENT_ID: clientId, ENTRA_CLIENT_SECRET: clientSecret } = process.env;
if (!tenantId || !clientId) { console.error('ENTRA_TENANT_ID and ENTRA_CLIENT_ID are required in .env'); process.exit(1); }

let text = '';
try { text = readFileSync(full, 'utf8'); } catch (e) { console.error(`Cannot read ${full}: ${(e as Error).message}`); process.exit(1); }

try {
  const token = await deviceCodeToken({ tenantId, clientId, clientSecret, scope: 'User.ReadBasic.All', announce: (m) => console.log(m) });
  console.log('Signed in. Matching (this takes a while: 5 requests/second)...');
  await runMatchJob({
    fileText: text, token, log: (l) => console.log(l),
    writeReport: (csv) => { mkdirSync(path.dirname(reportPath), { recursive: true }); writeFileSync(reportPath, csv, 'utf8'); },
  });
  text = '';
} catch (e) {
  if (e instanceof PublicClientDisabled) { console.error(e.message); process.exit(2); }
  console.error(`Match failed: ${e instanceof UmojaParseError || e instanceof DeviceFlowError ? e.message : (e as Error).message}`);
  process.exit(1);
}
