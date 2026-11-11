import { describe, expect, it } from 'vitest';
import { toContainerRequest } from '../../../worker/src/forward';
import { describeConfigError, parseConfig } from '../../src/config';

describe('toContainerRequest', () => {
  it('downgrades https to http and keeps method, path, query, headers and body', async () => {
    const r = toContainerRequest(new Request('https://x.workers.dev/api/a?b=1', { method: 'POST', headers: { 'cf-access-jwt-assertion': 'jwt' }, body: 'hi' }));
    expect(r.url).toBe('http://x.workers.dev/api/a?b=1');
    expect(r.method).toBe('POST');
    expect(r.headers.get('cf-access-jwt-assertion')).toBe('jwt');
    expect(await r.text()).toBe('hi');
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
