import { withTx, type Queryable } from '../db.js';

/**
 * SEC-02: there is no row per vote. Each candidate has one counter row (table `tallies`).
 *
 * Postgres keeps a hidden `xmin` (the writing transaction) on every row version. A tally row updated by a voter's
 * transaction would carry that voter's transaction id, the same id as the voter's receipt, which would link the receipt
 * to the candidate. So after every vote (and at close) ALL tally rows of the campaign are rewritten in one separate
 * transaction: every row then carries the same, voter-independent `xmin`. It is best effort for the per-vote call (a
 * failure only leaves the previous stamp) and exact at close and reset.
 */
export async function restampTallies(db: Queryable, campaignId: string): Promise<void> {
  await db.query('SELECT 1 FROM tallies WHERE campaign_id = $1 ORDER BY candidate_id FOR UPDATE', [campaignId]);
  await db.query('UPDATE tallies SET votes = votes WHERE campaign_id = $1', [campaignId]);
}

/** After a vote has committed. Never throws: the vote is already recorded. */
export async function restampAfterVote(campaignId: string): Promise<void> {
  try { await withTx((c) => restampTallies(c, campaignId)); } catch { /* the next vote or the close re-stamps */ }
}

/** One counter row per candidate, created when a campaign starts (candidates are locked from then on). */
export async function createTallies(db: Queryable, campaignId: string): Promise<void> {
  await db.query('INSERT INTO tallies (campaign_id, candidate_id, votes) SELECT campaign_id, id, 0 FROM candidates WHERE campaign_id = $1 ON CONFLICT DO NOTHING', [campaignId]);
}

/** Sum of all counters of a campaign (compared with the number of receipts as the integrity check). */
export async function tallySum(db: Queryable, campaignId: string): Promise<number> {
  return (await db.query('SELECT coalesce(sum(votes), 0)::int AS n FROM tallies WHERE campaign_id = $1', [campaignId])).rows[0].n as number;
}
