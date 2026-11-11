import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeOwner, makeCampaign, resetDb, setMembers, type Session } from '../helpers.js';
import { startMockIdp, type MockIdp, type Scenario } from '../mockIdp.js';
import { parseDemoMemberEmails } from '../../src/config.js';

const TENANT = 'fe7b029e-7e19-4525-bdf4-57462a59d299';
const CLIENT = '281ab38e-9ff5-4f17-88ea-18bdc3e65457';
const SECRET = 'test-client-secret-value~123';
const REDIRECT = 'https://app.test/auth/callback';
const ADMIN_EMAIL = 'boss@namra.org.na';
const LISTED = 'demo.voter@namra.org.na';

process.env.AUTH_MODE = 'entra';
process.env.ENTRA_TENANT_ID = TENANT;
process.env.ENTRA_CLIENT_ID = CLIENT;
process.env.ENTRA_CLIENT_SECRET = SECRET;
process.env.ENTRA_REDIRECT_URI = REDIRECT;
process.env.ADMIN_EMAILS = ADMIN_EMAIL;
process.env.DEMO_MEMBER_EMAILS = ` ${LISTED.toUpperCase()} , `;   // case/space tolerant, empty entries ignored

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

async function signIn(claims: Scenario['claims'], graph: Scenario['graph'] = {}) {
  const agent = request.agent(app);
  const loc = new URL((await agent.get('/auth/login')).headers.location);
  const code = `code-${++n}`;
  idp.register(code, { nonce: loc.searchParams.get('nonce')!, codeChallenge: loc.searchParams.get('code_challenge')!, claims, graph });
  const cb = await agent.get(`/auth/callback?code=${code}&state=${encodeURIComponent(loc.searchParams.get('state')!)}`);
  expect(cb.status).toBe(302);
  expect(cb.headers.location).not.toMatch(/error/);
  return agent;
}
async function asSession(agent: ReturnType<typeof request.agent>): Promise<Session> {
  const t = (await agent.get('/api/csrf')).body.token as string;
  return { get: (u) => agent.get(u), post: (u) => agent.post(u).set('x-csrf-token', t), put: (u) => agent.put(u).set('x-csrf-token', t), patch: (u) => agent.patch(u).set('x-csrf-token', t), del: (u) => agent.delete(u).set('x-csrf-token', t) };
}
async function umojaVote() {
  await setMembers([['NAM0445', true]]);
  const admin = await asSession(await signIn({ oid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', preferred_username: ADMIN_EMAIL, name: 'Boss' }, { employeeId: 'NAM0999' }));
  const c = await makeCampaign(admin, 2, 'Umoja vote', 'umoja');
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return c;
}
const OID_LISTED = '0f1d2c3b-4a59-4687-8795-a4b3c2d1e0f9';
const OID_OTHER = '1f1d2c3b-4a59-4687-8795-a4b3c2d1e0f9';

describe('DEMO_MEMBER_EMAILS override', () => {
  it('a listed email (from the verified token) can vote with no employeeId, exactly once, and it is logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = await umojaVote();
    const s = await asSession(await signIn({ oid: OID_LISTED, preferred_username: LISTED }));   // Graph: no employeeId
    expect((await s.get('/api/session').expect(200)).body.user.employeeCode).toBeNull();
    expect((await s.get(`/api/vote/${c.token}`).expect(200)).body.voterState).toBe('can_vote');
    expect((await s.get('/api/vote').expect(200)).body.campaigns.some((x: { shareToken: string }) => x.shareToken === c.token)).toBe(true);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);
    expect(warn.mock.calls.some((a) => String(a[0]).includes('member via DEMO_MEMBER_EMAILS'))).toBe(true);
    warn.mockRestore();
  });

  it('an unlisted email with no employee code is not_member (positive control above proves the flow works)', async () => {
    const c = await umojaVote();
    const s = await asSession(await signIn({ oid: OID_OTHER, preferred_username: 'someone.else@namra.org.na' }));
    expect((await s.get(`/api/vote/${c.token}`).expect(403)).body.code).toBe('not_member');
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(403);
  });

  it('a forged email in the body, query or headers is ignored: only the verified token email counts', async () => {
    const c = await umojaVote();
    const s = await asSession(await signIn({ oid: OID_OTHER, preferred_username: 'someone.else@namra.org.na' }));
    const forged = { email: LISTED, preferred_username: LISTED, voter_email: LISTED };
    await s.get(`/api/vote/${c.token}?email=${LISTED}&preferred_username=${LISTED}`)
      .set('x-email', LISTED).set('x-user-email', LISTED).set('x-forwarded-email', LISTED).set('cf-access-authenticated-user-email', LISTED).expect(403);
    await s.post(`/api/vote/${c.token}?email=${LISTED}`).set('x-email', LISTED).set('x-forwarded-email', LISTED)
      .send({ candidateId: c.candidates[0] }).expect(403);
    // Extra identity fields in the body are refused outright (strict schema) - and certainly never counted as a membership.
    const withBody = await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0], ...forged });
    expect([400, 403]).toContain(withBody.status);
    expect((await s.get('/api/vote?email=' + LISTED).set('x-email', LISTED).expect(200)).body.campaigns.length).toBe(0);
  });

  it('the override applies only to the listed person even when another user shares a display name', async () => {
    const c = await umojaVote();
    const s = await asSession(await signIn({ oid: OID_OTHER, preferred_username: 'other@namra.org.na', name: 'Demo Voter' }));
    await s.get(`/api/vote/${c.token}`).expect(403);
  });
});

describe('DEMO_MEMBER_EMAILS parsing', () => {
  it('empty or unset gives no overrides', () => {
    expect(parseDemoMemberEmails(undefined)).toEqual([]);
    expect(parseDemoMemberEmails('')).toEqual([]);
    expect(parseDemoMemberEmails(' , ,')).toEqual([]);
  });
  it('lower-cases, trims and de-duplicates', () => {
    expect(parseDemoMemberEmails(' A@namra.org.na,a@NAMRA.org.na , b@namra.org.na')).toEqual(['a@namra.org.na', 'b@namra.org.na']);
  });
  it('refuses anything that is not a plain email (it is embedded in SQL)', () => {
    for (const bad of ["x'; drop table users;--@a.com", 'not-an-email', 'a@b', 'a b@c.com', 'a"b@c.com']) expect(() => parseDemoMemberEmails(bad)).toThrow(/DEMO_MEMBER_EMAILS/);
  });
});
