import crypto from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeOwner, makeCampaign, ownerDb, resetDb, setMembers, type Session } from '../helpers.js';
import { startMockIdp, type MockIdp, type Scenario } from '../mockIdp.js';

const TENANT = 'fe7b029e-7e19-4525-bdf4-57462a59d299';
const CLIENT = '281ab38e-9ff5-4f17-88ea-18bdc3e65457';
const SECRET = 'test-client-secret-value~123';
const REDIRECT = 'https://app.test/auth/callback';
const ADMIN_EMAIL = 'boss@namra.org.na';
const OID = '0f1d2c3b-4a59-4687-8795-a4b3c2d1e0f9';
const OID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Config is read once per module graph: switch this file to entra mode BEFORE importing the app.
process.env.AUTH_MODE = 'entra';
process.env.ENTRA_TENANT_ID = TENANT;
process.env.ENTRA_CLIENT_ID = CLIENT;
process.env.ENTRA_CLIENT_SECRET = SECRET;
process.env.ENTRA_REDIRECT_URI = REDIRECT;
process.env.ADMIN_EMAILS = `${ADMIN_EMAIL}, Other.Admin@namra.org.na`;

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

interface Opts {
  claims?: Scenario['claims']; graph?: Scenario['graph']; next?: string; signWithOtherKey?: boolean;
  nonce?: string; state?: string; agent?: ReturnType<typeof request.agent>;
}

/** Drives the real flow: /auth/login -> (mock Microsoft) -> /auth/callback, with one cookie jar. */
async function signIn(o: Opts = {}) {
  const agent = o.agent ?? request.agent(app);
  const login = await agent.get('/auth/login' + (o.next === undefined ? '' : `?next=${encodeURIComponent(o.next)}`));
  const loc = new URL(login.headers.location);
  const code = `code-${++n}`;
  idp.register(code, {
    nonce: o.nonce ?? loc.searchParams.get('nonce')!, codeChallenge: loc.searchParams.get('code_challenge')!,
    claims: o.claims, graph: o.graph, signWithOtherKey: o.signWithOtherKey,
  });
  const callback = await agent.get(`/auth/callback?code=${code}&state=${encodeURIComponent(o.state ?? loc.searchParams.get('state')!)}`);
  return { agent, login, loc, callback };
}

const sessionCookie = (r: request.Response) => ((r.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((c) => c.startsWith('namra_session=') && !/namra_session=;/.test(c));
const rejected = (r: request.Response) => { expect(r.status).toBe(302); expect(r.headers.location).toBe('/login?error=signin_failed'); expect(sessionCookie(r)).toBeUndefined(); };
const userCount = async () => (await ownerDb().query('SELECT count(*)::int n FROM users')).rows[0].n as number;

async function asSession(agent: ReturnType<typeof request.agent>): Promise<Session> {
  const t = (await agent.get('/api/csrf')).body.token as string;
  return {
    get: (u) => agent.get(u), post: (u) => agent.post(u).set('x-csrf-token', t), put: (u) => agent.put(u).set('x-csrf-token', t),
    patch: (u) => agent.patch(u).set('x-csrf-token', t), del: (u) => agent.delete(u).set('x-csrf-token', t),
  };
}

describe('the login redirect', () => {
  it('sends the browser to Microsoft with PKCE, state, nonce, the right scope and prompt=select_account', async () => {
    const r = await request(app).get('/auth/login').expect(302);
    const u = new URL(r.headers.location);
    expect(u.origin + u.pathname).toBe(`${idp.base}/${TENANT}/oauth2/v2.0/authorize`);
    expect(u.searchParams.get('client_id')).toBe(CLIENT);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(u.searchParams.get('scope')).toBe('openid profile email User.Read');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('state')!.length).toBeGreaterThanOrEqual(16);
    expect(u.searchParams.get('nonce')!.length).toBeGreaterThanOrEqual(16);
    expect(r.headers.location).not.toContain(SECRET);
  });

  it('the auth cookie is HttpOnly, SameSite=Lax, short-lived and signed (no verifier or nonce readable)', async () => {
    const r = await request(app).get('/auth/login').expect(302);
    const c = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('namra_auth_'))!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Lax/i);
    expect(c).not.toMatch(/SameSite=Strict/i);
    expect(c).toMatch(/Max-Age=600/i);
    expect(c).toMatch(/Path=\/auth/i);
    const payload = JSON.parse(Buffer.from(decodeURIComponent(c.split(';')[0].slice(c.indexOf('=') + 1)).split('.')[0], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['exp', 'n', 'next', 's', 'v']);   // it is signed, not encrypted: it holds nothing the browser could abuse
  });
});

describe('successful sign-in', () => {
  it('creates the user from the ID token (oid, lower-cased email) and Graph (normalised employee code), signs in, clears the auth cookie', async () => {
    const { callback, agent } = await signIn({
      claims: { oid: OID.toUpperCase(), preferred_username: 'Jane.Doe@NamRA.org.na', name: 'Jane Doe' },
      graph: { employeeId: ' nam0445 ' },
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe('/votes');
    expect(sessionCookie(callback)).toMatch(/HttpOnly/i);
    const cleared = (callback.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('namra_auth_'))!;
    expect(cleared).toMatch(/^namra_auth_[A-Za-z0-9_-]+=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/SameSite=Lax/i);
    const rows = (await ownerDb().query('SELECT entra_oid, email, display_name, employee_code FROM users')).rows;
    expect(rows).toEqual([{ entra_oid: OID, email: 'jane.doe@namra.org.na', display_name: 'Jane Doe', employee_code: 'NAM0445' }]);
    const me = (await agent.get('/api/session').expect(200)).body;
    expect(me.authMode).toBe('entra');
    expect(me.user).toMatchObject({ oid: OID, email: 'jane.doe@namra.org.na', roles: [], employeeCode: 'NAM0445' });
  });

  it('exchanges the code with the secret, the configured redirect_uri and the PKCE verifier (the mock IdP enforces all three)', async () => {
    const before = idp.tokenRequests.length;
    const { callback } = await signIn();
    expect(callback.headers.location).toBe('/votes');
    const p = idp.tokenRequests[before];
    expect(p.get('grant_type')).toBe('authorization_code');
    expect(p.get('code_verifier')!.length).toBeGreaterThanOrEqual(43);
    expect(p.get('redirect_uri')).toBe(REDIRECT);
  });

  it('signing in again updates the same row (same oid), and takes over an email held by a pre-Entra demo user', async () => {
    await ownerDb().query(`INSERT INTO users (entra_oid, email, display_name) VALUES ($1, 'boss@namra.org.na', 'Old demo identity')`, [OID2]);
    await signIn({ claims: { oid: OID, preferred_username: ADMIN_EMAIL, name: 'Boss' } });
    await signIn({ claims: { oid: OID, preferred_username: ADMIN_EMAIL, name: 'Boss Renamed' } });
    const rows = (await ownerDb().query('SELECT entra_oid, email, display_name FROM users ORDER BY display_name')).rows;
    expect(rows.find((r) => r.entra_oid === OID)).toMatchObject({ email: ADMIN_EMAIL, display_name: 'Boss Renamed' });
    expect(rows.find((r) => r.entra_oid === OID2).email).toMatch(/^superseded-aaaaaaaa\+/);   // kept (campaigns may reference it), email freed
  });

  it('uses `email` when preferred_username is absent', async () => {
    const { callback } = await signIn({ claims: { preferred_username: undefined, email: 'Only.Mail@namra.org.na' } });
    expect(callback.headers.location).toBe('/votes');
    expect((await ownerDb().query('SELECT email FROM users')).rows[0].email).toBe('only.mail@namra.org.na');
  });

  it('works with no Cloudflare Access token: entra mode has no Access gate', async () => {
    await request(app).get('/api/session').expect(200);
    await request(app).get('/api/campaigns/mine').expect(401);
  });
});

describe('rejections (each leaves no session and no user)', () => {
  it.each<[string, Opts, RegExp]>([
    ['wrong tenant (tid)', { claims: { tid: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } }, /wrong tenant/],
    ['wrong issuer', { claims: { iss: 'https://login.microsoftonline.com/ffffffff-ffff-4fff-8fff-ffffffffffff/v2.0' } }, /unexpected JWT claim/],
    ['wrong audience', { claims: { aud: '99999999-9999-4999-8999-999999999999' } }, /unexpected JWT claim/],
    ['bad nonce', { nonce: 'not-the-nonce-we-sent-xxxxxxxxxxxx' }, /unexpected JWT claim/],
    ['state mismatch', { state: 'forged-state-value-forged-state-value' }, /missing or expired auth cookie/],
    ['ID token signed by an unknown key', { signWithOtherKey: true }, /signature verification failed/],
    ['expired ID token', { claims: { exp: Math.floor(Date.now() / 1000) - 600, iat: Math.floor(Date.now() / 1000) - 1200 } }, /timestamp claim/],
    ['no oid', { claims: { oid: undefined } }, /no oid/],
    ['no email', { claims: { preferred_username: undefined, email: undefined } }, /no email/],
    ['no tid', { claims: { tid: undefined } }, /wrong tenant/],
  ])('%s', async (_name, o, why) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { callback } = await signIn(o);
      rejected(callback);
      expect(warn.mock.calls.map((c) => String(c[0])).join(' | '), 'rejected for the intended reason').toMatch(new RegExp(`sign-in rejected: .*${why.source}`));
      expect(await userCount()).toBe(0);
    } finally { warn.mockRestore(); }
  });

  it('a callback without the auth cookie, with a tampered cookie, or replayed after success is rejected', async () => {
    const ok = await signIn();
    expect(ok.callback.headers.location).toBe('/votes');
    // replay: the cookie was cleared by the first callback
    const again = await ok.agent.get(ok.callback.request.url.replace(/^https?:\/\/[^/]+/, ''));
    rejected(again);
    // no cookie at all
    rejected(await request(app).get('/auth/callback?code=x&state=y'));
    // tampered cookie (verifier swapped) fails the signature
    const login = await request(app).get('/auth/login');
    const raw = ((login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('namra_auth_'))!).split(';')[0];
    const [body, mac] = decodeURIComponent(raw.slice(raw.indexOf('=') + 1)).split('.');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()); p.v = crypto.randomBytes(32).toString('base64url');
    const forged = `${Buffer.from(JSON.stringify(p)).toString('base64url')}.${mac}`;
    rejected(await request(app).get('/auth/callback?code=x&state=' + p.s).set('Cookie', `namra_auth_${p.s}=${encodeURIComponent(forged)}`));
  });

  it('an error returned by Microsoft (e.g. the user cancelled) is a clean rejection', async () => {
    const agent = request.agent(app);
    await agent.get('/auth/login');
    rejected(await agent.get('/auth/callback?error=access_denied&error_description=cancelled'));
  });
});

describe('employee code and not_member', () => {
  async function umojaVote() {
    await setMembers([['NAM0445', true]]);
    const adminSignIn = await signIn({ claims: { oid: OID2, preferred_username: ADMIN_EMAIL, name: 'Boss' }, graph: { employeeId: 'NAM0999' } });
    const admin = await asSession(adminSignIn.agent);
    const c = await makeCampaign(admin, 2, 'Umoja vote', 'umoja');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    return c;
  }

  it.each<[string, Scenario['graph']]>([
    ['employeeId absent', {}],
    ['employeeId blank', { employeeId: '   ' }],
    ['employeeId malformed', { employeeId: 'not-a-code' }],
    ['employeeId not a string', { employeeId: 12345 }],
    ['Graph returns an error', { __status: 500 }],
    ['Graph denies the token', { __status: 403 }],
  ])('%s: signs in with no code and gets not_member', async (_name, graph) => {
    const c = await umojaVote();
    const { callback, agent } = await signIn({ claims: { oid: OID, preferred_username: 'nocode@namra.org.na' }, graph });
    expect(callback.headers.location).toBe('/votes');
    const me = (await agent.get('/api/session').expect(200)).body.user;
    expect(me.employeeCode).toBeNull();
    const s = await asSession(agent);
    expect((await s.get(`/api/vote/${c.token}`).expect(403)).body.code).toBe('not_member');
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(403);
  });

  it('DEMO_MEMBER_EMAILS unset: no email is treated as a member (the override is off)', async () => {
    const c = await umojaVote();
    const { agent } = await signIn({ claims: { oid: OID, preferred_username: 'lenton.losper@namra.org.na' }, graph: {} });
    const s = await asSession(agent);
    expect((await s.get(`/api/vote/${c.token}`).expect(403)).body.code).toBe('not_member');
  });

  it('POSITIVE CONTROL: a valid employeeId on the Umoja list can vote, exactly once', async () => {
    const c = await umojaVote();
    const { agent } = await signIn({ claims: { oid: OID, preferred_username: 'member@namra.org.na' }, graph: { employeeId: 'NAM0445' } });
    const s = await asSession(agent);
    expect((await s.get(`/api/vote/${c.token}`).expect(200)).body.voterState).toBe('can_vote');
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);
  });
});

describe('the ballot link survives the whole sign-in (QR -> ballot)', () => {
  const ADMIN = { oid: OID2, preferred_username: ADMIN_EMAIL, name: 'Boss' };
  const STAFF = { oid: OID, preferred_username: 'staff@namra.org.na', name: 'Staff' };
  /** An open campaign created by the admin; returns the ballot path /v/:token. */
  async function ballot() {
    await setMembers([['NAM0445', true]]);
    const { agent } = await signIn({ claims: ADMIN, graph: { employeeId: 'NAM0445' } });
    const a = await asSession(agent);
    const c = await makeCampaign(a, 2, 'QR vote', 'all');
    await a.post(`/api/campaigns/${c.id}/start`).expect(200);
    return `/v/${c.token}`;
  }

  it.each([['an admin', ADMIN], ['a non-admin', STAFF]])('signed out: %s lands on the ballot, not /admin or /votes', async (_who, claims) => {
    const path = await ballot();
    const { callback, agent } = await signIn({ claims, graph: { employeeId: 'NAM0445' }, next: path });
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe(path);
    const s = await asSession(agent);
    await s.get('/api/vote/' + path.slice(3)).expect(200);   // and the ballot is really reachable with the new session
  });

  it.each([['an admin', ADMIN], ['a non-admin', STAFF]])('already signed in: /auth/login?next=ballot goes straight to the ballot for %s, no Microsoft round trip', async (_who, claims) => {
    const path = await ballot();
    const { agent } = await signIn({ claims, graph: { employeeId: 'NAM0445' } });
    const r = await agent.get('/auth/login?next=' + encodeURIComponent(path)).expect(302);
    expect(r.headers.location).toBe(path);
    expect((await agent.get('/api/session').expect(200)).body.user.email).toBe(String(claims!.preferred_username));
    expect(r.headers['set-cookie']).toBeUndefined();   // no new auth flow was started
  });

  it('already signed in without a next: the role default, never an authorize redirect', async () => {
    const { agent: a } = await signIn({ claims: ADMIN });
    expect((await a.get('/auth/login').expect(302)).headers.location).toBe('/admin');
    const { agent: s } = await signIn({ claims: STAFF });
    expect((await s.get('/auth/login').expect(302)).headers.location).toBe('/votes');
  });

  it('REGRESSION: a second /auth/login (a second tap, another tab, the plain /login page) cannot overwrite the ballot target of the first', async () => {
    const path = await ballot();
    const agent = request.agent(app);
    const a = new URL((await agent.get('/auth/login?next=' + encodeURIComponent(path))).headers.location);   // QR flow, Microsoft page open
    await agent.get('/auth/login').expect(302);                                                              // another hit with NO next
    await agent.get('/auth/login?next=%2Fadmin').expect(302);                                                // and one pointing elsewhere
    const code = `code-${++n}`;
    idp.register(code, { nonce: a.searchParams.get('nonce')!, codeChallenge: a.searchParams.get('code_challenge')!, claims: ADMIN, graph: { employeeId: 'NAM0445' } });
    const cb = await agent.get(`/auth/callback?code=${code}&state=${encodeURIComponent(a.searchParams.get('state')!)}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe(path);
  });

  it('each overlapping flow keeps its own target', async () => {
    const agent = request.agent(app);
    const flows = [] as { loc: URL; next: string }[];
    for (const next of ['/votes', '/admin']) flows.push({ loc: new URL((await agent.get('/auth/login?next=' + encodeURIComponent(next))).headers.location), next });
    const first = flows[0];
    const code = `code-${++n}`;
    idp.register(code, { nonce: first.loc.searchParams.get('nonce')!, codeChallenge: first.loc.searchParams.get('code_challenge')!, claims: STAFF, graph: {} });
    const cb = await agent.get(`/auth/callback?code=${code}&state=${encodeURIComponent(first.loc.searchParams.get('state')!)}`);
    expect(cb.headers.location).toBe(first.next);
  });

  it('pending-flow cookies are capped (expired ones dropped, at most 6 kept), so repeated taps cannot grow the Cookie header', async () => {
    const agent = request.agent(app);
    let last: string[] = [];
    for (let i = 0; i < 15; i++) last = (await agent.get('/auth/login?next=%2Fvotes').expect(302)).headers['set-cookie'] as unknown as string[];
    const cleared = last.filter((c) => /^namra_auth_[^=]+=;/.test(c));
    const added = last.filter((c) => /^namra_auth_[^=]+=[^;]+/.test(c) && !/^namra_auth_[^=]+=;/.test(c));
    expect(added).toHaveLength(1);
    expect(cleared.length).toBeGreaterThanOrEqual(1);   // the surplus is being cleared
  });
});

describe('roles', () => {
  it('ADMIN_EMAILS grants CampaignAdmin (case-insensitive) and lands on /admin', async () => {
    const { callback, agent } = await signIn({ claims: { oid: OID, preferred_username: 'BOSS@namra.org.na' } });
    expect(callback.headers.location).toBe('/admin');
    expect((await agent.get('/api/session')).body.user.roles).toEqual(['CampaignAdmin']);
    await agent.get('/api/campaigns/mine').expect(200);
    const second = await signIn({ claims: { oid: OID2, preferred_username: 'other.admin@namra.org.na' } });
    expect((await second.agent.get('/api/session')).body.user.roles).toEqual(['CampaignAdmin']);
  });

  it('a `roles` claim containing CampaignAdmin grants admin even when the email is not listed', async () => {
    const { callback, agent } = await signIn({ claims: { oid: OID, preferred_username: 'it.assigned@namra.org.na', roles: ['Something', 'CampaignAdmin'] } });
    expect(callback.headers.location).toBe('/admin');
    expect((await agent.get('/api/session')).body.user.roles).toEqual(['CampaignAdmin']);
  });

  it('a non-admin cannot reach admin routes, and an unrelated roles claim grants nothing', async () => {
    const { agent } = await signIn({ claims: { oid: OID, preferred_username: 'plain@namra.org.na', roles: ['Reader'] } });
    expect((await agent.get('/api/session')).body.user.roles).toEqual([]);
    await agent.get('/api/campaigns/mine').expect(403);
    const s = await asSession(agent);
    await s.post('/api/campaigns').send({ title: 'Sneaky' }).expect(403);
  });
});

describe('next and forged identity', () => {
  it('keeps a safe next, ignores an unsafe one', async () => {
    const token = 'x'.repeat(32);
    expect((await signIn({ next: `/v/${token}` })).callback.headers.location).toBe(`/v/${token}`);
    for (const bad of ['//evil.com', 'https://evil.com/admin', '/\\evil.com', 'javascript:alert(1)', '/not-allowed', '/v/ok\r\nSet-Cookie: x=y']) {
      const r = await signIn({ next: bad });
      expect(r.callback.headers.location, bad).toBe('/votes');
    }
    // admin default
    expect((await signIn({ next: '//evil.com', claims: { preferred_username: ADMIN_EMAIL } })).callback.headers.location).toBe('/admin');
  });

  it('a forged identity in the body, query string or headers is ignored; the picker routes do not exist', async () => {
    const { agent } = await signIn({ claims: { oid: OID, preferred_username: 'plain@namra.org.na' } });
    const forged = (r: request.Test) => r.set('X-User-Email', ADMIN_EMAIL).set('X-Forwarded-Email', ADMIN_EMAIL).set('Cf-Access-Authenticated-User-Email', ADMIN_EMAIL)
      .set('Cf-Access-Jwt-Assertion', 'a.b.c').set('X-Auth-Request-Email', ADMIN_EMAIL).set('Authorization', `Bearer ${ADMIN_EMAIL}`);
    const me = await forged(agent.get(`/api/session?email=${ADMIN_EMAIL}&roles=CampaignAdmin`)).expect(200);
    expect(me.body.user).toMatchObject({ email: 'plain@namra.org.na', roles: [] });
    await forged(agent.get(`/api/campaigns/mine?email=${ADMIN_EMAIL}`)).expect(403);
    const s = await asSession(agent);
    await s.post('/api/dev/login').send({ oid: OID2, email: ADMIN_EMAIL, displayName: 'Boss', roles: ['CampaignAdmin'] }).expect(404);
    await agent.get('/api/dev/users').expect(404);
    // a stranger with only forged headers is simply signed out
    await forged(request(app).get('/api/campaigns/mine')).expect(401);
    expect((await forged(request(app).get('/api/session')).expect(200)).body.user).toBeNull();
  });

  it('a tampered session cookie is not a login', async () => {
    const { callback } = await signIn({ claims: { preferred_username: ADMIN_EMAIL } });
    const c = sessionCookie(callback)!.split(';')[0];
    const [id, mac] = decodeURIComponent(c.split('=')[1]).split('.');
    const other = `${id.slice(0, -1)}${id.endsWith('A') ? 'B' : 'A'}.${mac}`;      // another id with the old mac
    expect((await request(app).get('/api/session').set('Cookie', `namra_session=${encodeURIComponent(other)}`)).body.user).toBeNull();
    expect((await request(app).get('/api/session').set('Cookie', `namra_session=${encodeURIComponent(id + '.' + mac.slice(0, -1) + 'x')}`)).body.user).toBeNull();
    // control: the real cookie works
    expect((await request(app).get('/api/session').set('Cookie', `namra_session=${encodeURIComponent(id + '.' + mac)}`)).body.user).not.toBeNull();
  });
});

describe('sign out (SEC-14: POST + CSRF, never a GET)', () => {
  it('POST /api/logout revokes the session on the server and returns the Microsoft sign-out address, returning to the site root', async () => {
    const { agent, callback } = await signIn();
    expect((await agent.get('/api/session')).body.user).not.toBeNull();
    const copied = sessionCookie(callback)!.split(';')[0];                      // a copy of the cookie, as an attacker might hold
    const s = await asSession(agent);
    const r = await s.post('/api/logout').expect(200);
    const u = new URL(r.body.redirect);
    expect(u.origin + u.pathname).toBe(`${idp.base}/${TENANT}/oauth2/v2.0/logout`);
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('https://app.test/');
    expect((r.headers['set-cookie'] as unknown as string[]).some((c) => /namra_session=;/.test(c))).toBe(true);
    expect((await agent.get('/api/session')).body.user).toBeNull();
    expect((await request(app).get('/api/session').set('Cookie', copied)).body.user).toBeNull();   // SEC-06: the copied cookie is dead too
  });

  it('a GET to /auth/logout (an image tag on another site) signs nobody out; it just lands on the site root', async () => {
    const { agent } = await signIn();
    const r = await agent.get('/auth/logout').expect(302);
    expect(r.headers.location).toBe('/');
    expect((r.headers['set-cookie'] as unknown as string[] | undefined) ?? []).toEqual([]);
    expect((await agent.get('/api/session')).body.user).not.toBeNull();
  });

  it('POST /api/logout without a valid CSRF token is refused and the session stays', async () => {
    const { agent } = await signIn();
    await agent.post('/api/logout').expect(403);
    await agent.post('/api/logout').set('x-csrf-token', 'a.b').expect(403);
    expect((await agent.get('/api/session')).body.user).not.toBeNull();
  });
});
