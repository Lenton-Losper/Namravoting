import type pg from 'pg';
import type { MemberFile } from './memberFile.js';
import { dbHost, isLocalDatabase } from './guard.js';

export interface MemberImportCounts {
  rows_read: number; added: number; updated: number; unchanged: number; rejected: number; duplicates: number;
}

/**
 * Where the member list may go without --allow-remote: this machine, a Docker/compose service name (a host with no dots, e.g. "db"), a private
 * network address, or a NamRA host. A public cloud database (the Cloudflare demo's Neon, for instance) is refused unless the caller says so.
 */
export function assertMemberImportAllowed(connectionString: string, allowRemote: boolean): void {
  if (allowRemote || isLocalDatabase(connectionString)) return;
  const h = dbHost(connectionString);
  const private4 = h !== null && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (h !== null && (!h.includes('.') || private4 || h.endsWith('.namra.org.na') || h.endsWith('.internal') || h.endsWith('.local'))) return;
  throw new Error(`Refusing to import: the database host "${h ?? 'unknown'}" looks like a public service. The member list belongs on the NamRA VM's database. Pass --allow-remote only if you are sure.`);
}

/**
 * Upserts the members by Employee Code, in ONE transaction (run with the OWNER role; the app role cannot write this table):
 *   - a code that is not in the table is ADDED (active);
 *   - a code that is, with a different email, is UPDATED (email only: an existing member's active flag and Entra match are never touched);
 *   - a code that is, with the same email, is UNCHANGED;
 *   - nobody is ever deleted;
 *   - an address that already belongs to a DIFFERENT member in the table rejects that row (it is counted as rejected, by row number only).
 * dryRun does the same work and ROLLS BACK, so the counts are exactly what a real run would give, and nothing changes (no audit entry either).
 * The audit entry holds counts and the SHA-256 of the file: never a name, an address or a code.
 */
export async function importMembers(client: pg.Client | pg.PoolClient, file: MemberFile, opts: { dryRun: boolean }): Promise<{ counts: MemberImportCounts; rejectedRows: { row: number; reason: string }[] }> {
  await client.query('BEGIN');
  try {
    const rejectedRows = [...file.rejected];
    const codes = file.members.map((m) => m.code);
    const existing = new Map<string, string | null>((await client.query('SELECT employee_code, email FROM umoja_members WHERE employee_code = ANY($1::text[])', [codes])).rows.map((r) => [r.employee_code as string, r.email as string | null]));
    const owners = new Map<string, string>((await client.query('SELECT email, employee_code FROM umoja_members WHERE email = ANY($1::text[])', [file.members.map((m) => m.email)])).rows.map((r) => [r.email as string, r.employee_code as string]));
    // Decide in memory, then write in TWO statements (multi-row, via unnest): a list of a thousand people takes a moment, not minutes.
    const toAdd: { code: string; email: string }[] = [], toUpdate: { code: string; email: string }[] = [];
    let unchanged = 0;
    for (const m of file.members) {
      const owner = owners.get(m.email);
      if (owner && owner !== m.code) { rejectedRows.push({ row: m.row, reason: 'email address already belongs to another member' }); continue; }
      if (!existing.has(m.code)) toAdd.push(m);
      else if (existing.get(m.code) !== m.email) toUpdate.push(m);
      else unchanged++;
    }
    if (toAdd.length) await client.query('INSERT INTO umoja_members (employee_code, active, email) SELECT c, true, e FROM unnest($1::text[], $2::text[]) AS t(c, e)', [toAdd.map((m) => m.code), toAdd.map((m) => m.email)]);
    if (toUpdate.length) {
      // two members swapping addresses in one file would clash on the unique index row by row: clear, then set (still one transaction)
      await client.query('UPDATE umoja_members SET email = NULL WHERE employee_code = ANY($1::text[]) AND entra_oid IS NULL', [toUpdate.map((m) => m.code)]);
      await client.query('UPDATE umoja_members m SET email = t.e, imported_at = now() FROM unnest($1::text[], $2::text[]) AS t(c, e) WHERE m.employee_code = t.c', [toUpdate.map((m) => m.code), toUpdate.map((m) => m.email)]);
    }
    const added = toAdd.length, updated = toUpdate.length;
    rejectedRows.sort((a, b) => a.row - b.row);
    const counts: MemberImportCounts = { rows_read: file.rowsRead, added, updated, unchanged, rejected: rejectedRows.length, duplicates: file.duplicates };
    if (opts.dryRun) { await client.query('ROLLBACK'); return { counts, rejectedRows }; }
    await client.query("INSERT INTO audit_log (actor_oid, action, details) VALUES (NULL, 'umoja.members_import', $1)", [JSON.stringify({ ...counts, file_sha256: file.sha256 })]);
    await client.query('COMMIT');
    return { counts, rejectedRows };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}
