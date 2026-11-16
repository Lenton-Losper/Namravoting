// The pure choose-N rules: what a voter may pick in a position with `seats` seats, and who wins several seats.
import { describe, expect, it } from 'vitest';
import { BallotRejected, computeResult, validateSelection, type RuleCandidate, type RulePosition } from '../../src/domain/rules.js';

const pos = (seats: number): RulePosition => ({ id: 'p', title: 'Additional Members', seats, rules: {}, minCandidates: null, maxCandidates: null });
const cand = (id: string, extra: Partial<RuleCandidate> = {}): RuleCandidate => ({ id, name: id, regionId: null, regionName: null, isAbstain: false, withdrawn: false, ...extra });
const refusal = (fn: () => void) => { try { fn(); } catch (e) { if (e instanceof BallotRejected) return `${e.status} ${e.code}`; throw e; } return 'accepted'; };

describe('validateSelection', () => {
  it('needs exactly `seats` candidates', () => {
    expect(refusal(() => validateSelection(pos(2), [cand('a')]))).toBe('400 wrong_number');
    expect(refusal(() => validateSelection(pos(2), [cand('a'), cand('b'), cand('c')]))).toBe('400 wrong_number');
    expect(refusal(() => validateSelection(pos(2), [cand('a'), cand('b')]))).toBe('accepted');
    expect(refusal(() => validateSelection(pos(1), [cand('a'), cand('b')]))).toBe('400 wrong_number');
    expect(refusal(() => validateSelection(pos(1), [cand('a')]))).toBe('accepted');
    expect(refusal(() => validateSelection(pos(1), []))).toBe('400 wrong_number');
  });
  it('refuses the same candidate twice, even when that makes the right count', () => {
    expect(refusal(() => validateSelection(pos(2), [cand('a'), cand('a')]))).toBe('400 duplicate_candidate');
  });
  it('Abstain stands alone and is not one of the seats', () => {
    expect(refusal(() => validateSelection(pos(2), [cand('x', { isAbstain: true })]))).toBe('accepted');
    expect(refusal(() => validateSelection(pos(1), [cand('x', { isAbstain: true })]))).toBe('accepted');
    expect(refusal(() => validateSelection(pos(2), [cand('a'), cand('x', { isAbstain: true })]))).toBe('400 abstain_mixed');
    expect(refusal(() => validateSelection(pos(3), [cand('a'), cand('b'), cand('x', { isAbstain: true })]))).toBe('400 abstain_mixed');
  });
});

describe('computeResult with several seats', () => {
  const t = (...v: [string, number, Partial<{ is_abstain: boolean; withdrawn: boolean }>?][]) => v.map(([id, votes, x]) => ({ id, name: id, votes, ...(x ?? {}) }));
  const names = (r: { winners: { id: string }[]; tied: { id: string }[] }) => ({ w: r.winners.map((x) => x.id), t: r.tied.map((x) => x.id) });

  it('the top `seats` win', () => {
    expect(names(computeResult(pos(2), t(['a', 5], ['b', 3], ['c', 1], ['d', 0])))).toEqual({ w: ['a', 'b'], t: [] });
  });
  it('a level last seat is nobody\'s: those candidates are reported as tied, the clear winners still win', () => {
    expect(names(computeResult(pos(2), t(['a', 5], ['b', 3], ['c', 3], ['d', 1])))).toEqual({ w: ['a'], t: ['b', 'c'] });
  });
  it('candidates level but all of them fit: they all win', () => {
    expect(names(computeResult(pos(3), t(['a', 5], ['b', 3], ['c', 3], ['d', 1])))).toEqual({ w: ['a', 'b', 'c'], t: [] });
  });
  it('fewer candidates with votes than seats: only those with votes win', () => {
    expect(names(computeResult(pos(3), t(['a', 2], ['b', 0], ['c', 0])))).toEqual({ w: ['a'], t: [] });
    expect(names(computeResult(pos(2), t(['a', 0], ['b', 0])))).toEqual({ w: [], t: [] });
  });
  it('Abstain and withdrawn candidates never win or tie', () => {
    expect(names(computeResult(pos(2), t(['x', 9, { is_abstain: true }], ['w', 8, { withdrawn: true }], ['a', 2], ['b', 1], ['c', 1])))).toEqual({ w: ['a'], t: ['b', 'c'] });
  });
  it('one seat is the same plurality rule as before', () => {
    expect(names(computeResult(pos(1), t(['a', 4], ['b', 2])))).toEqual({ w: ['a'], t: [] });
    expect(names(computeResult(pos(1), t(['a', 4], ['b', 4])))).toEqual({ w: [], t: ['a', 'b'] });
  });
});
