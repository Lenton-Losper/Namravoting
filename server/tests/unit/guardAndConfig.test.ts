import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { assertImportAllowed, isLocalDatabase } from '../../src/umoja/guard.js';

describe('umoja import guard', () => {
  it('allows local databases', () => {
    for (const u of ['postgres://o:p@localhost:5433/namra', 'postgres://o:p@127.0.0.1/x', 'postgres://o:p@[::1]:5432/x']) {
      expect(isLocalDatabase(u), u).toBe(true);
      expect(() => assertImportAllowed(u, false)).not.toThrow();
    }
  });

  it('refuses remote or unparseable databases unless --allow-remote', () => {
    for (const u of ['postgres://o:p@ep-cool-123.eu-central-1.aws.neon.tech/namra?sslmode=require', 'postgres://o:p@db.example.com/x', 'not a url', '', 'postgres://o:p@localhost.evil.com/x']) {
      expect(() => assertImportAllowed(u, false), u).toThrow(/not localhost/);
      expect(() => assertImportAllowed(u, true), `${u} with flag`).not.toThrow();
    }
  });

  it('the script refuses before reading the file or connecting, and never prints the password', () => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/umoja-import.ts', 'does-not-exist.txt'], {
      cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8',
      env: { ...process.env, MIGRATE_DATABASE_URL: 'postgres://owner:hunter2pw@ep-x.eu-central-1.aws.neon.tech/namra?sslmode=require' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not localhost');
    expect(r.stderr).not.toContain('Cannot read');           // the guard ran before the file was touched
    expect(r.stderr + r.stdout).not.toContain('hunter2pw');
  });
});

const base = { SESSION_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://a@localhost/x', ALLOW_DEV_AUTH: 'true' };

describe('production auth and storage rules', () => {
  it('AUTH_MODE=dev is still refused in production', () => {
    expect(() => parseConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'dev' })).toThrow(/AUTH_MODE=dev is not allowed/);
  });

  it('AUTH_MODE=demo needs both CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD', () => {
    expect(() => parseConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'demo' })).toThrow(/CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD/);
    expect(() => parseConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'demo', CF_ACCESS_TEAM_DOMAIN: 't' })).toThrow(/CF_ACCESS/);
    expect(() => parseConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'demo', CF_ACCESS_AUD: 'a' })).toThrow(/CF_ACCESS/);
    const c = parseConfig({ ...base, NODE_ENV: 'production', AUTH_MODE: 'demo', CF_ACCESS_TEAM_DOMAIN: 't', CF_ACCESS_AUD: 'a' });
    expect(c.access).toEqual({ teamDomain: 't', aud: 'a' });
  });

  it('STORAGE=r2 needs its credentials; the default is disk', () => {
    expect(parseConfig({ ...base }).storage).toBe('disk');
    expect(() => parseConfig({ ...base, STORAGE: 'r2' })).toThrow(/STORAGE=r2 requires/);
    expect(parseConfig({ ...base, STORAGE: 'r2', R2_ENDPOINT: 'https://a.r2.cloudflarestorage.com', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' }).storage).toBe('r2');
  });
});
