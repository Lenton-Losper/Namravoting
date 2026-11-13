import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../config.js';

/**
 * Where candidate photos live. Keys are the random file names made by images.ts.
 * Photos are never served from here directly: only through the authenticated /api/photos/:id route.
 */
export interface PhotoStorage {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** Local disk (dev and tests). */
export function createDiskStorage(dir: string): PhotoStorage {
  return {
    async put(key, data, _contentType) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, key), data, { flag: 'wx' }); },
    async get(key) { try { return await fs.readFile(path.join(dir, key)); } catch { return null; } },
    async delete(key) { try { await fs.unlink(path.join(dir, key)); } catch { /* already gone */ } },
  };
}

export interface R2Options {
  endpoint: string;            // https://<account>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;    // injectable for tests
  now?: () => Date;
}

const hmac = (key: string | Buffer, data: string) => crypto.createHmac('sha256', key).update(data).digest();
const sha256hex = (d: string | Buffer) => crypto.createHash('sha256').update(d).digest('hex');
const encodePath = (p: string) => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');

/** Cloudflare R2 through its S3-compatible API (AWS Signature V4, path-style, region "auto"). No SDK dependency. */
export function createR2Storage(o: R2Options): PhotoStorage {
  const f = o.fetchImpl ?? fetch;
  const base = new URL(o.endpoint);

  async function call(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, contentType = 'image/jpeg'): Promise<Response> {
    const uriPath = '/' + encodePath(`${o.bucket}/${key}`);
    const amzDate = (o.now?.() ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260101T000000Z
    const day = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body ?? '');
    const headers: Record<string, string> = { host: base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const signedNames = Object.keys(headers).sort();
    const canonicalRequest = `${method}\n${uriPath}\n\n${signedNames.map((n) => `${n}:${headers[n]}\n`).join('')}\n${signedNames.join(';')}\n${payloadHash}`;
    const scope = `${day}/auto/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(canonicalRequest)}`;
    const signingKey = hmac(hmac(hmac(hmac('AWS4' + o.secretAccessKey, day), 'auto'), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`;
    const { host: _host, ...sendHeaders } = headers;   // fetch sets Host itself
    return f(`${base.origin}${uriPath}`, {
      method, headers: { ...sendHeaders, authorization, ...(body ? { 'content-type': contentType } : {}) },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  return {
    async put(key, data, contentType) {
      const r = await call('PUT', key, data, contentType);
      if (!r.ok) throw new Error(`R2 put failed: HTTP ${r.status}`);
    },
    async get(key) {
      const r = await call('GET', key);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`R2 get failed: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    },
    async delete(key) {
      const r = await call('DELETE', key);
      if (!r.ok && r.status !== 404) throw new Error(`R2 delete failed: HTTP ${r.status}`);
    },
  };
}

let cached: PhotoStorage | undefined;
/** Backend chosen by STORAGE=disk|r2. */
export function getStorage(): PhotoStorage {
  if (cached) return cached;
  const c = getConfig();
  cached = c.storage === 'r2'
    ? createR2Storage({ endpoint: c.r2.endpoint!, bucket: c.r2.bucket, accessKeyId: c.r2.accessKeyId!, secretAccessKey: c.r2.secretAccessKey! })
    : createDiskStorage(c.uploadDir);
  return cached;
}
