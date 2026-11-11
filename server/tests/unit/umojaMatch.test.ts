import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceCodeToken, IT_MESSAGE_PUBLIC_CLIENT, PublicClientDisabled } from '../../src/umoja/graphAuth.js';
import { countResults, createGraphSearch, GraphError, isStrongMatch, matchMembers, normalizeName, reportCsv, searchQueries, type GraphUser } from '../../src/umoja/match.js';
import { runMatchJob } from '../../src/umoja/matchJob.js';
import { parseUmojaExport } from '../../src/umoja/parse.js';

// ---- a tiny fake of Graph /users?$search="displayName:x" AND "displayName:y" (never calls Microsoft) ---------------------------
const strip = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const tokens = (s: string) => strip(s).split(/[\s\-]+/).filter(Boolean);
let n = 0;
const user = (displayName: string, givenName: string | null, surname: string | null, mail?: string): GraphUser =>
  ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, displayName, givenName, surname, mail: mail ?? `${strip(givenName ?? 'x')}.${strip(surname ?? 'y')}@namra.org.na`, userPrincipalName: null });

function fakeGraph(directory: GraphUser[], calls: string[] = []) {
  return (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    expect(u.searchParams.get('$select')).toBe('id,displayName,givenName,surname,mail,userPrincipalName');   // only these fields are ever requested
    calls.push(u.searchParams.get('$search')!);
    const terms = [...u.searchParams.get('$search')!.matchAll(/"displayName:([^"]+)"/g)].map((m) => strip(m[1]));
    const value = directory.filter((d) => terms.every((t) => tokens(d.displayName ?? '').includes(t)));
    return new Response(JSON.stringify({ value }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}
const noSleep = async () => {};
const search = (dir: GraphUser[], calls?: string[]) => createGraphSearch({ token: 'T', fetch: fakeGraph(dir, calls), sleep: noSleep, now: () => 0 });
const member = (code: string, name: string, active = true) => ({ code, name, active });

describe('name normalisation', () => {
  it('lower-cases, trims, collapses spaces, strips accents, treats hyphens and spaces alike', () => {
    expect(normalizeName('  JOSÉ   Álvarez ')).toBe('jose alvarez');
    expect(normalizeName('Smith-Jones')).toBe(normalizeName('smith jones'));
    expect(normalizeName("O'Brien")).toBe('obrien');
    expect(normalizeName(null)).toBe('');
  });
});

describe('strong match rule', () => {
  const u = (d: string | null, g: string | null, s: string | null): GraphUser => ({ id: 'x', displayName: d, givenName: g, surname: s, mail: null, userPrincipalName: null });
  it('given name = first name and surname = any other name (middle names allowed)', () => {
    expect(isStrongMatch('Salinde Biselie Khariseb', u('Salinde Khariseb', 'Salinde', 'Khariseb'))).toBe(true);
    expect(isStrongMatch('Salinde Biselie Khariseb', u('S Biselie', 'Salinde', 'Biselie'))).toBe(true);
  });
  it('multi-word surnames and hyphens are equivalent', () => {
    expect(isStrongMatch('Anna van der Merwe', u('Anna vd Merwe', 'Anna', 'van der Merwe'))).toBe(true);
    expect(isStrongMatch('Anna Smith-Jones', u('x', 'Anna', 'Smith Jones'))).toBe(true);
    expect(isStrongMatch('Anna Smith Jones', u('x', 'Anna', 'Smith-Jones'))).toBe(true);
  });
  it('a full displayName equality counts even without given/surname', () => {
    expect(isStrongMatch('Jane Doe', u('jane  DOE', null, null))).toBe(true);
  });
  it('weaker evidence is not a match: right first name only, right surname only, or a different first name', () => {
    expect(isStrongMatch('Jane Doe', u('Jane Roe', 'Jane', 'Roe'))).toBe(false);
    expect(isStrongMatch('Jane Doe', u('Janet Doe', 'Janet', 'Doe'))).toBe(false);
    expect(isStrongMatch('Jane', u('Jane X', 'Jane', 'X'))).toBe(false);          // a single name never strong-matches on parts
    expect(isStrongMatch('Jane Doe', u('Jane Doe', 'Jane', null))).toBe(true);    // ...but displayName equality still does
  });
  it('builds $search expressions from the member name, most specific first, hyphen parts ANDed, quotes stripped', () => {
    expect(searchQueries('Salinde Biselie Khariseb')).toEqual(['"displayName:Salinde" AND "displayName:Khariseb"', '"displayName:Salinde" AND "displayName:Biselie"']);
    expect(searchQueries('Anna Smith-Jones')).toEqual(['"displayName:Anna" AND "displayName:Smith" AND "displayName:Jones"']);
    expect(searchQueries('Ann "Q" Lee')[0]).not.toMatch(/"displayName:[^"]*"[^ A]/);
    expect(searchQueries('   ')).toEqual([]);
  });
});

describe('matching members to accounts', () => {
  it('middle-name match: "Salinde Biselie Khariseb" -> given Salinde, surname Khariseb', async () => {
    const dir = [user('Salinde Khariseb', 'Salinde', 'Khariseb'), user('Salinde Smith', 'Salinde', 'Smith')];
    const [r] = await matchMembers([member('NAM0001', 'Salinde Biselie Khariseb')], search(dir));
    expect(r).toMatchObject({ status: 'matched', oid: dir[0].id, candidates: 1 });
  });

  it('hyphenated surname: hyphen and space are equivalent on either side', async () => {
    const dir = [user('Anna Smith-Jones', 'Anna', 'Smith-Jones')];
    expect((await matchMembers([member('NAM0001', 'Anna Smith-Jones')], search(dir)))[0]).toMatchObject({ status: 'matched', oid: dir[0].id });
    expect((await matchMembers([member('NAM0001', 'Anna Smith Jones')], search(dir)))[0]).toMatchObject({ status: 'matched', oid: dir[0].id });
    const spaced = [user('Anna Smith Jones', 'Anna', 'Smith Jones')];
    expect((await matchMembers([member('NAM0001', 'Anna Smith-Jones')], search(spaced)))[0]).toMatchObject({ status: 'matched', oid: spaced[0].id });
  });

  it('accent and case differences', async () => {
    const dir = [user('José Álvarez', 'José', 'Álvarez')];
    const [r] = await matchMembers([member('NAM0001', 'JOSE  ALVAREZ')], search(dir));
    expect(r).toMatchObject({ status: 'matched', oid: dir[0].id });
  });

  it('no candidates -> not_found (and a near-miss surname is not a match)', async () => {
    const dir = [user('Jane Roe', 'Jane', 'Roe')];
    const [a, b] = await matchMembers([member('NAM0001', 'Zed Nobody'), member('NAM0002', 'Jane Doe')], search(dir));
    expect(a).toMatchObject({ status: 'not_found', oid: null, candidates: 0 });
    expect(b).toMatchObject({ status: 'not_found', oid: null });
  });

  it('two accounts that both match strongly -> ambiguous; never picks one', async () => {
    const dir = [user('Jane Doe', 'Jane', 'Doe', 'jane.doe@namra.org.na'), user('Jane Doe', 'Jane', 'Doe', 'jane.doe2@namra.org.na')];
    const [r] = await matchMembers([member('NAM0001', 'Jane Doe')], search(dir));
    expect(r).toMatchObject({ status: 'ambiguous', oid: null, email: null, candidates: 2 });
  });

  it('one account claimed by two different codes -> both become conflict, with no oid or email kept', async () => {
    const dir = [user('Jane Doe', 'Jane', 'Doe'), user('Bob Lee', 'Bob', 'Lee')];
    const out = await matchMembers([member('NAM0001', 'Jane Doe'), member('NAM0002', 'Jane Mary Doe'), member('NAM0003', 'Bob Lee')], search(dir));
    expect(out.map((r) => r.status)).toEqual(['conflict', 'conflict', 'matched']);
    expect(out[0]).toMatchObject({ oid: null, email: null });
    expect(countResults(out)).toEqual({ matched: 1, not_found: 0, ambiguous: 0, conflict: 2 });
  });

  it('falls back to the other names only when the most specific query finds nobody, and lower-cases the email', async () => {
    const dir = [user('Salinde Biselie', 'Salinde', 'Biselie', 'Salinde.Biselie@NamRA.org.na')];
    const calls: string[] = [];
    const [r] = await matchMembers([member('NAM0001', 'Salinde Biselie Khariseb')], search(dir, calls));
    expect(calls).toHaveLength(2);
    expect(r).toMatchObject({ status: 'matched', email: 'salinde.biselie@namra.org.na' });
  });

  it('uses mail, then userPrincipalName, for the email', async () => {
    const d = { ...user('Jane Doe', 'Jane', 'Doe'), mail: null, userPrincipalName: 'Jane.Doe@NAMRA.org.na' };
    const [r] = await matchMembers([member('NAM0001', 'Jane Doe')], search([d]));
    expect(r.email).toBe('jane.doe@namra.org.na');
  });
});

describe('Graph client: throttle and 429', () => {
  it('spaces requests at 5 per second', async () => {
    let t = 0; const slept: number[] = [];
    const s = createGraphSearch({ token: 'T', fetch: fakeGraph([]), now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, ratePerSec: 5 });
    for (let i = 0; i < 6; i++) await s('"displayName:a"');
    expect(slept).toEqual([200, 200, 200, 200, 200]);   // the first call goes at once, every later one waits one slot
  });

  it('honours Retry-After on 429, then succeeds', async () => {
    let calls = 0; const slept: number[] = [];
    const f = (async () => (++calls === 1 ? new Response('', { status: 429, headers: { 'retry-after': '7' } }) : new Response(JSON.stringify({ value: [user('Jane Doe', 'Jane', 'Doe')] }), { status: 200 }))) as unknown as typeof fetch;
    const s = createGraphSearch({ token: 'T', fetch: f, sleep: async (ms) => { slept.push(ms); }, now: () => 0 });
    expect(await s('"displayName:Jane"')).toHaveLength(1);
    expect(calls).toBe(2);
    expect(slept).toContain(7000);
  });

  it('gives up after the retry budget, and the error carries no token or response body', async () => {
    const f = (async () => new Response('secret-body-T0KEN', { status: 429, headers: { 'retry-after': '1' } })) as unknown as typeof fetch;
    const s = createGraphSearch({ token: 'T0KEN-VALUE', fetch: f, sleep: noSleep, now: () => 0, maxRetries: 2 });
    const err = await s('x').catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(String(err.message)).toBe('Graph /users search failed with HTTP 429');
  });

  it('a non-retryable error (403) fails at once', async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response('{}', { status: 403 }); }) as unknown as typeof fetch;
    await expect(createGraphSearch({ token: 'T', fetch: f, sleep: noSleep, now: () => 0 })('x')).rejects.toThrow(/HTTP 403/);
    expect(calls).toBe(1);
  });

  it('sends the delegated token and ConsistencyLevel: eventual', async () => {
    let seen: Headers | undefined;
    const f = (async (_u: unknown, init: RequestInit) => { seen = new Headers(init.headers); return new Response('{"value":[]}', { status: 200 }); }) as unknown as typeof fetch;
    await createGraphSearch({ token: 'abc', fetch: f, sleep: noSleep, now: () => 0 })('x');
    expect(seen!.get('authorization')).toBe('Bearer abc');
    expect(seen!.get('consistencylevel')).toBe('eventual');
  });
});

describe('the job: privacy of console output and the report', () => {
  afterEach(() => vi.restoreAllMocks());
  const FILE = [
    'Employee Code,Employee Name,Umoja Membership,Date Joined,Active Months,Gender,Position,Business Unit',
    'NAM0001,Zorblax Quentin Wimbleton,Active,2019-03-01,12,Female,Clerk,Tax',
    'NAM0002,Prax Nobodyhome,Active,2019-03-01,12,Male,Clerk,Tax',
    'NAM0003,Quillon Dupe,Active,2019-03-01,12,Male,Clerk,Tax',
    'NAM0004,Fenwick Twin,Inactive,2019-03-01,12,Male,Clerk,Tax',
  ].join('\n');
  const DIR = [
    user('Zorblax Wimbleton', 'Zorblax', 'Wimbleton', 'zorblax.wimbleton@namra.org.na'),
    user('Quillon Dupe', 'Quillon', 'Dupe', 'q1@namra.org.na'), user('Quillon Dupe', 'Quillon', 'Dupe', 'q2@namra.org.na'),
  ];

  it('prints only counts: no name, email or oid reaches the console or the log, but the local report has them', async () => {
    const out: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    const lines: string[] = [];
    let csv = '';
    const res = await runMatchJob({ fileText: FILE, token: 'TOKEN-123', dryRun: true, log: (l) => lines.push(l), writeReport: (c) => { csv = c; }, fetch: fakeGraph(DIR), sleep: noSleep, now: () => 0 });
    expect(res.counts).toEqual({ matched: 1, not_found: 2, ambiguous: 1, conflict: 0 });
    const text = [...lines, ...out].join('\n');
    for (const secret of ['Zorblax', 'Quentin', 'Wimbleton', 'Nobodyhome', 'Dupe', 'Twin', '@namra.org.na', DIR[0].id, 'TOKEN-123', 'NAM000']) expect(text, `console/log leaked ${secret}`).not.toContain(secret);
    expect(lines).toEqual(expect.arrayContaining(['matched: 1', 'not_found: 2', 'ambiguous: 1', 'conflict: 0']));
    expect(csv.split('\n')[0]).toBe('code,member_name,status,matched_email,candidates');
    expect(csv).toContain('NAM0001,Zorblax Quentin Wimbleton,matched,zorblax.wimbleton@namra.org.na,1');
    expect(csv).toContain('NAM0003,Quillon Dupe,ambiguous,,2');
    expect(csv).not.toContain('TOKEN-123');
  });

  it('--dry-run never opens a database connection', async () => {
    const connect = vi.fn();
    await runMatchJob({ fileText: FILE, token: 't', dryRun: true, log: () => {}, writeReport: () => {}, connect, fetch: fakeGraph(DIR), sleep: noSleep, now: () => 0 });
    expect(connect).not.toHaveBeenCalled();
  });

  it('the report neutralises spreadsheet formulas in names', () => {
    const csv = reportCsv([{ code: 'NAM0001', name: '=HYPERLINK("x")', active: true, status: 'not_found', oid: null, email: null, candidates: 0 }]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('keeps names out of the normal parse (the import path) and only returns them when asked', () => {
    expect(parseUmojaExport(FILE).members[0]).toEqual({ code: 'NAM0001', active: true });
    expect(parseUmojaExport(FILE, { keepNames: true }).members[0]).toEqual({ code: 'NAM0001', active: true, name: 'Zorblax Quentin Wimbleton' });
  });
});

describe('device-code sign-in', () => {
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
  const base = { tenantId: 't', clientId: 'c', scope: 'User.ReadBasic.All', sleep: noSleep };

  it('shows the code, waits while pending, returns the token, and never announces it', async () => {
    let polls = 0; const said: string[] = [];
    const f = (async (url: string) => {
      if (String(url).endsWith('/devicecode')) return json({ device_code: 'D', user_code: 'ABC123', verification_uri: 'https://login.microsoft.com/device', expires_in: 900, interval: 5, message: 'Open https://login.microsoft.com/device and enter ABC123' });
      return ++polls < 3 ? json({ error: 'authorization_pending' }) : json({ access_token: 'SECRET-TOKEN' });
    }) as unknown as typeof fetch;
    const tok = await deviceCodeToken({ ...base, fetch: f, announce: (m) => said.push(m), now: () => 0 });
    expect(tok).toBe('SECRET-TOKEN');
    expect(polls).toBe(3);
    expect(said.join(' ')).toContain('ABC123');
    expect(said.join(' ')).not.toContain('SECRET-TOKEN');
  });

  it.each([
    ['at the device-code request', 'devicecode'],
    ['when polling for the token', 'token'],
  ])('public client flows disabled (AADSTS7000218) %s -> PublicClientDisabled with the message for IT', async (_w, stage) => {
    const f = (async (url: string) => {
      const bad = json({ error: 'invalid_client', error_description: 'AADSTS7000218: The request body must contain client_assertion or client_secret.' });
      if (String(url).endsWith('/devicecode')) return stage === 'devicecode' ? bad : json({ device_code: 'D', user_code: 'U', verification_uri: 'v', expires_in: 900, interval: 1 });
      return bad;
    }) as unknown as typeof fetch;
    const err = await deviceCodeToken({ ...base, fetch: f, announce: () => {}, now: () => 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(PublicClientDisabled);
    expect(err.message).toBe(IT_MESSAGE_PUBLIC_CLIENT);
    expect(err.message).toMatch(/Allow public client flows/);
    expect(err.message).toMatch(/http:\/\/localhost:3001\/auth\/callback/);
  });

  it('an expired code is reported as such, and a timeout is an error too', async () => {
    const f = (async (url: string) => String(url).endsWith('/devicecode')
      ? json({ device_code: 'D', user_code: 'U', verification_uri: 'v', expires_in: 900, interval: 1 })
      : json({ error: 'expired_token', error_description: 'AADSTS70020' })) as unknown as typeof fetch;
    await expect(deviceCodeToken({ ...base, fetch: f, announce: () => {}, now: () => 0 })).rejects.toThrow(/expired/);
    let t = 0;
    const pending = (async (url: string) => String(url).endsWith('/devicecode')
      ? json({ device_code: 'D', user_code: 'U', verification_uri: 'v', expires_in: 10, interval: 1 })
      : json({ error: 'authorization_pending' })) as unknown as typeof fetch;
    await expect(deviceCodeToken({ ...base, fetch: pending, announce: () => {}, now: () => (t += 5000), sleep: noSleep })).rejects.toThrow(/timed out/);
  });
});

describe('transient network errors', () => {
  it('Graph search retries a dropped connection and succeeds', async () => {
    let calls = 0; const slept: number[] = [];
    const f = (async () => { if (++calls < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); return new Response('{"value":[]}', { status: 200 }); }) as unknown as typeof fetch;
    expect(await createGraphSearch({ token: 'T', fetch: f, sleep: async (ms) => { slept.push(ms); }, now: () => 0 })('x')).toEqual([]);
    expect(calls).toBe(3);
  });
  it('after the retry budget it fails with the cause code only (no URL, no token)', async () => {
    const f = (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as unknown as typeof fetch;
    const err = await createGraphSearch({ token: 'TOK', fetch: f, sleep: noSleep, now: () => 0, maxRetries: 2 })('x').catch((e) => e);
    expect(err.message).toBe('Graph /users search failed: network error (ENOTFOUND)');
  });
  it('the device-code poll survives a dropped connection', async () => {
    let polls = 0;
    const f = (async (url: string) => {
      if (String(url).endsWith('/devicecode')) return new Response(JSON.stringify({ device_code: 'D', user_code: 'U', verification_uri: 'v', expires_in: 900, interval: 1 }), { status: 200 });
      if (++polls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return new Response(JSON.stringify({ access_token: 'OK' }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await deviceCodeToken({ tenantId: 't', clientId: 'c', scope: 's', fetch: f, sleep: async () => {}, announce: () => {}, now: () => 0 })).toBe('OK');
  });
});
