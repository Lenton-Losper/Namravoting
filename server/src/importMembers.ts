import path from 'node:path';
import pg from 'pg';
import { dbClientConfig } from './db.js';
import { loadDotEnv } from './env.js';
import { MemberFileError, parseMemberFile } from './umoja/memberFile.js';
import { assertMemberImportAllowed, importMembers } from './umoja/memberImport.js';

/**
 * Loads the Umoja member list (.xlsx or .csv: Employee Code, Display Name, Email Address) into the database. Meant for the DBA on the VM.
 *
 *   node server/dist/importMembers.js <file> [--check-file] [--dry-run] [--allow-remote]
 *
 *   --check-file   only read and validate the file (no database is contacted): counts and rejected row numbers
 *   --dry-run      do everything against the database, then roll back: the counts a real run would give, nothing changed
 *   (neither)      the real run: one transaction, one audit entry (counts + SHA-256 of the file)
 *
 * Safe to run twice (upsert by Employee Code), never deletes a member, and prints COUNTS and ROW NUMBERS only: no names, no addresses, no codes.
 * Uses the OWNER connection (MIGRATE_DATABASE_URL), like the migrations.
 */
loadDotEnv();
const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const file = args.find((a) => !a.startsWith('--'));
const say = (s = '') => console.log(s);

async function main(): Promise<number> {
  if (!file) { console.error('Usage: node server/dist/importMembers.js <path-to-xlsx-or-csv> [--check-file] [--dry-run] [--allow-remote]'); return 1; }
  const full = path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
  const checkOnly = flag('--check-file'), dry = flag('--dry-run');

  const url = process.env.MIGRATE_DATABASE_URL ?? '';
  if (!checkOnly) {
    if (!url) { console.error('MIGRATE_DATABASE_URL (the owner connection) is required'); return 1; }
    try { assertMemberImportAllowed(url, flag('--allow-remote')); } catch (e) { console.error((e as Error).message); return 1; }   // before the file is read
  }

  let parsed;
  try { parsed = await parseMemberFile(full); } catch (e) {
    console.error(e instanceof MemberFileError ? `Cannot use the file: ${e.message}` : `Cannot read the file: ${(e as Error).message.slice(0, 120)}`);
    return 1;
  }
  const report = (rejected: { row: number; reason: string }[]) => {
    if (!rejected.length) return;
    say(`Rejected rows (by spreadsheet row number):`);
    for (const r of rejected.slice(0, 500)) say(`  row ${r.row}: ${r.reason}`);
    if (rejected.length > 500) say(`  ... and ${rejected.length - 500} more`);
  };
  say(`File: SHA-256 ${parsed.sha256}`);

  if (checkOnly) {
    say(`Check only (no database contacted): ${parsed.rowsRead} rows read, ${parsed.members.length} valid, ${parsed.rejected.length} rejected, ${parsed.duplicates} repeated.`);
    report(parsed.rejected);
    return parsed.rejected.length ? 2 : 0;
  }

  const client = new pg.Client(dbClientConfig(url));
  try {
    await client.connect();
    const { counts, rejectedRows } = await importMembers(client, parsed, { dryRun: dry });
    say(`${dry ? 'DRY RUN (nothing was changed)' : 'IMPORT DONE'}: ${counts.rows_read} rows read`);
    say(`  added:     ${counts.added}`);
    say(`  updated:   ${counts.updated}`);
    say(`  unchanged: ${counts.unchanged}`);
    say(`  rejected:  ${counts.rejected}`);
    if (counts.duplicates) say(`  repeated rows ignored: ${counts.duplicates}`);
    report(rejectedRows);
    if (!dry) say('Recorded in the audit log (counts and the file SHA-256).');
    return 0;
  } catch (e) {
    console.error(`The import failed and nothing was changed: ${(e as Error).message.slice(0, 200)}`);
    return 1;
  } finally { await client.end().catch(() => undefined); }
}
process.exit(await main());
