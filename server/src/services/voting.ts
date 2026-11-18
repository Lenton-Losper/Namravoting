import crypto from 'node:crypto';
import { DEADLOCK, getPool, SERIALIZATION_FAILURE, UNIQUE_VIOLATION, withTx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { isVotingWindowOpen, shouldAutoClose } from '../domain/status.js';
import { refreshStatus } from './campaigns.js';
import { restampAfterVote } from './tallies.js';
import { logNotMember, umojaStanding } from './umoja.js';
import { isListed } from './listed.js';
import { BallotRejected, validateBallot, validateSelection } from '../domain/rules.js';

/** Test seam: lets a test force a specific interleaving (e.g. a close landing right after the status read). Empty in production. */
export const testHooks: { afterCampaignRead?: () => Promise<void> } = {};

export const notMemberMessage = 'This vote is for Umoja members only';

/** 32 symbols: the digits 2-9 and the letters A-Z without I and O (no 0/O or 1/I mix-ups). 32 is a power of two, so a random byte maps onto it without bias. */
export const RECEIPT_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/**
 * A receipt code such as UV-7K3M-Q9TD, from crypto randomness ONLY: nothing about the vote (candidate, position, time, voter) goes in,
 * so it can never be traced back to a choice. It is stored on the receipt row (which has no candidate) and never logged or audited.
 * 8 symbols from 32: about 1.1 x 10^12 codes. Matches the CHECK on vote_receipts.receipt_code (migration 020).
 */
export function newReceiptCode(): string {
  const b = crypto.randomBytes(8);
  const out = Array.from(b, (x) => RECEIPT_ALPHABET[x & 31]);   // 256 / 32 = 8 whole turns: every symbol is equally likely
  return `UV-${out.slice(0, 4).join('')}-${out.slice(4).join('')}`;
}

type Outcome = { kind: 'recorded' } | { kind: 'closed' } | { kind: 'close_due' } | { kind: 'not_open' } | { kind: 'not_eligible' } | { kind: 'not_member' };

/**
 * Casts a ballot. One transaction (READ COMMITTED; the locks below do the ordering):
 *   lock the campaign row FOR SHARE -> re-check open + eligible -> check the selection (exactly `seats` candidates) -> INSERT receipt (one per
 *   MEMBER and POSITION, SEC-03) -> votes = votes + 1 on each picked candidate's tally row (a candidate of another campaign matches no row and rolls the receipt back) -> COMMIT.
 * A close or reset takes FOR UPDATE on the same campaign row, so it waits for votes in flight and a vote that arrives after it
 * sees the new state. Any failure rolls everything back. Deadlocks are retried up to 3 times.
 *
 * SECRECY (SEC-02): no row is written per vote, only a counter is incremented. This function never logs, audits or returns
 * the candidate id. After the commit all tally rows are re-stamped (services/tallies.ts) so their hidden xmin does not
 * match the voter's receipt.
 */
export async function castVote(voterOid: string, voterEmail: string, shareToken: string, candidate: string | string[], positionId?: string): Promise<{ receiptCode: string }> {
  const picks = Array.isArray(candidate) ? candidate : [candidate];
  let outcome: Outcome | undefined;
  let receiptCode = '';
  let campaignId: string | undefined;
  let votedPosition: string | undefined;

  for (let attempt = 1; attempt <= 3; attempt++) {
    receiptCode = newReceiptCode();   // a fresh code per attempt
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
          if (!(await isListed(c, camp.id, voterOid, voterEmail))) return { kind: 'not_eligible' } as Outcome;
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

        // The candidates decide the position (a candidate belongs to exactly one). A candidate with no counter row is not on this ballot:
        // another campaign's, not approved, or unknown. Every pick must be on the SAME position (and the one named, if one was named).
        if (new Set(picks).size !== picks.length) throw new HttpError(400, 'Each candidate can be chosen only once', 'duplicate_candidate');
        const rows = (await c.query(
          `SELECT t.position_id, t.candidate_id, k.name, k.is_abstain, (k.withdrawn_at IS NOT NULL) AS withdrawn, k.region_id, r.name AS region_name,
                  p.title, p.seats, p.rules, p.min_candidates, p.max_candidates
             FROM tallies t JOIN candidates k ON k.id = t.candidate_id AND k.campaign_id = t.campaign_id
             JOIN positions p ON p.id = t.position_id LEFT JOIN regions r ON r.id = k.region_id
            WHERE t.campaign_id = $1 AND t.candidate_id = ANY($2::uuid[])`, [camp.id, picks])).rows;
        const first = rows[0];
        if (!first || rows.length !== picks.length || rows.some((x) => x.position_id !== first.position_id) || (positionId && positionId !== first.position_id)) {
          throw new HttpError(400, 'Candidate does not belong to this position', 'invalid_candidate');
        }
        votedPosition = first.position_id;
        const rulePos = { id: first.position_id, title: first.title, seats: first.seats, rules: first.rules, minCandidates: first.min_candidates, maxCandidates: first.max_candidates };
        const ruleCands = picks.map((id) => {
          const x = rows.find((y) => y.candidate_id === id)!;
          return { id, name: x.name, regionId: x.region_id, regionName: x.region_name, isAbstain: x.is_abstain, withdrawn: x.withdrawn };
        });

        // Election rules (domain/rules.ts), judged BEFORE anything is written: exactly `seats` candidates, or Abstain alone; no repeats; nobody
        // withdrawn. A withdrawn candidate cannot be chosen: the campaign row is held FOR SHARE and a withdrawal takes it FOR UPDATE, so this
        // check cannot race with one. Throwing rolls everything back.
        try {
          validateSelection(rulePos, ruleCands);
          for (const rc of ruleCands) validateBallot(rulePos, { key: memberKey, oid: voterOid }, rc);
        } catch (e) {
          if (e instanceof BallotRejected) throw new HttpError(e.status, e.message, e.code);
          throw e;
        }

        // The primary key (account) and the unique (campaign, position, member) constraint are the authority for "one vote per position": a
        // duplicate surfaces as 23505, whether it is the same account twice or a second account of the same member. ONE receipt covers the
        // whole selection. The receipt code goes on the receipt row only. NEVER log it (this function logs nothing about a vote).
        await c.query('INSERT INTO vote_receipts (campaign_id, position_id, voter_oid, member_key, receipt_code) VALUES ($1, $2, $3, $4, $5)', [camp.id, first.position_id, voterOid, memberKey, receiptCode]);

        // One vote for each pick. An Abstain ballot abstains from EVERY seat, so it adds `seats` to the Abstain line: that keeps "counters = receipts
        // x seats" exact for the integrity check, whatever was chosen. (The tally guard allows +1 per statement, hence one statement per vote.)
        for (const rc of ruleCands) {
          for (let i = 0; i < (rc.isAbstain ? rulePos.seats : 1); i++) {
            const t = await c.query('UPDATE tallies SET votes = votes + 1 WHERE campaign_id = $1 AND candidate_id = $2', [camp.id, rc.id]);
            if (t.rowCount === 0) throw new HttpError(400, 'Candidate does not belong to this campaign', 'invalid_candidate');
          }
        }
        return { kind: 'recorded' } as Outcome;
      });
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      // A clash on the random receipt code (about 1 in 10^12 per vote): try again with a new code. Any other duplicate is a second vote.
      if (code === UNIQUE_VIOLATION && (e as { constraint?: string }).constraint === 'vote_receipts_receipt_code_key' && attempt < 3) continue;
      if (code === UNIQUE_VIOLATION) throw new HttpError(409, 'You have already voted', 'already_voted');
      if (code === SERIALIZATION_FAILURE || code === DEADLOCK) {
        if (attempt < 3) { await new Promise((r) => setTimeout(r, 10 * attempt + Math.random() * 20)); continue; }
        // Out of retries. If our own receipt exists (a concurrent duplicate won), that is "already voted".
        if (campaignId) {
          const r = await getPool().query('SELECT 1 FROM vote_receipts WHERE campaign_id = $1 AND voter_oid = $2 AND ($3::uuid IS NULL OR position_id = $3)', [campaignId, voterOid, votedPosition ?? null]);
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
    case 'recorded': await restampAfterVote(campaignId!); return { receiptCode };
    case 'closed': throw new HttpError(409, 'Voting has closed', 'closed');
    case 'not_open': throw new HttpError(409, 'Voting is not open yet', 'not_open');
    case 'not_member': throw new HttpError(403, notMemberMessage, 'not_member');
    case 'not_eligible': throw new HttpError(403, 'You are not eligible to vote in this campaign', 'not_eligible');
    default: throw new HttpError(500, 'Internal server error');
  }
}
