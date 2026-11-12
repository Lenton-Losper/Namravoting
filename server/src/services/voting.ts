import { DEADLOCK, getPool, SERIALIZATION_FAILURE, UNIQUE_VIOLATION, withTx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { isVotingWindowOpen, shouldAutoClose } from '../domain/status.js';
import { refreshStatus } from './campaigns.js';
import { restampAfterVote } from './tallies.js';
import { logNotMember, umojaStanding } from './umoja.js';

/** Test seam: lets a test force a specific interleaving (e.g. a close landing right after the status read). Empty in production. */
export const testHooks: { afterCampaignRead?: () => Promise<void> } = {};

export const notMemberMessage = 'This vote is for Umoja members only';

type Outcome = { kind: 'recorded' } | { kind: 'closed' } | { kind: 'close_due' } | { kind: 'not_open' } | { kind: 'not_eligible' } | { kind: 'not_member' };

/**
 * Casts a ballot. One transaction (READ COMMITTED; the locks below do the ordering):
 *   lock the campaign row FOR SHARE -> re-check open + eligible -> INSERT receipt (one per MEMBER, SEC-03) -> votes = votes + 1
 *   on the candidate's tally row (a candidate of another campaign matches no row and rolls the receipt back) -> COMMIT.
 * A close or reset takes FOR UPDATE on the same campaign row, so it waits for votes in flight and a vote that arrives after it
 * sees the new state. Any failure rolls everything back. Deadlocks are retried up to 3 times.
 *
 * SECRECY (SEC-02): no row is written per vote, only a counter is incremented. This function never logs, audits or returns
 * the candidate id. After the commit all tally rows are re-stamped (services/tallies.ts) so their hidden xmin does not
 * match the voter's receipt.
 */
export async function castVote(voterOid: string, voterEmail: string, shareToken: string, candidateId: string): Promise<void> {
  let outcome: Outcome | undefined;
  let campaignId: string | undefined;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      outcome = await withTx(async (c) => {
        // FOR SHARE: voters don't block each other, but a concurrent close or reset (FOR UPDATE) waits for in-flight votes to
        // commit, and a vote that starts after one has committed re-reads the campaign row and sees the new state.
        const camp = (await c.query(
          'SELECT id, status, opens_at, closes_at, eligibility, clock_timestamp() AS db_now FROM campaigns WHERE share_token = $1 FOR SHARE', [shareToken])).rows[0];
        if (!camp) throw notFound();
        campaignId = camp.id;
        await testHooks.afterCampaignRead?.();
        // SEC-18: the cutoff is judged by the DATABASE clock, the same one that stamps every other time, not by this container's.
        const now: Date = camp.db_now;

        if (shouldAutoClose(camp, now)) return { kind: 'close_due' } as Outcome;   // closed in its own transaction below
        if (camp.status === 'closed') return { kind: 'closed' } as Outcome;
        if (!isVotingWindowOpen(camp, now)) return { kind: 'not_open' } as Outcome;

        let memberKey = `oid:${voterOid}`;
        if (camp.eligibility === 'list') {
          const e = await c.query('SELECT 1 FROM eligible_voters WHERE campaign_id = $1 AND voter_email = $2', [camp.id, voterEmail.toLowerCase()]);
          if (e.rowCount === 0) return { kind: 'not_eligible' } as Outcome;
        }
        if (camp.eligibility === 'umoja') {
          // Same check as the ballot page (services/umoja.ts), against the list frozen when the campaign started.
          const s = await umojaStanding(c, voterOid, camp);
          if (s.reason !== 'member' || !s.memberKey) {
            if (s.reason !== 'member') logNotMember(s.reason, camp.id, voterOid);
            return { kind: 'not_member' } as Outcome;
          }
          memberKey = s.memberKey;
        }

        // The primary key (account) and the unique (campaign, member) constraint are the authority for "one vote": a duplicate
        // surfaces as 23505, whether it is the same account twice or a second account of the same member.
        await c.query('INSERT INTO vote_receipts (campaign_id, voter_oid, member_key) VALUES ($1, $2, $3)', [camp.id, voterOid, memberKey]);

        const t = await c.query('UPDATE tallies SET votes = votes + 1 WHERE campaign_id = $1 AND candidate_id = $2', [camp.id, candidateId]);
        if (t.rowCount === 0) throw new HttpError(400, 'Candidate does not belong to this campaign', 'invalid_candidate');
        return { kind: 'recorded' } as Outcome;
      });
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === UNIQUE_VIOLATION) throw new HttpError(409, 'You have already voted', 'already_voted');
      if (code === SERIALIZATION_FAILURE || code === DEADLOCK) {
        if (attempt < 3) { await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20)); continue; }
        // Out of retries. If our own receipt exists (a concurrent duplicate won), that is "already voted".
        if (campaignId) {
          const r = await getPool().query('SELECT 1 FROM vote_receipts WHERE campaign_id = $1 AND voter_oid = $2', [campaignId, voterOid]);
          if (r.rowCount) throw new HttpError(409, 'You have already voted', 'already_voted');
        }
        throw new HttpError(503, 'The system is busy, please try again', 'busy');
      }
      throw e;
    }
  }

  if (outcome?.kind === 'close_due' && campaignId) {
    await refreshStatus(campaignId);               // atomic: status + receipts = tallies check + audit in one transaction
    throw new HttpError(409, 'Voting has closed', 'closed');
  }
  switch (outcome?.kind) {
    case 'recorded': await restampAfterVote(campaignId!); return;
    case 'closed': throw new HttpError(409, 'Voting has closed', 'closed');
    case 'not_open': throw new HttpError(409, 'Voting is not open yet', 'not_open');
    case 'not_member': throw new HttpError(403, notMemberMessage, 'not_member');
    case 'not_eligible': throw new HttpError(403, 'You are not eligible to vote in this campaign', 'not_eligible');
    default: throw new HttpError(500, 'Internal server error');
  }
}
