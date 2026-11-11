import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadDotEnv } from '../src/env.js';
import { assertImportAllowed } from '../src/umoja/guard.js';
import { deviceCodeToken, DeviceFlowError, PublicClientDisabled } from '../src/umoja/graphAuth.js';
import { runMatchJob } from '../src/umoja/matchJob.js';
import { UmojaParseError } from '../src/umoja/parse.js';

// Usage: npm run umoja:match -- <path-to-HR-export> [--dry-run] [--allow-remote]
// Matches Umoja members to their Microsoft accounts through Graph (delegated, device-code sign-in as YOU).
// Names are used in memory only; the local report (data/umoja-match-report.csv, gitignored) is the only place they are written.
loadDotEnv();
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const allowRemote = args.includes('--allow-remote');
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('Usage: npm run umoja:match -- <path-to-HR-export> [--dry-run] [--allow-remote]'); process.exit(1); }
try { if (!dry) assertImportAllowed(process.env.MIGRATE_DATABASE_URL ?? '', allowRemote); } catch (e) { console.error((e as Error).message); process.exit(1); }
const root = process.env.INIT_CWD ?? process.cwd();
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
    fileText: text, token, dryRun: dry, log: (l) => console.log(l),
    writeReport: (csv) => { mkdirSync(path.dirname(reportPath), { recursive: true }); writeFileSync(reportPath, csv, 'utf8'); },
    connect: async () => {
      const url = process.env.MIGRATE_DATABASE_URL;
      if (!url) throw new Error('MIGRATE_DATABASE_URL (owner role) is required, see .env.example');
      const c = new pg.Client({ connectionString: url }); await c.connect(); return c;
    },
  });
  text = '';
} catch (e) {
  if (e instanceof PublicClientDisabled) { console.error(e.message); process.exit(2); }
  console.error(`Match failed: ${e instanceof UmojaParseError || e instanceof DeviceFlowError ? e.message : (e as Error).message}`);
  process.exit(1);
}
