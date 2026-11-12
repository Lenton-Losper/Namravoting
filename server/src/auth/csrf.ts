import crypto from 'node:crypto';
import type { Express, RequestHandler } from 'express';
import type { Config } from '../config.js';
import { cookieOptions, readCookie } from './cookies.js';
import { signingKey } from './keys.js';
import { mac, safeEqual } from './signing.js';

const COOKIE = 'namra_csrf';
const HEADER = 'x-csrf-token';

/**
 * Signed double-submit CSRF: the token is `nonce.HMAC(nonce)`. It is stored in a (JS-readable) cookie
 * and must be echoed in the X-CSRF-Token header. An attacker cannot read the cookie (SameSite=Strict, other
 * origin) nor forge a token that carries a valid HMAC, so cookie-injection attacks fail too.
 */
export function mountCsrf(app: Express, config: Config): void {
  app.get('/api/csrf', (_req, res) => {
    const nonce = crypto.randomBytes(24).toString('base64url');
    const token = `${nonce}.${mac(signingKey(config, 'csrf'), 'csrf:' + nonce)}`;
    res.cookie(COOKIE, token, cookieOptions(config, { httpOnly: false, maxAge: 8 * 3600 * 1000 }));
    res.set('Cache-Control', 'no-store');
    res.json({ token });
  });
}

export function csrfProtection(config: Config): RequestHandler {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }
    const header = req.get(HEADER);
    const cookie = readCookie(req, COOKIE);
    const ok = !!header && !!cookie && safeEqual(header, cookie) && (() => {
      const i = header.lastIndexOf('.');
      return i > 0 && safeEqual(header.slice(i + 1), mac(signingKey(config, 'csrf'), 'csrf:' + header.slice(0, i)));
    })();
    if (!ok) { res.status(403).json({ error: 'Invalid CSRF token' }); return; }
    next();
  };
}
