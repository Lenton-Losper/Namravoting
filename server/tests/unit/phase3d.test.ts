import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toContainerRequest } from '../../../worker/src/forward.js';
import { parseJsonc, planDeploy } from '../../../scripts/deploy-plan.mjs';
import { dbClientConfig } from '../../src/db.js';
import { matchBasis, parseConfirmedReport, reportCsv, type GraphUser, type MatchResult } from '../../src/umoja/match.js';

describe('SEC-25: the Worker, not the client, decides the forwarding headers', () => {
  it('drops everything a client sent in X-Forwarded-*, Forwarded and X-Real-IP, and sets its own', () => {
    const r = toContainerRequest(new Request('https://vote.example.org/api/x?a=1', {
      headers: {
        'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http', 'x-forwarded-for': '6.6.6.6', 'x-forwarded-port': '1',
        forwarded: 'for=6.6.6.6;host=evil.example', 'x-real-ip': '6.6.6.6', 'x-original-url': '/admin', 'cf-connecting-ip': '203.0.113.9',
      },
    }));
    expect(r.headers.get('x-forwarded-host')).toBe('vote.example.org');
    expect(r.headers.get('x-forwarded-proto')).toBe('https');
    expect(r.headers.get('x-forwarded-for')).toBe('203.0.113.9');            // the address Cloudflare recorded, not the client's claim
    for (const h of ['forwarded', 'x-real-ip', 'x-forwarded-port', 'x-original-url']) expect(r.headers.get(h), h).toBeNull();
    expect(r.headers.get('cf-connecting-ip')).toBe('203.0.113.9');
  });
  it('with no CF-Connecting-IP there is no X-Forwarded-For at all (a client value never survives)', () => {
    const r = toContainerRequest(new Request('https://vote.example.org/', { headers: { 'x-forwarded-for': '6.6.6.6' } }));
    expect(r.headers.get('x-forwarded-for')).toBeNull();
    expect(r.headers.get('x-forwarded-host')).toBe('vote.example.org');
  });
});

describe('SEC-26: TLS to a remote database is always on and always verified', () => {
  const neon = 'postgresql://owner:pw@ep-x.c-8.eu-central-1.aws.neon.tech/namra?sslmode=require&channel_binding=require';
  it('remote hosts get rejectUnauthorized: true with the host name checked, whatever the URL says', () => {
    for (const q of ['sslmode=require', 'sslmode=disable', 'sslmode=no-verify', 'sslmode=allow&ssl=false', 'sslmode=verify-full&sslrootcert=/tmp/x.pem']) {
      const c = dbClientConfig(`postgres://u:p@db.example.com:5432/x?${q}`, {});
      expect(c.ssl, q).toEqual({ rejectUnauthorized: true, servername: 'db.example.com' });
      expect(c.connectionString, q).not.toMatch(/ssl/i);                       // the URL cannot override it
    }
    const n = dbClientConfig(neon, {});
    expect(n.ssl).toMatchObject({ rejectUnauthorized: true, servername: 'ep-x.c-8.eu-central-1.aws.neon.tech' });
    expect(n.connectionString).toContain('channel_binding=require');           // unrelated parameters are kept
    expect(n.connectionString).not.toContain('sslmode');
  });
  it('a CA (inline PEM or a file) can be pinned with DB_SSL_CA', () => {
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect((dbClientConfig(neon, { DB_SSL_CA: pem }).ssl as { ca?: string }).ca).toBe(pem);
    const f = path.join(fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'ca-')), 'ca.pem');
    fs.writeFileSync(f, pem);
    expect((dbClientConfig(neon, { DB_SSL_CA: f }).ssl as { ca?: string }).ca).toBe(pem);
  });
  it('control: this machine is not forced onto TLS (local development and the test database)', () => {
    for (const u of ['postgres://a:b@localhost:5433/x', 'postgres://a:b@127.0.0.1/x', 'postgres://a:b@[::1]:5432/x']) expect(dbClientConfig(u, {})).toEqual({ connectionString: u });
    expect(dbClientConfig('not a url', {})).toEqual({ connectionString: 'not a url' });
  });
});

describe('SEC-23: the deploy script only asks for, and sends, what the active mode needs', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'a', CLOUDFLARE_API_TOKEN: 't', DEMO_DATABASE_URL: 'postgres://x', DEMO_SESSION_SECRET: 's'.repeat(40),
    R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 'v', R2_ENDPOINT: 'https://r2', ENTRA_CLIENT_SECRET: 'e', CF_ACCESS_AUD: 'aud', DEMO_USERS: '{}',
  };
  const entra = { NODE_ENV: 'production', AUTH_MODE: 'entra' };

  it('entra: needs the Entra secret, does NOT need (or send) the demo-only secrets', () => {
    const { DEMO_USERS: _d, CF_ACCESS_AUD: _a, ...noDemo } = env;
    const p = planDeploy(noDemo, entra);
    expect(p.problems).toEqual([]);
    expect(p.names).toEqual(['DATABASE_URL', 'ENTRA_CLIENT_SECRET', 'R2_ACCESS_KEY_ID', 'R2_ENDPOINT', 'R2_SECRET_ACCESS_KEY', 'SESSION_SECRET']);
    expect(planDeploy(env, entra).names).not.toContain('DEMO_USERS');           // present in .env, still not sent
    expect(planDeploy(env, entra).names).not.toContain('CF_ACCESS_AUD');
  });
  it('demo: needs CF_ACCESS_AUD and DEMO_USERS, not the Entra secret', () => {
    const { ENTRA_CLIENT_SECRET: _e, ...noEntra } = env;
    const p = planDeploy(noEntra, { NODE_ENV: 'production', AUTH_MODE: 'demo' });
    expect(p.problems).toEqual([]);
    expect(p.names).toEqual(expect.arrayContaining(['CF_ACCESS_AUD', 'DEMO_USERS']));
    expect(p.names).not.toContain('ENTRA_CLIENT_SECRET');
  });
  it('names what is missing, and never generates a secret: a missing session secret is a problem, not a surprise', () => {
    const { DEMO_SESSION_SECRET: _s, ENTRA_CLIENT_SECRET: _e, ...rest } = env;
    const p = planDeploy(rest, entra);
    expect(p.problems).toEqual(expect.arrayContaining(['DEMO_SESSION_SECRET is missing from .env', 'ENTRA_CLIENT_SECRET is missing from .env']));
    expect(planDeploy({ ...env, DEMO_SESSION_SECRET: 'short' }, entra).problems).toContain('DEMO_SESSION_SECRET must be at least 32 characters');
  });
  it('refuses a config that would deploy dev settings', () => {
    expect(planDeploy(env, { NODE_ENV: 'production', AUTH_MODE: 'dev' }).problems.join()).toMatch(/never the dev identity picker/);
    expect(planDeploy(env, { NODE_ENV: 'production' }).problems.join()).toMatch(/AUTH_MODE/);
    expect(planDeploy(env, { NODE_ENV: 'development', AUTH_MODE: 'entra' }).problems.join()).toMatch(/NODE_ENV to "production"/);
    expect(planDeploy(env, { ...entra, ALLOW_DEV_AUTH: 'true' }).problems.join()).toMatch(/ALLOW_DEV_AUTH/);
    expect(planDeploy(env, undefined).problems.length).toBeGreaterThan(0);
  });
  it('optional rotation secrets ride along only when present; the API token is not needed with OAuth login', () => {
    expect(planDeploy({ ...env, SESSION_SECRET_PREVIOUS: 'p'.repeat(40), CSRF_SECRET: 'c'.repeat(40) }, entra).names).toEqual(expect.arrayContaining(['SESSION_SECRET_PREVIOUS', 'CSRF_SECRET']));
    const { CLOUDFLARE_API_TOKEN: _t, ...noToken } = env;
    expect(planDeploy(noToken, entra).problems).toContain('CLOUDFLARE_API_TOKEN is missing from .env');
    expect(planDeploy({ ...noToken, WRANGLER_OAUTH: '1' }, entra).problems).toEqual([]);
  });
  it('the real worker/wrangler.jsonc parses (comments and all) and is deployable in its mode', () => {
    const w = parseJsonc(fs.readFileSync(path.resolve(import.meta.dirname, '../../../worker/wrangler.jsonc'), 'utf8'));
    expect(w.vars.AUTH_MODE).toBe('entra');
    expect(w.vars.NODE_ENV).toBe('production');
    expect(w.observability.logs.invocation_logs).toBe(false);                  // SEC-19: no per-request URL logs
    expect(planDeploy(env, w.vars).problems).toEqual([]);
  });
  it('parseJsonc handles comments, strings that contain slashes, and trailing commas', () => {
    expect(parseJsonc('{ // c\n "a": "http://x//y", /* b */ "b": [1,2,], }')).toEqual({ a: 'http://x//y', b: [1, 2] });
  });
});

describe('SEC-22: matching by name needs a human to confirm', () => {
  const u = (o: Partial<GraphUser>): GraphUser => ({ id: 'id', displayName: null, givenName: null, surname: null, mail: null, userPrincipalName: null, ...o });
  const OID1 = '0f1d2c3b-4a59-4687-8795-a4b3c2d1e0f9'; const OID2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'; const OID3 = '11111111-2222-4333-8444-555555555555';
  const row = (code: string, status: string, oid: string, confirm: string, email = 'x@namra.org.na') => `${code},Some Name,${status},${email},${oid},given_surname,1,,${confirm}`;
  const sheet = (...rows: string[]) => ['code,member_name,status,matched_email,oid,basis,candidates,other_candidates,confirm', ...rows].join('\n') + '\n';

  it('says how a match was made: whole display name, or first name + surname', () => {
    expect(matchBasis('Ruth Kandjii', u({ displayName: 'Ruth Kandjii' }))).toBe('exact_name');
    expect(matchBasis('Ruth Anna Kandjii', u({ displayName: 'R. Kandjii', givenName: 'Ruth', surname: 'Kandjii' }))).toBe('given_surname');
    expect(matchBasis('Ruth Kandjii', u({ displayName: 'Ruth K', givenName: 'Ruth', surname: 'Kandjian' }))).toBeNull();
  });

  it('only rows a human marked yes are returned: blank, no, and not-matched rows never are', () => {
    const r = parseConfirmedReport(sheet(
      row('NAM0001', 'matched', OID1, 'yes'), row('NAM0002', 'matched', OID2, ''), row('NAM0003', 'matched', OID3, 'no'),
      row('NAM0004', 'ambiguous', OID3, 'yes'), row('NAM0005', 'not_found', OID3, 'YES')));
    expect(r.confirmed.map((x) => x.code)).toEqual(['NAM0001']);
    expect(r.ignored).toBe(2);
    expect(r.rejected.map((x) => x.code).sort()).toEqual(['NAM0004', 'NAM0005']);   // a "yes" on an ambiguous or not-found row is refused
  });

  it('rejects malformed codes and account ids, and rows that claim the same account or the same member twice', () => {
    const r = parseConfirmedReport(sheet(
      row('NAM0001', 'matched', OID1, 'yes'), row('NAM0002', 'matched', OID1, 'yes'),       // same account for two members
      row('NAM0003', 'matched', 'not-a-guid', 'yes'), row('BAD1', 'matched', OID2, 'yes'),
      row('NAM0009', 'matched', OID2, 'yes'), row('NAM0009', 'matched', OID3, 'yes')));    // same member twice
    expect(r.confirmed).toEqual([]);
    expect(r.rejected.length).toBe(6);
  });

  it('refuses a report that is not the one the script wrote', () => {
    expect(() => parseConfirmedReport('a,b\n1,2\n')).toThrow(/no "code" column/);
  });

  it('the report the matcher writes has an empty confirm column, so nothing is applied until a person fills it in', () => {
    const res: MatchResult = { code: 'NAM0001', name: 'Ruth Kandjii', active: true, status: 'matched', oid: OID1, email: 'ruth@namra.org.na', candidates: 1, basis: 'exact_name' };
    const csv = reportCsv([res]);
    expect(parseConfirmedReport(csv).confirmed).toEqual([]);
    expect(parseConfirmedReport(csv.replace(/,\n$/, ',yes\n')).confirmed.map((x) => x.code)).toEqual(['NAM0001']);
  });
});
