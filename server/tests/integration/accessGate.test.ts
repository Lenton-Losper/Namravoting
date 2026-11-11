import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Config is read once per module graph: switch this file to demo mode BEFORE importing the app.
process.env.AUTH_MODE = 'demo';
process.env.CF_ACCESS_TEAM_DOMAIN = 'testteam';
process.env.CF_ACCESS_AUD = 'aud-123';

const TEAM = 'testteam.cloudflareaccess.com';
const AUD = 'aud-123';
let app: import('express').Express;
let closePool: () => Promise<void>;
let key: CryptoKey;
let otherKey: CryptoKey;

async function token(o: { key?: CryptoKey; aud?: string; iss?: string; exp?: string | number; kid?: string } = {}) {
  return new SignJWT({ email: 'someone@namra.org.na' })
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? 'k1' })
    .setIssuer(o.iss ?? `https://${TEAM}`).setAudience(o.aud ?? AUD).setIssuedAt()
    .setExpirationTime(o.exp ?? '10m').sign(o.key ?? key);
}

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  key = kp.privateKey;
  otherKey = (await generateKeyPair('RS256')).privateKey;
  const pub: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const { createAccessVerifier } = await import('../../src/auth/access.js');
  const { createApp } = await import('../../src/app.js');
  closePool = (await import('../../src/db.js')).closePool;
  app = createApp({ accessVerifier: createAccessVerifier({ teamDomain: 'testteam', aud: AUD, keys: createLocalJWKSet({ keys: [pub] }) }) });
});
afterAll(async () => { await closePool(); });

const PATHS = ['/', '/index.html', '/login', '/api/session', '/api/csrf', '/api/dev/users', '/api/campaigns/mine', '/api/vote', '/fonts/inter.woff2', '/nope'];

describe('Cloudflare Access gate (AUTH_MODE=demo)', () => {
  it('POSITIVE CONTROL: a valid token reaches the app and IS the login (identity = the token email)', async () => {
    const t = await token();
    const s = await request(app).get('/api/session').set('Cf-Access-Jwt-Assertion', t).expect(200);
    expect(s.body.authMode).toBe('demo');
    expect(s.body.user.email).toBe('someone@namra.org.na');
    await request(app).get('/api/vote').set('Cf-Access-Jwt-Assertion', t).expect(200);   // no separate app login needed
  });

  it('missing header: 403 on every path (static files and API), before anything else runs', async () => {
    for (const p of PATHS) {
      const r = await request(app).get(p);
      expect(r.status, p).toBe(403);
      expect(r.text, p).toBe('Forbidden');
      expect(r.headers['content-security-policy'], `${p}: helmet must not have run (the gate is first)`).toBeUndefined();
      expect(r.headers['set-cookie'], `${p}: the CSRF middleware must not have run`).toBeUndefined();
    }
    await request(app).post('/api/logout').send({}).expect(403);
    await request(app).put('/api/campaigns/x/eligible').send({}).expect(403);
  });

  const BAD: [string, () => Promise<string>][] = [
    ['wrong audience', () => token({ aud: 'some-other-app' })],
    ['wrong issuer (another team)', () => token({ iss: 'https://evil.cloudflareaccess.com' })],
    ['expired', () => token({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ['bad signature (a different key, same kid)', () => token({ key: otherKey })],
    ['unknown key id', () => token({ kid: 'not-published' })],
    ['HS256 forgery', async () => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setIssuer(`https://${TEAM}`).setAudience(AUD).setExpirationTime('10m').sign(new TextEncoder().encode('secret-secret-secret-secret-secret!!'))],
    ['unsigned (alg none)', async () => {
      const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return `${b({ alg: 'none' })}.${b({ iss: `https://${TEAM}`, aud: AUD, exp: Math.floor(Date.now() / 1000) + 600 })}.`;
    }],
    ['garbage', async () => 'not.a.jwt'],
    ['empty', async () => ''],
  ];
  it.each(BAD)('%s: 403 and nothing else runs', async (_name, make) => {
    const t = await make();
    for (const p of ['/', '/api/session', '/api/dev/users']) {
      const r = await request(app).get(p).set('Cf-Access-Jwt-Assertion', t);
      expect(r.status, p).toBe(403);
      expect(r.text).toBe('Forbidden');
      expect(r.headers['content-security-policy']).toBeUndefined();
    }
    await request(app).post('/api/logout').set('Cf-Access-Jwt-Assertion', t).send({}).expect(403);
  });

  it('the app\'s own cookies are not a substitute for the Access header', async () => {
    const t = await token();
    const agent = request.agent(app);
    await agent.get('/api/csrf').set('Cf-Access-Jwt-Assertion', t).expect(200);   // the agent now holds app cookies
    await agent.get('/api/session').expect(403);
  });
});
