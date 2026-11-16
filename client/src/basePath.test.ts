import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
async function load(base: string) { vi.stubEnv('BASE_URL', base); vi.resetModules(); return import('./basePath'); }

describe('base path helpers', () => {
  it('are no-ops when the app is served from the root', async () => {
    const m = await load('/');
    expect(m.BASE).toBe('');
    expect(m.withBase('/api/session')).toBe('/api/session');
    expect(m.stripBase('/votes')).toBe('/votes');
  });
  it('prefix app paths and strip them back under /voting-app', async () => {
    const m = await load('/voting-app/');
    expect(m.BASE).toBe('/voting-app');
    expect(m.withBase('/api/session')).toBe('/voting-app/api/session');
    expect(m.withBase('//evil.example/x')).toBe('//evil.example/x');
    expect(m.withBase('https://x.example/y')).toBe('https://x.example/y');
    expect(m.stripBase('/voting-app/votes?x=1')).toBe('/votes?x=1');
    expect(m.stripBase('/voting-app')).toBe('/');
    expect(m.stripBase('/voting-application')).toBe('/voting-application');
  });
  it('make api() call the prefixed URLs', async () => {
    vi.stubEnv('BASE_URL', '/voting-app/'); vi.resetModules();
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { seen.push(u); return new Response(JSON.stringify({ token: 't' }), { status: 200 }); }));
    const { api } = await import('./api');
    await api('GET', '/api/session'); await api('POST', '/api/logout');
    expect(seen).toEqual(['/voting-app/api/session', '/voting-app/api/csrf', '/voting-app/api/logout']);
  });
});
