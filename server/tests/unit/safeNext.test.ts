import { describe, expect, it } from 'vitest';
import { landingFor, safeNext } from '../../../client/src/safeNext.js';

describe('safeNext (post-login redirect)', () => {
  const token = 'A'.repeat(32);
  it('accepts relative ballot, My votes and admin paths', () => {
    expect(safeNext(`/v/${token}`)).toBe(`/v/${token}`);
    expect(safeNext('/votes')).toBe('/votes');
    expect(safeNext('/admin')).toBe('/admin');
    expect(safeNext('/admin/c/123?tab=results')).toBe('/admin/c/123?tab=results');
  });

  it('accepts a nomination link (/n/<token>) and the observer pages', () => {
    expect(safeNext(`/n/${token}`)).toBe(`/n/${token}`);
    expect(safeNext('/observe')).toBe('/observe');
    expect(safeNext('/observe/abc')).toBe('/observe/abc');
  });

  it.each([
    ['absolute URL', 'https://evil.com'],
    ['absolute URL with allowed-looking path', 'https://evil.com/v/abc'],
    ['protocol-relative', '//evil.com'],
    ['protocol-relative with path', '//evil.com/v/abc'],
    ['backslash trick', '/\\evil.com'],
    ['backslash inside allowed prefix', '/v/\\evil.com'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['encoded javascript scheme', 'JaVaScRiPt:alert(1)'],
    ['data scheme', 'data:text/html,<script>1</script>'],
    ['not an allowed prefix', '/login'],
    ['look-alike prefix', '/votesevil'],
    ['look-alike admin prefix', '/administrator'],
    ['look-alike nomination prefix', '/nominate-evil'],
    ['nomination path without the slash', '/n'],
    ['backslash inside the nomination prefix', '/n/\\evil.com'],
    ['protocol-relative nomination look-alike', '//n/abc'],
    ['no leading slash', 'v/abc'],
    ['tab inside', '/v/\tabc'],
    ['newline inside', '/v/abc\n//evil.com'],
    ['space-led', ' /v/abc'],
    ['empty', ''],
  ])('rejects %s', (_name, input) => {
    expect(safeNext(input)).toBeNull();
  });

  it('rejects null, undefined and oversized input', () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext('/v/' + 'a'.repeat(600))).toBeNull();
  });
});

describe('landingFor (where a person goes right after signing in)', () => {
  const t = 'B'.repeat(32);
  it.each([
    // next,                       admin lands on,      non-admin lands on
    [`/v/${t}`,                     `/v/${t}`,           `/v/${t}`],
    [`/n/${t}`,                     `/n/${t}`,           `/n/${t}`],
    ['/votes',                      '/votes',            '/votes'],
    ['/observe/abc',                '/observe/abc',      '/observe/abc'],
    ['/admin',                      '/admin',            '/votes'],
    ['/admin/c/abc?tab=results',    '/admin/c/abc?tab=results', '/votes'],
    [null,                          '/admin',            '/votes'],
    ['https://evil.com/n/x',        '/admin',            '/votes'],
    ['/login',                      '/admin',            '/votes'],
  ])('next=%s -> admin %s, non-admin %s', (next, admin, staff) => {
    expect(landingFor(next, true)).toBe(admin);
    expect(landingFor(next, false)).toBe(staff);
  });
});
