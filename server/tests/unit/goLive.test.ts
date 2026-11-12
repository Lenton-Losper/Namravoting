import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { describeSignInFailure } from '../../src/auth/entra.js';
import { adminNotices, operatorWarnings, secretDaysLeft } from '../../src/auth/notices.js';

const TENANT = 'fe7b029e-7e19-4525-bdf4-57462a59d299';
const CLIENT = '281ab38e-9ff5-4f17-88ea-18bdc3e65457';
const OID = '0f1d2c3b-4a59-4687-8795-a4b3c2d1e0f9';
const base = {
  AUTH_MODE: 'entra', NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://x@localhost/x', STORAGE: 'disk',
  ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT, ENTRA_CLIENT_SECRET: 's', ENTRA_REDIRECT_URI: 'https://app.test/auth/callback',
};
const cfg = (extra: Record<string, string> = {}) => parseConfig({ ...base, ...extra } as NodeJS.ProcessEnv);

describe('SEC-07: the demo membership override cannot ride into production by accident', () => {
  it('refuses to start in production with DEMO_MEMBER_EMAILS unless DEMO=true', () => {
    expect(() => cfg({ DEMO_MEMBER_EMAILS: 'a@namra.org.na' })).toThrow(/DEMO_MEMBER_EMAILS is set in production but DEMO=true is not/);
    expect(() => cfg({ DEMO_MEMBER_EMAILS: 'a@namra.org.na', DEMO: 'false' })).toThrow(/DEMO=true/);
    expect(cfg({ DEMO_MEMBER_EMAILS: 'a@namra.org.na', DEMO: 'true' }).entra!.demoMemberEmails).toEqual(['a@namra.org.na']);
  });
  it('control: production without the override starts, and development/test are not blocked', () => {
    expect(cfg().entra!.demoMemberEmails).toEqual([]);
    expect(cfg({ DEMO_MEMBER_EMAILS: 'a@namra.org.na', NODE_ENV: 'development' }).entra!.demoMemberEmails).toHaveLength(1);
  });
  it('the admin banner and the log say so whenever the override is active', () => {
    const c = cfg({ DEMO_MEMBER_EMAILS: 'a@namra.org.na', DEMO: 'true', ADMIN_OIDS: OID, ENTRA_SECRET_EXPIRES_AT: '2099-01-01' });
    expect(adminNotices(c)).toEqual([{ kind: 'demo_override' }]);
    expect(operatorWarnings(c).map((w) => w.line).join('\n')).toMatch(/DEMO_MEMBER_EMAILS is active/);
    expect(adminNotices(cfg({ ADMIN_OIDS: OID, ENTRA_SECRET_EXPIRES_AT: '2099-01-01' }))).toEqual([]);
  });
});

describe('SEC-11: admins by account id, email only as a fallback', () => {
  it('ADMIN_OIDS is validated and, when set, switches email matching off unless ADMIN_EMAILS_FALLBACK=true', () => {
    expect(() => cfg({ ADMIN_OIDS: 'not-a-guid' })).toThrow(/ADMIN_OIDS/);
    const only = cfg({ ADMIN_OIDS: OID.toUpperCase(), ADMIN_EMAILS: 'boss@namra.org.na' }).entra!;
    expect(only.adminOids).toEqual([OID]);
    expect(only.adminEmailsAllowed).toBe(false);
    expect(cfg({ ADMIN_OIDS: OID, ADMIN_EMAILS: 'boss@namra.org.na', ADMIN_EMAILS_FALLBACK: 'true' }).entra!.adminEmailsAllowed).toBe(true);
    const emailOnly = cfg({ ADMIN_EMAILS: 'boss@namra.org.na' }).entra!;
    expect(emailOnly.adminEmailsAllowed).toBe(true);                         // the documented fallback keeps today's deployment working
    expect(adminNotices(cfg({ ADMIN_EMAILS: 'boss@namra.org.na' })).map((n) => n.kind)).toContain('admin_by_email');
  });
});

describe('Entra client secret expiry', () => {
  const day = 24 * 3600 * 1000;
  const at = (days: number) => new Date('2027-03-01T12:00:00Z').getTime() + days * day;
  const now = new Date('2027-03-01T12:00:00Z');
  const withExpiry = (days: number) => cfg({ DEMO_MEMBER_EMAILS: '', ADMIN_OIDS: OID, ENTRA_SECRET_EXPIRES_AT: new Date(at(days)).toISOString() });

  it('is silent until 30 days before, then warns (log + admin banner), then shouts once expired', () => {
    expect(secretDaysLeft(withExpiry(31), now)).toBe(31);
    expect(adminNotices(withExpiry(31), now)).toEqual([]);
    expect(operatorWarnings(withExpiry(31), now)).toEqual([]);
    expect(adminNotices(withExpiry(30), now)).toEqual([{ kind: 'secret_expiry', daysLeft: 30, expired: false }]);
    expect(operatorWarnings(withExpiry(5), now)[0]).toMatchObject({ level: 'warn', line: expect.stringMatching(/expires in 5 days/) });
    expect(adminNotices(withExpiry(-2), now)).toEqual([{ kind: 'secret_expiry', daysLeft: 0, expired: true }]);
    expect(operatorWarnings(withExpiry(-2), now)[0]).toMatchObject({ level: 'error', line: expect.stringMatching(/EXPIRED 2 days ago/) });
  });
  it('a plain date means "until the end of that day"; garbage refuses to start; unset warns that nothing is tracked', () => {
    const c = cfg({ ADMIN_OIDS: OID, ENTRA_SECRET_EXPIRES_AT: '2027-05-30' });
    expect(c.entra!.secretExpiresAt!.toISOString()).toBe('2027-05-30T23:59:59.000Z');
    expect(() => cfg({ ENTRA_SECRET_EXPIRES_AT: 'soon' })).toThrow(/ENTRA_SECRET_EXPIRES_AT/);
    expect(operatorWarnings(cfg({ ADMIN_OIDS: OID }), now).map((w) => w.line).join('\n')).toMatch(/ENTRA_SECRET_EXPIRES_AT is not set/);
  });
});

describe('a rejected token exchange says what is wrong', () => {
  const oauthError = (description: string) => Object.assign(new Error('server responded with an error in the response body'), { error: 'invalid_client', error_description: description });
  it('AADSTS7000222 (expired secret) and AADSTS7000215 (invalid secret) produce a clear operator line', () => {
    const a = describeSignInFailure(oauthError('AADSTS7000222: The provided client secret keys for app are expired.\r\nTrace ID: abc'));
    expect(a.secretProblem).toBe(true);
    expect(a.line).toMatch(/CLIENT SECRET EXPIRED \(AADSTS7000222\)/);
    expect(a.line).toMatch(/ENTRA_CLIENT_SECRET/);
    const b = describeSignInFailure(oauthError('AADSTS7000215: Invalid client secret provided.'));
    expect(b.secretProblem).toBe(true);
    expect(b.line).toMatch(/CLIENT SECRET INVALID \(AADSTS7000215\)/);
    // openid-client puts the OAuth body on `cause`
    const c = describeSignInFailure(Object.assign(new Error('x'), { cause: { error_description: 'AADSTS7000222: expired' } }));
    expect(c.secretProblem).toBe(true);
  });
  it('control: other AADSTS codes and ordinary failures are logged as a normal rejection, with the code and without secrets', () => {
    const d = describeSignInFailure(oauthError('AADSTS50011: The redirect URI does not match'));
    expect(d.secretProblem).toBe(false);
    expect(d.line).toMatch(/sign-in rejected/);
    expect(d.line).toMatch(/AADSTS50011/);
    expect(describeSignInFailure(new Error('state does not match its cookie'))).toEqual({ secretProblem: false, line: '[entra] sign-in rejected: state does not match its cookie' });
    expect(describeSignInFailure('weird').line).toBe('[entra] sign-in rejected: unknown');
  });
});
