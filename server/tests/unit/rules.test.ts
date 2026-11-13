// The two rule hooks (domain/rules.ts): today's plurality default.
import { describe, expect, it } from 'vitest';
import { BallotRejected, computeResult, validateBallot, type RuleCandidate, type RulePosition } from '../../src/domain/rules.js';

const position: RulePosition = { id: 'p', title: 'Press Secretary', seats: 1, rules: {}, minCandidates: null, maxCandidates: null };
const member = { key: 'code:NAM0101', oid: 'o' };
const cand = (over: Partial<RuleCandidate> = {}): RuleCandidate => ({ id: 'c', name: 'A', regionId: null, regionName: null, isAbstain: false, withdrawn: false, ...over });
const t = (id: string, votes: number, extra: Record<string, unknown> = {}) => ({ id, name: id, votes, ...extra });

describe('validateBallot (default)', () => {
  it('accepts an ordinary candidate and an abstain line', () => {
    expect(() => validateBallot(position, member, cand())).not.toThrow();
    expect(() => validateBallot(position, member, cand({ isAbstain: true }))).not.toThrow();
  });
  it('refuses a withdrawn candidate with a code the voter gets', () => {
    try { validateBallot(position, member, cand({ withdrawn: true })); expect.unreachable(); } catch (e) {
      expect(e).toBeInstanceOf(BallotRejected);
      expect((e as BallotRejected).code).toBe('candidate_withdrawn');
      expect((e as BallotRejected).status).toBe(409);
    }
  });
});

describe('computeResult (default: plurality, one seat)', () => {
  it('one winner when one candidate has the most votes', () => {
    const r = computeResult(position, [t('a', 5), t('b', 3), t('c', 0)]);
    expect(r.winners.map((w) => w.id)).toEqual(['a']);
    expect(r.tied).toEqual([]);
  });
  it('a tie for first place has no winner', () => {
    const r = computeResult(position, [t('a', 4), t('b', 4), t('c', 1)]);
    expect(r.winners).toEqual([]);
    expect(r.tied.map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('nobody has won when nobody has votes', () => {
    expect(computeResult(position, [t('a', 0), t('b', 0)])).toEqual({ winners: [], tied: [] });
  });
  it('abstentions and withdrawn candidates can neither win nor tie', () => {
    const r = computeResult(position, [t('abstain', 9, { is_abstain: true }), t('gone', 7, { withdrawn: true }), t('a', 2), t('b', 1)]);
    expect(r.winners.map((w) => w.id)).toEqual(['a']);
    const tie = computeResult(position, [t('abstain', 3, { is_abstain: true }), t('a', 2), t('b', 2)]);
    expect(tie.tied.map((x) => x.id)).toEqual(['a', 'b']);
  });
});
