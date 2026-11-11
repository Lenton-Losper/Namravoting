import type pg from 'pg';
import type { ParseResult } from './parse.js';

export interface ImportSummary {
  rows_read: number; active: number; inactive: number; invalid: number; duplicates: number; removed: number;
}

/**
 * Full sync in ONE transaction: the table ends up containing exactly the members in `parsed` (members missing
 * from the new file are removed; existing members keep their Entra match). Run with the OWNER role (the app role has SELECT only).
 * The audit entry holds counts only.
 */
export async function importUmoja(client: pg.Client | pg.PoolClient, parsed: ParseResult): Promise<ImportSummary> {
  if (parsed.members.length === 0) throw new Error('Refusing to replace the member list with an empty one (no valid rows found)');
  const codes = parsed.members.map((m) => m.code);
  const flags = parsed.members.map((m) => m.active);
  const active = flags.filter(Boolean).length;
  await client.query('BEGIN');
  try {
    const before = (await client.query('SELECT count(*)::int AS n FROM umoja_members')).rows[0].n as number;
    // Sync, not wipe-and-reload: members that stay keep their Entra match (entra_oid/email); members missing from the file go.
    await client.query('DELETE FROM umoja_members WHERE employee_code <> ALL($1::text[])', [codes]);
    await client.query(
      `INSERT INTO umoja_members (employee_code, active) SELECT * FROM unnest($1::text[], $2::boolean[])
       ON CONFLICT (employee_code) DO UPDATE SET active = EXCLUDED.active, imported_at = now()`, [codes, flags]);
    const summary: ImportSummary = {
      rows_read: parsed.rowsRead, active, inactive: codes.length - active,
      invalid: parsed.invalid.length, duplicates: parsed.duplicates, removed: before,
    };
    await client.query("INSERT INTO audit_log (actor_oid, action, details) VALUES (NULL, 'umoja.import', $1)", [JSON.stringify(summary)]);
    await client.query('COMMIT');
    return summary;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}
