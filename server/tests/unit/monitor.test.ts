// The outside monitor (items 6 and 12): app up, sign-in redirect, alerts.
import { describe, expect, it } from 'vitest';
import { checkApp, checkEntraToken, checkSecretExpiry, sendAlert, summarise } from '../../../scripts/monitor-lib.mjs';

const BASE = 'https://app.example.test';
const noSleep = async () => undefined;
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
type Route = (url: string) => Response | Promise<Response>;
const fake = (route: Route) => (async (u: string | URL | Request) => route(String(u))) as typeof fetch;

describe('checkApp', () => {
  it('passes when the app answers and sign-in redirects to Microsoft', async () => {
    const f = fake((u) => u.endsWith('/api/csrf') ? res(200, { token: 't' }) : res(302, {}, { location: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?x=1' }));
    const r = await checkApp(BASE, { fetchImpl: f, sleep: noSleep });
    expect(r.map((c) => [c.name, c.ok])).toEqual([['App answers', true], ['Sign-in redirects to Microsoft', true]]);
    expect(summarise(r).ok).toBe(true);
  });

  it('rides out a cold start: the first answers fail, a later one succeeds', async () => {
    let n = 0;
    const f = fake((u) => { if (u.endsWith('/api/csrf')) return ++n < 3 ? res(502) : res(200, { token: 't' }); return res(302, {}, { location: 'https://login.microsoftonline.com/x' }); });
    const r = await checkApp(BASE, { fetchImpl: f, sleep: noSleep });
    expect(r[0].ok).toBe(true); expect(n).toBe(3);
  });

  it('fails (and skips the redirect check) when the app never answers, naming the status', async () => {
    const r = await checkApp(BASE, { fetchImpl: fake(() => res(503)), sleep: noSleep, retries: 2 });
    expect(r).toEqual([{ name: 'App answers', ok: false, detail: `${BASE}: HTTP 503` }]);
    expect(summarise(r)).toMatchObject({ ok: false });
  });

  it('fails on a network error, and on a page that is not the CSRF endpoint', async () => {
    const down = await checkApp(BASE, { fetchImpl: (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch, sleep: noSleep, retries: 1 });
    expect(down[0]).toMatchObject({ ok: false }); expect(down[0].detail).toContain('ENOTFOUND');
    const html = await checkApp(BASE, { fetchImpl: fake(() => new Response('<html>', { status: 200 })), sleep: noSleep, retries: 0 });
    expect(html[0].ok).toBe(false);
  });

  it('fails when sign-in no longer goes to Microsoft', async () => {
    const f = fake((u) => u.endsWith('/api/csrf') ? res(200, { token: 't' }) : res(302, {}, { location: 'https://evil.example/login' }));
    const r = await checkApp(BASE, { fetchImpl: f, sleep: noSleep });
    expect(r[1]).toMatchObject({ ok: false }); expect(r[1].detail).toContain('https://evil.example');
    const broken = await checkApp(BASE, { fetchImpl: fake((u) => u.endsWith('/api/csrf') ? res(200, { token: 't' }) : res(500)), sleep: noSleep });
    expect(broken[1]).toMatchObject({ ok: false, detail: 'HTTP 500' });
  });
});

describe('summarise and sendAlert', () => {
  it('separates failures from warnings and prints each on a line', () => {
    const s = summarise([{ name: 'A', ok: true, detail: 'fine' }, { name: 'B', ok: false, detail: 'broken' }, { name: 'C', ok: false, warn: true, detail: 'soon' }]);
    expect(s.lines).toEqual(['OK    A: fine', 'FAIL  B: broken', 'WARN  C: soon']);
    expect(s.failing.map((c) => c.name)).toEqual(['B']); expect(s.warning.map((c) => c.name)).toEqual(['C']); expect(s.ok).toBe(false);
    expect(summarise([{ name: 'C', ok: false, warn: true, detail: 'soon' }]).ok).toBe(true);        // a warning alone is not a failure
  });

  it('posts a { text } payload to the webhook, does nothing without one, and never throws', async () => {
    let got: { url: string; body: { text: string } } | undefined;
    const f = (async (url: string, init: RequestInit) => { got = { url, body: JSON.parse(String(init.body)) }; return new Response('', { status: 200 }); }) as unknown as typeof fetch;
    expect(await sendAlert('https://hooks.example/abc', 'PROBLEM', ['B: broken'], { fetchImpl: f })).toBe(true);
    expect(got).toEqual({ url: 'https://hooks.example/abc', body: { text: 'PROBLEM\n\nB: broken' } });
    expect(await sendAlert(undefined, 't', ['x'], { fetchImpl: f })).toBe(false);
    expect(await sendAlert('https://hooks.example/abc', 't', ['x'], { fetchImpl: (async () => { throw new Error('boom'); }) as typeof fetch })).toBe(false);
  });
});

describe('checkEntraToken (item 12)', () => {
  const ids = { tenantId: 'tenant-guid', clientId: 'client-guid', clientSecret: 'the-secret-value' };
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('passes when Microsoft issues a token, and sends the same request the app makes', async () => {
    let seen: { url: string; body: string } | undefined;
    const f = (async (url: string, init: RequestInit) => { seen = { url, body: String(init.body) }; return new Response(JSON.stringify({ access_token: 'ACCESS-TOKEN-VALUE-123', expires_in: 3600 }), { status: 200 }); }) as unknown as typeof fetch;
    const r = await checkEntraToken(ids, { fetchImpl: f });
    expect(r).toMatchObject({ name: 'Microsoft sign-in secret works', ok: true });
    expect(seen!.url).toBe('https://login.microsoftonline.com/tenant-guid/oauth2/v2.0/token');
    expect(seen!.body).toContain('grant_type=client_credentials'); expect(seen!.body).toContain('graph.microsoft.com');
    expect(JSON.stringify(r)).not.toContain('ACCESS-TOKEN-VALUE-123'); expect(JSON.stringify(r)).not.toContain('the-secret-value');
  });

  it('says plainly when the secret has EXPIRED, is invalid, or the ids are wrong, naming the Microsoft code, never the secret', async () => {
    const expired = await checkEntraToken(ids, { fetchImpl: answer(401, { error: 'invalid_client', error_codes: [7000222] }) });
    expect(expired).toMatchObject({ ok: false, detail: expect.stringContaining('AADSTS7000222: the client secret has EXPIRED') }); expect(expired.warn).toBeUndefined();
    expect((await checkEntraToken(ids, { fetchImpl: answer(401, { error_codes: [7000215] }) })).detail).toContain('INVALID');
    expect((await checkEntraToken(ids, { fetchImpl: answer(400, { error_codes: [700016] }) })).detail).toContain('not found in this tenant');
    expect((await checkEntraToken(ids, { fetchImpl: answer(500, {}) })).detail).toBe('HTTP 500: Microsoft refused the token request');
    for (const r of [expired]) expect(JSON.stringify(r)).not.toContain('the-secret-value');
  });

  it('skips with a warning when the secret is not provided, and treats an unreachable Microsoft as a warning, not a failed secret', async () => {
    expect(await checkEntraToken({ ...ids, clientSecret: undefined })).toMatchObject({ ok: false, warn: true });
    const r = await checkEntraToken(ids, { fetchImpl: (async () => { throw new Error('getaddrinfo ENOTFOUND login.microsoftonline.com'); }) as typeof fetch });
    expect(r).toMatchObject({ ok: false, warn: true }); expect(r.detail).toContain('ENOTFOUND');
  });
});

describe('checkSecretExpiry (item 12)', () => {
  const now = new Date('2026-11-13T10:00:00Z');
  it('warns 30 days ahead, fails in the last 7 days and after expiry, and is fine otherwise', () => {
    expect(checkSecretExpiry('2027-05-30', now)).toMatchObject({ ok: true });
    expect(checkSecretExpiry('2026-12-20', now)).toMatchObject({ ok: true, detail: expect.stringContaining('38 days left') });   // more than 30 days away: fine
    const soon = checkSecretExpiry('2026-12-10', now);
    expect(soon).toMatchObject({ ok: false, warn: true }); expect(soon.detail).toContain('28 days');
    const week = checkSecretExpiry('2026-11-18', now);
    expect(week.ok).toBe(false); expect(week.warn).toBeUndefined(); expect(week.detail).toContain('expires in 6 day(s)');
    const gone = checkSecretExpiry('2026-11-01', now);
    expect(gone.ok).toBe(false); expect(gone.warn).toBeUndefined(); expect(gone.detail).toContain('EXPIRED 11 day(s) ago');
    expect(checkSecretExpiry('2026-11-13', now).detail).toContain('expires in 1 day(s)');     // the whole last day still counts
  });
  it('an unset or unreadable date is a warning that says what to set', () => {
    expect(checkSecretExpiry(undefined, now)).toMatchObject({ ok: false, warn: true, detail: expect.stringContaining('ENTRA_SECRET_EXPIRES_AT') });
    expect(checkSecretExpiry('soon', now)).toMatchObject({ ok: false, warn: true });
    expect(checkSecretExpiry('2027-02-30', now)).toMatchObject({ ok: false, warn: true });
  });
  it('accepts a full ISO time as well as a plain date', () => {
    expect(checkSecretExpiry('2027-05-30T12:00:00Z', now).ok).toBe(true);
  });
});
