import { DEADLOCK, getPool, SERIALIZATION_FAILURE, UNIQUE_VIOLATION, withTx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { isVotingWindowOpen, shouldAutoClose } from '../domain/status.js';
import { refreshStatus } from './campaigns.js';
import { logNotMember, umojaReason } from './umoja.js';

/** Test seam: lets a test force a specific interleaving (e.g. a close landing right after the status read). Empty in production. */
export const testHooks: { afterCampaignRead?: () => Promise<void> } = {};

export const notMemberMessage = 'This vote is for Umoja members only';

type Outcome = { kind: 'recorded' } | { kind: 'closed' } | { kind: 'close_due' } | { kind: 'not_open' } | { kind: 'not_eligible' } | { kind: 'not_member' };

/**
 * Casts a ballot. One SERIALIZABLE transaction:
 *   re-check open + eligible -> INSERT receipt -> INSERT ballot (candidate must belong to campaign) -> COMMIT.
 * Any failure rolls everything back. Serialization failures are retried up to 3 times.
 *
 * SECRECY: this function never logs, audits or returns the candidate id. The receipt and the ballot are
 * written in the same transaction but share no column, no timestamp and no ordering key.
 */
export async function castVote(voterOid: string, voterEmail: string, shareToken: string, candidateId: string): Promise<void> {
  let outcome: Outcome | undefined;
  let campaignId: string | undefined;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      outcome = await withTx(async (c) => {
        // FOR SHARE: voters don't block each other, but a concurrent close (which takes FOR UPDATE) waits for
        // in-flight votes to commit, and a vote that raced a committed close fails with 40001 and retries into
        // "closed". So no ballot can be committed after the close transaction has counted receipts/ballots.
        const camp = (await c.query(
          'SELECT id, status, opens_at, closes_at, eligibility FROM campaigns WHERE share_token = $1 FOR SHARE', [shareToken])).rows[0];
        if (!camp) throw notFound();
        campaignId = camp.id;
        await testHooks.afterCampaignRead?.();
        const now = new Date();

        if (shouldAutoClose(camp, now)) return { kind: 'close_due' } as Outcome;   // closed in its own transaction below
        if (camp.status === 'closed') return { kind: 'closed' } as Outcome;
        if (!isVotingWindowOpen(camp, now)) return { kind: 'not_open' } as Outcome;

        if (camp.eligibility === 'list') {
          const e = await c.query('SELECT 1 FROM eligible_voters WHERE campaign_id = $1 AND voter_email = $2', [camp.id, voterEmail.toLowerCase()]);
          if (e.rowCount === 0) return { kind: 'not_eligible' } as Outcome;
        }

        if (camp.eligibility === 'umoja') {
          // Same check as the ballot page (services/umoja.ts), against users.employee_code set at login.
          const reason = await umojaReason(c, voterOid);
          if (reason !== 'member') { logNotMember(reason, camp.id, voterOid); return { kind: 'not_member' } as Outcome; }
        }

        // No SELECT on vote_receipts here on purpose: reading it would make every concurrent voter
        // conflict with every other under SERIALIZABLE (relation-level predicate locks on small tables).
        // The primary key is the authority; a duplicate surfaces as 23505 (or 40001 -> retry -> 23505).
        await c.query('INSERT INTO vote_receipts (campaign_id, voter_oid) VALUES ($1, $2)', [camp.id, voterOid]);

        const cand = await c.query('SELECT 1 FROM candidates WHERE id = $1 AND campaign_id = $2', [candidateId, camp.id]);
        if (cand.rowCount === 0) throw new HttpError(400, 'Candidate does not belong to this campaign', 'invalid_candidate');
        await c.query('INSERT INTO ballots (campaign_id, candidate_id) VALUES ($1, $2)', [camp.id, candidateId]);
        return { kind: 'recorded' } as Outcome;
      }, 'SERIALIZABLE');
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
    await refreshStatus(campaignId);               // atomic: status + receipts=ballots check + audit in one transaction
    throw new HttpError(409, 'Voting has closed', 'closed');
  }
  switch (outcome?.kind) {
    case 'recorded': return;
    case 'closed': throw new HttpError(409, 'Voting has closed', 'closed');
    case 'not_open': throw new HttpError(409, 'Voting is not open yet', 'not_open');
    case 'not_member': throw new HttpError(403, notMemberMessage, 'not_member');
    case 'not_eligible': throw new HttpError(403, 'You are not eligible to vote in this campaign', 'not_eligible');
    default: throw new HttpError(500, 'Internal server error');
  }
}
