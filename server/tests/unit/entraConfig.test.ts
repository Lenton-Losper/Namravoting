import { describe, expect, it } from 'vitest';
import { safeNext as clientSafeNext } from '../../../client/src/safeNext.js';
import { safeNext as serverSafeNext } from '../../src/auth/safeNext.js';
import { describeConfigError, parseConfig } from '../../src/config.js';

const base = { SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@h/db', NODE_ENV: 'production' };
const entra = {
  AUTH_MODE: 'entra', ENTRA_TENANT_ID: 'fe7b029e-7e19-4525-bdf4-57462a59d299', ENTRA_CLIENT_ID: '281ab38e-9ff5-4f17-88ea-18bdc3e65457',
  ENTRA_CLIENT_SECRET: 'super-secret-value', ENTRA_REDIRECT_URI: 'https://x.example/auth/callback', ADMIN_EMAILS: 'A@b.c, d@e.f',
};

describe('AUTH_MODE=entra configuration', () => {
  it('parses a complete configuration (admin emails lower-cased; allowed in production)', () => {
    const c = parseConfig({ ...base, ...entra });
    expect(c.entra).toMatchObject({ tenantId: entra.ENTRA_TENANT_ID, clientId: entra.ENTRA_CLIENT_ID, adminEmails: ['a@b.c', 'd@e.f'] });
    expect(c.access).toBeNull();   // Microsoft sign-in is the gate: no Access JWT is required
  });

  it.each(['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'ENTRA_CLIENT_SECRET', 'ENTRA_REDIRECT_URI'] as const)('refuses to start without %s, naming the key and never a value', (k) => {
    const env = { ...base, ...entra } as Record<string, string>;
    delete env[k];
    let msg = '';
    try { parseConfig(env); } catch (e) { msg = describeConfigError(e); }
    expect(msg).toMatch(/Refusing to start: AUTH_MODE=entra requires/);
    expect(msg).toContain(k);
    expect(msg).not.toContain('super-secret-value');
    expect(msg.includes('\n')).toBe(false);   // one line, so the STARTUP ERROR output stays a single line
  });

  it('refuses blank values, malformed GUIDs and a redirect URI that is not /auth/callback', () => {
    expect(() => parseConfig({ ...base, ...entra, ENTRA_CLIENT_SECRET: '   ' })).toThrow(/ENTRA_CLIENT_SECRET/);
    expect(() => parseConfig({ ...base, ...entra, ENTRA_TENANT_ID: 'contoso.onmicrosoft.com' })).toThrow(/tenant GUID/);
    expect(() => parseConfig({ ...base, ...entra, ENTRA_CLIENT_ID: 'nope' })).toThrow(/client .*GUID/);
    expect(() => parseConfig({ ...base, ...entra, ENTRA_REDIRECT_URI: 'not a url' })).toThrow(/absolute URL/);
    expect(() => parseConfig({ ...base, ...entra, ENTRA_REDIRECT_URI: 'https://x.example/other' })).toThrow(/\/auth\/callback/);
  });

  it('other modes do not need ENTRA_* settings', () => {
    expect(parseConfig({ ...base, NODE_ENV: 'development', AUTH_MODE: 'dev', ALLOW_DEV_AUTH: 'true' }).entra).toBeNull();
  });
});

describe('server safeNext is identical to the client one', () => {
  const inputs = [null, undefined, '', '/', '/admin', '/admin/new', '/votes', '/votes?x=1', '/v/' + 'a'.repeat(32), '//evil.com', 'https://evil.com', '/\\evil.com', '/v/a b',
    'javascript:alert(1)', '/other', '/admin\r\nx', '/' + 'a'.repeat(600), '/v/%0d%0a', '/votes#frag', 'admin'];
  it.each(inputs)('%j', (i) => { expect(serverSafeNext(i as string)).toBe(clientSafeNext(i as string)); });
});
