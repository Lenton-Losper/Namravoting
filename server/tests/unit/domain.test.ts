import { describe, expect, it } from 'vitest';
import { canTransition, isVotingWindowOpen, shouldAutoClose, voterState } from '../../src/domain/status.js';
import { isEligible, parseEmailList } from '../../src/domain/eligibility.js';
import { createCampaignBody, eligibleBody, candidateBody, voteBody } from '../../src/domain/validation.js';
import { parseConfig } from '../../src/config.js';

const t = (s: string) => new Date(s);
const base = { opens_at: null, closes_at: null };

describe('status transitions', () => {
  it('allows only draft->open and open->closed', () => {
    expect(canTransition('draft', 'open')).toBe(true);
    expect(canTransition('open', 'closed')).toBe(true);
    for (const [a, b] of [['draft', 'closed'], ['open', 'draft'], ['closed', 'open'], ['closed', 'draft'], ['draft', 'draft']] as const)
      expect(canTransition(a, b)).toBe(false);
  });
  it('auto-closes only open campaigns past closes_at', () => {
    const now = t('2026-01-02T00:00:00Z');
    expect(shouldAutoClose({ status: 'open', opens_at: null, closes_at: t('2026-01-01T00:00:00Z') }, now)).toBe(true);
    expect(shouldAutoClose({ status: 'open', opens_at: null, closes_at: t('2026-01-03T00:00:00Z') }, now)).toBe(false);
    expect(shouldAutoClose({ status: 'draft', opens_at: null, closes_at: t('2026-01-01T00:00:00Z') }, now)).toBe(false);
    expect(shouldAutoClose({ status: 'open', ...base }, now)).toBe(false);
  });
  it('respects the voting window', () => {
    const c = { status: 'open' as const, opens_at: t('2026-01-01T10:00:00Z'), closes_at: t('2026-01-01T12:00:00Z') };
    expect(isVotingWindowOpen(c, t('2026-01-01T09:59:59Z'))).toBe(false);
    expect(isVotingWindowOpen(c, t('2026-01-01T11:00:00Z'))).toBe(true);
    expect(isVotingWindowOpen(c, t('2026-01-01T12:00:00Z'))).toBe(false);
  });
  it('derives voter state', () => {
    const now = t('2026-01-01T11:00:00Z');
    const open = { status: 'open' as const, ...base };
    expect(voterState(open, now, { eligible: true, hasVoted: false })).toBe('can_vote');
    expect(voterState(open, now, { eligible: true, hasVoted: true })).toBe('already_voted');
    expect(voterState(open, now, { eligible: false, hasVoted: false })).toBe('not_eligible');
    expect(voterState({ status: 'draft', ...base }, now, { eligible: true, hasVoted: false })).toBe('not_open');
    expect(voterState({ status: 'closed', ...base }, now, { eligible: true, hasVoted: true })).toBe('closed');
    expect(voterState({ status: 'open', opens_at: t('2026-02-01T00:00:00Z'), closes_at: null }, now, { eligible: true, hasVoted: false })).toBe('not_open');
    expect(voterState({ status: 'open', opens_at: null, closes_at: t('2026-01-01T10:00:00Z') }, now, { eligible: true, hasVoted: false })).toBe('closed');
  });
});

describe('eligibility', () => {
  it('"all" admits everyone; "list" is case-insensitive', () => {
    expect(isEligible({ eligibility: 'all' }, 'x@y.z', new Set())).toBe(true);
    expect(isEligible({ eligibility: 'list' }, 'A@Namra.test', new Set(['a@namra.test']))).toBe(true);
    expect(isEligible({ eligibility: 'list' }, 'b@namra.test', new Set(['a@namra.test']))).toBe(false);
  });
  it('parses pasted email lists', () => {
    const r = parseEmailList('A@x.com, b@x.com;\n a@x.com  not-an-email');
    expect(r.emails).toEqual(['a@x.com', 'b@x.com']);
    expect(r.invalid).toEqual(['not-an-email']);
  });
});

describe('validation', () => {
  it('rejects bad campaigns', () => {
    expect(createCampaignBody.safeParse({ title: '' }).success).toBe(false);
    expect(createCampaignBody.safeParse({ title: 'x', extra: 1 }).success).toBe(false);
    expect(createCampaignBody.safeParse({ title: 'x', opens_at: '2026-01-02T00:00:00Z', closes_at: '2026-01-01T00:00:00Z' }).success).toBe(false);
    expect(createCampaignBody.safeParse({ title: 'ok' }).success).toBe(true);
  });
  it('limits bio to 500 chars', () => {
    expect(candidateBody.safeParse({ name: 'a', bio: 'x'.repeat(501) }).success).toBe(false);
    expect(candidateBody.safeParse({ name: 'a', bio: 'x'.repeat(500) }).success).toBe(true);
  });
  it('validates eligibility and vote bodies', () => {
    expect(eligibleBody.safeParse({ mode: 'list', emails: [] }).success).toBe(false);
    expect(eligibleBody.safeParse({ mode: 'all' }).success).toBe(true);
    expect(voteBody.safeParse({ candidateId: 'nope' }).success).toBe(false);
  });
});

describe('config', () => {
  const ok = { SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://x' };
  it('refuses AUTH_MODE=dev in production', () => {
    expect(() => parseConfig({ ...ok, NODE_ENV: 'production', AUTH_MODE: 'dev' })).toThrow(/AUTH_MODE=dev/);
  });
  it('allows dev outside production and rejects short secrets', () => {
    expect(parseConfig({ ...ok, NODE_ENV: 'development', AUTH_MODE: 'dev' }).authMode).toBe('dev');
    expect(() => parseConfig({ ...ok, SESSION_SECRET: 'short' })).toThrow();
  });
});
