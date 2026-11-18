// Pick range and region rule (domain/rules.ts): pure, so every case is tested without a database.
import { describe, expect, it } from 'vitest';
import { BallotRejected, chooseLabel, computeResult, picksRange, regionRuleText, requiredOutside, validateSelection, type RuleCandidate, type RulePosition } from '../../src/domain/rules.js';

const KH = 'region-khomas', ER = 'region-erongo', OH = 'region-ohangwena';
const cand = (id: string, regionId: string | null, extra: Partial<RuleCandidate> = {}): RuleCandidate => ({ id, name: id, regionId, regionName: regionId, isAbstain: false, withdrawn: false, ...extra });
const pos = (over: Partial<RulePosition> = {}): RulePosition => ({ id: 'p', title: 'Additional Members', seats: 4, minPicks: 4, maxPicks: 4, rules: {}, minCandidates: null, maxCandidates: null, ...over });
const rule = { minOutside: 2, regionId: KH, regionName: 'Khomas' };
const rejects = (fn: () => void) => { try { fn(); } catch (e) { if (e instanceof BallotRejected) return e; throw e; } throw new Error('expected the ballot to be rejected'); };

describe('labels', () => {
  it('exact, up to, and a range', () => {
    expect(chooseLabel(4, 4)).toBe('Choose 4');
    expect(chooseLabel(1, 4)).toBe('Choose up to 4');
    expect(chooseLabel(2, 4)).toBe('Choose 2 to 4');
    expect(chooseLabel(1, 1)).toBe('Choose 1');
  });
  it('the rule sentence is generated from the data', () => {
    expect(regionRuleText({ minOutside: 2, regionName: 'Khomas' })).toBe('At least 2 picks from outside Khomas');
    expect(regionRuleText({ minOutside: 1, regionName: 'Erongo' })).toBe('At least 1 pick from outside Erongo');
  });
  it('a position without a range behaves as before: min = max = seats', () => {
    expect(picksRange({ seats: 3 })).toEqual({ min: 3, max: 3 });
    expect(picksRange({ seats: 4, minPicks: 1, maxPicks: 4 })).toEqual({ min: 1, max: 4 });
  });
});

describe('the pick range', () => {
  const four = [cand('a', KH), cand('b', KH), cand('c', ER), cand('d', OH)];
  it('exact: only the exact number passes', () => {
    validateSelection(pos(), four);
    expect(rejects(() => validateSelection(pos(), four.slice(0, 3))).code).toBe('wrong_number');
    expect(rejects(() => validateSelection(pos(), [...four, cand('e', ER)])).message).toMatch(/exactly 4/);
  });
  it('up to 4: anywhere from one to four passes, none or five does not', () => {
    const p = pos({ minPicks: 1 });
    for (let n = 1; n <= 4; n++) validateSelection(p, four.slice(0, n));
    expect(rejects(() => validateSelection(p, [])).code).toBe('wrong_number');
    expect(rejects(() => validateSelection(p, [...four, cand('e', ER)])).message).toMatch(/up to 4/);
  });
  it('2 to 4: one pick is too few', () => {
    const p = pos({ minPicks: 2 });
    expect(rejects(() => validateSelection(p, four.slice(0, 1))).message).toMatch(/2 to 4/);
    validateSelection(p, four.slice(0, 2));
  });
});

describe('the region rule', () => {
  const p = pos({ regionRule: rule });
  it('passes with enough picks from outside the region', () => {
    validateSelection(p, [cand('a', KH), cand('b', KH), cand('c', ER), cand('d', OH)]);
    validateSelection(p, [cand('a', KH), cand('c', ER), cand('d', OH), cand('e', ER)]);
  });
  it('is refused with 409 and a clear message when too few are from outside', () => {
    const e = rejects(() => validateSelection(p, [cand('a', KH), cand('b', KH), cand('c', KH), cand('d', ER)]));
    expect(e).toMatchObject({ code: 'region_rule', status: 409 });
    expect(e.message).toContain('At least 2 picks from outside Khomas');
    expect(e.message).toContain('you chose 1');
  });
  it('a candidate with no region counts as outside nothing known: it is not "from Khomas"', () => {
    validateSelection(p, [cand('a', KH), cand('b', KH), cand('c', null), cand('d', null)]);
  });
  it('works with a range: up to 4, but at least 2 outside Khomas', () => {
    const r = pos({ minPicks: 1, regionRule: rule });
    validateSelection(r, [cand('a', ER), cand('b', OH)]);
    expect(rejects(() => validateSelection(r, [cand('a', KH), cand('b', ER)])).code).toBe('region_rule');
    expect(rejects(() => validateSelection(r, [cand('a', KH)])).code).toBe('region_rule');
  });
  it('abstain is still allowed, alone, even though it picks nobody from outside', () => {
    validateSelection(p, [cand('abs', null, { isAbstain: true })]);
    expect(rejects(() => validateSelection(p, [cand('abs', null, { isAbstain: true }), cand('a', ER)])).code).toBe('abstain_mixed');
  });
  it('never asks for more outside picks than there are candidates outside the region (candidates withdrew)', () => {
    expect(requiredOutside({ ...rule, outsideAvailable: 1 })).toBe(1);
    expect(requiredOutside({ ...rule, outsideAvailable: 5 })).toBe(2);
    expect(requiredOutside(rule)).toBe(2);
    validateSelection(pos({ regionRule: { ...rule, outsideAvailable: 1 } }), [cand('a', KH), cand('b', KH), cand('c', KH), cand('d', ER)]);
  });
});

describe('winners are not touched by the voting rules', () => {
  it('computeResult ignores picks and the region rule: the top `seats` win', () => {
    const t = [{ id: 'a', name: 'a', votes: 9, isAbstain: false, withdrawn: false }, { id: 'b', name: 'b', votes: 8, isAbstain: false, withdrawn: false }, { id: 'c', name: 'c', votes: 7, isAbstain: false, withdrawn: false }];
    const base = computeResult(pos({ seats: 2 }), t as never);
    const ruled = computeResult(pos({ seats: 2, minPicks: 1, maxPicks: 4, regionRule: rule }), t as never);
    expect(ruled).toEqual(base);
    expect(base.winners.map((w) => w.id)).toEqual(['a', 'b']);
  });
});
