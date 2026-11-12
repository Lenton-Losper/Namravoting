import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeOwner, ownerDb, resetDb } from '../helpers.js';
import { startMockIdp, type MockIdp, type Scenario } from '../mockIdp.js';

const TENANT = 'fe7b029e-7e19-4525-bdf4-57462a59d299';
const CLIENT = '281ab38e-9ff5-4f17-88ea-18bdc3e65457';
const SECRET = 'test-client-secret-value~123';
const REDIRECT = 'https://app.test/auth/callback';
const ADMIN_OID = '0f1d2c3b-4a59-4687-8795-a4b3c2d1e0f9';
const EMAIL_ADMIN = 'boss@namra.org.na';
const STAFF_OID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DAY = 24 * 3600 * 1000;

process.env.AUTH_MODE = 'entra';
process.env.ENTRA_TENANT_ID = TENANT;
process.env.ENTRA_CLIENT_ID = CLIENT;
process.env.ENTRA_CLIENT_SECRET = SECRET;
process.env.ENTRA_REDIRECT_URI = REDIRECT;
process.env.ADMIN_OIDS = ADMIN_OID;                       // SEC-11: admins by account id ...
process.env.ADMIN_EMAILS = EMAIL_ADMIN;                   // ... so this email list is ignored (no ADMIN_EMAILS_FALLBACK)
process.env.DEMO_MEMBER_EMAILS = 'demo@namra.org.na';
process.env.DEMO = 'true';
process.env.ENTRA_SECRET_EXPIRES_AT = new Date(Date.now() + 10 * DAY).toISOString();

let idp: MockIdp;
let app: import('express').Express;
let closePool: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  idp = await startMockIdp({ tenant: TENANT, clientId: CLIENT, secret: SECRET, redirectUri: REDIRECT });
  const { createApp } = await import('../../src/app.js');
  closePool = (await import('../../src/db.js')).closePool;
  app = createApp({ entra: { authorityBase: idp.base, graphBase: `${idp.base}/graph/v1.0`, allowInsecure: true } });
});
beforeEach(resetDb);
afterAll(async () => { await idp.close(); await closePool(); await closeOwner(); });

async function signIn(o: { claims?: Scenario['claims']; tokenError?: Scenario['tokenError'] } = {}) {
  const agent = request.agent(app);
  const login = await agent.get('/auth/login');
  const loc = new URL(login.headers.location);
  const code = `code-${++n}`;
  idp.register(code, { nonce: loc.searchParams.get('nonce')!, codeChallenge: loc.searchParams.get('code_challenge')!, claims: o.claims, tokenError: o.tokenError, graph: { employeeId: undefined } });
  const callback = await agent.get(`/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state')!)}`);
  return { agent, callback };
}

describe('SEC-11: admins by Entra object id', () => {
  it('the account in ADMIN_OIDS is an admin, whatever its email', async () => {
    const { agent, callback } = await signIn({ claims: { oid: ADMIN_OID, preferred_username: 'renamed.admin@namra.org.na' } });
    expect(callback.headers.location).toBe('/admin');
    expect((await agent.get('/api/session')).body.user.roles).toEqual(['CampaignAdmin']);
  });
  it('the email in ADMIN_EMAILS does NOT make an account an admin once ADMIN_OIDS is set (a reused or renamed address gets nothing)', async () => {
    const { agent, callback } = await signIn({ claims: { oid: STAFF_OID, preferred_username: EMAIL_ADMIN } });
    expect(callback.headers.location).toBe('/votes');
    expect((await agent.get('/api/session')).body.user.roles).toEqual([]);
    await agent.get('/api/campaigns/mine').expect(403);
  });
});

describe('operator banners reach admins only', () => {
  it('an admin sees the demo override and the secret expiry; staff see nothing; signed-out sees nothing', async () => {
    const admin = await signIn({ claims: { oid: ADMIN_OID } });
    const notices = (await admin.agent.get('/api/session')).body.notices as { kind: string; daysLeft?: number }[];
    expect(notices.map((x) => x.kind).sort()).toEqual(['demo_override', 'secret_expiry']);
    expect(notices.find((x) => x.kind === 'secret_expiry')!.daysLeft).toBeGreaterThanOrEqual(9);
    const staff = await signIn({ claims: { oid: STAFF_OID, preferred_username: 'staff@namra.org.na' } });
    expect((await staff.agent.get('/api/session')).body.notices).toEqual([]);
    expect((await request(app).get('/api/session')).body.notices).toEqual([]);
  });
});

describe('SEC-12: a signed sign-in-flow cookie is not a session', () => {
  it('renaming the namra_auth_<state> cookie to namra_session gives no user and no access', async () => {
    const login = await request(app).get('/auth/login');
    const flow = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('namra_auth_'))!;
    const value = flow.split(';')[0].split('=').slice(1).join('=');
    const r = await request(app).get('/api/session').set('Cookie', `namra_session=${value}`);
    expect(r.body.user).toBeNull();
    await request(app).get('/api/vote').set('Cookie', `namra_session=${value}`).expect(401);
    await request(app).get('/api/campaigns/mine').set('Cookie', `namra_session=${value}`).expect(401);
  });
});

describe('a failed token exchange because of the client secret', () => {
  it('AADSTS7000222 logs a clear "client secret expired" error line and the user still just sees signin_failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { callback } = await signIn({ tokenError: { error: 'invalid_client', error_description: 'AADSTS7000222: The provided client secret keys for app are expired. Trace ID: x' } });
      expect(callback.status).toBe(302);
      expect(callback.headers.location).toBe('/login?error=signin_failed');
      const lines = err.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => /CLIENT SECRET EXPIRED \(AADSTS7000222\)/.test(l) && /ENTRA_CLIENT_SECRET/.test(l)), lines.join('\n')).toBe(true);
      expect(lines.join('\n')).not.toContain(SECRET);
    } finally { err.mockRestore(); }
  });
  it('AADSTS7000215 says "invalid"; any other failure stays a normal warning', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await signIn({ tokenError: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' } });
      expect(err.mock.calls.map((c) => String(c[0])).some((l) => /CLIENT SECRET INVALID \(AADSTS7000215\)/.test(l))).toBe(true);
      err.mockClear();
      await signIn({ tokenError: { error: 'invalid_grant', error_description: 'AADSTS70008: The code has expired' } });
      expect(err.mock.calls.map((c) => String(c[0])).some((l) => /CLIENT SECRET/.test(l))).toBe(false);
      expect(warn.mock.calls.map((c) => String(c[0])).some((l) => /sign-in rejected/.test(l) && /AADSTS70008/.test(l))).toBe(true);
    } finally { err.mockRestore(); warn.mockRestore(); }
    expect((await ownerDb().query('SELECT count(*)::int n FROM users')).rows[0].n).toBe(0);
  });
});
