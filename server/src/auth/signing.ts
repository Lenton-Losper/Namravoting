import crypto from 'node:crypto';

const mac = (secret: string, data: string) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** token = base64url(json) "." HMAC-SHA256 */
export function sign(secret: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${mac(secret, body)}`;
}

export function verify<T>(secret: string, token: string): T | null {
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i);
  if (!safeEqual(token.slice(i + 1), mac(secret, body))) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T; } catch { return null; }
}

export { mac };
