import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Queryable } from '../db.js';
import type { PhotoStorage } from './storage.js';

/**
 * Is this database a faithful, complete copy? Run against a restored database (a Neon branch / point-in-time restore) before pointing the
 * app at it, and used by the restore drill (scripts/restore-drill.mjs). Read-only. Reports; never changes anything.
 *
 *   FAIL (the copy cannot be trusted):  migrations missing, audit chain broken, receipts <> counters, a sealed result no longer equal to its counters.
 *   WARN (worth knowing):               a closed campaign with no sealed-result copy in storage.
 */
export interface Check { name: string; ok: boolean; warn?: boolean; detail: string }
export interface RestoreReport { ok: boolean; checks: Check[]; counts: { users: number; campaigns: number; audit_entries: number; closed_campaigns: number } }

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function checkDatabase(db: Queryable, storage?: PhotoStorage): Promise<RestoreReport> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, warn = false) => checks.push({ name, ok, detail, ...(warn ? { warn: true } : {}) });

  const expected = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
  const missing = expected.filter((f) => !applied.has(f));
  add('Migrations', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `all ${expected.length} applied`);

  const chain = (await db.query('SELECT audit_chain_verify() AS r')).rows[0].r as { ok: boolean; checked: number; broken_at_seq?: number };
  add('Audit chain', chain.ok, chain.ok ? `${chain.checked} entries, every hash links to the one before` : `BROKEN at entry ${chain.broken_at_seq}`);

  const mismatch = (await db.query(
    `SELECT c.id FROM campaigns c WHERE c.status <> 'draft' AND c.receipts_purged_at IS NULL
        AND (SELECT coalesce(sum(votes), 0) FROM tallies t WHERE t.campaign_id = c.id) <> (SELECT count(*) FROM vote_receipts v WHERE v.campaign_id = c.id)`)).rows;
  add('Receipts equal counters', mismatch.length === 0, mismatch.length ? `differ for ${mismatch.length} campaign(s): ${mismatch.map((r) => String(r.id).slice(0, 8)).join(', ')}` : 'every started campaign: ballots counted = receipts');

  const closed = (await db.query(
    `SELECT c.id, c.title, s.seq, s.details FROM campaigns c
       JOIN LATERAL (SELECT seq, details FROM audit_log WHERE campaign_id = c.id AND action LIKE 'campaign.close%' ORDER BY seq DESC LIMIT 1) s ON true
      WHERE c.status = 'closed'`)).rows;
  const unsealed = (await db.query("SELECT count(*)::int AS n FROM campaigns c WHERE c.status = 'closed' AND NOT EXISTS (SELECT 1 FROM audit_log WHERE campaign_id = c.id AND action LIKE 'campaign.close%')")).rows[0].n as number;
  add('Closed campaigns are sealed', unsealed === 0, unsealed ? `${unsealed} closed campaign(s) have no seal` : `${closed.length} sealed`);

  let drift = 0;
  for (const c of closed) {
    const sealed = (c.details?.tallies ?? []) as { candidate_id: string; votes: number }[];
    const now = (await db.query('SELECT candidate_id, votes FROM tallies WHERE campaign_id = $1', [c.id])).rows as { candidate_id: string; votes: number }[];
    const cur = new Map(now.map((r) => [r.candidate_id, r.votes]));
    if (now.length && (sealed.length !== now.length || sealed.some((t) => cur.get(t.candidate_id) !== t.votes))) drift++;
  }
  add('Sealed results equal the counters', drift === 0, drift ? `${drift} campaign(s) differ from what was sealed` : 'every closed campaign');

  if (storage) {
    const noCopy: string[] = [];
    for (const c of closed) if (!(await storage.get(`sealed-${c.id}-${c.seq}.json`))) noCopy.push(String(c.id).slice(0, 8));
    add('Sealed-result copies in storage', noCopy.length === 0, noCopy.length ? `missing for ${noCopy.length} closed campaign(s): ${noCopy.join(', ')} (run: npm run backup:sealed)` : `${closed.length} present`, noCopy.length > 0);
  }

  const n = async (sql: string) => (await db.query(sql)).rows[0].n as number;
  const counts = { users: await n('SELECT count(*)::int AS n FROM users'), campaigns: await n('SELECT count(*)::int AS n FROM campaigns'), audit_entries: await n('SELECT count(*)::int AS n FROM audit_log'), closed_campaigns: closed.length };
  return { ok: checks.every((c) => c.ok || c.warn), checks, counts };
}

export const formatReport = (r: RestoreReport): string =>
  [...r.checks.map((c) => `  ${c.ok ? 'PASS' : c.warn ? 'WARN' : 'FAIL'}  ${c.name}: ${c.detail}`),
    `  Counts: ${r.counts.users} users, ${r.counts.campaigns} campaigns (${r.counts.closed_campaigns} closed), ${r.counts.audit_entries} audit entries`,
    r.ok ? 'RESULT: this database is a faithful copy.' : 'RESULT: DO NOT USE this database until the failures are understood.'].join('\n');
