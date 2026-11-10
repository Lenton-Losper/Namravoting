export type Status = 'draft' | 'open' | 'closed';
export type VoterState = 'can_vote' | 'already_voted' | 'not_eligible' | 'not_open' | 'closed';

export interface CampaignTimes { status: Status; opens_at: Date | null; closes_at: Date | null }

const allowed: Record<Status, Status[]> = { draft: ['open'], open: ['closed'], closed: [] };
export const canTransition = (from: Status, to: Status): boolean => allowed[from].includes(to);

/** Lazy auto-close: an open campaign whose closes_at has passed is closed. (No cron needed.) */
export function shouldAutoClose(c: CampaignTimes, now: Date): boolean {
  return c.status === 'open' && c.closes_at !== null && c.closes_at.getTime() <= now.getTime();
}

/** Whether ballots may be cast right now (status open AND inside the optional window). */
export function isVotingWindowOpen(c: CampaignTimes, now: Date): boolean {
  if (c.status !== 'open') return false;
  if (c.opens_at && now.getTime() < c.opens_at.getTime()) return false;
  if (c.closes_at && now.getTime() >= c.closes_at.getTime()) return false;
  return true;
}

export function voterState(
  c: CampaignTimes, now: Date, opts: { eligible: boolean; hasVoted: boolean },
): VoterState {
  if (c.status === 'closed' || shouldAutoClose(c, now)) return 'closed';
  if (!opts.eligible) return 'not_eligible';
  if (opts.hasVoted) return 'already_voted';
  return isVotingWindowOpen(c, now) ? 'can_vote' : 'not_open';
}
