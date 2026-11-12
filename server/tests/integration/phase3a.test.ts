import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { parseConfig } from '../../src/config.js';
import { ADMIN_A, S1, S2, closeOwner, login, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

describe('SEC-13: dev auth is an explicit opt-in and stays on this machine', () => {
  const base = { SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://a@localhost/x' };
  it('refuses to start in dev mode without ALLOW_DEV_AUTH=true, and when nothing at all is set', () => {
    expect(() => parseConfig({ ...base })).toThrow(/needs ALLOW_DEV_AUTH=true/);                                   // forgot AUTH_MODE and NODE_ENV
    expect(() => parseConfig({ ...base, AUTH_MODE: 'dev', NODE_ENV: 'development' })).toThrow(/ALLOW_DEV_AUTH/);
    expect(() => parseConfig({ ...base, AUTH_MODE: 'dev', ALLOW_DEV_AUTH: 'false' })).toThrow(/ALLOW_DEV_AUTH/);
    expect(parseConfig({ ...base, AUTH_MODE: 'dev', ALLOW_DEV_AUTH: 'true' }).authMode).toBe('dev');
  });
  it('production never allows it, even with the opt-in', () => {
    expect(() => parseConfig({ ...base, AUTH_MODE: 'dev', NODE_ENV: 'production', ALLOW_DEV_AUTH: 'true' })).toThrow(/not allowed when NODE_ENV=production/);
  });
  it('dev mode listens on localhost only, unless the LAN script says otherwise; other modes listen on all interfaces', () => {
    expect(parseConfig({ ...base, AUTH_MODE: 'dev', ALLOW_DEV_AUTH: 'true' }).bindHost).toBe('127.0.0.1');
    expect(parseConfig({ ...base, AUTH_MODE: 'dev', ALLOW_DEV_AUTH: 'true', DEV_LAN: 'true' }).bindHost).toBe('0.0.0.0');
    const entra = { ...base, AUTH_MODE: 'entra', NODE_ENV: 'production', ENTRA_TENANT_ID: 'fe7b029e-7e19-4525-bdf4-57462a59d299', ENTRA_CLIENT_ID: '281ab38e-9ff5-4f17-88ea-18bdc3e65457', ENTRA_CLIENT_SECRET: 's', ENTRA_REDIRECT_URI: 'https://a.test/auth/callback' };
    expect(parseConfig(entra).bindHost).toBe('0.0.0.0');
  });
});

describe('SEC-15: the CSRF token is bound to the session', () => {
  const mint = async (agent: ReturnType<typeof request.agent>) => (await agent.get('/api/csrf')).body.token as string;

  it('a token minted before sign-in stops working once there is a session; a fresh one works', async () => {
    const agent = request.agent(app);
    const early = await mint(agent);
    await agent.post('/api/dev/login').set('x-csrf-token', early).send(S1).expect(200);       // anonymous binding is fine for login itself
    expect((await agent.post('/api/logout').set('x-csrf-token', early)).status).toBe(403);   // ... but not for the signed-in session
    const fresh = await mint(agent);
    await agent.post('/api/logout').set('x-csrf-token', fresh).expect(204);
  });

  it('a token minted for one session is refused on another session, even if the attacker plants it as the cookie too', async () => {
    const a = request.agent(app); const b = request.agent(app);
    const ta0 = await mint(a); const tb0 = await mint(b);   // mint first: the agent snapshots its cookies when the request is created
    await a.post('/api/dev/login').set('x-csrf-token', ta0).send(ADMIN_A).expect(200);
    await b.post('/api/dev/login').set('x-csrf-token', tb0).send(S2).expect(200);
    const tokenOfA = await mint(a);
    // session b presents A's token in the header while its own cookie jar is overwritten with the same token
    const r = await b.post('/api/logout').set('Cookie', `namra_csrf=${encodeURIComponent(tokenOfA)}`).set('x-csrf-token', tokenOfA);
    expect(r.status).toBe(403);
    // b's own token still works
    const tb1 = await mint(b);
    await b.post('/api/logout').set('x-csrf-token', tb1).expect(204);
  });

  it('signed-in users still do everything normally (the helper fetches the token after sign-in)', async () => {
    const s = await login(app, ADMIN_A);
    await s.post('/api/campaigns').send({ title: 'bound token works' }).expect(201);
  });

  it('control: a tampered token never works', async () => {
    const other = request.agent(app);
    const t2 = await mint(other);
    await other.post('/api/dev/login').set('x-csrf-token', t2.slice(0, -2) + 'xx').send(S1).expect(403);
  });
});
