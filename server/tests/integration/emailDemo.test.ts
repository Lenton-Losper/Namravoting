// AUTH_MODE=email-demo (DEMO ONLY): sign in by typing an email address. No code and no password, for admins too.
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeOwner, ownerDb, resetDb } from '../helpers.js';
import { parseConfig } from '../../src/config.js';

// Config is read once per module graph: switch this file to email-demo BEFORE importing the app.
const ADMIN = 'lenton.losper@namra.org.na';
const GMAIL = 'llosperofficial@gmail.com';
process.env.AUTH_MODE = 'email-demo';
delete process.env.ADMIN_DEMO_PASSWORD;   // it no longer exists: email-demo must start without it
process.env.DEMO_USERS = JSON.stringify({
  [ADMIN]: { displayName: 'Lenton Losper', roles: ['CampaignAdmin'], employeeCode: 'TST0026' },
  [GMAIL]: { displayName: 'Lenton Losper (Gmail)', roles: ['CampaignAdmin'], employeeCode: 'TST0027' },
});

let app: import('express').Express;
let closePool: () => Promise<void>;
let ip = 0;
/** A browser at its own client address (the per-address sign-in limit is tested on purpose below). */
async function browser(addr = `203.0.113.${++ip}`) {
  const agent = request.agent(app);
  const h = (r: request.Test) => r.set('cf-connecting-ip', addr);
  let csrf = (await h(agent.get('/api/csrf'))).body.token as string;
  return {
    /** Signs in and checks the status: `await b.signIn(email).expect(200)`. */
    signIn: (email: string) => ({
      expect: async (status: number) => {
        const r = await h(agent.post('/api/email-login').set('x-csrf-token', csrf)).send({ email });
        expect(r.status, JSON.stringify(r.body)).toBe(status);
        if (r.status === 200) csrf = (await h(agent.get('/api/csrf'))).body.token as string;   // the token is bound to the new session
        return r;
      },
    }),
    get: (u: string) => h(agent.get(u)),
    post: (u: string) => h(agent.post(u).set('x-csrf-token', csrf)),
  };
}

beforeAll(async () => {
  const { createApp } = await import('../../src/app.js');
  closePool = (await import('../../src/db.js')).closePool;
  app = createApp();
});
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });
const audits = async (action: string) => (await ownerDb().query('SELECT actor_oid, details FROM audit_log WHERE action = $1 ORDER BY seq', [action])).rows;

describe('email-demo sign-in', () => {
  it('signs a NamRA address in as itself (trimmed, lower-cased), in a database session, and audits it with the email', async () => {
    const b = await browser();
    const r = await b.signIn('  Sam.Staff@NamRA.org.na ').expect(200);
    expect(r.body.user).toMatchObject({ email: 'sam.staff@namra.org.na', roles: [] });
    const s = (await b.get('/api/session').expect(200)).body;
    expect(s).toMatchObject({ authMode: 'email-demo', user: { email: 'sam.staff@namra.org.na', roles: [] } });
    const sessions = (await ownerDb().query('SELECT s.claim_admin FROM sessions s JOIN users u ON u.entra_oid = s.user_oid WHERE u.email = $1 AND s.revoked_at IS NULL', ['sam.staff@namra.org.na'])).rows;
    expect(sessions).toEqual([{ claim_admin: false }]);
    expect(await audits('auth.signin')).toEqual([{ actor_oid: r.body.user.oid, details: { email: 'sam.staff@namra.org.na', mode: 'email-demo', admin: false } }]);
    await b.get('/api/vote').expect(200);                                        // a signed-in staff member
    await b.get('/api/campaigns/mine').expect(403);                              // but not an admin
  });

  it('refuses addresses outside @namra.org.na (except the listed operator address) and malformed input', async () => {
    const b = await browser();
    expect((await b.signIn('someone@gmail.com').expect(403)).body.code).toBe('email_not_allowed');
    expect((await b.signIn('x@namra.org.na.evil.com').expect(403)).body.code).toBe('email_not_allowed');
    expect((await b.signIn('not an email').expect(400)).body.code).toBe('bad_email');
    await b.post('/api/email-login').send({ email: 'a@namra.org.na', role: 'CampaignAdmin' }).expect(400);   // nothing else is accepted
    await b.get('/api/session').expect(200).then((x) => expect(x.body.user).toBeNull());
  });

  it('admin addresses sign in with just the email too (no password), as admins and members, and it is audited', async () => {
    const b = await browser();
    const ok = await b.signIn(` ${ADMIN.toUpperCase()} `).expect(200);
    expect(ok.body.user).toMatchObject({ email: ADMIN, roles: ['CampaignAdmin'], employeeCode: 'TST0026' });
    await b.get('/api/campaigns/mine').expect(200);
    const g = await browser();
    expect((await g.signIn(GMAIL).expect(200)).body.user).toMatchObject({ email: GMAIL, roles: ['CampaignAdmin'], employeeCode: 'TST0027' });
    await g.get('/api/campaigns/mine').expect(200);
    expect((await audits('auth.signin')).map((a) => a.details)).toEqual([{ email: ADMIN, mode: 'email-demo', admin: true }, { email: GMAIL, mode: 'email-demo', admin: true }]);
    expect(await audits('auth.signin_failed')).toEqual([]);
  });

  it('a password is not part of the sign-in any more: sending one is refused as an unknown field, and gives nobody admin rights', async () => {
    const b = await browser();
    await b.post('/api/email-login').send({ email: 'sam@namra.org.na', password: 'anything' }).expect(400);
    expect((await b.get('/api/session')).body.user).toBeNull();
    expect((await b.signIn('sam@namra.org.na').expect(200)).body.user.roles).toEqual([]);   // staff stay staff
  });

  it('an address that already has an account (e.g. from Microsoft sign-in) keeps that account id and its campaigns', async () => {
    const entraOid = '87a4af90-dd00-48c6-9601-17e56248c9e1';
    await ownerDb().query('INSERT INTO users (entra_oid, email, display_name) VALUES ($1, $2, $3)', [entraOid, ADMIN, 'Lenton (Microsoft)']);
    await ownerDb().query("INSERT INTO campaigns (share_token, created_by, title) VALUES ($1, $2, 'Made with Microsoft sign-in')", ['y'.repeat(32), entraOid]);
    const b = await browser();
    expect((await b.signIn(ADMIN).expect(200)).body.user.oid).toBe(entraOid);
    expect((await b.get('/api/campaigns/mine').expect(200)).body.campaigns.map((c: { title: string }) => c.title)).toEqual(['Made with Microsoft sign-in']);
    expect((await ownerDb().query('SELECT count(*)::int n FROM users WHERE email = $1', [ADMIN])).rows[0].n).toBe(1);
  });

  it('a new address gets a stable id: the same person signing in twice is the same account', async () => {
    const a = (await (await browser()).signIn('new.person@namra.org.na').expect(200)).body.user.oid;
    const b = (await (await browser()).signIn('NEW.person@namra.org.na').expect(200)).body.user.oid;
    expect(a).toBe(b);
  });

  it('is rate limited per client address (10 a minute), whatever the outcome', async () => {
    const b = await browser('198.51.100.7');
    for (let i = 0; i < 10; i++) await b.signIn(`p${i}@gmail.com`).expect(403);
    expect((await b.signIn('ok@namra.org.na').expect(429)).body.code).toBe('rate_limited');
    await (await browser('198.51.100.8')).signIn('ok@namra.org.na').expect(200);                 // another address is not affected
  });

  it('sign-out revokes the database session', async () => {
    const b = await browser();
    await b.signIn('sam@namra.org.na').expect(200);
    await b.post('/api/logout').expect(204);
    expect((await b.get('/api/session')).body.user).toBeNull();
    expect((await ownerDb().query('SELECT count(*)::int n FROM sessions WHERE revoked_at IS NULL')).rows[0].n).toBe(0);
  });

  it('has no identity picker and needs no Cloudflare Access token', async () => {
    const b = await browser();
    await b.get('/api/dev/users').expect(404);
    await b.get('/api/csrf').expect(200);
  });
});

describe('email-demo is refused where it does not belong', () => {
  const base = { SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://x@localhost/x', AUTH_MODE: 'email-demo' };
  it('in production without DEMO=true', () => {
    expect(() => parseConfig({ ...base, NODE_ENV: 'production' })).toThrow(/email-demo.*DEMO=true/);
    expect(parseConfig({ ...base, NODE_ENV: 'production', DEMO: 'true' }).authMode).toBe('email-demo');
  });
  it('starts without any admin password (there is none any more)', () => {
    expect(parseConfig({ ...base }).authMode).toBe('email-demo');
    expect(parseConfig({ ...base, NODE_ENV: 'production', DEMO: 'true' })).not.toHaveProperty('adminDemoPassword');
  });
});
