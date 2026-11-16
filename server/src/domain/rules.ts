import { isContender, standing, type Counted } from './results.js';

/**
 * ELECTION RULES: the two places where rules plug in (see docs/rules-hooks.md).
 *
 * Today every position is a plain "one vote, most votes wins" plurality contest. Rules that come later (region quotas, several seats,
 * "must vote in every position", ...) belong HERE and nowhere else: the vote transaction calls validateBallot(), and the results page,
 * the exports and the seal all call computeResult(). Nothing else in the code decides who may be chosen or who has won.
 *
 * Both are pure (no database, no clock) so a rule can be tested on its own. The per-position `rules` JSON column is passed through
 * untouched: a rule reads its settings from `position.rules`.
 */

export interface RulePosition {
  id: string; title: string; seats: number; rules: Record<string, unknown>;
  minCandidates: number | null; maxCandidates: number | null;
}
/** Who is voting. Used only to decide whether the ballot is allowed: it is never stored next to a candidate. */
export interface RuleMember { key: string; oid: string }
export interface RuleCandidate { id: string; name: string; regionId: string | null; regionName: string | null; isAbstain: boolean; withdrawn: boolean }

/** Thrown by validateBallot to refuse a ballot. `code` is returned to the voter. */
export class BallotRejected extends Error {
  constructor(message: string, public code = 'ballot_rejected', public status = 409) { super(message); }
}

/**
 * Called inside the vote transaction (after eligibility and "one vote per position" are enforced by the database, before the counter
 * is incremented). Throw BallotRejected to refuse; returning normally accepts. Default: every approved, non-withdrawn candidate of the
 * position may be chosen, and an Abstain line is always allowed.
 */
export function validateBallot(position: RulePosition, member: RuleMember, candidate: RuleCandidate): void {
  void position; void member;
  if (candidate.withdrawn) throw new BallotRejected('This candidate has withdrawn. Please choose someone else.', 'candidate_withdrawn');
}

/**
 * The whole selection one voter makes in one position (several candidates when the position has several seats). Pure, so the rule is
 * tested without a database; the vote transaction calls it BEFORE anything is written, and the database does the rest (one receipt per
 * voter and position). The rule is "exactly `seats` candidates, no repeats, all in this position", or the Abstain line on its own.
 * Abstain is never counted as one of the seats and cannot be mixed with candidates.
 */
export function validateSelection(position: RulePosition, picks: RuleCandidate[]): void {
  if (picks.length === 0) throw new BallotRejected('Choose a candidate', 'wrong_number', 400);
  if (new Set(picks.map((p) => p.id)).size !== picks.length) throw new BallotRejected('Each candidate can be chosen only once', 'duplicate_candidate', 400);
  const abstain = picks.filter((p) => p.isAbstain);
  if (abstain.length) {
    if (picks.length > 1) throw new BallotRejected('Abstain cannot be combined with candidates', 'abstain_mixed', 400);
    return;
  }
  if (picks.length !== position.seats) {
    throw new BallotRejected(position.seats === 1 ? 'Choose one candidate' : `Choose exactly ${position.seats} candidates (you chose ${picks.length})`, 'wrong_number', 400);
  }
}

export interface PositionOutcome {
  /** The winner(s): one with the default plurality rule, up to `seats` with a rule that uses seats. Empty when nobody has votes. */
  winners: Counted[];
  /** Candidates sharing first place (2 or more) when the result is a tie: a tie has no winner. */
  tied: Counted[];
}

/**
 * Turns the final counters of one position into an outcome. Default: plurality, one seat. Abstain lines and withdrawn candidates can
 * neither win nor tie (domain/results.ts).
 */
export function computeResult(position: RulePosition, tallies: Counted[]): PositionOutcome {
  if (position.seats <= 1) {
    const s = standing(tallies);
    return { winners: s.leader ? [s.leader] : [], tied: s.tied };
  }
  // Several seats: the `seats` contenders with the most votes. If the last seat is shared by candidates who have the same number of
  // votes and not all of them fit, nobody is given that seat: those candidates are reported as `tied` for an admin to settle (a run-off).
  const live = tallies.filter(isContender).filter((c) => c.votes > 0).sort((a, b) => b.votes - a.votes);
  if (live.length <= position.seats) return { winners: live, tied: [] };
  const cut = live[position.seats - 1].votes;
  const above = live.filter((c) => c.votes > cut), at = live.filter((c) => c.votes === cut);
  return above.length + at.length <= position.seats ? { winners: [...above, ...at], tied: [] } : { winners: above, tied: at };
}
