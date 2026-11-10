import { readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { loadDotEnv } from '../src/env.js';
import { assertImportAllowed } from '../src/umoja/guard.js';
import { importUmoja } from '../src/umoja/import.js';
import { parseUmojaExport, UmojaParseError } from '../src/umoja/parse.js';

// Usage: npm run umoja:import -- <path-to-HR-export> [--dry-run]
loadDotEnv();
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const allowRemote = args.includes('--allow-remote');
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('Usage: npm run umoja:import -- <path-to-HR-export> [--dry-run] [--allow-remote]'); process.exit(1); }
// Guard FIRST, before the file is even read: the member list only goes into a local database.
try {
  if (!dry) assertImportAllowed(process.env.MIGRATE_DATABASE_URL ?? '', allowRemote);
} catch (e) { console.error((e as Error).message); process.exit(1); }
// npm runs workspace scripts from server/, so resolve relative paths against where the user typed the command.
const full = path.resolve(process.env.INIT_CWD ?? process.cwd(), file);

let text = '';
try { text = readFileSync(full, 'utf8'); } catch (e) { console.error(`Cannot read ${full}: ${(e as Error).message}`); process.exit(1); }

try {
  const parsed = parseUmojaExport(text);
  text = '';   // drop the raw file contents; only codes + flags are kept from here on
  const active = parsed.members.filter((m) => m.active).length;
  console.log(`Layout: ${parsed.layout}. Columns seen (${parsed.columns.length}): ${parsed.columns.join(' | ')}`);
  console.log('Only "Employee Code" and "Umoja Membership" are used; every other column is discarded.');
  console.log(`Rows read:        ${parsed.rowsRead}`);
  console.log(`Active:           ${active}`);
  console.log(`Inactive:         ${parsed.members.length - active}`);
  const shown = parsed.invalid.slice(0, 25).map((c) => JSON.stringify(c)).join(', ') + (parsed.invalid.length > 25 ? ', ...' : '');
  console.log(`Invalid codes:    ${parsed.invalid.length}${parsed.invalid.length ? '  -> ' + shown : ''}`);
  console.log(`Duplicates:       ${parsed.duplicates}${parsed.conflictingDuplicates ? ` (${parsed.conflictingDuplicates} with conflicting status: treated as inactive)` : ''}`);
  if (parsed.irregularRecords) console.log(`Irregular records: ${parsed.irregularRecords} (extra wrapped lines; located by their employee-code line)`);
  if (dry) { console.log('Dry run: nothing was written.'); process.exit(0); }

  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) { console.error('MIGRATE_DATABASE_URL (owner role) is required, see .env.example'); process.exit(1); }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const s = await importUmoja(client, parsed);
    console.log(`Imported ${s.active + s.inactive} members (${s.removed} previous rows replaced). Audit entry "umoja.import" written (counts only).`);
  } finally { await client.end(); }
} catch (e) {
  console.error(`Import failed: ${e instanceof UmojaParseError ? e.message : (e as Error).message}`);
  process.exit(1);
}
