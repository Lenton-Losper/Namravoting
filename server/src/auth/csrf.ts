import crypto from 'node:crypto';
import type { Express, Request, RequestHandler } from 'express';
import type { Config } from '../config.js';
import { cookieOptions, readCookie } from './cookies.js';
import { signingKey } from './keys.js';
import { sessionKeyOf } from './sessions.js';
import { mac, safeEqual } from './signing.js';

const COOKIE = 'namra_csrf';
const HEADER = 'x-csrf-token';

/**
 * Signed double-submit CSRF: the token is `nonce.HMAC(csrf key, "csrf:" + binding + ":" + nonce)`. It is stored in a
 * (JS-readable) cookie and must be echoed in the X-CSRF-Token header. An attacker cannot read the cookie (SameSite=Strict,
 * other origin) nor forge a token that carries a valid HMAC, so cookie-injection attacks fail too.
 *
 * SEC-15: the HMAC also covers the BINDING: the hash of the caller's server-side session id, or "anon" before sign-in. A token
 * minted for one session is worthless for another, and a token minted before sign-in stops working once a session exists
 * (the client fetches a new one; see client/src/api.ts). So an attacker who can mint a token for themselves, or who can plant a
 * cookie from a sibling subdomain, cannot use it against a signed-in victim.
 */
const bindingOf = (req: Request): string => sessionKeyOf(req) ?? 'anon';
const tag = (config: Config, binding: string, nonce: string) => mac(signingKey(config, 'csrf'), `csrf:${binding}:${nonce}`);

export function mountCsrf(app: Express, config: Config): void {
  app.get('/api/csrf', (req, res) => {
    const nonce = crypto.randomBytes(24).toString('base64url');
    const token = `${nonce}.${tag(config, bindingOf(req), nonce)}`;
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
      return i > 0 && safeEqual(header.slice(i + 1), tag(config, bindingOf(req), header.slice(0, i)));
    })();
    if (!ok) { res.status(403).json({ error: 'Invalid CSRF token' }); return; }
    next();
  };
}
