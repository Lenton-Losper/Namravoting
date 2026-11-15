import { describe, expect, it } from 'vitest';
import { envFingerprint, toContainerRequest } from '../../../worker/src/forward.js';
import { describeConfigError, parseConfig } from '../../src/config.js';

describe('toContainerRequest', () => {
  it('downgrades https to http and keeps method, path, query, headers and body', async () => {
    const r = toContainerRequest(new Request('https://x.workers.dev/api/a?b=1', { method: 'POST', headers: { 'cf-access-jwt-assertion': 'jwt', 'content-type': 'application/json' }, body: '{"t":"hi"}' }));
    expect(r.url).toBe('http://x.workers.dev/api/a?b=1');
    expect(r.method).toBe('POST');
    expect(r.headers.get('cf-access-jwt-assertion')).toBe('jwt');
    expect(await r.json()).toEqual({ t: 'hi' });
  });

  it('keeps multipart uploads intact (boundary header and bytes)', async () => {
    const fd = new FormData();
    fd.set('name', 'Alice');
    fd.set('photo', new File([new Uint8Array([137, 80, 78, 71, 0, 255, 1])], 'p.png', { type: 'image/png' }));
    const original = new Request('https://x.workers.dev/up', { method: 'POST', body: fd });
    const ct = original.headers.get('content-type');
    const r = toContainerRequest(original);
    expect(r.headers.get('content-type')).toBe(ct);
    const back = await r.formData();
    expect(back.get('name')).toBe('Alice');
    expect(new Uint8Array(await (back.get('photo') as File).arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71, 0, 255, 1]));
  });

  it('does not follow redirects and tells the app the public origin', () => {
    const r = toContainerRequest(new Request('https://x.workers.dev/', { headers: { 'x-forwarded-host': 'already.set' } }));
    expect(r.redirect).toBe('manual');
    expect(r.headers.get('x-forwarded-host')).toBe('x.workers.dev');   // SEC-25: a client-supplied value is replaced, not kept
    const r2 = toContainerRequest(new Request('https://x.workers.dev/p'));
    expect(r2.headers.get('x-forwarded-host')).toBe('x.workers.dev');
    expect(r2.headers.get('x-forwarded-proto')).toBe('https');
  });
});

describe('describeConfigError', () => {
  it('names the missing key and never echoes values', () => {
    let msg = '';
    try { parseConfig({ NODE_ENV: 'production', SESSION_SECRET: 'short-secret-value' } as never); } catch (e) { msg = describeConfigError(e); }
    expect(msg).toMatch(/SESSION_SECRET/);
    expect(msg).toMatch(/DATABASE_URL/);
    expect(msg).not.toMatch(/short-secret-value/);
  });
});

describe('envFingerprint (the Worker restarts the container when its settings changed)', () => {
  it('is stable for the same settings in any order, and changes when any value changes, including AUTH_MODE or a secret', async () => {
    const a = await envFingerprint({ AUTH_MODE: 'entra', CF_ACCESS_AUD: 'old', PORT: '8080' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await envFingerprint({ PORT: '8080', CF_ACCESS_AUD: 'old', AUTH_MODE: 'entra' })).toBe(a);
    expect(await envFingerprint({ AUTH_MODE: 'demo', CF_ACCESS_AUD: 'old', PORT: '8080' })).not.toBe(a);
    expect(await envFingerprint({ AUTH_MODE: 'entra', CF_ACCESS_AUD: 'new', PORT: '8080' })).not.toBe(a);
    expect(await envFingerprint({ AUTH_MODE: 'entra', CF_ACCESS_AUD: 'old', PORT: '8080', DEMO_USERS: '{}' })).not.toBe(a);
  });
  it('never contains the values themselves', async () => {
    expect(await envFingerprint({ SESSION_SECRET: 'super-secret-value' })).not.toContain('super-secret');
  });
});
