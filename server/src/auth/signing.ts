import crypto from 'node:crypto';

/** One signing key per purpose (session cookie, sign-in flow cookie, CSRF), derived from the secrets in auth/keys.ts. */
export type Key = Buffer | string;

export const mac = (key: Key, data: string) => crypto.createHmac('sha256', key).update(data).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** token = base64url(json) "." HMAC-SHA256 */
export function sign(key: Key, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(key, body)}`;
}

/** Verifies against each key in turn (the current one, then the previous one during a key rotation). */
export function verify<T>(keys: Key | Key[], token: string): T | null {
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  const tag = token.slice(i + 1);
  if (![keys].flat().some((k) => safeEqual(tag, mac(k, body)))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T; } catch { return null; }
}

/** Opaque-value cookie: `<value>.<mac>` where value is a random id (used for server-side sessions). */
export function signValue(key: Key, value: string): string { return `${value}.${mac(key, value)}`; }

export function verifyValue(keys: Key | Key[], token: string): string | null {
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const value = token.slice(0, i);
  const tag = token.slice(i + 1);
  return [keys].flat().some((k) => safeEqual(tag, mac(k, value))) ? value : null;
}
