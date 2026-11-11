import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeOwner, makeCampaign, ownerDb, resetDb, setMembers, type Session } from '../helpers.js';

// Config is read once per module graph: switch this file to demo mode BEFORE importing the app.
const ADMIN = 'lenton.losper@namra.org.na';
const GMAIL_ADMIN = 'llosperofficial@gmail.com';
const VOTER = 'voter.demo@namra.org.na';
const NONMEMBER = 'nonmember.demo@namra.org.na';
process.env.AUTH_MODE = 'demo';
process.env.CF_ACCESS_TEAM_DOMAIN = 'testteam';
process.env.CF_ACCESS_AUD = 'aud-123';
process.env.DEMO_USERS = JSON.stringify({
  [ADMIN]: { displayName: 'Lenton Losper', roles: ['CampaignAdmin'], employeeCode: 'TST0001' },
  [GMAIL_ADMIN.toUpperCase()]: { displayName: 'Lenton Losper', roles: ['CampaignAdmin'], employeeCode: 'TST0001' },   // keys are case-insensitive
  [VOTER]: { displayName: 'Vera Voter', roles: [], employeeCode: 'TST0007' },
  [NONMEMBER]: { displayName: 'Nico Nonmember', roles: [] },
});

const AUD = 'aud-123';
let app: import('express').Express;
let closePool: () => Promise<void>;
let key: CryptoKey;

async function token(claims: Record<string, unknown>) {
  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer('https://testteam.cloudflareaccess.com').setAudience(AUD).setIssuedAt().setExpirationTime('10m').sign(key);
}

/** A CSRF-aware client whose every request carries a genuine Access token for `email` (like the browser behind Access). */
async function as(email: string | null, extra: Record<string, unknown> = {}): Promise<Session> {
  const jwt = await token(email === null ? { ...extra } : { email, ...extra });
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/csrf').set('Cf-Access-Jwt-Assertion', jwt)).body.token as string;
  const h = (r: request.Test) => r.set('Cf-Access-Jwt-Assertion', jwt);
  return {
    get: (u) => h(agent.get(u)), post: (u) => h(agent.post(u).set('x-csrf-token', csrf)), put: (u) => h(agent.put(u).set('x-csrf-token', csrf)),
    patch: (u) => h(agent.patch(u).set('x-csrf-token', csrf)), del: (u) => h(agent.delete(u).set('x-csrf-token', csrf)),
  };
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  key = kp.privateKey;
  const pub: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const { createAccessVerifier } = await import('../../src/auth/access.js');
  const { createApp } = await import('../../src/app.js');
  closePool = (await import('../../src/db.js')).closePool;
  app = createApp({ accessVerifier: createAccessVerifier({ teamDomain: 'testteam', aud: AUD, keys: createLocalJWKSet({ keys: [pub] }) }) });
});
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

describe('demo identity comes from the verified Access JWT', () => {
  it('maps the email claim to its DEMO_USERS profile (name, role, employee code), lower-casing the email', async () => {
    const s = await as('Lenton.Losper@NamRA.org.na');
    const u = (await s.get('/api/session').expect(200)).body;
    expect(u.authMode).toBe('demo');
    expect(u.user).toMatchObject({ email: ADMIN, displayName: 'Lenton Losper', roles: ['CampaignAdmin'], employeeCode: 'TST0001' });
    const v = (await (await as(VOTER)).get('/api/session').expect(200)).body.user;
    expect(v).toMatchObject({ displayName: 'Vera Voter', roles: [], employeeCode: 'TST0007' });
    const n = (await (await as(NONMEMBER)).get('/api/session').expect(200)).body.user;
    expect(n).toMatchObject({ displayName: 'Nico Nonmember', roles: [], employeeCode: null });
  });

  it('the gmail owner gets the same admin profile as lenton.losper (case-insensitive map keys)', async () => {
    const g = (await (await as(GMAIL_ADMIN)).get('/api/session').expect(200)).body.user;
    expect(g).toMatchObject({ email: GMAIL_ADMIN, displayName: 'Lenton Losper', roles: ['CampaignAdmin'], employeeCode: 'TST0001' });
    expect(g.oid).not.toBe((await (await as(ADMIN)).get('/api/session')).body.user.oid);   // distinct people, distinct ids
  });

  it('an unmapped email is plain staff with no code, and gets the not_member response on an Umoja vote', async () => {
    await setMembers([['TST0001', true], ['TST0007', true]]);
    const admin = await as(ADMIN);
    const c = await makeCampaign(admin, 2, 'Umoja vote', 'umoja');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);

    const stranger = await as('jane.doe@namra.org.na');
    const me = (await stranger.get('/api/session').expect(200)).body.user;
    expect(me).toMatchObject({ email: 'jane.doe@namra.org.na', displayName: 'Jane Doe', roles: [], employeeCode: null });
    const r = await stranger.get(`/api/vote/${c.token}`).expect(403);
    expect(r.body.code).toBe('not_member');
    await stranger.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(403);
    await stranger.get('/api/campaigns/mine').expect(403);                      // not an admin either

    // POSITIVE CONTROL: the mapped member with an active TST code can vote, once.
    const voter = await as(VOTER);
    expect((await voter.get(`/api/vote/${c.token}`).expect(200)).body.voterState).toBe('can_vote');
    await voter.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await voter.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);
  });

  it('a forged email in the body, query string or any header is ignored: only the verified claim counts', async () => {
    const s = await as('jane.doe@namra.org.na');
    const forged = (r: request.Test) => r
      .set('X-User-Email', ADMIN).set('X-Forwarded-Email', ADMIN).set('Cf-Access-Authenticated-User-Email', ADMIN)
      .set('X-Auth-Request-Email', ADMIN).set('Authorization', `Bearer ${ADMIN}`);
    const viaHeaders = await forged(s.get(`/api/session?email=${ADMIN}&user=${ADMIN}`)).expect(200);
    expect(viaHeaders.body.user.email).toBe('jane.doe@namra.org.na');
    expect(viaHeaders.body.user.roles).toEqual([]);
    await forged(s.get(`/api/campaigns/mine?email=${ADMIN}`)).expect(403);
    const viaBody = await s.post('/api/dev/login').send({ oid: '11111111-1111-4111-8111-111111111111', email: ADMIN, displayName: 'Lenton Losper', roles: ['CampaignAdmin'], employeeCode: 'TST0001' });
    expect(viaBody.status).toBe(404);   // the picker's login route does not exist in demo mode
    await s.post('/api/logout').send({ email: ADMIN }).expect(204);
    expect((await s.get('/api/session').expect(200)).body.user.email).toBe('jane.doe@namra.org.na');
    expect((await ownerDb().query('SELECT count(*)::int n FROM users WHERE email = $1', [ADMIN])).rows[0].n).toBe(0);
  });

  it('the same email always gets the same oid (deterministic v5 UUID), with one users row, even across many requests', async () => {
    const a = (await (await as(ADMIN)).get('/api/session')).body.user.oid as string;
    const b = (await (await as('LENTON.LOSPER@namra.org.na')).get('/api/session')).body.user.oid as string;
    const o = (await (await as(VOTER)).get('/api/session')).body.user.oid as string;
    expect(a).toBe(b);
    expect(a).not.toBe(o);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const rows = (await ownerDb().query('SELECT entra_oid, display_name, employee_code FROM users WHERE email = $1', [ADMIN])).rows;
    expect(rows).toEqual([{ entra_oid: a, display_name: 'Lenton Losper', employee_code: 'TST0001' }]);
  });

  it('there is no identity picker in demo mode: /api/dev/* does not exist', async () => {
    const s = await as(ADMIN);
    await s.get('/api/dev/users').expect(404);
    await s.post('/api/dev/login').send({}).expect(404);
  });

  it('a valid Access token with no email claim (e.g. a service token) is signed out', async () => {
    const s = await as(null);
    expect((await s.get('/api/session').expect(200)).body.user).toBeNull();
    await s.get('/api/campaigns/mine').expect(401);
    await s.get('/api/vote').expect(401);
  });
});
