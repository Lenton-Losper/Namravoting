// BASE_PATH: the app served under a path (e.g. /voting-app) behind a reverse proxy that forwards the path unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { dbClientConfig } from '../../src/db.js';
import { normalizeBasePath, parseConfig, parseTrustProxy } from '../../src/config.js';

const ENV = { NODE_ENV: 'test', AUTH_MODE: 'dev', ALLOW_DEV_AUTH: 'true', SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@localhost/db', PUBLIC_BASE_URL: 'https://voting.example.org' };

describe('normalizeBasePath', () => {
  it.each([['', ''], ['/', ''], ['  ', ''], ['/voting-app', '/voting-app'], ['/voting-app/', '/voting-app'], ['/a/b', '/a/b']])('%j -> %j', (raw, want) => {
    expect(normalizeBasePath(raw)).toBe(want);
  });
  it.each(['voting-app', '//evil.com', '/a//b', '/a b', '/../x', '/a/..', '/a?x=1', '/a#x', '/a\\b', 'http://x/y'])('rejects %j', (raw) => {
    expect(() => normalizeBasePath(raw)).toThrow(/BASE_PATH/);
  });
});

describe('config with a base path', () => {
  it('has no base path by default and leaves PUBLIC_BASE_URL alone', () => {
    const c = parseConfig(ENV);
    expect(c.basePath).toBe('');
    expect(c.publicBaseUrl).toBe('https://voting.example.org');
  });
  it('puts the base path into every public link, whether or not PUBLIC_BASE_URL already has it', () => {
    expect(parseConfig({ ...ENV, BASE_PATH: '/voting-app' }).publicBaseUrl).toBe('https://voting.example.org/voting-app');
    expect(parseConfig({ ...ENV, BASE_PATH: '/voting-app', PUBLIC_BASE_URL: 'https://voting.example.org/voting-app/' }).publicBaseUrl).toBe('https://voting.example.org/voting-app');
  });
  it('requires the Entra redirect URI to carry the base path', () => {
    const entra = { ...ENV, AUTH_MODE: 'entra', ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111', ENTRA_CLIENT_ID: '22222222-2222-2222-2222-222222222222', ENTRA_CLIENT_SECRET: 's'.repeat(20) };
    expect(parseConfig({ ...entra, BASE_PATH: '/voting-app', ENTRA_REDIRECT_URI: 'https://voting.example.org/voting-app/auth/callback' }).entra?.redirectUri).toBe('https://voting.example.org/voting-app/auth/callback');
    expect(() => parseConfig({ ...entra, BASE_PATH: '/voting-app', ENTRA_REDIRECT_URI: 'https://voting.example.org/auth/callback' })).toThrow('/voting-app/auth/callback');
    expect(() => parseConfig({ ...entra, ENTRA_REDIRECT_URI: 'https://voting.example.org/voting-app/auth/callback' })).toThrow('/auth/callback');
  });
});

describe('TRUST_PROXY', () => {
  it('is off unless set, takes a hop count or addresses, and never plain true', () => {
    expect(parseConfig(ENV).trustProxy).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('loopback, 10.0.0.0/8')).toBe('loopback, 10.0.0.0/8');
    expect(parseTrustProxy('0')).toBe(false);
    expect(() => parseTrustProxy('true')).toThrow(/TRUST_PROXY/);
    expect(() => parseTrustProxy('a;b')).toThrow(/TRUST_PROXY/);
  });
});

describe('the app mounted under /voting-app', () => {
  process.env.BASE_PATH = '/voting-app';
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'namra-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><script type="module" src="/voting-app/assets/app.js"></script></head><body><div id="root"></div></body></html>');
  fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
  afterAll(() => fs.rmSync(dist, { recursive: true, force: true }));

  it('serves the client, its assets and a deep link below the base path; nothing outside it', async () => {
    const { createApp } = await import('../../src/app.js');
    const app = createApp({ clientDist: dist });
    expect((await request(app).get('/voting-app/')).text).toContain('/voting-app/assets/app.js');
    expect((await request(app).get('/voting-app/v/some-token')).status).toBe(200);          // history fallback for the router
    expect((await request(app).get('/voting-app/assets/app.js')).status).toBe(200);
    expect((await request(app).get('/assets/app.js')).status).toBe(404);                    // not served at the root of the host
    expect((await request(app).get('/api/csrf')).status).toBe(404);
    const root = await request(app).get('/');
    expect(root.status).toBe(302); expect(root.headers.location).toBe('/voting-app/');
  });

  it('scopes cookies to the base path', async () => {
    const { createApp } = await import('../../src/app.js');
    const res = await request(createApp({ clientDist: dist })).get('/voting-app/api/csrf');
    expect(res.status).toBe(200);
    expect(String(res.headers['set-cookie'])).toMatch(/Path=\/voting-app(;|$)/i);
  });

  it('answers the health check under the base path', async () => {
    const { createApp } = await import('../../src/app.js');
    const { closePool } = await import('../../src/db.js');
    const res = await request(createApp({ clientDist: dist })).get('/voting-app/api/health');
    expect(res.status).toBe(200); expect(res.body).toEqual({ ok: true });
    await closePool();
  });

  it('refuses to start when the client was built for a different base path', async () => {
    const { createApp, builtClientBase } = await import('../../src/app.js');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'namra-dist-'));
    fs.writeFileSync(path.join(other, 'index.html'), '<script src="/assets/app.js"></script>');
    try {
      expect(builtClientBase(other)).toBe('');
      expect(builtClientBase(dist)).toBe('/voting-app');
      expect(() => createApp({ clientDist: other })).toThrow(/built for ""/);
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });
});

describe('DB_TLS', () => {
  const url = 'postgres://u:p@db.internal:5432/namra?sslmode=require';
  it('keeps verified TLS for a remote database by default', () => {
    const c = dbClientConfig(url, {});
    expect(c.ssl).toMatchObject({ rejectUnauthorized: true });
  });
  it('only DB_TLS=off (an environment variable) switches it off, and drops ssl parameters from the URL', () => {
    const c = dbClientConfig(url, { DB_TLS: 'off' });
    expect(c.ssl).toBeUndefined();
    expect(c.connectionString).not.toMatch(/sslmode/);
    expect(dbClientConfig('postgres://u:p@db.internal/namra?sslmode=disable', {}).ssl).toMatchObject({ rejectUnauthorized: true });   // a URL cannot weaken it
  });
});
