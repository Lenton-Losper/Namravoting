import type { CookieOptions, Request } from 'express';
import type { Config } from '../config.js';

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

export function cookieOptions(config: Config, extra: CookieOptions = {}): CookieOptions {
  return { sameSite: 'strict', secure: config.isProd, path: '/', ...extra };
}
