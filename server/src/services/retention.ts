import crypto from 'node:crypto';
import type pg from 'pg';

/**
 * Retention (business-logic item 5). Run by `npm run retention` / the Retention workflow with the OWNER database role.
 *
 *  - purgeCampaign: for a campaign that is closed AND archived for N months, removes the personal data (receipts, the voter list, the
 *    Umoja snapshot, candidate photos). The sealed result (tallies, turnout, the audit chain) stays, and so does the campaign row.
 *  - anonymiseUsers: for people who have left, replaces name, email and employee code and ends their sessions; the account id stays, so
 *    the audit log still makes sense ("a former staff member did this").
 * Every step is audited (actor null = the job) and nothing is removed from a campaign that is not closed and archived.
 */

export interface Purgeable { id: string; title: string; closed_at: Date; archived_at: Date; receipts: number }

/** Closed, archived, not yet purged, and closed more than `months` months ago (months may be 0 in tests). */
export async function findPurgeable(db: pg.Pool | pg.PoolClient, months: number): Promise<Purgeable[]> {
  const { rows } = await db.query(
    `SELECT c.id, c.title, closed.at AS closed_at, c.archived_at, (SELECT count(*)::int FROM vote_receipts v WHERE v.campaign_id = c.id) AS receipts
       FROM campaigns c, LATERAL (SELECT max(at) AS at FROM audit_log WHERE campaign_id = c.id AND action LIKE 'campaign.close%') closed
      WHERE c.status = 'closed' AND c.archived_at IS NOT NULL AND c.receipts_purged_at IS NULL
        AND closed.at IS NOT NULL AND closed.at < now() - make_interval(months => $1)
      ORDER BY closed.at`, [months]);
  return rows;
}

export interface PurgeResult { id: string; title: string; receipts: number; eligible_voters: number; snapshot_rows: number; photos: number }

export async function purgeCampaign(pool: pg.Pool, id: string, deleteFile: (name: string) => Promise<void>): Promise<PurgeResult | null> {
  const client = await pool.connect();
  let photos: string[] = [];
  let out: PurgeResult;
  try {
    await client.query('BEGIN');
    const c = (await client.query('SELECT title, status, archived_at, receipts_purged_at FROM campaigns WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!c || c.status !== 'closed' || !c.archived_at || c.receipts_purged_at) { await client.query('ROLLBACK'); return null; }
    photos = (await client.query('SELECT photo_path FROM candidates WHERE campaign_id = $1 AND photo_path IS NOT NULL', [id])).rows.map((r) => r.photo_path as string);
    const rc = (await client.query('DELETE FROM vote_receipts WHERE campaign_id = $1', [id])).rowCount ?? 0;
    const ev = (await client.query('DELETE FROM eligible_voters WHERE campaign_id = $1', [id])).rowCount ?? 0;
    const cv = (await client.query('DELETE FROM campaign_voters WHERE campaign_id = $1', [id])).rowCount ?? 0;
    await client.query('UPDATE campaigns SET receipts_purged_at = now(), photos_purged_at = now() WHERE id = $1', [id]);
    out = { id, title: c.title, receipts: rc, eligible_voters: ev, snapshot_rows: cv, photos: photos.length };
    await client.query("INSERT INTO audit_log (actor_oid, action, campaign_id, details) VALUES (NULL, 'retention.purged', $1, $2)",
      [id, JSON.stringify({ title: c.title, receipts_removed: rc, eligible_voters_removed: ev, snapshot_rows_removed: cv, photos_removed: photos.length })]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
  // Files go only AFTER the database commit: a storage hiccup never undoes the purge.
  for (const p of photos) { try { await deleteFile(p); } catch (e) { console.warn(`[retention] could not delete a photo file: ${(e as Error).message}`); } }
  return out;
}

export type LeaverOutcome = 'anonymised' | 'not_found' | 'already_anonymised' | 'owns_active_campaigns';
export interface LeaverResult { email_hash: string; outcome: LeaverOutcome }

const REMOVED_DOMAIN = '@removed.invalid';

/** Reports never echo the email itself: a short hash lets the operator match lines to their list without spreading the address. */
const shortHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);

export async function anonymiseUsers(pool: pg.Pool, emails: string[], apply: boolean): Promise<LeaverResult[]> {
  const out: LeaverResult[] = [];
  for (const raw of [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]) {
    const h = shortHash(raw);
    if (raw.endsWith(REMOVED_DOMAIN)) { out.push({ email_hash: h, outcome: 'already_anonymised' }); continue; }
    const u = (await pool.query('SELECT entra_oid FROM users WHERE email = $1', [raw])).rows[0];
    if (!u) { out.push({ email_hash: h, outcome: 'not_found' }); continue; }
    // Someone who still runs a draft or open campaign is not removed: their name is what the voters and the audit trail rely on.
    const active = (await pool.query("SELECT 1 FROM campaigns WHERE created_by = $1 AND status IN ('draft', 'open') LIMIT 1", [u.entra_oid])).rowCount;
    if (active) { out.push({ email_hash: h, outcome: 'owns_active_campaigns' }); continue; }
    if (apply) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("UPDATE users SET email = 'removed-' || entra_oid::text || $2, display_name = 'Former staff member', employee_code = NULL WHERE entra_oid = $1", [u.entra_oid, REMOVED_DOMAIN]);
        await client.query('DELETE FROM sessions WHERE user_oid = $1', [u.entra_oid]);
        await client.query('DELETE FROM eligible_voters WHERE voter_email = $1', [raw]);
        await client.query("INSERT INTO audit_log (actor_oid, action, campaign_id, details) VALUES (NULL, 'retention.user_anonymised', NULL, $1)", [JSON.stringify({ user: u.entra_oid })]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; } finally { client.release(); }
    }
    out.push({ email_hash: h, outcome: 'anonymised' });
  }
  return out;
}
