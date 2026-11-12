import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { signingKey, verifyKeys } from '../../src/auth/keys.js';
import { sign, signValue, verify, verifyValue } from '../../src/auth/signing.js';

const A = 'a'.repeat(40); const B = 'b'.repeat(40); const C = 'c'.repeat(40);
const cfg = (extra: Record<string, string> = {}) => parseConfig({ NODE_ENV: 'test', AUTH_MODE: 'dev', ALLOW_DEV_AUTH: 'true', SESSION_SECRET: A, DATABASE_URL: 'postgres://x@localhost/x', ...extra } as NodeJS.ProcessEnv);

describe('SEC-06: one key per purpose, derived from the secrets', () => {
  it('session, sign-in-flow and CSRF keys differ, so a value signed for one purpose never verifies as another', () => {
    const c = cfg();
    const keys = (['session', 'authflow', 'csrf'] as const).map((p) => signingKey(c, p).toString('hex'));
    expect(new Set(keys).size).toBe(3);
    const token = sign(signingKey(c, 'authflow'), { s: 'state', exp: 1 });
    expect(verify(verifyKeys(c, 'authflow'), token)).toMatchObject({ s: 'state' });
    expect(verify(verifyKeys(c, 'session'), token)).toBeNull();           // SEC-12: a flow cookie is not a session
    expect(verify(verifyKeys(c, 'csrf'), token)).toBeNull();
    expect(verify(A, token)).toBeNull();                                  // the raw secret is not a signing key
  });

  it('CSRF_SECRET rotates the CSRF key on its own and leaves the session and flow keys alone', () => {
    const before = cfg(); const after = cfg({ CSRF_SECRET: C });
    expect(signingKey(after, 'csrf').toString('hex')).not.toBe(signingKey(before, 'csrf').toString('hex'));
    expect(signingKey(after, 'session').toString('hex')).toBe(signingKey(before, 'session').toString('hex'));
    expect(signingKey(after, 'authflow').toString('hex')).toBe(signingKey(before, 'authflow').toString('hex'));
  });

  it('SESSION_SECRET_PREVIOUS is accepted for verification only, so a rotation does not sign everyone out at once', () => {
    const oldCfg = cfg(); const newCfg = cfg({ SESSION_SECRET: B, SESSION_SECRET_PREVIOUS: A });
    const cookie = signValue(signingKey(oldCfg, 'session'), 'session-id-123');
    expect(verifyValue(verifyKeys(newCfg, 'session'), cookie)).toBe('session-id-123');             // old cookie still good
    const fresh = signValue(signingKey(newCfg, 'session'), 'session-id-456');
    expect(verifyValue(verifyKeys(oldCfg, 'session'), fresh)).toBeNull();                          // new cookies use the new key
    expect(verifyValue(verifyKeys(cfg({ SESSION_SECRET: B }), 'session'), cookie)).toBeNull();     // without PREVIOUS the old one is dead
  });

  it('a too-short rotation secret refuses to start', () => {
    expect(() => cfg({ SESSION_SECRET_PREVIOUS: 'short' })).toThrow(/SESSION_SECRET_PREVIOUS/);
    expect(() => cfg({ CSRF_SECRET: 'short' })).toThrow(/CSRF_SECRET/);
  });
});
