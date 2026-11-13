import { standing, type Counted } from './results.js';

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
  void position;
  const s = standing(tallies);
  return { winners: s.leader ? [s.leader] : [], tied: s.tied };
}
