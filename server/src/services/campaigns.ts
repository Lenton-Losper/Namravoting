import type { Queryable } from '../db.js';
import { withTx } from '../db.js';
import { shouldAutoClose, type Status } from '../domain/status.js';
import { audit } from './audit.js';

export interface CampaignRow {
  id: string; share_token: string; created_by: string; title: string; description: string | null;
  status: Status; opens_at: Date | null; closes_at: Date | null; eligibility: 'all' | 'list' | 'umoja';
  results_published: boolean; created_at: Date; archived_at: Date | null;
}

export interface Integrity { ballots: number; receipts: number; match: boolean }

/** Closes a campaign inside an existing transaction and writes the integrity check to the audit log. */
export async function closeInTx(
  db: Queryable, campaignId: string, actorOid: string | null, reason: 'manual' | 'auto',
): Promise<Integrity> {
  await db.query("UPDATE campaigns SET status = 'closed' WHERE id = $1 AND status = 'open'", [campaignId]);
  const b = await db.query('SELECT count(*)::int AS n FROM ballots WHERE campaign_id = $1', [campaignId]);
  const r = await db.query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [campaignId]);
  const integrity = { ballots: b.rows[0].n as number, receipts: r.rows[0].n as number, match: b.rows[0].n === r.rows[0].n };
  await audit(db, actorOid, integrity.match ? 'campaign.close' : 'campaign.close.INTEGRITY_MISMATCH', campaignId, { reason, ...integrity });
  return integrity;
}

/** Lazy auto-close (replaces a cron job): closes the campaign if closes_at has passed. */
export async function refreshStatus(campaignId: string): Promise<void> {
  await withTx(async (c) => {
    const { rows } = await c.query('SELECT status, opens_at, closes_at FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
    if (rows[0] && shouldAutoClose(rows[0], new Date())) await closeInTx(c, campaignId, null, 'auto');
  });
}

export interface ResetEntry {
  at: Date; by: string | null; reason: string; votes_cleared: number;
  /** Per-candidate counts before the reset. Only included for the campaign's creator. */
  candidates?: { name: string; votes: number }[];
}

/**
 * Reset history, newest last. Built from the permanent audit entries (action 'campaign.reset'); the snapshot holds
 * counts only, never anything about individual voters.
 */
export async function getResetHistory(db: Queryable, campaignId: string, withTallies: boolean): Promise<ResetEntry[]> {
  const { rows } = await db.query(
    `SELECT a.at, u.display_name AS by, a.details
       FROM audit_log a LEFT JOIN users u ON u.entra_oid = a.actor_oid
      WHERE a.campaign_id = $1 AND a.action = 'campaign.reset' ORDER BY a.at, a.id`, [campaignId]);
  return rows.map((r) => {
    const snap = r.details?.snapshot ?? {};
    const e: ResetEntry = { at: r.at, by: r.by ?? null, reason: String(r.details?.reason ?? ''), votes_cleared: Number(snap.turnout?.votes ?? 0) };
    if (withTallies) e.candidates = (snap.candidates ?? []) as { name: string; votes: number }[];
    return e;
  });
}

export interface ResultsPayload {
  candidates: { id: string; name: string; votes: number }[];
  turnout: { votes: number; eligible: number | null };
}

export async function getResults(db: Queryable, campaignId: string): Promise<ResultsPayload> {
  const cands = await db.query(
    `SELECT c.id, c.name, count(b.id)::int AS votes
       FROM candidates c LEFT JOIN ballots b ON b.candidate_id = c.id AND b.campaign_id = c.campaign_id
      WHERE c.campaign_id = $1 GROUP BY c.id ORDER BY c.sort_order, c.name`, [campaignId]);
  const t = await db.query(
    `SELECT (SELECT count(*)::int FROM vote_receipts WHERE campaign_id = $1) AS votes,
            CASE (SELECT eligibility FROM campaigns WHERE id = $1)
                 WHEN 'list' THEN (SELECT count(*)::int FROM eligible_voters WHERE campaign_id = $1)
                 WHEN 'umoja' THEN (SELECT count(*)::int FROM umoja_members WHERE active) END AS eligible`, [campaignId]);
  return { candidates: cands.rows, turnout: { votes: t.rows[0].votes, eligible: t.rows[0].eligible } };
}
