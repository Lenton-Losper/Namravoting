import type { Queryable } from '../db.js';
import { getPool, withTx } from '../db.js';
import { shouldAutoClose, type Status } from '../domain/status.js';
import { audit } from './audit.js';
import { restampTallies, tallySum } from './tallies.js';

export interface CampaignRow {
  id: string; share_token: string; created_by: string; title: string; description: string | null;
  status: Status; opens_at: Date | null; closes_at: Date | null; eligibility: 'all' | 'list' | 'umoja';
  results_published: boolean; created_at: Date; archived_at: Date | null;
}

/** `ballots` is the sum of the candidate tallies (there is no row per ballot, SEC-02); it must equal the receipts. */
export interface Integrity { ballots: number; receipts: number; match: boolean }

export interface CloseOptions {
  /** Closed by hand before closes_at: needs a reason, which is shown to voters. */
  early?: boolean;
  why?: string;
}

/**
 * Closes a campaign inside an existing transaction and SEALS the result: the final per-candidate tallies, the turnout and the
 * receipts = tallies check go into one hash-chained audit entry (SEC-04), which survives a permanent delete.
 */
export async function closeInTx(
  db: Queryable, campaignId: string, actorOid: string | null, reason: 'manual' | 'auto', opts: CloseOptions = {},
): Promise<Integrity> {
  await db.query("UPDATE campaigns SET status = 'closed' WHERE id = $1 AND status = 'open'", [campaignId]);
  await restampTallies(db, campaignId);   // every tally row now carries this transaction's id, not a voter's
  const ballots = await tallySum(db, campaignId);
  const receipts = (await db.query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [campaignId])).rows[0].n as number;
  const integrity = { ballots, receipts, match: ballots === receipts };
  const tallies = (await db.query(
    `SELECT k.id AS candidate_id, k.name, coalesce(t.votes, 0)::int AS votes
       FROM candidates k LEFT JOIN tallies t ON t.candidate_id = k.id AND t.campaign_id = k.campaign_id
      WHERE k.campaign_id = $1 ORDER BY k.sort_order, k.name`, [campaignId])).rows;
  await audit(db, actorOid, integrity.match ? 'campaign.close' : 'campaign.close.INTEGRITY_MISMATCH', campaignId,
    { reason, ...integrity, tallies, ...(opts.early ? { early: true, why: opts.why ?? '' } : {}) });
  return integrity;
}

/** Lazy auto-close (replaces a cron job): closes the campaign if closes_at has passed. */
export async function refreshStatus(campaignId: string): Promise<void> {
  // Cheap read first (SEC-08): every page load calls this, and a write transaction with a row lock per call is a free load generator.
  const peek = (await getPool().query('SELECT status, opens_at, closes_at FROM campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!peek || !shouldAutoClose(peek, new Date())) return;
  await withTx(async (c) => {
    const { rows } = await c.query('SELECT status, opens_at, closes_at FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
    if (rows[0] && shouldAutoClose(rows[0], new Date())) await closeInTx(c, campaignId, null, 'auto');
  });
}

/** A voter-visible event in a campaign's life: a reset, or an early close. Built from the permanent audit entries. */
export interface Notice {
  kind: 'reset' | 'closed_early';
  at: Date; by: string | null; reason: string;
  votes_cleared?: number;
  /** Per-candidate counts before the reset. Only included for the campaign's creator. */
  candidates?: { name: string; votes: number }[];
}

/**
 * Resets and early closes, oldest first. Counts only, never anything about individual voters. Shown on the ballot page while
 * the vote runs and in the published results afterwards (SEC-01).
 */
export async function getNotices(db: Queryable, campaignId: string, withTallies: boolean): Promise<Notice[]> {
  const { rows } = await db.query(
    `SELECT a.at, a.action, u.display_name AS by, a.details
       FROM audit_log a LEFT JOIN users u ON u.entra_oid = a.actor_oid
      WHERE a.campaign_id = $1 AND (a.action = 'campaign.reset' OR (a.action LIKE 'campaign.close%' AND a.details->>'early' = 'true'))
      ORDER BY a.seq`, [campaignId]);
  return rows.map((r) => {
    if (r.action === 'campaign.reset') {
      const snap = r.details?.snapshot ?? {};
      const e: Notice = { kind: 'reset', at: r.at, by: r.by ?? null, reason: String(r.details?.reason ?? ''), votes_cleared: Number(snap.turnout?.votes ?? 0) };
      if (withTallies) e.candidates = (snap.candidates ?? []) as { name: string; votes: number }[];
      return e;
    }
    return { kind: 'closed_early', at: r.at, by: r.by ?? null, reason: String(r.details?.why ?? '') } as Notice;
  });
}

/** Resets only (kept for the results payload shape the client already reads). */
export async function getResetHistory(db: Queryable, campaignId: string, withTallies: boolean) {
  return (await getNotices(db, campaignId, withTallies)).filter((n) => n.kind === 'reset');
}

export interface ResultsPayload {
  candidates: { id: string; name: string; votes: number }[];
  turnout: { votes: number; eligible: number | null };
}

/** Per-candidate counts. Only ever returned for a CLOSED campaign (SEC-01): while it is open nobody sees these. */
export async function getResults(db: Queryable, campaignId: string): Promise<ResultsPayload> {
  const cands = await db.query(
    `SELECT c.id, c.name, coalesce(t.votes, 0)::int AS votes
       FROM candidates c LEFT JOIN tallies t ON t.candidate_id = c.id AND t.campaign_id = c.campaign_id
      WHERE c.campaign_id = $1 ORDER BY c.sort_order, c.name`, [campaignId]);
  return { candidates: cands.rows, turnout: await getTurnout(db, campaignId) };
}

/** Turnout only (votes cast, and how many people could have voted). Safe to show while voting is open. */
export async function getTurnout(db: Queryable, campaignId: string): Promise<ResultsPayload['turnout']> {
  const t = await db.query(
    `SELECT (SELECT count(*)::int FROM vote_receipts WHERE campaign_id = $1) AS votes,
            CASE (SELECT eligibility FROM campaigns WHERE id = $1)
                 WHEN 'list' THEN (SELECT count(*)::int FROM eligible_voters WHERE campaign_id = $1)
                 WHEN 'umoja' THEN (SELECT CASE WHEN (SELECT status FROM campaigns WHERE id = $1) = 'draft'
                                                THEN (SELECT count(*)::int FROM umoja_members WHERE active)
                                                ELSE (SELECT count(*)::int FROM campaign_voters WHERE campaign_id = $1 AND active) END) END AS eligible`, [campaignId]);
  return { votes: t.rows[0].votes, eligible: t.rows[0].eligible };
}

export interface SealCheck {
  chain_ok: boolean; chain_checked: number;
  sealed: boolean; sealed_at: Date | null; seal_hash: string | null; seal_seq: number | null;
  tallies_match: boolean | null; receipts_match: boolean | null;
  sealed_tallies: { name: string; votes: number }[]; sealed_turnout: number | null;
}

/**
 * "Verify results integrity" (SEC-04): the audit chain is intact, the campaign's latest close entry is sealed in it, and the
 * counters and receipts still equal what that entry recorded. null = the data it would compare with no longer exists
 * (permanently deleted); the sealed entry itself stays.
 */
export async function verifySeal(db: Queryable, campaignId: string): Promise<SealCheck> {
  const chain = (await db.query('SELECT audit_chain_verify() AS r')).rows[0].r as { ok: boolean; checked: number };
  const seal = (await db.query(
    `SELECT seq, hash, at, details FROM audit_log WHERE campaign_id = $1 AND action LIKE 'campaign.close%' ORDER BY seq DESC LIMIT 1`, [campaignId])).rows[0];
  const reset = seal ? (await db.query(`SELECT 1 FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.reset' AND seq > $2`, [campaignId, seal.seq])).rowCount : 0;
  const out: SealCheck = { chain_ok: chain.ok, chain_checked: Number(chain.checked), sealed: !!seal && !reset, sealed_at: null, seal_hash: null, seal_seq: null,
    tallies_match: null, receipts_match: null, sealed_tallies: [], sealed_turnout: null };
  if (!seal || reset) return out;
  out.sealed_at = seal.at; out.seal_hash = seal.hash; out.seal_seq = Number(seal.seq);
  const sealed = (seal.details?.tallies ?? []) as { candidate_id: string; name: string; votes: number }[];
  out.sealed_tallies = sealed.map((t) => ({ name: t.name, votes: t.votes }));
  out.sealed_turnout = Number(seal.details?.receipts ?? 0);
  const now = (await db.query('SELECT candidate_id, votes FROM tallies WHERE campaign_id = $1', [campaignId])).rows as { candidate_id: string; votes: number }[];
  if (now.length > 0) {
    const cur = new Map(now.map((r) => [r.candidate_id, r.votes]));
    out.tallies_match = sealed.length === now.length && sealed.every((t) => cur.get(t.candidate_id) === t.votes);
    const receipts = (await db.query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [campaignId])).rows[0].n as number;
    out.receipts_match = receipts === out.sealed_turnout;
  }
  return out;
}
