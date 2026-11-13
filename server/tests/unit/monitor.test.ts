// The outside monitor (items 6 and 12): app up, sign-in redirect, alerts.
import { describe, expect, it } from 'vitest';
import { checkApp, sendAlert, summarise } from '../../../scripts/monitor-lib.mjs';

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
