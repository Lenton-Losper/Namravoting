import { describe, expect, it } from 'vitest';
import { safeNext } from '../../../client/src/safeNext.js';

describe('safeNext (post-login redirect)', () => {
  const token = 'A'.repeat(32);
  it('accepts relative ballot, My votes and admin paths', () => {
    expect(safeNext(`/v/${token}`)).toBe(`/v/${token}`);
    expect(safeNext('/votes')).toBe('/votes');
    expect(safeNext('/admin')).toBe('/admin');
    expect(safeNext('/admin/c/123?tab=results')).toBe('/admin/c/123?tab=results');
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
