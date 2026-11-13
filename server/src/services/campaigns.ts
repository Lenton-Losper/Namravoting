import type { Queryable } from '../db.js';
import { getPool, withTx } from '../db.js';
import { shouldAutoClose, type Status } from '../domain/status.js';
import { standing } from '../domain/results.js';
import { audit } from './audit.js';
import { backupSealedResult } from './backup.js';
import { restampTallies, tallySum } from './tallies.js';

export interface CampaignRow {
  id: string; share_token: string; created_by: string; title: string; description: string | null;
  status: Status; opens_at: Date | null; closes_at: Date | null; eligibility: 'all' | 'list' | 'umoja';
  results_published: boolean; created_at: Date; archived_at: Date | null;
  parent_campaign_id?: string | null; runoff_round?: number; allow_edits_after_start?: boolean; allow_abstain?: boolean; require_approval?: boolean; receipts_purged_at?: Date | null; photos_purged_at?: Date | null;
  /** The database clock when the row was read (only on queries that ask for it). */
  db_now?: Date;
}

/** `ballots` is the sum of the candidate tallies (there is no row per ballot, SEC-02); it must equal the receipts. */
export interface Integrity { ballots: number; receipts: number; match: boolean }

/**
 * SEC-16: receipts and the sum of the tallies must agree. If they do not, the campaign is NOT closed (and a closed one cannot be
 * published) until an admin has looked into it and said so (`campaign.integrity.ack`, with a note). Thrown inside the closing
 * transaction, so it rolls back; callers record the block in the audit log afterwards (recordIntegrityBlock).
 */
export class IntegrityBlocked extends Error {
  constructor(public ballots: number, public receipts: number) { super(`receipts (${receipts}) and tallies (${ballots}) do not match`); }
}

/** The latest unacknowledged integrity block of a campaign, or null. */
export async function openIntegrityBlock(db: Queryable, campaignId: string): Promise<{ ballots: number; receipts: number; at: Date } | null> {
  const { rows } = await db.query(
    `SELECT a.seq, a.at, a.details FROM audit_log a
      WHERE a.campaign_id = $1 AND a.action = 'campaign.integrity.blocked'
        AND a.seq > coalesce((SELECT max(seq) FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.integrity.ack'), 0)
      ORDER BY a.seq DESC LIMIT 1`, [campaignId]);
  return rows[0] ? { ballots: Number(rows[0].details?.ballots ?? 0), receipts: Number(rows[0].details?.receipts ?? 0), at: rows[0].at } : null;
}

/** Writes the block to the audit log once per unacknowledged episode (a page view must not be able to flood it). */
export async function recordIntegrityBlock(campaignId: string, actorOid: string | null, e: IntegrityBlocked, attempt: 'manual' | 'auto'): Promise<void> {
  const db = getPool();
  if (await openIntegrityBlock(db, campaignId)) return;
  await audit(db, actorOid, 'campaign.integrity.blocked', campaignId, { ballots: e.ballots, receipts: e.receipts, attempt });
  console.error(`[integrity] campaign=${campaignId} receipts=${e.receipts} tallies=${e.ballots}: closing is blocked until an admin acknowledges it`);
}

export const integrityMessage = (e: IntegrityBlocked) =>
  `Receipts (${e.receipts}) and tallies (${e.ballots}) do not match, so the campaign was NOT closed. Investigate (see the audit log), then acknowledge to allow closing.`;

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
  // The caller holds the campaign row FOR UPDATE, so no vote can land between these counts and the status change.
  const ballots = await tallySum(db, campaignId);
  const receipts = (await db.query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [campaignId])).rows[0].n as number;
  const integrity = { ballots, receipts, match: ballots === receipts };
  let acknowledged = false;
  if (!integrity.match) {
    // acknowledged = an admin has acknowledged the latest block; nothing is blocked yet on the very first attempt
    const everBlocked = (await db.query("SELECT 1 FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.integrity.blocked' LIMIT 1", [campaignId])).rowCount! > 0;
    acknowledged = everBlocked && !(await openIntegrityBlock(db, campaignId));
    if (!acknowledged) throw new IntegrityBlocked(ballots, receipts);
  }
  await db.query("UPDATE campaigns SET status = 'closed' WHERE id = $1 AND status = 'open'", [campaignId]);
  await restampTallies(db, campaignId);   // every tally row now carries this transaction's id, not a voter's
  const tallies = (await db.query(
    `SELECT k.id AS candidate_id, k.name, coalesce(t.votes, 0)::int AS votes
       FROM candidates k LEFT JOIN tallies t ON t.candidate_id = k.id AND t.campaign_id = k.campaign_id
      WHERE k.campaign_id = $1 ORDER BY k.sort_order, k.name`, [campaignId])).rows;
  await audit(db, actorOid, integrity.match ? 'campaign.close' : 'campaign.close.INTEGRITY_MISMATCH', campaignId,
    { reason, ...integrity, tallies, ...(acknowledged ? { acknowledged: true } : {}), ...(opts.early ? { early: true, why: opts.why ?? '' } : {}) });
  return integrity;
}

/** Lazy auto-close (replaces a cron job): closes the campaign if closes_at has passed. */
export async function refreshStatus(campaignId: string): Promise<void> {
  // Cheap read first (SEC-08): every page load calls this, and a write transaction with a row lock per call is a free load generator.
  const peek = (await getPool().query('SELECT status, opens_at, closes_at, clock_timestamp() AS db_now FROM campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!peek || !shouldAutoClose(peek, peek.db_now)) return;   // database time (SEC-18)
  const closed = await withTx(async (c) => {
    const { rows } = await c.query('SELECT status, opens_at, closes_at, clock_timestamp() AS db_now FROM campaigns WHERE id = $1 FOR UPDATE', [campaignId]);
    if (rows[0] && shouldAutoClose(rows[0], rows[0].db_now)) { await closeInTx(c, campaignId, null, 'auto'); return true; }
    return false;
  }).catch(async (e) => {
    // A mismatch keeps the campaign open (voting is already shut by its closing time); record it once and carry on.
    if (e instanceof IntegrityBlocked) { await recordIntegrityBlock(campaignId, null, e, 'auto'); return false; }
    throw e;
  });
  if (closed) await backupSealedResult(campaignId);   // a copy of the sealed result outside the database (never throws)
}

/** A voter-visible event in a campaign's life: a reset, or an early close. Built from the permanent audit entries. */
export interface Notice {
  kind: 'reset' | 'closed_early' | 'edited_after_start' | 'candidate_withdrawn';
  /** candidate_withdrawn: who withdrew. Votes already cast for them are void (reported separately, never a winner). */
  candidate?: string;
  at: Date; by: string | null; reason: string;
  /** edited_after_start: what changed (titles, descriptions, closing times and candidate names only; never anything about voters). */
  changes?: { what: string; name?: string; from?: string | null; to?: string | null }[];
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
      WHERE a.campaign_id = $1 AND (a.action IN ('campaign.reset', 'campaign.edit_after_start', 'candidate.withdrawn') OR (a.action LIKE 'campaign.close%' AND a.details->>'early' = 'true'))
      ORDER BY a.seq`, [campaignId]);
  return rows.map((r) => {
    if (r.action === 'campaign.reset') {
      const snap = r.details?.snapshot ?? {};
      const e: Notice = { kind: 'reset', at: r.at, by: r.by ?? null, reason: String(r.details?.reason ?? ''), votes_cleared: Number(snap.turnout?.votes ?? 0) };
      if (withTallies) e.candidates = (snap.candidates ?? []) as { name: string; votes: number }[];
      return e;
    }
    if (r.action === 'candidate.withdrawn') return { kind: 'candidate_withdrawn', at: r.at, by: r.by ?? null, reason: String(r.details?.reason ?? ''), candidate: String(r.details?.name ?? '') } as Notice;
    if (r.action === 'campaign.edit_after_start') return { kind: 'edited_after_start', at: r.at, by: r.by ?? null, reason: '', changes: (r.details?.changes ?? []) } as Notice;
    return { kind: 'closed_early', at: r.at, by: r.by ?? null, reason: String(r.details?.why ?? '') } as Notice;
  });
}

/** Resets only (kept for the results payload shape the client already reads). */
export async function getResetHistory(db: Queryable, campaignId: string, withTallies: boolean) {
  return (await getNotices(db, campaignId, withTallies)).filter((n) => n.kind === 'reset');
}

export interface ResultsPayload {
  candidates: { id: string; name: string; votes: number; is_abstain?: boolean; withdrawn?: boolean }[];
  turnout: { votes: number; eligible: number | null };
  /** Candidates sharing first place (2 or more), or null. A tie has no winner: the creator can start a run-off. */
  tie: { ids: string[]; names: string[]; votes: number } | null;
}

/** Per-candidate counts. Only ever returned for a CLOSED campaign (SEC-01): while it is open nobody sees these. */
export async function getResults(db: Queryable, campaignId: string): Promise<ResultsPayload> {
  const cands = await db.query(
    `SELECT c.id, c.name, c.is_abstain, (c.withdrawn_at IS NOT NULL) AS withdrawn, coalesce(t.votes, 0)::int AS votes
       FROM candidates c LEFT JOIN tallies t ON t.candidate_id = c.id AND t.campaign_id = c.campaign_id
      WHERE c.campaign_id = $1 ORDER BY c.sort_order, c.name`, [campaignId]);
  const s = standing(cands.rows);
  return { candidates: cands.rows, turnout: await getTurnout(db, campaignId), tie: s.tied.length ? { ids: s.tied.map((x) => x.id), names: s.tied.map((x) => x.name), votes: s.tied[0].votes } : null };
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
  // Once the retention job has removed the receipts (their personal data), "receipts equal the sealed turnout" no longer applies (null);
  // the sealed turnout itself stays in the audit chain.
  const purged = (await db.query('SELECT receipts_purged_at FROM campaigns WHERE id = $1', [campaignId])).rows[0]?.receipts_purged_at;
  if (now.length > 0) {
    const cur = new Map(now.map((r) => [r.candidate_id, r.votes]));
    out.tallies_match = sealed.length === now.length && sealed.every((t) => cur.get(t.candidate_id) === t.votes);
    const receipts = (await db.query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [campaignId])).rows[0].n as number;
    out.receipts_match = purged ? null : receipts === out.sealed_turnout;
  }
  return out;
}
