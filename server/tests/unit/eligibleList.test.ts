import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkEmailList, eligibleListHash, NAMRA_DOMAIN } from '../../src/domain/eligibility.js';
import { pickEmail } from '../../src/auth/entra.js';

describe('checkEmailList: report, never reject', () => {
  it('keeps the valid addresses (lower-cased, once), names the invalid entries, flags the ones outside @namra.org.na', () => {
    const r = checkEmailList([' Amy@NamRA.org.na ', 'amy@namra.org.na', 'typo', 'a@b', 'guest@gmail.com', '', 'x@sub.namra.org.na', 'typo']);
    expect(r.emails).toEqual(['amy@namra.org.na', 'guest@gmail.com', 'x@sub.namra.org.na']);
    expect(r.invalid).toEqual(['typo', 'a@b']);                                  // each named once, in the order met
    expect(r.notNamra).toEqual(['guest@gmail.com', 'x@sub.namra.org.na']);       // a sub-domain is not the NamRA domain
    expect(NAMRA_DOMAIN).toBe('namra.org.na');
  });
  it('a list of only bad entries has no valid address', () => {
    expect(checkEmailList(['nope', 'x y@z.com']).emails).toEqual([]);
  });
  it('an address longer than 254 characters is invalid', () => {
    expect(checkEmailList([`${'a'.repeat(250)}@x.org`]).invalid).toHaveLength(1);
  });
});

describe('eligibleListHash', () => {
  it('is the SHA-256 of the lower-case addresses, sorted, joined by line feeds, duplicates once', () => {
    const want = crypto.createHash('sha256').update('a@x.org\nb@x.org', 'utf8').digest('hex');
    expect(eligibleListHash(['b@x.org', 'A@x.org', 'a@x.org'])).toBe(want);
  });
  it('does not depend on the order, and changes when anyone is added or removed', () => {
    const base = eligibleListHash(['a@x.org', 'b@x.org']);
    expect(eligibleListHash(['b@x.org', 'a@x.org'])).toBe(base);
    expect(eligibleListHash(['a@x.org', 'b@x.org', 'c@x.org'])).not.toBe(base);
    expect(eligibleListHash(['a@x.org'])).not.toBe(base);
  });
  it('the empty list has a hash too (the SHA-256 of nothing)', () => {
    expect(eligibleListHash([])).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('pickEmail: the mail claim first, the sign-in name last', () => {
  it('prefers email, then mail, then preferred_username', () => {
    expect(pickEmail({ email: 'A@x.org', mail: 'b@x.org', preferred_username: 'c@x.org' })).toEqual({ email: 'a@x.org', source: 'email' });
    expect(pickEmail({ mail: ' B@x.org ', preferred_username: 'c@x.org' })).toEqual({ email: 'b@x.org', source: 'mail' });
    expect(pickEmail({ preferred_username: 'C@x.org' })).toEqual({ email: 'c@x.org', source: 'preferred_username' });
  });
  it('skips a claim that is not an address, and returns null when there is none', () => {
    expect(pickEmail({ email: 'nope', mail: 42, preferred_username: 'c@x.org' })).toEqual({ email: 'c@x.org', source: 'preferred_username' });
    expect(pickEmail({ email: 'nope', preferred_username: 'also-nope' })).toBeNull();
    expect(pickEmail({})).toBeNull();
  });
});
