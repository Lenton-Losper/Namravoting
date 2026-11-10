import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createDiskStorage, createR2Storage, type PhotoStorage } from '../../src/services/storage.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'storage-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Minimal in-memory S3 endpoint: re-derives the SigV4 signature independently and rejects bad ones. */
function fakeR2(secret: string, accessKey: string) {
  const objects = new Map<string, Buffer>();
  const calls: { method: string; url: string }[] = [];
  const hm = (k: string | Buffer, d: string) => crypto.createHmac('sha256', k).update(d).digest();
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String(init?.method);
    const h = new Headers(init?.headers);
    calls.push({ method, url: url.pathname });
    const auth = h.get('authorization') ?? '';
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m || m[1] !== accessKey) return new Response('bad auth', { status: 403 });
    const [, , day, signed, sig] = m;
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    if (h.get('x-amz-content-sha256') !== crypto.createHash('sha256').update(body).digest('hex')) return new Response('bad hash', { status: 400 });
    const headerLines = signed.split(';').map((n) => `${n}:${n === 'host' ? url.host : h.get(n)}\n`).join('');
    const canonical = `${method}\n${url.pathname}\n\n${headerLines}\n${signed}\n${h.get('x-amz-content-sha256')}`;
    const sts = `AWS4-HMAC-SHA256\n${h.get('x-amz-date')}\n${day}/auto/s3/aws4_request\n${crypto.createHash('sha256').update(canonical).digest('hex')}`;
    const expected = crypto.createHmac('sha256', hm(hm(hm(hm('AWS4' + secret, day), 'auto'), 's3'), 'aws4_request')).update(sts).digest('hex');
    if (expected !== sig) return new Response('signature mismatch', { status: 403 });
    if (method === 'PUT') { objects.set(url.pathname, body); return new Response(null, { status: 200 }); }
    if (method === 'GET') { const o = objects.get(url.pathname); return o ? new Response(new Uint8Array(o)) : new Response('NoSuchKey', { status: 404 }); }
    if (method === 'DELETE') { objects.delete(url.pathname); return new Response(null, { status: 204 }); }
    return new Response('?', { status: 405 });
  }) as typeof fetch;
  return { impl, objects, calls };
}

const KEY = 'a'.repeat(32) + '.jpg';
const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4]);

/** The contract every backend must satisfy. */
function contract(name: string, make: () => PhotoStorage) {
  describe(`${name} backend`, () => {
    it('round-trips a photo, returns null for a missing key, and delete is idempotent', async () => {
      const s = make();
      expect(await s.get(KEY)).toBeNull();
      await s.put(KEY, bytes);
      expect((await s.get(KEY))?.equals(bytes)).toBe(true);
      await s.delete(KEY);
      expect(await s.get(KEY)).toBeNull();
      await s.delete(KEY);                              // deleting twice is fine
    });
    it('keeps photos separate by key', async () => {
      const s = make();
      const k2 = 'b'.repeat(32) + '.jpg';
      await s.put(KEY, bytes); await s.put(k2, Buffer.from('other'));
      expect((await s.get(k2))?.toString()).toBe('other');
      expect((await s.get(KEY))?.equals(bytes)).toBe(true);
      await s.delete(KEY); await s.delete(k2);
    });
  });
}

contract('disk', () => createDiskStorage(path.join(tmp, 'disk')));
const r2 = fakeR2('s3cr3t', 'AKID');
contract('r2 (signed S3 API against a fake endpoint)', () => createR2Storage({
  endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'photos', accessKeyId: 'AKID', secretAccessKey: 's3cr3t', fetchImpl: r2.impl,
  now: () => new Date('2026-11-10T12:00:00Z'),
}));

describe('r2 backend details', () => {
  it('uses path-style bucket URLs, and wrong credentials are rejected by the endpoint', async () => {
    const good = createR2Storage({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'photos', accessKeyId: 'AKID', secretAccessKey: 's3cr3t', fetchImpl: r2.impl });
    await good.put(KEY, bytes);
    expect(r2.calls.at(-1)).toEqual({ method: 'PUT', url: `/photos/${KEY}` });
    const bad = createR2Storage({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'photos', accessKeyId: 'AKID', secretAccessKey: 'WRONG', fetchImpl: r2.impl });
    await expect(bad.put(KEY, bytes)).rejects.toThrow(/HTTP 403/);
    await expect(bad.get(KEY)).rejects.toThrow(/HTTP 403/);
  });
  it('never puts the secret key on the wire', async () => {
    const seen: string[] = [];
    const spy = (async (u: string | URL | Request, i?: RequestInit) => { seen.push(JSON.stringify([String(u), i?.headers])); return new Response(null, { status: 200 }); }) as typeof fetch;
    await createR2Storage({ endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b', accessKeyId: 'AKID', secretAccessKey: 'TOP-SECRET-VALUE', fetchImpl: spy }).put(KEY, bytes);
    expect(seen.join()).not.toContain('TOP-SECRET-VALUE');
  });
});
